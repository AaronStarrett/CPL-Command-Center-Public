import { describe, expect, it } from "vitest";

import {
  FailClosedLiveDeliveryAdapter,
  LocalTestDeliveryAdapter,
  defaultSyntheticRenderer,
} from "../../packages/automation/src/index.js";
import {
  DEFAULT_SYNTHETIC_REQUIREMENTS,
  DEMO_ROLE_IDS,
  SYNTHETIC_REPORT_DISCLOSURE,
  assertInspectionStatusTransition,
  assertProjectStatusTransition,
  assertReportStatusTransition,
  canonicalRecipientList,
  elapsedMs,
  evaluateInspectionCompleteness,
  normalizeInspectionPayload,
  OperationsStatusTransitionError,
  pausedDurationMs,
  sameCanonicalRecipients,
} from "../../packages/domain/src/index.js";
import { PERMISSIONS, authorize } from "../../packages/security/src/index.js";
import { completeSyntheticSubmissionPayload } from "../../packages/database/src/operations-seed.js";
import {
  claimRunnableJobStatement,
  FAIL_CLAIMED_JOB_SQL,
  SUCCEED_CLAIMED_JOB_SQL,
} from "../../packages/database/src/job-claim.js";
import { isUniqueConstraintViolation } from "../../packages/database/src/unique-constraint.js";
import { computeMetrics } from "../../packages/database/src/operations-repository.js";

