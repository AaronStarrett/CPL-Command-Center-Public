import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryBoundary } from "./repository-boundary.mjs";
import {
  EXPECTED_GITHUB_REPOSITORY,
  EXPECTED_REPOSITORY,
  localAppDataCleanupTargets,
  OPTIONAL_CLEANUP_APPROVALS,
  REPOSITORY_CLEANUP_TARGETS,
} from "./phase135/local-storage-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const configuredLocalAppData = process.env.LOCALAPPDATA?.trim() || null;
const localAppData = configuredLocalAppData ?? path.join(os.homedir(), "AppData", "Local");
const productRoot = path.join(localAppData, "BEA", "CommandCenter");
export const TOOLCHAIN_OPERATION_LOCK_NAME = ".bea-toolchain-operation.lock";
const toolchainOperationLockPath = path.join(
  productRoot,
  "toolchain",
  TOOLCHAIN_OPERATION_LOCK_NAME,
);
const protectedRepository = "C:\\CPL-Dev\\Cyber Pirate Labs Command Center";
const potentialMutatingProcessNames = Object.freeze([
  "node.exe",
  "npm.exe",
  "pnpm.exe",
  "turbo.exe",
  "esbuild.exe",
  "swc.exe",
  "vitest.exe",
  "playwright.exe",
]);
const knownBeaPorts = Object.freeze([
  3_000, 3_001, 3_002, 3_100, 3_101, 3_102, 3_210, 3_211, 3_212, 3_443, 3_444,
]);
const productionStartWindowMilliseconds = 5 * 60 * 1_000;

export function isPotentialMutatingProcessName(value) {
  return potentialMutatingProcessNames.includes(String(value).toLowerCase());
}

function normalizeWindowsText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("/", "\\")
    .replace(/\\+$/u, "");
}

function executableWithin(candidate, parent) {
  if (
    !path.win32.isAbsolute(String(candidate ?? "")) ||
    !path.win32.isAbsolute(String(parent ?? ""))
  ) {
    return false;
  }
  const executable = normalizeWindowsText(path.win32.resolve(candidate));
  const root = normalizeWindowsText(path.win32.resolve(parent));
  return Boolean(executable && root && (executable === root || executable.startsWith(root + "\\")));
}

const exactBeaScriptCategories = Object.freeze(
  new Map([
    ["scripts\\preview-start.mjs", "PREVIEW_RUNTIME"],
    ["scripts\\preview-stop.mjs", "PREVIEW_RUNTIME"],
    ["scripts\\preview-supervisor.mjs", "PREVIEW_RUNTIME"],
    ["scripts\\demo-start.mjs", "DEMO_RUNTIME"],
    ["scripts\\demo-stop.mjs", "DEMO_RUNTIME"],
    ["scripts\\demo-supervisor.mjs", "DEMO_RUNTIME"],
    ["scripts\\phase133\\production-preflight.mjs", "PRODUCTION_RUNTIME"],
    ["scripts\\phase133\\production-start.mjs", "PRODUCTION_RUNTIME"],
    ["scripts\\phase133\\production-stop.mjs", "PRODUCTION_RUNTIME"],
    ["scripts\\phase134\\production-start.mjs", "PRODUCTION_RUNTIME"],
    ["scripts\\phase134\\production-stop.mjs", "PRODUCTION_RUNTIME"],
    ["scripts\\phase134\\production-supervisor.mjs", "PRODUCTION_RUNTIME"],
    ["scripts\\phase134\\https-gateway.mjs", "PRODUCTION_RUNTIME"],
    ["scripts\\phase134\\ensure-toolchain.ps1", "TOOLCHAIN_PROVISIONER"],
    ["scripts\\run-guarded.mjs", "BUILD_OR_VERIFICATION"],
    ["scripts\\next-no-env.mjs", "NEXT_BUILD"],
    ["scripts\\web-startup-smoke.ts", "BUILD_OR_VERIFICATION"],
    ["scripts\\worker-startup-smoke.ts", "BUILD_OR_VERIFICATION"],
    ["scripts\\verify-phase0.ps1", "BUILD_OR_VERIFICATION"],
    ["scripts\\verify-phase1.mjs", "BUILD_OR_VERIFICATION"],
    ["scripts\\verify-phase1-1.mjs", "BUILD_OR_VERIFICATION"],
    ["scripts\\verify-phase1-2.mjs", "BUILD_OR_VERIFICATION"],
    ["scripts\\verify-phase1-3-1.mjs", "BUILD_OR_VERIFICATION"],
    ["scripts\\verify-phase1-3-2.mjs", "BUILD_OR_VERIFICATION"],
    ["scripts\\verify-phase1-3-3.mjs", "BUILD_OR_VERIFICATION"],
    ["scripts\\verify-phase1-3-4.mjs", "BUILD_OR_VERIFICATION"],
    ["scripts\\verify-phase1-3-4-real-postgres.mjs", "BUILD_OR_VERIFICATION"],
    ["scripts\\verify-phase1-3-5.mjs", "BUILD_OR_VERIFICATION"],
  ]),
);

function tokenizeCommandLine(value) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const character of String(value ?? "")) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
    } else if (/\s/u.test(character) && !quote) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function primaryCommandTarget(processRecord) {
  const tokens = tokenizeCommandLine(processRecord?.commandLine);
  const name = String(processRecord?.name ?? "").toLowerCase();
  if (["powershell.exe", "pwsh.exe"].includes(name)) {
    const fileIndex = tokens.findIndex((token) => token.toLowerCase() === "-file");
    const commandIndex = tokens.findIndex((token) =>
      ["-c", "-command", "-ec", "-encodedcommand"].includes(token.toLowerCase()),
    );
    const validFileSelector = fileIndex > 0 && (commandIndex < 0 || commandIndex > fileIndex);
    return {
      index: validFileSelector ? fileIndex + 1 : -1,
      target: validFileSelector ? tokens[fileIndex + 1] : undefined,
      tokens,
    };
  }
  if (name === "node.exe") {
    let index = 1;
    const optionsWithSeparateValue = new Set([
      "--import",
      "--loader",
      "--experimental-loader",
      "--require",
      "-r",
    ]);
    while (index < tokens.length && tokens[index].startsWith("-")) {
      const option = tokens[index].toLowerCase();
      if (
        ["-e", "--eval", "-p", "--print"].includes(option) ||
        option.startsWith("--eval=") ||
        option.startsWith("--print=")
      ) {
        return { index: -1, target: undefined, tokens };
      }
      index += optionsWithSeparateValue.has(option) ? 2 : 1;
    }
    return { index, target: tokens[index], tokens };
  }
  return { index: 0, target: processRecord?.executablePath || tokens[0], tokens };
}

function relativeCommandPath(value) {
  return normalizeWindowsText(value).replace(/^\.\\/u, "");
}

function exactScriptMatch(target, expectedRepository, relativePath) {
  const normalizedTarget = normalizeWindowsText(target);
  const normalizedRelativeTarget = relativeCommandPath(target);
  return {
    relative:
      normalizedRelativeTarget === relativePath ||
      normalizedRelativeTarget === `..\\..\\${relativePath}`,
    repository:
      path.win32.isAbsolute(String(target ?? "")) &&
      normalizeWindowsText(path.win32.resolve(normalizedTarget)) ===
        normalizeWindowsText(path.win32.join(expectedRepository, relativePath)),
  };
}

