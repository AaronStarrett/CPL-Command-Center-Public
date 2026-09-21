import { assertLegacyRuntimeTestOnly, loadRepositoryEnvironment } from "@bea/config";
import { toSafeErrorDetails } from "@bea/observability";
import { pathToFileURL } from "node:url";
import { createDatabaseAdapter } from "../factory.js";
import { migrateDatabase, verifyMigrations } from "../migrations.js";
import { verifyProductionDatabase } from "../production-verification.js";
import { assertDemoResetAllowed, resetDemoDatabase, type DemoResetContext } from "../reset.js";
import { assertDemoSeedAllowed, seedDatabase } from "../seed.js";
import { seedSystemDatabase, verifySystemSeed } from "../system-seed.js";

export type DatabaseCommand =
  | "migrate"
  | "verify-migrations"
  | "system-seed"
  | "verify-system-seed"
  | "verify-production"
  | "seed"
  | "demo-reset";

export interface DatabaseCommandDependencies {
  readonly createDatabase?: typeof createDatabaseAdapter;
}

export async function runDatabaseCommand(
  command: DatabaseCommand,
  rawEnvironment: Readonly<Record<string, string | undefined>>,
  dependencies: DatabaseCommandDependencies = {},
): Promise<unknown> {
  if (command === "seed" || command === "demo-reset") {
    assertLegacyRuntimeTestOnly(rawEnvironment);
  }
  const { environment } = loadRepositoryEnvironment({ processEnvironment: rawEnvironment });
  const resetContext: DemoResetContext = {
    appMode: environment.appMode,
    nodeEnv: environment.nodeEnv,
    confirmation: rawEnvironment.DEMO_RESET_CONFIRMATION ?? "",
  };
  if (command === "demo-reset") assertDemoResetAllowed(resetContext);
  if (command === "seed") assertDemoSeedAllowed(environment.appMode);
  if (
    command === "verify-production" &&
    (environment.runtimeMode !== "production" ||
      environment.appMode !== "production" ||
      environment.databaseDriver !== "postgres" ||
      environment.demoAuthEnabled ||
      new URL(environment.appBaseUrl).protocol !== "https:")
  ) {
    throw new Error("Production verification requires the validated HTTPS PostgreSQL profile.");
  }

  const database = (dependencies.createDatabase ?? createDatabaseAdapter)(environment);
  try {
    if (command === "verify-migrations") {
      return { command, migration: await verifyMigrations(database) };
    }
    if (command === "system-seed") {
      const migration = await verifyMigrations(database);
      return { command, migration, seed: await seedSystemDatabase(database) };
    }
    if (command === "verify-system-seed") {
      const migration = await verifyMigrations(database);
      return { command, migration, seed: await verifySystemSeed(database) };
    }
    if (command === "verify-production") {
      return { command, verification: await verifyProductionDatabase(database, environment) };
    }
    const migration = await migrateDatabase(database);
    if (command === "migrate") return { command, migration };
    if (command === "seed") return { command, migration, seed: await seedDatabase(database) };
    return {
      command,
      migration,
      reset: await resetDemoDatabase(database, resetContext),
    };
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  const validCommands: readonly DatabaseCommand[] = [
    "migrate",
    "verify-migrations",
    "system-seed",
    "verify-system-seed",
    "verify-production",
    "seed",
    "demo-reset",
  ];
  if (!validCommands.includes(command as DatabaseCommand)) {
    process.stderr.write(
      `${JSON.stringify({
        code: "BEA_DATABASE_COMMAND_FAILED",
        errorName: "InvalidDatabaseCommandError",
        errorCode: "INVALID_DATABASE_COMMAND",
      })}\n`,
    );
    process.exitCode = 1;
  } else {
    runDatabaseCommand(command as DatabaseCommand, process.env)
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error: unknown) => {
        process.stderr.write(
          `${JSON.stringify({
            code: "BEA_DATABASE_COMMAND_FAILED",
            ...toSafeErrorDetails(error, "DATABASE_COMMAND_FAILED"),
          })}\n`,
        );
        process.exitCode = 1;
      });
  }
}
