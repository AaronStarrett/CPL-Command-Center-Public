import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEMO_PERSONAS } from "../../packages/domain/src/index.js";
import {
  AI_PROVIDER_SETTINGS_KEY,
  createServerRuntime,
  type BeaServerRuntime,
} from "../../packages/database/src/index.js";
import { generateExecutivePdfArtifact } from "../../apps/web/lib/executive-artifact.js";

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
  const current = await runtime.ai.persistence.getProviderSettings();
  await runtime.settings.set({
    key: AI_PROVIDER_SETTINGS_KEY,
    value: { ...current, pdfGenerationAllowed: true, mode: current.mode },
    actorUserId: OWNER_USER_ID,
    correlationId: "phase22-pdf",
  });
  return runtime;
}

// Fresh database migration and demo seeding are fixture setup, separate from the PDF assertions.
beforeEach(async () => {
  await demoRuntime();
}, 60_000);

describe("Phase 2.2 executive PDF persistence", () => {
  it("renders, stores, versions, and audits an application-owned PDF", async () => {
    const server = runtime;
    if (!server) throw new Error("The executive PDF fixture was not initialized.");
    const conversation = await server.phase1.createConversation({
      ownerUserId: OWNER_USER_ID,
      title: "Phase 2.2 briefing",
    });
    const first = await generateExecutivePdfArtifact({
      runtime: server,
      userId: OWNER_USER_ID,
      correlationId: "phase22-pdf-1",
      request: {
        conversationId: conversation.id,
        title: "Northstar executive briefing",
        template: "executive_briefing",
        provider: "openai",
        model: "fixture-text",
      },
    });
    expect(first.specification.reviewStatus).toBe("draft_human_review_required");
    expect(first.filename).toMatch(/^BEA-Executive-Briefing-Northstar-executive-briefing-/u);
    expect(first.workspacePayload.renderer).toBe("pdf");
    expect(JSON.stringify(first)).not.toMatch(/sk-[A-Za-z0-9]{10,}/u);

    const second = await generateExecutivePdfArtifact({
      runtime: server,
      userId: OWNER_USER_ID,
      correlationId: "phase22-pdf-2",
      request: {
        conversationId: conversation.id,
        parentArtifactId: first.artifactId,
        instructions: "Make this more concise.",
        outputLength: "concise",
        provider: "openai",
        model: "fixture-text",
      },
    });
    expect(second.specification.version).toBe(2);
    expect(second.specification.parentVersion).toBe(1);
    expect(second.storageId).not.toBe(first.storageId);

    const rows = await server.database.query<{ artifact_version: number; title: string }>(
      `SELECT artifact_version, title FROM generated_artifacts
       WHERE conversation_id=$1 AND kind='pdf' ORDER BY artifact_version`,
      [conversation.id],
    );
    expect(rows.rows.map((row) => Number(row.artifact_version))).toEqual([1, 2]);
    const audit = await server.repository.listAuditLogs();
    expect(audit.some((event) => event.eventType === "artifact.created")).toBe(true);
    expect(audit.some((event) => event.eventType === "artifact.revised")).toBe(true);
  });
});
