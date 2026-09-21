import { pathToFileURL } from "node:url";

import {
  assertOwnerEvaluationPathContract,
  assertPreviewBoundary,
  authenticatedStatusMatches,
  checkPortAvailable,
  controlRequest,
  inspectPreviewLaunchLock,
  inspectPreviewPorts,
  inspectProcessIdentity,
  inspectTrackedPreview,
  ownerEvaluationPaths,
  ownerEvaluationPorts,
  processIdentityMatches,
  processIsAlive,
  readPreviewMetadata,
  recoverStalePreviewLaunchLock,
  removeMetadataOwnedBy,
  requireCanonicalToolchain,
  unavailablePreviewPorts,
  waitFor,
} from "./preview-common.mjs";

export function parsePreviewStopArguments(arguments_) {
  if (arguments_.length === 0) return Object.freeze({ check: false });
  if (arguments_.length === 1 && arguments_[0] === "--check") {
    return Object.freeze({ check: true });
  }
  throw new Error("Usage: owner-evaluation-stop.mjs [--check]");
}

export function decidePreviewStop(tracked, options = {}) {
  if (tracked.state === "stopped") return { action: "already-stopped" };
  if (tracked.state === "running") return { action: options.check ? "report-running" : "stop" };
  if (tracked.state === "stale") return { action: options.check ? "report-stale" : "clean-stale" };
  return { action: "block-unverifiable" };
}

function emit(dependencies, value) {
  (dependencies.writeOutput ?? ((text) => process.stdout.write(text)))(value);
}

async function requirePortsReleased(dependencies = {}) {
  const results = await (dependencies.inspectPorts ?? inspectPreviewPorts)({
    checkPort: dependencies.checkPort ?? checkPortAvailable,
    ports: ownerEvaluationPorts,
  });
  const unavailable = unavailablePreviewPorts(results, ownerEvaluationPorts);
  if (unavailable.length > 0) {
    throw new Error(
      `Owner Evaluation ports remain occupied (${unavailable.join(", ")}); no process was touched.`,
    );
  }
  return results;
}

async function handleStoppedLaunchLock(options, toolchain, dependencies = {}) {
  const paths = dependencies.paths ?? ownerEvaluationPaths;
  const inspection = await (dependencies.inspectLaunchLock ?? inspectPreviewLaunchLock)({
    ...dependencies,
    nodeExecutable: toolchain.nodeExecutable,
    path: paths.launchLockFile,
    recoveryPath: `${paths.launchLockFile}.recovering`,
  });
  if (inspection.state === "missing") return { state: "missing" };
  if (inspection.state === "live") {
    if (options.check) {
      emit(dependencies, "BEA_OWNER_EVALUATION_STOP_CHECK=BLOCKED (LAUNCH_STARTING)\n");
      return { outcome: "BLOCKED", readOnly: true, reason: "LAUNCH_STARTING" };
    }
    throw new Error(
      "An exact Owner Evaluation launcher is still starting; no process was touched.",
    );
  }
  if (["ambiguous", "invalid"].includes(inspection.state)) {
    throw new Error(
      "Owner Evaluation launch-lock ownership is unverifiable; live or ambiguous evidence was preserved.",
    );
  }

  await requirePortsReleased(dependencies);
  if (options.check) {
    emit(dependencies, "BEA_OWNER_EVALUATION_STOP_CHECK=BLOCKED (STALE_LAUNCH_LOCK)\n");
    return { outcome: "BLOCKED", readOnly: true, reason: "STALE_LAUNCH_LOCK" };
  }
  const recovered = await (dependencies.recoverLaunchLock ?? recoverStalePreviewLaunchLock)(
    inspection,
    {
      ...dependencies,
      nodeExecutable: toolchain.nodeExecutable,
      path: paths.launchLockFile,
      recoveryPath: `${paths.launchLockFile}.recovering`,
    },
  );
  if (!recovered) {
    throw new Error(
      "Stale Owner Evaluation launch-lock ownership changed; evidence was preserved.",
    );
  }
  emit(
    dependencies,
    "Removed a validated dead-owner Preview launch lock after all fixed ports were free; no process was terminated.\nBEA_OWNER_EVALUATION_STOP=STALE_LAUNCH_LOCK_CLEANED\n",
  );
  return { outcome: "STALE_LAUNCH_LOCK_CLEANED" };
}

export function authenticatedStopAccepted(metadata, response) {
  return (
    response?.ok === true &&
    response.status === 202 &&
    response.body?.code === "BEA_PREVIEW_STOP_ACCEPTED" &&
    authenticatedStatusMatches(metadata, response.body)
  );
}

