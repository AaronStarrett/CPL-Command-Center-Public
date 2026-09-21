import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { previewDistDirectoryForEnvironment } from "../../apps/web/next.config.ts";
import {
  activateOpenAiProvider,
  isDeterministicDemoAiCommandAllowed,
  resolveAiCommandProvider,
} from "../../apps/web/lib/openai-administration.ts";
import {
  RepositoryArtifactFileStore,
  artifactStoreRootForEnvironment,
} from "../../packages/artifacts/src/store.ts";
import { loadRepositoryEnvironment } from "../../packages/config/src/repository-environment.ts";
import { parseEnvironment } from "../../packages/config/src/environment.ts";
import { DEFAULT_PRODUCTION_PORTS } from "../../scripts/phase134/production-profile.mjs";
import {
  authenticatedStatusMatches,
  canonicalToolchainPaths,
  commandLineFingerprint,
  createPreviewChildEnvironment,
  createPreviewLaunchLock,
  createWindowsCommandLine,
  createWindowsPowerShellEnvironment,
  inspectCanonicalToolchain,
  inspectTrackedPreview,
  previewAuthority,
  previewHost,
  previewPaths,
  previewPorts,
  previewSignInUrl,
  processIdentityMatches,
  recoverStalePreviewLaunchLock,
  repositoryRoot,
  supervisorLaunchFingerprint,
  systemCommandPromptPath,
  systemPowerShellPath,
  validatePreviewLaunchLock,
  validatePreviewMetadata,
} from "../../scripts/preview-common.mjs";
import {
  decidePreviewStart,
  parsePreviewStartArguments,
  startPreview,
} from "../../scripts/preview-start.mjs";
import {
  authenticatedStopAccepted,
  decidePreviewStop,
  parsePreviewStopArguments,
  stopPreview,
} from "../../scripts/preview-stop.mjs";
import {
  createAuthenticatedStatus,
  terminateExactPreviewChild,
  validatePreviewSupervisorEnvironment,
} from "../../scripts/preview-supervisor.mjs";

vi.mock("server-only", () => ({}));

const testEnvironment = {
  ...process.env,
  LOCALAPPDATA: process.env.LOCALAPPDATA ?? "C:\\Users\\BEA Test\\AppData\\Local",
  SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
};
const toolchain = canonicalToolchainPaths(testEnvironment);
const supervisorScript = join(repositoryRoot, "scripts", "preview-supervisor.mjs");
const fixedStartedAt = "2026-08-25T12:00:00.000Z";

function source(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

function osIdentity(pid = 4_101, overrides = {}) {
  return {
    commandLineFingerprint: commandLineFingerprint(`synthetic-preview-command-${String(pid)}`),
    executablePath: toolchain.nodeExecutable,
    osStartedAt: fixedStartedAt,
    pid,
    ...overrides,
  };
}

function validMetadata(overrides = {}) {
  const identity = osIdentity();
  return {
    children: {},
    controlHost: previewHost,
    controlPort: previewPorts.control,
    controlToken: "b".repeat(64),
    instanceId: "a".repeat(32),
    logs: {
      supervisor: ".data/bea-preview/logs/synthetic-supervisor.log",
      web: ".data/bea-preview/logs/synthetic-web.log",
      worker: ".data/bea-preview/logs/synthetic-worker.log",
    },
    ports: previewPorts,
    profile: "preview",
    repositoryRoot,
    startedAt: fixedStartedAt,
    state: "starting",
    supervisorExecutable: toolchain.nodeExecutable,
    supervisorLaunchFingerprint: supervisorLaunchFingerprint({
      nodeExecutable: toolchain.nodeExecutable,
      supervisorScript,
    }),
    supervisorOsIdentity: identity,
    supervisorScript,
    updatedAt: fixedStartedAt,
    version: 1,
    ...overrides,
  };
}

function allPortsAvailable() {
  return {
    control: { available: true },
    web: { available: true },
    workerHealth: { available: true },
  };
}

function exactPreviewEnvironment(overrides = {}) {
  return {
    ...createPreviewChildEnvironment(testEnvironment),
    ...overrides,
  };
}

// The legacy launch contract remains parked. Application fixtures must opt into
// the isolated test harness to exercise its retained storage and provider rules.
function applicationPreviewTestEnvironment(overrides = {}) {
  return exactPreviewEnvironment({ NODE_ENV: "test", ...overrides });
}

function createStartFixture(options = {}) {
  const events = [];
  let capturedMetadata;
  let inspectCount = 0;
  const identity = osIdentity(5_001);
  const dependencies = {
    acquireLaunchLock: () => {
      events.push("lock");
      return { path: previewPaths.launchLockFile, token: "lock" };
    },
    assertBoundary: () => events.push("boundary"),
    assertPaths: () => events.push("paths"),
    createLogs: () => ({
      supervisor: join(previewPaths.logDirectory, "fixture-supervisor.log"),
      web: join(previewPaths.logDirectory, "fixture-web.log"),
      worker: join(previewPaths.logDirectory, "fixture-worker.log"),
    }),
    ensureDirectories: () => events.push("directories"),
    environment: testEnvironment,
    exists: () => options.dependenciesPresent ?? true,
    inspectPorts: async () => {
      events.push("ports");
      return options.portResults ?? allPortsAvailable();
    },
    inspectLaunchLock: async () => ({ state: "missing" }),
    inspectProcessIdentity: async () => {
      events.push("identity");
      return identity;
    },
    inspectTracked: async () => {
      inspectCount += 1;
      events.push(`tracked:${String(inspectCount)}`);
      if (inspectCount === 1) return options.initialTracked ?? { state: "stopped" };
      if (inspectCount === 2 && options.startupUnreachableOnce) {
        return { metadata: capturedMetadata, state: "unreachable" };
      }
      return {
        metadata: capturedMetadata,
        state: "running",
        status: { state: "ready" },
      };
    },
    platform: "win32",
    openBrowser: (url) => events.push(`browser:${url}`),
    processIsAlive: () => true,
    randomBytes: (size) => Buffer.alloc(size, size === 16 ? 0xaa : 0xbb),
    readInitialization: () =>
      options.initialization ?? {
        firstStart: true,
      },
    releaseLaunchLock: () => events.push("unlock"),
    requireToolchain: () => {
      events.push("toolchain");
      return toolchain;
    },
    runPnpm: (_pnpm, arguments_) => {
      events.push(`pnpm:${arguments_.join(" ")}`);
      return { exitCode: 0 };
    },
    spawnSupervisor: () => {
      events.push("spawn");
      return {
        kill: vi.fn(),
        pid: identity.pid,
        unref: () => events.push("unref"),
      };
    },
    waitFor: async (predicate) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const value = await predicate();
        if (value) return value;
      }
      throw new Error("Synthetic Preview wait did not resolve.");
    },
    writeInitialization: (_marker, seeded) => events.push(`initialized:${String(seeded)}`),
    writeInitialMetadata: (_path, metadata) => {
      events.push("metadata");
      capturedMetadata = metadata;
    },
    writeOutput: (text) => events.push(`output:${text.trim()}`),
    ...options.dependencies,
  };
  return {
    dependencies,
    events,
    get metadata() {
      return capturedMetadata;
    },
  };
}

