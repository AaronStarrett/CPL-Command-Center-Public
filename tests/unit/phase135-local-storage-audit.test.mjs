import {
  existsSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isContained,
  isPotentialMutatingProcessName,
  isToolchainProvisionerProcess,
  assertSafePathIdentity,
  captureSafePathIdentity,
  ensureSafeTree,
  evaluateBeaRuntimeOwnership,
  measurePathNoFollow,
  ownsExactLock,
  parseMode,
  productionSupervisorFingerprint,
  releaseOwnedLock,
  toolchainOperationLockBlocks,
  TOOLCHAIN_OPERATION_LOCK_NAME,
  verifyRuntimesStopped,
} from "../../scripts/local-storage-audit.mjs";
import {
  EXPECTED_REPOSITORY,
  localAppDataCleanupTargets,
  OPTIONAL_CLEANUP_APPROVALS,
  REPOSITORY_CLEANUP_TARGETS,
} from "../../scripts/phase135/local-storage-policy.mjs";

const testLocalAppData = "C:\\Users\\owner\\AppData\\Local";
const testToolchainRoot = path.win32.join(testLocalAppData, "BEA", "CommandCenter", "toolchain");
const testNode = path.win32.join(testToolchainRoot, "node-v24.19.0-win-x64", "node.exe");
const previewScript = path.win32.join(EXPECTED_REPOSITORY, "scripts", "preview-supervisor.mjs");
const productionScript = path.win32.join(
  EXPECTED_REPOSITORY,
  "scripts",
  "phase134",
  "production-supervisor.mjs",
);
const initialProcessStart = "2026-08-26T12:00:00.000Z";

function processRecord(overrides = {}) {
  return {
    pid: 4_101,
    name: "node.exe",
    executablePath: testNode,
    commandLine: `"${testNode}" "${path.win32.join(EXPECTED_REPOSITORY, "scripts", "verify-phase1-3-5.mjs")}"`,
    osStartedAt: initialProcessStart,
    ...overrides,
  };
}

function previewMetadataFor(process) {
  return {
    exists: true,
    issues: [],
    metadata: {
      repositoryRoot: EXPECTED_REPOSITORY,
      supervisorOsIdentity: {
        pid: process.pid,
        executablePath: process.executablePath,
        commandLineFingerprint: createHash("sha256")
          .update(process.commandLine, "utf8")
          .digest("hex"),
        osStartedAt: process.osStartedAt,
      },
    },
  };
}

function productionMetadataFor(process) {
  return {
    exists: true,
    issues: [],
    metadata: {
      repositoryRoot: EXPECTED_REPOSITORY,
      supervisorPid: process.pid,
      supervisorExecutable: process.executablePath,
      supervisorScript: productionScript,
      supervisorFingerprint: productionSupervisorFingerprint(
        process.executablePath,
        productionScript,
      ),
      startedAt: "2026-08-26T12:00:10.000Z",
      ports: { web: 3_210, workerHealth: 3_211, control: 3_212, https: 3_443, setup: 3_444 },
    },
  };
}

function evaluateRuntime(overrides = {}) {
  return evaluateBeaRuntimeOwnership(
    {
      processes: [],
      listeners: [],
      previewMetadata: { exists: false, issues: [] },
      productionMetadata: { exists: false, issues: [] },
      configuredPorts: [],
      ...overrides,
    },
    { repositoryRoot: EXPECTED_REPOSITORY, toolchainRoot: testToolchainRoot },
  );
}

