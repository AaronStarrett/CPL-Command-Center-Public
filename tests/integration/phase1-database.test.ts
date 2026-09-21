import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  MERIDIAN_CLIENT,
  type RoleId,
  type SuggestedAction,
} from "../../packages/domain/src/index.js";
import {
  PGliteDatabaseAdapter,
  SqlFoundationRepository,
  SqlPhase1Repository,
  TASK_ACTION_CONFIRMATION,
  loadMigrations,
  migrateDatabase,
  seedDatabase,
  type ApproveAndExecuteTaskActionInput,
} from "../../packages/database/src/index.js";
import {
  PERMISSIONS,
  PersistentAuthorizationService,
  type Permission,
} from "../../packages/security/src/index.js";
import { APPROVED_CURRENT_ROLE_PERMISSIONS } from "../approved-phase1-rbac.js";

const OWNER_USER_ID = DEMO_PERSONAS[0].id;
const SALES_USER_ID = DEMO_PERSONAS[1].id;
const OPERATIONS_USER_ID = DEMO_PERSONAS[2].id;
const EXECUTIVE_USER_ID = DEMO_PERSONAS[3].id;
const INTEGRATION_ADMIN_USER_ID = DEMO_PERSONAS[4].id;

const COMPANY_ID = "90000000-0000-4000-8000-000000000001";
const OTHER_COMPANY_ID = "90000000-0000-4000-8000-000000000002";
const CONTACT_ID = "91000000-0000-4000-8000-000000000001";
const SALES_TASK_ID = "92000000-0000-4000-8000-000000000001";
const OPERATIONS_TASK_ID = "92000000-0000-4000-8000-000000000002";
const OWNER_CONVERSATION_ID = "95000000-0000-4000-8000-000000000001";
const OWNER_ARTIFACT_ID = "97000000-0000-4000-8000-000000000001";
const OWNER_PENDING_ACTION_ID = "98000000-0000-4000-8000-000000000001";
const PHASE1_TEST_TIMEOUT_MS = 60_000;

const LEGACY_ROLE_IDS: Readonly<Record<RoleId, string>> = {
  [DEMO_ROLE_IDS.OWNER_ADMIN]: "20000000-0000-4000-8000-000000000001",
  [DEMO_ROLE_IDS.SALES]: "20000000-0000-4000-8000-000000000002",
  [DEMO_ROLE_IDS.OPERATIONS]: "20000000-0000-4000-8000-000000000003",
  [DEMO_ROLE_IDS.EXECUTIVE_READONLY]: "20000000-0000-4000-8000-000000000004",
  [DEMO_ROLE_IDS.INTEGRATION_ADMIN]: "20000000-0000-4000-8000-000000000005",
};

const LEGACY_PHASE0_PERMISSIONS = [
  PERMISSIONS.HOME_VIEW,
  PERMISSIONS.LEADS_VIEW,
  PERMISSIONS.PROPOSALS_VIEW,
  PERMISSIONS.PROJECTS_VIEW,
  PERMISSIONS.TASKS_VIEW,
  PERMISSIONS.COMMUNICATIONS_VIEW,
  PERMISSIONS.DOCUMENTS_VIEW,
  PERMISSIONS.ASK_BEA_VIEW,
  PERMISSIONS.REPORTS_VIEW,
  PERMISSIONS.AUTOMATIONS_VIEW,
  PERMISSIONS.INTEGRATIONS_VIEW,
  PERMISSIONS.INTEGRATIONS_MANAGE,
  PERMISSIONS.ADMINISTRATION_VIEW,
  PERMISSIONS.USERS_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.FOUNDATION_WORKFLOW_RUN,
] as const satisfies readonly Permission[];

const LEGACY_PHASE0_ROLE_PERMISSIONS: Readonly<Record<RoleId, readonly Permission[]>> = {
  [DEMO_ROLE_IDS.OWNER_ADMIN]: LEGACY_PHASE0_PERMISSIONS,
  [DEMO_ROLE_IDS.SALES]: [
    PERMISSIONS.HOME_VIEW,
    PERMISSIONS.LEADS_VIEW,
    PERMISSIONS.PROPOSALS_VIEW,
    PERMISSIONS.COMMUNICATIONS_VIEW,
    PERMISSIONS.DOCUMENTS_VIEW,
  ],
  [DEMO_ROLE_IDS.OPERATIONS]: [
    PERMISSIONS.HOME_VIEW,
    PERMISSIONS.PROJECTS_VIEW,
    PERMISSIONS.TASKS_VIEW,
    PERMISSIONS.COMMUNICATIONS_VIEW,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.AUTOMATIONS_VIEW,
    PERMISSIONS.FOUNDATION_WORKFLOW_RUN,
  ],
  [DEMO_ROLE_IDS.EXECUTIVE_READONLY]: [PERMISSIONS.HOME_VIEW, PERMISSIONS.REPORTS_VIEW],
  [DEMO_ROLE_IDS.INTEGRATION_ADMIN]: [
    PERMISSIONS.HOME_VIEW,
    PERMISSIONS.INTEGRATIONS_VIEW,
    PERMISSIONS.INTEGRATIONS_MANAGE,
    PERMISSIONS.ADMINISTRATION_VIEW,
    PERMISSIONS.SETTINGS_MANAGE,
  ],
};

const PHASE1_TABLE_EXPECTATIONS = [
  ["companies", 4],
  ["contacts", 5],
  ["tasks", 4],
  ["activities", 8],
  ["notifications", 3],
  ["conversations", 2],
  ["assistant_messages", 3],
  ["workspace_artifacts", 1],
  ["suggested_actions", 2],
  ["action_approvals", 1],
  ["action_executions", 1],
] as const;

