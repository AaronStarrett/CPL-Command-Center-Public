import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  browserMediaTestModeForEnvironment,
  permissionsPolicyForEnvironment,
} from "../../apps/web/next.config.ts";

import {
  EXPECTED_PHASE1_2_PLAYWRIGHT_TEST_COUNT,
  EXPECTED_PHASE1_2_WEBRTC_TEST_COUNT,
  PHASE1_2_GATE_DEFINITIONS,
  PHASE1_2_NORMAL_PERMISSIONS_POLICY,
  PHASE1_2_STARTING_COMMIT,
  PHASE1_2_VERIFIED_NODE_VERSION,
  PHASE1_2_VERIFIED_PNPM_VERSION,
  PHASE1_2_WEBRTC_EVIDENCE_TITLE,
  PHASE1_2_WEBRTC_PERMISSIONS_POLICY,
  assertNoFocusedTestArguments,
  assertBuiltPermissionsPolicy,
  assertPhase1_2StartingState,
  assertPhase1_2ToolchainVersions,
  createAuthoritativeEnvironment,
  createBrowserMediaTestEnvironment,
  createDeterministicWebRtcWaveFixture,
  finalizeBrowserMediaTestEnvironment,
  findForbiddenPhase1_2StagedPaths,
  outputHasExactTestEvidence,
  outputHasExactTestTitle,
  readBuiltPermissionsPolicy,
  removeDeterministicWebRtcWaveFixture,
} from "../../scripts/verify-phase1-2.mjs";

