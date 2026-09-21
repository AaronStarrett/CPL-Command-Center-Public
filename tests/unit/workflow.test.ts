import { describe, expect, it } from "vitest";
import { FoundationSystemHealthWorkflow } from "../../packages/automation/src/index.js";
import { createDefaultMockProviderRegistry } from "../../packages/integrations/src/index.js";
import { createLogger } from "../../packages/observability/src/index.js";
import {
  FixedClock,
  InMemoryAuditSink,
  InMemoryWorkflowStore,
  SequenceIdGenerator,
} from "../../packages/testing/src/index.js";

describe("foundation workflow", () => {
  it("persists steps, audit evidence, correlation, and idempotent reuse", async () => {
    const store = new InMemoryWorkflowStore();
    const audit = new InMemoryAuditSink();
    const clock = new FixedClock();
    const workflow = new FoundationSystemHealthWorkflow({
      database: {
        health: async () => ({
          status: "healthy",
          adapter: "pglite",
          checkedAt: clock.now().toISOString(),
          latencyMs: 1,
        }),
      },
      providers: createDefaultMockProviderRegistry(clock),
      store,
      audit,
      clock,
      ids: new SequenceIdGenerator("workflow"),
    });
    const first = await workflow.execute({
      idempotencyKey: "test:health:v1",
      correlationId: "correlation-1",
    });
    const second = await workflow.execute({
      idempotencyKey: "test:health:v1",
      correlationId: "correlation-2",
    });
    expect(first.run.status).toBe("succeeded");
    expect(first.steps).toHaveLength(2);
    expect(second.reused).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(second.steps).toHaveLength(2);
    expect(store.steps).toHaveLength(2);
    expect(audit.events).toHaveLength(1);
  });

  it("persists truthful degraded and failed check status with a safe audited failure", async () => {
    const degradedStore = new InMemoryWorkflowStore();
    const degraded = new FoundationSystemHealthWorkflow({
      database: {
        health: async () => ({
          status: "degraded",
          adapter: "pglite",
          checkedAt: new Date().toISOString(),
          latencyMs: 1,
        }),
      },
      providers: createDefaultMockProviderRegistry(new FixedClock()),
      store: degradedStore,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator("degraded"),
    });
    const degradedResult = await degraded.execute({ idempotencyKey: "test:degraded" });
    expect(degradedResult.run.status).toBe("degraded");
    expect(degradedResult.steps.map((step) => step.status)).toEqual(["degraded", "succeeded"]);

    const failedStore = new InMemoryWorkflowStore();
    const audit = new InMemoryAuditSink();
    const logOutput: string[] = [];
    const failed = new FoundationSystemHealthWorkflow({
      database: {
        health: async () => {
          throw new Error("private database detail");
        },
      },
      providers: createDefaultMockProviderRegistry(new FixedClock()),
      store: failedStore,
      audit,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator("failed"),
      logger: createLogger({
        service: "workflow-test",
        environment: "test",
        destination: {
          write: (chunk) => {
            logOutput.push(chunk);
          },
        },
      }),
    });
    const failedResult = await failed.execute({ idempotencyKey: "test:failed" });
    expect(failedResult.run).toMatchObject({
      status: "failed",
      error: { code: "FOUNDATION_WORKFLOW_FAILED", message: "Foundation health check failed." },
    });
    expect(JSON.stringify(failedResult.run)).not.toContain("private database detail");
    expect(logOutput.join("")).not.toContain("private database detail");
    expect(logOutput.join("")).toContain("FOUNDATION_WORKFLOW_FAILED");
    expect(audit.events).toEqual([
      expect.objectContaining({ eventType: "workflow.failed", outcome: "failed" }),
    ]);
  });
});
