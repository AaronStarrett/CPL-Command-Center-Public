import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ConfigurationActivationError,
  ConfigurationValidationError,
  DEMO_PERSONAS,
  hashRawSourceText,
  ProductionMappingNotConfiguredError,
  SEEDED_CONFIGURATION_IDS,
  SEEDED_OPERATIONS_IDS,
  SYNTHETIC_ALTERNATE_COLLECTION_FIXTURE,
  SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE,
  SYNTHETIC_EXTERIOR_JSON_FIXTURE,
  SYNTHETIC_EXTERIOR_PACKAGE,
  SYNTHETIC_MOISTURE_CSV_FIXTURE,
  parseStagingSource,
  type JsonObject,
} from "../../packages/domain/src/index.js";
import {
  ConfigurationStudioService,
  InspectionReportPipeline,
  PGliteDatabaseAdapter,
  SqlFoundationRepository,
  createInspectionReportPipeline,
  migrateDatabase,
  seedDatabase,
} from "../../packages/database/src/index.js";
import { PERMISSIONS, PersistentAuthorizationService } from "../../packages/security/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;
const SALES = DEMO_PERSONAS[1].id;
const OPERATIONS = DEMO_PERSONAS[2].id;
const INTEGRATION = DEMO_PERSONAS[4].id;

let database: PGliteDatabaseAdapter;
let configuration: ConfigurationStudioService;
let pipeline: InspectionReportPipeline;
let authorization: PersistentAuthorizationService;

async function prepareInspection(releaseId: string) {
  const inspection = await configuration.createInspection({
    projectId: SEEDED_OPERATIONS_IDS.happyProject,
    configurationReleaseId: releaseId,
    inspectionType: "synthetic-lab",
    inspectorUserId: OPERATIONS,
    scheduledAt: null,
    actorUserId: OWNER,
    correlationId: `setup-${releaseId}-${Date.now()}`,
  });
  for (const key of ["scope", "access", "equipment"]) {
    await configuration.updateInspectionSetup({
      inspectionId: inspection.id,
      action: "checklist",
      checklistKey: key,
      checklistStatus: "complete",
      actorUserId: OWNER,
      correlationId: `checklist-${key}`,
    });
  }
  await configuration.updateInspectionSetup({
    inspectionId: inspection.id,
    action: "ready",
    actorUserId: OWNER,
    correlationId: "ready",
  });
  await configuration.updateInspectionSetup({
    inspectionId: inspection.id,
    action: "start",
    actorUserId: OWNER,
    correlationId: "start",
  });
  await configuration.updateInspectionSetup({
    inspectionId: inspection.id,
    action: "complete",
    actorUserId: OWNER,
    correlationId: "complete",
  });
  return inspection;
}

beforeAll(async () => {
  database = new PGliteDatabaseAdapter("memory://");
  const migrated = await migrateDatabase(database);
  expect(migrated.applied.at(-1)).toBe("0039_cpl_durable_inbound.sql");
  await seedDatabase(database);
  configuration = new ConfigurationStudioService(database);
  pipeline = createInspectionReportPipeline(database, "demo", { processInline: true });
  configuration.bindSubmissions({
    submitInspection: (input) => pipeline.submitInspection(input),
  });
  authorization = new PersistentAuthorizationService(new SqlFoundationRepository(database));
}, 60_000);

afterAll(async () => {
  await database?.close();
});

