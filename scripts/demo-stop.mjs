import { pathToFileURL } from "node:url";

import {
  assertOwnerToolBoundary,
  controlRequest,
  inspectTrackedDemo,
  processIsAlive,
  readValidatedMetadata,
  removeMetadataOwnedBy,
  waitFor,
} from "./owner-tools-common.mjs";

function parseArguments(arguments_) {
  const options = { check: false };
  for (const argument of arguments_) {
    if (argument === "--check") options.check = true;
    else throw new Error("Usage: node scripts/demo-stop.mjs [--check]");
  }
  return options;
}

function childSummary(status) {
  const webPid = status?.children?.web?.pid ?? "unknown";
  const workerPid = status?.children?.worker?.pid ?? "unknown";
  return `supervisor PID ${status.supervisorPid}; web PID ${webPid}; worker PID ${workerPid}`;
}

export async function stopDemo(options = {}) {
  assertOwnerToolBoundary();
  const tracked = await inspectTrackedDemo();

  if (tracked.state === "stopped") {
    process.stdout.write("BEA demo is already stopped; no owner metadata is present.\n");
    process.stdout.write("BEA_DEMO_STOP=ALREADY_STOPPED\n");
    return 0;
  }
  if (tracked.state === "invalid") {
    throw new Error(`Owner metadata failed validation. ${tracked.issues.join(" ")}`);
  }
  if (tracked.state === "unreachable") {
    throw new Error(
      `Supervisor PID ${tracked.metadata.supervisorPid} is alive but the control-token handshake failed. No process was terminated.`,
    );
  }
  if (tracked.state === "stale") {
    if (options.check) {
      process.stdout.write(
        `BEA_DEMO_STOP_CHECK=STALE (stopped supervisor PID ${tracked.metadata.supervisorPid})\n`,
      );
      return 1;
    }
    if (!removeMetadataOwnedBy(tracked.metadata)) {
      throw new Error("Stale metadata changed during validation and was not removed.");
    }
    process.stdout.write(
      `Removed stale owner metadata for stopped supervisor PID ${tracked.metadata.supervisorPid}; no process was terminated.\n`,
    );
    process.stdout.write("BEA_DEMO_STOP=STALE_METADATA_CLEANED\n");
    return 0;
  }

  if (options.check) {
    process.stdout.write(
      `BEA demo is tracked and authenticated (${childSummary(tracked.status)}).\n`,
    );
    process.stdout.write(`BEA_DEMO_STOP_CHECK=RUNNING (${tracked.status.state})\n`);
    return 0;
  }

  const response = await controlRequest(tracked.metadata, "/stop", {
    method: "POST",
    timeoutMilliseconds: 5_000,
  });
  if (
    !response.ok ||
    response.status !== 202 ||
    response.body?.supervisorPid !== tracked.metadata.supervisorPid
  ) {
    throw new Error(
      "Authenticated supervisor did not accept the stop request; no fallback kill was used.",
    );
  }

  process.stdout.write(`Graceful stop accepted for ${childSummary(tracked.status)}.\n`);
  await waitFor(
    () => {
      const alive = processIsAlive(tracked.metadata.supervisorPid);
      const current = readValidatedMetadata();
      if (!alive && current.metadata) removeMetadataOwnedBy(tracked.metadata);
      return !alive && !readValidatedMetadata().exists;
    },
    {
      intervalMilliseconds: 250,
      timeoutMessage:
        "The authenticated supervisor did not finish graceful shutdown within 35 seconds; no broad process kill was attempted.",
      timeoutMilliseconds: 35_000,
    },
  );

  process.stdout.write(
    "Stopped the launcher-owned BEA web and worker processes. Logs remain under .data.\n",
  );
  process.stdout.write("BEA_DEMO_STOP=PASS\n");
  return 0;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  process.exitCode = await stopDemo(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(
      `BEA_DEMO_STOP=BLOCKED (${error instanceof Error ? error.message : "UnknownError"})\n`,
    );
    process.exitCode = 1;
  });
}
