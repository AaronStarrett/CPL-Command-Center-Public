import { SqlCplReportRepository } from "../../packages/database/src/cpl-report-repository";
import type {
  CplReportTemplateInput,
  CplReportContent,
  CplReportDetail,
} from "../../packages/domain/src/cpl-report";
import { SqlCplFieldRepository } from "../../packages/database/src/cpl-field-repository";
import type {
  CplFieldTemplateInput,
  CplFieldPhotoDerivative,
} from "../../packages/domain/src/cpl-field";
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
suite("tenant reviewed reports on isolated real PostgreSQL", () => {
  let control: PgSqlDatabaseAdapter,
    admin: PgSqlDatabaseAdapter,
    web: PgSqlDatabaseAdapter,
    auth: SqlCplHostedAuthStore,
    tenants: SqlCplTenantRepository,
    intake: SqlCplWorkflowRepository,
    commercial: SqlCplCommercialRepository,
    execution: SqlCplExecutionRepository,
    field: SqlCplFieldRepository,
    reports: SqlCplReportRepository;
  const databaseName = `cpl_report_test_${randomBytes(6).toString("hex")}`;
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
    field = new SqlCplFieldRepository(tenants);
    reports = new SqlCplReportRepository(tenants);
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
      "UPDATE cpl_module_entitlements SET enabled=TRUE,usage_limit=NULL WHERE organization_id=$1 AND module_key IN ('intake-job-tracker','proposal-builder','award-to-project-launcher','field-report-assembler')",
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
  function templateInput(): CplFieldTemplateInput {
    return {
      name: "Fictional service visit",
      description: "Human field evidence",
      sections: [
        {
          id: randomUUID(),
          title: "Inspection",
          items: [
            {
              id: randomUUID(),
              label: "Observed condition",
              instructions: "Record human observation",
              type: "text",
              required: true,
              unit: "",
              options: [],
              naReasonRequired: true,
              minimumPhotos: 0,
            },
            {
              id: randomUUID(),
              label: "Site evidence",
              instructions: "Attach an actual image",
              type: "photo",
              required: true,
              unit: "",
              options: [],
              naReasonRequired: true,
              minimumPhotos: 1,
            },
          ],
        },
      ],
    };
  }
  async function fieldFixture() {
    const f = await projectFixture();
    const visit = await execution.createVisit({
      ...f.query,
      idempotencyKey: randomUUID(),
      input: appointment(f.actor.session.identityId),
    });
    const scope = { ...f.query, visitId: visit.id };
    const t = await field.saveTemplate({
      ...f.request,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      input: templateInput(),
    });
    const attached = await field.attachTemplate({
      ...scope,
      expectedRevision: 0,
      templateId: t.id,
      templateVersion: t.version,
      idempotencyKey: randomUUID(),
    });
    return { ...f, visit, scope, t, attached };
  }
  const upload = () => ({
    filename: "fictional.png",
    mimeType: "image/png",
    sha256: sha("fictional original bytes"),
    byteLength: 24,
  });
  const image = (kind: string): CplFieldPhotoDerivative => ({
    sha256: sha(kind),
    byteLength: 20,
    width: 20,
    height: 10,
    mimeType: "image/png",
    pipelineVersion: "cpl-image-v1-sharp-0.35.4",
  });
  async function readyPhoto(f: Awaited<ReturnType<typeof fieldFixture>>) {
    const reserved = await field.reservePhoto({
      ...f.scope,
      idempotencyKey: randomUUID(),
      input: upload(),
    });
    const original = await field.recordPhotoOriginal({
      ...f.scope,
      photoId: reserved.photo.id,
      expectedPhotoRevision: 1,
      idempotencyKey: randomUUID(),
      original: { width: 20, height: 10, exifOrientation: null },
      upright: { width: 20, height: 10 },
    });
    const claim = await field.beginPhotoProcessing({
      ...f.scope,
      photoId: reserved.photo.id,
      expectedPhotoRevision: original.photo.revision,
      idempotencyKey: randomUUID(),
    });
    const request = {
      ...f.scope,
      photoId: reserved.photo.id,
      processingToken: claim.processingToken,
      idempotencyKey: randomUUID(),
      thumbnail: image("thumbnail"),
      report: image("report"),
    };
    return { reserved, original, claim, request, ready: await field.completePhoto(request) };
  }
  async function checklistReady(f: Awaited<ReturnType<typeof fieldFixture>>, photoId: string) {
    const w = await field.getVisitWorkspace(f.scope);
    return field.saveChecklist({
      ...f.scope,
      expectedRevision: w.revision,
      idempotencyKey: randomUUID(),
      answers: [
        {
          itemId: f.t.sections[0]!.items[0]!.id,
          result: "complete",
          value: "Human confirmed condition",
          note: "",
          photoIds: [],
        },
        {
          itemId: f.t.sections[0]!.items[1]!.id,
          result: "complete",
          value: null,
          note: "",
          photoIds: [photoId],
        },
      ],
    });
  }
  function completedInput(f: Awaited<ReturnType<typeof fieldFixture>>) {
    return {
      ...f.visit,
      status: "completed",
      actualStartAt: "2026-09-20T12:00:00.000Z",
      actualEndAt: "2026-09-20T13:00:00.000Z",
      completionNote: "Human completion",
      tasks: f.visit.tasks.map((task) => ({ ...task, status: "completed" })),
    };
  }
  function reportTemplate(): CplReportTemplateInput {
    return {
      name: "Fictional report",
      description: "Tenant-configured report",
      title: "Fictional service report",
      scope: "",
      summary: "Human summary",
      limitations: "Only accessible areas",
      conclusion: "Human conclusion",
      sections: [{ id: randomUUID(), title: "Additional context", body: "Human extra text" }],
      sectionOrder: ["scope", "summary", "limitations", "visits", "conclusion", "sections"],
    };
  }
  async function reportFixture() {
    const f = await fieldFixture(),
      photo = await readyPhoto(f);
    let w = await field.getVisitWorkspace(f.scope);
    w = await field.saveObservation({
      ...f.scope,
      expectedRevision: w.revision,
      idempotencyKey: randomUUID(),
      input: {
        title: "Human observation",
        description: "Visible measured condition",
        location: "East wall",
        category: "Human category",
        priority: "Human priority",
        followUp: "Human follow-up",
        internalNotes: "PRIVATE FIELD NOTE CANARY",
        reportEligible: true,
      },
    });
    const observation = w.observations[0]!;
    w = await field.saveObservation({
      ...f.scope,
      expectedRevision: w.revision,
      idempotencyKey: randomUUID(),
      input: {
        title: "PRIVATE OBSERVATION CANARY",
        description: "PRIVATE DETAIL CANARY",
        reportEligible: false,
      },
    });
    w = await field.savePhotoMetadata({
      ...f.scope,
      photoId: photo.ready.photo.id,
      expectedRevision: w.revision,
      idempotencyKey: randomUUID(),
      input: {
        ...photo.ready.photo.metadata,
        caption: "Human caption",
        observationId: observation.id,
        overview: true,
        annotations: {
          coordinateSpace: "upright-normalized-v1",
          shapes: [
            {
              kind: "arrow",
              x1: 0.1,
              y1: 0.2,
              x2: 0.7,
              y2: 0.8,
              color: "#FF0000",
              strokeWidth: 0.005,
            },
          ],
        },
      },
    });
    w = await checklistReady(f, photo.ready.photo.id);
    const completed = await execution.saveVisit({
      ...f.scope,
      expectedRevision: f.visit.revision,
      idempotencyKey: randomUUID(),
      input: completedInput(f),
    });
    const branding = await reports.saveBranding({
      ...f.request,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      input: {
        businessName: "Fictional Report Company",
        email: "reports@example.invalid",
        phone: "",
        address: "Fictional address",
        accentColor: "#123456",
        logoDataUrl: null,
      },
    });
    const t = await reports.saveTemplate({
      ...f.request,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      input: reportTemplate(),
    });
    const created = await reports.createReport({
      ...f.query,
      templateId: t.id,
      templateVersion: t.version,
      idempotencyKey: randomUUID(),
    });
    const content: CplReportContent = {
      ...created.versions[0]!.content,
      visits: [
        {
          visitId: f.visit.id,
          observations: [
            {
              observationId: observation.id,
              titleOverride: null,
              descriptionOverride: null,
              followUpOverride: null,
              photos: [{ photoId: photo.ready.photo.id, layout: "large" }],
            },
          ],
          overviewPhotos: [],
        },
      ],
    };
    const query = { ...f.query, reportId: created.id };
    const draft = await reports.saveReport({
      ...query,
      expectedRevision: created.revision,
      idempotencyKey: randomUUID(),
      input: content,
    });
    return {
      ...f,
      photo,
      observation,
      fieldWorkspace: w,
      completed,
      branding,
      reportTemplate: t,
      created,
      content,
      reportQuery: query,
      draft,
    };
  }
  async function inReview(
    f: Awaited<ReturnType<typeof reportFixture>>,
    report: CplReportDetail = f.draft,
  ) {
    return reports.submitReport({
      ...f.reportQuery,
      expectedRevision: report.revision,
      idempotencyKey: randomUUID(),
    });
  }
  async function prepared(f: Awaited<ReturnType<typeof reportFixture>>) {
    const review = await inReview(f),
      request = {
        ...f.reportQuery,
        expectedRevision: review.revision,
        idempotencyKey: randomUUID(),
      };
    const p = await reports.prepareApproval(request);
    if (p.status !== "prepared") throw Error("Expected prepared fixture");
    return { review, request, p };
  }
  const artifactInput = (attemptId: string) => ({
    attemptId,
    sha256: sha("deterministic PDF fixture bytes"),
    byteLength: 31,
    rendererVersion: "cpl-report-pdf-v1",
    idempotencyKey: randomUUID(),
  });
  it("migrates empty and verifies restricted runtime roles and immutable report configuration", async () => {
    expect((await verifyMigrations(admin)).current).toBe("0035_cpl_delivery_closeout.sql");
    await expect(verifyHostedDatabaseRole(web, "web")).resolves.toMatchObject({ purpose: "web" });
    expect((await admin.query("SELECT count(*) FROM cpl_reports")).rows[0]?.count).toBe("0");
  });
  it("creates idempotent report drafts with approved scope and isolated report branding", async () => {
    const f = await reportFixture(),
      request = {
        ...f.query,
        templateId: f.reportTemplate.id,
        templateVersion: 1,
        idempotencyKey: randomUUID(),
      };
    const [first, retry] = await Promise.all([
      reports.createReport(request),
      reports.createReport(request),
    ]);
    expect(retry.id).toBe(first.id);
    expect(first.versions[0]?.content.scope).toBe(f.project.snapshot.version.content.scope);
    expect(first.versions[0]?.branding.businessName).toBe("Fictional Report Company");
    expect(f.project.snapshot.version.branding.businessName).toBe("Fictional Services");
    expect(first.reference).toMatch(/^RPT-\d{4}-[A-F0-9]{12}$/u);
  });
  it("projects only selected public fields, photo hashes and annotations without private canaries", async () => {
    const f = await reportFixture(),
      preview = await reports.getCustomerPreview({
        ...f.reportQuery,
        version: f.draft.currentVersion,
      });
    expect(preview.approvalState).toBe("unapproved");
    const encoded = JSON.stringify(preview.projection);
    for (const value of [
      "PRIVATE",
      "purchaseOrder",
      "amountMinor",
      "internalNotes",
      "objectId",
      "accessInstructions",
    ])
      expect(encoded).not.toContain(value);
    expect(preview.projection.visits[0]?.observations[0]).toMatchObject({
      title: "Human observation",
      priority: "Human priority",
      photos: [
        { photoId: f.photo.ready.photo.id, sha256: image("report").sha256, width: 20, height: 10 },
      ],
    });
    expect(
      preview.projection.visits[0]?.observations[0]?.photos[0]?.annotations.shapes,
    ).toHaveLength(1);
    await expect(
      reports.getArtifact({ ...f.reportQuery, version: f.draft.currentVersion }),
    ).rejects.toMatchObject({ code: "CPL_REPORT_ARTIFACT_NOT_FOUND" });
  });
  it("freezes saved versions, refuses stale edits, and preserves old customer previews", async () => {
    const f = await reportFixture(),
      versionNumber = f.draft.currentVersion;
    const saved = await reports.saveReport({
      ...f.reportQuery,
      expectedRevision: f.draft.revision,
      idempotencyKey: randomUUID(),
      input: { ...f.content, title: "New report title" },
    });
    expect(saved.versions.map((v) => v.content.title)).toEqual([
      "New report title",
      "Fictional service report",
      "Fictional service report",
    ]);
    expect(
      (await reports.getCustomerPreview({ ...f.reportQuery, version: versionNumber })).projection
        .title,
    ).toBe("Fictional service report");
    await expect(
      reports.saveReport({
        ...f.reportQuery,
        expectedRevision: f.draft.revision,
        idempotencyKey: randomUUID(),
        input: f.content,
      }),
    ).rejects.toMatchObject({ code: "CPL_REPORT_VERSION_CONFLICT" });
    await expect(
      admin.query(
        "UPDATE cpl_report_versions SET snapshot='{}' WHERE organization_id=$1 AND report_id=$2",
        [f.request.organizationId, f.draft.id],
      ),
    ).rejects.toThrow();
  });
  it("enforces author/reviewer roles, request-change reasons and reviewed-content edit gates", async () => {
    const f = await reportFixture(),
      author = await member(f, "member"),
      reviewer = await member(f, "reviewer"),
      fieldUser = await member(f, "field-user");
    const review = await inReview(f);
    await expect(
      reports.saveReport({
        ...f.reportQuery,
        expectedRevision: review.revision,
        idempotencyKey: randomUUID(),
        input: f.content,
      }),
    ).rejects.toMatchObject({ code: "CPL_REPORT_STATE_CONFLICT" });
    await expect(
      reports.prepareApproval({
        ...author.query,
        reportId: f.draft.id,
        expectedRevision: review.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(
      reports.requestChanges({
        ...reviewer.query,
        reportId: f.draft.id,
        expectedRevision: review.revision,
        idempotencyKey: randomUUID(),
        reason: "",
      }),
    ).rejects.toThrow();
    const changes = await reports.requestChanges({
      ...reviewer.query,
      reportId: f.draft.id,
      expectedRevision: review.revision,
      idempotencyKey: randomUUID(),
      reason: "Clarify human summary",
    });
    expect(changes.state).toBe("changes_requested");
    expect(changes.versions[0]?.version).toBe(f.draft.currentVersion);
    await expect(
      reports.saveReport({
        ...reviewer.query,
        reportId: f.draft.id,
        expectedRevision: changes.revision,
        idempotencyKey: randomUUID(),
        input: f.content,
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await expect(
      reports.getReport({ ...fieldUser.query, reportId: f.draft.id }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
  });
  it("prepares stable retryable approval while failed rendering leaves review and no artifact", async () => {
    const f = await reportFixture(),
      p = await prepared(f),
      retry = await reports.prepareApproval(p.request);
    expect(retry).toEqual(p.p);
    expect((await reports.getReport(f.reportQuery)).state).toBe("in_review");
    expect(p.p.photoReferences).toEqual([
      {
        photoId: f.photo.ready.photo.id,
        reference: {
          organizationId: f.request.organizationId,
          objectId: f.photo.ready.reportObjectId,
          sha256: image("report").sha256,
          byteLength: 20,
        },
      },
    ]);
    expect((await reports.getReport(f.reportQuery)).artifacts).toEqual([]);
    await expect(
      reports.getArtifact({ ...f.reportQuery, version: f.draft.currentVersion }),
    ).rejects.toThrow();
  });
  it("approves exactly once and returns completed preparation without another attempt", async () => {
    const f = await reportFixture(),
      p = await prepared(f),
      request = { ...f.reportQuery, ...artifactInput(p.p.attemptId) };
    const [one, two] = await Promise.all([
      reports.completeApproval(request),
      reports.completeApproval(request),
    ]);
    expect(one.state).toBe("approved");
    expect(two.revision).toBe(one.revision);
    expect(one.artifacts).toHaveLength(1);
    expect(one.artifacts[0]).toMatchObject({
      sourceHash: p.p.sourceHash,
      approvedAt: p.p.approvedAt,
      reference: { objectId: p.p.artifactObjectId },
    });
    const completed = await reports.prepareApproval(p.request);
    expect(completed.status).toBe("completed");
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM cpl_report_attempts WHERE organization_id=$1 AND report_id=$2",
          [f.request.organizationId, f.draft.id],
        )
      ).rows[0]?.count,
    ).toBe("1");
    await expect(
      reports.completeApproval({ ...request, sha256: sha("changed") }),
    ).rejects.toMatchObject({ code: "CPL_REPORT_IMMUTABLE_ARTIFACT" });
    await expect(
      admin.query(
        "UPDATE cpl_report_artifacts SET sha256=$3 WHERE organization_id=$1 AND report_id=$2",
        [f.request.organizationId, f.draft.id, sha("changed")],
      ),
    ).rejects.toThrow();
  });
  it("rejects source changes after prepare and requires explicit refreshed review", async () => {
    const f = await reportFixture(),
      p = await prepared(f);
    const opened = await field.reopenVisit({
      ...f.scope,
      expectedFieldRevision: f.fieldWorkspace.revision,
      expectedVisitRevision: f.completed.revision,
      idempotencyKey: randomUUID(),
      reason: "Correct observed wording",
    });
    await field.saveObservation({
      ...f.scope,
      expectedRevision: opened.revision,
      observationId: f.observation.id,
      idempotencyKey: randomUUID(),
      input: { ...f.observation, description: "Corrected human text" },
    });
    await expect(
      reports.completeApproval({ ...f.reportQuery, ...artifactInput(p.p.attemptId) }),
    ).rejects.toMatchObject({ code: "CPL_REPORT_SOURCES_CHANGED" });
    const stale = await reports.getReport(f.reportQuery);
    expect(stale.sourcesStale).toBe(true);
    expect(stale.artifacts).toEqual([]);
    const requested = await reports.requestChanges({
      ...f.reportQuery,
      expectedRevision: stale.revision,
      idempotencyKey: randomUUID(),
      reason: "Review corrected sources",
    });
    await expect(
      reports.saveReport({
        ...f.reportQuery,
        expectedRevision: requested.revision,
        idempotencyKey: randomUUID(),
        input: f.content,
      }),
    ).rejects.toMatchObject({ code: "CPL_REPORT_SOURCES_CHANGED" });
    const refreshed = await reports.refreshSources({
      ...f.reportQuery,
      expectedRevision: requested.revision,
      idempotencyKey: randomUUID(),
    });
    expect(refreshed.sourcesStale).toBe(false);
    expect(refreshed.versions[0]?.sources.visits[0]?.observations[0]?.description).toBe(
      "Corrected human text",
    );
    expect(refreshed.readiness.some((x) => x.code === "CPL_REPORT_VISIT_NOT_READY")).toBe(true);
  });
  it("explicitly reconciles removal of a now-private source instead of trapping a stale draft", async () => {
    const f = await reportFixture();
    let w = await field.reopenVisit({
      ...f.scope,
      expectedFieldRevision: f.fieldWorkspace.revision,
      expectedVisitRevision: f.completed.revision,
      idempotencyKey: randomUUID(),
      reason: "Restrict source visibility",
    });
    w = await field.saveObservation({
      ...f.scope,
      expectedRevision: w.revision,
      observationId: f.observation.id,
      idempotencyKey: randomUUID(),
      input: { ...f.observation, reportEligible: false },
    });
    w = await field.saveObservation({
      ...f.scope,
      expectedRevision: w.revision,
      idempotencyKey: randomUUID(),
      input: {
        title: "Replacement public observation",
        description: "New public evidence",
        reportEligible: true,
      },
    });
    const replacement = w.observations.find((o) => o.title === "Replacement public observation")!;
    await execution.saveVisit({
      ...f.scope,
      expectedRevision: w.visit.revision,
      idempotencyKey: randomUUID(),
      input: completedInput(f),
    });
    await expect(
      reports.saveReport({
        ...f.reportQuery,
        expectedRevision: f.draft.revision,
        idempotencyKey: randomUUID(),
        input: f.content,
      }),
    ).rejects.toMatchObject({ code: "CPL_REPORT_SOURCE_NOT_ELIGIBLE" });
    const reconciled = await reports.refreshSources({
      ...f.reportQuery,
      expectedRevision: f.draft.revision,
      idempotencyKey: randomUUID(),
      input: {
        ...f.content,
        visits: [
          {
            visitId: f.visit.id,
            observations: [
              {
                observationId: replacement.id,
                titleOverride: null,
                descriptionOverride: null,
                followUpOverride: null,
                photos: [],
              },
            ],
            overviewPhotos: [],
          },
        ],
      },
    });
    expect(reconciled.sourcesStale).toBe(false);
    expect(reconciled.versions[0]?.sources.visits[0]?.observations[0]?.id).toBe(replacement.id);
    expect((await inReview(f, reconciled)).state).toBe("in_review");
  });
  it("rechecks branding and reviewer membership after rendering without publishing orphan artifacts", async () => {
    const f = await reportFixture(),
      p = await prepared(f);
    await reports.saveBranding({
      ...f.request,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: { ...f.branding, businessName: "Changed brand" },
    });
    await expect(
      reports.completeApproval({ ...f.reportQuery, ...artifactInput(p.p.attemptId) }),
    ).rejects.toMatchObject({ code: "CPL_REPORT_SOURCES_CHANGED" });
    const g = await reportFixture(),
      q = await prepared(g);
    await admin.query(
      "UPDATE cpl_memberships SET status='suspended',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
      [g.request.organizationId, g.actor.session.identityId],
    );
    await expect(
      reports.completeApproval({ ...g.reportQuery, ...artifactInput(q.p.attemptId) }),
    ).rejects.toThrow();
    expect(
      (
        await admin.query("SELECT count(*) FROM cpl_report_artifacts WHERE organization_id=$1", [
          g.request.organizationId,
        ])
      ).rows[0]?.count,
    ).toBe("0");
  });
  it("creates a distinct revision draft and preserves exact approved historical download and preview", async () => {
    const f = await reportFixture(),
      p = await prepared(f),
      approved = await reports.completeApproval({
        ...f.reportQuery,
        ...artifactInput(p.p.attemptId),
      });
    const oldArtifact = await reports.getArtifact({
        ...f.reportQuery,
        version: approved.currentVersion,
      }),
      oldPreview = await reports.getCustomerPreview({
        ...f.reportQuery,
        version: approved.currentVersion,
      });
    const revised = await reports.reviseReport({
      ...f.reportQuery,
      expectedRevision: approved.revision,
      idempotencyKey: randomUUID(),
      reason: "Add another visit",
    });
    expect(revised.currentVersion).toBe(approved.currentVersion + 1);
    expect(revised.state).toBe("draft");
    expect(
      (await reports.getCustomerPreview({ ...f.reportQuery, version: revised.currentVersion }))
        .approvalState,
    ).toBe("unapproved");
    expect(
      await reports.getArtifact({ ...f.reportQuery, version: approved.currentVersion }),
    ).toEqual(oldArtifact);
    expect(
      await reports.getCustomerPreview({ ...f.reportQuery, version: approved.currentVersion }),
    ).toEqual(oldPreview);
  });
  it("approves a report containing two completed visits and deliberate overview photo grouping", async () => {
    const f = await reportFixture();
    const visit = await execution.createVisit({
      ...f.query,
      idempotencyKey: randomUUID(),
      input: appointment(f.actor.session.identityId, {
        purpose: "Second fictional visit",
        plannedStartLocal: "2026-10-13T09:00",
        plannedEndLocal: "2026-10-13T10:00",
      }),
    });
    const scope = { ...f.query, visitId: visit.id };
    const second = { ...f, visit, scope };
    await field.attachTemplate({
      ...scope,
      expectedRevision: 0,
      templateId: f.t.id,
      templateVersion: 1,
      idempotencyKey: randomUUID(),
    });
    const p2 = await readyPhoto(second);
    const w = await field.getVisitWorkspace(scope);
    await field.savePhotoMetadata({
      ...scope,
      photoId: p2.ready.photo.id,
      expectedRevision: w.revision,
      idempotencyKey: randomUUID(),
      input: { ...p2.ready.photo.metadata, caption: "Second visit overview", overview: true },
    });
    await checklistReady(second, p2.ready.photo.id);
    await execution.saveVisit({
      ...scope,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: completedInput(second),
    });
    const saved = await reports.saveReport({
      ...f.reportQuery,
      expectedRevision: f.draft.revision,
      idempotencyKey: randomUUID(),
      input: {
        ...f.content,
        visits: [
          ...f.content.visits,
          {
            visitId: visit.id,
            observations: [],
            overviewPhotos: [{ photoId: p2.ready.photo.id, layout: "pair" }],
          },
        ],
      },
    });
    const review = await inReview(f, saved),
      prepared = await reports.prepareApproval({
        ...f.reportQuery,
        expectedRevision: review.revision,
        idempotencyKey: randomUUID(),
      });
    if (prepared.status !== "prepared") throw Error("Expected prepared");
    expect(prepared.projection.visits).toHaveLength(2);
    expect(prepared.projection.visits[1]?.observations[0]).toMatchObject({
      title: "Visit overview",
      description: "",
      photos: [{ caption: "Second visit overview" }],
    });
    expect(
      (await reports.completeApproval({ ...f.reportQuery, ...artifactInput(prepared.attemptId) }))
        .state,
    ).toBe("approved");
  });
  it("refuses private linked photos even when requested as overview and omits hidden section content", async () => {
    const f = await reportFixture();
    const hidden = await reports.saveReport({
      ...f.reportQuery,
      expectedRevision: f.draft.revision,
      idempotencyKey: randomUUID(),
      input: { ...f.content, summary: "SECRET OMITTED SUMMARY", sectionOrder: ["scope"] },
    });
    const preview = await reports.getCustomerPreview({
      ...f.reportQuery,
      version: hidden.currentVersion,
    });
    expect(preview.projection.visits).toEqual([]);
    expect(preview.projection.summary).toBe("");
    expect(JSON.stringify(preview.projection)).not.toContain("SECRET OMITTED SUMMARY");
    const w = await field.reopenVisit({
      ...f.scope,
      expectedFieldRevision: f.fieldWorkspace.revision,
      expectedVisitRevision: f.completed.revision,
      idempotencyKey: randomUUID(),
      reason: "Private source correction",
    });
    await field.saveObservation({
      ...f.scope,
      expectedRevision: w.revision,
      observationId: f.observation.id,
      idempotencyKey: randomUUID(),
      input: { ...f.observation, reportEligible: false },
    });
    await expect(
      reports.refreshSources({
        ...f.reportQuery,
        expectedRevision: hidden.revision,
        idempotencyKey: randomUUID(),
        input: {
          ...f.content,
          visits: [
            {
              visitId: f.visit.id,
              observations: [],
              overviewPhotos: [{ photoId: f.photo.ready.photo.id, layout: "large" }],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "CPL_REPORT_SOURCE_NOT_ELIGIBLE" });
  });
  it("isolates project/report/version/attempt references across tenants and enforces raw RLS", async () => {
    const a = await reportFixture(),
      b = await reportFixture(),
      preparedA = await prepared(a);
    for (const operation of [
      () => reports.getReport({ ...b.request, projectId: a.project.id, reportId: a.draft.id }),
      () =>
        reports.getCustomerPreview({
          ...b.request,
          projectId: a.project.id,
          reportId: a.draft.id,
          version: a.draft.currentVersion,
        }),
      () => reports.completeApproval({ ...b.reportQuery, ...artifactInput(preparedA.p.attemptId) }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    expect((await web.query("SELECT * FROM cpl_report_versions")).rows).toEqual([]);
    await expect(
      reports.saveReport({
        ...b.reportQuery,
        expectedRevision: b.draft.revision,
        idempotencyKey: randomUUID(),
        input: { ...b.content, visits: a.content.visits },
      }),
    ).rejects.toMatchObject({ code: "CPL_REPORT_SOURCE_UNAVAILABLE" });
  });
  it("rolls back approval state and artifact reference when audit insertion fails", async () => {
    const f = await reportFixture(),
      p = await prepared(f),
      request = { ...f.reportQuery, ...artifactInput(p.p.attemptId) };
    await admin.execute(
      "CREATE FUNCTION cpl_report_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='report.approved' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER cpl_report_test_fail BEFORE INSERT ON cpl_tenant_audit_events FOR EACH ROW EXECUTE FUNCTION cpl_report_test_fail_audit();",
    );
    try {
      await expect(reports.completeApproval(request)).rejects.toThrow();
    } finally {
      await admin.execute(
        "DROP TRIGGER cpl_report_test_fail ON cpl_tenant_audit_events; DROP FUNCTION cpl_report_test_fail_audit();",
      );
    }
    const after = await reports.getReport(f.reportQuery);
    expect(after.state).toBe("in_review");
    expect(after.artifacts).toEqual([]);
    expect((await reports.completeApproval(request)).state).toBe("approved");
  });
});
