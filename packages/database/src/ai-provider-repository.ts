import { randomUUID } from "node:crypto";
import type {
  AiMessageCitationRecord,
  AiModelCacheRecord,
  AiPresentationRunRecord,
  AiPresentationStatus,
  AiProviderConnectionTest,
  AiProviderKey,
  AiProviderSettings,
  AiRealtimeSessionRecord,
  AiResponseRun,
  AiToolCallRecord,
  AiUsageLedgerRecord,
  AiUserVoicePreference,
  ArtifactProviderKey,
  GeneratedArtifactRecord,
  JsonObject,
  RateLimitDecision,
} from "@bea/domain";
import {
  createUnconfiguredAiRoutingProfile,
  DEFAULT_ASSISTANT_POLICY_PROVENANCE,
  type AssistantPolicyProvenance,
} from "@bea/domain";
import type { DatabaseAdapter } from "./adapter.js";
import { PHASE21_LIMITS } from "@bea/ai";

type Row = Record<string, unknown>;

export const AI_PROVIDER_SETTINGS_KEY = "ai.provider.settings";

export const DEFAULT_AI_PROVIDER_SETTINGS: AiProviderSettings = Object.freeze({
  mode: "demo",
  defaultTextModel: "deterministic-demo-router",
  defaultRealtimeModel: "deterministic-demo-router",
  defaultVoice: "demo",
  webSearchAllowed: false,
  webSearchDefault: false,
  codeInterpreterAllowed: false,
  imageGenerationAllowed: false,
  pdfGenerationAllowed: false,
  realtimeAllowed: true,
  requestTimeoutMs: 30_000,
  modelCacheTtlSeconds: 3_600,
  dailyRequestLimit: 100,
  perUserRequestsPerMinute: 10,
  perConversationRequestsPerMinute: 10,
  maxUploadBytes: 10_000_000,
  maxGeneratedFileBytes: 25_000_000,
  maxResearchDurationSeconds: 300,
  codeInterpreterMaxContainerSeconds: 300,
  imageQuality: "medium",
  defaultChartType: "bar",
  defaultPdfTemplate: "standard",
  artifactRetentionDays: 30,
  monthlyCostLimitUsd: null,
  highCostConfirmationThresholdUsd: null,
  realtimeTurnDetection: "server_vad",
  realtimeInteractionMode: "automatic",
  realtimeAllowInterruption: true,
  inputTranscriptionModel: null,
  realtimeOutputSpeed: 1,
  realtimeSessionInstructions: "Assist with authorized BEA work and only propose registered tools.",
  realtimeMaxOutputTokens: 2048,
  modelCapabilityOverrides: {},
  routingProfile: createUnconfiguredAiRoutingProfile(),
});

