import type {
  GuidedDemoMachineState,
  GuidedDemoRecordBindings,
  GuidedMeridianEvidenceView,
  GuidedMeridianFindingView,
  GuidedMeridianReportView,
  GuidedMeridianReviewRecordView,
  InspectionEvidence,
  InspectionFinding,
} from "@bea/domain";
import {
  GuidedDemoIntegrityError,
  MERIDIAN_RECIPIENT_EMAIL,
  parseMeridianReportWorkspaceDocument,
} from "@bea/domain";

import type { SqlOperationsRepository } from "./operations-repository.js";

export interface GuidedMeridianReportLoadResult {
  readonly view: GuidedMeridianReportView | null;
  readonly error: string | null;
  readonly unavailableReason: "not_assembled" | "integrity" | "missing_snapshot" | null;
}

export async function loadGuidedMeridianReportView(input: {
  readonly repository: SqlOperationsRepository;
  readonly bindings: GuidedDemoRecordBindings;
  readonly machineState: GuidedDemoMachineState;
}): Promise<GuidedMeridianReportLoadResult> {
  if (!input.bindings.reportId) {
    return { view: null, error: null, unavailableReason: "not_assembled" };
  }
  try {
    const view = await buildGuidedMeridianReportView(input);
    return { view, error: null, unavailableReason: null };
  } catch (error) {
    const message =
      error instanceof GuidedDemoIntegrityError
        ? error.message
        : "Stored Report content is unavailable for this demonstration run.";
    return {
      view: null,
      error: message,
      unavailableReason:
        error instanceof GuidedDemoIntegrityError && error.message.includes("workspace snapshot")
          ? "missing_snapshot"
          : "integrity",
    };
  }
}

