import { performance } from "node:perf_hooks";
import type { DatabaseHealth } from "@bea/domain";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseAdapter, DatabaseResult, SqlExecutor } from "./adapter.js";

interface PGliteResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly affectedRows?: number;
}

interface PGliteClient {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<PGliteResult<Row>>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

class PGliteTransactionExecutor implements SqlExecutor {
  constructor(private readonly client: PGliteClient) {}

  async query<Row extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<DatabaseResult<Row>> {
    const result = await this.client.query<Row>(sql, parameters);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  async execute(sql: string): Promise<void> {
    await this.client.exec(sql);
  }
}

export class PGliteDatabaseAdapter implements DatabaseAdapter {
  readonly kind = "pglite" as const;
  readonly client: PGliteClient;
  private readonly transactionExecutor: SqlExecutor;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(dataDirectory = "memory://") {
    this.client = new PGlite(dataDirectory) as unknown as PGliteClient;
    this.transactionExecutor = new PGliteTransactionExecutor(this.client);
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const precedingOperation = this.operationTail;
    let releaseOperation!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    await precedingOperation;
    try {
      return await operation();
    } finally {
      releaseOperation();
    }
  }

  async query<Row extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<DatabaseResult<Row>> {
    return this.runExclusive(() => this.transactionExecutor.query<Row>(sql, parameters));
  }

  async execute(sql: string): Promise<void> {
    await this.runExclusive(() => this.transactionExecutor.execute(sql));
  }

  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      await this.client.exec("BEGIN");
      try {
        const result = await operation(this.transactionExecutor);
        await this.client.exec("COMMIT");
        return result;
      } catch (error) {
        await this.client.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async health(): Promise<DatabaseHealth> {
    const startedAt = performance.now();
    const checkedAt = new Date().toISOString();
    try {
      await this.query("SELECT 1 AS healthy");
      return {
        status: "healthy",
        adapter: "pglite",
        checkedAt,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      };
    } catch {
      return {
        status: "unhealthy",
        adapter: "pglite",
        checkedAt,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        detail: "PGlite health query failed.",
      };
    }
  }

  async close(): Promise<void> {
    await this.runExclusive(() => this.client.close());
  }
}
