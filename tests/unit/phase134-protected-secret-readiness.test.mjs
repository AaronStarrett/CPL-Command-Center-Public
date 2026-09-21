import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WindowsDpapiCurrentUserProtector as RuntimeWindowsDpapiCurrentUserProtector } from "../../packages/config/src/secrets.ts";
import { configureProductionBootstrap } from "../../scripts/phase134/configure-production.mjs";
import { createDefaultProductionConfig } from "../../scripts/phase134/production-config.mjs";
import { createProductionPaths } from "../../scripts/phase134/production-paths.mjs";
import {
  DPAPI_CURRENT_USER_READINESS_HELPER,
  WINDOWS_DPAPI_POWERSHELL_EXECUTABLE,
  assertProtectedSecretReadiness,
  inspectProtectedSecretReadiness,
  storeProductionSecrets,
} from "../../scripts/phase134/production-secrets.mjs";
import { resolveCurrentUserSid } from "../../scripts/phase134/windows-acl.mjs";

const CURRENT_SID = "S-1-5-21-100-200-300-1001";
const OTHER_SID = "S-1-5-21-100-200-300-1002";
const temporaryDirectories = [];

function fixture({ createSecretsDirectory = true } = {}) {
  const localAppData = mkdtempSync(join(tmpdir(), "bea-phase134-secret-readiness-"));
  temporaryDirectories.push(localAppData);
  const paths = createProductionPaths({ localAppData });
  mkdirSync(paths.productRoot, { recursive: true });
  if (createSecretsDirectory) mkdirSync(paths.secretDirectory);
  return { localAppData, paths };
}

function helperEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "windows-dpapi-current-user",
    runtimeExecutable: WINDOWS_DPAPI_POWERSHELL_EXECUTABLE,
    runtimeVersion: "5.1.26100.9168",
    currentUserSid: CURRENT_SID,
    currentTokenElevated: false,
    userProfileLoaded: true,
    protectSucceeded: true,
    unprotectSucceeded: true,
    roundTripMatched: true,
    probePersisted: false,
    probeOutput: false,
    failureCategory: "NONE",
    ...overrides,
  };
}

function helperResult(overrides = {}, exitCode = 0) {
  return {
    exitCode,
    stdout: JSON.stringify(helperEvidence(overrides)),
    stderr: "",
  };
}

function readinessOptions(paths, overrides = {}) {
  return {
    paths,
    platform: "win32",
    intendedUserSid: CURRENT_SID,
    toolchain: {
      ok: true,
      nodeReady: true,
      nodePath: paths.nodeExecutable,
      nodeVersion: "24.19.0",
    },
    currentNodeExecutable: paths.nodeExecutable,
    currentNodeVersion: "v24.19.0",
    helperExists: () => true,
    inspectAcl: () => ({ exactProtected: true }),
    runReadinessHelper: () => helperResult(),
    ...overrides,
  };
}

function secretStatus({ configured = false, available = true } = {}) {
  return {
    available,
    schemaVersion: 1,
    protection: "windows-dpapi-current-user",
    records: Object.freeze(
      Object.fromEntries(
        ["sessionSecret", "databaseUrl", "openAiApiKey", "httpsPfxPassword", "controlToken"].map(
          (key) => [
            key,
            Object.freeze({ present: configured, configured, fingerprint: null, updatedAt: null }),
          ],
        ),
      ),
    ),
  };
}

function readyEvidence(paths) {
  return {
    Ready: true,
    SecretProvider: "windows-dpapi-current-user",
    IntendedUserSid: CURRENT_SID,
    CurrentUserSid: CURRENT_SID,
    CurrentTokenElevated: false,
    UserProfileLoaded: true,
    ProductRoot: paths.productRoot,
    SecretsDirectory: paths.secretDirectory,
    SecretsDirectoryExists: true,
    SecretsDirectoryAclReady: true,
    DpapiHelperPath: DPAPI_CURRENT_USER_READINESS_HELPER,
    DpapiHelperExecutable: WINDOWS_DPAPI_POWERSHELL_EXECUTABLE,
    DpapiHelperRuntime: "WINDOWS_POWERSHELL_DOTNET_DPAPI_CURRENT_USER",
    DpapiHelperRuntimeVersion: "5.1.26100.9168",
    DpapiHelperExitCode: 0,
    DpapiFailureCategory: "NONE",
    DpapiProtectSucceeded: true,
    DpapiUnprotectSucceeded: true,
    DpapiRoundTripMatched: true,
    DpapiProbePersisted: false,
    DpapiProbeOutput: false,
    CanonicalNodeExecutable: paths.nodeExecutable,
    CanonicalNodeVersion: "24.19.0",
    CanonicalNodeReady: true,
  };
}

