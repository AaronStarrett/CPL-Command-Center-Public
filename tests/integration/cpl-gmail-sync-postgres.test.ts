import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import { migrateDatabase } from "../../packages/database/src/migrations";
import {
  configureHostedRuntimeRole,
  configureCplIngestionWorker,
} from "../../packages/database/src/hosted-database-role";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store";
import { SqlCplTenantRepository } from "../../packages/database/src/tenant-repository";
import { SqlCplIntegrationRepository } from "../../packages/database/src/cpl-integration-repository";
import { processCplGmailSync } from "../../packages/database/src/cpl-gmail-sync";
import { processHostedJobs } from "../../packages/database/src/hosted-workflow";
import type {
  CplIntegrationRepositoryOptions,
  CplGmailTokens,
} from "../../packages/database/src/cpl-integration-ports";
import type { IntegrationRow } from "../../packages/database/src/cpl-integration-data";
import { CplGoogleGmailAdapter } from "../../packages/integrations/src/cpl-gmail";
import { createCplGmailHttpFixture } from "../../packages/security/src/cpl-integration-fixture";
import {
  createGoogleIntegrationIdentityVerifier,
  createIntegrationOpaqueToken,
  createIntegrationSecretBox,
} from "../../packages/security/src/cpl-integration-security";

const material = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON;
const configPath = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG;
const redirectUri = "http://127.0.0.1:3400/api/cpl-integrations/oauth/google/callback";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Transport = (
  url: string,
  init: RequestInit | undefined,
  fallback: typeof fetch,
) => Promise<Response>;
(material || configPath ? describe : describe.skip)(
  "Gmail sync with real PostgreSQL and deterministic HTTP transport",
  () => {
    let admin: PgSqlDatabaseAdapter,
      control: PgSqlDatabaseAdapter,
      web: PgSqlDatabaseAdapter,
      worker: PgSqlDatabaseAdapter;
    let tenants: SqlCplTenantRepository, auth: SqlCplHostedAuthStore;
    let privateJwk: JWK, publicJwk: JWK;
    const databaseName = `cpl_gmail_sync_test_${randomBytes(6).toString("hex")}`;
    const secretBox = createIntegrationSecretBox({
      resolveKey: async () => new Uint8Array(32).fill(23),
    });
    let created = false;
    beforeAll(async () => {
      const c = JSON.parse(material ?? readFileSync(configPath!, "utf8"));
      for (const value of [c.adminUrl, c.webUrl, c.workerUrl])
        if (!["127.0.0.1", "localhost"].includes(new URL(value).hostname))
          throw Error("Isolated local PostgreSQL only");
      const connection = (value: string) => {
        const u = new URL(value);
        u.pathname = "/" + databaseName;
        return u.href;
      };
      control = new PgSqlDatabaseAdapter({ connectionString: c.adminUrl, max: 1 });
      await control.execute(`CREATE DATABASE "${databaseName}"`);
      created = true;
      admin = new PgSqlDatabaseAdapter({ connectionString: connection(c.adminUrl), max: 3 });
      await migrateDatabase(admin);
      await configureHostedRuntimeRole(admin, new URL(c.webUrl).username, "web");
      await configureHostedRuntimeRole(admin, new URL(c.workerUrl).username, "worker");
      await configureCplIngestionWorker(admin, new URL(c.workerUrl).username);
      web = new PgSqlDatabaseAdapter({ connectionString: connection(c.webUrl), max: 3 });
      worker = new PgSqlDatabaseAdapter({ connectionString: connection(c.workerUrl), max: 3 });
      tenants = new SqlCplTenantRepository(web);
      auth = new SqlCplHostedAuthStore(web);
      const keys = await generateKeyPair("RS256", { extractable: true });
      privateJwk = await exportJWK(keys.privateKey);
      publicJwk = await exportJWK(keys.publicKey);
    }, 180000);
    afterAll(async () => {
      await worker?.close();
      await web?.close();
      await admin?.close();
      if (created) await control.execute(`DROP DATABASE "${databaseName}" WITH(FORCE)`);
      await control?.close();
    }, 60000);
    async function fixture(existing?: { organizationId: string; sessionToken: string }) {
      let request = existing;
      if (!request) {
        const raw = randomBytes(32).toString("base64url"),
          now = new Date().toISOString();
        await auth.createSession({
          identity: {
            issuer: "https://accounts.google.com",
            subject: randomUUID(),
            email: "fictional@example.invalid",
            emailVerified: true,
            hostedDomain: null,
            displayName: "Fictional Gmail operator",
            authenticatedAt: now,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
          material: {
            tokenHash: sha(raw),
            csrfTokenHash: sha(randomUUID()),
            expiresAt: new Date(Date.now() + 3500000).toISOString(),
            absoluteExpiresAt: new Date(Date.now() + 28000000).toISOString(),
          },
          now,
        });
        const org = await tenants.createOrganization(raw, {
          slug: randomUUID(),
          displayName: "Fictional Gmail company",
        });
        request = { organizationId: org.id, sessionToken: raw };
        await admin.query(
          "UPDATE cpl_module_entitlements SET enabled=TRUE,usage_limit=NULL WHERE organization_id=$1",
          [org.id],
        );
      }
      const repository = new SqlCplIntegrationRepository(web, tenants, {
        providerMode: "local_fixture",
      });
      const mapping = await repository.saveMapping({
        ...request,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: {
          name: "Fictional source mapping",
          sourceKind: "gmail",
          rules: [
            {
              source: { kind: "gmail", field: "subject" },
              target: { kind: "builtin", field: "title" },
              transform: "trim",
            },
          ],
        },
      });
      const connection = await repository.createConnection({
        ...request,
        idempotencyKey: randomUUID(),
        input: {
          displayName: "Fictional mailbox",
          selection: null,
          mappingId: mapping.id,
          mappingVersion: mapping.version,
        },
      });
      const epoch = new Date(Date.now() - 60000).toISOString();
      const transport = await createCplGmailHttpFixture({
        fixtureId: request.organizationId,
        fixtureEpoch: epoch,
        fixtureSecret: new Uint8Array(32).fill(19),
        privateJwk,
        publicJwk,
        redirectUri,
      });
      const adapter = new CplGoogleGmailAdapter(transport.configuration, {
        fetch: transport.fetch,
        assertCurrent: async () => undefined,
        verifyIdentity: createGoogleIntegrationIdentityVerifier(),
      });
      const state = createIntegrationOpaqueToken(),
        nonce = createIntegrationOpaqueToken(),
        verifier = createIntegrationOpaqueToken();
      const consent = await transport.authorize(
        await adapter.authorizationUrl({ state, nonce, verifier, redirectUri }),
      );
      const grant = await adapter.exchangeCode({
        code: consent.code,
        nonce,
        verifier,
        redirectUri,
      });
      const account = await admin.query<{ id: string }>(
        `INSERT INTO cpl_integration_accounts(organization_id,id,issuer,subject,email) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,issuer,subject) DO NOTHING RETURNING id`,
        [
          request.organizationId,
          randomUUID(),
          grant.account.issuer,
          grant.account.subject,
          grant.account.email,
        ],
      );
      const accountId =
        account.rows[0]?.id ??
        (
          await admin.query<{ id: string }>(
            "SELECT id FROM cpl_integration_accounts WHERE organization_id=$1 AND issuer=$2 AND subject=$3",
            [request.organizationId, grant.account.issuer, grant.account.subject],
          )
        ).rows[0]!.id;
      const input = {
        ...connection.configuration,
        selection: {
          kind: "label",
          labelId: "INBOX",
          labelName: "Inbox",
          start: {
            kind: "bounded_backfill",
            after: new Date(Date.now() - 86400000).toISOString(),
            maxMessages: 20,
          },
          cadenceMinutes: 5,
        },
      };
      await admin.query(
        `INSERT INTO cpl_integration_source_versions(organization_id,source_id,version,input,configured_by_identity_id,authorized_membership_version) SELECT organization_id,id,2,$3::jsonb,configured_by_identity_id,authorized_membership_version FROM cpl_integration_sources WHERE organization_id=$1 AND id=$2`,
        [request.organizationId, connection.id, JSON.stringify(input)],
      );
      await admin.query(
        "UPDATE cpl_integration_sources SET state='active',configuration_version=2,account_id=$3 WHERE organization_id=$1 AND id=$2",
        [request.organizationId, connection.id, accountId],
      );
      const source = (
        await admin.query<IntegrationRow>(
          "SELECT * FROM cpl_integration_sources WHERE organization_id=$1 AND id=$2",
          [request.organizationId, connection.id],
        )
      ).rows[0]!;
      const storeTokens = async (tokens: CplGmailTokens, revision = 1) => {
        const envelope = await secretBox.seal({
          plaintext: new TextEncoder().encode(JSON.stringify({ account: grant.account, tokens })),
          context: {
            purpose: "gmail_tokens",
            organizationId: request!.organizationId,
            sourceId: connection.id,
            credentialRevision: revision,
          },
          keyVersion: "synthetic-test-v1",
        });
        await admin.query(
          `INSERT INTO cpl_integration_credentials(organization_id,source_id,purpose,revision,envelope,scopes) VALUES($1,$2,'gmail_tokens',$3,$4::jsonb,$5::jsonb) ON CONFLICT(organization_id,source_id,purpose) DO UPDATE SET revision=EXCLUDED.revision,envelope=EXCLUDED.envelope,scopes=EXCLUDED.scopes`,
          [
            request!.organizationId,
            connection.id,
            revision,
            JSON.stringify(envelope),
            JSON.stringify(tokens.scopes),
          ],
        );
      };
      await storeTokens(grant.tokens);
      let override: Transport | undefined,
        calls = 0;
      const options: CplIntegrationRepositoryOptions = {
        providerMode: "local_fixture",
        keyVersion: "synthetic-test-v1",
        secretBox,
        createGmailAdapter: ({ assertCurrent, signal }) =>
          new CplGoogleGmailAdapter(transport.configuration, {
            assertCurrent,
            signal,
            verifyIdentity: createGoogleIntegrationIdentityVerifier(),
            fetch: async (url, init) => {
              calls++;
              return override
                ? override(String(url), init, transport.fetch)
                : transport.fetch(url, init);
            },
          }),
      };
      const claim = async (attempts = 1) => {
        await admin.query(
          "UPDATE cpl_workflow_jobs SET status='skipped',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE organization_id=$1 AND integration_source_id=$2 AND kind='integration.gmail.sync' AND status IN('queued','retrying','running')",
          [request!.organizationId, connection.id],
        );
        const lease = randomUUID(),
          id = randomUUID();
        const result = await admin.query<IntegrationRow>(
          `INSERT INTO cpl_workflow_jobs(id,organization_id,kind,status,attempts,max_attempts,lease_token,lease_owner,lease_expires_at,issued_by_identity_id,issued_membership_version,integration_source_id,integration_generation,integration_configuration_version) VALUES($1,$2,'integration.gmail.sync','running',$3,5,$4,'fixture',clock_timestamp()+INTERVAL '30 seconds',$5,$6,$7,$8,$9) RETURNING *`,
          [
            id,
            request!.organizationId,
            attempts,
            lease,
            source.configured_by_identity_id,
            source.authorized_membership_version,
            connection.id,
            source.generation,
            source.configuration_version,
          ],
        );
        return { job: result.rows[0]!, lease };
      };
      const run = async (attempts = 1) => {
        const c = await claim(attempts);
        return processCplGmailSync(worker, c.job, c.lease, options);
      };
      const current = async () =>
        (
          await admin.query<IntegrationRow>(
            "SELECT * FROM cpl_integration_sources WHERE organization_id=$1 AND id=$2",
            [request!.organizationId, connection.id],
          )
        ).rows[0]!;
      const originals = async () =>
        (
          await admin.query<IntegrationRow>(
            "SELECT * FROM cpl_inbound_originals WHERE organization_id=$1 ORDER BY external_event_id",
            [request!.organizationId],
          )
        ).rows;
      return {
        request,
        connection,
        source,
        grant,
        transport,
        options,
        claim,
        run,
        current,
        originals,
        storeTokens,
        setTransport: (fn: Transport) => {
          override = fn;
        },
        calls: () => calls,
      };
    }
    const response = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    function syntheticMessage(id: string) {
      return {
        id,
        threadId: "thread-" + id,
        historyId: "900719925474099305",
        internalDate: String(Date.now() - 30000),
        labelIds: ["INBOX"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: "Synthetic inquiry " + id },
            { name: "From", value: "Fictional sender <sender@example.invalid>" },
          ],
          body: { data: Buffer.from("Fictional request details").toString("base64url") },
        },
      };
    }
    it("captures bounded originals and queues durable lead work, then schedules the next cadence", async () => {
      const f = await fixture();
      expect(await f.run()).toBe("completed");
      const originals = await f.originals();
      expect(originals).toHaveLength(2);
      expect(
        originals.every(
          (o) => o.source_id === f.connection.id && o.account_id === f.source.account_id,
        ),
      ).toBe(true);
      expect(
        originals.every(
          (o) =>
            sha(Buffer.from(o.original_bytes as Uint8Array).toString("utf8")) === o.original_sha256,
        ),
      ).toBe(true);
      const state = await f.current();
      expect(state.page_json).toBeNull();
      expect(state.coverage).toBe("complete_to_checkpoint");
      expect(state.history_id).toBeTruthy();
      const jobs = await admin.query<IntegrationRow>(
        "SELECT kind,status,available_at FROM cpl_workflow_jobs WHERE organization_id=$1",
        [f.request.organizationId],
      );
      expect(
        jobs.rows.filter((j) => j.kind === "inbound.receipt.process" && j.status === "queued"),
      ).toHaveLength(2);
      expect(
        jobs.rows.filter((j) => j.kind === "integration.gmail.sync" && j.status === "queued"),
      ).toHaveLength(1);
      await processHostedJobs(worker, { claimOwner: "synthetic-inbound", ingestion: f.options });
      const linked = await admin.query<{ count: string }>(
        "SELECT count(*) FROM cpl_workflow_leads WHERE organization_id=$1 AND status='new'",
        [f.request.organizationId],
      );
      expect(Number(linked.rows[0]!.count)).toBe(1);
    });
    it("deduplicates overlapping connections by verified tenant account and immutable message ID", async () => {
      const f = await fixture();
      await f.run();
      const second = await fixture(f.request);
      // Match the provider's stable original date across independently constructed connections.
      const first = await f.originals();
      second.setTransport(async (url, init, fallback) => {
        const id = /\/messages\/([^?]+)/u.exec(url)?.[1];
        const row = first.find((o) => o.external_event_id === id);
        return row
          ? new Response(row.original_bytes as Uint8Array, {
              headers: { "content-type": "application/json" },
            })
          : fallback(url, init);
      });
      expect(await second.run()).toBe("completed");
      expect(await f.originals()).toHaveLength(2);
    });
    it("never checkpoints a partially consumed page and resumes durable IDs after a new worker turn", async () => {
      const f = await fixture();
      let lists = 0;
      f.setTransport(async (url, init, fallback) => {
        const u = new URL(url);
        if (u.pathname.endsWith("/messages")) {
          lists++;
          return response({ messages: Array.from({ length: 6 }, (_, i) => ({ id: "m" + i })) });
        }
        const id = /\/messages\/(m\d+)/u.exec(url)?.[1];
        return id ? response(syntheticMessage(id)) : fallback(url, init);
      });
      expect(await f.run()).toBe("completed");
      expect(await f.originals()).toHaveLength(4);
      expect((await f.current()).history_id).toBeNull();
      expect((await f.current()).page_json).toMatchObject({
        pending: [{ id: "m4" }, { id: "m5" }],
      });
      expect(await f.run()).toBe("completed");
      expect(await f.originals()).toHaveLength(6);
      expect(lists).toBe(1);
      expect((await f.current()).history_id).toBeTruthy();
    });
    it("preserves captured progress on HTTP429 and honors the provider retry delay", async () => {
      const f = await fixture();
      let messages = 0;
      f.setTransport(async (url, init, fallback) => {
        if (/\/messages\//u.test(url) && ++messages === 2)
          return response({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 429, {
            "retry-after": "180",
          });
        return fallback(url, init);
      });
      expect(await f.run()).toBe("retrying");
      expect(await f.originals()).toHaveLength(1);
      expect((await f.current()).history_id).toBeNull();
      const job = (
        await admin.query<IntegrationRow>(
          "SELECT available_at,last_error_code FROM cpl_workflow_jobs WHERE organization_id=$1 AND kind='integration.gmail.sync' AND status='retrying'",
          [f.request.organizationId],
        )
      ).rows[0]!;
      expect(new Date(String(job.available_at)).getTime() - Date.now()).toBeGreaterThan(170000);
      expect(job.last_error_code).toBe("CPL_INTEGRATION_RATE_LIMITED");
      expect(await f.run(2)).toBe("completed");
      expect(await f.originals()).toHaveLength(2);
    });
    it("fences late message responses after the connection is paused", async () => {
      const f = await fixture();
      f.setTransport(async (url, init, fallback) => {
        const r = await fallback(url, init);
        if (/\/messages\//u.test(url))
          await admin.query(
            "UPDATE cpl_integration_sources SET state='paused',generation=generation+1 WHERE organization_id=$1 AND id=$2",
            [f.request.organizationId, f.connection.id],
          );
        return r;
      });
      expect(await f.run()).toBe("skipped");
      expect(await f.originals()).toHaveLength(0);
      expect((await f.current()).state).toBe("paused");
      expect((await f.current()).history_id).toBeNull();
    });
    it("rechecks issuer membership before network and after a late provider response", async () => {
      const f = await fixture();
      f.setTransport(async (url, init, fallback) => {
        const r = await fallback(url, init);
        if (/\/messages\//u.test(url))
          await admin.query(
            "UPDATE cpl_memberships SET status='suspended',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
            [f.request.organizationId, f.source.configured_by_identity_id],
          );
        return r;
      });
      expect(await f.run()).toBe("skipped");
      expect(await f.originals()).toHaveLength(0);
      const calls = f.calls();
      expect(await f.run()).toBe("skipped");
      expect(f.calls()).toBe(calls);
    });
    it("rejects expired leases without acknowledging or persisting the late HTTP body", async () => {
      const f = await fixture();
      f.setTransport(async (url, init, fallback) => {
        const r = await fallback(url, init);
        if (/\/messages\//u.test(url))
          await admin.query(
            "UPDATE cpl_workflow_jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE organization_id=$1 AND kind='integration.gmail.sync' AND status='running'",
            [f.request.organizationId],
          );
        return r;
      });
      await expect(f.run()).rejects.toThrow("CPL_INTEGRATION_LEASE_LOST");
      expect(await f.originals()).toHaveLength(0);
    });
    it("persists parse warnings and attachment metadata without fetching attachment bytes", async () => {
      const f = await fixture();
      f.setTransport(async (url, init, fallback) => {
        if (/\/messages\//u.test(url)) {
          const id = /\/messages\/([^?]+)/u.exec(url)![1]!;
          return response({
            ...syntheticMessage(id),
            payload: {
              mimeType: "text/html",
              headers: [{ name: "Subject", value: "HTML-only synthetic request" }],
              body: { data: Buffer.from("<p>Fictional request</p>").toString("base64url") },
            },
          });
        }
        return fallback(url, init);
      });
      expect(await f.run()).toBe("completed");
      const originals = await f.originals();
      expect(originals[0]!.parse_issues).toContain("HTML_BODY_NOT_EXTRACTED");
      expect(originals[0]!.plain_text).toBeNull();
    });
    it("refreshes encrypted credentials using a revision CAS and preserves an omitted refresh token", async () => {
      const f = await fixture();
      await f.storeTokens({
        ...f.grant.tokens,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      expect(await f.run()).toBe("completed");
      const row = (
        await admin.query<IntegrationRow>(
          "SELECT * FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2",
          [f.request.organizationId, f.connection.id],
        )
      ).rows[0]!;
      expect(Number(row.revision)).toBe(2);
      const bytes = await secretBox.open({
        envelope: row.envelope as Parameters<typeof secretBox.open>[0]["envelope"],
        context: {
          purpose: "gmail_tokens",
          organizationId: f.request.organizationId,
          sourceId: f.connection.id,
          credentialRevision: 2,
        },
      });
      expect(JSON.parse(new TextDecoder().decode(bytes)).tokens.refreshToken).toBe(
        f.grant.tokens.refreshToken,
      );
    });
    it("requires reconnect after invalid_grant instead of deleting or replacing original evidence", async () => {
      const f = await fixture();
      await f.storeTokens({
        ...f.grant.tokens,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      f.setTransport(async (url, init, fallback) =>
        url === "https://oauth2.googleapis.com/token"
          ? response({ error: "invalid_grant" }, 400)
          : fallback(url, init),
      );
      expect(await f.run()).toBe("failed");
      expect((await f.current()).state).toBe("reconnect_required");
      expect(await f.originals()).toHaveLength(0);
    });
    it("marks expired history as an explicit resync requirement without resetting the checkpoint", async () => {
      const f = await fixture();
      await admin.query(
        "UPDATE cpl_integration_sources SET history_id=$3 WHERE organization_id=$1 AND id=$2",
        [f.request.organizationId, f.connection.id, "101"],
      );
      f.setTransport(async (url, init, fallback) =>
        new URL(url).pathname.endsWith("/history")
          ? response({ error: {} }, 404)
          : fallback(url, init),
      );
      expect(await f.run()).toBe("failed");
      const current = await f.current();
      expect(current.coverage).toBe("resync_required");
      expect(current.history_id).toBe("101");
    });
    it("retains originals on deleted messages and records incomplete coverage visibly", async () => {
      const f = await fixture();
      f.setTransport(async (url, init, fallback) =>
        /\/messages\//u.test(url) ? response({ error: {} }, 404) : fallback(url, init),
      );
      expect(await f.run()).toBe("completed");
      expect(await f.originals()).toHaveLength(0);
      expect((await f.current()).coverage).toBe("incomplete");
      expect((await f.current()).last_issue).toMatchObject({
        code: "CPL_GMAIL_MESSAGE_UNAVAILABLE",
      });
    });
    it("fails changed immutable message content without overwriting the earlier capture", async () => {
      const f = await fixture();
      await f.run();
      const before = await f.originals();
      await admin.query(
        "UPDATE cpl_integration_sources SET history_id=NULL,page_json=NULL,coverage='not_started' WHERE organization_id=$1 AND id=$2",
        [f.request.organizationId, f.connection.id],
      );
      f.setTransport(async (url, init, fallback) => {
        const id = /\/messages\/([^?]+)/u.exec(url)?.[1];
        return id ? response(syntheticMessage(id)) : fallback(url, init);
      });
      expect(await f.run()).toBe("failed");
      expect((await f.originals()).map((o) => o.original_sha256)).toEqual(
        before.map((o) => o.original_sha256),
      );
      expect((await f.current()).last_issue).toMatchObject({
        code: "CPL_INTEGRATION_SOURCE_CONFLICT",
      });
    });
    it("does not make provider calls when trusted runtime configuration is disabled", async () => {
      const f = await fixture(),
        c = await f.claim();
      expect(await processCplGmailSync(worker, c.job, c.lease, {})).toBe("skipped");
      expect(f.calls()).toBe(0);
    });
    it("requires reconnect if the bootstrap Gmail profile disagrees with the encrypted verified account", async () => {
      const f = await fixture();
      f.setTransport(async (url, init, fallback) =>
        new URL(url).pathname.endsWith("/profile")
          ? response({
              emailAddress: "different@example.invalid",
              historyId: "101",
              messagesTotal: 1,
              threadsTotal: 1,
            })
          : fallback(url, init),
      );
      expect(await f.run()).toBe("failed");
      expect((await f.current()).state).toBe("reconnect_required");
      expect((await f.current()).history_id).toBeNull();
      expect(await f.originals()).toHaveLength(0);
    });
    it("refuses a provider page larger than requested without exceeding the intake bound", async () => {
      const f = await fixture();
      f.setTransport(async (url, init, fallback) =>
        new URL(url).pathname.endsWith("/messages")
          ? response({ messages: Array.from({ length: 11 }, (_, i) => ({ id: "oversized" + i })) })
          : fallback(url, init),
      );
      expect(await f.run()).toBe("failed");
      expect(await f.originals()).toHaveLength(0);
      expect((await f.current()).history_id).toBeNull();
    });
    it("waits for a human operation lease without using credentials or altering its token", async () => {
      const f = await fixture(),
        humanToken = randomUUID();
      await admin.query(
        "UPDATE cpl_integration_sources SET operation_token=$3,operation_expires_at=clock_timestamp()+INTERVAL '25 seconds' WHERE organization_id=$1 AND id=$2",
        [f.request.organizationId, f.connection.id, humanToken],
      );
      expect(await f.run()).toBe("retrying");
      expect(f.calls()).toBe(0);
      expect((await f.current()).operation_token).toBe(humanToken);
      expect(await f.originals()).toHaveLength(0);
    });
    it("rejects a late response after its operation token changes and never clears the new token", async () => {
      const f = await fixture(),
        replacement = randomUUID();
      f.setTransport(async (url, init, fallback) => {
        const r = await fallback(url, init);
        if (/\/messages\//u.test(url))
          await admin.query(
            "UPDATE cpl_integration_sources SET operation_token=$3,operation_expires_at=clock_timestamp()+INTERVAL '25 seconds' WHERE organization_id=$1 AND id=$2",
            [f.request.organizationId, f.connection.id, replacement],
          );
        return r;
      });
      expect(await f.run()).toBe("retrying");
      expect(await f.originals()).toHaveLength(0);
      expect((await f.current()).operation_token).toBe(replacement);
    });
    it("keeps a from-now checkpoint and consumes every incremental history page before advancing it", async () => {
      const f = await fixture();
      const base = "900719925474099300",
        final = "900719925474099309";
      await admin.query(
        "UPDATE cpl_integration_sources SET history_id=$3 WHERE organization_id=$1 AND id=$2",
        [f.request.organizationId, f.connection.id, base],
      );
      const starts: string[] = [],
        pages: string[] = [];
      f.setTransport(async (url, init, fallback) => {
        const u = new URL(url);
        if (u.pathname.endsWith("/history")) {
          starts.push(u.searchParams.get("startHistoryId")!);
          pages.push(u.searchParams.get("pageToken") ?? "first");
          return response(
            u.searchParams.has("pageToken")
              ? {
                  historyId: final,
                  history: [
                    { id: "900719925474099308", messagesAdded: [{ message: { id: "hist4" } }] },
                  ],
                }
              : {
                  historyId: final,
                  nextPageToken: "page-two",
                  history: [
                    {
                      id: "900719925474099307",
                      messagesAdded: Array.from({ length: 4 }, (_, i) => ({
                        message: { id: "hist" + i },
                      })),
                    },
                  ],
                },
          );
        }
        const id = /\/messages\/(hist\d+)/u.exec(url)?.[1];
        return id ? response(syntheticMessage(id)) : fallback(url, init);
      });
      expect(await f.run()).toBe("completed");
      expect((await f.current()).history_id).toBe(base);
      expect((await f.current()).page_json).toMatchObject({ nextPageToken: "page-two" });
      expect(await f.run()).toBe("completed");
      expect((await f.current()).history_id).toBe(final);
      expect(await f.originals()).toHaveLength(5);
      expect(starts).toEqual([base, base]);
      expect(pages).toEqual(["first", "page-two"]);
    });
    it("treats deletion history as evidence of a gap and preserves an already captured original", async () => {
      const f = await fixture();
      await f.run();
      const before = await f.originals();
      f.setTransport(async (url, init, fallback) =>
        new URL(url).pathname.endsWith("/history")
          ? response({
              historyId: "900719925474099399",
              history: [
                {
                  id: "900719925474099398",
                  messagesDeleted: [{ message: { id: before[0]!.external_event_id } }],
                },
              ],
            })
          : fallback(url, init),
      );
      expect(await f.run()).toBe("completed");
      expect((await f.originals()).map((o) => o.original_sha256)).toEqual(
        before.map((o) => o.original_sha256),
      );
      expect((await f.current()).last_issue).toMatchObject({ code: "CPL_GMAIL_MESSAGE_REMOVED" });
    });
    it("honors a bounded backfill cap and reports incomplete historical coverage explicitly", async () => {
      const f = await fixture();
      const c = await f.claim();
      await admin.query(
        `UPDATE cpl_integration_sources SET page_json=$3::jsonb WHERE organization_id=$1 AND id=$2`,
        [
          f.request.organizationId,
          f.connection.id,
          JSON.stringify({
            version: 1,
            mode: "backfill",
            baseHistoryId: "101",
            checkpoint: "101",
            nextPageToken: null,
            loaded: false,
            pending: [],
            remaining: 1,
            after: new Date(Date.now() - 86400000).toISOString(),
            warnings: [],
          }),
        ],
      );
      f.setTransport(async (url, init, fallback) => {
        const u = new URL(url);
        if (u.pathname.endsWith("/messages")) {
          expect(u.searchParams.get("maxResults")).toBe("1");
          return response({ messages: [{ id: "cap-one" }], nextPageToken: "remaining-page" });
        }
        return /\/messages\/cap-one/u.test(url)
          ? response(syntheticMessage("cap-one"))
          : fallback(url, init);
      });
      expect(await processCplGmailSync(worker, c.job, c.lease, f.options)).toBe("completed");
      expect(await f.originals()).toHaveLength(1);
      expect((await f.current()).last_issue).toMatchObject({ code: "CPL_GMAIL_BACKFILL_LIMIT" });
      expect((await f.current()).coverage).toBe("incomplete");
    });
    it("does not deduplicate the same provider message ID across different tenant accounts", async () => {
      const a = await fixture(),
        b = await fixture();
      for (const f of [a, b])
        f.setTransport(async (url, init, fallback) =>
          new URL(url).pathname.endsWith("/messages")
            ? response({ messages: [{ id: "same-id" }] })
            : /\/messages\/same-id/u.test(url)
              ? response(syntheticMessage("same-id"))
              : fallback(url, init),
        );
      expect(await a.run()).toBe("completed");
      expect(await b.run()).toBe("completed");
      expect(await a.originals()).toHaveLength(1);
      expect(await b.originals()).toHaveLength(1);
      expect((await a.originals())[0]!.account_id).not.toBe((await b.originals())[0]!.account_id);
    });
    it("never overwrites a newer credential revision when refresh returns late", async () => {
      const f = await fixture();
      await f.storeTokens({
        ...f.grant.tokens,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      f.setTransport(async (url, init, fallback) => {
        const result = await fallback(url, init);
        if (url === "https://oauth2.googleapis.com/token") await f.storeTokens(f.grant.tokens, 2);
        return result;
      });
      expect(await f.run()).toBe("completed");
      const row = (
        await admin.query<IntegrationRow>(
          "SELECT revision,envelope FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2",
          [f.request.organizationId, f.connection.id],
        )
      ).rows[0]!;
      expect(Number(row.revision)).toBe(2);
      const bytes = await secretBox.open({
        envelope: row.envelope as Parameters<typeof secretBox.open>[0]["envelope"],
        context: {
          purpose: "gmail_tokens",
          organizationId: f.request.organizationId,
          sourceId: f.connection.id,
          credentialRevision: 2,
        },
      });
      expect(JSON.parse(new TextDecoder().decode(bytes)).tokens.accessToken).toBe(
        f.grant.tokens.accessToken,
      );
    });
  },
);