async function waitForOwnedShutdown(metadata, dependencies = {}) {
  return (dependencies.waitFor ?? waitFor)(
    async () => {
      const alive = (dependencies.processIsAlive ?? processIsAlive)(
        metadata.supervisorOsIdentity.pid,
      );
      if (alive) {
        const current = await (dependencies.inspectProcessIdentity ?? inspectProcessIdentity)(
          metadata.supervisorOsIdentity.pid,
        );
        if (!current || !processIdentityMatches(metadata.supervisorOsIdentity, current)) {
          throw new Error(
            "The authenticated supervisor PID changed identity during shutdown; no fallback kill was used.",
          );
        }
        return false;
      }

      const currentMetadata = (dependencies.readMetadata ?? readPreviewMetadata)({
        path: ownerEvaluationPaths.metadataFile,
      });
      if (currentMetadata.metadata) {
        (dependencies.removeMetadata ?? removeMetadataOwnedBy)(metadata, {
          path: ownerEvaluationPaths.metadataFile,
        });
      } else if (currentMetadata.exists) {
        throw new Error(
          "Owner Evaluation metadata became invalid during shutdown and was preserved.",
        );
      }
      const afterRemoval = (dependencies.readMetadata ?? readPreviewMetadata)({
        path: ownerEvaluationPaths.metadataFile,
      });
      if (afterRemoval.exists) return false;
      await requirePortsReleased(dependencies);
      return true;
    },
    {
      intervalMilliseconds: 250,
      timeoutMessage:
        "The Owner Evaluation supervisor did not stop and release its exact ports within 40 seconds; no broad kill was attempted.",
      timeoutMilliseconds: 40_000,
    },
  );
}

export async function stopPreview(options = {}, dependencies = {}) {
  (dependencies.assertBoundary ?? assertPreviewBoundary)();
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("The Owner Evaluation stop tool supports Windows only.");
  }
  (dependencies.assertPaths ?? assertOwnerEvaluationPathContract)(
    dependencies.paths ?? ownerEvaluationPaths,
  );
  const toolchain = (dependencies.requireToolchain ?? requireCanonicalToolchain)({
    environment: dependencies.environment ?? process.env,
    requirePnpm: false,
  });

  const tracked = await (dependencies.inspectTracked ?? inspectTrackedPreview)({
    path: ownerEvaluationPaths.metadataFile,
  });
  const decision = decidePreviewStop(tracked, options);
  if (decision.action === "block-unverifiable") {
    throw new Error(
      "Owner Evaluation metadata or the tracked supervisor identity is unverifiable; no process was touched.",
    );
  }
  if (decision.action === "already-stopped") {
    const launchLock = await handleStoppedLaunchLock(options, toolchain, dependencies);
    if (launchLock.outcome) return launchLock;
    await requirePortsReleased(dependencies);
    emit(
      dependencies,
      options.check
        ? "BEA_OWNER_EVALUATION_STOP_CHECK=PASS (ALREADY_STOPPED)\n"
        : "BEA_OWNER_EVALUATION_STOP=ALREADY_STOPPED\n",
    );
    return { outcome: "ALREADY_STOPPED", readOnly: options.check === true };
  }
  if (decision.action === "report-stale") {
    emit(dependencies, "BEA_OWNER_EVALUATION_STOP_CHECK=BLOCKED (STALE_METADATA)\n");
    return { outcome: "BLOCKED", readOnly: true };
  }
  if (decision.action === "clean-stale") {
    await requirePortsReleased(dependencies);
    if (
      !(dependencies.removeMetadata ?? removeMetadataOwnedBy)(tracked.metadata, {
        path: ownerEvaluationPaths.metadataFile,
      })
    ) {
      throw new Error(
        "Stale Owner Evaluation metadata changed during validation and was preserved.",
      );
    }
    emit(
      dependencies,
      `Removed stale metadata for stopped Preview supervisor PID ${String(tracked.metadata.supervisorOsIdentity.pid)}; no process was terminated.\nBEA_OWNER_EVALUATION_STOP=STALE_METADATA_CLEANED\n`,
    );
    return { outcome: "STALE_METADATA_CLEANED" };
  }
  if (decision.action === "report-running") {
    emit(
      dependencies,
      `BEA_OWNER_EVALUATION_STOP_CHECK=PASS (RUNNING:${tracked.status.state}, PID:${String(tracked.metadata.supervisorOsIdentity.pid)})\n`,
    );
    return { outcome: "PASS", readOnly: true };
  }

  const response = await (dependencies.controlRequest ?? controlRequest)(
    tracked.metadata,
    "/stop",
    { method: "POST", timeoutMilliseconds: 5_000 },
  );
  if (!authenticatedStopAccepted(tracked.metadata, response)) {
    throw new Error(
      "The exact authenticated Preview supervisor did not accept shutdown; no fallback kill was used.",
    );
  }
  await waitForOwnedShutdown(tracked.metadata, dependencies);
  emit(
    dependencies,
    "Stopped the exact launcher-owned Owner Evaluation supervisor, web, and worker processes; ports 3300/3301/3302 are released.\nBEA_OWNER_EVALUATION_STOP=PASS\n",
  );
  return { outcome: "PASS" };
}

async function main() {
  const options = parsePreviewStopArguments(process.argv.slice(2));
  const result = await stopPreview(options);
  process.exitCode = result.outcome === "BLOCKED" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(
      `BEA_OWNER_EVALUATION_STOP=BLOCKED (${error instanceof Error ? error.message : "UnknownError"})\n`,
    );
    process.exitCode = 1;
  });
}