describe("BEA-owned runtime detection", () => {
  it("1. allows cleanup when no Node processes exist", () => {
    expect(evaluateRuntime()).toMatchObject({ stopped: true, blockers: [] });
  });

  it("2. ignores Adobe Node without BEA ownership evidence", () => {
    const result = evaluateRuntime({
      processes: [
        processRecord({
          executablePath: "C:\\Program Files\\Adobe\\Creative Cloud\\node.exe",
          commandLine: '"C:\\Program Files\\Adobe\\Creative Cloud\\node.exe" adobe-service.js',
        }),
      ],
    });
    expect(result.stopped).toBe(true);
    expect(result.ignoredProcesses).toEqual([
      { category: "UNRELATED_NODE_PROCESSES_IGNORED", count: 1 },
    ]);
  });

  it("3. ignores OpenAI Codex Node without BEA ownership evidence", () => {
    const result = evaluateRuntime({
      processes: [
        processRecord({
          executablePath: "C:\\Program Files\\OpenAI\\Codex\\node.exe",
          commandLine: '"C:\\Program Files\\OpenAI\\Codex\\node.exe" codex-runtime.js',
        }),
      ],
    });
    expect(result.stopped).toBe(true);
    expect(result.ignoredProcesses[0]).toEqual({
      category: "UNRELATED_NODE_PROCESSES_IGNORED",
      count: 1,
    });
  });

  it("4. aggregates multiple unrelated Node processes without exposing them", () => {
    const processes = ["Adobe", "OpenAI Codex", "Microsoft VS Code", "ChatGPT"].map(
      (product, index) =>
        processRecord({
          pid: 4_200 + index,
          executablePath: `C:\\Program Files\\${product}\\node.exe`,
          commandLine: `"C:\\Program Files\\${product}\\node.exe" service.js`,
        }),
    );
    expect(evaluateRuntime({ processes }).ignoredProcesses).toEqual([
      { category: "UNRELATED_NODE_PROCESSES_IGNORED", count: 4 },
    ]);
  });

  it("5. ignores another repository's Next process", () => {
    const otherRepository = "C:\\Other\\Automation-App";
    const result = evaluateRuntime({
      processes: [
        processRecord({
          executablePath: "C:\\Program Files\\nodejs\\node.exe",
          commandLine: `"C:\\Program Files\\nodejs\\node.exe" "${otherRepository}\\node_modules\\next\\dist\\bin\\next" build`,
        }),
      ],
    });
    expect(result.stopped).toBe(true);
    expect(result.ownershipEvidence).toEqual([]);
  });

  it("6. blocks for exact matching Preview metadata and process identity", () => {
    const process = processRecord({ commandLine: `"${testNode}" "${previewScript}"` });
    const result = evaluateRuntime({
      processes: [process],
      previewMetadata: previewMetadataFor(process),
    });
    expect(result.stopped).toBe(false);
    expect(result.ownershipEvidence).toEqual([
      {
        category: "PREVIEW_RUNTIME",
        pid: process.pid,
        ownershipSource: "PREVIEW_METADATA",
        repositoryMatch: true,
        toolchainMatch: true,
        metadataMatch: true,
        startTimeMatch: true,
        portMatch: false,
      },
    ]);
  });

  it("7. blocks for matching production metadata and bounded OS start identity", () => {
    const process = processRecord({ commandLine: `"${testNode}" "${productionScript}"` });
    const result = evaluateRuntime({
      processes: [process],
      productionMetadata: productionMetadataFor(process),
    });
    expect(result.stopped).toBe(false);
    expect(result.ownershipEvidence[0]).toMatchObject({
      category: "PRODUCTION_RUNTIME",
      ownershipSource: "PRODUCTION_METADATA",
      metadataMatch: true,
      startTimeMatch: true,
    });
  });

  it("rejects production metadata when the live launch tuple has extra arguments", () => {
    const expected = processRecord({ commandLine: `"${testNode}" "${productionScript}"` });
    const actual = processRecord({
      commandLine: `"${testNode}" "${productionScript}" --unexpected`,
    });
    const result = evaluateRuntime({
      processes: [actual],
      productionMetadata: productionMetadataFor(expected),
    });
    expect(result.metadata.production).toBe("MISMATCHED_IGNORED");
    expect(result.ownershipEvidence[0]).toMatchObject({
      ownershipSource: "REPOSITORY_COMMAND",
      metadataMatch: false,
    });
  });

  it("rejects production metadata with a mismatched fingerprint or old OS start", () => {
    const process = processRecord({ commandLine: `"${testNode}" "${productionScript}"` });
    const badFingerprint = productionMetadataFor(process);
    badFingerprint.metadata.supervisorFingerprint = "0".repeat(64);
    expect(
      evaluateRuntime({ processes: [process], productionMetadata: badFingerprint }).metadata
        .production,
    ).toBe("MISMATCHED_IGNORED");

    const oldProcess = { ...process, osStartedAt: "2026-08-26T11:50:00.000Z" };
    expect(
      evaluateRuntime({
        processes: [oldProcess],
        productionMetadata: productionMetadataFor(process),
      }).metadata.production,
    ).toBe("MISMATCHED_IGNORED");
  });

  it("8. treats Preview metadata with no matching PID as stale and stopped", () => {
    const process = processRecord({ commandLine: `"${testNode}" "${previewScript}"` });
    const result = evaluateRuntime({ previewMetadata: previewMetadataFor(process) });
    expect(result).toMatchObject({ stopped: true, metadata: { preview: "STALE_IGNORED" } });
  });

  it("9. treats production metadata with no matching PID as stale and stopped", () => {
    const process = processRecord({ commandLine: `"${testNode}" "${productionScript}"` });
    const result = evaluateRuntime({ productionMetadata: productionMetadataFor(process) });
    expect(result).toMatchObject({ stopped: true, metadata: { production: "STALE_IGNORED" } });
  });

  it("10. rejects a reused metadata PID with a different executable", () => {
    const expected = processRecord({ commandLine: `"${testNode}" "${previewScript}"` });
    const reused = processRecord({
      executablePath: "C:\\Program Files\\Adobe\\node.exe",
      commandLine: '"C:\\Program Files\\Adobe\\node.exe" service.js',
    });
    const result = evaluateRuntime({
      processes: [reused],
      previewMetadata: previewMetadataFor(expected),
    });
    expect(result).toMatchObject({
      stopped: true,
      metadata: { preview: "MISMATCHED_IGNORED" },
    });
  });

  it("11. rejects metadata start-time reuse while retaining independent BEA evidence", () => {
    const expected = processRecord({ commandLine: `"${testNode}" "${previewScript}"` });
    const reused = { ...expected, osStartedAt: "2026-08-26T13:00:00.000Z" };
    const result = evaluateRuntime({
      processes: [reused],
      previewMetadata: previewMetadataFor(expected),
    });
    expect(result.metadata.preview).toBe("MISMATCHED_IGNORED");
    expect(result.ownershipEvidence[0]).toMatchObject({
      ownershipSource: "REPOSITORY_COMMAND",
      metadataMatch: false,
      startTimeMatch: false,
    });
  });

  it("12. blocks an expected BEA command containing the canonical repository path", () => {
    const result = evaluateRuntime({ processes: [processRecord()] });
    expect(result.ownershipEvidence[0]).toMatchObject({
      category: "BUILD_OR_VERIFICATION",
      ownershipSource: "REPOSITORY_COMMAND",
      repositoryMatch: true,
    });
  });

  it("13. blocks BEA toolchain execution only with BEA-owned script arguments", () => {
    const relativeCommand = `"${testNode}" scripts\\verify-phase1-3-5.mjs`;
    const result = evaluateRuntime({
      processes: [processRecord({ commandLine: relativeCommand })],
    });
    expect(result.ownershipEvidence[0]).toMatchObject({
      ownershipSource: "BEA_TOOLCHAIN",
      repositoryMatch: false,
      toolchainMatch: true,
    });
    const fixtureRepositoryRoot = path.win32.join(
      "C:\\",
      "Temporary Workspaces",
      "BEA Automation Command Center",
    );
    const fixtureToolchainRoot = path.win32.join(
      "C:\\",
      "Temporary Toolchains",
      "BEA Command Center",
      "toolchain",
    );
    const fixturePaths = {
      repositoryRoot: fixtureRepositoryRoot,
      toolchainRoot: fixtureToolchainRoot,
    };
    expect(
      isToolchainProvisionerProcess(
        {
          name: "powershell.exe",
          executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          commandLine: `powershell.exe -File "${path.win32.join(fixtureRepositoryRoot, "scripts", "phase134", "ensure-toolchain.ps1")}"`,
        },
        fixturePaths,
      ),
    ).toBe(true);
    expect(
      isToolchainProvisionerProcess(
        {
          name: "powershell.exe",
          executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          commandLine: "powershell.exe -File .\\scripts\\phase134\\ensure-toolchain.ps1",
        },
        fixturePaths,
      ),
    ).toBe(false);
    expect(
      isToolchainProvisionerProcess(
        {
          name: "powershell.exe",
          executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          commandLine: `powershell.exe -Command Write-Host -File "${path.win32.join(fixtureRepositoryRoot, "scripts", "phase134", "ensure-toolchain.ps1")}"`,
        },
        fixturePaths,
      ),
    ).toBe(false);

    const corepack = path.win32.join(
      testToolchainRoot,
      "node-v24.19.0-win-x64",
      "node_modules",
      "corepack",
      "dist",
      "corepack.js",
    );
    const packageRun = processRecord({
      commandLine: `"${testNode}" "${corepack}" pnpm --filter @bea/worker build`,
    });
    expect(evaluateRuntime({ processes: [packageRun] }).ownershipEvidence[0]).toMatchObject({
      category: "WORKER_RUNTIME",
      ownershipSource: "BEA_TOOLCHAIN",
    });
  });

  it("14. ignores the BEA toolchain when its arguments are unrelated", () => {
    const result = evaluateRuntime({
      processes: [processRecord({ commandLine: `"${testNode}" C:\\Other\\utility.mjs` })],
    });
    expect(result.stopped).toBe(true);
    expect(result.ownershipEvidence).toEqual([]);
  });

  it("15. reports a configured BEA port owned by a validated BEA process", () => {
    const process = processRecord();
    const result = evaluateRuntime({
      processes: [process],
      listeners: [{ port: 3_102, pid: process.pid }],
    });
    expect(result.stopped).toBe(false);
    expect(result.ownershipEvidence[0].portMatch).toBe(true);
  });

  it("16. ignores a configured BEA port owned by an unrelated process", () => {
    const process = processRecord({
      executablePath: "C:\\Program Files\\Adobe\\node.exe",
      commandLine: '"C:\\Program Files\\Adobe\\node.exe" service.js',
    });
    const result = evaluateRuntime({
      processes: [process],
      listeners: [{ port: 3_100, pid: process.pid }],
    });
    expect(result.stopped).toBe(true);
    expect(result.ignoredPortListeners.count).toBe(1);
  });

  it("17. allows cleanup when no configured BEA ports have listeners", () => {
    expect(evaluateRuntime({ listeners: [] })).toMatchObject({
      stopped: true,
      ignoredPortListeners: { count: 0 },
    });
  });

  it("18. blocks an active BEA Turbo build", () => {
    const wrapperTarget = `${EXPECTED_REPOSITORY}\\node_modules\\.bin\\..\\turbo\\bin\\turbo`;
    const nativeExecutable = path.win32.join(
      EXPECTED_REPOSITORY,
      "node_modules",
      ".pnpm",
      "@turbo+windows-64@2.10.10",
      "node_modules",
      "@turbo",
      "windows-64",
      "bin",
      "turbo.exe",
    );
    const processes = [
      processRecord({ commandLine: `"${testNode}" "${wrapperTarget}" run build` }),
      processRecord({
        name: "turbo.exe",
        executablePath: nativeExecutable,
        commandLine: `"${nativeExecutable}" run build`,
      }),
    ];
    for (const process of processes) {
      expect(evaluateRuntime({ processes: [process] }).ownershipEvidence[0].category).toBe(
        "TURBO_BUILD",
      );
    }
  });

  it("19. blocks an active BEA Next build", () => {
    const next = processRecord({
      commandLine: `"${testNode}" "${path.win32.join(EXPECTED_REPOSITORY, "node_modules", "next", "dist", "bin", "next")}" build`,
    });
    expect(evaluateRuntime({ processes: [next] }).ownershipEvidence[0].category).toBe("NEXT_BUILD");
  });

  it("20. blocks active BEA Vitest and Playwright runs", () => {
    for (const [target, category] of [
      [path.win32.join("node_modules", "vitest", "vitest.mjs"), "VITEST_RUN"],
      [path.win32.join("node_modules", "@playwright", "test", "cli.js"), "PLAYWRIGHT_RUN"],
      [
        path.win32.join(
          "node_modules",
          ".pnpm",
          "@playwright+test@1.62.1",
          "node_modules",
          "@playwright",
          "test",
          "cli.js",
        ),
        "PLAYWRIGHT_RUN",
      ],
    ]) {
      const process = processRecord({
        commandLine: `"${testNode}" "${path.win32.join(EXPECTED_REPOSITORY, target)}"`,
      });
      expect(evaluateRuntime({ processes: [process] }).ownershipEvidence[0].category).toBe(
        category,
      );
    }
  });

  it("blocks the exact BEA Demo supervisor and correlates its control listener", () => {
    const demoScript = path.win32.join(EXPECTED_REPOSITORY, "scripts", "demo-supervisor.mjs");
    const process = processRecord({ commandLine: `"${testNode}" "${demoScript}"` });
    const result = evaluateRuntime({
      processes: [process],
      listeners: [{ port: 3_002, pid: process.pid }],
    });
    expect(result.ownershipEvidence[0]).toMatchObject({
      category: "DEMO_RUNTIME",
      repositoryMatch: true,
      portMatch: true,
    });
  });

  it("blocks repository-owned native esbuild and SWC workers", () => {
    for (const name of ["esbuild.exe", "swc.exe"]) {
      const executablePath = path.win32.join(
        EXPECTED_REPOSITORY,
        "node_modules",
        ".pnpm",
        name.slice(0, -4),
        name,
      );
      const result = evaluateRuntime({
        processes: [
          processRecord({
            name,
            executablePath,
            commandLine: `"${executablePath}" --service`,
          }),
        ],
      });
      expect(result.ownershipEvidence[0].category).toBe("BUILD_OR_VERIFICATION");
    }
  });

  it("recognizes Preview child targets after Node preload options", () => {
    const guard = path.win32.join(EXPECTED_REPOSITORY, "scripts", "preview-network-guard.cjs");
    const worker = path.win32.join(EXPECTED_REPOSITORY, "apps", "worker", "src", "index.ts");
    const web = path.win32.join(EXPECTED_REPOSITORY, "scripts", "next-no-env.mjs");
    const results = [
      processRecord({
        commandLine: `"${testNode}" --require "${guard}" --import=tsx "${worker}" --serve`,
      }),
      processRecord({
        commandLine: `"${testNode}" --require "${guard}" "${web}" dev --webpack`,
      }),
    ].map((process) => evaluateRuntime({ processes: [process] }).ownershipEvidence[0].category);
    expect(results).toEqual(["WORKER_RUNTIME", "NEXT_BUILD"]);
  });

  it("recognizes real package-relative parents plus TSX and TypeScript children", () => {
    const tsx = path.win32.join(EXPECTED_REPOSITORY, "node_modules", "tsx", "dist", "cli.mjs");
    const tsc = path.win32.join(EXPECTED_REPOSITORY, "node_modules", "typescript", "bin", "tsc");
    const processes = [
      processRecord({ commandLine: `"${testNode}" ..\\..\\scripts\\next-no-env.mjs build` }),
      processRecord({
        commandLine: `"${testNode}" ..\\..\\scripts\\run-guarded.mjs tsx src\\index.ts --serve`,
      }),
      processRecord({ commandLine: `"${testNode}" "${tsx}" src\\index.ts --serve` }),
      processRecord({ commandLine: `"${testNode}" "${tsc}" --noEmit` }),
    ];
    expect(
      processes.map(
        (process) => evaluateRuntime({ processes: [process] }).ownershipEvidence[0].category,
      ),
    ).toEqual(["NEXT_BUILD", "BUILD_OR_VERIFICATION", "WORKER_RUNTIME", "BUILD_OR_VERIFICATION"]);
  });

  it("21. reports stopped when Preview metadata is absent and ports are released", () => {
    expect(evaluateRuntime()).toMatchObject({
      stopped: true,
      metadata: { preview: "ABSENT" },
      ignoredPortListeners: { count: 0 },
    });
  });

  it("22. allows cleanup while Codex is open", () => {
    const codex = processRecord({
      executablePath: "C:\\Program Files\\OpenAI\\Codex\\node.exe",
      commandLine: '"C:\\Program Files\\OpenAI\\Codex\\node.exe" codex-runtime.js',
    });
    expect(evaluateRuntime({ processes: [codex] }).stopped).toBe(true);
  });

  it("23. allows cleanup while Adobe is open", () => {
    const adobe = processRecord({
      executablePath: "C:\\Program Files\\Adobe\\node.exe",
      commandLine: '"C:\\Program Files\\Adobe\\node.exe" creative-cloud.js',
    });
    expect(evaluateRuntime({ processes: [adobe] }).stopped).toBe(true);
  });

  it("24. blocks only the one process with positive BEA ownership evidence", () => {
    const unrelated = ["node.exe", "npm.exe", "pnpm.exe", "turbo.exe", "esbuild.exe"].map(
      (name, index) =>
        processRecord({
          pid: 4_300 + index,
          name,
          executablePath: `C:\\Other\\Tools\\${name}`,
          commandLine: `"C:\\Other\\Tools\\${name}" --version`,
        }),
    );
    const owned = processRecord({ pid: 4_399 });
    const result = evaluateRuntime({ processes: [...unrelated, owned] });
    expect(result.ownershipEvidence).toHaveLength(1);
    expect(result.ownershipEvidence[0].pid).toBe(owned.pid);
    expect(isPotentialMutatingProcessName("npm.exe")).toBe(true);

    const falsePositiveNearMisses = [
      processRecord({
        executablePath: "C:\\Other\\node.exe",
        commandLine: `"C:\\Other\\node.exe" C:\\Other\\copy-tool.js --source "${EXPECTED_REPOSITORY}" build`,
      }),
      processRecord({ commandLine: `"${testNode}" scripts\\verify-not-a-bea-script.mjs` }),
      processRecord({
        executablePath: path.win32.join(testToolchainRoot, "other-tool.exe"),
        commandLine: `"${path.win32.join(testToolchainRoot, "other-tool.exe")}" scripts\\verify-phase1-3-5.mjs`,
      }),
      processRecord({
        commandLine: `"${testNode}" "${EXPECTED_REPOSITORY}\\node_modules\\..\\..\\Other\\@playwright\\test\\cli.js"`,
      }),
      processRecord({
        commandLine: `"${testNode}" -e "scripts\\verify-phase1-3-5.mjs"`,
      }),
      processRecord({
        commandLine: `"${testNode}" C:\\Other\\tool.mjs @bea/web`,
      }),
      processRecord({
        commandLine: `"${path.win32.join(testToolchainRoot, "node-v24.19.0-win-x64", "node.exe")}" "${path.win32.join(testToolchainRoot, "node-v24.19.0-win-x64", "node_modules", "corepack", "dist", "corepack.js")}" pnpm @bea/web build`,
      }),
    ];
    for (const process of falsePositiveNearMisses) {
      expect(evaluateRuntime({ processes: [process] }).ownershipEvidence).toEqual([]);
    }
  });

  it("fails closed when process or listener inspection cannot be verified", async () => {
    const unavailable = await verifyRuntimesStopped({
      platform: "win32",
      previewMetadata: { exists: false, issues: [] },
      productionMetadata: { exists: false, issues: [] },
      collectRuntimeSnapshot() {
        throw new Error("synthetic collector failure");
      },
    });
    expect(unavailable).toMatchObject({
      stopped: false,
      inspection: "UNVERIFIED",
      blockers: ["PROCESS_STATE_UNVERIFIED"],
    });

    const incomplete = evaluateRuntime({
      processes: [
        {
          pid: 4_500,
          name: "node.exe",
          executablePath: testNode,
          commandLine: `"${testNode}" "${previewScript}"`,
          osStartedAt: "",
        },
      ],
    });
    expect(incomplete).toMatchObject({ stopped: false, inspection: "UNVERIFIED" });
    expect(incomplete.warnings).toContain("PROCESS_RECORD_IDENTITY_UNVERIFIED");

    const malformedListener = evaluateRuntime({ listeners: [{ port: "3100", pid: "51" }] });
    expect(malformedListener).toMatchObject({ stopped: false, inspection: "UNVERIFIED" });
    expect(malformedListener.warnings).toContain("PORT_LISTENER_IDENTITY_UNVERIFIED");
  });

  it("25. contains no process-termination implementation", () => {
    const cleanupSource = readFileSync(
      new URL("../../scripts/local-storage-audit.mjs", import.meta.url),
      "utf8",
    );
    expect(cleanupSource).not.toMatch(/process\.kill|taskkill|stop-process/iu);
  });

  it("26. never serializes an unrelated command line", () => {
    const sentinel = "DO_NOT_DISCLOSE_UNRELATED_COMMAND_LINE_7f41";
    const result = evaluateRuntime({
      processes: [
        processRecord({
          executablePath: "C:\\Other\\node.exe",
          commandLine: `"C:\\Other\\node.exe" ${sentinel}`,
        }),
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("commandLine");
    expect(serialized).not.toContain("C:\\Other");
  });

  it("27. keeps the reviewed automatic cleanup allowlist unchanged", () => {
    expect(REPOSITORY_CLEANUP_TARGETS).toHaveLength(49);
    const policySource = readFileSync(
      new URL("../../scripts/phase135/local-storage-policy.mjs", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(policySource).digest("hex")).toBe(
      "742a940325d2f257d74d38510ddd4816399d8739609704125442ec58404a5214",
    );
    expect(localAppDataCleanupTargets(testLocalAppData).map((entry) => entry.id)).toEqual([
      "toolchain-node-download",
      "toolchain-node-checksums",
      "toolchain-empty-staging",
    ]);
  });

  it("28. keeps source, history, Preview data, secrets, databases, backups, active toolchain, and unknown files protected", () => {
    const automaticPaths = [
      ...REPOSITORY_CLEANUP_TARGETS.map((entry) => entry.relativePath.replaceAll("\\", "/")),
      ...localAppDataCleanupTargets(testLocalAppData).map((entry) =>
        entry.absolutePath.replaceAll("\\", "/"),
      ),
    ];
    const joined = automaticPaths.join("|").toLowerCase();
    for (const protectedMarker of [
      ".git",
      "node_modules",
      ".data/pglite",
      ".data/bea-preview",
      ".env.local",
      "secrets",
      "certificates",
      ".data/database",
      ".data/postgres",
      ".sqlite",
      "backups",
      "corepack-home",
      ".data/artifacts",
      "apps/web/app",
      "packages/config/src",
    ]) {
      expect(joined).not.toContain(protectedMarker);
    }
    const activeNodeDirectory = path.win32
      .join(testToolchainRoot, "node-v24.19.0-win-x64")
      .replaceAll("\\", "/")
      .toLowerCase();
    expect(automaticPaths).not.toContain(activeNodeDirectory);
    expect(
      automaticPaths.some((candidate) => candidate.startsWith(activeNodeDirectory + "/")),
    ).toBe(false);
  });
});

describe("Phase 1.3.5 local-storage safety", () => {
  it("accepts exactly one explicit mode", () => {
    expect(parseMode(["--dry-run"])).toBe("dry-run");
    expect(parseMode(["--safe"])).toBe("safe");
    expect(() => parseMode([])).toThrow();
    expect(() => parseMode(["--safe", "--dry-run"])).toThrow();
    expect(() => parseMode(["--unknown"])).toThrow();
  });

  it("serializes cleanup and provisioning with one exclusive operation lock", () => {
    expect(TOOLCHAIN_OPERATION_LOCK_NAME).toBe(".bea-toolchain-operation.lock");
    const cleanupSource = readFileSync(
      new URL("../../scripts/local-storage-audit.mjs", import.meta.url),
      "utf8",
    );
    const provisionerSource = readFileSync(
      new URL("../../scripts/phase134/ensure-toolchain.ps1", import.meta.url),
      "utf8",
    );
    expect(cleanupSource).toContain('openSync(toolchainOperationLockPath, "wx")');
    expect(provisionerSource).toContain("[IO.FileMode]::CreateNew");
    expect(provisionerSource).toContain("[IO.FileShare]::None");
    expect(provisionerSource).toContain("[IO.FileOptions]::DeleteOnClose");
    expect(provisionerSource).toContain("$ToolchainOperationLockStream.Dispose()");
  });

  it("rejects path-prefix escapes", () => {
    expect(isContained("C:\\safe\\root", "C:\\safe\\root\\child")).toBe(true);
    expect(isContained("C:\\safe\\root", "C:\\safe\\root-escape")).toBe(false);
    expect(isContained("C:\\safe\\root", "C:\\safe\\other")).toBe(false);
  });

  it("never allowlists protected or unknown data", () => {
    const paths = REPOSITORY_CLEANUP_TARGETS.map((entry) =>
      entry.relativePath.replaceAll("\\", "/"),
    );
    expect(paths).not.toContain(".git");
    expect(paths).not.toContain("node_modules");
    expect(paths).not.toContain(".data/pglite");
    expect(paths).not.toContain(".data/bea-preview");
    expect(paths).not.toContain(".data/artifacts");
    expect(paths.some((entry) => entry.includes("secrets"))).toBe(false);
    expect(paths.some((entry) => entry.includes("certificates"))).toBe(false);
    expect(paths.some((entry) => entry.includes("backups"))).toBe(false);
    expect(paths).not.toContain(".data/final-verification");
    expect(paths).not.toContain(".data/phase1-3-4-verification");
    expect(paths).not.toContain(".data/phase1-3-5-verification");
  });

  it("requires exact future approval phrases for large optional removals", () => {
    expect(OPTIONAL_CLEANUP_APPROVALS.map((entry) => entry.approval)).toEqual([
      "REMOVE BEA NODE_MODULES AT <HEAD>",
      "REMOVE BEA PREVIEW DATA AT <HEAD>",
      "REMOVE BEA VISUALIZATIONS AT <HEAD>",
      "REMOVE BEA TOOLCHAIN AT <HEAD>",
    ]);
  });

  it("keeps personal homes and historical session paths out of exported storage policies", () => {
    for (const source of [
      "../../scripts/repository-boundary.mjs",
      "../../scripts/local-storage-audit.mjs",
      "../../scripts/phase135/local-storage-policy.mjs",
    ]) {
      const text = readFileSync(new URL(source, import.meta.url), "utf8");
      expect(text).not.toMatch(/[a-z]:[\\/]+Users[\\/]+/iu);
      expect(text).not.toMatch(/\.codex[\\/]+visualizations[\\/]+20\d{2}[\\/]/iu);
    }
    expect(OPTIONAL_CLEANUP_APPROVALS.find(({ id }) => id === "visualizations")).toMatchObject({
      relativePath: "%USERPROFILE%/.codex/visualizations/<owner-selected-session>",
      approval: "REMOVE BEA VISUALIZATIONS AT <HEAD>",
    });
    expect(REPOSITORY_CLEANUP_TARGETS.some(({ id }) => id.includes("visualization"))).toBe(false);
  });

  it("measures files without reading their contents", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bea-phase135-audit-"));
    try {
      mkdirSync(path.join(root, "nested"));
      writeFileSync(path.join(root, "nested", "data.bin"), Buffer.alloc(17, 1));
      expect(measurePathNoFollow(root)).toMatchObject({
        exists: true,
        bytes: 17,
        files: 1,
        reparsePoints: 0,
        errors: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a junction that redirects an allowlisted path outside its root", (context) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bea-phase135-root-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "bea-phase135-outside-"));
    const junction = path.join(root, "redirect");
    try {
      writeFileSync(path.join(outside, "sentinel.txt"), "preserve");
      try {
        symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (
          process.platform === "win32" &&
          ["EINVAL", "EPERM", "ENOTSUP", "EOPNOTSUPP", "UNKNOWN", "EISDIR"].includes(error.code)
        ) {
          context.skip(
            "Physical junction evidence NOT RUN: this Windows filesystem does not support junction creation (" +
              error.code +
              "). Pure path-redirection coverage remains enabled.",
          );
          return;
        }
        throw error;
      }
      expect(() => ensureSafeTree(junction, root)).toThrow(/REPARSE_POINT/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("detects path substitution after a safe identity was captured", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bea-phase135-identity-"));
    const candidate = path.join(root, "candidate");
    const moved = path.join(root, "moved");
    try {
      mkdirSync(candidate);
      const identity = captureSafePathIdentity(candidate, root);
      renameSync(candidate, moved);
      mkdirSync(candidate);
      expect(() => assertSafePathIdentity(candidate, root, identity)).toThrow(
        /PATH_IDENTITY_CHANGED/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases only the lock acquired by the current run", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bea-phase135-lock-"));
    const foreignPath = path.join(root, "foreign.lock");
    const ownedPath = path.join(root, "owned.lock");
    try {
      writeFileSync(foreignPath, "foreign");
      expect(toolchainOperationLockBlocks(ownedPath, undefined)).toBe(false);
      expect(releaseOwnedLock(foreignPath, undefined, undefined)).toEqual([]);
      expect(existsSync(foreignPath)).toBe(true);

      const descriptor = openSync(ownedPath, "wx");
      const metadata = fstatSync(descriptor);
      const ownedIdentity = { dev: metadata.dev, ino: metadata.ino };
      expect(toolchainOperationLockBlocks(ownedPath, undefined)).toBe(true);
      expect(ownsExactLock(ownedPath, descriptor, { dev: metadata.dev, ino: metadata.ino })).toBe(
        true,
      );
      expect(
        toolchainOperationLockBlocks(ownedPath, {
          descriptor,
          identity: ownedIdentity,
        }),
      ).toBe(false);
      expect(
        toolchainOperationLockBlocks(path.join(root, "missing.lock"), {
          descriptor,
          identity: ownedIdentity,
        }),
      ).toBe(true);
      expect(ownsExactLock(foreignPath, descriptor, { dev: metadata.dev, ino: metadata.ino })).toBe(
        false,
      );
      expect(releaseOwnedLock(ownedPath, descriptor, ownedIdentity)).toEqual([]);
      expect(existsSync(ownedPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
