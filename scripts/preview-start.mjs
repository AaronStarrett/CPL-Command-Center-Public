import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertPreviewBoundary,
  assertPreviewPathContract,
  checkPortAvailable,
  closeFileDescriptor,
  controlRequest,
  createPreviewLaunchLock,
  createPreviewChildEnvironment,
  createRunLogPaths,
  ensurePreviewDirectories,
  inspectPreviewLaunchLock,
  inspectPreviewPorts,
  inspectProcessIdentity,
  inspectTrackedPreview,
  openAppendOnlyLog,
  openInDefaultBrowser,
  pathsEqual,
  previewHost,
  previewPaths,
  previewPorts,
  previewSignInUrl,
  processIdentityMatches,
  processIsAlive,
  readPreviewLaunchLock,
  recoverStalePreviewLaunchLock,
  relativeLogPaths,
  removeMetadataOwnedBy,
  repositoryRoot,
  requireCanonicalToolchain,
  runCanonicalPnpm,
  supervisorLaunchFingerprint,
  unavailablePreviewPorts,
  validatePreviewMetadata,
  waitFor,
  writeJsonAtomic,
} from "./preview-common.mjs";

export const previewSupervisorScript = join(repositoryRoot, "scripts", "preview-supervisor.mjs");

export function parsePreviewStartArguments(arguments_) {
  const options = { check: false, noOpen: false, seed: false };
  for (const argument of arguments_) {
    if (argument === "--check") options.check = true;
    else if (argument === "--no-open") options.noOpen = true;
    else if (argument === "--seed") options.seed = true;
    else throw new Error("Usage: preview-start.mjs [--check] [--no-open] [--seed]");
  }
  if (options.check && (options.noOpen || options.seed)) {
    throw new Error("--check cannot be combined with --no-open or --seed.");
  }
  return Object.freeze(options);
}

export function decidePreviewStart(tracked, options = {}) {
  if (tracked.state === "stopped") return { action: "start" };
  if (tracked.state === "running") {
    if (tracked.metadata?.state !== tracked.status?.state) {
      return { action: "block-unverifiable" };
    }
    if (tracked.status.state === "ready") {
      return options.seed ? { action: "block-running-seed" } : { action: "already-running" };
    }
    if (tracked.status.state === "starting") {
      return options.seed ? { action: "block-running-seed" } : { action: "wait-for-ready" };
    }
    if (tracked.status.state === "failed") return { action: "block-failed" };
    if (tracked.status.state === "stopping") return { action: "block-stopping" };
    return { action: "block-unverifiable" };
  }
  if (tracked.state === "stale") return { action: "clean-stale" };
  return { action: "block-unverifiable" };
}

export function readPreviewInitialization(options = {}) {
  const path = options.path ?? previewPaths.initializationFile;
  const fileExists = options.exists ?? existsSync;
  if (!fileExists(path)) return { firstStart: true };
  let value;
  try {
    value = JSON.parse((options.readFile ?? readFileSync)(path, "utf8"));
  } catch {
    throw new Error("Preview initialization marker is invalid.");
  }
  if (
    value?.version !== 1 ||
    value.profile !== "preview" ||
    typeof value.repositoryRoot !== "string" ||
    !pathsEqual(value.repositoryRoot, repositoryRoot) ||
    typeof value.initializedAt !== "string" ||
    Number.isNaN(Date.parse(value.initializedAt))
  ) {
    throw new Error("Preview initialization marker does not match this canonical checkout.");
  }
  return { firstStart: false, marker: value };
}

