import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEMO_PERSONAS,
  DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY,
  EXECUTIVE_TEAM_WORKFLOW_GOAL,
  SEEDED_DIGITAL_WORKFORCE_IDS,
} from "../../packages/domain/src/index.js";
import { AccessDeniedError, PERMISSIONS } from "../../packages/security/src/index.js";
import {
  createServerRuntime,
  executeDigitalWorkforceRun,
  type BeaServerRuntime,
  type DigitalWorkforceExecutorAdapters,
} from "../../packages/database/src/index.js";
import { startDigitalWorkforceRun } from "../../apps/web/lib/digital-workforce-runtime.js";

vi.mock("server-only", () => ({}));

const OWNER_USER_ID = DEMO_PERSONAS[0].id;
const ids = SEEDED_DIGITAL_WORKFORCE_IDS;
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

function demoAdapters(
  overrides: Partial<DigitalWorkforceExecutorAdapters> = {},
): DigitalWorkforceExecutorAdapters {
  return {
    liveEnabled: false,
    demoFallbackAllowed: true,
    resolveModel: async ({ profile }) => ({
      model: `deterministic:${profile}`,
      fallbackUsed: null,
      provider: "deterministic",
    }),
    generatePdf: async (input) => ({
      artifactId: randomUUID(),
      title: input.title,
    }),
    ...overrides,
  };
}

async function queueExecutiveRun(server: BeaServerRuntime, idempotencyKey: string) {
  const agent = await server.digitalWorkforce.getAgent(ids.agents.andrewExecutive);
  if (!agent?.currentPublishedVersionId) {
    throw new Error("Seeded executive Digital Agent is missing.");
  }
  const run = await server.digitalWorkforce.createRun({
    initiatingUserId: OWNER_USER_ID,
    rootAgentId: agent.id,
    rootAgentVersionId: agent.currentPublishedVersionId,
    goal: EXECUTIVE_TEAM_WORKFLOW_GOAL,
    normalizedRequest: EXECUTIVE_TEAM_WORKFLOW_GOAL,
    idempotencyKey,
    correlationId: `phase23-${idempotencyKey}`,
  });
  if (run.status === "draft") {
    await server.digitalWorkforce.transitionRun({ runId: run.id, to: "validating" });
    await server.digitalWorkforce.transitionRun({ runId: run.id, to: "queued" });
  }
  return run;
}

