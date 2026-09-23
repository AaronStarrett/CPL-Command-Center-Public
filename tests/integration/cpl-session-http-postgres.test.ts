import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { resolve } from "node:path";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter.ts";
import { migrateDatabase } from "../../packages/database/src/migrations.ts";
import { configureHostedRuntimeRole } from "../../packages/database/src/hosted-database-role.ts";
import { configureHostedRuntimeRole as configureSessionRole } from "../../packages/database/src/hosted-database-role.ts";
import type { DatabaseAdapter, SqlExecutor } from "../../packages/database/src/adapter.ts";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store.ts";
import { CplHostedAuthService } from "../../packages/security/src/hosted-authentication.ts";
import type { CplHostedAuthStore } from "../../packages/security/src/hosted-authentication-contracts.ts";
import {
  DEADLINE_SQL,
  READ_SQL,
  PASSKEY_SQL,
  mapSessionResult,
} from "../../apps/web/lib/session-http.mjs";
const ROOT = resolve(import.meta.dirname, "../..");
const productionPath = resolve(
  ROOT,
  "packages/database/migrations/0028_cpl_session_http_reads.sql",
);
const productionBytes = readFileSync(productionPath, "utf8");
const definitions = [
  ...productionBytes.matchAll(/CREATE FUNCTION cpl_session_http\.[\s\S]*?\$function\$;/gu),
].map((match) => match[0]);
if (definitions.length !== 4) throw Error("SESSION_FUNCTION_SET_REFUSED");
const sql =
  "BEGIN;\nCREATE SCHEMA cpl_session_http;\nREVOKE ALL ON SCHEMA cpl_session_http FROM PUBLIC;\nGRANT USAGE ON SCHEMA cpl_session_http TO cpl_fixture_web;\n" +
  definitions.join("\n\n") +
  "\nREVOKE ALL ON ALL FUNCTIONS IN SCHEMA cpl_session_http FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION cpl_session_http.assert_web_v1(),cpl_session_http.read_core_v1(text,timestamptz,boolean),cpl_session_http.read_v1(text,timestamptz),cpl_session_http.read_with_passkey_v1(text,timestamptz) TO cpl_fixture_web;\nCOMMIT;\n";
const rawConfig = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON,
  suite = rawConfig ? describe : describe.skip;
