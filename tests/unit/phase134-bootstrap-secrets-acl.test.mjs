import { nativeWindowsFilesystemMissing } from "../filesystem-capabilities";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_SECRET_KEYS,
  deleteProductionSecrets,
  generateControlToken,
  generatePfxPassword,
  generateSessionSecret,
  readProductionSecrets,
  readSecretStatus,
  storeProductionSecrets,
} from "../../scripts/phase134/production-secrets.mjs";
import { createProductionPaths } from "../../scripts/phase134/production-paths.mjs";
import { configureProductionBootstrap } from "../../scripts/phase134/configure-production.mjs";
import {
  ACL_ADMINISTRATORS_SID,
  ACL_REPAIR_APPROVAL,
  ACL_SYSTEM_SID,
  applyRestrictedAcl,
  buildElevatedProductRootRepairRequest,
  buildRestrictedAclPlan,
  classifyAclFailure,
  decodeElevatedAclExitCode,
  ensureProductionAclBootstrap,
  evaluateAclEvidence,
  formatProductRootRepairPrompt,
  inspectAcl,
  repairProductRootAclElevated,
  resolveCurrentUserSid,
  validateAclTarget,
  validateAclTargetForOperation,
} from "../../scripts/phase134/windows-acl.mjs";

const itWithPersistentAcls = it.skipIf(nativeWindowsFilesystemMissing("persistent ACLs", tmpdir()));
const itWithReparsePoints = it.skipIf(nativeWindowsFilesystemMissing("reparse points", tmpdir()));
const temporaryDirectories = [];
const sharedTemporaryDirectories = [];
let sharedNativePromise;

