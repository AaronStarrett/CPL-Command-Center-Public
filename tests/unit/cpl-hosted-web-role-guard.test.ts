import { describe, expect, it, vi } from "vitest";
import type {
  DatabaseAdapter,
  DatabaseResult,
  SqlExecutor,
} from "../../packages/database/src/adapter";
import { withHostedWebRoleGuard } from "../../packages/database/src/hosted-web-role-guard";
import { withHyperdriveDeadlines } from "../../packages/database/src/hosted-connection";

const unsafeCapabilities = [
  "rolsuper",
  "rolbypassrls",
  "rolcreatedb",
  "rolcreaterole",
  "rolreplication",
  "owns_database",
  "owns_schema",
  "owns_application_tables",
  "schema_create",
  "elevated_membership",
  "can_change_role_registry",
  "can_read_legacy_leads",
];
const safeRole = () => ({
  rolname: "cpl_web_runtime",
  purpose: "web",
  tenant_tables_protected: true,
  ...Object.fromEntries(unsafeCapabilities.map((key) => [key, false])),
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(
  options: {
    role?: Record<string, unknown>;
    beforeRole?: () => Promise<void>;
    beforeCommit?: () => Promise<void>;
    failCommit?: boolean;
    deadline?: number;
  } = {},
) {
  const commands: string[] = [];
  const executor: SqlExecutor = {
    async query<Row extends Record<string, unknown>>(sql: string): Promise<DatabaseResult<Row>> {
      const role = sql.includes("WITH RECURSIVE inherited");
      const deadline = sql.includes("set_config('statement_timeout'");
      commands.push(role ? "ROLE" : deadline ? "DEADLINE" : sql);
      if (role) await options.beforeRole?.();
      const rows = role
        ? [options.role ?? safeRole()]
        : deadline
          ? [
              {
                statement_timeout_ms: options.deadline ?? 15000,
                idle_timeout_ms: options.deadline ?? 15000,
              },
            ]
          : [{ healthy: 1 }];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    },
    async execute(sql) {
      commands.push(sql);
    },
  };
  const close = vi.fn(async () => {});
  const database: DatabaseAdapter = {
    kind: "postgres",
    query: vi.fn(async () => {
      throw new Error("UNGUARDED_QUERY");
    }),
    execute: vi.fn(async () => {
      throw new Error("UNGUARDED_EXECUTE");
    }),
    health: vi.fn(async () => {
      throw new Error("UNGUARDED_HEALTH");
    }),
    async transaction(operation) {
      commands.push("BEGIN");
      try {
        const result = await operation(executor);
        await options.beforeCommit?.();
        commands.push("COMMIT");
        if (options.failCommit) throw new Error("COMMIT_FAILED");
        return result;
      } catch (error) {
        commands.push("ROLLBACK");
        throw error;
      }
    },
    close,
  };
  return {
    database,
    commands,
    close,
    guarded: withHostedWebRoleGuard(withHyperdriveDeadlines(database, "web")),
  };
}
describe("invocation-scoped first-transaction web role guard", () => {
  it("keeps full role verification before application SQL on the same executor and checks only once per invocation", async () => {
    const f = fixture();
    await f.guarded.query("FIRST");
    await f.guarded.execute("SECOND");
    expect(await f.guarded.health()).toMatchObject({ status: "healthy" });
    expect(f.commands).toEqual([
      "BEGIN",
      "DEADLINE",
      "ROLE",
      "FIRST",
      "COMMIT",
      "BEGIN",
      "DEADLINE",
      "SECOND",
      "COMMIT",
      "BEGIN",
      "DEADLINE",
      "SELECT 1 AS healthy",
      "COMMIT",
    ]);
    expect(f.database.query).not.toHaveBeenCalled();
    expect(f.database.execute).not.toHaveBeenCalled();
    expect(f.database.health).not.toHaveBeenCalled();
    const other = withHostedWebRoleGuard(withHyperdriveDeadlines(f.database, "web"));
    await other.query("OTHER_INVOCATION");
    expect(f.commands.filter((command) => command === "ROLE")).toHaveLength(2);
  });
  it("queues concurrent first operations until first COMMIT without another checkout or premature authorization", async () => {
    const firstAtCommit = deferred(),
      commit = deferred();
    let transactions = 0;
    const f = fixture({
      beforeCommit: async () => {
        if (++transactions === 1) {
          firstAtCommit.release();
          await commit.promise;
        }
      },
    });
    const left = f.guarded.query("LEFT");
    await firstAtCommit.promise;
    const right = f.guarded.query("RIGHT");
    await Promise.resolve();
    expect(f.commands).toEqual(["BEGIN", "DEADLINE", "ROLE", "LEFT"]);
    commit.release();
    await Promise.all([left, right]);
    expect(f.commands).toEqual([
      "BEGIN",
      "DEADLINE",
      "ROLE",
      "LEFT",
      "COMMIT",
      "BEGIN",
      "DEADLINE",
      "RIGHT",
      "COMMIT",
    ]);
  });
  it("a failed first COMMIT wakes waiting callers into refusal and cannot cache the successful role SELECT", async () => {
    const firstAtCommit = deferred(),
      commit = deferred();
    const f = fixture({
      failCommit: true,
      beforeCommit: async () => {
        firstAtCommit.release();
        await commit.promise;
      },
    });
    const left = f.guarded.query("LEFT");
    await firstAtCommit.promise;
    const right = f.guarded.query("RIGHT");
    const results = Promise.allSettled([left, right]);
    commit.release();
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(f.guarded.query("RETRY")).rejects.toThrow("CPL_HOSTED_WEB_ROLE_GUARD_REFUSED");
    expect(f.commands).toEqual(["BEGIN", "DEADLINE", "ROLE", "LEFT", "COMMIT", "ROLLBACK"]);
  });
  it("concurrent callers all refuse when the initial live role check fails", async () => {
    const atRole = deferred(),
      releaseRole = deferred();
    const f = fixture({
      role: { ...safeRole(), rolbypassrls: true },
      beforeRole: async () => {
        atRole.release();
        await releaseRole.promise;
      },
    });
    const left = f.guarded.query("LEFT");
    await atRole.promise;
    const right = f.guarded.execute("RIGHT");
    const results = Promise.allSettled([left, right]);
    expect(f.commands).toEqual(["BEGIN", "DEADLINE", "ROLE"]);
    releaseRole.release();
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(f.commands).toEqual(["BEGIN", "DEADLINE", "ROLE", "ROLLBACK"]);
  });
  it("application rollback poisons first-transaction authorization even when its caller catches the failure", async () => {
    const f = fixture();
    await expect(
      f.guarded.transaction(async (executor) => {
        await executor.execute("MUTATION");
        throw new Error("APPLICATION_FAILED");
      }),
    ).rejects.toThrow("APPLICATION_FAILED");
    await expect(f.guarded.execute("LATER")).rejects.toThrow("CPL_HOSTED_WEB_ROLE_GUARD_REFUSED");
    expect(f.commands).toEqual(["BEGIN", "DEADLINE", "ROLE", "MUTATION", "ROLLBACK"]);
  });
  it.each(unsafeCapabilities)(
    "retains refusal for privileged or indeterminate %s",
    async (capability) => {
      for (const value of [true, null, undefined]) {
        const f = fixture({ role: { ...safeRole(), [capability]: value } });
        const application = vi.fn(async () => {});
        await expect(f.guarded.transaction(application)).rejects.toThrow(
          "CPL_HOSTED_DATABASE_ROLE_REFUSED",
        );
        expect(application).not.toHaveBeenCalled();
        expect(f.commands).toEqual(["BEGIN", "DEADLINE", "ROLE", "ROLLBACK"]);
      }
    },
  );
  it.each([
    { purpose: "worker" },
    { tenant_tables_protected: false },
    { tenant_tables_protected: null },
  ])("role purpose and forced RLS stay fail-closed (%j)", async (changed) => {
    const f = fixture({ role: { ...safeRole(), ...changed } });
    await expect(f.guarded.query("APPLICATION")).rejects.toThrow(
      "CPL_HOSTED_DATABASE_ROLE_REFUSED",
    );
    expect(await f.guarded.health()).toMatchObject({ status: "unhealthy" });
    expect(f.commands).toEqual(["BEGIN", "DEADLINE", "ROLE", "ROLLBACK"]);
  });
  it("health as the first operation cannot bypass a bad role", async () => {
    const f = fixture({ role: { ...safeRole(), rolsuper: true } });
    expect(await f.guarded.health()).toMatchObject({ status: "unhealthy" });
    expect(f.commands).toEqual(["BEGIN", "DEADLINE", "ROLE", "ROLLBACK"]);
  });
  it("deadline failure precedes role and application work and poisons the invocation", async () => {
    const f = fixture({ deadline: 0 });
    await expect(f.guarded.query("APPLICATION")).rejects.toThrow(
      "CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED",
    );
    await expect(f.guarded.query("RETRY")).rejects.toThrow("CPL_HOSTED_WEB_ROLE_GUARD_REFUSED");
    expect(f.commands).toEqual(["BEGIN", "DEADLINE", "ROLLBACK"]);
  });
  it("close is owned once and future calls cannot use cached verification", async () => {
    const f = fixture();
    await f.guarded.query("FIRST");
    await Promise.all([f.guarded.close(), f.guarded.close()]);
    expect(f.close).toHaveBeenCalledOnce();
    await expect(f.guarded.query("AFTER_CLOSE")).rejects.toThrow(
      "CPL_HOSTED_WEB_ROLE_GUARD_REFUSED",
    );
    expect(await f.guarded.health()).toMatchObject({ status: "unhealthy" });
  });
  it("refuses non-Postgres adapters", () => {
    const f = fixture();
    expect(() => withHostedWebRoleGuard({ ...f.database, kind: "pglite" })).toThrow(
      "CPL_HOSTED_POSTGRES_REQUIRED",
    );
  });
});
