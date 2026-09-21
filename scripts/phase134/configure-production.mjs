import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";

import { assertRepositoryBoundary } from "../repository-boundary.mjs";
import {
  createDefaultProductionConfig,
  readProductionConfig,
  writeProductionConfigAtomic,
} from "./production-config.mjs";
import {
  inspectCertificateTrust,
  setupTrustedLocalCertificate,
  validateCertificateMetadata,
} from "./production-certificate.mjs";
import { productionPaths, repositoryRoot } from "./production-paths.mjs";
import {
  assertProtectedSecretReadiness,
  generateControlToken,
  generatePfxPassword,
  generateSessionSecret,
  readProductionSecrets,
  readSecretStatus,
  storeProductionSecrets,
} from "./production-secrets.mjs";
import { verifyPinnedToolchain } from "./toolchain-bootstrap.mjs";
import {
  applyRestrictedAcl,
  ensureProductionAclBootstrap,
  resolveCurrentUserSid,
  validateAclTargetForOperation,
} from "./windows-acl.mjs";

export const SETUP_STATE_VERSION = 1;

export function writeSetupState(state, options = {}) {
  const path = options.path ?? productionPaths.setupStateFile;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readCertificateMetadata(paths) {
  if (!existsSync(paths.certificateMetadataFile)) return undefined;
  try {
    return validateCertificateMetadata(
      JSON.parse(readFileSync(paths.certificateMetadataFile, "utf8")),
      { productRoot: paths.productRoot },
    );
  } catch {
    throw new Error("Existing Local Live certificate metadata is invalid; renewal is required.");
  }
}

async function defaultPrompt(message) {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return await terminal.question(message);
  } finally {
    terminal.close();
  }
}

async function inspectCertificateReadiness(paths, options = {}) {
  let certificate;
  let certificateInspection;
  let certificateError;
  let certificateInspectionError;
  if (options.inspectCertificates !== false) {
    if (options.certificateTargetsPrevalidated !== true) {
      const validate = options.validateAclTarget ?? validateAclTargetForOperation;
      const validationRoot = dirname(dirname(paths.productRoot));
      for (const target of [
        paths.certificateMetadataFile,
        paths.certificatePfxFile,
        paths.certificateRootFile,
      ]) {
        validate(target, {
          ...options,
          allowedRoot: paths.productRoot,
          validationRoot,
          stage: "certificate-readiness-preflight",
        });
      }
    }
    try {
      certificate = await (options.readCertificate ?? readCertificateMetadata)(paths);
    } catch (error) {
      certificateError = error;
    }
    if (certificate !== undefined && options.probeSecrets !== false) {
      try {
        const certificateSecrets = (options.readSecrets ?? readProductionSecrets)(
          ["httpsPfxPassword"],
          {
            filePath: paths.secretFile,
            allowedRoot: paths.secretDirectory,
            protector: options.protector,
          },
        );
        certificateInspection = await (options.inspectCertificateTrust ?? inspectCertificateTrust)(
          certificate,
          {
            productRoot: paths.productRoot,
            metadataValidated: true,
            pfxPassword: certificateSecrets.httpsPfxPassword,
          },
        );
      } catch (error) {
        certificateInspectionError = error;
      }
    }
  }
  const certificateReady =
    certificate !== undefined &&
    certificate.renewalWarning !== true &&
    certificateInspection?.contractValid === true &&
    certificateInspection.renewalWarning !== true;
  return Object.freeze({
    certificateReady,
    certificate,
    certificateInspection,
    certificateError: certificateError?.message,
    certificateInspectionError: certificateInspectionError?.message,
  });
}

export async function inspectBootstrapReadiness(options = {}) {
  const paths = options.paths ?? productionPaths;
  const validate = options.validateAclTarget ?? validateAclTargetForOperation;
  const validationRoot = dirname(dirname(paths.productRoot));
  for (const target of [
    paths.productRoot,
    paths.nodeExecutable,
    paths.pnpmExecutable,
    paths.configFile,
    paths.secretFile,
    paths.certificateMetadataFile,
    paths.certificatePfxFile,
    paths.certificateRootFile,
  ]) {
    validate(target, {
      ...options,
      allowedRoot: paths.productRoot,
      validationRoot,
      stage: "bootstrap-readiness-preflight",
    });
  }
  const toolchain = (options.verifyToolchain ?? verifyPinnedToolchain)({ paths });
  let config;
  let configError;
  try {
    config = (options.readConfig ?? readProductionConfig)({
      filePath: paths.configFile,
      productRoot: paths.productRoot,
    });
  } catch (error) {
    configError = error;
  }
  const configMissing = config === undefined && configError?.code === "ENOENT";
  let secrets;
  let secretError;
  if (options.inspectSecrets !== false) {
    try {
      secrets = (options.readStatus ?? readSecretStatus)({
        filePath: paths.secretFile,
        allowedRoot: paths.secretDirectory,
        protector: options.protector,
        probe: options.probeSecrets !== false,
        readinessEvidence: options.secretReadinessEvidence,
      });
    } catch (error) {
      secretError = error;
    }
  }
  const certificateState = await inspectCertificateReadiness(paths, {
    ...options,
    certificateTargetsPrevalidated: true,
  });
  const requiredSecrets = ["sessionSecret", "httpsPfxPassword", "controlToken"];
  const secretsReady =
    secrets?.available === true && requiredSecrets.every((key) => secrets.records[key].configured);
  return Object.freeze({
    toolchain,
    configReady: config !== undefined,
    configMissing,
    config,
    configError: configError?.message,
    secretsReady,
    secretStatus: secrets,
    secretError: secretError?.message,
    ...certificateState,
    readyForDatabaseAndOwnerSetup:
      toolchain.ok && config !== undefined && secretsReady && certificateState.certificateReady,
  });
}

