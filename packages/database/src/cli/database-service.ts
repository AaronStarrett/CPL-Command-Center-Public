import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadRepositoryEnvironment } from "@bea/config";
import { toSafeErrorDetails } from "@bea/observability";

export interface CommandRunner {
  run(
    executable: string,
    arguments_: readonly string[],
    options: { readonly cwd: string },
  ): Promise<number>;
}

const processRunner: CommandRunner = {
  run: (executable, arguments_, options) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(executable, [...arguments_], {
        cwd: options.cwd,
        stdio: "inherit",
        shell: false,
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    }),
};

export async function runDatabaseService(
  action: "start" | "stop",
  rawEnvironment: Readonly<Record<string, string | undefined>>,
  runner: CommandRunner = processRunner,
): Promise<Readonly<Record<string, string>>> {
  const loaded = loadRepositoryEnvironment({ processEnvironment: rawEnvironment });
  if (loaded.environment.databaseDriver === "pglite") {
    return { action, adapter: "pglite", status: "embedded-no-separate-service" };
  }
  const composeFile = join(loaded.repositoryRoot, "compose.yaml");
  if (!existsSync(composeFile))
    throw new Error("PostgreSQL start/stop requires the repository compose.yaml file.");
  const envFile = join(loaded.repositoryRoot, ".env.local");
  const arguments_ = [
    "compose",
    ...(existsSync(envFile) ? ["--env-file", envFile] : []),
    "-f",
    composeFile,
    action === "start" ? "up" : "stop",
  ];
  if (action === "start") arguments_.push("-d", "--wait", "--wait-timeout", "60");
  arguments_.push("postgres");
  const exitCode = await runner.run("docker", arguments_, { cwd: loaded.repositoryRoot });
  if (exitCode !== 0)
    throw new Error(`docker compose ${action} failed with exit code ${exitCode}.`);
  return { action, adapter: "postgres", status: action === "start" ? "started" : "stopped" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2];
  if (action !== "start" && action !== "stop") {
    process.stderr.write(
      `${JSON.stringify({
        code: "BEA_DATABASE_SERVICE_FAILED",
        errorName: "InvalidDatabaseServiceActionError",
        errorCode: "INVALID_DATABASE_SERVICE_ACTION",
      })}\n`,
    );
    process.exitCode = 1;
  } else {
    runDatabaseService(action, process.env)
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error: unknown) => {
        process.stderr.write(
          `${JSON.stringify({
            code: "BEA_DATABASE_SERVICE_FAILED",
            ...toSafeErrorDetails(error, "DATABASE_SERVICE_FAILED"),
          })}\n`,
        );
        process.exitCode = 1;
      });
  }
}
