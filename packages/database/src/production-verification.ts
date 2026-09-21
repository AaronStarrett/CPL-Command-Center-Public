import type { ServerEnvironment } from "@bea/config";
import type { DatabaseAdapter } from "./adapter.js";
import { verifyMigrations, type MigrationVerificationResult } from "./migrations.js";
import { verifySystemSeed, type SystemSeedVerification } from "./system-seed.js";

export interface ProductionDatabaseVerification {
  readonly migration: MigrationVerificationResult;
  readonly systemSeed: SystemSeedVerification;
  readonly ownerProvider: "local-owner" | "microsoft-entra";
  readonly ownerReady: true;
  readonly demoUsers: 0;
  readonly demoIntegrations: 0;
}

export interface EmptyProductionBootstrapVerification {
  readonly verified: true;
  readonly businessRecordCount: 0;
}

const productionOpenAiIntegration = {
  id: "60000000-0000-4000-8000-000000000001",
  providerType: "ai",
  displayName: "OpenAI",
  requiredPermissions: ["ai.run", "integration.manage", "settings.manage"],
} as const;

export async function verifyNoProductionBusinessRecords(
  database: DatabaseAdapter,
): Promise<EmptyProductionBootstrapVerification> {
  const result = await database.query<{ count: string | number }>(
    `SELECT
       (SELECT COUNT(*) FROM companies) +
       (SELECT COUNT(*) FROM contacts) +
       (SELECT COUNT(*) FROM leads) +
       (SELECT COUNT(*) FROM lead_parties) +
       (SELECT COUNT(*) FROM lead_status_events) +
       (SELECT COUNT(*) FROM tasks) +
       (SELECT COUNT(*) FROM activities) +
       (SELECT COUNT(*) FROM notifications) +
       (SELECT COUNT(*) FROM conversations) +
       (SELECT COUNT(*) FROM assistant_messages) +
       (SELECT COUNT(*) FROM workspace_artifacts) +
       (SELECT COUNT(*) FROM suggested_actions) +
       (SELECT COUNT(*) FROM action_approvals) +
       (SELECT COUNT(*) FROM action_executions) +
       (SELECT COUNT(*) FROM workflow_runs) +
       (SELECT COUNT(*) FROM workflow_step_runs) +
       (SELECT COUNT(*) FROM generated_artifacts) +
       (SELECT COUNT(*) FROM ai_response_runs) +
       (SELECT COUNT(*) FROM ai_message_citations) +
       (SELECT COUNT(*) FROM ai_tool_calls) +
       (SELECT COUNT(*) FROM ai_realtime_sessions) +
       (SELECT COUNT(*) FROM ai_usage_records) +
       (SELECT COUNT(*) FROM digital_workforce_departments) +
       (SELECT COUNT(*) FROM digital_workforce_teams) +
       (SELECT COUNT(*) FROM digital_workforce_agents) +
       (SELECT COUNT(*) FROM digital_workforce_agent_versions) +
       (SELECT COUNT(*) FROM digital_workforce_runs) +
       (SELECT COUNT(*) FROM digital_workforce_run_steps) +
       (SELECT COUNT(*) FROM digital_workforce_handoffs) +
       (SELECT COUNT(*) FROM digital_workforce_run_events) +
       (SELECT COUNT(*) FROM projects) +
       (SELECT COUNT(*) FROM inspections) +
       (SELECT COUNT(*) FROM inspection_submissions) +
       (SELECT COUNT(*) FROM inspection_reports) +
       (SELECT COUNT(*) FROM report_versions) +
       (SELECT COUNT(*) FROM report_deliveries) +
       (SELECT COUNT(*) FROM exception_cases) AS count`,
  );
  if (Number(result.rows[0]?.count ?? 0) !== 0) {
    throw new Error("Production bootstrap found pre-existing business or assistant records.");
  }
  return { verified: true, businessRecordCount: 0 };
}

