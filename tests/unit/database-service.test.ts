import { describe, expect, it, vi } from "vitest";
import {
  runDatabaseCommand,
  type DatabaseCommandDependencies,
} from "../../packages/database/src/cli/database-command.js";
import {
  runDatabaseService,
  type CommandRunner,
} from "../../packages/database/src/cli/database-service.js";
import type { DatabaseAdapter, SqlExecutor } from "../../packages/database/src/adapter.js";
import { migrateDatabase } from "../../packages/database/src/migrations.js";

describe("database service command", () => {
  it("is an explicit no-op only for embedded PGlite", async () => {
    const run = vi.fn(async () => 0);
    const runner: CommandRunner = { run };
    const demo = await runDatabaseService(
      "start",
      { NODE_ENV: "test", APP_MODE: "demo", DATABASE_DRIVER: "pglite" },
      runner,
    );
    expect(demo.status).toBe("embedded-no-separate-service");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs guarded docker compose for PostgreSQL", async () => {
    const run = vi.fn(async () => 0);
    const result = await runDatabaseService(
      "start",
      {
        NODE_ENV: "test",
        APP_MODE: "production",
        APP_BASE_URL: "https://command-center.example.invalid",
        DATABASE_DRIVER: "postgres",
        DATABASE_URL: "postgresql://database.example.invalid/bea",
        DEMO_AUTH_ENABLED: "false",
        SESSION_SECRET: "example-only-session-secret-32-characters",
        WORKER_QUEUE_ADAPTER: "pg-boss",
      },
      { run },
    );
    expect(result).toMatchObject({ adapter: "postgres", status: "started" });
    expect(run).toHaveBeenCalledOnce();
    const [executable, arguments_] = run.mock.calls[0] ?? [];
    expect(executable).toBe("docker");
    expect(arguments_?.slice(-6)).toEqual([
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "60",
      "postgres",
    ]);
  });

  it("takes the PostgreSQL transaction-scoped advisory lock before migration inspection", async () => {
    const events: string[] = [];
    const transaction = {
      query: vi.fn(async (sql: string) => {
        events.push(`query:${sql}`);
        return { rows: [], rowCount: 0 };
      }),
      execute: vi.fn(async (sql: string) => {
        events.push(sql.includes("bea_schema_migrations") ? "execute:ledger" : "execute:migration");
      }),
    } as unknown as SqlExecutor;
    const database = {
      kind: "postgres",
      query: vi.fn(),
      execute: vi.fn(async () => undefined),
      transaction: vi.fn(async (operation: (executor: SqlExecutor) => Promise<unknown>) =>
        operation(transaction),
      ),
      health: vi.fn(),
      close: vi.fn(),
    } as unknown as DatabaseAdapter;

    expect(await migrateDatabase(database)).toEqual({
      applied: [
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
      ],
      alreadyApplied: [],
    });
    const lockIndex = events.findIndex((event) => event.includes("pg_advisory_xact_lock"));
    const inspectionIndex = events.findIndex((event) => event.includes("SELECT checksum"));
    const applicationIndex = events.indexOf("execute:migration");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(inspectionIndex).toBeGreaterThan(lockIndex);
    expect(applicationIndex).toBeGreaterThan(inspectionIndex);
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("refuses a production demo reset before constructing a database adapter", async () => {
    const createDatabase = vi.fn(() => {
      throw new Error("database adapter must not be constructed");
    });
    const dependencies: DatabaseCommandDependencies = { createDatabase };

    await expect(
      runDatabaseCommand(
        "demo-reset",
        {
          NODE_ENV: "production",
          APP_MODE: "production",
          APP_BASE_URL: "https://command-center.example.invalid",
          DATABASE_DRIVER: "postgres",
          DATABASE_URL: "postgresql://database.example.invalid/bea",
          DEMO_AUTH_ENABLED: "false",
          SESSION_SECRET: "example-only-session-secret-32-characters",
          WORKER_QUEUE_ADAPTER: "pg-boss",
          DEMO_RESET_CONFIRMATION: "RESET_BEA_DEMO_DATA",
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "CPL_PRODUCT_RUNTIME_NOT_READY" });
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("refuses deterministic demo seed in production before constructing an adapter", async () => {
    const createDatabase = vi.fn(() => {
      throw new Error("database adapter must not be constructed");
    });

    await expect(
      runDatabaseCommand(
        "seed",
        {
          NODE_ENV: "production",
          APP_MODE: "production",
          APP_BASE_URL: "https://command-center.example.invalid",
          DATABASE_DRIVER: "postgres",
          DATABASE_URL: "postgresql://database.example.invalid/bea",
          DEMO_AUTH_ENABLED: "false",
          SESSION_SECRET: "example-only-session-secret-32-characters",
          WORKER_QUEUE_ADAPTER: "pg-boss",
        },
        { createDatabase },
      ),
    ).rejects.toMatchObject({ code: "CPL_PRODUCT_RUNTIME_NOT_READY" });
    expect(createDatabase).not.toHaveBeenCalled();
  });
});
