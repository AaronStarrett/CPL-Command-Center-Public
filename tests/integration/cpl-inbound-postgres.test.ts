import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import { migrateDatabase } from "../../packages/database/src/migrations";
import {
  configureHostedRuntimeRole,
  configureCplIngestionWorker,
} from "../../packages/database/src/hosted-database-role";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store";
import { SqlCplTenantRepository } from "../../packages/database/src/tenant-repository";
import {
  SqlCplWorkflowRepository,
  processHostedJobs,
} from "../../packages/database/src/hosted-workflow";
import { SqlCplAutomationRepository } from "../../packages/database/src/cpl-automation-repository";
import { processCplIngestionJob } from "../../packages/database/src/cpl-ingestion-worker";
import { SqlCplInboundRepository } from "../../packages/database/src/cpl-inbound-repository";
import { SqlCplIntegrationRepository } from "../../packages/database/src/cpl-integration-repository";
import {
  createIntegrationSecretBox,
  verifyCplInboundSubmission,
  signCplInboundSubmission,
  createGoogleIntegrationIdentityVerifier,
} from "../../packages/security/src/cpl-integration-security";
import { createCplGmailHttpFixture } from "../../packages/security/src/cpl-integration-fixture";
import { CplGoogleGmailAdapter } from "../../packages/integrations/src/cpl-gmail";
import { generateKeyPair, exportJWK, type JWK } from "jose";
import type { CplIntegrationRepositoryOptions } from "../../packages/database/src/cpl-integration-ports";

const material = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON,
  configPath = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
