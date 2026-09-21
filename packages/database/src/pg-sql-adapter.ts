import { performance } from "node:perf_hooks";
import type { DatabaseHealth } from "@bea/domain";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import type { DatabaseAdapter, DatabaseResult, SqlExecutor } from "./adapter.js";

class PgTransactionExecutor implements SqlExecutor {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<DatabaseResult<Row>> {
    const result = await this.client.query<Row & QueryResultRow>(sql, [...parameters]);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  }

  async execute(sql: string): Promise<void> {
    await this.client.query(sql);
  }
}

/** SQL-only PostgreSQL lifecycle shared by hosted and legacy callers. */
export class PgSqlDatabaseAdapter implements DatabaseAdapter {
  readonly kind = "postgres" as const;
  readonly pool: Pool;

  constructor(configuration: PoolConfig | string) {
    this.pool = new Pool(
      typeof configuration === "string" ? { connectionString: configuration } : configuration,
    );
  }

  async query<Row extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<DatabaseResult<Row>> {
    const result = await this.pool.query<Row & QueryResultRow>(sql, [...parameters]);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  }

  async execute(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let connectionFailure: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await operation(new PgTransactionExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        connectionFailure = new Error("PostgreSQL rollback failed; discard connection.");
      }
      throw error;
    } finally {
      client.release(connectionFailure);
    }
  }

  async health(): Promise<DatabaseHealth> {
    const startedAt = performance.now();
    const checkedAt = new Date().toISOString();
    try {
      await this.pool.query("SELECT 1 AS healthy");
      return {
        status: "healthy",
        adapter: "postgres",
        checkedAt,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      };
    } catch {
      return {
        status: "unhealthy",
        adapter: "postgres",
        checkedAt,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        detail: "PostgreSQL health query failed.",
      };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
