import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import { migrateDatabase, verifyMigrations } from "../../packages/database/src/migrations";
import {
  configureCplAutomationWorker,
  configureHostedRuntimeRole,
  verifyHostedDatabaseRole,
} from "../../packages/database/src/hosted-database-role";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store";
import { SqlCplTenantRepository } from "../../packages/database/src/tenant-repository";
import {
  SqlCplWorkflowRepository,
  processHostedJobs,
} from "../../packages/database/src/hosted-workflow";
import { SqlCplCommercialRepository } from "../../packages/database/src/cpl-commercial-repository";
import { SqlCplAutomationRepository } from "../../packages/database/src/cpl-automation-repository";
import { SqlCplExecutionRepository } from "../../packages/database/src/cpl-execution-repository";
import { SqlCplFieldRepository } from "../../packages/database/src/cpl-field-repository";
import { SqlCplReportRepository } from "../../packages/database/src/cpl-report-repository";
import type { CplAutomationRecipeInput } from "../../packages/domain/src/cpl-automation";
import { defaultCplCommercialBranding } from "../../packages/domain/src/cpl-commercial";
import type { DatabaseAdapter, SqlExecutor } from "../../packages/database/src/adapter";

const material = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON;
const configPath = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG;
const suite = material || configPath ? describe : describe.skip;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

