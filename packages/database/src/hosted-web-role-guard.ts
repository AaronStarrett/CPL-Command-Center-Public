import { performance } from "node:perf_hooks";
import type { DatabaseAdapter, DatabaseResult, SqlExecutor } from "./adapter.js";
import { verifyHostedDatabaseRole } from "./hosted-database-role.js";

/** Invocation-owned web guard, composed outside the Hyperdrive deadline adapter.
 * The first application transaction also verifies the unchanged runtime role.
 * Concurrent callers wait for its COMMIT; a failed first transaction cannot
 * authorize later work. Never retain this adapter between requests.
 */
export function withHostedWebRoleGuard(database: DatabaseAdapter): DatabaseAdapter {
  if (database.kind !== "postgres") throw new Error("CPL_HOSTED_POSTGRES_REQUIRED");
  let verified = false;
  let failed = false;
  let closed = false;
  let pending: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const assertAvailable = () => {
    if (closed || failed) throw new Error("CPL_HOSTED_WEB_ROLE_GUARD_REFUSED");
  };
  const transaction = async <T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> => {
    assertAvailable();
    if (pending) {
      await pending;
      assertAvailable();
    }
    const first = !verified;
    let release: (() => void) | undefined;
    if (first)
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
    try {
      const result = await database.transaction(async (executor) => {
        assertAvailable();
        if (first) await verifyHostedDatabaseRole(database, "web", executor);
        assertAvailable();
        return operation(executor);
      });
      // transaction() resolves only after COMMIT. A successful role query alone
      // must not release concurrent callers after application/commit failure.
      assertAvailable();
      if (first) verified = true;
      return result;
    } catch (error) {
      if (first) failed = true;
      throw error;
    } finally {
      if (first) pending = undefined;
      release?.();
    }
  };
  const guarded: DatabaseAdapter = {
    kind: "postgres",
    transaction,
    query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<DatabaseResult<Row>> {
      return transaction((executor) => executor.query<Row>(sql, parameters));
    },
    execute(sql: string): Promise<void> {
      return transaction((executor) => executor.execute(sql));
    },
    async health() {
      const started = performance.now();
      const checkedAt = new Date().toISOString();
      try {
        await guarded.query("SELECT 1 AS healthy");
        return {
          status: "healthy",
          adapter: "postgres",
          checkedAt,
          latencyMs: Number((performance.now() - started).toFixed(2)),
        };
      } catch {
        return {
          status: "unhealthy",
          adapter: "postgres",
          checkedAt,
          latencyMs: Number((performance.now() - started).toFixed(2)),
          detail: "PostgreSQL health query failed.",
        };
      }
    },
    close() {
      closed = true;
      closing ??= database.close();
      return closing;
    },
  };
  return guarded;
}
