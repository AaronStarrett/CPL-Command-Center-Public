import { describe, expect, it } from "vitest";

import {
  DEMO_PERSONAS,
  DEMO_ROLE_IDS,
  EMAIL_DRY_RUN_DISCLOSURE,
  ESCALATION_CATCH_UP_MODE,
  SYNTHETIC_WORK_ROUTING_BLUEPRINTS,
  TEAMS_DRY_RUN_DISCLOSURE,
  WORK_CONTROL_CODE_DEFINED_POLICY,
  WORK_CONTROL_PRODUCTION_UNCONFIGURED,
  WORK_FAILURE_SOURCE_TYPES,
  cycleIdentityIsExact,
  assertWorkItemTransition,
  buildWorkItemCycleIdentity,
  buildWorkProjectionIdempotencyKey,
  configurationReleaseIdentityMaterial,
  createCycleIdentityIncompleteError,
  cycleIdentityIncompleteMessage,
  decideReconciliation,
  decideWorkAssignment,
  eventIdentityContractFor,
  escalationDueAt,
  nextEscalationLevel,
  notificationShouldBeSuppressed,
  projectionRetryDelayMs,
  reminderDueAt,
  resolveWorkCycleIdentity,
  schedulerCatchUpDue,
  selectReminderAnchor,
  skippedEscalationLevels,
  userMayClaimWorkItem,
  workItemIsAtRisk,
  workItemIsOverdue,
  WorkItemTransitionError,
  type WorkEventIdentity,
} from "../../packages/domain/src/index.js";
import { extractPayloadContext } from "../../packages/database/src/work-control-projection.js";
import { PERMISSIONS, authorize } from "../../packages/security/src/index.js";

const OWNER = DEMO_PERSONAS[0].id;
const OPERATIONS = DEMO_PERSONAS[2].id;

