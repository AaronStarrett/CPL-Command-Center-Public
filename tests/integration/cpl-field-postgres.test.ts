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
suite("tenant field records on isolated real PostgreSQL", () => {
  let control: PgSqlDatabaseAdapter,
    admin: PgSqlDatabaseAdapter,
    web: PgSqlDatabaseAdapter,
    auth: SqlCplHostedAuthStore,
    tenants: SqlCplTenantRepository,
    intake: SqlCplWorkflowRepository,
    commercial: SqlCplCommercialRepository,
    execution: SqlCplExecutionRepository,
    field: SqlCplFieldRepository;
  const databaseName = `cpl_field_test_${randomBytes(6).toString("hex")}`;
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
  it("applies forward field schema with no seeds and real restricted role protection", async () => {
    expect((await verifyMigrations(admin)).current).toBe("0039_cpl_durable_inbound.sql");
    await expect(verifyHostedDatabaseRole(web, "web")).resolves.toMatchObject({ purpose: "web" });
    expect((await admin.query("SELECT count(*) FROM cpl_field_templates")).rows[0]?.count).toBe(
      "0",
    );
  });
  it("pins immutable template versions and leaves prior visit requirements unchanged", async () => {
    const f = await fieldFixture();
    const newer = await field.saveTemplate({
      ...f.request,
      templateId: f.t.id,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      input: {
        ...f.t,
        name: "Revised requirements",
        sections: [{ ...f.t.sections[0], items: [f.t.sections[0]!.items[0]] }],
      },
    });
    expect(newer.version).toBe(2);
    const current = await field.getVisitWorkspace(f.scope);
    expect(current.template?.version).toBe(1);
    expect(current.template?.sections[0]?.items).toHaveLength(2);
    expect(current.templates).toHaveLength(2);
    await expect(
      field.attachTemplate({
        ...f.scope,
        expectedRevision: 1,
        templateId: newer.id,
        templateVersion: 2,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_FIELD_TEMPLATE_PINNED" });
    await expect(
      admin.query(
        "UPDATE cpl_field_templates SET snapshot='{}' WHERE organization_id=$1 AND id=$2",
        [f.request.organizationId, f.t.id],
      ),
    ).rejects.toThrow();
    await expect(
      admin.query(
        "UPDATE cpl_field_records SET template_version=2 WHERE organization_id=$1 AND visit_id=$2",
        [f.request.organizationId, f.visit.id],
      ),
    ).rejects.toThrow();
  });
  it("saves incomplete answers and blocks existing execution completion until ready", async () => {
    const f = await fieldFixture();
    const incomplete = await field.saveChecklist({
      ...f.scope,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      answers: [],
    });
    expect(incomplete.readiness).toHaveLength(2);
    await expect(
      execution.saveVisit({
        ...f.scope,
        expectedRevision: f.visit.revision,
        idempotencyKey: randomUUID(),
        input: completedInput(f),
      }),
    ).rejects.toMatchObject({ code: "CPL_FIELD_VISIT_NOT_READY" });
    const p = await readyPhoto(f),
      ready = await checklistReady(f, p.ready.photo.id);
    expect(ready.readiness).toEqual([]);
    const completed = await execution.saveVisit({
      ...f.scope,
      expectedRevision: f.visit.revision,
      idempotencyKey: randomUUID(),
      input: completedInput(f),
    });
    expect(completed.status).toBe("completed");
    await expect(
      field.saveChecklist({
        ...f.scope,
        expectedRevision: ready.revision,
        idempotencyKey: randomUUID(),
        answers: [],
      }),
    ).rejects.toMatchObject({ code: "CPL_FIELD_VISIT_LOCKED" });
  });
  it("preserves checklist and observation revisions with stale edits and idempotent retries", async () => {
    const f = await fieldFixture(),
      key = randomUUID();
    const request = {
      ...f.scope,
      expectedRevision: 1,
      idempotencyKey: key,
      input: {
        title: "First observation",
        description: "Human text",
        reportEligible: false,
        internalNotes: "Private",
      },
    };
    const saved = await field.saveObservation(request);
    const retried = await field.saveObservation(request);
    expect(retried.revision).toBe(2);
    expect(retried.observations).toHaveLength(1);
    const id = saved.observations[0]!.id;
    const corrected = await field.saveObservation({
      ...f.scope,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      observationId: id,
      input: {
        ...saved.observations[0],
        title: "Corrected observation",
        followUp: "Human follow-up",
        reportEligible: true,
      },
    });
    expect(corrected.observations[0]?.revisions.map((v) => v.title)).toEqual([
      "Corrected observation",
      "First observation",
    ]);
    await expect(
      field.saveObservation({ ...request, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CPL_FIELD_VERSION_CONFLICT" });
    await expect(
      field.saveObservation({ ...request, input: { ...request.input, title: "Different" } }),
    ).rejects.toMatchObject({ code: "CPL_IDEMPOTENCY_CONFLICT" });
    await expect(
      admin.query(
        "UPDATE cpl_field_observation_revisions SET snapshot='{}' WHERE organization_id=$1",
        [f.request.organizationId],
      ),
    ).rejects.toThrow();
  });
  it("isolates field users to assignment, allows reviewers read only and restricts template authors", async () => {
    const f = await fieldFixture(),
      assigned = await member(f, "field-user"),
      reviewer = await member(f, "reviewer");
    await expect(
      field.getVisitWorkspace({ ...assigned.query, visitId: f.visit.id }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    await execution.saveVisit({
      ...f.scope,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: { ...f.visit, responsibleIdentityId: assigned.session.identityId },
    });
    const s = { ...assigned.query, visitId: f.visit.id };
    expect((await field.getVisitWorkspace(s)).permissions.canEdit).toBe(true);
    await field.saveObservation({
      ...s,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: { title: "Assigned human finding", reportEligible: false },
    });
    await expect(
      field.saveTemplate({
        ...assigned.query,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: templateInput(),
      }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
    const r = { ...reviewer.query, visitId: f.visit.id };
    expect((await field.getVisitWorkspace(r)).permissions.canEdit).toBe(false);
    await expect(
      field.reservePhoto({ ...r, idempotencyKey: randomUUID(), input: upload() }),
    ).rejects.toMatchObject({ code: "CPL_ACCESS_DENIED" });
  });
  it("reserves concurrent photos append-only with stable opaque IDs and upload-key conflict refusal", async () => {
    const f = await fieldFixture(),
      request = { ...f.scope, idempotencyKey: randomUUID(), input: upload() };
    const [first, retry] = await Promise.all([
      field.reservePhoto(request),
      field.reservePhoto(request),
    ]);
    expect(retry).toEqual(first);
    expect(
      new Set([first.original.objectId, first.thumbnailObjectId, first.reportObjectId]).size,
    ).toBe(3);
    const second = await field.reservePhoto({ ...request, idempotencyKey: randomUUID() });
    expect(second.photo.id).not.toBe(first.photo.id);
    expect((await field.getVisitWorkspace(f.scope)).revision).toBe(3);
    await expect(
      field.reservePhoto({ ...request, input: { ...upload(), sha256: sha("different") } }),
    ).rejects.toMatchObject({ code: "CPL_IDEMPOTENCY_CONFLICT" });
  });
  it("retains original references across storage failure and retry without duplicate metadata", async () => {
    const f = await fieldFixture(),
      request = { ...f.scope, idempotencyKey: randomUUID(), input: upload() },
      reserved = await field.reservePhoto(request);
    const failed = await field.failPhoto({
      ...f.scope,
      photoId: reserved.photo.id,
      expectedPhotoRevision: 1,
      idempotencyKey: randomUUID(),
      failureCode: "CPL_PHOTO_ORIGINAL_UNAVAILABLE",
    });
    expect(failed.photo.state).toBe("failed");
    const retried = await field.reservePhoto(request);
    expect(retried.original).toEqual(reserved.original);
    const originalRequest = {
      ...f.scope,
      photoId: reserved.photo.id,
      expectedPhotoRevision: failed.photo.revision,
      idempotencyKey: randomUUID(),
      original: { width: 20, height: 10, exifOrientation: null },
      upright: { width: 20, height: 10 },
    };
    const original = await field.recordPhotoOriginal(originalRequest);
    expect((await field.recordPhotoOriginal(originalRequest)).photo.revision).toBe(
      original.photo.revision,
    );
    expect(
      await field.getPhotoContent({ ...f.scope, photoId: reserved.photo.id, kind: "original" }),
    ).toEqual(reserved.original);
    expect(original.photo.revisions).toHaveLength(1);
  });
  it("uses bounded processing claims and rejects expired/stolen completion without overwriting original", async () => {
    const f = await fieldFixture(),
      p = await readyPhoto(f);
    expect(p.ready.photo.state).toBe("ready");
    expect((await field.completePhoto(p.request)).photo).toEqual(p.ready.photo);
    await expect(
      field.completePhoto({
        ...p.request,
        idempotencyKey: randomUUID(),
        processingToken: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_FIELD_PHOTO_LEASE_EXPIRED" });
    await expect(
      admin.query("UPDATE cpl_field_photos SET upload='{}' WHERE organization_id=$1 AND id=$2", [
        f.request.organizationId,
        p.ready.photo.id,
      ]),
    ).rejects.toThrow();
    await expect(
      admin.query("UPDATE cpl_field_photos SET report='{}' WHERE organization_id=$1 AND id=$2", [
        f.request.organizationId,
        p.ready.photo.id,
      ]),
    ).rejects.toThrow();
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
    await expect(
      field.beginPhotoProcessing({
        ...f.scope,
        photoId: reserved.photo.id,
        expectedPhotoRevision: claim.photo.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CPL_FIELD_PHOTO_BUSY" });
    await admin.query(
      "UPDATE cpl_field_photos SET processing_expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE organization_id=$1 AND id=$2",
      [f.request.organizationId, reserved.photo.id],
    );
    await expect(
      field.completePhoto({
        ...f.scope,
        photoId: reserved.photo.id,
        processingToken: claim.processingToken,
        idempotencyKey: randomUUID(),
        thumbnail: image("t"),
        report: image("r"),
      }),
    ).rejects.toMatchObject({ code: "CPL_FIELD_PHOTO_LEASE_EXPIRED" });
    const reclaimed = await field.beginPhotoProcessing({
      ...f.scope,
      photoId: reserved.photo.id,
      expectedPhotoRevision: claim.photo.revision,
      idempotencyKey: randomUUID(),
    });
    expect(reclaimed.photo.attempts).toBe(2);
    expect(reclaimed.processingToken).not.toBe(claim.processingToken);
  });
  it("keeps captions, report exclusion and annotations independent of processing revisions", async () => {
    const f = await fieldFixture(),
      p = await readyPhoto(f),
      w = await field.getVisitWorkspace(f.scope);
    expect(w.revision).toBe(2);
    const input = {
      ...p.ready.photo.metadata,
      caption: "Human image caption",
      overview: true,
      reportEligible: false,
      annotations: {
        coordinateSpace: "upright-normalized-v1",
        shapes: [
          {
            kind: "rectangle",
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.3,
            color: "#FF0000",
            strokeWidth: 0.005,
          },
        ],
      },
    };
    const saved = await field.savePhotoMetadata({
      ...f.scope,
      photoId: p.ready.photo.id,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      input,
    });
    expect(saved.photos[0]?.metadata).toMatchObject({
      caption: input.caption,
      reportEligible: false,
      revision: 2,
    });
    expect(saved.photos[0]?.revision).toBe(p.ready.photo.revision);
    expect(saved.photos[0]?.revisions).toHaveLength(2);
    expect(saved.photos[0]?.original.sha256).toBe(p.ready.photo.original.sha256);
    await expect(
      field.savePhotoMetadata({
        ...f.scope,
        photoId: p.ready.photo.id,
        expectedRevision: 3,
        idempotencyKey: randomUUID(),
        input: { ...input, annotations: { ...input.annotations, svg: "<script>" } },
      }),
    ).rejects.toMatchObject({ code: "CPL_IMAGE_INVALID_ANNOTATIONS" });
  });
  it("revalidates membership after photo processing and preserves recoverable original on revocation", async () => {
    const f = await fieldFixture();
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
    await admin.query(
      "UPDATE cpl_memberships SET status='suspended',version=version+1 WHERE organization_id=$1 AND identity_id=$2",
      [f.request.organizationId, f.actor.session.identityId],
    );
    const request = {
      ...f.scope,
      photoId: reserved.photo.id,
      processingToken: claim.processingToken,
      idempotencyKey: randomUUID(),
      thumbnail: image("t"),
      report: image("r"),
    };
    await expect(field.completePhoto(request)).rejects.toThrow();
    const persisted = (
      await admin.query(
        "SELECT state,original_object_id,original_metadata,report FROM cpl_field_photos WHERE organization_id=$1 AND id=$2",
        [f.request.organizationId, reserved.photo.id],
      )
    ).rows[0];
    expect(persisted).toMatchObject({
      state: "processing",
      original_object_id: reserved.original.objectId,
      report: null,
    });
    expect(persisted?.original_metadata).not.toBeNull();
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM cpl_field_mutations WHERE organization_id=$1 AND idempotency_key=$2",
          [f.request.organizationId, request.idempotencyKey],
        )
      ).rows[0]?.count,
    ).toBe("0");
  });
  it("blocks optional photo finalization races through the existing visit completion service", async () => {
    const f = await fieldFixture();
    const waived = await field.saveChecklist({
      ...f.scope,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      answers: f.t.sections[0]!.items.map((i) => ({
        itemId: i.id,
        result: "not_applicable",
        value: null,
        note: "Not applicable to this fictional visit",
        photoIds: [],
      })),
    });
    expect(waived.readiness).toEqual([]);
    const reserved = await field.reservePhoto({
      ...f.scope,
      idempotencyKey: randomUUID(),
      input: upload(),
    });
    expect((await field.getVisitWorkspace(f.scope)).readiness).toMatchObject([
      { code: "CPL_FIELD_PHOTO_PENDING", field: reserved.photo.id },
    ]);
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
    // Native image/file work is outside SQL. A concurrent completion at this
    // exact durable claim state formerly succeeded and stranded finalization.
    const completion = {
      ...f.scope,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: completedInput(f),
    };
    await expect(execution.saveVisit(completion)).rejects.toMatchObject({
      code: "CPL_FIELD_VISIT_NOT_READY",
    });
    await field.completePhoto({
      ...f.scope,
      photoId: reserved.photo.id,
      processingToken: claim.processingToken,
      idempotencyKey: randomUUID(),
      thumbnail: image("t"),
      report: image("r"),
    });
    expect((await execution.saveVisit(completion)).status).toBe("completed");
  });
  it("retains a failed optional upload without creating a permanent completion blocker", async () => {
    const f = await fieldFixture();
    await field.saveChecklist({
      ...f.scope,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      answers: f.t.sections[0]!.items.map((i) => ({
        itemId: i.id,
        result: "not_applicable",
        value: null,
        note: "Not applicable to this fictional visit",
        photoIds: [],
      })),
    });
    const reserved = await field.reservePhoto({
      ...f.scope,
      idempotencyKey: randomUUID(),
      input: upload(),
    });
    await field.failPhoto({
      ...f.scope,
      photoId: reserved.photo.id,
      expectedPhotoRevision: 1,
      idempotencyKey: randomUUID(),
      failureCode: "CPL_PHOTO_ORIGINAL_UNAVAILABLE",
    });
    const current = await field.getVisitWorkspace(f.scope);
    expect(current.readiness).toEqual([]);
    expect(current.photos[0]?.state).toBe("failed");
    expect(
      (
        await execution.saveVisit({
          ...f.scope,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
          input: completedInput(f),
        })
      ).status,
    ).toBe("completed");
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM cpl_field_photos WHERE organization_id=$1 AND id=$2",
          [f.request.organizationId, reserved.photo.id],
        )
      ).rows[0]?.count,
    ).toBe("1");
  });
  it("rejects cross-tenant and wrong-visit references and raw RLS reads", async () => {
    const a = await fieldFixture(),
      b = await fieldFixture(),
      p = await readyPhoto(a);
    await expect(
      field.getVisitWorkspace({ ...b.request, projectId: a.project.id, visitId: a.visit.id }),
    ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    await expect(
      field.getPhotoContent({ ...b.scope, photoId: p.ready.photo.id, kind: "original" }),
    ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    const second = await execution.createVisit({
      ...a.query,
      idempotencyKey: randomUUID(),
      input: appointment(a.actor.session.identityId, {
        plannedStartLocal: "2026-10-12T11:00",
        plannedEndLocal: "2026-10-12T12:00",
      }),
    });
    await expect(
      field.getPhotoContent({
        ...a.scope,
        visitId: second.id,
        photoId: p.ready.photo.id,
        kind: "original",
      }),
    ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    const current = await field.getVisitWorkspace(b.scope);
    await expect(
      field.saveChecklist({
        ...b.scope,
        expectedRevision: current.revision,
        idempotencyKey: randomUUID(),
        answers: [
          {
            itemId: b.t.sections[0]!.items[1]!.id,
            result: "complete",
            photoIds: [p.ready.photo.id],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
    expect((await web.query("SELECT * FROM cpl_field_photos")).rows).toEqual([]);
    const owner = await field.saveObservation({
      ...a.scope,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      input: { title: "Local observation", reportEligible: true },
    });
    await expect(
      field.savePhotoMetadata({
        ...a.scope,
        photoId: p.ready.photo.id,
        expectedRevision: owner.revision,
        idempotencyKey: randomUUID(),
        input: { ...p.ready.photo.metadata, observationId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "CPL_RECORD_NOT_FOUND" });
  });
  it("serializes checklist changes with completion so stale readiness cannot pass", async () => {
    const f = await fieldFixture(),
      p = await readyPhoto(f),
      ready = await checklistReady(f, p.ready.photo.id);
    const results = await Promise.allSettled([
      field.saveChecklist({
        ...f.scope,
        expectedRevision: ready.revision,
        idempotencyKey: randomUUID(),
        answers: [],
      }),
      execution.saveVisit({
        ...f.scope,
        expectedRevision: f.visit.revision,
        idempotencyKey: randomUUID(),
        input: completedInput(f),
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const current = await field.getVisitWorkspace(f.scope);
    expect(
      current.visit.status === "completed"
        ? current.readiness.length === 0
        : current.readiness.length > 0,
    ).toBe(true);
  });
  it("explicitly reopens completed visits with history and optimistic/idempotent protection", async () => {
    const f = await fieldFixture(),
      p = await readyPhoto(f),
      ready = await checklistReady(f, p.ready.photo.id);
    const completed = await execution.saveVisit({
      ...f.scope,
      expectedRevision: f.visit.revision,
      idempotencyKey: randomUUID(),
      input: completedInput(f),
    });
    const request = {
      ...f.scope,
      expectedFieldRevision: ready.revision,
      expectedVisitRevision: completed.revision,
      idempotencyKey: randomUUID(),
      reason: "Correct human observation",
    };
    const reopened = await field.reopenVisit(request);
    expect(reopened.visit).toMatchObject({
      status: "in_progress",
      actualEndAt: null,
      completionNote: "",
    });
    expect((await field.reopenVisit(request)).revision).toBe(reopened.revision);
    const events = (await execution.getProjectWorkspace(f.query)).events;
    expect(
      events.some(
        (e) =>
          e.action === "visit.reopened" && (e.before as { status: string }).status === "completed",
      ),
    ).toBe(true);
    expect(reopened.events.some((e) => e.note === request.reason)).toBe(true);
  });
  it("rolls back data and idempotency reservation on audit failure", async () => {
    const f = await fieldFixture(),
      countBefore = await admin.query(
        "SELECT count(*) FROM cpl_field_mutations WHERE organization_id=$1",
        [f.request.organizationId],
      );
    await admin.execute(
      "CREATE FUNCTION cpl_field_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='field.observation.saved' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER cpl_field_test_fail BEFORE INSERT ON cpl_tenant_audit_events FOR EACH ROW EXECUTE FUNCTION cpl_field_test_fail_audit();",
    );
    const request = {
      ...f.scope,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      input: { title: "Rollback candidate", reportEligible: false },
    };
    try {
      await expect(field.saveObservation(request)).rejects.toThrow();
    } finally {
      await admin.execute(
        "DROP TRIGGER cpl_field_test_fail ON cpl_tenant_audit_events; DROP FUNCTION cpl_field_test_fail_audit();",
      );
    }
    expect((await field.getVisitWorkspace(f.scope)).observations).toEqual([]);
    expect(
      (
        await admin.query("SELECT count(*) FROM cpl_field_mutations WHERE organization_id=$1", [
          f.request.organizationId,
        ])
      ).rows,
    ).toEqual(countBefore.rows);
    expect((await field.saveObservation(request)).observations).toHaveLength(1);
  });
  it("fails closed after module revocation and forced-RLS drift", async () => {
    const f = await fieldFixture();
    await admin.query(
      "UPDATE cpl_module_entitlements SET enabled=FALSE WHERE organization_id=$1 AND module_key='field-report-assembler'",
      [f.request.organizationId],
    );
    await expect(field.getVisitWorkspace(f.scope)).rejects.toThrow();
    await admin.query(
      "UPDATE cpl_module_entitlements SET enabled=TRUE WHERE organization_id=$1 AND module_key='field-report-assembler'",
      [f.request.organizationId],
    );
    await admin.execute("ALTER TABLE cpl_field_photos NO FORCE ROW LEVEL SECURITY");
    try {
      await expect(field.getVisitWorkspace(f.scope)).rejects.toMatchObject({
        code: "CPL_FIELD_SCHEMA_UNSAFE",
      });
      await expect(verifyHostedDatabaseRole(web, "web")).rejects.toThrow();
    } finally {
      await admin.execute("ALTER TABLE cpl_field_photos FORCE ROW LEVEL SECURITY");
    }
    expect((await field.getVisitWorkspace(f.scope)).template?.id).toBe(f.t.id);
  });
});
