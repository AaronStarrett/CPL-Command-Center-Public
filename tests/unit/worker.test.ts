import { afterEach, describe, expect, it } from "vitest";
import { parseWorkerArguments } from "../../apps/worker/src/cli.js";
import {
  InlineScheduledRunCoordinator,
  recordScheduledWorkerFailure,
} from "../../apps/worker/src/runtime.js";
import {
  startWorkerHealthServer,
  WorkerHealthMonitor,
  type WorkerHealthServer,
} from "../../apps/worker/src/health-server.js";
import type { StructuredLogger } from "../../packages/observability/src/index.js";
import { vi } from "vitest";

let server: WorkerHealthServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("worker CLI and health", () => {
  it("supports once and serve modes", () => {
    expect(parseWorkerArguments(["--once"])).toMatchObject({ mode: "once" });
    expect(parseWorkerArguments(["--serve", "--idempotency-key=key-1"])).toEqual({
      mode: "serve",
      idempotencyKey: "key-1",
    });
    expect(() => parseWorkerArguments(["--once", "--serve"])).toThrow();
  });
  it("serves structured safe health JSON and closes cleanly", async () => {
    const monitor = new WorkerHealthMonitor();
    monitor.markHealthy();
    server = await startWorkerHealthServer(monitor, 0);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: "bea-worker",
      status: "healthy",
      lastWorkflowRun: null,
    });
  });
  it("reports a degraded workflow as unavailable", async () => {
    const monitor = new WorkerHealthMonitor();
    monitor.recordWorkflow(
      { id: "workflow-degraded", status: "degraded", finishedAt: "2026-08-18T00:00:00.000Z" },
      false,
    );
    server = await startWorkerHealthServer(monitor, 0);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      service: "bea-worker",
      status: "degraded",
      lastWorkflowRun: { id: "workflow-degraded", status: "degraded", reused: false },
    });
  });
  it("marks scheduled failures degraded and logs only a safe failure code", () => {
    const monitor = new WorkerHealthMonitor();
    monitor.markHealthy();
    const error = vi.fn<StructuredLogger["error"]>();
    const logger: StructuredLogger = {
      child: () => logger,
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error,
      fatal: () => undefined,
    };

    recordScheduledWorkerFailure(monitor, logger);

    expect(monitor.snapshot().status).toBe("degraded");
    expect(error).toHaveBeenCalledWith(
      { errorCode: "WORKER_SCHEDULED_RUN_FAILED" },
      "Scheduled worker workflow failed",
    );
  });

  it("runs at most one inline scheduled operation and refuses new work after stop", async () => {
    const coordinator = new InlineScheduledRunCoordinator();
    let active = 0;
    let maximumActive = 0;
    let operationCount = 0;
    let releaseRun: (() => void) | undefined;
    const heldRun = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const onFailure = vi.fn();

    const started = coordinator.start(async () => {
      operationCount += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await heldRun;
      active -= 1;
    }, onFailure);
    const overlapping = coordinator.start(async () => {
      operationCount += 1;
    }, onFailure);

    expect(started).toBe(true);
    expect(overlapping).toBe(false);
    await vi.waitFor(() => expect(active).toBe(1));
    expect(operationCount).toBe(1);
    expect(maximumActive).toBe(1);

    releaseRun?.();
    await coordinator.drain();
    coordinator.stopScheduling();
    expect(coordinator.start(async () => undefined, onFailure)).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