async function buildGuidedMeridianReportView(input: {
  readonly repository: SqlOperationsRepository;
  readonly bindings: GuidedDemoRecordBindings;
  readonly machineState: GuidedDemoMachineState;
}): Promise<GuidedMeridianReportView> {
  const reportId = input.bindings.reportId;
  if (!reportId) {
    throw new GuidedDemoIntegrityError("The guided run is not bound to a Report.");
  }
  const report = await input.repository.getReport(reportId);
  if (!report || report.id !== reportId) {
    throw new GuidedDemoIntegrityError("The bound Report was not found.");
  }
  const versions = await input.repository.listReportVersions(report.id);
  const boundVersion =
    versions.find((item) => item.id === input.bindings.reportVersionId) ??
    versions.find((item) => item.versionNumber === report.currentVersionNumber);
  if (!boundVersion) {
    throw new GuidedDemoIntegrityError("The bound Report version was not found.");
  }
  if (boundVersion.reportId !== report.id) {
    throw new GuidedDemoIntegrityError("The bound Report version does not belong to the Report.");
  }
  if (
    input.bindings.reportVersionId &&
    input.bindings.reportVersionId !== boundVersion.id &&
    input.machineState !== "report_revision_processing"
  ) {
    throw new GuidedDemoIntegrityError(
      "The story Report version does not match the stored current Report version.",
    );
  }
  if (
    boundVersion.versionNumber !== report.currentVersionNumber &&
    input.machineState !== "report_revision_processing"
  ) {
    throw new GuidedDemoIntegrityError(
      "Displayed Report version is not the current stored Report version.",
    );
  }
  const document = parseMeridianReportWorkspaceDocument(boundVersion.inputSnapshot);
  if (!document) {
    throw new GuidedDemoIntegrityError(
      "The stored Report workspace snapshot is missing for this demonstration run.",
    );
  }
  const inspection = await input.repository.getInspection(report.inspectionId);
  if (!inspection) {
    throw new GuidedDemoIntegrityError("The bound Inspection was not found.");
  }
  if (input.bindings.inspectionId && input.bindings.inspectionId !== inspection.id) {
    throw new GuidedDemoIntegrityError("The bound Inspection does not match the Report.");
  }
  if (report.inspectionId !== inspection.id) {
    throw new GuidedDemoIntegrityError("The Report is not bound to the loaded Inspection.");
  }
  const project = await input.repository.getProject(report.projectId);
  if (!project || project.id !== report.projectId) {
    throw new GuidedDemoIntegrityError("The bound Project was not found.");
  }
  const submission =
    (await input.repository.getSubmission(boundVersion.submissionId)) ??
    (await input.repository.getLatestSubmission(inspection.id));
  if (!submission || submission.inspectionId !== inspection.id) {
    throw new GuidedDemoIntegrityError("The bound Inspection submission was not found.");
  }
  const [findings, evidence, deliveries, authorizations, confirmed, commentGroups] =
    await Promise.all([
      input.repository.listFindings(submission.id),
      input.repository.listEvidence(submission.id),
      input.repository.listDeliveries(report.id),
      input.repository.listDeliveryAuthorizations(report.id),
      input.repository.getConfirmedDelivery(report.id),
      Promise.all(versions.map((version) => input.repository.listReviewComments(version.id))),
    ]);
  const comments = commentGroups.flat();
  const photoEvidence = evidence.filter((item) => item.kind === "photo");
  if (findings.length !== document.findings.length) {
    throw new GuidedDemoIntegrityError(
      "Persisted findings do not match the stored Report workspace snapshot.",
    );
  }
  if (photoEvidence.length !== document.evidence.length) {
    throw new GuidedDemoIntegrityError(
      "Persisted photograph evidence does not match the stored Report workspace snapshot.",
    );
  }
  const findingViews = document.findings.map((seed) =>
    mapFindingView(seed, findings, photoEvidence),
  );
  const evidenceViews = document.evidence.map((seed, index) =>
    mapEvidenceView(seed, photoEvidence[index]!, findingViews),
  );
  const reviewHistory = buildReviewHistory(versions, boundVersion.id, comments);
  const currentReview = versions.find((item) => item.id === boundVersion.id);
  const technicallyApproved =
    currentReview?.reviewDecision === "approve" &&
    (report.status === "approved" ||
      report.status === "rendering_final" ||
      report.status === "ready_for_delivery" ||
      report.status === "delivering" ||
      report.status === "delivered");
  const activeAuthorization = authorizations.find(
    (item) => item.status === "active" && item.reportVersionId === boundVersion.id,
  );
  const deliveredForVersion =
    deliveries.find(
      (item) => item.status === "delivered" && item.reportVersionId === boundVersion.id,
    ) ?? null;
  const confirmedForVersion =
    (confirmed && confirmed.reportVersionId === boundVersion.id ? confirmed : null) ??
    deliveredForVersion;
  const approvalStatus = technicallyApproved
    ? `Version ${boundVersion.versionNumber} is technically approved. Owner delivery authorization remains separate.`
    : currentReview?.reviewDecision === "request_revision"
      ? `Version ${boundVersion.versionNumber} was returned for revision.`
      : `Version ${boundVersion.versionNumber} is awaiting technical review.`;
  const deliveryStatus = confirmedForVersion
    ? "Local-test delivery confirmed. No real email was sent."
    : activeAuthorization
      ? "Demonstration delivery is authorized and processing. No real email is sent."
      : report.status === "ready_for_delivery"
        ? "No delivery has occurred. Owner delivery authorization is required."
        : "Delivery is not authorized for this Report version.";
  return {
    reportId: report.id,
    reportReference: report.reference,
    reportStatus: report.status,
    versionId: boundVersion.id,
    versionNumber: boundVersion.versionNumber,
    versionStatus: boundVersion.status,
    inspectionId: inspection.id,
    inspectionReference: inspection.reference,
    inspectionCompletedAt: inspection.completedAt,
    projectId: project.id,
    projectReference: project.reference,
    projectName: project.name,
    clientName: document.client,
    contactName: document.contactName,
    contactTitle: document.contactTitle,
    title: document.title,
    versionMarker: document.versionMarker,
    syntheticNotice: document.syntheticNotice,
    executiveSummary: document.executiveSummary,
    propertyDetails: document.propertyDetails,
    scope: document.scope,
    documentsReviewed: [...document.documentsReviewed],
    observedConditions: document.observedConditions,
    findings: findingViews,
    evidence: evidenceViews,
    recommendations: document.recommendations,
    repairPriorities: document.repairPriorities.map((item) => ({ ...item })),
    limitations: document.limitations,
    reviewUpdate: document.reviewUpdate,
    reviewHistory,
    approvalStatus,
    technicallyApproved,
    deliveryAuthorizationStatus: activeAuthorization?.status ?? null,
    deliveryStatus,
    deliveryConfirmed: Boolean(confirmedForVersion),
    recipient:
      confirmedForVersion?.recipients[0] ??
      activeAuthorization?.recipients[0] ??
      MERIDIAN_RECIPIENT_EMAIL,
    artifactChecksum: boundVersion.renderedChecksum,
    artifactFilename: boundVersion.renderedStorageRef
      ? `${report.reference}-v${boundVersion.versionNumber}.pdf`
      : null,
    artifactStorageRef: boundVersion.renderedStorageRef,
    findingCount: findingViews.length,
    highPriorityCount: findingViews.filter((item) => item.priority === "High").length,
    mediumPriorityCount: findingViews.filter((item) => item.priority === "Medium").length,
    evidenceCount: evidenceViews.length,
    sources: [
      {
        key: "report",
        label: "Report",
        sectionId: "cover",
        href: `/reports/${encodeURIComponent(report.id)}`,
        recordId: report.id,
      },
      {
        key: "inspection",
        label: "Inspection",
        sectionId: "property",
        href: `/inspections/${encodeURIComponent(inspection.id)}`,
        recordId: inspection.id,
      },
      {
        key: "findings",
        label: "Findings",
        sectionId: "findings",
        recordId: boundVersion.id,
      },
      {
        key: "review",
        label: "Review History",
        sectionId: "review-history",
        recordId: boundVersion.id,
      },
      {
        key: "delivery",
        label: "Delivery Status",
        sectionId: "delivery-status",
        recordId: report.id,
      },
      { key: "flow", label: "Automation Flow", href: "/automation-flow" },
    ],
  };
}

