import { pathToFileURL } from "node:url";

import {
  collectProductionDoctorReport,
  printProductionDoctorReport,
} from "./production-preflight.mjs";
import {
  assertProductionOwnerToolBoundary,
  redactSensitiveText,
} from "./production-owner-tools.mjs";

function parseArguments(arguments_) {
  const options = { check: false };
  for (const argument of arguments_) {
    if (argument === "--check") options.check = true;
    else throw new Error("Usage: node scripts/phase133/production-start.mjs [--check]");
  }
  return options;
}

export async function startProduction(options = {}) {
  assertProductionOwnerToolBoundary();
  if (process.platform !== "win32") {
    throw new Error("The production owner launcher supports Windows only.");
  }

  const report = await collectProductionDoctorReport();
  printProductionDoctorReport(report);
  if (options.check) {
    process.stdout.write(
      `BEA_PRODUCTION_START_CHECK=${report.blockers.length === 0 ? "PASS" : "BLOCKED"}\n`,
    );
    return report.blockers.length === 0 ? 0 : 1;
  }
  if (report.blockers.length > 0) {
    throw new Error("Production prerequisite checks are blocked; no process was started.");
  }

  throw new Error(
    "Production process activation remains NOT RUN and requires explicit owner authorization; no Demo fallback, migration, service, or process action was performed.",
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  process.exitCode = await startProduction(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    const message = redactSensitiveText(error instanceof Error ? error.message : "UnknownError");
    process.stderr.write(`BEA_PRODUCTION_START=BLOCKED (${message})\n`);
    process.exitCode = 1;
  });
}