describe("Phase 3.0 inspection-to-report domain", () => {
  it("rejects invalid project, inspection, and report transitions", () => {
    expect(() => assertProjectStatusTransition("closed", "awarded")).toThrow(
      OperationsStatusTransitionError,
    );
    expect(() => assertInspectionStatusTransition("complete", "submitted")).toThrow(
      OperationsStatusTransitionError,
    );
    expect(() => assertReportStatusTransition("delivered", "delivering")).toThrow(
      OperationsStatusTransitionError,
    );
    expect(() => assertInspectionStatusTransition("completed", "submitted")).not.toThrow();
    expect(() => assertReportStatusTransition("in_review", "approved")).not.toThrow();
  });

  it("treats missing narrative summary as optional, not blocking", () => {
    const payload = normalizeInspectionPayload(completeSyntheticSubmissionPayload());
    const complete = evaluateInspectionCompleteness(
      { ...payload, summary: null },
      DEFAULT_SYNTHETIC_REQUIREMENTS,
    );
    expect(complete.passed).toBe(true);
    expect(complete.optional.some((item) => item.code === "summary")).toBe(true);
    const incomplete = evaluateInspectionCompleteness({
      clientName: null,
      siteName: null,
      inspectorName: null,
      completedAt: null,
      serviceKey: null,
      attestation: false,
      summary: null,
      findings: [],
      evidence: [],
    });
    expect(incomplete.passed).toBe(false);
    expect(incomplete.blocking.length).toBeGreaterThan(0);
    expect(incomplete.blocking.every((item) => item.severity === "blocking")).toBe(true);
  });

  it("keeps operations RBAC deny-by-default", () => {
    const sales = { roleIds: [DEMO_ROLE_IDS.SALES] };
    const operations = { roleIds: [DEMO_ROLE_IDS.OPERATIONS] };
    const executive = { roleIds: [DEMO_ROLE_IDS.EXECUTIVE_READONLY] };
    const integration = { roleIds: [DEMO_ROLE_IDS.INTEGRATION_ADMIN] };
    expect(authorize(sales, PERMISSIONS.OPERATIONS_BOARD_VIEW)).toEqual({ allowed: true });
    expect(authorize(sales, PERMISSIONS.REPORTS_APPROVE)).toMatchObject({ allowed: false });
    expect(authorize(sales, PERMISSIONS.REPORTS_DELIVER)).toMatchObject({ allowed: false });
    expect(authorize(operations, PERMISSIONS.INSPECTIONS_SUBMIT)).toEqual({ allowed: true });
    expect(authorize(operations, PERMISSIONS.REPORTS_APPROVE)).toEqual({ allowed: true });
    expect(authorize(operations, PERMISSIONS.REPORTS_DELIVER)).toMatchObject({ allowed: false });
    expect(authorize(executive, PERMISSIONS.EXCEPTIONS_VIEW)).toEqual({ allowed: true });
    expect(authorize(executive, PERMISSIONS.REPORTS_APPROVE)).toMatchObject({ allowed: false });
    expect(authorize(integration, PERMISSIONS.OPERATIONS_BOARD_VIEW)).toMatchObject({
      allowed: false,
    });
    expect(
      authorize({ roleIds: [DEMO_ROLE_IDS.OWNER_ADMIN] }, PERMISSIONS.REPORTS_DELIVER),
    ).toEqual({ allowed: true });
  });

  it("renders a labeled synthetic PDF without an AI provider", async () => {
    const rendered = await defaultSyntheticRenderer.render({
      reportReference: "BEA-RP-000001",
      inspectionReference: "BEA-IN-000001",
      projectReference: "BEA-PR-000001",
      templateKey: "bea-synthetic-inspection-report",
      templateVersion: 1,
      disclosure: SYNTHETIC_REPORT_DISCLOSURE,
      snapshot: { payload: completeSyntheticSubmissionPayload() },
      generatedAt: "2026-08-31T16:00:00.000Z",
    });
    expect(rendered.mimeType).toBe("application/pdf");
    expect(new TextDecoder().decode(rendered.bytes)).toContain("SYNTHETIC FIXTURE");
    expect(rendered.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps local delivery idempotent and live delivery fail-closed", async () => {
    const local = new LocalTestDeliveryAdapter(() => new Date("2026-08-31T16:00:00.000Z"));
    const request = {
      idempotencyKey: "report.deliver:r1:v1:v1",
      reportId: "r1",
      reportVersionId: "v1",
      reportReference: "BEA-RP-000001",
      artifactChecksum: "aa".repeat(32),
      artifact: new Uint8Array([1, 2, 3]),
      mimeType: "application/pdf",
      filename: "bea-rp-000001.pdf",
      recipients: ["client@example.invalid"],
      subject: "BEA inspection report BEA-RP-000001",
      correlationId: "corr-1",
    };
    const first = await local.deliver(request);
    const second = await local.deliver(request);
    expect(first.externalMessageId).toBe(second.externalMessageId);
    expect(local.sentCount).toBe(1);
    await expect(new FailClosedLiveDeliveryAdapter().deliver()).rejects.toMatchObject({
      code: "LIVE_DELIVERY_NOT_CONFIGURED",
      retryable: false,
    });
  });

  it("keeps PostgreSQL and PGlite claim SQL from reclaiming a non-stale claimed job", () => {
    for (const kind of ["postgres", "pglite"] as const) {
      const sql = claimRunnableJobStatement(kind);
      expect(sql).toMatch(/status='pending'/u);
      expect(sql).toMatch(/lease_expires_at<=/u);
      expect(sql).not.toMatch(/status IN \('pending',\s*'claimed'\)/u);
    }
    expect(claimRunnableJobStatement("postgres")).toMatch(/FOR UPDATE SKIP LOCKED/u);
    expect(claimRunnableJobStatement("pglite")).not.toMatch(/FOR UPDATE SKIP LOCKED/u);
  });

  it("binds job succeed and fail settlement to the current claim owner", () => {
    expect(SUCCEED_CLAIMED_JOB_SQL).toMatch(/status='claimed' AND claimed_by=\$2/u);
    expect(FAIL_CLAIMED_JOB_SQL).toMatch(/status='claimed' AND claimed_by=\$2/u);
    expect(SUCCEED_CLAIMED_JOB_SQL).not.toMatch(/WHERE id=\$1 AND status='claimed'\s*$/u);
  });

  it("compares delivery destinations by canonical recipient set", () => {
    expect(
      canonicalRecipientList([" B@Example.INVALID ", "a@example.invalid", "a@example.invalid"]),
    ).toEqual(["a@example.invalid", "b@example.invalid"]);
    expect(
      sameCanonicalRecipients(["B@x.invalid", "a@x.invalid"], ["a@x.invalid", "b@x.invalid"]),
    ).toBe(true);
    expect(sameCanonicalRecipients(["a@x.invalid"], ["a@x.invalid", "b@x.invalid"])).toBe(false);
  });

  it("recognizes unique-constraint duplicates without swallowing unrelated errors", () => {
    expect(isUniqueConstraintViolation({ code: "23505" })).toBe(true);
    expect(
      isUniqueConstraintViolation(new Error("duplicate key value violates unique constraint")),
    ).toBe(true);
    expect(isUniqueConstraintViolation(new Error("connection refused"))).toBe(false);
  });

  it("uses confirmed delivery minus inspection completion for north-star turnaround", () => {
    const completed = "2026-08-31T16:00:00.000Z";
    const delivered = "2026-08-31T16:00:08.000Z";
    const metrics = computeMetrics(
      {
        id: "i1",
        reference: "BEA-IN-000001",
        projectId: "p1",
        status: "complete",
        inspectorUserId: null,
        reviewerUserId: null,
        scheduledAt: null,
        startedAt: null,
        completedAt: completed,
        submittedAt: delivered,
        serviceKey: "building-envelope-inspection",
        reportTemplateId: "t1",
        createdByUserId: "u1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: delivered,
        version: 1,
      },
      {
        id: "r1",
        reference: "BEA-RP-000001",
        inspectionId: "i1",
        projectId: "p1",
        templateId: "t1",
        currentTemplateVersionId: "tv1",
        status: "delivered",
        currentVersionNumber: 1,
        createdByUserId: null,
        createdAt: delivered,
        updatedAt: delivered,
        version: 1,
      },
      {
        id: "s1",
        reportId: "r1",
        inspectionId: "i1",
        clockKind: "calendar",
        targetMinutes: 1440,
        startedAt: completed,
        pausedAt: null,
        pauseReason: null,
        pausedTotalMs: 5_000,
        stoppedAt: "2026-08-31T16:00:09.000Z",
        status: "stopped",
        createdAt: completed,
        updatedAt: delivered,
        version: 1,
      },
      "2026-08-31T16:00:10.000Z",
      {
        confirmedDeliveryAt: delivered,
        stageDurations: { validation_passed_to_report_draft_created: 1000 },
      },
    );
    expect(metrics.totalTurnaroundMs).toBe(elapsedMs(completed, delivered));
    expect(metrics.totalTurnaroundMs).toBeLessThan(60_000);
    expect(metrics.confirmedDeliveryAt).toBe(delivered);
    expect(metrics.pausedDurationMs).toBe(5_000);
    expect(metrics.stageDurations.validation_passed_to_report_draft_created).toBe(1000);
    expect(
      pausedDurationMs({
        pausedAt: "2026-08-31T16:00:00.000Z",
        pausedTotalMs: 1_000,
        now: "2026-08-31T16:00:03.000Z",
        status: "paused",
      }),
    ).toBe(4_000);
  });
});