describe("Phase 3.1A configurable report production", () => {
  it("scenario 1 publishes and activates a cloned synthetic release with complete audit history", async () => {
    const cloned = await configuration.cloneRelease({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      actorUserId: OWNER,
      correlationId: "s1-clone",
    });
    expect(cloned.status).toBe("draft");
    const validated = await configuration.validateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "s1-validate",
    });
    expect(validated.passed).toBe(true);
    const published = await configuration.publishRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "s1-publish",
    });
    expect(published.status).toBe("published");
    const activated = await configuration.activateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "s1-activate",
    });
    expect(activated.status).toBe("active");
    const audit = await configuration.repository.listAudit(cloned.id);
    expect(audit.some((item) => String(item.action) === "configuration.clone")).toBe(true);
    expect(audit.some((item) => String(item.action) === "configuration.validate")).toBe(true);
    expect(audit.some((item) => String(item.action) === "configuration.publish")).toBe(true);
    expect(audit.some((item) => String(item.action) === "configuration.activate")).toBe(true);
  });

  it("scenario 2 blocks publication when required fields are unmapped", async () => {
    const draft = await configuration.createDraft({
      familyKey: "synthetic-invalid-lab",
      displayName: "Invalid mapping draft",
      serviceContextKey: "synthetic-invalid-lab",
      description: "Missing required mappings",
      synthetic: true,
      actorUserId: OWNER,
      correlationId: "s2-draft",
    });
    await configuration.updateDraftArtifact({
      releaseId: draft.id,
      kind: "inspection_schema",
      artifactKey: SYNTHETIC_EXTERIOR_PACKAGE.schema.schemaKey,
      payload: SYNTHETIC_EXTERIOR_PACKAGE.schema as unknown as JsonObject,
      expectedVersion: draft.version,
      actorUserId: OWNER,
      correlationId: "s2-schema",
    });
    const mapping = {
      ...SYNTHETIC_EXTERIOR_PACKAGE.mapping,
      rules: SYNTHETIC_EXTERIOR_PACKAGE.mapping.rules.filter(
        (rule) => rule.canonicalField !== "client_name",
      ),
    };
    const afterSchema = await configuration.repository.getRelease(draft.id);
    await configuration.updateDraftArtifact({
      releaseId: draft.id,
      kind: "mapping_profile",
      artifactKey: mapping.profileKey,
      payload: mapping as unknown as JsonObject,
      expectedVersion: afterSchema!.version,
      actorUserId: OWNER,
      correlationId: "s2-mapping",
    });
    for (const [kind, key, payload] of [
      [
        "validation_rule_set",
        SYNTHETIC_EXTERIOR_PACKAGE.validation.ruleSetKey,
        SYNTHETIC_EXTERIOR_PACKAGE.validation,
      ],
      [
        "report_template",
        SYNTHETIC_EXTERIOR_PACKAGE.template.templateKey,
        SYNTHETIC_EXTERIOR_PACKAGE.template,
      ],
      [
        "review_policy",
        SYNTHETIC_EXTERIOR_PACKAGE.review.policyKey,
        SYNTHETIC_EXTERIOR_PACKAGE.review,
      ],
      [
        "storage_policy",
        SYNTHETIC_EXTERIOR_PACKAGE.storage.policyKey,
        SYNTHETIC_EXTERIOR_PACKAGE.storage,
      ],
      [
        "delivery_policy",
        SYNTHETIC_EXTERIOR_PACKAGE.delivery.policyKey,
        SYNTHETIC_EXTERIOR_PACKAGE.delivery,
      ],
      ["sla_policy", SYNTHETIC_EXTERIOR_PACKAGE.sla.policyKey, SYNTHETIC_EXTERIOR_PACKAGE.sla],
      [
        "workflow_blueprint",
        SYNTHETIC_EXTERIOR_PACKAGE.workflow.policyKey,
        SYNTHETIC_EXTERIOR_PACKAGE.workflow,
      ],
    ] as const) {
      const current = await configuration.repository.getRelease(draft.id);
      await configuration.updateDraftArtifact({
        releaseId: draft.id,
        kind,
        artifactKey: key,
        payload: payload as unknown as JsonObject,
        expectedVersion: current!.version,
        actorUserId: OWNER,
        correlationId: `s2-${kind}`,
      });
    }
    const validated = await configuration.validateRelease({
      releaseId: draft.id,
      actorUserId: OWNER,
      correlationId: "s2-validate",
    });
    expect(validated.passed).toBe(false);
    expect(validated.issues.some((item) => item.code === "mapping.required_field_unmapped")).toBe(
      true,
    );
    await expect(
      configuration.publishRelease({
        releaseId: draft.id,
        actorUserId: OWNER,
        correlationId: "s2-publish",
      }),
    ).rejects.toBeInstanceOf(ConfigurationValidationError);
  });

  it("scenario 3 dry-run maps JSON without creating a submission", async () => {
    const before = await database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM inspection_submissions",
    );
    const result = await configuration.dryRunMapping({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      sourceType: "json",
      raw: JSON.stringify(SYNTHETIC_EXTERIOR_JSON_FIXTURE),
      actorUserId: OWNER,
      correlationId: "s3-dry",
    });
    expect(result.staging.dryRun).toBe(true);
    expect(result.mapping.canonical.fields.client_name).toBeTruthy();
    expect(result.mapping.unmappedSourceFields.length).toBeGreaterThan(0);
    expect(result.mapping.canonical.lineage.length).toBeGreaterThan(0);
    const after = await database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM inspection_submissions",
    );
    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count));
  });

  it("scenario 4 maps CSV through the moisture profile", async () => {
    const result = await configuration.dryRunMapping({
      releaseId: SEEDED_CONFIGURATION_IDS.moistureRelease,
      sourceType: "csv",
      raw: SYNTHETIC_MOISTURE_CSV_FIXTURE,
      actorUserId: OWNER,
      correlationId: "s4-csv",
    });
    expect(result.mapping.canonical.fields.client_name).toBeTruthy();
    expect(result.mapping.canonical.fields.indoor_rh).not.toBeUndefined();
  });

  it("scenario 5 renders two configuration-driven reports without fixture-id branches", async () => {
    const exterior = await configuration.previewReport({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      sourceType: "json",
      raw: JSON.stringify(SYNTHETIC_EXTERIOR_JSON_FIXTURE),
    });
    const moisture = await configuration.previewReport({
      releaseId: SEEDED_CONFIGURATION_IDS.moistureRelease,
      sourceType: "csv",
      raw: SYNTHETIC_MOISTURE_CSV_FIXTURE,
    });
    expect(exterior.rendered.filename).toContain("BEA-SYN-EXT");
    expect(moisture.rendered.filename).toContain("BEA-SYN-MOI");
    expect(exterior.document.nodes.map((node) => node.kind)).not.toEqual(
      moisture.document.nodes.map((node) => node.kind),
    );
    expect(exterior.rendered.checksumSha256).not.toBe(moisture.rendered.checksumSha256);
  });

  it("scenario 6 keeps historical reports tied to the prior configuration release", async () => {
    const baseline = await configuration.repository.getRelease(
      SEEDED_CONFIGURATION_IDS.exteriorRelease,
    );
    const inspection = await prepareInspection(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    const submitted = await pipeline.submitInspection({
      inspectionId: inspection.id,
      sourceChannel: "file_import",
      sourceIdempotencyKey: `hist-${inspection.id}`,
      payload: SYNTHETIC_EXTERIOR_JSON_FIXTURE,
      actorUserId: OWNER,
      correlationId: `hist-${inspection.id}`,
    });
    expect(submitted.submission.configurationReleaseId).toBe(
      SEEDED_CONFIGURATION_IDS.exteriorRelease,
    );
    const report = await pipeline.repository.getReportByInspection(inspection.id);
    expect(report?.configurationReleaseId).toBe(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    const versions = report ? await pipeline.repository.listReportVersions(report.id) : [];
    const originalSnapshot = versions[0]?.inputSnapshot ?? {};
    const cloned = await configuration.cloneRelease({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      actorUserId: OWNER,
      correlationId: "hist-clone",
    });
    const template = {
      ...SYNTHETIC_EXTERIOR_PACKAGE.template,
      filenamePattern: "BEA-SYN-EXT-V2-{inspectionRef}.pdf",
      templateVersion: 2,
    };
    await configuration.updateDraftArtifact({
      releaseId: cloned.id,
      kind: "report_template",
      artifactKey: template.templateKey,
      payload: template as unknown as JsonObject,
      expectedVersion: cloned.version,
      actorUserId: OWNER,
      correlationId: "hist-template",
    });
    await configuration.validateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "hist-validate",
    });
    await configuration.publishRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "hist-publish",
    });
    await configuration.activateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "hist-activate",
    });
    const reread = report ? await pipeline.repository.listReportVersions(report.id) : [];
    expect(reread[0]?.configurationReleaseId).toBe(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    expect(reread[0]?.inputSnapshot).toEqual(originalSnapshot);
    expect(baseline?.id).toBe(SEEDED_CONFIGURATION_IDS.exteriorRelease);
  });

  it("scenario 7 separates blocking validation from warnings and retains history", async () => {
    const completeSource = parseStagingSource("csv", SYNTHETIC_MOISTURE_CSV_FIXTURE).source;
    const incomplete = { ...completeSource, client_name: "" };
    const inspection = await prepareInspection(SEEDED_CONFIGURATION_IDS.moistureRelease);
    await pipeline.submitInspection({
      inspectionId: inspection.id,
      sourceChannel: "file_import",
      sourceIdempotencyKey: `val-bad-${inspection.id}`,
      payload: incomplete,
      actorUserId: OWNER,
      correlationId: `val-bad-${inspection.id}`,
    });
    const first = await pipeline.repository.latestValidation(inspection.id);
    expect(first?.passed).toBe(false);
    expect(first?.blocking.length).toBeGreaterThan(0);
    await pipeline.submitInspection({
      inspectionId: inspection.id,
      sourceChannel: "file_import",
      sourceIdempotencyKey: `val-good-${inspection.id}`,
      payload: completeSource,
      actorUserId: OWNER,
      correlationId: `val-good-${inspection.id}`,
    });
    const history = await database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM inspection_validation_results WHERE inspection_id=$1",
      [inspection.id],
    );
    expect(Number(history.rows[0]?.count)).toBeGreaterThan(1);
  });

  it("scenario 8 creates an inspection from an existing project and continues into the report flow", async () => {
    const inspection = await prepareInspection(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    expect(inspection.configurationReleaseId).toBe(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    const submitted = await pipeline.submitInspection({
      inspectionId: inspection.id,
      sourceChannel: "file_import",
      sourceIdempotencyKey: `setup-${inspection.id}`,
      payload: SYNTHETIC_EXTERIOR_JSON_FIXTURE,
      actorUserId: OWNER,
      correlationId: `setup-${inspection.id}`,
    });
    expect(submitted.duplicate).toBe(false);
    const live = await pipeline.repository.getInspection(inspection.id);
    expect(["submitted", "validating", "validated", "reporting", "complete"]).toContain(
      live?.status,
    );
  });

  it("scenario 9 produces a no-write SharePoint and Outlook plan", async () => {
    const manifest = await configuration.connectorDryRun({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      inspectionReference: "BEA-IN-DRY",
      reportReference: "BEA-RP-DRY",
      projectReference: "BEA-PR-DRY",
      filename: "synthetic.pdf",
      actorUserId: OWNER,
      correlationId: "s9",
    });
    expect(manifest.liveWrites).toBe(false);
    expect(manifest.calendarEventThatWouldBePrepared.disclosure).toMatch(/not connected/i);
    const connectors = await pipeline.repository.listConnectorReadiness();
    expect(connectors.every((item) => item.readinessStatus !== "healthy")).toBe(true);
    expect(connectors.every((item) => item.readinessStatus !== "authenticated")).toBe(true);
    await expect(
      configuration.activateRelease({
        releaseId: SEEDED_CONFIGURATION_IDS.productionDraft,
        actorUserId: OWNER,
        correlationId: "s9-prod",
      }),
    ).rejects.toBeInstanceOf(ConfigurationActivationError);
  });

  it("scenario 10 enforces configuration RBAC server-side", async () => {
    expect(
      (await authorization.authorizeUser(OWNER, PERMISSIONS.CONFIGURATION_ACTIVATE)).allowed,
    ).toBe(true);
    expect(
      (await authorization.authorizeUser(INTEGRATION, PERMISSIONS.CONFIGURATION_DRAFT)).allowed,
    ).toBe(true);
    expect(
      (await authorization.authorizeUser(INTEGRATION, PERMISSIONS.CONFIGURATION_ACTIVATE)).allowed,
    ).toBe(false);
    expect(
      (await authorization.authorizeUser(OPERATIONS, PERMISSIONS.CONFIGURATION_PUBLISH)).allowed,
    ).toBe(false);
    expect((await authorization.authorizeUser(SALES, PERMISSIONS.CONFIGURATION_VIEW)).allowed).toBe(
      false,
    );
  });

  it("scenario 11 boots without AI or Microsoft credentials", () => {
    expect(process.env.OPENAI_API_KEY ?? "").toBe("");
  });

  it("scenario 12 rolls back activation without mutating older reports", async () => {
    const first = await configuration.repository.getRelease(
      SEEDED_CONFIGURATION_IDS.moistureRelease,
    );
    expect(first?.status).toBe("active");
    const cloned = await configuration.cloneRelease({
      releaseId: SEEDED_CONFIGURATION_IDS.moistureRelease,
      actorUserId: OWNER,
      correlationId: "rb-clone",
    });
    await configuration.validateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "rb-validate",
    });
    await configuration.publishRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "rb-publish",
    });
    await configuration.activateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "rb-activate",
    });
    const inspection = await prepareInspection(cloned.id);
    await pipeline.submitInspection({
      inspectionId: inspection.id,
      sourceChannel: "file_import",
      sourceIdempotencyKey: `rb-${inspection.id}`,
      payload: parseStagingSource("csv", SYNTHETIC_MOISTURE_CSV_FIXTURE).source,
      actorUserId: OWNER,
      correlationId: `rb-${inspection.id}`,
    });
    const report = await pipeline.repository.getReportByInspection(inspection.id);
    await configuration.activateRelease({
      releaseId: SEEDED_CONFIGURATION_IDS.moistureRelease,
      actorUserId: OWNER,
      correlationId: "rb-rollback",
      rollback: true,
    });
    const rolled = await configuration.repository.getRelease(
      SEEDED_CONFIGURATION_IDS.moistureRelease,
    );
    const later = await configuration.repository.getRelease(cloned.id);
    expect(rolled?.status).toBe("active");
    expect(later?.status).toBe("superseded");
    const reread = report ? await pipeline.repository.getReport(report.id) : null;
    expect(reread?.configurationReleaseId).toBe(cloned.id);
    const audit = await configuration.repository.listAudit(
      SEEDED_CONFIGURATION_IDS.moistureRelease,
    );
    expect(audit.some((item) => String(item.action) === "configuration.rollback")).toBe(true);
  });

  it("preserves complete raw source hashes and staging duplicate outcomes", async () => {
    const prefix = "y".repeat(12_000);
    const left = `${JSON.stringify({ ...SYNTHETIC_EXTERIOR_JSON_FIXTURE, tag: "left" }).slice(0, -1)},"pad":"${prefix}","end":"one"}`;
    const right = `${JSON.stringify({ ...SYNTHETIC_EXTERIOR_JSON_FIXTURE, tag: "right" }).slice(0, -1)},"pad":"${prefix}","end":"two"}`;
    const firstInspection = await prepareInspection(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    const first = await configuration.commitStagedInspection({
      inspectionId: firstInspection.id,
      sourceType: "json",
      raw: left,
      actorUserId: OWNER,
      correlationId: `hash-left-${firstInspection.id}`,
    });
    expect(first.staging.status).toBe("committed");
    expect(first.newSubmissionCreated).toBe(true);
    expect(first.staging.rawSourceText).toBe(left);
    expect(first.staging.rawSourceSha256).toBe(hashRawSourceText(left).sha256);
    expect(first.staging.rawSourceByteLength).toBe(new TextEncoder().encode(left).byteLength);
    const duplicate = await configuration.commitStagedInspection({
      inspectionId: firstInspection.id,
      sourceType: "json",
      raw: left,
      actorUserId: OWNER,
      correlationId: `hash-dup-${firstInspection.id}`,
    });
    expect(duplicate.staging.status).toBe("duplicate");
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.newSubmissionCreated).toBe(false);
    expect(duplicate.submissionId).toBe(first.submissionId);
    const submissions = await database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM inspection_submissions WHERE inspection_id=$1",
      [firstInspection.id],
    );
    expect(Number(submissions.rows[0]?.count)).toBe(1);
    const secondInspection = await prepareInspection(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    const other = await configuration.dryRunMapping({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      sourceType: "json",
      raw: right,
      actorUserId: OWNER,
      correlationId: `hash-right-${secondInspection.id}`,
    });
    expect(other.staging.rawSourceSha256).not.toBe(first.staging.rawSourceSha256);
    const recomputed = await database.query<{ raw_source_text: string; raw_source_sha256: string }>(
      "SELECT raw_source_text, raw_source_sha256 FROM ingestion_staging_runs WHERE id=$1",
      [first.staging.id],
    );
    expect(hashRawSourceText(String(recomputed.rows[0]?.raw_source_text)).sha256).toBe(
      String(recomputed.rows[0]?.raw_source_sha256),
    );
  });

  it("records a failed submission and reconciles after an interrupted finalization", async () => {
    const inspection = await prepareInspection(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    const failing = new ConfigurationStudioService(database);
    failing.bindSubmissions({
      submitInspection: async () => {
        throw new Error("forced submit failure");
      },
    });
    const failed = await failing
      .commitStagedInspection({
        inspectionId: inspection.id,
        sourceType: "json",
        raw: JSON.stringify(SYNTHETIC_EXTERIOR_JSON_FIXTURE),
        actorUserId: OWNER,
        correlationId: `fail-${inspection.id}`,
      })
      .then(
        () => null,
        async () => {
          const rows = await database.query<{ id: string; status: string }>(
            "SELECT id, status FROM ingestion_staging_runs WHERE inspection_id=$1 ORDER BY created_at DESC LIMIT 1",
            [inspection.id],
          );
          return rows.rows[0];
        },
      );
    expect(failed?.status).toBe("failed");
    const retried = await configuration.retryStagingCommit({
      stagingId: String(failed?.id),
      actorUserId: OWNER,
      correlationId: `retry-${inspection.id}`,
    });
    expect(["committed", "duplicate"]).toContain(retried.staging.status);
    const interruptInspection = await prepareInspection(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    const raw = JSON.stringify({ ...SYNTHETIC_EXTERIOR_JSON_FIXTURE, summary: "interrupt" });
    const prepared = await configuration.prepareCommit({
      inspectionId: interruptInspection.id,
      sourceType: "json",
      raw,
      actorUserId: OWNER,
      correlationId: `prep-${interruptInspection.id}`,
    });
    const submitted = await pipeline.submitInspection({
      inspectionId: interruptInspection.id,
      sourceChannel: "file_import",
      sourceIdempotencyKey: prepared.sourceIdempotencyKey,
      payload: prepared.source,
      actorUserId: OWNER,
      correlationId: `submit-${interruptInspection.id}`,
    });
    expect(prepared.staging.status).toBe("validated");
    const reconciled = await configuration.reconcileStaging({
      stagingId: prepared.staging.id,
      actorUserId: OWNER,
      correlationId: `recon-${interruptInspection.id}`,
    });
    expect(reconciled.status).toBe("committed");
    expect(reconciled.committedSubmissionId).toBe(submitted.submission.id);
    const secondReconcile = await configuration.reconcileStaging({
      stagingId: prepared.staging.id,
      actorUserId: OWNER,
      correlationId: `recon2-${interruptInspection.id}`,
    });
    expect(secondReconcile.status).toBe("committed");
    const counts = await database.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM inspection_submissions WHERE inspection_id=$1",
      [interruptInspection.id],
    );
    expect(Number(counts.rows[0]?.count)).toBe(1);
  });

  it("uses official BEA-RP identity on committed configured reports", async () => {
    const inspection = await prepareInspection(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    const committed = await configuration.commitStagedInspection({
      inspectionId: inspection.id,
      sourceType: "json",
      raw: JSON.stringify(SYNTHETIC_EXTERIOR_JSON_FIXTURE),
      actorUserId: OWNER,
      correlationId: `official-${inspection.id}`,
    });
    expect(committed.staging.status).toBe("committed");
    const report = await pipeline.repository.getReportByInspection(inspection.id);
    expect(report?.reference.startsWith("BEA-RP-")).toBe(true);
    const versions = report ? await pipeline.repository.listReportVersions(report.id) : [];
    const snapshot = versions[0]?.inputSnapshot as {
      reportReference?: string;
      frozenGeneratedAt?: string;
      reportDocument?: { reportReference?: string; filename?: string; preview?: boolean };
    };
    expect(snapshot.reportReference).toBe(report?.reference);
    expect(snapshot.reportDocument?.reportReference).toBe(report?.reference);
    expect(snapshot.reportDocument?.preview).toBe(false);
    expect(JSON.stringify(snapshot)).not.toMatch(/pending-|preview-|placeholder-/u);
    expect(snapshot.frozenGeneratedAt).toBeTruthy();
    expect(snapshot.reportDocument?.filename ?? "").toContain(report?.reference ?? "BEA-RP-");
  });

  it("blocks non-synthetic production mapping, preview, commit, and activation", async () => {
    await expect(
      configuration.dryRunMapping({
        releaseId: SEEDED_CONFIGURATION_IDS.productionDraft,
        sourceType: "json",
        raw: "{}",
        actorUserId: OWNER,
        correlationId: "prod-map",
      }),
    ).rejects.toBeInstanceOf(ProductionMappingNotConfiguredError);
    await expect(
      configuration.previewReport({
        releaseId: SEEDED_CONFIGURATION_IDS.productionDraft,
        sourceType: "json",
        raw: "{}",
      }),
    ).rejects.toBeInstanceOf(ProductionMappingNotConfiguredError);
    const inspection = await prepareInspection(SEEDED_CONFIGURATION_IDS.exteriorRelease);
    await database.query("UPDATE inspections SET configuration_release_id=$2 WHERE id=$1", [
      inspection.id,
      SEEDED_CONFIGURATION_IDS.productionDraft,
    ]);
    await expect(
      configuration.commitStagedInspection({
        inspectionId: inspection.id,
        sourceType: "json",
        raw: JSON.stringify(SYNTHETIC_EXTERIOR_JSON_FIXTURE),
        actorUserId: OWNER,
        correlationId: "prod-commit",
      }),
    ).rejects.toBeInstanceOf(ProductionMappingNotConfiguredError);
    await expect(
      configuration.activateRelease({
        releaseId: SEEDED_CONFIGURATION_IDS.productionDraft,
        actorUserId: OWNER,
        correlationId: "prod-activate",
      }),
    ).rejects.toBeInstanceOf(ConfigurationActivationError);
  });

  it("rejects unknown validation kinds on save and injected execution", async () => {
    const cloned = await configuration.cloneRelease({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      actorUserId: OWNER,
      correlationId: "unknown-clone",
    });
    await expect(
      configuration.updateDraftArtifact({
        releaseId: cloned.id,
        kind: "validation_rule_set",
        artifactKey: "bad",
        payload: {
          ...SYNTHETIC_EXTERIOR_PACKAGE.validation,
          rules: [
            {
              ruleKey: "unknown",
              label: "Unknown",
              description: "Unknown",
              severity: "blocking",
              blocking: true,
              sectionKey: "site",
              trigger: { kind: "always" },
              expression: { kind: "python_eval" },
              remediation: "Remove it.",
            },
          ],
        },
        expectedVersion: cloned.version,
        actorUserId: OWNER,
        correlationId: "unknown-save",
      }),
    ).rejects.toBeInstanceOf(ConfigurationValidationError);
    await database.query(
      `UPDATE configuration_artifacts
          SET payload = jsonb_set(payload, '{rules,0,expression,kind}', '"python_eval"')
        WHERE release_id=$1 AND artifact_kind='validation_rule_set'`,
      [cloned.id],
    );
    const validated = await configuration.validateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "unknown-validate",
    });
    expect(validated.passed).toBe(false);
    await expect(
      configuration.publishRelease({
        releaseId: cloned.id,
        actorUserId: OWNER,
        correlationId: "unknown-publish",
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("maps the alternate collection family through configuration only", async () => {
    const mapped = await configuration.dryRunMapping({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      sourceType: "json",
      raw: JSON.stringify(SYNTHETIC_ALTERNATE_COLLECTION_FIXTURE),
      actorUserId: OWNER,
      correlationId: "alt-wrong-family",
    });
    expect(mapped.mapping.canonical.findings.length).toBeGreaterThanOrEqual(0);
    const cloned = await configuration.cloneRelease({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      actorUserId: OWNER,
      correlationId: "alt-clone",
    });
    for (const [kind, payload, key] of [
      [
        "inspection_schema",
        SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.schema,
        SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.schema.schemaKey,
      ],
      [
        "mapping_profile",
        SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.mapping,
        SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.mapping.profileKey,
      ],
      [
        "validation_rule_set",
        SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.validation,
        SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.validation.ruleSetKey,
      ],
      [
        "report_template",
        SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.template,
        SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE.template.templateKey,
      ],
    ] as const) {
      const live = await configuration.repository.getRelease(cloned.id);
      await configuration.updateDraftArtifact({
        releaseId: cloned.id,
        kind,
        artifactKey: key,
        payload: payload as unknown as JsonObject,
        expectedVersion: live?.version ?? 0,
        actorUserId: OWNER,
        correlationId: `alt-${kind}`,
      });
    }
    const extras = [
      "review_policy",
      "storage_policy",
      "delivery_policy",
      "sla_policy",
      "workflow_blueprint",
    ] as const;
    const pack = SYNTHETIC_ALTERNATE_COLLECTION_PACKAGE;
    const extraPayloads = {
      review_policy: pack.review,
      storage_policy: pack.storage,
      delivery_policy: pack.delivery,
      sla_policy: pack.sla,
      workflow_blueprint: pack.workflow,
    };
    for (const kind of extras) {
      const live = await configuration.repository.getRelease(cloned.id);
      await configuration.updateDraftArtifact({
        releaseId: cloned.id,
        kind,
        artifactKey: `${kind}-alt`,
        payload: extraPayloads[kind] as unknown as JsonObject,
        expectedVersion: live?.version ?? 0,
        actorUserId: OWNER,
        correlationId: `alt-${kind}`,
      });
    }
    const validated = await configuration.validateRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "alt-validate",
    });
    expect(validated.passed).toBe(true);
    await configuration.publishRelease({
      releaseId: cloned.id,
      actorUserId: OWNER,
      correlationId: "alt-publish",
    });
    const preview = await configuration.previewReport({
      releaseId: cloned.id,
      sourceType: "json",
      raw: JSON.stringify(SYNTHETIC_ALTERNATE_COLLECTION_FIXTURE),
      reportReference: "BEA-RP-000099",
      inspectionReference: "BEA-IN-000099",
      projectReference: "BEA-PR-000099",
    });
    expect(preview.mapping.canonical.findings).toHaveLength(2);
    expect(preview.mapping.canonical.evidence.filter((item) => item.kind === "photo")).toHaveLength(
      2,
    );
    expect(preview.document.filename).toBe(
      "OFFICIAL-BEA-RP-000099-BEA-IN-000099-BEA-PR-000099.pdf",
    );
  });

  it("preserves connector readiness across a no-write dry-run", async () => {
    await database.query(
      "UPDATE connector_readiness SET readiness_status='configuration_required' WHERE provider_type='sharepoint'",
    );
    const manifest = await configuration.connectorDryRun({
      releaseId: SEEDED_CONFIGURATION_IDS.exteriorRelease,
      inspectionReference: "BEA-IN-DRY2",
      reportReference: "BEA-RP-DRY2",
      projectReference: "BEA-PR-DRY2",
      filename: "synthetic.pdf",
      actorUserId: OWNER,
      correlationId: "dry-preserve",
    });
    expect(manifest.liveWrites).toBe(false);
    const sharePoint = await database.query<{ readiness_status: string; last_dry_run_at: string }>(
      "SELECT readiness_status, last_dry_run_at FROM connector_readiness WHERE provider_type='sharepoint'",
    );
    expect(sharePoint.rows[0]?.readiness_status).toBe("configuration_required");
    expect(sharePoint.rows[0]?.last_dry_run_at).toBeTruthy();
  });

  it("separates intake draft entry from Owner policy confirmation", async () => {
    const items = await configuration.repository.listIntakeItems();
    const item = items[0];
    expect(item).toBeTruthy();
    const drafted = await configuration.updateIntakeItem({
      itemId: item.id,
      status: "configured",
      answer: "Synthetic lab answer",
      notes: "draft",
      expectedVersion: item.version,
      actorUserId: INTEGRATION,
      correlationId: "intake-draft",
    });
    expect(drafted.status).toBe("configured");
    const tested = await configuration.updateIntakeItem({
      itemId: drafted.id,
      status: "tested",
      answer: drafted.answer,
      notes: "tested",
      expectedVersion: drafted.version,
      actorUserId: INTEGRATION,
      correlationId: "intake-tested",
    });
    const approved = await configuration.updateIntakeItem({
      itemId: tested.id,
      status: "approved",
      answer: tested.answer,
      notes: "owner approved",
      expectedVersion: tested.version,
      actorUserId: OWNER,
      correlationId: "intake-approved",
    });
    expect(approved.status).toBe("approved");
    const audit = await database.query<{ metadata: unknown }>(
      "SELECT metadata FROM audit_logs WHERE resource_id=$1 ORDER BY created_at",
      [item.id],
    );
    expect(JSON.stringify(audit.rows)).toMatch(/previousStatus/);
  });
});
