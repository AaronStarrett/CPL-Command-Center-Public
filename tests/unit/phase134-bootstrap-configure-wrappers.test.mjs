import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureProductionBootstrap,
  inspectBootstrapReadiness,
} from "../../scripts/phase134/configure-production.mjs";
import { readProductionConfig } from "../../scripts/phase134/production-config.mjs";
import { validateCertificateMetadata } from "../../scripts/phase134/production-certificate.mjs";
import { createProductionPaths, repositoryRoot } from "../../scripts/phase134/production-paths.mjs";
import { WindowsDpapiCurrentUserProtector } from "../../scripts/phase134/production-secrets.mjs";

const temporaryDirectories = [];
const validateFixtureAclTarget = () => undefined;

class FakeProtector extends WindowsDpapiCurrentUserProtector {
  constructor() {
    super({ platform: "win32" });
  }

  protect(value) {
    return Buffer.from(`protected:${value}`, "utf8").toString("base64");
  }

  unprotect(value) {
    return Buffer.from(value, "base64")
      .toString("utf8")
      .replace(/^protected:/u, "");
  }
}

function fixture() {
  const localAppData = mkdtempSync(join(tmpdir(), "bea-phase134-configure-"));
  temporaryDirectories.push(localAppData);
  const paths = createProductionPaths({ localAppData });
  mkdirSync(paths.secretDirectory, { recursive: true });
  return { paths, protector: new FakeProtector() };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("Phase 1.3.4 resumable Configure-BEA workflow", () => {
  it("is read-only in check mode and reports setup-required fields distinctly", async () => {
    const { paths, protector } = fixture();
    const report = await inspectBootstrapReadiness({
      paths,
      protector,
      validateAclTarget: validateFixtureAclTarget,
      verifyToolchain: () => ({
        ok: true,
        code: "TOOLCHAIN_READY",
        nodeVersion: "24.19.0",
        pnpmVersion: "11.19.0",
      }),
    });
    expect(report).toMatchObject({
      configReady: false,
      secretsReady: false,
      certificateReady: false,
      readyForDatabaseAndOwnerSetup: false,
    });
  });

  it("requires exact owner approval, persists completed steps, and can resume", async () => {
    const { paths, protector } = fixture();
    const verifyToolchain = () => ({
      ok: true,
      code: "TOOLCHAIN_READY",
      nodeVersion: "24.19.0",
      pnpmVersion: "11.19.0",
    });
    const assertBoundary = vi.fn(() => ({ current: repositoryRoot }));
    const validCertificateInspection = {
      trusted: true,
      contractValid: true,
      rootTrusted: true,
      leafPresent: true,
      leafHasPrivateKey: true,
      pfxPresent: true,
      rootCertificatePresent: true,
      renewalWarning: false,
    };
    const inspectCertificateTrust = vi.fn(async () => validCertificateInspection);
    await expect(
      configureProductionBootstrap({
        paths,
        protector,
        validateAclTarget: validateFixtureAclTarget,
        verifyToolchain,
        assertBoundary,
        prompt: async () => "decline",
      }),
    ).rejects.toThrow(/declined/iu);

    const answers = ["CONFIGURE LOCAL LIVE", "TRUST BEA LOCAL ROOT"];
    const prompt = vi.fn(async () => answers.shift());
    const setupCertificate = vi.fn(async () => {
      const persistedMetadata = {
        schemaVersion: 1,
        hostname: "bea.localhost",
        subject: "CN=bea.localhost",
        issuer: "CN=BEA Local Production Root",
        certificateThumbprint: "A".repeat(40),
        rootThumbprint: "B".repeat(40),
        sans: ["bea.localhost", "localhost", "127.0.0.1", "::1"],
        notBefore: "2026-08-24T00:00:00.000Z",
        notAfter: "2027-08-24T00:00:00.000Z",
        trustStore: "Cert:\\CurrentUser\\Root",
        privateKeyStore: "Cert:\\CurrentUser\\My",
        pfxPath: paths.certificatePfxFile,
        rootCertificatePath: paths.certificateRootFile,
      };
      const metadata = validateCertificateMetadata(persistedMetadata, {
        productRoot: paths.productRoot,
        now: new Date("2026-08-24T12:00:00.000Z"),
      });
      mkdirSync(paths.certificateDirectory, { recursive: true });
      writeFileSync(paths.certificateMetadataFile, `${JSON.stringify(persistedMetadata)}\n`);
      return metadata;
    });
    const final = await configureProductionBootstrap({
      paths,
      protector,
      validateAclTarget: validateFixtureAclTarget,
      verifyToolchain,
      assertBoundary,
      prompt,
      setupCertificate,
      inspectCertificateTrust,
      applyAcl: async () => ({ applied: true }),
      ensureAclBootstrap: async () => ({ code: "ALREADY_COMPLIANT" }),
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(final).toMatchObject({
      configReady: true,
      secretsReady: true,
      certificateReady: true,
      readyForDatabaseAndOwnerSetup: true,
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(setupCertificate).toHaveBeenCalledTimes(1);
    const inspectedPfxPassword = inspectCertificateTrust.mock.calls[0][1].pfxPassword;
    expect(inspectedPfxPassword).toEqual(expect.any(String));
    expect(inspectedPfxPassword.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(final)).not.toContain(inspectedPfxPassword);
    expect(readFileSync(paths.setupStateFile, "utf8")).toContain('"certificate": true');
    expect(
      readProductionConfig({
        filePath: paths.configFile,
        productRoot: paths.productRoot,
      }).https.certificateThumbprint,
    ).toBe("A".repeat(40));

    const resumePrompt = vi.fn(async () => "CONFIGURE LOCAL LIVE");
    const resumed = await configureProductionBootstrap({
      paths,
      protector,
      validateAclTarget: validateFixtureAclTarget,
      verifyToolchain,
      assertBoundary,
      prompt: resumePrompt,
      setupCertificate,
      inspectCertificateTrust,
      applyAcl: async () => ({ applied: true }),
      ensureAclBootstrap: async () => ({ code: "ALREADY_COMPLIANT" }),
    });
    expect(resumed.readyForDatabaseAndOwnerSetup).toBe(true);
    expect(resumePrompt).toHaveBeenCalledTimes(1);
    expect(setupCertificate).toHaveBeenCalledTimes(1);

    inspectCertificateTrust
      .mockResolvedValueOnce({
        ...validCertificateInspection,
        trusted: false,
        contractValid: false,
      })
      .mockResolvedValueOnce(validCertificateInspection);
    const repairAnswers = ["CONFIGURE LOCAL LIVE", "TRUST BEA LOCAL ROOT"];
    const repaired = await configureProductionBootstrap({
      paths,
      protector,
      validateAclTarget: validateFixtureAclTarget,
      verifyToolchain,
      assertBoundary,
      prompt: async () => repairAnswers.shift(),
      setupCertificate,
      inspectCertificateTrust,
      applyAcl: async () => ({ applied: true }),
      ensureAclBootstrap: async () => ({ code: "ALREADY_COMPLIANT" }),
    });
    expect(repaired.readyForDatabaseAndOwnerSetup).toBe(true);
    expect(setupCertificate).toHaveBeenCalledTimes(2);

    inspectCertificateTrust
      .mockRejectedValueOnce(new Error("synthetic PFX inspection failure"))
      .mockResolvedValueOnce(validCertificateInspection);
    const failedInspectionRepairAnswers = ["CONFIGURE LOCAL LIVE", "TRUST BEA LOCAL ROOT"];
    const recovered = await configureProductionBootstrap({
      paths,
      protector,
      validateAclTarget: validateFixtureAclTarget,
      verifyToolchain,
      assertBoundary,
      prompt: async () => failedInspectionRepairAnswers.shift(),
      setupCertificate,
      inspectCertificateTrust,
      applyAcl: async () => ({ applied: true }),
      ensureAclBootstrap: async () => ({ code: "ALREADY_COMPLIANT" }),
    });
    expect(recovered.readyForDatabaseAndOwnerSetup).toBe(true);
    expect(setupCertificate).toHaveBeenCalledTimes(3);
  }, 60_000);

  it("preserves invalid existing configuration and fails before prompting", async () => {
    const { paths, protector } = fixture();
    mkdirSync(paths.configDirectory, { recursive: true });
    const invalid = '{"schemaVersion":999,"doNotOverwrite":true}\n';
    writeFileSync(paths.configFile, invalid);
    const prompt = vi.fn(async () => "CONFIGURE LOCAL LIVE");
    await expect(
      configureProductionBootstrap({
        paths,
        protector,
        validateAclTarget: validateFixtureAclTarget,
        verifyToolchain: () => ({
          ok: true,
          code: "TOOLCHAIN_READY",
          nodeVersion: "24.19.0",
          pnpmVersion: "11.19.0",
        }),
        assertBoundary: () => ({ current: repositoryRoot }),
        prompt,
      }),
    ).rejects.toThrow(/preserved because it is invalid/iu);
    expect(readFileSync(paths.configFile, "utf8")).toBe(invalid);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("Phase 1.3.4 owner wrappers", () => {
  it("bootstraps through repository-owned PowerShell and invokes only absolute pinned Node", () => {
    const configure = readFileSync(join(repositoryRoot, "Configure-BEA.cmd"), "utf8");
    const ensure = readFileSync(join(repositoryRoot, "Ensure-BEA-Toolchain.cmd"), "utf8");
    const powershell = readFileSync(
      join(repositoryRoot, "scripts", "phase134", "ensure-toolchain.ps1"),
      "utf8",
    );
    expect(configure).toContain("%LOCALAPPDATA%\\BEA\\CommandCenter\\toolchain");
    expect(configure).toContain('"%BEA_NODE%" scripts\\repository-boundary.mjs');
    expect(configure).not.toMatch(/^node\s/imu);
    expect(ensure).toContain("-ExecutionPolicy Bypass");
    expect(ensure).not.toMatch(/^node\s/imu);
    expect(powershell).toContain("https://nodejs.org/dist/v$ExpectedNodeVersion/");
    expect(powershell).toContain("Get-FileHash");
    expect(powershell).toContain("checksum mismatch");
    expect(powershell).toContain("COREPACK_HOME");
    expect(powershell).toContain("PNPM_HOME");
    expect(powershell).toContain("BEA_TOOLCHAIN_STATUS=");
    expect(powershell).toContain("$PnpmOutput = @(& $PnpmExecutable --version");
    expect(powershell).not.toMatch(/& \$PnpmExecutable[^\n]+\|\s*Select-Object\s+-First/iu);
    expect(powershell).toContain('"$NodeExecutable`" `"$CorepackJavaScript`" pnpm %*"');
    expect(powershell).toContain("SetAccessRuleProtection($true, $false)");
    expect(powershell).toContain("[IO.Directory]::SetAccessControl($ToolchainRoot");
    expect(powershell).not.toContain("icacls.exe");
    expect(powershell).not.toMatch(/setx|machine.*path|EnvironmentVariableTarget.*Machine/iu);
  });
});
