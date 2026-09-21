import { nativeWindowsFilesystemMissing } from "../filesystem-capabilities";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyProductionActivation,
  createBuildEnvironment,
  inspectDatabasePrerequisites,
} from "../../scripts/phase134/production-activation.mjs";
import { createProductionPaths } from "../../scripts/phase134/production-paths.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Phase 1.3.4 production activation", () => {
  it("requires active TLS for managed and non-loopback PostgreSQL targets", async () => {
    const database = {
      query: vi.fn(async () => ({
        rows: [
          {
            database_name: "bea",
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
            tls_active: false,
          },
        ],
      })),
    };
    const config = { database: { tlsMode: "prefer" } };
    await expect(
      inspectDatabasePrerequisites(
        database,
        config,
        "existing",
        "postgresql://bea:redacted@db.example.com/bea",
      ),
    ).rejects.toThrow(/TLS policy/iu);
    await expect(
      inspectDatabasePrerequisites(
        database,
        config,
        "existing",
        "postgresql://bea:redacted@127.0.0.1:55432/bea",
      ),
    ).resolves.toMatchObject({ tlsActive: false });
  });

  it("builds without forwarding live database or session secrets", () => {
    const localAppData = mkdtempSync(join(tmpdir(), "bea-phase134-build-env-"));
    temporaryDirectories.push(localAppData);
    const paths = createProductionPaths({ localAppData });
    const environment = createBuildEnvironment(
      {
        database: { tlsMode: "require" },
        appBaseUrl: "https://bea.localhost:3443",
        authentication: { provider: "local-owner" },
        deploymentProfile: "local-live",
        ports: { workerHealth: 3211 },
      },
      paths,
    );
    expect(environment.DATABASE_URL).toContain("build-only");
    expect(environment.DATABASE_URL).toContain("sslmode=require");
    expect(environment.SESSION_SECRET).toContain("build-only-non-secret");
    expect(environment.BEA_DISABLE_ENV_FILE).toBe("true");
  });

  it.skipIf(nativeWindowsFilesystemMissing("reparse points", tmpdir()))(
    "refuses a configured log path escape before activation mutation",
    async () => {
      const localAppData = mkdtempSync(join(tmpdir(), "bea-phase134-activation-paths-"));
      temporaryDirectories.push(localAppData);
      const paths = createProductionPaths({ localAppData });
      mkdirSync(paths.productRoot, { recursive: true });
      const outside = join(localAppData, "outside-log-root");
      const junction = join(paths.productRoot, "configured-log-link");
      mkdirSync(outside);
      symlinkSync(outside, junction, "junction");
      const configuredLogDirectory = join(junction, "logs");
      const submission = {
        databaseChoice: "existing",
        databaseUrl: "postgresql://bea:redacted@127.0.0.1:55432/bea",
        tlsMode: "prefer",
        postgresToolsDirectory: null,
        ownerUsername: "andrew",
        password: "a strong local passphrase",
      };
      const initialConfig = (overrides = {}) => ({
        deploymentProfile: "local-live",
        appBaseUrl: "https://bea.localhost:3443",
        hostname: "bea.localhost",
        ports: {
          web: 3210,
          https: 3443,
          workerHealth: 3211,
          control: 3212,
          setup: 3444,
        },
        database: { driver: "postgres", tlsMode: "prefer", toolsDirectory: null },
        authentication: { provider: "local-owner", ownerUsername: "andrew" },
        https: {
          pfxPath: paths.certificatePfxFile,
          certificateThumbprint: "A".repeat(40),
          notAfter: "2027-08-24T00:00:00.000Z",
        },
        paths: {
          logDirectory: overrides.logDirectory ?? paths.logDirectory,
          backupDirectory: paths.backupDirectory,
          backupRetentionCount: 14,
        },
      });
      const expectPreflightRefusal = async ({ config, stage, category, absentPath }) => {
        const writeConfig = vi.fn();
        const storeSecrets = vi.fn();
        const applyAcl = vi.fn();
        const checkPort = vi.fn(async () => ({ available: true }));
        await expect(
          applyProductionActivation(submission, {
            paths,
            readConfig: () => config,
            writeConfig,
            storeSecrets,
            applyAcl,
            checkPort,
          }),
        ).rejects.toMatchObject({
          evidence: expect.objectContaining({
            AclStage: stage,
            AclFailureCategory: category,
          }),
        });
        expect(existsSync(absentPath)).toBe(false);
        expect(writeConfig).not.toHaveBeenCalled();
        expect(storeSecrets).not.toHaveBeenCalled();
        expect(applyAcl).not.toHaveBeenCalled();
        expect(checkPort).not.toHaveBeenCalled();
      };

      await expectPreflightRefusal({
        config: initialConfig({ logDirectory: configuredLogDirectory }),
        stage: "configured-log-directory-preflight",
        category: "REPARSE_POINT_REFUSED",
        absentPath: configuredLogDirectory,
      });
    },
  );

  it("builds before the one-time Owner and defers final readiness until recovery acknowledgement", async () => {
    const localAppData = mkdtempSync(join(tmpdir(), "bea-phase134-activation-"));
    temporaryDirectories.push(localAppData);
    const paths = createProductionPaths({ localAppData });
    const order = [];
    const config = {
      schemaVersion: 1,
      deploymentProfile: "local-live",
      appBaseUrl: "https://bea.localhost:3443",
      hostname: "bea.localhost",
      ports: { web: 3210, https: 3443, workerHealth: 3211, control: 3212, setup: 3444 },
      database: { driver: "postgres", tlsMode: "prefer", toolsDirectory: null },
      queue: { adapter: "pg-boss" },
      worker: { mode: "serve" },
      authentication: { provider: "local-owner", ownerUsername: "andrew" },
      https: {
        pfxPath: paths.certificatePfxFile,
        certificateThumbprint: "A".repeat(40),
        notAfter: "2027-08-24T00:00:00.000Z",
      },
      paths: {
        logDirectory: paths.logDirectory,
        backupDirectory: paths.backupDirectory,
        backupRetentionCount: 14,
      },
      features: { webSearchEnabled: false, realtimeEnabled: false },
    };
    let databaseUrlStored = false;
    const close = vi.fn(async () => order.push("close"));
    const result = await applyProductionActivation(
      {
        databaseChoice: "existing",
        databaseUrl: "postgresql://bea:redacted@127.0.0.1:55432/bea",
        tlsMode: "prefer",
        postgresToolsDirectory: null,
        ownerUsername: "andrew",
        password: "a strong local passphrase",
      },
      {
        paths,
        readConfig: () => config,
        writeConfig: () => order.push("config"),
        checkPort: async () => ({ available: true }),
        storeSecrets: async (values) => {
          if (values.databaseUrl) databaseUrlStored = true;
          order.push("database-secret");
        },
        readSecrets: () => ({
          sessionSecret: "s".repeat(64),
          databaseUrl: databaseUrlStored
            ? "postgresql://bea:redacted@127.0.0.1:55432/bea"
            : undefined,
        }),
        createDatabase: () => ({
          kind: "postgres",
          query: vi.fn(),
          execute: vi.fn(),
          transaction: vi.fn(),
          health: vi.fn(),
          close,
        }),
        inspectDatabase: async () => order.push("postgres"),
        migrate: async () => order.push("migrate"),
        systemSeed: async () => order.push("system-seed"),
        findOwnerCredential: async () => null,
        verifyEmptyBootstrap: async () => order.push("no-business-records"),
        provisionOwner: async () => {
          order.push("owner");
          return {
            passwordHash: "h".repeat(64),
            recoveryCodeHash: "r".repeat(64),
            recoveryCode: "bea-recovery-once",
          };
        },
        verifyProduction: async () => order.push("verify-production"),
        recordAudit: async () => order.push("audit"),
        queueCheck: async () => order.push("queue"),
        runBuild: (_arguments, buildEnvironment) => {
          expect(buildEnvironment.DATABASE_URL).not.toContain("redacted");
          expect(buildEnvironment.SESSION_SECRET).not.toBe("s".repeat(64));
          order.push("build");
        },
        createManifest: () => ({ manifestVersion: 1 }),
        writeManifest: () => order.push("manifest"),
        writeState: () => order.push("state"),
        applyAcl: async () => undefined,
      },
    );
    expect(result.recoveryCode).toBe("bea-recovery-once");
    expect(order).toEqual([
      "config",
      "database-secret",
      "postgres",
      "migrate",
      "system-seed",
      "no-business-records",
      "build",
      "manifest",
      "owner",
      "close",
    ]);
    await result.finalize();
    expect(order).toEqual([
      "config",
      "database-secret",
      "postgres",
      "migrate",
      "system-seed",
      "no-business-records",
      "build",
      "manifest",
      "owner",
      "close",
      "verify-production",
      "queue",
      "state",
      "audit",
      "close",
    ]);
    await result.finalize();
    expect(order.filter((step) => step === "audit")).toHaveLength(1);
  });
});
