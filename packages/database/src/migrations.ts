import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DatabaseAdapter } from "./adapter.js";

export interface MigrationDefinition {
  readonly id: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

const migrationFiles = [
  "0001_phase0_foundation.sql",
  "0002_phase1_core.sql",
  "0003_assistant_message_permissions.sql",
  "0004_phase1_2_openai_provider.sql",
  "0005_phase1_3_live_openai.sql",
  "0006_phase1_3_1_policy_provenance.sql",
  "0007_phase1_3_3_production_ai_routing.sql",
  "0008_phase1_3_3_connection_fingerprint.sql",
  "0009_phase1_3_3_realtime_route_provenance.sql",
  "0010_phase1_3_4_local_owner.sql",
  "0011_phase2_leads.sql",
  "0012_phase2_1_presentation.sql",
  "0013_phase2_2_executive_documents.sql",
  "0014_phase2_3_digital_workforce.sql",
  "0015_phase3_inspection_report_core.sql",
  "0016_phase3_delivery_authorization.sql",
  "0017_phase31a_configuration_release.sql",
  "0018_phase31a_source_integrity_and_staging_repair.sql",
  "0019_phase32a_operational_work_control_plane.sql",
  "0020_phase32a_projection_reliability_and_cycle_integrity.sql",
  "0021_phase32a_terminal_projection_and_schedule_failure.sql",
  "0022_phase33a_service_catalog_and_proposals.sql",
  "0023_phase33a_commercial_integrity_and_override_cycles.sql",
  "0024_phase34a_guided_meridian_experience.sql",
  "0025_cpl_tenant_foundation.sql",
  "0026_cpl_hosted_workflow.sql",
  "0027_cpl_hosted_jobs_http_v1.sql",
  "0028_cpl_session_http_reads.sql",
  "0029_cpl_structured_intake.sql",
  "0030_cpl_commercial_spine.sql",
  "0031_cpl_project_execution.sql",
  "0032_cpl_field_records.sql",
  "0033_cpl_reviewed_reports.sql",
  "0034_cpl_automation_recipes.sql",
  "0035_cpl_delivery_closeout.sql",
] as const;
const postgresMigrationLockClassId = 0x42454130;
const postgresMigrationLockObjectId = 0;
const migrationLedgerSql = `
  CREATE TABLE IF NOT EXISTS bea_schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

export async function loadMigrations(): Promise<readonly MigrationDefinition[]> {
  return Promise.all(
    migrationFiles.map(async (id) => {
      // Convert through the serialized href because a URL constructed by a Next/Webpack
      // server bundle may come from a different JavaScript realm than Node's fs module.
      const migrationPath = fileURLToPath(new URL(`../migrations/${id}`, import.meta.url).href);
      const sql = await readFile(migrationPath, "utf8");
      return {
        id,
        sql,
        checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
      };
    }),
  );
}

export async function migrateDatabase(database: DatabaseAdapter): Promise<MigrationResult> {
  const migrations = await loadMigrations();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    await database.transaction(async (transaction) => {
      if (database.kind === "postgres") {
        await transaction.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [
          postgresMigrationLockClassId,
          postgresMigrationLockObjectId,
        ]);
      }
      await transaction.execute(migrationLedgerSql);
      const existing = await transaction.query<{ checksum: string }>(
        "SELECT checksum FROM bea_schema_migrations WHERE id = $1",
        [migration.id],
      );
      const prior = existing.rows.at(0);
      if (prior) {
        if (prior.checksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch for ${migration.id}.`);
        }
        alreadyApplied.push(migration.id);
        return;
      }
      await transaction.execute(migration.sql);
      await transaction.query("INSERT INTO bea_schema_migrations (id, checksum) VALUES ($1, $2)", [
        migration.id,
        migration.checksum,
      ]);
      applied.push(migration.id);
    });
  }
  return { applied, alreadyApplied };
}

export interface MigrationVerificationResult {
  readonly current: string;
  readonly verified: readonly string[];
}

export async function verifyMigrations(
  database: DatabaseAdapter,
): Promise<MigrationVerificationResult> {
  const expected = await loadMigrations();
  const result = await database.query<{ id: string; checksum: string }>(
    "SELECT id, checksum FROM bea_schema_migrations ORDER BY id",
  );
  const actual = new Map(result.rows.map((row) => [row.id, row.checksum]));
  const expectedIds = new Set(expected.map((migration) => migration.id));
  for (const migration of expected) {
    const checksum = actual.get(migration.id);
    if (checksum === undefined)
      throw new Error(`Required migration ${migration.id} is not applied.`);
    if (checksum !== migration.checksum) {
      throw new Error(`Migration checksum mismatch for ${migration.id}.`);
    }
  }
  const unexpected = [...actual.keys()].filter((id) => !expectedIds.has(id));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected migration ledger entries: ${unexpected.join(", ")}.`);
  }
  return {
    current: expected.at(-1)?.id ?? "none",
    verified: expected.map((migration) => migration.id),
  };
}