function repositoryNodeModulesTarget(target, expectedRepository, suffixPattern) {
  if (!path.win32.isAbsolute(String(target ?? ""))) return false;
  const normalizedTarget = normalizeWindowsText(path.win32.resolve(target));
  const nodeModulesRoot = normalizeWindowsText(path.win32.join(expectedRepository, "node_modules"));
  return (
    normalizedTarget.startsWith(nodeModulesRoot + "\\") &&
    suffixPattern.test(normalizedTarget.slice(nodeModulesRoot.length + 1))
  );
}

function exactToolchainNode(executablePath, toolchainRoot) {
  return (
    normalizeWindowsText(executablePath) ===
    normalizeWindowsText(path.win32.join(toolchainRoot, "node-v24.19.0-win-x64", "node.exe"))
  );
}

function classifyExpectedBeaProcess(processRecord, options = {}) {
  const expectedRepository = options.repositoryRoot ?? repositoryRoot;
  const expectedToolchainRoot = options.toolchainRoot ?? path.join(productRoot, "toolchain");
  const launch = primaryCommandTarget(processRecord);
  const target = launch.target ?? "";
  for (const [relativePath, category] of exactBeaScriptCategories) {
    const match = exactScriptMatch(target, expectedRepository, relativePath);
    if (match.repository || match.relative) {
      return {
        category,
        repositoryMatch: match.repository,
        toolchainMatch: exactToolchainNode(processRecord?.executablePath, expectedToolchainRoot),
      };
    }
  }

  for (const [relativePath, category] of [
    ["apps\\worker\\src\\index.ts", "WORKER_RUNTIME"],
    ["apps\\worker\\dist\\index.js", "WORKER_RUNTIME"],
  ]) {
    const match = exactScriptMatch(target, expectedRepository, relativePath);
    if (match.repository) {
      return { category, repositoryMatch: true, toolchainMatch: false };
    }
  }

  const executableInRepositoryModules = executableWithin(
    processRecord?.executablePath,
    path.win32.join(expectedRepository, "node_modules"),
  );
  const name = String(processRecord?.name ?? "").toLowerCase();
  if (name === "turbo.exe" && executableInRepositoryModules) {
    return { category: "TURBO_BUILD", repositoryMatch: true, toolchainMatch: false };
  }
  if (["esbuild.exe", "swc.exe"].includes(name) && executableInRepositoryModules) {
    return {
      category: "BUILD_OR_VERIFICATION",
      repositoryMatch: true,
      toolchainMatch: false,
    };
  }
  if (name === "vitest.exe" && executableInRepositoryModules) {
    return { category: "VITEST_RUN", repositoryMatch: true, toolchainMatch: false };
  }
  if (name === "playwright.exe" && executableInRepositoryModules) {
    return { category: "PLAYWRIGHT_RUN", repositoryMatch: true, toolchainMatch: false };
  }

  if (repositoryNodeModulesTarget(target, expectedRepository, /(?:^|\\)turbo\\bin\\turbo$/u)) {
    return { category: "TURBO_BUILD", repositoryMatch: true, toolchainMatch: false };
  }
  if (
    repositoryNodeModulesTarget(
      target,
      expectedRepository,
      /(?:^|\\)next\\dist\\bin\\next(?:\.js)?$/u,
    )
  ) {
    return { category: "NEXT_BUILD", repositoryMatch: true, toolchainMatch: false };
  }
  if (
    repositoryNodeModulesTarget(
      target,
      expectedRepository,
      /(?:^|\\)vitest\\(?:vitest\.mjs|dist\\cli\.js)$/u,
    )
  ) {
    return { category: "VITEST_RUN", repositoryMatch: true, toolchainMatch: false };
  }
  if (
    repositoryNodeModulesTarget(target, expectedRepository, /(?:^|\\)@playwright\\test\\cli\.js$/u)
  ) {
    return { category: "PLAYWRIGHT_RUN", repositoryMatch: true, toolchainMatch: false };
  }
  if (repositoryNodeModulesTarget(target, expectedRepository, /(?:^|\\)typescript\\bin\\tsc$/u)) {
    return {
      category: "BUILD_OR_VERIFICATION",
      repositoryMatch: true,
      toolchainMatch: false,
    };
  }
  if (repositoryNodeModulesTarget(target, expectedRepository, /(?:^|\\)tsx\\dist\\cli\.mjs$/u)) {
    const argumentsAfterTarget = launch.tokens.slice(launch.index + 1).map(relativeCommandPath);
    const relativeWorker = argumentsAfterTarget.includes("src\\index.ts");
    const absoluteWorker = argumentsAfterTarget.includes(
      normalizeWindowsText(
        path.win32.join(expectedRepository, "apps", "worker", "src", "index.ts"),
      ),
    );
    const workerMode =
      argumentsAfterTarget.includes("--serve") || argumentsAfterTarget.includes("--once");
    if ((relativeWorker || absoluteWorker) && workerMode) {
      return { category: "WORKER_RUNTIME", repositoryMatch: true, toolchainMatch: false };
    }
  }

  const toolchainMatch = exactToolchainNode(processRecord?.executablePath, expectedToolchainRoot);
  const normalizedTokens = launch.tokens.map(normalizeWindowsText);
  const expectedCorepack = normalizeWindowsText(
    path.win32.join(
      expectedToolchainRoot,
      "node-v24.19.0-win-x64",
      "node_modules",
      "corepack",
      "dist",
      "corepack.js",
    ),
  );
  const corepackPnpmLaunch =
    toolchainMatch &&
    normalizeWindowsText(target) === expectedCorepack &&
    normalizedTokens[launch.index + 1] === "pnpm";
  if (corepackPnpmLaunch) {
    const filterIndex = normalizedTokens.findIndex(
      (token, index) => index > launch.index + 1 && ["--filter", "-f"].includes(token),
    );
    const filteredPackage = filterIndex >= 0 ? normalizedTokens[filterIndex + 1] : undefined;
    if (filteredPackage === "@bea\\web") {
      return { category: "NEXT_BUILD", repositoryMatch: false, toolchainMatch: true };
    }
    if (filteredPackage === "@bea\\worker") {
      return { category: "WORKER_RUNTIME", repositoryMatch: false, toolchainMatch: true };
    }
  }
  return null;
}

function processStartMatches(expected, actual, options = {}) {
  const expectedTime = Date.parse(expected ?? "");
  const actualTime = Date.parse(actual ?? "");
  if (!Number.isFinite(expectedTime) || !Number.isFinite(actualTime)) return false;
  if (options.exact === true) return expectedTime === actualTime;
  const difference = expectedTime - actualTime;
  return difference >= 0 && difference <= productionStartWindowMilliseconds;
}

function commandLineFingerprint(commandLine) {
  return createHash("sha256")
    .update(String(commandLine ?? ""), "utf8")
    .digest("hex");
}

function exactNodeScriptLaunch(processRecord, expectedScript) {
  const launch = primaryCommandTarget(processRecord);
  return (
    String(processRecord?.name ?? "").toLowerCase() === "node.exe" &&
    launch.tokens.length === 2 &&
    normalizeWindowsText(launch.tokens[0]) === normalizeWindowsText(processRecord.executablePath) &&
    normalizeWindowsText(launch.target) === normalizeWindowsText(expectedScript)
  );
}

export function productionSupervisorFingerprint(executable, supervisorScript) {
  return createHash("sha256")
    .update(
      JSON.stringify([path.resolve(executable).toLowerCase(), path.resolve(supervisorScript)]),
    )
    .digest("hex");
}

export function isToolchainProvisionerProcess(processRecord, options = {}) {
  const name = String(processRecord?.name ?? "").toLowerCase();
  if (!["powershell.exe", "pwsh.exe"].includes(name)) return false;
  const classification = classifyExpectedBeaProcess(processRecord, options);
  return (
    classification?.category === "TOOLCHAIN_PROVISIONER" &&
    (classification.repositoryMatch || classification.toolchainMatch)
  );
}