function writeJsonExclusive(path, value, dependencies = {}) {
  let descriptor;
  try {
    descriptor = (dependencies.open ?? openSync)(path, "wx", 0o600);
    (dependencies.write ?? writeFileSync)(
      descriptor,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    (dependencies.fsync ?? fsyncSync)(descriptor);
  } finally {
    if (descriptor !== undefined) (dependencies.close ?? closeSync)(descriptor);
  }
}

export function writePreviewInitialization(existing, seeded, dependencies = {}) {
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const value = {
    initializedAt: existing?.initializedAt ?? now,
    lastSeededAt: seeded ? now : (existing?.lastSeededAt ?? null),
    profile: "preview",
    repositoryRoot,
    version: 1,
  };
  (dependencies.writeInitializationFile ?? writeJsonAtomic)(
    dependencies.path ?? previewPaths.initializationFile,
    value,
    dependencies,
  );
  return value;
}

async function acquireLaunchLock(paths, toolchain, dependencies = {}) {
  const recoveryPath = `${paths.launchLockFile}.recovering`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const inspection = await (dependencies.inspectLaunchLock ?? inspectPreviewLaunchLock)({
      ...dependencies,
      nodeExecutable: toolchain.nodeExecutable,
      path: paths.launchLockFile,
      recoveryPath,
    });
    if (inspection.state === "live") {
      throw new Error("Another exact Preview launcher is already active; no process was touched.");
    }
    if (["ambiguous", "invalid"].includes(inspection.state)) {
      throw new Error(
        "Preview launch-lock ownership is unverifiable; live or ambiguous evidence was preserved.",
      );
    }
    if (inspection.state === "stale") {
      await verifyPortsAvailable(dependencies);
      const recovered = await (dependencies.recoverLaunchLock ?? recoverStalePreviewLaunchLock)(
        inspection,
        {
          ...dependencies,
          nodeExecutable: toolchain.nodeExecutable,
          path: paths.launchLockFile,
          recoveryPath,
        },
      );
      if (!recovered) continue;
      continue;
    }

    const ownerOsIdentity = await (dependencies.inspectProcessIdentity ?? inspectProcessIdentity)(
      process.pid,
    );
    if (
      !ownerOsIdentity ||
      ownerOsIdentity.pid !== process.pid ||
      !pathsEqual(ownerOsIdentity.executablePath, toolchain.nodeExecutable)
    ) {
      throw new Error("Preview launcher OS identity is not exact canonical BEA Node.");
    }
    const token = (dependencies.randomBytes ?? randomBytes)(32).toString("hex");
    const lock = createPreviewLaunchLock(ownerOsIdentity, token, {
      ...dependencies,
      nodeExecutable: toolchain.nodeExecutable,
    });
    try {
      writeJsonExclusive(paths.launchLockFile, lock, dependencies);
      return Object.freeze({ ...lock, path: paths.launchLockFile });
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Preview launch-lock ownership changed repeatedly; no process was touched.");
}

function releaseLaunchLock(lock, dependencies = {}) {
  const current = (dependencies.readLaunchLock ?? readPreviewLaunchLock)({
    ...dependencies,
    nodeExecutable: lock.ownerOsIdentity.executablePath,
    path: lock.path,
  });
  if (
    !current.lock ||
    current.lock.token !== lock.token ||
    !processIdentityMatches(current.lock.ownerOsIdentity, lock.ownerOsIdentity)
  ) {
    throw new Error("Preview launch-lock ownership changed; the lock was preserved.");
  }
  (dependencies.removeFile ?? rmSync)(lock.path);
}

function writeInitialMetadata(metadata, dependencies = {}) {
  const validation = validatePreviewMetadata(metadata, dependencies);
  if (!validation.metadata) throw new Error(validation.issues.join(" "));
  (dependencies.writeInitialMetadata ?? writeJsonExclusive)(
    dependencies.metadataPath ?? previewPaths.metadataFile,
    metadata,
    dependencies,
  );
}

function emit(dependencies, value) {
  (dependencies.writeOutput ?? ((text) => process.stdout.write(text)))(value);
}

async function verifyPortsAvailable(dependencies = {}) {
  const results = await (dependencies.inspectPorts ?? inspectPreviewPorts)({
    checkPort: dependencies.checkPort ?? checkPortAvailable,
  });
  const unavailable = unavailablePreviewPorts(results);
  if (unavailable.length > 0) {
    throw new Error(
      `Preview ports are occupied (${unavailable.join(", ")}); no process was touched.`,
    );
  }
  return results;
}

function runRequiredPnpm(toolchain, arguments_, environment, label, dependencies = {}) {
  emit(dependencies, `==> ${label}\n`);
  const result = (dependencies.runPnpm ?? runCanonicalPnpm)(toolchain.pnpmExecutable, arguments_, {
    environment,
    stdio: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${String(result.exitCode)}.`);
  }
}

function spawnPreviewSupervisor(toolchain, logs, instanceId, controlToken, dependencies = {}) {
  const descriptor = (dependencies.openLog ?? openAppendOnlyLog)(logs.supervisor);
  try {
    return (dependencies.spawn ?? spawn)(toolchain.nodeExecutable, [previewSupervisorScript], {
      cwd: repositoryRoot,
      detached: true,
      env: {
        ...createPreviewChildEnvironment(dependencies.environment ?? process.env),
        BEA_PREVIEW_CONTROL_TOKEN: controlToken,
        BEA_PREVIEW_INSTANCE_ID: instanceId,
        BEA_PREVIEW_WEB_LOG: logs.web,
        BEA_PREVIEW_WORKER_LOG: logs.worker,
      },
      stdio: ["ignore", descriptor, descriptor],
      windowsHide: true,
    });
  } finally {
    (dependencies.closeLog ?? closeFileDescriptor)(descriptor);
  }
}

function waitForSpawnedChildExit(child, timeoutMilliseconds) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMilliseconds);
    child.once("exit", onExit);
  });
}

function pendingSupervisorRecord(supervisor, toolchain) {
  const arguments_ = Object.freeze([previewSupervisorScript]);
  return Object.freeze({
    arguments: arguments_,
    cwd: repositoryRoot,
    executable: toolchain.nodeExecutable,
    launchFingerprint: supervisorLaunchFingerprint({
      nodeExecutable: toolchain.nodeExecutable,
      supervisorScript: previewSupervisorScript,
    }),
    name: "supervisor",
    pid: supervisor.pid,
    process: supervisor,
  });
}

export async function terminateExactSpawnedPreviewSupervisor(tracked, dependencies = {}) {
  if (
    !tracked?.process ||
    !tracked.pid ||
    tracked.process.pid !== tracked.pid ||
    tracked.process.exitCode !== null ||
    tracked.process.signalCode !== null
  ) {
    return;
  }
  const expectedFingerprint = supervisorLaunchFingerprint({
    nodeExecutable: tracked.executable,
    supervisorScript: tracked.arguments?.[0],
  });
  if (
    tracked.cwd !== repositoryRoot ||
    tracked.launchFingerprint !== expectedFingerprint ||
    tracked.arguments?.length !== 1 ||
    !pathsEqual(tracked.arguments[0], previewSupervisorScript)
  ) {
    throw new Error("Pending Preview supervisor launch evidence is invalid; no kill was sent.");
  }
  const inspect = dependencies.inspectProcessIdentity ?? inspectProcessIdentity;
  let captured;
  try {
    captured = await inspect(tracked.pid);
  } catch {
    throw new Error(
      "Pending Preview supervisor OS identity could not be captured; no kill was sent.",
    );
  }
  if (!captured || !pathsEqual(captured.executablePath, tracked.executable)) {
    throw new Error("Pending Preview supervisor executable identity is invalid; no kill was sent.");
  }
  const confirmed = await inspect(tracked.pid);
  if (!confirmed || !processIdentityMatches(captured, confirmed)) {
    throw new Error("Pending Preview supervisor identity changed; no kill was sent.");
  }
  tracked.process.kill("SIGTERM");
  const waitForExit = dependencies.waitForSpawnedChildExit ?? waitForSpawnedChildExit;
  if (await waitForExit(tracked.process, 5_000)) return;
  if (tracked.process.exitCode !== null || tracked.process.signalCode !== null) return;
  const beforeEscalation = await inspect(tracked.pid);
  if (!beforeEscalation || !processIdentityMatches(captured, beforeEscalation)) {
    throw new Error(
      "Pending Preview supervisor identity changed before escalation; no kill was sent.",
    );
  }
  tracked.process.kill("SIGKILL");
  if (!(await waitForExit(tracked.process, 5_000))) {
    throw new Error("The exact spawned Preview supervisor process did not stop.");
  }
}

async function waitForOsIdentity(pid, expectedExecutable, dependencies = {}) {
  return (dependencies.waitFor ?? waitFor)(
    async () => {
      const identity = await (dependencies.inspectProcessIdentity ?? inspectProcessIdentity)(pid);
      if (!identity) return false;
      if (!pathsEqual(identity.executablePath, expectedExecutable)) {
        throw new Error("Spawned Preview supervisor does not use canonical BEA Node.");
      }
      return identity;
    },
    {
      intervalMilliseconds: 100,
      timeoutMessage: "The Preview supervisor OS identity was not observable.",
      timeoutMilliseconds: 5_000,
    },
  );
}

function createLaunchMetadata(
  identity,
  toolchain,
  logs,
  instanceId,
  controlToken,
  dependencies = {},
) {
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  return {
    children: {},
    controlHost: previewHost,
    controlPort: previewPorts.control,
    controlToken,
    instanceId,
    logs: relativeLogPaths(logs),
    ports: previewPorts,
    profile: "preview",
    repositoryRoot,
    startedAt: now,
    state: "starting",
    supervisorExecutable: toolchain.nodeExecutable,
    supervisorLaunchFingerprint: supervisorLaunchFingerprint({
      nodeExecutable: toolchain.nodeExecutable,
      supervisorScript: previewSupervisorScript,
    }),
    supervisorOsIdentity: identity,
    supervisorScript: previewSupervisorScript,
    updatedAt: now,
    version: 1,
  };
}

async function stopFailedLaunch(supervisor, metadata, dependencies = {}) {
  try {
    const tracked = await (dependencies.inspectTracked ?? inspectTrackedPreview)();
    if (tracked.state === "running" && tracked.metadata.instanceId === metadata.instanceId) {
      await (dependencies.controlRequest ?? controlRequest)(tracked.metadata, "/stop", {
        method: "POST",
        timeoutMilliseconds: 3_000,
      });
    } else if ((dependencies.processIsAlive ?? processIsAlive)(supervisor.pid)) {
      const current = await (dependencies.inspectProcessIdentity ?? inspectProcessIdentity)(
        supervisor.pid,
      );
      if (current && processIdentityMatches(metadata.supervisorOsIdentity, current)) {
        supervisor.kill("SIGTERM");
      }
    }
  } catch {
    // The fallback below still requires the exact launch identity before touching the child handle.
  }
  try {
    await (dependencies.waitFor ?? waitFor)(
      () => !(dependencies.processIsAlive ?? processIsAlive)(supervisor.pid),
      { intervalMilliseconds: 200, timeoutMilliseconds: 20_000 },
    );
  } catch {
    const current = await Promise.resolve(
      (dependencies.inspectProcessIdentity ?? inspectProcessIdentity)(supervisor.pid),
    ).catch(() => undefined);
    if (
      current &&
      processIdentityMatches(metadata.supervisorOsIdentity, current) &&
      (dependencies.processIsAlive ?? processIsAlive)(supervisor.pid)
    ) {
      supervisor.kill("SIGKILL");
    }
  }
  if (!(dependencies.processIsAlive ?? processIsAlive)(supervisor.pid)) {
    await verifyPortsAvailable(dependencies);
    (dependencies.removeMetadata ?? removeMetadataOwnedBy)(metadata);
  }
}

async function waitForSupervisorReady(supervisorPid, instanceId, dependencies = {}) {
  return (dependencies.waitFor ?? waitFor)(
    async () => {
      if (!(dependencies.processIsAlive ?? processIsAlive)(supervisorPid)) {
        throw new Error("The owned Preview supervisor exited before readiness.");
      }
      const tracked = await (dependencies.inspectTracked ?? inspectTrackedPreview)();
      if (
        tracked.state === "running" &&
        tracked.metadata.instanceId === instanceId &&
        tracked.status.state === "ready"
      ) {
        return tracked;
      }
      if (tracked.state === "running" && tracked.status.state === "failed") {
        throw new Error("The owned Preview supervisor reported readiness failure.");
      }
      if (["invalid", "stale"].includes(tracked.state)) {
        throw new Error("Preview supervisor identity became unverifiable during startup.");
      }
      // The launcher can publish exact OS metadata a few milliseconds before the supervisor has
      // bound its authenticated control socket. Keep polling that bounded startup race; exact
      // identity is rechecked by inspectTrackedPreview on every attempt and by failed cleanup.
      if (tracked.state === "unreachable") return false;
      return false;
    },
    {
      intervalMilliseconds: 300,
      timeoutMessage: "The isolated Preview runtime was not ready within 185 seconds.",
      timeoutMilliseconds: 185_000,
    },
  );
}

async function waitForConcurrentPreviewReady(initial, dependencies = {}) {
  const result = await (dependencies.waitFor ?? waitFor)(
    async () => {
      const tracked = await (dependencies.inspectTracked ?? inspectTrackedPreview)();
      if (
        tracked.state !== "running" ||
        tracked.metadata?.instanceId !== initial.metadata.instanceId ||
        !processIdentityMatches(
          initial.metadata.supervisorOsIdentity,
          tracked.metadata?.supervisorOsIdentity,
        ) ||
        tracked.metadata.state !== tracked.status?.state
      ) {
        return {
          error: new Error(
            "The concurrent Preview startup changed ownership or became unverifiable.",
          ),
        };
      }
      if (tracked.status.state === "ready") return { tracked };
      if (tracked.status.state === "starting") return false;
      return {
        error: new Error(
          `The concurrent Preview supervisor entered ${tracked.status.state}; no browser was opened.`,
        ),
      };
    },
    {
      intervalMilliseconds: 300,
      timeoutMessage: "The concurrent Preview startup did not become ready within 185 seconds.",
      timeoutMilliseconds: 185_000,
    },
  );
  if (result.error) throw result.error;
  return result.tracked;
}

export async function startPreview(options = {}, dependencies = {}) {
  (dependencies.assertBoundary ?? assertPreviewBoundary)();
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("The isolated Preview launcher supports Windows only.");
  }
  const paths = dependencies.paths ?? previewPaths;
  (dependencies.assertPaths ?? assertPreviewPathContract)(paths);
  const toolchain = (dependencies.requireToolchain ?? requireCanonicalToolchain)({
    environment: dependencies.environment ?? process.env,
    requirePnpm: true,
  });
  const tracked = await (dependencies.inspectTracked ?? inspectTrackedPreview)();
  const decision = decidePreviewStart(tracked, options);
  if (decision.action === "block-running-seed") {
    throw new Error("Stop the running Preview before using --seed.");
  }
  if (decision.action === "block-unverifiable") {
    throw new Error(
      "Preview metadata or the tracked process identity is unverifiable; no process was touched.",
    );
  }
  if (decision.action === "block-failed") {
    throw new Error(
      "The authenticated Preview supervisor reported failed startup; no browser was opened.",
    );
  }
  if (decision.action === "block-stopping") {
    throw new Error("The authenticated Preview supervisor is stopping; no browser was opened.");
  }
  if (decision.action === "wait-for-ready") {
    if (options.check) {
      emit(dependencies, "BEA_PREVIEW_START_CHECK=BLOCKED (RUNNING:starting)\n");
      return { outcome: "BLOCKED", readOnly: true, reason: "STARTING" };
    }
    const ready = await waitForConcurrentPreviewReady(tracked, dependencies);
    emit(
      dependencies,
      `BEA Preview finished its concurrent startup under authenticated supervisor PID ${String(ready.metadata.supervisorOsIdentity.pid)}.\n`,
    );
    if (!options.noOpen) {
      (dependencies.openBrowser ?? openInDefaultBrowser)(previewSignInUrl);
    }
    emit(dependencies, `Open ${previewSignInUrl}\nBEA_PREVIEW_START=ALREADY_RUNNING\n`);
    return {
      outcome: "ALREADY_RUNNING",
      supervisorPid: ready.metadata.supervisorOsIdentity.pid,
    };
  }
  if (decision.action === "already-running") {
    emit(
      dependencies,
      `BEA Preview is already running under authenticated supervisor PID ${String(tracked.metadata.supervisorOsIdentity.pid)}.\n`,
    );
    if (options.check) {
      emit(dependencies, `BEA_PREVIEW_START_CHECK=PASS (RUNNING:${tracked.status.state})\n`);
      return {
        outcome: "PASS",
        readOnly: true,
        supervisorPid: tracked.metadata.supervisorOsIdentity.pid,
      };
    }
    if (!options.noOpen) {
      (dependencies.openBrowser ?? openInDefaultBrowser)(previewSignInUrl);
    }
    emit(dependencies, `Open ${previewSignInUrl}\nBEA_PREVIEW_START=ALREADY_RUNNING\n`);
    return { outcome: "ALREADY_RUNNING", supervisorPid: tracked.metadata.supervisorOsIdentity.pid };
  }
  if (decision.action === "clean-stale") {
    await verifyPortsAvailable(dependencies);
    if (options.check) {
      emit(
        dependencies,
        "BEA_PREVIEW_START_CHECK=BLOCKED (validated stale metadata requires cleanup)\n",
      );
      return { outcome: "BLOCKED", reason: "STALE_METADATA" };
    }
    if (!(dependencies.removeMetadata ?? removeMetadataOwnedBy)(tracked.metadata)) {
      throw new Error("Stale Preview metadata changed during validation and was preserved.");
    }
  } else {
    await verifyPortsAvailable(dependencies);
  }

  if (options.check) {
    const lock = await (dependencies.inspectLaunchLock ?? inspectPreviewLaunchLock)({
      ...dependencies,
      nodeExecutable: toolchain.nodeExecutable,
      path: paths.launchLockFile,
      recoveryPath: `${paths.launchLockFile}.recovering`,
    });
    if (lock.state === "live") {
      emit(dependencies, "BEA_PREVIEW_START_CHECK=BLOCKED (LAUNCH_STARTING)\n");
      return { outcome: "BLOCKED", readOnly: true, reason: "LAUNCH_STARTING" };
    }
    if (lock.state === "stale") {
      emit(dependencies, "BEA_PREVIEW_START_CHECK=BLOCKED (STALE_LAUNCH_LOCK)\n");
      return { outcome: "BLOCKED", readOnly: true, reason: "STALE_LAUNCH_LOCK" };
    }
    if (["ambiguous", "invalid"].includes(lock.state)) {
      throw new Error(
        "Preview launch-lock ownership is unverifiable; live or ambiguous evidence was preserved.",
      );
    }
  }

  const dependenciesPresent = (dependencies.exists ?? existsSync)(
    join(repositoryRoot, "node_modules"),
  );
  const initialization = (dependencies.readInitialization ?? readPreviewInitialization)();
  if (options.check) {
    emit(
      dependencies,
      dependenciesPresent
        ? "BEA_PREVIEW_START_CHECK=PASS\n"
        : "BEA_PREVIEW_START_CHECK=PASS (SETUP_REQUIRED:FROZEN_INSTALL)\n",
    );
    return { outcome: "PASS", readOnly: true, setupRequired: !dependenciesPresent };
  }

  (dependencies.ensureDirectories ?? ensurePreviewDirectories)(paths);
  const launchLock = await (dependencies.acquireLaunchLock ?? acquireLaunchLock)(
    paths,
    toolchain,
    dependencies,
  );
  try {
    const childEnvironment = createPreviewChildEnvironment(dependencies.environment ?? process.env);
    if (!dependenciesPresent) {
      runRequiredPnpm(
        toolchain,
        ["install", "--frozen-lockfile"],
        childEnvironment,
        "Canonical frozen dependency installation",
        dependencies,
      );
    } else {
      emit(dependencies, "==> Repository dependencies present; frozen install skipped.\n");
    }
    runRequiredPnpm(
      toolchain,
      ["--filter", "@bea/database", "migrate"],
      childEnvironment,
      "Preview database migration",
      dependencies,
    );
    const shouldSeed = initialization.firstStart || options.seed === true;
    if (shouldSeed) {
      runRequiredPnpm(
        toolchain,
        ["--filter", "@bea/database", "seed"],
        childEnvironment,
        "Deterministic isolated Preview seed",
        dependencies,
      );
    } else {
      emit(dependencies, "==> Existing Preview initialization found; explicit seed skipped.\n");
    }

    const logs = (dependencies.createLogs ?? createRunLogPaths)();
    const instanceId = (dependencies.randomBytes ?? randomBytes)(16).toString("hex");
    const controlToken = (dependencies.randomBytes ?? randomBytes)(32).toString("hex");
    const supervisor = (dependencies.spawnSupervisor ?? spawnPreviewSupervisor)(
      toolchain,
      logs,
      instanceId,
      controlToken,
      dependencies,
    );
    if (!supervisor?.pid) throw new Error("The Preview supervisor did not return a PID.");
    const pendingSupervisor = pendingSupervisorRecord(supervisor, toolchain);
    let identity;
    try {
      identity = await waitForOsIdentity(supervisor.pid, toolchain.nodeExecutable, dependencies);
    } catch (error) {
      try {
        await terminateExactSpawnedPreviewSupervisor(pendingSupervisor, dependencies);
      } catch (cleanupError) {
        throw new Error(
          `${error instanceof Error ? error.message : "Preview supervisor identity capture failed."} Exact cleanup was refused: ${cleanupError instanceof Error ? cleanupError.message : "identity unavailable"}`,
          { cause: error },
        );
      }
      await verifyPortsAvailable(dependencies);
      throw error;
    }
    const metadata = createLaunchMetadata(
      identity,
      toolchain,
      logs,
      instanceId,
      controlToken,
      dependencies,
    );
    try {
      writeInitialMetadata(metadata, dependencies);
    } catch (error) {
      await stopFailedLaunch(supervisor, metadata, dependencies);
      throw error;
    }
    supervisor.unref?.();

    try {
      const ready = await waitForSupervisorReady(supervisor.pid, instanceId, dependencies);
      (dependencies.writeInitialization ?? writePreviewInitialization)(
        initialization.marker,
        shouldSeed,
      );
      emit(dependencies, "\nBEA Preview is ready (NON-PRODUCTION / SIMULATED).\n");
      emit(dependencies, `Sign-in: ${previewSignInUrl}\n`);
      emit(dependencies, `Supervisor PID: ${String(ready.metadata.supervisorOsIdentity.pid)}\n`);
      emit(
        dependencies,
        "Production config, secrets, database, ports, metadata, and processes were not used.\n",
      );
      if (!options.noOpen) (dependencies.openBrowser ?? openInDefaultBrowser)(previewSignInUrl);
      emit(dependencies, "BEA_PREVIEW_START=PASS\n");
      return { outcome: "PASS", supervisorPid: ready.metadata.supervisorOsIdentity.pid };
    } catch (error) {
      await stopFailedLaunch(supervisor, metadata, dependencies);
      throw error;
    }
  } finally {
    await (dependencies.releaseLaunchLock ?? releaseLaunchLock)(launchLock, dependencies);
  }
}

async function main() {
  const options = parsePreviewStartArguments(process.argv.slice(2));
  const result = await startPreview(options);
  process.exitCode = result.outcome === "BLOCKED" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(
      `BEA_PREVIEW_START=BLOCKED (${error instanceof Error ? error.message : "UnknownError"})\n`,
    );
    process.exitCode = 1;
  });
}
