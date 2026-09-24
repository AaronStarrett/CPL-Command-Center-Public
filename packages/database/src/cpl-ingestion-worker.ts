import { CPL_INTEGRATION_ERROR_CODES } from "@bea/domain/cpl-integrations";
import type { DatabaseAdapter } from "./adapter.js";
import { SqlCplTenantRepository } from "./tenant-repository.js";
import { SqlCplIntakeRepository } from "./cpl-intake-repository.js";
import {
  integrationFail,
  integrationHash,
  integrationIso,
  integrationJson,
  integrationMapping,
  mapCplInboundForOrganization,
  type IntegrationRow,
} from "./cpl-integration-data.js";
import type { CplIntegrationRepositoryOptions } from "./cpl-integration-ports.js";

import { withCplIngestionAuthority } from "./cpl-ingestion-authority.js";
/** A freshly fenced exhausted job may only record failure metadata. It cannot
 * fetch provider data, normalize evidence, or use obsolete human authority. */
export async function failExhaustedCplIngestionJob(
  database: DatabaseAdapter,
  job: IntegrationRow,
  leaseToken: string,
): Promise<void> {
  await database.transaction(async (e) => {
    await e.query(
      "SELECT set_config('cpl.organization_id',$1,true),pg_advisory_xact_lock(hashtextextended($1,38))",
      [job.organization_id],
    );
    const fence = await e.query(
      "SELECT id FROM cpl_workflow_jobs WHERE organization_id=$1 AND id=$2 AND status='running' AND lease_token=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE",
      [job.organization_id, job.id, leaseToken],
    );
    if (fence.rowCount !== 1) integrationFail("CPL_INTEGRATION_LEASE_LOST");
    const issue = JSON.stringify({
      code: "CPL_INTEGRATION_PROCESSING_FAILED",
      message: "The bounded processing attempt budget was exhausted. Review and explicitly retry.",
      retryable: true,
      occurredAt: new Date().toISOString(),
      correlationId: null,
    });
    if (job.kind === "inbound.receipt.process") {
      await e.query(
        "UPDATE cpl_inbound_receipts SET revision=revision+1,state='failed',last_issue=$3::jsonb,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 AND linked_lead_id IS NULL",
        [job.organization_id, job.inbound_receipt_id, issue],
      );
      await e.query(
        "INSERT INTO cpl_inbound_attempts(organization_id,receipt_id,number,job_id,state,issue,finished_at) SELECT $1,$2,COALESCE(max(number),0)+1,$3,'failed',$4::jsonb,CURRENT_TIMESTAMP FROM cpl_inbound_attempts WHERE organization_id=$1 AND receipt_id=$2",
        [job.organization_id, job.inbound_receipt_id, job.id, issue],
      );
    } else {
      await e.query(
        "UPDATE cpl_integration_sources SET state='failed',last_issue=$5::jsonb,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 AND generation=$3 AND configuration_version=$4 AND state='active'",
        [
          job.organization_id,
          job.integration_source_id,
          job.integration_generation,
          job.integration_configuration_version,
          issue,
        ],
      );
    }
    const done = await e.query(
      "UPDATE cpl_workflow_jobs SET status='failed',last_error_code='CPL_JOB_RETRY_EXHAUSTED',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 AND status='running' AND lease_token=$3 AND lease_expires_at>clock_timestamp()",
      [job.organization_id, job.id, leaseToken],
    );
    if (done.rowCount !== 1) integrationFail("CPL_INTEGRATION_LEASE_LOST");
  });
}
export async function processCplIngestionJob(
  database: DatabaseAdapter,
  job: IntegrationRow,
  leaseToken: string,
  _options: CplIntegrationRepositoryOptions = {},
): Promise<"completed" | "retrying" | "failed" | "skipped"> {
  if (job.kind === "integration.gmail.sync") {
    const { processCplGmailSync } = await import("./cpl-gmail-sync.js");
    return processCplGmailSync(database, job, leaseToken, _options);
  }
  try {
    if (job.kind !== "inbound.receipt.process")
      integrationFail("CPL_INTEGRATION_PROVIDER_DISABLED");
    await withCplIngestionAuthority(database, job, leaseToken, async (e, a) => {
      const rows = await e.query<IntegrationRow>(
        "SELECT o.*,r.state,r.linked_lead_id,r.mapping_id AS processing_mapping_id,r.mapping_version AS processing_mapping_version FROM cpl_inbound_originals o JOIN cpl_inbound_receipts r ON r.organization_id=o.organization_id AND r.id=o.id JOIN cpl_workflow_jobs j ON j.organization_id=o.organization_id AND j.inbound_receipt_id=o.id WHERE o.organization_id=$1 AND j.id=$2 FOR UPDATE OF r",
        [a.organizationId, job.id],
      );
      const receipt = rows.rows[0];
      if (!receipt) integrationFail("CPL_INTEGRATION_NOT_FOUND");
      if (receipt.source_id !== job.integration_source_id)
        integrationFail("CPL_INTEGRATION_CONFIGURATION_CHANGED");
      if (receipt.linked_lead_id) return;
      const version = await e.query<{ version: number }>(
        "SELECT COALESCE(max(version),0)+1 AS version FROM cpl_inbound_normalizations WHERE organization_id=$1 AND receipt_id=$2",
        [a.organizationId, receipt.id],
      );
      const mapping = await integrationMapping(
        e,
        a.organizationId,
        String(receipt.processing_mapping_id),
        Number(receipt.processing_mapping_version),
      );
      let sample: Record<string, unknown>,
        serviceId: string | null = null;
      if (receipt.source_kind === "gmail") {
        sample = integrationJson(receipt.source_claims);
        sample.plainText = receipt.plain_text;
      } else {
        const raw = JSON.parse(Buffer.from(receipt.original_bytes as Uint8Array).toString("utf8"));
        sample = raw.values;
        serviceId = raw.serviceId ?? null;
      }
      const normalized = await mapCplInboundForOrganization(
        e,
        a.organizationId,
        mapping.input,
        sample,
      );
      const issues = integrationJson<string[]>(receipt.parse_issues).map((code) => ({
        code,
        message: "Source content needs human review.",
        retryable: false,
        occurredAt: integrationIso(receipt.received_at),
        correlationId: null,
      }));
      await e.query(
        "INSERT INTO cpl_inbound_normalizations(organization_id,receipt_id,version,mapping_id,mapping_version,fields,issues) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)",
        [
          a.organizationId,
          receipt.id,
          version.rows[0]!.version,
          mapping.id,
          mapping.version,
          JSON.stringify({
            ...normalized.fields,
            customValues: normalized.customValues,
            ...(normalized.dateOnlyTimeZone
              ? { dateOnlyTimeZone: normalized.dateOnlyTimeZone }
              : {}),
          }),
          JSON.stringify(issues),
        ],
      );
      let leadId = receipt.linked_lead_id,
        leadVersion: number | null = null;
      if (!leadId) {
        const fields = Object.fromEntries(
          Object.entries(normalized.fields).filter(([, v]) => v !== null),
        );
        const intake = new SqlCplIntakeRepository(new SqlCplTenantRepository(database));
        const lead = await intake.createLeadInTransaction(e, a, {
          ...fields,
          title:
            typeof fields.title === "string" && fields.title
              ? fields.title
              : receipt.source_kind === "gmail"
                ? "New email inquiry"
                : "New form inquiry",
          sourceType: receipt.source_kind === "gmail" ? "email" : "website_form",
          status: "new",
          receivedAt: integrationIso(receipt.received_at),
          nextAction: "Review original source and confirm intake information",
          sourceReference: `inbound:${receipt.id}:${receipt.content_sha256}`,
          evidenceNote:
            "Captured from an inbound source. Sender and submitted contact values are unverified claims requiring human review.",
          catalogItemId: serviceId,
          customValues: normalized.customValues,
          idempotencyKey: `inbound-${receipt.id}`,
        });
        leadId = lead.id;
        leadVersion = lead.version;
      }
      await e.query(
        "UPDATE cpl_inbound_receipts SET revision=revision+1,state='linked_lead',processing_attempts=processing_attempts+1,linked_lead_id=$3,linked_lead_version=COALESCE($4,linked_lead_version),last_issue=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
        [a.organizationId, receipt.id, leadId, leadVersion],
      );
      await e.query(
        "INSERT INTO cpl_inbound_attempts(organization_id,receipt_id,number,job_id,state,finished_at) SELECT $1,$2,COALESCE(max(number),0)+1,$3,'completed',CURRENT_TIMESTAMP FROM cpl_inbound_attempts WHERE organization_id=$1 AND receipt_id=$2",
        [a.organizationId, receipt.id, job.id],
      );
    });
    // Action and receipt commit independently of acknowledgement. Retrying the
    // same durable receipt cannot create another lead or overwrite human edits.
    const done = await database.query(
      "UPDATE cpl_workflow_jobs SET status='completed',result_sha256=$3,last_error_code=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_expires_at>clock_timestamp()",
      [job.id, leaseToken, integrationHash({ receiptId: job.inbound_receipt_id })],
    );
    if (done.rowCount !== 1) integrationFail("CPL_INTEGRATION_LEASE_LOST");
    return "completed";
  } catch (error) {
    const candidate =
      error && typeof error === "object" ? ("message" in error ? String(error.message) : "") : "";
    const code =
      error instanceof Error && error.name === "CplIntakeError"
        ? "CPL_INTEGRATION_MAPPING_INVALID"
        : (CPL_INTEGRATION_ERROR_CODES as readonly string[]).includes(candidate)
          ? candidate
          : "CPL_INTEGRATION_PROCESSING_FAILED";
    if (code === "CPL_INTEGRATION_LEASE_LOST") throw error;
    const needsReview = [
      "CPL_INTEGRATION_MAPPING_INVALID",
      "CPL_MAPPING_VALUE_INVALID",
      "CPL_INBOUND_INVALID_INPUT",
    ].includes(code);
    const terminal =
      needsReview ||
      [
        "CPL_INTEGRATION_CONFIGURATION_CHANGED",
        "CPL_INTEGRATION_AUTHORIZATION_REVOKED",
        "CPL_INTEGRATION_NOT_FOUND",
        "CPL_INTEGRATION_PROVIDER_DISABLED",
      ].includes(code) ||
      Number(job.attempts) >= Number(job.max_attempts);
    await database.transaction(async (e) => {
      await e.query("SELECT set_config('cpl.organization_id',$1,true)", [job.organization_id]);
      const changed = await e.query(
        "UPDATE cpl_workflow_jobs SET status=$3,last_error_code=$4,available_at=CURRENT_TIMESTAMP+INTERVAL '1 minute',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND status='running' AND lease_token=$2 AND organization_id=$5 AND lease_expires_at>clock_timestamp()",
        [job.id, leaseToken, terminal ? "skipped" : "retrying", code, job.organization_id],
      );
      if (!changed.rowCount) integrationFail("CPL_INTEGRATION_LEASE_LOST");
      if (job.inbound_receipt_id)
        await e.query(
          "UPDATE cpl_inbound_receipts SET revision=revision+1,state=$3,processing_attempts=processing_attempts+1,last_issue=$4::jsonb,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2 AND linked_lead_id IS NULL",
          [
            job.organization_id,
            job.inbound_receipt_id,
            needsReview ? "needs_review" : terminal ? "blocked" : "failed",
            JSON.stringify({
              code,
              message: "Source processing requires authorized review.",
              retryable: !terminal || needsReview,
              occurredAt: new Date().toISOString(),
              correlationId: null,
            }),
          ],
        );
      if (job.inbound_receipt_id)
        await e.query(
          "INSERT INTO cpl_inbound_attempts(organization_id,receipt_id,number,job_id,state,issue,finished_at) SELECT $1,$2,COALESCE(max(number),0)+1,$3,$4,$5::jsonb,CURRENT_TIMESTAMP FROM cpl_inbound_attempts WHERE organization_id=$1 AND receipt_id=$2",
          [
            job.organization_id,
            job.inbound_receipt_id,
            job.id,
            needsReview ? "needs_review" : terminal ? "blocked" : "failed",
            JSON.stringify({
              code,
              message: "Source processing requires authorized review.",
              retryable: !terminal || needsReview,
              occurredAt: new Date().toISOString(),
              correlationId: null,
            }),
          ],
        );
    });
    return terminal ? "skipped" : "retrying";
  }
}