function metadataStatus(result) {
  if (!result?.exists) return "ABSENT";
  return result.metadata ? "VALIDATED" : "INVALID_IGNORED";
}

function validProcessRecord(value) {
  return (
    value &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.name === "string" &&
    value.name.trim() !== "" &&
    typeof value.executablePath === "string" &&
    value.executablePath.trim() !== "" &&
    typeof value.commandLine === "string" &&
    value.commandLine.trim() !== "" &&
    typeof value.osStartedAt === "string" &&
    !Number.isNaN(Date.parse(value.osStartedAt))
  );
}

function safeOwnershipEvidence(input) {
  return {
    category: input.category,
    pid: input.pid,
    ownershipSource: input.ownershipSource,
    repositoryMatch: input.repositoryMatch === true,
    toolchainMatch: input.toolchainMatch === true,
    metadataMatch: input.metadataMatch === true,
    startTimeMatch: input.startTimeMatch === true,
    portMatch: false,
  };
}

export function evaluateBeaRuntimeOwnership(snapshot = {}, options = {}) {
  const expectedRepository = options.repositoryRoot ?? repositoryRoot;
  const expectedToolchainRoot = options.toolchainRoot ?? path.join(productRoot, "toolchain");
  const sourceProcesses = Array.isArray(snapshot.processes) ? snapshot.processes : [];
  const invalidProcessRecordCount = sourceProcesses.filter(
    (processRecord) => !validProcessRecord(processRecord),
  ).length;
  const processes = sourceProcesses.filter(validProcessRecord);
  const sourceListeners = Array.isArray(snapshot.listeners) ? snapshot.listeners : [];
  const invalidListenerRecordCount = sourceListeners.filter(
    (listener) =>
      !Number.isSafeInteger(listener?.port) ||
      listener.port < 1 ||
      listener.port > 65_535 ||
      !Number.isSafeInteger(listener?.pid) ||
      listener.pid < 1,
  ).length;
  const processByPid = new Map(
    processes.map((processRecord) => [processRecord.pid, processRecord]),
  );
  const evidenceByPid = new Map();
  const metadata = {
    preview: metadataStatus(snapshot.previewMetadata),
    production: metadataStatus(snapshot.productionMetadata),
  };
  const addEvidence = (evidence) => {
    if (!evidenceByPid.has(evidence.pid)) {
      evidenceByPid.set(evidence.pid, safeOwnershipEvidence(evidence));
    }
  };

  const preview = snapshot.previewMetadata?.metadata;
  if (preview?.supervisorOsIdentity) {
    const expected = preview.supervisorOsIdentity;
    const actual = processByPid.get(expected.pid);
    if (!actual) {
      metadata.preview = "STALE_IGNORED";
    } else {
      const repositoryMatch =
        normalizeWindowsText(preview.repositoryRoot) === normalizeWindowsText(expectedRepository);
      const toolchainMatch = executableWithin(actual.executablePath, expectedToolchainRoot);
      const executableMatch =
        normalizeWindowsText(expected.executablePath) ===
        normalizeWindowsText(actual.executablePath);
      const commandMatch =
        expected.commandLineFingerprint === commandLineFingerprint(actual.commandLine);
      const startTimeMatch = processStartMatches(expected.osStartedAt, actual.osStartedAt, {
        exact: true,
      });
      const metadataMatch =
        expected.pid === actual.pid && executableMatch && commandMatch && startTimeMatch;
      if (repositoryMatch && toolchainMatch && metadataMatch) {
        metadata.preview = "ACTIVE";
        addEvidence({
          category: "PREVIEW_RUNTIME",
          pid: actual.pid,
          ownershipSource: "PREVIEW_METADATA",
          repositoryMatch,
          toolchainMatch,
          metadataMatch,
          startTimeMatch,
        });
      } else {
        metadata.preview = "MISMATCHED_IGNORED";
      }
    }
  }

  const production = snapshot.productionMetadata?.metadata;
  if (production?.supervisorPid) {
    const actual = processByPid.get(production.supervisorPid);
    if (!actual) {
      metadata.production = "STALE_IGNORED";
    } else {
      const scriptMatch = exactNodeScriptLaunch(actual, production.supervisorScript);
      const repositoryMatch =
        normalizeWindowsText(production.repositoryRoot) ===
          normalizeWindowsText(expectedRepository) && scriptMatch;
      const toolchainMatch = exactToolchainNode(actual.executablePath, expectedToolchainRoot);
      const executableMatch =
        normalizeWindowsText(production.supervisorExecutable) ===
        normalizeWindowsText(actual.executablePath);
      const fingerprintMatch =
        production.supervisorFingerprint ===
        productionSupervisorFingerprint(actual.executablePath, production.supervisorScript);
      const startTimeMatch = processStartMatches(production.startedAt, actual.osStartedAt);
      const metadataMatch =
        production.supervisorPid === actual.pid &&
        executableMatch &&
        scriptMatch &&
        fingerprintMatch &&
        startTimeMatch;
      if (repositoryMatch && toolchainMatch && metadataMatch) {
        metadata.production = "ACTIVE";
        addEvidence({
          category: "PRODUCTION_RUNTIME",
          pid: actual.pid,
          ownershipSource: "PRODUCTION_METADATA",
          repositoryMatch,
          toolchainMatch,
          metadataMatch,
          startTimeMatch,
        });
      } else {
        metadata.production = "MISMATCHED_IGNORED";
      }
    }
  }

  const candidates = processes.filter(
    (processRecord) =>
      isPotentialMutatingProcessName(processRecord.name) ||
      classifyExpectedBeaProcess(processRecord, {
        repositoryRoot: expectedRepository,
        toolchainRoot: expectedToolchainRoot,
      }) !== null,
  );
  for (const processRecord of candidates) {
    if (evidenceByPid.has(processRecord.pid)) continue;
    const classification = classifyExpectedBeaProcess(processRecord, {
      repositoryRoot: expectedRepository,
      toolchainRoot: expectedToolchainRoot,
    });
    if (classification && (classification.repositoryMatch || classification.toolchainMatch)) {
      addEvidence({
        category: classification.category,
        pid: processRecord.pid,
        ownershipSource: classification.repositoryMatch ? "REPOSITORY_COMMAND" : "BEA_TOOLCHAIN",
        repositoryMatch: classification.repositoryMatch,
        toolchainMatch: classification.toolchainMatch,
        metadataMatch: false,
        startTimeMatch: false,
      });
    }
  }

  const configuredPorts = new Set([
    ...knownBeaPorts,
    ...(Array.isArray(snapshot.configuredPorts) ? snapshot.configuredPorts : []),
  ]);
  const relevantListeners = sourceListeners.filter(
    (listener) =>
      Number.isSafeInteger(listener?.port) &&
      configuredPorts.has(listener.port) &&
      Number.isSafeInteger(listener?.pid) &&
      listener.pid > 0,
  );
  for (const evidence of evidenceByPid.values()) {
    evidence.portMatch = relevantListeners.some((listener) => listener.pid === evidence.pid);
  }

  const ignored = candidates.filter((processRecord) => !evidenceByPid.has(processRecord.pid));
  const unrelatedNodeCount = ignored.filter(
    (processRecord) => String(processRecord.name).toLowerCase() === "node.exe",
  ).length;
  const unrelatedBuildCount = ignored.length - unrelatedNodeCount;
  const ignoredProcesses = [
    {
      category: "UNRELATED_NODE_PROCESSES_IGNORED",
      count: unrelatedNodeCount,
    },
    {
      category: "UNRELATED_BUILD_PROCESSES_IGNORED",
      count: unrelatedBuildCount,
    },
  ].filter((entry) => entry.count > 0);
  const ownershipEvidence = [...evidenceByPid.values()].sort(
    (left, right) => left.pid - right.pid || left.category.localeCompare(right.category),
  );
  const inspection =
    (snapshot.inspection ?? "VERIFIED") === "VERIFIED" &&
    invalidProcessRecordCount === 0 &&
    invalidListenerRecordCount === 0
      ? "VERIFIED"
      : "UNVERIFIED";
  const blockers = [
    ...new Set(
      ownershipEvidence.map((evidence) => `BEA_OWNED_PROCESS_RUNNING:${evidence.category}`),
    ),
  ].sort();
  if (inspection !== "VERIFIED") blockers.push("PROCESS_STATE_UNVERIFIED");
  const ownedListenerCount = relevantListeners.filter((listener) =>
    evidenceByPid.has(listener.pid),
  ).length;

  return {
    stopped: blockers.length === 0,
    blockers,
    ownershipEvidence,
    metadata,
    ignoredProcesses,
    ignoredPortListeners: {
      category: "UNRELATED_BEA_PORT_LISTENERS_IGNORED",
      count: relevantListeners.length - ownedListenerCount,
    },
    inspection,
    warnings: [
      ...(Array.isArray(snapshot.warnings) ? snapshot.warnings : []),
      ...(invalidProcessRecordCount > 0 ? ["PROCESS_RECORD_IDENTITY_UNVERIFIED"] : []),
      ...(invalidListenerRecordCount > 0 ? ["PORT_LISTENER_IDENTITY_UNVERIFIED"] : []),
    ],
  };
}

