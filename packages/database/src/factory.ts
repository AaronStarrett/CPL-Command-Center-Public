import type { ServerEnvironment } from "@bea/config";
import type { DatabaseAdapter } from "./adapter.js";
import { PgDatabaseAdapter } from "./pg-adapter.js";
import { PGliteDatabaseAdapter } from "./pglite-adapter.js";

export function createDatabaseAdapter(environment: ServerEnvironment): DatabaseAdapter {
  if (environment.databaseDriver === "postgres") {
    if (!environment.databaseUrl) {
      throw new Error("The PostgreSQL adapter requires DATABASE_URL.");
    }
    return new PgDatabaseAdapter(environment.databaseUrl);
  }
  if (environment.appMode !== "demo") {
    throw new Error("PGlite is restricted to explicit demo mode.");
  }
  return new PGliteDatabaseAdapter(environment.demoDatabasePath);
}
