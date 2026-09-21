import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const verifierScriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(verifierScriptPath), "..");
const normalizedRoot = repositoryRoot.replaceAll("\\", "/");
const webRoutesManifestPath = path.join(
  repositoryRoot,
  "apps",
  "web",
  ".next",
  "routes-manifest.json",
);
export const PHASE1_2_STARTING_COMMIT = "4b6a9cb884f7eb32c82b231d46a3a550f87cc83a";
const isWindows = process.platform === "win32";
const pnpm = isWindows ? "pnpm.cmd" : "pnpm";
const require = createRequire(import.meta.url);
const playwrightCliPath = require.resolve("@playwright/test/cli");
const forbiddenWarningOutput = ["MaxListenersExceededWarning"];
const ansiEscapePattern = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "gu");

export const EXPECTED_PHASE1_2_PLAYWRIGHT_TEST_COUNT = 32;
export const EXPECTED_PHASE1_2_WEBRTC_TEST_COUNT = 1;
export const PHASE1_2_VERIFIED_NODE_VERSION = "24.19.0";
export const PHASE1_2_VERIFIED_PNPM_VERSION = "11.19.0";
export const PHASE1_2_WEBRTC_EVIDENCE_TITLE =
  "@webrtc executes deterministic browser microphone and WebRTC lifecycle with complete cleanup";
export const PHASE1_2_NORMAL_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()";
export const PHASE1_2_WEBRTC_PERMISSIONS_POLICY = "camera=(), microphone=(self), geolocation=()";

export const PHASE1_2_EVIDENCE_BINDINGS = Object.freeze({
  "publishes the matched-height panel contract": {
    file: "tests/component/ai-command-workspace.test.tsx",
    suiteGate: 10,
  },
  "publishes the bottom-aligned panel region contract": {
    file: "tests/component/ai-command-workspace.test.tsx",
    suiteGate: 10,
  },
  "publishes the intentional two-scroller architecture": {
    file: "tests/component/ai-command-workspace.test.tsx",
    suiteGate: 10,
  },
  "publishes the compact consistent suggestion-pill contract": {
    file: "tests/component/ai-command-workspace.test.tsx",
    suiteGate: 10,
  },
  "publishes the composer anchoring contract": {
    file: "tests/component/ai-command-workspace.test.tsx",
    suiteGate: 10,
  },
  "defines the resizable desktop split and compact single-panel breakpoint": {
    file: "tests/component/ai-command-workspace.test.tsx",
    suiteGate: 10,
  },
  "keeps the current workspace visible until the staged replacement is ready": {
    file: "tests/component/phase11-motion.test.tsx",
    suiteGate: 10,
  },
  "BEA_DISABLE_ENV_FILE bypasses every env-file exists/read operation": {
    file: "tests/unit/environment.test.ts",
    suiteGate: 9,
  },
  "ambient BEA_DISABLE_ENV_FILE overrides a narrowed child environment and loadEnvFile true": {
    file: "tests/unit/environment.test.ts",
    suiteGate: 9,
  },
  "normalizes timeout cancel auth quota rate network and unavailable without raw causes": {
    file: "packages/ai/src/openai/phase1-2-openai.test.ts",
    suiteGate: 9,
  },
  "bounds pagination, rejects malformed metadata, deduplicates IDs, and guards dates": {
    file: "packages/ai/src/openai/phase1-2-openai.test.ts",
    suiteGate: 9,
  },
  "blocks activation when required model capabilities remain unknown": {
    file: "tests/unit/openai-administration-backend.test.ts",
    suiteGate: 9,
  },
  "allows only an explicitly administrator-verified compatible cached model": {
    file: "tests/unit/openai-administration-backend.test.ts",
    suiteGate: 9,
  },
  "streams deltas usage and completion and maps abort timeout safely": {
    file: "packages/ai/src/openai/phase1-2-openai.test.ts",
    suiteGate: 9,
  },
  "bounds adversarial provider collections text and token usage metadata": {
    file: "packages/ai/src/openai/phase1-2-openai.test.ts",
    suiteGate: 9,
  },
  "constructs current Responses tools and sanitizes sources citations files usage and provider fields":
    {
      file: "packages/ai/src/openai/phase1-2-openai.test.ts",
      suiteGate: 9,
    },
  "streams simulated web citations and schema-valid artifact proposals without a key": {
    file: "packages/ai/src/openai/phase1-2-openai.test.ts",
    suiteGate: 9,
  },
  "preserves application artifacts, citations, and downloads when reopened": {
    file: "tests/component/workspace-renderer.test.tsx",
    suiteGate: 10,
  },
  "mints current short-lived Realtime config with allowlisted tools and no standard key DTO": {
    file: "packages/ai/src/openai/phase1-2-openai.test.ts",
    suiteGate: 9,
  },
  [PHASE1_2_WEBRTC_EVIDENCE_TITLE]: {
    file: "tests/e2e/command-center.spec.ts",
    suiteGate: 30,
  },
  "publishes every required BEA orb state and integrated simulated voice flow": {
    file: "tests/component/phase11-motion.test.tsx",
    suiteGate: 10,
  },
  "caps the legacy in-memory usage ledger to the newest 500 records": {
    file: "packages/ai/src/openai/phase1-2-openai.test.ts",
    suiteGate: 9,
  },
  "uses one registered tool for text and simulated voice to create a research source board, cited chart, table, AI-labeled image, branded PDF, and simulated usage":
    {
      file: "tests/integration/artifact-demo-runner.test.ts",
      suiteGate: 11,
    },
  "gates the administration panel on both management permissions in the server page": {
    file: "tests/component/openai-administration.test.tsx",
    suiteGate: 10,
  },
  "blocks direct live Realtime file code and image work without durable owner authorization": {
    file: "tests/unit/openai-administration-backend.test.ts",
    suiteGate: 9,
  },
  "requires a validated upload at the web seam and returns safe preview, download, and refresh responses":
    {
      file: "tests/integration/artifact-file-store.test.ts",
      suiteGate: 11,
    },
  "attributes restricted owner uploads to the application instead of a provider": {
    file: "tests/component/artifact-upload-contract.test.ts",
    suiteGate: 10,
  },
  "renders only allowlisted application renderers with safe markup": {
    file: "tests/component/workspace-renderer.test.tsx",
    suiteGate: 10,
  },
  "accepts only the normalized pdf renderer shape": {
    file: "packages/artifacts/src/manifest.test.ts",
    suiteGate: 9,
  },
  "rejects arbitrary renderers and unsafe extra renderer fields": {
    file: "packages/artifacts/src/manifest.test.ts",
    suiteGate: 9,
  },
  "rejects unknown or unsafe application renderer payloads": {
    file: "tests/component/workspace-renderer.test.tsx",
    suiteGate: 10,
  },
  "fails closed for simulated, infected, unavailable, and failed malware scans": {
    file: "packages/artifacts/src/uploads.test.ts",
    suiteGate: 9,
  },
  "stores stable IDs and hashes without exposing raw paths": {
    file: "tests/integration/artifact-file-store.test.ts",
    suiteGate: 11,
  },
  "rechecks every persisted artifact permission and hides same-owner access after role revocation":
    {
      file: "tests/integration/artifact-route-audit.test.ts",
      suiteGate: 11,
    },
  "accepts allowlisted line charts with explicit provenance": {
    file: "packages/artifacts/src/manifest.test.ts",
    suiteGate: 9,
  },
  "rejects chart provenance or data defects": {
    file: "packages/artifacts/src/manifest.test.ts",
    suiteGate: 9,
  },
  "creates byte-identical PDFs with branding, findings, citations, disclosure, dates, and page numbers":
    {
      file: "packages/artifacts/src/pdf.test.ts",
      suiteGate: 9,
    },
  "keeps browser uploads at 12 MiB while trusted generated files use their separate ceiling": {
    file: "packages/artifacts/src/uploads.test.ts",
    suiteGate: 9,
  },
  "uses the strictest bounded upload and generated-file limits": {
    file: "tests/component/artifact-settings.test.ts",
    suiteGate: 10,
  },
  "adapts normalized artifact manifests and provides controlled PDF navigation": {
    file: "tests/component/workspace-renderer.test.tsx",
    suiteGate: 10,
  },
  "0004 persists every generated-artifact kind, application-owned upload attribution, and owner-scoped reopen":
    {
      file: "tests/integration/database-pglite.test.ts",
      suiteGate: 11,
    },
  "returns the same non-enumerating 404 for cross-owner preview, download, and refresh": {
    file: "tests/integration/artifact-file-store.test.ts",
    suiteGate: 11,
  },
  "stores safe artifact-file linkage without writing a non-UUID file ID into resource_id": {
    file: "tests/integration/artifact-route-audit.test.ts",
    suiteGate: 11,
  },
  "removes generated files when authoritative persistence fails": {
    file: "tests/integration/artifact-demo-runner.test.ts",
    suiteGate: 11,
  },
  "reports failed retention cleanup without exposing a path and succeeds on retry": {
    file: "tests/integration/artifact-file-store.test.ts",
    suiteGate: 11,
  },
  "sweeps expired files and crash orphans while preserving fresh and paired data": {
    file: "tests/integration/artifact-file-store.test.ts",
    suiteGate: 11,
  },
  "automatically runs retention and orphan reconciliation on the inline schedule": {
    file: "tests/integration/worker-runtime.test.ts",
    suiteGate: 11,
  },
  "queues a singleton retention sweep for pg-boss and executes its registered handler": {
    file: "tests/integration/worker-runtime.test.ts",
    suiteGate: 11,
  },
  "runs and reopens the Demo research source-board chart and PDF artifact chain": {
    file: "tests/e2e/command-center.spec.ts",
    suiteGate: 41,
  },
  "keeps optional live provider validation separately acknowledged and non-authoritative": {
    file: "tests/unit/phase12-verifier-environment.test.mjs",
    suiteGate: 9,
  },
});