function mapFindingView(
  seed: {
    code: string;
    title: string;
    priority: "High" | "Medium";
    observation: string;
    recommendation: string;
  },
  findings: readonly InspectionFinding[],
  evidence: readonly InspectionEvidence[],
): GuidedMeridianFindingView {
  const persisted = findings.find((item) => item.code === seed.code);
  if (!persisted) {
    throw new GuidedDemoIntegrityError(`Persisted finding ${seed.code} was not found.`);
  }
  return {
    id: persisted.id,
    code: seed.code,
    title: persisted.title || seed.title,
    priority: seed.priority,
    observation: persisted.description || seed.observation,
    recommendation: seed.recommendation,
    evidenceIds: evidence.filter((item) => item.findingId === persisted.id).map((item) => item.id),
  };
}

function mapEvidenceView(
  seed: { label: string; caption: string; filename: string; findingCode: string },
  persisted: InspectionEvidence,
  findings: readonly GuidedMeridianFindingView[],
): GuidedMeridianEvidenceView {
  const finding = findings.find((item) => item.code === seed.findingCode);
  return {
    id: persisted.id,
    label: seed.label,
    caption: seed.caption,
    filename: persisted.filename || seed.filename,
    findingCode: finding?.code ?? seed.findingCode,
    storageRef: persisted.storageRef,
    kind: "photo",
  };
}

function buildReviewHistory(
  versions: readonly {
    readonly id: string;
    readonly versionNumber: number;
    readonly reviewDecision: string | null;
    readonly reviewComment: string | null;
    readonly reviewedAt: string | null;
    readonly reviewerUserId: string | null;
  }[],
  currentVersionId: string,
  comments: readonly {
    readonly reportVersionId: string;
    readonly body: string;
    readonly createdAt: string;
    readonly authorUserId: string;
  }[],
): GuidedMeridianReviewRecordView[] {
  const fromVersions = versions.map((version) => ({
    versionId: version.id,
    versionNumber: version.versionNumber,
    decision: version.reviewDecision,
    comment: version.reviewComment,
    reviewedAt: version.reviewedAt,
    reviewerUserId: version.reviewerUserId,
    historical: version.id !== currentVersionId,
  }));
  const extra = comments
    .filter((comment) => !fromVersions.some((item) => item.comment === comment.body))
    .map((comment) => {
      const version = versions.find((item) => item.id === comment.reportVersionId);
      return {
        versionId: comment.reportVersionId,
        versionNumber: version?.versionNumber ?? 0,
        decision: "request_revision",
        comment: comment.body,
        reviewedAt: comment.createdAt,
        reviewerUserId: comment.authorUserId,
        historical: comment.reportVersionId !== currentVersionId,
      };
    });
  return [...fromVersions, ...extra].sort(
    (left, right) => left.versionNumber - right.versionNumber,
  );
}