suite("durable first automation handoff on isolated real PostgreSQL", () => {
  let control: PgSqlDatabaseAdapter,
    admin: PgSqlDatabaseAdapter,
    web: PgSqlDatabaseAdapter,
    worker: PgSqlDatabaseAdapter;
  let auth: SqlCplHostedAuthStore,
    tenants: SqlCplTenantRepository,
    intake: SqlCplWorkflowRepository,
    commercial: SqlCplCommercialRepository,
    automation: SqlCplAutomationRepository;
  let workerConnection: string;
  const databaseName = `cpl_automation_test_${randomBytes(6).toString("hex")}`;
  let created = false;
  beforeAll(async () => {
    const config = JSON.parse(material ?? readFileSync(configPath!, "utf8"));
    for (const value of [config.adminUrl, config.webUrl, config.workerUrl])
      if (!["127.0.0.1", "localhost"].includes(new URL(value).hostname))
        throw Error("Isolated local PostgreSQL only");
    control = new PgSqlDatabaseAdapter({ connectionString: config.adminUrl, max: 1 });
    await control.execute(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const connect = (value: string) => {
      const url = new URL(value);
      url.pathname = "/" + databaseName;
      return url.href;
    };
    admin = new PgSqlDatabaseAdapter({ connectionString: connect(config.adminUrl), max: 2 });
    await migrateDatabase(admin);
    await configureHostedRuntimeRole(admin, new URL(config.webUrl).username, "web");
    await configureHostedRuntimeRole(admin, new URL(config.workerUrl).username, "worker");
    await configureCplAutomationWorker(admin, new URL(config.workerUrl).username);
    web = new PgSqlDatabaseAdapter({
      connectionString: connect(config.webUrl),
      max: 4,
      statement_timeout: 10000,
    });
    workerConnection = connect(config.workerUrl);
    worker = new PgSqlDatabaseAdapter({
      connectionString: workerConnection,
      max: 4,
      statement_timeout: 10000,
    });
    auth = new SqlCplHostedAuthStore(web);
    tenants = new SqlCplTenantRepository(web);
    intake = new SqlCplWorkflowRepository(web, tenants);
    commercial = new SqlCplCommercialRepository(tenants);
    automation = new SqlCplAutomationRepository(tenants);
  }, 180000);
  afterAll(async () => {
    await Promise.all([worker?.close(), web?.close(), admin?.close()]);
    if (created) await control.execute(`DROP DATABASE "${databaseName}" WITH(FORCE)`);
    await control?.close();
  }, 60000);
  async function signIn() {
    const raw = randomBytes(32).toString("base64url"),
      now = new Date().toISOString();
    const session = await auth.createSession({
      identity: {
        issuer: "https://accounts.google.com",
        subject: randomUUID(),
        email: "fictional@example.invalid",
        emailVerified: true,
        hostedDomain: null,
        displayName: "Fictional automation owner",
        authenticatedAt: now,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      material: {
        tokenHash: sha(raw),
        csrfTokenHash: sha(randomUUID()),
        expiresAt: new Date(Date.now() + 3500000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 28000000).toISOString(),
      },
      now,
    });
    return { raw, session };
  }
  async function fixture() {
    const actor = await signIn(),
      org = await tenants.createOrganization(actor.raw, {
        slug: randomUUID(),
        displayName: "Fictional automation company",
      });
    const request = { sessionToken: actor.raw, organizationId: org.id };
    await admin.query(
      "UPDATE cpl_module_entitlements SET enabled=TRUE,usage_limit=NULL WHERE organization_id=$1 AND module_key IN ('intake-job-tracker','proposal-builder','award-to-project-launcher','field-report-assembler')",
      [org.id],
    );
    await commercial.saveBranding({
      ...request,
      expectedRevision: 0,
      input: { ...defaultCplCommercialBranding(), businessName: "Fictional automation services" },
    });
    const lead = await intake.createLead({
      ...request,
      title: "Fictional automation inquiry",
      customerName: "Fictional Customer",
      contactName: "Fictional Contact",
      contactEmail: "customer@example.invalid",
      siteName: "Fictional site",
      siteAddress: "123 Example Road",
      details: "Confirmed service scope",
      requestedService: "Fictional service",
      assignedMemberIdentityId: actor.session.identityId,
      nextAction: "Prepare proposal",
      notes: "PRIVATE LEAD CANARY",
      evidenceNote: "PRIVATE SOURCE CANARY",
      sourceReference: "reference:fictional",
      idempotencyKey: randomUUID(),
    });
    const template = await commercial.createTemplate({
      ...request,
      idempotencyKey: randomUUID(),
      input: {
        name: "Fictional approved-for-automation template",
        catalog: [
          {
            serviceCode: "DEMO",
            description: "Fictional service",
            quantity: "1",
            unit: "visit",
            unitPriceMinor: 50000,
          },
        ],
        terms: "Fictional standard terms",
      },
    });
    const input: CplAutomationRecipeInput = {
      name: "Fictional lead to proposal",
      trigger: "lead.ready",
      enabled: true,
      service: "Fictional service",
      prepareDraft: true,
      templateId: template.id,
      templateVersion: 1,
      templateApprovedForAutomation: true,
      owner: { kind: "person", role: null, identityId: actor.session.identityId },
      dueAfterHours: 24,
      taskTitle: "Review the prepared proposal",
    };
    return { actor, request, lead, template, input };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const configure = (f: Fixture, input = f.input) =>
    automation.saveRecipe({
      ...f.request,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      input,
    });
  const ready = (f: Fixture) =>
    intake.updateLead({
      ...f.request,
      leadId: f.lead.id,
      expectedVersion: f.lead.version,
      status: "ready_for_proposal",
    });
  async function awardFixture(f: Fixture) {
    await ready(f);
    let p = await commercial.createProposal({
      ...f.request,
      leadId: f.lead.id,
      templateId: f.template.id,
      idempotencyKey: randomUUID(),
    });
    p = await commercial.submitProposal({
      ...f.request,
      proposalId: p.id,
      expectedRevision: p.revision,
    });
    p = await commercial.reviewProposal({
      ...f.request,
      proposalId: p.id,
      expectedRevision: p.revision,
      decision: "approve",
    });
    return commercial.recordOutcome({
      ...f.request,
      proposalId: p.id,
      expectedRevision: p.revision,
      outcome: "awarded",
      award: {
        awardDate: "2026-09-23",
        amountMinor: p.versions[0]!.totals.totalMinor,
        currency: p.versions[0]!.totals.currency,
        purchaseOrder: "FICTIONAL-PO",
        startDate: null,
        notes: "Human-recorded fictional award",
      },
      idempotencyKey: randomUUID(),
    });
  }
  async function execution(f: Fixture) {
    const workspace = await automation.getWorkspace(f.request);
    expect(workspace.executions).toHaveLength(1);
    return workspace.executions[0]!;
  }
  async function run(f: Fixture) {
    for (let count = 0; count < 10; count++) {
      const current = await execution(f);
      if (!["queued", "running"].includes(current.status)) return current;
      await processHostedJobs(worker, { claimOwner: "fictional-local-runner", limit: 1 });
    }
    throw Error("Target execution did not finish within bounded processing");
  }
  async function count(
    table:
      "cpl_business_events" | "cpl_workflow_jobs" | "cpl_commercial_proposals" | "cpl_action_tasks",
    organizationId: string,
  ) {
    return Number(
      (
        await admin.query<{ total: string }>(
          `SELECT count(*) AS total FROM ${table} WHERE organization_id=$1${table === "cpl_action_tasks" ? " AND execution_id IS NOT NULL" : ""}`,
          [organizationId],
        )
      ).rows[0]!.total,
    );
  }
  it("applies additive migrations and keeps both restricted roles protected", async () => {
    expect((await verifyMigrations(admin)).current).toBe("0039_cpl_durable_inbound.sql");
    await expect(verifyHostedDatabaseRole(web, "web")).resolves.toMatchObject({ purpose: "web" });
    await expect(verifyHostedDatabaseRole(worker, "worker")).resolves.toMatchObject({
      purpose: "worker",
    });
    expect((await migrateDatabase(admin)).applied).toEqual([]);
    expect(
      (await admin.query("SELECT count(*) AS total FROM cpl_automation_recipes")).rows[0]?.total,
    ).toBe("0");
  });
  it("rolls back the source transition when durable event insertion fails", async () => {
    const f = await fixture();
    await configure(f);
    await admin.execute(
      "ALTER TABLE cpl_business_events ADD CONSTRAINT fictional_event_failure CHECK(event_type<>'lead.ready') NOT VALID",
    );
    try {
      await expect(ready(f)).rejects.toThrow();
    } finally {
      await admin.execute(
        "ALTER TABLE cpl_business_events DROP CONSTRAINT fictional_event_failure",
      );
    }
    expect((await intake.getLead({ ...f.request, leadId: f.lead.id })).status).toBe("new");
    expect(await count("cpl_business_events", f.request.organizationId)).toBe(0);
    expect(await count("cpl_workflow_jobs", f.request.organizationId)).toBe(0);
  });
  it("does not backfill historical ready events when a recipe is enabled", async () => {
    const f = await fixture();
    await ready(f);
    await configure(f);
    expect(await count("cpl_business_events", f.request.organizationId)).toBe(1);
    expect(await count("cpl_workflow_jobs", f.request.organizationId)).toBe(0);
    const workspace = await automation.getWorkspace(f.request);
    expect(workspace.tasks.filter((task) => task.executionId !== null)).toEqual([]);
    expect(workspace.counts.openTasks).toBe(1); // Manual attention is not historical recipe replay.
  });
  it("rolls back both source and event if the captured job cannot be inserted", async () => {
    const f = await fixture();
    await configure(f);
    await admin.execute(
      "ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT fictional_job_failure CHECK(kind<>'automation.recipe') NOT VALID",
    );
    try {
      await expect(ready(f)).rejects.toThrow();
    } finally {
      await admin.execute("ALTER TABLE cpl_workflow_jobs DROP CONSTRAINT fictional_job_failure");
    }
    expect((await intake.getLead({ ...f.request, leadId: f.lead.id })).status).toBe("new");
    expect(await count("cpl_business_events", f.request.organizationId)).toBe(0);
    expect(await count("cpl_workflow_jobs", f.request.organizationId)).toBe(0);
  });
  it("records the event and queued version, then prepares a linked draft and human action", async () => {
    const f = await fixture(),
      recipe = await configure(f),
      lead = await ready(f);
    const queued = await execution(f);
    expect(queued).toMatchObject({
      status: "queued",
      recipeId: recipe.id,
      recipeVersion: 1,
      event: { sourceId: lead.id, sourceVersion: lead.version, origin: "human" },
    });
    expect(await count("cpl_commercial_proposals", f.request.organizationId)).toBe(0);
    const completed = await run(f);
    expect(completed.status).toBe("succeeded");
    const workspace = await automation.getWorkspace(f.request),
      commercialWorkspace = await commercial.readWorkspace(f.request);
    expect(commercialWorkspace.proposals).toHaveLength(1);
    const proposal = await commercial.getProposal({
      ...f.request,
      proposalId: commercialWorkspace.proposals[0]!.id,
    });
    expect(proposal).toMatchObject({ state: "draft", leadId: lead.id, currentVersion: 1 });
    expect(proposal.versions[0]!.sourceLead.fields.customerName).toBe("Fictional Customer");
    expect(proposal.versions[0]!.totals.totalMinor).toBe(50000);
    const handoffTasks = workspace.tasks.filter((task) => task.executionId === completed.id);
    expect(handoffTasks).toHaveLength(1);
    expect(handoffTasks[0]).toMatchObject({
      executionId: completed.id,
      status: "open",
      owner: f.input.owner,
      target: { kind: "proposal", id: proposal.id },
    });
    expect(handoffTasks[0]!.dueAt).toBe(
      new Date(Date.parse(completed.event.occurredAt) + 86400000).toISOString(),
    );
    expect(workspace.counts).toMatchObject({
      openTasks: 1,
      myTasks: 1,
      succeededExecutions: 1,
      queuedExecutions: 0,
    });
    const detail = await automation.getExecution({ ...f.request, executionId: completed.id });
    expect(detail.attemptHistory).toHaveLength(1);
    expect(detail.attemptHistory[0]!.status).toBe("succeeded");
    expect(await count("cpl_business_events", f.request.organizationId)).toBe(1);
  });
  it("replaying a completed event after a discarded response preserves one draft and task", async () => {
    const f = await fixture();
    await configure(f);
    await ready(f);
    // Deliberately discard completion response. Reconciliation reads durable state.
    await processHostedJobs(worker, { claimOwner: "discarded-response" });
    const original = await execution(f),
      key = randomUUID();
    for (let i = 0; i < 2; i++)
      await automation.replayEvent({
        ...f.request,
        eventId: original.event.id,
        idempotencyKey: key,
        reason: "Fictional lost-response reconciliation",
      });
    await processHostedJobs(worker, { claimOwner: "reopened-response" });
    expect((await execution(f)).id).toBe(original.id);
    expect(await count("cpl_commercial_proposals", f.request.organizationId)).toBe(1);
    expect(await count("cpl_action_tasks", f.request.organizationId)).toBe(1);
    expect(await count("cpl_workflow_jobs", f.request.organizationId)).toBe(1);
  });
  it("concurrent worker attempts commit only one requested operation", async () => {
    const f = await fixture();
    await configure(f);
    await ready(f);
    await Promise.all([
      processHostedJobs(worker, { claimOwner: "concurrent-one" }),
      processHostedJobs(worker, { claimOwner: "concurrent-two" }),
    ]);
    expect((await execution(f)).status).toBe("succeeded");
    expect(await count("cpl_commercial_proposals", f.request.organizationId)).toBe(1);
    expect(await count("cpl_action_tasks", f.request.organizationId)).toBe(1);
  });
  it("resumes after a committed handoff loses its acknowledgement without repeating that step", async () => {
    const f = await fixture();
    await configure(f);
    await ready(f);
    const queued = await execution(f);
    let interrupted = false;
    const lostAcknowledgement = new Proxy(worker, {
      get(target, property) {
        if (property === "transaction")
          return async <T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> => {
            const result = await target.transaction(operation);
            const committed = await admin.query(
              "SELECT step_key FROM cpl_automation_steps WHERE organization_id=$1 AND execution_id=$2 AND step_key='handoff'",
              [f.request.organizationId, queued.id],
            );
            if (!interrupted && committed.rows.length) {
              interrupted = true;
              throw Error("Synthetic acknowledgement loss after PostgreSQL commit");
            }
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseAdapter;
    await processHostedJobs(lostAcknowledgement, { claimOwner: "lost-commit-acknowledgement" });
    expect(interrupted).toBe(true);
    expect((await execution(f)).status).toBe("retrying");
    const before = (await commercial.readWorkspace(f.request)).proposals;
    expect(before).toHaveLength(1);
    expect(await count("cpl_action_tasks", f.request.organizationId)).toBe(0);
    // Advance only this disposable job's test clock; production retry delay is unchanged.
    await admin.query(
      "UPDATE cpl_workflow_jobs SET available_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
      [f.request.organizationId, queued.id],
    );
    await processHostedJobs(worker, { claimOwner: "retry-after-lost-commit" });
    expect((await execution(f)).status).toBe("succeeded");
    expect((await commercial.readWorkspace(f.request)).proposals.map((p) => p.id)).toEqual(
      before.map((p) => p.id),
    );
    expect(await count("cpl_action_tasks", f.request.organizationId)).toBe(1);
    const detail = await automation.getExecution({ ...f.request, executionId: queued.id });
    expect(detail.attemptHistory.map((attempt) => attempt.status)).toEqual([
      "retrying",
      "succeeded",
    ]);
  });
  it("skips queued work when the recipe version changes", async () => {
    const f = await fixture(),
      recipe = await configure(f);
    await ready(f);
    await automation.saveRecipe({
      ...f.request,
      recipeId: recipe.id,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      input: { ...f.input, taskTitle: "Changed future action" },
    });
    expect((await run(f)).status).toBe("skipped");
    expect(await count("cpl_commercial_proposals", f.request.organizationId)).toBe(0);
  });
  it("skips queued work when the responsible person's membership is revoked", async () => {
    const f = await fixture(),
      person = await signIn();
    await admin.query(
      "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'member')",
      [f.request.organizationId, person.session.identityId],
    );
    await configure(f, {
      ...f.input,
      owner: { kind: "person", role: null, identityId: person.session.identityId },
    });
    await ready(f);
    await admin.query(
      "UPDATE cpl_memberships SET status='suspended',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
      [f.request.organizationId, person.session.identityId],
    );
    expect((await run(f)).status).toBe("skipped");
    expect(await count("cpl_commercial_proposals", f.request.organizationId)).toBe(0);
  });
  it("rechecks a changed lead before creating the delayed proposal", async () => {
    const f = await fixture();
    await configure(f);
    const lead = await ready(f);
    await intake.updateLead({
      ...f.request,
      leadId: lead.id,
      expectedVersion: lead.version,
      status: "needs_info",
    });
    expect((await run(f)).status).toBe("skipped");
    expect(await count("cpl_commercial_proposals", f.request.organizationId)).toBe(0);
  });
  it("processes persisted pending work after closing and reopening the worker connection", async () => {
    const f = await fixture();
    await configure(f);
    await ready(f);
    const pending = await execution(f);
    await worker.close();
    worker = new PgSqlDatabaseAdapter({
      connectionString: workerConnection,
      max: 4,
      statement_timeout: 10000,
    });
    expect((await execution(f)).id).toBe(pending.id);
    expect((await run(f)).status).toBe("succeeded");
    expect(await count("cpl_commercial_proposals", f.request.organizationId)).toBe(1);
  });
  it("isolates recipes, executions and tasks and refuses a web-role worker", async () => {
    const a = await fixture(),
      b = await fixture();
    await configure(a);
    await ready(a);
    const completed = await run(a);
    const other = await automation.getWorkspace(b.request);
    expect(other.recipes).toEqual([]);
    expect(other.executions).toEqual([]);
    expect(other.tasks.every((task) => task.organizationId === b.request.organizationId)).toBe(
      true,
    );
    expect(other.tasks.filter((task) => task.executionId !== null)).toEqual([]);
    await expect(
      automation.getExecution({ ...b.request, executionId: completed.id }),
    ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    await expect(configure(b, { ...b.input, templateId: a.template.id })).rejects.toThrow();
    await expect(processHostedJobs(web, { claimOwner: "forbidden-web-drain" })).rejects.toThrow();
    await web.transaction(async (tx) => {
      await tx.query("SELECT set_config('cpl.organization_id',$1,true)", [
        b.request.organizationId,
      ]);
      expect(
        (
          await tx.query("SELECT id FROM cpl_action_tasks WHERE organization_id=$1", [
            a.request.organizationId,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await tx.query("SELECT id FROM cpl_business_events WHERE organization_id=$1", [
            a.request.organizationId,
          ])
        ).rows,
      ).toEqual([]);
    });
  });
  it("dismisses with a durable reason without changing the proposal review state", async () => {
    const f = await fixture();
    await configure(f);
    await ready(f);
    await run(f);
    const task = (await automation.getWorkspace(f.request)).tasks.find(
      (item) => item.executionId !== null,
    )!;
    const result = await automation.updateTask({
      ...f.request,
      taskId: task.id,
      expectedRevision: task.revision,
      idempotencyKey: randomUUID(),
      action: "dismiss",
      reason: "Fictional action handled in another internal review",
    });
    expect(result).toMatchObject({
      status: "dismissed",
      resolutionReason: "Fictional action handled in another internal review",
    });
    expect((await commercial.getProposal({ ...f.request, proposalId: task.target.id })).state).toBe(
      "draft",
    );
  });
  it("requires explicit template authorization and does not enqueue disabled or nonmatching recipes", async () => {
    const f = await fixture();
    await expect(
      configure(f, { ...f.input, templateApprovedForAutomation: false }),
    ).rejects.toMatchObject({ code: "CPL_AUTOMATION_TEMPLATE_AUTHORIZATION_REQUIRED" });
    await configure(f, { ...f.input, enabled: false });
    await configure(f, {
      ...f.input,
      name: "Different service",
      service: "Other fictional service",
    });
    await ready(f);
    expect(await count("cpl_workflow_jobs", f.request.organizationId)).toBe(0);
  });
  it("rechecks the configuring actor membership version before every delayed action", async () => {
    const f = await fixture();
    await configure(f);
    await ready(f);
    await admin.query(
      "UPDATE cpl_memberships SET version=version+1 WHERE organization_id=$1 AND identity_id=$2",
      [f.request.organizationId, f.actor.session.identityId],
    );
    expect((await run(f)).status).toBe("skipped");
    expect(await count("cpl_commercial_proposals", f.request.organizationId)).toBe(0);
  });
  it("binds mutable job authority to the immutable configuring identity", async () => {
    const f = await fixture(),
      other = await signIn();
    await configure(f);
    await ready(f);
    await admin.query(
      "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'owner')",
      [f.request.organizationId, other.session.identityId],
    );
    await admin.query(
      "UPDATE cpl_workflow_jobs SET issued_by_identity_id=$2,issued_membership_version=1 WHERE organization_id=$1 AND kind='automation.recipe'",
      [f.request.organizationId, other.session.identityId],
    );
    expect((await run(f)).status).toBe("skipped");
    expect(await count("cpl_commercial_proposals", f.request.organizationId)).toBe(0);
  });
  it("keeps source attention without enabling or replaying a historical recipe", async () => {
    const f = await fixture();
    let w = await automation.getWorkspace(f.request);
    expect(w.counts.openTasks).toBe(1);
    expect(w.tasks[0]!.executionId).toBeNull();
    await ready(f);
    w = await automation.getWorkspace(f.request);
    expect(w.counts.openTasks).toBe(1);
    expect(w.tasks[0]!.group).toBe("next_actions");
    await commercial.createProposal({
      ...f.request,
      leadId: f.lead.id,
      templateId: f.template.id,
      idempotencyKey: randomUUID(),
    });
    w = await automation.getWorkspace(f.request);
    expect(w.counts.openTasks).toBe(0);
    expect(w.tasks[0]!.status).toBe("completed");
    expect(w.executions).toEqual([]);
    const history = await admin.query(
      "SELECT action FROM cpl_action_task_events WHERE organization_id=$1",
      [f.request.organizationId],
    );
    expect(history.rows.length).toBeGreaterThanOrEqual(3);
  });
  it("reconciles a governed proposal approval and rejects task completion as an approval substitute", async () => {
    const f = await fixture();
    await configure(f);
    await ready(f);
    await run(f);
    const task = (await automation.getWorkspace(f.request)).tasks.find((t) => t.executionId)!;
    expect(task.availableActions.canComplete).toBe(false);
    await expect(
      automation.updateTask({
        ...f.request,
        taskId: task.id,
        expectedRevision: task.revision,
        idempotencyKey: randomUUID(),
        action: "complete",
        reason: "Attempted shortcut",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    let p = await commercial.getProposal({ ...f.request, proposalId: task.target.id });
    p = await commercial.submitProposal({
      ...f.request,
      proposalId: p.id,
      expectedRevision: p.revision,
    });
    await commercial.reviewProposal({
      ...f.request,
      proposalId: p.id,
      expectedRevision: p.revision,
      decision: "approve",
    });
    const closed = (await automation.getWorkspace(f.request)).tasks.find((t) => t.id === task.id)!;
    expect(closed.status).toBe("completed");
    expect(closed.resolutionReason).toContain("approved");
    expect(closed.revision).toBeGreaterThan(task.revision);
  });
  it("refuses unrelated member and field-user mutation/readback of commercial tasks", async () => {
    const f = await fixture(),
      person = await signIn();
    await configure(f);
    await ready(f);
    await run(f);
    const task = (await automation.getWorkspace(f.request)).tasks.find((t) => t.executionId)!;
    await admin.query(
      "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'member')",
      [f.request.organizationId, person.session.identityId],
    );
    const request = { organizationId: f.request.organizationId, sessionToken: person.raw };
    await expect(
      automation.updateTask({
        ...request,
        taskId: task.id,
        expectedRevision: task.revision,
        idempotencyKey: randomUUID(),
        action: "start",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await admin.query(
      "UPDATE cpl_memberships SET role='field-user',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
      [f.request.organizationId, person.session.identityId],
    );
    const scoped = await automation.getWorkspace(request);
    expect(scoped.tasks).toEqual([]);
    expect(scoped.executions).toEqual([]);
    expect(scoped.counts.openTasks).toBe(0);
  });
  it("cancels a pending execution with an immutable multiline reason and stable repeat", async () => {
    const f = await fixture();
    await configure(f);
    await ready(f);
    const pending = await execution(f),
      request = {
        ...f.request,
        executionId: pending.id,
        expectedRevision: pending.revision,
        idempotencyKey: randomUUID(),
        reason: "Stop this handoff.\nOwner will handle it manually.",
      };
    const cancelled = await automation.cancelExecution(request);
    expect(cancelled.status).toBe("cancelled");
    expect((await automation.cancelExecution(request)).id).toBe(cancelled.id);
    await processHostedJobs(worker, { claimOwner: "cancel-check" });
    expect(await count("cpl_commercial_proposals", f.request.organizationId)).toBe(0);
    const history = await admin.query<{ details: { reason: string } }>(
      "SELECT details FROM cpl_automation_mutations WHERE organization_id=$1 AND mutation_kind='execution.cancel'",
      [f.request.organizationId],
    );
    expect(history.rows[0]!.details.reason).toBe(request.reason);
  });
  it("keeps the original worker kind isolated until explicit automation opt-in", async () => {
    const f = await fixture();
    await configure(f);
    await ready(f);
    const role = (await worker.query<{ current_user: string }>("SELECT current_user")).rows[0]!
      .current_user;
    await configureHostedRuntimeRole(admin, role, "worker");
    try {
      expect((await processHostedJobs(worker, { claimOwner: "historical-worker" })).claimed).toBe(
        0,
      );
      await expect(
        worker.query("SELECT cpl_automation_lock_authority($1,$2,$3)", [
          f.request.organizationId,
          (await execution(f)).id,
          randomUUID(),
        ]),
      ).rejects.toThrow();
    } finally {
      await configureCplAutomationWorker(admin, role);
    }
    expect((await run(f)).status).toBe("succeeded");
  });
  it("uses the exact existing award conversion once and creates a kickoff task", async () => {
    const f = await fixture();
    await configure(f, {
      ...f.input,
      trigger: "proposal.awarded",
      prepareDraft: false,
      templateId: null,
      templateVersion: null,
      templateApprovedForAutomation: false,
      taskTitle: "Plan kickoff",
    });
    const p = await awardFixture(f),
      completed = await run(f);
    expect(completed.status).toBe("succeeded");
    const handoff = completed.results.find((s) => s.step === "handoff")!;
    expect(handoff.target.kind).toBe("project");
    const project = await commercial.getProject({ ...f.request, projectId: handoff.target.id });
    expect(project.proposalId).toBe(p.id);
    expect(project.proposalVersion).toBe(p.currentVersion);
    expect(
      (
        await commercial.createProject({
          ...f.request,
          proposalId: p.id,
          idempotencyKey: randomUUID(),
        })
      ).id,
    ).toBe(project.id);
    const task = (await automation.getWorkspace(f.request)).tasks.find(
      (t) => t.executionId === completed.id,
    )!;
    expect(task.target.id).toBe(project.id);
    expect(task.customerName).toBe("Fictional Customer");
    expect(task.projectName).toBe(project.snapshot.version.content.title);
    expect(task.availableActions.canComplete).toBe(true);
    await admin.query(
      "UPDATE cpl_action_tasks SET display_context='{}'::jsonb WHERE organization_id=$1 AND id=$2",
      [f.request.organizationId, task.id],
    );
    const historical = (await automation.getWorkspace(f.request)).tasks.find(
      (item) => item.id === task.id,
    )!;
    expect(historical).toMatchObject({
      customerName: "Fictional Customer",
      projectName: project.snapshot.version.content.title,
      revision: task.revision,
    });
    expect(
      (
        await admin.query(
          "SELECT display_context FROM cpl_action_tasks WHERE organization_id=$1 AND id=$2",
          [f.request.organizationId, task.id],
        )
      ).rows[0]!.display_context,
    ).toEqual({});
  });
  it("prepares a pinned human report draft from completed eligible evidence and reconciles both review tasks after human approval", async () => {
    const f = await fixture(),
      p = await awardFixture(f),
      project = await commercial.createProject({
        ...f.request,
        proposalId: p.id,
        idempotencyKey: randomUUID(),
      }),
      executionRepo = new SqlCplExecutionRepository(tenants),
      field = new SqlCplFieldRepository(tenants),
      reports = new SqlCplReportRepository(tenants),
      request = { ...f.request, projectId: project.id };
    const visit = await executionRepo.createVisit({
        ...request,
        idempotencyKey: randomUUID(),
        input: {
          purpose: "Fictional inspection",
          serviceType: "Fictional service",
          status: "scheduled",
          timeZone: "America/Indiana/Indianapolis",
          plannedStartLocal: "2026-09-20T09:00",
          plannedEndLocal: "2026-09-20T10:00",
          plannedStartOffsetMinutes: null,
          plannedEndOffsetMinutes: null,
          responsibleIdentityId: f.actor.session.identityId,
          siteName: "Fictional site",
          siteAddress: "123 Example Road",
          accessInstructions: "",
          actualStartAt: null,
          actualEndAt: null,
          completionNote: "",
          cancellationReason: "",
          tasks: [],
        },
      }),
      scope = { ...request, visitId: visit.id };
    const fieldTemplate = await field.saveTemplate({
      ...f.request,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      input: {
        name: "Fictional field template",
        description: "Human entry",
        sections: [
          {
            id: randomUUID(),
            title: "Observed conditions",
            items: [
              {
                id: randomUUID(),
                label: "Optional context",
                instructions: "",
                type: "text",
                required: false,
                unit: "",
                options: [],
                naReasonRequired: true,
                minimumPhotos: 0,
              },
            ],
          },
        ],
      },
    });
    let fieldWorkspace = await field.attachTemplate({
      ...scope,
      expectedRevision: 0,
      templateId: fieldTemplate.id,
      templateVersion: fieldTemplate.version,
      idempotencyKey: randomUUID(),
    });
    fieldWorkspace = await field.saveObservation({
      ...scope,
      expectedRevision: fieldWorkspace.revision,
      idempotencyKey: randomUUID(),
      input: {
        title: "Human observation",
        description: "Visible measured condition",
        reportEligible: true,
        internalNotes: "PRIVATE FIELD CANARY",
      },
    });
    const eligibleId = fieldWorkspace.observations[0]!.id;
    await field.saveObservation({
      ...scope,
      expectedRevision: fieldWorkspace.revision,
      idempotencyKey: randomUUID(),
      input: {
        title: "PRIVATE EXCLUDED OBSERVATION",
        description: "PRIVATE EXCLUDED DETAIL",
        reportEligible: false,
      },
    });
    await reports.saveBranding({
      ...f.request,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      input: {
        businessName: "Fictional reports",
        email: "reports@example.invalid",
        phone: "",
        address: "",
        accentColor: "#123456",
        logoDataUrl: null,
      },
    });
    const reportTemplate = await reports.saveTemplate({
      ...f.request,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      input: {
        name: "Pinned report template",
        description: "Explicitly authorized template",
        title: "Fictional service report",
        scope: "",
        summary: "Human summary",
        limitations: "Accessible areas only",
        conclusion: "Human conclusion",
        sections: [],
        sectionOrder: ["scope", "summary", "limitations", "visits", "conclusion", "sections"],
      },
    });
    await configure(f, {
      ...f.input,
      name: "Prepare report",
      trigger: "fieldwork.submitted",
      templateId: reportTemplate.id,
      templateVersion: reportTemplate.version,
    });
    await configure(f, {
      ...f.input,
      name: "Review completed field work",
      trigger: "fieldwork.submitted",
      prepareDraft: false,
      templateId: null,
      templateVersion: null,
      templateApprovedForAutomation: false,
    });
    await executionRepo.saveVisit({
      ...scope,
      expectedRevision: visit.revision,
      idempotencyKey: randomUUID(),
      input: {
        ...visit,
        status: "completed",
        actualStartAt: "2026-09-20T13:00:00.000Z",
        actualEndAt: "2026-09-20T14:00:00.000Z",
        completionNote: "Human completed visit",
      },
    });
    for (let index = 0; index < 10; index++) {
      const pending = (await automation.getWorkspace(f.request)).executions.filter((item) =>
        ["queued", "running"].includes(item.status),
      );
      if (!pending.length) break;
      await processHostedJobs(worker, { claimOwner: "fictional-report-runner", limit: 1 });
    }
    const workspace = await automation.getWorkspace(f.request);
    expect(
      workspace.executions.map((item) => ({ status: item.status, error: item.lastErrorCode })),
    ).toEqual([
      { status: "succeeded", error: null },
      { status: "succeeded", error: null },
    ]);
    const reportResult = workspace.executions
      .flatMap((item) => item.results)
      .find((item) => item.step === "handoff" && item.target.kind === "report")!;
    const reportRequest = { ...request, reportId: reportResult.target.id };
    let report = await reports.getReport(reportRequest);
    expect(report.state).toBe("draft");
    const saved = report.versions.find((item) => item.version === report.currentVersion)!;
    expect(saved.content.visits[0]!.observations.map((item) => item.observationId)).toEqual([
      eligibleId,
    ]);
    expect(saved.template).toMatchObject({
      id: reportTemplate.id,
      version: reportTemplate.version,
    });
    const preview = await reports.getCustomerPreview({
      ...reportRequest,
      version: report.currentVersion,
    });
    expect(JSON.stringify(preview.projection)).not.toContain("PRIVATE");
    expect.soft(saved.content.scope).toBe(project.snapshot.version.content.scope);
    report = await reports.submitReport({
      ...reportRequest,
      expectedRevision: report.revision,
      idempotencyKey: randomUUID(),
    });
    const prepared = await reports.prepareApproval({
      ...reportRequest,
      expectedRevision: report.revision,
      idempotencyKey: randomUUID(),
    });
    if (prepared.status !== "prepared") throw Error("Expected real approval preparation");
    await reports.completeApproval({
      ...reportRequest,
      attemptId: prepared.attemptId,
      sha256: sha("Fictional SQL artifact fixture"),
      byteLength: 30,
      rendererVersion: "cpl-report-pdf-v1",
      idempotencyKey: randomUUID(),
    });
    const tasks = (await automation.getWorkspace(f.request)).tasks.filter(
      (item) => item.executionId !== null,
    );
    expect(tasks).toHaveLength(2);
    expect(tasks.every((item) => item.status === "completed")).toBe(true);
    expect(tasks.find((item) => item.target.kind === "visit")!.resolutionReason).toContain(
      "approved",
    );
  });
  it("does not revive a manually converted project cancelled before the award handoff", async () => {
    const f = await fixture();
    await configure(f, {
      ...f.input,
      trigger: "proposal.awarded",
      prepareDraft: false,
      templateId: null,
      templateVersion: null,
      templateApprovedForAutomation: false,
    });
    const p = await awardFixture(f),
      project = await commercial.createProject({
        ...f.request,
        proposalId: p.id,
        idempotencyKey: randomUUID(),
      }),
      executionRepo = new SqlCplExecutionRepository(tenants),
      request = { ...f.request, projectId: project.id };
    const before = await executionRepo.getProjectWorkspace(request);
    await executionRepo.saveProject({
      ...request,
      expectedRevision: before.operations.revision,
      idempotencyKey: randomUUID(),
      input: {
        ...before.operations,
        status: "cancelled",
        statusReason: "Fictional customer cancellation",
      },
    });
    expect((await run(f)).status).toBe("skipped");
    expect(
      (
        await admin.query(
          "SELECT count(*) AS total FROM cpl_commercial_projects WHERE organization_id=$1",
          [f.request.organizationId],
        )
      ).rows[0]?.total,
    ).toBe("1");
    expect(await count("cpl_action_tasks", f.request.organizationId)).toBe(0);
  });
  it("creates task-only human review after explicit field completion and hides it from unrelated field users", async () => {
    const f = await fixture(),
      p = await awardFixture(f),
      project = await commercial.createProject({
        ...f.request,
        proposalId: p.id,
        idempotencyKey: randomUUID(),
      }),
      executionRepo = new SqlCplExecutionRepository(tenants),
      request = { ...f.request, projectId: project.id };
    await configure(f, {
      ...f.input,
      trigger: "fieldwork.submitted",
      prepareDraft: false,
      templateId: null,
      templateVersion: null,
      templateApprovedForAutomation: false,
    });
    const visit = await executionRepo.createVisit({
      ...request,
      idempotencyKey: randomUUID(),
      input: {
        purpose: "Fictional inspection",
        serviceType: "Fictional service",
        status: "scheduled",
        timeZone: "America/Indiana/Indianapolis",
        plannedStartLocal: "2026-09-20T09:00",
        plannedEndLocal: "2026-09-20T10:00",
        plannedStartOffsetMinutes: null,
        plannedEndOffsetMinutes: null,
        responsibleIdentityId: f.actor.session.identityId,
        siteName: "Fictional site",
        siteAddress: "123 Example Road",
        accessInstructions: "",
        actualStartAt: null,
        actualEndAt: null,
        completionNote: "",
        cancellationReason: "",
        tasks: [],
      },
    });
    await executionRepo.saveVisit({
      ...request,
      visitId: visit.id,
      expectedRevision: visit.revision,
      idempotencyKey: randomUUID(),
      input: {
        ...visit,
        status: "completed",
        actualStartAt: "2026-09-20T13:00:00.000Z",
        actualEndAt: "2026-09-20T14:00:00.000Z",
        completionNote: "Human completed field visit",
      },
    });
    const completed = await run(f);
    expect(completed.status).toBe("succeeded");
    const task = (await automation.getWorkspace(f.request)).tasks.find(
      (t) => t.executionId === completed.id,
    )!;
    expect(task).toMatchObject({
      group: "reviews",
      status: "open",
      target: { kind: "visit", id: visit.id },
    });
    expect(task.availableActions.canComplete).toBe(false);
    const other = await signIn();
    await admin.query(
      "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'field-user')",
      [f.request.organizationId, other.session.identityId],
    );
    await automation.updateTask({
      ...f.request,
      taskId: task.id,
      expectedRevision: task.revision,
      idempotencyKey: randomUUID(),
      action: "assign",
      owner: { kind: "role", role: "field-user", identityId: null },
    });
    const hidden = await automation.getWorkspace({
      organizationId: f.request.organizationId,
      sessionToken: other.raw,
    });
    expect(hidden.tasks).toEqual([]);
    await expect(
      automation.updateTask({
        organizationId: f.request.organizationId,
        sessionToken: other.raw,
        taskId: task.id,
        expectedRevision: task.revision + 1,
        idempotencyKey: randomUUID(),
        action: "start",
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
  });
});