export function assertPhase1_2StartingState(headCommit, branchName) {
  if (headCommit.trim() !== PHASE1_2_STARTING_COMMIT) {
    throw new Error(
      `Phase 1.2 precommit verification requires HEAD ${PHASE1_2_STARTING_COMMIT}; received ${headCommit.trim() || "unknown"}.`,
    );
  }
  if (branchName.trim() !== "main") {
    throw new Error(
      `Phase 1.2 precommit verification requires branch main; received ${branchName.trim() || "detached"}.`,
    );
  }
}

const forbiddenStagedDirectories = new Set([
  ".data",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "reports",
  "test-results",
]);
const forbiddenStagedExtensions = new Set([
  ".aac",
  ".db",
  ".flac",
  ".log",
  ".m4a",
  ".mp3",
  ".ogg",
  ".opus",
  ".pid",
  ".sqlite",
  ".sqlite3",
  ".wav",
  ".wma",
]);

export function findForbiddenPhase1_2StagedPaths(pathnames) {
  return pathnames.filter((pathname) => {
    const normalized = pathname.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
    const segments = normalized.split("/").filter(Boolean);
    if (segments.some((segment) => forbiddenStagedDirectories.has(segment))) return true;
    const leaf = segments.at(-1) ?? "";
    if (leaf === ".env" || (leaf.startsWith(".env.") && leaf !== ".env.example")) return true;
    return [...forbiddenStagedExtensions].some((extension) => leaf.endsWith(extension));
  });
}

export function assertPhase1_2ToolchainVersions(nodeVersion, pnpmVersion) {
  if (nodeVersion !== PHASE1_2_VERIFIED_NODE_VERSION) {
    throw new Error(
      `Phase 1.2 authoritative verification requires exact Node ${PHASE1_2_VERIFIED_NODE_VERSION}; received ${nodeVersion || "unknown"}.`,
    );
  }
  if (pnpmVersion !== PHASE1_2_VERIFIED_PNPM_VERSION) {
    throw new Error(
      `Phase 1.2 authoritative verification requires exact pnpm ${PHASE1_2_VERIFIED_PNPM_VERSION}; received ${pnpmVersion || "unknown"}.`,
    );
  }
}

export const PHASE1_2_GATE_DEFINITIONS = Object.freeze([
  [1, "Repository boundary"],
  [2, "Starting commit"],
  [3, "Source integrity"],
  [4, "Frozen dependency installation"],
  [5, "Format"],
  [6, "Format check"],
  [7, "Lint"],
  [8, "Typecheck"],
  [9, "Unit tests"],
  [10, "Component tests"],
  [11, "Integration tests"],
  [12, "Database migrations"],
  [13, "Repeatable seed"],
  [14, "Demo reset safety"],
  [15, "AI panel-height tests"],
  [16, "AI bottom-alignment tests"],
  [17, "AI scroll-architecture tests"],
  [18, "Suggestion-pill consistency tests"],
  [19, "Composer anchoring tests"],
  [20, "Divider regression tests"],
  [21, "Workspace transition tests"],
  [22, "OpenAI secret-handling tests"],
  [23, "OpenAI provider tests"],
  [24, "Model-discovery tests"],
  [25, "Capability-selection tests"],
  [26, "Responses streaming tests"],
  [27, "Web-search tests"],
  [28, "Citation tests"],
  [29, "Realtime client-secret tests"],
  [30, "WebRTC lifecycle tests"],
  [31, "Voice/orb synchronization tests"],
  [32, "Usage logging tests"],
  [33, "Provider RBAC tests"],
  [34, "Existing Phase 0/1/1.1 regressions"],
  [35, "Web build"],
  [36, "Worker build"],
  [37, "Full monorepo build"],
  [38, "Built web startup"],
  [39, "Worker startup"],
  [40, "Health checks"],
  [41, "Full production Chromium suite"],
  [42, "Windows Doctor regression"],
  [43, "Windows Start regression"],
  [44, "Windows Stop regression"],
  [45, "Dependency audit"],
  [46, "Secret scan"],
  [47, "Inventory reconciliation"],
  [48, "Staged-diff check"],
  [49, "Git status"],
  [50, "Artifact manifest and schema validation"],
  [51, "Arbitrary renderer rejection"],
  [52, "Restricted upload and malware-scan seam"],
  [53, "Artifact file ownership and authorization"],
  [54, "Private preview, download, and refresh responses"],
  [55, "Chart registry and provenance validation"],
  [56, "Deterministic CI artifact fixtures"],
  [57, "Generated-file size and retention controls"],
  [58, "Research source-board generation"],
  [59, "BEA PDF branding and citation evidence"],
  [60, "Controlled PDF preview and download UI"],
  [61, "Simulated AI-generated image labeling"],
  [62, "Simulated-voice chart and PDF flow"],
  [63, "Shared registered artifact tool"],
  [64, "Generated-artifact persistence and reopen"],
  [65, "Cross-user artifact non-enumeration"],
  [66, "Artifact usage and audit evidence"],
  [67, "Failed generation and retention cleanup"],
  [68, "Demo application-artifact parity"],
  [69, "Optional live profile readiness (execution deferred)"],
]);

