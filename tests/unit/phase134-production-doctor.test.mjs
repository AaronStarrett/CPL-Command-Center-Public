import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  aclIsRestricted,
  collectProductionDoctorReport,
} from "../../scripts/phase134/production-doctor.mjs";
import {
  createProductionPaths,
  productionPaths,
} from "../../scripts/phase134/production-paths.mjs";

function emptySecretStatus() {
  return {
    available: true,
    schemaVersion: 1,
    protection: "windows-dpapi-current-user",
    records: Object.fromEntries(
      ["sessionSecret", "databaseUrl", "openAiApiKey", "httpsPfxPassword", "controlToken"].map(
        (key) => [key, { configured: false, fingerprint: null, updatedAt: null }],
      ),
    ),
  };
}

describe("Phase 1.3.4 Production Doctor", () => {
  it("executes the canonical pnpm batch wrapper through the Windows command processor", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "bea doctor batch pnpm "));
    try {
      const paths = createProductionPaths({ localAppData: temporary });
      mkdirSync(paths.nodeDirectory, { recursive: true });
      mkdirSync(join(paths.pnpmExecutable, ".."), { recursive: true });
      copyFileSync(process.execPath, paths.nodeExecutable);
      writeFileSync(paths.pnpmExecutable, "@echo off\r\necho 11.19.0\r\nexit /b 0\r\n");
      const report = await collectProductionDoctorReport({
        paths,
        platform: "win32",
        nodeVersion: "v24.19.0",
        assertBoundary: () => ({ current: productionPaths.repositoryRoot }),
        readSecretStatus: () => emptySecretStatus(),
      });
      expect(report.checks.find((check) => check.name === "Isolated pnpm")).toMatchObject({
        status: "PASS",
        detail: `pnpm 11.19.0 at ${paths.pnpmExecutable}`,
      });
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("separates OpenAI Setup Required from genuine startup blockers", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "bea-doctor-"));
    const pnpmExecutable = join(temporary, "pnpm.cmd");
    writeFileSync(pnpmExecutable, "test");
    const paths = {
      ...productionPaths,
      pnpmExecutable,
      configFile: join(temporary, "missing-production.json"),
      secretFile: join(temporary, "missing-secrets.json"),
    };
    const report = await collectProductionDoctorReport({
      paths,
      platform: "win32",
      nodeVersion: "v24.19.0",
      assertBoundary: () => ({ current: productionPaths.repositoryRoot }),
      readSecretStatus: () => emptySecretStatus(),
      run: (command) =>
        command === pnpmExecutable
          ? { exitCode: 0, stdout: "11.19.0", stderr: "" }
          : { exitCode: 0, stdout: "git version test", stderr: "" },
    });
    const openAi = report.checks.find((check) => check.name === "OpenAI");
    const config = report.checks.find((check) => check.name === "Production config");
    expect(openAi).toMatchObject({ status: "SETUP REQUIRED", startBlocker: false });
    expect(config).toMatchObject({ status: "SETUP REQUIRED", startBlocker: true });
    expect(report.checks.find((check) => check.name === "OpenAI provider test")?.status).toBe(
      "NOT RUN",
    );
  });

  it("rejects ACLs that retain broad Windows principals", () => {
    expect(aclIsRestricted("NT AUTHORITY\\SYSTEM:(F)\nDESKTOP\\SyntheticOwner:(F)")).toBe(true);
    expect(aclIsRestricted("BUILTIN\\Users:(RX)\nDESKTOP\\SyntheticOwner:(F)")).toBe(false);
    expect(aclIsRestricted("Everyone:(F)")).toBe(false);
  });

  it("passes HTTPS only after the shared live certificate contract validates", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "bea-doctor-certificate-"));
    const paths = createProductionPaths({ localAppData: temporary });
    mkdirSync(paths.certificateDirectory, { recursive: true });
    mkdirSync(paths.runtimeDirectory, { recursive: true });
    const pnpmExecutable = paths.pnpmExecutable;
    mkdirSync(join(pnpmExecutable, ".."), { recursive: true });
    writeFileSync(pnpmExecutable, "test");
    const notAfter = "2027-08-24T00:00:00.000Z";
    writeFileSync(
      paths.certificateMetadataFile,
      `${JSON.stringify({
        schemaVersion: 1,
        hostname: "bea.localhost",
        subject: "CN=bea.localhost",
        issuer: "CN=BEA Local Production Root",
        certificateThumbprint: "A".repeat(40),
        rootThumbprint: "B".repeat(40),
        sans: ["bea.localhost", "localhost", "127.0.0.1", "::1"],
        notBefore: "2026-08-23T00:00:00.000Z",
        notAfter,
        trustStore: "Cert:\\CurrentUser\\Root",
        privateKeyStore: "Cert:\\CurrentUser\\My",
        pfxPath: paths.certificatePfxFile,
        rootCertificatePath: paths.certificateRootFile,
      })}\n`,
    );
    writeFileSync(paths.certificatePfxFile, "synthetic encrypted PFX fixture");
    const status = emptySecretStatus();
    for (const key of ["sessionSecret", "databaseUrl", "httpsPfxPassword", "controlToken"]) {
      status.records[key].configured = true;
    }
    const inspectCertificateTrust = vi.fn(async (_metadata, options) => ({
      contractValid: options.pfxPassword === "p".repeat(48),
      renewalWarning: false,
      notAfter,
      daysUntilExpiration: 365,
    }));
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
        notAfter,
      },
      paths: {
        logDirectory: paths.logDirectory,
        backupDirectory: paths.backupDirectory,
        backupRetentionCount: 14,
      },
      features: { webSearchEnabled: false, realtimeEnabled: false },
    };
    const report = await collectProductionDoctorReport({
      paths,
      platform: "win32",
      nodeVersion: "v24.19.0",
      assertBoundary: () => ({ current: productionPaths.repositoryRoot }),
      readConfig: () => config,
      readSecretStatus: () => status,
      readSecrets: () => ({ httpsPfxPassword: "p".repeat(48) }),
      inspectCertificateTrust,
      inspectAcl: (path) => ({ exactRestricted: path !== paths.certificatePfxFile }),
      checkPort: async () => ({ available: true }),
      run: (command) =>
        command === pnpmExecutable
          ? { exitCode: 0, stdout: "11.19.0", stderr: "" }
          : { exitCode: 0, stdout: "git version test", stderr: "" },
    });
    expect(report.checks.find((check) => check.name === "Trusted local HTTPS")).toMatchObject({
      status: "PASS",
      startBlocker: false,
    });
    expect(inspectCertificateTrust).toHaveBeenCalledOnce();
    expect(report.checks.find((check) => check.name === "Certificate PFX ACL")).toMatchObject({
      status: "BLOCKED",
      startBlocker: true,
    });
  });
});