export async function verifyEmptyProductionBootstrap(
  database: DatabaseAdapter,
): Promise<EmptyProductionBootstrapVerification> {
  const verification = await verifyNoProductionBusinessRecords(database);
  const identityState = await database.query<{
    users: string | number;
    auth_identities: string | number;
    local_owner_credentials: string | number;
    sessions: string | number;
    user_roles: string | number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM auth_identities) AS auth_identities,
       (SELECT COUNT(*) FROM local_owner_credentials) AS local_owner_credentials,
       (SELECT COUNT(*) FROM sessions) AS sessions,
       (SELECT COUNT(*) FROM user_roles) AS user_roles`,
  );
  const state = identityState.rows[0];
  if (
    Number(state?.users ?? 0) !== 0 ||
    Number(state?.auth_identities ?? 0) !== 0 ||
    Number(state?.local_owner_credentials ?? 0) !== 0 ||
    Number(state?.sessions ?? 0) !== 0 ||
    Number(state?.user_roles ?? 0) !== 0
  ) {
    throw new Error("Production bootstrap found pre-existing identity or session records.");
  }
  return verification;
}

function assertProductionEnvironment(environment: ServerEnvironment): void {
  if (
    environment.runtimeMode !== "production" ||
    environment.appMode !== "production" ||
    environment.demoAuthEnabled ||
    environment.databaseDriver !== "postgres" ||
    new URL(environment.appBaseUrl).protocol !== "https:"
  ) {
    throw new Error("Production database verification requires the validated production profile.");
  }
}

export async function verifyProductionDatabase(
  database: DatabaseAdapter,
  environment: ServerEnvironment,
): Promise<ProductionDatabaseVerification> {
  assertProductionEnvironment(environment);
  if (database.kind !== "postgres") {
    throw new Error("Production database verification requires PostgreSQL.");
  }
  const migration = await verifyMigrations(database);
  const systemSeed = await verifySystemSeed(database);
  await verifyNoProductionBusinessRecords(database);
  const [demoUsers, demoIntegrations] = await Promise.all([
    database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM users WHERE persona_key IS NOT NULL",
    ),
    database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM integration_connections WHERE mock_mode=TRUE OR test_mode=TRUE",
    ),
  ]);
  const demoUserCount = Number(demoUsers.rows[0]?.count ?? 0);
  const demoIntegrationCount = Number(demoIntegrations.rows[0]?.count ?? 0);
  if (demoUserCount !== 0 || demoIntegrationCount !== 0) {
    throw new Error("Production verification found Demo identities or simulated integrations.");
  }

  const integrationState = await database.query<{
    total: string | number;
    expected: string | number;
  }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (
         WHERE id=$1::uuid
           AND provider_type=$2
           AND display_name=$3
           AND mode='live'
           AND test_mode=FALSE
           AND mock_mode=FALSE
           AND required_permissions=$4::jsonb
       ) AS expected
     FROM integration_connections`,
    [
      productionOpenAiIntegration.id,
      productionOpenAiIntegration.providerType,
      productionOpenAiIntegration.displayName,
      JSON.stringify(productionOpenAiIntegration.requiredPermissions),
    ],
  );
  if (
    Number(integrationState.rows[0]?.total ?? 0) !== 1 ||
    Number(integrationState.rows[0]?.expected ?? 0) !== 1
  ) {
    throw new Error("Production integrations must contain only the system OpenAI connection.");
  }

  const ownerProvider =
    environment.deploymentProfile === "local-live" ? "local-owner" : "microsoft-entra";
  const localOwnerSql = [
    "SELECT COUNT(*) AS count FROM users u",
    "JOIN auth_identities ai ON ai.user_id=u.id AND ai.provider='local-owner'",
    "JOIN local_owner_credentials loc ON loc.user_id=u.id AND loc.username=ai.subject",
    "JOIN user_roles ur ON ur.user_id=u.id",
    "JOIN roles r ON r.id=ur.role_id AND r.key='owner-admin' AND r.status='active'",
    "WHERE u.status='active' AND u.archived_at IS NULL AND u.persona_key IS NULL",
    "AND u.email IS NULL AND u.display_name='Workspace Owner'",
    "AND u.title='Chief Executive Officer'",
  ].join(" ");
  const entraOwnerSql = [
    "SELECT COUNT(*) AS count FROM users u",
    "JOIN auth_identities ai ON ai.user_id=u.id AND ai.provider='microsoft-entra'",
    "JOIN user_roles ur ON ur.user_id=u.id",
    "JOIN roles r ON r.id=ur.role_id AND r.key='owner-admin' AND r.status='active'",
    "WHERE u.status='active' AND u.archived_at IS NULL AND u.persona_key IS NULL",
  ].join(" ");
  const [owner, users, identities, localOwnerCredentials] = await Promise.all([
    database.query<{ count: string | number }>(
      ownerProvider === "local-owner" ? localOwnerSql : entraOwnerSql,
    ),
    database.query<{ count: string | number }>("SELECT COUNT(*) AS count FROM users"),
    database.query<{ count: string | number }>("SELECT COUNT(*) AS count FROM auth_identities"),
    database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM local_owner_credentials",
    ),
  ]);
  const expectedLocalOwnerCredentials = ownerProvider === "local-owner" ? 1 : 0;
  if (
    Number(owner.rows[0]?.count ?? 0) !== 1 ||
    Number(users.rows[0]?.count ?? 0) !== 1 ||
    Number(identities.rows[0]?.count ?? 0) !== 1 ||
    Number(localOwnerCredentials.rows[0]?.count ?? 0) !== expectedLocalOwnerCredentials
  ) {
    throw new Error(
      "Production authentication must contain exactly one active " +
        ownerProvider +
        " Owner and no unexpected users or providers.",
    );
  }
  return {
    migration,
    systemSeed,
    ownerProvider,
    ownerReady: true,
    demoUsers: 0,
    demoIntegrations: 0,
  };
}