const authoritativeEnvironmentValues = Object.freeze({
  APP_MODE: "demo",
  BEA_BROWSER_MEDIA_TEST_AUTHORITY: "",
  BEA_BROWSER_MEDIA_TEST_MODE: "false",
  BEA_BROWSER_MEDIA_TEST_WAV_SHA256: "",
  BEA_BROWSER_MEDIA_TEST_WAV_PATH: "",
  BEA_DISABLE_ENV_FILE: "true",
  OPENAI_API_KEY: "",
});

export function createAuthoritativeEnvironment(baseEnvironment, overrides = {}) {
  const environment = { ...baseEnvironment, ...overrides };
  const protectedKeys = new Set(Object.keys(authoritativeEnvironmentValues));
  for (const key of Object.keys(environment)) {
    if (protectedKeys.has(key.toUpperCase())) delete environment[key];
  }
  Object.assign(environment, authoritativeEnvironmentValues);

  for (const key of Object.keys(environment)) {
    if (
      ["NODE_NO_WARNINGS", "NODE_OPTIONS", "NODE_REDIRECT_WARNINGS", "NO_COLOR"].includes(
        key.toUpperCase(),
      )
    ) {
      delete environment[key];
    }
  }
  environment.FORCE_COLOR = "0";
  environment.NODE_OPTIONS = "--trace-warnings";
  return environment;
}

export function createBrowserMediaTestEnvironment(baseEnvironment, fixturePath, fixtureSha256) {
  if (!path.isAbsolute(fixturePath) || path.extname(fixturePath).toLowerCase() !== ".wav") {
    throw new Error("Gate 30 requires an absolute generated WAV fixture path.");
  }
  if (!/^[a-f0-9]{64}$/u.test(fixtureSha256)) {
    throw new Error("Gate 30 requires the generated WAV fixture SHA-256.");
  }
  const environment = createAuthoritativeEnvironment(baseEnvironment);
  environment.BEA_BROWSER_MEDIA_TEST_AUTHORITY = "phase1-2-gate30";
  environment.BEA_BROWSER_MEDIA_TEST_MODE = "true";
  environment.BEA_BROWSER_MEDIA_TEST_WAV_PATH = fixturePath;
  environment.BEA_BROWSER_MEDIA_TEST_WAV_SHA256 = fixtureSha256;
  return environment;
}

export function readBuiltPermissionsPolicy(routesManifestPath = webRoutesManifestPath) {
  const manifest = JSON.parse(readFileSync(routesManifestPath, "utf8"));
  const rules = Array.isArray(manifest?.headers) ? manifest.headers : [];
  const policies = rules
    .flatMap((rule) => (Array.isArray(rule?.headers) ? rule.headers : []))
    .filter(
      (header) =>
        typeof header?.key === "string" &&
        header.key.toLowerCase() === "permissions-policy" &&
        typeof header.value === "string",
    )
    .map((header) => header.value);
  if (policies.length !== 1) {
    throw new Error("Gate 30 requires exactly one built Permissions-Policy header.");
  }
  return policies[0];
}

export function assertBuiltPermissionsPolicy(
  expectedPolicy,
  routesManifestPath = webRoutesManifestPath,
) {
  const observedPolicy = readBuiltPermissionsPolicy(routesManifestPath);
  if (observedPolicy !== expectedPolicy) {
    throw new Error(
      `Gate 30 built Permissions-Policy mismatch: expected ${expectedPolicy}; received ${observedPolicy}.`,
    );
  }
  return observedPolicy;
}

export function outputHasExactTestTitle(output, title) {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const exactTitlePattern = new RegExp(
    String.raw`(?:^|\s(?:>|›)\s)${escapedTitle}(?:\s+\(?\d+(?:\.\d+)?(?:ms|s|m)\)?)?$`,
    "u",
  );
  return output
    .replace(ansiEscapePattern, "")
    .split(/\r?\n/u)
    .some((line) => {
      const passedLine = line.trim();
      if (!/^(?:(?:✓|√)\s+|ok\s+\d+\s+)/u.test(passedLine)) return false;
      const testLine = passedLine.replace(/^(?:✓|√)\s+/u, "").replace(/^ok\s+(?=\d+\s+)/u, "");
      return exactTitlePattern.test(testLine);
    });
}

function reporterTestFile(passingLine) {
  const normalizedLine = passingLine.replaceAll("\\", "/");
  const playwrightMatch = /^\d+\s+\[[^\]\r\n]+\]\s+›\s+(.+?)(?::\d+:\d+)?\s+›\s/u.exec(
    normalizedLine,
  );
  if (playwrightMatch) return playwrightMatch[1];
  return /^(.+?\.(?:test|spec)\.[cm]?[jt]sx?)\s+>\s/u.exec(normalizedLine)?.[1] ?? null;
}

export function outputHasExactTestEvidence(output, title, expectedTestFile) {
  const normalizedExpectedFile = expectedTestFile.replaceAll("\\", "/");
  return output
    .replace(ansiEscapePattern, "")
    .split(/\r?\n/u)
    .some((line) => {
      const passedLine = line.trim();
      if (!/^(?:(?:✓|√)\s+|ok\s+\d+\s+)/u.test(passedLine)) return false;
      const testLine = passedLine.replace(/^(?:✓|√)\s+/u, "").replace(/^ok\s+(?=\d+\s+)/u, "");
      return (
        reporterTestFile(testLine) === normalizedExpectedFile &&
        outputHasExactTestTitle(passedLine, title)
      );
    });
}

const focusedArgumentNames = new Set([
  "-g",
  "-t",
  "--grep",
  "--grep-invert",
  "--test-name-pattern",
  "--testNamePattern",
]);