export function parseMode(arguments_) {
  if (arguments_.length !== 1 || !["--dry-run", "--safe"].includes(arguments_[0])) {
    throw new Error("Usage: node scripts/local-storage-audit.mjs --dry-run|--safe");
  }
  return arguments_[0] === "--safe" ? "safe" : "dry-run";
}

function normalize(candidate) {
  return path
    .resolve(candidate)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

export function isContained(parent, candidate) {
  const root = normalize(parent);
  const child = normalize(candidate);
  return child === root || child.startsWith(root + path.sep.toLowerCase());
}

function command(executable, arguments_, options = {}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toUpperCase().startsWith("GIT_") &&
        !key.toUpperCase().startsWith("GITHUB_") &&
        !key.toUpperCase().startsWith("GH_"),
    ),
  );
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: {
      ...environment,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
    windowsHide: true,
  });
  const allowed = options.allowedStatuses ?? [0];
  if (result.error || result.status === null || !allowed.includes(result.status)) {
    throw new Error(options.errorCode ?? "COMMAND_FAILED");
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function git(arguments_, options = {}) {
  return command(
    "git",
    [
      "--git-dir",
      path.join(repositoryRoot, ".git"),
      "--work-tree",
      repositoryRoot,
      "-c",
      "safe.directory=" + repositoryRoot.replaceAll("\\", "/"),
      ...arguments_,
    ],
    options,
  );
}

export function measurePathNoFollow(candidate) {
  const result = {
    exists: false,
    bytes: 0,
    files: 0,
    directories: 0,
    reparsePoints: 0,
    errors: [],
  };
  if (!existsSync(candidate)) return result;
  result.exists = true;
  const pending = [candidate];
  while (pending.length > 0) {
    const current = pending.pop();
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        result.reparsePoints += 1;
        continue;
      }
      if (metadata.isDirectory()) {
        result.directories += 1;
        for (const name of readdirSync(current)) pending.push(path.join(current, name));
      } else if (metadata.isFile()) {
        result.files += 1;
        result.bytes += metadata.size;
      }
    } catch (error) {
      result.errors.push({
        path: current,
        code: typeof error?.code === "string" ? error.code : "ENUMERATION_FAILED",
      });
    }
  }
  return result;
}

function ensureExistingPathHasNoReparse(candidate) {
  const resolved = path.resolve(candidate);
  const root = path.parse(resolved).root;
  let current = root;
  const relationship = path.relative(root, resolved);
  for (const segment of relationship.split(/[\\/]/u).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error("REPARSE_POINT_IN_TRUSTED_PATH");
  }
}

export function ensureSafeTree(candidate, allowedRoot) {
  if (!isContained(allowedRoot, candidate)) throw new Error("TARGET_OUTSIDE_ALLOWLIST_ROOT");
  if (isContained(protectedRepository, candidate) || isContained(candidate, protectedRepository)) {
    throw new Error("PROTECTED_REPOSITORY_TARGET");
  }
  ensureExistingPathHasNoReparse(allowedRoot);
  ensureExistingPathHasNoReparse(candidate);
  if (existsSync(allowedRoot) && existsSync(candidate)) {
    const canonicalRoot = realpathSync.native(allowedRoot);
    const canonicalCandidate = realpathSync.native(candidate);
    if (!isContained(canonicalRoot, canonicalCandidate)) {
      throw new Error("CANONICAL_TARGET_OUTSIDE_ALLOWLIST_ROOT");
    }
  }
  const measurement = measurePathNoFollow(candidate);
  if (measurement.errors.length > 0) throw new Error("TARGET_ENUMERATION_FAILED");
  if (measurement.reparsePoints > 0) throw new Error("REPARSE_POINT_IN_TARGET_TREE");
  return measurement;
}

function identityFor(metadata) {
  return { dev: metadata.dev, ino: metadata.ino };
}

function identitiesMatch(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

export function ownsExactLock(lockPath, descriptor, expectedIdentity) {
  if (descriptor === undefined || !expectedIdentity) return false;
  try {
    const descriptorIdentity = identityFor(fstatSync(descriptor));
    const pathMetadata = lstatSync(lockPath);
    return (
      !pathMetadata.isSymbolicLink() &&
      identitiesMatch(descriptorIdentity, expectedIdentity) &&
      identitiesMatch(identityFor(pathMetadata), expectedIdentity)
    );
  } catch {
    return false;
  }
}

export function toolchainOperationLockBlocks(lockPath, ownedLock) {
  if (ownedLock) {
    return !ownsExactLock(lockPath, ownedLock.descriptor, ownedLock.identity);
  }
  return existsSync(lockPath);
}

export function captureSafePathIdentity(candidate, allowedRoot) {
  ensureSafeTree(candidate, allowedRoot);
  if (!existsSync(candidate)) throw new Error("IDENTITY_TARGET_MISSING");
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink()) throw new Error("REPARSE_POINT_DURING_IDENTITY_CAPTURE");
  return identityFor(metadata);
}

export function assertSafePathIdentity(candidate, allowedRoot, expectedIdentity) {
  if (!isContained(allowedRoot, candidate)) throw new Error("IDENTITY_TARGET_OUTSIDE_ROOT");
  ensureExistingPathHasNoReparse(candidate);
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !identitiesMatch(identityFor(metadata), expectedIdentity)) {
    throw new Error("PATH_IDENTITY_CHANGED");
  }
}

function repositoryState() {
  const branch = git(["branch", "--show-current"]).stdout;
  const localHead = git(["rev-parse", "HEAD"]).stdout;
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
  let upstream = null;
  try {
    upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).stdout;
  } catch {
    upstream = null;
  }
  return { branch, localHead, clean: status === "", upstream };
}