export const PRODUCTION_AI_PROVIDER_SETTINGS: AiProviderSettings = Object.freeze({
  ...DEFAULT_AI_PROVIDER_SETTINGS,
  mode: "openai",
  defaultTextModel: "unconfigured",
  defaultRealtimeModel: "unconfigured",
  defaultVoice: "marin",
  realtimeAllowed: false,
});

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapConnectionTest(row: Row): AiProviderConnectionTest {
  return {
    id: String(row.id),
    provider: row.provider as AiProviderKey,
    actorUserId: String(row.actor_user_id),
    outcome: row.outcome as AiProviderConnectionTest["outcome"],
    authenticated: Boolean(row.authenticated),
    safeFailureCode: nullable(row.safe_failure_code),
    safeMessage: String(row.safe_message),
    modelCount:
      row.model_count === null || row.model_count === undefined ? null : Number(row.model_count),
    latencyMs:
      row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    credentialFingerprint: nullable(row.credential_fingerprint),
    correlationId: String(row.correlation_id),
    testedAt: iso(row.tested_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function connectionEvidenceMatchesCredential(
  evidence: Pick<AiProviderConnectionTest, "credentialFingerprint"> | null | undefined,
  currentFingerprint: string | null | undefined,
): boolean {
  return (
    typeof currentFingerprint === "string" &&
    currentFingerprint.length > 0 &&
    evidence?.credentialFingerprint === currentFingerprint
  );
}

function mapRealtimeSession(row: Row): AiRealtimeSessionRecord {
  return {
    id: String(row.id),
    conversationId: nullable(row.conversation_id),
    requestedByUserId: String(row.requested_by_user_id),
    provider: row.provider as AiProviderKey,
    providerSessionId: nullable(row.provider_session_id),
    model: String(row.model),
    voice: String(row.voice),
    status: row.status as AiRealtimeSessionRecord["status"],
    correlationId: String(row.correlation_id),
    authorizedAt: iso(row.authorized_at),
    expiresAt: iso(row.expires_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    errorCode: nullable(row.error_code),
    simulated: Boolean(row.simulated),
    policyProvenance: json<AssistantPolicyProvenance>(
      row.policy_provenance,
      DEFAULT_ASSISTANT_POLICY_PROVENANCE,
    ),
    routeDecision: json(row.route_decision, null),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapPresentationRun(row: Row): AiPresentationRunRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    responseRunId: nullable(row.response_run_id),
    realtimeSessionId: nullable(row.realtime_session_id),
    initiatingUserMessageId: nullable(row.initiating_user_message_id),
    assistantMessageId: nullable(row.assistant_message_id),
    visualArtifactId: nullable(row.visual_artifact_id),
    actingUserId: String(row.acting_user_id),
    routeKey: String(row.route_key),
    provider: String(row.provider),
    model: String(row.model),
    providerResponseId: nullable(row.provider_response_id),
    status: row.status as AiPresentationStatus,
    query: String(row.query),
    packet: json<JsonObject>(row.packet, {}),
    selectedContext: json<JsonObject | null>(row.selected_context, null),
    autoFollow: Boolean(row.auto_follow),
    simulated: Boolean(row.simulated),
    liveWebSearch: Boolean(row.live_web_search),
    requiredPermissions: json<readonly string[]>(row.required_permissions, []),
    usageMetadata: json<JsonObject>(row.usage_metadata, {}),
    errorCode: nullable(row.error_code),
    errorMessage: nullable(row.error_message),
    startedAt: iso(row.started_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

function mapGeneratedArtifact(row: Row): GeneratedArtifactRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    responseRunId: nullable(row.response_run_id),
    requestedByUserId: String(row.requested_by_user_id),
    kind: row.kind as GeneratedArtifactRecord["kind"],
    title: String(row.title),
    status: row.status as GeneratedArtifactRecord["status"],
    artifactVersion: Number(row.artifact_version),
    provider: row.provider as ArtifactProviderKey,
    providerItemId: nullable(row.provider_item_id),
    providerContainerId: nullable(row.provider_container_id),
    providerFileId: nullable(row.provider_file_id),
    filename: nullable(row.filename),
    mediaType: nullable(row.media_type),
    storageReference: nullable(row.storage_reference),
    specification: json<JsonObject>(row.specification, {}),
    sourceMetadata: json<JsonObject>(row.source_metadata, {}),
    citationIds: json<readonly string[]>(row.citation_ids, []),
    fileMetadata: json<JsonObject>(row.file_metadata, {}),
    renderMetadata: json<JsonObject>(row.render_metadata, {}),
    generationMetadata: json<JsonObject>(row.generation_metadata, {}),
    requiredPermissions: json<readonly string[]>(row.required_permissions, []),
    simulated: Boolean(row.simulated),
    errorCode: nullable(row.error_code),
    policyProvenance: json<AssistantPolicyProvenance>(
      row.policy_provenance,
      DEFAULT_ASSISTANT_POLICY_PROVENANCE,
    ),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export interface RecordConnectionTestInput {
  readonly provider: AiProviderKey;
  readonly actorUserId: string;
  readonly outcome: "succeeded" | "failed";
  readonly authenticated: boolean;
  readonly safeFailureCode?: string;
  readonly safeMessage: string;
  readonly modelCount?: number;
  readonly latencyMs?: number;
  readonly credentialFingerprint: string | null;
  readonly correlationId: string;
  readonly testedAt?: string;
}

export interface BeginAiResponseRunInput {
  readonly conversationId: string;
  readonly requestedByUserId: string;
  readonly requestId: string;
  readonly provider: AiProviderKey;
  readonly model: string;
  readonly correlationId: string;
  readonly startedAt?: string;
  readonly policyProvenance?: AssistantPolicyProvenance;
  readonly routeDecision?: AiResponseRun["routeDecision"];
}

export interface CompleteAiResponseRunInput {
  readonly id: string;
  readonly requestedByUserId: string;
  readonly status: Exclude<AiResponseRun["status"], "started">;
  readonly providerResponseId?: string;
  readonly errorCode?: string;
  readonly completedAt?: string;
}

export interface AiProviderSettingsSnapshot {
  readonly settings: AiProviderSettings;
  readonly version: number;
}

export interface ActivateOpenAiAtomicallyInput {
  readonly actorUserId: string;
  readonly evidenceId: string;
  readonly credentialFingerprint: string;
  readonly settings: AiProviderSettings;
  readonly expectedSettingsVersion: number;
  readonly correlationId: string;
  readonly authorizationAuditId: string;
  readonly activatedAt?: string;
}

export type RecordGeneratedArtifactInput = Omit<
  GeneratedArtifactRecord,
  "id" | "createdAt" | "updatedAt" | "version" | "policyProvenance"
> & { readonly policyProvenance?: AssistantPolicyProvenance };

export class SqlAiProviderRepository {
  constructor(private readonly database: DatabaseAdapter) {}

  async getProviderSettings(): Promise<AiProviderSettings> {
    return (await this.getProviderSettingsSnapshot()).settings;
  }

  async ensureProviderSettings(appMode: "demo" | "production"): Promise<void> {
    const now = new Date().toISOString();
    const settings =
      appMode === "production" ? PRODUCTION_AI_PROVIDER_SETTINGS : DEFAULT_AI_PROVIDER_SETTINGS;
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO system_settings
         (id,key,value_json,description,sensitivity,created_at,updated_at,version)
         VALUES ($1,$2,$3::jsonb,$4,'internal',$5,$5,1)
         ON CONFLICT (key) DO NOTHING`,
        [
          randomUUID(),
          AI_PROVIDER_SETTINGS_KEY,
          JSON.stringify(settings),
          "Phase 1.3.3 production OpenAI provider and workload-routing policy.",
          now,
        ],
      );
      if (appMode === "production") {
        await transaction.query(
          `INSERT INTO integration_connections
           (id,provider_type,display_name,mode,connection_status,requirement_status,
            configuration_completeness,required_permissions,test_mode,mock_mode,created_at,updated_at,version)
           VALUES ($1,'ai','OpenAI','live','not-configured','BLOCKED',0,$2::jsonb,FALSE,FALSE,$3,$3,1)
           ON CONFLICT (provider_type) DO NOTHING`,
          [randomUUID(), JSON.stringify(["ai.run", "integration.manage", "settings.manage"]), now],
        );
      }
    });
  }

  async adoptOwnerEvaluationOpenAiBoundary(): Promise<void> {
    const now = new Date().toISOString();
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE system_settings
         SET value_json=$1::jsonb, updated_at=$2, version=version+1
         WHERE key=$3`,
        [JSON.stringify(PRODUCTION_AI_PROVIDER_SETTINGS), now, AI_PROVIDER_SETTINGS_KEY],
      );
      await transaction.query(
        `UPDATE integration_connections
         SET display_name='OpenAI', mode='live', connection_status='not-configured',
             requirement_status='BLOCKED', test_mode=FALSE, mock_mode=FALSE,
             updated_at=$1, version=version+1
         WHERE provider_type='ai'`,
        [now],
      );
    });
  }

  async getProviderSettingsSnapshot(): Promise<AiProviderSettingsSnapshot> {
    const result = await this.database.query<Row>(
      "SELECT value_json,version FROM system_settings WHERE key=$1",
      [AI_PROVIDER_SETTINGS_KEY],
    );
    const row = result.rows[0];
    if (!row) throw new Error("AI provider settings are unavailable.");
    return {
      settings: {
        ...DEFAULT_AI_PROVIDER_SETTINGS,
        ...json<Partial<AiProviderSettings>>(row.value_json, {}),
      },
      version: Number(row.version),
    };
  }

  async recordConnectionTest(input: RecordConnectionTestInput): Promise<AiProviderConnectionTest> {
    const id = randomUUID();
    const testedAt = input.testedAt ?? new Date().toISOString();
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<Row>(
        `INSERT INTO ai_provider_connection_tests
         (id,provider,actor_user_id,outcome,authenticated,safe_failure_code,safe_message,model_count,latency_ms,credential_fingerprint,correlation_id,tested_at,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12,1) RETURNING *`,
        [
          id,
          input.provider,
          input.actorUserId,
          input.outcome,
          input.authenticated,
          input.safeFailureCode ?? null,
          input.safeMessage,
          input.modelCount ?? null,
          input.latencyMs ?? null,
          input.credentialFingerprint,
          input.correlationId,
          testedAt,
        ],
      );
      await transaction.query(
        `UPDATE integration_connections
         SET last_health_check_at=$1,
             last_successful_test_at=CASE WHEN $2='succeeded' AND $3=TRUE THEN $1 ELSE last_successful_test_at END,
             last_failed_test_at=CASE WHEN $2='failed' THEN $1 ELSE last_failed_test_at END,
             last_test_evidence_id=$4,
             last_failure=CASE WHEN $2='failed' THEN jsonb_build_object('code',COALESCE($5,'PROVIDER_TEST_FAILED'),'message',$6::text,'retryable',FALSE) ELSE NULL END,
             updated_at=$1,version=version+1
         WHERE provider_type='ai'`,
        [
          testedAt,
          input.outcome,
          input.authenticated,
          id,
          input.safeFailureCode ?? null,
          input.safeMessage,
        ],
      );
      return mapConnectionTest(result.rows[0] as Row);
    });
  }

  async latestConnectionTest(provider: AiProviderKey): Promise<AiProviderConnectionTest | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM ai_provider_connection_tests
       WHERE provider=$1 ORDER BY tested_at DESC,id DESC LIMIT 1`,
      [provider],
    );
    return result.rows[0] ? mapConnectionTest(result.rows[0]) : null;
  }

  async latestConnectionTestByOutcome(
    provider: AiProviderKey,
    outcome: AiProviderConnectionTest["outcome"],
  ): Promise<AiProviderConnectionTest | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM ai_provider_connection_tests
       WHERE provider=$1 AND outcome=$2 ORDER BY tested_at DESC,id DESC LIMIT 1`,
      [provider, outcome],
    );
    return result.rows[0] ? mapConnectionTest(result.rows[0]) : null;
  }

  async restoreLiveOpenAiConnection(): Promise<void> {
    const now = new Date().toISOString();
    await this.database.query(
      `UPDATE integration_connections
       SET display_name='OpenAI', mode='live', connection_status='connected',
           requirement_status='CONNECTED', test_mode=FALSE, mock_mode=FALSE,
           configuration_completeness=100, updated_at=$1, version=version+1
       WHERE provider_type='ai'`,
      [now],
    );
  }

  async activateOpenAiAtomically(input: ActivateOpenAiAtomicallyInput): Promise<boolean> {
    const activatedAt = input.activatedAt ?? new Date().toISOString();
    return this.database.transaction(async (transaction) => {
      const connection = await transaction.query<{ id: string }>(
        `UPDATE integration_connections c
         SET mode='live',connection_status='connected',requirement_status='CONNECTED',mock_mode=FALSE,
             test_mode=FALSE,configuration_completeness=100,activated_at=$3,activated_by_user_id=$2,
             last_test_evidence_id=$1,updated_at=$3,version=version+1
         WHERE c.provider_type='ai' AND EXISTS (
           SELECT 1 FROM ai_provider_connection_tests t
           WHERE t.id=$1 AND t.provider='openai' AND t.outcome='succeeded' AND t.authenticated=TRUE
             AND t.credential_fingerprint=$7
         ) AND EXISTS (
           SELECT 1 FROM audit_logs a
           WHERE a.id=$4 AND a.event_type='ai-provider.activation-authorized'
             AND a.action='openai.activate' AND a.outcome='allowed'
             AND a.actor_user_id=$2 AND a.correlation_id=$5
             AND a.metadata->>'provider'='openai'
             AND a.metadata->>'evidenceId'=$1::text
             AND a.metadata->>'model'=$6
             AND a.metadata->>'credentialFingerprint'=$7
         ) RETURNING c.id`,
        [
          input.evidenceId,
          input.actorUserId,
          activatedAt,
          input.authorizationAuditId,
          input.correlationId,
          input.settings.defaultTextModel,
          input.credentialFingerprint,
        ],
      );
      if (connection.rowCount !== 1) return false;

      const setting = await transaction.query<{ id: string }>(
        `UPDATE system_settings
         SET value_json=$2::jsonb,created_by_user_id=$3,updated_at=$4,version=version+1
         WHERE key=$1 AND version=$5 RETURNING id`,
        [
          AI_PROVIDER_SETTINGS_KEY,
          JSON.stringify(input.settings),
          input.actorUserId,
          activatedAt,
          input.expectedSettingsVersion,
        ],
      );
      if (setting.rowCount !== 1) {
        throw new Error("AI provider settings changed before activation could be committed.");
      }

      await transaction.query(
        `INSERT INTO audit_logs
         (id,event_type,action,outcome,actor_user_id,resource_type,resource_id,correlation_id,metadata,created_at)
         VALUES ($1,'ai-provider.activated','openai.activate','succeeded',$2,'integration-provider',$3,$4,$5::jsonb,$6)`,
        [
          randomUUID(),
          input.actorUserId,
          connection.rows[0]?.id,
          input.correlationId,
          JSON.stringify({
            provider: "openai",
            evidenceId: input.evidenceId,
            model: input.settings.defaultTextModel,
            authorizationAuditId: input.authorizationAuditId,
          }),
          activatedAt,
        ],
      );
      return true;
    });
  }

  async activateDemo(actorUserId: string, activatedAt = new Date().toISOString()): Promise<void> {
    await this.database.query(
      `UPDATE integration_connections
       SET mode='mock',connection_status='simulated',requirement_status='SIMULATED',mock_mode=TRUE,
           test_mode=TRUE,configuration_completeness=0,activated_at=$2,activated_by_user_id=$1,
           updated_at=$2,version=version+1 WHERE provider_type='ai'`,
      [actorUserId, activatedAt],
    );
  }

  async deactivateOpenAiProduction(input: {
    readonly actorUserId: string;
    readonly configured: boolean;
    readonly at?: string;
  }): Promise<void> {
    const at = input.at ?? new Date().toISOString();
    await this.database.query(
      `UPDATE integration_connections
       SET mode='live',connection_status=$2,requirement_status='BLOCKED',mock_mode=FALSE,
           test_mode=FALSE,configuration_completeness=$3,activated_at=NULL,
           activated_by_user_id=$1,updated_at=$4,version=version+1
       WHERE provider_type='ai'`,
      [
        input.actorUserId,
        input.configured ? "not-configured" : "disabled",
        input.configured ? 25 : 0,
        at,
      ],
    );
  }

  async replaceModelCache(input: {
    readonly provider: AiProviderKey;
    readonly models: readonly Omit<
      AiModelCacheRecord,
      "id" | "createdAt" | "updatedAt" | "version"
    >[];
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const now = new Date().toISOString();
      const returnedIds = new Set(input.models.map((model) => model.modelId));
      const existing = await transaction.query<{ model_id: string }>(
        "SELECT model_id FROM ai_model_cache WHERE provider=$1",
        [input.provider],
      );
      for (const row of existing.rows) {
        if (!returnedIds.has(String(row.model_id))) {
          await transaction.query(
            `UPDATE ai_model_cache
             SET available=FALSE, updated_at=$1, version=version+1
             WHERE provider=$2 AND model_id=$3`,
            [now, input.provider, String(row.model_id)],
          );
        }
      }
      for (const model of input.models) {
        await transaction.query(
          `INSERT INTO ai_model_cache
           (id,provider,model_id,available,owned_by,capabilities,capability_source,validation,fetched_at,expires_at,created_at,updated_at,version)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$11,1)
           ON CONFLICT (provider, model_id) DO UPDATE SET
             available=EXCLUDED.available,
             owned_by=EXCLUDED.owned_by,
             capabilities=EXCLUDED.capabilities,
             capability_source=EXCLUDED.capability_source,
             validation=EXCLUDED.validation,
             fetched_at=EXCLUDED.fetched_at,
             expires_at=EXCLUDED.expires_at,
             updated_at=EXCLUDED.updated_at,
             version=ai_model_cache.version+1`,
          [
            randomUUID(),
            input.provider,
            model.modelId,
            model.available,
            model.ownedBy,
            JSON.stringify(model.capabilities),
            model.capabilitySource,
            JSON.stringify(model.validation),
            model.fetchedAt,
            model.expiresAt,
            now,
          ],
        );
      }
    });
  }

  async upsertCapabilityEvidence(
    records: readonly {
      readonly provider?: "openai";
      readonly modelId: string;
      readonly capability: string;
      readonly status: "verified" | "candidate" | "unsupported";
      readonly verificationMethod: "registry" | "provider_probe" | "administrator";
      readonly verifiedAt: string;
      readonly providerRequestId: string | null;
      readonly safeFailureCode: string | null;
      readonly registryVersion: string;
    }[],
  ): Promise<void> {
    if (records.length === 0) return;
    await this.database.transaction(async (transaction) => {
      const now = new Date().toISOString();
      for (const record of records) {
        await transaction.query(
          `INSERT INTO ai_model_capability_evidence
           (id,provider,model_id,capability,status,verification_method,verified_at,provider_request_id,safe_failure_code,registry_version,created_at,updated_at,version)
           VALUES ($1,'openai',$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,1)
           ON CONFLICT (provider, model_id, capability) DO UPDATE SET
             status=EXCLUDED.status,
             verification_method=EXCLUDED.verification_method,
             verified_at=EXCLUDED.verified_at,
             provider_request_id=EXCLUDED.provider_request_id,
             safe_failure_code=EXCLUDED.safe_failure_code,
             registry_version=EXCLUDED.registry_version,
             updated_at=EXCLUDED.updated_at,
             version=ai_model_capability_evidence.version+1`,
          [
            randomUUID(),
            record.modelId,
            record.capability,
            record.status,
            record.verificationMethod,
            record.verifiedAt,
            record.providerRequestId,
            record.safeFailureCode,
            record.registryVersion,
            now,
          ],
        );
      }
    });
  }

  async listCachedModels(provider: AiProviderKey): Promise<readonly AiModelCacheRecord[]> {
    const result = await this.database.query<Row>(
      `SELECT * FROM ai_model_cache WHERE provider=$1 ORDER BY model_id`,
      [provider],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      provider: row.provider as AiProviderKey,
      modelId: String(row.model_id),
      available: Boolean(row.available),
      ownedBy: nullable(row.owned_by),
      capabilities: json(row.capabilities, {}),
      capabilitySource: row.capability_source as AiModelCacheRecord["capabilitySource"],
      validation: json(row.validation, {
        registryVersion: "2026-08-phase1.3.3-v1",
        validatedAt: null,
        validationMethod: "unknown",
        evidence: {},
      }),
      fetchedAt: iso(row.fetched_at),
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      version: Number(row.version),
    }));
  }

  async beginResponseRun(input: BeginAiResponseRunInput): Promise<AiResponseRun> {
    const id = randomUUID();
    const startedAt = input.startedAt ?? new Date().toISOString();
    const result = await this.database.query<Row>(
      `INSERT INTO ai_response_runs
       (id,conversation_id,requested_by_user_id,request_id,provider,model,status,correlation_id,started_at,policy_provenance,route_decision,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,'started',$7,$8,$9::jsonb,$10::jsonb,$8,$8,1) RETURNING *`,
      [
        id,
        input.conversationId,
        input.requestedByUserId,
        input.requestId,
        input.provider,
        input.model,
        input.correlationId,
        startedAt,
        JSON.stringify(input.policyProvenance ?? DEFAULT_ASSISTANT_POLICY_PROVENANCE),
        input.routeDecision == null ? null : JSON.stringify(input.routeDecision),
      ],
    );
    return this.mapResponseRun(result.rows[0] as Row);
  }

  async completeResponseRun(input: CompleteAiResponseRunInput): Promise<AiResponseRun | null> {
    const completedAt = input.completedAt ?? new Date().toISOString();
    const result = await this.database.query<Row>(
      `UPDATE ai_response_runs SET status=$3,provider_response_id=$4,error_code=$5,completed_at=$6,
       updated_at=$6,version=version+1 WHERE id=$1 AND requested_by_user_id=$2 AND status='started' RETURNING *`,
      [
        input.id,
        input.requestedByUserId,
        input.status,
        input.providerResponseId ?? null,
        input.errorCode ?? null,
        completedAt,
      ],
    );
    return result.rows[0] ? this.mapResponseRun(result.rows[0]) : null;
  }

  async recordCitation(
    input: Omit<AiMessageCitationRecord, "id" | "createdAt" | "updatedAt" | "version">,
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.database.query(
      `INSERT INTO ai_message_citations
       (id,response_run_id,assistant_message_id,provider_item_id,title,url,domain,start_index,end_index,retrieved_at,simulated,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,1)`,
      [
        id,
        input.responseRunId,
        input.assistantMessageId,
        input.providerItemId,
        input.title,
        input.url,
        input.domain,
        input.startIndex,
        input.endIndex,
        input.retrievedAt,
        input.simulated,
        now,
      ],
    );
    return id;
  }

  async recordToolCall(
    input: Omit<AiToolCallRecord, "id" | "createdAt" | "updatedAt" | "version">,
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.database.query(
      `INSERT INTO ai_tool_calls
       (id,response_run_id,provider_call_id,name,arguments,status,required_permissions,effect,error_code,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$10,1)`,
      [
        id,
        input.responseRunId,
        input.providerCallId,
        input.name,
        JSON.stringify(input.arguments),
        input.status,
        JSON.stringify(input.requiredPermissions),
        input.effect,
        input.errorCode,
        now,
      ],
    );
    return id;
  }

  async recordUsage(
    input: Omit<AiUsageLedgerRecord, "id" | "createdAt" | "updatedAt" | "version">,
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.database.query(
      `INSERT INTO ai_usage_records
       (id,response_run_id,realtime_session_id,requested_by_user_id,provider,model,operation,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,audio_input_tokens,audio_output_tokens,realtime_duration_seconds,estimated_cost_usd,cost_status,simulated,recorded_at,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,1)`,
      [
        id,
        input.responseRunId,
        input.realtimeSessionId,
        input.requestedByUserId,
        input.provider,
        input.model,
        input.operation,
        input.inputTokens,
        input.outputTokens,
        input.reasoningTokens,
        input.cachedInputTokens,
        input.audioInputTokens,
        input.audioOutputTokens,
        input.realtimeDurationSeconds,
        input.estimatedCostUsd,
        input.costStatus,
        input.simulated,
        input.recordedAt,
        now,
      ],
    );
    return id;
  }

  async recordRealtimeSession(
    input: Omit<
      AiRealtimeSessionRecord,
      | "id"
      | "conversationId"
      | "createdAt"
      | "updatedAt"
      | "version"
      | "policyProvenance"
      | "routeDecision"
    > & {
      readonly conversationId: string;
      readonly policyProvenance?: AssistantPolicyProvenance;
      readonly routeDecision?: AiRealtimeSessionRecord["routeDecision"];
    },
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.database.query(
      `INSERT INTO ai_realtime_sessions
       (id,conversation_id,requested_by_user_id,provider,provider_session_id,model,voice,status,correlation_id,authorized_at,expires_at,completed_at,error_code,simulated,policy_provenance,route_decision,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$17,1)`,
      [
        id,
        input.conversationId,
        input.requestedByUserId,
        input.provider,
        input.providerSessionId,
        input.model,
        input.voice,
        input.status,
        input.correlationId,
        input.authorizedAt,
        input.expiresAt,
        input.completedAt,
        input.errorCode,
        input.simulated,
        JSON.stringify(input.policyProvenance ?? DEFAULT_ASSISTANT_POLICY_PROVENANCE),
        input.routeDecision == null ? null : JSON.stringify(input.routeDecision),
        now,
      ],
    );
    return id;
  }

  async getUserVoicePreference(userId: string): Promise<AiUserVoicePreference> {
    const result = await this.database.query<Row>(
      `SELECT * FROM ai_user_voice_preferences WHERE user_id=$1 LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      const now = new Date().toISOString();
      return {
        id: userId,
        userId,
        speakResponses: true,
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
    }
    return {
      id: String(row.user_id),
      userId: String(row.user_id),
      speakResponses: Boolean(row.speak_responses),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      version: Number(row.version),
    };
  }

  async setUserVoicePreference(input: {
    readonly userId: string;
    readonly speakResponses: boolean;
  }): Promise<AiUserVoicePreference> {
    const now = new Date().toISOString();
    const result = await this.database.query<Row>(
      `INSERT INTO ai_user_voice_preferences
       (user_id,speak_responses,created_at,updated_at,version)
       VALUES ($1,$2,$3,$3,1)
       ON CONFLICT (user_id) DO UPDATE
       SET speak_responses=EXCLUDED.speak_responses,updated_at=EXCLUDED.updated_at,
           version=ai_user_voice_preferences.version+1
       RETURNING *`,
      [input.userId, input.speakResponses, now],
    );
    const row = result.rows[0] as Row;
    return {
      id: String(row.user_id),
      userId: String(row.user_id),
      speakResponses: Boolean(row.speak_responses),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      version: Number(row.version),
    };
  }

  async getRealtimeSessionForUser(
    id: string,
    requestedByUserId: string,
  ): Promise<AiRealtimeSessionRecord | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM ai_realtime_sessions WHERE id=$1 AND requested_by_user_id=$2 LIMIT 1`,
      [id, requestedByUserId],
    );
    return result.rows[0] ? mapRealtimeSession(result.rows[0]) : null;
  }

  async transitionRealtimeSession(input: {
    readonly id: string;
    readonly requestedByUserId: string;
    readonly status: "connected" | "completed" | "failed" | "cancelled";
    readonly providerSessionId?: string | null;
    readonly completedAt?: string | null;
    readonly errorCode?: string | null;
  }): Promise<AiRealtimeSessionRecord | null> {
    const now = new Date().toISOString();
    const terminal = ["completed", "failed", "cancelled"].includes(input.status);
    const result = await this.database.query<Row>(
      `UPDATE ai_realtime_sessions
       SET status=$3,
           provider_session_id=COALESCE($4,provider_session_id),
           completed_at=$5,
           error_code=$6,
           updated_at=$7,
           version=version+1
       WHERE id=$1 AND requested_by_user_id=$2
         AND status IN ('authorized','connected')
         AND ($3 <> 'connected' OR status='authorized')
       RETURNING *`,
      [
        input.id,
        input.requestedByUserId,
        input.status,
        input.providerSessionId ?? null,
        terminal ? (input.completedAt ?? now) : null,
        input.errorCode ?? null,
        now,
      ],
    );
    if (result.rows[0]) return mapRealtimeSession(result.rows[0]);
    const existing = await this.getRealtimeSessionForUser(input.id, input.requestedByUserId);
    return existing?.status === input.status ? existing : null;
  }

  async recordGeneratedArtifact(input: RecordGeneratedArtifactInput): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.database.query(
      `INSERT INTO generated_artifacts
       (id,conversation_id,response_run_id,requested_by_user_id,kind,title,status,artifact_version,provider,provider_item_id,provider_container_id,provider_file_id,filename,media_type,storage_reference,specification,source_metadata,citation_ids,file_metadata,render_metadata,generation_metadata,required_permissions,simulated,error_code,policy_provenance,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25::jsonb,$26,$26,1)`,
      [
        id,
        input.conversationId,
        input.responseRunId,
        input.requestedByUserId,
        input.kind,
        input.title,
        input.status,
        input.artifactVersion,
        input.provider,
        input.providerItemId,
        input.providerContainerId,
        input.providerFileId,
        input.filename,
        input.mediaType,
        input.storageReference,
        JSON.stringify(input.specification),
        JSON.stringify(input.sourceMetadata),
        JSON.stringify(input.citationIds),
        JSON.stringify(input.fileMetadata),
        JSON.stringify(input.renderMetadata),
        JSON.stringify(input.generationMetadata),
        JSON.stringify(input.requiredPermissions),
        input.simulated,
        input.errorCode,
        JSON.stringify(input.policyProvenance ?? DEFAULT_ASSISTANT_POLICY_PROVENANCE),
        now,
      ],
    );
    return id;
  }

  async recordGeneratedArtifacts(
    inputs: readonly RecordGeneratedArtifactInput[],
  ): Promise<readonly string[]> {
    if (inputs.length < 1 || inputs.length > 25) {
      throw new Error("Generated artifact batch must contain between 1 and 25 records.");
    }
    return this.database.transaction(async (transaction) => {
      const now = new Date().toISOString();
      const ids: string[] = [];
      for (const input of inputs) {
        const id = randomUUID();
        await transaction.query(
          `INSERT INTO generated_artifacts
           (id,conversation_id,response_run_id,requested_by_user_id,kind,title,status,artifact_version,provider,provider_item_id,provider_container_id,provider_file_id,filename,media_type,storage_reference,specification,source_metadata,citation_ids,file_metadata,render_metadata,generation_metadata,required_permissions,simulated,error_code,policy_provenance,created_at,updated_at,version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25::jsonb,$26,$26,1)`,
          [
            id,
            input.conversationId,
            input.responseRunId,
            input.requestedByUserId,
            input.kind,
            input.title,
            input.status,
            input.artifactVersion,
            input.provider,
            input.providerItemId,
            input.providerContainerId,
            input.providerFileId,
            input.filename,
            input.mediaType,
            input.storageReference,
            JSON.stringify(input.specification),
            JSON.stringify(input.sourceMetadata),
            JSON.stringify(input.citationIds),
            JSON.stringify(input.fileMetadata),
            JSON.stringify(input.renderMetadata),
            JSON.stringify(input.generationMetadata),
            JSON.stringify(input.requiredPermissions),
            input.simulated,
            input.errorCode,
            JSON.stringify(input.policyProvenance ?? DEFAULT_ASSISTANT_POLICY_PROVENANCE),
            now,
          ],
        );
        ids.push(id);
      }
      return ids;
    });
  }

  async getGeneratedArtifactByStorageReference(
    storageReference: string,
    requestedByUserId: string,
  ): Promise<GeneratedArtifactRecord | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM generated_artifacts
       WHERE storage_reference=$1 AND requested_by_user_id=$2
       ORDER BY artifact_version DESC,created_at DESC,id DESC LIMIT 1`,
      [storageReference, requestedByUserId],
    );
    return result.rows[0] ? mapGeneratedArtifact(result.rows[0]) : null;
  }

  async failGeneratedArtifactsForResponseRun(input: {
    readonly responseRunId: string;
    readonly requestedByUserId: string;
    readonly errorCode: string;
  }): Promise<readonly string[]> {
    return this.database.transaction(async (transaction) => {
      const existing = await transaction.query<{ storage_reference: string | null }>(
        `SELECT storage_reference FROM generated_artifacts
         WHERE response_run_id=$1 AND requested_by_user_id=$2
           AND status IN ('preparing','generating','ready','partial')`,
        [input.responseRunId, input.requestedByUserId],
      );
      await transaction.query(
        `UPDATE generated_artifacts
         SET status='failed',storage_reference=NULL,
             file_metadata='{}'::jsonb,error_code=$3,
             updated_at=CURRENT_TIMESTAMP,version=version+1
         WHERE response_run_id=$1 AND requested_by_user_id=$2
           AND status IN ('preparing','generating','ready','partial')`,
        [input.responseRunId, input.requestedByUserId, input.errorCode.slice(0, 200)],
      );
      return existing.rows.flatMap((row) =>
        row.storage_reference === null ? [] : [row.storage_reference],
      );
    });
  }

  async consumeRateLimit(input: {
    readonly subjectKey: string;
    readonly routeKey: string;
    readonly limit: number;
    readonly windowSeconds: number;
    readonly at?: Date;
  }): Promise<RateLimitDecision> {
    const at = input.at ?? new Date();
    const windowMs = input.windowSeconds * 1000;
    const windowStartedAt = new Date(Math.floor(at.getTime() / windowMs) * windowMs);
    const resetAt = new Date(windowStartedAt.getTime() + windowMs).toISOString();
    const result = await this.database.query<{ request_count: number }>(
      `INSERT INTO api_rate_limit_windows
       (subject_key,route_key,window_started_at,window_seconds,request_count,updated_at)
       VALUES ($1,$2,$3,$4,1,$5)
       ON CONFLICT (subject_key,route_key,window_started_at) DO UPDATE
       SET request_count=api_rate_limit_windows.request_count+1,updated_at=EXCLUDED.updated_at
       WHERE api_rate_limit_windows.request_count<$6
       RETURNING request_count`,
      [
        input.subjectKey,
        input.routeKey,
        windowStartedAt.toISOString(),
        input.windowSeconds,
        at.toISOString(),
        input.limit,
      ],
    );
    const count = Number(result.rows[0]?.request_count ?? input.limit);
    return {
      allowed: result.rowCount === 1,
      limit: input.limit,
      remaining: Math.max(0, input.limit - count),
      resetAt,
    };
  }

  async countActiveRealtimeSessionsForUser(userId: string, at = new Date()): Promise<number> {
    const cutoff = new Date(at.getTime() - PHASE21_LIMITS.realtimeSessionMaxAgeMs).toISOString();
    const result = await this.database.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count
       FROM ai_realtime_sessions
       WHERE requested_by_user_id=$1
         AND status IN ('authorized','connected')
         AND authorized_at > $2`,
      [userId, cutoff],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async recordPresentationRun(input: {
    readonly id: string;
    readonly conversationId: string;
    readonly responseRunId?: string | null;
    readonly realtimeSessionId?: string | null;
    readonly initiatingUserMessageId?: string | null;
    readonly assistantMessageId?: string | null;
    readonly visualArtifactId?: string | null;
    readonly actingUserId: string;
    readonly routeKey: string;
    readonly provider: string;
    readonly model: string;
    readonly providerResponseId?: string | null;
    readonly status: AiPresentationStatus;
    readonly query: string;
    readonly packet: JsonObject;
    readonly selectedContext?: JsonObject | null;
    readonly autoFollow?: boolean;
    readonly simulated: boolean;
    readonly liveWebSearch: boolean;
    readonly requiredPermissions: readonly string[];
    readonly usageMetadata?: JsonObject;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
    readonly startedAt: string;
    readonly completedAt?: string | null;
  }): Promise<string> {
    const now = new Date().toISOString();
    await this.database.query(
      `INSERT INTO ai_presentation_runs
       (id,conversation_id,response_run_id,realtime_session_id,initiating_user_message_id,assistant_message_id,visual_artifact_id,acting_user_id,route_key,provider,model,provider_response_id,status,query,packet,selected_context,auto_follow,simulated,live_web_search,required_permissions,usage_metadata,error_code,error_message,started_at,completed_at,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20::jsonb,$21::jsonb,$22,$23,$24,$25,$26,$26,1)`,
      [
        input.id,
        input.conversationId,
        input.responseRunId ?? null,
        input.realtimeSessionId ?? null,
        input.initiatingUserMessageId ?? null,
        input.assistantMessageId ?? null,
        input.visualArtifactId ?? null,
        input.actingUserId,
        input.routeKey,
        input.provider,
        input.model,
        input.providerResponseId ?? null,
        input.status,
        input.query.slice(0, 2_000),
        JSON.stringify(input.packet),
        input.selectedContext ? JSON.stringify(input.selectedContext) : null,
        input.autoFollow !== false,
        input.simulated,
        input.liveWebSearch,
        JSON.stringify(input.requiredPermissions),
        JSON.stringify(input.usageMetadata ?? {}),
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.startedAt,
        input.completedAt ?? null,
        now,
      ],
    );
    return input.id;
  }

  async getLatestPresentationRunForConversation(
    conversationId: string,
    actingUserId: string,
  ): Promise<AiPresentationRunRecord | null> {
    const result = await this.database.query<Row>(
      `SELECT * FROM ai_presentation_runs
       WHERE conversation_id=$1 AND acting_user_id=$2
       ORDER BY started_at DESC
       LIMIT 1`,
      [conversationId, actingUserId],
    );
    return result.rows[0] ? mapPresentationRun(result.rows[0]) : null;
  }

  async updatePresentationSelection(input: {
    readonly id: string;
    readonly actingUserId: string;
    readonly selectedContext: JsonObject | null;
    readonly autoFollow: boolean;
    readonly status?: AiPresentationStatus;
  }): Promise<AiPresentationRunRecord | null> {
    const result = await this.database.query<Row>(
      `UPDATE ai_presentation_runs
       SET selected_context=$3::jsonb,
           auto_follow=$4,
           status=COALESCE($5,status),
           updated_at=CURRENT_TIMESTAMP,
           version=version+1
       WHERE id=$1 AND acting_user_id=$2
       RETURNING *`,
      [
        input.id,
        input.actingUserId,
        input.selectedContext ? JSON.stringify(input.selectedContext) : null,
        input.autoFollow,
        input.status ?? null,
      ],
    );
    return result.rows[0] ? mapPresentationRun(result.rows[0]) : null;
  }

  async updatePresentationRunLifecycle(input: {
    readonly id: string;
    readonly actingUserId: string;
    readonly status?: AiPresentationStatus;
    readonly realtimeSessionId?: string | null;
    readonly initiatingUserMessageId?: string | null;
    readonly assistantMessageId?: string | null;
    readonly responseRunId?: string | null;
    readonly visualArtifactId?: string | null;
    readonly providerResponseId?: string | null;
    readonly lastCompletedNarrationSegmentId?: string | null;
    readonly packet?: JsonObject;
  }): Promise<AiPresentationRunRecord | null> {
    const result = await this.database.query<Row>(
      `UPDATE ai_presentation_runs
       SET status=COALESCE($3,status),
           realtime_session_id=COALESCE($4,realtime_session_id),
           initiating_user_message_id=COALESCE($5,initiating_user_message_id),
           assistant_message_id=COALESCE($6,assistant_message_id),
           response_run_id=COALESCE($7,response_run_id),
           visual_artifact_id=COALESCE($8,visual_artifact_id),
           provider_response_id=COALESCE($9,provider_response_id),
           packet=CASE
             WHEN $10::jsonb IS NULL THEN packet
             ELSE COALESCE(packet, '{}'::jsonb) || $10::jsonb
           END,
           usage_metadata=CASE
             WHEN $11::text IS NULL THEN usage_metadata
             ELSE jsonb_set(
               COALESCE(usage_metadata,'{}'::jsonb),
               '{lastCompletedNarrationSegmentId}',
               to_jsonb($11::text),
               true
             )
           END,
           updated_at=CURRENT_TIMESTAMP,
           version=version+1
       WHERE id=$1 AND acting_user_id=$2
       RETURNING *`,
      [
        input.id,
        input.actingUserId,
        input.status ?? null,
        input.realtimeSessionId ?? null,
        input.initiatingUserMessageId ?? null,
        input.assistantMessageId ?? null,
        input.responseRunId ?? null,
        input.visualArtifactId ?? null,
        input.providerResponseId ?? null,
        input.packet ? JSON.stringify(input.packet) : null,
        input.lastCompletedNarrationSegmentId ?? null,
      ],
    );
    return result.rows[0] ? mapPresentationRun(result.rows[0]) : null;
  }

  private mapResponseRun(row: Row): AiResponseRun {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      requestedByUserId: String(row.requested_by_user_id),
      requestId: String(row.request_id),
      provider: row.provider as AiProviderKey,
      model: String(row.model),
      providerResponseId: nullable(row.provider_response_id),
      status: row.status as AiResponseRun["status"],
      correlationId: String(row.correlation_id),
      errorCode: nullable(row.error_code),
      startedAt: iso(row.started_at),
      completedAt: row.completed_at ? iso(row.completed_at) : null,
      routeDecision: json(row.route_decision, null),
      policyProvenance: json<AssistantPolicyProvenance>(
        row.policy_provenance,
        DEFAULT_ASSISTANT_POLICY_PROVENANCE,
      ),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      version: Number(row.version),
    };
  }
}