describe("Phase 1.2 authoritative verifier contract", () => {
  it("preserves the original 49 gates and adds explicit addendum gates with fixed full-Chromium discovery", () => {
    expect(PHASE1_2_GATE_DEFINITIONS).toHaveLength(69);
    expect(PHASE1_2_GATE_DEFINITIONS.map(([number]) => number)).toEqual(
      Array.from({ length: 69 }, (_, index) => index + 1),
    );
    expect(PHASE1_2_GATE_DEFINITIONS.slice(0, 49).at(-1)).toEqual([49, "Git status"]);
    expect(EXPECTED_PHASE1_2_PLAYWRIGHT_TEST_COUNT).toBe(32);
    expect(EXPECTED_PHASE1_2_WEBRTC_TEST_COUNT).toBe(1);
    expect(PHASE1_2_WEBRTC_EVIDENCE_TITLE).toBe(
      "@webrtc executes deterministic browser microphone and WebRTC lifecycle with complete cleanup",
    );
    const verifier = readFileSync(
      path.join(process.cwd(), "scripts", "verify-phase1-2.mjs"),
      "utf8",
    );
    expect(verifier).toContain('["test:unit", "--reporter=verbose"]');
    expect(verifier).toContain('["test:component", "--reporter=verbose"]');
    expect(verifier).toContain('["test:integration", "--reporter=verbose"]');
    expect(verifier).not.toContain('"--", "--reporter=verbose"');
  });

  it("keeps optional live provider validation separately acknowledged and non-authoritative", () => {
    expect(PHASE1_2_GATE_DEFINITIONS.at(-1)).toEqual([
      69,
      "Optional live profile readiness (execution deferred)",
    ]);
    const verifier = readFileSync(
      path.join(process.cwd(), "scripts", "verify-phase1-2.mjs"),
      "utf8",
    );
    expect(verifier).toMatch(/deferredEvidenceGate\(\s*69,/u);
    expect(verifier).toContain('record(number, "DEFERRED", null, detail)');
    expect(verifier).not.toMatch(/(?:^|[^A-Za-z])evidenceGate\(\s*69,/u);
  });

  it("fails closed unless the exact verified Node and pnpm toolchain is active", () => {
    expect(PHASE1_2_VERIFIED_NODE_VERSION).toBe("24.19.0");
    expect(PHASE1_2_VERIFIED_PNPM_VERSION).toBe("11.19.0");
    expect(() => assertPhase1_2ToolchainVersions("24.19.0", "11.19.0")).not.toThrow();
    expect(() => assertPhase1_2ToolchainVersions("20.12.2", "11.19.0")).toThrow(
      /requires exact Node 24\.19\.0/u,
    );
    expect(() => assertPhase1_2ToolchainVersions("24.19.0", "11.18.0")).toThrow(
      /requires exact pnpm 11\.19\.0/u,
    );
  });

  it("requires the untouched Phase 1.1 HEAD on main before the one Phase 1.2 commit", () => {
    expect(() => assertPhase1_2StartingState(PHASE1_2_STARTING_COMMIT, "main")).not.toThrow();
    expect(() => assertPhase1_2StartingState("f".repeat(40), "main")).toThrow(
      /requires HEAD 4b6a9cb884f7eb32c82b231d46a3a550f87cc83a/u,
    );
    expect(() => assertPhase1_2StartingState(PHASE1_2_STARTING_COMMIT, "feature/interim")).toThrow(
      /requires branch main/u,
    );
  });

  it("rejects forced staged runtime build report secret database and audio artifacts", () => {
    expect(
      findForbiddenPhase1_2StagedPaths([
        ".data/upload.bin",
        "apps/web/.next/BUILD_ID",
        "packages/ai/dist/index.js",
        "playwright-report/index.html",
        "reports/phase1-2.json",
        ".env.local",
        "fixtures/demo.sqlite",
        "fixtures/realtime.wav",
        "docs/PHASE1_2_HANDOFF.md",
        ".env.example",
      ]),
    ).toEqual([
      ".data/upload.bin",
      "apps/web/.next/BUILD_ID",
      "packages/ai/dist/index.js",
      "playwright-report/index.html",
      "reports/phase1-2.json",
      ".env.local",
      "fixtures/demo.sqlite",
      "fixtures/realtime.wav",
    ]);
  });

  it("requires dedicated exact browser WebRTC lifecycle evidence for Gate 30", () => {
    const verifier = readFileSync(
      path.join(process.cwd(), "scripts", "verify-phase1-2.mjs"),
      "utf8",
    );
    expect(verifier).toContain("runWebRtcBrowserVerification((output) => {");
    expect(verifier).toContain("outputHasExactTestEvidence(");
    expect(verifier).not.toContain(
      "Browser getUserMedia/RTCPeerConnection lifecycle is intentionally absent",
    );
    const packageManifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );
    expect(packageManifest.scripts["verify:webrtc-browser"]).toBe(
      "node scripts/verify-phase1-2.mjs --webrtc-browser",
    );
  });

  it("forces hostile ambient browser-media variables off outside the dedicated constructor", () => {
    const hostile = {
      APP_MODE: "production",
      BEA_BROWSER_MEDIA_TEST_AUTHORITY: "phase1-2-gate30",
      BEA_BROWSER_MEDIA_TEST_MODE: "true",
      BEA_BROWSER_MEDIA_TEST_WAV_SHA256: "f".repeat(64),
      BEA_BROWSER_MEDIA_TEST_WAV_PATH: "C:\\untrusted\\capture.wav",
      BEA_DISABLE_ENV_FILE: "false",
      OPENAI_API_KEY: "must-not-propagate",
    };
    const normal = createAuthoritativeEnvironment(hostile);
    expect(normal).toMatchObject({
      APP_MODE: "demo",
      BEA_BROWSER_MEDIA_TEST_AUTHORITY: "",
      BEA_BROWSER_MEDIA_TEST_MODE: "false",
      BEA_BROWSER_MEDIA_TEST_WAV_SHA256: "",
      BEA_BROWSER_MEDIA_TEST_WAV_PATH: "",
      BEA_DISABLE_ENV_FILE: "true",
      OPENAI_API_KEY: "",
    });
    const fixturePath = path.join(tmpdir(), "dedicated-gate30.wav");
    const dedicated = createBrowserMediaTestEnvironment(hostile, fixturePath, "a".repeat(64));
    expect(dedicated).toMatchObject({
      APP_MODE: "demo",
      BEA_BROWSER_MEDIA_TEST_AUTHORITY: "phase1-2-gate30",
      BEA_BROWSER_MEDIA_TEST_MODE: "true",
      BEA_BROWSER_MEDIA_TEST_WAV_SHA256: "a".repeat(64),
      BEA_BROWSER_MEDIA_TEST_WAV_PATH: fixturePath,
      BEA_DISABLE_ENV_FILE: "true",
      OPENAI_API_KEY: "",
    });
  });

  it("creates and removes the deterministic ephemeral Gate 30 WAV fixture", () => {
    const fixture = createDeterministicWebRtcWaveFixture();
    try {
      const bytes = readFileSync(fixture.fixturePath);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(fixture).toMatchObject({
        bitsPerSample: 16,
        channelCount: 1,
        durationSeconds: 12,
        sampleRate: 48_000,
      });
      expect(fixture.sha256).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      removeDeterministicWebRtcWaveFixture(fixture);
    }
    expect(existsSync(fixture.directory)).toBe(false);
  });

  it("binds the dedicated web build and restored build to exact generated header policies", () => {
    const verifier = readFileSync(
      path.join(process.cwd(), "scripts", "verify-phase1-2.mjs"),
      "utf8",
    );
    expect(verifier).toContain('spawnAuthoritative(pnpm, ["--filter", "@bea/web", "build"]');
    expect(verifier).toContain("assertBuiltPermissionsPolicy(PHASE1_2_WEBRTC_PERMISSIONS_POLICY)");
    expect(verifier).toContain("assertBuiltPermissionsPolicy(PHASE1_2_NORMAL_PERMISSIONS_POLICY)");
    expect(verifier).toContain('"--trace=off"');

    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "bea-gate30-manifest-"));
    const manifestPath = path.join(temporaryDirectory, "routes-manifest.json");
    try {
      const writeManifest = (policy) =>
        writeFileSync(
          manifestPath,
          JSON.stringify({
            headers: [{ headers: [{ key: "Permissions-Policy", value: policy }] }],
          }),
          "utf8",
        );
      writeManifest(PHASE1_2_WEBRTC_PERMISSIONS_POLICY);
      expect(readBuiltPermissionsPolicy(manifestPath)).toBe(PHASE1_2_WEBRTC_PERMISSIONS_POLICY);
      expect(() =>
        assertBuiltPermissionsPolicy(PHASE1_2_WEBRTC_PERMISSIONS_POLICY, manifestPath),
      ).not.toThrow();
      expect(() =>
        assertBuiltPermissionsPolicy(PHASE1_2_NORMAL_PERMISSIONS_POLICY, manifestPath),
      ).toThrow(/built Permissions-Policy mismatch/u);

      writeManifest(PHASE1_2_NORMAL_PERMISSIONS_POLICY);
      expect(() =>
        assertBuiltPermissionsPolicy(PHASE1_2_NORMAL_PERMISSIONS_POLICY, manifestPath),
      ).not.toThrow();
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("keeps native capture diagnostics sanitized and probe cleanup observational", () => {
    const browserTest = readFileSync(
      path.join(process.cwd(), "tests", "e2e", "command-center.spec.ts"),
      "utf8",
    );
    expect(browserTest).toContain("GATE30_SAFE_NATIVE_START_FAILURE=");
    expect(browserTest).toContain("GATE30_SAFE_NATIVE_PROBE_FAILURE=");
    expect(browserTest).toContain("adapterErrorCode: adapter?.errorCode");
    expect(browserTest).toContain("getUserMediaSuccesses: native.getUserMediaSuccesses");
    expect(browserTest).toContain("getUserMediaFailures: native.getUserMediaFailures");
    expect(browserTest).toContain(
      "lastGetUserMediaFailureName: native.lastGetUserMediaFailureName",
    );
    for (const safeFailureName of [
      "TypeError",
      "Error",
      "InvalidStateError",
      "NotSupportedError",
      "OperationError",
      "UnknownError",
    ]) {
      expect(browserTest).toContain(`case "${safeFailureName}":`);
    }
    expect(browserTest).toContain('return "OtherError"');
    expect(browserTest).toContain(
      "instrumentationFailureCount: native.instrumentationFailureCount",
    );
    expect(browserTest).toContain('session.send("Browser.getBrowserCommandLine")');
    expect(browserTest).toContain("fakeDeviceArgumentPresent");
    expect(browserTest).toContain("fakeAudioArgumentPresent");
    expect(browserTest).toContain("audioInputDeviceCount");
    expect(browserTest).toContain('device.kind === "audioinput"');
    expect(browserTest).toContain("browserMediaRuntime: browserMediaRuntimeEvidence");
    expect(browserTest).toContain("await context.clearPermissions()");
    expect(browserTest).toContain("await context.grantPermissions([], { origin: appOrigin })");
    expect(browserTest).toContain(
      'await context.grantPermissions(["microphone"], { origin: appOrigin })',
    );
    expect(browserTest).toContain("temporarily rejects every");
    expect(browserTest).not.toContain('session.send("Browser.grantPermissions"');
    expect(browserTest).not.toContain('session.send("Browser.setPermission"');
    expect(browserTest).toContain("permissionDeniedBefore.getUserMediaCalls + 1");
    expect(browserTest).toContain("permissionDeniedBefore.getUserMediaFailures + 1");
    expect(browserTest).toContain('["NotAllowedError", "SecurityError"]');
    expect(browserTest).toContain("permissionDeniedNativeFailureName");
    expect(browserTest).not.toContain("JSON.stringify(commandLine)");
    expect(browserTest).not.toContain("console.log(commandLine)");
    expect(browserTest).not.toContain('Object.defineProperty(track, "stop"');
    expect(browserTest).not.toContain("const nativeStop = track.stop.bind(track)");
    expect(browserTest).not.toContain("const nativeClose = peer.close.bind(peer)");
  });

  it("hands pagehide cleanup evidence through bounded single-use same-tab storage", () => {
    const browserTest = readFileSync(
      path.join(process.cwd(), "tests", "e2e", "command-center.spec.ts"),
      "utf8",
    );
    expect(browserTest).toContain("const lifecycleStoragePrefix = `__beaGate30Lifecycle_");
    expect(browserTest).toContain("const lifecycleInboxName = `__beaGate30LifecycleInbox_");
    expect(browserTest).toContain("await page.addInitScript(");
    expect(browserTest).toContain("window.sessionStorage.getItem(key)");
    expect(browserTest).toContain("window.sessionStorage.removeItem(key)");
    expect(browserTest).toContain("Object.defineProperty(window, inboxName");
    expect(browserTest).toContain("enumerable: false");
    expect(browserTest).toContain("window.sessionStorage.removeItem(storageKey)");
    expect(browserTest).toContain("window.sessionStorage.setItem(");
    expect(browserTest).toContain("new TextEncoder().encode(serialized).byteLength");
    expect(browserTest).toContain('Buffer.byteLength(record.raw, "utf8")');
    expect(browserTest).toContain('const gate30LifecycleSchema = "bea-gate30-pagehide-v1"');
    expect(browserTest).toContain("gate30HasExactKeys(value");
    expect(browserTest).toContain('randomBytes(16).toString("hex")');
    expect(browserTest).toContain('randomBytes(18).toString("hex")');
    expect(browserTest).toContain("{ capture: false, once: true }");
    expect(browserTest).toContain("consumeLifecyclePagehideReport");
    expect(browserTest).toContain("Reflect.deleteProperty(inboxWindow, inboxName)");
    expect(browserTest).toContain("lifecycleConsumedStorageKeys.has(armed.storageKey)");
    expect(browserTest).toContain('armLifecyclePagehideReport("navigation-cleanup")');
    expect(browserTest).toContain("navigationCleanupWinner");
    expect(browserTest).toContain("expect(lifecycleReportsById.size).toBe(4)");
    expect(browserTest).not.toContain('expectGlobalCleanup("component-unmount")');
    expect(browserTest).toContain("lifecycleHarnessResidue");
    expect(browserTest).toContain("storageLocationCount: 0");
    expect(browserTest).not.toContain("lifecycleBindingSession");
    expect(browserTest).not.toContain('Runtime.addBinding"');
    expect(browserTest).not.toContain('Runtime.bindingCalled"');
    expect(browserTest).not.toContain('page.exposeBinding("__beaGate30ReportPagehide"');
    expect(browserTest).not.toContain("__beaGate30ReportPagehide");

    const connectingReady = browserTest.indexOf(
      "(await nativeSnapshot()).createdPeerCount).toBeGreaterThan(1)",
    );
    const connectingArm = browserTest.indexOf('armLifecyclePagehideReport("connecting-refresh")');
    expect(connectingReady).toBeGreaterThan(-1);
    expect(connectingArm).toBeGreaterThan(connectingReady);
  });

  it("always restores the fail-closed build when media fixture cleanup fails", () => {
    const events = [];
    const result = finalizeBrowserMediaTestEnvironment(
      () => {
        events.push("cleanup");
        throw new Error("fixture cleanup failure");
      },
      () => {
        events.push("restore");
        return 0;
      },
    );
    expect(events).toEqual(["cleanup", "restore"]);
    expect(result.cleanupError).toBeInstanceOf(Error);
    expect(result.restoreError).toBeUndefined();
    expect(result.restoreExitCode).toBe(0);
  });

  it("removes an owner key before spawning a Demo-only child", () => {
    const sentinel = "owner-key-must-not-propagate";
    const environment = createAuthoritativeEnvironment({
      APP_MODE: "production",
      BEA_DISABLE_ENV_FILE: "false",
      OpenAi_Api_Key: sentinel,
    });
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({appMode:process.env.APP_MODE,envFileDisabled:process.env.BEA_DISABLE_ENV_FILE,keyConfigured:Boolean(process.env.OPENAI_API_KEY)}))",
      ],
      { encoding: "utf8", env: environment, windowsHide: true },
    );

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      appMode: "demo",
      envFileDisabled: "true",
      keyConfigured: false,
    });
    expect(`${child.stdout}${child.stderr}`).not.toContain(sentinel);
    expect(Object.values(environment)).not.toContain(sentinel);
  });

  it("replaces every ambient NODE_OPTIONS variant and prevents preload execution", () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "bea-phase12-verifier-"));
    const preloadPath = path.join(temporaryDirectory, "hostile-preload.mjs");
    writeFileSync(preloadPath, 'process.env.BEA_HOSTILE_PRELOAD = "executed";\n', "utf8");

    try {
      const hostileImport = `--import=${pathToFileURL(preloadPath).href}`;
      const environment = createAuthoritativeEnvironment({
        NODE_OPTIONS: hostileImport,
        Node_Options: "--no-warnings",
        node_options: "--require=malicious-preload.cjs",
        NODE_NO_WARNINGS: "1",
        node_redirect_warnings: path.join(temporaryDirectory, "warnings.log"),
      });
      const nodeOptionKeys = Object.keys(environment).filter(
        (key) => key.toUpperCase() === "NODE_OPTIONS",
      );
      const child = spawnSync(
        process.execPath,
        ["-e", 'process.stdout.write(process.env.BEA_HOSTILE_PRELOAD ?? "not-executed")'],
        { encoding: "utf8", env: environment, windowsHide: true },
      );

      expect(nodeOptionKeys).toEqual(["NODE_OPTIONS"]);
      expect(environment.NODE_OPTIONS).toBe("--trace-warnings");
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("not-executed");
      expect(child.stderr).toBe("");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("accepts exact titles only from passing reporter lines", () => {
    const title = "publishes the matched-height panel contract";
    expect(
      outputHasExactTestTitle(
        `✓ tests/component/ai-command.test.tsx > AI Command > ${title} 18ms`,
        title,
      ),
    ).toBe(true);
    expect(
      outputHasExactTestTitle(
        `✓  1 [chromium] › tests/e2e/command-center.spec.ts:10:3 › AI Command › ${title} (1.2s)`,
        title,
      ),
    ).toBe(true);
    expect(
      outputHasExactTestTitle(
        `  ok 28 [chromium-desktop] › tests\\e2e\\command-center.spec.ts:1651:1 › ${title} (18.6s)`,
        title,
      ),
    ).toBe(true);
    expect(
      outputHasExactTestTitle(
        `  x 28 [chromium-desktop] › tests\\e2e\\command-center.spec.ts:1651:1 › ${title} (18.6s)`,
        title,
      ),
    ).toBe(false);
    expect(outputHasExactTestTitle(`↓ suite > ${title}`, title)).toBe(false);
    expect(outputHasExactTestTitle(`// it("${title}", () => {})`, title)).toBe(false);
    expect(outputHasExactTestTitle(`✓ suite > prefix ${title}`, title)).toBe(false);
  });

  it("binds authoritative evidence to the expected test file", () => {
    const title = "publishes the matched-height panel contract";
    const expectedFile = "tests/component/ai-command-workspace.test.tsx";
    expect(
      outputHasExactTestEvidence(
        `✓ tests/component/copied-title.test.tsx > AI Command > ${title} 18ms`,
        title,
        expectedFile,
      ),
    ).toBe(false);
    expect(
      outputHasExactTestEvidence(
        `✓ ${expectedFile} > AI Command > ${title} 18ms`,
        title,
        expectedFile,
      ),
    ).toBe(true);

    const e2eTitle = "runs and reopens the Demo research source-board chart and PDF artifact chain";
    const e2eFile = "tests/e2e/command-center.spec.ts";
    expect(
      outputHasExactTestEvidence(
        `✓  1 [chromium] › tests/e2e/copied-title.spec.ts:10:3 › AI Command › ${e2eTitle} (1.2s)`,
        e2eTitle,
        e2eFile,
      ),
    ).toBe(false);
    expect(
      outputHasExactTestEvidence(
        `✓  1 [chromium] › ${e2eFile}:10:3 › AI Command › ${e2eTitle} (1.2s)`,
        e2eTitle,
        e2eFile,
      ),
    ).toBe(true);
    expect(
      outputHasExactTestEvidence(
        `  ok 28 [chromium-desktop] › tests\\e2e\\command-center.spec.ts:1651:1 › ${e2eTitle} (18.6s)`,
        e2eTitle,
        e2eFile,
      ),
    ).toBe(true);
    expect(
      outputHasExactTestEvidence(
        `  ok 1 [chromium-desktop] › tests\\e2e\\command-center.spec.ts:1651:1 › ${e2eTitle} (1.1m)`,
        e2eTitle,
        e2eFile,
      ),
    ).toBe(true);
  });

  it("rejects name filters, grep, and explicit test-file selection", () => {
    expect(() => assertNoFocusedTestArguments(["vitest", "run", "-t", "one test"])).toThrow(
      /Focused authoritative tests are forbidden/u,
    );
    expect(() =>
      assertNoFocusedTestArguments(["vitest", "run", "tests/unit/environment.test.ts"]),
    ).toThrow(/Focused authoritative tests are forbidden/u);
    expect(() => assertNoFocusedTestArguments(["vitest", "run"])).not.toThrow();
  });

  it("invokes Windows command scripts without Node shell mode or warning suppression", () => {
    const verifier = readFileSync(
      path.join(process.cwd(), "scripts", "verify-phase1-2.mjs"),
      "utf8",
    );
    expect(verifier).toContain('["/d", "/s", "/c", command, ...args]');
    expect(verifier).toContain("shell: false");
    expect(verifier).not.toMatch(/shell:\s*isWindows/u);
  });

  it("does not combine NO_COLOR with the noninteractive FORCE_COLOR setting", () => {
    const playwrightConfig = readFileSync(path.join(process.cwd(), "playwright.config.ts"), "utf8");
    expect(playwrightConfig).toContain("browserMediaTestMode: false");
    const dedicatedConfig = readFileSync(
      path.join(process.cwd(), "playwright.webrtc.config.ts"),
      "utf8",
    );
    expect(dedicatedConfig).toContain("browserMediaTestMode: true");
    const sharedConfig = readFileSync(path.join(process.cwd(), "playwright.shared.ts"), "utf8");
    expect(playwrightConfig).not.toContain("--enable-automation");
    expect(playwrightConfig).not.toContain('channel: "chromium"');
    expect(sharedConfig).toMatch(/args:\s*browserMediaTestMode\s*\?\s*\[\s*"--enable-automation"/u);
    expect(sharedConfig).toContain('FORCE_COLOR: "0"');
    expect(sharedConfig).not.toMatch(/NO_COLOR\s*:/u);
    expect(sharedConfig).toContain("grepInvert: productionPresentationTestMode");
    expect(sharedConfig).toContain(": ordinaryExcludedTags,");
    expect(sharedConfig).toContain("@phase20-leads");
    expect(sharedConfig).toContain('"--use-fake-device-for-media-stream"');
    expect(sharedConfig).toContain("`--use-file-for-fake-audio-capture=${browserMediaFixture}`");
    expect(sharedConfig).not.toContain("--use-fake-ui-for-media-stream");
    expect(sharedConfig).toContain(
      'const traceMode = browserMediaTestMode ? "off" : "retain-on-failure"',
    );
    expect(sharedConfig).toMatch(
      /browserMediaTestMode\s*\?\s*\{ channel: "chromium" as const, trace: "off" as const \}\s*:\s*\{\}/u,
    );
    expect(sharedConfig).not.toMatch(/recordHar|video:\s*["']on/u);

    const browserTest = readFileSync(
      path.join(process.cwd(), "tests", "e2e", "command-center.spec.ts"),
      "utf8",
    );
    expect(browserTest).toContain('expect(testInfo.project.use.channel).toBe("chromium")');
    expect(browserTest).toContain("const browserVersion = browser.version()");
    expect(browserTest).toContain("browser: `Chromium ${browserVersion}`");
    expect(browserTest).toContain("browserChannel: testInfo.project.use.channel");
  });

  it("keeps microphone capture denied unless the deterministic browser-media harness is active", () => {
    expect(permissionsPolicyForEnvironment(false)).toBe("camera=(), microphone=(), geolocation=()");
    expect(permissionsPolicyForEnvironment(true)).toBe(
      "camera=(), microphone=(self), geolocation=()",
    );
    expect(
      browserMediaTestModeForEnvironment({
        APP_MODE: "demo",
        BEA_BROWSER_MEDIA_TEST_AUTHORITY: "phase1-2-gate30",
        BEA_BROWSER_MEDIA_TEST_MODE: "true",
        BEA_DISABLE_ENV_FILE: "true",
      }),
    ).toBe(true);
    expect(
      browserMediaTestModeForEnvironment({
        APP_MODE: "production",
        BEA_BROWSER_MEDIA_TEST_AUTHORITY: "phase1-2-gate30",
        BEA_BROWSER_MEDIA_TEST_MODE: "true",
        BEA_DISABLE_ENV_FILE: "true",
      }),
    ).toBe(false);
    expect(
      browserMediaTestModeForEnvironment({
        APP_MODE: "demo",
        BEA_BROWSER_MEDIA_TEST_AUTHORITY: "ambient",
        BEA_BROWSER_MEDIA_TEST_MODE: "true",
        BEA_DISABLE_ENV_FILE: "true",
      }),
    ).toBe(false);
  });
});