function normalizeOriginUrl(value) {
  const normalized = value.trim().replace(/\.git$/iu, "");
  if (
    normalized === "https://github.com/" + EXPECTED_GITHUB_REPOSITORY ||
    normalized === "git@github.com:" + EXPECTED_GITHUB_REPOSITORY ||
    normalized === "ssh://git@github.com/" + EXPECTED_GITHUB_REPOSITORY
  ) {
    return EXPECTED_GITHUB_REPOSITORY;
  }
  return null;
}

export function verifyPrivateRemote() {
  const state = repositoryState();
  const blockers = [];
  const remotes = git(["remote"]).stdout.split(/\r?\n/u).filter(Boolean);
  if (remotes.length !== 1 || remotes[0] !== "origin") blockers.push("EXACT_ORIGIN_REQUIRED");

  let origin = null;
  if (remotes.includes("origin")) {
    const urls = git(["remote", "get-url", "--all", "origin"])
      .stdout.split(/\r?\n/u)
      .filter(Boolean);
    if (urls.length === 1) origin = normalizeOriginUrl(urls[0]);
    if (origin !== EXPECTED_GITHUB_REPOSITORY) blockers.push("ORIGIN_URL_MISMATCH");
  }

  let github = null;
  try {
    const login = JSON.parse(
      command("gh", ["api", "--hostname", "github.com", "user"], {
        timeout: 45_000,
      }).stdout,
    ).login;
    const repository = JSON.parse(
      command("gh", ["api", "--hostname", "github.com", "repos/" + EXPECTED_GITHUB_REPOSITORY], {
        timeout: 45_000,
      }).stdout,
    );
    github = {
      login,
      defaultBranch: repository.default_branch,
      fullName: repository.full_name,
      owner: repository.owner?.login,
      private: repository.private,
      visibility: repository.visibility,
    };
    if (login !== "AaronStarrett") blockers.push("GITHUB_LOGIN_MISMATCH");
    if (
      github.fullName !== EXPECTED_GITHUB_REPOSITORY ||
      github.owner !== "AaronStarrett" ||
      github.private !== true ||
      github.visibility !== "private" ||
      github.defaultBranch !== "main"
    ) {
      blockers.push("PRIVATE_REPOSITORY_ATTESTATION_FAILED");
    }
  } catch {
    blockers.push("GITHUB_API_UNVERIFIED");
  }

  let remoteHead = null;
  let trackingHead = null;
  if (origin) {
    try {
      const remoteLine = git(["ls-remote", "--exit-code", "origin", "refs/heads/main"], {
        timeout: 45_000,
      }).stdout;
      const lines = remoteLine.split(/\r?\n/u).filter(Boolean);
      if (lines.length === 1) remoteHead = lines[0].split(/\s+/u)[0] ?? null;
      else blockers.push("REMOTE_MAIN_AMBIGUOUS");
    } catch {
      blockers.push("REMOTE_MAIN_UNREACHABLE");
    }
    try {
      trackingHead = git(["rev-parse", "origin/main"]).stdout;
    } catch {
      blockers.push("TRACKING_BRANCH_MISSING");
    }
  }

  if (state.branch !== "main") blockers.push("MAIN_BRANCH_REQUIRED");
  if (!state.clean) blockers.push("CLEAN_TREE_REQUIRED");
  if (state.upstream !== "origin/main") blockers.push("UPSTREAM_MISMATCH");
  if (!remoteHead || remoteHead !== state.localHead) blockers.push("REMOTE_HEAD_MISMATCH");
  if (!trackingHead || trackingHead !== state.localHead) blockers.push("TRACKING_HEAD_MISMATCH");

  if (origin) {
    try {
      const localTags = git(["show-ref", "--tags"], { allowedStatuses: [0, 1] })
        .stdout.split(/\r?\n/u)
        .filter(Boolean)
        .sort();
      const remoteTags = git(["ls-remote", "--tags", "origin"], { timeout: 45_000 })
        .stdout.split(/\r?\n/u)
        .filter((line) => line && !line.endsWith("^{}"))
        .map((line) => {
          const [sha, reference] = line.split(/\s+/u);
          return sha + " " + reference;
        })
        .sort();
      if (JSON.stringify(localTags) !== JSON.stringify(remoteTags)) blockers.push("TAG_MISMATCH");
    } catch {
      blockers.push("TAG_VERIFICATION_FAILED");
    }
  }

  return {
    status: blockers.length === 0 ? "VERIFIED" : "BLOCKED",
    nameWithOwner: github?.fullName ?? EXPECTED_GITHUB_REPOSITORY,
    visibility: github?.visibility?.toUpperCase() ?? "UNVERIFIED",
    localHead: state.localHead,
    remoteHead,
    headMatches: Boolean(remoteHead && remoteHead === state.localHead),
    originVerified: origin === EXPECTED_GITHUB_REPOSITORY,
    githubLogin: github?.login ?? null,
    branch: state.branch,
    upstream: state.upstream,
    clean: state.clean,
    blockers: [...new Set(blockers)].sort(),
  };
}

function collectWindowsRuntimeSnapshot(configuredPorts) {
  const ports = [...new Set(configuredPorts)]
    .filter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65_535)
    .sort((left, right) => left - right);
  const powershellTargets = [
    path.win32.join(repositoryRoot, "scripts", "phase134", "ensure-toolchain.ps1"),
    path.win32.join(repositoryRoot, "scripts", "verify-phase0.ps1"),
  ].map((target) => normalizeWindowsText(target).replaceAll("'", "''"));
  const powershellTargetChecks = powershellTargets
    .map(
      (target) =>
        "([string]$_.CommandLine).ToLowerInvariant().Replace('/','\\').Contains('" + target + "')",
    )
    .join(" -or ");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$self=" + String(process.pid),
    "$guardPid=$PID",
    "$names=@(" + potentialMutatingProcessNames.map((name) => "'" + name + "'").join(",") + ")",
    "$shellNames=@('powershell.exe','pwsh.exe')",
    "$ports=@(" + ports.map(String).join(",") + ")",
    "$all=Get-CimInstance -ClassName Win32_Process",
    "$selected=@($all|Where-Object {" +
      " $_.ProcessId -ne $self -and $_.ProcessId -ne $guardPid -and (" +
      " $names -contains ([string]$_.Name).ToLowerInvariant() -or (" +
      " $shellNames -contains ([string]$_.Name).ToLowerInvariant() -and" +
      " (" +
      powershellTargetChecks +
      ")" +
      " )" +
      " ) })",
    "$processes=@($selected|ForEach-Object {" +
      " $started=if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''};" +
      " @{pid=[int]$_.ProcessId;name=[string]$_.Name;executablePath=[string]$_.ExecutablePath;" +
      " commandLine=[string]$_.CommandLine;osStartedAt=$started}" +
      " })",
    "$listenerInspection='VERIFIED'",
    "try {$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|" +
      " Where-Object {$ports -contains [int]$_.LocalPort}|" +
      " ForEach-Object {@{port=[int]$_.LocalPort;pid=[int]$_.OwningProcess}}|" +
      " Sort-Object port,pid -Unique)} catch {$listeners=@();$listenerInspection='UNVERIFIED'}",
    "@{processes=$processes;listeners=$listeners;listenerInspection=$listenerInspection}|" +
      "ConvertTo-Json -Compress -Depth 5",
  ].join(";");
  const output = command("powershell", ["-NoProfile", "-Command", script], {
    errorCode: "PROCESS_STATE_UNVERIFIED",
    timeout: 45_000,
  }).stdout;
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed?.processes) || !Array.isArray(parsed?.listeners)) {
    throw new Error("PROCESS_STATE_UNVERIFIED");
  }
  return {
    processes: parsed.processes,
    listeners: parsed.listeners,
    inspection: parsed.listenerInspection === "VERIFIED" ? "VERIFIED" : "UNVERIFIED",
    warnings: parsed.listenerInspection === "VERIFIED" ? [] : ["PORT_LISTENER_STATE_UNVERIFIED"],
  };
}

