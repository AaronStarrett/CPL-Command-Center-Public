import { randomBytes, randomUUID } from "node:crypto";
import type {
  Change,
  FormInput,
  InquiryForm,
  Page,
  PageInput,
  PublicInquiryForm,
  PublicReceipt,
  TenantRequest,
} from "@bea/domain/cpl-integrations";
import {
  inboundCanonical,
  inboundId,
  inboundInteger,
  inboundKey,
  inboundObject,
  inboundText,
  normalizeCplInquiryForm,
  normalizeCplPublicInquiry,
} from "@bea/domain/cpl-inbound";
import type { SqlExecutor } from "./adapter.js";
import type { CplTenantAccess } from "./tenant-repository.js";
import { readCplCatalog, readCplIntakePolicy } from "./cpl-company-data.js";
import {
  CplIntegrationStore,
  integrationBytesHash,
  integrationEvent,
  integrationFail,
  integrationHash,
  integrationJson,
  integrationMapping,
  integrationMutation,
  integrationPage,
  integrationSource,
  integrationVersion,
  lockIntegration,
  mapInquiryForm,
  type IntegrationRow,
  assertCplInboundCapacity,
} from "./cpl-integration-data.js";
import type { CplIntegrationSecretEnvelope } from "./cpl-integration-ports.js";

export type CplSubmissionBoundary =
  | { source: "browser_form"; publicId: string; addressKey: string; rawBody: Uint8Array }
  | {
      source: "signed_form";
      publicId: string;
      keyId: string;
      timestamp: string;
      nonce: string;
      signature: string;
      addressKey: string;
      rawBody: Uint8Array;
    };