describe("Phase 3.2A work-control domain", () => {
  it("rejects invalid work-item transitions", () => {
    expect(() => assertWorkItemTransition("completed", "open")).toThrow(WorkItemTransitionError);
    expect(() => assertWorkItemTransition("cancelled", "in_progress")).toThrow(
      WorkItemTransitionError,
    );
    expect(() => assertWorkItemTransition("open", "acknowledged")).not.toThrow();
    expect(() => assertWorkItemTransition("blocked", "in_progress")).not.toThrow();
  });

  it("matches synthetic blueprints to trigger events", () => {
    const readiness = SYNTHETIC_WORK_ROUTING_BLUEPRINTS.filter((item) =>
      item.triggerEventTypes.includes("inspection.scheduled"),
    );
    expect(readiness).toHaveLength(1);
    expect(readiness[0]?.workItemKind).toBe("inspection_readiness");
    expect(readiness[0]?.completionEventTypes).toContain("inspection.ready");
    const delivery = SYNTHETIC_WORK_ROUTING_BLUEPRINTS.find(
      (item) => item.workItemKind === "report_delivery_authorization",
    );
    expect(delivery?.assignedRoleKey).toBe(DEMO_ROLE_IDS.OWNER_ADMIN);
    expect(delivery?.triggerStatus).toBe("active_internal");
  });

  it("builds idempotency keys from event, blueprint, cycle, and action", () => {
    const left = buildWorkProjectionIdempotencyKey({
      sourceEventId: "e1",
      blueprintKey: "work.inspection-readiness",
      blueprintVersion: 1,
      cycleIdentity: "inspection:a:readiness:1",
      actionType: "create",
    });
    const right = buildWorkProjectionIdempotencyKey({
      sourceEventId: "e1",
      blueprintKey: "work.inspection-readiness",
      blueprintVersion: 1,
      cycleIdentity: "inspection:a:readiness:1",
      actionType: "create",
    });
    const other = buildWorkProjectionIdempotencyKey({
      sourceEventId: "e1",
      blueprintKey: "work.inspection-readiness",
      blueprintVersion: 1,
      cycleIdentity: "inspection:a:readiness:2",
      actionType: "create",
    });
    expect(left).toBe(right);
    expect(left).not.toBe(other);
  });

  it("keeps revision cycles distinct", () => {
    const cycle1 = buildWorkItemCycleIdentity({
      kind: "report_revision",
      reportId: "r1",
      reportVersionId: "v1",
    });
    const cycle2 = buildWorkItemCycleIdentity({
      kind: "report_revision",
      reportId: "r1",
      reportVersionId: "v2",
    });
    expect(cycle1).not.toBe(cycle2);
  });

  it("assigns explicit domain users then role queues", () => {
    const blueprint = SYNTHETIC_WORK_ROUTING_BLUEPRINTS[0];
    expect(
      decideWorkAssignment({ blueprint, domainAssigneeUserId: OPERATIONS }).assignedUserId,
    ).toBe(OPERATIONS);
    const ownerDelivery = SYNTHETIC_WORK_ROUTING_BLUEPRINTS.find(
      (item) => item.workItemKind === "report_delivery_authorization",
    )!;
    expect(decideWorkAssignment({ blueprint: ownerDelivery }).assignedUserId).toBeNull();
    expect(decideWorkAssignment({ blueprint: ownerDelivery }).assignedRoleKey).toBe(
      DEMO_ROLE_IDS.OWNER_ADMIN,
    );
  });

  it("refuses Operations claiming Owner-only delivery work", () => {
    const allowed = userMayClaimWorkItem({
      actorUserId: OPERATIONS,
      actorRoleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      assignedUserId: null,
      assignedRoleKey: DEMO_ROLE_IDS.OWNER_ADMIN,
      claimedUserId: null,
      workItemKind: "report_delivery_authorization",
      hasOwnerPrivilege: false,
    });
    expect(allowed.allowed).toBe(false);
    expect(allowed.reason).toBe("owner_only_delivery_authorization");
    expect(
      userMayClaimWorkItem({
        actorUserId: OWNER,
        actorRoleKeys: [DEMO_ROLE_IDS.OWNER_ADMIN],
        assignedUserId: null,
        assignedRoleKey: DEMO_ROLE_IDS.OWNER_ADMIN,
        claimedUserId: null,
        workItemKind: "report_delivery_authorization",
        hasOwnerPrivilege: true,
      }).allowed,
    ).toBe(true);
  });

  it("derives overdue and at-risk from timestamps", () => {
    const availableAt = "2026-09-01T10:00:00.000Z";
    const dueAt = "2026-09-01T12:00:00.000Z";
    expect(workItemIsOverdue(dueAt, new Date("2026-09-01T12:00:01.000Z"))).toBe(true);
    expect(workItemIsAtRisk(dueAt, availableAt, new Date("2026-09-01T11:50:00.000Z"))).toBe(true);
    expect(workItemIsAtRisk(dueAt, availableAt, new Date("2026-09-01T10:10:00.000Z"))).toBe(false);
  });

  it("calculates reminder and escalation thresholds once per level", () => {
    expect(reminderDueAt("2026-09-01T12:00:00.000Z", -3_600_000)).toBe("2026-09-01T11:00:00.000Z");
    expect(
      selectReminderAnchor({
        relativeTo: "due_at",
        availableAt: "2026-09-01T10:00:00.000Z",
        dueAt: "2026-09-01T12:00:00.000Z",
      }),
    ).toBe("2026-09-01T12:00:00.000Z");
    expect(
      escalationDueAt({
        availableAt: "2026-09-01T10:00:00.000Z",
        dueAt: "2026-09-01T12:00:00.000Z",
        ratioOfDueWindow: 1,
      }),
    ).toBe("2026-09-01T12:00:00.000Z");
    expect(
      nextEscalationLevel(
        "none",
        "2026-09-01T10:00:00.000Z",
        "2026-09-01T12:00:00.000Z",
        new Date("2026-09-01T11:00:00.000Z"),
      ),
    ).toBe("watch");
    expect(
      nextEscalationLevel(
        "watch",
        "2026-09-01T10:00:00.000Z",
        "2026-09-01T12:00:00.000Z",
        new Date("2026-09-01T11:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("suppresses duplicate and terminal notifications", () => {
    expect(
      notificationShouldBeSuppressed({
        workItemStatus: "open",
        alreadyExists: true,
        slaPaused: false,
        pauseReason: null,
      }).reason,
    ).toBe("duplicate_threshold");
    expect(
      notificationShouldBeSuppressed({
        workItemStatus: "completed",
        alreadyExists: false,
        slaPaused: false,
        pauseReason: null,
      }).reason,
    ).toBe("work_item_terminal");
    expect(
      notificationShouldBeSuppressed({
        workItemStatus: "open",
        alreadyExists: false,
        slaPaused: true,
        pauseReason: "customer_caused",
      }).reason,
    ).toBe("sla_paused_customer_caused");
    expect(EMAIL_DRY_RUN_DISCLOSURE).toContain("NO MESSAGE SENT");
    expect(TEAMS_DRY_RUN_DISCLOSURE).toContain("NO MESSAGE POSTED");
  });

  it("catches up due schedules without repeating succeeded runs", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    expect(
      schedulerCatchUpDue({
        scheduledFor: "2026-09-01T11:00:00.000Z",
        now,
        status: "pending",
      }),
    ).toBe(true);
    expect(
      schedulerCatchUpDue({
        scheduledFor: "2026-09-01T11:00:00.000Z",
        now,
        status: "succeeded",
      }),
    ).toBe(false);
    expect(
      schedulerCatchUpDue({
        scheduledFor: "2026-09-01T11:00:00.000Z",
        now,
        status: "paused",
      }),
    ).toBe(false);
  });

  it("reconciles missing, stale, and cancelled projections", () => {
    expect(
      decideReconciliation({
        kind: "report_delivery_authorization",
        required: true,
        domainComplete: false,
        domainCancelled: false,
        openWorkItem: false,
        cycleIdentity: "c1",
      }).action,
    ).toBe("create_missing");
    expect(
      decideReconciliation({
        kind: "report_delivery_authorization",
        required: false,
        domainComplete: true,
        domainCancelled: false,
        openWorkItem: true,
        cycleIdentity: "c1",
      }).action,
    ).toBe("complete_stale");
    expect(
      decideReconciliation({
        kind: "inspection_readiness",
        required: false,
        domainComplete: false,
        domainCancelled: true,
        openWorkItem: true,
        cycleIdentity: "c1",
      }).action,
    ).toBe("cancel_superseded");
    expect(
      decideReconciliation({
        kind: "inspection_readiness",
        required: true,
        domainComplete: false,
        domainCancelled: false,
        openWorkItem: true,
        cycleIdentity: "c1",
      }).action,
    ).toBe("noop");
  });

  it("binds release identity to artifact kind, key, payload checksum, id, and version", () => {
    const left = configurationReleaseIdentityMaterial({
      releaseId: "rel-1",
      versionNumber: 2,
      artifacts: [
        { artifactKind: "report_template", artifactKey: "bea.ext", payloadChecksum: "aaa" },
        { artifactKind: "mapping_profile", artifactKey: "bea.ext", payloadChecksum: "bbb" },
      ],
    });
    const substituted = configurationReleaseIdentityMaterial({
      releaseId: "rel-1",
      versionNumber: 2,
      artifacts: [
        { artifactKind: "inspection_schema", artifactKey: "bea.ext", payloadChecksum: "aaa" },
        { artifactKind: "mapping_profile", artifactKey: "bea.ext", payloadChecksum: "bbb" },
      ],
    });
    expect(left).toContain("release:rel-1");
    expect(left).toContain("version:2");
    expect(left).toContain("report_template|bea.ext|aaa");
    expect(left).not.toBe(substituted);
  });

  it("keeps production orchestration unconfigured and work permissions bounded", () => {
    expect(WORK_CONTROL_PRODUCTION_UNCONFIGURED).toContain("UNCONFIGURED");
    expect(authorize({ roleIds: [DEMO_ROLE_IDS.SALES] }, PERMISSIONS.WORK_VIEW)).toMatchObject({
      allowed: false,
    });
    expect(authorize({ roleIds: [DEMO_ROLE_IDS.OPERATIONS] }, PERMISSIONS.WORK_CLAIM)).toEqual({
      allowed: true,
    });
    expect(
      authorize({ roleIds: [DEMO_ROLE_IDS.OPERATIONS] }, PERMISSIONS.REPORTS_DELIVER),
    ).toMatchObject({ allowed: false });
    expect(
      authorize({ roleIds: [DEMO_ROLE_IDS.EXECUTIVE_READONLY] }, PERMISSIONS.WORK_CLAIM),
    ).toMatchObject({ allowed: false });
    expect(
      authorize(
        { roleIds: [DEMO_ROLE_IDS.INTEGRATION_ADMIN] },
        PERMISSIONS.ORCHESTRATION_POLICY_ACTIVATE,
      ),
    ).toMatchObject({ allowed: false });
  });

  it("builds exact cycle identities without latest-record fallbacks", () => {
    expect(buildWorkItemCycleIdentity({ kind: "inspection_readiness", inspectionId: "a" })).toBe(
      "inspection:a:readiness",
    );
    expect(
      buildWorkItemCycleIdentity({
        kind: "inspection_correction",
        inspectionId: "insp",
        exceptionId: "ex-a",
      }),
    ).toBe("inspection:insp:correction:ex-a");
    expect(
      buildWorkItemCycleIdentity({
        kind: "inspection_correction",
        inspectionId: "insp",
        exceptionId: "ex-b",
      }),
    ).toBe("inspection:insp:correction:ex-b");
    expect(
      buildWorkItemCycleIdentity({
        kind: "report_technical_review",
        reportId: "r1",
        reportVersionId: "v1",
      }),
    ).not.toBe(
      buildWorkItemCycleIdentity({
        kind: "report_technical_review",
        reportId: "r1",
        reportVersionId: "v2",
      }),
    );
    expect(
      buildWorkItemCycleIdentity({
        kind: "report_delivery_authorization",
        reportId: "r1",
        reportVersionId: "v1",
      }),
    ).toBe("report:r1:delivery-auth:v1");
    expect(
      buildWorkItemCycleIdentity({
        kind: "automation_failure",
        jobId: "job-1",
      }),
    ).toBe("job:job-1:dead-letter");
    expect(
      buildWorkItemCycleIdentity({
        kind: "automation_failure",
        projectionEventId: "evt-1",
      }),
    ).toBe("projection:evt-1:dead-letter");
    expect(
      buildWorkItemCycleIdentity({
        kind: "report_technical_review",
        reportId: "r1",
        reportVersionId: "v-same",
      }),
    ).toBe("report:r1:review:v-same");
    expect(WORK_CONTROL_CODE_DEFINED_POLICY).toContain("CODE-DEFINED SYNTHETIC POLICY");
    expect(cycleIdentityIsExact("report:r1:review:v1")).toBe(true);
    expect(cycleIdentityIsExact("report:r1:review:unknown")).toBe(false);
  });

  it("treats complementary draft and review events as one exact review cycle", () => {
    const draft = buildWorkItemCycleIdentity({
      kind: "report_technical_review",
      reportId: "r1",
      reportVersionId: "v1",
    });
    const review = buildWorkItemCycleIdentity({
      kind: "report_technical_review",
      reportId: "r1",
      reportVersionId: "v1",
    });
    expect(draft).toBe(review);
  });

  it("does not infer a latest open exception for events without exceptionId", () => {
    const context = extractPayloadContext(
      {
        aggregate_type: "inspection",
        aggregate_id: "insp",
        id: "evt",
        event_type: "inspection.submitted",
      },
      { submissionId: "sub-1" },
    );
    expect(context.exceptionId).toBeNull();
    expect(context.exceptionIds).toEqual([]);
    expect(context.exceptionIdsPresent).toBe(false);
  });

  it("keeps claim eligibility separate from durable assignment", () => {
    const roleQueue = userMayClaimWorkItem({
      actorUserId: OPERATIONS,
      actorRoleKeys: [DEMO_ROLE_IDS.OPERATIONS],
      assignedUserId: null,
      assignedRoleKey: DEMO_ROLE_IDS.OPERATIONS,
      claimedUserId: null,
      workItemKind: "inspection_correction",
      hasOwnerPrivilege: false,
    });
    expect(roleQueue.allowed).toBe(true);
    expect(roleQueue.reason).toBe("role_queue");
    expect(
      userMayClaimWorkItem({
        actorUserId: DEMO_PERSONAS[5].id,
        actorRoleKeys: [DEMO_ROLE_IDS.OPERATIONS],
        assignedUserId: OPERATIONS,
        assignedRoleKey: DEMO_ROLE_IDS.OPERATIONS,
        claimedUserId: null,
        workItemKind: "inspection_correction",
        hasOwnerPrivilege: false,
      }).allowed,
    ).toBe(false);
  });

  it("uses bounded exponential backoff for projection retries", () => {
    expect(projectionRetryDelayMs(1)).toBe(1000);
    expect(projectionRetryDelayMs(2)).toBe(2000);
    expect(projectionRetryDelayMs(20)).toBe(5 * 60 * 1000);
  });

  it("records skipped escalation levels for highest-currently-due catch-up", () => {
    expect(ESCALATION_CATCH_UP_MODE).toBe("highest_currently_due");
    expect(skippedEscalationLevels("none", "critical")).toEqual(["watch", "at_risk", "breached"]);
    expect(skippedEscalationLevels("watch", "at_risk")).toEqual([]);
  });

  it("keeps automation-failure completion job-specific", () => {
    const failure = SYNTHETIC_WORK_ROUTING_BLUEPRINTS.find(
      (item) => item.workItemKind === "automation_failure",
    );
    expect(failure?.completionEventTypes).toEqual(
      expect.arrayContaining([
        "automation.job_succeeded",
        "automation.job_cancelled",
        "automation.projection_succeeded",
        "automation.schedule_succeeded",
        "automation.schedule_resolved",
      ]),
    );
    expect(failure?.completionEventTypes).not.toContain("exception.resolved");
    expect(failure?.triggerEventTypes).toEqual(
      expect.arrayContaining([
        "automation.job_dead_letter",
        "automation.projection_dead_lettered",
        "automation.schedule_dead_lettered",
      ]),
    );
  });

  function identity(
    partial: Partial<WorkEventIdentity> & Pick<WorkEventIdentity, "eventType">,
  ): WorkEventIdentity {
    return {
      eventId: "evt-1",
      inspectionId: null,
      reportId: null,
      reportVersionId: null,
      requestedRevisionVersionId: null,
      submissionId: null,
      exceptionId: null,
      exceptionIds: [],
      exceptionIdsPresent: false,
      deliveryId: null,
      deliveryAuthorizationId: null,
      jobId: null,
      projectionEventId: null,
      scheduledActionId: null,
      failureSourceType: null,
      failureSourceId: null,
      leadId: null,
      proposalId: null,
      proposalVersionId: null,
      catalogVersionId: null,
      pricingOverrideId: null,
      informationCycleNumber: null,
      ...partial,
    };
  }

  it("treats missing reportVersionId on report.approved as malformed, not a no-op", () => {
    const blueprint = SYNTHETIC_WORK_ROUTING_BLUEPRINTS.find(
      (item) => item.workItemKind === "report_technical_review",
    )!;
    const resolution = resolveWorkCycleIdentity({
      blueprint,
      action: "complete",
      identity: identity({ eventType: "report.approved", reportId: "r1" }),
    });
    expect(resolution.kind).toBe("malformed_missing_identity");
    if (resolution.kind !== "malformed_missing_identity") return;
    expect(resolution.missingFields).toContain("reportVersionId");
    const error = createCycleIdentityIncompleteError(resolution);
    expect(error.code).toBe("CYCLE_IDENTITY_INCOMPLETE");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("reportVersionId");
    expect(error.message).toContain("report.approved");
    expect(error.message).toContain("report_technical_review");
    expect(cycleIdentityIncompleteMessage(resolution)).toBe(error.message);
  });

  it("treats explicit empty exceptionIds as not applicable and a missing property as malformed", () => {
    const blueprint = SYNTHETIC_WORK_ROUTING_BLUEPRINTS.find(
      (item) => item.workItemKind === "inspection_correction",
    )!;
    const empty = resolveWorkCycleIdentity({
      blueprint,
      action: "complete",
      identity: identity({
        eventType: "inspection.validated",
        inspectionId: "insp-1",
        exceptionIds: [],
        exceptionIdsPresent: true,
      }),
    });
    expect(empty.kind).toBe("not_applicable");
    const missing = resolveWorkCycleIdentity({
      blueprint,
      action: "complete",
      identity: identity({
        eventType: "inspection.validated",
        inspectionId: "insp-1",
        exceptionIdsPresent: false,
      }),
    });
    expect(missing.kind).toBe("malformed_missing_identity");
    if (missing.kind === "malformed_missing_identity") {
      expect(missing.missingFields).toEqual(["exceptionIds"]);
    }
  });

  it("does not require a prior revision id for an initial report draft", () => {
    const blueprint = SYNTHETIC_WORK_ROUTING_BLUEPRINTS.find(
      (item) => item.workItemKind === "report_revision",
    )!;
    const resolution = resolveWorkCycleIdentity({
      blueprint,
      action: "complete",
      identity: identity({
        eventType: "report.draft_created",
        reportId: "r1",
        reportVersionId: "v1",
      }),
    });
    expect(resolution.kind).toBe("not_applicable");
  });

  it("keeps job, projection, and schedule failure cycles distinct", () => {
    expect(WORK_FAILURE_SOURCE_TYPES).toEqual(["job", "projection", "schedule"]);
    expect(
      buildWorkItemCycleIdentity({
        kind: "automation_failure",
        jobId: "job-1",
        failureSourceType: "job",
        failureSourceId: "job-1",
      }),
    ).toBe("job:job-1:dead-letter");
    expect(
      buildWorkItemCycleIdentity({
        kind: "automation_failure",
        projectionEventId: "evt-1",
        failureSourceType: "projection",
        failureSourceId: "evt-1",
      }),
    ).toBe("projection:evt-1:dead-letter");
    expect(
      buildWorkItemCycleIdentity({
        kind: "automation_failure",
        scheduledActionId: "sched-1",
        failureSourceType: "schedule",
        failureSourceId: "sched-1",
      }),
    ).toBe("schedule:sched-1:dead-letter");
    expect(eventIdentityContractFor("automation.schedule_dead_lettered")?.fields[0]?.field).toBe(
      "scheduleId",
    );
    const scheduleContext = extractPayloadContext(
      {
        aggregate_type: "schedule",
        aggregate_id: "sched-1",
        id: "evt",
        event_type: "automation.schedule_dead_lettered",
      },
      { scheduleId: "sched-1" },
    );
    expect(scheduleContext.jobId).toBeNull();
    expect(scheduleContext.scheduledActionId).toBe("sched-1");
    expect(scheduleContext.failureSourceType).toBe("schedule");
  });
});
