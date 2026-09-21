import { afterEach, describe, expect, it } from "vitest";

import {
  migrateDatabase,
  PGliteDatabaseAdapter,
  seedDatabase,
  SqlAiProviderRepository,
} from "../../packages/database/src/index.js";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "95000000-0000-4000-8000-000000000001";
const provenance = {
  personaPromptVersion: "bea-executive-business-partner-v1",
  executiveProfileVersion: "andrew-executive-profile-v1",
  brandPolicyVersion: "bea-artifact-brand-v1",
  artifactTemplateVersion: "bea-artifact-template-v1",
} as const;

let database: PGliteDatabaseAdapter | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe("Phase 1.3.1 policy provenance persistence", () => {
  it("records policy versions with Responses, Realtime, and generated artifacts", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    const repository = new SqlAiProviderRepository(database);
    const responseRun = await repository.beginResponseRun({
      conversationId: CONVERSATION_ID,
      requestedByUserId: OWNER_ID,
      requestId: "phase131-response",
      provider: "demo",
      model: "deterministic-demo-router",
      correlationId: "phase131-response",
      policyProvenance: provenance,
    });
    expect(responseRun.policyProvenance).toEqual(provenance);

    const now = new Date().toISOString();
    const realtimeId = await repository.recordRealtimeSession({
      conversationId: CONVERSATION_ID,
      requestedByUserId: OWNER_ID,
      provider: "demo",
      providerSessionId: "demo-phase131",
      model: "deterministic-demo-router",
      voice: "demo",
      status: "authorized",
      correlationId: "phase131-realtime",
      authorizedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      completedAt: null,
      errorCode: null,
      simulated: true,
      policyProvenance: provenance,
    });
    await expect(repository.getRealtimeSessionForUser(realtimeId, OWNER_ID)).resolves.toMatchObject(
      {
        conversationId: CONVERSATION_ID,
        policyProvenance: provenance,
      },
    );

    await repository.recordGeneratedArtifact({
      conversationId: CONVERSATION_ID,
      responseRunId: responseRun.id,
      requestedByUserId: OWNER_ID,
      kind: "research_report",
      title: "Synthetic BEA executive brief",
      status: "ready",
      artifactVersion: 1,
      provider: "demo",
      providerItemId: null,
      providerContainerId: null,
      providerFileId: null,
      filename: null,
      mediaType: null,
      storageReference: "phase131-policy-provenance",
      specification: { renderer: "research" },
      sourceMetadata: { dataStatus: "synthetic" },
      citationIds: [],
      fileMetadata: {},
      renderMetadata: { brandPolicyVersion: provenance.brandPolicyVersion },
      generationMetadata: { promptVersion: provenance.personaPromptVersion },
      requiredPermissions: ["ai-command.view"],
      simulated: true,
      errorCode: null,
      policyProvenance: provenance,
    });
    await expect(
      repository.getGeneratedArtifactByStorageReference("phase131-policy-provenance", OWNER_ID),
    ).resolves.toMatchObject({ policyProvenance: provenance });
  });
});
