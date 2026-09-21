import { createHash } from "node:crypto";
import {
  ARTIFACT_BRAND_POLICY_SETTING_KEY,
  DEFAULT_ARTIFACT_BRAND_POLICY,
  DEFAULT_EXECUTIVE_PERSONA_POLICY,
  DEFAULT_EXECUTIVE_PROFILE,
  DEMO_ROLE_IDS,
  EXECUTIVE_PERSONA_POLICY_SETTING_KEY,
  EXECUTIVE_PROFILE_SETTING_KEY,
  type RoleId,
} from "@bea/domain";
import { PERMISSIONS, ROLE_PERMISSION_MATRIX, type Permission } from "@bea/security";
import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";
import {
  AI_PROVIDER_SETTINGS_KEY,
  PRODUCTION_AI_PROVIDER_SETTINGS,
} from "./ai-provider-repository.js";
import { FEATURE_FLAG_SEEDS } from "./seed.js";

export const SYSTEM_SEED_ID = "cpl-system-v1";
export const SYSTEM_SEED_TIMESTAMP = "2026-08-31T00:00:00.000Z";

const roleIds: Readonly<Record<RoleId, string>> = {
  [DEMO_ROLE_IDS.OWNER_ADMIN]: "20000000-0000-4000-8000-000000000001",
  [DEMO_ROLE_IDS.SALES]: "20000000-0000-4000-8000-000000000002",
  [DEMO_ROLE_IDS.OPERATIONS]: "20000000-0000-4000-8000-000000000003",
  [DEMO_ROLE_IDS.EXECUTIVE_READONLY]: "20000000-0000-4000-8000-000000000004",
  [DEMO_ROLE_IDS.INTEGRATION_ADMIN]: "20000000-0000-4000-8000-000000000005",
};

const roleNames: Readonly<Record<RoleId, string>> = {
  [DEMO_ROLE_IDS.OWNER_ADMIN]: "Owner / Administrator",
  [DEMO_ROLE_IDS.SALES]: "Sales",
  [DEMO_ROLE_IDS.OPERATIONS]: "Operations",
  [DEMO_ROLE_IDS.EXECUTIVE_READONLY]: "Read-only Executive",
  [DEMO_ROLE_IDS.INTEGRATION_ADMIN]: "Integration Administrator",
};

const systemSettings = [
  {
    id: "50000000-0000-4000-8000-000000000001",
    key: "product.display-name",
    value: "Cyber Pirate Labs",
    description: "Application display name.",
    sensitivity: "public",
  },
  {
    id: "50000000-0000-4000-8000-000000000002",
    key: "product.name",
    value: "CPL Command Center",
    description: "Application product name.",
    sensitivity: "public",
  },
  {
    id: "50000000-0000-4000-8000-000000000004",
    key: "runtime.demo-mode",
    value: false,
    description: "Production system seed disables Demo runtime behavior.",
    sensitivity: "internal",
  },
  {
    id: "50000000-0000-4000-8000-000000000005",
    key: AI_PROVIDER_SETTINGS_KEY,
    value: PRODUCTION_AI_PROVIDER_SETTINGS,
    description: "Production OpenAI provider and workload-routing policy.",
    sensitivity: "internal",
  },
  {
    id: "50000000-0000-4000-8000-000000000006",
    key: EXECUTIVE_PROFILE_SETTING_KEY,
    value: DEFAULT_EXECUTIVE_PROFILE,
    description: "Unconfigured executive profile; no personal defaults.",
    sensitivity: "secret",
  },
  {
    id: "50000000-0000-4000-8000-000000000007",
    key: EXECUTIVE_PERSONA_POLICY_SETTING_KEY,
    value: DEFAULT_EXECUTIVE_PERSONA_POLICY,
    description: "Versioned server-owned assistant persona policy.",
    sensitivity: "internal",
  },
  {
    id: "50000000-0000-4000-8000-000000000008",
    key: ARTIFACT_BRAND_POLICY_SETTING_KEY,
    value: DEFAULT_ARTIFACT_BRAND_POLICY,
    description: "Deterministic application-owned CPL artifact brand policy.",
    sensitivity: "internal",
  },
] as const satisfies readonly {
  readonly id: string;
  readonly key: string;
  readonly value: unknown;
  readonly description: string;
  readonly sensitivity: "public" | "internal" | "secret";
}[];