(material || configPath ? describe : describe.skip)(
  "durable inbound on isolated real PostgreSQL",
  () => {
    let worker: PgSqlDatabaseAdapter,
      inbound: SqlCplInboundRepository,
      integrations: SqlCplIntegrationRepository,
      control: PgSqlDatabaseAdapter,
      admin: PgSqlDatabaseAdapter,
      web: PgSqlDatabaseAdapter,
      auth: SqlCplHostedAuthStore,
      tenants: SqlCplTenantRepository,
      intake: SqlCplWorkflowRepository;
    const db = `cpl_inbound_test_${randomBytes(6).toString("hex")}`;
    let created = false;
    const envelopeKey = randomBytes(32),
      fixtureSecret = randomBytes(32),
      redirectUri = "http://127.0.0.1:3400/api/cpl-integrations/oauth/google/callback";
    let privateJwk: JWK, publicJwk: JWK;
    const fixtures = new Map<string, Awaited<ReturnType<typeof createCplGmailHttpFixture>>>();
    const options: CplIntegrationRepositoryOptions = {
      providerMode: "local_fixture",
      keyVersion: "test-v1",
      redirectUri,
      secretBox: createIntegrationSecretBox({ resolveKey: async () => envelopeKey }),
      signedSubmissions: { verify: verifyCplInboundSubmission },
      createGmailAdapter: async ({ organizationId, assertCurrent, signal }) => {
        let fixture = fixtures.get(organizationId);
        if (!fixture) {
          fixture = await createCplGmailHttpFixture({
            fixtureId: organizationId,
            fixtureEpoch: new Date(Date.now() - 60000).toISOString(),
            privateJwk,
            publicJwk,
            fixtureSecret,
            redirectUri,
          });
          fixtures.set(organizationId, fixture);
        }
        return new CplGoogleGmailAdapter(fixture.configuration, {
          fetch: fixture.fetch,
          assertCurrent,
          signal,
          verifyIdentity: createGoogleIntegrationIdentityVerifier(),
          now: () => new Date(),
        });
      },
    };
    beforeAll(async () => {
      const key = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
      privateJwk = await exportJWK(key.privateKey);
      publicJwk = await exportJWK(key.publicKey);
      const c = JSON.parse(material ?? readFileSync(configPath!, "utf8"));
      for (const raw of [c.adminUrl, c.webUrl, c.workerUrl])
        if (!["127.0.0.1", "localhost"].includes(new URL(raw).hostname))
          throw Error("Local isolated PostgreSQL only");
      const connection = (raw: string) => {
        const u = new URL(raw);
        u.pathname = "/" + db;
        return u.href;
      };
      control = new PgSqlDatabaseAdapter({ connectionString: c.adminUrl, max: 1 });
      await control.execute(`CREATE DATABASE "${db}"`);
      created = true;
      admin = new PgSqlDatabaseAdapter({ connectionString: connection(c.adminUrl), max: 2 });
      await migrateDatabase(admin);
      await configureHostedRuntimeRole(admin, new URL(c.webUrl).username, "web");
      await configureHostedRuntimeRole(admin, new URL(c.workerUrl).username, "worker");
      await configureCplIngestionWorker(admin, new URL(c.workerUrl).username);
      worker = new PgSqlDatabaseAdapter({ connectionString: connection(c.workerUrl), max: 3 });
      web = new PgSqlDatabaseAdapter({ connectionString: connection(c.webUrl), max: 3 });
      auth = new SqlCplHostedAuthStore(web);
      tenants = new SqlCplTenantRepository(web);
      intake = new SqlCplWorkflowRepository(web, tenants);
      inbound = new SqlCplInboundRepository(web, tenants, options);
      integrations = new SqlCplIntegrationRepository(web, tenants, options);
    }, 180000);
    afterAll(async () => {
      await worker?.close();
      await web?.close();
      await admin?.close();
      if (created) await control.execute(`DROP DATABASE "${db}" WITH(FORCE)`);
      await control?.close();
    }, 60000);
    async function actor() {
      const raw = randomBytes(32).toString("base64url"),
        now = new Date().toISOString();
      const session = await auth.createSession({
        identity: {
          issuer: "https://accounts.google.com",
          subject: randomUUID(),
          email: "fictional@example.invalid",
          emailVerified: true,
          hostedDomain: null,
          displayName: "Fictional company operator",
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
      return { raw, session };
    }
    async function fixture() {
      const a = await actor(),
        org = await tenants.createOrganization(a.raw, {
          slug: randomUUID(),
          displayName: "Fictional Company",
        }),
        request = { organizationId: org.id, sessionToken: a.raw };
      await admin.query(
        "UPDATE cpl_module_entitlements SET enabled=TRUE,usage_limit=NULL WHERE organization_id=$1",
        [org.id],
      );
      return { a, org, request };
    }
    const fields = [
      {
        key: "title",
        target: { kind: "builtin", field: "title" },
        label: "Request",
        type: "text",
        required: true,
        maxLength: 240,
        options: [],
      },
    ];
    async function formFixture() {
      const f = await fixture();
      const mapping = await integrations.saveMapping({
        ...f.request,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: {
          name: "Fictional form mapping",
          sourceKind: "form",
          rules: [
            {
              source: { kind: "form_field", key: "title" },
              target: { kind: "builtin", field: "title" },
              transform: "trim",
            },
          ],
        },
      });
      let form = await inbound.saveForm({
        ...f.request,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: {
          name: "Fictional inquiry",
          title: "Fictional service inquiry",
          description: "Controlled test inquiry",
          fields,
          publishedServiceIds: [],
          confirmationText: "Inquiry received for review.",
          mappingId: mapping.id,
          mappingVersion: mapping.version,
        },
      });
      form = await inbound.setFormEnabled({
        ...f.request,
        formId: form.id,
        expectedRevision: form.revision,
        enabled: true,
        reason: "Enable synthetic fixture",
        idempotencyKey: randomUUID(),
      });
      return { ...f, mapping, form };
    }
    const body = (
      f: Awaited<ReturnType<typeof formFixture>>,
      eventId = randomUUID(),
      title = "Fictional form scope",
    ) =>
      Buffer.from(
        JSON.stringify({
          configurationVersion: f.form.configurationVersion,
          eventId,
          values: { title },
          serviceId: null,
        }),
      );
    const submit = (f: Awaited<ReturnType<typeof formFixture>>, rawBody = body(f)) =>
      inbound.acceptSubmission({
        source: "browser_form",
        publicId: f.form.publicId,
        addressKey: "untrusted-client",
        rawBody,
      });
    it("persists original receipt then creates one non-ready lead through the ordinary restricted worker", async () => {
      const f = await formFixture(),
        raw = body(f);
      const result = await submit(f, raw);
      expect(result.status).toBe("accepted");
      const before = await intake.listLeads(f.request);
      expect(before).toHaveLength(0);
      expect(await processHostedJobs(worker, { claimOwner: "test", limit: 1 })).toMatchObject({
        claimed: 1,
        completed: 1,
      });
      const leads = await intake.listLeads(f.request);
      expect(leads).toHaveLength(1);
      expect(leads[0]).toMatchObject({
        title: "Fictional form scope",
        sourceType: "website_form",
        status: "new",
        assignedMemberIdentityId: null,
      });
      expect(leads[0]!.readiness.readyForProposal).toBe(false);
      const receipts = await integrations.listReceipts(f.request);
      expect(receipts.items).toHaveLength(1);
      const detail = await integrations.getReceipt({
        ...f.request,
        receiptId: receipts.items[0]!.id,
      });
      expect(detail.linkedLeadId).toBe(leads[0]!.id);
      expect(detail.original.sha256).toBe(sha(raw.toString()));
      expect(detail.original.plainText).toBe(raw.toString());
      expect(detail.normalizations).toHaveLength(1);
      expect(await submit(f, raw)).toMatchObject({ reference: result.reference });
      expect(await processHostedJobs(worker, { claimOwner: "test" })).toMatchObject({ claimed: 0 });
      expect(await intake.listLeads(f.request)).toHaveLength(1);
    });
    it("maps published calendar dates to company midnight through preview and the normal worker while preserving raw evidence", async () => {
      const f = await fixture();
      await admin.query(
        "INSERT INTO cpl_organization_settings(organization_id,setting_key,value_json,updated_by_identity_id) VALUES($1,'company.profile',$2::jsonb,$3)",
        [f.org.id, JSON.stringify({ timeZone: "America/Los_Angeles" }), f.a.session.identityId],
      );
      const dateFields = ["requestedDeadlineAt", "requestedVisitAt"] as const;
      const mapping = await integrations.saveMapping({
        ...f.request,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: {
          name: "Fictional dated inquiry",
          sourceKind: "form",
          rules: [
            {
              source: { kind: "form_field", key: "title" },
              target: { kind: "builtin", field: "title" },
              transform: "trim",
            },
            ...dateFields.map((field, index) => ({
              source: { kind: "form_field", key: `date_${index}` },
              target: { kind: "builtin", field },
              transform: "none",
            })),
          ],
        },
      });
      let form = await inbound.saveForm({
        ...f.request,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: {
          name: "Fictional dates",
          title: "Fictional dates",
          description: "",
          publishedServiceIds: [],
          confirmationText: "Received for review",
          fields: [
            ...fields,
            ...dateFields.map((field, index) => ({
              key: `date_${index}`,
              target: { kind: "builtin", field },
              label: field,
              type: "date",
              required: true,
              maxLength: null,
              options: [],
            })),
          ],
          mappingId: mapping.id,
          mappingVersion: mapping.version,
        },
      });
      form = await inbound.setFormEnabled({
        ...f.request,
        formId: form.id,
        expectedRevision: form.revision,
        enabled: true,
        reason: "Test calendar dates",
        idempotencyKey: randomUUID(),
      });
      const values = { title: "Fictional dates", date_0: "2026-10-10", date_1: "2026-01-06" };
      const expectedDates = {
        requestedDeadlineAt: "2026-10-10T07:00:00.000Z",
        requestedVisitAt: "2026-01-06T08:00:00.000Z",
      };
      expect(
        await integrations.previewMapping({ ...f.request, input: mapping.input, sample: values }),
      ).toMatchObject({
        fields: { fields: expectedDates, dateOnlyTimeZone: "America/Los_Angeles" },
      });
      await expect(
        integrations.previewMapping({
          ...f.request,
          input: mapping.input,
          sample: { ...values, date_0: "2026-02-30" },
        }),
      ).rejects.toMatchObject({ code: "CPL_MAPPING_VALUE_INVALID" });
      const raw = Buffer.from(
        JSON.stringify({
          configurationVersion: form.configurationVersion,
          eventId: randomUUID(),
          values,
          serviceId: null,
        }),
      );
      const submission = {
        source: "browser_form" as const,
        publicId: form.publicId,
        addressKey: "untrusted",
        rawBody: raw,
      };
      const accepted = await inbound.acceptSubmission(submission);
      expect(await processHostedJobs(worker, { claimOwner: "date-test", limit: 1 })).toMatchObject({
        completed: 1,
      });
      const leads = await intake.listLeads(f.request);
      expect(leads).toHaveLength(1);
      expect(leads[0]).toMatchObject({ ...expectedDates, status: "new" });
      const receipt = (await integrations.listReceipts(f.request)).items[0]!;
      const detail = await integrations.getReceipt({ ...f.request, receiptId: receipt.id });
      expect(detail.normalizations[0]!.fields).toMatchObject({
        ...expectedDates,
        dateOnlyTimeZone: "America/Los_Angeles",
      });
      expect(detail.original.plainText).toBe(raw.toString());
      expect(detail.original.sha256).toBe(sha(raw.toString()));
      expect(await inbound.acceptSubmission(submission)).toMatchObject({
        reference: accepted.reference,
      });
      expect(await processHostedJobs(worker, { claimOwner: "date-retry", limit: 1 })).toMatchObject(
        { claimed: 0 },
      );
      expect(await intake.listLeads(f.request)).toHaveLength(1);
    });
    it("refuses changed original bytes even when field trimming produces identical values", async () => {
      const f = await formFixture(),
        event = randomUUID();
      await submit(f, body(f, event, "  Same scope  "));
      await expect(submit(f, body(f, event, "Same scope"))).rejects.toMatchObject({
        code: "CPL_INTEGRATION_SOURCE_CONFLICT",
      });
      await processHostedJobs(worker, { claimOwner: "test" });
    });
    it("retains a receipt across a database reconnect and processes it after resuming the normal worker", async () => {
      const f = await formFixture();
      await submit(f);
      const second = new SqlCplInboundRepository(web, new SqlCplTenantRepository(web));
      expect(await second.readPublicForm(f.form.publicId)).toMatchObject({
        publicId: f.form.publicId,
      });
      expect(await processHostedJobs(worker, { claimOwner: "reconnected" })).toMatchObject({
        completed: 1,
      });
      expect(await intake.listLeads(f.request)).toHaveLength(1);
    });
    it("blocks queued work after source disable, preserving original receipt and creating no lead", async () => {
      const f = await formFixture();
      await submit(f);
      await inbound.setFormEnabled({
        ...f.request,
        formId: f.form.id,
        expectedRevision: f.form.revision,
        enabled: false,
        reason: "Stop intake",
        idempotencyKey: randomUUID(),
      });
      expect(await processHostedJobs(worker, { claimOwner: "test" })).toMatchObject({ skipped: 1 });
      expect(await intake.listLeads(f.request)).toHaveLength(0);
      expect((await integrations.listReceipts(f.request)).items[0]).toMatchObject({
        state: "blocked",
      });
      await expect(inbound.readPublicForm(f.form.publicId)).rejects.toMatchObject({
        code: "CPL_INTEGRATION_NOT_FOUND",
      });
      expect(await inbound.readFormPreview({ ...f.request, formId: f.form.id })).toMatchObject({
        publicId: f.form.publicId,
      });
    });
    it("does not revive a stale configuring membership grant after suspension and reactivation", async () => {
      const f = await formFixture();
      await submit(f);
      await admin.query(
        "UPDATE cpl_memberships SET status='suspended',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
        [f.org.id, f.a.session.identityId],
      );
      await admin.query(
        "UPDATE cpl_memberships SET status='active',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
        [f.org.id, f.a.session.identityId],
      );
      expect(await processHostedJobs(worker, { claimOwner: "test" })).toMatchObject({ skipped: 1 });
      expect(await intake.listLeads(f.request)).toHaveLength(0);
      await expect(submit(f)).rejects.toMatchObject({ code: "CPL_INTEGRATION_NOT_FOUND" });
    });
    it("rejects cross-company receipt, source and mapping references", async () => {
      const a = await formFixture(),
        b = await formFixture();
      await submit(a);
      const id = (await integrations.listReceipts(a.request)).items[0]!.id;
      await expect(integrations.getReceipt({ ...b.request, receiptId: id })).rejects.toMatchObject({
        code: "CPL_INTEGRATION_NOT_FOUND",
      });
      await expect(
        inbound.readFormPreview({ ...b.request, formId: a.form.id }),
      ).rejects.toMatchObject({ code: "CPL_INTEGRATION_NOT_FOUND" });
      await expect(
        inbound.saveForm({
          ...b.request,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
          input: a.form.input,
        }),
      ).rejects.toMatchObject({ code: "CPL_INTEGRATION_MAPPING_INVALID" });
      await processHostedJobs(worker, { claimOwner: "test" });
    });
    it("validates current form version, strict fields and pinned mapping destination", async () => {
      const f = await formFixture();
      const raw = JSON.parse(body(f).toString());
      await expect(
        submit(f, Buffer.from(JSON.stringify({ ...raw, organizationId: randomUUID() }))),
      ).rejects.toMatchObject({ code: "CPL_INBOUND_INVALID_INPUT" });
      await expect(
        submit(f, Buffer.from(JSON.stringify({ ...raw, configurationVersion: 1 }))),
      ).rejects.toMatchObject({ code: "CPL_FORM_CONFIGURATION_CHANGED" });
      await expect(
        inbound.saveForm({
          ...f.request,
          formId: f.form.id,
          expectedRevision: f.form.revision,
          idempotencyKey: randomUUID(),
          input: {
            ...f.form.input,
            fields: [{ ...fields[0], target: { kind: "builtin", field: "details" } }],
          },
        }),
      ).rejects.toMatchObject({ code: "CPL_INTEGRATION_MAPPING_INVALID" });
    });
    it("commits bounded abuse counters for invalid public identifiers without allocating attacker-keyed rows", async () => {
      const n = Number(
        (await admin.query<{ count: string }>("SELECT count(*) FROM cpl_inbound_rate_buckets"))
          .rows[0]!.count,
      );
      for (let i = 0; i < 3; i++)
        await expect(
          inbound.acceptSubmission({
            source: "browser_form",
            publicId: "missing-" + randomUUID(),
            addressKey: randomUUID(),
            rawBody: Buffer.from("{}"),
          }),
        ).rejects.toMatchObject({ code: "CPL_INTEGRATION_NOT_FOUND" });
      expect(
        Number(
          (await admin.query<{ count: string }>("SELECT count(*) FROM cpl_inbound_rate_buckets"))
            .rows[0]!.count,
        ),
      ).toBe(n);
      await expect(web.query("SELECT * FROM cpl_inbound_rate_buckets")).rejects.toMatchObject({
        code: "42501",
      });
    });
    it("rolls back original, receipt and queued job together when queue insertion fails", async () => {
      const f = await formFixture();
      await admin.execute(
        "CREATE FUNCTION cpl_test_refuse_inbound() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='inbound.receipt.process' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER cpl_test_refuse BEFORE INSERT ON cpl_workflow_jobs FOR EACH ROW EXECUTE FUNCTION cpl_test_refuse_inbound()",
      );
      try {
        await expect(submit(f)).rejects.toThrow();
        expect((await integrations.listReceipts(f.request)).items).toHaveLength(0);
      } finally {
        await admin.execute(
          "DROP TRIGGER cpl_test_refuse ON cpl_workflow_jobs; DROP FUNCTION cpl_test_refuse_inbound()",
        );
      }
    });
    it("requires explicit ingestion opt-in and refuses web-role job execution", async () => {
      const f = await formFixture();
      await submit(f);
      await admin.execute(
        "UPDATE cpl_runtime_roles SET ingestion_enabled=FALSE WHERE purpose='worker'",
      );
      try {
        expect(await processHostedJobs(worker, { claimOwner: "legacy" })).toMatchObject({
          claimed: 0,
        });
        await expect(processHostedJobs(web, { claimOwner: "browser" })).rejects.toThrow(
          "CPL_HOSTED_DATABASE_ROLE_REFUSED",
        );
      } finally {
        const role = (await worker.query<{ role: string }>("SELECT current_user AS role")).rows[0]!
          .role;
        await configureCplIngestionWorker(admin, role);
      }
      await processHostedJobs(worker, { claimOwner: "test" });
    });
    async function signedFixture() {
      const f = await formFixture();
      const rotated = await inbound.rotateSourceCredential({
        ...f.request,
        formId: f.form.id,
        expectedRevision: f.form.revision,
        reason: "Synthetic signed producer",
        idempotencyKey: randomUUID(),
      });
      return {
        ...f,
        form: rotated.form,
        key: Buffer.from(rotated.credential.secret, "base64url"),
        keyId: rotated.credential.keyId,
      };
    }
    async function signed(
      f: Awaited<ReturnType<typeof signedFixture>>,
      rawBody = body(f),
      nonce = randomBytes(32).toString("base64url"),
    ) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = await signCplInboundSubmission({
        method: "POST",
        publicId: f.form.publicId,
        keyId: f.keyId,
        keyGeneration: f.form.signedSource.generation,
        timestamp,
        nonce,
        rawBody,
        key: f.key,
      });
      return {
        source: "signed_form" as const,
        publicId: f.form.publicId,
        keyId: f.keyId,
        timestamp,
        nonce,
        rawBody,
        signature,
        addressKey: "no-trusted-address",
      };
    }
    it("verifies actual HMAC and returns one durable receipt for identical nonce and fresh-nonce retries", async () => {
      const f = await signedFixture(),
        raw = body(f),
        envelope = await signed(f, raw),
        receipt = await inbound.acceptSubmission(envelope);
      expect(await inbound.acceptSubmission(envelope)).toMatchObject({
        reference: receipt.reference,
      });
      expect(await inbound.acceptSubmission(await signed(f, raw))).toMatchObject({
        reference: receipt.reference,
      });
      expect((await integrations.listReceipts(f.request)).total).toBe(1);
      expect(await processHostedJobs(worker, { claimOwner: "test" })).toMatchObject({
        completed: 1,
      });
      expect(await intake.listLeads(f.request)).toHaveLength(1);
    });
    it("refuses reused nonce changed body, bad signature and revoked key without another original", async () => {
      const f = await signedFixture(),
        envelope = await signed(f);
      await inbound.acceptSubmission(envelope);
      const changed = await signed(f, body(f), envelope.nonce);
      await expect(inbound.acceptSubmission(changed)).rejects.toMatchObject({
        code: "CPL_INTEGRATION_REPLAY_REJECTED",
      });
      await expect(
        inbound.acceptSubmission({ ...envelope, signature: "A".repeat(43) }),
      ).rejects.toMatchObject({ code: "CPL_INTEGRATION_SIGNATURE_REJECTED" });
      await inbound.revokeSourceCredential({
        ...f.request,
        formId: f.form.id,
        expectedRevision: f.form.revision,
        reason: "Stop signed producer",
        idempotencyKey: randomUUID(),
      });
      await expect(inbound.acceptSubmission(await signed(f))).rejects.toMatchObject({
        code: "CPL_INTEGRATION_SIGNATURE_REJECTED",
      });
      expect((await integrations.listReceipts(f.request)).total).toBe(1);
      await processHostedJobs(worker, { claimOwner: "test" });
    });
    async function connected() {
      const f = await fixture();
      const connection = await integrations.createConnection({
        ...f.request,
        idempotencyKey: randomUUID(),
        input: {
          displayName: "Controlled Gmail connection",
          selection: null,
          mappingId: null,
          mappingVersion: null,
        },
      });
      const start = await integrations.startOAuth({
        ...f.request,
        connectionId: connection.id,
        expectedRevision: connection.revision,
        idempotencyKey: randomUUID(),
      });
      const flow = await fixtures.get(f.org.id)!.authorize(start.authorizationUrl);
      return { ...f, connection, flow, start };
    }
    it("uses the actual OAuth adapter with PKCE and JWT fixture, exact session binding and one-time callback consumption", async () => {
      const f = await connected(),
        wrong = await actor();
      await expect(
        integrations.completeOAuth({
          sessionToken: wrong.raw,
          state: f.flow.state,
          code: f.flow.code,
        }),
      ).rejects.toMatchObject({ code: "CPL_INTEGRATION_OAUTH_REJECTED" });
      expect(
        await integrations.completeOAuth({
          sessionToken: f.request.sessionToken,
          state: f.flow.state,
          code: f.flow.code,
        }),
      ).toEqual({ organizationId: f.org.id, connectionId: f.connection.id });
      await expect(
        integrations.completeOAuth({
          sessionToken: f.request.sessionToken,
          state: f.flow.state,
          code: f.flow.code,
        }),
      ).rejects.toMatchObject({ code: "CPL_INTEGRATION_OAUTH_REJECTED" });
      const current = await integrations.getConnection({
        ...f.request,
        connectionId: f.connection.id,
      });
      expect(current.state).toBe("paused");
      expect(current.account?.email).toMatch(/@example\.invalid$/u);
      expect(current.grantedScopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
      const stored = await admin.query<{ envelope: unknown }>(
        "SELECT envelope FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2",
        [f.org.id, f.connection.id],
      );
      expect(JSON.stringify(stored.rows)).not.toContain("accessToken");
      expect(JSON.stringify(stored.rows)).not.toContain(f.flow.code);
    });
    it("denies OAuth callback after a concurrent generation change or revoked initiating membership", async () => {
      const f = await connected();
      await integrations.changeConnectionState({
        ...f.request,
        connectionId: f.connection.id,
        expectedRevision: f.connection.revision + 1,
        action: "pause",
        reason: "Operator pause during consent",
        idempotencyKey: randomUUID(),
      });
      await expect(
        integrations.completeOAuth({
          sessionToken: f.a.raw,
          state: f.flow.state,
          code: f.flow.code,
        }),
      ).rejects.toMatchObject({ code: "CPL_INTEGRATION_CONFIGURATION_CHANGED" });
      const g = await connected();
      await admin.query(
        "UPDATE cpl_memberships SET role='member',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
        [g.org.id, g.a.session.identityId],
      );
      await expect(
        integrations.completeOAuth({
          sessionToken: g.a.raw,
          state: g.flow.state,
          code: g.flow.code,
        }),
      ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
      expect(
        (
          await admin.query("SELECT 1 FROM cpl_integration_credentials WHERE organization_id=$1", [
            g.org.id,
          ])
        ).rows,
      ).toHaveLength(0);
    });
    it("captures an explicit from-now checkpoint, queues one sync, and disconnect deletes only local encrypted credentials", async () => {
      const f = await connected();
      await integrations.completeOAuth({
        sessionToken: f.a.raw,
        state: f.flow.state,
        code: f.flow.code,
      });
      const current = await integrations.getConnection({
        ...f.request,
        connectionId: f.connection.id,
      });
      const labels = await integrations.listConnectionLabels({
        ...f.request,
        connectionId: f.connection.id,
      });
      const mapping = await integrations.saveMapping({
        ...f.request,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: {
          name: "Mail mapping",
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
      const configured = await integrations.saveConnection({
        ...f.request,
        connectionId: current.id,
        expectedRevision: current.revision,
        idempotencyKey: randomUUID(),
        reconcile: "from_now",
        input: {
          displayName: "Controlled mailbox",
          selection: {
            kind: "label",
            labelId: labels[0]!.id,
            labelName: labels[0]!.name,
            start: { kind: "from_now" },
            cadenceMinutes: 15,
          },
          mappingId: mapping.id,
          mappingVersion: mapping.version,
        },
      });
      expect(configured.checkpoint.historyId).toMatch(/^\d+$/u);
      const first = await integrations.enqueueSync({
        ...f.request,
        connectionId: current.id,
        expectedRevision: configured.revision,
        idempotencyKey: randomUUID(),
        reason: "Check configured sync",
      });
      const again = await integrations.enqueueSync({
        ...f.request,
        connectionId: current.id,
        expectedRevision: configured.revision,
        idempotencyKey: randomUUID(),
        reason: "Check same configured sync",
      });
      expect(again.jobId).toBe(first.jobId);
      await admin.query(
        "UPDATE cpl_workflow_jobs SET attempts=max_attempts,status='running',lease_token=$2,lease_owner='crashed',lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE organization_id=$1 AND id=$3",
        [f.org.id, randomUUID(), first.jobId],
      );
      expect(await processHostedJobs(worker, { claimOwner: "gmail-exhaustion" })).toMatchObject({
        failed: 1,
      });
      const failed = await integrations.getConnection({ ...f.request, connectionId: current.id });
      expect(failed).toMatchObject({ state: "failed", lastIssue: { retryable: true } });
      const actions = await new SqlCplAutomationRepository(tenants).getWorkspace(f.request);
      expect(actions.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: { kind: "integration", id: current.id, projectId: null, version: null },
          }),
        ]),
      );
      await integrations.changeConnectionState({
        ...f.request,
        connectionId: current.id,
        expectedRevision: configured.revision,
        idempotencyKey: randomUUID(),
        action: "disconnect",
        reason: "Disconnect this company source",
      });
      expect(
        (
          await admin.query("SELECT 1 FROM cpl_integration_credentials WHERE organization_id=$1", [
            f.org.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(fixtures.get(f.org.id)!.safeCounters().revoke ?? 0).toBe(0);
    });
    it("returns exact original evidence only with live tenant and source permission", async () => {
      const f = await formFixture(),
        other = await formFixture(),
        raw = body(f);
      await submit(f, raw);
      const receipt = (await integrations.listReceipts(f.request)).items[0]!;
      const evidence = await integrations.getReceiptEvidence({
        ...f.request,
        receiptId: receipt.id,
      });
      expect(Buffer.from(evidence.bytes).equals(raw)).toBe(true);
      expect(evidence).toMatchObject({
        sha256: sha(raw.toString()),
        byteLength: raw.length,
        mediaType: "application/octet-stream",
      });
      await expect(
        integrations.getReceiptEvidence({ ...other.request, receiptId: receipt.id }),
      ).rejects.toMatchObject({ code: "CPL_INTEGRATION_NOT_FOUND" });
      await admin.query(
        "UPDATE cpl_memberships SET role='field-user',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
        [f.org.id, f.a.session.identityId],
      );
      await expect(
        integrations.getReceiptEvidence({ ...f.request, receiptId: receipt.id }),
      ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
      await processHostedJobs(worker, { claimOwner: "test" });
    });
    it("pages immutable mapping versions without losing old pins or exposing another company", async () => {
      const f = await formFixture(),
        other = await formFixture();
      const next = await integrations.saveMapping({
        ...f.request,
        mappingId: f.mapping.id,
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        input: { ...f.mapping.input, name: "Reviewed mapping revision" },
      });
      const page1 = await integrations.listMappings({ ...f.request, limit: 1 });
      const page2 = await integrations.listMappings({
        ...f.request,
        limit: 1,
        cursor: page1.nextCursor!,
      });
      expect(page1).toMatchObject({ total: 2, items: [{ id: f.mapping.id, version: 1 }] });
      expect(page2).toMatchObject({
        total: 2,
        items: [{ id: f.mapping.id, version: 2 }],
        nextCursor: null,
      });
      expect(
        await integrations.getMapping({ ...f.request, mappingId: f.mapping.id, version: 1 }),
      ).toEqual(f.mapping);
      expect(next.version).toBe(2);
      await expect(
        integrations.getMapping({ ...other.request, mappingId: f.mapping.id, version: 1 }),
      ).rejects.toMatchObject({ code: "CPL_INTEGRATION_MAPPING_INVALID" });
    });
    it("reconciles exhausted receipt attention after an explicit safe retry without duplicate leads", async () => {
      const f = await formFixture(),
        other = await formFixture();
      await submit(f);
      const receipt = (await integrations.listReceipts(f.request)).items[0]!;
      await admin.query(
        "UPDATE cpl_workflow_jobs SET attempts=max_attempts,status='running',lease_token=$2,lease_owner='crashed',lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE organization_id=$1",
        [f.org.id, randomUUID()],
      );
      expect(await processHostedJobs(worker, { claimOwner: "recover" })).toMatchObject({
        claimed: 1,
        failed: 1,
      });
      const failed = await integrations.getReceipt({ ...f.request, receiptId: receipt.id });
      expect(failed).toMatchObject({ state: "failed", lastIssue: { retryable: true } });
      const actions = new SqlCplAutomationRepository(tenants),
        workspace = await actions.getWorkspace(f.request);
      expect(workspace.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: { kind: "source_receipt", id: receipt.id, projectId: null, version: null },
            availableActions: {
              canAssign: false,
              canStart: false,
              canComplete: false,
              canDismiss: false,
            },
          }),
        ]),
      );
      expect(workspace.counts).toMatchObject({ openTasks: 1, missingInformation: 1 });
      expect((await actions.getWorkspace(other.request)).tasks).toHaveLength(0);
      await integrations.retryReceipt({
        ...f.request,
        receiptId: receipt.id,
        expectedRevision: failed.revision,
        reason: "Recover bounded crash",
        idempotencyKey: randomUUID(),
      });
      expect(
        (await actions.getWorkspace(f.request)).tasks.filter(
          (t) => t.target.kind === "source_receipt",
        ),
      ).toHaveLength(0);
      expect(await processHostedJobs(worker, { claimOwner: "recover" })).toMatchObject({
        completed: 1,
      });
      expect(await intake.listLeads(f.request)).toHaveLength(1);
    });
    it("refuses expired error-path acknowledgement and leaves receipt and attempt history unchanged", async () => {
      const f = await formFixture();
      await submit(f);
      const lease = randomUUID();
      const job = (
        await admin.query<Record<string, unknown>>(
          "UPDATE cpl_workflow_jobs SET attempts=1,status='running',lease_token=$2,lease_owner='expired',lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE organization_id=$1 RETURNING *",
          [f.org.id, lease],
        )
      ).rows[0]!;
      const before = await integrations.getReceipt({
        ...f.request,
        receiptId: String(job.inbound_receipt_id),
      });
      await expect(processCplIngestionJob(worker, job, lease)).rejects.toThrow(
        "CPL_INTEGRATION_LEASE_LOST",
      );
      expect(await integrations.getReceipt({ ...f.request, receiptId: before.id })).toEqual(before);
      expect(await processHostedJobs(worker, { claimOwner: "fresh" })).toMatchObject({
        completed: 1,
      });
    });
    it("retains originals at the tenant count ceiling and rolls back nonce receipt and job allocation", async () => {
      const f = await signedFixture();
      await inbound.acceptSubmission(await signed(f));
      await admin.query(
        "INSERT INTO cpl_inbound_originals(organization_id,id,source_id,source_kind,external_event_id,configuration_version,generation,content_sha256,original_sha256,media_type,original_bytes,source_claims,mapping_id,mapping_version) SELECT o.organization_id,gen_random_uuid(),o.source_id,o.source_kind,'capacity-fixture-'||n,o.configuration_version,o.generation,o.content_sha256,o.original_sha256,o.media_type,o.original_bytes,o.source_claims,o.mapping_id,o.mapping_version FROM cpl_inbound_originals o CROSS JOIN generate_series(1,24999) n WHERE o.organization_id=$1",
        [f.org.id],
      );
      await expect(inbound.acceptSubmission(await signed(f))).rejects.toMatchObject({
        code: "CPL_INTEGRATION_STORAGE_LIMIT",
      });
      const totals = (
        await admin.query<{ originals: string; receipts: string; jobs: string; nonces: string }>(
          "SELECT (SELECT count(*) FROM cpl_inbound_originals WHERE organization_id=$1) AS originals,(SELECT count(*) FROM cpl_inbound_receipts WHERE organization_id=$1) AS receipts,(SELECT count(*) FROM cpl_workflow_jobs WHERE organization_id=$1) AS jobs,(SELECT count(*) FROM cpl_inbound_nonces WHERE organization_id=$1) AS nonces",
          [f.org.id],
        )
      ).rows[0];
      expect(totals).toEqual({ originals: "25000", receipts: "1", jobs: "1", nonces: "1" });
      await processHostedJobs(worker, { claimOwner: "test" });
    });
    it("reprocesses mapping as append-only preview while preserving the linked human lead and original bytes", async () => {
      const f = await formFixture(),
        raw = body(f);
      await submit(f, raw);
      await processHostedJobs(worker, { claimOwner: "test" });
      const receipt = (await integrations.listReceipts(f.request)).items[0]!,
        leads = await intake.listLeads(f.request);
      const mapping = await integrations.saveMapping({
        ...f.request,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: {
          name: "Alternative preview",
          sourceKind: "form",
          rules: [
            {
              source: { kind: "literal", value: "Alternative normalized title" },
              target: { kind: "builtin", field: "title" },
              transform: "none",
            },
          ],
        },
      });
      const result = await integrations.reprocessReceipt({
        ...f.request,
        receiptId: receipt.id,
        expectedRevision: receipt.revision,
        mappingId: mapping.id,
        mappingVersion: 1,
        reason: "Review alternative mapping without overwriting human data",
        idempotencyKey: randomUUID(),
      });
      expect(result.normalizations).toHaveLength(2);
      expect(result.linkedLeadId).toBe(leads[0]!.id);
      expect(await intake.listLeads(f.request)).toEqual(leads);
      expect(
        Buffer.from(
          (await integrations.getReceiptEvidence({ ...f.request, receiptId: receipt.id })).bytes,
        ).equals(raw),
      ).toBe(true);
      await expect(
        integrations.retryReceipt({
          ...f.request,
          receiptId: receipt.id,
          expectedRevision: result.revision,
          reason: "Cannot create a second lead",
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CPL_INTEGRATION_REPLAY_REJECTED" });
    });
  },
);
