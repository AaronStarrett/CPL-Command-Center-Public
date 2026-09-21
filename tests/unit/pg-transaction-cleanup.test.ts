import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { PgDatabaseAdapter } from "../../packages/database/src/pg-adapter.js";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter.js";

const databases: PgSqlDatabaseAdapter[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  vi.restoreAllMocks();
});
function adapter(Adapter: typeof PgSqlDatabaseAdapter, query: ReturnType<typeof vi.fn>) {
  const database = new Adapter({
    connectionString: "postgresql://fixture.invalid/unused",
    max: 1,
  });
  databases.push(database);
  const release = vi.fn();
  vi.spyOn(database.pool, "connect").mockResolvedValue({ query, release } as unknown as PoolClient);
  return { database, release };
}
describe.each([
  { name: "Legacy PostgreSQL", Adapter: PgDatabaseAdapter },
  { name: "Hosted SQL PostgreSQL", Adapter: PgSqlDatabaseAdapter },
])("$name transaction connection cleanup", ({ Adapter }) => {
  it("discards a connection if rollback fails while preserving the original operation error", async () => {
    const original = new Error("operation failed");
    const query = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("connection failed during rollback"));
    const { database, release } = adapter(Adapter, query);
    await expect(
      database.transaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
  it("returns a usable connection only after successful rollback", async () => {
    const query = vi.fn().mockResolvedValue({});
    const { database, release } = adapter(Adapter, query);
    await expect(
      database.transaction(async () => {
        throw new Error("application failure");
      }),
    ).rejects.toThrow("application failure");
    expect(query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledWith(undefined);
  });
  it("commits before releasing successful work", async () => {
    const query = vi.fn().mockResolvedValue({});
    const { database, release } = adapter(Adapter, query);
    expect(await database.transaction(async () => 42)).toBe(42);
    expect(query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "COMMIT"]);
    expect(release).toHaveBeenCalledWith(undefined);
  });
});