async function readOwnedRuntimeMetadata(options = {}) {
  if (options.previewMetadata && options.productionMetadata) {
    return {
      previewMetadata: options.previewMetadata,
      productionMetadata: options.productionMetadata,
    };
  }
  const [{ readPreviewMetadata }, { readRuntimeMetadata }] = await Promise.all([
    import("./preview-common.mjs"),
    import("./phase134/runtime-control.mjs"),
  ]);
  return {
    previewMetadata: options.previewMetadata ?? readPreviewMetadata(),
    productionMetadata:
      options.productionMetadata ??
      readRuntimeMetadata(path.join(productRoot, "runtime", "production-process.json")),
  };
}

export async function verifyRuntimesStopped(options = {}) {
  let metadataResults;
  const metadataWarnings = [];
  try {
    metadataResults = await readOwnedRuntimeMetadata(options);
  } catch {
    metadataResults = {
      previewMetadata: { exists: true, issues: ["Preview metadata inspection failed safely."] },
      productionMetadata: {
        exists: true,
        issues: ["Production metadata inspection failed safely."],
      },
    };
    metadataWarnings.push("RUNTIME_METADATA_STATE_UNVERIFIED");
  }
  const configuredPorts = [
    ...knownBeaPorts,
    ...Object.values(metadataResults.productionMetadata?.metadata?.ports ?? {}),
  ];
  if ((options.platform ?? process.platform) !== "win32") {
    return evaluateBeaRuntimeOwnership(
      {
        ...metadataResults,
        configuredPorts,
        inspection: "NOT_WINDOWS",
        warnings: [...metadataWarnings, "WINDOWS_PROCESS_INSPECTION_NOT_AVAILABLE"],
      },
      options,
    );
  }
  try {
    const snapshot =
      options.snapshot ??
      (options.collectRuntimeSnapshot ?? collectWindowsRuntimeSnapshot)(configuredPorts);
    return evaluateBeaRuntimeOwnership(
      {
        ...snapshot,
        ...metadataResults,
        configuredPorts,
        inspection:
          metadataWarnings.length === 0 && snapshot.inspection === "VERIFIED"
            ? "VERIFIED"
            : "UNVERIFIED",
        warnings: [...metadataWarnings, ...(snapshot.warnings ?? [])],
      },
      options,
    );
  } catch {
    return evaluateBeaRuntimeOwnership(
      {
        ...metadataResults,
        configuredPorts,
        inspection: "UNVERIFIED",
        warnings: [...metadataWarnings, "PROCESS_STATE_UNVERIFIED"],
      },
      options,
    );
  }
}

function retainedRows() {
  const specs = [
    ["repository-git", path.join(repositoryRoot, ".git"), "SOURCE"],
    ["repository-node-modules", path.join(repositoryRoot, "node_modules"), "REGENERABLE"],
    ["preview-pglite", path.join(repositoryRoot, ".data", "pglite"), "PREVIEW DATA"],
    ["preview-isolated", path.join(repositoryRoot, ".data", "bea-preview"), "PREVIEW DATA"],
    [
      "final-verification-evidence",
      path.join(repositoryRoot, ".data", "final-verification"),
      "REGENERABLE",
    ],
    [
      "owner-tools-demo-state",
      path.join(repositoryRoot, ".data", "bea-owner-tools", "demo-initialized.json"),
      "PREVIEW DATA",
    ],
    ["artifact-store", path.join(repositoryRoot, ".data", "artifacts"), "UNKNOWN"],
    ["local-env", path.join(repositoryRoot, ".env.local"), "SECRET"],
    ["production-config", path.join(productRoot, "config"), "PRODUCTION DATA"],
    ["production-secrets", path.join(productRoot, "secrets"), "SECRET"],
    ["production-certificates", path.join(productRoot, "certificates"), "SECRET"],
    ["production-runtime", path.join(productRoot, "runtime"), "PRODUCTION DATA"],
    ["production-logs", path.join(productRoot, "logs"), "PRODUCTION DATA"],
    ["production-backups", path.join(productRoot, "backups"), "BACKUP"],
    [
      "active-node-toolchain",
      path.join(productRoot, "toolchain", "node-v24.19.0-win-x64"),
      "TOOLCHAIN",
    ],
    ["active-corepack", path.join(productRoot, "toolchain", "corepack-home"), "TOOLCHAIN"],
    ["shared-pnpm-store", path.join(localAppData, "pnpm", "store"), "UNKNOWN"],
    ["shared-pnpm-cache", path.join(localAppData, "pnpm-cache"), "UNKNOWN"],
    ["shared-npm-cache", path.join(localAppData, "npm-cache"), "UNKNOWN"],
    ["shared-playwright", path.join(localAppData, "ms-playwright"), "UNKNOWN"],
    ["postgresql-data", "C:\\Program Files\\PostgreSQL\\16\\data", "UNKNOWN"],
  ];
  return specs.map(([id, absolutePath, classification]) => {
    const measured = measurePathNoFollow(absolutePath);
    return {
      id,
      path: absolutePath,
      classification,
      ownership:
        id.startsWith("shared-") || id === "postgresql-data"
          ? "SHARED_OR_UNPROVEN"
          : "BEA_OR_SCOPED",
      exists: measured.exists,
      bytesBefore: measured.bytes,
      filesBefore: measured.files,
      reparsePoints: measured.reparsePoints,
      eligibility: "RETAIN",
      action: "RETAINED",
      bytesAfter: measured.bytes,
      bytesRecovered: 0,
      reasonCode: classification === "UNKNOWN" ? "UNKNOWN_NOT_DELETED" : "PRESERVED_BY_POLICY",
      errors: measured.errors,
    };
  });
}

function cleanupRows() {
  const rows = [];
  for (const policy of REPOSITORY_CLEANUP_TARGETS) {
    const absolutePath = path.resolve(repositoryRoot, policy.relativePath);
    const measured = measurePathNoFollow(absolutePath);
    let eligibility = measured.exists ? "SAFE" : "ABSENT";
    let reasonCode = "ALLOWLISTED_" + policy.classification.replaceAll(" ", "_");
    if (measured.reparsePoints > 0 || measured.errors.length > 0) {
      eligibility = "BLOCKED";
      reasonCode = "UNSAFE_TREE";
    } else if (measured.exists) {
      const ignored =
        git(["check-ignore", "-q", "--", policy.relativePath], {
          allowedStatuses: [0, 1],
        }).status === 0;
      const tracked =
        git(["ls-files", "--error-unmatch", "--", policy.relativePath], {
          allowedStatuses: [0, 1],
        }).status === 0;
      if (!ignored || tracked) {
        eligibility = "BLOCKED";
        reasonCode = "TRACKED_OR_NOT_IGNORED";
      }
    }
    rows.push({
      id: policy.id,
      path: absolutePath,
      relativePath: policy.relativePath,
      classification: policy.classification,
      ownership: "BEA_OWNED",
      exists: measured.exists,
      bytesBefore: measured.bytes,
      filesBefore: measured.files,
      reparsePoints: measured.reparsePoints,
      eligibility,
      action: !measured.exists ? "ABSENT" : eligibility === "SAFE" ? "WOULD_DELETE" : "BLOCKED",
      bytesAfter: measured.bytes,
      bytesRecovered: 0,
      reasonCode,
      errors: measured.errors,
      cleanupRoot: repositoryRoot,
    });
  }

  for (const policy of localAppDataCleanupTargets(localAppData)) {
    const measured = measurePathNoFollow(policy.absolutePath);
    let eligibility = measured.exists ? "SAFE" : "ABSENT";
    let reasonCode = "ALLOWLISTED_" + policy.classification;
    if (measured.reparsePoints > 0 || measured.errors.length > 0) {
      eligibility = "BLOCKED";
      reasonCode = "UNSAFE_TREE";
    }
    if (measured.exists && policy.emptyOnly && (measured.files > 0 || measured.directories > 1)) {
      eligibility = "RETAIN";
      reasonCode = "STAGING_NOT_EMPTY";
    }
    rows.push({
      id: policy.id,
      path: policy.absolutePath,
      relativePath: null,
      classification: policy.classification,
      ownership: "BEA_OWNED",
      exists: measured.exists,
      bytesBefore: measured.bytes,
      filesBefore: measured.files,
      reparsePoints: measured.reparsePoints,
      eligibility,
      action: !measured.exists
        ? "ABSENT"
        : eligibility === "SAFE"
          ? "WOULD_DELETE"
          : eligibility === "RETAIN"
            ? "RETAINED"
            : "BLOCKED",
      bytesAfter: measured.bytes,
      bytesRecovered: 0,
      reasonCode,
      errors: measured.errors,
      cleanupRoot: policy.root,
    });
  }
  return rows;
}

