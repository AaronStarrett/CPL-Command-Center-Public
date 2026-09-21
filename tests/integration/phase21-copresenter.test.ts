import { afterEach, describe, expect, it, vi } from "vitest";

import { DEMO_PERSONAS } from "../../packages/domain/src/index.js";
import { createServerRuntime, type BeaServerRuntime } from "../../packages/database/src/index.js";
import {
  authorizeWorkspaceSelection,
  parsePresentationFromPayload,
  parseSafeWorkspaceSelection,
} from "../../packages/ai/src/index.js";
import {
  processAiCommandMessageWithRuntime,
  reserveAiCommandRequestWithRuntime,
} from "../../apps/web/lib/ai-command.js";

vi.mock("server-only", () => ({}));

const OWNER_USER_ID = DEMO_PERSONAS[0].id;
let runtime: BeaServerRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function demoRuntime() {
  runtime = await createServerRuntime({
    loadEnvFile: false,
    processEnvironment: {
      NODE_ENV: "test",
      APP_MODE: "demo",
      DATABASE_DRIVER: "pglite",
      DEMO_DATABASE_PATH: "memory://",
      DEMO_AUTH_ENABLED: "true",
      LOG_LEVEL: "silent",
      OPENAI_API_KEY: "",
    },
  });
  return runtime;
}