class FakeProtector {
  available() {
    return true;
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
  const localAppData = mkdtempSync(join(tmpdir(), "bea-phase134-secrets-"));
  temporaryDirectories.push(localAppData);
  const paths = createProductionPaths({ localAppData });
  return { paths, protector: new FakeProtector() };
}

function exactAclEvidence(sid, directory = true) {
  const inheritance = directory ? 3 : 0;
  return {
    ok: true,
    protected: true,
    protectedAncestor: null,
    ownerSid: sid,
    directory,
    reparsePoint: false,
    rules: [
      {
        sid,
        accessType: 0,
        rights: 2_032_127,
        inheritance,
        propagation: 0,
        inherited: false,
      },
      {
        sid: "S-1-5-18",
        accessType: 0,
        rights: 2_032_127,
        inheritance,
        propagation: 0,
        inherited: false,
      },
    ],
  };
}

function aclEvidence(
  sid,
  {
    directory = true,
    ownerSid = sid,
    protectedAcl = true,
    inherited = false,
    protectedAncestor = protectedAcl ? null : "C:\\fixture\\protected-parent",
    extraRules = [],
  } = {},
) {
  const inheritance = directory ? 3 : 0;
  return {
    ok: true,
    protected: protectedAcl,
    protectedAncestor,
    ownerSid,
    directory,
    reparsePoint: false,
    rules: [
      {
        sid,
        accessType: 0,
        rights: 2_032_127,
        inheritance,
        propagation: 0,
        inherited,
      },
      {
        sid: ACL_SYSTEM_SID,
        accessType: 0,
        rights: 2_032_127,
        inheritance,
        propagation: 0,
        inherited,
      },
      ...extraRules,
    ],
  };
}

function evaluatedAcl(raw, sid, options = {}) {
  return {
    ...raw,
    ...evaluateAclEvidence(raw, sid, raw.directory, options),
  };
}

function broadProductRootEvidence(sid) {
  return evaluatedAcl(
    aclEvidence(sid, {
      ownerSid: ACL_ADMINISTRATORS_SID,
      protectedAcl: false,
      inherited: true,
      protectedAncestor: null,
      extraRules: [
        {
          sid: "S-1-5-21-100-200-300-1007",
          accessType: 0,
          rights: 1_179_817,
          inheritance: 3,
          propagation: 0,
          inherited: true,
        },
        {
          sid: ACL_ADMINISTRATORS_SID,
          accessType: 0,
          rights: 2_032_127,
          inheritance: 3,
          propagation: 0,
          inherited: true,
        },
      ],
    }),
    sid,
    { allowInherited: false },
  );
}

function readDirectorySddl(path) {
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Console]::In.ReadToEnd()
$sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
[IO.Directory]::GetAccessControl($target, $sections).GetSecurityDescriptorSddlForm($sections)
`;
  const result = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", input: path, shell: false, windowsHide: true },
  );
  if (result.status !== 0) throw new Error("Temporary ACL SDDL inspection failed.");
  return String(result.stdout).trim();
}

async function sharedNativeFixture() {
  if (!sharedNativePromise) {
    sharedNativePromise = (async () => {
      const localAppData = mkdtempSync(join(tmpdir(), "bea-phase134-shared-acl-"));
      sharedTemporaryDirectories.push(localAppData);
      const paths = createProductionPaths({ localAppData });
      mkdirSync(paths.productRoot, { recursive: true });
      const sid = resolveCurrentUserSid();
      const result = await applyRestrictedAcl(paths.productRoot, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        productRootParent: dirnameForProductRoot(paths.productRoot),
        currentUserSid: sid,
        directory: true,
        policy: "product-root",
        allowInherited: false,
        confirm: async () => true,
      });
      const inspection = inspectAcl(paths.productRoot, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        productRootParent: dirnameForProductRoot(paths.productRoot),
        currentUserSid: sid,
        directory: true,
        allowInherited: false,
      });
      return { inspection, paths, result, sid };
    })();
  }
  return sharedNativePromise;
}

function dirnameForProductRoot(productRoot) {
  return join(productRoot, "..", "..");
}

function expectedDirectoryAcl(paths, target, exact, inherited) {
  return [paths.configDirectory, paths.secretDirectory, paths.certificateDirectory].includes(target)
    ? exact
    : inherited;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

afterAll(() => {
  for (const path of sharedTemporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("Phase 1.3.4 generalized protected vault and Windows ACL contract", () => {
  it("uses the exact five protected production secret keys", () => {
    expect(PRODUCTION_SECRET_KEYS).toEqual([
      "sessionSecret",
      "databaseUrl",
      "openAiApiKey",
      "httpsPfxPassword",
      "controlToken",
    ]);
  });

  it("stores only protected ciphertext and returns status/fingerprint without values", async () => {
    const { paths, protector } = fixture();
    mkdirSync(paths.secretDirectory, { recursive: true });
    const values = {
      sessionSecret: generateSessionSecret(),
      databaseUrl: "postgresql://bea:private-value@127.0.0.1:5433/bea",
      openAiApiKey: "fixture-openai-api-key-value",
      httpsPfxPassword: generatePfxPassword(),
      controlToken: generateControlToken(),
    };
    const status = await storeProductionSecrets(values, {
      filePath: paths.secretFile,
      allowedRoot: paths.secretDirectory,
      protector,
      confirm: async () => true,
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(status.available).toBe(true);
    expect(status.records.openAiApiKey).toMatchObject({
      configured: true,
      updatedAt: "2026-08-24T12:00:00.000Z",
    });
    expect(status.records.openAiApiKey.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const serialized = readFileSync(paths.secretFile, "utf8");
    for (const value of Object.values(values)) expect(serialized).not.toContain(value);
    expect(JSON.stringify(status)).not.toContain(values.openAiApiKey);
    expect(
      readProductionSecrets(["sessionSecret", "controlToken"], {
        filePath: paths.secretFile,
        allowedRoot: paths.secretDirectory,
        protector,
      }),
    ).toEqual({
      sessionSecret: values.sessionSecret,
      controlToken: values.controlToken,
    });
  });

  it("requires explicit confirmation for store and delete and fails closed on invalid values", async () => {
    const { paths, protector } = fixture();
    mkdirSync(paths.secretDirectory, { recursive: true });
    await expect(
      storeProductionSecrets(
        { sessionSecret: generateSessionSecret() },
        {
          filePath: paths.secretFile,
          allowedRoot: paths.secretDirectory,
          protector,
        },
      ),
    ).rejects.toThrow(/confirmation/iu);
    await expect(
      storeProductionSecrets(
        { controlToken: "not-a-token" },
        {
          filePath: paths.secretFile,
          allowedRoot: paths.secretDirectory,
          protector,
          confirm: async () => true,
        },
      ),
    ).rejects.toThrow(/validation/iu);

    await storeProductionSecrets(
      { sessionSecret: generateSessionSecret() },
      {
        filePath: paths.secretFile,
        allowedRoot: paths.secretDirectory,
        protector,
        confirm: async () => true,
      },
    );
    await expect(
      deleteProductionSecrets(["sessionSecret"], {
        filePath: paths.secretFile,
        allowedRoot: paths.secretDirectory,
        protector,
        confirm: async () => false,
      }),
    ).rejects.toThrow(/confirmation/iu);
    const status = await deleteProductionSecrets(["sessionSecret"], {
      filePath: paths.secretFile,
      allowedRoot: paths.secretDirectory,
      protector,
      confirm: async () => true,
    });
    expect(status.records.sessionSecret.configured).toBe(false);
    expect(
      readSecretStatus({
        filePath: paths.secretFile,
        allowedRoot: paths.secretDirectory,
        protector,
      }).records.sessionSecret.configured,
    ).toBe(false);
  });

  it("refuses status readiness when protected ciphertext cannot be validated", async () => {
    const { paths, protector } = fixture();
    mkdirSync(paths.secretDirectory, { recursive: true });
    await storeProductionSecrets(
      { sessionSecret: generateSessionSecret() },
      {
        filePath: paths.secretFile,
        allowedRoot: paths.secretDirectory,
        protector,
        confirm: async () => true,
      },
    );
    const envelope = JSON.parse(readFileSync(paths.secretFile, "utf8"));
    envelope.records.sessionSecret.ciphertext = Buffer.from("protected:invalid", "utf8").toString(
      "base64",
    );
    writeFileSync(paths.secretFile, `${JSON.stringify(envelope)}\n`);
    expect(() =>
      readSecretStatus({
        filePath: paths.secretFile,
        allowedRoot: paths.secretDirectory,
        protector,
      }),
    ).toThrow(/failed validation/iu);
  });

  it("builds a current-user and SYSTEM-only ACL plan and keeps mutation injectable", async () => {
    const { paths } = fixture();
    const sid = "S-1-5-21-100-200-300-1001";
    const plan = buildRestrictedAclPlan(paths.configDirectory, {
      allowedRoot: paths.productRoot,
      currentUserSid: sid,
      directory: true,
      powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
    expect(plan.principals).toEqual([sid, "S-1-5-18"]);
    expect(JSON.parse(plan.input)).toEqual({
      target: paths.configDirectory,
      allowedRoot: paths.productRoot,
      validationRoot: paths.productRoot,
      forbiddenRoot: "C:\\CPL-Dev\\Cyber Pirate Labs Command Center",
      currentUserSid: sid,
      directory: true,
      requireCanonicalProductRoot: false,
      createIfMissing: false,
      testOnlyForceVerificationFailure: false,
    });
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0].at(-1)).toContain("SetAccessRuleProtection($true, $false)");
    expect(plan.commands[0].at(-1)).toContain("FileSystemRights]::FullControl");
    expect(plan.commands[0].at(-1)).toContain("InheritanceFlags]::ContainerInherit");
    expect(plan.commands[0].at(-1)).toContain("[IO.Directory]::GetAccessControl");
    expect(plan.commands[0].at(-1)).toContain("[IO.Directory]::SetAccessControl");
    expect(plan.commands[0].at(-1)).not.toContain("Set-Acl");
    mkdirSync(paths.configDirectory, { recursive: true });
    const runner = vi.fn(() => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, inspection: exactAclEvidence(sid) }),
      stderr: "",
    }));
    const inspect = vi.fn(() => ({
      exactProtected: false,
      exactRestricted: false,
      ownerSid: sid,
      protected: false,
    }));
    const result = await applyRestrictedAcl(paths.configDirectory, {
      platform: "win32",
      allowedRoot: paths.productRoot,
      currentUserSid: sid,
      directory: true,
      confirm: async () => true,
      run: runner,
      inspect,
      powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
    expect(result.applied).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    await expect(
      applyRestrictedAcl(paths.configDirectory, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        currentUserSid: sid,
        directory: true,
        policy: "protected",
        run: runner,
        inspect,
      }),
    ).rejects.toThrow(/confirmation/iu);
  });

  it("requires exact protected current-user and SYSTEM evidence during ACL inspection", () => {
    const { paths } = fixture();
    const sid = "S-1-5-21-100-200-300-1001";
    const exact = inspectAcl(paths.configDirectory, {
      allowedRoot: paths.productRoot,
      currentUserSid: sid,
      directory: true,
      powershellExecutable: "powershell.exe",
      run: () => ({
        exitCode: 0,
        stdout: JSON.stringify(exactAclEvidence(sid)),
        stderr: "",
      }),
    });
    expect(exact.exactRestricted).toBe(true);
    const exactFile = inspectAcl(paths.secretFile, {
      allowedRoot: paths.productRoot,
      currentUserSid: sid,
      directory: false,
      powershellExecutable: "powershell.exe",
      run: () => ({
        exitCode: 0,
        stdout: JSON.stringify(exactAclEvidence(sid, false)),
        stderr: "",
      }),
    });
    expect(exactFile.exactRestricted).toBe(true);

    for (const mutate of [
      (evidence) => evidence.rules.push({ ...evidence.rules[0], sid: "S-1-5-32-545" }),
      (evidence) => (evidence.rules[0].accessType = 1),
      (evidence) => (evidence.rules[0].rights = 1_179_785),
      (evidence) => (evidence.rules[0].inheritance = 0),
      (evidence) => (evidence.rules[0].propagation = 2),
      (evidence) => (evidence.rules[0].inherited = true),
      (evidence) => (evidence.ownerSid = "S-1-5-18"),
      (evidence) => (evidence.protected = false),
      (evidence) => (evidence.directory = false),
    ]) {
      const unsafeEvidence = exactAclEvidence(sid);
      mutate(unsafeEvidence);
      const unsafe = inspectAcl(paths.configDirectory, {
        allowedRoot: paths.productRoot,
        currentUserSid: sid,
        directory: true,
        powershellExecutable: "powershell.exe",
        run: () => ({
          exitCode: 0,
          stdout: JSON.stringify(unsafeEvidence),
          stderr: "",
        }),
      });
      expect(unsafe.exactRestricted).toBe(false);
    }
  }, 20_000);

  it("fails ACL application when the post-write evidence is not exact", async () => {
    const { paths } = fixture();
    mkdirSync(paths.configDirectory, { recursive: true });
    const sid = "S-1-5-21-100-200-300-1001";
    const unsafeEvidence = exactAclEvidence(sid);
    unsafeEvidence.rules[1].rights = 1_179_785;
    await expect(
      applyRestrictedAcl(paths.configDirectory, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        currentUserSid: sid,
        directory: true,
        policy: "protected",
        confirm: async () => true,
        inspect: () => evaluatedAcl(unsafeEvidence, sid, { allowInherited: false }),
        runMutation: () => ({
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, inspection: unsafeEvidence }),
          stderr: "",
        }),
        powershellExecutable: "powershell.exe",
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclFailureCategory: "EXACT_VERIFICATION_FAILED",
        AclRecoveryCommand: ".\\Configure-BEA.cmd",
      }),
    });
  });
});

describe("Phase 1.3.4 Windows ACL bootstrap correction (37 focused cases)", () => {
  const sid = "S-1-5-21-100-200-300-1001";

  it("1. attempts a normal transactional repair for an Administrators-owned product root", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const broad = broadProductRootEvidence(sid);
    const exact = evaluatedAcl(aclEvidence(sid), sid, { allowInherited: false });
    const inherited = evaluatedAcl(
      aclEvidence(sid, {
        protectedAcl: false,
        inherited: true,
        protectedAncestor: paths.productRoot,
      }),
      sid,
    );
    let rootReads = 0;
    expect(
      formatProductRootRepairPrompt({
        target: paths.productRoot,
        currentUserSid: sid,
        inspection: broad,
        elevationRequired: false,
        elevationConditional: true,
      }),
    ).toContain("AclElevationRequired: NO initially");
    const repairElevated = vi.fn(async () => ({ code: "REPAIRED_ELEVATED" }));
    const repairNormal = vi.fn(async () => ({ code: "REPAIRED" }));
    const result = await ensureProductionAclBootstrap({
      paths,
      platform: "win32",
      currentUserSid: sid,
      prompt: async () => ACL_REPAIR_APPROVAL,
      inspect: (target) => {
        if (target === paths.productRoot) return rootReads++ === 0 ? broad : exact;
        return expectedDirectoryAcl(paths, target, exact, inherited);
      },
      repairElevated,
      repairNormal,
      applyAcl: async () => ({ code: "ALREADY_COMPLIANT" }),
    });
    expect(repairNormal).toHaveBeenCalledTimes(1);
    expect(repairElevated).not.toHaveBeenCalled();
    expect(result.elevationUsed).toBe(false);
  });

  it("2. rejects inherited CodexSandboxUsers ReadAndExecute on the product root", () => {
    const evidence = broadProductRootEvidence(sid);
    expect(evidence.principals).toContain("S-1-5-21-100-200-300-1007");
    expect(evidence.exactRestricted).toBe(false);
  });

  it("3. rejects inherited current-user FullControl while root inheritance remains enabled", () => {
    const raw = aclEvidence(sid, {
      protectedAcl: false,
      inherited: true,
      protectedAncestor: null,
    });
    const evidence = evaluateAclEvidence(raw, sid, true, { allowInherited: false });
    expect(evidence.rules.find((rule) => rule.sid === sid)?.rights).toBe(2_032_127);
    expect(evidence.exactRestricted).toBe(false);
  });

  itWithPersistentAcls(
    "4. repairs a current-user-owned temporary root without elevation",
    async () => {
      const native = await sharedNativeFixture();
      expect(native.result.code).toBe("REPAIRED");
      expect(native.inspection.exactProtected).toBe(true);
    },
    20_000,
  );

  it("5. reports a declined elevation request with safe structured evidence", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    await expect(
      repairProductRootAclElevated(paths.productRoot, {
        platform: "win32",
        productRoot: paths.productRoot,
        productRootParent: dirnameForProductRoot(paths.productRoot),
        currentUserSid: sid,
        ownerBefore: ACL_ADMINISTRATORS_SID,
        inheritanceBefore: "ENABLED",
        runElevated: () => ({
          exitCode: 0,
          stdout: JSON.stringify({ ok: false, exitCode: 1223, failureCategory: "UAC_DECLINED" }),
          stderr: "sensitive raw stderr must not surface",
        }),
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclFailureCategory: "UAC_DECLINED",
        AclElevationRequired: true,
      }),
    });

    const broad = broadProductRootEvidence(sid);
    const exact = evaluatedAcl(aclEvidence(sid), sid, { allowInherited: false });
    const inherited = evaluatedAcl(
      aclEvidence(sid, {
        protectedAcl: false,
        inherited: true,
        protectedAncestor: paths.productRoot,
      }),
      sid,
    );
    let reads = 0;
    const accessDenied = Object.assign(new Error("access denied"), {
      evidence: {
        AclFailureCategory: "ACCESS_DENIED",
        AclRollbackResult: "NOT_RUN",
      },
    });
    const repairNormal = vi.fn(async () => {
      throw accessDenied;
    });
    const repairElevated = vi.fn(async () => ({ code: "REPAIRED_ELEVATED" }));
    const result = await ensureProductionAclBootstrap({
      paths,
      platform: "win32",
      currentUserSid: sid,
      prompt: async () => ACL_REPAIR_APPROVAL,
      inspect: (target) => {
        if (target === paths.productRoot) return reads++ === 0 ? broad : exact;
        return expectedDirectoryAcl(paths, target, exact, inherited);
      },
      repairNormal,
      repairElevated,
      applyAcl: async () => ({ code: "ALREADY_COMPLIANT" }),
    });
    expect(repairNormal).toHaveBeenCalledTimes(1);
    expect(repairElevated).toHaveBeenCalledTimes(1);
    expect(result.elevationUsed).toBe(true);
  });

  it("6. builds one narrow RunAs helper request for only the canonical product root", () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const request = buildElevatedProductRootRepairRequest(paths.productRoot, {
      productRoot: paths.productRoot,
      productRootParent: dirnameForProductRoot(paths.productRoot),
      currentUserSid: sid,
      powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
    const compressedLauncher = Buffer.from(request.encodedCommand, "base64").toString("utf16le");
    const compressedPayload = /FromBase64String\('([^']+)'\)/u.exec(compressedLauncher)?.[1];
    const elevatedSource = gunzipSync(Buffer.from(compressedPayload, "base64")).toString("utf8");
    expect(request.target).toBe(paths.productRoot);
    expect(request.argumentCategory).toBe(
      "NO_PROFILE_NONINTERACTIVE_PROCESS_ONLY_POLICY_ENCODED_HELPER",
    );
    expect(request.payloadCategory).toBe("GZIP_BASE64_EMBEDDED_DOTNET_ACL_HELPER");
    expect(request.executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(request.wrapperArguments.at(-1)).toContain("$startInfo.Verb = 'runas'");
    expect(request.wrapperArguments.at(-1)).toContain("[Environment]::SystemDirectory");
    expect(request.encodedCommand.length).toBeLessThan(30_000);
    expect(compressedLauncher).toContain("Compression.GzipStream");
    expect(elevatedSource).toContain("requireCanonicalProductRoot");
    expect(elevatedSource).toContain("[IO.Path]::GetPathRoot($targetFull)");
    expect(elevatedSource).toContain("ACL_SID_MISMATCH");
    expect(elevatedSource).not.toContain("Configure-BEA.cmd");
    expect(decodeElevatedAclExitCode(0xa324)).toMatchObject({
      stage: "inheritance-and-grant-replacement",
      failureCategory: "MUTATION_FAILED",
      rollbackAttempted: false,
    });
    expect(decodeElevatedAclExitCode(0xa41d)).toMatchObject({
      stage: "owner-assignment",
      failureCategory: "ACCESS_DENIED",
      rollbackSucceeded: true,
    });
    expect(decodeElevatedAclExitCode(0xa41e)).toMatchObject({ rollbackSucceeded: false });
    expect(decodeElevatedAclExitCode(0xa529)).toMatchObject({
      stage: "exact-verification",
      failureCategory: "EXACT_VERIFICATION_FAILED",
      rollbackSucceeded: true,
    });
    expect(decodeElevatedAclExitCode(0xa52a)).toMatchObject({ rollbackSucceeded: false });
    expect(decodeElevatedAclExitCode(0xa728)).toMatchObject({
      stage: "secure-directory-verification",
      failureCategory: "EXACT_VERIFICATION_FAILED",
      rollbackAttempted: false,
      verificationResult: "FAILED",
    });
    expect(decodeElevatedAclExitCode(1223)).toBeUndefined();
    expect(decodeElevatedAclExitCode(0xa52b)).toBeUndefined();
    expect(decodeElevatedAclExitCode(0xa72b)).toBeUndefined();
    expect(() =>
      buildElevatedProductRootRepairRequest(paths.productRoot, {
        productRoot: paths.productRoot,
        productRootParent: dirnameForProductRoot(paths.productRoot),
        currentUserSid: sid,
        powershellExecutable: "powershell.exe",
      }),
    ).toThrow(/pinned system Windows PowerShell/iu);
  });

  it("7. accepts elevated post-verification only when owner becomes the initiating SID", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const exact = evaluatedAcl(aclEvidence(sid), sid, { allowInherited: false });
    const result = await repairProductRootAclElevated(paths.productRoot, {
      platform: "win32",
      productRoot: paths.productRoot,
      productRootParent: dirnameForProductRoot(paths.productRoot),
      currentUserSid: sid,
      runElevated: () => ({
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, exitCode: 0, failureCategory: null }),
        stderr: "",
      }),
      inspect: () => exact,
    });
    expect(result.inspection.ownerSid).toBe(sid);
    expect(result.code).toBe("REPAIRED_ELEVATED");
  });

  itWithPersistentAcls(
    "8. disables inheritance on an actually repaired temporary product root",
    async () => {
      const native = await sharedNativeFixture();
      expect(native.inspection.protected).toBe(true);
    },
  );

  itWithPersistentAcls(
    "9. removes every unapproved inherited identity from an actually repaired root",
    async () => {
      const native = await sharedNativeFixture();
      expect(native.inspection.principals).toEqual([ACL_SYSTEM_SID, native.sid].sort());
    },
  );

  itWithPersistentAcls(
    "10. grants the current user one explicit inheritable FullControl ACE",
    async () => {
      const native = await sharedNativeFixture();
      expect(native.inspection.rules.filter((rule) => rule.sid === native.sid)).toEqual([
        expect.objectContaining({ rights: 2_032_127, inheritance: 3, inherited: false }),
      ]);
    },
  );

  itWithPersistentAcls("11. grants SYSTEM one explicit inheritable FullControl ACE", async () => {
    const native = await sharedNativeFixture();
    expect(native.inspection.rules.filter((rule) => rule.sid === ACL_SYSTEM_SID)).toEqual([
      expect.objectContaining({ rights: 2_032_127, inheritance: 3, inherited: false }),
    ]);
  });

  itWithPersistentAcls(
    "12. leaves exactly two allow ACEs with no unexpected explicit grant",
    async () => {
      const native = await sharedNativeFixture();
      expect(native.inspection.rules).toHaveLength(2);
      expect(native.inspection.rules.every((rule) => rule.accessType === 0)).toBe(true);
    },
  );

  it("13. preserves an already-correct config root without mutation", async () => {
    const { paths } = fixture();
    mkdirSync(paths.configDirectory, { recursive: true });
    const sentinel = join(paths.configDirectory, "preserve.txt");
    writeFileSync(sentinel, "config-preserved\n");
    const mutation = vi.fn();
    const result = await applyRestrictedAcl(paths.configDirectory, {
      platform: "win32",
      allowedRoot: paths.productRoot,
      currentUserSid: sid,
      directory: true,
      policy: "protected",
      inspect: () => evaluatedAcl(aclEvidence(sid), sid, { allowInherited: false }),
      runMutation: mutation,
    });
    expect(result.code).toBe("ALREADY_COMPLIANT");
    expect(mutation).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, "utf8")).toBe("config-preserved\n");
  });

  it("14. preserves an already-correct toolchain root and its content", async () => {
    const { paths } = fixture();
    mkdirSync(paths.toolchainDirectory, { recursive: true });
    const wrapper = join(paths.toolchainDirectory, "pnpm.cmd");
    writeFileSync(wrapper, "@echo protected toolchain\r\n");
    const mutation = vi.fn();
    const result = await applyRestrictedAcl(paths.toolchainDirectory, {
      platform: "win32",
      allowedRoot: paths.productRoot,
      currentUserSid: sid,
      directory: true,
      policy: "protected",
      inspect: () => evaluatedAcl(aclEvidence(sid), sid, { allowInherited: false }),
      runMutation: mutation,
    });
    expect(result.code).toBe("ALREADY_COMPLIANT");
    expect(mutation).not.toHaveBeenCalled();
    expect(readFileSync(wrapper, "utf8")).toBe("@echo protected toolchain\r\n");
  });

  itWithPersistentAcls(
    "15. accepts a child inheriting only approved grants from a protected parent",
    async () => {
      const native = await sharedNativeFixture();
      const child = join(native.paths.productRoot, "runtime-child");
      mkdirSync(child);
      const inherited = inspectAcl(child, {
        platform: "win32",
        allowedRoot: native.paths.productRoot,
        currentUserSid: native.sid,
        directory: true,
        allowInherited: true,
      });
      expect(inherited.verificationResult).toBe("EXACT_INHERITED");
      expect(inherited.protected).toBe(false);
    },
  );

  it("16. accepts legacy Administrators ownership only for an exact toolchain descendant policy", () => {
    const raw = aclEvidence(sid, {
      ownerSid: ACL_ADMINISTRATORS_SID,
      protectedAcl: false,
      inherited: true,
    });
    expect(
      evaluateAclEvidence(raw, sid, true, {
        allowInherited: true,
        allowAdministrativeOwner: true,
      }).exactInherited,
    ).toBe(true);
    expect(evaluateAclEvidence(raw, sid, true).exactInherited).toBe(false);
    raw.rules.push({ ...raw.rules[0], sid: "S-1-5-32-545" });
    expect(
      evaluateAclEvidence(raw, sid, true, {
        allowInherited: true,
        allowAdministrativeOwner: true,
      }).exactInherited,
    ).toBe(false);
  });

  itWithPersistentAcls(
    "17. creates and verifies the six missing production directories without real secrets",
    async () => {
      const { paths } = fixture();
      const currentSid = resolveCurrentUserSid();
      const result = await ensureProductionAclBootstrap({
        paths,
        platform: "win32",
        currentUserSid: currentSid,
        prompt: async () => ACL_REPAIR_APPROVAL,
      });
      expect(result.directories).toEqual([
        paths.configDirectory,
        paths.secretDirectory,
        paths.runtimeDirectory,
        paths.logDirectory,
        paths.certificateDirectory,
        paths.backupDirectory,
      ]);
      expect(result.root.exactProtected).toBe(true);
      for (const directory of result.directories) expect(existsSync(directory)).toBe(true);
      expect(existsSync(paths.secretFile)).toBe(false);
      expect(
        inspectAcl(paths.runtimeDirectory, {
          platform: "win32",
          allowedRoot: paths.productRoot,
          currentUserSid: currentSid,
          directory: true,
        }).exactProtected,
      ).toBe(true);
    },
    45_000,
  );

  it("18. rejects a target outside the allowed product root before mutation", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const sibling = join(paths.productRoot, "..", "outside");
    mkdirSync(sibling);
    expect(() => validateAclTarget(sibling, { allowedRoot: paths.productRoot })).toThrow(
      /inside/iu,
    );
    await expect(
      applyRestrictedAcl(sibling, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        currentUserSid: sid,
        directory: true,
        confirm: async () => true,
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclStage: "validation",
        AclFailureCategory: "TARGET_OUTSIDE_ROOT",
      }),
    });
  });

  it("19. rejects the protected CPL repository lexically without filesystem access", () => {
    const { paths } = fixture();
    const exists = vi.fn(() => {
      throw new Error("filesystem must not be queried");
    });
    expect(() =>
      validateAclTarget("C:\\CPL-Dev\\Cyber Pirate Labs Command Center", {
        allowedRoot: paths.productRoot,
        exists,
      }),
    ).toThrow(/protected CPL repository/iu);
    expect(exists).not.toHaveBeenCalled();
  });

  itWithReparsePoints(
    "20. rejects actual junction escapes before creation and leaves outside data unchanged",
    async () => {
      const { paths } = fixture();
      mkdirSync(paths.productRoot, { recursive: true });
      const junction = join(paths.productRoot, "junction");
      const outsideDirectory = join(paths.productRoot, "..", "junction-outside");
      const outside = join(outsideDirectory, "outside-sentinel.txt");
      mkdirSync(outsideDirectory);
      writeFileSync(outside, "unchanged\n");
      symlinkSync(outsideDirectory, junction, "junction");
      expect(() => validateAclTarget(junction, { allowedRoot: paths.productRoot })).toThrow(
        /junction|symbolic link|reparse/iu,
      );
      expect(readFileSync(outside, "utf8")).toBe("unchanged\n");
      rmSync(outsideDirectory, { recursive: true });
      const realpath = vi.fn(() => {
        throw new Error("realpath must not follow a dangling reparse point");
      });
      let nativeDanglingError;
      try {
        validateAclTargetForOperation(junction, {
          platform: "win32",
          allowedRoot: paths.productRoot,
          lstat: (target) =>
            target === junction ? { isSymbolicLink: () => false } : lstatSync(target),
          realpath,
        });
      } catch (error) {
        nativeDanglingError = error;
      }
      expect(nativeDanglingError).toMatchObject({
        evidence: expect.objectContaining({ AclFailureCategory: "REPARSE_POINT_REFUSED" }),
      });
      expect(realpath).not.toHaveBeenCalled();

      const missing = fixture();
      const missingLocalAppData = join(missing.paths.productRoot, "..", "..");
      const escapedParent = join(missingLocalAppData, "escaped-parent");
      mkdirSync(escapedParent);
      symlinkSync(escapedParent, join(missingLocalAppData, "BEA"), "junction");
      const inspect = vi.fn();
      const repairNormal = vi.fn();
      const applyAcl = vi.fn();
      await expect(
        ensureProductionAclBootstrap({
          paths: missing.paths,
          platform: "win32",
          currentUserSid: sid,
          inspect,
          repairNormal,
          applyAcl,
        }),
      ).rejects.toMatchObject({
        evidence: expect.objectContaining({ AclFailureCategory: "REPARSE_POINT_REFUSED" }),
      });
      expect(existsSync(join(escapedParent, "CommandCenter"))).toBe(false);
      expect(inspect).not.toHaveBeenCalled();
      expect(repairNormal).not.toHaveBeenCalled();
      expect(applyAcl).not.toHaveBeenCalled();
    },
  );

  itWithReparsePoints(
    "21. rejects a symbolic-link escape using native NTFS creation when permitted",
    () => {
      const { paths } = fixture();
      mkdirSync(paths.productRoot, { recursive: true });
      const outside = join(paths.productRoot, "..", "symlink-outside");
      mkdirSync(outside);
      const link = join(paths.productRoot, "link");
      let lstat;
      try {
        symlinkSync(outside, link, "dir");
      } catch (error) {
        if (error?.code !== "EPERM") throw error;
        mkdirSync(link);
        lstat = (target) => ({ isSymbolicLink: () => target === link });
      }
      expect(() => validateAclTarget(link, { allowedRoot: paths.productRoot, lstat })).toThrow(
        /symbolic link|reparse/iu,
      );
    },
  );

  it("rejects a symbolic-link escape with injected filesystem evidence on every volume", () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const link = join(paths.productRoot, "link");
    mkdirSync(link);
    expect(() =>
      validateAclTarget(link, {
        allowedRoot: paths.productRoot,
        lstat: (target) => ({ isSymbolicLink: () => target === link }),
      }),
    ).toThrow(/symbolic link|reparse/iu);
  });

  it("22. rejects a generic reparse-point path independently of link type", () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const mount = join(paths.productRoot, "mount");
    mkdirSync(mount);
    expect(() =>
      validateAclTarget(mount, {
        allowedRoot: paths.productRoot,
        reparsePaths: [mount],
      }),
    ).toThrow(/reparse point/iu);
    expect(() =>
      validateAclTarget(paths.configDirectory, {
        allowedRoot: paths.productRoot,
        validationRoot: paths.productRoot,
        reparsePaths: [dirnameForProductRoot(paths.productRoot)],
      }),
    ).toThrow(/reparse point/iu);
  });

  it("23. rejects a known SID that does not match the initiating token", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const before = readDirectorySddl(paths.productRoot);
    await expect(
      applyRestrictedAcl(paths.productRoot, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        productRootParent: dirnameForProductRoot(paths.productRoot),
        currentUserSid: ACL_SYSTEM_SID,
        directory: true,
        policy: "product-root",
        inspect: () => ({
          exactProtected: false,
          exactRestricted: false,
          ownerSid: sid,
          protected: false,
        }),
        confirm: async () => true,
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({ AclFailureCategory: "SID_MISMATCH" }),
    });
    expect(readDirectorySddl(paths.productRoot)).toBe(before);
  });

  it("24. rejects a syntactically valid SID that cannot be resolved", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const unknownSid = "S-1-5-21-111111111-222222222-333333333-9999";
    await expect(
      applyRestrictedAcl(paths.productRoot, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        productRootParent: dirnameForProductRoot(paths.productRoot),
        currentUserSid: unknownSid,
        directory: true,
        policy: "product-root",
        inspect: () => ({
          exactProtected: false,
          exactRestricted: false,
          ownerSid: sid,
          protected: false,
        }),
        confirm: async () => true,
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({ AclFailureCategory: "UNKNOWN_SID" }),
    });
    const invalidSubauthoritySid = "S-1-5-4294967296";
    await expect(
      applyRestrictedAcl(paths.productRoot, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        productRootParent: dirnameForProductRoot(paths.productRoot),
        currentUserSid: invalidSubauthoritySid,
        directory: true,
        policy: "product-root",
        inspect: () => ({
          exactProtected: false,
          exactRestricted: false,
          ownerSid: sid,
          protected: false,
        }),
        confirm: async () => true,
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({ AclFailureCategory: "UNKNOWN_SID" }),
    });
  });

  it("25. preserves a mutation exit code and sanitized failure category", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    let thrown;
    try {
      await applyRestrictedAcl(paths.productRoot, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        currentUserSid: sid,
        directory: true,
        inspect: () => ({
          exactProtected: false,
          exactRestricted: false,
          ownerSid: sid,
          protected: false,
        }),
        confirm: async () => true,
        runMutation: () => ({
          exitCode: 25,
          stdout: JSON.stringify({
            ok: false,
            stage: "inheritance-and-grant-replacement",
            failureCategory: "MUTATION_FAILED",
            rollbackAttempted: false,
          }),
          stderr: "private-value-that-must-not-surface",
        }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown.evidence).toMatchObject({
      AclExitCode: 25,
      AclFailureCategory: "MUTATION_FAILED",
      AclElevationRequired: false,
    });
    expect(thrown.message).not.toContain("private-value-that-must-not-surface");
    expect(classifyAclFailure("ObjectNotFound: CouldNotAutoloadMatchingModule Set-Acl")).toBe(
      "POWERSHELL_MODULE_AUTOLOAD_INCOMPATIBLE",
    );
    expect(
      classifyAclFailure(
        "MethodInvocationException with inner UnauthorizedAccessException: Access is denied",
      ),
    ).toBe("ACCESS_DENIED");
    await expect(
      applyRestrictedAcl(paths.productRoot, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        currentUserSid: sid,
        directory: true,
        inspect: () => ({
          exactProtected: false,
          exactRestricted: false,
          ownerSid: sid,
          protected: false,
        }),
        confirm: async () => true,
        runMutation: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "ObjectNotFound: CouldNotAutoloadMatchingModule Set-Acl private-value",
        }),
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclExitCode: 1,
        AclFailureCategory: "POWERSHELL_MODULE_AUTOLOAD_INCOMPATIBLE",
      }),
    });
  });

  it("26. rejects malformed JSON inspection or mutation evidence", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    await expect(
      applyRestrictedAcl(paths.productRoot, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        currentUserSid: sid,
        directory: true,
        inspect: () => ({
          exactProtected: false,
          exactRestricted: false,
          ownerSid: sid,
          protected: false,
        }),
        confirm: async () => true,
        runMutation: () => ({ exitCode: 0, stdout: "not-json\nextra", stderr: "" }),
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({ AclFailureCategory: "INVALID_JSON" }),
    });
    await expect(
      repairProductRootAclElevated(paths.productRoot, {
        platform: "win32",
        productRoot: paths.productRoot,
        productRootParent: dirnameForProductRoot(paths.productRoot),
        currentUserSid: sid,
        runElevated: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "MethodInvocationException: inner UnauthorizedAccessException: Access is denied",
        }),
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclFailureCategory: "ACCESS_DENIED",
        AclElevationRequired: true,
      }),
    });
  });

  it("27. reports exact-verification failure and a successful rollback", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    await expect(
      applyRestrictedAcl(paths.productRoot, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        currentUserSid: sid,
        directory: true,
        inspect: () => ({
          exactProtected: false,
          exactRestricted: false,
          ownerSid: sid,
          protected: false,
        }),
        confirm: async () => true,
        runMutation: () => ({
          exitCode: 53,
          stdout: JSON.stringify({
            ok: false,
            stage: "exact-verification",
            failureCategory: "EXACT_VERIFICATION_FAILED",
            rollbackAttempted: true,
            rollbackSucceeded: true,
          }),
          stderr: "",
        }),
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclVerificationResult: "FAILED",
        AclRollbackResult: "PASS",
      }),
    });
    await expect(
      repairProductRootAclElevated(paths.productRoot, {
        platform: "win32",
        productRoot: paths.productRoot,
        productRootParent: dirnameForProductRoot(paths.productRoot),
        currentUserSid: sid,
        runElevated: () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            ok: false,
            exitCode: 0xa529,
            failureCategory: "ELEVATED_HELPER_FAILED",
          }),
          stderr: "",
        }),
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclStage: "exact-verification",
        AclFailureCategory: "EXACT_VERIFICATION_FAILED",
        AclRollbackAttempted: true,
        AclRollbackResult: "PASS",
      }),
    });
  });

  itWithPersistentAcls(
    "28. restores the original descriptor after an injected native post-write failure",
    async () => {
      const { paths } = fixture();
      mkdirSync(paths.productRoot, { recursive: true });
      const currentSid = resolveCurrentUserSid();
      const before = readDirectorySddl(paths.productRoot);
      await expect(
        applyRestrictedAcl(paths.productRoot, {
          platform: "win32",
          allowedRoot: paths.productRoot,
          productRootParent: dirnameForProductRoot(paths.productRoot),
          currentUserSid: currentSid,
          directory: true,
          policy: "product-root",
          testOnlyForceVerificationFailure: true,
          confirm: async () => true,
        }),
      ).rejects.toMatchObject({
        evidence: expect.objectContaining({ AclRollbackResult: "PASS" }),
      });
      expect(readDirectorySddl(paths.productRoot)).toBe(before);
      await expect(
        repairProductRootAclElevated(paths.productRoot, {
          platform: "win32",
          productRoot: paths.productRoot,
          productRootParent: dirnameForProductRoot(paths.productRoot),
          currentUserSid: currentSid,
          runElevated: () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              ok: false,
              exitCode: 0xa52a,
              failureCategory: "ELEVATED_HELPER_FAILED",
            }),
            stderr: "",
          }),
        }),
      ).rejects.toMatchObject({
        evidence: expect.objectContaining({
          AclStage: "exact-verification",
          AclFailureCategory: "EXACT_VERIFICATION_FAILED",
          AclRollbackResult: "FAILED",
          AclRecoveryCommand:
            '& "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File ".\\scripts\\phase134\\repair-production-acl.ps1"',
        }),
      });
      await expect(
        repairProductRootAclElevated(paths.productRoot, {
          platform: "win32",
          productRoot: paths.productRoot,
          productRootParent: dirnameForProductRoot(paths.productRoot),
          currentUserSid: currentSid,
          runElevated: () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              ok: false,
              exitCode: 0xa728,
              failureCategory: "ELEVATED_HELPER_FAILED",
            }),
            stderr: "",
          }),
        }),
      ).rejects.toMatchObject({
        evidence: expect.objectContaining({
          AclStage: "secure-directory-verification",
          AclVerificationResult: "FAILED",
          AclRollbackResult: "NOT_RUN",
          AclRecoveryCommand:
            '& "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File ".\\scripts\\phase134\\repair-production-acl.ps1"',
        }),
      });
    },
    20_000,
  );

  itWithPersistentAcls(
    "29. makes a repeated repair idempotent with no second mutation",
    async () => {
      const native = await sharedNativeFixture();
      const before = readDirectorySddl(native.paths.productRoot);
      const mutation = vi.fn(() => {
        throw new Error("second mutation must not run");
      });
      const second = await applyRestrictedAcl(native.paths.productRoot, {
        platform: "win32",
        allowedRoot: native.paths.productRoot,
        productRootParent: dirnameForProductRoot(native.paths.productRoot),
        currentUserSid: native.sid,
        directory: true,
        policy: "product-root",
        runMutation: mutation,
      });
      expect(second.code).toBe("ALREADY_COMPLIANT");
      expect(mutation).not.toHaveBeenCalled();
      expect(readDirectorySddl(native.paths.productRoot)).toBe(before);
    },
  );

  it("30. lets Configure-BEA continue only after the verified permission bootstrap", async () => {
    const { paths, protector } = fixture();
    const events = [];
    const answers = ["CONFIGURE LOCAL LIVE", ""];
    const result = await configureProductionBootstrap({
      paths,
      protector,
      validateAclTarget: (target) => {
        events.push(`preflight:${target}`);
        return { target };
      },
      verifyToolchain: () => {
        events.push("toolchain-readiness");
        return {
          ok: true,
          code: "TOOLCHAIN_READY",
          nodeVersion: "24.19.0",
          pnpmVersion: "11.19.0",
        };
      },
      assertBoundary: () => ({ protectedRepositoryEntered: false }),
      prompt: async () => answers.shift(),
      ensureAclBootstrap: async () => {
        events.push("permissions-verified");
        for (const directory of [
          paths.configDirectory,
          paths.secretDirectory,
          paths.runtimeDirectory,
          paths.logDirectory,
          paths.certificateDirectory,
          paths.backupDirectory,
        ]) {
          mkdirSync(directory, { recursive: true });
        }
        return { code: "REPAIRED" };
      },
      applyAcl: async (target) => {
        if (!events.some((event) => event.startsWith("first-post-repair-acl:"))) {
          events.push(`first-post-repair-acl:${target}`);
        }
        return { code: "ALREADY_COMPLIANT" };
      },
    });
    const toolchainIndex = events.indexOf("toolchain-readiness");
    const permissionsIndex = events.indexOf("permissions-verified");
    expect(toolchainIndex).toBeGreaterThan(0);
    expect(events.slice(0, toolchainIndex).every((event) => event.startsWith("preflight:"))).toBe(
      true,
    );
    expect(permissionsIndex).toBeGreaterThan(toolchainIndex);
    expect(events[permissionsIndex + 1]).toContain(paths.configDirectory);
    expect(result.configReady).toBe(true);

    const blockedError = Object.assign(new Error("reparse refused"), {
      evidence: { AclFailureCategory: "REPARSE_POINT_REFUSED" },
    });
    const verifyToolchain = vi.fn();
    const readConfig = vi.fn();
    const readStatus = vi.fn();
    const readCertificate = vi.fn();
    await expect(
      configureProductionBootstrap({
        paths,
        assertBoundary: () => ({ protectedRepositoryEntered: false }),
        validateAclTarget: () => {
          throw blockedError;
        },
        verifyToolchain,
        readConfig,
        readStatus,
        readCertificate,
      }),
    ).rejects.toBe(blockedError);
    expect(verifyToolchain).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
    expect(readStatus).not.toHaveBeenCalled();
    expect(readCertificate).not.toHaveBeenCalled();
  });

  itWithPersistentAcls(
    "31. changes neither the temporary parent ACL nor a sibling ACL",
    async () => {
      const { paths } = fixture();
      mkdirSync(paths.productRoot, { recursive: true });
      const directParent = resolve(paths.productRoot, "..");
      const validationParent = dirnameForProductRoot(paths.productRoot);
      const sibling = join(directParent, "acl-sibling");
      mkdirSync(sibling);
      const directParentBefore = readDirectorySddl(directParent);
      const validationParentBefore = readDirectorySddl(validationParent);
      const siblingBefore = readDirectorySddl(sibling);
      const currentSid = resolveCurrentUserSid();
      await applyRestrictedAcl(paths.productRoot, {
        platform: "win32",
        allowedRoot: paths.productRoot,
        productRootParent: dirnameForProductRoot(paths.productRoot),
        currentUserSid: currentSid,
        directory: true,
        policy: "product-root",
        confirm: async () => true,
      });
      expect(readDirectorySddl(directParent)).toBe(directParentBefore);
      expect(readDirectorySddl(validationParent)).toBe(validationParentBefore);
      expect(readDirectorySddl(sibling)).toBe(siblingBefore);
    },
    20_000,
  );

  it("32. uses only process-local policy and a bounded emergency recovery helper", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts", "phase134", "windows-acl.mjs"),
      "utf8",
    );
    const recoveryPath = join(process.cwd(), "scripts", "phase134", "repair-production-acl.ps1");
    const recovery = readFileSync(recoveryPath, "utf8");
    expect(source).toContain('"-ExecutionPolicy"');
    expect(source).toContain("ACL_NATIVE_REPARSE_PREFLIGHT=PASS");
    expect(source).toContain("[IO.File]::GetAttributes($current)");
    expect(source).not.toMatch(/Set-ExecutionPolicy|icacls(?:\.exe)?|Set-Acl|Get-Acl/iu);
    expect(source).not.toMatch(/CurrentVersion\\Policies|GroupPolicy|SetEnvironmentVariable/iu);
    expect(recovery).toContain("REPAIR BEA PERMISSIONS");
    expect(recovery).toContain("$startInfo.Verb = 'runas'");
    expect(recovery).toContain("[IO.Directory]::SetAccessControl");
    expect(recovery).toContain("[IO.Path]::Combine($PSHOME, 'powershell.exe')");
    expect(recovery).toContain("[Environment]::SystemDirectory");
    expect(recovery).not.toContain("$env:SystemRoot");
    expect(recovery).not.toMatch(
      /Set-ExecutionPolicy|icacls(?:\.exe)?|Set-Acl|Get-Acl|-Recurse|SetEnvironmentVariable/iu,
    );

    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const sentinel = join(paths.productRoot, "outside-target-sentinel.txt");
    writeFileSync(sentinel, "unchanged\n");
    const before = readDirectorySddl(paths.productRoot);
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const result = spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        recoveryPath,
        "-Elevated",
        "-InitiatingSid",
        resolveCurrentUserSid(),
        "-Target",
        paths.productRoot,
      ],
      { encoding: "utf8", shell: false, windowsHide: true },
    );
    expect(result.status).toBe(0xa104);
    expect(readDirectorySddl(paths.productRoot)).toBe(before);
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
  });

  it("33. confines every automated mutation target to an isolated temporary LocalAppData", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const exact = evaluatedAcl(aclEvidence(sid), sid, { allowInherited: false });
    const inherited = evaluatedAcl(
      aclEvidence(sid, {
        protectedAcl: false,
        inherited: true,
        protectedAncestor: paths.productRoot,
      }),
      sid,
    );
    const mutationTargets = [];
    await ensureProductionAclBootstrap({
      paths,
      platform: "win32",
      currentUserSid: sid,
      inspect: (target) =>
        target === paths.productRoot
          ? exact
          : expectedDirectoryAcl(paths, target, exact, inherited),
      applyAcl: async (target) => {
        mutationTargets.push(target);
        return { code: "ALREADY_COMPLIANT" };
      },
    });
    const realOwnerRoot = resolve(
      process.env.LOCALAPPDATA ?? "C:\\Users\\owner\\AppData\\Local",
      "BEA",
      "CommandCenter",
    );
    expect(paths.productRoot).not.toBe(realOwnerRoot);
    expect(mutationTargets).toEqual([
      paths.configDirectory,
      paths.secretDirectory,
      paths.runtimeDirectory,
      paths.logDirectory,
      paths.certificateDirectory,
      paths.backupDirectory,
    ]);
    expect(mutationTargets.every((target) => target.startsWith(paths.productRoot))).toBe(true);
    expect(mutationTargets).not.toContain(realOwnerRoot);
  });

  it("34. routes only structured initial-inspection access denial directly to elevation", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const exact = evaluatedAcl(aclEvidence(sid), sid, { allowInherited: false });
    const inherited = evaluatedAcl(
      aclEvidence(sid, {
        protectedAcl: false,
        inherited: true,
        protectedAncestor: paths.productRoot,
      }),
      sid,
    );
    const inspectionDenied = Object.assign(new Error("inspection access denied"), {
      evidence: {
        AclTarget: paths.productRoot,
        AclStage: "inspection",
        AclOwnerBefore: "UNKNOWN",
        AclInheritanceBefore: "UNKNOWN",
        AclCommandType: "WINDOWS_POWERSHELL_DOTNET_SECURITY_DESCRIPTOR",
        AclExitCode: 41,
        AclFailureCategory: "ACCESS_DENIED",
        AclElevationRequired: true,
        AclVerificationResult: "NOT_RUN",
        AclRollbackAttempted: false,
        AclRollbackResult: "NOT_RUN",
      },
    });
    let rootReads = 0;
    const repairNormal = vi.fn();
    const repairElevated = vi.fn(async () => ({ code: "REPAIRED_ELEVATED" }));
    const result = await ensureProductionAclBootstrap({
      paths,
      platform: "win32",
      currentUserSid: sid,
      prompt: async () => ACL_REPAIR_APPROVAL,
      inspect: (target) => {
        if (target === paths.productRoot) {
          if (rootReads++ === 0) throw inspectionDenied;
          return exact;
        }
        return expectedDirectoryAcl(paths, target, exact, inherited);
      },
      repairNormal,
      repairElevated,
      applyAcl: async () => ({ code: "ALREADY_COMPLIANT" }),
    });
    expect(repairNormal).not.toHaveBeenCalled();
    expect(repairElevated).toHaveBeenCalledTimes(1);
    expect(result.elevationUsed).toBe(true);

    await expect(
      ensureProductionAclBootstrap({
        paths,
        platform: "win32",
        currentUserSid: sid,
        prompt: async () => "",
        inspect: () => {
          throw inspectionDenied;
        },
        repairNormal,
        repairElevated,
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclFailureCategory: "ACCESS_DENIED",
        AclRecoveryCommand:
          '& "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File ".\\scripts\\phase134\\repair-production-acl.ps1"',
      }),
    });
  });

  it("35. preserves failed rollback evidence through second decline and UAC failure", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const broad = broadProductRootEvidence(sid);
    const postFailure = Object.freeze({ ...broad, ownerSid: ACL_SYSTEM_SID });
    const rollbackFailure = Object.assign(new Error("rollback failed"), {
      evidence: {
        AclTarget: paths.productRoot,
        AclStage: "exact-verification",
        AclOwnerBefore: ACL_ADMINISTRATORS_SID,
        AclInheritanceBefore: "ENABLED",
        AclCommandType: "WINDOWS_POWERSHELL_DOTNET_SECURITY_DESCRIPTOR",
        AclExitCode: 53,
        AclFailureCategory: "EXACT_VERIFICATION_FAILED",
        AclElevationRequired: false,
        AclVerificationResult: "FAILED",
        AclRollbackAttempted: true,
        AclRollbackResult: "FAILED",
      },
    });
    const repairNormal = vi.fn(async () => {
      throw rollbackFailure;
    });
    const repairElevated = vi.fn();
    const prompts = [];
    let reads = 0;
    await expect(
      ensureProductionAclBootstrap({
        paths,
        platform: "win32",
        currentUserSid: sid,
        prompt: async (text) => {
          prompts.push(text);
          return prompts.length === 1 ? ACL_REPAIR_APPROVAL : "";
        },
        inspect: () => (reads++ === 0 ? broad : postFailure),
        repairNormal,
        repairElevated,
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclRollbackAttempted: true,
        AclRollbackResult: "FAILED",
        AclRecoveryCommand:
          '& "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File ".\\scripts\\phase134\\repair-production-acl.ps1"',
      }),
    });
    expect(prompts[1]).toContain("AclOwnerBefore: S-1-5-18");
    expect(repairElevated).not.toHaveBeenCalled();

    const uacFailure = Object.assign(new Error("UAC declined"), {
      evidence: {
        AclTarget: paths.productRoot,
        AclStage: "elevation",
        AclOwnerBefore: ACL_SYSTEM_SID,
        AclInheritanceBefore: "UNKNOWN",
        AclCommandType: "WINDOWS_POWERSHELL_DOTNET_SECURITY_DESCRIPTOR_ELEVATED",
        AclExitCode: 1223,
        AclFailureCategory: "UAC_DECLINED",
        AclElevationRequired: true,
        AclVerificationResult: "NOT_RUN",
        AclRollbackAttempted: false,
        AclRollbackResult: "NOT_RUN",
      },
    });
    reads = 0;
    await expect(
      ensureProductionAclBootstrap({
        paths,
        platform: "win32",
        currentUserSid: sid,
        prompt: async () => ACL_REPAIR_APPROVAL,
        inspect: () => (reads++ === 0 ? broad : postFailure),
        repairNormal,
        repairElevated: async () => {
          throw uacFailure;
        },
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclFailureCategory: "UAC_DECLINED",
        AclRollbackAttempted: true,
        AclRollbackResult: "FAILED",
        AclRecoveryCommand:
          '& "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File ".\\scripts\\phase134\\repair-production-acl.ps1"',
      }),
    });
  });

  it("36. fails closed on a non-access initial inspection error", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const failure = Object.assign(new Error("inspection failed"), {
      evidence: { AclFailureCategory: "INSPECTION_FAILED" },
    });
    const prompt = vi.fn();
    const repairNormal = vi.fn();
    const repairElevated = vi.fn();
    await expect(
      ensureProductionAclBootstrap({
        paths,
        platform: "win32",
        currentUserSid: sid,
        inspect: () => {
          throw failure;
        },
        prompt,
        repairNormal,
        repairElevated,
      }),
    ).rejects.toBe(failure);
    expect(prompt).not.toHaveBeenCalled();
    expect(repairNormal).not.toHaveBeenCalled();
    expect(repairElevated).not.toHaveBeenCalled();
  });

  it("37. requires exactProtected evidence for config, secrets, and certificates", async () => {
    const { paths } = fixture();
    mkdirSync(paths.productRoot, { recursive: true });
    const exact = evaluatedAcl(aclEvidence(sid), sid, { allowInherited: false });
    const inherited = evaluatedAcl(
      aclEvidence(sid, {
        protectedAcl: false,
        inherited: true,
        protectedAncestor: paths.productRoot,
      }),
      sid,
    );
    await expect(
      ensureProductionAclBootstrap({
        paths,
        platform: "win32",
        currentUserSid: sid,
        inspect: (target) => (target === paths.productRoot ? exact : inherited),
        applyAcl: async () => ({ code: "ALREADY_COMPLIANT" }),
      }),
    ).rejects.toMatchObject({
      evidence: expect.objectContaining({
        AclTarget: paths.configDirectory,
        AclFailureCategory: "EXACT_VERIFICATION_FAILED",
      }),
    });
  });
});
