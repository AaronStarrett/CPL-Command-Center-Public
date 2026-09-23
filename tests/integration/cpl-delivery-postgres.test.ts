import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSqlDatabaseAdapter } from "../../packages/database/src/pg-sql-adapter";
import { migrateDatabase } from "../../packages/database/src/migrations";
import {
  configureCplAutomationWorker,
  configureHostedRuntimeRole,
} from "../../packages/database/src/hosted-database-role";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store";
import {
  SqlCplTenantRepository,
  type CplTenantRequest,
} from "../../packages/database/src/tenant-repository";
import {
  SqlCplWorkflowRepository,
  processHostedJobs,
} from "../../packages/database/src/hosted-workflow";
import { SqlCplAutomationRepository } from "../../packages/database/src/cpl-automation-repository";
import { emitCplBusinessEvent } from "../../packages/database/src/cpl-business-events";
import { SqlCplCommercialRepository } from "../../packages/database/src/cpl-commercial-repository";
import { SqlCplDeliveryRepository } from "../../packages/database/src/cpl-delivery-repository";
import { defaultCplCommercialBranding } from "../../packages/domain/src/cpl-commercial";
import {
  cplBillingHandoff,
  cplDeliveryPublicManifest,
  type CplDeliveryPackage,
  type CplCloseoutPolicyInput,
} from "../../packages/domain/src/cpl-delivery";
const material = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG_JSON;
const configPath = process.env.CPL_HOSTED_POSTGRES_TEST_CONFIG;
const suite = material || configPath ? describe : describe.skip;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
suite("tenant delivery and live closeout on isolated real PostgreSQL", () => {
  let control: PgSqlDatabaseAdapter,
    admin: PgSqlDatabaseAdapter,
    web: PgSqlDatabaseAdapter,
    worker: PgSqlDatabaseAdapter,
    tenants: SqlCplTenantRepository,
    auth: SqlCplHostedAuthStore,
    intake: SqlCplWorkflowRepository,
    commercial: SqlCplCommercialRepository,
    delivery: SqlCplDeliveryRepository,
    automation: SqlCplAutomationRepository;
  const db = `cpl_delivery_test_${randomBytes(6).toString("hex")}`;
  let created = false;
  beforeAll(async () => {
    const config = JSON.parse(material ?? readFileSync(configPath!, "utf8"));
    for (const value of [config.adminUrl, config.webUrl, config.workerUrl])
      if (!["127.0.0.1", "localhost"].includes(new URL(value).hostname))
        throw Error("Isolated local PostgreSQL only");
    control = new PgSqlDatabaseAdapter({ connectionString: config.adminUrl, max: 1 });
    await control.execute(`CREATE DATABASE "${db}"`);
    created = true;
    const connect = (value: string) => {
      const u = new URL(value);
      u.pathname = `/${db}`;
      return u.href;
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
    worker = new PgSqlDatabaseAdapter({
      connectionString: connect(config.workerUrl),
      max: 2,
      statement_timeout: 10000,
    });
    auth = new SqlCplHostedAuthStore(web);
    tenants = new SqlCplTenantRepository(web);
    intake = new SqlCplWorkflowRepository(web, tenants);
    commercial = new SqlCplCommercialRepository(tenants);
    delivery = new SqlCplDeliveryRepository(tenants);
    automation = new SqlCplAutomationRepository(tenants);
  }, 180000);
  afterAll(async () => {
    await Promise.all([worker?.close(), web?.close(), admin?.close()]);
    if (created) await control.execute(`DROP DATABASE "${db}" WITH(FORCE)`);
    await control?.close();
  }, 60000);
  async function signIn() {
    const raw = randomBytes(32).toString("base64url"),
      now = new Date().toISOString();
    const session = await auth.createSession({
      identity: {
        issuer: "https://accounts.google.com",
        subject: randomUUID(),
        email: "synthetic@example.invalid",
        emailVerified: true,
        hostedDomain: null,
        displayName: "Fictional Owner",
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
        displayName: "Fictional delivery company",
      });
    const request = { sessionToken: actor.raw, organizationId: org.id };
    await admin.query(
      "UPDATE cpl_module_entitlements SET enabled=TRUE,usage_limit=NULL WHERE organization_id=$1 AND module_key IN ('intake-job-tracker','proposal-builder','award-to-project-launcher','field-report-assembler')",
      [org.id],
    );
    let lead = await intake.createLead({
      ...request,
      title: "Fictional service",
      contactName: "Fictional Contact",
      contactEmail: "customer@example.invalid",
      customerName: "Fictional Customer",
      siteName: "Example site",
      siteAddress: "123 Fictional Road",
      details: "Confirmed scope",
      requestedService: "Inspection",
      assignedMemberIdentityId: actor.session.identityId,
      nextAction: "Quote",
      notes: "PRIVATE LEAD",
      evidenceNote: "PRIVATE EVIDENCE",
      sourceReference: "reference:fictional",
      idempotencyKey: randomUUID(),
    });
    lead = await intake.updateLead({
      ...request,
      leadId: lead.id,
      expectedVersion: lead.version,
      status: "ready_for_proposal",
    });
    await commercial.saveBranding({
      ...request,
      expectedRevision: 0,
      input: { ...defaultCplCommercialBranding(), businessName: "Fictional Services" },
    });
    let p = await commercial.createProposal({
      ...request,
      leadId: lead.id,
      idempotencyKey: randomUUID(),
    });
    p = await commercial.saveProposal({
      ...request,
      proposalId: p.id,
      expectedRevision: p.revision,
      internalNotes: "PRIVATE COMMERCIAL",
      content: {
        ...p.versions[0]!.content,
        lineItems: [
          {
            description: "Inspection",
            serviceCode: "inspect",
            quantity: "1",
            unit: "visit",
            unitPriceMinor: 12500,
          },
        ],
        accessInstructions: "PRIVATE ACCESS",
        constraints: "PRIVATE CONSTRAINTS",
      },
    });
    p = await commercial.submitProposal({
      ...request,
      proposalId: p.id,
      expectedRevision: p.revision,
    });
    p = await commercial.reviewProposal({
      ...request,
      proposalId: p.id,
      expectedRevision: p.revision,
      decision: "approve",
    });
    p = await commercial.recordOutcome({
      ...request,
      proposalId: p.id,
      expectedRevision: p.revision,
      outcome: "awarded",
      award: {
        awardDate: "2026-09-23",
        amountMinor: p.versions[0]!.totals.totalMinor,
        currency: "USD",
        purchaseOrder: "",
        startDate: null,
        notes: "Fictional manually recorded award",
      },
      idempotencyKey: randomUUID(),
    });
    const project = await commercial.createProject({
      ...request,
      proposalId: p.id,
      idempotencyKey: randomUUID(),
    });
    const query = { ...request, projectId: project.id };
    const f = { actor, request, project, query };
    const report = await approvedArtifact(f, 4, 6);
    return { ...f, report };
  }
  // Exact SQL fixtures model an ALREADY approved immutable artifact; Phase3 tests
  // separately verify rendering/approval. These tests never fabricate approval via
  // a delivery API, and use the restricted web role for every tested operation.
  async function approvedArtifact(
    f: {
      request: CplTenantRequest;
      project: { id: string };
      actor: { session: { identityId: string } };
    },
    version: number,
    currentVersion = version,
    existingId?: string,
  ) {
    const reportId = existingId ?? randomUUID(),
      template = randomUUID(),
      attempt = randomUUID(),
      objectId = randomUUID(),
      reference = `RPT-${reportId.slice(0, 8)}`,
      approvedAt = new Date(Date.now() - 1000).toISOString(),
      hash = sha(`approved-${reportId}-${version}`);
    const org = f.request.organizationId,
      pid = f.project.id,
      actor = f.actor.session.identityId;
    await admin.transaction(async (e) => {
      await e.query(
        "INSERT INTO cpl_report_branding(organization_id,revision,configuration,created_by_identity_id) VALUES($1,1,'{}',$2) ON CONFLICT DO NOTHING",
        [org, actor],
      );
      await e.query(
        "INSERT INTO cpl_report_templates(organization_id,id,version,snapshot,created_by_identity_id) VALUES($1,$2,1,'{}',$3)",
        [org, template, actor],
      );
      if (!existingId)
        await e.query(
          "INSERT INTO cpl_reports(organization_id,project_id,id,reference,revision,current_version,state,title,created_by_identity_id) VALUES($1,$2,$3,$4,1,$5,'draft','Customer report',$6)",
          [org, pid, reportId, reference, currentVersion, actor],
        );
      else
        await e.query(
          "UPDATE cpl_reports SET current_version=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2",
          [org, reportId, currentVersion],
        );
      for (const v of new Set([version, currentVersion]))
        await e.query(
          "INSERT INTO cpl_report_versions(organization_id,project_id,report_id,version,snapshot,source_hash,template_id,template_version,branding_revision,created_by_identity_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,1,1,$8) ON CONFLICT DO NOTHING",
          [
            org,
            pid,
            reportId,
            v,
            JSON.stringify({
              content: { title: `Customer report v${v}` },
              internalNotes: "PRIVATE REPORT SOURCE",
            }),
            hash,
            template,
            actor,
          ],
        );
      await e.query(
        "INSERT INTO cpl_report_attempts(organization_id,project_id,report_id,version,id,expected_revision,artifact_object_id,source_hash,projection,approved_at,prepared_by_identity_id) VALUES($1,$2,$3,$4,$5,1,$6,$7,'{}',$8,$9)",
        [org, pid, reportId, version, attempt, objectId, hash, approvedAt, actor],
      );
      await e.query(
        "INSERT INTO cpl_report_artifacts(organization_id,project_id,report_id,version,attempt_id,object_id,sha256,byte_length,renderer_version,source_hash,approved_at,approved_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,1234,'fixture-approved-v1',$7,$8,$9)",
        [org, pid, reportId, version, attempt, objectId, hash, approvedAt, actor],
      );
    });
    return { reportId, version, objectId, sha256: hash, reference };
  }
  function draft(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      customerName: "Fictional Customer",
      contactName: "Fictional Contact",
      recipient: "customer@example.invalid",
      subject: "Approved report",
      message: "Customer-facing message",
      attachments: [{ reportId: f.report.reportId, version: f.report.version }],
    };
  }
  async function create(f: Awaited<ReturnType<typeof fixture>>) {
    return delivery.createPackage({ ...f.query, input: draft(f), idempotencyKey: randomUUID() });
  }
  const edit = (f: { query: CplTenantRequest & { projectId: string } }, p: CplDeliveryPackage) => ({
    ...f.query,
    packageId: p.id,
    expectedRevision: p.revision,
    idempotencyKey: randomUUID(),
  });
  async function ready(f: Awaited<ReturnType<typeof fixture>>, p?: CplDeliveryPackage) {
    p ??= await create(f);
    return delivery.markReady({ ...edit(f, p), recipientConfirmed: true });
  }
  async function sent(f: Awaited<ReturnType<typeof fixture>>, p?: CplDeliveryPackage) {
    p = await ready(f, p);
    return delivery.recordSent({
      ...edit(f, p),
      input: {
        sentAt: new Date().toISOString(),
        channel: "Email manually recorded",
        recipient: "customer@example.invalid",
        reference: "FICTIONAL-SENT",
        note: "Synthetic test evidence",
      },
    });
  }
  function rules(patch: Partial<CplCloseoutPolicyInput> = {}): CplCloseoutPolicyInput {
    return {
      serviceKey: "*",
      name: "Fictional policy",
      requireAward: true,
      requireWorkCompleted: false,
      requireApprovedReport: false,
      requireDelivery: false,
      requirePurchaseOrder: false,
      requireIssuesDisposed: false,
      ...patch,
    };
  }
  async function configure(
    f: Awaited<ReturnType<typeof fixture>>,
    patch: Partial<CplCloseoutPolicyInput> = {},
  ) {
    return delivery.savePolicy({
      ...f.query,
      expectedVersion: 0,
      input: rules(patch),
      idempotencyKey: randomUUID(),
    });
  }
  it("uses existing approved v4 while current report is draft v6, with no regeneration/private export", async () => {
    const f = await fixture(),
      p = await create(f),
      w = await delivery.workspace(f.query);
    expect(w.approvedReports[0]).toMatchObject({
      version: 4,
      latestEditableVersion: 6,
      withdrawn: false,
    });
    expect(p.versions[0]!.attachments[0]!.sha256).toBe(f.report.sha256);
    expect(p.readiness).toMatchObject({ ready: false, canMarkReady: true });
    const ref = await delivery.attachment({
      ...f.query,
      packageId: p.id,
      version: 1,
      reportId: f.report.reportId,
      reportVersion: 4,
    });
    expect(ref).toMatchObject({ objectId: f.report.objectId, sha256: f.report.sha256 });
    expect(JSON.stringify(cplDeliveryPublicManifest(p, 1))).not.toContain("PRIVATE");
    expect((await delivery.getPackage({ ...f.query, packageId: p.id })).events).toHaveLength(1);
  });
  it("atomically deduplicates concurrent creation and rejects different inputs on reused key", async () => {
    const f = await fixture(),
      r = { ...f.query, input: draft(f), idempotencyKey: randomUUID() },
      result = await Promise.all([delivery.createPackage(r), delivery.createPackage(r)]);
    expect(result[0]!.id).toBe(result[1]!.id);
    expect(result[0]!.events).toHaveLength(1);
    await expect(
      delivery.createPackage({ ...r, input: { ...r.input, message: "Changed" } }),
    ).rejects.toThrow("CPL_IDEMPOTENCY_CONFLICT");
  });
  it("rejects editable/unapproved, cross-company and unrelated-project attachments", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      delivery.createPackage({
        ...f.query,
        input: { ...draft(f), attachments: [{ reportId: f.report.reportId, version: 6 }] },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("CPL_DELIVERY_APPROVED_ARTIFACT_REQUIRED");
    await expect(
      delivery.createPackage({
        ...f.query,
        input: { ...draft(f), attachments: [{ reportId: other.report.reportId, version: 4 }] },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("CPL_DELIVERY_APPROVED_ARTIFACT_REQUIRED");
    await expect(delivery.workspace({ ...f.query, projectId: other.project.id })).rejects.toThrow(
      "CPL_RECORD_NOT_FOUND",
    );
  });
  it("requires explicit recipient confirmation and never marks GET/export as sent", async () => {
    const f = await fixture();
    let p = await create(f);
    await expect(delivery.markReady({ ...edit(f, p), recipientConfirmed: false })).rejects.toThrow(
      "CPL_DELIVERY_RECIPIENT_CONFIRMATION_REQUIRED",
    );
    await expect(delivery.recordExport(edit(f, p))).rejects.toThrow("CPL_DELIVERY_NOT_READY");
    p = await ready(f, p);
    p = await delivery.recordExport(edit(f, p));
    expect(p.state).toBe("exported");
    expect((await delivery.getPackage({ ...f.query, packageId: p.id })).state).toBe("exported");
    expect(p.events.some((x) => x.action === "manually_sent")).toBe(false);
  });
  it("editing a ready recipient/message creates another immutable draft and invalidates confirmation", async () => {
    const f = await fixture();
    let p = await ready(f);
    p = await delivery.savePackage({
      ...edit(f, p),
      input: {
        ...draft(f),
        recipient: "changed@example.invalid",
        message: "Revised human message",
      },
    });
    expect(p.state).toBe("draft");
    expect(p.currentVersion).toBe(2);
    expect(p.versions[0]!.state).toBe("ready");
    expect(p.versions[0]!.input.recipient).toBe("customer@example.invalid");
    await expect(
      delivery.recordSent({
        ...edit(f, p),
        input: {
          sentAt: new Date().toISOString(),
          channel: "email",
          recipient: "changed@example.invalid",
          reference: "",
          note: "",
        },
      }),
    ).rejects.toThrow("CPL_DELIVERY_NOT_READY");
  });
  it("records exact manual evidence once, emits one durable event, and preserves sent v4 across explicit v7 revision", async () => {
    const f = await fixture();
    let p = await ready(f);
    const req = {
      ...edit(f, p),
      input: {
        sentAt: new Date().toISOString(),
        channel: "Fictional manual email",
        recipient: "customer@example.invalid",
        reference: "reference-1",
        note: "Manual attestation",
      },
    };
    p = await delivery.recordSent(req);
    expect((await delivery.recordSent(req)).revision).toBe(p.revision);
    const ev = p.events.find((x) => x.action === "manually_sent")!;
    expect(ev.actorIdentityId).toBe(f.actor.session.identityId);
    expect(ev.details).toMatchObject({
      recipient: "customer@example.invalid",
      providerReceipt: false,
    });
    expect(
      (
        await admin.query(
          "SELECT id FROM cpl_business_events WHERE organization_id=$1 AND event_type='delivery.recorded'",
          [f.request.organizationId],
        )
      ).rowCount,
    ).toBe(1);
    await expect(delivery.savePackage({ ...edit(f, p), input: draft(f) })).rejects.toThrow(
      "CPL_DELIVERY_EXPLICIT_REVISION_REQUIRED",
    );
    await approvedArtifact(f, 7, 7, f.report.reportId);
    p = await delivery.revisePackage({
      ...edit(f, p),
      reason: "New approved report explicitly selected",
      input: { ...draft(f), attachments: [{ reportId: f.report.reportId, version: 7 }] },
    });
    expect(p.state).toBe("draft");
    expect(p.versions[0]!.state).toBe("manually_sent");
    expect(p.versions[0]!.attachments[0]!.version).toBe(4);
    expect(p.versions[1]!.attachments[0]!.version).toBe(7);
    await configure(f, { requireApprovedReport: true, requireDelivery: true });
    const next = await delivery.saveCloseoutFacts({
      ...f.query,
      expectedRevision: 0,
      input: {
        purchaseOrder: "",
        requiredReport: { reportId: f.report.reportId, version: 7 },
        issueDispositions: [],
        manualIssues: [],
      },
      idempotencyKey: randomUUID(),
    });
    expect(next.readiness.status).toBe("blocked");
    expect(next.readiness.deliveryRecorded).toBe(false);
    expect(
      (
        await delivery.attachment({
          ...f.query,
          packageId: p.id,
          version: 1,
          reportId: f.report.reportId,
          reportVersion: 4,
        })
      ).sha256,
    ).toBe(f.report.sha256);
  });
  it("rejects recipient mismatch, future manual times and acknowledgments without evidence", async () => {
    const f = await fixture(),
      p = await ready(f),
      details = {
        sentAt: new Date().toISOString(),
        channel: "Manual",
        recipient: "other@example.invalid",
        reference: "",
        note: "",
      };
    await expect(delivery.recordSent({ ...edit(f, p), input: details })).rejects.toThrow(
      "CPL_DELIVERY_RECIPIENT_CHANGED",
    );
    await expect(
      delivery.recordSent({
        ...edit(f, p),
        input: { ...details, sentAt: new Date(Date.now() + 60000).toISOString() },
      }),
    ).rejects.toThrow();
    await expect(
      delivery.acknowledge({
        ...edit(f, p),
        input: { acknowledgedAt: new Date().toISOString(), evidence: "" },
      }),
    ).rejects.toThrow();
    await expect(delivery.acknowledge({ ...edit(f, p), input: null })).rejects.toThrow();
    await expect(
      delivery.acknowledge({
        ...edit(f, p),
        input: { acknowledgedAt: new Date().toISOString(), evidence: "Fictional customer reply" },
      }),
    ).rejects.toThrow("CPL_DELIVERY_INVALID_STATE");
  });
  it("records acknowledgment only after manual sending with explicit evidence", async () => {
    const f = await fixture();
    let p = await sent(f);
    p = await delivery.acknowledge({
      ...edit(f, p),
      input: {
        acknowledgedAt: new Date().toISOString(),
        evidence: "Fictional recipient confirmed document receipt by phone",
      },
    });
    expect(p.state).toBe("acknowledged");
    expect(p.events.filter((x) => x.action === "manually_sent")).toHaveLength(1);
    expect(p.events.find((x) => x.action === "acknowledged")?.details).toMatchObject({
      evidence: "Fictional recipient confirmed document receipt by phone",
      providerReceipt: false,
    });
  });
  it("retains approval withdrawal as separate fact and preserves exact historical artifact", async () => {
    const f = await fixture(),
      p = await ready(f);
    await delivery.withdrawApproval({
      ...f.query,
      reportId: f.report.reportId,
      version: 4,
      reason: "Human review withdrawn",
      idempotencyKey: randomUUID(),
    });
    const after = await delivery.getPackage({ ...f.query, packageId: p.id });
    expect(after.state).toBe("ready");
    expect(after.readiness.ready).toBe(false);
    await expect(
      delivery.recordSent({
        ...edit(f, p),
        input: {
          sentAt: new Date().toISOString(),
          channel: "Manual",
          recipient: "customer@example.invalid",
          reference: "",
          note: "",
        },
      }),
    ).rejects.toThrow("CPL_DELIVERY_APPROVAL_WITHDRAWN");
    expect(
      (
        await delivery.attachment({
          ...f.query,
          packageId: p.id,
          version: 1,
          reportId: f.report.reportId,
          reportVersion: 4,
        })
      ).sha256,
    ).toBe(f.report.sha256);
    expect(
      (
        await admin.query(
          "SELECT state,current_version FROM cpl_reports WHERE organization_id=$1 AND id=$2",
          [f.request.organizationId, f.report.reportId],
        )
      ).rows[0],
    ).toMatchObject({ state: "draft", current_version: 6 });
  });
  it("separates no-policy from readiness and uses exact service policy ahead of organization fallback", async () => {
    const f = await fixture();
    expect((await delivery.workspace(f.query)).readiness.status).toBe("not_configured");
    expect((await configure(f)).readiness.status).toBe("ready");
    const w = await delivery.savePolicy({
      ...f.query,
      expectedVersion: 0,
      input: rules({ serviceKey: "Inspection", requireDelivery: true }),
      idempotencyKey: randomUUID(),
    });
    expect(w.readiness.status).toBe("blocked");
    expect(w.readiness.policy?.serviceKey).toBe("Inspection");
    expect(w.readiness.invoiceIssued).toBe("not_tracked");
  });
  it("evaluates selected exact approved version delivery, not newer editable report state", async () => {
    const f = await fixture();
    await configure(f, { requireApprovedReport: true, requireDelivery: true });
    let w = await delivery.saveCloseoutFacts({
      ...f.query,
      expectedRevision: 0,
      input: {
        purchaseOrder: "",
        requiredReport: { reportId: f.report.reportId, version: 4 },
        issueDispositions: [],
        manualIssues: [],
      },
      idempotencyKey: randomUUID(),
    });
    expect(w.readiness.status).toBe("blocked");
    await sent(f);
    w = await delivery.workspace(f.query);
    expect(w.readiness.status).toBe("ready");
    expect(w.readiness.deliveryRecorded).toBe(true);
    await delivery.withdrawApproval({
      ...f.query,
      reportId: f.report.reportId,
      version: 4,
      reason: "Approval invalidated",
      idempotencyKey: randomUUID(),
    });
    expect((await delivery.workspace(f.query)).readiness.status).toBe("blocked");
  });
  it("keeps operational PO supplement and frozen agreed amount separate from immutable award", async () => {
    const f = await fixture();
    await configure(f, { requirePurchaseOrder: true });
    const w = await delivery.saveCloseoutFacts({
      ...f.query,
      expectedRevision: 0,
      input: {
        purchaseOrder: "Fictional supplemental PO",
        requiredReport: null,
        issueDispositions: [],
        manualIssues: [],
      },
      idempotencyKey: randomUUID(),
    });
    expect(w.readiness.status).toBe("ready");
    expect(w.readiness.agreedAmount.amountMinor).toBe(12500);
    expect(
      (
        await admin.query(
          "SELECT snapshot->>'purchaseOrder' AS po FROM cpl_commercial_awards WHERE organization_id=$1 AND id=$2",
          [f.request.organizationId, f.project.awardId],
        )
      ).rows[0]?.po,
    ).toBe("");
    expect(JSON.stringify(cplBillingHandoff(w.project, w.readiness))).not.toContain("PRIVATE");
  });
  it("binds overrides to policy and specific evidence; changed work invalidates an old override", async () => {
    const f = await fixture();
    let w = await configure(f, { requireWorkCompleted: true });
    const check = w.readiness.checks.find((x) => x.key === "work")!;
    w = await delivery.overrideReadiness({
      ...f.query,
      key: "work",
      evidenceHash: check.evidenceHash,
      active: true,
      reason: "Deposit milestone does not require completed fieldwork",
      idempotencyKey: randomUUID(),
    });
    expect(w.readiness.status).toBe("ready");
    expect(w.readiness.operationalCompletion).toBe(false);
    expect(w.readiness.checks.find((x) => x.key === "work")?.override?.reason).toContain("Deposit");
    await admin.query(
      "INSERT INTO cpl_project_visits(id,organization_id,project_id,revision,status,snapshot,created_by_identity_id) VALUES($1,$2,$3,1,'draft','{}',$4)",
      [randomUUID(), f.request.organizationId, f.project.id, f.actor.session.identityId],
    );
    w = await delivery.workspace(f.query);
    expect(w.readiness.status).toBe("blocked");
    expect(w.readiness.checks.find((x) => x.key === "work")?.override).toBeNull();
    await expect(
      delivery.overrideReadiness({
        ...f.query,
        key: "work",
        evidenceHash: check.evidenceHash,
        active: true,
        reason: "Old claim",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("CPL_CLOSEOUT_EVIDENCE_CHANGED");
  });
  it("manual issue resolution requires a reason and is live instead of latched", async () => {
    const f = await fixture();
    await configure(f, { requireIssuesDisposed: true });
    const id = randomUUID();
    let w = await delivery.saveCloseoutFacts({
      ...f.query,
      expectedRevision: 0,
      input: {
        purchaseOrder: "",
        requiredReport: null,
        issueDispositions: [],
        manualIssues: [{ id, title: "Fictional issue", status: "open", reason: "" }],
      },
      idempotencyKey: randomUUID(),
    });
    expect(w.readiness.status).toBe("blocked");
    w = await delivery.saveCloseoutFacts({
      ...f.query,
      expectedRevision: 1,
      input: {
        ...w.readiness.facts,
        manualIssues: [
          {
            id,
            title: "Fictional issue",
            status: "accepted",
            reason: "Authorized human disposition",
          },
        ],
      },
      idempotencyKey: randomUUID(),
    });
    expect(w.readiness.status).toBe("ready");
    w = await delivery.saveCloseoutFacts({
      ...f.query,
      expectedRevision: 2,
      input: {
        ...w.readiness.facts,
        manualIssues: [{ id, title: "Fictional issue", status: "open", reason: "New observation" }],
      },
      idempotencyKey: randomUUID(),
    });
    expect(w.readiness.status).toBe("blocked");
    await expect(
      delivery.saveCloseoutFacts({
        ...f.query,
        expectedRevision: 3,
        input: { ...w.readiness.facts, manualIssues: [] },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("CPL_CLOSEOUT_ISSUE_DISPOSITION_REQUIRED");
  });
  it("reopening a previously completed visit invalidates readiness without changing agreed amounts", async () => {
    const f = await fixture(),
      visitId = randomUUID();
    await admin.query(
      "INSERT INTO cpl_project_visits(id,organization_id,project_id,revision,status,responsible_identity_id,planned_start_at,planned_end_at,snapshot,created_by_identity_id) VALUES($1,$2,$3,1,'completed',$4,'2026-09-01T09:00:00Z','2026-09-01T10:00:00Z','{}',$4)",
      [visitId, f.request.organizationId, f.project.id, f.actor.session.identityId],
    );
    const before = await configure(f, { requireWorkCompleted: true });
    expect(before.readiness.status).toBe("ready");
    await admin.query(
      "UPDATE cpl_project_visits SET status='in_progress',revision=revision+1 WHERE organization_id=$1 AND id=$2",
      [f.request.organizationId, visitId],
    );
    const after = await delivery.workspace(f.query);
    expect(after.readiness.status).toBe("blocked");
    expect(after.readiness.operationalCompletion).toBe(false);
    expect(after.readiness.agreedAmount).toEqual(before.readiness.agreedAmount);
  });
  it("requires a fresh human disposition when source checklist evidence changes", async () => {
    const f = await fixture(),
      visit = randomUUID(),
      template = randomUUID(),
      item = randomUUID();
    await admin.query(
      "INSERT INTO cpl_project_visits(id,organization_id,project_id,revision,status,snapshot,created_by_identity_id) VALUES($1,$2,$3,1,'draft',$4::jsonb,$5)",
      [
        visit,
        f.request.organizationId,
        f.project.id,
        JSON.stringify({ purpose: "Fictional roof visit" }),
        f.actor.session.identityId,
      ],
    );
    await admin.query(
      "INSERT INTO cpl_field_templates(organization_id,id,version,snapshot,created_by_identity_id) VALUES($1,$2,1,$3::jsonb,$4)",
      [
        f.request.organizationId,
        template,
        JSON.stringify({ sections: [{ items: [{ id: item, label: "Flashing condition" }] }] }),
        f.actor.session.identityId,
      ],
    );
    const answer = {
      itemId: item,
      result: "issue",
      value: "Human observation",
      note: "Private source note",
      photoIds: [],
    };
    await admin.query(
      "INSERT INTO cpl_field_records(organization_id,project_id,visit_id,revision,template_id,template_version,answers,updated_by_identity_id) VALUES($1,$2,$3,1,$4,1,$5::jsonb,$6)",
      [
        f.request.organizationId,
        f.project.id,
        visit,
        template,
        JSON.stringify([answer]),
        f.actor.session.identityId,
      ],
    );
    let w = await configure(f, { requireIssuesDisposed: true });
    const issue = w.readiness.issues[0]!;
    expect(issue.title).toBe("Flashing condition — Fictional roof visit");
    expect(JSON.stringify(issue)).not.toContain("Private source note");
    w = await delivery.saveCloseoutFacts({
      ...f.query,
      expectedRevision: 0,
      input: {
        purchaseOrder: "",
        requiredReport: null,
        manualIssues: [],
        issueDispositions: [
          {
            sourceKey: issue.sourceKey,
            factHash: issue.factHash,
            disposition: "accepted",
            reason: "Authorized scope disposition",
          },
        ],
      },
      idempotencyKey: randomUUID(),
    });
    expect(w.readiness.status).toBe("ready");
    await admin.query(
      "UPDATE cpl_field_records SET revision=revision+1,answers=$4::jsonb WHERE organization_id=$1 AND project_id=$2 AND visit_id=$3",
      [
        f.request.organizationId,
        f.project.id,
        visit,
        JSON.stringify([{ ...answer, value: "New material human observation" }]),
      ],
    );
    const after = await delivery.workspace(f.query);
    expect(after.readiness.status).toBe("blocked");
    expect(after.readiness.issues[0]!.disposed).toBe(false);
    expect(after.readiness.issues[0]!.factHash).not.toBe(issue.factHash);
    await expect(
      delivery.saveCloseoutFacts({
        ...f.query,
        expectedRevision: 1,
        input: w.readiness.facts,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("CPL_CLOSEOUT_ISSUE_CHANGED");
  });
  it("enforces stale revision, role, revoked membership and RLS boundaries", async () => {
    const f = await fixture(),
      p = await create(f),
      member = await signIn();
    await admin.query(
      "INSERT INTO cpl_memberships(organization_id,identity_id,role) VALUES($1,$2,'member')",
      [f.request.organizationId, member.session.identityId],
    );
    const memberRequest = { ...edit(f, p), sessionToken: member.raw };
    await expect(
      delivery.markReady({ ...memberRequest, recipientConfirmed: true }),
    ).rejects.toThrow("CPL_ACCESS_DENIED");
    await expect(
      delivery.savePolicy({
        ...f.query,
        sessionToken: member.raw,
        expectedVersion: 0,
        input: rules(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("CPL_ACCESS_DENIED");
    await ready(f, p);
    await expect(delivery.savePackage({ ...edit(f, p), input: draft(f) })).rejects.toThrow(
      "CPL_DELIVERY_REVISION_CONFLICT",
    );
    await admin.query(
      "UPDATE cpl_memberships SET status='removed',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
      [f.request.organizationId, member.session.identityId],
    );
    await expect(
      delivery.getPackage({ ...f.query, packageId: p.id, sessionToken: member.raw }),
    ).rejects.toThrow("CPL_ACCESS_DENIED");
    expect((await web.query("SELECT id FROM cpl_delivery_packages")).rows).toHaveLength(0);
    await expect(web.query("UPDATE cpl_delivery_versions SET snapshot='{}'")).rejects.toThrow();
  });
  it("blocks cancelled projects without altering earlier manual delivery truth", async () => {
    const f = await fixture(),
      p = await sent(f);
    await admin.query(
      "INSERT INTO cpl_project_operations(organization_id,project_id,revision,name,status,snapshot,updated_by_identity_id) VALUES($1,$2,1,'Fictional','cancelled','{}',$3)",
      [f.request.organizationId, f.project.id, f.actor.session.identityId],
    );
    await expect(create(f)).rejects.toThrow("CPL_DELIVERY_PROJECT_UNAVAILABLE");
    expect((await delivery.getPackage({ ...f.query, packageId: p.id })).versions[0]!.state).toBe(
      "manually_sent",
    );
    expect((await configure(f)).readiness.status).toBe("blocked");
  });
  async function recipeFor(
    f: Awaited<ReturnType<typeof fixture>>,
    trigger: "report.approved" | "delivery.recorded",
  ) {
    return automation.saveRecipe({
      ...f.request,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      input: {
        name: `Fictional ${trigger}`,
        trigger,
        enabled: true,
        service: "Inspection",
        prepareDraft: false,
        templateId: null,
        templateVersion: null,
        templateApprovedForAutomation: false,
        owner: { kind: "person", role: null, identityId: f.actor.session.identityId },
        dueAfterHours: 24,
        taskTitle: "Review the exact handoff",
      },
    });
  }
  // The approval artifact above is an isolated SQL fixture. Emit its corresponding
  // business event through the production transaction helper; worker dispatch,
  // lease/role authority, package creation and task creation are real operations.
  async function emitApproval(f: Awaited<ReturnType<typeof fixture>>) {
    return tenants.withOrganizationTransaction(f.request, "records:read", (e, a) =>
      emitCplBusinessEvent(e, a, {
        type: "report.approved",
        sourceKind: "report",
        sourceId: f.report.reportId,
        sourceVersion: f.report.version,
        projectId: f.project.id,
        service: "Inspection",
        title: "Fictional approved report",
      }),
    );
  }
  async function execute(f: Awaited<ReturnType<typeof fixture>>) {
    const before = await automation.getWorkspace(f.request);
    expect(before.executions).toHaveLength(1);
    const result = await processHostedJobs(worker, {
      claimOwner: "fictional-delivery-worker",
      limit: 1,
    });
    expect(result.executionId).toBe(before.executions[0]!.id);
    return automation.getExecution({ ...f.request, executionId: before.executions[0]!.id });
  }
  async function executionTasks(f: Awaited<ReturnType<typeof fixture>>) {
    const workspace = await automation.getWorkspace(f.request);
    expect(workspace.executions).toHaveLength(1);
    // Virtual source-attention items remain visible independently of this durable
    // execution; only its own task receipt establishes dispatch/deduplication.
    return workspace.tasks.filter((task) => task.executionId === workspace.executions[0]!.id);
  }
  it("dispatches exact approved v4 into one unconfirmed package while report v6 remains editable", async () => {
    const f = await fixture();
    await recipeFor(f, "report.approved");
    const eventId = await emitApproval(f);
    expect((await execute(f)).status).toBe("succeeded");
    const workspace = await delivery.workspace(f.query),
      actions = await automation.getWorkspace(f.request);
    expect(workspace.packages).toHaveLength(1);
    const p = workspace.packages[0]!;
    expect(p.state).toBe("draft");
    expect(p.readiness).toMatchObject({ ready: false, canMarkReady: true });
    expect(p.versions[0]!.attachments[0]).toMatchObject({ version: 4, sha256: f.report.sha256 });
    expect(p.events[0]!.details).toMatchObject({
      origin: "automation",
      automationExecutionId: actions.executions[0]!.id,
    });
    const tasks = await executionTasks(f);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      group: "delivery",
      target: { kind: "package", id: p.id, version: 1 },
    });
    expect(await emitApproval(f)).toBe(eventId);
    expect(
      (await processHostedJobs(worker, { claimOwner: "fictional-delivery-worker", limit: 1 }))
        .claimed,
    ).toBe(0);
    expect((await delivery.workspace(f.query)).packages).toHaveLength(1);
    expect(
      (
        await delivery.attachment({
          ...f.query,
          packageId: p.id,
          version: 1,
          reportId: f.report.reportId,
          reportVersion: 4,
        })
      ).objectId,
    ).toBe(f.report.objectId);
  });
  it("dispatches an actual manual-delivery event to current closeout without recording invoice or payment", async () => {
    const f = await fixture();
    await recipeFor(f, "delivery.recorded");
    await configure(f, { requireDelivery: true, requireApprovedReport: true });
    await delivery.saveCloseoutFacts({
      ...f.query,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      input: {
        purchaseOrder: "",
        requiredReport: { reportId: f.report.reportId, version: 4 },
        issueDispositions: [],
        manualIssues: [],
      },
    });
    const p = await sent(f);
    expect((await execute(f)).status).toBe("succeeded");
    const tasks = await executionTasks(f),
      workspace = await delivery.workspace(f.query);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      group: "closeout",
      target: { kind: "project", id: f.project.id },
    });
    expect(workspace.readiness).toMatchObject({
      status: "ready",
      deliveryRecorded: true,
      invoiceIssued: "not_tracked",
      paymentReceived: "not_tracked",
    });
    expect(workspace.packages[0]!.id).toBe(p.id);
    expect(workspace.packages).toHaveLength(1);
  });
  it("skips delayed withdrawn approval while retaining old manually-sent package and exact artifact", async () => {
    const f = await fixture(),
      p = await sent(f);
    await recipeFor(f, "report.approved");
    await emitApproval(f);
    await delivery.withdrawApproval({
      ...f.query,
      reportId: f.report.reportId,
      version: 4,
      reason: "New human approval withdrawal",
      idempotencyKey: randomUUID(),
    });
    expect(await execute(f)).toMatchObject({
      status: "skipped",
      lastErrorCode: "CPL_AUTOMATION_SOURCE_CHANGED",
      results: [],
    });
    expect(await executionTasks(f)).toHaveLength(0);
    const workspace = await delivery.workspace(f.query);
    expect(workspace.packages).toHaveLength(1);
    expect(workspace.packages[0]!.versions[0]!.state).toBe("manually_sent");
    expect(
      (
        await delivery.attachment({
          ...f.query,
          packageId: p.id,
          version: 1,
          reportId: f.report.reportId,
          reportVersion: 4,
        })
      ).sha256,
    ).toBe(f.report.sha256);
  });
  it("retains committed package history but skips remaining task after withdrawal between attempts", async () => {
    const f = await fixture();
    await recipeFor(f, "report.approved");
    await emitApproval(f);
    await admin.execute(
      `ALTER TABLE cpl_action_tasks ADD CONSTRAINT fictional_delivery_task_failure CHECK(organization_id<>'${f.request.organizationId}'::uuid OR execution_id IS NULL) NOT VALID`,
    );
    let first;
    try {
      first = await execute(f);
    } finally {
      await admin.execute(
        "ALTER TABLE cpl_action_tasks DROP CONSTRAINT fictional_delivery_task_failure",
      );
    }
    expect(first).toMatchObject({ status: "retrying" });
    expect(first!.results.map((x) => x.step)).toEqual(["handoff"]);
    const p = (await delivery.workspace(f.query)).packages[0]!;
    await delivery.withdrawApproval({
      ...f.query,
      reportId: f.report.reportId,
      version: 4,
      reason: "Withdraw before delayed task",
      idempotencyKey: randomUUID(),
    });
    await admin.query(
      "UPDATE cpl_workflow_jobs SET available_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE organization_id=$1 AND id=$2",
      [f.request.organizationId, first!.id],
    );
    const second = await execute(f);
    expect(second).toMatchObject({
      status: "skipped",
      lastErrorCode: "CPL_AUTOMATION_SOURCE_CHANGED",
    });
    expect(second.results.map((x) => x.step)).toEqual(["handoff"]);
    expect(second.attemptHistory.map((x) => x.status)).toEqual(["retrying", "skipped"]);
    expect(await executionTasks(f)).toHaveLength(0);
    const retained = await delivery.workspace(f.query);
    expect(retained.packages).toHaveLength(1);
    expect(retained.packages[0]!.id).toBe(p.id);
    expect(retained.packages[0]!.readiness.ready).toBe(false);
    expect(
      (
        await delivery.attachment({
          ...f.query,
          packageId: p.id,
          version: 1,
          reportId: f.report.reportId,
          reportVersion: 4,
        })
      ).sha256,
    ).toBe(f.report.sha256);
  });
  it.each(["cancelled", "on_hold"])(
    "skips delayed approved report for %s parent without creating package or task",
    async (status) => {
      const f = await fixture();
      await recipeFor(f, "report.approved");
      await emitApproval(f);
      await admin.query(
        "INSERT INTO cpl_project_operations(organization_id,project_id,revision,name,status,snapshot,updated_by_identity_id) VALUES($1,$2,1,'Fictional',$3,'{}',$4)",
        [f.request.organizationId, f.project.id, status, f.actor.session.identityId],
      );
      expect(await execute(f)).toMatchObject({
        status: "skipped",
        lastErrorCode: "CPL_AUTOMATION_SOURCE_CHANGED",
        results: [],
      });
      expect((await delivery.workspace(f.query)).packages).toHaveLength(0);
      expect(await executionTasks(f)).toHaveLength(0);
    },
  );
  it("refuses disabled tenant RLS before data reads", async () => {
    const f = await fixture();
    await admin.execute("ALTER TABLE cpl_delivery_versions NO FORCE ROW LEVEL SECURITY");
    try {
      await expect(delivery.workspace(f.query)).rejects.toThrow("CPL_DELIVERY_SCHEMA_UNSAFE");
    } finally {
      await admin.execute("ALTER TABLE cpl_delivery_versions FORCE ROW LEVEL SECURITY");
    }
  });
});
