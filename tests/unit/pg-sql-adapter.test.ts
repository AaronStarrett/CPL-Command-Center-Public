import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter.js";

// This regression fails if the hosted entry evaluates the unused legacy ORM.
vi.mock("../../packages/database/src/schema.js", () => {
  throw new Error("Hosted SQL must not initialize the legacy schema.");
});
vi.mock("drizzle-orm/node-postgres", () => {
  throw new Error("Hosted SQL must not initialize Drizzle.");
});

const databases: PgSqlDatabaseAdapter[] = [];
function database() {
  const adapter = new PgSqlDatabaseAdapter({
    connectionString: "postgresql://fixture.invalid/unused",
    max: 1,
    ssl: { rejectUnauthorized: true },
    statement_timeout: 4_000,
  });
  databases.push(adapter);
  return adapter;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const adapter of databases.splice(0)) await adapter.close();
});

describe("hosted SQL adapter", () => {
  it("loads the hosted entry without evaluating Drizzle or legacy schema", async () => {
    const hosted = await import("../../packages/database/src/hosted.js");
    expect(hosted.PgDatabaseAdapter).toBe(PgSqlDatabaseAdapter);
    expect(database()).not.toHaveProperty("drizzle");
  });

  it("keeps invocation pools distinct with the supplied TLS, capacity and timeout", () => {
    const first = database();
    const second = database();
    expect(first.pool).not.toBe(second.pool);
    expect(first.pool.options).toMatchObject({
      max: 1,
      ssl: { rejectUnauthorized: true },
      statement_timeout: 4_000,
    });
    expect(first.pool.totalCount).toBe(0);
    expect(second.pool.totalCount).toBe(0);
  });

  it("copies query parameters and preserves row count fallback", async () => {
    const adapter = database();
    const query = vi.spyOn(adapter.pool, "query").mockResolvedValue({
      rows: [{ id: "fixture" }],
      rowCount: null,
    } as never);
    const parameters = Object.freeze(["fixture"]);
    expect(await adapter.query("SELECT $1 AS id", parameters)).toEqual({
      rows: [{ id: "fixture" }],
      rowCount: 1,
    });
    expect(query).toHaveBeenCalledWith("SELECT $1 AS id", ["fixture"]);
    expect(query.mock.calls[0]?.[1]).not.toBe(parameters);
  });

  it("preserves a commit failure and rolls back before returning the connection", async () => {
    const adapter = database();
    const original = new Error("commit failed");
    const query = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce({});
    const release = vi.fn();
    vi.spyOn(adapter.pool, "connect").mockResolvedValue({
      query,
      release,
    } as unknown as PoolClient);
    await expect(adapter.transaction(async () => "result")).rejects.toBe(original);
    expect(query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("does not run tenant work when BEGIN fails", async () => {
    const adapter = database();
    const original = new Error("begin failed");
    const query = vi.fn().mockRejectedValueOnce(original).mockResolvedValueOnce({});
    const release = vi.fn();
    const operation = vi.fn();
    vi.spyOn(adapter.pool, "connect").mockResolvedValue({
      query,
      release,
    } as unknown as PoolClient);
    await expect(adapter.transaction(operation)).rejects.toBe(original);
    expect(operation).not.toHaveBeenCalled();
    expect(query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("returns a sanitized unhealthy result without exposing query errors", async () => {
    const adapter = database();
    vi.spyOn(adapter.pool, "query").mockRejectedValue(new Error("fixture connection credential"));
    const result = await adapter.health();
    expect(result).toMatchObject({
      status: "unhealthy",
      adapter: "postgres",
      detail: "PostgreSQL health query failed.",
    });
    expect(JSON.stringify(result)).not.toContain("fixture connection credential");
  });

  it("awaits close and propagates connection cleanup failure", async () => {
    const adapter = database();
    const failure = new Error("pool close failed");
    const end = vi.spyOn(adapter.pool, "end").mockRejectedValue(failure);
    await expect(adapter.close()).rejects.toBe(failure);
    expect(end).toHaveBeenCalledExactlyOnceWith();
  });
});
