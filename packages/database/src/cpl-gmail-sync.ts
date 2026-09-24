import { randomUUID } from "node:crypto";
import type { GmailConfiguration, SafeIssue } from "@bea/domain/cpl-integrations";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import {
  assertCplInboundCapacity,
  integrationBytesHash,
  integrationFail,
  integrationHash,
  integrationJson,
  integrationSource,
  type IntegrationRow,
} from "./cpl-integration-data.js";
import { withCplIngestionAuthority } from "./cpl-ingestion-authority.js";
import { enqueueInboundReceipt } from "./cpl-inbound-repository.js";
import type {
  CplGmailAccount,
  CplGmailMessage,
  CplGmailTokens,
  CplIntegrationRepositoryOptions,
  CplIntegrationSecretEnvelope,
} from "./cpl-integration-ports.js";

type Outcome = "completed" | "retrying" | "failed" | "skipped";
type PendingMessage = { id: string; removed: boolean };
/** The pending page and its remaining IDs are durable before any full-message fetch.
 * A history checkpoint advances only after every ID in every page is accounted for. */
type Cursor = {
  version: 1;
  mode: "backfill" | "history";
  baseHistoryId: string;
  checkpoint: string;
  nextPageToken: string | null;
  loaded: boolean;
  pending: PendingMessage[];
  remaining: number | null;
  after: string | null;
  warnings: string[];
};
type Credential = {
  revision: number;
  account: CplGmailAccount;
  tokens: CplGmailTokens;
};
const warnings = new Set([
  "CPL_GMAIL_MESSAGE_UNAVAILABLE",
  "CPL_GMAIL_MESSAGE_REMOVED",
  "CPL_GMAIL_MESSAGE_OUTSIDE_SELECTION",
  "CPL_GMAIL_BACKFILL_LIMIT",
  "CPL_GMAIL_PRIOR_COVERAGE_INCOMPLETE",
]);
const revoked = new Set([
  "CPL_INTEGRATION_AUTHORIZATION_REVOKED",
  "CPL_INTEGRATION_CONFIGURATION_CHANGED",
  "CPL_INTEGRATION_NOT_FOUND",
  "CPL_INTEGRATION_PROVIDER_DISABLED",
]);
function safeCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const e = error as { code?: unknown; message?: unknown };
  // PostgreSQL raises the fixed authority codes as messages (SQLSTATE P0001).
  if (
    typeof e.message === "string" &&
    (revoked.has(e.message) || e.message === "CPL_INTEGRATION_LEASE_LOST")
  )
    return e.message;
  return typeof e.code === "string" ? e.code : typeof e.message === "string" ? e.message : "";
}
function issue(code: string, retryable: boolean): SafeIssue {
  return {
    code,
    message: "Gmail source synchronization needs review.",
    retryable,
    occurredAt: new Date().toISOString(),
    correlationId: null,
  };
}
function parseCursor(value: unknown): Cursor | null {
  if (value == null) return null;
  const c = integrationJson<Cursor>(value);
  if (
    c.version !== 1 ||
    !["backfill", "history"].includes(c.mode) ||
    !/^\d{1,40}$/u.test(c.baseHistoryId) ||
    !/^\d{1,40}$/u.test(c.checkpoint) ||
    typeof c.loaded !== "boolean" ||
    !Array.isArray(c.pending) ||
    c.pending.length > 2000 ||
    c.pending.some(
      (m) => !m || !/^[A-Za-z0-9_-]{1,256}$/u.test(m.id) || typeof m.removed !== "boolean",
    ) ||
    (c.nextPageToken !== null &&
      (typeof c.nextPageToken !== "string" || c.nextPageToken.length > 4096)) ||
    (c.remaining !== null &&
      (!Number.isSafeInteger(c.remaining) || c.remaining < 0 || c.remaining > 500)) ||
    (c.mode === "backfill" &&
      (c.remaining === null || !c.after || !Number.isFinite(Date.parse(c.after)))) ||
    !Array.isArray(c.warnings) ||
    c.warnings.some((w) => !warnings.has(w))
  )
    integrationFail("CPL_INTEGRATION_PROCESSING_FAILED");
  return c;
}
function addWarning(cursor: Cursor, code: string) {
  if (!cursor.warnings.includes(code)) cursor.warnings.push(code);
}
function messageTime(value: string): number {
  const milliseconds = Number(value);
  if (
    !/^\d{1,16}$/u.test(value) ||
    !Number.isSafeInteger(milliseconds) ||
    !Number.isFinite(new Date(milliseconds).getTime())
  )
    integrationFail("CPL_INTEGRATION_PROCESSING_FAILED");
  return milliseconds;
}
function tokensFrom(value: unknown): { account: CplGmailAccount; tokens: CplGmailTokens } {
  const o = value as { account?: CplGmailAccount; tokens?: CplGmailTokens } | null;
  if (
    !o?.account ||
    o.account.issuer !== "https://accounts.google.com" ||
    typeof o.account.subject !== "string" ||
    !o.account.subject ||
    !o.tokens ||
    typeof o.tokens.accessToken !== "string" ||
    !o.tokens.accessToken ||
    !Number.isFinite(Date.parse(o.tokens.expiresAt)) ||
    !Array.isArray(o.tokens.scopes) ||
    o.tokens.scopes.some((s) => typeof s !== "string") ||
    (o.tokens.refreshToken !== undefined &&
      (typeof o.tokens.refreshToken !== "string" || !o.tokens.refreshToken))
  )
    integrationFail("CPL_INTEGRATION_RECONNECT_REQUIRED");
  return { account: o.account, tokens: o.tokens };
}
async function finishJob(
  e: SqlExecutor,
  job: IntegrationRow,
  lease: string,
  status: Outcome,
  code: string | null,
  delaySeconds = 0,
) {
  const changed = await e.query(
    `UPDATE cpl_workflow_jobs SET status=$4,last_error_code=$5,
       result_sha256=CASE WHEN $4='completed' THEN $6 ELSE result_sha256 END,
       available_at=clock_timestamp()+($7::integer * INTERVAL '1 second'),
       lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
     WHERE organization_id=$1 AND id=$2 AND status='running' AND lease_token=$3
       AND lease_expires_at>clock_timestamp()`,
    [
      job.organization_id,
      job.id,
      lease,
      status,
      code,
      integrationHash({ sourceId: job.integration_source_id, jobId: job.id }),
      delaySeconds,
    ],
  );
  if (changed.rowCount !== 1) integrationFail("CPL_INTEGRATION_LEASE_LOST");
}

