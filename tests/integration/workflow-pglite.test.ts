import { afterEach, describe, expect, it } from "vitest";
import { FoundationSystemHealthWorkflow } from "../../packages/automation/src/index.js";
import {
  PGliteDatabaseAdapter,
  migrateDatabase,
  seedDatabase,
  SqlFoundationRepository,
} from "../../packages/database/src/index.js";
import { createDefaultMockProviderRegistry } from "../../packages/integrations/src/index.js";

let database: PGliteDatabaseAdapter | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe("foundation workflow persistence", () => {
  it("persists exactly one run for an idempotency key", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedDatabase(database);
    const repository = new SqlFoundationRepository(database);
    const workflow = new FoundationSystemHealthWorkflow({
      database,
      providers: createDefaultMockProviderRegistry(),
      store: repository,
      audit: repository,
    });
    const first = await workflow.execute({
      idempotencyKey: "integration:health:v1",
      correlationId: "integration-correlation",
    });
    const second = await workflow.execute({ idempotencyKey: "integration:health:v1" });
    expect(first.run.status).toBe("succeeded");
    expect(second.reused).toBe(true);
    expect(second.steps).toHaveLength(2);
    const rows = await database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM workflow_runs WHERE idempotency_key=$1",
      ["integration:health:v1"],
    );
    expect(Number(rows.rows[0]?.count)).toBe(1);
  });
});
