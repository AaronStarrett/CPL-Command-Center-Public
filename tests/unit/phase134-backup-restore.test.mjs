import { nativeWindowsFilesystemMissing } from "../filesystem-capabilities";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  applyBackupRetention,
  createBackupPlan,
  createProductionBackup,
  inspectBackupDatabase,
} from "../../scripts/phase134/database-backup.mjs";
import {
  acquireRestoreMaintenanceLock,
  assertRestoreRuntimeStopped,
  createRestorePlan,
  validateRestoreArchive,
} from "../../scripts/phase134/database-restore.mjs";
import { resolvePostgresTools } from "../../scripts/phase134/postgres-tools.mjs";
import { createProductionPaths } from "../../scripts/phase134/production-paths.mjs";

function config(backupDirectory) {
  return {
    database: { driver: "postgres", tlsMode: "require", toolsDirectory: null },
    paths: { backupDirectory, backupRetentionCount: 2 },
  };
}

describe("Phase 1.3.4 PostgreSQL backup and restore", () => {
  it("keeps credentials out of pg_dump/pg_restore arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "bea-backup-plan-"));
    const databaseUrl = "postgresql://bea_app:top-secret@127.0.0.1:5433/bea_production";
    const backup = createBackupPlan(
      config(root),
      databaseUrl,
      { pgDump: "C:\\PostgreSQL\\bin\\pg_dump.exe" },
      { now: new Date("2026-08-24T12:34:56.789Z"), environment: {} },
    );
    expect(JSON.stringify(backup.arguments)).not.toContain("top-secret");
    expect(backup.connectionEnvironment).toMatchObject({
      PGDATABASE: "bea_production",
      PGHOST: "127.0.0.1",
      PGPASSWORD: "top-secret",
      PGPORT: "5433",
      PGSSLMODE: "require",
      PGUSER: "bea_app",
    });
    const restore = createRestorePlan(
      config(root),
      databaseUrl,
      { pgRestore: "C:\\PostgreSQL\\bin\\pg_restore.exe" },
      { archive: join(root, "backup.dump"), manifest: { databaseName: "bea_production" } },
    );
    expect(JSON.stringify(restore.arguments)).not.toContain("top-secret");
    expect(restore.arguments).toContain("bea_production");
    expect(restore.arguments).toContain("--single-transaction");
  });

  it.skipIf(nativeWindowsFilesystemMissing("reparse points", tmpdir()))(
    "refuses a configured backup path through an in-root junction before backup mutation",
    async () => {
      const localAppData = mkdtempSync(join(tmpdir(), "bea-backup-junction-"));
      try {
        const paths = createProductionPaths({ localAppData });
        mkdirSync(paths.productRoot, { recursive: true });
        const outside = join(localAppData, "outside-backup-root");
        const junction = join(paths.productRoot, "configured-backup-link");
        mkdirSync(outside);
        symlinkSync(outside, junction, "junction");
        const configuredBackupDirectory = join(junction, "archives");
        const readSecrets = vi.fn();
        const resolveTools = vi.fn();
        const applyAcl = vi.fn();
        const inspectDatabase = vi.fn();
        const runTool = vi.fn();

        await expect(
          createProductionBackup(
            { quiet: true },
            {
              paths,
              assertBoundary: vi.fn(),
              readConfig: () => config(configuredBackupDirectory),
              readSecrets,
              resolveTools,
              applyAcl,
              inspectDatabase,
              runTool,
            },
          ),
        ).rejects.toMatchObject({
          evidence: expect.objectContaining({
            AclStage: "configured-backup-directory-preflight",
            AclFailureCategory: "REPARSE_POINT_REFUSED",
          }),
        });
        expect(existsSync(configuredBackupDirectory)).toBe(false);
        expect(readSecrets).not.toHaveBeenCalled();
        expect(resolveTools).not.toHaveBeenCalled();
        expect(applyAcl).not.toHaveBeenCalled();
        expect(inspectDatabase).not.toHaveBeenCalled();
        expect(runTool).not.toHaveBeenCalled();
      } finally {
        rmSync(localAppData, { recursive: true, force: true });
      }
    },
  );

  it("forces the configured TLS policy before backup metadata queries", async () => {
    const root = mkdtempSync(join(tmpdir(), "bea-backup-inspection-"));
    let poolOptions;
    let queryNumber = 0;
    class Pool {
      constructor(options) {
        poolOptions = options;
      }

      async query() {
        queryNumber += 1;
        if (queryNumber === 1) {
          return {
            rows: [
              {
                database_name: "bea_production",
                role_name: "bea_app",
                server_version_num: 160_000,
                rolsuper: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolbypassrls: false,
                rolreplication: false,
                owns_database: false,
                has_elevated_membership: false,
                can_connect: true,
                can_use_schema: true,
                can_create_schema_objects: true,
                tls_active: true,
              },
            ],
          };
        }
        if (queryNumber === 2) {
          return { rows: [{ database_name: "bea_production", server_version: "16.4" }] };
        }
        return { rows: [{ id: "0010_phase1_3_4_local_owner.sql" }] };
      }

      async end() {}
    }
    await expect(
      inspectBackupDatabase(
        config(root),
        "postgresql://bea_app:secret@db.example.com/bea_production?sslmode=disable",
        { pgModule: { Pool } },
      ),
    ).resolves.toMatchObject({
      databaseName: "bea_production",
      migrationVersion: "0010_phase1_3_4_local_owner",
    });
    expect(poolOptions.connectionString).toContain("sslmode=require");
    expect(poolOptions.connectionString).not.toContain("sslmode=disable");
  });

  it("validates archive checksum/known migration and applies bounded retention", () => {
    const root = mkdtempSync(join(tmpdir(), "bea-backup-retention-"));
    mkdirSync(root, { recursive: true });
    const names = [
      "bea-production-20260824120000-001.dump",
      "bea-production-20260824120001-001.dump",
      "bea-production-20260824120002-001.dump",
    ];
    names.forEach((name, index) => {
      const path = join(root, name);
      writeFileSync(path, `archive-${String(index)}`);
      writeFileSync(`${path}.manifest.json`, "{}");
      const time = new Date(2026, 7, 24, 12, 0, index);
      utimesSync(path, time, time);
    });
    expect(applyBackupRetention(root, 2)).toEqual([names[0]]);

    const archive = join(root, names[2]);
    const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(
      `${archive}.manifest.json`,
      JSON.stringify({
        schemaVersion: 1,
        archiveFile: names[2],
        archiveSha256: checksum,
        migrationVersion: "0001_phase0_foundation",
        databaseName: "bea_production",
      }),
    );
    expect(validateRestoreArchive(archive, config(root)).manifest.databaseName).toBe(
      "bea_production",
    );
    writeFileSync(archive, "corrupted");
    expect(() => validateRestoreArchive(archive, config(root))).toThrow(/checksum/u);
  });

  it("uses only co-located signed supported PostgreSQL tools and never PATH fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "bea-postgres-tools-"));
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pg_dump.exe"), "fixture");
    writeFileSync(join(bin, "pg_restore.exe"), "fixture");
    const tools = resolvePostgresTools(
      { database: { toolsDirectory: bin } },
      {
        environment: { PATH: root, ProgramFiles: join(root, "elsewhere") },
        inspectVersion: () => ({ major: 16, version: "16.4" }),
        inspectSignature: () => ({
          status: "Valid",
          publisher: "CN=EnterpriseDB Corporation, O=EnterpriseDB Corporation",
        }),
      },
    );
    expect(tools).toMatchObject({ directory: bin, majorVersion: 16 });
    expect(() =>
      resolvePostgresTools(
        { database: { toolsDirectory: null } },
        { environment: { PATH: bin, ProgramFiles: join(root, "missing") } },
      ),
    ).toThrow(/required/iu);
  });

  it("blocks restore unless metadata, lock, and every configured port prove stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "bea-restore-stop-"));
    const paths = {
      runtimeMetadataFile: join(root, "production-process.json"),
      runtimeLockFile: join(root, "production.lock"),
    };
    const productionConfig = {
      ports: { web: 3210, https: 3443, workerHealth: 3211, control: 3212, setup: 3444 },
    };
    await expect(
      assertRestoreRuntimeStopped(productionConfig, paths, {
        readMetadata: () => ({ exists: false }),
        exists: () => false,
        checkPort: async () => ({ available: true }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertRestoreRuntimeStopped(productionConfig, paths, {
        readMetadata: () => ({ exists: false }),
        exists: () => false,
        checkPort: async (port) => ({ available: port !== 3443 }),
      }),
    ).rejects.toThrow(/port https is occupied/iu);
  });

  it("holds an exclusive maintenance lock for the complete restore window", () => {
    const root = mkdtempSync(join(tmpdir(), "bea-restore-lock-"));
    const paths = {
      runtimeMetadataFile: join(root, "production-process.json"),
      runtimeLockFile: join(root, "production.lock"),
    };
    const maintenance = acquireRestoreMaintenanceLock(paths, {
      pid: 4242,
      nonce: "phase134-maintenance-lock-nonce",
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(existsSync(paths.runtimeLockFile)).toBe(true);
    expect(() => acquireRestoreMaintenanceLock(paths)).toThrow(/could not be acquired/iu);
    maintenance.release();
    expect(existsSync(paths.runtimeLockFile)).toBe(false);
  });
});
