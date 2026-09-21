import { pathToFileURL } from "node:url";

import {
  assertProductionOwnerToolBoundary,
  inspectTrackedProduction,
  processIsAlive,
  productionControlRequest,
  readValidatedProductionMetadata,
  redactSensitiveText,
  removeProductionMetadataOwnedBy,
  waitFor,
} from "./production-owner-tools.mjs";

function parseArguments(arguments_) {
  const options = { check: false };
  for (const argument of arguments_) {
    if (argument === "--check") options.check = true;
    else throw new Error("Usage: node scripts/phase133/production-stop.mjs [--check]");
  }
  return options;
}

function childSummary(status) {
  const webPid = status?.children?.web?.pid ?? "unknown";
  const workerPid = status?.children?.worker?.pid ?? "unknown";
  return `supervisor PID ${status.supervisorPid}; web PID ${webPid}; worker PID ${workerPid}`;
}

export async function stopProduction(options = {}) {
  assertProductionOwnerToolBoundary();
  const tracked = await inspectTrackedProduction();

  if (tracked.state === "stopped") {
    process.stdout.write("BEA production runtime is already stopped; no metadata is present.\n");
    process.stdout.write("BEA_PRODUCTION_STOP=ALREADY_STOPPED\n");
    return 0;
  }
  if (tracked.state === "invalid") {
    throw new Error(`Production metadata failed validation. ${tracked.issues.join(" ")}`);
  }
  if (tracked.state === "unreachable") {
    throw new Error(
      `Supervisor PID ${tracked.metadata.supervisorPid} is alive but the authenticated control handshake failed; no process was terminated.`,
    );
  }
  if (tracked.state === "stale") {
    if (options.check) {
      process.stdout.write(
        `BEA_PRODUCTION_STOP_CHECK=STALE (stopped supervisor PID ${tracked.metadata.supervisorPid})\n`,
      );
      return 1;
    }
    if (!removeProductionMetadataOwnedBy(tracked.metadata)) {
      throw new Error("Stale production metadata changed during validation and was not removed.");
    }
    process.stdout.write(
      `Removed stale metadata for stopped supervisor PID ${tracked.metadata.supervisorPid}; no process was terminated.\n`,
    );
    process.stdout.write("BEA_PRODUCTION_STOP=STALE_METADATA_CLEANED\n");
    return 0;
  }

  if (options.check) {
    process.stdout.write(
      `BEA production runtime is tracked and authenticated (${childSummary(tracked.status)}).\n`,
    );
    process.stdout.write(`BEA_PRODUCTION_STOP_CHECK=RUNNING (${tracked.status.state})\n`);
    return 0;
  }

  const response = await productionControlRequest(tracked.metadata, "/stop", {
    method: "POST",
    timeoutMilliseconds: 5_000,
  });
  if (
    !response.ok ||
    response.status !== 202 ||
    response.body?.supervisorPid !== tracked.metadata.supervisorPid
  ) {
    throw new Error(
      "Authenticated production supervisor did not accept the stop request; no fallback kill was used.",
    );
  }

  process.stdout.write(`Graceful stop accepted for ${childSummary(tracked.status)}.\n`);
  await waitFor(
    () => {
      const alive = processIsAlive(tracked.metadata.supervisorPid);
      const current = readValidatedProductionMetadata();
      if (!alive && current.metadata) removeProductionMetadataOwnedBy(tracked.metadata);
      return !alive && !readValidatedProductionMetadata().exists;
    },
    {
      intervalMilliseconds: 250,
      timeoutMessage:
        "The authenticated supervisor did not finish graceful shutdown within 35 seconds; no broad or fallback process kill was attempted.",
      timeoutMilliseconds: 35_000,
    },
  );

  process.stdout.write(
    "Stopped only the production supervisor-owned web and worker processes; logs remain under .data.\n",
  );
  process.stdout.write("BEA_PRODUCTION_STOP=PASS\n");
  return 0;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  process.exitCode = await stopProduction(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    const message = redactSensitiveText(error instanceof Error ? error.message : "UnknownError");
    process.stderr.write(`BEA_PRODUCTION_STOP=BLOCKED (${message})\n`);
    process.exitCode = 1;
  });
}