const workflowDefinitions = [
  {
    key: "foundation.system-health-check",
    displayName: "Foundation system health check",
    definitionVersion: 1,
  },
] as const;

const systemIntegrationConnections = [
  {
    id: "60000000-0000-4000-8000-000000000001",
    providerType: "ai",
    displayName: "OpenAI",
    requiredPermissions: ["ai.run", "integration.manage", "settings.manage"],
  },
] as const;

function stablePermissionId(key: Permission): string {
  const digest = createHash("sha256").update(`bea-demo-permission:${key}`, "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const systemSeedManifest = {
  roles: Object.values(DEMO_ROLE_IDS).map((key) => ({
    key,
    id: roleIds[key],
    name: roleNames[key],
  })),
  permissions: Object.values(PERMISSIONS).map((key) => ({ key, id: stablePermissionId(key) })),
  grants: Object.fromEntries(
    Object.values(DEMO_ROLE_IDS).map((key) => [key, [...ROLE_PERMISSION_MATRIX[key]]]),
  ),
  featureFlags: FEATURE_FLAG_SEEDS,
  settings: systemSettings,
  workflows: workflowDefinitions,
  integrations: systemIntegrationConnections,
};

export const SYSTEM_SEED_CHECKSUM = createHash("sha256")
  .update(JSON.stringify(systemSeedManifest), "utf8")
  .digest("hex");

export interface SystemSeedSummary {
  readonly id: typeof SYSTEM_SEED_ID;
  readonly checksum: string;
  readonly applied: boolean;
  readonly roles: number;
  readonly permissions: number;
  readonly featureFlags: number;
  readonly settings: number;
  readonly workflowDefinitions: number;
  readonly integrations: number;
}

export interface SystemSeedVerification {
  readonly id: typeof SYSTEM_SEED_ID;
  readonly checksum: string;
  readonly verified: true;
}

function summary(applied: boolean): SystemSeedSummary {
  return {
    id: SYSTEM_SEED_ID,
    checksum: SYSTEM_SEED_CHECKSUM,
    applied,
    roles: Object.values(DEMO_ROLE_IDS).length,
    permissions: Object.values(PERMISSIONS).length,
    featureFlags: FEATURE_FLAG_SEEDS.length,
    settings: systemSettings.length,
    workflowDefinitions: workflowDefinitions.length,
    integrations: systemIntegrationConnections.length,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function assertSystemSeedRows(executor: SqlExecutor): Promise<void> {
  for (const key of Object.values(DEMO_ROLE_IDS)) {
    const role = await executor.query<{ id: string; name: string }>(
      "SELECT id::text AS id,name FROM roles WHERE key=$1 AND status='active'",
      [key],
    );
    if (role.rows[0]?.id !== roleIds[key] || role.rows[0]?.name !== roleNames[key]) {
      throw new Error(`Production system role ${key} is missing or changed.`);
    }
  }
  for (const permission of Object.values(PERMISSIONS)) {
    const row = await executor.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM permissions WHERE key=$1 AND status='active'",
      [permission],
    );
    if (Number(row.rows[0]?.count ?? 0) !== 1) {
      throw new Error(`Production permission ${permission} is missing or changed.`);
    }
  }
  for (const roleKey of Object.values(DEMO_ROLE_IDS)) {
    for (const permission of ROLE_PERMISSION_MATRIX[roleKey]) {
      const grant = await executor.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM role_permissions rp
         JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id
         WHERE r.key=$1 AND p.key=$2`,
        [roleKey, permission],
      );
      if (Number(grant.rows[0]?.count ?? 0) !== 1) {
        throw new Error(`Production grant ${roleKey}:${permission} is missing.`);
      }
    }
  }
  for (const [key] of FEATURE_FLAG_SEEDS) {
    const flag = await executor.query<{ enabled: boolean; requirement_status: string }>(
      "SELECT enabled,requirement_status FROM feature_flags WHERE key=$1",
      [key],
    );
    if (flag.rows[0]?.enabled !== false || flag.rows[0]?.requirement_status !== "DEFERRED") {
      throw new Error(`Production feature flag ${key} is missing or changed.`);
    }
  }
  for (const setting of systemSettings) {
    const row = await executor.query<{ value_json: unknown; sensitivity: string }>(
      "SELECT value_json,sensitivity FROM system_settings WHERE key=$1",
      [setting.key],
    );
    const value = row.rows[0]?.value_json;
    let normalizedValue = value;
    if (typeof value === "string") {
      try {
        normalizedValue = JSON.parse(value);
      } catch {
        normalizedValue = value;
      }
    }
    if (setting.key === AI_PROVIDER_SETTINGS_KEY) {
      const providerSettings = normalizedValue as {
        readonly mode?: unknown;
        readonly defaultTextModel?: unknown;
      };
      if (
        row.rows[0]?.sensitivity !== setting.sensitivity ||
        !["openai", "hybrid"].includes(String(providerSettings?.mode ?? "")) ||
        providerSettings?.defaultTextModel === "deterministic-demo-router"
      ) {
        throw new Error(`Production system setting ${setting.key} is missing or unsafe.`);
      }
      continue;
    }
    if (
      row.rows[0]?.sensitivity !== setting.sensitivity ||
      canonicalJson(normalizedValue) !== canonicalJson(setting.value)
    ) {
      throw new Error(`Production system setting ${setting.key} is missing or changed.`);
    }
  }
  for (const workflow of workflowDefinitions) {
    const row = await executor.query<{ definition_version: number; enabled: boolean }>(
      "SELECT definition_version,enabled FROM workflow_definitions WHERE key=$1",
      [workflow.key],
    );
    if (
      Number(row.rows[0]?.definition_version) !== workflow.definitionVersion ||
      row.rows[0]?.enabled !== true
    ) {
      throw new Error(`Production workflow definition ${workflow.key} is missing or changed.`);
    }
  }
  for (const integration of systemIntegrationConnections) {
    const row = await executor.query<{
      mode: string;
      connection_status: string;
      requirement_status: string;
      test_mode: boolean;
      mock_mode: boolean;
    }>(
      `SELECT mode,connection_status,requirement_status,test_mode,mock_mode
       FROM integration_connections WHERE provider_type=$1`,
      [integration.providerType],
    );
    if (
      row.rows[0]?.mode !== "live" ||
      !["not-configured", "connected", "degraded", "failed", "disabled"].includes(
        row.rows[0]?.connection_status ?? "",
      ) ||
      !["BLOCKED", "CONNECTED"].includes(row.rows[0]?.requirement_status ?? "") ||
      row.rows[0]?.test_mode !== false ||
      row.rows[0]?.mock_mode !== false
    ) {
      throw new Error(`Production integration ${integration.providerType} is missing or changed.`);
    }
  }
}

export async function verifySystemSeed(database: DatabaseAdapter): Promise<SystemSeedVerification> {
  const ledger = await database.query<{ checksum: string }>(
    "SELECT checksum FROM bea_system_seed_versions WHERE id=$1",
    [SYSTEM_SEED_ID],
  );
  if (ledger.rows[0]?.checksum !== SYSTEM_SEED_CHECKSUM) {
    throw new Error(`Production system seed ${SYSTEM_SEED_ID} is missing or has checksum drift.`);
  }
  await assertSystemSeedRows(database);
  return { id: SYSTEM_SEED_ID, checksum: SYSTEM_SEED_CHECKSUM, verified: true };
}

export async function seedSystemDatabase(database: DatabaseAdapter): Promise<SystemSeedSummary> {
  return database.transaction(async (transaction) => {
    const ledger = await transaction.query<{ checksum: string }>(
      "SELECT checksum FROM bea_system_seed_versions WHERE id=$1",
      [SYSTEM_SEED_ID],
    );
    if (ledger.rows[0]) {
      if (ledger.rows[0].checksum !== SYSTEM_SEED_CHECKSUM) {
        throw new Error(`Production system seed checksum mismatch for ${SYSTEM_SEED_ID}.`);
      }
      await assertSystemSeedRows(transaction);
      return summary(false);
    }

    const permissionIds = new Map<Permission, string>();
    for (const roleKey of Object.values(DEMO_ROLE_IDS)) {
      await transaction.query(
        `INSERT INTO roles (id,key,name,description,status,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,'active',$5,$5,1)
         ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,
         status='active',updated_at=EXCLUDED.updated_at`,
        [
          roleIds[roleKey],
          roleKey,
          roleNames[roleKey],
          `Production ${roleNames[roleKey]} role.`,
          SYSTEM_SEED_TIMESTAMP,
        ],
      );
    }
    for (const permission of Object.values(PERMISSIONS)) {
      const persisted = await transaction.query<{ id: string }>(
        `INSERT INTO permissions (id,key,name,description,status,created_at,updated_at,version)
         VALUES ($1,$2,$2,$3,'active',$4,$4,1)
         ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,
         status='active',updated_at=EXCLUDED.updated_at RETURNING id::text AS id`,
        [
          stablePermissionId(permission),
          permission,
          `Allows ${permission}.`,
          SYSTEM_SEED_TIMESTAMP,
        ],
      );
      const id = persisted.rows[0]?.id;
      if (!id) throw new Error(`Permission ${permission} was not persisted.`);
      permissionIds.set(permission, id);
    }
    for (const roleKey of Object.values(DEMO_ROLE_IDS)) {
      for (const permission of ROLE_PERMISSION_MATRIX[roleKey]) {
        await transaction.query(
          `INSERT INTO role_permissions (role_id,permission_id,created_at)
           VALUES ($1,$2,$3) ON CONFLICT (role_id,permission_id) DO NOTHING`,
          [roleIds[roleKey], permissionIds.get(permission), SYSTEM_SEED_TIMESTAMP],
        );
      }
    }
    for (const [index, [key, displayName]] of FEATURE_FLAG_SEEDS.entries()) {
      await transaction.query(
        `INSERT INTO feature_flags
         (id,key,display_name,description,enabled,requirement_status,created_at,updated_at,version)
         VALUES ($1,$2,$3,$4,FALSE,'DEFERRED',$5,$5,1)
         ON CONFLICT (key) DO UPDATE SET display_name=EXCLUDED.display_name,
         description=EXCLUDED.description,enabled=FALSE,requirement_status='DEFERRED',
         updated_at=EXCLUDED.updated_at`,
        [
          `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          key,
          displayName,
          `${displayName} is disabled until explicitly configured and verified.`,
          SYSTEM_SEED_TIMESTAMP,
        ],
      );
    }
    for (const setting of systemSettings) {
      await transaction.query(
        `INSERT INTO system_settings
         (id,key,value_json,description,sensitivity,created_at,updated_at,version)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$6,1)
         ON CONFLICT (key) DO UPDATE SET value_json=EXCLUDED.value_json,
         description=EXCLUDED.description,sensitivity=EXCLUDED.sensitivity,
         updated_at=EXCLUDED.updated_at`,
        [
          setting.id,
          setting.key,
          JSON.stringify(setting.value),
          setting.description,
          setting.sensitivity,
          SYSTEM_SEED_TIMESTAMP,
        ],
      );
    }
    for (const workflow of workflowDefinitions) {
      await transaction.query(
        `INSERT INTO workflow_definitions
         (key,display_name,definition_version,enabled,created_at,updated_at)
         VALUES ($1,$2,$3,TRUE,$4,$4)
         ON CONFLICT (key) DO UPDATE SET display_name=EXCLUDED.display_name,
         definition_version=EXCLUDED.definition_version,enabled=TRUE,updated_at=EXCLUDED.updated_at`,
        [workflow.key, workflow.displayName, workflow.definitionVersion, SYSTEM_SEED_TIMESTAMP],
      );
    }
    for (const integration of systemIntegrationConnections) {
      await transaction.query(
        `INSERT INTO integration_connections
         (id,provider_type,display_name,mode,connection_status,requirement_status,
          configuration_completeness,required_permissions,test_mode,mock_mode,created_at,updated_at,version)
         VALUES ($1,$2,$3,'live','not-configured','BLOCKED',0,$4::jsonb,FALSE,FALSE,$5,$5,1)
         ON CONFLICT (provider_type) DO NOTHING`,
        [
          integration.id,
          integration.providerType,
          integration.displayName,
          JSON.stringify(integration.requiredPermissions),
          SYSTEM_SEED_TIMESTAMP,
        ],
      );
    }
    await transaction.query(
      "INSERT INTO bea_system_seed_versions (id,checksum,applied_at) VALUES ($1,$2,$3)",
      [SYSTEM_SEED_ID, SYSTEM_SEED_CHECKSUM, SYSTEM_SEED_TIMESTAMP],
    );
    return summary(true);
  });
}