describe("Phase 2.1 co-presenter persistence", () => {
  it("persists one research presentation that drives the artifact and narration plan", async () => {
    const server = await demoRuntime();
    const conversation = await server.phase1.createConversation({
      ownerUserId: OWNER_USER_ID,
      title: "Phase 2.1 research",
    });
    const reservation = await reserveAiCommandRequestWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
    });
    const snapshot = await processAiCommandMessageWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
      message: "Research the latest information relevant to water penetration testing",
      ...reservation,
      correlationId: "phase21-research",
    });
    const packet = parsePresentationFromPayload(snapshot.artifact.payload);
    expect(packet).not.toBeNull();
    expect(packet?.presentationRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(packet?.narrationSegments.length).toBeGreaterThan(3);
    expect(
      packet?.sources.map((source) => source.url).every((url) => url.startsWith("https://")),
    ).toBe(true);
    expect(snapshot.artifact.payload).toMatchObject({
      presentation: expect.objectContaining({ presentationRunId: packet?.presentationRunId }),
    });
    const stored = await server.ai.persistence.getLatestPresentationRunForConversation(
      conversation.id,
      OWNER_USER_ID,
    );
    expect(stored?.id).toBe(packet?.presentationRunId);
    expect(stored?.liveWebSearch).toBe(false);
    expect(stored?.simulated).toBe(true);
    expect(JSON.stringify(stored)).not.toMatch(/(?:sk-[A-Za-z0-9]{10,}|ek_[A-Za-z0-9]{10,})/u);
    const storedPacket = parsePresentationFromPayload(stored?.packet);
    expect(storedPacket?.sources.some((source) => source.id === "source-2")).toBe(true);
    expect(
      authorizeWorkspaceSelection({
        latest: storedPacket,
        selection: parseSafeWorkspaceSelection({
          presentationRunId: stored!.id,
          artifactId: snapshot.artifact.id,
          kind: "source",
          elementId: "source-2",
        }),
        conversationOwnerUserId: OWNER_USER_ID,
        actingUserId: OWNER_USER_ID,
        permissionsAllowed: true,
        runVisualArtifactId: stored?.visualArtifactId,
      }).ok,
    ).toBe(true);
    await server.ai.persistence.updatePresentationRunLifecycle({
      id: stored!.id,
      actingUserId: OWNER_USER_ID,
      status: "narrating",
      packet: { status: "narrating" },
    });
    const narrating = await server.ai.persistence.getLatestPresentationRunForConversation(
      conversation.id,
      OWNER_USER_ID,
    );
    const narratingPacket = parsePresentationFromPayload(narrating?.packet);
    expect(narratingPacket?.status).toBe("narrating");
    expect(narratingPacket?.sources.some((source) => source.id === "source-2")).toBe(true);
    expect(
      authorizeWorkspaceSelection({
        latest: narratingPacket,
        selection: parseSafeWorkspaceSelection({
          presentationRunId: stored!.id,
          artifactId: snapshot.artifact.id,
          kind: "source",
          elementId: "source-2",
        }),
        conversationOwnerUserId: OWNER_USER_ID,
        actingUserId: OWNER_USER_ID,
        permissionsAllowed: true,
        runVisualArtifactId: narrating?.visualArtifactId,
      }).ok,
    ).toBe(true);
  });

  it("answers a selected-source follow-up without replacing the presentation run", async () => {
    const server = await demoRuntime();
    const conversation = await server.phase1.createConversation({
      ownerUserId: OWNER_USER_ID,
      title: "Phase 2.1 source follow-up",
    });
    const first = await reserveAiCommandRequestWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
    });
    const research = await processAiCommandMessageWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
      message: "Research the latest information relevant to water penetration testing",
      ...first,
      correlationId: "phase21-research-first",
    });
    const packet = parsePresentationFromPayload(research.artifact.payload);
    expect(packet).not.toBeNull();
    const follow = await reserveAiCommandRequestWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
    });
    const answered = await processAiCommandMessageWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
      message: "What does this source mean for us?",
      ...follow,
      correlationId: "phase21-source-follow-up",
      workspaceSelection: {
        presentationRunId: packet!.presentationRunId,
        artifactId: research.artifact.id,
        kind: "source",
        elementId: "source-2",
      },
    });
    expect(answered.messages.at(-1)?.content).toMatch(/Source 2/u);
    expect(answered.messages.at(-1)?.content).toMatch(/AAMA/u);
    const followPacket = parsePresentationFromPayload(answered.artifact.payload);
    expect(followPacket?.presentationRunId).toBe(packet?.presentationRunId);
    expect(followPacket?.selected?.elementId).toBe("source-2");
    expect(answered.messages.at(-1)?.content).not.toMatch(/^\s*source-2\s*$/u);
  });

  it("narrates authorized blocked leads without calling them live business data", async () => {
    const server = await demoRuntime();
    const conversation = await server.phase1.createConversation({
      ownerUserId: OWNER_USER_ID,
      title: "Phase 2.1 leads",
    });
    const reservation = await reserveAiCommandRequestWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
    });
    const snapshot = await processAiCommandMessageWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
      message: "Show me the leads that still need information",
      ...reservation,
      correlationId: "phase21-leads",
    });
    expect(snapshot.artifact.type).toBe("lead-list");
    expect(snapshot.artifact.subtitle).toMatch(/not live business data/u);
    const packet = parsePresentationFromPayload(snapshot.artifact.payload);
    expect(packet?.routeKey).toBe("record_retrieval");
    expect(packet?.liveWebSearch).toBe(false);
    const follow = await reserveAiCommandRequestWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
    });
    const firstLeadId = String(
      (snapshot.artifact.payload as { items?: { id?: string }[] }).items?.[0]?.id ?? "",
    );
    expect(firstLeadId).toMatch(/^[0-9a-f-]{36}$/u);
    const explained = await processAiCommandMessageWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
      message: "Explain this one.",
      ...follow,
      correlationId: "phase21-lead-follow-up",
      workspaceSelection: {
        presentationRunId: packet!.presentationRunId,
        artifactId: snapshot.artifact.id,
        kind: "lead",
        elementId: `lead-${firstLeadId}`,
        recordType: "lead",
        recordId: firstLeadId,
      },
    });
    expect(explained.messages.at(-1)?.content.length).toBeGreaterThan(20);
    expect(explained.artifact.subtitle).not.toMatch(/LIVE WEB RESEARCH/u);
    expect(explained.artifact.type).toBe("lead-list");
  });

  it("keeps the presentation run after an interrupted follow-up and counts Realtime sessions", async () => {
    const server = await demoRuntime();
    const conversation = await server.phase1.createConversation({
      ownerUserId: OWNER_USER_ID,
      title: "Phase 2.1 interruption",
    });
    const reservation = await reserveAiCommandRequestWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
    });
    const research = await processAiCommandMessageWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
      message: "Research the latest information relevant to water penetration testing",
      ...reservation,
      correlationId: "phase21-interrupt-research",
    });
    const packet = parsePresentationFromPayload(research.artifact.payload);
    expect(packet).not.toBeNull();
    await server.ai.persistence.updatePresentationSelection({
      id: packet!.presentationRunId,
      actingUserId: OWNER_USER_ID,
      selectedContext: {
        presentationRunId: packet!.presentationRunId,
        artifactId: research.artifact.id,
        kind: "source",
        elementId: "source-1",
      },
      autoFollow: false,
      status: "interrupted",
    });
    const stored = await server.ai.persistence.getLatestPresentationRunForConversation(
      conversation.id,
      OWNER_USER_ID,
    );
    expect(stored?.id).toBe(packet?.presentationRunId);
    expect(stored?.status).toBe("interrupted");
    expect(stored?.autoFollow).toBe(false);
    expect(await server.ai.persistence.countActiveRealtimeSessionsForUser(OWNER_USER_ID)).toBe(0);
  });

  it("rejects a forged source selection and does not count expired Realtime sessions as active", async () => {
    const server = await demoRuntime();
    const conversation = await server.phase1.createConversation({
      ownerUserId: OWNER_USER_ID,
      title: "Phase 2.1 selection denial",
    });
    const reservation = await reserveAiCommandRequestWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
    });
    const research = await processAiCommandMessageWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
      message: "Research the latest information relevant to water penetration testing",
      ...reservation,
      correlationId: "phase21-forged-selection",
    });
    const packet = parsePresentationFromPayload(research.artifact.payload);
    const follow = await reserveAiCommandRequestWithRuntime(server, {
      userId: OWNER_USER_ID,
      conversationId: conversation.id,
    });
    await expect(
      processAiCommandMessageWithRuntime(server, {
        userId: OWNER_USER_ID,
        conversationId: conversation.id,
        message: "What does this source mean for us?",
        ...follow,
        correlationId: "phase21-forged-follow-up",
        workspaceSelection: {
          presentationRunId: packet!.presentationRunId,
          artifactId: research.artifact.id,
          kind: "source",
          elementId: "source-invented",
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const expiredAuthorizedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    await server.ai.persistence.recordRealtimeSession({
      conversationId: conversation.id,
      requestedByUserId: OWNER_USER_ID,
      provider: "openai",
      providerSessionId: null,
      model: "gpt-realtime-test",
      voice: "coral",
      status: "connected",
      correlationId: "phase21-expired-session",
      authorizedAt: expiredAuthorizedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      completedAt: null,
      errorCode: null,
      simulated: false,
    });
    expect(await server.ai.persistence.countActiveRealtimeSessionsForUser(OWNER_USER_ID)).toBe(0);
    const currentAuthorizedAt = new Date().toISOString();
    await server.ai.persistence.recordRealtimeSession({
      conversationId: conversation.id,
      requestedByUserId: OWNER_USER_ID,
      provider: "openai",
      providerSessionId: null,
      model: "gpt-realtime-test",
      voice: "coral",
      status: "connected",
      correlationId: "phase21-active-session",
      authorizedAt: currentAuthorizedAt,
      expiresAt: new Date(Date.parse(currentAuthorizedAt) + 30_000).toISOString(),
      completedAt: null,
      errorCode: null,
      simulated: false,
    });
    expect(await server.ai.persistence.countActiveRealtimeSessionsForUser(OWNER_USER_ID)).toBe(1);
  });
});