function removeNoFollow(candidate, allowedRoot, expectedIdentity = null) {
  if (!isContained(allowedRoot, candidate)) throw new Error("DELETE_TARGET_OUTSIDE_ROOT");
  ensureExistingPathHasNoReparse(candidate);
  const metadata = lstatSync(candidate);
  const identity = identityFor(metadata);
  if (metadata.isSymbolicLink()) throw new Error("REPARSE_POINT_DURING_DELETE");
  if (expectedIdentity && !identitiesMatch(identity, expectedIdentity)) {
    throw new Error("DELETE_TARGET_IDENTITY_CHANGED");
  }
  if (metadata.isDirectory()) {
    const children = readdirSync(candidate);
    assertSafePathIdentity(candidate, allowedRoot, identity);
    for (const name of children) {
      removeNoFollow(path.join(candidate, name), allowedRoot);
      assertSafePathIdentity(candidate, allowedRoot, identity);
    }
    assertSafePathIdentity(candidate, allowedRoot, identity);
    rmdirSync(candidate);
  } else {
    assertSafePathIdentity(candidate, allowedRoot, identity);
    unlinkSync(candidate);
  }
}

function createCleanupError(message, mutationStarted, quarantinePaths = []) {
  const error = new Error(message);
  error.mutationStarted = mutationStarted;
  error.quarantinePaths = quarantinePaths;
  return error;
}

function executeCleanup(entries, runId) {
  const candidates = entries.filter((entry) => entry.exists && entry.eligibility === "SAFE");
  const moves = [];
  const quarantineIdentities = new Map();
  try {
    for (const entry of candidates) {
      ensureSafeTree(entry.path, entry.cleanupRoot);
      const quarantineBase = isContained(repositoryRoot, entry.path)
        ? path.join(repositoryRoot, ".data", ".bea-cleanup-quarantine", runId)
        : path.join(entry.cleanupRoot, ".bea-cleanup-quarantine", runId);
      ensureExistingPathHasNoReparse(path.dirname(quarantineBase));
      mkdirSync(quarantineBase, { recursive: true });
      ensureSafeTree(quarantineBase, entry.cleanupRoot);
      const quarantineIdentity =
        quarantineIdentities.get(quarantineBase) ??
        captureSafePathIdentity(quarantineBase, entry.cleanupRoot);
      quarantineIdentities.set(quarantineBase, quarantineIdentity);
      const destination = path.join(quarantineBase, entry.id);
      if (existsSync(destination)) throw new Error("QUARANTINE_COLLISION");
      assertSafePathIdentity(quarantineBase, entry.cleanupRoot, quarantineIdentity);
      ensureSafeTree(entry.path, entry.cleanupRoot);
      renameSync(entry.path, destination);
      entry.action = "QUARANTINED";
      entry.quarantinePath = destination;
      const move = { entry, destination, destinationIdentity: null };
      moves.push(move);
      assertSafePathIdentity(quarantineBase, entry.cleanupRoot, quarantineIdentity);
      move.destinationIdentity = captureSafePathIdentity(destination, entry.cleanupRoot);
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const move of moves.reverse()) {
      try {
        if (existsSync(move.destination) && !existsSync(move.entry.path)) {
          if (move.destinationIdentity) {
            assertSafePathIdentity(
              move.destination,
              move.entry.cleanupRoot,
              move.destinationIdentity,
            );
          } else {
            ensureSafeTree(move.destination, move.entry.cleanupRoot);
          }
          ensureExistingPathHasNoReparse(path.dirname(move.entry.path));
          renameSync(move.destination, move.entry.path);
        }
        if (!existsSync(move.destination) && existsSync(move.entry.path)) {
          move.entry.action = "WOULD_DELETE";
          delete move.entry.quarantinePath;
        }
      } catch {
        move.entry.action = "QUARANTINED_NOT_REMOVED";
        rollbackFailures.push(move.destination);
      }
    }
    throw createCleanupError(
      rollbackFailures.length > 0
        ? "ROLLBACK_INCOMPLETE"
        : error instanceof Error
          ? error.message
          : "QUARANTINE_FAILED",
      moves.length > 0,
      rollbackFailures,
    );
  }

  const failures = [];
  for (const move of moves) {
    try {
      removeNoFollow(move.destination, move.entry.cleanupRoot, move.destinationIdentity);
      move.entry.action = "DELETED";
      move.entry.bytesAfter = 0;
      move.entry.bytesRecovered = move.entry.bytesBefore;
      delete move.entry.quarantinePath;
    } catch {
      move.entry.action = "QUARANTINED_NOT_REMOVED";
      move.entry.bytesAfter = measurePathNoFollow(move.destination).bytes;
      move.entry.bytesRecovered = 0;
      failures.push(move.destination);
    }
  }
  if (failures.length > 0) {
    throw createCleanupError("PARTIAL_DELETE", true, failures);
  }
  return { mutationStarted: moves.length > 0 };
}

export function releaseOwnedLock(lockPath, descriptor, expectedIdentity) {
  if (descriptor === undefined) return [];
  const errors = [];
  try {
    closeSync(descriptor);
  } catch {
    errors.push("LOCK_CLOSE_FAILED");
  }
  try {
    if (existsSync(lockPath)) {
      const currentIdentity = identityFor(lstatSync(lockPath));
      if (expectedIdentity && identitiesMatch(currentIdentity, expectedIdentity)) {
        unlinkSync(lockPath);
      } else {
        errors.push("LOCK_IDENTITY_CHANGED");
      }
    }
  } catch {
    errors.push("LOCK_RELEASE_FAILED");
  }
  return [...new Set(errors)];
}

function sourceIntegrity() {
  command(process.execPath, ["scripts/source-integrity.mjs"], {
    errorCode: "SOURCE_INTEGRITY_FAILED",
  });
}

