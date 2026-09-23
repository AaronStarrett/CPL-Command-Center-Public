import { SqlCplExecutionRepository } from "../../packages/database/src/cpl-execution-repository";
import {
  CPL_EXECUTION_TIME_ZONE,
  type CplVisitInput,
} from "../../packages/domain/src/cpl-execution";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import { migrateDatabase, verifyMigrations } from "../../packages/database/src/migrations";
import {
  configureHostedRuntimeRole,
  verifyHostedDatabaseRole,
} from "../../packages/database/src/hosted-database-role";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store";
import {
  SqlCplTenantRepository,
  type CplTenantRequest,
} from "../../packages/database/src/tenant-repository";
import { SqlCplWorkflowRepository } from "../../packages/database/src/hosted-workflow";
import { SqlCplCommercialRepository } from "../../packages/database/src/cpl-commercial-repository";
import {
  defaultCplCommercialBranding,
  type CplCommercialProposal,
} from "../../packages/domain/src/cpl-commercial";

const material = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON;
const configPath = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG;
const suite = material || configPath ? describe : describe.skip;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
suite("tenant project execution on isolated real PostgreSQL", () => {
  let control: PgSqlDatabaseAdapter,
    admin: PgSqlDatabaseAdapter,
    web: PgSqlDatabaseAdapter,
    auth: SqlCplHostedAuthStore,
    tenants: SqlCplTenantRepository,
    intake: SqlCplWorkflowRepository,
    commercial: SqlCplCommercialRepository,
    execution: SqlCplExecutionRepository;
  const databaseName = `cpl_execution_test_${randomBytes(6).toString("hex")}`;
  let created = false;
  const connection = (url: string) => {
    const value = new URL(url);
    value.pathname = `/${databaseName}`;
    return value.toString();
  };
  beforeAll(async () => {
    const config = JSON.parse(material ?? readFileSync(configPath!, "utf8"));
    for (const value of [config.adminUrl, config.webUrl])
      if (!["127.0.0.1", "localhost"].includes(new URL(value).hostname))
        throw Error("Local isolated PostgreSQL only");
    control = new PgSqlDatabaseAdapter({ connectionString: config.adminUrl, max: 1 });
    await control.execute(`CREATE DATABASE "${databaseName}"`);
    created = true;
    admin = new PgSqlDatabaseAdapter({ connectionString: connection(config.adminUrl), max: 2 });
    await migrateDatabase(admin);
    await configureHostedRuntimeRole(admin, new URL(config.webUrl).username, "web");
    web = new PgSqlDatabaseAdapter({
      connectionString: connection(config.webUrl),
      max: 3,
      statement_timeout: 10000,
    });
    auth = new SqlCplHostedAuthStore(web);
    tenants = new SqlCplTenantRepository(web);
    intake = new SqlCplWorkflowRepository(web, tenants);
    commercial = new SqlCplCommercialRepository(tenants);
    execution = new SqlCplExecutionRepository(tenants);
  }, 180000);
  afterAll(async () => {
    await Promise.all([web?.close(), admin?.close()]);
    if (created) await control.execute(`DROP DATABASE "${databaseName}" WITH(FORCE)`);
    await control?.close();
  }, 60000);
  async function signIn() {
    const raw = token(),
      now = new Date().toISOString();
    const session = await auth.createSession({
      identity: {
        issuer: "https://accounts.google.com",
        subject: randomUUID(),
        email: "fictional@example.invalid",
        emailVerified: true,
        hostedDomain: null,
        displayName: "Fictional Owner",
        authenticatedAt: now,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      material: {
        tokenHash: sha(raw),
        csrfTokenHash: sha(token()),
        expiresAt: new Date(Date.now() + 3500000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 28000000).toISOString(),
      },
      now,
    });
    return { session, raw };
  }
  async function workspace() {
    const actor = await signIn();
    const org = await tenants.createOrganization(actor.raw, {
      slug: randomUUID(),
      displayName: "Fictional Services",
    });
    const request = { sessionToken: actor.raw, organizationId: org.id };
    await admin.query(
      "UPDATE cpl_module_entitlements SET enabled=TRUE,usage_limit=NULL WHERE organization_id=$1 AND module_key IN ('intake-job-tracker','proposal-builder','award-to-project-launcher')",
      [org.id],
    );
    const lead = await intake.createLead({
      ...request,
      title: "Fictional inspection",
      contactName: "Fictional Contact",
      contactEmail: "customer@example.invalid",
      customerName: "Fictional Customer",
      siteName: "Example site",
      siteAddress: "123 Fictional Road",
      details: "Confirmed inspection scope",
      requestedService: "Inspection",
      assignedMemberIdentityId: actor.session.identityId,
      nextAction: "Quote",
      notes: "PRIVATE LEAD NOTE",
      evidenceNote: "PRIVATE SOURCE NOTE",
      sourceReference: "reference:fictional-inquiry",
      idempotencyKey: randomUUID(),
    });
    await intake.updateLead({
      ...request,
      leadId: lead.id,
      expectedVersion: lead.version,
      status: "ready_for_proposal",
    });
    await commercial.saveBranding({
      ...request,
      expectedRevision: 0,
      input: {
        ...defaultCplCommercialBranding(),
        businessName: "Fictional Services",
        discountEnabled: true,
        taxEnabled: true,
      },
    });
    return { request, actor, lead };
  }
  async function proposal(request: CplTenantRequest, leadId: string) {
    return commercial.createProposal({ ...request, leadId, idempotencyKey: randomUUID() });
  }
  async function saved(request: CplTenantRequest, p: CplCommercialProposal) {
    return commercial.saveProposal({
      ...request,
      proposalId: p.id,
      expectedRevision: p.revision,
      internalNotes: "PRIVATE PROPOSAL NOTE",
      content: {
        ...p.versions[0]!.content,
        lineItems: [
          {
            description: "Inspection",
            serviceCode: "inspect",
            quantity: "2.5",
            unit: "hours",
            unitPriceMinor: 12500,
          },
        ],
        discountMinor: 1250,
        taxBasisPoints: 500,
        schedule: "Within two weeks",
        startDate: "2026-10-01",
        endDate: "2026-10-02",
        accessInstructions: "PRIVATE ACCESS CODE",
        constraints: "PRIVATE OPERATIONAL CONSTRAINT",
      },
    });
  }
  async function approved(request: CplTenantRequest, p: CplCommercialProposal) {
    p = await saved(request, p);
    p = await commercial.submitProposal({
      ...request,
      proposalId: p.id,
      expectedRevision: p.revision,
    });
    return commercial.reviewProposal({
      ...request,
      proposalId: p.id,
      expectedRevision: p.revision,
      decision: "approve",
    });
  }
  function awardInput(p: CplCommercialProposal) {
    return {
      awardDate: "2026-09-23",
      amountMinor: p.versions[0]!.totals.totalMinor,
      currency: "USD",
      purchaseOrder: "FICTIONAL-PO-1",
      startDate: "2026-10-01",
      notes: "Fictional award confirmed manually",
    };
  }
  async function awarded(request: CplTenantRequest, p: CplCommercialProposal) {
    p = await approved(request, p);
    return commercial.recordOutcome({
      ...request,
      proposalId: p.id,
      expectedRevision: p.revision,
      outcome: "awarded",
      award: awardInput(p),
      idempotencyKey: randomUUID(),
    });
  }
  async function projectFixture() {
    const f = await workspace();
    const p = await awarded(f.request, await proposal(f.request, f.lead.id));
    const project = await commercial.createProject({
      ...f.request,
      proposalId: p.id,
      idempotencyKey: randomUUID(),
    });
    return { ...f, project, query: { ...f.request, projectId: project.id } };
  }
  function appointment(identityId: string, patch: Partial<CplVisitInput> = {}): CplVisitInput {
    return {
      purpose: "Fictional site visit",
      serviceType: "Site observation",
      status: "scheduled",
      timeZone: CPL_EXECUTION_TIME_ZONE,
      plannedStartLocal: "2026-10-12T09:00",
      plannedEndLocal: "2026-10-12T10:00",
      plannedStartOffsetMinutes: null,
      plannedEndOffsetMinutes: null,
      responsibleIdentityId: identityId,
      siteName: "Fictional site",
      siteAddress: "123 Fictional Road",
      accessInstructions: "Private access note",
      actualStartAt: null,
      actualEndAt: null,
      completionNote: "",
      cancellationReason: "",
      tasks: [
        {
          id: randomUUID(),
          title: "Confirm site context",
          instructions: "Human entry required",
          required: true,
          status: "pending",
          note: "",
        },
      ],
      ...patch,
    };
  }
  async function member(f: Awaited<ReturnType<typeof projectFixture>>, role: string) {
    const user = await signIn();
    await admin.query(
      "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,$3)",
      [f.request.organizationId, user.session.identityId, role],
    );
    return {
      ...user,
      query: {
        organizationId: f.request.organizationId,
        sessionToken: user.raw,
        projectId: f.project.id,
      },
    };
  }
  it("migrates empty without new seeds and verifies the restricted role", async () => {
    expect((await verifyMigrations(admin)).current).toBe("0035_cpl_delivery_closeout.sql");
    await expect(verifyHostedDatabaseRole(web, "web")).resolves.toMatchObject({ purpose: "web" });
    expect((await admin.query("SELECT count(*) FROM cpl_project_operations")).rows[0]?.count).toBe(
      "0",
    );
  });
  it("reads operational defaults without writes and preserves immutable commercial lineage", async () => {
    const f = await projectFixture(),
      before = sha(JSON.stringify(f.project.snapshot));
    const loaded = await execution.getProjectWorkspace(f.query);
    expect(loaded.operations).toMatchObject({ revision: 0, timeZone: CPL_EXECUTION_TIME_ZONE });
    expect(
      (
        await admin.query("SELECT count(*) FROM cpl_project_operations WHERE project_id=$1", [
          f.project.id,
        ])
      ).rows[0]?.count,
    ).toBe("0");
    const input = {
      ...loaded.operations,
      name: "Fictional execution plan",
      ownerIdentityId: f.actor.session.identityId,
      teamIdentityIds: [f.actor.session.identityId],
      operationalInstructions: "Updated access only",
      nextAction: "Schedule visits",
    };
    const request = { ...f.query, expectedRevision: 0, idempotencyKey: randomUUID(), input };
    const saved = await execution.saveProject(request),
      retried = await execution.saveProject(request);
    expect(saved.operations.revision).toBe(1);
    expect(retried.operations.revision).toBe(1);
    expect(sha(JSON.stringify(saved.project.snapshot))).toBe(before);
    expect(saved.project.proposalVersion).toBe(f.project.proposalVersion);
    expect(saved.events).toHaveLength(1);
    await expect(
      execution.saveProject({ ...request, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CPL_EXECUTION_VERSION_CONFLICT" });
  });
  it("saves two visits, reschedules, cancels one without cancelling project, and keeps history", async () => {
    const f = await projectFixture();
    const first = await execution.createVisit({
      ...f.query,
      idempotencyKey: randomUUID(),
      input: appointment(f.actor.session.identityId),
    });
    const second = await execution.createVisit({
      ...f.query,
      idempotencyKey: randomUUID(),
      input: appointment(f.actor.session.identityId, {
        plannedStartLocal: "2026-10-12T10:00",
        plannedEndLocal: "2026-10-12T11:00",
      }),
    });
    const moved = await execution.saveVisit({
      ...f.query,
      visitId: second.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: {
        ...second,
        plannedStartLocal: "2026-10-13T10:00",
        plannedEndLocal: "2026-10-13T11:00",
      },
    });
    const cancelled = await execution.saveVisit({
      ...f.query,
      visitId: first.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: { ...first, status: "cancelled", cancellationReason: "Customer changed appointment" },
    });
    expect(moved.plannedStartAt).toBe("2026-10-13T14:00:00.000Z");
    expect(cancelled.status).toBe("cancelled");
    const loaded = await execution.getProjectWorkspace(f.query);
    expect(loaded.operations.status).toBe("active");
    expect(loaded.visits).toHaveLength(2);
    expect(loaded.events).toHaveLength(4);
    expect(loaded.events.find((e) => e.action === "visit.updated")?.before).toMatchObject({
      plannedStartLocal: "2026-10-12T10:00",
    });
    expect(
      (
        await execution.readAgenda({
          ...f.request,
          from: "2026-10-01T00:00:00Z",
          to: "2026-11-01T00:00:00Z",
        })
      ).items,
    ).toHaveLength(2);
  });
  it("serializes concurrent overlapping assignments and permits adjacent windows", async () => {
    const f = await projectFixture(),
      input = appointment(f.actor.session.identityId);
    const results = await Promise.allSettled([
      execution.createVisit({ ...f.query, idempotencyKey: randomUUID(), input }),
      execution.createVisit({
        ...f.query,
        idempotencyKey: randomUUID(),
        input: { ...input, tasks: [] },
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({
      code: "CPL_EXECUTION_SCHEDULE_CONFLICT",
      conflicts: [
        expect.objectContaining({
          projectId: f.project.id,
          plannedStartAt: "2026-10-12T13:00:00.000Z",
        }),
      ],
    });
    await expect(
      execution.createVisit({
        ...f.query,
        idempotencyKey: randomUUID(),
        input: appointment(f.actor.session.identityId, {
          plannedStartLocal: "2026-10-12T10:00",
          plannedEndLocal: "2026-10-12T11:00",
        }),
      }),
    ).resolves.toMatchObject({ revision: 1 });
  });
  it("rejects stale concurrent edits and returns exact lost-response retries without another event", async () => {
    const f = await projectFixture(),
      v = await execution.createVisit({
        ...f.query,
        idempotencyKey: randomUUID(),
        input: appointment(f.actor.session.identityId),
      });
    const input = { ...v, purpose: "Corrected purpose" },
      request = {
        ...f.query,
        visitId: v.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        input,
      };
    const results = await Promise.allSettled([
      execution.saveVisit(request),
      execution.saveVisit({
        ...request,
        idempotencyKey: randomUUID(),
        input: { ...input, purpose: "Different correction" },
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code,
    ).toBe("CPL_EXECUTION_VERSION_CONFLICT");
    const succeeded = results[0]!.status === "fulfilled";
    if (succeeded) expect((await execution.saveVisit(request)).revision).toBe(2);
    const events = (await execution.getProjectWorkspace(f.query)).events;
    expect(events).toHaveLength(2);
    await expect(
      execution.createVisit({
        ...f.query,
        idempotencyKey: request.idempotencyKey,
        input: appointment(f.actor.session.identityId),
      }),
    ).rejects.toMatchObject({ code: "CPL_EXECUTION_SCHEDULE_CONFLICT" });
  });
  it("preserves incomplete drafts and blocks completion until required tasks and actual details exist", async () => {
    const f = await projectFixture();
    const draft = await execution.createVisit({
      ...f.query,
      idempotencyKey: randomUUID(),
      input: appointment(f.actor.session.identityId, {
        status: "draft",
        responsibleIdentityId: null,
        plannedStartLocal: null,
        plannedEndLocal: null,
      }),
    });
    expect(draft.readiness.some((r) => r.code === "responsible_required")).toBe(true);
    const v = await execution.createVisit({
      ...f.query,
      idempotencyKey: randomUUID(),
      input: appointment(f.actor.session.identityId),
    });
    const actual = {
      actualStartAt: "2026-09-01T13:00:00Z",
      actualEndAt: "2026-09-01T14:00:00Z",
      completionNote: "Work recorded by person",
      status: "completed",
    };
    await expect(
      execution.saveVisit({
        ...f.query,
        visitId: v.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        input: { ...v, ...actual },
      }),
    ).rejects.toMatchObject({ code: "CPL_EXECUTION_VISIT_NOT_READY" });
    const completed = await execution.saveVisit({
      ...f.query,
      visitId: v.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: { ...v, ...actual, tasks: v.tasks.map((t) => ({ ...t, status: "completed" })) },
    });
    expect(completed.status).toBe("completed");
    expect(completed.readiness).toEqual([]);
    await expect(
      execution.saveVisit({
        ...f.query,
        visitId: v.id,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
        input: { ...completed, purpose: "Silent completed edit" },
      }),
    ).rejects.toMatchObject({ code: "CPL_EXECUTION_STATE_CONFLICT" });
  });
  it("restricts field users to their assigned visit execution and denies reviewer planning", async () => {
    const f = await projectFixture(),
      field = await member(f, "field-user"),
      reviewer = await member(f, "reviewer");
    const v = await execution.createVisit({
      ...f.query,
      idempotencyKey: randomUUID(),
      input: appointment(field.session.identityId),
    });
    await expect(
      execution.createVisit({
        ...field.query,
        idempotencyKey: randomUUID(),
        input: appointment(field.session.identityId),
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(
      execution.saveVisit({
        ...field.query,
        visitId: v.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        input: {
          ...v,
          status: "in_progress",
          actualStartAt: "2026-09-01T13:00:00Z",
          plannedStartLocal: "2026-10-13T09:00",
          plannedEndLocal: "2026-10-13T10:00",
        },
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    const started = await execution.saveVisit({
      ...field.query,
      visitId: v.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: { ...v, status: "in_progress", actualStartAt: "2026-09-01T13:00:00Z" },
    });
    expect(started.status).toBe("in_progress");
    await expect(
      execution.saveVisit({
        ...reviewer.query,
        visitId: v.id,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
        input: { ...started, completionNote: "Unauthorized" },
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    const other = await member(f, "field-user");
    await expect(
      execution.saveVisit({
        ...other.query,
        visitId: v.id,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
        input: started,
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
  });
  it("refuses inactive and foreign assignments without leaving an idempotency reservation", async () => {
    const f = await projectFixture(),
      foreign = await signIn(),
      assigned = await member(f, "member");
    await expect(
      execution.createVisit({
        ...f.query,
        idempotencyKey: randomUUID(),
        input: appointment(foreign.session.identityId),
      }),
    ).rejects.toMatchObject({ code: "CPL_EXECUTION_MEMBER_UNAVAILABLE" });
    await admin.query(
      "UPDATE cpl_memberships SET status='suspended' WHERE organization_id=$1 AND identity_id=$2",
      [f.request.organizationId, assigned.session.identityId],
    );
    const key = randomUUID();
    await expect(
      execution.createVisit({
        ...f.query,
        idempotencyKey: key,
        input: appointment(assigned.session.identityId),
      }),
    ).rejects.toMatchObject({ code: "CPL_EXECUTION_MEMBER_UNAVAILABLE" });
    expect(
      (
        await admin.query("SELECT count(*) FROM cpl_execution_mutations WHERE idempotency_key=$1", [
          key,
        ])
      ).rows[0]?.count,
    ).toBe("0");
  });
  it("blocks project termination with unfinished visits while cancellation stays project-local", async () => {
    const f = await projectFixture(),
      loaded = await execution.getProjectWorkspace(f.query);
    await execution.createVisit({
      ...f.query,
      idempotencyKey: randomUUID(),
      input: appointment(f.actor.session.identityId),
    });
    await expect(
      execution.saveProject({
        ...f.query,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        input: { ...loaded.operations, status: "cancelled", statusReason: "Cancel project" },
      }),
    ).rejects.toMatchObject({ code: "CPL_EXECUTION_OPEN_VISITS" });
    expect((await execution.getProjectWorkspace(f.query)).operations.revision).toBe(0);
  });
  it("enforces tenant and parent ownership for reads, agenda, edits, task IDs and raw RLS", async () => {
    const a = await projectFixture(),
      b = await projectFixture();
    const va = await execution.createVisit({
      ...a.query,
      idempotencyKey: randomUUID(),
      input: appointment(a.actor.session.identityId),
    });
    await expect(
      execution.getProjectWorkspace({ ...b.request, projectId: a.project.id }),
    ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    await expect(execution.getVisit({ ...b.query, visitId: va.id })).rejects.toMatchObject({
      code: "CPL_RECORD_NOT_FOUND",
    });
    expect(
      (
        await execution.readAgenda({
          ...b.request,
          from: "2026-10-01T00:00:00Z",
          to: "2026-11-01T00:00:00Z",
        })
      ).items,
    ).toEqual([]);
    const second = await commercial.createProposal({
      ...a.request,
      leadId: a.lead.id,
      allowAdditional: true,
      idempotencyKey: randomUUID(),
    });
    const awardedSecond = await awarded(a.request, second);
    const pb = await commercial.createProject({
      ...a.request,
      proposalId: awardedSecond.id,
      idempotencyKey: randomUUID(),
    });
    await expect(
      execution.createVisit({
        ...a.request,
        projectId: pb.id,
        idempotencyKey: randomUUID(),
        input: appointment(a.actor.session.identityId, { status: "draft", tasks: va.tasks }),
      }),
    ).rejects.toMatchObject({ code: "CPL_INVALID_INPUT" });
    const leaked = await web.transaction(async (e) => {
      await e.query("SELECT set_config('cpl.organization_id',$1,true)", [b.request.organizationId]);
      return e.query("SELECT id FROM cpl_project_visits WHERE id=$1", [va.id]);
    });
    expect(leaked.rows).toEqual([]);
    await expect(
      admin.query("UPDATE cpl_commercial_projects SET reference='changed' WHERE id=$1", [
        a.project.id,
      ]),
    ).rejects.toThrow();
  });
  it("rolls back visits, tasks, events and idempotency after required audit failure", async () => {
    const f = await projectFixture(),
      key = randomUUID();
    await admin.execute(
      "CREATE FUNCTION cpl_execution_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='visit.created' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER cpl_execution_test_audit_failure BEFORE INSERT ON cpl_tenant_audit_events FOR EACH ROW EXECUTE FUNCTION cpl_execution_test_audit_failure();",
    );
    try {
      await expect(
        execution.createVisit({
          ...f.query,
          idempotencyKey: key,
          input: appointment(f.actor.session.identityId),
        }),
      ).rejects.toThrow();
    } finally {
      await admin.execute(
        "DROP TRIGGER cpl_execution_test_audit_failure ON cpl_tenant_audit_events; DROP FUNCTION cpl_execution_test_audit_failure();",
      );
    }
    expect((await execution.getProjectWorkspace(f.query)).visits).toEqual([]);
    expect(
      (
        await admin.query("SELECT count(*) FROM cpl_execution_mutations WHERE idempotency_key=$1", [
          key,
        ])
      ).rows[0]?.count,
    ).toBe("0");
    await expect(
      execution.createVisit({
        ...f.query,
        idempotencyKey: key,
        input: appointment(f.actor.session.identityId),
      }),
    ).resolves.toMatchObject({ revision: 1 });
  });
  it("rejects payload reuse, keeps event history immutable and fails closed on missing RLS", async () => {
    const f = await projectFixture(),
      key = randomUUID(),
      input = appointment(f.actor.session.identityId);
    await execution.createVisit({ ...f.query, idempotencyKey: key, input });
    await expect(
      execution.createVisit({
        ...f.query,
        idempotencyKey: key,
        input: { ...input, purpose: "Changed payload" },
      }),
    ).rejects.toMatchObject({ code: "CPL_IDEMPOTENCY_CONFLICT" });
    await expect(
      admin.query("DELETE FROM cpl_execution_events WHERE project_id=$1", [f.project.id]),
    ).rejects.toThrow();
    await admin.execute("ALTER TABLE cpl_project_tasks NO FORCE ROW LEVEL SECURITY");
    try {
      await expect(execution.getProjectWorkspace(f.query)).rejects.toMatchObject({
        code: "CPL_EXECUTION_SCHEMA_UNSAFE",
      });
    } finally {
      await admin.execute("ALTER TABLE cpl_project_tasks FORCE ROW LEVEL SECURITY");
    }
    const context = await web.query<{ org: string | null; identity: string | null }>(
      "SELECT current_setting('cpl.organization_id',true) AS org,current_setting('cpl.identity_id',true) AS identity",
    );
    expect(context.rows[0]?.org || "").toBe("");
    expect(context.rows[0]?.identity || "").toBe("");
  });
});
