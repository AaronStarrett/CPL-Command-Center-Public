import { runWorker } from "./runtime.js";
import { toSafeErrorDetails } from "@bea/observability";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

runWorker(process.argv.slice(2), process.env, shutdown.signal)
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        code: "BEA_WORKER_FAILED",
        ...toSafeErrorDetails(error, "WORKER_FAILED"),
      })}\n`,
    );
    process.exitCode = 1;
  });

export * from "./cli.js";
export * from "./health-server.js";
export * from "./runtime.js";
