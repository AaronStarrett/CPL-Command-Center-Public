import "server-only";

import { spawnSync } from "node:child_process";

import type { BeaServerRuntime } from "@bea/database";
import {
  OWNER_ACCEPTANCE_APPLICATION_VERSION,
  OWNER_ACCEPTANCE_AUDIT_ACTION,
  OWNER_ACCEPTANCE_AUDIT_EVENT,
  OWNER_ACCEPTANCE_CONTRACT_VERSION,
  OWNER_ACCEPTANCE_PHYSICAL_OBSERVATION_IDS,
  OWNER_ACCEPTANCE_PHYSICAL_OBSERVATIONS,
  OWNER_ACCEPTANCE_TECHNICAL_EVIDENCE_IDS,
  OWNER_ACCEPTANCE_TECHNICAL_EVIDENCE_LABELS,
  canConfirmPhysicalObservation,
  isOwnerAcceptancePhysicalObservationId,
  ownerLiveTechnicalStatus,
  type OwnerTechnicalEvidenceStatus,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";

import type { AuthSession } from "./auth/session-store";
import { OpenAiAdministrationError, readOpenAiAdministration } from "./openai-administration";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isCi(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CI === "true";
}

function count(value: string | number | undefined): number {
  return Number(value ?? 0);
}

async function queryCount(
  runtime: BeaServerRuntime,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<number> {
  const result = await runtime.database.query<{ count: string | number }>(sql, parameters);
  return count(result.rows[0]?.count);
}

function readGitSha(runtime: BeaServerRuntime): string {
  const fromEnv = process.env.BEA_GIT_SHA || process.env.GITHUB_SHA;
  if (fromEnv && /^[0-9a-f]{7,40}$/iu.test(fromEnv)) return fromEnv;
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${runtime.repositoryRoot.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: runtime.repositoryRoot, encoding: "utf8", windowsHide: true },
  );
  const sha = String(result.stdout ?? "").trim();
  return result.status === 0 && /^[0-9a-f]{7,40}$/iu.test(sha) ? sha : "unknown";
}

function confirmableEnvironment(runtime: BeaServerRuntime, session: AuthSession) {
  return canConfirmPhysicalObservation({
    authProvider: session.provider,
    appMode: runtime.environment.appMode,
    runtimeMode: runtime.environment.runtimeMode,
    deploymentProfile: runtime.environment.deploymentProfile,
    ci: isCi(),
  });
}

async function technicalEvidence(
  runtime: BeaServerRuntime,
  administration: Awaited<ReturnType<typeof readOpenAiAdministration>>,
  confirmable: boolean,
): Promise<
  Record<
    (typeof OWNER_ACCEPTANCE_TECHNICAL_EVIDENCE_IDS)[number],
    {
      readonly serverEvidence: OwnerTechnicalEvidenceStatus;
      readonly ownerLiveStatus: OwnerTechnicalEvidenceStatus;
    }
  >
> {
  const models = await queryCount(runtime, "SELECT COUNT(*) AS count FROM ai_model_cache");
  const executiveRuns = await queryCount(
    runtime,
    `SELECT COUNT(*) AS count FROM ai_response_runs
     WHERE provider='openai' AND status IN ('completed','completed_with_warnings')`,
  );
  const webSearch = await queryCount(
    runtime,
    `SELECT COUNT(*) AS count FROM ai_tool_calls
     WHERE name IN ('web_search','search_web') AND status='completed'`,
  );
  const citations = await queryCount(
    runtime,
    "SELECT COUNT(*) AS count FROM ai_message_citations WHERE simulated=FALSE",
  );
  const realtime = await queryCount(
    runtime,
    "SELECT COUNT(*) AS count FROM ai_realtime_sessions WHERE provider='openai' AND simulated=FALSE",
  );
  const transcripts = await queryCount(runtime, "SELECT COUNT(*) AS count FROM assistant_messages");
  const usage = await queryCount(
    runtime,
    "SELECT COUNT(*) AS count FROM ai_usage_records WHERE simulated=FALSE",
  );
  const disconnected = await queryCount(
    runtime,
    `SELECT COUNT(*) AS count FROM audit_logs
     WHERE event_type IN ('ai-provider.disconnected','openai.disconnect')`,
  );
  const routeReady = Object.values(administration.routingProfile.routes).some(
    (route) => route.enabled && Boolean(route.primaryModel),
  );
  const failClosed =
    administration.connectionStatus === "disabled" ||
    administration.connectionStatus === "not_configured" ||
    administration.providerStatus === "DISABLED";

  const raw = {
    openai_key_configured:
      administration.apiKeyStatus === "configured" ? "EVIDENCE_RECORDED" : "NOT_RUN",
    connection_test:
      administration.lastSuccessfulTest?.authenticated === true ? "EVIDENCE_RECORDED" : "NOT_RUN",
    model_discovery: models > 0 ? "EVIDENCE_RECORDED" : "NOT_RUN",
    route_compatibility: routeReady ? "EVIDENCE_RECORDED" : "NOT_RUN",
    executive_text_request: executiveRuns > 0 ? "EVIDENCE_RECORDED" : "NOT_RUN",
    web_search_execution: webSearch > 0 ? "EVIDENCE_RECORDED" : "NOT_RUN",
    citation_presence: citations > 0 ? "EVIDENCE_RECORDED" : "NOT_RUN",
    realtime_connection: realtime > 0 ? "EVIDENCE_RECORDED" : "NOT_RUN",
    transcript_persistence: transcripts > 0 ? "EVIDENCE_RECORDED" : "NOT_RUN",
    usage_persistence: usage > 0 ? "EVIDENCE_RECORDED" : "NOT_RUN",
    provider_deactivation: disconnected > 0 ? "EVIDENCE_RECORDED" : "NOT_RUN",
    fail_closed_behavior: failClosed ? "EVIDENCE_RECORDED" : "NOT_RUN",
  } as const;

  return Object.fromEntries(
    OWNER_ACCEPTANCE_TECHNICAL_EVIDENCE_IDS.map((id) => [
      id,
      {
        serverEvidence: raw[id],
        ownerLiveStatus: ownerLiveTechnicalStatus({
          confirmableEnvironment: confirmable,
          evidenceStatus: raw[id],
        }),
      },
    ]),
  ) as Record<
    (typeof OWNER_ACCEPTANCE_TECHNICAL_EVIDENCE_IDS)[number],
    {
      readonly serverEvidence: OwnerTechnicalEvidenceStatus;
      readonly ownerLiveStatus: OwnerTechnicalEvidenceStatus;
    }
  >;
}

export async function readOwnerLiveAcceptance(runtime: BeaServerRuntime, session: AuthSession) {
  const decision = await runtime.authorization.authorizeUser(
    session.personaId,
    PERMISSIONS.SETTINGS_MANAGE,
  );
  if (!decision.allowed) {
    throw new OpenAiAdministrationError(
      "OWNER_ACCEPTANCE_FORBIDDEN",
      403,
      "Owner Live Acceptance is restricted to Integration Administrators and Owners.",
    );
  }
  const confirmationPolicy = confirmableEnvironment(runtime, session);
  const administration = await readOpenAiAdministration(runtime, session.personaId);
  const evidence = await technicalEvidence(runtime, administration, confirmationPolicy.allowed);
  const confirmations = await runtime.database.query<{
    resource_id: string;
    created_at: string;
    actor_user_id: string | null;
    metadata: unknown;
  }>(
    `SELECT resource_id, created_at, actor_user_id, metadata
     FROM audit_logs
     WHERE event_type=$1 AND action=$2 AND outcome='succeeded'
     ORDER BY created_at DESC, id DESC`,
    [OWNER_ACCEPTANCE_AUDIT_EVENT, OWNER_ACCEPTANCE_AUDIT_ACTION],
  );
  const latest = new Map<string, (typeof confirmations.rows)[number]>();
  for (const row of confirmations.rows) {
    if (!latest.has(row.resource_id)) latest.set(row.resource_id, row);
  }

  return {
    contractVersion: OWNER_ACCEPTANCE_CONTRACT_VERSION,
    applicationVersion: OWNER_ACCEPTANCE_APPLICATION_VERSION,
    gitSha: readGitSha(runtime),
    ownerLiveStatus: "NOT_RUN" as const,
    physicalConfirmable: confirmationPolicy.allowed,
    physicalConfirmationReason: confirmationPolicy.reason,
    provider: administration.settings.mode,
    selectedModel: administration.settings.defaultTextModel,
    realtimeModel: administration.settings.defaultRealtimeModel,
    connectionStatus: administration.connectionStatus,
    providerStatus: administration.providerStatus,
    apiKeyFingerprint: administration.apiKeyFingerprint,
    lastTestLatencyMs: administration.lastSuccessfulTest?.latencyMs ?? null,
    syntheticDataDisclosure:
      "Records in this runtime are synthetic BEA demonstration data until Owner's real systems are separately authorized.",
    externalIntegrations: "NOT CONNECTED",
    technicalEvidence: OWNER_ACCEPTANCE_TECHNICAL_EVIDENCE_IDS.map((id) => ({
      id,
      label: OWNER_ACCEPTANCE_TECHNICAL_EVIDENCE_LABELS[id],
      serverEvidence: evidence[id].serverEvidence,
      ownerLiveStatus: evidence[id].ownerLiveStatus,
    })),
    physicalObservations: OWNER_ACCEPTANCE_PHYSICAL_OBSERVATION_IDS.map((id) => {
      const recorded = latest.get(id);
      return {
        id,
        label: OWNER_ACCEPTANCE_PHYSICAL_OBSERVATIONS[id],
        status: recorded ? ("CONFIRMED" as const) : ("NOT_RUN" as const),
        confirmedAt: recorded?.created_at ?? null,
        actorUserId: recorded?.actor_user_id ?? null,
      };
    }),
    chargeableCallWarning:
      "This page does not call OpenAI when it loads. Test connection, Refresh models, Activate OpenAI, Start live voice, and sending a message are explicit owner actions and may use project quota.",
  };
}

export async function confirmOwnerPhysicalObservation(input: {
  readonly runtime: BeaServerRuntime;
  readonly session: AuthSession;
  readonly correlationId: string;
  readonly observationId: unknown;
  readonly confirmed: unknown;
  readonly presentationRunId?: unknown;
}) {
  if (!isOwnerAcceptancePhysicalObservationId(input.observationId)) {
    throw new OpenAiAdministrationError(
      "OWNER_ACCEPTANCE_UNKNOWN_OBSERVATION",
      400,
      "Unknown physical observation.",
    );
  }
  if (input.confirmed !== true) {
    throw new OpenAiAdministrationError(
      "OWNER_ACCEPTANCE_CONFIRMATION_REQUIRED",
      400,
      "Physical observations are recorded only after an explicit owner confirmation.",
    );
  }
  if (
    input.presentationRunId !== undefined &&
    input.presentationRunId !== null &&
    (typeof input.presentationRunId !== "string" || !uuidPattern.test(input.presentationRunId))
  ) {
    throw new OpenAiAdministrationError(
      "OWNER_ACCEPTANCE_INVALID_PRESENTATION",
      400,
      "presentationRunId must be a UUID when supplied.",
    );
  }
  const policy = confirmableEnvironment(input.runtime, input.session);
  if (!policy.allowed) {
    throw new OpenAiAdministrationError("OWNER_ACCEPTANCE_NOT_CONFIRMABLE", 403, policy.reason);
  }
  const administration = await readOpenAiAdministration(input.runtime, input.session.personaId);
  const gitSha = readGitSha(input.runtime);
  await input.runtime.repository.record({
    eventType: OWNER_ACCEPTANCE_AUDIT_EVENT,
    action: OWNER_ACCEPTANCE_AUDIT_ACTION,
    outcome: "succeeded",
    actorUserId: input.session.personaId,
    resourceType: "owner-acceptance",
    resourceId: input.observationId,
    correlationId: input.correlationId,
    metadata: {
      observationId: input.observationId,
      confirmationResult: "confirmed",
      applicationVersion: OWNER_ACCEPTANCE_APPLICATION_VERSION,
      gitSha,
      provider: administration.settings.mode,
      selectedModel: administration.settings.defaultTextModel,
      realtimeModel: administration.settings.defaultRealtimeModel,
      presentationRunId:
        typeof input.presentationRunId === "string" ? input.presentationRunId : null,
    },
  });
  return readOwnerLiveAcceptance(input.runtime, input.session);
}

export type OwnerLiveAcceptanceView = Awaited<ReturnType<typeof readOwnerLiveAcceptance>>;
export { OWNER_ACCEPTANCE_PHYSICAL_OBSERVATIONS };