let database!: PGliteDatabaseAdapter;
let repository!: SqlPhase1Repository;

async function phase1TableCounts(): Promise<readonly number[]> {
  return Promise.all(
    PHASE1_TABLE_EXPECTATIONS.map(async ([table]) => {
      const result = await database.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM ${table}`,
      );
      return Number(result.rows[0]?.count ?? 0);
    }),
  );
}

async function createPendingTaskAction(label: string): Promise<SuggestedAction> {
  const conversation = await repository.createConversation({
    ownerUserId: OWNER_USER_ID,
    title: `Synthetic action test ${label}`,
  });
  const result = await repository.createSuggestedAction({
    conversationId: conversation.id,
    requestedByUserId: OWNER_USER_ID,
    actionType: "task.create",
    payload: {
      title: `Confirmed synthetic task ${label}`,
      description: "Integration-test-only task payload.",
      priority: "high",
      assigneeUserId: OWNER_USER_ID,
      companyId: COMPANY_ID,
      contactId: CONTACT_ID,
    },
    requiredPermission: PERMISSIONS.TASK_ACTION_EXECUTE,
    idempotencyKey: `integration:phase1:preview:${label}`,
    correlationId: `integration-phase1-preview-${label}`,
    expiresAt: "2099-12-31T23:59:59.000Z",
  });
  expect(result.reused).toBe(false);
  return result.action;
}

function validExecutionInput(
  action: SuggestedAction,
  label: string,
): ApproveAndExecuteTaskActionInput {
  const executedAt = new Date().toISOString();
  return {
    suggestedActionId: action.id,
    actorUserId: OWNER_USER_ID,
    confirmation: TASK_ACTION_CONFIRMATION,
    permissionRevalidation: {
      permission: PERMISSIONS.TASK_ACTION_EXECUTE,
      allowed: true,
      checkedAt: executedAt,
    },
    additionalPermissionRevalidations: [
      PERMISSIONS.AI_COMMAND_VIEW,
      PERMISSIONS.TASKS_VIEW,
      PERMISSIONS.COMPANIES_VIEW,
      PERMISSIONS.CONTACTS_VIEW,
    ].map((permission) => ({ permission, allowed: true as const, checkedAt: executedAt })),
    idempotencyKey: `integration:phase1:execute:${label}`,
    correlationId: `integration-phase1-execute-${label}`,
    executedAt,
  };
}

beforeAll(async () => {
  database = new PGliteDatabaseAdapter("memory://");
  await migrateDatabase(database);
  await seedDatabase(database);
  repository = new SqlPhase1Repository(database);
}, PHASE1_TEST_TIMEOUT_MS);

afterAll(async () => {
  await database.close();
}, PHASE1_TEST_TIMEOUT_MS);

describe("Phase 1 persistence and security boundaries", () => {
  it(
    "migrates Phase 0 permission identities without retaining unintended role grants",
    async () => {
      const upgradeDatabase = new PGliteDatabaseAdapter("memory://");
      try {
        const migrations = await loadMigrations();
        const phase0Migration = migrations.find(
          (migration) => migration.id === "0001_phase0_foundation.sql",
        );
        const phase1Migration = migrations.find(
          (migration) => migration.id === "0002_phase1_core.sql",
        );
        const phase11Migration = migrations.find(
          (migration) => migration.id === "0003_assistant_message_permissions.sql",
        );
        const phase12Migration = migrations.find(
          (migration) => migration.id === "0004_phase1_2_openai_provider.sql",
        );
        if (!phase0Migration || !phase1Migration || !phase11Migration || !phase12Migration) {
          throw new Error("Phase 0/1 migrations missing.");
        }
        await upgradeDatabase.execute(phase0Migration.sql);

        for (const roleKey of Object.values(DEMO_ROLE_IDS)) {
          await upgradeDatabase.query(
            `INSERT INTO roles (id,key,name,description,status)
             VALUES ($1,$2,$3,$4,'active')`,
            [LEGACY_ROLE_IDS[roleKey], roleKey, roleKey, `Legacy Phase 0 ${roleKey} role.`],
          );
        }

        const legacyPermissionIds = new Map<Permission, string>();
        for (const [index, permission] of LEGACY_PHASE0_PERMISSIONS.entries()) {
          const permissionId = `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
          legacyPermissionIds.set(permission, permissionId);
          await upgradeDatabase.query(
            `INSERT INTO permissions (id,key,name,description,status)
             VALUES ($1,$2,$2,$3,'active')`,
            [permissionId, permission, `Legacy Phase 0 ${permission} permission.`],
          );
        }

        for (const roleKey of Object.values(DEMO_ROLE_IDS)) {
          for (const permission of LEGACY_PHASE0_ROLE_PERMISSIONS[roleKey]) {
            await upgradeDatabase.query(
              "INSERT INTO role_permissions (role_id,permission_id) VALUES ($1,$2)",
              [LEGACY_ROLE_IDS[roleKey], legacyPermissionIds.get(permission)],
            );
          }
        }

        await upgradeDatabase.execute(phase1Migration.sql);
        await upgradeDatabase.execute(phase11Migration.sql);
        await upgradeDatabase.execute(phase12Migration.sql);
        const remainingMigrations = migrations.filter(
          (migration) =>
            ![
              "0001_phase0_foundation.sql",
              "0002_phase1_core.sql",
              "0003_assistant_message_permissions.sql",
              "0004_phase1_2_openai_provider.sql",
            ].includes(migration.id),
        );
        for (const migration of remainingMigrations) {
          await upgradeDatabase.execute(migration.sql);
        }
        await seedDatabase(upgradeDatabase);

        async function authorizationSnapshot() {
          const [permissionRows, grantRows] = await Promise.all([
            upgradeDatabase.query<{ id: string; key: string }>(
              "SELECT id::text AS id,key FROM permissions ORDER BY key",
            ),
            upgradeDatabase.query<{ permission_key: string; role_key: RoleId }>(
              `SELECT r.key AS role_key,p.key AS permission_key
               FROM role_permissions rp
               JOIN roles r ON r.id=rp.role_id
               JOIN permissions p ON p.id=rp.permission_id
               ORDER BY r.key,p.key`,
            ),
          ]);
          return {
            grants: grantRows.rows.map((row) => ({
              permission: row.permission_key,
              role: row.role_key,
            })),
            permissions: permissionRows.rows.map((row) => ({ id: row.id, key: row.key })),
          };
        }

        const first = await authorizationSnapshot();
        expect(first.permissions).toHaveLength(Object.values(PERMISSIONS).length);
        expect(new Set(first.permissions.map((permission) => permission.id)).size).toBe(
          first.permissions.length,
        );
        const persistedPermissionIds = new Map(
          first.permissions.map((permission) => [permission.key, permission.id]),
        );
        for (const [permission, legacyId] of legacyPermissionIds) {
          expect(persistedPermissionIds.get(permission)).toBe(legacyId);
        }
        for (const roleKey of Object.values(DEMO_ROLE_IDS)) {
          const actual = first.grants
            .filter((grant) => grant.role === roleKey)
            .map((grant) => grant.permission);
          expect(actual).toEqual([...APPROVED_CURRENT_ROLE_PERMISSIONS[roleKey]].sort());
        }

        await seedDatabase(upgradeDatabase);
        expect(await authorizationSnapshot()).toEqual(first);
      } finally {
        await upgradeDatabase.close();
      }
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "seeds the exact approved grants and separates all-task reads from mutation",
    async () => {
      const authorization = new PersistentAuthorizationService(
        new SqlFoundationRepository(database),
      );
      for (const persona of DEMO_PERSONAS) {
        const roleId = persona.roleIds[0];
        if (!roleId) throw new Error(`Persona ${persona.key} has no role.`);
        const effective = await database.query<{ key: Permission }>(
          `SELECT DISTINCT p.key
           FROM users u
           JOIN user_roles ur ON ur.user_id=u.id
           JOIN roles r ON r.id=ur.role_id AND r.status='active'
           JOIN role_permissions rp ON rp.role_id=r.id
           JOIN permissions p ON p.id=rp.permission_id AND p.status='active'
           WHERE u.id=$1 AND u.status='active' AND u.archived_at IS NULL
           ORDER BY p.key`,
          [persona.id],
        );
        expect(effective.rows.map((row) => row.key)).toEqual(
          [...APPROVED_CURRENT_ROLE_PERMISSIONS[roleId]].sort(),
        );
      }

      await expect(authorization.taskReadScopeForUser(OWNER_USER_ID)).resolves.toBe("all");
      await expect(authorization.taskReadScopeForUser(SALES_USER_ID)).resolves.toBe("all");
      await expect(authorization.taskReadScopeForUser(OPERATIONS_USER_ID)).resolves.toBe("all");
      await expect(authorization.taskReadScopeForUser(EXECUTIVE_USER_ID)).resolves.toBe("all");
      await expect(authorization.taskReadScopeForUser(INTEGRATION_ADMIN_USER_ID)).resolves.toBe(
        "none",
      );
      await expect(
        authorization.authorizeUser(EXECUTIVE_USER_ID, PERMISSIONS.TASKS_MANAGE),
      ).resolves.toMatchObject({ allowed: false });
      await expect(
        authorization.authorizeUser(EXECUTIVE_USER_ID, PERMISSIONS.TASK_ACTION_EXECUTE),
      ).resolves.toMatchObject({ allowed: false });
      await expect(
        authorization.authorizeUser(INTEGRATION_ADMIN_USER_ID, PERMISSIONS.TASKS_VIEW),
      ).resolves.toMatchObject({ allowed: false });
      await expect(
        authorization.authorizeUser(
          INTEGRATION_ADMIN_USER_ID,
          PERMISSIONS.AI_INTEGRATION_HEALTH_VIEW,
        ),
      ).resolves.toEqual({ allowed: true });

      const assignedCounts = await repository.getDashboardCounts(EXECUTIVE_USER_ID, {
        tasks: true,
        taskScope: "assigned",
      });
      const allCounts = await repository.getDashboardCounts(EXECUTIVE_USER_ID, {
        tasks: true,
        taskScope: "all",
      });
      expect(assignedCounts).toMatchObject({ openTasks: 0, completedTasks: 0 });
      expect(allCounts).toMatchObject({ openTasks: 2, completedTasks: 2 });
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "repeats the synthetic seed without duplication or mutable-state reversal",
    async () => {
      const expectedCounts = PHASE1_TABLE_EXPECTATIONS.map(([, count]) => count);
      expect(await phase1TableCounts()).toEqual(expectedCounts);

      await database.query("UPDATE tasks SET status='completed',completed_at=$2 WHERE id=$1", [
        OPERATIONS_TASK_ID,
        "2026-08-18T20:10:00.000Z",
      ]);
      await database.query("UPDATE notifications SET read_at=$2 WHERE id=$1", [
        "94000000-0000-4000-8000-000000000002",
        "2026-08-18T20:11:00.000Z",
      ]);
      await database.query("UPDATE suggested_actions SET status='denied' WHERE id=$1", [
        OWNER_PENDING_ACTION_ID,
      ]);

      await seedDatabase(database);
      await seedDatabase(database);

      expect(await phase1TableCounts()).toEqual(expectedCounts);
      expect(await repository.getTask(OPERATIONS_TASK_ID)).toMatchObject({
        status: "completed",
        completedAt: "2026-08-18T20:10:00.000Z",
      });
      expect(
        (
          await repository.listNotifications({
            userId: OPERATIONS_USER_ID,
            unreadOnly: false,
          })
        )[0],
      ).toMatchObject({ readAt: "2026-08-18T20:11:00.000Z" });
      expect(
        await repository.getSuggestedAction(OWNER_PENDING_ACTION_ID, OWNER_USER_ID),
      ).toMatchObject({ status: "denied" });
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "reads companies and contacts and records task, activity, notification, and audit changes",
    async () => {
      expect(await repository.listCompanies()).toHaveLength(4);
      expect(await repository.listCompanies({ query: "Northstar", status: "active" })).toEqual([
        expect.objectContaining({ id: COMPANY_ID, name: "Northstar Facade Group" }),
      ]);
      expect(await repository.listCompanies({ query: "Meridian", status: "active" })).toEqual([
        expect.objectContaining({ name: MERIDIAN_CLIENT.companyName }),
      ]);
      expect(await repository.getCompany(COMPANY_ID)).toMatchObject({
        status: "active",
        website: "https://northstar.example.invalid",
      });

      expect(await repository.listContacts({ companyId: COMPANY_ID })).toHaveLength(2);
      expect(await repository.getContact(CONTACT_ID)).toMatchObject({
        companyId: COMPANY_ID,
        firstName: "Morgan",
        lastName: "Demo",
      });
      expect(await repository.listTasks({ assigneeUserId: SALES_USER_ID, status: "open" })).toEqual(
        [expect.objectContaining({ id: SALES_TASK_ID })],
      );

      const task = await repository.createTask({
        id: "a1000000-0000-4000-8000-000000000001",
        title: "Integration synthetic task lifecycle",
        description: "Created and completed only in the PGlite integration test.",
        priority: "urgent",
        assigneeUserId: OWNER_USER_ID,
        companyId: COMPANY_ID,
        contactId: CONTACT_ID,
        createdByUserId: OWNER_USER_ID,
        correlationId: "integration-phase1-task-lifecycle",
        createdAt: "2026-08-18T20:20:00.000Z",
      });
      expect(await repository.getTask(task.id)).toEqual(task);
      expect(await repository.listTasks({ query: "Integration synthetic" })).toEqual([
        expect.objectContaining({ id: task.id }),
      ]);
      expect(await repository.listTasks({ query: "%" })).toEqual([]);

      const completed = await repository.completeTask({
        taskId: task.id,
        actorUserId: OWNER_USER_ID,
        correlationId: "integration-phase1-task-lifecycle",
        completedAt: "2026-08-18T20:21:00.000Z",
        expectedVersion: task.version,
      });
      expect(completed).toMatchObject({ reused: false, task: { status: "completed", version: 2 } });
      expect(
        await repository.completeTask({
          taskId: task.id,
          actorUserId: OWNER_USER_ID,
          completedAt: "2026-08-18T20:22:00.000Z",
        }),
      ).toMatchObject({
        reused: true,
        task: { id: task.id, completedAt: completed.task.completedAt },
      });

      const activities = await repository.listActivities({ taskId: task.id });
      expect(activities.map((activity) => activity.type).sort()).toEqual([
        "task.completed",
        "task.created",
      ]);
      const audit = await database.query<{ event_type: string }>(
        "SELECT event_type FROM audit_logs WHERE resource_type='task' AND resource_id=$1 ORDER BY event_type",
        [task.id],
      );
      expect(audit.rows.map((row) => row.event_type)).toEqual(["task.completed", "task.created"]);

      const unread = await repository.listNotifications({
        userId: SALES_USER_ID,
        unreadOnly: true,
      });
      expect(unread).toEqual([expect.objectContaining({ userId: SALES_USER_ID, readAt: null })]);
      expect(
        await repository.markNotificationRead({
          notificationId: unread[0]!.id,
          userId: OWNER_USER_ID,
          readAt: "2026-08-18T20:23:00.000Z",
        }),
      ).toBeNull();
      expect(
        await repository.markNotificationRead({
          notificationId: unread[0]!.id,
          userId: SALES_USER_ID,
          readAt: "2026-08-18T20:23:00.000Z",
        }),
      ).toMatchObject({ readAt: "2026-08-18T20:23:00.000Z" });
      expect(
        await repository.listNotifications({ userId: SALES_USER_ID, unreadOnly: true }),
      ).toEqual([]);
      expect(await repository.getDashboardCounts(OWNER_USER_ID)).toMatchObject({
        companies: 4,
        contacts: 5,
        completedTasks: 3,
        activeConversations: 1,
      });
      expect(await repository.getDashboardCounts(OWNER_USER_ID, { companies: true })).toEqual({
        companies: 4,
        contacts: 0,
        openTasks: 0,
        completedTasks: 0,
        overdueTasks: 0,
        unreadNotifications: 0,
        activeConversations: 0,
      });
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "rejects invalid company-contact task relationships without success evidence",
    async () => {
      const attempts = [
        {
          id: "a2000000-0000-4000-8000-000000000001",
          companyId: null,
          correlationId: "phase11-contact-without-company",
        },
        {
          id: "a2000000-0000-4000-8000-000000000002",
          companyId: OTHER_COMPANY_ID,
          correlationId: "phase11-contact-company-mismatch",
        },
      ] as const;

      for (const attempt of attempts) {
        await expect(
          repository.createTask({
            id: attempt.id,
            title: `Rejected relationship ${attempt.id}`,
            assigneeUserId: OWNER_USER_ID,
            companyId: attempt.companyId,
            contactId: CONTACT_ID,
            createdByUserId: OWNER_USER_ID,
            correlationId: attempt.correlationId,
          }),
        ).rejects.toMatchObject({
          code: "PHASE1_TASK_CONTACT_COMPANY_MISMATCH",
          field: "contactId",
        });
      }

      const evidence = await database.query<{
        activities: string | number;
        audits: string | number;
        tasks: string | number;
      }>(
        `SELECT
         (SELECT COUNT(*) FROM tasks WHERE id IN ($1,$2)) AS tasks,
         (SELECT COUNT(*) FROM activities WHERE correlation_id IN ($3,$4)) AS activities,
         (SELECT COUNT(*) FROM audit_logs WHERE correlation_id IN ($3,$4)) AS audits`,
        [attempts[0].id, attempts[1].id, attempts[0].correlationId, attempts[1].correlationId],
      );
      expect({
        activities: Number(evidence.rows[0]?.activities ?? -1),
        audits: Number(evidence.rows[0]?.audits ?? -1),
        tasks: Number(evidence.rows[0]?.tasks ?? -1),
      }).toEqual({ activities: 0, audits: 0, tasks: 0 });
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "revalidates the company-contact relationship during confirmed AI execution",
    async () => {
      const action = await createPendingTaskAction("relationship-revalidation");
      const input = validExecutionInput(action, "relationship-revalidation");
      await database.query(
        "UPDATE contacts SET company_id=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1",
        [CONTACT_ID, OTHER_COMPANY_ID],
      );
      try {
        await expect(repository.approveAndExecuteTaskAction(input)).rejects.toMatchObject({
          code: "PHASE1_TASK_CONTACT_COMPANY_MISMATCH",
          field: "contactId",
        });
        expect(await repository.getSuggestedAction(action.id, OWNER_USER_ID)).toMatchObject({
          status: "pending",
        });
        const evidence = await database.query<{
          activities: string | number;
          approvals: string | number;
          audits: string | number;
          executions: string | number;
          tasks: string | number;
        }>(
          `SELECT
           (SELECT COUNT(*) FROM action_approvals WHERE suggested_action_id=$1) AS approvals,
           (SELECT COUNT(*) FROM action_executions WHERE suggested_action_id=$1) AS executions,
           (SELECT COUNT(*) FROM tasks WHERE title=$2) AS tasks,
           (SELECT COUNT(*) FROM activities WHERE correlation_id=$3) AS activities,
           (SELECT COUNT(*) FROM audit_logs WHERE correlation_id=$3) AS audits`,
          [action.id, action.payload.title, input.correlationId],
        );
        expect({
          activities: Number(evidence.rows[0]?.activities ?? -1),
          approvals: Number(evidence.rows[0]?.approvals ?? -1),
          audits: Number(evidence.rows[0]?.audits ?? -1),
          executions: Number(evidence.rows[0]?.executions ?? -1),
          tasks: Number(evidence.rows[0]?.tasks ?? -1),
        }).toEqual({ activities: 0, approvals: 0, audits: 0, executions: 0, tasks: 0 });
      } finally {
        await database.query(
          "UPDATE contacts SET company_id=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1",
          [CONTACT_ID, COMPANY_ID],
        );
      }
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "supersedes older AI Command generations and makes prior previews unexecutable",
    async () => {
      const conversation = await repository.createConversation({
        ownerUserId: OWNER_USER_ID,
        title: "Synthetic request generation ordering",
        createdAt: "2026-08-18T20:59:00.000Z",
      });
      const firstReservation = await repository.reserveAiCommandRequest({
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        correlationId: "phase11-request-first",
        reservedAt: "2026-08-18T21:00:00.000Z",
      });
      const first = await repository.beginAiCommandRequest({
        requestId: firstReservation.requestId,
        generation: firstReservation.generation,
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        content: "Prepare the first task preview",
        correlationId: "phase11-request-first",
        createdAt: "2026-08-18T21:00:01.000Z",
      });
      expect(first.status).toBe("accepted");
      const firstFinalization = await repository.finalizeAiCommandRequest({
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        generation: first.generation,
        assistantMessage: {
          content: "First preview response",
          correlationId: "phase11-request-first",
          executionMs: 1,
        },
        workspaceArtifact: {
          id: "a2200000-0000-4000-8000-000000000001",
          type: "action-preview",
          title: "First preview",
          payload: { actionId: "a2300000-0000-4000-8000-000000000001", executable: true },
          requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
        },
        suggestedAction: {
          id: "a2300000-0000-4000-8000-000000000001",
          actionType: "task.create",
          payload: {
            title: "Superseded synthetic task",
            assigneeUserId: OWNER_USER_ID,
            companyId: COMPANY_ID,
            contactId: CONTACT_ID,
          },
          requiredPermission: PERMISSIONS.TASK_ACTION_EXECUTE,
          idempotencyKey: "phase11-preview-first",
          correlationId: "phase11-request-first",
          expiresAt: "2099-12-31T23:59:59.000Z",
        },
        finalizedAt: "2026-08-18T21:01:00.000Z",
      });
      expect(firstFinalization).toMatchObject({
        status: "completed",
        suggestedAction: { status: "pending" },
      });
      if (firstFinalization.status !== "completed" || !firstFinalization.suggestedAction) {
        throw new Error("Expected a persisted first preview action.");
      }
      const beforeDuplicate = await repository.getConversation(conversation.id, OWNER_USER_ID);
      await expect(
        repository.beginAiCommandRequest({
          requestId: first.requestId,
          generation: first.generation,
          conversationId: conversation.id,
          ownerUserId: OWNER_USER_ID,
          content: "Duplicate retry must fail closed",
          correlationId: "phase11-request-duplicate",
          createdAt: "2026-08-18T21:01:30.000Z",
        }),
      ).rejects.toMatchObject({ code: "PHASE1_REQUEST_REPLAYED" });
      expect(await repository.getConversation(conversation.id, OWNER_USER_ID)).toMatchObject({
        version: beforeDuplicate?.version,
      });
      expect(
        await repository.getSuggestedAction(firstFinalization.suggestedAction.id, OWNER_USER_ID),
      ).toMatchObject({ status: "pending" });

      const secondReservation = await repository.reserveAiCommandRequest({
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        correlationId: "phase11-request-second",
        reservedAt: "2026-08-18T21:02:00.000Z",
      });
      expect(secondReservation.supersededActionIds).toContain(firstFinalization.suggestedAction.id);
      const second = await repository.beginAiCommandRequest({
        requestId: secondReservation.requestId,
        generation: secondReservation.generation,
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        content: "Prepare an older delayed response",
        correlationId: "phase11-request-second",
        createdAt: "2026-08-18T21:02:01.000Z",
      });
      expect(second.status).toBe("accepted");
      const thirdReservation = await repository.reserveAiCommandRequest({
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        correlationId: "phase11-request-third",
        reservedAt: "2026-08-18T21:03:00.000Z",
      });
      const third = await repository.beginAiCommandRequest({
        requestId: thirdReservation.requestId,
        generation: thirdReservation.generation,
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        content: "Prepare the newest response",
        correlationId: "phase11-request-third",
        createdAt: "2026-08-18T21:03:01.000Z",
      });
      expect(third.status).toBe("accepted");

      const staleFinalization = await repository.finalizeAiCommandRequest({
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        generation: second.generation,
        assistantMessage: {
          content: "This stale assistant response must not persist",
          correlationId: "phase11-request-second",
        },
        workspaceArtifact: {
          type: "action-preview",
          title: "Stale preview must not persist",
          payload: { actionId: "a2300000-0000-4000-8000-000000000002" },
          requiredPermissions: [PERMISSIONS.AI_COMMAND_VIEW],
        },
        suggestedAction: {
          id: "a2300000-0000-4000-8000-000000000002",
          actionType: "task.create",
          payload: { title: "Stale task", assigneeUserId: OWNER_USER_ID },
          requiredPermission: PERMISSIONS.TASK_ACTION_EXECUTE,
          idempotencyKey: "phase11-preview-stale",
          correlationId: "phase11-request-second",
          expiresAt: "2099-12-31T23:59:59.000Z",
        },
        finalizedAt: "2026-08-18T21:04:00.000Z",
      });
      expect(staleFinalization).toEqual({ status: "superseded" });

      const newestFinalization = await repository.finalizeAiCommandRequest({
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        generation: third.generation,
        assistantMessage: {
          content: "Newest assistant response",
          correlationId: "phase11-request-third",
        },
        workspaceArtifact: {
          id: "a2200000-0000-4000-8000-000000000003",
          type: "task-list",
          title: "Newest workspace result",
          payload: { items: [] },
          requiredPermissions: [PERMISSIONS.TASKS_VIEW],
        },
        finalizedAt: "2026-08-18T21:05:00.000Z",
      });
      expect(newestFinalization).toMatchObject({ status: "completed" });

      await expect(
        repository.approveAndExecuteTaskAction(
          validExecutionInput(firstFinalization.suggestedAction, "superseded-preview"),
        ),
      ).rejects.toMatchObject({ code: "PHASE1_ACTION_SUPERSEDED" });
      expect(
        await repository.getSuggestedAction(firstFinalization.suggestedAction.id, OWNER_USER_ID),
      ).toMatchObject({ status: "denied" });
      expect(await repository.listSuggestedActions(conversation.id, OWNER_USER_ID)).toHaveLength(1);
      const messages = await repository.listAssistantMessages(conversation.id, OWNER_USER_ID, 20);
      expect(messages.map((message) => message.content)).not.toContain(
        "This stale assistant response must not persist",
      );
      expect(
        (await repository.listWorkspaceArtifacts(conversation.id, OWNER_USER_ID, 10))[0],
      ).toMatchObject({ id: "a2200000-0000-4000-8000-000000000003" });
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a delayed older reservation stale after the newer request begins",
    async () => {
      const conversation = await repository.createConversation({
        ownerUserId: OWNER_USER_ID,
        title: "Authoritative submission ordering",
      });
      const older = await repository.reserveAiCommandRequest({
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        correlationId: "phase11-reservation-older",
      });
      const newer = await repository.reserveAiCommandRequest({
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        correlationId: "phase11-reservation-newer",
      });
      const newerBegin = await repository.beginAiCommandRequest({
        requestId: newer.requestId,
        generation: newer.generation,
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        content: "Show all companies",
        correlationId: "phase11-reservation-newer",
      });
      expect(newerBegin.status).toBe("accepted");
      const delayedOlder = await repository.beginAiCommandRequest({
        requestId: older.requestId,
        generation: older.generation,
        conversationId: conversation.id,
        ownerUserId: OWNER_USER_ID,
        content: "Create the stale task that must never be staged",
        correlationId: "phase11-reservation-older",
      });
      expect(delayedOlder).toEqual({
        status: "superseded",
        requestId: older.requestId,
        generation: older.generation,
      });
      await expect(
        repository.beginAiCommandRequest({
          requestId: older.requestId,
          generation: older.generation,
          conversationId: conversation.id,
          ownerUserId: OWNER_USER_ID,
          content: "Replay must fail closed",
          correlationId: "phase11-reservation-older-replay",
        }),
      ).rejects.toMatchObject({ code: "PHASE1_REQUEST_REPLAYED" });
      await expect(
        repository.finalizeAiCommandRequest({
          conversationId: conversation.id,
          ownerUserId: OWNER_USER_ID,
          generation: newer.generation,
          assistantMessage: {
            content: "Newest reserved request completed",
            correlationId: "phase11-reservation-newer",
          },
          workspaceArtifact: {
            type: "company-list",
            title: "Newest companies",
            payload: { items: [] },
            requiredPermissions: [PERMISSIONS.COMPANIES_VIEW],
          },
        }),
      ).resolves.toMatchObject({ status: "completed" });
      const messages = await repository.listAssistantMessages(conversation.id, OWNER_USER_ID, 20);
      expect(messages.map((message) => message.content)).toEqual([
        "Show all companies",
        "Newest reserved request completed",
      ]);
      expect(await repository.listWorkspaceArtifacts(conversation.id, OWNER_USER_ID)).toHaveLength(
        1,
      );
      expect(await repository.listSuggestedActions(conversation.id, OWNER_USER_ID)).toEqual([]);
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "denies cross-owner reads and writes for AI workspace records and actions",
    async () => {
      expect(await repository.getConversation(OWNER_CONVERSATION_ID, OWNER_USER_ID)).not.toBeNull();
      expect(
        await repository.listAssistantMessages(OWNER_CONVERSATION_ID, OWNER_USER_ID),
      ).toHaveLength(2);
      expect(
        await repository.listWorkspaceArtifacts(OWNER_CONVERSATION_ID, OWNER_USER_ID),
      ).toHaveLength(1);

      expect(await repository.getConversation(OWNER_CONVERSATION_ID, SALES_USER_ID)).toBeNull();
      expect(await repository.listAssistantMessages(OWNER_CONVERSATION_ID, SALES_USER_ID)).toEqual(
        [],
      );
      expect(await repository.listWorkspaceArtifacts(OWNER_CONVERSATION_ID, SALES_USER_ID)).toEqual(
        [],
      );
      expect(await repository.getWorkspaceArtifact(OWNER_ARTIFACT_ID, SALES_USER_ID)).toBeNull();
      expect(
        await repository.getSuggestedAction(OWNER_PENDING_ACTION_ID, SALES_USER_ID),
      ).toBeNull();
      expect(await repository.listSuggestedActions(OWNER_CONVERSATION_ID, SALES_USER_ID)).toEqual(
        [],
      );

      await expect(
        repository.createAssistantMessage({
          conversationId: OWNER_CONVERSATION_ID,
          ownerUserId: SALES_USER_ID,
          role: "user",
          content: "Cross-owner message must be rejected.",
          correlationId: "integration-phase1-owner-denial-message",
        }),
      ).rejects.toMatchObject({ code: "PHASE1_OWNERSHIP_REQUIRED" });
      await expect(
        repository.createWorkspaceArtifact({
          conversationId: OWNER_CONVERSATION_ID,
          requestedByUserId: SALES_USER_ID,
          type: "search-results",
          title: "Cross-owner artifact",
        }),
      ).rejects.toMatchObject({ code: "PHASE1_OWNERSHIP_REQUIRED" });
      await expect(
        repository.createSuggestedAction({
          conversationId: OWNER_CONVERSATION_ID,
          requestedByUserId: SALES_USER_ID,
          actionType: "task.create",
          payload: { title: "Cross-owner task", assigneeUserId: SALES_USER_ID },
          requiredPermission: PERMISSIONS.TASK_ACTION_EXECUTE,
          idempotencyKey: "integration:phase1:owner-denial-preview",
          correlationId: "integration-phase1-owner-denial-preview",
          expiresAt: "2099-12-31T23:59:59.000Z",
        }),
      ).rejects.toMatchObject({ code: "PHASE1_OWNERSHIP_REQUIRED" });

      const executedAt = new Date().toISOString();
      await expect(
        repository.approveAndExecuteTaskAction({
          suggestedActionId: OWNER_PENDING_ACTION_ID,
          actorUserId: SALES_USER_ID,
          confirmation: TASK_ACTION_CONFIRMATION,
          permissionRevalidation: {
            permission: PERMISSIONS.TASK_ACTION_EXECUTE,
            allowed: true,
            checkedAt: executedAt,
          },
          idempotencyKey: "integration:phase1:owner-denial-execute",
          correlationId: "integration-phase1-owner-denial-execute",
          executedAt,
        }),
      ).rejects.toMatchObject({ code: "PHASE1_OWNERSHIP_REQUIRED" });
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "suppresses an explicitly empty search scope and emits canonical workflow links",
    async () => {
      expect(await repository.searchKeyword("Northstar", { types: [] })).toEqual([]);
      expect(await repository.searchKeyword("Northstar")).toEqual([
        expect.objectContaining({ id: COMPANY_ID, type: "company" }),
        expect.objectContaining({
          type: "lead",
          title: "Synthetic Northstar curtain-wall review",
          href: "/leads/a1000000-0000-4000-8000-000000000003",
        }),
      ]);
      const workflowResults = await repository.searchKeyword("foundation", {
        types: ["workflow-run"],
      });
      expect(workflowResults).toEqual([
        expect.objectContaining({
          type: "workflow-run",
          href: "/workflow-runs/70000000-0000-4000-8000-000000000001",
        }),
      ]);
      expect(
        await repository.searchKeyword("synthetic", {
          types: ["task"],
          taskAssigneeUserId: OPERATIONS_USER_ID,
        }),
      ).toEqual([
        expect.objectContaining({
          id: OPERATIONS_TASK_ID,
          title: "Prepare synthetic operations handoff",
          type: "task",
        }),
      ]);
      expect(await repository.searchKeyword("Outlook", { types: ["integration"] })).toEqual([
        expect.objectContaining({ href: "/integrations/outlook-calendar" }),
        expect.objectContaining({ href: "/integrations/outlook-email" }),
      ]);
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "requires exact confirmation and fresh, matching permission proof",
    async () => {
      const action = await createPendingTaskAction("proof-boundaries");
      const validInput = validExecutionInput(action, "proof-boundaries");

      await expect(
        repository.approveAndExecuteTaskAction({
          ...validInput,
          confirmation: "CONFIRM_TASK_CREATE_WRONG" as typeof TASK_ACTION_CONFIRMATION,
        }),
      ).rejects.toMatchObject({ code: "PHASE1_ACTION_CONFIRMATION_REQUIRED" });

      await expect(
        repository.approveAndExecuteTaskAction({
          ...validInput,
          permissionRevalidation: {
            ...validInput.permissionRevalidation,
            checkedAt: new Date(Date.parse(validInput.executedAt!) - 10 * 60_000).toISOString(),
          },
        }),
      ).rejects.toMatchObject({ code: "PHASE1_PERMISSION_REVALIDATION_STALE" });

      await expect(
        repository.approveAndExecuteTaskAction({
          ...validInput,
          permissionRevalidation: {
            permission: PERMISSIONS.TASKS_MANAGE,
            allowed: true,
            checkedAt: validInput.executedAt!,
          },
        }),
      ).rejects.toMatchObject({ code: "PHASE1_PERMISSION_REVALIDATION_FAILED" });

      expect(await repository.getSuggestedAction(action.id, OWNER_USER_ID)).toMatchObject({
        status: "pending",
      });
      const evidence = await database.query<{
        approvals: string | number;
        executions: string | number;
      }>(
        `SELECT
         (SELECT COUNT(*) FROM action_approvals WHERE suggested_action_id=$1) AS approvals,
         (SELECT COUNT(*) FROM action_executions WHERE suggested_action_id=$1) AS executions`,
        [action.id],
      );
      expect({
        approvals: Number(evidence.rows[0]?.approvals ?? -1),
        executions: Number(evidence.rows[0]?.executions ?? -1),
      }).toEqual({ approvals: 0, executions: 0 });
    },
    PHASE1_TEST_TIMEOUT_MS,
  );

  it(
    "executes a confirmed task once and preserves approval, audit, and activity evidence",
    async () => {
      const action = await createPendingTaskAction("idempotent-confirmation");
      const input = validExecutionInput(action, "idempotent-confirmation");

      const first = await repository.approveAndExecuteTaskAction(input);
      const repeated = await repository.approveAndExecuteTaskAction(input);

      expect(first).toMatchObject({
        reused: false,
        action: { id: action.id, status: "executed" },
        approval: { decision: "approved", actorUserId: OWNER_USER_ID },
        execution: { status: "succeeded", actorUserId: OWNER_USER_ID },
        task: { title: "Confirmed synthetic task idempotent-confirmation", status: "open" },
      });
      expect(repeated).toMatchObject({
        reused: true,
        action: { id: first.action.id },
        approval: { id: first.approval.id },
        execution: { id: first.execution.id },
        task: { id: first.task.id },
      });

      const cardinality = await database.query<{
        approvals: string | number;
        executions: string | number;
        tasks: string | number;
      }>(
        `SELECT
         (SELECT COUNT(*) FROM action_approvals WHERE suggested_action_id=$1) AS approvals,
         (SELECT COUNT(*) FROM action_executions WHERE suggested_action_id=$1) AS executions,
         (SELECT COUNT(*) FROM tasks WHERE id=$2) AS tasks`,
        [action.id, first.task.id],
      );
      expect({
        approvals: Number(cardinality.rows[0]?.approvals ?? -1),
        executions: Number(cardinality.rows[0]?.executions ?? -1),
        tasks: Number(cardinality.rows[0]?.tasks ?? -1),
      }).toEqual({ approvals: 1, executions: 1, tasks: 1 });

      const activityTypes = (await repository.listActivities({ taskId: first.task.id })).map(
        (activity) => activity.type,
      );
      expect(activityTypes).toEqual(
        expect.arrayContaining(["action.approved", "task.created", "action.executed"]),
      );
      expect(activityTypes).toHaveLength(3);

      const audit = await database.query<{
        event_type: string;
        action: string;
        resource_id: string;
        correlation_id: string;
      }>(
        `SELECT event_type,action,resource_id,correlation_id FROM audit_logs
       WHERE resource_type='action-execution' AND resource_id=$1`,
        [first.execution.id],
      );
      expect(audit.rows).toEqual([
        {
          event_type: "assistant.action-executed",
          action: "assistant.task.create",
          resource_id: first.execution.id,
          correlation_id: input.correlationId,
        },
      ]);
    },
    PHASE1_TEST_TIMEOUT_MS,
  );
});
