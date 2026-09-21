import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolConfig } from "pg";
import { PgSqlDatabaseAdapter } from "./pg-sql-adapter.js";
import { schema } from "./schema.js";

/** Legacy ORM entry. Hosted callers use the SQL-only adapter directly. */
export class PgDatabaseAdapter extends PgSqlDatabaseAdapter {
  readonly drizzle: NodePgDatabase<typeof schema>;

  constructor(configuration: PoolConfig | string) {
    super(configuration);
    this.drizzle = drizzle(this.pool, { schema });
  }
}