export async function configureProductionBootstrap(options = {}) {
  const paths = options.paths ?? productionPaths;
  (options.assertBoundary ?? assertRepositoryBoundary)({ target: repositoryRoot });
  const initial = await inspectBootstrapReadiness({
    ...options,
    paths,
    inspectSecrets: false,
    probeSecrets: false,
    inspectCertificates: false,
  });
  if (!initial.toolchain.ok) {
    throw new Error("BEA-owned Node 24.19.0 and pnpm 11.19.0 are required before configuration.");
  }
  if (options.check === true) return initial;
  if (initial.configError && !initial.configMissing) {
    throw new Error(
      `Existing production configuration was preserved because it is invalid: ${initial.configError}`,
    );
  }
  if (initial.secretError) {
    throw new Error(
      `Existing protected secret vault was preserved because it is invalid: ${initial.secretError}`,
    );
  }
  const prompt = options.prompt ?? defaultPrompt;
  const approval = await prompt(
    `BEA will write protected Local Live configuration under ${paths.productRoot}, generate non-displayable runtime secrets, and install only lockfile-pinned repository dependencies with the isolated toolchain. Type CONFIGURE LOCAL LIVE to continue: `,
  );
  if (approval !== "CONFIGURE LOCAL LIVE")
    throw new Error("Owner declined Local Live configuration.");
  const aclConfirmation = async () => true;
  const applyAcl =
    options.applyAcl ??
    ((path, directoryOrOptions = false, aclOptions = {}) => {
      const resolvedAclOptions =
        typeof directoryOrOptions === "object"
          ? directoryOrOptions
          : { ...aclOptions, directory: directoryOrOptions };
      return applyRestrictedAcl(path, {
        allowedRoot: paths.productRoot,
        ...resolvedAclOptions,
        confirm: aclConfirmation,
      });
    });

  const aclBootstrap = await (options.ensureAclBootstrap ?? ensureProductionAclBootstrap)({
    paths,
    prompt,
    applyAcl: (path, aclOptions) => applyAcl(path, aclOptions),
  });

  const intendedUserSid =
    aclBootstrap?.currentUserSid ??
    options.currentUserSid ??
    (options.resolveCurrentUserSid ?? resolveCurrentUserSid)(options);
  const secretReadiness = await (options.assertSecretReadiness ?? assertProtectedSecretReadiness)({
    paths,
    intendedUserSid,
    toolchain: initial.toolchain,
    protector: options.protector,
    useInjectedProtector: options.protector !== undefined,
    trustInjectedAcl: options.ensureAclBootstrap !== undefined,
    trustInjectedToolchain: options.verifyToolchain !== undefined,
    runReadinessHelper: options.runReadinessHelper,
    helperPath: options.dpapiReadinessHelperPath,
    helperExists: options.dpapiReadinessHelperExists,
    powershellExecutable: options.dpapiPowershellExecutable,
    currentNodeExecutable: options.currentNodeExecutable,
    currentNodeVersion: options.currentNodeVersion,
    platform: options.platform,
    inspectAcl: options.inspectAcl,
    exists: options.exists,
  });

  let config =
    initial.config ?? (options.createDefaultConfig ?? createDefaultProductionConfig)({ paths });
  (options.writeConfig ?? writeProductionConfigAtomic)(config, {
    filePath: paths.configFile,
    allowedRoot: paths.configDirectory,
    productRoot: paths.productRoot,
  });
  await applyAcl(paths.configDirectory, {
    directory: true,
    policy: "protected",
    allowInherited: false,
  });
  await applyAcl(paths.configFile, {
    directory: false,
    policy: "secure-descendant",
    allowInherited: true,
  });

  const status = (options.readStatus ?? readSecretStatus)({
    filePath: paths.secretFile,
    allowedRoot: paths.secretDirectory,
    protector: options.protector,
    readinessEvidence: secretReadiness,
  });
  const missingSecrets = {};
  if (!status.records.sessionSecret.configured) {
    missingSecrets.sessionSecret = (options.generateSessionSecret ?? generateSessionSecret)();
  }
  if (!status.records.controlToken.configured) {
    missingSecrets.controlToken = (options.generateControlToken ?? generateControlToken)();
  }
  if (!status.records.httpsPfxPassword.configured) {
    missingSecrets.httpsPfxPassword = (options.generatePfxPassword ?? generatePfxPassword)();
  }
  if (Object.keys(missingSecrets).length > 0) {
    await (options.storeSecrets ?? storeProductionSecrets)(missingSecrets, {
      filePath: paths.secretFile,
      allowedRoot: paths.secretDirectory,
      protector: options.protector,
      readinessEvidence: secretReadiness,
      confirm: async () => true,
    });
  }
  await applyAcl(paths.secretDirectory, {
    directory: true,
    policy: "protected",
    allowInherited: false,
  });
  await applyAcl(paths.secretFile, {
    directory: false,
    policy: "secret-file",
    allowInherited: false,
  });

  const postSecret = await inspectCertificateReadiness(paths, {
    ...options,
    secretReadinessEvidence: secretReadiness,
  });
  if (postSecret.certificateError) {
    throw new Error(
      `Existing certificate state was preserved because validation failed: ${postSecret.certificateError}`,
    );
  }
  let certificate = postSecret.certificate;
  if (
    !certificate ||
    certificate.renewalWarning ||
    postSecret.certificateInspection?.contractValid !== true
  ) {
    const trustApproval = await prompt(
      "BEA must add its local root certificate to CurrentUser\\Root and create a bea.localhost leaf certificate. Type TRUST BEA LOCAL ROOT to approve, or press Enter to defer: ",
    );
    if (trustApproval === "TRUST BEA LOCAL ROOT") {
      const secrets = (options.readSecrets ?? readProductionSecrets)(["httpsPfxPassword"], {
        filePath: paths.secretFile,
        allowedRoot: paths.secretDirectory,
        protector: options.protector,
      });
      certificate = await (options.setupCertificate ?? setupTrustedLocalCertificate)({
        paths,
        hostname: config.hostname,
        pfxPassword: secrets.httpsPfxPassword,
        confirmTrust: async () => true,
      });
      await applyAcl(paths.certificateDirectory, {
        directory: true,
        policy: "protected",
        allowInherited: false,
      });
      await applyAcl(paths.certificatePfxFile, {
        directory: false,
        policy: "secret-file",
        allowInherited: false,
      });
      config = {
        ...config,
        https: {
          ...config.https,
          certificateThumbprint: certificate.certificateThumbprint,
          notAfter: certificate.notAfter,
        },
      };
      (options.writeConfig ?? writeProductionConfigAtomic)(config, {
        filePath: paths.configFile,
        allowedRoot: paths.configDirectory,
        productRoot: paths.productRoot,
      });
    }
  }

  const final = await inspectBootstrapReadiness({
    ...options,
    paths,
    secretReadinessEvidence: secretReadiness,
  });
  const state = {
    schemaVersion: SETUP_STATE_VERSION,
    profile: "local-live",
    completed: {
      toolchain: final.toolchain.ok,
      config: final.configReady,
      secrets: final.secretsReady,
      certificate: final.certificateReady,
    },
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  (options.writeState ?? writeSetupState)(state, { path: paths.setupStateFile });
  await applyAcl(paths.setupStateFile, {
    directory: false,
    policy: "secure-descendant",
    allowInherited: true,
  });
  return final;
}

function parseArguments(arguments_) {
  if (arguments_.length === 0) return { check: false };
  if (arguments_.length === 1 && arguments_[0] === "--check") return { check: true };
  throw new Error("Usage: Configure-BEA.cmd [--check]");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await configureProductionBootstrap(options);
  process.stdout.write("BEA Local Live Production bootstrap\n");
  process.stdout.write(`[${result.toolchain.ok ? "PASS" : "BLOCKED"}] BEA-owned toolchain\n`);
  process.stdout.write(`[${result.configReady ? "PASS" : "SETUP REQUIRED"}] Production config\n`);
  process.stdout.write(
    `[${result.secretsReady ? "PASS" : "SETUP REQUIRED"}] Protected runtime secrets\n`,
  );
  process.stdout.write(
    `[${result.certificateReady ? "PASS" : "SETUP REQUIRED"}] Trusted local HTTPS\n`,
  );
  process.stdout.write(
    "[SETUP REQUIRED] PostgreSQL, Local Owner credentials, migrations, and build\n",
  );
  process.stdout.write(
    `BEA_PHASE134_BOOTSTRAP=${result.readyForDatabaseAndOwnerSetup ? "READY_FOR_NEXT_SETUP" : "SETUP_REQUIRED"}\n`,
  );
  process.exitCode = options.check && !result.readyForDatabaseAndOwnerSetup ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    if (error?.code === "BEA_PROTECTED_SECRET_READINESS_FAILED" && error.evidence) {
      process.stderr.write(
        `BEA_PROTECTED_SECRET_READINESS_EVIDENCE=${JSON.stringify(error.evidence)}\n`,
      );
    }
    process.stderr.write(
      `BEA_PHASE134_BOOTSTRAP=BLOCKED (${error instanceof Error ? error.message : "UnknownError"})\n`,
    );
    process.exitCode = 1;
  });
}
