import { describe, expect, it } from "vitest";
import { PgBossQueueAdapter, type PgBossClientSeam } from "../../packages/automation/src/index.js";

describe("pg-boss queue adapter", () => {
  it("creates a pg-boss v10 queue before registering work or sending jobs", async () => {
    const calls: string[] = [];
    const client: PgBossClientSeam = {
      start: async () => undefined,
      stop: async () => undefined,
      createQueue: async (name) => {
        calls.push(`create:${name}`);
      },
      send: async (name) => {
        calls.push(`send:${name}`);
        return "job-1";
      },
      work: async (name, handler) => {
        calls.push(`work:${name}`);
        await handler([{ id: "job-1", name, data: { idempotencyKey: "queue-test" } }]);
      },
    };
    const queue = new PgBossQueueAdapter(client);
    const handled: string[] = [];

    await queue.start();
    await queue.work("foundation", async (job) => {
      handled.push(job.id);
    });
    await queue.enqueue("foundation", { safe: true }, "queue-test");

    expect(calls).toEqual(["create:foundation", "work:foundation", "send:foundation"]);
    expect(handled).toEqual(["job-1"]);
  });
});