export function assertNoFocusedTestArguments(args) {
  const runnerInvocation = args.some(
    (argument) =>
      argument === "vitest" ||
      argument === playwrightCliPath ||
      argument.endsWith("verify-phase1-2.mjs"),
  );
  if (!runnerInvocation) return;
  const focusedArgument = args.find(
    (argument) =>
      focusedArgumentNames.has(argument) ||
      [...focusedArgumentNames].some((name) => argument.startsWith(`${name}=`)) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(argument),
  );
  if (focusedArgument) {
    throw new Error(`Focused authoritative tests are forbidden: ${focusedArgument}`);
  }
}

function writeCapturedOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function inspectedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(ansiEscapePattern, "");
}

function spawnAuthoritative(command, args, options = {}) {
  assertNoFocusedTestArguments(args);
  const commandScript = isWindows && command.toLowerCase().endsWith(".cmd");
  const executable = commandScript ? process.env.ComSpec || "cmd.exe" : command;
  const executableArguments = commandScript ? ["/d", "/s", "/c", command, ...args] : args;
  const baseEnvironment = { ...process.env, ...options.environment };
  const environment = options.browserMediaFixturePath
    ? createBrowserMediaTestEnvironment(
        baseEnvironment,
        options.browserMediaFixturePath,
        options.browserMediaFixtureSha256,
      )
    : createAuthoritativeEnvironment(baseEnvironment);
  const result = spawnSync(executable, executableArguments, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    shell: false,
    stdio: options.stdio ?? "pipe",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (options.stdio !== "ignore") writeCapturedOutput(result);
  const output = inspectedOutput(result);
  const forbiddenMatch = [
    ...new Set([...forbiddenWarningOutput, ...(options.forbiddenOutput ?? [])]),
  ].find((value) => output.includes(value));
  if (forbiddenMatch) {
    console.error(`Forbidden verifier output detected: ${forbiddenMatch}`);
    return { exitCode: 1, output };
  }
  return { exitCode: result.status ?? 1, output };
}

function assertPinnedPhase1_2Toolchain() {
  const probe = spawnAuthoritative(pnpm, ["--version"]);
  if (probe.exitCode !== 0) {
    throw new Error(`Unable to verify pinned pnpm ${PHASE1_2_VERIFIED_PNPM_VERSION}.`);
  }
  const pnpmVersion = probe.output.match(/^\s*(\d+\.\d+\.\d+)\s*$/mu)?.[1] ?? "";
  assertPhase1_2ToolchainVersions(process.versions.node, pnpmVersion);
}

function parseDiscoveredTestCount(output) {
  const match = output.match(/Total:\s+(\d+)\s+tests?\s+in\b/u);
  return match ? Number(match[1]) : null;
}

function parsePassedTestCount(output) {
  const matches = [...output.matchAll(/^\s*(\d+)\s+passed\b/gmu)];
  return matches.length > 0 ? Number(matches.at(-1)[1]) : null;
}

export function createDeterministicWebRtcWaveFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "bea-phase1-2-gate30-"));
  try {
    const fixturePath = path.join(directory, "deterministic-fake-microphone.wav");
    const sampleRate = 48_000;
    const durationSeconds = 12;
    const channelCount = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const sampleCount = sampleRate * durationSeconds;
    const dataBytes = sampleCount * channelCount * bytesPerSample;
    const wave = Buffer.alloc(44 + dataBytes);
    wave.write("RIFF", 0, "ascii");
    wave.writeUInt32LE(36 + dataBytes, 4);
    wave.write("WAVE", 8, "ascii");
    wave.write("fmt ", 12, "ascii");
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20);
    wave.writeUInt16LE(channelCount, 22);
    wave.writeUInt32LE(sampleRate, 24);
    wave.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
    wave.writeUInt16LE(channelCount * bytesPerSample, 32);
    wave.writeUInt16LE(bitsPerSample, 34);
    wave.write("data", 36, "ascii");
    wave.writeUInt32LE(dataBytes, 40);
    for (let index = 0; index < sampleCount; index += 1) {
      const halfSecond = Math.floor(index / (sampleRate / 2));
      const tone = halfSecond % 2 === 0;
      const sample = tone
        ? Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.22 * 32_767)
        : 0;
      wave.writeInt16LE(sample, 44 + index * bytesPerSample);
    }
    writeFileSync(fixturePath, wave, { flag: "wx" });
    return {
      bitsPerSample,
      channelCount,
      directory,
      durationSeconds,
      fixturePath,
      sampleRate,
      sha256: createHash("sha256").update(wave).digest("hex"),
    };
  } catch (error) {
    removeDeterministicWebRtcWaveFixture({ directory });
    throw error;
  }
}

export function removeDeterministicWebRtcWaveFixture(fixture) {
  const temporaryRoot = path.resolve(tmpdir());
  const resolvedDirectory = path.resolve(fixture.directory);
  const expectedPrefix = `${temporaryRoot}${path.sep}`.toLowerCase();
  if (
    !resolvedDirectory.toLowerCase().startsWith(expectedPrefix) ||
    !path.basename(resolvedDirectory).startsWith("bea-phase1-2-gate30-")
  ) {
    throw new Error("Refusing to remove a Gate 30 fixture outside its controlled temp directory.");
  }
  rmSync(resolvedDirectory, { force: true, recursive: true });
}

export function finalizeBrowserMediaTestEnvironment(cleanup, restore) {
  let cleanupError;
  let restoreError;
  let restoreExitCode = 1;
  try {
    cleanup();
  } catch (error) {
    cleanupError = error;
  }
  try {
    restoreExitCode = restore();
  } catch (error) {
    restoreError = error;
  }
  return { cleanupError, restoreError, restoreExitCode };
}