const databaseName = `cpl_acceptance_session_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const token = "A".repeat(43),
  tokenHash = createHash("sha256").update(token).digest("hex"),
  csrfHash = "b".repeat(64);
const now = "2026-09-23T02:00:00.000Z";
describe("private session SQL source contract (offline)", () => {
  it("embeds exact canonical role SQL and all15field checks before reads", () => {
    const source = readFileSync(`${ROOT}/packages/database/src/hosted-database-role.ts`, "utf8"),
      ast = ts.createSourceFile("role.ts", source, ts.ScriptTarget.Latest, true),
      queries: string[] = [];
    function walk(n: ts.Node) {
      if (ts.isNoSubstitutionTemplateLiteral(n) && n.text.includes("WITH RECURSIVE inherited"))
        queries.push(n.text);
      ts.forEachChild(n, walk);
    }
    walk(ast);
    const normalize = (s: string) => s.replace(/\s+/gu, " ").trim(),
      embedded = sql
        .split("-- BEGIN CANONICAL ROLE QUERY")[1]!
        .split("-- END CANONICAL ROLE QUERY")[0]!;
    expect(queries).toHaveLength(1);
    expect(normalize(embedded)).toBe(normalize(queries[0]!));
    for (const f of [
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
    ])
      expect(sql).toContain(`v_role.${f} IS DISTINCT FROM false`);
    expect(sql).toContain("v_role.purpose IS DISTINCT FROM 'web'");
    expect(sql).toContain("v_role.tenant_tables_protected IS DISTINCT FROM true");
    expect(sql.indexOf("PERFORM cpl_session_http.assert_web_v1()")).toBeLessThan(
      sql.indexOf("SELECT s.*,i.issuer"),
    );
  });
  it("production installation wrapper preserves all four local function definitions with invoker/readOnly/noDML", () => {
    const production = readFileSync(productionPath, "utf8");
    const definitions = (source: string) =>
      [
        ...source
          .replaceAll("\r\n", "\n")
          .matchAll(/CREATE FUNCTION cpl_session_http\.[\s\S]*?\$function\$;/gu),
      ].map((match) => match[0]);
    expect(definitions(sql)).toHaveLength(4);
    expect(definitions(production)).toEqual(definitions(sql));
    expect(sql.match(/LANGUAGE \w+ VOLATILE SECURITY INVOKER/gu)).toHaveLength(4);
    expect(sql).not.toMatch(
      /SECURITY DEFINER|FOR (UPDATE|SHARE)|\b(INSERT|UPDATE|DELETE|TRUNCATE)\s+(INTO|FROM|public\.)/iu,
    );
    expect(sql).toContain("current_setting('transaction_read_only') IS DISTINCT FROM 'on'");
    expect(sql).toContain("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cpl_session_http FROM PUBLIC");
  });
});
suite("versioned session functions on owned local PostgreSQL16.15", () => {
  let control: PgSqlDatabaseAdapter,
    admin: PgSqlDatabaseAdapter,
    web: PgSqlDatabaseAdapter,
    worker: PgSqlDatabaseAdapter,
    created = false,
    store: SqlCplHostedAuthStore;
  beforeAll(async () => {
    const config = JSON.parse(rawConfig!),
      urls = [config.adminUrl, config.webUrl, config.workerUrl].map((v) => new URL(v));
    if (
      config.allowHostedDisposableDatabase !== false ||
      urls.some(
        (u) =>
          u.hostname !== "127.0.0.1" ||
          u.pathname !== "/postgres" ||
          u.password ||
          u.search !== "?sslmode=disable" ||
          u.port !== urls[0]!.port,
      ) ||
      urls[0]!.username !== "cpl_fixture_admin" ||
      urls[1]!.username !== "cpl_fixture_web" ||
      urls[2]!.username !== "cpl_fixture_worker"
    )
      throw Error("LOCAL_FIXTURE_ONLY");
    control = new PgSqlDatabaseAdapter({
      connectionString: config.adminUrl,
      max: 1,
    });
    await control.execute(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const connect = (i: number) => {
      const u = new URL(urls[i]!.href);
      u.pathname = `/${databaseName}`;
      return u.href;
    };
    admin = new PgSqlDatabaseAdapter({ connectionString: connect(0), max: 4 });
    await migrateDatabase(admin);
    await configureHostedRuntimeRole(admin, "cpl_fixture_web", "web");
    await configureHostedRuntimeRole(admin, "cpl_fixture_worker", "worker");
    // migrateDatabase has installed0028; this owned fixture grants its synthetic
    // web role the same four existing invoker functions without replacing them.
    await admin.execute(
      "GRANT USAGE ON SCHEMA cpl_session_http TO cpl_fixture_web; GRANT EXECUTE ON FUNCTION cpl_session_http.assert_web_v1(),cpl_session_http.read_core_v1(text,timestamptz,boolean),cpl_session_http.read_v1(text,timestamptz),cpl_session_http.read_with_passkey_v1(text,timestamptz) TO cpl_fixture_web;",
    );
    web = new PgSqlDatabaseAdapter({ connectionString: connect(1), max: 1 });
    worker = new PgSqlDatabaseAdapter({ connectionString: connect(2), max: 1 });
    store = new SqlCplHostedAuthStore(web);
  });
  afterAll(async () => {
    await Promise.all([web?.close(), worker?.close(), admin?.close()]);
    if (created) await control.execute(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await control?.close();
  });
  beforeEach(async () => {
    await admin.execute("TRUNCATE public.cpl_identities,public.cpl_organizations CASCADE");
  });
  async function seed(selected = false, passkey = false) {
    const identityId = randomUUID(),
      id = randomUUID(),
      organizationId = randomUUID();
    await admin.query(
      "INSERT INTO cpl_identities(id,issuer,subject,email,email_verified,display_name) VALUES($1::uuid,'https://accounts.google.com',$1::text,'synthetic@example.invalid',TRUE,'Synthetic 🙂')",
      [identityId],
    );
    await admin.query(
      "INSERT INTO cpl_organizations(id,slug,display_name) VALUES($1::uuid,$1::text,'Synthetic')",
      [organizationId],
    );
    await admin.query(
      "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'member')",
      [organizationId, identityId],
    );
    await admin.query(
      "INSERT INTO cpl_sessions(id,identity_id,token_hash,authenticated_at,created_at,expires_at,absolute_expires_at,csrf_token_hash,selected_organization_id) VALUES($1,$2,$3,'2026-09-23T01:00Z','2026-09-23T01:00Z','2026-09-23T03:00Z','2026-09-23T09:00Z',$4,$5)",
      [id, identityId, tokenHash, csrfHash, selected ? organizationId : null],
    );
    if (passkey) await credential(identityId);
    return { identityId, id, organizationId };
  }
  async function credential(identityId: string) {
    await admin.query(
      "INSERT INTO cpl_webauthn_credentials(id,identity_id,public_key,counter,transports_json,device_type,backed_up) VALUES($1,$2,'SYNTHETIC-NOT-A-KEY',0,'[]','singleDevice',false)",
      [randomUUID(), identityId],
    );
  }
  async function rawStage(
    passkey = false,
    hash: string | null = tokenHash,
    time: string | null = now,
    role = web,
    readOnly = true,
  ) {
    // Preserve real PostgreSQL command metadata for the strict HTTP mapper.
    // The shared adapter intentionally returns only rows and rowCount.
    const client = await role.pool.connect();
    let failure: Error | undefined;
    try {
      await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
      const deadlines = await client.query(DEADLINE_SQL),
        result = await client.query(passkey ? PASSKEY_SQL : READ_SQL, [hash, time]);
      await client.query("COMMIT");
      return [deadlines, result];
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        failure = new Error("LOCAL_ROLLBACK_FAILED");
      }
      throw error;
    } finally {
      client.release(failure);
    }
  }
  async function stage<Passkey extends boolean = false>(
    passkey: Passkey = false as Passkey,
    hash = tokenHash,
    time = now,
  ) {
    return mapSessionResult(passkey, await rawStage(passkey, hash, time));
  }
  async function installation(operation: (tx: SqlExecutor) => Promise<void>) {
    await expect(
      admin.transaction(async (tx) => {
        // Owned disposable database only; the outer rollback restores its fixture.
        await tx.execute("DROP SCHEMA cpl_session_http CASCADE");
        expect(
          (await tx.query("SELECT oid FROM pg_roles WHERE rolname='cpl_web_runtime'")).rows,
        ).toHaveLength(0);
        await operation(tx);
        throw Error("RESTORE_LOCAL_INSTALLATION_FIXTURE");
      }),
    ).rejects.toThrow("RESTORE_LOCAL_INSTALLATION_FIXTURE");
    expect(
      (
        await admin.query(
          "SELECT count(*)::integer AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='cpl_session_http'",
        )
      ).rows[0]!.count,
    ).toBe(4);
  }
  function currentTransaction(tx: SqlExecutor): DatabaseAdapter {
    return {
      kind: "postgres",
      query: tx.query.bind(tx),
      execute: tx.execute.bind(tx),
      transaction: async (operation) => operation(tx),
      health: () => admin.health(),
      close: async () => {},
    };
  }
  const production = readFileSync(productionPath, "utf8");
  it("fresh migration succeeds without web role and grants no PUBLIC or worker execution", async () =>
    installation(async (tx) => {
      await tx.execute(production);
      const rows = (
        await tx.query(
          "SELECT p.prosecdef,p.proconfig,has_function_privilege('cpl_fixture_worker',p.oid,'EXECUTE') AS worker,(SELECT bool_or(a.grantee=0) FROM aclexplode(p.proacl) a) AS public FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='cpl_session_http'",
        )
      ).rows;
      expect(rows).toHaveLength(4);
      for (const r of rows) {
        expect(r.prosecdef).toBe(false);
        expect(r.proconfig).toEqual(["search_path=pg_catalog, public, pg_temp"]);
        expect(r.worker).toBe(false);
        expect(r.public).toBe(false);
      }
    }));
  it("fresh provisioning after migration grants only exact validated web capability", async () =>
    installation(async (tx) => {
      await tx.execute(production);
      await tx.execute("CREATE ROLE cpl_web_runtime NOLOGIN");
      await configureSessionRole(currentTransaction(tx), "cpl_web_runtime", "web");
      const rows = (
        await tx.query(
          "SELECT has_function_privilege('cpl_web_runtime',p.oid,'EXECUTE') AS web,has_function_privilege('cpl_fixture_worker',p.oid,'EXECUTE') AS worker FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='cpl_session_http'",
        )
      ).rows;
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.web === true && r.worker === false)).toBe(true);
    }));
  it("populated installation grants only existing registered web role", async () =>
    installation(async (tx) => {
      await tx.execute("CREATE ROLE cpl_web_runtime NOLOGIN");
      await configureHostedRuntimeRole(currentTransaction(tx), "cpl_web_runtime", "web");
      await tx.execute(production);
      expect(
        (
          await tx.query(
            "SELECT has_schema_privilege('cpl_web_runtime','cpl_session_http','USAGE') AS allowed",
          )
        ).rows[0]!.allowed,
      ).toBe(true);
    }));
  for (const purpose of [null, "worker"])
    it(`existing unregistered/wrong-purpose role refuses installation: ${purpose}`, async () =>
      installation(async (tx) => {
        await tx.execute("CREATE ROLE cpl_web_runtime NOLOGIN");
        if (purpose)
          await tx.query("INSERT INTO cpl_runtime_roles(role_name,purpose) VALUES($1,$2)", [
            "cpl_web_runtime",
            purpose,
          ]);
        await expect(tx.execute(production)).rejects.toThrow("CPL_SESSION_HTTP_WEB_ROLE_REFUSED");
      }));
  it("registered runtime migration owner is refused before creating capability", async () =>
    installation(async (tx) => {
      await tx.execute("SET LOCAL ROLE cpl_fixture_web");
      await expect(tx.execute(production)).rejects.toThrow(
        "CPL_SESSION_HTTP_MIGRATION_OWNER_REFUSED",
      );
    }));
  it("unexpected inherited default function ACL aborts installation", async () =>
    installation(async (tx) => {
      await tx.execute("ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO cpl_fixture_worker");
      await expect(tx.execute(production)).rejects.toThrow("CPL_SESSION_HTTP_NEW_ACL_REFUSED");
    }));
  it("web grant-option default ACL aborts installation", async () =>
    installation(async (tx) => {
      await tx.execute("CREATE ROLE cpl_web_runtime NOLOGIN");
      await configureHostedRuntimeRole(currentTransaction(tx), "cpl_web_runtime", "web");
      await tx.execute(
        "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO cpl_web_runtime WITH GRANT OPTION",
      );
      await expect(tx.execute(production)).rejects.toThrow("CPL_SESSION_HTTP_NEW_ACL_REFUSED");
    }));
  it("fresh grant rejects a changed security guard body", async () =>
    installation(async (tx) => {
      await tx.execute(production);
      await tx.execute("CREATE ROLE cpl_web_runtime NOLOGIN");
      await tx.execute(
        "CREATE OR REPLACE FUNCTION cpl_session_http.assert_web_v1() RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS 'BEGIN RETURN; END'",
      );
      await expect(
        configureSessionRole(currentTransaction(tx), "cpl_web_runtime", "web"),
      ).rejects.toThrow("CPL_SESSION_HTTP_FUNCTION_CONTRACT_REFUSED");
    }));
  it("fresh grant rejects unexpected PUBLIC execution instead of broadening access", async () =>
    installation(async (tx) => {
      await tx.execute(production);
      await tx.execute("CREATE ROLE cpl_web_runtime NOLOGIN");
      await tx.execute("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cpl_session_http TO PUBLIC");
      await expect(
        configureSessionRole(currentTransaction(tx), "cpl_web_runtime", "web"),
      ).rejects.toThrow("CPL_SESSION_HTTP_FUNCTION_CONTRACT_REFUSED");
    }));
  for (const [selected, passkey] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])
    it(`parity of every DTO field selected=${selected} passkey=${passkey}`, async () => {
      await seed(selected, passkey);
      expect(await stage()).toEqual(await store.readSession(tokenHash, now));
      expect(await stage(true)).toEqual(await store.readSessionWithPasskey(tokenHash, now));
    });
  it("MFA and live platform administrator representation exactly match canonical", async () => {
    const v = await seed(true, true);
    await admin.query("UPDATE cpl_sessions SET mfa_verified_at='2026-09-23T01:58Z' WHERE id=$1", [
      v.id,
    ]);
    await admin.query(
      "INSERT INTO cpl_platform_administrators(identity_id,status) VALUES($1,'active')",
      [v.identityId],
    );
    expect(await stage(true)).toEqual(await store.readSessionWithPasskey(tokenHash, now));
    expect((await stage())!.platformAdministrator).toBe(true);
  });
  for (const fallback of ["missing provider name", "invalid provider name"])
    it(`long email display fallback preserves canonical representation: ${fallback}`, async () => {
      const value = await seed(),
        email = "a".repeat(241) + "@example.test";
      await admin.query("UPDATE cpl_identities SET email=$1,display_name=$1 WHERE id=$2", [
        email,
        value.identityId,
      ]);
      expect((await stage())!.displayName).toHaveLength(254);
      expect(await stage()).toEqual(await store.readSession(tokenHash, now));
    });
  it("unconstrained persisted text fields preserve exact store values within transport byte budget", async () => {
    const v = await seed();
    await admin.query(
      "UPDATE cpl_identities SET issuer=$1,subject=$2,email=$3,display_name=$4 WHERE id=$5",
      ["i".repeat(3000), "s".repeat(1500), "e".repeat(300), "d".repeat(5000), v.identityId],
    );
    expect(await stage()).toEqual(await store.readSession(tokenHash, now));
  });
  for (const [label, change] of [
    ["revoked", "UPDATE cpl_sessions SET revoked_at=now()"],
    ["expired", "UPDATE cpl_sessions SET expires_at='2026-09-23T02:00Z'"],
    ["absoluteExpired", "UPDATE cpl_sessions SET absolute_expires_at='2026-09-23T02:00Z'"],
    ["missingCSRF", "UPDATE cpl_sessions SET csrf_token_hash=NULL"],
    ["inactiveIdentity", "UPDATE cpl_identities SET status='suspended'"],
    ["unverifiedEmail", "UPDATE cpl_identities SET email_verified=false"],
  ])
    it(`${label} returns NULL for both fresh reads`, async () => {
      await seed(true, true);
      await admin.execute(change!);
      expect(await stage()).toBeNull();
      expect(await stage(true)).toBeNull();
      expect(await store.readSession(tokenHash, now)).toBeNull();
    });
  for (const [label, change] of [
    ["suspendedMember", "UPDATE cpl_memberships SET status='suspended'"],
    ["removedMember", "DELETE FROM cpl_memberships"],
    ["suspendedOrg", "UPDATE cpl_organizations SET status='suspended'"],
  ])
    it(`${label} clears selected organization without revoking unrelated session`, async () => {
      await seed(true, true);
      await admin.execute(change!);
      expect((await stage())!.selectedOrganizationId).toBeNull();
      expect(await stage(true)).toEqual(await store.readSessionWithPasskey(tokenHash, now));
    });
  it("forged selected tenant without membership is not represented and unrelated credentials do not count", async () => {
    const v = await seed();
    const other = randomUUID(),
      foreign = randomUUID();
    await admin.query(
      "INSERT INTO cpl_organizations(id,slug,display_name) VALUES($1::uuid,$1::text,'Other')",
      [other],
    );
    await admin.query("UPDATE cpl_sessions SET selected_organization_id=$1", [other]);
    await admin.query(
      "INSERT INTO cpl_identities(id,issuer,subject,display_name) VALUES($1::uuid,'https://example.invalid',$1::text,'Other')",
      [foreign],
    );
    await credential(foreign);
    expect(await stage(true)).toEqual({
      session: {
        ...(await store.readSession(tokenHash, now)),
        identityId: v.identityId,
        selectedOrganizationId: null,
      },
      hasPasskey: false,
    });
  });
  it("revocation and credential removal between calls are visible in second transaction", async () => {
    const v = await seed(true, true);
    expect(await stage()).not.toBeNull();
    await admin.query("DELETE FROM cpl_webauthn_credentials WHERE identity_id=$1", [v.identityId]);
    expect((await stage(true))!.hasPasskey).toBe(false);
    await admin.query("UPDATE cpl_sessions SET revoked_at=now() WHERE id=$1", [v.id]);
    expect(await stage(true)).toBeNull();
  });
  it("no new session row locks: revocation can commit after first read while its transaction remains open", async () => {
    const v = await seed();
    let release!: () => void, reached!: () => void;
    const wait = new Promise<void>((r) => (release = r)),
      read = new Promise<void>((r) => (reached = r));
    const held = web.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      await tx.query(DEADLINE_SQL);
      await tx.query(READ_SQL, [tokenHash, now]);
      reached();
      await wait;
    });
    await read;
    try {
      await admin.transaction(async (tx) => {
        await tx.query("SET LOCAL lock_timeout='1000ms'");
        await tx.query("UPDATE cpl_sessions SET revoked_at=now() WHERE id=$1", [v.id]);
      });
    } finally {
      release();
      await held;
    }
    expect(await stage(true)).toBeNull();
  });
  it("service checks expiry after the function transaction commits", async () => {
    await seed();
    let clock = Date.parse(now);
    const adapter = Object.create(store) as CplHostedAuthStore;
    adapter.readSession = async (hash, time) => {
      const result = await stage(false, hash, time);
      clock = Date.parse("2026-09-23T03:00Z");
      return result;
    };
    adapter.readSessionWithPasskey = async (hash, time) => {
      const result = await stage(true, hash, time);
      clock = Date.parse("2026-09-23T03:00Z");
      return result;
    };
    const service = new CplHostedAuthService(
      adapter,
      {
        authorizationUrl: () => {
          throw Error("UNUSED");
        },
        exchangeCode: async () => {
          throw Error("UNUSED");
        },
      },
      { appOrigin: "https://example.invalid", now: () => new Date(clock) },
    );
    expect(await service.readSession(token)).toBeNull();
    clock = Date.parse(now);
    await expect(service.hasPasskey(token)).rejects.toThrow("CPL_AUTHENTICATION_REQUIRED");
  });
  it("server refuses missing15s deadline or write transaction before reads", async () => {
    await seed();
    await expect(web.query(READ_SQL, [tokenHash, now])).rejects.toThrow(
      "CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED",
    );
    await expect(rawStage(false, tokenHash, now, web, false)).rejects.toThrow(
      "CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED",
    );
  });
  it("worker has no schema/function execution privilege", async () => {
    await seed();
    await expect(rawStage(false, tokenHash, now, worker)).rejects.toMatchObject({ code: "42501" });
  });
  it("input NULL/malformed/overflow refuses without session material", async () => {
    await seed();
    for (const [hash, time] of [
      [null, now],
      ["bad", now],
      [tokenHash, null],
      [tokenHash, "infinity"],
    ])
      await expect(rawStage(false, hash, time)).rejects.toThrow("CPL_AUTHENTICATION_REQUIRED");
    await expect(rawStage(false, tokenHash, "999999999-01-01")).rejects.toBeDefined();
    expect(await stage()).not.toBeNull();
  });
  const drift = [
    ["superuser", "ALTER ROLE cpl_fixture_web SUPERUSER", "ALTER ROLE cpl_fixture_web NOSUPERUSER"],
    ["bypass", "ALTER ROLE cpl_fixture_web BYPASSRLS", "ALTER ROLE cpl_fixture_web NOBYPASSRLS"],
    ["createdb", "ALTER ROLE cpl_fixture_web CREATEDB", "ALTER ROLE cpl_fixture_web NOCREATEDB"],
    [
      "createrole",
      "ALTER ROLE cpl_fixture_web CREATEROLE",
      "ALTER ROLE cpl_fixture_web NOCREATEROLE",
    ],
    [
      "replication",
      "ALTER ROLE cpl_fixture_web REPLICATION",
      "ALTER ROLE cpl_fixture_web NOREPLICATION",
    ],
    [
      "database owner",
      `ALTER DATABASE "${databaseName}" OWNER TO cpl_fixture_web`,
      `ALTER DATABASE "${databaseName}" OWNER TO cpl_fixture_admin`,
    ],
    [
      "schema owner",
      "ALTER SCHEMA public OWNER TO cpl_fixture_web",
      "ALTER SCHEMA public OWNER TO cpl_fixture_admin",
    ],
    [
      "table owner",
      "ALTER TABLE cpl_sessions OWNER TO cpl_fixture_web",
      "ALTER TABLE cpl_sessions OWNER TO cpl_fixture_admin",
    ],
    [
      "forced RLS",
      "ALTER TABLE cpl_organizations NO FORCE ROW LEVEL SECURITY",
      "ALTER TABLE cpl_organizations FORCE ROW LEVEL SECURITY",
    ],
    [
      "RLS",
      "ALTER TABLE cpl_organizations DISABLE ROW LEVEL SECURITY",
      "ALTER TABLE cpl_organizations ENABLE ROW LEVEL SECURITY",
    ],
    [
      "schema create",
      "GRANT CREATE ON SCHEMA public TO cpl_fixture_web",
      "REVOKE CREATE ON SCHEMA public FROM cpl_fixture_web",
    ],
    [
      "elevated inherited role",
      "GRANT pg_monitor TO cpl_fixture_web",
      "REVOKE pg_monitor FROM cpl_fixture_web",
    ],
    [
      "registry mutation",
      "GRANT UPDATE ON cpl_runtime_roles TO cpl_fixture_web",
      "REVOKE UPDATE ON cpl_runtime_roles FROM cpl_fixture_web",
    ],
    [
      "legacy read",
      "GRANT SELECT ON leads TO cpl_fixture_web",
      "REVOKE SELECT ON leads FROM cpl_fixture_web",
    ],
    [
      "wrong purpose",
      "UPDATE cpl_runtime_roles SET purpose='worker' WHERE role_name='cpl_fixture_web'",
      "UPDATE cpl_runtime_roles SET purpose='web' WHERE role_name='cpl_fixture_web'",
    ],
    [
      "missing purpose",
      "DELETE FROM cpl_runtime_roles WHERE role_name='cpl_fixture_web'",
      "INSERT INTO cpl_runtime_roles(role_name,purpose) VALUES('cpl_fixture_web','web')",
    ],
  ];
  for (const [label, change, restore] of drift)
    it(`live guard refuses ${label} after first read before second`, async () => {
      await seed(true, true);
      expect(await stage()).not.toBeNull();
      await admin.execute(change!);
      try {
        await expect(stage(true)).rejects.toThrow("CPL_HOSTED_DATABASE_ROLE_REFUSED");
      } finally {
        await admin.execute(restore!);
        await configureHostedRuntimeRole(admin, "cpl_fixture_web", "web");
      }
    });
  it("same frontend has clean tenant identity and deadlines after COMMIT and ROLLBACK", async () => {
    await seed(true);
    const baseline = (
      await web.query(
        "SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle",
      )
    ).rows[0]!;
    await stage();
    await expect(
      web.transaction(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY");
        await tx.query(DEADLINE_SQL);
        await tx.query(READ_SQL, [tokenHash, now]);
        throw Error("FORCED_ROLLBACK");
      }),
    ).rejects.toThrow("FORCED_ROLLBACK");
    const after = (
      await web.query(
        "SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle,current_setting('cpl.organization_id',true) AS organization,current_setting('cpl.identity_id',true) AS identity",
      )
    ).rows[0]!;
    expect(after).toMatchObject(baseline);
    expect(after.organization ?? "").toBe("");
    expect(after.identity ?? "").toBe("");
  });
  it("read-only enforcement prevents writes and leaves zero new audit/events or session mutation", async () => {
    await seed(true, true);
    const before = (await admin.query("SELECT row_to_json(s) AS value FROM cpl_sessions s")).rows;
    await stage();
    await stage(true);
    await expect(
      web.transaction(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY");
        await tx.query(DEADLINE_SQL);
        await tx.query(READ_SQL, [tokenHash, now]);
        await tx.query("UPDATE cpl_sessions SET revoked_at=now()");
      }),
    ).rejects.toMatchObject({ code: "25006" });
    expect((await admin.query("SELECT row_to_json(s) AS value FROM cpl_sessions s")).rows).toEqual(
      before,
    );
    expect(
      (await admin.query("SELECT count(*)::integer AS count FROM cpl_auth_audit_events")).rows[0]!
        .count,
    ).toBe(0);
  });
});