function configureFixture(paths, overrides = {}) {
  let configured = false;
  let config;
  const promptAnswers = ["CONFIGURE LOCAL LIVE", ""];
  return {
    paths,
    platform: "win32",
    assertBoundary: () => ({ protectedRepositoryEntered: false }),
    validateAclTarget: () => ({ target: paths.productRoot }),
    verifyToolchain: () => ({
      ok: true,
      code: "TOOLCHAIN_READY",
      nodeReady: true,
      nodePath: paths.nodeExecutable,
      nodeVersion: "24.19.0",
      pnpmReady: true,
      pnpmVersion: "11.19.0",
    }),
    readConfig: () => config,
    writeConfig: (value) => {
      config = value;
    },
    createDefaultConfig: () => createDefaultProductionConfig({ paths }),
    readStatus: (options) =>
      secretStatus({ configured, available: options.probe === false ? false : true }),
    storeSecrets: async () => {
      configured = true;
      return secretStatus({ configured: true });
    },
    readCertificate: () => undefined,
    prompt: async () => promptAnswers.shift(),
    ensureAclBootstrap: async () => ({ code: "ALREADY_COMPLIANT", currentUserSid: CURRENT_SID }),
    assertSecretReadiness: () => readyEvidence(paths),
    applyAcl: async () => ({ code: "ALREADY_COMPLIANT" }),
    writeState: () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Phase 1.3.4 protected-secret readiness", () => {
  it("01. performs a real normal-user CurrentUser DPAPI round trip with safe evidence", () => {
    const temporary = fixture();
    const paths = { ...temporary.paths, nodeExecutable: process.execPath };
    const currentSid = resolveCurrentUserSid();
    const evidence = assertProtectedSecretReadiness({
      paths,
      platform: "win32",
      intendedUserSid: currentSid,
      toolchain: {
        ok: true,
        nodeReady: true,
        nodePath: process.execPath,
        nodeVersion: process.version.replace(/^v/u, ""),
      },
      inspectAcl: () => ({ exactProtected: true }),
      environment: {
        ...process.env,
        PSModulePath: "C:\\hostile-powershell7-modules",
      },
    });
    expect(evidence).toMatchObject({
      Ready: true,
      SecretProvider: "windows-dpapi-current-user",
      IntendedUserSid: currentSid,
      CurrentUserSid: currentSid,
      CurrentTokenElevated: false,
      UserProfileLoaded: true,
      DpapiProtectSucceeded: true,
      DpapiUnprotectSucceeded: true,
      DpapiRoundTripMatched: true,
      DpapiProbePersisted: false,
      DpapiProbeOutput: false,
      FailureBeforeSecretWrite: false,
      ProductionSecretGenerated: false,
      CanonicalNodeExecutable: process.execPath,
      CanonicalNodeVersion: "24.19.0",
    });
    expect(readdirSync(paths.secretDirectory)).toEqual([]);

    const runtimeProtector = new RuntimeWindowsDpapiCurrentUserProtector();
    const runtimeProbe = `phase134-runtime-dpapi-${process.pid}-${Date.now()}`;
    const runtimeCiphertext = runtimeProtector.protect(runtimeProbe);
    expect(runtimeCiphertext).not.toContain(runtimeProbe);
    expect(runtimeProtector.unprotect(runtimeCiphertext)).toBe(runtimeProbe);
  }, 15_000);

  it("02. refuses a missing secrets directory before invoking the helper", () => {
    const { paths } = fixture({ createSecretsDirectory: false });
    const runReadinessHelper = vi.fn();
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, { runReadinessHelper }),
    );
    expect(evidence).toMatchObject({
      Ready: false,
      SecretsDirectoryExists: false,
      DpapiFailureCategory: "SECRETS_DIRECTORY_MISSING",
    });
    expect(runReadinessHelper).not.toHaveBeenCalled();
  });

  it("03. creates all six secure directories in final order before the readiness probe", async () => {
    const { paths } = fixture({ createSecretsDirectory: false });
    const order = [];
    const directories = [
      paths.configDirectory,
      paths.secretDirectory,
      paths.runtimeDirectory,
      paths.logDirectory,
      paths.certificateDirectory,
      paths.backupDirectory,
    ];
    const options = configureFixture(paths, {
      ensureAclBootstrap: async () => {
        for (const directory of directories) {
          mkdirSync(directory, { recursive: true });
          order.push(directory);
        }
        return { code: "REPAIRED", currentUserSid: CURRENT_SID };
      },
      assertSecretReadiness: () => {
        expect(directories.every((directory) => existsSync(directory))).toBe(true);
        order.push("DPAPI_PROBE");
        return readyEvidence(paths);
      },
    });
    await configureProductionBootstrap(options);
    expect(order).toEqual([...directories, "DPAPI_PROBE"]);
  });

  it("04. refuses an incorrect secrets-directory ACL", () => {
    const { paths } = fixture();
    const runReadinessHelper = vi.fn();
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        inspectAcl: () => ({ exactProtected: false }),
        runReadinessHelper,
      }),
    );
    expect(evidence.DpapiFailureCategory).toBe("SECRETS_DIRECTORY_ACL_NOT_READY");
    expect(runReadinessHelper).not.toHaveBeenCalled();
  });

  it("05. accepts only the correct protected secrets-directory ACL evidence", () => {
    const { paths } = fixture();
    const inspectAcl = vi.fn(() => ({ exactProtected: true }));
    const evidence = inspectProtectedSecretReadiness(readinessOptions(paths, { inspectAcl }));
    expect(evidence.SecretsDirectoryAclReady).toBe(true);
    expect(inspectAcl).toHaveBeenCalledWith(
      paths.secretDirectory,
      expect.objectContaining({ allowInherited: false, currentUserSid: CURRENT_SID }),
    );
  });

  it("06. fails closed when the current user profile is unavailable", () => {
    const { paths } = fixture();
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        runReadinessHelper: () =>
          helperResult(
            {
              userProfileLoaded: false,
              protectSucceeded: false,
              unprotectSucceeded: false,
              roundTripMatched: false,
              failureCategory: "USER_PROFILE_UNAVAILABLE",
            },
            5,
          ),
      }),
    );
    expect(evidence).toMatchObject({
      Ready: false,
      UserProfileLoaded: false,
      DpapiFailureCategory: "USER_PROFILE_UNAVAILABLE",
    });
  });

  it("07. fails closed when intended and current Windows SIDs differ", () => {
    const { paths } = fixture();
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        runReadinessHelper: () =>
          helperResult(
            {
              currentUserSid: OTHER_SID,
              protectSucceeded: false,
              unprotectSucceeded: false,
              roundTripMatched: false,
              failureCategory: "IDENTITY_MISMATCH",
            },
            4,
          ),
      }),
    );
    expect(evidence).toMatchObject({
      Ready: false,
      IntendedUserSid: CURRENT_SID,
      CurrentUserSid: OTHER_SID,
      DpapiFailureCategory: "IDENTITY_MISMATCH",
    });
  });

  it("08. ignores ambient Node 20 and invokes no PATH-resolved Node process", () => {
    const { paths } = fixture();
    const runReadinessHelper = vi.fn(() => helperResult());
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        ambientNodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        ambientNodeVersion: "v20.12.2",
        environment: { PATH: "C:\\Program Files\\nodejs" },
        runReadinessHelper,
      }),
    );
    expect(evidence).toMatchObject({ Ready: true, CanonicalNodeReady: true });
    expect(runReadinessHelper.mock.calls[0][0]).toBe(WINDOWS_DPAPI_POWERSHELL_EXECUTABLE);
    expect(JSON.stringify(runReadinessHelper.mock.calls[0])).not.toContain("nodejs\\node.exe");
  });

  it("09. requires the canonical Node 24 runtime evidence before using the helper", () => {
    const { paths } = fixture();
    const runReadinessHelper = vi.fn(() => helperResult());
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        currentNodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        currentNodeVersion: "v20.12.2",
        runReadinessHelper,
      }),
    );
    expect(evidence).toMatchObject({
      Ready: false,
      CanonicalNodeExecutable: paths.nodeExecutable,
      CanonicalNodeVersion: "24.19.0",
      CanonicalNodeReady: false,
      DpapiFailureCategory: "CANONICAL_NODE_REQUIRED",
    });
    expect(runReadinessHelper).not.toHaveBeenCalled();

    const moduleUrl = new URL("../../scripts/phase134/production-secrets.mjs", import.meta.url)
      .href;
    const hostileSystemRootProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const module = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(module.WINDOWS_DPAPI_POWERSHELL_EXECUTABLE);`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, SystemRoot: "C:\\hostile-system-root" },
        shell: false,
        windowsHide: true,
      },
    );
    expect(hostileSystemRootProbe.status).toBe(0);
    expect(hostileSystemRootProbe.stdout).toBe(WINDOWS_DPAPI_POWERSHELL_EXECUTABLE);

    const reparseRunner = vi.fn(() => helperResult());
    const reparseEvidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        powershellLstat: () => ({
          isFile: () => false,
          isSymbolicLink: () => true,
        }),
        runReadinessHelper: reparseRunner,
      }),
    );
    expect(reparseEvidence.DpapiFailureCategory).toBe("HELPER_RUNTIME_REFUSED");
    expect(reparseRunner).not.toHaveBeenCalled();
  });

  it("10. reports an unavailable absolute helper before process launch", () => {
    const { paths } = fixture();
    const runReadinessHelper = vi.fn();
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, { helperExists: () => false, runReadinessHelper }),
    );
    expect(evidence.DpapiFailureCategory).toBe("DPAPI_HELPER_UNAVAILABLE");
    expect(isAbsolute(evidence.DpapiHelperPath)).toBe(true);
    expect(runReadinessHelper).not.toHaveBeenCalled();
  });

  it("11. preserves a helper nonzero exit code without exposing stderr", () => {
    const { paths } = fixture();
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        runReadinessHelper: () => ({
          exitCode: 27,
          stdout: "",
          stderr: "sensitive child diagnostics must not escape",
        }),
      }),
    );
    expect(evidence).toMatchObject({
      Ready: false,
      DpapiHelperExitCode: 27,
      DpapiFailureCategory: "HELPER_NONZERO_EXIT",
    });
    expect(JSON.stringify(evidence)).not.toContain("sensitive child diagnostics");

    for (const [failureCategory, exitCode] of [
      ["MALFORMED_HELPER_INPUT", 2],
      ["IDENTITY_UNAVAILABLE", 3],
      ["HELPER_INTERNAL_FAILURE", 16],
    ]) {
      const earlyFailure = inspectProtectedSecretReadiness(
        readinessOptions(paths, {
          runReadinessHelper: () =>
            helperResult(
              {
                currentUserSid: "UNKNOWN",
                currentTokenElevated: null,
                userProfileLoaded: false,
                protectSucceeded: false,
                unprotectSucceeded: false,
                roundTripMatched: false,
                failureCategory,
              },
              exitCode,
            ),
        }),
      );
      expect(earlyFailure).toMatchObject({
        Ready: false,
        CurrentUserSid: "UNKNOWN",
        CurrentTokenElevated: null,
        DpapiHelperExitCode: exitCode,
        DpapiFailureCategory: failureCategory,
        FailureBeforeSecretWrite: true,
        ProductionSecretGenerated: false,
      });
    }
  });

  it("12. rejects malformed helper evidence", () => {
    const { paths } = fixture();
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        runReadinessHelper: () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: "" }),
      }),
    );
    expect(evidence.DpapiFailureCategory).toBe("MALFORMED_HELPER_EVIDENCE");
  });

  it("13. reports a protect failure without attempting to claim unprotect success", () => {
    const { paths } = fixture();
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        runReadinessHelper: () =>
          helperResult(
            {
              protectSucceeded: false,
              unprotectSucceeded: false,
              roundTripMatched: false,
              failureCategory: "PROTECT_FAILED",
            },
            13,
          ),
      }),
    );
    expect(evidence).toMatchObject({
      DpapiFailureCategory: "PROTECT_FAILED",
      DpapiProtectSucceeded: false,
      DpapiUnprotectSucceeded: false,
    });
  });

  it("14. reports an unprotect failure after successful protection", () => {
    const { paths } = fixture();
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        runReadinessHelper: () =>
          helperResult(
            {
              unprotectSucceeded: false,
              roundTripMatched: false,
              failureCategory: "UNPROTECT_FAILED",
            },
            14,
          ),
      }),
    );
    expect(evidence).toMatchObject({
      DpapiFailureCategory: "UNPROTECT_FAILED",
      DpapiProtectSucceeded: true,
      DpapiUnprotectSucceeded: false,
    });
  });

  it("15. refuses a DPAPI round-trip mismatch", () => {
    const { paths } = fixture();
    const evidence = inspectProtectedSecretReadiness(
      readinessOptions(paths, {
        runReadinessHelper: () =>
          helperResult({ roundTripMatched: false, failureCategory: "ROUND_TRIP_MISMATCH" }, 15),
      }),
    );
    expect(evidence).toMatchObject({
      Ready: false,
      DpapiProtectSucceeded: true,
      DpapiUnprotectSucceeded: true,
      DpapiRoundTripMatched: false,
      DpapiFailureCategory: "ROUND_TRIP_MISMATCH",
    });
  });

  it("16. persists no readiness probe artifact", () => {
    const { paths } = fixture();
    const before = readdirSync(paths.secretDirectory);
    const evidence = inspectProtectedSecretReadiness(readinessOptions(paths));
    const helperSource = readFileSync(DPAPI_CURRENT_USER_READINESS_HELPER, "utf8");
    expect(readdirSync(paths.secretDirectory)).toEqual(before);
    expect(evidence).toMatchObject({ DpapiProbePersisted: false, DpapiProbeOutput: false });
    expect(helperSource).toContain("[Array]::Clear($probe, 0, $probe.Length)");
    expect(helperSource).toContain("[Array]::Clear($ciphertext, 0, $ciphertext.Length)");
    expect(helperSource).toContain("[Array]::Clear($roundTrip, 0, $roundTrip.Length)");
    expect(helperSource.indexOf("finally {")).toBeLessThan(
      helperSource.indexOf("[Array]::Clear($probe"),
    );
  });

  it("17. provides no plaintext fallback when protected storage is unavailable", async () => {
    const { paths } = fixture();
    const protector = {
      available: () => false,
      protect: vi.fn(),
      unprotect: vi.fn(),
    };
    await expect(
      storeProductionSecrets(
        { sessionSecret: "s".repeat(64) },
        {
          filePath: paths.secretFile,
          allowedRoot: paths.secretDirectory,
          protector,
          confirm: async () => true,
        },
      ),
    ).rejects.toThrow(/unavailable/iu);
    expect(protector.protect).not.toHaveBeenCalled();
    expect(existsSync(paths.secretFile)).toBe(false);
  });

  it("18. uses CurrentUser only and contains no LocalMachine fallback", () => {
    const bootstrapSource = readFileSync(
      new URL("../../scripts/phase134/production-secrets.mjs", import.meta.url),
      "utf8",
    );
    const helperSource = readFileSync(DPAPI_CURRENT_USER_READINESS_HELPER, "utf8");
    const runtimeSource = readFileSync(
      new URL("../../packages/config/src/secrets.ts", import.meta.url),
      "utf8",
    );
    for (const source of [bootstrapSource, helperSource, runtimeSource]) {
      expect(source).toContain("DataProtectionScope]::CurrentUser");
      expect(source).not.toContain("DataProtectionScope]::LocalMachine");
    }
    expect(helperSource).toContain("[Reflection.Assembly]::Load");
    expect(helperSource).toContain(".ContainsKey('schemaVersion')");
    expect(helperSource).not.toMatch(
      /\b(?:Add-Type|ConvertFrom-Json|ConvertTo-Json|Join-Path)\b/iu,
    );
    for (const source of [bootstrapSource, runtimeSource]) {
      expect(source).not.toContain("process.env.SystemRoot");
      expect(source).toContain("C:\\\\Windows\\\\System32\\\\WindowsPowerShell");
      expect(source).toContain("realpathSync.native");
      expect(source).toContain("isSymbolicLink()");
    }
  });

  it("19. emits only the exact payload-free helper and readiness evidence allowlists", () => {
    const temporary = fixture();
    const paths = { ...temporary.paths, nodeExecutable: process.execPath };
    const currentSid = resolveCurrentUserSid();
    const result = spawnSync(
      WINDOWS_DPAPI_POWERSHELL_EXECUTABLE,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        DPAPI_CURRENT_USER_READINESS_HELPER,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PSModulePath: "C:\\hostile-powershell7-modules",
        },
        input: JSON.stringify({ schemaVersion: 1, intendedUserSid: currentSid }),
        shell: false,
        windowsHide: true,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe("");
    const raw = JSON.parse(result.stdout);
    expect(Object.keys(raw).sort()).toEqual(
      [
        "schemaVersion",
        "provider",
        "runtimeExecutable",
        "runtimeVersion",
        "currentUserSid",
        "currentTokenElevated",
        "userProfileLoaded",
        "protectSucceeded",
        "unprotectSucceeded",
        "roundTripMatched",
        "probePersisted",
        "probeOutput",
        "failureCategory",
      ].sort(),
    );
    const evidence = inspectProtectedSecretReadiness({
      paths,
      platform: "win32",
      intendedUserSid: currentSid,
      toolchain: {
        ok: true,
        nodeReady: true,
        nodePath: process.execPath,
        nodeVersion: process.version.replace(/^v/u, ""),
      },
      inspectAcl: () => ({ exactProtected: true }),
      runReadinessHelper: () => ({
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    });
    for (const value of [raw, evidence]) {
      for (const forbidden of [
        "plaintext",
        "ciphertext",
        "protectedPayload",
        "probeValue",
        "payload",
      ]) {
        expect(value).not.toHaveProperty(forbidden);
      }
    }
    expect(evidence).toMatchObject({
      Ready: true,
      DpapiProbePersisted: false,
      DpapiProbeOutput: false,
    });
  }, 15_000);

  it("20. repeats readiness checks idempotently without filesystem mutation", () => {
    const { paths } = fixture();
    const runReadinessHelper = vi.fn(() => helperResult());
    const options = readinessOptions(paths, { runReadinessHelper });
    const before = readdirSync(paths.secretDirectory);
    expect(inspectProtectedSecretReadiness(options).Ready).toBe(true);
    expect(inspectProtectedSecretReadiness(options).Ready).toBe(true);
    expect(runReadinessHelper).toHaveBeenCalledTimes(2);
    expect(readdirSync(paths.secretDirectory)).toEqual(before);
  });

  it("21. lets Configure-BEA continue only after readiness succeeds", async () => {
    const { paths } = fixture();
    const events = [];
    const result = await configureProductionBootstrap(
      configureFixture(paths, {
        ensureAclBootstrap: async () => {
          events.push("acl");
          return { code: "ALREADY_COMPLIANT", currentUserSid: CURRENT_SID };
        },
        assertSecretReadiness: () => {
          events.push("readiness");
          return readyEvidence(paths);
        },
        createDefaultConfig: () => {
          events.push("config");
          return createDefaultProductionConfig({ paths });
        },
        storeSecrets: async () => {
          events.push("store");
          return secretStatus({ configured: true });
        },
      }),
    );
    expect(events).toEqual(["acl", "readiness", "config", "store"]);
    expect(result.configReady).toBe(true);
  });

  it("22. stops before config, secret, certificate, or database work when readiness fails", async () => {
    const { paths } = fixture();
    const writeConfig = vi.fn();
    const storeSecrets = vi.fn();
    const readCertificate = vi.fn();
    const readSecrets = vi.fn();
    const inspectCertificateTrust = vi.fn();
    const setupCertificate = vi.fn();
    const databaseSetup = vi.fn();
    const failure = Object.assign(new Error("readiness blocked"), {
      evidence: { DpapiFailureCategory: "USER_PROFILE_UNAVAILABLE" },
    });
    await expect(
      configureProductionBootstrap(
        configureFixture(paths, {
          assertSecretReadiness: () => {
            throw failure;
          },
          writeConfig,
          storeSecrets,
          readCertificate,
          readSecrets,
          inspectCertificateTrust,
          setupCertificate,
          databaseSetup,
        }),
      ),
    ).rejects.toBe(failure);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(storeSecrets).not.toHaveBeenCalled();
    expect(readCertificate).not.toHaveBeenCalled();
    expect(readSecrets).not.toHaveBeenCalled();
    expect(inspectCertificateTrust).not.toHaveBeenCalled();
    expect(setupCertificate).not.toHaveBeenCalled();
    expect(databaseSetup).not.toHaveBeenCalled();
  });

  it("23. generates no production secret during the readiness probe", async () => {
    const { paths } = fixture();
    const events = [];
    const generateSessionSecret = vi.fn(() => {
      events.push("generate-session");
      return "s".repeat(64);
    });
    const generateControlToken = vi.fn(() => {
      events.push("generate-control");
      return "a".repeat(64);
    });
    const generatePfxPassword = vi.fn(() => {
      events.push("generate-pfx");
      return "p".repeat(48);
    });
    await configureProductionBootstrap(
      configureFixture(paths, {
        assertSecretReadiness: () => {
          expect(generateSessionSecret).not.toHaveBeenCalled();
          expect(generateControlToken).not.toHaveBeenCalled();
          expect(generatePfxPassword).not.toHaveBeenCalled();
          events.push("readiness");
          return readyEvidence(paths);
        },
        generateSessionSecret,
        generateControlToken,
        generatePfxPassword,
      }),
    );
    expect(events).toEqual(["readiness", "generate-session", "generate-control", "generate-pfx"]);
  });
});