describe("Phase 2.3 Digital Workforce persistence and execution", () => {
  it("migrates 0014, seeds twelve labeled Digital Agents, and keeps File Search disconnected", async () => {
    const server = await demoRuntime();
    const applied = await server.database.query<{ id: string }>(
      "SELECT id FROM bea_schema_migrations ORDER BY id",
    );
    expect(applied.rows.at(-1)?.id).toBe("0025_cpl_tenant_foundation.sql");
    const organization = await server.digitalWorkforce.listOrganization();
    expect(organization).toHaveLength(12);
    expect(organization.every((node) => node.digitalAgentLabel === "Digital Agent")).toBe(true);
    const scheduling = organization.find((node) => node.agentId === ids.agents.scheduling);
    expect(scheduling?.status).toBe("paused");
    const knowledge = await server.digitalWorkforce.getPublishedVersion(ids.agents.beaKnowledge);
    expect(
      knowledge?.knowledgeScopes.some(
        (scope) =>
          scope.scope === "organizational-file-search" && scope.connectionState === "not-connected",
      ),
    ).toBe(true);
    expect(JSON.stringify(organization)).not.toMatch(/sk-[A-Za-z0-9]{10,}/u);
  });

  it("executes the canonical executive-team workflow with parallel discovery and a PDF", async () => {
    const server = await demoRuntime();
    const queued = await queueExecutiveRun(server, "executive-team-demo");
    const finished = await executeDigitalWorkforceRun({
      workforce: server.digitalWorkforce,
      leads: server.leads,
      runId: queued.id,
      adapters: demoAdapters(),
    });
    expect(["completed", "partially_completed"]).toContain(finished.status);
    const steps = await server.digitalWorkforce.listSteps(finished.id);
    expect(steps.map((step) => step.stepKey)).toEqual(
      expect.arrayContaining([
        "lead-review",
        "public-research",
        "executive-document",
        "executive-synthesis",
      ]),
    );
    const lead = steps.find((step) => step.stepKey === "lead-review");
    const research = steps.find((step) => step.stepKey === "public-research");
    expect(lead?.parallelGroup).toBe("discovery");
    expect(research?.parallelGroup).toBe("discovery");
    expect(lead?.model).toMatch(/^deterministic:/u);
    expect(finished.outputArtifactIds.length).toBeGreaterThan(0);
    const handoffs = await server.digitalWorkforce.listHandoffs(finished.id);
    expect(handoffs.length).toBeGreaterThan(0);
    expect(handoffs.every((handoff) => handoff.packet.boundedContextSummary.length <= 2000)).toBe(
      true,
    );
    const events = await server.digitalWorkforce.listEvents(finished.id, 200);
    expect(
      events.some((event) =>
        /assigned the lead review and public research in parallel/iu.test(event.narration ?? ""),
      ),
    ).toBe(true);
    const replay = await executeDigitalWorkforceRun({
      workforce: server.digitalWorkforce,
      leads: server.leads,
      runId: finished.id,
      adapters: demoAdapters(),
    });
    expect(replay.status).toBe(finished.status);
  }, 60_000);

  it("replays createRun and upsertStep by idempotency key", async () => {
    const server = await demoRuntime();
    const first = await queueExecutiveRun(server, "same-run-key");
    const second = await queueExecutiveRun(server, "same-run-key");
    expect(second.id).toBe(first.id);
    const version = await server.digitalWorkforce.getPublishedVersion(ids.agents.leadReview);
    const step = await server.digitalWorkforce.upsertStep({
      id: randomUUID(),
      runId: first.id,
      stepKey: "lead-review",
      stepType: "analyze_records",
      agentId: ids.agents.leadReview,
      agentVersionId: version!.id,
      status: "completed",
      idempotencyKey: `run:${first.id}:step:lead-review`,
      sequence: 1,
      parallelGroup: "discovery",
      assignedWhy: "idempotent",
      provider: "deterministic",
      model: "deterministic:fast",
      fallbackModelUsed: null,
      toolNames: ["bea_query_records"],
      authorizedRecordIds: [],
      citationIds: [],
      artifactIds: [],
      usageJson: {},
      resultJson: { ok: true },
      safeError: null,
      retryCount: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const replay = await server.digitalWorkforce.upsertStep({
      id: randomUUID(),
      runId: first.id,
      stepKey: "lead-review",
      stepType: "analyze_records",
      agentId: ids.agents.leadReview,
      agentVersionId: version!.id,
      status: "failed",
      idempotencyKey: `run:${first.id}:step:lead-review`,
      sequence: 1,
      parallelGroup: "discovery",
      assignedWhy: "should not replace",
      provider: "deterministic",
      model: "other",
      fallbackModelUsed: null,
      toolNames: [],
      authorizedRecordIds: [],
      citationIds: [],
      artifactIds: [],
      usageJson: {},
      resultJson: {},
      safeError: "no",
      retryCount: 9,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    expect(replay.id).toBe(step.id);
    expect(replay.status).toBe("completed");
    expect(replay.model).toBe("deterministic:fast");
  });

  it("filters organization by audience and denies operations the executive Digital Agent", async () => {
    const server = await demoRuntime();
    const operations = await server.digitalWorkforce.listOrganization({
      availableToRoleIds: ["operations"],
    });
    expect(operations.some((node) => node.agentId === ids.agents.andrewExecutive)).toBe(false);
    expect(operations.some((node) => node.agentId === ids.agents.leadReview)).toBe(false);
    expect(operations.some((node) => node.agentId === ids.agents.projectReadiness)).toBe(true);
    const executive = await server.digitalWorkforce.listOrganization({
      availableToRoleIds: ["executive-readonly"],
    });
    expect(executive.some((node) => node.agentId === ids.agents.andrewExecutive)).toBe(true);
    expect(executive.some((node) => node.agentId === ids.agents.scheduling)).toBe(false);
    const decision = await server.authorization.authorizeUser(
      DEMO_PERSONAS[4].id,
      PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    );
    expect(decision.allowed).toBe(false);
  });

  it("cancels a queued run before specialist work proceeds", async () => {
    const server = await demoRuntime();
    const queued = await queueExecutiveRun(server, "cancel-run");
    await server.digitalWorkforce.requestCancellation({
      runId: queued.id,
      cancelledByUserId: OWNER_USER_ID,
      reason: "Owner stopped the run.",
    });
    const finished = await executeDigitalWorkforceRun({
      workforce: server.digitalWorkforce,
      leads: server.leads,
      runId: queued.id,
      adapters: demoAdapters(),
    });
    expect(finished.status).toBe("cancelled");
  });

  it("fails closed when the document specialist is paused", async () => {
    const server = await demoRuntime();
    await server.digitalWorkforce.setAgentStatus({
      agentId: ids.agents.executiveDocument,
      status: "paused",
      actorUserId: OWNER_USER_ID,
    });
    const queued = await queueExecutiveRun(server, "paused-document");
    const finished = await executeDigitalWorkforceRun({
      workforce: server.digitalWorkforce,
      leads: server.leads,
      runId: queued.id,
      adapters: demoAdapters(),
    });
    expect(finished.status).toBe("failed");
    expect(finished.safeError).toMatch(/not published/iu);
  });

  it("marks budget_exceeded when a live step reports over-ceiling cost", async () => {
    const server = await demoRuntime();
    const queued = await queueExecutiveRun(server, "budget-run");
    const finished = await executeDigitalWorkforceRun({
      workforce: server.digitalWorkforce,
      leads: server.leads,
      runId: queued.id,
      adapters: demoAdapters({
        liveEnabled: true,
        demoFallbackAllowed: false,
        liveLeadAnalysis: async () => ({
          text: "blocked leads",
          model: "fixture-text",
          provider: "openai",
          citations: [],
          estimatedCostUsd: DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY.maximumEstimatedCostUsd + 1,
        }),
      }),
    });
    expect(finished.status).toBe("budget_exceeded");
  });

  it("refuses to start a run as integration-admin and awaits owned execution for the owner", async () => {
    const server = await demoRuntime();
    await expect(
      startDigitalWorkforceRun({
        runtime: server,
        userId: DEMO_PERSONAS[4].id,
        roleIds: ["integration-admin"],
        goal: EXECUTIVE_TEAM_WORKFLOW_GOAL,
        idempotencyKey: "denied-integration",
        correlationId: "phase23-denied",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const started = await startDigitalWorkforceRun({
      runtime: server,
      userId: OWNER_USER_ID,
      roleIds: ["owner-admin"],
      goal: EXECUTIVE_TEAM_WORKFLOW_GOAL,
      idempotencyKey: "owner-await",
      correlationId: "phase23-owner-await",
      awaitExecution: true,
    });
    expect(["completed", "partially_completed"]).toContain(started.status);
  }, 60_000);

  it("creates fifty extra Digital Agents, one hundred runs, and five hundred events", async () => {
    const server = await demoRuntime();
    const published = await server.digitalWorkforce.getPublishedVersion(ids.agents.andrewExecutive);
    if (!published) throw new Error("missing published executive version");
    const baseVersion = {
      persona: "Scale Digital Agent. Never expand permissions.",
      roleDefinition: "Load specialist",
      goals: ["Stay inside registered tools"],
      successCriteria: ["No permission expansion"],
      departmentId: ids.departments.operations,
      teamId: ids.teams.projectReadiness,
      supervisorAgentId: ids.agents.operationsManager,
      preferredHandoffAgentIds: [ids.agents.operationsManager],
      availableToRoleIds: ["owner-admin"] as const,
      modelAssignment: published.modelAssignment,
      toolGrants: published.toolGrants.slice(0, 2),
      dataScopes: published.dataScopes.slice(0, 1),
      knowledgeScopes: published.knowledgeScopes.slice(0, 1),
      memoryPolicy: published.memoryPolicy,
      approvalPolicy: published.approvalPolicy,
      designatedApproverRoleId: null,
      escalationInstructions: "Escalate to the owner.",
      runtimePolicy: published.runtimePolicy,
      createdByUserId: OWNER_USER_ID,
    };
    for (let index = 0; index < 50; index += 1) {
      await server.digitalWorkforce.createAgentDraft({
        slug: `scale-specialist-${index + 1}`,
        displayName: `Scale Specialist ${index + 1}`,
        roleTitle: "Scale Specialist — Digital Agent",
        shortDescription: "Load-test Digital Agent",
        departmentId: ids.departments.operations,
        teamId: ids.teams.projectReadiness,
        avatar: "specialist-operations",
        createdByUserId: OWNER_USER_ID,
        version: baseVersion,
      });
    }
    const agents = await server.digitalWorkforce.listAgents({ includeArchived: true, limit: 100 });
    expect(agents.length).toBeGreaterThanOrEqual(62);
    const runIds: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const run = await server.digitalWorkforce.createRun({
        initiatingUserId: OWNER_USER_ID,
        rootAgentId: ids.agents.andrewExecutive,
        rootAgentVersionId: published.id,
        goal: "Bounded scale evaluation goal.",
        normalizedRequest: "Bounded scale evaluation goal.",
        idempotencyKey: `scale-run-${index + 1}`,
        correlationId: `scale-${index + 1}`,
      });
      runIds.push(run.id);
    }
    expect(runIds).toHaveLength(100);
    const eventRun = runIds[0]!;
    for (let index = 0; index < 500; index += 1) {
      await server.digitalWorkforce.appendEvent({
        runId: eventRun,
        eventType: "run.progress",
        narration: `Scale event ${index + 1}`,
        metadata: { index },
      });
    }
    const events = await server.digitalWorkforce.listEvents(eventRun, 500);
    expect(events).toHaveLength(500);
  }, 90_000);
});
