import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEMO_PERSONAS,
  SEEDED_CONFIGURATION_IDS,
  SYNTHETIC_EXTERIOR_JSON_FIXTURE,
} from "../../packages/domain/src/index.js";
import {
  ConfigurationStudioService,
  PgDatabaseAdapter,
  createInspectionReportPipeline,
  migrateDatabase,
  seedDatabase,
  verifyMigrations,
} from "../../packages/database/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;

function inspectPhase31aPostgresUrl(value: string | undefined) {
  const url = value?.trim() ?? "";
  if (!url) {
    return { ready: false as const, detail: "BEA_PHASE31A_REAL_POSTGRES_URL is not set." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("BEA_PHASE31A_REAL_POSTGRES_URL is invalid.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("BEA_PHASE31A_REAL_POSTGRES_URL must be a PostgreSQL URL.");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/(?:phase[_-]?31a?|phase[_-]?30|test|ci|disposable)/iu.test(database)) {
    throw new Error(
      "Refusing a PostgreSQL database whose name does not contain phase31a, phase30, test, ci, or disposable.",
    );
  }
  return { ready: true as const, url, database };
}

const prerequisite = inspectPhase31aPostgresUrl(process.env.BEA_PHASE31A_REAL_POSTGRES_URL);
const describePostgres = prerequisite.ready ? describe.sequential : describe.sequential.skip;

describePostgres("Phase 3.1A real PostgreSQL configuration concurrency", () => {
  let database: PgDatabaseAdapter;

  beforeAll(async () => {
    if (!prerequisite.ready) return;
    database = new PgDatabaseAdapter({
      connectionString: prerequisite.url,
      max: 8,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
    });
    const migrated = await migrateDatabase(database);
    expect(migrated.applied.at(-1) ?? migrated.alreadyApplied.at(-1)).toBe(
      "0035_cpl_delivery_closeout.sql",
    );
    await expect(verifyMigrations(database)).resolves.toMatchObject({
      current: "0035_cpl_delivery_closeout.sql",
    });
    await seedDatabase(database);
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("publishes, activates, and keeps one active release per service context", async () => {
    const configuration = new ConfigurationStudioService(database);
    const pipeline = createInspectionReportPipeline(database, "demo", { processInline: true });
    const cloned = await configuration.cloneRelease({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      actorUserId: OWNER,
      correlationId: "pg-clone",
    });
    const validated = await configuration.validateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "pg-validate",
    });
    expect(validated.passed).toBe(true);
    await configuration.publishRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "pg-publish",
    });
    const activated = await configuration.activateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "pg-activate",
    });
    expect(activated.status).toBe("active");
    const active = await database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM configuration_releases WHERE service_context_key=$1 AND status='active'",
      [activated.serviceContextKey],
    );
    expect(Number(active.rows[0]?.count)).toBe(1);
    const preview = await configuration.previewReport({
      releaseId: cloned.id,
      sourceType: "json",
      raw: JSON.stringify(SYNTHETIC_EXTERIOR_JSON_FIXTURE),
    });
    expect(preview.rendered.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(pipeline.repository).toBeTruthy();
  });
});
