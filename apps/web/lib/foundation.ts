import "server-only";

import { FOUNDATION_WORKFLOW_KEY } from "@bea/automation";

import { getActiveDemoSessionCount } from "./auth/session-store";
import { getFoundationRuntime } from "./foundation-runtime";
import { parseWorkerHealthResponse } from "./worker-health";

async function getWorkerHealth(port: number) {
  const controller = new AbortController();
  // Keep the probe bounded while allowing for local Next compilation and
  // single-process PGlite CPU contention in the Phase 0 demo.
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const endpoint = `http://127.0.0.1:${port}/health`;
  try {
    const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
    const checkedAt = new Date().toISOString();
    const body: unknown = await response.json().catch(() => undefined);
    return parseWorkerHealthResponse(response.status, body, checkedAt);
  } catch {
    return { status: "unavailable" as const, checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getFoundationSnapshot() {
  const runtime = await getFoundationRuntime();
  // Probe the separate worker before PGlite work. PGlite can occupy the local
  // event loop long enough to starve an otherwise healthy worker response.
  const workerHealth = await getWorkerHealth(runtime.environment.workerHealthPort);
  const [runtimeHealth, activeSessions, latestWorkflowRun] = await Promise.all([
    runtime.health(),
    getActiveDemoSessionCount(),
    runtime.repository.getLatestWorkflowRun(FOUNDATION_WORKFLOW_KEY),
  ]);
  const latestWorkflowSteps = latestWorkflowRun
    ? await runtime.repository.listWorkflowStepRuns(latestWorkflowRun.id)
    : [];
  const databaseHealth = runtimeHealth.database;
  const integrationHealth = runtimeHealth.integrations;
  return {
    phase: "Phase 0",
    status:
      runtimeHealth.status !== "healthy" || workerHealth.status !== "healthy"
        ? ("degraded" as const)
        : ("healthy" as const),
    environment: runtime.environment.nodeEnv,
    appMode: runtime.environment.appMode,
    version: process.env.npm_package_version ?? "0.0.0",
    demoAuth: runtime.environment.demoAuthEnabled ? ("enabled" as const) : ("disabled" as const),
    sessionStore: `${runtime.database.kind}-sql` as const,
    activeSessions,
    adapterMode: "simulated" as const,
    simulatedAdapters: integrationHealth.simulated,
    liveConnections: integrationHealth.connected,
    databaseHealth,
    integrationHealth,
    workerHealth,
    latestWorkflow: latestWorkflowRun
      ? { run: latestWorkflowRun, steps: latestWorkflowSteps }
      : null,
    generatedAt: new Date().toISOString(),
  };
}

export async function runFoundationWorkflow(input: {
  idempotencyKey: string;
  actorUserId: string;
  correlationId: string;
}) {
  const runtime = await getFoundationRuntime();
  return runtime.workflow.execute({
    idempotencyKey: input.idempotencyKey,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    trigger: "manual",
  });
}
