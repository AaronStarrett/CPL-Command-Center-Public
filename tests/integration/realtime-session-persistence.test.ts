import { afterEach, describe, expect, it } from "vitest";

import {
  migrateDatabase,
  PGliteDatabaseAdapter,
  seedDatabase,
  SqlAiProviderRepository,
} from "../../packages/database/src/index.js";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "95000000-0000-4000-8000-000000000001";
const POLICY_PROVENANCE = {
  personaPromptVersion: "bea-executive-business-partner-v1",
  assistantRoleVersion: "bea-role-assistant-v1",
  executiveProfileVersion: "andrew-executive-profile-v1",
  artifactBrandPolicyVersion: "bea-artifact-brand-v1",
  artifactTemplateVersion: "bea-artifact-template-v1",
} as const;
const ROUTE_DECISION = {
  profileVersion: "phase1.3.3-v1",
  routeKey: "realtime_voice",
  selectedModel: "gpt-realtime-test",
  primaryModel: "gpt-realtime-test",
  fallbackModel: "gpt-realtime-fallback",
  usedFallback: false,
  fallbackReason: null,
  requiredCapabilities: ["realtime", "audioInput", "audioOutput"],
  reasoningEffort: "none",
  toolAllowlist: ["bea_query_records", "bea_preview_task"],
  decidedAt: "2026-08-23T12:00:00.000Z",
} as const;

let database: PGliteDatabaseAdapter | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe("Phase 1.3 Realtime persistence", () => {
  it("isolates session ownership and persists an idempotent lifecycle with bounded usage metadata", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    const repository = new SqlAiProviderRepository(database);
    const authorizedAt = new Date().toISOString();
    const sessionId = await repository.recordRealtimeSession({
      conversationId: CONVERSATION_ID,
      requestedByUserId: OWNER_ID,
      provider: "openai",
      providerSessionId: null,
      model: "gpt-realtime-test",
      voice: "coral",
      status: "authorized",
      correlationId: "realtime-persistence-fixture",
      authorizedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      completedAt: null,
      errorCode: null,
      simulated: false,
      policyProvenance: POLICY_PROVENANCE,
      routeDecision: ROUTE_DECISION,
    });

    await expect(
      repository.getRealtimeSessionForUser(sessionId, OTHER_USER_ID),
    ).resolves.toBeNull();
    const connected = await repository.transitionRealtimeSession({
      id: sessionId,
      requestedByUserId: OWNER_ID,
      status: "connected",
      providerSessionId: "sess_realtime_test",
    });
    expect(connected).toMatchObject({
      id: sessionId,
      conversationId: CONVERSATION_ID,
      requestedByUserId: OWNER_ID,
      provider: "openai",
      providerSessionId: "sess_realtime_test",
      status: "connected",
      simulated: false,
      policyProvenance: POLICY_PROVENANCE,
      routeDecision: ROUTE_DECISION,
    });

    const connectedAgain = await repository.transitionRealtimeSession({
      id: sessionId,
      requestedByUserId: OWNER_ID,
      status: "connected",
      providerSessionId: "sess_realtime_test",
    });
    expect(connectedAgain?.version).toBe(connected?.version);

    const usageId = await repository.recordUsage({
      responseRunId: null,
      realtimeSessionId: sessionId,
      requestedByUserId: OWNER_ID,
      provider: "openai",
      model: "gpt-realtime-test",
      operation: "realtime.voice",
      inputTokens: 12,
      outputTokens: 7,
      reasoningTokens: 1,
      cachedInputTokens: 2,
      audioInputTokens: 5,
      audioOutputTokens: 4,
      realtimeDurationSeconds: 9,
      estimatedCostUsd: null,
      costStatus: "unavailable",
      simulated: false,
      recordedAt: new Date().toISOString(),
    });

    const completed = await repository.transitionRealtimeSession({
      id: sessionId,
      requestedByUserId: OWNER_ID,
      status: "completed",
    });
    expect(completed).toMatchObject({
      id: sessionId,
      status: "completed",
      errorCode: null,
    });
    expect(completed?.completedAt).not.toBeNull();
    const completedAgain = await repository.transitionRealtimeSession({
      id: sessionId,
      requestedByUserId: OWNER_ID,
      status: "completed",
    });
    expect(completedAgain?.version).toBe(completed?.version);
    await expect(
      repository.transitionRealtimeSession({
        id: sessionId,
        requestedByUserId: OWNER_ID,
        status: "failed",
        errorCode: "LATE_FAILURE",
      }),
    ).resolves.toBeNull();

    await expect(
      database.query<{
        id: string;
        realtime_session_id: string;
        audio_input_tokens: number;
        audio_output_tokens: number;
        realtime_duration_seconds: number;
        estimated_cost_usd: string | null;
        cost_status: string;
        simulated: boolean;
      }>(
        `SELECT id::text,realtime_session_id::text,audio_input_tokens,audio_output_tokens,
                realtime_duration_seconds,estimated_cost_usd,cost_status,simulated
         FROM ai_usage_records WHERE id=$1`,
        [usageId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          id: usageId,
          realtime_session_id: sessionId,
          audio_input_tokens: 5,
          audio_output_tokens: 4,
          realtime_duration_seconds: 9,
          estimated_cost_usd: null,
          cost_status: "unavailable",
          simulated: false,
        },
      ],
    });
  });
});
