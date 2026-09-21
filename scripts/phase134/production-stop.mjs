import { rmSync } from "node:fs";
import { join } from "node:path";

import { assertRepositoryBoundary } from "../repository-boundary.mjs";
import { productionPaths, repositoryRoot, TOOLCHAIN_NODE_VERSION } from "./production-paths.mjs";
import { readProductionSecrets } from "./production-secrets.mjs";
import {
  checkPortAvailable,
  controlRequest,
  processIsAlive,
  readRuntimeMetadata,
  waitFor,
} from "./runtime-control.mjs";

export function decideStopFromTrackedState(metadataResult, alive) {
  if (!metadataResult.exists) return { action: "already-stopped" };
  if (!metadataResult.metadata) {
    return { action: "block", message: metadataResult.issues.join(" ") };
  }
  if (!alive) return { action: "clean-stale", metadata: metadataResult.metadata };
  return { action: "authenticate-stop", metadata: metadataResult.metadata };
}

async function verifyPortsReleased(metadata, dependencies = {}) {
  const checkPort = dependencies.checkPort ?? checkPortAvailable;
  const failures = [];
  for (const [name, port] of Object.entries(metadata.ports)) {
    const result = await checkPort(port);
    if (!result.available) failures.push(`${name}:${String(port)}:${result.code ?? "occupied"}`);
  }
  if (failures.length > 0) {
    throw new Error(`Owned production ports were not released (${failures.join(", ")}).`);
  }
}

export async function stopProduction(options = {}, dependencies = {}) {
  (dependencies.assertBoundary ?? assertRepositoryBoundary)({
    cwd: repositoryRoot,
    target: repositoryRoot,
  });
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("Local Live production supports Windows only.");
  }
  const currentNode = (dependencies.nodeVersion ?? process.version).replace(/^v/u, "");
  if (currentNode !== TOOLCHAIN_NODE_VERSION) {
    throw new Error(`Stop-BEA requires the BEA-owned Node ${TOOLCHAIN_NODE_VERSION}.`);
  }
  const paths = dependencies.paths ?? productionPaths;
  const tracked = (dependencies.readMetadata ?? readRuntimeMetadata)(paths.runtimeMetadataFile);
  const decision = decideStopFromTrackedState(
    tracked,
    tracked.metadata
      ? (dependencies.processIsAlive ?? processIsAlive)(tracked.metadata.supervisorPid)
      : false,
  );
  if (options.check) return decision;
  if (decision.action === "already-stopped") {
    process.stdout.write(
      "BEA Local Live Production is already stopped.\nBEA_PRODUCTION_STOP=ALREADY_STOPPED\n",
    );
    return { outcome: "ALREADY_STOPPED" };
  }
  if (decision.action === "block") throw new Error(decision.message);
  if (decision.action === "clean-stale") {
    await verifyPortsReleased(decision.metadata, dependencies);
    rmSync(paths.runtimeMetadataFile, { force: true });
    rmSync(join(paths.runtimeDirectory, "production.lock"), { force: true });
    process.stdout.write(
      `Removed validated stale metadata for stopped supervisor PID ${String(decision.metadata.supervisorPid)}.\n` +
        `BEA_PRODUCTION_STOP=ALREADY_STOPPED\n`,
    );
    return { outcome: "ALREADY_STOPPED", staleMetadataRemoved: true };
  }

  const secrets = (dependencies.readSecrets ?? readProductionSecrets)(["controlToken"], {
    filePath: paths.secretFile,
  });
  const status = await (dependencies.controlRequest ?? controlRequest)(
    decision.metadata,
    secrets.controlToken,
    "/status",
  ).catch(() => undefined);
  if (
    !status?.ok ||
    status.body?.supervisorPid !== decision.metadata.supervisorPid ||
    status.body?.profile !== "local-live"
  ) {
    throw new Error(
      "The tracked PID did not authenticate as this BEA supervisor; no process was terminated.",
    );
  }
  const accepted = await (dependencies.controlRequest ?? controlRequest)(
    decision.metadata,
    secrets.controlToken,
    "/stop",
    { method: "POST", timeoutMs: 5_000 },
  );
  if (!accepted.ok || accepted.body?.code !== "BEA_STOP_ACCEPTED") {
    throw new Error("The authenticated supervisor did not accept graceful shutdown.");
  }
  await (dependencies.waitFor ?? waitFor)(
    () => !(dependencies.processIsAlive ?? processIsAlive)(decision.metadata.supervisorPid),
    {
      timeoutMs: 45_000,
      intervalMs: 250,
      message: "The authenticated owned supervisor did not stop within the grace period.",
    },
  );
  await verifyPortsReleased(decision.metadata, dependencies);
  const finalMetadata = (dependencies.readMetadata ?? readRuntimeMetadata)(
    paths.runtimeMetadataFile,
  );
  if (finalMetadata.exists) {
    if (
      !finalMetadata.metadata ||
      finalMetadata.metadata.supervisorPid !== decision.metadata.supervisorPid
    ) {
      throw new Error("Runtime metadata changed during shutdown and was not removed.");
    }
    rmSync(paths.runtimeMetadataFile, { force: true });
  }
  rmSync(join(paths.runtimeDirectory, "production.lock"), { force: true });
  process.stdout.write(
    `Stopped authenticated BEA-owned supervisor PID ${String(decision.metadata.supervisorPid)} and released all configured ports.\n` +
      `BEA_PRODUCTION_STOP=PASS\n`,
  );
  return { outcome: "PASS", supervisorPid: decision.metadata.supervisorPid };
}

function parseArguments(arguments_) {
  const options = { check: false };
  for (const argument of arguments_) {
    if (argument === "--check") options.check = true;
    else throw new Error("Usage: production-stop.mjs [--check]");
  }
  return options;
}

if (process.argv[1]?.toLowerCase().endsWith("production-stop.mjs")) {
  stopProduction(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(
      `BEA_PRODUCTION_STOP=BLOCKED (${error instanceof Error ? error.name : "UnknownError"})\n`,
    );
    process.exitCode = 1;
  });
}