describe("Phase 1.3.4 isolated Preview runtime (exactly 22 cases)", () => {
  it("1. keeps Preview wrappers boundary-first, pinned, and separate from production launchers", () => {
    for (const [wrapper, entrypoint] of [
      ["Start-BEA-Preview.cmd", "preview-start.mjs"],
      ["Stop-BEA-Preview.cmd", "preview-stop.mjs"],
    ]) {
      const text = source(wrapper);
      expect(text).toContain('cd /d "%~dp0"');
      expect(text).toContain("node-v24.19.0-win-x64\\node.exe");
      expect(text.indexOf("repository-boundary.mjs")).toBeLessThan(text.indexOf(entrypoint));
      expect(text).not.toMatch(/Start-BEA\.cmd|Stop-BEA\.cmd|phase134\\production/iu);
    }
    expect(source("Start-BEA-Demo.cmd")).toMatch(/TEST-ONLY \/ LEGACY[\s\S]*demo-start\.mjs/iu);
    expect(source("Stop-BEA-Demo.cmd")).toMatch(/TEST-ONLY \/ LEGACY[\s\S]*demo-stop\.mjs/iu);
  });

  it("2. accepts only the bounded Start and Stop command arguments", () => {
    expect(parsePreviewStartArguments(["--no-open", "--seed"])).toEqual({
      check: false,
      noOpen: true,
      seed: true,
    });
    expect(parsePreviewStopArguments(["--check"])).toEqual({ check: true });
    expect(() => parsePreviewStartArguments(["--check", "--seed"])).toThrow(/cannot be combined/iu);
    expect(() => parsePreviewStartArguments(["--live"])).toThrow(/Usage/iu);
    expect(() => parsePreviewStopArguments(["--force"])).toThrow(/Usage/iu);
  });

  it("3. fixes loopback ports and keeps every owned path under .data/bea-preview", () => {
    expect(previewPorts).toEqual({ control: 3_102, web: 3_100, workerHealth: 3_101 });
    expect(Object.values(previewPorts)).not.toEqual(
      expect.arrayContaining(Object.values(DEFAULT_PRODUCTION_PORTS)),
    );
    expect(
      Object.values(previewPorts).filter((port) =>
        Object.values(DEFAULT_PRODUCTION_PORTS).includes(port),
      ),
    ).toEqual([]);
    expect(previewSignInUrl).toBe("http://127.0.0.1:3100/sign-in");
    for (const path of Object.values(previewPaths)) {
      expect(resolve(path).toLowerCase()).toMatch(/\\\.data\\bea-preview(?:\\|$)/u);
      expect(path).not.toMatch(/bea-owner-tools|production-runtime|local-live/iu);
    }
    const start = source("scripts/preview-start.mjs");
    expect(start).toContain('["install", "--frozen-lockfile"]');
    expect(start.indexOf("verifyPortsAvailable")).toBeLessThan(start.indexOf("runRequiredPnpm"));
  });

  it("4. quotes pinned pnpm paths with spaces and strips ambient PSModulePath from WinPS", () => {
    const command = "C:\\Users\\BEA Owner\\AppData\\Local\\BEA\\toolchain\\bin\\pnpm.cmd";
    expect(createWindowsCommandLine(command, ["install", "--frozen-lockfile"])).toBe(
      '""C:\\Users\\BEA Owner\\AppData\\Local\\BEA\\toolchain\\bin\\pnpm.cmd" "install" "--frozen-lockfile""',
    );
    expect(() => createWindowsCommandLine("pnpm.cmd", ["--version"])).toThrow(/absolute/iu);
    const sanitized = createWindowsPowerShellEnvironment({
      ComSpec: "C:\\hostile\\cmd.exe",
      Path: "C:\\Windows",
      PSModulePath: "C:\\PowerShell7\\Modules",
      PSMODULEPATH: "C:\\hostile",
      SystemRoot: "C:\\hostile-windows",
    });
    expect(sanitized).toMatchObject({
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
    });
    expect(sanitized).not.toHaveProperty("PSModulePath");
    expect(systemCommandPromptPath()).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(systemPowerShellPath({ SystemRoot: "C:\\hostile-windows" })).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(() => systemCommandPromptPath({ path: "C:\\hostile\\cmd.exe" })).toThrow(
      /not canonical/iu,
    );

    const spawnPnpm = vi.fn(() => ({ status: 0, stderr: "", stdout: "11.19.0\n" }));
    const inspected = inspectCanonicalToolchain({
      environment: testEnvironment,
      exists: (candidate) =>
        candidate === toolchain.nodeExecutable || candidate === toolchain.pnpmExecutable,
      nodeExecutable: toolchain.nodeExecutable,
      nodeVersion: "24.19.0",
      spawnSync: spawnPnpm,
      toolchainPaths: toolchain,
    });
    expect(inspected).toMatchObject({ nodeReady: true, pnpmReady: true, ready: true });
    expect(spawnPnpm).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      expect.any(Array),
      expect.objectContaining({ shell: false, windowsVerbatimArguments: true }),
    );
    spawnPnpm.mockClear();
    expect(
      inspectCanonicalToolchain({
        environment: testEnvironment,
        exists: () => false,
        nodeExecutable: toolchain.nodeExecutable,
        nodeVersion: "24.19.0",
        spawnSync: spawnPnpm,
        toolchainPaths: toolchain,
      }),
    ).toMatchObject({
      nodePresent: false,
      pnpmPresent: false,
      nodeReady: false,
      pnpmReady: false,
      ready: false,
    });
    expect(spawnPnpm).not.toHaveBeenCalled();
  });

  it("5. creates a narrow loopback Preview child environment without ambient live controls", () => {
    const child = exactPreviewEnvironment({});
    expect(child).toMatchObject({
      APP_MODE: "demo",
      BEA_ARTIFACT_STORE_PATH: ".data/bea-preview/artifacts",
      BEA_PREVIEW_AUTHORITY: previewAuthority,
      BEA_PREVIEW_MODE: "true",
      BEA_PREVIEW_NETWORK_GUARD: "loopback-only",
      DATABASE_DRIVER: "pglite",
      DEMO_DATABASE_PATH: ".data/bea-preview/pglite",
      OPENAI_API_KEY: "",
      PORT: "3100",
      WORKER_HEALTH_PORT: "3101",
      WORKER_QUEUE_ADAPTER: "inline",
    });
    const hostile = createPreviewChildEnvironment({
      ...testEnvironment,
      DATABASE_URL: "postgresql://production.invalid/bea",
      NODE_OPTIONS: "--require=hostile.js",
      OPENAI_API_KEY: "must-not-propagate",
      Path: "C:\\AmbientNode20;C:\\AmbientPnpm",
      PATH: "C:\\AmbientNode20;C:\\AmbientPnpm",
      SESSION_SECRET: "must-not-propagate",
      SystemRoot: "C:\\hostile-windows",
      ComSpec: "C:\\hostile\\cmd.exe",
    });
    expect(hostile.DATABASE_URL).toBe("");
    expect(hostile.OPENAI_API_KEY).toBe("");
    expect(hostile.SESSION_SECRET).toBe("");
    expect(hostile).not.toHaveProperty("NODE_OPTIONS");
    expect(hostile.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(hostile.SystemRoot).toBe("C:\\Windows");
    expect(hostile.Path).not.toContain("AmbientNode20");
    expect(hostile.Path.split(";").slice(0, 2)).toEqual([
      dirname(toolchain.nodeExecutable),
      dirname(toolchain.pnpmExecutable),
    ]);
    expect(source("scripts/preview-start.mjs")).toContain("toolchain.pnpmExecutable");
    expect(source("scripts/preview-supervisor.mjs")).toContain("toolchain.nodeExecutable");
  });

  it("6. loads isolated Preview fixtures without env-file access or a readable/writable secret provider", () => {
    const touched = [];
    const loaded = loadRepositoryEnvironment({
      envFileAccess: {
        exists: (path) => {
          touched.push(path);
          return true;
        },
        read: (path) => {
          touched.push(path);
          return "OPENAI_API_KEY=must-not-load";
        },
      },
      processEnvironment: applicationPreviewTestEnvironment(),
      startDirectory: repositoryRoot,
    });
    expect(touched).toEqual([]);
    expect(loaded.environment).toMatchObject({
      appMode: "demo",
      deploymentProfile: "demo",
      runtimeMode: "test",
    });
    expect(loaded.secrets.status().openAiApiKey).toBe("not_configured");
    expect(() => loaded.secrets.storeOpenAiApiKey("preview-cannot-persist-a-secret")).toThrow(
      /unavailable/iu,
    );
  });

  it("7. routes artifacts to the contained Preview store and rejects an outside root", () => {
    expect(
      artifactStoreRootForEnvironment(repositoryRoot, {
        BEA_ARTIFACT_STORE_PATH: ".data/bea-preview/artifacts",
      }),
    ).toBe(resolve(repositoryRoot, ".data", "bea-preview", "artifacts"));
    expect(
      () =>
        new RepositoryArtifactFileStore({
          repositoryRoot,
          rootDirectory: resolve(repositoryRoot, "..", "outside-artifacts"),
        }),
    ).toThrow(/inside.*\.data|outside/iu);
  });

  it("8. selects .next-preview and renders the Preview banner only under exact authority", () => {
    const exact = exactPreviewEnvironment();
    expect(previewDistDirectoryForEnvironment(exact)).toBe(".next-preview");
    expect(
      previewDistDirectoryForEnvironment({ ...exact, BEA_PREVIEW_AUTHORITY: "untrusted" }),
    ).toBeUndefined();
    const banner = source("apps/web/components/operating-mode-banner.tsx");
    expect(banner).toContain("PREVIEW — NON-PRODUCTION");
    expect(banner).toContain('BEA_PREVIEW_AUTHORITY === "Start-BEA-Preview.cmd"');
    const signIn = source("apps/web/app/sign-in/page.tsx");
    expect(signIn).toContain("PREVIEW — NON-PRODUCTION");
    expect(signIn).toContain("Open the isolated Preview workspace");
    expect(signIn).toContain('BEA_PREVIEW_AUTHORITY === "Start-BEA-Preview.cmd"');
    const webTypeScript = JSON.parse(source("apps/web/tsconfig.json"));
    expect(webTypeScript.exclude).toContain(".next-preview/dev/types");
  });

  it("9. orders frozen setup, migration, first-start seed, identity metadata, and spawn deterministically", async () => {
    const fixture = createStartFixture({
      dependenciesPresent: false,
      startupUnreachableOnce: true,
    });
    const result = await startPreview({}, fixture.dependencies);
    expect(result.outcome).toBe("PASS");
    const relevant = fixture.events.filter((event) =>
      /^(?:boundary|paths|toolchain|ports|directories|lock|pnpm:|spawn|identity|metadata|initialized|unlock)/u.test(
        event,
      ),
    );
    expect(relevant).toEqual([
      "boundary",
      "paths",
      "toolchain",
      "ports",
      "directories",
      "lock",
      "pnpm:install --frozen-lockfile",
      "pnpm:--filter @bea/database migrate",
      "pnpm:--filter @bea/database seed",
      "spawn",
      "identity",
      "metadata",
      "initialized:true",
      "unlock",
    ]);
    expect(fixture.metadata).toMatchObject({
      profile: "preview",
      state: "starting",
      supervisorExecutable: toolchain.nodeExecutable,
    });
    expect(fixture.events.indexOf("tracked:3")).toBeLessThan(
      fixture.events.indexOf(`browser:${previewSignInUrl}`),
    );
    expect(fixture.events.filter((event) => event.startsWith("browser:"))).toEqual([
      `browser:${previewSignInUrl}`,
    ]);
  });

  it("10. migrates every launch but seeds initialized state only when explicitly requested", async () => {
    const marker = { initializedAt: fixedStartedAt, lastSeededAt: fixedStartedAt };
    const ordinary = createStartFixture({
      dependenciesPresent: true,
      initialization: { firstStart: false, marker },
    });
    await startPreview({ noOpen: true }, ordinary.dependencies);
    expect(ordinary.events).toContain("pnpm:--filter @bea/database migrate");
    expect(ordinary.events).not.toContain("pnpm:--filter @bea/database seed");
    expect(ordinary.events).not.toContain("pnpm:install --frozen-lockfile");

    const reseed = createStartFixture({
      dependenciesPresent: true,
      initialization: { firstStart: false, marker },
    });
    await startPreview({ noOpen: true, seed: true }, reseed.dependencies);
    expect(reseed.events.indexOf("pnpm:--filter @bea/database migrate")).toBeLessThan(
      reseed.events.indexOf("pnpm:--filter @bea/database seed"),
    );
  });

  it("11. treats authenticated running Preview as idempotent and refuses in-place reseeding", async () => {
    const metadata = validMetadata({ state: "ready" });
    const tracked = {
      metadata,
      state: "running",
      status: { ...createAuthenticatedStatus(metadata), state: "ready" },
    };
    expect(decidePreviewStart(tracked)).toEqual({ action: "already-running" });
    expect(decidePreviewStart(tracked, { seed: true })).toEqual({ action: "block-running-seed" });
    for (const [state, action] of [
      ["starting", "wait-for-ready"],
      ["failed", "block-failed"],
      ["stopping", "block-stopping"],
    ]) {
      const stateMetadata = validMetadata({ state });
      expect(
        decidePreviewStart({
          metadata: stateMetadata,
          state: "running",
          status: { ...createAuthenticatedStatus(stateMetadata), state },
        }),
      ).toEqual({ action });
    }
    const spawned = vi.fn();
    const dependencies = {
      assertBoundary: vi.fn(),
      assertPaths: vi.fn(),
      environment: testEnvironment,
      inspectTracked: async () => tracked,
      platform: "win32",
      requireToolchain: () => toolchain,
      spawnSupervisor: spawned,
      writeOutput: vi.fn(),
    };
    await expect(startPreview({ noOpen: true }, dependencies)).resolves.toMatchObject({
      outcome: "ALREADY_RUNNING",
    });
    await expect(startPreview({ noOpen: true, seed: true }, dependencies)).rejects.toThrow(
      /Stop the running Preview/iu,
    );
    expect(spawned).not.toHaveBeenCalled();

    const startingMetadata = validMetadata({ state: "starting" });
    const readyMetadata = { ...startingMetadata, state: "ready" };
    const browser = vi.fn();
    const inspectConcurrent = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: startingMetadata,
        state: "running",
        status: createAuthenticatedStatus(startingMetadata),
      })
      .mockResolvedValue({
        metadata: readyMetadata,
        state: "running",
        status: createAuthenticatedStatus(readyMetadata),
      });
    await expect(
      startPreview(
        {},
        {
          assertBoundary: vi.fn(),
          assertPaths: vi.fn(),
          environment: testEnvironment,
          inspectTracked: inspectConcurrent,
          openBrowser: browser,
          platform: "win32",
          requireToolchain: () => toolchain,
          writeOutput: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ outcome: "ALREADY_RUNNING" });
    expect(browser).toHaveBeenCalledExactlyOnceWith(previewSignInUrl);

    const failedMetadata = validMetadata({ state: "failed" });
    await expect(
      startPreview(
        {},
        {
          assertBoundary: vi.fn(),
          assertPaths: vi.fn(),
          environment: testEnvironment,
          inspectTracked: async () => ({
            metadata: failedMetadata,
            state: "running",
            status: createAuthenticatedStatus(failedMetadata),
          }),
          openBrowser: browser,
          platform: "win32",
          requireToolchain: () => toolchain,
        },
      ),
    ).rejects.toThrow(/failed startup/iu);
    expect(browser).toHaveBeenCalledOnce();
  });

  it("12. blocks occupied Preview ports before install, migration, seed, or process launch", async () => {
    const fixture = createStartFixture({
      dependenciesPresent: false,
      portResults: {
        ...allPortsAvailable(),
        web: { available: false, code: "EADDRINUSE" },
      },
    });
    await expect(startPreview({ noOpen: true }, fixture.dependencies)).rejects.toThrow(
      /occupied/iu,
    );
    expect(fixture.events).not.toContain("directories");
    expect(fixture.events.some((event) => event.startsWith("pnpm:"))).toBe(false);
    expect(fixture.events).not.toContain("spawn");
  });

  it("13. refuses ALREADY_STOPPED when any fixed Preview port remains occupied", async () => {
    const processAccess = vi.fn();
    await expect(
      stopPreview(
        {},
        {
          assertBoundary: vi.fn(),
          assertPaths: vi.fn(),
          inspectPorts: async () => ({
            ...allPortsAvailable(),
            control: { available: false, code: "EADDRINUSE" },
          }),
          inspectLaunchLock: async () => ({ state: "missing" }),
          inspectTracked: async () => ({ state: "stopped" }),
          platform: "win32",
          processIsAlive: processAccess,
          requireToolchain: () => toolchain,
        },
      ),
    ).rejects.toThrow(/ports remain occupied/iu);
    expect(processAccess).not.toHaveBeenCalled();
    await expect(
      stopPreview(
        {},
        {
          assertBoundary: vi.fn(),
          assertPaths: vi.fn(),
          inspectPorts: async () => allPortsAvailable(),
          inspectLaunchLock: async () => ({ state: "missing" }),
          inspectTracked: async () => ({ state: "stopped" }),
          platform: "win32",
          processIsAlive: processAccess,
          requireToolchain: () => toolchain,
          writeOutput: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ outcome: "ALREADY_STOPPED" });
    expect(processAccess).not.toHaveBeenCalled();

    const portsDuringLaunch = vi.fn(async () => allPortsAvailable());
    await expect(
      stopPreview(
        {},
        {
          assertBoundary: vi.fn(),
          assertPaths: vi.fn(),
          inspectLaunchLock: async () => ({ state: "live" }),
          inspectPorts: portsDuringLaunch,
          inspectTracked: async () => ({ state: "stopped" }),
          platform: "win32",
          requireToolchain: () => toolchain,
        },
      ),
    ).rejects.toThrow(/still starting/iu);
    expect(portsDuringLaunch).not.toHaveBeenCalled();
  });

  it("14. validates exact supervisor metadata and rejects changed executable, logs, or shape", () => {
    const valid = validMetadata();
    expect(validatePreviewMetadata(valid, { environment: testEnvironment }).issues).toEqual([]);
    expect(
      validatePreviewMetadata(
        { ...valid, supervisorExecutable: "C:\\untrusted\\node.exe" },
        { environment: testEnvironment },
      ).issues,
    ).toContain("Preview supervisor executable is not canonical BEA Node.");
    expect(
      validatePreviewMetadata(
        { ...valid, logs: { ...valid.logs, web: "production.log" } },
        { environment: testEnvironment },
      ).issues,
    ).toContain("Preview log metadata is invalid.");
    expect(
      validatePreviewMetadata({ ...valid, unexpected: true }, { environment: testEnvironment })
        .issues[0],
    ).toMatch(/unknown fields/iu);

    const lock = createPreviewLaunchLock(osIdentity(process.pid), "9".repeat(64), {
      environment: testEnvironment,
      now: () => new Date(fixedStartedAt),
    });
    expect(validatePreviewLaunchLock(lock, { environment: testEnvironment }).issues).toEqual([]);
    expect(
      validatePreviewLaunchLock(
        {
          ...lock,
          ownerOsIdentity: {
            ...lock.ownerOsIdentity,
            executablePath: "C:\\untrusted\\node.exe",
          },
        },
        { environment: testEnvironment },
      ).issues,
    ).toContain("Preview launch-lock owner is not canonical BEA Node.");
  });

  it("15. cleans stale metadata only after all ports are free and an owner-CAS succeeds", async () => {
    const metadata = validMetadata();
    const removed = vi.fn(() => true);
    const base = {
      assertBoundary: vi.fn(),
      assertPaths: vi.fn(),
      inspectTracked: async () => ({ metadata, state: "stale" }),
      platform: "win32",
      removeMetadata: removed,
      requireToolchain: () => toolchain,
      writeOutput: vi.fn(),
    };
    await expect(
      stopPreview(
        {},
        {
          ...base,
          inspectPorts: async () => ({
            ...allPortsAvailable(),
            workerHealth: { available: false, code: "EADDRINUSE" },
          }),
        },
      ),
    ).rejects.toThrow(/ports remain occupied/iu);
    expect(removed).not.toHaveBeenCalled();
    await expect(
      stopPreview({}, { ...base, inspectPorts: async () => allPortsAvailable() }),
    ).resolves.toMatchObject({ outcome: "STALE_METADATA_CLEANED" });
    expect(removed).toHaveBeenCalledOnce();
    expect(decidePreviewStop({ metadata, state: "stale" }, { check: true })).toEqual({
      action: "report-stale",
    });

    const staleLock = {
      lock: createPreviewLaunchLock(osIdentity(7_001), "8".repeat(64), {
        environment: testEnvironment,
        now: () => new Date(fixedStartedAt),
      }),
      recovery: false,
      state: "stale",
    };
    const recoveryEvents = [];
    await expect(
      stopPreview(
        {},
        {
          assertBoundary: vi.fn(),
          assertPaths: vi.fn(),
          inspectLaunchLock: async () => staleLock,
          inspectPorts: async () => {
            recoveryEvents.push("ports");
            return allPortsAvailable();
          },
          inspectTracked: async () => ({ state: "stopped" }),
          platform: "win32",
          recoverLaunchLock: async () => {
            recoveryEvents.push("recover");
            return true;
          },
          requireToolchain: () => toolchain,
          writeOutput: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ outcome: "STALE_LAUNCH_LOCK_CLEANED" });
    expect(recoveryEvents).toEqual(["ports", "recover"]);

    const claimedEvents = [];
    await expect(
      recoverStalePreviewLaunchLock(staleLock, {
        environment: testEnvironment,
        inspectLaunchLock: async () => staleLock,
        readLaunchLock: () => ({ exists: true, issues: [], lock: staleLock.lock }),
        remove: () => claimedEvents.push("remove"),
        rename: () => claimedEvents.push("rename"),
      }),
    ).resolves.toBe(true);
    expect(claimedEvents).toEqual(["rename", "remove"]);
  });

  it("16. fails closed on invalid or unreachable evidence without spawning, controlling, or killing", async () => {
    const spawn = vi.fn();
    const control = vi.fn();
    const kill = vi.fn();
    const common = {
      assertBoundary: vi.fn(),
      assertPaths: vi.fn(),
      environment: testEnvironment,
      platform: "win32",
      requireToolchain: () => toolchain,
    };
    await expect(
      startPreview(
        {},
        {
          ...common,
          inspectTracked: async () => ({ issues: ["invalid"], state: "invalid" }),
          spawnSupervisor: spawn,
        },
      ),
    ).rejects.toThrow(/unverifiable/iu);
    await expect(
      stopPreview(
        {},
        {
          ...common,
          controlRequest: control,
          inspectTracked: async () => ({ metadata: validMetadata(), state: "unreachable" }),
          processKill: kill,
        },
      ),
    ).rejects.toThrow(/unverifiable/iu);
    expect(spawn).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();

    const recover = vi.fn();
    const inspectPorts = vi.fn();
    await expect(
      stopPreview(
        {},
        {
          ...common,
          inspectLaunchLock: async () => ({ state: "ambiguous" }),
          inspectPorts,
          inspectTracked: async () => ({ state: "stopped" }),
          recoverLaunchLock: recover,
        },
      ),
    ).rejects.toThrow(/launch-lock ownership is unverifiable/iu);
    expect(inspectPorts).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("17. keeps Preview out of production provider/runtime schema values", () => {
    const loaded = loadRepositoryEnvironment({
      processEnvironment: applicationPreviewTestEnvironment(),
      startDirectory: repositoryRoot,
    });
    expect(loaded.environment).toMatchObject({
      appMode: "demo",
      authProvider: "demo",
      deploymentProfile: "demo",
      runtimeMode: "test",
    });
    for (const override of [
      { APP_MODE: "preview" },
      { BEA_AUTH_PROVIDER: "preview" },
      { BEA_DEPLOYMENT_PROFILE: "preview" },
      { BEA_RUNTIME_MODE: "preview" },
    ]) {
      expect(() =>
        parseEnvironment({ ...applicationPreviewTestEnvironment(), ...override }),
      ).toThrow();
    }
  });

  it("18. allows deterministic Demo in isolated test fixtures and denies production fallback", async () => {
    const getProviderSettings = vi.fn(async () => ({ mode: "demo" }));
    const active = vi.fn(() => ({ providerKey: "demo" }));
    const productionRuntime = {
      ai: { persistence: { getProviderSettings }, registry: { active } },
      environment: { appMode: "production", runtimeMode: "production" },
    };
    await expect(isDeterministicDemoAiCommandAllowed(productionRuntime)).resolves.toBe(false);
    expect(getProviderSettings).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();

    const loadedPreview = loadRepositoryEnvironment({
      processEnvironment: applicationPreviewTestEnvironment(),
      startDirectory: repositoryRoot,
    });
    const previewEnvironment = loadedPreview.environment;
    await expect(
      isDeterministicDemoAiCommandAllowed({
        ai: { persistence: { getProviderSettings }, registry: { active } },
        environment: previewEnvironment,
      }),
    ).resolves.toBe(true);
    expect(getProviderSettings).toHaveBeenCalledOnce();
    expect(active).toHaveBeenCalledOnce();

    const previewProvider = { key: "synthetic-preview-demo-provider" };
    const activatePreviewProvider = vi.fn((key) => {
      if (key !== "demo") throw new Error("live provider activation attempted");
      return previewProvider;
    });
    const createOpenAiProvider = vi.fn(() => {
      throw new Error("live provider construction attempted");
    });
    const describeOpenAiApiKey = vi.fn(() => loadedPreview.secrets.describeOpenAiApiKey());
    const previewRuntime = {
      ai: {
        createOpenAiProvider,
        persistence: { getProviderSettings: vi.fn(async () => ({ mode: "demo" })) },
        registry: { activate: activatePreviewProvider },
        secrets: { describeOpenAiApiKey },
      },
      environment: previewEnvironment,
    };
    await expect(resolveAiCommandProvider(previewRuntime)).resolves.toBe(previewProvider);
    expect(activatePreviewProvider).toHaveBeenCalledExactlyOnceWith("demo");
    expect(describeOpenAiApiKey).not.toHaveBeenCalled();
    expect(createOpenAiProvider).not.toHaveBeenCalled();

    previewRuntime.ai.persistence.getProviderSettings.mockResolvedValueOnce({ mode: "openai" });
    await expect(resolveAiCommandProvider(previewRuntime)).rejects.toMatchObject({
      code: "OPENAI_NOT_ACTIVE",
    });
    expect(describeOpenAiApiKey).toHaveBeenCalledOnce();
    expect(createOpenAiProvider).not.toHaveBeenCalled();
    expect(activatePreviewProvider).toHaveBeenCalledOnce();

    await expect(
      activateOpenAiProvider({
        actorUserId: "preview-owner",
        correlationId: "preview-empty-secret",
        runtime: previewRuntime,
      }),
    ).rejects.toMatchObject({ code: "OPENAI_KEY_NOT_CONFIGURED" });
    expect(createOpenAiProvider).not.toHaveBeenCalled();
  });

  it("19. rejects Preview authority downgrade and every supplied live credential", () => {
    const exact = applicationPreviewTestEnvironment();
    for (const override of [
      { BEA_PREVIEW_AUTHORITY: "wrong-launcher" },
      { DATABASE_URL: "postgresql://production.invalid/bea" },
      { OPENAI_API_KEY: "synthetic-nonempty-key" },
      { BEA_PRODUCTION_SECRET_PATH: "C:\\production\\secrets.dpapi" },
      { APP_BASE_URL: "http://0.0.0.0:3100" },
      { APP_BASE_URL: "http://localhost:3100" },
      { APP_BASE_URL: "http://[::]:3100" },
      { APP_BASE_URL: "http://[::1]:3100" },
    ]) {
      expect(() =>
        loadRepositoryEnvironment({
          processEnvironment: { ...exact, ...override },
          startDirectory: repositoryRoot,
        }),
      ).toThrow(/Preview requires the exact|BEA_PREVIEW_MODE/iu);
    }
  });

  it("20. makes supervisor startup require the exact Preview environment and canonical child Node", () => {
    const exact = exactPreviewEnvironment({
      BEA_PREVIEW_CONTROL_TOKEN: "c".repeat(64),
      BEA_PREVIEW_INSTANCE_ID: "d".repeat(32),
      BEA_PREVIEW_WEB_LOG: join(previewPaths.logDirectory, "fixture-web.log"),
      BEA_PREVIEW_WORKER_LOG: join(previewPaths.logDirectory, "fixture-worker.log"),
    });
    expect(validatePreviewSupervisorEnvironment(exact).issues).toEqual([]);
    expect(
      validatePreviewSupervisorEnvironment({ ...exact, WORKER_QUEUE_ADAPTER: "pg-boss" }).issues,
    ).toContain("WORKER_QUEUE_ADAPTER does not match the exact Preview contract.");
    expect(
      validatePreviewSupervisorEnvironment({ ...exact, BEA_PREVIEW_NETWORK_GUARD: "off" }).issues,
    ).toContain("BEA_PREVIEW_NETWORK_GUARD does not match the exact Preview contract.");
    const supervisor = source("scripts/preview-supervisor.mjs");
    expect(supervisor).toContain("toolchain.nodeExecutable");
    expect(supervisor).toContain('join(repositoryRoot, "scripts", "next-no-env.mjs")');
    expect(supervisor).toContain('join(repositoryRoot, "scripts", "preview-network-guard.cjs")');
    expect(supervisor).not.toContain('resolve("next/package.json")');
    expect(supervisor).toContain(
      "pathsEqual(workerIdentity.executablePath, toolchain.nodeExecutable)",
    );
    expect(supervisor.indexOf("workerChild = pendingChildRecord(")).toBeLessThan(
      supervisor.indexOf("await observeChildIdentity(workerProcess"),
    );
    expect(supervisor.indexOf("webChild = pendingChildRecord(")).toBeLessThan(
      supervisor.indexOf("await observeChildIdentity(webProcess"),
    );
    expect(supervisor.lastIndexOf("await startChildren(toolchain, dependencies)")).toBeLessThan(
      supervisor.lastIndexOf("await listenForControl(dependencies)"),
    );
    expect(supervisor).toMatch(/if \(startupPromise\)[\s\S]*await startupPromise/iu);
    expect(supervisor).not.toMatch(/taskkill|Stop-Process|Get-Process|wmic|kill\s+\//iu);

    const guardPath = join(repositoryRoot, "scripts", "preview-network-guard.cjs");
    const guardProbe = String.raw`
const guard = require(process.env.BEA_TEST_GUARD_PATH);
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
function expectBlocked(operation) {
  try {
    const socket = operation();
    socket?.destroy?.();
    process.exit(41);
  } catch (error) {
    if (error?.code !== "BEA_PREVIEW_NON_LOOPBACK_NETWORK_BLOCKED") throw error;
  }
}
if (!guard.installed) process.exit(42);
if (!guard.isLoopbackHost("127.0.0.1") || !guard.isLoopbackHost("::1") || !guard.isLoopbackHost("localhost")) process.exit(43);
const server = http.createServer((_request, response) => response.end("loopback-ok"));
server.listen(0, "127.0.0.1", async () => {
  try {
    const address = server.address();
    if (!address || typeof address === "string") process.exit(44);
    const response = await fetch("http://127.0.0.1:" + address.port + "/health");
    if (!response.ok || (await response.text()) !== "loopback-ok") process.exit(45);
    expectBlocked(() => net.connect({ host: "203.0.113.10", port: 443 }));
    expectBlocked(() => new net.Socket().connect({ host: "198.51.100.20", port: 443 }));
    expectBlocked(() => tls.connect({ host: "api.openai.com", port: 443 }));
    process.stdout.write("BEA_PREVIEW_NETWORK_GUARD=PASS");
  } finally {
    server.close();
  }
});
`;
    const guardResult = spawnSync(
      toolchain.nodeExecutable,
      ["--require", guardPath, "-e", guardProbe],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: exactPreviewEnvironment({ BEA_TEST_GUARD_PATH: guardPath }),
        shell: false,
        windowsHide: true,
      },
    );
    expect(guardResult.status, guardResult.stderr).toBe(0);
    expect(guardResult.stdout).toBe("BEA_PREVIEW_NETWORK_GUARD=PASS");
  });

  it("21. reports running only after exact OS identity and authenticated status both match", async () => {
    const metadata = validMetadata({ state: "ready" });
    const status = { ...createAuthenticatedStatus(metadata), state: "ready" };
    expect(authenticatedStatusMatches(metadata, status)).toBe(true);
    const running = await inspectTrackedPreview({
      controlRequest: async () => ({ body: status, ok: true, status: 200 }),
      inspectProcessIdentity: async () => metadata.supervisorOsIdentity,
      processIsAlive: () => true,
      readMetadata: () => ({ exists: true, issues: [], metadata }),
    });
    expect(running).toMatchObject({ state: "running" });
    const control = vi.fn();
    const unreachable = await inspectTrackedPreview({
      controlRequest: control,
      inspectProcessIdentity: async () => ({
        ...metadata.supervisorOsIdentity,
        commandLineFingerprint: "f".repeat(64),
      }),
      processIsAlive: () => true,
      readMetadata: () => ({ exists: true, issues: [], metadata }),
    });
    expect(unreachable.state).toBe("unreachable");
    expect(control).not.toHaveBeenCalled();
    const supervisor = source("scripts/preview-supervisor.mjs");
    const readiness = supervisor.slice(
      supervisor.indexOf("async function waitForReady"),
      supervisor.indexOf("async function waitForLaunchMetadata"),
    );
    expect(readiness).toContain("await Promise.all");
    expect(readiness).toContain("isolatedWorkerHealthUrl");
    expect(readiness).toContain("webHealthUrl");
    expect(readiness).toContain("isolatedSignInUrl");
    expect(supervisor).toContain(
      "isolated ? ownerEvaluationWorkerHealthUrl : previewWorkerHealthUrl",
    );
    expect(supervisor).toContain("isolated ? ownerEvaluationSignInUrl : previewSignInUrl");
    expect(supervisor.indexOf("await waitForReady(dependencies)")).toBeLessThan(
      supervisor.lastIndexOf('updateMetadata({ state: "ready" }'),
    );
  });

  it("22. authenticates exact shutdown, verifies release, and refuses mismatched child identity", async () => {
    const metadata = validMetadata({ state: "ready" });
    const response = {
      body: {
        code: "BEA_PREVIEW_STOP_ACCEPTED",
        ...createAuthenticatedStatus(metadata),
      },
      ok: true,
      status: 202,
    };
    expect(authenticatedStopAccepted(metadata, response)).toBe(true);
    const control = vi.fn(async () => response);
    const inspectPorts = vi.fn(async () => allPortsAvailable());
    await expect(
      stopPreview(
        {},
        {
          assertBoundary: vi.fn(),
          assertPaths: vi.fn(),
          controlRequest: control,
          inspectPorts,
          inspectTracked: async () => ({ metadata, state: "running", status: response.body }),
          platform: "win32",
          processIsAlive: () => false,
          readMetadata: () => ({ exists: false, issues: [] }),
          requireToolchain: () => toolchain,
          waitFor: async (predicate) => predicate(),
          writeOutput: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ outcome: "PASS" });
    expect(control).toHaveBeenCalledWith(metadata, "/stop", {
      method: "POST",
      timeoutMilliseconds: 5_000,
    });
    expect(inspectPorts).toHaveBeenCalledOnce();

    const matchingKill = vi.fn();
    const matchingChild = {
      name: "web",
      osIdentity: osIdentity(6_001),
      process: { exitCode: null, kill: matchingKill, signalCode: null },
    };
    await expect(
      terminateExactPreviewChild(matchingChild, {
        inspectProcessIdentity: async () => matchingChild.osIdentity,
        waitForChildExit: async () => true,
      }),
    ).resolves.toBeUndefined();
    expect(matchingKill).toHaveBeenCalledExactlyOnceWith("SIGTERM");

    const mismatches = [
      osIdentity(6_001, { executablePath: "C:\\untrusted\\node.exe" }),
      osIdentity(6_001, { commandLineFingerprint: "e".repeat(64) }),
      osIdentity(6_002),
      osIdentity(6_001, { osStartedAt: "2026-08-25T12:01:00.000Z" }),
    ];
    for (const mismatch of mismatches) {
      const refusedKill = vi.fn();
      const trackedChild = {
        name: "web",
        osIdentity: osIdentity(6_001),
        process: { exitCode: null, kill: refusedKill, signalCode: null },
      };
      await expect(
        terminateExactPreviewChild(trackedChild, {
          inspectProcessIdentity: async () => mismatch,
        }),
      ).rejects.toThrow(/identity no longer matches/iu);
      expect(refusedKill).not.toHaveBeenCalled();
    }

    const unverifiedPendingKill = vi.fn();
    await expect(
      terminateExactPreviewChild(
        {
          arguments: [],
          cwd: repositoryRoot,
          executable: toolchain.nodeExecutable,
          launchFingerprint: "0".repeat(64),
          name: "pending-web",
          pid: 7_101,
          process: {
            exitCode: null,
            kill: unverifiedPendingKill,
            pid: 7_101,
            signalCode: null,
          },
        },
        { inspectProcessIdentity: vi.fn() },
      ),
    ).rejects.toThrow(/no exact captured or pending ownership/iu);
    expect(unverifiedPendingKill).not.toHaveBeenCalled();

    const identityFailureKill = vi.fn();
    const recapturedIdentity = osIdentity(7_102);
    let identityAttempts = 0;
    const identityFailure = createStartFixture({
      dependencies: {
        inspectProcessIdentity: async () => {
          identityAttempts += 1;
          if (identityAttempts === 1) {
            throw new Error("synthetic supervisor identity capture failure");
          }
          return recapturedIdentity;
        },
        spawnSupervisor: () => ({
          exitCode: null,
          kill: identityFailureKill,
          pid: 7_102,
          signalCode: null,
          unref: vi.fn(),
        }),
        waitForSpawnedChildExit: async () => true,
      },
    });
    await expect(startPreview({ noOpen: true }, identityFailure.dependencies)).rejects.toThrow(
      /identity capture failure/iu,
    );
    expect(identityFailureKill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(identityFailure.events.filter((event) => event === "ports")).toHaveLength(2);
    expect(identityFailure.events).toContain("unlock");

    const refusedSupervisorKill = vi.fn();
    const unavailableIdentity = createStartFixture({
      dependencies: {
        inspectProcessIdentity: async () => {
          throw new Error("synthetic process inspection unavailable");
        },
        spawnSupervisor: () => ({
          exitCode: null,
          kill: refusedSupervisorKill,
          pid: 7_103,
          signalCode: null,
          unref: vi.fn(),
        }),
        waitForSpawnedChildExit: async () => true,
      },
    });
    await expect(startPreview({ noOpen: true }, unavailableIdentity.dependencies)).rejects.toThrow(
      /Exact cleanup was refused.*no kill was sent/iu,
    );
    expect(refusedSupervisorKill).not.toHaveBeenCalled();
    expect(unavailableIdentity.events.filter((event) => event === "ports")).toHaveLength(1);
    expect(unavailableIdentity.events).toContain("unlock");

    const startSource = source("scripts/preview-start.mjs");
    const failedCleanup = startSource.slice(
      startSource.indexOf("async function stopFailedLaunch"),
      startSource.indexOf("async function waitForSupervisorReady"),
    );
    expect(failedCleanup.indexOf("await verifyPortsAvailable(dependencies)")).toBeLessThan(
      failedCleanup.indexOf("dependencies.removeMetadata"),
    );
    const pendingSupervisorCleanup = startSource.slice(
      startSource.indexOf("export async function terminateExactSpawnedPreviewSupervisor"),
      startSource.indexOf("async function waitForOsIdentity"),
    );
    expect(pendingSupervisorCleanup.indexOf("captured = await inspect(tracked.pid)")).toBeLessThan(
      pendingSupervisorCleanup.indexOf('tracked.process.kill("SIGTERM")'),
    );
    const supervisorSource = source("scripts/preview-supervisor.mjs");
    const pendingChildCleanup = supervisorSource.slice(
      supervisorSource.indexOf("export async function terminateExactPreviewChild"),
      supervisorSource.indexOf("function pendingChildRecord"),
    );
    expect(pendingChildCleanup.indexOf("launchFingerprint(")).toBeLessThan(
      pendingChildCleanup.indexOf('tracked.process.kill("SIGTERM")'),
    );
    expect(
      pendingChildCleanup.indexOf("expectedIdentity = await inspect(tracked.pid)"),
    ).toBeLessThan(pendingChildCleanup.indexOf('tracked.process.kill("SIGTERM")'));
    await expect(
      Promise.resolve(processIdentityMatches(matchingChild.osIdentity, matchingChild.osIdentity)),
    ).resolves.toBe(true);
  });
});
