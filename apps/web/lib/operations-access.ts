import type {
  InspectionEvidence,
  InspectionFinding,
  InspectionSubmission,
  JsonObject,
  ReportVersion,
} from "@bea/domain";
import { PERMISSIONS, authorize, type AuthorizationSubject, type Permission } from "@bea/security";

export function canViewInspectionSensitive(subject: AuthorizationSubject): boolean {
  return (
    authorize(subject, PERMISSIONS.INSPECTIONS_SUBMIT).allowed ||
    authorize(subject, PERMISSIONS.INSPECTIONS_CORRECT).allowed ||
    authorize(subject, PERMISSIONS.REPORTS_REVIEW).allowed ||
    authorize(subject, PERMISSIONS.REPORTS_APPROVE).allowed ||
    authorize(subject, PERMISSIONS.AUDIT_VIEW).allowed
  );
}

export function projectInspectionSubmission(input: {
  readonly canViewSensitive: boolean;
  readonly submission: InspectionSubmission | null;
  readonly findings: readonly InspectionFinding[];
  readonly evidence: readonly InspectionEvidence[];
}): {
  readonly submission: InspectionSubmission | null | { id: string; createdAt: string };
  readonly findings: readonly InspectionFinding[] | readonly { code: string; title: string }[];
  readonly evidence: readonly InspectionEvidence[] | readonly { kind: string; filename: string }[];
} {
  if (input.canViewSensitive) {
    return {
      submission: input.submission,
      findings: input.findings,
      evidence: input.evidence,
    };
  }
  return {
    submission: input.submission
      ? { id: input.submission.id, createdAt: input.submission.createdAt }
      : null,
    findings: input.findings.map((finding) => ({ code: finding.code, title: finding.title })),
    evidence: input.evidence.map((item) => ({ kind: item.kind, filename: item.filename })),
  };
}

export function permissionForReportAction(action: string): {
  readonly permission: Permission;
  readonly auditAction: string;
} | null {
  switch (action) {
    case "technical-approve":
      return { permission: PERMISSIONS.REPORTS_APPROVE, auditAction: "report.review" };
    case "request-revision":
    case "return-to-inspector":
      return { permission: PERMISSIONS.REPORTS_REVIEW, auditAction: "report.review" };
    case "authorize-delivery":
      return { permission: PERMISSIONS.REPORTS_DELIVER, auditAction: "report.authorize-delivery" };
    case "retry-delivery":
      return { permission: PERMISSIONS.REPORTS_DELIVER, auditAction: "report.retry-delivery" };
    case "revoke-delivery-authorization":
      return {
        permission: PERMISSIONS.REPORTS_DELIVER,
        auditAction: "report.revoke-delivery-authorization",
      };
    default:
      return null;
  }
}

export function permissionForInspectionSubmit(needsCorrection: boolean): Permission {
  return needsCorrection ? PERMISSIONS.INSPECTIONS_CORRECT : PERMISSIONS.INSPECTIONS_SUBMIT;
}

export function projectReportVersions(input: {
  readonly canViewSensitive: boolean;
  readonly versions: readonly ReportVersion[];
}): readonly ReportVersion[] {
  if (input.canViewSensitive) return input.versions;
  return input.versions.map((version) => ({
    ...version,
    inputSnapshot: projectedInputSnapshot(version.inputSnapshot),
  }));
}

function projectedInputSnapshot(snapshot: JsonObject): JsonObject {
  return {
    inspectionId: snapshot.inspectionId ?? null,
    inspectionReference: snapshot.inspectionReference ?? null,
    projectReference: snapshot.projectReference ?? null,
    submissionId: snapshot.submissionId ?? null,
    payloadSha256: snapshot.payloadSha256 ?? null,
    templateKey: snapshot.templateKey ?? null,
    templateVersion: snapshot.templateVersion ?? null,
    rawPreserved: snapshot.rawPreserved ?? null,
  };
}