function runWebRtcBrowserVerification(captureOutput = () => {}) {
  console.log("\n==> Gate 30 repository boundary");
  const boundary = spawnAuthoritative(process.execPath, ["scripts/repository-boundary.mjs"]);
  if (boundary.exitCode !== 0) return boundary.exitCode;
  const fixture = createDeterministicWebRtcWaveFixture();
  let exitCode = 1;
  console.log(
    `GATE30_FIXTURE=generated-wav;sample_rate=${fixture.sampleRate};bits=${fixture.bitsPerSample};channels=${fixture.channelCount};duration_seconds=${fixture.durationSeconds};sha256=${fixture.sha256}`,
  );
  try {
    console.log("\n==> Gate 30 production media-test build");
    const build = spawnAuthoritative(pnpm, ["--filter", "@bea/web", "build"], {
      browserMediaFixturePath: fixture.fixturePath,
      browserMediaFixtureSha256: fixture.sha256,
    });
    if (build.exitCode !== 0) {
      exitCode = build.exitCode;
    } else {
      try {
        assertBuiltPermissionsPolicy(PHASE1_2_WEBRTC_PERMISSIONS_POLICY);
        console.log(
          "GATE30_MEDIA_BUILD_POLICY=PASS camera=denied;microphone=self;geolocation=denied",
        );
      } catch (error) {
        console.error(
          error instanceof Error ? error.message : "Gate 30 media build policy failed.",
        );
        return 1;
      }
      const mediaOptions = {
        browserMediaFixturePath: fixture.fixturePath,
        browserMediaFixtureSha256: fixture.sha256,
      };
      const discovery = spawnAuthoritative(
        process.execPath,
        [
          playwrightCliPath,
          "test",
          "--config=playwright.webrtc.config.ts",
          "--reporter=line",
          "--workers=1",
          "--list",
        ],
        mediaOptions,
      );
      captureOutput(discovery.output);
      const discoveredTestCount = parseDiscoveredTestCount(discovery.output);
      if (discovery.exitCode !== 0) {
        exitCode = discovery.exitCode;
      } else if (discoveredTestCount !== EXPECTED_PHASE1_2_WEBRTC_TEST_COUNT) {
        console.error(
          `Gate 30 Playwright discovery mismatch: expected ${EXPECTED_PHASE1_2_WEBRTC_TEST_COUNT}, discovered ${discoveredTestCount ?? 0}.`,
        );
      } else {
        const execution = spawnAuthoritative(
          process.execPath,
          [
            playwrightCliPath,
            "test",
            "--config=playwright.webrtc.config.ts",
            "--reporter=list",
            "--trace=off",
            "--workers=1",
          ],
          mediaOptions,
        );
        captureOutput(execution.output);
        const passedTestCount = parsePassedTestCount(execution.output);
        const exactEvidence = outputHasExactTestEvidence(
          execution.output,
          PHASE1_2_WEBRTC_EVIDENCE_TITLE,
          PHASE1_2_EVIDENCE_BINDINGS[PHASE1_2_WEBRTC_EVIDENCE_TITLE].file,
        );
        const evidenceMarker = execution.output.includes("GATE30_BROWSER_EVIDENCE=PASS");
        if (execution.exitCode !== 0) {
          exitCode = execution.exitCode;
        } else if (passedTestCount !== discoveredTestCount) {
          console.error(
            `Gate 30 Playwright execution mismatch: discovered ${discoveredTestCount}, passed ${passedTestCount ?? 0}.`,
          );
        } else if (!exactEvidence || !evidenceMarker) {
          console.error("Gate 30 exact browser lifecycle evidence is missing.");
        } else {
          console.log(`evidence: ${PHASE1_2_WEBRTC_EVIDENCE_TITLE}`);
          exitCode = 0;
        }
      }
    }
  } finally {
    const finalization = finalizeBrowserMediaTestEnvironment(
      () => removeDeterministicWebRtcWaveFixture(fixture),
      () => {
        console.log("\n==> Restore normal fail-closed production build");
        const restore = spawnAuthoritative(pnpm, ["build"]);
        if (restore.exitCode !== 0) return restore.exitCode;
        try {
          assertBuiltPermissionsPolicy(PHASE1_2_NORMAL_PERMISSIONS_POLICY);
          console.log(
            "GATE30_NORMAL_BUILD_POLICY=PASS camera=denied;microphone=denied;geolocation=denied",
          );
          return 0;
        } catch (error) {
          console.error(
            error instanceof Error ? error.message : "Gate 30 normal build policy failed.",
          );
          return 1;
        }
      },
    );
    if (finalization.cleanupError) {
      console.error("Gate 30 generated WAV fixture cleanup failed.");
      exitCode = 1;
    } else {
      console.log("GATE30_FIXTURE_CLEANUP=PASS");
    }
    if (finalization.restoreError || finalization.restoreExitCode !== 0) {
      console.error("Gate 30 normal fail-closed production build restoration failed.");
      exitCode = finalization.restoreExitCode || 1;
    } else {
      console.log("GATE30_NORMAL_BUILD_RESTORED=PASS");
    }
  }
  return exitCode;
}

function runPreparedE2E(rawArguments, buildFirst, captureOutput = () => {}) {
  if (rawArguments.some((argument) => argument !== "--list")) {
    console.error("Authoritative Playwright accepts only the optional --list argument.");
    return 1;
  }
  if (buildFirst) {
    const build = spawnAuthoritative(pnpm, ["build"]);
    if (build.exitCode !== 0) return build.exitCode;
  }
  const discovery = spawnAuthoritative(process.execPath, [
    playwrightCliPath,
    "test",
    "--reporter=line",
    "--workers=1",
    "--list",
  ]);
  if (discovery.exitCode !== 0) return discovery.exitCode;
  captureOutput(discovery.output);
  const discoveredTestCount = parseDiscoveredTestCount(discovery.output);
  if (discoveredTestCount !== EXPECTED_PHASE1_2_PLAYWRIGHT_TEST_COUNT) {
    console.error(
      `Playwright discovery count mismatch: expected ${EXPECTED_PHASE1_2_PLAYWRIGHT_TEST_COUNT}, discovered ${discoveredTestCount ?? 0}.`,
    );
    return 1;
  }
  if (rawArguments.includes("--list")) return 0;

  const execution = spawnAuthoritative(process.execPath, [
    playwrightCliPath,
    "test",
    "--reporter=list",
    "--workers=1",
  ]);
  captureOutput(execution.output);
  if (execution.exitCode !== 0) return execution.exitCode;
  const passedTestCount = parsePassedTestCount(execution.output);
  if (passedTestCount !== discoveredTestCount) {
    console.error(
      `Playwright execution count mismatch: discovered ${discoveredTestCount}, passed ${passedTestCount ?? 0}.`,
    );
    return 1;
  }
  return 0;
}

