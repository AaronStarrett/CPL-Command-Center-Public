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
suite("tenant commercial spine on isolated real PostgreSQL", () => {
  let control: PgSqlDatabaseAdapter,
    admin: PgSqlDatabaseAdapter,
    web: PgSqlDatabaseAdapter,
    auth: SqlCplHostedAuthStore,
    tenants: SqlCplTenantRepository,
    intake: SqlCplWorkflowRepository,
    commercial: SqlCplCommercialRepository;
  const databaseName = `cpl_commercial_test_${randomBytes(6).toString("hex")}`;
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
  it("migrates empty without business seeds and verifies the restricted role", async () => {
    expect((await verifyMigrations(admin)).current).toBe("0035_cpl_delivery_closeout.sql");
    await expect(verifyHostedDatabaseRole(web, "web")).resolves.toMatchObject({ purpose: "web" });
    expect(
      (await admin.query("SELECT count(*) FROM cpl_commercial_proposals")).rows[0]?.count,
    ).toBe("0");
    expect((await migrateDatabase(admin)).applied).toEqual([]);
  });
  it("creates one default proposal for concurrent attempts and allows an explicit additional quote", async () => {
    const f = await workspace();
    const input = { ...f.request, leadId: f.lead.id, idempotencyKey: randomUUID() };
    const [a, b] = await Promise.all([
      commercial.createProposal(input),
      commercial.createProposal({ ...input, idempotencyKey: randomUUID() }),
    ]);
    expect(a.id).toBe(b.id);
    expect((await commercial.createProposal(input)).id).toBe(a.id);
    const c = await commercial.createProposal({
      ...input,
      allowAdditional: true,
      idempotencyKey: randomUUID(),
    });
    expect(c.id).not.toBe(a.id);
    await expect(
      commercial.createProposal({ ...input, allowAdditional: true }),
    ).rejects.toMatchObject({ code: "CPL_IDEMPOTENCY_CONFLICT" });
  });
  it("preserves legacy drafts during explicit scoped upgrade", async () => {
    const f = await workspace();
    const legacy = await intake.createProposalDraft({
      ...f.request,
      leadId: f.lead.id,
      title: "Legacy",
      content: "Immutable copied legacy scope",
      idempotencyKey: randomUUID(),
    });
    const p = await commercial.createProposal({
      ...f.request,
      leadId: f.lead.id,
      legacyDraftId: legacy.id,
      idempotencyKey: randomUUID(),
    });
    expect(p.legacyDraftId).toBe(legacy.id);
    expect(p.versions[0]?.content.scope).toContain("Preserved legacy manual draft (version 1)");
    expect(p.versions[0]?.content.scope).toContain(legacy.content);
    expect(await intake.getProposalDraft({ ...f.request, proposalId: legacy.id })).toEqual(legacy);
  });
  it("requires a ready lead and rolls back failed idempotency reservation", async () => {
    const f = await workspace();
    await intake.updateLead({
      ...f.request,
      leadId: f.lead.id,
      expectedVersion: 2,
      status: "needs_info",
    });
    const key = randomUUID();
    await expect(
      commercial.createProposal({ ...f.request, leadId: f.lead.id, idempotencyKey: key }),
    ).rejects.toMatchObject({ code: "CPL_LEAD_NOT_READY" });
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM cpl_workflow_mutations WHERE organization_id=$1 AND idempotency_key=$2",
          [f.request.organizationId, key],
        )
      ).rows[0]?.count,
    ).toBe("0");
  });
  it("keeps every saved version immutable and rejects stale concurrent editors", async () => {
    const f = await workspace();
    const p = await proposal(f.request, f.lead.id);
    const results = await Promise.allSettled([saved(f.request, p), saved(f.request, p)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.find((x) => x.status === "rejected")).toMatchObject({
      reason: { code: "CPL_COMMERCIAL_VERSION_CONFLICT" },
    });
    const detail = await commercial.getProposal({ ...f.request, proposalId: p.id });
    expect(detail.versions).toHaveLength(2);
    expect(detail.versions[1]).toEqual(p.versions[0]);
    expect(detail.versions[0]?.totals.totalMinor).toBe(31500);
  });
  it("separates reviewer authority, review state and quoted versions", async () => {
    const f = await workspace(),
      reviewer = await signIn();
    await admin.query(
      "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'reviewer')",
      [f.request.organizationId, reviewer.session.identityId],
    );
    const r = { sessionToken: reviewer.raw, organizationId: f.request.organizationId };
    let p = await saved(f.request, await proposal(f.request, f.lead.id));
    await expect(
      commercial.reviewProposal({
        ...f.request,
        proposalId: p.id,
        expectedRevision: p.revision,
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "CPL_COMMERCIAL_STATE_CONFLICT" });
    p = await commercial.submitProposal({
      ...f.request,
      proposalId: p.id,
      expectedRevision: p.revision,
    });
    await expect(
      commercial.saveProposal({
        ...r,
        proposalId: p.id,
        expectedRevision: p.revision,
        content: p.versions[0]!.content,
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    const reviewed = await commercial.reviewProposal({
      ...r,
      proposalId: p.id,
      expectedRevision: p.revision,
      decision: "request_changes",
      reason: "Clarify exclusions",
    });
    expect(reviewed.state).toBe("revision_requested");
    expect(reviewed.currentVersion).toBe(p.currentVersion);
    expect(reviewed.versions).toEqual(p.versions);
    const changed = await saved(f.request, reviewed);
    expect(changed.currentVersion).toBe(p.currentVersion + 1);
    expect(changed.state).toBe("draft");
  });
  it("blocks unapproved artifacts/awards and strips internal provenance from customer output", async () => {
    const f = await workspace();
    let p = await proposal(f.request, f.lead.id);
    await expect(
      commercial.getApprovedPdf({ ...f.request, proposalId: p.id }),
    ).rejects.toMatchObject({ code: "CPL_APPROVED_VERSION_REQUIRED" });
    await expect(
      commercial.recordOutcome({
        ...f.request,
        proposalId: p.id,
        expectedRevision: p.revision,
        outcome: "awarded",
        award: awardInput(p),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_APPROVED_VERSION_REQUIRED" });
    p = await approved(f.request, p);
    const projected = await commercial.getApprovedPdf({ ...f.request, proposalId: p.id });
    expect(projected.content.schedule).toBe("Within two weeks");
    expect(JSON.stringify(projected)).not.toContain("PRIVATE");
    expect(projected.content).not.toHaveProperty("accessInstructions");
    expect(projected.content).not.toHaveProperty("constraints");
    const draftPreview = await commercial.getCustomerPreview({
      ...f.request,
      proposalId: p.id,
      version: 1,
    });
    expect(draftPreview.approved).toBe(false);
    expect(draftPreview.document.approvedAt).toBe("");
  });
  it("stores immutable artifact bytes bound to exact approved projection and survives later edits", async () => {
    const f = await workspace();
    let p = await approved(f.request, await proposal(f.request, f.lead.id));
    const dto = await commercial.getApprovedPdf({ ...f.request, proposalId: p.id });
    const bytes = new TextEncoder().encode("%PDF-1.7\nFictional fixture bytes\n%%EOF");
    const req = {
      ...f.request,
      proposalId: p.id,
      version: p.currentVersion,
      projectionSha256: sha(JSON.stringify(dto)),
      bytes,
      rendererVersion: "fixture-v1",
    };
    const artifact = await commercial.recordArtifact(req);
    expect(await commercial.recordArtifact(req)).toEqual(artifact);
    expect(
      (
        await commercial.getPdfArtifact({
          ...f.request,
          proposalId: p.id,
          version: p.currentVersion,
        })
      ).bytes,
    ).toEqual(bytes);
    await expect(
      commercial.recordArtifact({
        ...req,
        bytes: new TextEncoder().encode("%PDF-1.7\nChanged\n%%EOF"),
      }),
    ).rejects.toMatchObject({ code: "CPL_ARTIFACT_IMMUTABLE" });
    p = await commercial.reviseProposal({
      ...f.request,
      proposalId: p.id,
      expectedRevision: p.revision,
      reason: "New scope",
    });
    await expect(commercial.recordArtifact(req)).rejects.toMatchObject({
      code: "CPL_APPROVED_VERSION_REQUIRED",
    });
    expect(
      (await commercial.getPdfArtifact({ ...f.request, proposalId: p.id, version: req.version }))
        .metadata.sha256,
    ).toBe(artifact.sha256);
  });
  it("refuses mismatched totals and records one immutable idempotent award", async () => {
    const f = await workspace();
    let p = await approved(f.request, await proposal(f.request, f.lead.id));
    const input = {
      ...f.request,
      proposalId: p.id,
      expectedRevision: p.revision,
      outcome: "awarded" as const,
      award: awardInput(p),
      idempotencyKey: randomUUID(),
    };
    await expect(
      commercial.recordOutcome({ ...input, award: { ...input.award, amountMinor: 1 } }),
    ).rejects.toMatchObject({ code: "CPL_AWARD_TOTAL_MISMATCH" });
    p = await commercial.recordOutcome(input);
    expect(p.state).toBe("awarded");
    expect((await commercial.recordOutcome(input)).award).toEqual(p.award);
    await expect(
      commercial.saveProposal({
        ...f.request,
        proposalId: p.id,
        expectedRevision: p.revision,
        content: p.versions[0]!.content,
      }),
    ).rejects.toMatchObject({ code: "CPL_COMMERCIAL_STATE_CONFLICT" });
  });
  it("converts an award once under concurrency and preserves exact lineage and operational notes", async () => {
    const f = await workspace();
    const p = await awarded(f.request, await proposal(f.request, f.lead.id));
    const req = { ...f.request, proposalId: p.id, idempotencyKey: randomUUID() };
    const [a, b] = await Promise.all([
      commercial.createProject(req),
      commercial.createProject({ ...req, idempotencyKey: randomUUID() }),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.snapshot.version).toEqual(p.versions[0]);
    expect(a.snapshot.award).toEqual(p.award);
    expect(a.snapshot.internalNotes).toBe("PRIVATE PROPOSAL NOTE");
    expect(a.snapshot.version.sourceLead.fields.notes).toBe("PRIVATE LEAD NOTE");
    expect(a.snapshot.version.sourceLead.evidence[0]?.note).toBe("PRIVATE SOURCE NOTE");
    expect(await commercial.getProject({ ...f.request, projectId: a.id })).toEqual(a);
    expect((await commercial.createProject(req)).id).toBe(a.id);
    expect(
      (
        await admin.query("SELECT count(*) FROM cpl_commercial_projects WHERE organization_id=$1", [
          f.request.organizationId,
        ])
      ).rows[0]?.count,
    ).toBe("1");
  });
  it("enforces the independent project entitlement without blocking the proposal workspace", async () => {
    const f = await workspace();
    const p = await awarded(f.request, await proposal(f.request, f.lead.id));
    const created = await commercial.createProject({
      ...f.request,
      proposalId: p.id,
      idempotencyKey: randomUUID(),
    });
    await admin.query(
      "UPDATE cpl_module_entitlements SET enabled=FALSE WHERE organization_id=$1 AND module_key='award-to-project-launcher'",
      [f.request.organizationId],
    );
    expect((await commercial.readWorkspace(f.request)).permissions.canCreateProject).toBe(false);
    expect((await commercial.getProposal({ ...f.request, proposalId: p.id })).project).toBeNull();
    await expect(
      commercial.getProject({ ...f.request, projectId: created.id }),
    ).rejects.toMatchObject({ code: "CPL_MODULE_DISABLED" });
    await expect(
      commercial.createProject({ ...f.request, proposalId: p.id, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CPL_MODULE_DISABLED" });
  });
  it("initializes template catalog defaults and freezes company/template snapshots across later settings changes", async () => {
    const f = await workspace();
    const template = await commercial.createTemplate({
      ...f.request,
      idempotencyKey: randomUUID(),
      input: {
        name: "Fictional template",
        scope: "Template scope",
        schedule: "In a week",
        sections: [{ id: "test", title: "Custom", body: "Preserved" }],
        catalog: [
          {
            serviceCode: "sample",
            description: "Fictional sample service",
            unit: "each",
            unitPriceMinor: 10000,
          },
        ],
      },
    });
    const p = await commercial.createProposal({
      ...f.request,
      leadId: f.lead.id,
      templateId: template.id,
      idempotencyKey: randomUUID(),
    });
    expect(p.versions[0]?.content.lineItems[0]).toMatchObject({
      serviceCode: "sample",
      quantity: "1",
      unitPriceMinor: 10000,
    });
    expect(p.versions[0]?.content.schedule).toBe("In a week");
    await commercial.saveBranding({
      ...f.request,
      expectedRevision: 1,
      input: { ...defaultCplCommercialBranding(), businessName: "Fictional renamed firm" },
    });
    expect((await commercial.getProposal({ ...f.request, proposalId: p.id })).versions).toEqual(
      p.versions,
    );
    expect(p.versions[0]?.templateSnapshot).toEqual(template);
  });
  it.each(["price", "competitor", "timing", "scope_changed", "no_response", "other"] as const)(
    "persists structured loss reason %s independently from free text",
    async (reasonCode) => {
      const f = await workspace();
      const p = await proposal(f.request, f.lead.id);
      const result = await commercial.recordOutcome({
        ...f.request,
        proposalId: p.id,
        expectedRevision: p.revision,
        outcome: "lost",
        reasonCode,
        note: "Fictional explanatory note",
        idempotencyKey: randomUUID(),
      });
      expect(result.outcome).toMatchObject({
        outcome: "lost",
        reasonCode,
        note: "Fictional explanatory note",
        version: 1,
        actorIdentityId: f.actor.session.identityId,
      });
      expect(
        (
          await admin.query(
            "SELECT reason_code,note FROM cpl_commercial_events WHERE organization_id=$1 AND proposal_id=$2 AND action='lost'",
            [f.request.organizationId, p.id],
          )
        ).rows,
      ).toEqual([{ reason_code: reasonCode, note: "Fictional explanatory note" }]);
    },
  );
  it("rejects a PDF render result when approval is revoked while waiting for the proposal lock", async () => {
    const f = await workspace();
    const p = await approved(f.request, await proposal(f.request, f.lead.id));
    const dto = await commercial.getApprovedPdf({ ...f.request, proposalId: p.id });
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocker = admin.transaction(async (e) => {
      await e.query(
        "UPDATE cpl_commercial_proposals SET state='draft',approved_version=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2",
        [f.request.organizationId, p.id],
      );
      entered();
      await hold;
    });
    await locked;
    const saving = commercial.recordArtifact({
      ...f.request,
      proposalId: p.id,
      version: p.currentVersion,
      projectionSha256: sha(JSON.stringify(dto)),
      bytes: new TextEncoder().encode("%PDF-1.7\nStale rendering\n%%EOF"),
      rendererVersion: "fixture-v1",
    });
    const rejected = expect(saving).rejects.toMatchObject({
      code: "CPL_APPROVED_VERSION_REQUIRED",
    });
    let waiting = false;
    try {
      for (let i = 0; i < 100; i++) {
        const r = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM cpl_commercial_proposals%FOR UPDATE'",
        );
        if (r.rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
      await blocker;
    }
    expect(waiting).toBe(true);
    await rejected;
    expect(
      (
        await admin.query("SELECT count(*) FROM cpl_commercial_artifacts WHERE proposal_id=$1", [
          p.id,
        ])
      ).rows[0]?.count,
    ).toBe("0");
  });
  it("rolls back project creation and reservation when required audit fails, then safely retries", async () => {
    const f = await workspace();
    const p = await awarded(f.request, await proposal(f.request, f.lead.id));
    const req = { ...f.request, proposalId: p.id, idempotencyKey: randomUUID() };
    await admin.execute(
      "ALTER TABLE cpl_tenant_audit_events ADD CONSTRAINT cpl_test_reject_project CHECK(action<>'commercial.project.created') NOT VALID",
    );
    try {
      await expect(commercial.createProject(req)).rejects.toThrow();
    } finally {
      await admin.execute(
        "ALTER TABLE cpl_tenant_audit_events DROP CONSTRAINT cpl_test_reject_project",
      );
    }
    expect(
      (
        await admin.query("SELECT count(*) FROM cpl_commercial_projects WHERE proposal_id=$1", [
          p.id,
        ])
      ).rows[0]?.count,
    ).toBe("0");
    const created = await commercial.createProject(req);
    expect((await commercial.createProject(req)).id).toBe(created.id);
  });
  it("denies cross-tenant proposal, template, project, artifact and raw RLS reads", async () => {
    const a = await workspace(),
      b = await workspace();
    const p = await awarded(a.request, await proposal(a.request, a.lead.id));
    const project = await commercial.createProject({
      ...a.request,
      proposalId: p.id,
      idempotencyKey: randomUUID(),
    });
    const template = await commercial.createTemplate({
      ...a.request,
      idempotencyKey: randomUUID(),
      input: { name: "Fictional", catalog: [] },
    });
    for (const operation of [
      () => commercial.getProposal({ ...b.request, proposalId: p.id }),
      () => commercial.getProject({ ...b.request, projectId: project.id }),
      () => commercial.getTemplate({ ...b.request, templateId: template.id }),
      () =>
        commercial.getPdfArtifact({ ...b.request, proposalId: p.id, version: p.currentVersion }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    await web.transaction(async (e) => {
      await e.query("SELECT set_config('cpl.organization_id',$1,true)", [b.request.organizationId]);
      expect(
        (await e.query("SELECT id FROM cpl_commercial_proposals WHERE id=$1", [p.id])).rows,
      ).toEqual([]);
      await expect(
        e.query(
          "INSERT INTO cpl_commercial_templates(id,organization_id,name,snapshot,created_by_identity_id) VALUES($1,$2,'forbidden','{}',$3)",
          [randomUUID(), a.request.organizationId, a.actor.session.identityId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
  it("rolls back version and state changes when required audit persistence fails", async () => {
    const f = await workspace();
    const p = await proposal(f.request, f.lead.id);
    await admin.execute(
      "ALTER TABLE cpl_tenant_audit_events ADD CONSTRAINT cpl_test_reject_saved CHECK(action<>'commercial.version.saved') NOT VALID",
    );
    try {
      await expect(saved(f.request, p)).rejects.toThrow();
    } finally {
      await admin.execute(
        "ALTER TABLE cpl_tenant_audit_events DROP CONSTRAINT cpl_test_reject_saved",
      );
    }
    expect(await commercial.getProposal({ ...f.request, proposalId: p.id })).toEqual(p);
  });
  it("makes versions, awards, projects and templates immutable even for an operator DML mistake", async () => {
    const f = await workspace();
    const p = await awarded(f.request, await proposal(f.request, f.lead.id));
    await commercial.createProject({
      ...f.request,
      proposalId: p.id,
      idempotencyKey: randomUUID(),
    });
    const template = await commercial.createTemplate({
      ...f.request,
      idempotencyKey: randomUUID(),
      input: { name: "Fictional", catalog: [] },
    });
    for (const table of [
      "cpl_commercial_versions",
      "cpl_commercial_awards",
      "cpl_commercial_projects",
      "cpl_commercial_templates",
    ])
      await expect(
        admin.query(`DELETE FROM ${table} WHERE organization_id=$1`, [f.request.organizationId]),
      ).rejects.toMatchObject({ code: "42501" });
    expect((await commercial.getTemplate({ ...f.request, templateId: template.id })).name).toBe(
      "Fictional",
    );
  });
  it("stores lost/withdrawn reasons and refuses terminal conversion", async () => {
    for (const outcome of ["lost", "withdrawn"] as const) {
      const f = await workspace();
      const p = await proposal(f.request, f.lead.id);
      await expect(
        commercial.recordOutcome({
          ...f.request,
          proposalId: p.id,
          expectedRevision: p.revision,
          outcome,
          reason: "",
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
      const closed = await commercial.recordOutcome({
        ...f.request,
        proposalId: p.id,
        expectedRevision: p.revision,
        outcome,
        reason: "Fictional documented reason",
        idempotencyKey: randomUUID(),
      });
      expect(closed.events[0]?.reason).toBe("Fictional documented reason");
      await expect(
        commercial.createProject({ ...f.request, proposalId: p.id, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: "CPL_AWARD_REQUIRED" });
    }
  });
  it("fails closed if a commercial table loses forced RLS and clears connection context", async () => {
    const f = await workspace();
    await admin.execute("ALTER TABLE cpl_commercial_projects NO FORCE ROW LEVEL SECURITY");
    try {
      await expect(commercial.readWorkspace(f.request)).rejects.toMatchObject({
        code: "CPL_COMMERCIAL_SCHEMA_UNSAFE",
      });
      await expect(verifyHostedDatabaseRole(web, "web")).rejects.toThrow(
        "CPL_HOSTED_DATABASE_ROLE_REFUSED",
      );
    } finally {
      await admin.execute("ALTER TABLE cpl_commercial_projects FORCE ROW LEVEL SECURITY");
    }
    const context = await web.query(
      "SELECT current_setting('cpl.organization_id',true) AS organization",
    );
    expect(context.rows[0]?.organization ?? "").toBe("");
  });
});