/** One short worker turn. It never holds a transaction while making provider HTTP
 * calls. The authority helper locks the current issuer, entitlement, source and
 * job lease for every read/write and every adapter network boundary. */
export async function processCplGmailSync(
  database: DatabaseAdapter,
  job: IntegrationRow,
  leaseToken: string,
  options: CplIntegrationRepositoryOptions,
): Promise<Outcome> {
  const started = Date.now();
  const signal = AbortSignal.timeout(24_000);
  let ownsOperation = false;
  const checkOperation = async (e: SqlExecutor) => {
    const current = await e.query(
      "SELECT id FROM cpl_integration_sources WHERE organization_id=$1 AND id=$2 AND operation_token=$3 AND operation_expires_at>clock_timestamp()",
      [job.organization_id, job.integration_source_id, leaseToken],
    );
    if (!current.rowCount) integrationFail("CPL_INTEGRATION_BUSY");
  };
  const guarded = <T>(
    run: Parameters<typeof withCplIngestionAuthority<T>>[3],
    finalize?: Parameters<typeof withCplIngestionAuthority<T>>[4],
  ) =>
    withCplIngestionAuthority(
      database,
      job,
      leaseToken,
      async (e, a) => {
        if (ownsOperation) await checkOperation(e);
        const result = await run(e, a);
        if (ownsOperation) await checkOperation(e);
        return result;
      },
      finalize,
    );
  let source: IntegrationRow;
  try {
    if (
      !options.createGmailAdapter ||
      !options.secretBox ||
      !options.keyVersion ||
      !options.providerMode ||
      options.providerMode === "disabled"
    )
      integrationFail("CPL_INTEGRATION_PROVIDER_DISABLED");
    source = await guarded(async (e) => {
      const row = await integrationSource(
        e,
        String(job.organization_id),
        String(job.integration_source_id),
        "gmail",
      );
      if (row.mode !== options.providerMode || !row.account_id)
        integrationFail("CPL_INTEGRATION_PROVIDER_DISABLED");
      const acquired = await e.query(
        `UPDATE cpl_integration_sources SET operation_token=$3,operation_expires_at=clock_timestamp()+INTERVAL '25 seconds'
        WHERE organization_id=$1 AND id=$2 AND (operation_token IS NULL OR operation_expires_at<=clock_timestamp() OR operation_token=$3)`,
        [row.organization_id, row.id, leaseToken],
      );
      if (acquired.rowCount !== 1) integrationFail("CPL_INTEGRATION_BUSY");
      await e.query(
        "UPDATE cpl_integration_sources SET last_attempt_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [row.organization_id, row.id],
      );
      return row;
    });
    ownsOperation = true;
    const configuration = integrationJson<GmailConfiguration>(source.input);
    if (!configuration.selection || !configuration.mappingId || !configuration.mappingVersion)
      integrationFail("CPL_INTEGRATION_MAPPING_INVALID");
    const selection = configuration.selection;
    const assertCurrent = async () => {
      signal.throwIfAborted();
      await guarded(async () => undefined);
      signal.throwIfAborted();
    };
    const adapter = await options.createGmailAdapter({
      organizationId: String(source.organization_id),
      connectionId: String(source.id),
      assertCurrent,
      signal,
    });
    const loadCredential = async (): Promise<Credential> => {
      const row = await guarded(async (e) => {
        const r = await e.query<IntegrationRow>(
          `SELECT c.*,a.issuer,a.subject FROM cpl_integration_credentials c
           JOIN cpl_integration_sources s ON s.organization_id=c.organization_id AND s.id=c.source_id
           JOIN cpl_integration_accounts a ON a.organization_id=s.organization_id AND a.id=s.account_id
           WHERE c.organization_id=$1 AND c.source_id=$2 AND c.purpose='gmail_tokens'`,
          [source.organization_id, source.id],
        );
        if (!r.rows[0]) integrationFail("CPL_INTEGRATION_RECONNECT_REQUIRED");
        return r.rows[0];
      });
      const bytes = await options.secretBox!.open({
        envelope: integrationJson<CplIntegrationSecretEnvelope>(row.envelope),
        context: {
          purpose: "gmail_tokens",
          organizationId: String(source.organization_id),
          sourceId: String(source.id),
          credentialRevision: Number(row.revision),
        },
      });
      let content: ReturnType<typeof tokensFrom>;
      try {
        content = tokensFrom(JSON.parse(new TextDecoder().decode(bytes)));
      } finally {
        bytes.fill(0);
      }
      if (content.account.issuer !== row.issuer || content.account.subject !== row.subject)
        integrationFail("CPL_INTEGRATION_RECONNECT_REQUIRED");
      await assertCurrent();
      return { ...content, revision: Number(row.revision) };
    };
    let credential = await loadCredential();
    if (Date.parse(credential.tokens.expiresAt) <= Date.now() + 60_000) {
      if (!credential.tokens.refreshToken) integrationFail("CPL_INTEGRATION_RECONNECT_REQUIRED");
      const refreshed = await adapter.refresh({
        refreshToken: credential.tokens.refreshToken,
        priorScopes: credential.tokens.scopes,
      });
      const tokens = {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? credential.tokens.refreshToken,
      };
      const plaintext = new TextEncoder().encode(
        JSON.stringify({ account: credential.account, tokens }),
      );
      let envelope: CplIntegrationSecretEnvelope;
      try {
        envelope = await options.secretBox.seal({
          plaintext,
          keyVersion: options.keyVersion,
          context: {
            purpose: "gmail_tokens",
            organizationId: String(source.organization_id),
            sourceId: String(source.id),
            credentialRevision: credential.revision + 1,
          },
        });
      } finally {
        plaintext.fill(0);
      }
      const updated = await guarded(async (e) => {
        const r = await e.query(
          `UPDATE cpl_integration_credentials c SET revision=revision+1,envelope=$4::jsonb,scopes=$5::jsonb,updated_at=clock_timestamp()
           WHERE organization_id=$1 AND source_id=$2 AND purpose='gmail_tokens' AND revision=$3
             AND EXISTS(SELECT 1 FROM cpl_integration_sources s WHERE s.organization_id=c.organization_id AND s.id=c.source_id AND s.account_id=$6)`,
          [
            source.organization_id,
            source.id,
            credential.revision,
            JSON.stringify(envelope),
            JSON.stringify(tokens.scopes),
            source.account_id,
          ],
        );
        return r.rowCount === 1;
      });
      credential = updated
        ? { ...credential, revision: credential.revision + 1, tokens }
        : await loadCredential();
      if (Date.parse(credential.tokens.expiresAt) <= Date.now() + 1000)
        integrationFail("CPL_INTEGRATION_PROCESSING_FAILED");
    }
    const accessToken = credential.tokens.accessToken;
    let cursor = parseCursor(source.page_json);
    const persist = async (e: SqlExecutor, current: Cursor) => {
      await e.query(
        "UPDATE cpl_integration_sources SET page_json=$3::jsonb,coverage=$4,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [
          source.organization_id,
          source.id,
          JSON.stringify(current),
          current.mode === "backfill" ? "backfill_in_progress" : "incomplete",
        ],
      );
    };
    if (!cursor) {
      let base = source.history_id ? String(source.history_id) : null;
      if (!base) {
        const profile = await adapter.profile({ accessToken });
        if (profile.email.toLowerCase() !== credential.account.email.toLowerCase())
          integrationFail("CPL_INTEGRATION_RECONNECT_REQUIRED");
        base = profile.historyId;
      }
      const backfill = !source.history_id && selection.start.kind === "bounded_backfill";
      cursor = {
        version: 1,
        mode: backfill ? "backfill" : "history",
        baseHistoryId: base,
        checkpoint: base,
        nextPageToken: null,
        loaded: !source.history_id && !backfill,
        pending: [],
        remaining:
          backfill && selection.start.kind === "bounded_backfill"
            ? selection.start.maxMessages
            : null,
        after:
          backfill && selection.start.kind === "bounded_backfill" ? selection.start.after : null,
        warnings: source.coverage === "incomplete" ? ["CPL_GMAIL_PRIOR_COVERAGE_INCOMPLETE"] : [],
      };
      await guarded((e) => persist(e, cursor!));
    }
    let handled = 0;
    while (handled < 4 && Date.now() - started < 18_000) {
      if (!cursor.pending.length) {
        if (cursor.loaded && !cursor.nextPageToken) break;
        if (cursor.mode === "backfill" && cursor.remaining === 0) {
          addWarning(cursor, "CPL_GMAIL_BACKFILL_LIMIT");
          cursor.nextPageToken = null;
          cursor.loaded = true;
          await guarded((e) => persist(e, cursor!));
          break;
        }
        if (cursor.mode === "backfill") {
          const limit = Math.min(10, cursor.remaining!);
          const page = await adapter.listMessages({
            accessToken,
            labelId: selection.labelId,
            after: cursor.after!,
            ...(cursor.nextPageToken ? { pageToken: cursor.nextPageToken } : {}),
            limit,
          });
          if (page.messageIds.length > limit) integrationFail("CPL_INTEGRATION_PROCESSING_FAILED");
          cursor.pending = [...new Set(page.messageIds)].map((id) => ({ id, removed: false }));
          cursor.nextPageToken = page.nextPageToken;
        } else {
          const page = await adapter.listHistory({
            accessToken,
            labelId: selection.labelId,
            startHistoryId: cursor.baseHistoryId,
            ...(cursor.nextPageToken ? { pageToken: cursor.nextPageToken } : {}),
            limit: 10,
          });
          // Full-message label membership is rechecked; deletion/removal events never
          // delete immutable captured originals or silently create a replacement lead.
          const byId = new Map<string, PendingMessage>();
          for (const change of page.changes)
            byId.set(change.messageId, {
              id: change.messageId,
              removed: change.kind === "message_deleted" || change.kind === "label_removed",
            });
          cursor.pending = [...byId.values()];
          cursor.nextPageToken = page.nextPageToken;
          if (page.historyId) cursor.checkpoint = page.historyId;
        }
        cursor.loaded = true;
        await guarded((e) => persist(e, cursor!));
        if (!cursor.pending.length) {
          // Empty pages still yield after one page, avoiding unbounded provider loops.
          break;
        }
      }
      const pending = cursor.pending[0]!;
      let message: CplGmailMessage | null = null;
      if (pending.removed) addWarning(cursor, "CPL_GMAIL_MESSAGE_REMOVED");
      else {
        try {
          message = await adapter.getMessage({ accessToken, messageId: pending.id });
        } catch (error) {
          if (safeCode(error) !== "MESSAGE_UNAVAILABLE") throw error;
          addWarning(cursor, "CPL_GMAIL_MESSAGE_UNAVAILABLE");
        }
        if (
          message &&
          (!message.labelIds.includes(selection.labelId) ||
            (cursor.mode === "backfill" &&
              messageTime(message.internalDate) < Date.parse(cursor.after!)))
        ) {
          message = null;
          addWarning(cursor, "CPL_GMAIL_MESSAGE_OUTSIDE_SELECTION");
        }
      }
      const captured = message;
      const next: Cursor = {
        ...cursor,
        pending: cursor.pending.slice(1),
        remaining: cursor.remaining === null ? null : Math.max(0, cursor.remaining - 1),
      };
      await guarded(async (e) => {
        if (captured) {
          const prior = await e.query<IntegrationRow>(
            "SELECT id,content_sha256 FROM cpl_inbound_originals WHERE organization_id=$1 AND account_id=$2 AND external_event_id=$3",
            [source.organization_id, source.account_id, captured.id],
          );
          if (prior.rows[0]) {
            if (prior.rows[0].content_sha256 !== captured.contentSha256)
              integrationFail("CPL_INTEGRATION_SOURCE_CONFLICT");
          } else {
            await assertCplInboundCapacity(
              e,
              String(source.organization_id),
              captured.original.byteLength,
            );
            const id = randomUUID();
            await e.query(
              `INSERT INTO cpl_inbound_originals(organization_id,id,source_id,source_kind,account_id,external_event_id,
                configuration_version,generation,content_sha256,original_sha256,media_type,original_bytes,
                source_claims,plain_text,attachments,parse_issues,mapping_id,mapping_version,provider_at)
               VALUES($1,$2,$3,'gmail',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15::jsonb,$16,$17,$18)`,
              [
                source.organization_id,
                id,
                source.id,
                source.account_id,
                captured.id,
                source.configuration_version,
                source.generation,
                captured.contentSha256,
                integrationBytesHash(captured.original),
                captured.originalMediaType,
                Buffer.from(captured.original),
                JSON.stringify({
                  subject: captured.subject,
                  senderNameClaim: captured.senderNameClaim,
                  senderEmailClaim: captured.senderEmailClaim,
                  threadId: captured.threadId,
                }),
                captured.plainText,
                JSON.stringify(captured.attachments),
                JSON.stringify(captured.parseIssues ?? []),
                configuration.mappingId,
                configuration.mappingVersion,
                new Date(messageTime(captured.internalDate)).toISOString(),
              ],
            );
            await e.query(
              "INSERT INTO cpl_inbound_receipts(organization_id,id,reference,state,mapping_id,mapping_version) VALUES($1,$2,$3,'queued',$4,$5)",
              [
                source.organization_id,
                id,
                `IN-${id.replaceAll("-", "").slice(0, 16).toUpperCase()}`,
                configuration.mappingId,
                configuration.mappingVersion,
              ],
            );
            await enqueueInboundReceipt(e, source, id);
          }
        }
        await persist(e, next);
      });
      cursor = next;
      handled++;
    }
    const complete = cursor.loaded && cursor.pending.length === 0 && !cursor.nextPageToken;
    const delay = complete ? selection.cadenceMinutes * 60 : 1;
    await guarded(
      async (e) => {
        await e.query(
          `UPDATE cpl_integration_sources SET history_id=$3,page_json=$4::jsonb,coverage=$5,
          last_success_at=CASE WHEN $6 THEN clock_timestamp() ELSE last_success_at END,
          last_issue=$7::jsonb,next_eligible_at=clock_timestamp()+($8::integer * INTERVAL '1 second'),updated_at=clock_timestamp()
        WHERE organization_id=$1 AND id=$2`,
          [
            source.organization_id,
            source.id,
            complete ? cursor.checkpoint : source.history_id,
            complete ? null : JSON.stringify(cursor),
            complete
              ? cursor.warnings.length
                ? "incomplete"
                : "complete_to_checkpoint"
              : cursor.mode === "backfill"
                ? "backfill_in_progress"
                : "incomplete",
            complete,
            cursor.warnings[0] ? JSON.stringify(issue(cursor.warnings[0], false)) : null,
            delay,
          ],
        );
      },
      async (e) => {
        await finishJob(e, job, leaseToken, "completed", null);
        await e.query(
          `INSERT INTO cpl_workflow_jobs(id,organization_id,kind,status,max_attempts,available_at,
          issued_by_identity_id,issued_membership_version,integration_source_id,integration_generation,integration_configuration_version)
        VALUES($1,$2,'integration.gmail.sync','queued',5,clock_timestamp()+($3::integer * INTERVAL '1 second'),$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            source.organization_id,
            delay,
            source.configured_by_identity_id,
            source.authorized_membership_version,
            source.id,
            source.generation,
            source.configuration_version,
          ],
        );
      },
    );
    return "completed";
  } catch (error) {
    const code = safeCode(error);
    if (code === "CPL_INTEGRATION_LEASE_LOST") throw error;
    if (code === "CPL_INTEGRATION_BUSY") {
      const outcome = Number(job.attempts) >= Number(job.max_attempts) ? "failed" : "retrying";
      await finishJob(database, job, leaseToken, outcome, code, 30);
      return outcome;
    }
    if (revoked.has(code)) {
      // A stale worker may acknowledge only its own still-live lease. It must not
      // overwrite the new source generation or write tenant business records.
      await finishJob(database, job, leaseToken, "skipped", code);
      return "skipped";
    }
    const reconnect = [
      "CPL_INTEGRATION_RECONNECT_REQUIRED",
      "TOKEN_REFRESH_REJECTED",
      "TOKEN_SCOPES_REJECTED",
      "PROVIDER_UNAUTHORIZED",
      "CPL_INTEGRATION_DECRYPTION_FAILED",
    ].includes(code);
    const resync = code === "HISTORY_EXPIRED";
    const retryable =
      signal.aborted ||
      ["40001", "40P01", "55P03", "57014", "ECONNRESET", "ECONNREFUSED"].includes(code) ||
      (error != null &&
        typeof error === "object" &&
        "retryable" in error &&
        error.retryable === true);
    const terminal =
      reconnect || resync || !retryable || Number(job.attempts) >= Number(job.max_attempts);
    const safe = reconnect
      ? "CPL_INTEGRATION_RECONNECT_REQUIRED"
      : resync
        ? "CPL_INTEGRATION_RESYNC_REQUIRED"
        : ["CPL_INTEGRATION_SOURCE_CONFLICT", "CPL_INTEGRATION_STORAGE_LIMIT"].includes(code)
          ? code
          : code === "PROVIDER_RATE_LIMITED"
            ? "CPL_INTEGRATION_RATE_LIMITED"
            : "CPL_INTEGRATION_PROCESSING_FAILED";
    const retryAfter =
      error && typeof error === "object" && "retryAfterSeconds" in error
        ? Number(error.retryAfterSeconds)
        : 0;
    const delay = Math.min(
      86_400,
      Math.max(
        60,
        Number.isFinite(retryAfter) ? retryAfter : 0,
        Math.min(3600, 2 ** Math.min(10, Number(job.attempts)) * 30),
      ),
    );
    try {
      await guarded(
        async (e) => {
          await e.query(
            `UPDATE cpl_integration_sources SET state=$3,coverage=$4,last_issue=$5::jsonb,
          next_eligible_at=CASE WHEN $6 THEN NULL ELSE clock_timestamp()+($7::integer * INTERVAL '1 second') END,updated_at=clock_timestamp()
          WHERE organization_id=$1 AND id=$2`,
            [
              job.organization_id,
              job.integration_source_id,
              reconnect ? "reconnect_required" : terminal ? "failed" : "active",
              resync ? "resync_required" : "incomplete",
              JSON.stringify(issue(safe, !terminal)),
              terminal,
              delay,
            ],
          );
        },
        (e) => finishJob(e, job, leaseToken, terminal ? "failed" : "retrying", safe, delay),
      );
    } catch (fenceError) {
      if (safeCode(fenceError) === "CPL_INTEGRATION_BUSY") {
        await finishJob(database, job, leaseToken, "retrying", "CPL_INTEGRATION_BUSY", 30);
        return "retrying";
      }
      if (!revoked.has(safeCode(fenceError))) throw fenceError;
      await finishJob(database, job, leaseToken, "skipped", safeCode(fenceError));
      return "skipped";
    }
    return terminal ? "failed" : "retrying";
  } finally {
    if (ownsOperation) {
      // Releasing only our opaque token cannot clear a newer human/worker lease.
      // No source state or credential is modified after authority loss.
      await database
        .transaction(async (e) => {
          await e.query("SELECT set_config('cpl.organization_id',$1,true)", [job.organization_id]);
          await e.query(
            "UPDATE cpl_integration_sources SET operation_token=NULL,operation_expires_at=NULL WHERE organization_id=$1 AND id=$2 AND operation_token=$3",
            [job.organization_id, job.integration_source_id, leaseToken],
          );
        })
        .catch(() => undefined); // The bounded lease expires if cleanup is unavailable.
    }
  }
}