function runAggregate(options) {
  const verificationEnvironment = createAuthoritativeEnvironment(process.env, {
    APP_BASE_URL: "http://127.0.0.1:3000",
    DATABASE_DRIVER: "pglite",
    DEMO_AUTH_ENABLED: "true",
    DEMO_DATABASE_PATH: ".data/phase1-2-verification",
    DEMO_RESET_CONFIRMATION: "RESET_BEA_DEMO_DATA",
    LOG_LEVEL: "silent",
    SESSION_TTL_MINUTES: "480",
    WORKER_DEMO_DATABASE_PATH: "memory://",
    WORKER_HEALTH_PORT: "33102",
    WORKER_MODE: "once",
    WORKER_POLL_INTERVAL_MS: "60000",
    WORKER_QUEUE_ADAPTER: "inline",
  });
  const results = PHASE1_2_GATE_DEFINITIONS.map(([number, name]) => ({
    detail: "",
    exitCode: null,
    name,
    number,
    result: "PENDING",
  }));
  let databaseBoundaryStarted = false;
  let ownerLauncherAttempted = false;
  let ownerLauncherStopped = false;
  let productionBrowserBuildReady = false;
  let terminalFailure;
  let terminalBlock;
  const passingSuiteOutput = new Map();

  class RequiredGateBlockedError extends Error {}

  function resultFor(number) {
    const result = results.find((entry) => entry.number === number);
    if (!result) throw new Error(`Unknown Phase 1.2 gate ${number}.`);
    return result;
  }

  function record(number, result, exitCode, detail = "") {
    Object.assign(resultFor(number), { detail, exitCode, result });
  }

  function executeResult(command, args, commandOptions = {}) {
    return spawnAuthoritative(command, args, {
      ...commandOptions,
      environment: { ...verificationEnvironment, ...commandOptions.environment },
    });
  }

  function execute(command, args, commandOptions = {}) {
    return executeResult(command, args, commandOptions).exitCode;
  }

  function commandGate(number, command, args, commandOptions = {}) {
    const { name } = resultFor(number);
    console.log(`\n==> ${number}. ${name}`);
    const { captureEvidence = false, ...executionOptions } = commandOptions;
    const execution = executeResult(command, args, executionOptions);
    const { exitCode } = execution;
    record(number, exitCode === 0 ? "PASS" : "FAIL", exitCode);
    if (exitCode !== 0) throw new Error(`${name} failed with exit code ${exitCode}.`);
    if (captureEvidence) passingSuiteOutput.set(number, execution.output);
  }

  function customGate(number, callback, detail = "") {
    const { name } = resultFor(number);
    console.log(`\n==> ${number}. ${name}`);
    const exitCode = callback();
    record(number, exitCode === 0 ? "PASS" : "FAIL", exitCode, detail);
    if (exitCode !== 0) throw new Error(`${name} failed with exit code ${exitCode}.`);
  }

  function blockedGate(number, detail) {
    const { name } = resultFor(number);
    console.log(`\n==> ${number}. ${name}: BLOCKED (${detail})`);
    record(number, "BLOCKED", null, detail);
    throw new RequiredGateBlockedError(`${name} is required but was not run: ${detail}.`);
  }

  function pnpmGate(number, ...args) {
    commandGate(number, pnpm, args);
  }

  function sequence(steps) {
    for (const [command, args] of steps) {
      const exitCode = execute(command, args);
      if (exitCode !== 0) return exitCode;
    }
    return 0;
  }

  function evidenceGate(number, phrases, suiteGates) {
    customGate(
      number,
      () => {
        if (suiteGates.some((gate) => resultFor(gate).result !== "PASS")) return 1;
        const missing = phrases.filter((phrase) => {
          const binding = PHASE1_2_EVIDENCE_BINDINGS[phrase];
          return (
            !binding ||
            !suiteGates.includes(binding.suiteGate) ||
            !outputHasExactTestEvidence(
              passingSuiteOutput.get(binding.suiteGate) ?? "",
              phrase,
              binding.file,
            )
          );
        });
        if (missing.length > 0) {
          console.error(`Missing named automated evidence: ${missing.join(", ")}`);
          return 1;
        }
        phrases.forEach((phrase) => console.log(`evidence: ${phrase}`));
        return 0;
      },
      `Covered by full gate${suiteGates.length === 1 ? "" : "s"} ${suiteGates.join(", ")}.`,
    );
  }

  function deferredEvidenceGate(number, phrases, suiteGates, detail) {
    const { name } = resultFor(number);
    console.log(`\n==> ${number}. ${name}`);
    if (suiteGates.some((gate) => resultFor(gate).result !== "PASS")) {
      record(number, "FAIL", 1, "Required readiness suite did not pass.");
      throw new Error(`${name} readiness evidence is unavailable.`);
    }
    const missing = phrases.filter((phrase) => {
      const binding = PHASE1_2_EVIDENCE_BINDINGS[phrase];
      return (
        !binding ||
        !suiteGates.includes(binding.suiteGate) ||
        !outputHasExactTestEvidence(
          passingSuiteOutput.get(binding.suiteGate) ?? "",
          phrase,
          binding.file,
        )
      );
    });
    if (missing.length > 0) {
      console.error(`Missing named readiness evidence: ${missing.join(", ")}`);
      record(number, "FAIL", 1, "Named readiness evidence is missing.");
      throw new Error(`${name} readiness evidence is incomplete.`);
    }
    phrases.forEach((phrase) => console.log(`readiness evidence: ${phrase}`));
    console.log(`DEFERRED: ${detail}`);
    record(number, "DEFERRED", null, detail);
  }

  function ensureProductionBrowserBuild() {
    if (productionBrowserBuildReady) return 0;
    const exitCode = execute(pnpm, ["build"]);
    if (exitCode === 0) productionBrowserBuildReady = true;
    return exitCode;
  }

  try {
    commandGate(1, process.execPath, ["scripts/repository-boundary.mjs"]);
    customGate(2, () => {
      const pinnedCommit = execute("git", [
        "-c",
        `safe.directory=${normalizedRoot}`,
        "cat-file",
        "-e",
        `${PHASE1_2_STARTING_COMMIT}^{commit}`,
      ]);
      if (pinnedCommit !== 0) return pinnedCommit;
      const head = executeResult("git", [
        "-c",
        `safe.directory=${normalizedRoot}`,
        "rev-parse",
        "HEAD",
      ]);
      if (head.exitCode !== 0) return head.exitCode;
      const branch = executeResult("git", [
        "-c",
        `safe.directory=${normalizedRoot}`,
        "symbolic-ref",
        "--short",
        "HEAD",
      ]);
      if (branch.exitCode !== 0) return branch.exitCode;
      try {
        assertPhase1_2StartingState(head.output, branch.output);
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        return 1;
      }
    });
    pnpmGate(3, "source:verify");
    commandGate(4, pnpm, ["install", "--frozen-lockfile"]);
    pnpmGate(5, "format");
    pnpmGate(6, "format:check");
    pnpmGate(7, "lint");
    pnpmGate(8, "typecheck");
    commandGate(9, pnpm, ["test:unit", "--reporter=verbose"], {
      captureEvidence: true,
    });
    commandGate(10, pnpm, ["test:component", "--reporter=verbose"], {
      captureEvidence: true,
    });
    commandGate(11, pnpm, ["test:integration", "--reporter=verbose"], {
      captureEvidence: true,
    });

    customGate(12, () => {
      const start = execute(pnpm, ["db:start"]);
      if (start !== 0) return start;
      databaseBoundaryStarted = true;
      return execute(pnpm, ["db:migrate"]);
    });
    customGate(13, () =>
      sequence([
        [pnpm, ["db:seed"]],
        [pnpm, ["db:seed"]],
      ]),
    );
    customGate(14, () =>
      sequence([
        [pnpm, ["demo:reset"]],
        [pnpm, ["db:seed"]],
      ]),
    );

    evidenceGate(15, ["publishes the matched-height panel contract"], [10]);
    evidenceGate(16, ["publishes the bottom-aligned panel region contract"], [10]);
    evidenceGate(17, ["publishes the intentional two-scroller architecture"], [10]);
    evidenceGate(18, ["publishes the compact consistent suggestion-pill contract"], [10]);
    evidenceGate(19, ["publishes the composer anchoring contract"], [10]);
    evidenceGate(
      20,
      ["defines the resizable desktop split and compact single-panel breakpoint"],
      [10],
    );
    evidenceGate(
      21,
      ["keeps the current workspace visible until the staged replacement is ready"],
      [10],
    );
    evidenceGate(
      22,
      [
        "BEA_DISABLE_ENV_FILE bypasses every env-file exists/read operation",
        "ambient BEA_DISABLE_ENV_FILE overrides a narrowed child environment and loadEnvFile true",
      ],
      [9],
    );
    evidenceGate(
      23,
      ["normalizes timeout cancel auth quota rate network and unavailable without raw causes"],
      [9],
    );
    evidenceGate(
      24,
      ["bounds pagination, rejects malformed metadata, deduplicates IDs, and guards dates"],
      [9],
    );
    evidenceGate(
      25,
      [
        "blocks activation when required model capabilities remain unknown",
        "allows only an explicitly administrator-verified compatible cached model",
      ],
      [9],
    );
    evidenceGate(
      26,
      [
        "streams deltas usage and completion and maps abort timeout safely",
        "bounds adversarial provider collections text and token usage metadata",
      ],
      [9],
    );
    evidenceGate(
      27,
      [
        "constructs current Responses tools and sanitizes sources citations files usage and provider fields",
        "streams simulated web citations and schema-valid artifact proposals without a key",
      ],
      [9],
    );
    evidenceGate(
      28,
      [
        "constructs current Responses tools and sanitizes sources citations files usage and provider fields",
        "preserves application artifacts, citations, and downloads when reopened",
      ],
      [9, 10],
    );
    evidenceGate(
      29,
      ["mints current short-lived Realtime config with allowlisted tools and no standard key DTO"],
      [9],
    );
    customGate(
      30,
      () =>
        runWebRtcBrowserVerification((output) => {
          passingSuiteOutput.set(30, `${passingSuiteOutput.get(30) ?? ""}\n${output}`);
        }),
      "Covered by the dedicated production-built deterministic Chromium media lifecycle.",
    );
    evidenceGate(
      31,
      ["publishes every required BEA orb state and integrated simulated voice flow"],
      [10],
    );
    evidenceGate(
      32,
      [
        "caps the legacy in-memory usage ledger to the newest 500 records",
        "uses one registered tool for text and simulated voice to create a research source board, cited chart, table, AI-labeled image, branded PDF, and simulated usage",
      ],
      [9, 11],
    );
    evidenceGate(
      33,
      [
        "gates the administration panel on both management permissions in the server page",
        "blocks direct live Realtime file code and image work without durable owner authorization",
      ],
      [9, 10],
    );
    evidenceGate(
      34,
      [
        "uses one registered tool for text and simulated voice to create a research source board, cited chart, table, AI-labeled image, branded PDF, and simulated usage",
        "requires a validated upload at the web seam and returns safe preview, download, and refresh responses",
        "attributes restricted owner uploads to the application instead of a provider",
        "renders only allowlisted application renderers with safe markup",
      ],
      [9, 10, 11],
    );

    pnpmGate(35, "build:web");
    pnpmGate(36, "build:worker");
    pnpmGate(37, "build");
    productionBrowserBuildReady = true;
    pnpmGate(38, "smoke:web");
    pnpmGate(39, "smoke:worker");
    customGate(
      40,
      () => (resultFor(38).result === "PASS" && resultFor(39).result === "PASS" ? 0 : 1),
      "Covered by the built web and worker startup health probes in gates 38 and 39.",
    );
    if (options.skipEndToEnd) blockedGate(41, "--skip-e2e was supplied");
    else {
      customGate(41, () => {
        const buildExitCode = ensureProductionBrowserBuild();
        return buildExitCode === 0
          ? runPreparedE2E([], false, (output) => {
              passingSuiteOutput.set(41, `${passingSuiteOutput.get(41) ?? ""}\n${output}`);
            })
          : buildExitCode;
      });
    }

    commandGate(42, "cmd.exe", ["/d", "/c", "BEA-Doctor.cmd", "--check"]);
    if (options.skipOwnerLauncher) blockedGate(43, "--skip-owner-launcher was supplied");
    ownerLauncherAttempted = true;
    commandGate(43, "cmd.exe", ["/d", "/c", "Start-BEA-Demo.cmd", "--no-open", "--seed"]);
    commandGate(44, "cmd.exe", ["/d", "/c", "Stop-BEA-Demo.cmd"]);
    ownerLauncherStopped = true;

    pnpmGate(45, "security:audit");
    commandGate(46, process.execPath, ["scripts/secret-scan.mjs"]);
    pnpmGate(47, "inventory:verify");
    customGate(48, () => {
      const check = execute("git", [
        "-c",
        `safe.directory=${normalizedRoot}`,
        "diff",
        "--cached",
        "--check",
      ]);
      if (check !== 0) return check;
      const stagedPaths = spawnAuthoritative(
        "git",
        [
          "-c",
          `safe.directory=${normalizedRoot}`,
          "-c",
          "core.quotepath=false",
          "diff",
          "--cached",
          "--name-only",
          "--diff-filter=ACMR",
        ],
        { environment: verificationEnvironment },
      );
      if (stagedPaths.exitCode !== 0) return stagedPaths.exitCode;
      const forbiddenPaths = findForbiddenPhase1_2StagedPaths(
        stagedPaths.output
          .split(/\r?\n/u)
          .map((pathname) => pathname.trim())
          .filter(Boolean),
      );
      if (forbiddenPaths.length > 0) {
        console.error(
          `Forbidden staged runtime/build/report/audio paths: ${forbiddenPaths.join(", ")}`,
        );
        return 1;
      }
      const empty = spawnAuthoritative(
        "git",
        ["-c", `safe.directory=${normalizedRoot}`, "diff", "--cached", "--quiet"],
        { environment: verificationEnvironment, stdio: "ignore" },
      ).exitCode;
      if (empty === 0) {
        console.error("No staged Phase 1.2 diff is available for final verification.");
        return 1;
      }
      return empty === 1 ? 0 : empty;
    });
    customGate(49, () => {
      const status = spawnAuthoritative(
        "git",
        ["-c", `safe.directory=${normalizedRoot}`, "status", "--porcelain=v1"],
        { environment: verificationEnvironment },
      );
      if (status.exitCode !== 0) return status.exitCode;
      const lines = status.output.trim().split(/\r?\n/u).filter(Boolean);
      const invalid = lines.filter((line) => line.startsWith("??") || line[1] !== " ");
      if (invalid.length > 0) {
        console.error("Git status must be clean or contain only intentionally staged files.");
        return 1;
      }
      return 0;
    });
    evidenceGate(
      50,
      [
        "accepts only the normalized pdf renderer shape",
        "rejects arbitrary renderers and unsafe extra renderer fields",
      ],
      [9],
    );
    evidenceGate(
      51,
      [
        "rejects arbitrary renderers and unsafe extra renderer fields",
        "rejects unknown or unsafe application renderer payloads",
      ],
      [9, 10],
    );
    evidenceGate(
      52,
      [
        "fails closed for simulated, infected, unavailable, and failed malware scans",
        "attributes restricted owner uploads to the application instead of a provider",
      ],
      [9, 10],
    );
    evidenceGate(
      53,
      [
        "stores stable IDs and hashes without exposing raw paths",
        "rechecks every persisted artifact permission and hides same-owner access after role revocation",
      ],
      [11],
    );
    evidenceGate(
      54,
      [
        "requires a validated upload at the web seam and returns safe preview, download, and refresh responses",
      ],
      [11],
    );
    evidenceGate(
      55,
      [
        "accepts allowlisted line charts with explicit provenance",
        "rejects chart provenance or data defects",
      ],
      [9],
    );
    evidenceGate(
      56,
      [
        "creates byte-identical PDFs with branding, findings, citations, disclosure, dates, and page numbers",
      ],
      [9],
    );
    evidenceGate(
      57,
      [
        "keeps browser uploads at 12 MiB while trusted generated files use their separate ceiling",
        "uses the strictest bounded upload and generated-file limits",
      ],
      [9, 10],
    );
    evidenceGate(
      58,
      [
        "uses one registered tool for text and simulated voice to create a research source board, cited chart, table, AI-labeled image, branded PDF, and simulated usage",
      ],
      [11],
    );
    evidenceGate(
      59,
      [
        "creates byte-identical PDFs with branding, findings, citations, disclosure, dates, and page numbers",
      ],
      [9],
    );
    evidenceGate(
      60,
      ["adapts normalized artifact manifests and provides controlled PDF navigation"],
      [10],
    );
    evidenceGate(
      61,
      [
        "uses one registered tool for text and simulated voice to create a research source board, cited chart, table, AI-labeled image, branded PDF, and simulated usage",
      ],
      [11],
    );
    evidenceGate(
      62,
      [
        "uses one registered tool for text and simulated voice to create a research source board, cited chart, table, AI-labeled image, branded PDF, and simulated usage",
      ],
      [11],
    );
    evidenceGate(
      63,
      [
        "uses one registered tool for text and simulated voice to create a research source board, cited chart, table, AI-labeled image, branded PDF, and simulated usage",
      ],
      [11],
    );
    evidenceGate(
      64,
      [
        "0004 persists every generated-artifact kind, application-owned upload attribution, and owner-scoped reopen",
        "preserves application artifacts, citations, and downloads when reopened",
      ],
      [10, 11],
    );
    evidenceGate(
      65,
      ["returns the same non-enumerating 404 for cross-owner preview, download, and refresh"],
      [11],
    );
    evidenceGate(
      66,
      [
        "uses one registered tool for text and simulated voice to create a research source board, cited chart, table, AI-labeled image, branded PDF, and simulated usage",
        "stores safe artifact-file linkage without writing a non-UUID file ID into resource_id",
      ],
      [11],
    );
    evidenceGate(
      67,
      [
        "removes generated files when authoritative persistence fails",
        "reports failed retention cleanup without exposing a path and succeeds on retry",
        "sweeps expired files and crash orphans while preserving fresh and paired data",
        "automatically runs retention and orphan reconciliation on the inline schedule",
        "queues a singleton retention sweep for pg-boss and executes its registered handler",
      ],
      [11],
    );
    evidenceGate(
      68,
      [
        "uses one registered tool for text and simulated voice to create a research source board, cited chart, table, AI-labeled image, branded PDF, and simulated usage",
        "runs and reopens the Demo research source-board chart and PDF artifact chain",
      ],
      [11, 41],
    );
    deferredEvidenceGate(
      69,
      ["keeps optional live provider validation separately acknowledged and non-authoritative"],
      [9],
      "No owner-provided OpenAI credential or explicit paid live-smoke acknowledgement is in scope.",
    );
  } catch (error) {
    if (error instanceof RequiredGateBlockedError) terminalBlock = error;
    else terminalFailure = error;
    console.error(error instanceof Error ? error.message : error);
  } finally {
    if (ownerLauncherAttempted && !ownerLauncherStopped) {
      console.log("\n==> Exact owner-launcher cleanup boundary");
      const stopCode = execute("cmd.exe", ["/d", "/c", "Stop-BEA-Demo.cmd"]);
      if (stopCode !== 0) {
        terminalFailure ??= new Error(`Owner-launcher cleanup failed with exit code ${stopCode}.`);
        if (resultFor(44).result === "PENDING") {
          record(44, "FAIL", stopCode, "Exact owner-launcher cleanup failed.");
        }
      }
    }
    if (databaseBoundaryStarted) {
      console.log("\n==> Demo database shutdown boundary");
      const stopCode = execute(pnpm, ["db:stop"]);
      if (stopCode !== 0) {
        terminalFailure ??= new Error(`Demo database cleanup failed with exit code ${stopCode}.`);
        record(12, "FAIL", stopCode, "Database shutdown boundary failed.");
      }
    }
    const blocker = terminalFailure
      ? "blocked by an earlier failed gate"
      : terminalBlock
        ? "required gate was intentionally skipped"
        : "aggregate ended before this gate";
    for (const result of results) {
      if (result.result === "PENDING") record(result.number, "BLOCKED", null, blocker);
    }
    console.table(results);
  }

  const hasFailure = results.some((result) => result.result === "FAIL") || terminalFailure;
  const hasBlocked = results.some((result) => result.result === "BLOCKED") || terminalBlock;
  if (hasFailure) {
    console.log("PHASE1_2_VERIFICATION=FAIL");
    return 1;
  }
  if (hasBlocked) {
    console.log("PHASE1_2_VERIFICATION=BLOCKED_REQUIRED_GATE_NOT_RUN");
    return 2;
  }
  console.log("PHASE1_2_VERIFICATION=PASS");
  return 0;
}

export function runPhase1_2Verifier(arguments_ = process.argv.slice(2)) {
  assertPinnedPhase1_2Toolchain();
  const mode = arguments_[0];
  if (mode === "--webrtc-browser") {
    if (arguments_.length !== 1) {
      throw new Error("Gate 30 browser verification accepts no additional arguments.");
    }
    return runWebRtcBrowserVerification();
  }
  if (mode === "--prepared-e2e" || mode === "--production-e2e") {
    return runPreparedE2E(arguments_.slice(1), mode === "--production-e2e");
  }
  const allowed = new Set(["--skip-e2e", "--skip-owner-launcher"]);
  if (arguments_.some((argument) => !allowed.has(argument))) {
    throw new Error(
      "Usage: node scripts/verify-phase1-2.mjs [--webrtc-browser|--skip-e2e|--skip-owner-launcher]",
    );
  }
  return runAggregate({
    skipEndToEnd: arguments_.includes("--skip-e2e"),
    skipOwnerLauncher: arguments_.includes("--skip-owner-launcher"),
  });
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    process.exitCode = runPhase1_2Verifier();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.log("PHASE1_2_VERIFICATION=FAIL");
    process.exitCode = 1;
  }
}