export class SqlCplInboundRepository extends CplIntegrationStore {
  async listForms(request: TenantRequest & PageInput): Promise<Page<InquiryForm>> {
    return this.transaction(request, "integrations:read", async (e, a) => {
      const page = integrationPage(request);
      const rows = await e.query<IntegrationRow>(
        "SELECT s.*,v.input FROM cpl_integration_sources s JOIN cpl_integration_source_versions v ON v.organization_id=s.organization_id AND v.source_id=s.id AND v.version=s.configuration_version WHERE s.organization_id=$1 AND s.kind='form' AND ($2::uuid IS NULL OR s.id>$2) ORDER BY s.id LIMIT $3",
        [a.organizationId, page.cursor, page.limit + 1],
      );
      const count = await e.query<{ count: string }>(
        "SELECT count(*) FROM cpl_integration_sources WHERE organization_id=$1 AND kind='form'",
        [a.organizationId],
      );
      return {
        items: await Promise.all(
          rows.rows.slice(0, page.limit).map((row) => mapInquiryForm(e, row)),
        ),
        total: Number(count.rows[0]!.count),
        limit: page.limit,
        nextCursor:
          rows.rows.length > page.limit ? page.next(String(rows.rows[page.limit - 1]!.id)) : null,
      };
    });
  }
  private async validateForm(e: SqlExecutor, a: CplTenantAccess, input: FormInput) {
    const mapping = await integrationMapping(
      e,
      a.organizationId,
      input.mappingId,
      input.mappingVersion,
    );
    if (mapping.input.sourceKind !== "form" || mapping.input.rules.length !== input.fields.length)
      integrationFail("CPL_INTEGRATION_MAPPING_INVALID");
    for (const field of input.fields) {
      const rule = mapping.input.rules.find(
        (r) => r.source.kind === "form_field" && r.source.key === field.key,
      );
      if (!rule || inboundCanonical(rule.target) !== inboundCanonical(field.target))
        integrationFail("CPL_INTEGRATION_MAPPING_INVALID");
    }
    const policy = await readCplIntakePolicy(e, a.organizationId);
    for (const field of input.fields) {
      if (field.target.kind === "custom") {
        const id = field.target.fieldId;
        const current = policy.input.customFields.find((f) => f.id === id && f.active);
        if (
          !current ||
          (current.type === "text" && !["text", "textarea"].includes(field.type)) ||
          (current.type !== "text" && current.type !== field.type) ||
          (current.type === "choice" && field.options.some((o) => !current.options.includes(o)))
        )
          integrationFail("CPL_INTEGRATION_MAPPING_INVALID");
      }
    }
    for (const id of input.publishedServiceIds) {
      const item = await readCplCatalog(e, a.organizationId, id);
      if (!item || item.status !== "active") integrationFail("CPL_INTEGRATION_SOURCE_UNAVAILABLE");
    }
  }
  async saveForm(
    request: TenantRequest & {
      formId?: string;
      expectedRevision: number;
      input: unknown;
      idempotencyKey: string;
    },
  ): Promise<InquiryForm> {
    const input = normalizeCplInquiryForm(request.input);
    inboundInteger(request.expectedRevision, 0, 1000000);
    return this.transaction(request, "integrations:configure", async (e, a) =>
      integrationMutation(
        e,
        a,
        "form.save",
        request.idempotencyKey,
        { formId: request.formId ?? null, expectedRevision: request.expectedRevision, input },
        async () => {
          await this.validateForm(e, a, input);
          const id = request.formId ? inboundId(request.formId) : randomUUID();
          if (request.formId) {
            const prior = await integrationSource(e, a.organizationId, id, "form");
            if (Number(prior.revision) !== request.expectedRevision)
              integrationFail("CPL_INTEGRATION_STALE");
            await e.query(
              "UPDATE cpl_integration_sources SET revision=revision+1,generation=generation+1,configuration_version=configuration_version+1,configured_by_identity_id=$3,authorized_membership_version=$4,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
              [a.organizationId, id, a.identityId, a.membershipVersion],
            );
            await integrationVersion(e, a, id, Number(prior.configuration_version) + 1, input);
          } else {
            if (request.expectedRevision !== 0) integrationFail("CPL_INTEGRATION_STALE");
            await e.query(
              "INSERT INTO cpl_integration_sources(organization_id,id,kind,revision,generation,configuration_version,state,mode,public_id,configured_by_identity_id,authorized_membership_version) VALUES($1,$2,'form',1,1,1,'paused','disabled',$3,$4,$5)",
              [
                a.organizationId,
                id,
                randomBytes(24).toString("base64url"),
                a.identityId,
                a.membershipVersion,
              ],
            );
            await integrationVersion(e, a, id, 1, input);
          }
          const row = await integrationSource(e, a.organizationId, id, "form");
          await integrationEvent(e, a, row, "inbound.form.saved");
          return mapInquiryForm(e, row);
        },
      ),
    );
  }
  async setFormEnabled(
    request: TenantRequest & Change & { formId: string; enabled: boolean; reason: string },
  ): Promise<InquiryForm> {
    if (typeof request.enabled !== "boolean") integrationFail("CPL_INBOUND_INVALID_INPUT");
    const reason = inboundText(request.reason, 2000, true);
    return this.transaction(request, "integrations:configure", async (e, a) =>
      integrationMutation(
        e,
        a,
        "form.state",
        request.idempotencyKey,
        {
          formId: inboundId(request.formId),
          expectedRevision: request.expectedRevision,
          enabled: request.enabled,
          reason,
        },
        async () => {
          const prior = await integrationSource(e, a.organizationId, request.formId, "form");
          if (Number(prior.revision) !== request.expectedRevision)
            integrationFail("CPL_INTEGRATION_STALE");
          const input = integrationJson<FormInput>(prior.input);
          if (request.enabled) await this.validateForm(e, a, input);
          await e.query(
            "UPDATE cpl_integration_sources SET state=$3,revision=revision+1,generation=generation+1,configuration_version=configuration_version+1,configured_by_identity_id=$4,authorized_membership_version=$5,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
            [
              a.organizationId,
              prior.id,
              request.enabled ? "active" : "paused",
              a.identityId,
              a.membershipVersion,
            ],
          );
          await integrationVersion(
            e,
            a,
            String(prior.id),
            Number(prior.configuration_version) + 1,
            input,
          );
          const row = await integrationSource(e, a.organizationId, String(prior.id), "form");
          await integrationEvent(
            e,
            a,
            row,
            request.enabled ? "inbound.form.enabled" : "inbound.form.disabled",
            reason,
          );
          return mapInquiryForm(e, row);
        },
      ),
    );
  }
  private async publicProjection(e: SqlExecutor, row: IntegrationRow): Promise<PublicInquiryForm> {
    const input = integrationJson<FormInput>(row.input);
    const services: PublicInquiryForm["services"] = [];
    for (const id of input.publishedServiceIds) {
      const item = await readCplCatalog(e, String(row.organization_id), id);
      if (item?.status === "active")
        services.push({ id: item.id, name: item.name, description: item.description });
    }
    return {
      publicId: String(row.public_id),
      version: Number(row.configuration_version),
      title: input.title,
      description: input.description,
      fields: input.fields.map(({ key, label, type, required, maxLength, options }) => ({
        key,
        label,
        type,
        required,
        maxLength,
        options,
      })),
      services,
      confirmationText: input.confirmationText,
    };
  }
  async readFormPreview(request: TenantRequest & { formId: string }): Promise<PublicInquiryForm> {
    return this.transaction(request, "integrations:read", async (e, a) =>
      this.publicProjection(
        e,
        await integrationSource(e, a.organizationId, request.formId, "form"),
      ),
    );
  }
  async readPublicForm(publicId: string): Promise<PublicInquiryForm> {
    const id = inboundText(publicId, 100, true);
    return this.database.transaction(async (e) => {
      const context = await this.context(e, id);
      return this.publicProjection(
        e,
        await integrationSource(e, context.organizationId, context.sourceId, "form"),
      );
    });
  }
  private async context(
    e: SqlExecutor,
    publicId: string,
  ): Promise<
    CplTenantAccess & { sourceId: string; generation: number; configurationVersion: number }
  > {
    const r = await e.query<{ value: unknown }>("SELECT cpl_inbound_public_context($1) AS value", [
      publicId,
    ]);
    if (!r.rows[0]?.value) integrationFail("CPL_INTEGRATION_NOT_FOUND");
    return integrationJson(r.rows[0].value);
  }
  async rotateSourceCredential(
    request: TenantRequest & Change & { formId: string; reason: string },
  ): Promise<{ form: InquiryForm; credential: { keyId: string; secret: string } }> {
    if (!this.options.secretBox || !this.options.keyVersion)
      integrationFail("CPL_INTEGRATION_PROVIDER_DISABLED");
    const reason = inboundText(request.reason, 2000, true);
    return this.transaction(request, "integrations:configure", async (e, a) => {
      // Store only the issuance identity; a replay never reads back a secret.
      const prior = await e.query(
        "SELECT 1 FROM cpl_integration_mutations WHERE organization_id=$1 AND kind=$2 AND idempotency_key=$3",
        [a.organizationId, "form.key", request.idempotencyKey],
      );
      if (prior.rowCount) integrationFail("CPL_INTEGRATION_REPLAY_REJECTED");
      const row = await integrationSource(e, a.organizationId, request.formId, "form");
      if (Number(row.revision) !== request.expectedRevision)
        integrationFail("CPL_INTEGRATION_STALE");
      const old = await e.query<IntegrationRow>(
        "SELECT revision,key_generation FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2 AND purpose='signed_intake_key'",
        [a.organizationId, row.id],
      );
      const revision = Number(old.rows[0]?.revision ?? 0) + 1,
        keyGeneration = Number(row.generation) + 1,
        keyId = randomBytes(16).toString("base64url"),
        bytes = randomBytes(32);
      const envelope = await this.options.secretBox!.seal({
        plaintext: bytes,
        context: {
          purpose: "signed_intake_key",
          organizationId: a.organizationId,
          sourceId: String(row.id),
          credentialRevision: revision,
        },
        keyVersion: this.options.keyVersion!,
      });
      await e.query(
        "INSERT INTO cpl_integration_credentials(organization_id,source_id,purpose,revision,envelope,key_id,key_generation) VALUES($1,$2,'signed_intake_key',$3,$4::jsonb,$5,$6) ON CONFLICT(organization_id,source_id,purpose) DO UPDATE SET revision=EXCLUDED.revision,envelope=EXCLUDED.envelope,key_id=EXCLUDED.key_id,key_generation=EXCLUDED.key_generation,updated_at=CURRENT_TIMESTAMP",
        [a.organizationId, row.id, revision, JSON.stringify(envelope), keyId, keyGeneration],
      );
      await e.query(
        "UPDATE cpl_integration_sources SET revision=revision+1,generation=generation+1 WHERE organization_id=$1 AND id=$2",
        [a.organizationId, row.id],
      );
      const next = await integrationSource(e, a.organizationId, String(row.id), "form");
      await integrationEvent(e, a, next, "inbound.credential.rotated", reason);
      await integrationMutation(
        e,
        a,
        "form.key",
        request.idempotencyKey,
        { formId: request.formId, expectedRevision: request.expectedRevision, reason },
        async () => ({ keyId }),
      );
      return {
        form: await mapInquiryForm(e, next),
        credential: { keyId, secret: bytes.toString("base64url") },
      };
    });
  }
  async revokeSourceCredential(
    request: TenantRequest & Change & { formId: string; reason: string },
  ): Promise<InquiryForm> {
    const reason = inboundText(request.reason, 2000, true);
    return this.transaction(request, "integrations:configure", async (e, a) =>
      integrationMutation(
        e,
        a,
        "form.key.revoke",
        request.idempotencyKey,
        { formId: request.formId, expectedRevision: request.expectedRevision, reason },
        async () => {
          const row = await integrationSource(e, a.organizationId, request.formId, "form");
          if (Number(row.revision) !== request.expectedRevision)
            integrationFail("CPL_INTEGRATION_STALE");
          await e.query(
            "DELETE FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2 AND purpose='signed_intake_key'",
            [a.organizationId, row.id],
          );
          await e.query(
            "UPDATE cpl_integration_sources SET revision=revision+1,generation=generation+1 WHERE organization_id=$1 AND id=$2",
            [a.organizationId, row.id],
          );
          const next = await integrationSource(e, a.organizationId, String(row.id), "form");
          await integrationEvent(e, a, next, "inbound.credential.revoked", reason);
          return mapInquiryForm(e, next);
        },
      ),
    );
  }
  async acceptSubmission(boundary: CplSubmissionBoundary): Promise<PublicReceipt> {
    // This separate transaction retains the bounded budget even when later parsing,
    // signature or source validation rejects the request. No attacker-keyed rows.
    const budget = await this.database.query<{ allowed: boolean }>(
      "SELECT cpl_inbound_admission_budget($1) AS allowed",
      [typeof boundary.publicId === "string" ? boundary.publicId.slice(0, 100) : ""],
    );
    if (budget.rows[0]?.allowed !== true) integrationFail("CPL_INTEGRATION_RATE_LIMITED");
    if (
      !(boundary.rawBody instanceof Uint8Array) ||
      boundary.rawBody.byteLength < 1 ||
      boundary.rawBody.byteLength > 65536
    )
      integrationFail("CPL_INTEGRATION_INPUT_TOO_LARGE");
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(boundary.rawBody));
    } catch {
      integrationFail("CPL_INBOUND_INVALID_INPUT");
    }
    return this.database.transaction(async (e) => {
      const a = await this.context(e, inboundText(boundary.publicId, 100, true));
      await lockIntegration(e, a.organizationId);
      const source = await integrationSource(e, a.organizationId, a.sourceId, "form");
      const form = integrationJson<FormInput>(source.input);
      const caller = inboundObject(raw, ["configurationVersion", "eventId", "values", "serviceId"]);
      const eventId = inboundKey(caller.eventId);
      const contentHash = integrationBytesHash(boundary.rawBody);
      let nonceReplay = false;
      if (boundary.source === "signed_form") {
        if (!this.options.secretBox || !this.options.signedSubmissions)
          integrationFail("CPL_INTEGRATION_SIGNATURE_REJECTED");
        const keys = await e.query<IntegrationRow>(
          "SELECT * FROM cpl_integration_credentials WHERE organization_id=$1 AND source_id=$2 AND purpose='signed_intake_key' AND key_id=$3",
          [a.organizationId, source.id, boundary.keyId],
        );
        const key = keys.rows[0];
        if (!key) integrationFail("CPL_INTEGRATION_SIGNATURE_REJECTED");
        const plaintext = await this.options.secretBox.open({
          envelope: integrationJson<CplIntegrationSecretEnvelope>(key.envelope),
          context: {
            purpose: "signed_intake_key",
            organizationId: a.organizationId,
            sourceId: a.sourceId,
            credentialRevision: Number(key.revision),
          },
        });
        try {
          await this.options.signedSubmissions.verify({
            method: "POST",
            publicId: boundary.publicId,
            keyId: boundary.keyId,
            keyGeneration: Number(key.key_generation),
            timestamp: boundary.timestamp,
            nonce: boundary.nonce,
            rawBody: boundary.rawBody,
            signature: boundary.signature,
            key: plaintext,
            now: new Date(),
          });
        } catch {
          integrationFail("CPL_INTEGRATION_SIGNATURE_REJECTED");
        } finally {
          plaintext.fill(0);
        }
        await e.query(
          "DELETE FROM cpl_inbound_nonces WHERE organization_id=$1 AND source_id=$2 AND expires_at<clock_timestamp()",
          [a.organizationId, a.sourceId],
        );
        const nonce = await e.query(
          "INSERT INTO cpl_inbound_nonces(organization_id,source_id,key_generation,nonce_hash,body_sha256,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '6 minutes') ON CONFLICT DO NOTHING",
          [
            a.organizationId,
            a.sourceId,
            key.key_generation,
            integrationHash(boundary.nonce),
            integrationBytesHash(boundary.rawBody),
          ],
        );
        if (!nonce.rowCount) {
          const old = await e.query<IntegrationRow>(
            "SELECT body_sha256 FROM cpl_inbound_nonces WHERE organization_id=$1 AND source_id=$2 AND key_generation=$3 AND nonce_hash=$4",
            [a.organizationId, a.sourceId, key.key_generation, integrationHash(boundary.nonce)],
          );
          if (old.rows[0]?.body_sha256 !== contentHash)
            integrationFail("CPL_INTEGRATION_REPLAY_REJECTED");
          nonceReplay = true;
        }
      } else if (boundary.source !== "browser_form") integrationFail("CPL_INBOUND_INVALID_INPUT");
      const existing = await e.query<IntegrationRow>(
        "SELECT o.content_sha256,r.reference FROM cpl_inbound_originals o JOIN cpl_inbound_receipts r ON r.organization_id=o.organization_id AND r.id=o.id WHERE o.organization_id=$1 AND o.source_id=$2 AND o.external_event_id=$3 AND o.account_id IS NULL",
        [a.organizationId, a.sourceId, eventId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].content_sha256 !== contentHash)
          integrationFail("CPL_INTEGRATION_SOURCE_CONFLICT");
        return {
          reference: String(existing.rows[0].reference),
          status: "accepted",
          processing: "received",
        };
      }
      if (nonceReplay) integrationFail("CPL_INTEGRATION_REPLAY_REJECTED");
      const value = normalizeCplPublicInquiry(raw, form, Number(source.configuration_version));
      if (value.serviceId) {
        const item = await readCplCatalog(e, a.organizationId, value.serviceId);
        if (!item || item.status !== "active")
          integrationFail("CPL_INTEGRATION_SOURCE_UNAVAILABLE");
      }
      await assertCplInboundCapacity(e, a.organizationId, boundary.rawBody.byteLength);
      const id = randomUUID(),
        reference = `INQ-${randomBytes(12).toString("hex").toUpperCase()}`;
      await e.query(
        "INSERT INTO cpl_inbound_originals(organization_id,id,source_id,source_kind,external_event_id,configuration_version,generation,content_sha256,original_sha256,media_type,original_bytes,source_claims,mapping_id,mapping_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'application/json',$10,$11::jsonb,$12,$13)",
        [
          a.organizationId,
          id,
          a.sourceId,
          boundary.source === "signed_form" ? "signed_form" : "public_form",
          value.eventId,
          source.configuration_version,
          source.generation,
          contentHash,
          integrationBytesHash(boundary.rawBody),
          Buffer.from(boundary.rawBody),
          JSON.stringify({ publicId: boundary.publicId }),
          form.mappingId,
          form.mappingVersion,
        ],
      );
      await e.query(
        "INSERT INTO cpl_inbound_receipts(organization_id,id,reference,state,mapping_id,mapping_version) VALUES($1,$2,$3,'queued',$4,$5)",
        [a.organizationId, id, reference, form.mappingId, form.mappingVersion],
      );
      await enqueueInboundReceipt(e, source, id);
      return { reference, status: "accepted", processing: "queued" };
    });
  }
}
export async function enqueueInboundReceipt(
  e: SqlExecutor,
  source: IntegrationRow,
  receiptId: string,
) {
  const id = randomUUID();
  await e.query(
    "INSERT INTO cpl_workflow_jobs(id,organization_id,kind,status,max_attempts,issued_by_identity_id,issued_membership_version,integration_source_id,integration_generation,integration_configuration_version,inbound_receipt_id) VALUES($1,$2,'inbound.receipt.process','queued',5,$3,$4,$5,$6,$7,$8)",
    [
      id,
      source.organization_id,
      source.configured_by_identity_id,
      source.authorized_membership_version,
      source.id,
      source.generation,
      source.configuration_version,
      receiptId,
    ],
  );
  return id;
}
