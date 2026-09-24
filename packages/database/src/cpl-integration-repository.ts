import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  Change,
  GmailConfiguration,
  IntegrationConnection,
  IntegrationWorkspace,
  MappingVersion,
  Page,
  PageInput,
  SourceReceiptDetail,
  SourceReceiptSummary,
  TenantRequest,
} from "@bea/domain/cpl-integrations";
import {
  inboundId,
  inboundInteger,
  inboundText,
  normalizeCplGmailConfiguration,
  normalizeCplInboundMapping,
} from "@bea/domain/cpl-inbound";
import { cplTenantRoleAllows } from "./tenant-repository.js";
import {
  CplIntegrationStore,
  integrationEvent,
  integrationFail,
  integrationIso,
  integrationJson,
  integrationMapping,
  mapCplInboundForOrganization,
  integrationMutation,
  integrationPage,
  integrationSource,
  integrationVersion,
  integrationHash,
  integrationBytesHash,
  type IntegrationRow,
} from "./cpl-integration-data.js";
import { SqlCplInboundRepository, enqueueInboundReceipt } from "./cpl-inbound-repository.js";
import type { SqlExecutor } from "./adapter.js";
import type {
  CplGmailAccount,
  CplGmailTokens,
  CplIntegrationSecretEnvelope,
  CplGoogleGmailAdapter,
} from "./cpl-integration-ports.js";

const opaque = () => randomBytes(32).toString("base64url");
const tokenDigest = (value: string) => createHash("sha256").update(value).digest("hex");
type OAuthMaterial = {
  nonce: string;
  verifier: string;
  redirectUri: string;
  operationToken: string;
};

const receiptQuery =
  "SELECT o.*,r.reference,r.revision,r.state,r.processing_attempts,r.linked_lead_id,r.linked_lead_version,r.last_issue,r.mapping_id AS processing_mapping_id,r.mapping_version AS processing_mapping_version FROM cpl_inbound_originals o JOIN cpl_inbound_receipts r ON r.organization_id=o.organization_id AND r.id=o.id";
