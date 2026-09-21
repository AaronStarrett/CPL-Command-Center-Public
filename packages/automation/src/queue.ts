import type { JsonObject } from "@bea/domain";

export const FOUNDATION_QUEUE_NAME = "bea.foundation.system-health-check";
export const ARTIFACT_RETENTION_QUEUE_NAME = "bea.artifacts.retention-sweep";
export const DIGITAL_WORKFORCE_QUEUE_NAME = "bea.digital-workforce.execute-run";
export const OPERATIONS_QUEUE_NAME = "bea.operations.inspection-report";

export interface QueueJob<T extends JsonObject = JsonObject> {
  readonly id: string;
  readonly name: string;
  readonly data: T;
}

export interface JobQueue {
  readonly kind: "inline-demo" | "pg-boss";
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue<T extends JsonObject>(name: string, data: T, idempotencyKey: string): Promise<string>;
  work<T extends JsonObject>(
    name: string,
    handler: (job: QueueJob<T>) => Promise<void>,
  ): Promise<void>;
}

export interface PgBossClientSeam {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<unknown>;
  createQueue(name: string): Promise<unknown>;
  send(
    name: string,
    data: JsonObject,
    options?: { singletonKey?: string; retryLimit?: number },
  ): Promise<string | null>;
  work(
    name: string,
    handler: (jobs: readonly { id: string; name: string; data: JsonObject }[]) => Promise<void>,
  ): Promise<unknown>;
}

export class PgBossQueueAdapter implements JobQueue {
  readonly kind = "pg-boss" as const;
  private readonly queueCreations = new Map<string, Promise<void>>();

  constructor(private readonly client: PgBossClientSeam) {}

  async start(): Promise<void> {
    await this.client.start();
  }

  async stop(): Promise<void> {
    await this.client.stop({ graceful: true, timeout: 10_000 });
  }

  async enqueue<T extends JsonObject>(
    name: string,
    data: T,
    idempotencyKey: string,
  ): Promise<string> {
    await this.ensureQueue(name);
    const id = await this.client.send(name, data, { singletonKey: idempotencyKey, retryLimit: 3 });
    if (!id) throw new Error("pg-boss did not enqueue the idempotent job.");
    return id;
  }

  async work<T extends JsonObject>(
    name: string,
    handler: (job: QueueJob<T>) => Promise<void>,
  ): Promise<void> {
    await this.ensureQueue(name);
    await this.client.work(name, async (jobs) => {
      const job = jobs.at(0);
      if (!job) return;
      await handler({ id: job.id, name: job.name, data: job.data as T });
    });
  }

  private ensureQueue(name: string): Promise<void> {
    const pending = this.queueCreations.get(name);
    if (pending) return pending;
    const creation = this.client
      .createQueue(name)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.queueCreations.delete(name);
        throw error;
      });
    this.queueCreations.set(name, creation);
    return creation;
  }
}