export async function auditLocalStorage(mode) {
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const boundary = assertRepositoryBoundary({ cwd: process.cwd(), target: EXPECTED_REPOSITORY });
  if (normalize(boundary.target) !== normalize(EXPECTED_REPOSITORY)) {
    throw new Error("AUTHORIZED_REPOSITORY_MISMATCH");
  }
  if (normalize(process.cwd()) !== normalize(repositoryRoot)) {
    throw new Error("CALLER_REPOSITORY_MISMATCH");
  }
  if (mode === "safe") {
    if (!configuredLocalAppData || !path.isAbsolute(configuredLocalAppData)) {
      throw new Error("LOCALAPPDATA_REQUIRED_FOR_SAFE_MODE");
    }
    const pinnedNode = path.join(
      configuredLocalAppData,
      "BEA",
      "CommandCenter",
      "toolchain",
      "node-v24.19.0-win-x64",
      "node.exe",
    );
    if (process.platform !== "win32" || normalize(process.execPath) !== normalize(pinnedNode)) {
      throw new Error("PINNED_NODE_REQUIRED_FOR_SAFE_MODE");
    }
    if (process.version !== "v24.19.0") throw new Error("PINNED_NODE_VERSION_MISMATCH");
    ensureExistingPathHasNoReparse(repositoryRoot);
    ensureExistingPathHasNoReparse(path.join(configuredLocalAppData, "BEA", "CommandCenter"));
  }

  const repository = repositoryState();
  const remote = verifyPrivateRemote();
  const runtime = await verifyRuntimesStopped();
  const entries = cleanupRows();
  const retained = retainedRows();
  const attributableRoots = [
    { id: "repository", path: repositoryRoot, measurement: measurePathNoFollow(repositoryRoot) },
    { id: "product-root", path: productRoot, measurement: measurePathNoFollow(productRoot) },
  ];

  const guards = [
    { id: "repository-boundary", status: "PASS", code: "BEA_REPOSITORY_BOUNDARY_OK" },
    {
      id: "private-remote",
      status: remote.status === "VERIFIED" ? "PASS" : "BLOCKED",
      code: remote.status,
    },
    {
      id: "runtime-stopped",
      status: runtime.stopped ? "PASS" : "BLOCKED",
      code: runtime.stopped ? "RUNTIMES_STOPPED" : runtime.blockers.join(","),
    },
    {
      id: "safe-targets",
      status: entries.some((entry) => entry.eligibility === "BLOCKED") ? "BLOCKED" : "PASS",
      code: entries.some((entry) => entry.eligibility === "BLOCKED")
        ? "UNSAFE_TARGET"
        : "ALLOWLIST_VALID",
    },
  ];

  let status = "DRY_RUN_COMPLETE";
  let exitCode = 0;
  let cleanupError = null;
  if (mode === "safe") {
    if (
      remote.status !== "VERIFIED" ||
      !runtime.stopped ||
      entries.some((entry) => entry.eligibility === "BLOCKED")
    ) {
      status = "BLOCKED";
      exitCode = 4;
      for (const entry of entries) {
        if (entry.action === "WOULD_DELETE") entry.action = "BLOCKED";
      }
    } else {
      const lockPath = path.join(repositoryRoot, ".data", ".bea-cleanup.lock");
      mkdirSync(path.dirname(lockPath), { recursive: true });
      let lock;
      let lockIdentity;
      let toolchainOperationLock;
      let toolchainOperationLockIdentity;
      let mutationStarted = false;
      try {
        ensureExistingPathHasNoReparse(path.dirname(lockPath));
        lock = openSync(lockPath, "wx");
        lockIdentity = fstatSync(lock);
        ensureExistingPathHasNoReparse(path.dirname(toolchainOperationLockPath));
        toolchainOperationLock = openSync(toolchainOperationLockPath, "wx");
        toolchainOperationLockIdentity = fstatSync(toolchainOperationLock);
        sourceIntegrity();
        const repeatedRemote = verifyPrivateRemote();
        const repeatedRuntime = await verifyRuntimesStopped();
        if (repeatedRemote.status !== "VERIFIED" || !repeatedRuntime.stopped) {
          throw new Error("CLEANUP_GUARD_CHANGED");
        }
        const cleanup = executeCleanup(entries, runId);
        mutationStarted = cleanup.mutationStarted;
        sourceIntegrity();
        if (!repositoryState().clean) throw new Error("GIT_STATE_CHANGED");
        for (const entry of entries.filter((candidate) => candidate.eligibility === "SAFE")) {
          const after = measurePathNoFollow(entry.path);
          entry.bytesAfter = after.bytes;
          entry.bytesRecovered = Math.max(0, entry.bytesBefore - after.bytes);
          if (after.exists) {
            entry.action = "RECREATED_AFTER_CLEANUP";
            throw createCleanupError("TARGET_RECREATED_AFTER_CLEANUP", true);
          }
        }
        status = "SAFE_CLEANUP_COMPLETE";
      } catch (error) {
        mutationStarted = mutationStarted || error?.mutationStarted === true;
        cleanupError = error instanceof Error ? error.message : "SAFE_CLEANUP_FAILED";
        status = mutationStarted ? "PARTIAL_FAILURE" : "BLOCKED";
        exitCode = mutationStarted ? 6 : 3;
      } finally {
        const toolchainLockErrors = releaseOwnedLock(
          toolchainOperationLockPath,
          toolchainOperationLock,
          toolchainOperationLockIdentity,
        );
        const lockErrors = releaseOwnedLock(lockPath, lock, lockIdentity);
        if (toolchainLockErrors.length > 0 || lockErrors.length > 0) {
          cleanupError = [cleanupError, ...toolchainLockErrors, ...lockErrors]
            .filter(Boolean)
            .join(",");
          status = mutationStarted ? "PARTIAL_FAILURE" : "BLOCKED";
          exitCode = mutationStarted ? 6 : 3;
        }
      }
    }
  }

  const safeCandidateBytes = entries
    .filter((entry) => entry.eligibility === "SAFE")
    .reduce((sum, entry) => sum + entry.bytesBefore, 0);
  const bytesRecovered = entries.reduce((sum, entry) => sum + entry.bytesRecovered, 0);
  const beaAttributableBytes = attributableRoots.reduce(
    (sum, item) => sum + item.measurement.bytes,
    0,
  );
  const unknownBytes = retained
    .filter((entry) => entry.classification === "UNKNOWN")
    .reduce((sum, entry) => sum + entry.bytesBefore, 0);

  return {
    exitCode,
    output: {
      schemaVersion: 1,
      mode,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      repository: {
        root: repositoryRoot,
        branch: repository.branch,
        localHead: repository.localHead,
        clean: repository.clean,
        upstream: repository.upstream,
      },
      remote,
      runtime,
      guards,
      entries: [...entries, ...retained].map((entry) => {
        const outputEntry = { ...entry };
        delete outputEntry.cleanupRoot;
        delete outputEntry.relativePath;
        return outputEntry;
      }),
      attributableRoots: attributableRoots.map((item) => ({
        id: item.id,
        path: item.path,
        bytes: item.measurement.bytes,
        errors: item.measurement.errors,
      })),
      optionalCleanup: OPTIONAL_CLEANUP_APPROVALS,
      totals: {
        beaAttributableBytes,
        safeCandidateBytes,
        unknownBytes,
        bytesRecovered,
      },
      status,
      errors: cleanupError ? [cleanupError] : [],
      protectedRepositoryEntered: false,
    },
  };
}

async function main() {
  try {
    const mode = parseMode(process.argv.slice(2));
    const result = await auditLocalStorage(mode);
    process.stdout.write("BEA_LOCAL_STORAGE_AUDIT=" + JSON.stringify(result.output) + "\n");
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(
      "BEA_LOCAL_STORAGE_AUDIT=" +
        JSON.stringify({
          schemaVersion: 1,
          status: "BLOCKED",
          errors: [error instanceof Error ? error.message : "AUDIT_FAILED"],
          protectedRepositoryEntered: false,
        }) +
        "\n",
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
