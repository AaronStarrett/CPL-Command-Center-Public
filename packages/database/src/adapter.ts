import type { DatabaseHealthProvider } from "@bea/domain";

export interface DatabaseResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface SqlExecutor {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<DatabaseResult<Row>>;
  execute(sql: string): Promise<void>;
}

export interface DatabaseAdapter extends SqlExecutor, DatabaseHealthProvider {
  readonly kind: "postgres" | "pglite";
  transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