function summary(row: IntegrationRow): SourceReceiptSummary {
  return {
    id: String(row.id),
    reference: String(row.reference),
    revision: Number(row.revision),
    sourceKind: row.source_kind as SourceReceiptSummary["sourceKind"],
    sourceId: String(row.source_id),
    providerAccountId: row.account_id ? String(row.account_id) : null,
    externalEventId: String(row.external_event_id),
    receivedAt: integrationIso(row.received_at),
    providerAt: row.provider_at ? integrationIso(row.provider_at) : null,
    contentSha256: String(row.content_sha256),
    state: row.state as SourceReceiptSummary["state"],
    mappingId: String(row.processing_mapping_id),
    mappingVersion: Number(row.processing_mapping_version),
    processingAttempts: Number(row.processing_attempts),
    linkedLeadId: row.linked_lead_id ? String(row.linked_lead_id) : null,
    linkedLeadVersion: row.linked_lead_version ? Number(row.linked_lead_version) : null,
    reviewRequired: true,
    lastIssue: row.last_issue ? integrationJson(row.last_issue) : null,
  };
}
export class SqlCplIntegrationRepository extends CplIntegrationStore {
  async getMapping(
    request: TenantRequest & { mappingId: string; version: number },
  ): Promise<MappingVersion> {
    return this.transaction(request, "integrations:read", (e, a) =>
      integrationMapping(e, a.organizationId, request.mappingId, request.version),
    );
  }
  /** Pages immutable versions, including older pins. Cursor order is (id,version). */
  async listMappings(request: TenantRequest & PageInput): Promise<Page<MappingVersion>> {
    const limit = inboundInteger(request.limit ?? 50, 1, 100);
    let afterId: string | null = null,
      afterVersion = 0;
    if (request.cursor !== undefined) {
      if (typeof request.cursor !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(request.cursor))
        integrationFail("CPL_INBOUND_INVALID_INPUT");
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
      } catch {
        integrationFail("CPL_INBOUND_INVALID_INPUT");
      }
      if (!Array.isArray(decoded) || decoded.length !== 2)
        integrationFail("CPL_INBOUND_INVALID_INPUT");
      afterId = inboundId(decoded[0]);
      afterVersion = inboundInteger(decoded[1], 1, 1000000);
    }
    return this.transaction(request, "integrations:read", async (e, a) => {
      const result = await e.query<IntegrationRow>(
        "SELECT * FROM cpl_inbound_mapping_versions WHERE organization_id=$1 AND ($2::uuid IS NULL OR (id,version)>($2::uuid,$3::integer)) ORDER BY id,version LIMIT $4",
        [a.organizationId, afterId, afterVersion, limit + 1],
      );
      const total = await e.query<{ count: string }>(
        "SELECT count(*) FROM cpl_inbound_mapping_versions WHERE organization_id=$1",
        [a.organizationId],
      );
      const selected = result.rows.slice(0, limit),
        last = selected.at(-1);
      return {
        items: selected.map((row) => ({
          id: String(row.id),
          version: Number(row.version),
          input: integrationJson(row.input),
          createdAt: integrationIso(row.created_at),
          createdByIdentityId: String(row.created_by_identity_id),
        })),
        total: Number(total.rows[0]!.count),
        limit,
        nextCursor:
          result.rows.length > limit && last
            ? Buffer.from(JSON.stringify([String(last.id), Number(last.version)])).toString(
                "base64url",
              )
            : null,
      };
    });
  }
  async saveMapping(
    request: TenantRequest & {
      mappingId?: string;
      expectedVersion: number;
      input: unknown;
      idempotencyKey: string;
    },
  ): Promise<MappingVersion> {
    const input = normalizeCplInboundMapping(request.input);
    inboundInteger(request.expectedVersion, 0, 1000000);
    return this.transaction(request, "integrations:configure", async (e, a) =>
      integrationMutation(
        e,
        a,
        "mapping.save",
        request.idempotencyKey,
        { mappingId: request.mappingId ?? null, expectedVersion: request.expectedVersion, input },
        async () => {
          const id = request.mappingId ? inboundId(request.mappingId) : randomUUID();
          const latest = await e.query<{ version: number }>(
            "SELECT COALESCE(max(version),0) AS version FROM cpl_inbound_mapping_versions WHERE organization_id=$1 AND id=$2",
            [a.organizationId, id],
          );
          if (Number(latest.rows[0]!.version) !== request.expectedVersion)
            integrationFail("CPL_INTEGRATION_STALE");
          await e.query(
            "INSERT INTO cpl_inbound_mapping_versions(organization_id,id,version,input,created_by_identity_id) VALUES($1,$2,$3,$4::jsonb,$5)",
            [
              a.organizationId,
              id,
              request.expectedVersion + 1,
              JSON.stringify(input),
              a.identityId,
            ],
          );
          return integrationMapping(e, a.organizationId, id, request.expectedVersion + 1);
        },
      ),
    );
  }
  async previewMapping(request: TenantRequest & { input: unknown; sample: unknown }) {
    const input = normalizeCplInboundMapping(request.input);
    return this.transaction(request, "integrations:configure", async (e, a) => {
      if (!request.sample || typeof request.sample !== "object" || Array.isArray(request.sample))
        integrationFail("CPL_INBOUND_INVALID_INPUT");
      return {
        fields: await mapCplInboundForOrganization(
          e,
          a.organizationId,
          input,
          request.sample as Record<string, unknown>,
        ),
        issues: [],
      };
    });
  }
  async listConnections(request: TenantRequest & PageInput): Promise<Page<IntegrationConnection>> {
    return this.transaction(request, "integrations:read", async (e, a) => {
      const page = integrationPage(request);
      const r = await e.query<IntegrationRow>(
        "SELECT id FROM cpl_integration_sources WHERE organization_id=$1 AND kind='gmail' AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3",
        [a.organizationId, page.cursor, page.limit + 1],
      );
      const count = await e.query<{ count: string }>(
        "SELECT count(*) FROM cpl_integration_sources WHERE organization_id=$1 AND kind='gmail'",
        [a.organizationId],
      );
      const items = [];
      for (const row of r.rows.slice(0, page.limit))
        items.push(await this.connection(e, a.organizationId, String(row.id)));
      return {
        items,
        total: Number(count.rows[0]!.count),
        limit: page.limit,
        nextCursor:
          r.rows.length > page.limit ? page.next(String(r.rows[page.limit - 1]!.id)) : null,
      };
    });
  }
  private async connection(
    e: SqlExecutor,
    org: string,
    id: string,
  ): Promise<IntegrationConnection> {
    const s = await integrationSource(e, org, id, "gmail");
    const account = s.account_id
      ? (
          await e.query<IntegrationRow>(
            "SELECT subject,email FROM cpl_integration_accounts WHERE organization_id=$1 AND id=$2",
            [org, s.account_id],
          )
        ).rows[0]
      : null;
    const credential = await e.query<IntegrationRow>(
      "SELECT scopes FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2 AND purpose='gmail_tokens'",
      [org, id],
    );
    const count = await e.query<IntegrationRow>(
      "SELECT count(*) AS total,count(*) FILTER(WHERE r.linked_lead_id IS NOT NULL) AS linked,count(*) FILTER(WHERE r.state='needs_review') AS review,count(*) FILTER(WHERE r.state IN('failed','blocked')) AS failed FROM cpl_inbound_originals o JOIN cpl_inbound_receipts r ON r.organization_id=o.organization_id AND r.id=o.id WHERE o.organization_id=$1 AND o.source_id=$2",
      [org, id],
    );
    const counts = count.rows[0]!;
    const configuration = integrationJson<GmailConfiguration>(s.input);
    return {
      id,
      revision: Number(s.revision),
      generation: Number(s.generation),
      configurationVersion: Number(s.configuration_version),
      provider: "google-gmail",
      mode: s.mode === "local_fixture" ? "local_fixture" : "live",
      state: s.state as IntegrationConnection["state"],
      displayName: configuration.displayName,
      account: account ? { subject: String(account.subject), email: String(account.email) } : null,
      grantedScopes: credential.rows[0] ? integrationJson(credential.rows[0].scopes) : [],
      authorizedByIdentityId: String(s.configured_by_identity_id),
      authorizedMembershipVersion: Number(s.authorized_membership_version),
      configuration,
      coverage: s.coverage as IntegrationConnection["coverage"],
      checkpoint: {
        historyId: s.history_id ? String(s.history_id) : null,
        pagePending: !!s.page_json,
      },
      lastAttemptAt: s.last_attempt_at ? integrationIso(s.last_attempt_at) : null,
      lastSuccessAt: s.last_success_at ? integrationIso(s.last_success_at) : null,
      nextEligibleAt: s.next_eligible_at ? integrationIso(s.next_eligible_at) : null,
      lastIssue: s.last_issue ? integrationJson(s.last_issue) : null,
      counts: {
        receipts: Number(counts.total),
        linkedLeads: Number(counts.linked),
        needsReview: Number(counts.review),
        failed: Number(counts.failed),
      },
    };
  }
  private requireProvider() {
    if (
      !this.options.createGmailAdapter ||
      !this.options.secretBox ||
      !this.options.keyVersion ||
      !this.options.redirectUri ||
      !this.options.providerMode ||
      this.options.providerMode === "disabled"
    )
      integrationFail("CPL_INTEGRATION_PROVIDER_DISABLED");
  }
  private async humanProvider(
    request: TenantRequest & { connectionId: string },
    generation: number,
    operationToken?: string,
    expectedMembershipVersion?: number,
  ): Promise<CplGoogleGmailAdapter> {
    this.requireProvider();
    const signal = AbortSignal.timeout(20000);
    const assertCurrent = async () => {
      if (signal.aborted) integrationFail("CPL_INTEGRATION_LEASE_LOST");
      await this.transaction(request, "integrations:configure", async (e, a) => {
        const s = await integrationSource(e, a.organizationId, request.connectionId, "gmail");
        if (
          expectedMembershipVersion !== undefined &&
          a.membershipVersion !== expectedMembershipVersion
        )
          integrationFail("CPL_INTEGRATION_AUTHORIZATION_REVOKED");
        if (
          Number(s.generation) !== generation ||
          s.state === "disconnected" ||
          (operationToken &&
            (s.operation_token !== operationToken ||
              new Date(s.operation_expires_at as string).getTime() <= Date.now()))
        )
          integrationFail("CPL_INTEGRATION_CONFIGURATION_CHANGED");
      });
    };
    return this.options.createGmailAdapter!({
      organizationId: request.organizationId,
      connectionId: request.connectionId,
      assertCurrent,
      signal,
    });
  }
  async startOAuth(
    request: TenantRequest & Change & { connectionId: string },
  ): Promise<{ authorizationUrl: string }> {
    this.requireProvider();
    const state = opaque(),
      nonce = opaque(),
      verifier = opaque(),
      operationToken = randomUUID();
    const prepared = await this.transaction(request, "integrations:configure", async (e, a) => {
      const existing = await e.query(
        "SELECT 1 FROM cpl_integration_mutations WHERE organization_id=$1 AND kind='oauth.start' AND idempotency_key=$2",
        [a.organizationId, request.idempotencyKey],
      );
      if (existing.rowCount) integrationFail("CPL_INTEGRATION_REPLAY_REJECTED");
      const source = await integrationSource(e, a.organizationId, request.connectionId, "gmail");
      if (Number(source.revision) !== request.expectedRevision)
        integrationFail("CPL_INTEGRATION_STALE");
      const session = await e.query<IntegrationRow>(
        "SELECT id FROM cpl_sessions WHERE token_hash=$1 AND identity_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()",
        [tokenDigest(request.sessionToken), a.identityId],
      );
      if (!session.rows[0]) integrationFail("CPL_INTEGRATION_OAUTH_REJECTED");
      const generation = Number(source.generation) + 1;
      const material: OAuthMaterial = {
        nonce,
        verifier,
        redirectUri: this.options.redirectUri!,
        operationToken,
      };
      const envelope = await this.options.secretBox!.seal({
        plaintext: Buffer.from(JSON.stringify(material)),
        context: {
          purpose: "oauth_attempt",
          organizationId: a.organizationId,
          sourceId: request.connectionId,
          credentialRevision: generation,
        },
        keyVersion: this.options.keyVersion!,
      });
      await e.query(
        "DELETE FROM cpl_integration_oauth_attempts WHERE organization_id=$1 AND (source_id=$2 OR expires_at<=clock_timestamp())",
        [a.organizationId, request.connectionId],
      );
      await e.query(
        "INSERT INTO cpl_integration_oauth_attempts(organization_id,source_id,state_hash,session_id,identity_id,membership_version,generation,envelope,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,clock_timestamp()+interval '5 minutes')",
        [
          a.organizationId,
          request.connectionId,
          tokenDigest(state),
          session.rows[0].id,
          a.identityId,
          a.membershipVersion,
          generation,
          JSON.stringify(envelope),
        ],
      );
      await e.query(
        "UPDATE cpl_integration_sources SET generation=$3,revision=revision+1,state='authorization_required',operation_token=$4,operation_expires_at=clock_timestamp()+interval '5 minutes',updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
        [a.organizationId, request.connectionId, generation, operationToken],
      );
      const row = await integrationSource(e, a.organizationId, request.connectionId);
      await integrationEvent(e, a, row, "integration.authorization.started");
      await integrationMutation(
        e,
        a,
        "oauth.start",
        request.idempotencyKey,
        { connectionId: request.connectionId, expectedRevision: request.expectedRevision },
        async () => ({ started: true }),
      );
      return { generation, membershipVersion: a.membershipVersion };
    });
    const adapter = await this.humanProvider(
      request,
      prepared.generation,
      operationToken,
      prepared.membershipVersion,
    );
    const authorizationUrl = await adapter.authorizationUrl({
      state,
      nonce,
      verifier,
      redirectUri: this.options.redirectUri!,
    });
    return { authorizationUrl };
  }
  async completeOAuth(request: {
    sessionToken: string;
    state: string;
    code?: string;
    error?: string;
  }): Promise<{ connectionId: string; organizationId: string }> {
    this.requireProvider();
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(request.state) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(request.sessionToken)
    )
      integrationFail("CPL_INTEGRATION_OAUTH_REJECTED");
    const resolved = await this.database.query<{ context: unknown }>(
      "SELECT cpl_integration_oauth_context($1,$2) AS context",
      [tokenDigest(request.state), tokenDigest(request.sessionToken)],
    );
    if (!resolved.rows[0]?.context) integrationFail("CPL_INTEGRATION_OAUTH_REJECTED");
    const context = integrationJson<{ organizationId: string; connectionId: string }>(
      resolved.rows[0].context,
    );
    const tenant = { ...context, sessionToken: request.sessionToken };
    const prepared = await this.transaction(tenant, "integrations:configure", async (e, a) => {
      const row = (
        await e.query<IntegrationRow>(
          "SELECT * FROM cpl_integration_oauth_attempts WHERE organization_id=$1 AND state_hash=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
          [a.organizationId, tokenDigest(request.state)],
        )
      ).rows[0];
      if (
        !row ||
        row.identity_id !== a.identityId ||
        Number(row.membership_version) !== a.membershipVersion
      )
        integrationFail("CPL_INTEGRATION_OAUTH_REJECTED");
      const session = await e.query("SELECT id FROM cpl_sessions WHERE id=$1 AND token_hash=$2", [
        row.session_id,
        tokenDigest(request.sessionToken),
      ]);
      if (!session.rowCount) integrationFail("CPL_INTEGRATION_OAUTH_REJECTED");
      const source = await integrationSource(e, a.organizationId, context.connectionId, "gmail");
      if (Number(source.generation) !== Number(row.generation))
        integrationFail("CPL_INTEGRATION_CONFIGURATION_CHANGED");
      const bytes = await this.options.secretBox!.open({
        envelope: integrationJson<CplIntegrationSecretEnvelope>(row.envelope),
        context: {
          purpose: "oauth_attempt",
          organizationId: a.organizationId,
          sourceId: context.connectionId,
          credentialRevision: Number(row.generation),
        },
      });
      let material: OAuthMaterial;
      try {
        material = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } finally {
        bytes.fill(0);
      }
      if (
        source.operation_token !== material.operationToken ||
        material.redirectUri !== this.options.redirectUri
      )
        integrationFail("CPL_INTEGRATION_OAUTH_REJECTED");
      await e.query(
        "UPDATE cpl_integration_oauth_attempts SET consumed_at=clock_timestamp() WHERE organization_id=$1 AND state_hash=$2",
        [a.organizationId, tokenDigest(request.state)],
      );
      return {
        generation: Number(row.generation),
        material,
        membershipVersion: a.membershipVersion,
      };
    });
    if (request.error || !request.code) integrationFail("CPL_INTEGRATION_OAUTH_REJECTED");
    const code = inboundText(request.code, 8192, true);
    const adapter = await this.humanProvider(
      tenant,
      prepared.generation,
      prepared.material.operationToken,
      prepared.membershipVersion,
    );
    let result: { account: CplGmailAccount; tokens: CplGmailTokens };
    try {
      result = await adapter.exchangeCode({
        code,
        verifier: prepared.material.verifier,
        nonce: prepared.material.nonce,
        redirectUri: prepared.material.redirectUri,
      });
    } catch {
      integrationFail("CPL_INTEGRATION_OAUTH_REJECTED");
    }
    return this.transaction(tenant, "integrations:configure", async (e, a) => {
      const source = await integrationSource(e, a.organizationId, context.connectionId, "gmail");
      if (a.membershipVersion !== prepared.membershipVersion)
        integrationFail("CPL_INTEGRATION_AUTHORIZATION_REVOKED");
      if (
        Number(source.generation) !== prepared.generation ||
        source.operation_token !== prepared.material.operationToken ||
        new Date(source.operation_expires_at as string).getTime() <= Date.now()
      )
        integrationFail("CPL_INTEGRATION_CONFIGURATION_CHANGED");
      const old = (
        await e.query<IntegrationRow>(
          "SELECT * FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2 AND purpose='gmail_tokens'",
          [a.organizationId, source.id],
        )
      ).rows[0];
      const priorAccount = source.account_id
        ? (
            await e.query<IntegrationRow>(
              "SELECT issuer,subject FROM cpl_integration_accounts WHERE organization_id=$1 AND id=$2",
              [a.organizationId, source.account_id],
            )
          ).rows[0]
        : null;
      if (
        priorAccount &&
        (priorAccount.issuer !== result.account.issuer ||
          priorAccount.subject !== result.account.subject)
      )
        integrationFail("CPL_INTEGRATION_SOURCE_CONFLICT");
      if (!result.tokens.refreshToken && old) {
        const bytes = await this.options.secretBox!.open({
          envelope: integrationJson(old.envelope),
          context: {
            purpose: "gmail_tokens",
            organizationId: a.organizationId,
            sourceId: String(source.id),
            credentialRevision: Number(old.revision),
          },
        });
        try {
          const previous = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
            account: CplGmailAccount;
            tokens: CplGmailTokens;
          };
          if (
            previous.account.issuer !== result.account.issuer ||
            previous.account.subject !== result.account.subject
          )
            integrationFail("CPL_INTEGRATION_SOURCE_CONFLICT");
          if (previous.tokens.refreshToken)
            result.tokens.refreshToken = previous.tokens.refreshToken;
        } finally {
          bytes.fill(0);
        }
      }
      const account = await e.query<IntegrationRow>(
        "INSERT INTO cpl_integration_accounts(organization_id,id,issuer,subject,email) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,issuer,subject) DO NOTHING RETURNING id",
        [
          a.organizationId,
          randomUUID(),
          result.account.issuer,
          result.account.subject,
          result.account.email,
        ],
      );
      const accountId =
        account.rows[0]?.id ??
        (
          await e.query<IntegrationRow>(
            "SELECT id FROM cpl_integration_accounts WHERE organization_id=$1 AND issuer=$2 AND subject=$3",
            [a.organizationId, result.account.issuer, result.account.subject],
          )
        ).rows[0]!.id;
      const revision = Number(old?.revision ?? 0) + 1;
      const envelope = await this.options.secretBox!.seal({
        plaintext: Buffer.from(JSON.stringify(result)),
        context: {
          purpose: "gmail_tokens",
          organizationId: a.organizationId,
          sourceId: String(source.id),
          credentialRevision: revision,
        },
        keyVersion: this.options.keyVersion!,
      });
      await e.query(
        "INSERT INTO cpl_integration_credentials(organization_id,source_id,purpose,revision,envelope,scopes) VALUES($1,$2,'gmail_tokens',$3,$4::jsonb,$5::jsonb) ON CONFLICT(organization_id,source_id,purpose) DO UPDATE SET revision=EXCLUDED.revision,envelope=EXCLUDED.envelope,scopes=EXCLUDED.scopes,updated_at=CURRENT_TIMESTAMP",
        [
          a.organizationId,
          source.id,
          revision,
          JSON.stringify(envelope),
          JSON.stringify(result.tokens.scopes),
        ],
      );
      await e.query(
        "UPDATE cpl_integration_sources SET account_id=$3,state='paused',revision=revision+1,generation=generation+1,configuration_version=configuration_version+1,configured_by_identity_id=$4,authorized_membership_version=$5,history_id=NULL,page_json=NULL,coverage='not_started',operation_token=NULL,operation_expires_at=NULL,last_issue=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
        [a.organizationId, source.id, accountId, a.identityId, a.membershipVersion],
      );
      await integrationVersion(
        e,
        a,
        String(source.id),
        Number(source.configuration_version) + 1,
        integrationJson(source.input),
      );
      const row = await integrationSource(e, a.organizationId, String(source.id));
      await integrationEvent(e, a, row, "integration.authorization.completed");
      return context;
    });
  }
  private async authorizedLabels(
    request: TenantRequest & { connectionId: string },
    captureCheckpoint = false,
  ): Promise<{
    labels: { id: string; name: string }[];
    revision: number;
    generation: number;
    historyId: string | null;
    membershipVersion: number;
  }> {
    this.requireProvider();
    const operationToken = randomUUID();
    const prepared = await this.transaction(request, "integrations:configure", async (e, a) => {
      const source = await integrationSource(e, a.organizationId, request.connectionId, "gmail");
      if (
        source.mode !== this.options.providerMode ||
        !source.account_id ||
        source.state === "disconnected"
      )
        integrationFail("CPL_INTEGRATION_RECONNECT_REQUIRED");
      if (
        source.operation_token &&
        new Date(source.operation_expires_at as string).getTime() > Date.now()
      )
        integrationFail("CPL_INTEGRATION_BUSY");
      const row = (
        await e.query<IntegrationRow>(
          "SELECT * FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2 AND purpose='gmail_tokens'",
          [a.organizationId, source.id],
        )
      ).rows[0];
      if (!row) integrationFail("CPL_INTEGRATION_RECONNECT_REQUIRED");
      const bytes = await this.options.secretBox!.open({
        envelope: integrationJson(row.envelope),
        context: {
          purpose: "gmail_tokens",
          organizationId: a.organizationId,
          sourceId: request.connectionId,
          credentialRevision: Number(row.revision),
        },
      });
      try {
        const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
          account: CplGmailAccount;
          tokens: CplGmailTokens;
        };
        await e.query(
          "UPDATE cpl_integration_sources SET operation_token=$3,operation_expires_at=clock_timestamp()+interval '25 seconds' WHERE organization_id=$1 AND id=$2",
          [a.organizationId, source.id, operationToken],
        );
        return { source, credential: row, membershipVersion: a.membershipVersion, value };
      } finally {
        bytes.fill(0);
      }
    });
    try {
      const adapter = await this.humanProvider(
        request,
        Number(prepared.source.generation),
        operationToken,
        prepared.membershipVersion,
      );
      let tokens = prepared.value.tokens;
      if (Date.parse(tokens.expiresAt) <= Date.now() + 30000) {
        if (!tokens.refreshToken) integrationFail("CPL_INTEGRATION_RECONNECT_REQUIRED");
        const refresh = await adapter.refresh({
          refreshToken: tokens.refreshToken,
          priorScopes: tokens.scopes,
        });
        tokens = {
          ...refresh,
          ...(!refresh.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        };
        await this.transaction(request, "integrations:configure", async (e, a) => {
          const current = await integrationSource(
            e,
            a.organizationId,
            request.connectionId,
            "gmail",
          );
          if (
            Number(current.generation) !== Number(prepared.source.generation) ||
            current.operation_token !== operationToken ||
            new Date(current.operation_expires_at as string).getTime() <= Date.now() ||
            a.membershipVersion !== prepared.membershipVersion
          )
            integrationFail("CPL_INTEGRATION_CONFIGURATION_CHANGED");
          const revision = Number(prepared.credential.revision) + 1;
          const envelope = await this.options.secretBox!.seal({
            plaintext: Buffer.from(JSON.stringify({ account: prepared.value.account, tokens })),
            context: {
              purpose: "gmail_tokens",
              organizationId: a.organizationId,
              sourceId: request.connectionId,
              credentialRevision: revision,
            },
            keyVersion: this.options.keyVersion!,
          });
          const update = await e.query(
            "UPDATE cpl_integration_credentials SET revision=$4,envelope=$5::jsonb,scopes=$6::jsonb,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND source_id=$2 AND purpose='gmail_tokens' AND revision=$3",
            [
              a.organizationId,
              request.connectionId,
              prepared.credential.revision,
              revision,
              JSON.stringify(envelope),
              JSON.stringify(tokens.scopes),
            ],
          );
          if (!update.rowCount) integrationFail("CPL_INTEGRATION_STALE");
        });
      }
      const labels = await adapter.listLabels({ accessToken: tokens.accessToken });
      const profile = captureCheckpoint
        ? await adapter.profile({ accessToken: tokens.accessToken })
        : null;
      if (profile && profile.email.toLowerCase() !== prepared.value.account.email.toLowerCase())
        integrationFail("CPL_INTEGRATION_SOURCE_CONFLICT");
      return {
        labels,
        revision: Number(prepared.source.revision),
        generation: Number(prepared.source.generation),
        historyId: profile?.historyId ?? null,
        membershipVersion: prepared.membershipVersion,
      };
    } finally {
      await this.database.transaction(async (e) => {
        await e.query("SELECT set_config('cpl.organization_id',$1,true)", [request.organizationId]);
        await e.query(
          "UPDATE cpl_integration_sources SET operation_token=NULL,operation_expires_at=NULL WHERE organization_id=$1 AND id=$2 AND operation_token=$3",
          [request.organizationId, request.connectionId, operationToken],
        );
      });
    }
  }
  async listConnectionLabels(request: TenantRequest & { connectionId: string }) {
    return (await this.authorizedLabels(request)).labels;
  }
  async saveConnection(
    request: TenantRequest &
      Change & { connectionId: string; input: unknown; reconcile: "from_now" | "bounded_backfill" },
  ): Promise<IntegrationConnection> {
    const input = normalizeCplGmailConfiguration(request.input);
    if (!input.selection || !input.mappingId || request.reconcile !== input.selection.start.kind)
      integrationFail("CPL_INTEGRATION_MAPPING_INVALID");
    const intent = {
      connectionId: request.connectionId,
      expectedRevision: request.expectedRevision,
      input: structuredClone(input),
      reconcile: request.reconcile,
    };
    const prior = await this.transaction(request, "integrations:configure", async (e, a) => {
      const row = await e.query<IntegrationRow>(
        "SELECT request_hash,result FROM cpl_integration_mutations WHERE organization_id=$1 AND kind='connection.save' AND idempotency_key=$2",
        [a.organizationId, request.idempotencyKey],
      );
      if (row.rows[0]) {
        if (row.rows[0].request_hash !== integrationHash(intent))
          integrationFail("CPL_IDEMPOTENCY_CONFLICT");
        return integrationJson<IntegrationConnection>(row.rows[0].result);
      }
      return null;
    });
    if (prior) return prior;
    const labels = await this.authorizedLabels(request, true);
    const label = labels.labels.find((l) => l.id === input.selection!.labelId);
    if (!label) integrationFail("CPL_INTEGRATION_SOURCE_UNAVAILABLE");
    input.selection.labelName = label.name;
    return this.transaction(request, "integrations:configure", async (e, a) =>
      integrationMutation(e, a, "connection.save", request.idempotencyKey, intent, async () => {
        const source = await integrationSource(e, a.organizationId, request.connectionId, "gmail");
        if (
          Number(source.revision) !== request.expectedRevision ||
          Number(source.generation) !== labels.generation ||
          a.membershipVersion !== labels.membershipVersion
        )
          integrationFail("CPL_INTEGRATION_STALE");
        const mapping = await integrationMapping(
          e,
          a.organizationId,
          input.mappingId!,
          input.mappingVersion!,
        );
        if (mapping.input.sourceKind !== "gmail")
          integrationFail("CPL_INTEGRATION_MAPPING_INVALID");
        await e.query(
          "UPDATE cpl_integration_sources SET revision=revision+1,generation=generation+1,configuration_version=configuration_version+1,state='active',configured_by_identity_id=$3,authorized_membership_version=$4,history_id=$5,page_json=NULL,coverage='not_started',next_eligible_at=CURRENT_TIMESTAMP,last_issue=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
          [
            a.organizationId,
            source.id,
            a.identityId,
            a.membershipVersion,
            input.selection!.start.kind === "from_now" ? labels.historyId : null,
          ],
        );
        await integrationVersion(
          e,
          a,
          String(source.id),
          Number(source.configuration_version) + 1,
          input,
        );
        const next = await integrationSource(e, a.organizationId, String(source.id));
        await cancelSourceJobs(e, next);
        await enqueueGmailSync(e, next);
        await integrationEvent(e, a, next, "integration.selection.saved");
        return this.connection(e, a.organizationId, String(source.id));
      }),
    );
  }
  async changeConnectionState(
    request: TenantRequest &
      Change & { connectionId: string; action: "pause" | "resume" | "disconnect"; reason: string },
  ): Promise<IntegrationConnection> {
    if (!["pause", "resume", "disconnect"].includes(request.action))
      integrationFail("CPL_INBOUND_INVALID_INPUT");
    const reason = inboundText(request.reason, 2000, true);
    return this.transaction(request, "integrations:operate", async (e, a) =>
      integrationMutation(
        e,
        a,
        "connection.state",
        request.idempotencyKey,
        {
          connectionId: request.connectionId,
          expectedRevision: request.expectedRevision,
          action: request.action,
          reason,
        },
        async () => {
          const s = await integrationSource(e, a.organizationId, request.connectionId, "gmail");
          if (Number(s.revision) !== request.expectedRevision)
            integrationFail("CPL_INTEGRATION_STALE");
          const input = integrationJson<GmailConfiguration>(s.input);
          if (
            request.action === "resume" &&
            (!s.account_id || !input.selection || !input.mappingId || s.state === "disconnected")
          )
            integrationFail("CPL_INTEGRATION_RECONNECT_REQUIRED");
          await e.query(
            "UPDATE cpl_integration_sources SET state=$3,revision=revision+1,generation=generation+1,operation_token=NULL,operation_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
            [
              a.organizationId,
              s.id,
              request.action === "pause"
                ? "paused"
                : request.action === "disconnect"
                  ? "disconnected"
                  : "active",
            ],
          );
          const next = await integrationSource(e, a.organizationId, String(s.id));
          await cancelSourceJobs(e, next);
          if (request.action === "disconnect") {
            await e.query(
              "DELETE FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2",
              [a.organizationId, s.id],
            );
            await e.query(
              "DELETE FROM cpl_integration_oauth_attempts WHERE organization_id=$1 AND source_id=$2",
              [a.organizationId, s.id],
            );
          }
          if (request.action === "resume") await enqueueGmailSync(e, next);
          await integrationEvent(e, a, next, `integration.${request.action}`, reason);
          return this.connection(e, a.organizationId, String(s.id));
        },
      ),
    );
  }
  async enqueueSync(
    request: TenantRequest & Change & { connectionId: string; reason: string },
  ): Promise<{ jobId: string; connection: IntegrationConnection }> {
    const reason = inboundText(request.reason, 2000, true);
    return this.transaction(request, "integrations:operate", async (e, a) =>
      integrationMutation(
        e,
        a,
        "connection.sync",
        request.idempotencyKey,
        { connectionId: request.connectionId, expectedRevision: request.expectedRevision, reason },
        async () => {
          const s = await integrationSource(e, a.organizationId, request.connectionId, "gmail");
          if (Number(s.revision) !== request.expectedRevision)
            integrationFail("CPL_INTEGRATION_STALE");
          if (s.state !== "active") integrationFail("CPL_INTEGRATION_DISABLED");
          const active = await e.query<IntegrationRow>(
            "SELECT id FROM cpl_workflow_jobs WHERE organization_id=$1 AND integration_source_id=$2 AND kind='integration.gmail.sync' AND status IN('queued','running','retrying')",
            [a.organizationId, s.id],
          );
          const jobId = active.rows[0] ? String(active.rows[0].id) : await enqueueGmailSync(e, s);
          await integrationEvent(e, a, s, "integration.sync.requested", reason);
          return { jobId, connection: await this.connection(e, a.organizationId, String(s.id)) };
        },
      ),
    );
  }
  async getConnection(request: TenantRequest & { connectionId: string }) {
    return this.transaction(request, "integrations:read", (e, a) =>
      this.connection(e, a.organizationId, request.connectionId),
    );
  }
  async createConnection(
    request: TenantRequest & { input: unknown; idempotencyKey: string },
  ): Promise<IntegrationConnection> {
    const input = normalizeCplGmailConfiguration(request.input);
    return this.transaction(request, "integrations:configure", async (e, a) =>
      integrationMutation(e, a, "connection.create", request.idempotencyKey, input, async () => {
        if (input.selection) integrationFail("CPL_INTEGRATION_MAPPING_INVALID");
        const id = randomUUID();
        if (input.mappingId)
          await integrationMapping(e, a.organizationId, input.mappingId, input.mappingVersion!);
        await e.query(
          "INSERT INTO cpl_integration_sources(organization_id,id,kind,revision,generation,configuration_version,state,mode,configured_by_identity_id,authorized_membership_version) VALUES($1,$2,'gmail',1,1,1,'authorization_required',$3,$4,$5)",
          [
            a.organizationId,
            id,
            this.options.providerMode ?? "disabled",
            a.identityId,
            a.membershipVersion,
          ],
        );
        await integrationVersion(e, a, id, 1, input);
        const s = await integrationSource(e, a.organizationId, id);
        await integrationEvent(e, a, s, "integration.created");
        return this.connection(e, a.organizationId, id);
      }),
    );
  }
  async getWorkspace(request: TenantRequest & PageInput): Promise<IntegrationWorkspace> {
    const base = await this.transaction(request, "integrations:read", async (e, a) => {
      const rows = await e.query<IntegrationRow>(
        "SELECT state,count(*) AS count FROM cpl_inbound_receipts WHERE organization_id=$1 GROUP BY state",
        [a.organizationId],
      );
      const counts = {
        queued: 0,
        processing: 0,
        needsReview: 0,
        linkedLead: 0,
        rejected: 0,
        failed: 0,
        blocked: 0,
      };
      for (const row of rows.rows) {
        const key =
          ({ needs_review: "needsReview", linked_lead: "linkedLead" } as Record<string, string>)[
            String(row.state)
          ] ?? String(row.state);
        if (key in counts) counts[key as keyof typeof counts] = Number(row.count);
      }
      const r = await e.query<IntegrationRow>(
        "SELECT DISTINCT ON(id) * FROM cpl_inbound_mapping_versions WHERE organization_id=$1 ORDER BY id,version DESC LIMIT 100",
        [a.organizationId],
      );
      return {
        permissions: {
          canViewStatus: true,
          canConfigure: cplTenantRoleAllows(a.role, "integrations:configure"),
          canAuthorize: cplTenantRoleAllows(a.role, "integrations:configure"),
          canOperate: cplTenantRoleAllows(a.role, "integrations:operate"),
          canReadSource: cplTenantRoleAllows(a.role, "sources:read"),
          canReprocess: cplTenantRoleAllows(a.role, "sources:reprocess"),
        },
        mappings: r.rows.map((row) => ({
          id: String(row.id),
          version: Number(row.version),
          input: integrationJson<MappingVersion["input"]>(row.input),
          createdAt: integrationIso(row.created_at),
          createdByIdentityId: String(row.created_by_identity_id),
        })),
        counts,
      };
    });
    const forms = await new SqlCplInboundRepository(
        this.database,
        this.tenants,
        this.options,
      ).listForms(request),
      connections = await this.listConnections(request);
    return {
      ...base,
      forms,
      connections,
      runtime: {
        providerMode: this.options.providerMode ?? "disabled",
        liveVerification: "deferred",
      },
    };
  }
  async listReceipts(
    request: TenantRequest & PageInput & { sourceId?: string },
  ): Promise<Page<SourceReceiptSummary>> {
    return this.transaction(request, "sources:read", async (e, a) => {
      const page = integrationPage(request);
      const source = request.sourceId ? inboundId(request.sourceId) : null;
      const status = request.status ?? null;
      if (
        status &&
        ![
          "queued",
          "processing",
          "needs_review",
          "linked_lead",
          "rejected",
          "failed",
          "blocked",
        ].includes(status)
      )
        integrationFail("CPL_INBOUND_INVALID_INPUT");
      const rows = await e.query<IntegrationRow>(
        `${receiptQuery} WHERE o.organization_id=$1 AND ($2::uuid IS NULL OR o.source_id=$2) AND ($3::text IS NULL OR r.state=$3) AND ($4::uuid IS NULL OR o.id>$4) ORDER BY o.id LIMIT $5`,
        [a.organizationId, source, status, page.cursor, page.limit + 1],
      );
      const count = await e.query<{ count: string }>(
        `SELECT count(*) FROM cpl_inbound_originals o JOIN cpl_inbound_receipts r ON r.organization_id=o.organization_id AND r.id=o.id WHERE o.organization_id=$1 AND ($2::uuid IS NULL OR o.source_id=$2) AND ($3::text IS NULL OR r.state=$3)`,
        [a.organizationId, source, status],
      );
      return {
        items: rows.rows.slice(0, page.limit).map(summary),
        total: Number(count.rows[0]!.count),
        limit: page.limit,
        nextCursor:
          rows.rows.length > page.limit ? page.next(String(rows.rows[page.limit - 1]!.id)) : null,
      };
    });
  }
  private async receiptDetail(
    e: SqlExecutor,
    org: string,
    id: string,
    operate: boolean,
  ): Promise<SourceReceiptDetail> {
    const r = await e.query<IntegrationRow>(
      `${receiptQuery} WHERE o.organization_id=$1 AND o.id=$2`,
      [org, inboundId(id)],
    );
    const row = r.rows[0];
    if (!row) integrationFail("CPL_INTEGRATION_NOT_FOUND");
    const normal = await e.query<IntegrationRow>(
      "SELECT * FROM cpl_inbound_normalizations WHERE organization_id=$1 AND receipt_id=$2 ORDER BY version",
      [org, id],
    );
    const attempts = await e.query<IntegrationRow>(
      "SELECT * FROM cpl_inbound_attempts WHERE organization_id=$1 AND receipt_id=$2 ORDER BY number",
      [org, id],
    );
    return {
      ...summary(row),
      original: {
        mediaType: String(row.media_type),
        bytes: (row.original_bytes as Uint8Array).byteLength,
        sha256: String(row.original_sha256),
        sourceClaims: integrationJson(row.source_claims),
        plainText:
          row.source_kind === "gmail"
            ? row.plain_text == null
              ? null
              : String(row.plain_text)
            : Buffer.from(row.original_bytes as Uint8Array).toString("utf8"),
        safeEvidenceAvailable: true,
        attachments: integrationJson(row.attachments),
      },
      normalizations: normal.rows.map((n) => ({
        version: Number(n.version),
        mappingId: String(n.mapping_id),
        mappingVersion: Number(n.mapping_version),
        fields: integrationJson(n.fields),
        issues: integrationJson(n.issues),
        createdAt: integrationIso(n.created_at),
      })),
      attempts: attempts.rows.map((n) => ({
        number: Number(n.number),
        state: String(n.state),
        startedAt: integrationIso(n.started_at),
        finishedAt: n.finished_at ? integrationIso(n.finished_at) : null,
        issue: n.issue ? integrationJson(n.issue) : null,
      })),
      permissions: {
        canReadEvidence: true,
        canRetry:
          operate &&
          !row.linked_lead_id &&
          ["blocked", "failed", "needs_review"].includes(String(row.state)),
        canReprocess: operate,
        canOpenLead: !!row.linked_lead_id,
      },
    };
  }
  async getReceipt(request: TenantRequest & { receiptId: string }) {
    return this.transaction(request, "sources:read", (e, a) =>
      this.receiptDetail(
        e,
        a.organizationId,
        request.receiptId,
        cplTenantRoleAllows(a.role, "sources:reprocess"),
      ),
    );
  }
  async getReceiptEvidence(request: TenantRequest & { receiptId: string }): Promise<{
    bytes: Uint8Array;
    sha256: string;
    byteLength: number;
    mediaType: "application/octet-stream";
    filename: string;
  }> {
    return this.transaction(request, "sources:read", async (e, a) => {
      const row = (
        await e.query<IntegrationRow>(
          "SELECT original_bytes,original_sha256 FROM cpl_inbound_originals WHERE organization_id=$1 AND id=$2",
          [a.organizationId, inboundId(request.receiptId)],
        )
      ).rows[0];
      if (!row) integrationFail("CPL_INTEGRATION_NOT_FOUND");
      const bytes = new Uint8Array(row.original_bytes as Uint8Array);
      if (integrationBytesHash(bytes) !== String(row.original_sha256))
        integrationFail("CPL_INTEGRATION_SOURCE_CONFLICT");
      return {
        bytes,
        sha256: String(row.original_sha256),
        byteLength: bytes.byteLength,
        mediaType: "application/octet-stream",
        filename: `source-${request.receiptId}.json`,
      };
    });
  }
  async retryReceipt(
    request: TenantRequest & Change & { receiptId: string; reason: string },
  ): Promise<SourceReceiptDetail> {
    const reason = inboundText(request.reason, 2000, true);
    return this.transaction(request, "sources:reprocess", async (e, a) =>
      integrationMutation(
        e,
        a,
        "receipt.retry",
        request.idempotencyKey,
        { receiptId: request.receiptId, expectedRevision: request.expectedRevision, reason },
        async () => {
          const prior = await this.receiptDetail(e, a.organizationId, request.receiptId, true);
          if (prior.revision !== request.expectedRevision) integrationFail("CPL_INTEGRATION_STALE");
          if (prior.linkedLeadId) integrationFail("CPL_INTEGRATION_REPLAY_REJECTED");
          const source = await integrationSource(e, a.organizationId, prior.sourceId);
          if (source.state !== "active") integrationFail("CPL_INTEGRATION_DISABLED");
          await enqueueInboundReceipt(e, source, prior.id);
          await e.query(
            "UPDATE cpl_inbound_receipts SET revision=revision+1,state='queued',last_issue=NULL WHERE organization_id=$1 AND id=$2",
            [a.organizationId, prior.id],
          );
          await integrationEvent(e, a, source, "inbound.receipt.retried", reason);
          return this.receiptDetail(e, a.organizationId, prior.id, true);
        },
      ),
    );
  }
  async reprocessReceipt(
    request: TenantRequest &
      Change & { receiptId: string; mappingId: string; mappingVersion: number; reason: string },
  ): Promise<SourceReceiptDetail> {
    const reason = inboundText(request.reason, 2000, true);
    return this.transaction(request, "sources:reprocess", async (e, a) =>
      integrationMutation(
        e,
        a,
        "receipt.reprocess",
        request.idempotencyKey,
        {
          receiptId: request.receiptId,
          expectedRevision: request.expectedRevision,
          mappingId: request.mappingId,
          mappingVersion: request.mappingVersion,
          reason,
        },
        async () => {
          const receipt = await this.receiptDetail(e, a.organizationId, request.receiptId, true);
          if (receipt.revision !== request.expectedRevision)
            integrationFail("CPL_INTEGRATION_STALE");
          const mapping = await integrationMapping(
            e,
            a.organizationId,
            request.mappingId,
            request.mappingVersion,
          );
          if (mapping.input.sourceKind !== (receipt.sourceKind === "gmail" ? "gmail" : "form"))
            integrationFail("CPL_INTEGRATION_MAPPING_INVALID");
          const original = (
            await e.query<IntegrationRow>(
              "SELECT * FROM cpl_inbound_originals WHERE organization_id=$1 AND id=$2",
              [a.organizationId, receipt.id],
            )
          ).rows[0]!;
          const sample =
            receipt.sourceKind === "gmail"
              ? {
                  ...integrationJson<Record<string, unknown>>(original.source_claims),
                  plainText: original.plain_text,
                }
              : JSON.parse(Buffer.from(original.original_bytes as Uint8Array).toString("utf8"))
                  .values;
          const normalized = await mapCplInboundForOrganization(
            e,
            a.organizationId,
            mapping.input,
            sample,
          );
          const version = receipt.normalizations.at(-1)?.version ?? 0;
          await e.query(
            "INSERT INTO cpl_inbound_normalizations(organization_id,receipt_id,version,mapping_id,mapping_version,fields,issues) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)",
            [
              a.organizationId,
              receipt.id,
              version + 1,
              mapping.id,
              mapping.version,
              JSON.stringify({
                ...normalized.fields,
                customValues: normalized.customValues,
                ...(normalized.dateOnlyTimeZone
                  ? { dateOnlyTimeZone: normalized.dateOnlyTimeZone }
                  : {}),
              }),
              JSON.stringify([
                {
                  code: "HUMAN_REPROCESS_PREVIEW",
                  message: "New mapping preview only. Existing human lead data was preserved.",
                  retryable: false,
                  occurredAt: new Date().toISOString(),
                  correlationId: null,
                },
              ]),
            ],
          );
          await e.query(
            "UPDATE cpl_inbound_receipts SET revision=revision+1,mapping_id=$3,mapping_version=$4,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
            [a.organizationId, receipt.id, mapping.id, mapping.version],
          );
          await integrationEvent(
            e,
            a,
            await integrationSource(e, a.organizationId, receipt.sourceId),
            "inbound.receipt.reprocessed",
            reason,
          );
          return this.receiptDetail(e, a.organizationId, receipt.id, true);
        },
      ),
    );
  }
}
async function cancelSourceJobs(e: SqlExecutor, source: IntegrationRow) {
  await e.query(
    "UPDATE cpl_workflow_jobs SET status='cancelled',last_error_code='CPL_INTEGRATION_CONFIGURATION_CHANGED',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND integration_source_id=$2 AND kind='integration.gmail.sync' AND status IN('queued','running','retrying')",
    [source.organization_id, source.id],
  );
}
async function enqueueGmailSync(e: SqlExecutor, source: IntegrationRow) {
  const id = randomUUID();
  await e.query(
    "INSERT INTO cpl_workflow_jobs(id,organization_id,kind,status,max_attempts,issued_by_identity_id,issued_membership_version,integration_source_id,integration_generation,integration_configuration_version) VALUES($1,$2,'integration.gmail.sync','queued',5,$3,$4,$5,$6,$7)",
    [
      id,
      source.organization_id,
      source.configured_by_identity_id,
      source.authorized_membership_version,
      source.id,
      source.generation,
      source.configuration_version,
    ],
  );
  return id;
}
