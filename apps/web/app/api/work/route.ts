import { type BeaServerRuntime } from "@bea/database";
import {
  SALES_COMMERCIAL_WORK_KINDS,
  WORK_CONTROL_PRODUCTION_UNCONFIGURED,
  WORK_CONTROL_SYNTHETIC_DISCLOSURE,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { getOperationsServerRuntime, operationsMutationErrorStatus } from "@/lib/operations-api";
import { isSameOriginRequest } from "@/lib/request-security";
import {
  permissionForWorkAction,
  restrictWorkItemsForActor,
  actorCanSeeWorkKind,
  workViewAlternatePermission,
  workViewPermission,
} from "@/lib/work-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function actorRoles(
  runtime: BeaServerRuntime,
  session: { readonly personaId: string; readonly roleIds?: readonly string[] },
): Promise<readonly string[]> {
  if (session.roleIds && session.roleIds.length > 0) return session.roleIds;
  const user = await runtime.repository.findActiveUserById(session.personaId);
  return user?.roleIds ?? [];
}

export async function GET(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/work", "GET");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!session) {
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    }
    const view = request.nextUrl.searchParams.get("view") ?? "my";
    const permission = workViewPermission(view);
    const alternate = workViewAlternatePermission(view);
    const decision = await runtime.authorization.authorizeUser(session.personaId, permission);
    const alternateDecision = alternate
      ? await runtime.authorization.authorizeUser(session.personaId, alternate)
      : { allowed: false };
    if (!decision.allowed && !alternateDecision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "work.read",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "operational_work_item",
        correlationId,
        metadata: { permission, reason: decision.reason, view },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot view operational work.",
        403,
        correlationId,
      );
    }
    const work = runtime.workControl;
    if (view === "notifications") {
      return apiJson(
        { items: await work.repository.listNotifications(), synthetic: true },
        correlationId,
      );
    }
    if (view === "scheduler") {
      return apiJson(
        {
          items: await work.repository.listSchedules(),
          runs: await work.repository.listReconciliationRuns(),
          synthetic: true,
        },
        correlationId,
      );
    }
    if (view === "policies") {
      const preview = work.inspectPolicy();
      return apiJson(
        {
          policies: await work.repository.listPolicies(),
          blueprints: await work.repository.listBlueprints(),
          plan: work.triggerProvisioningPlan(),
          preview,
          production: WORK_CONTROL_PRODUCTION_UNCONFIGURED,
          synthetic: WORK_CONTROL_SYNTHETIC_DISCLOSURE,
          durableTransitionOccurred: false,
          codeDefinedSyntheticRoutingActive: true,
        },
        correlationId,
      );
    }
    if (view === "projection-failures") {
      return apiJson(
        { items: await work.repository.listProjectionFailures(), synthetic: true },
        correlationId,
      );
    }
    if (view === "metrics") {
      return apiJson(
        {
          metrics: await work.metrics(
            new Date(),
            decision.allowed ? {} : { kinds: [...SALES_COMMERCIAL_WORK_KINDS] },
          ),
          synthetic: true,
        },
        correlationId,
      );
    }
    const items = restrictWorkItemsForActor(await work.repository.listWorkItems({ limit: 300 }), {
      hasFullWorkView: decision.allowed,
    });
    return apiJson(
      { items, synthetic: true, disclosure: WORK_CONTROL_SYNTHETIC_DISCLOSURE },
      correlationId,
    );
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Work read failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/work", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getOperationsServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin work mutation was rejected.",
        403,
        correlationId,
      );
    }
    if (!session) {
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("invalid-json", "The request body must be valid JSON.", 400, correlationId);
    }
    if (!body || typeof body !== "object") {
      return apiError(
        "invalid-operations",
        "Work action details are required.",
        400,
        correlationId,
      );
    }
    const input = body as Record<string, unknown>;
    const action = asString(input.action);
    const mapped = permissionForWorkAction(action);
    if (!mapped) {
      return apiError("unknown-action", "The work action is not recognized.", 400, correlationId);
    }
    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      mapped.permission,
    );
    const alternateDecision = mapped.alternatePermission
      ? await runtime.authorization.authorizeUser(session.personaId, mapped.alternatePermission)
      : { allowed: false };
    if (!decision.allowed && !alternateDecision.allowed) {
      if (action === "reconcile-dry-run") {
        const ownerExecute = await runtime.authorization.authorizeUser(
          session.personaId,
          PERMISSIONS.WORK_RECONCILE,
        );
        if (!ownerExecute.allowed) {
          await runtime.repository.record({
            eventType: "authorization.denied",
            action: mapped.auditAction,
            outcome: "denied",
            actorUserId: session.personaId,
            resourceType: "operational_work_item",
            correlationId,
            metadata: { permission: mapped.permission, reason: decision.reason },
          });
          return apiError(
            "permission-not-granted",
            "The current role cannot run reconciliation.",
            403,
            correlationId,
          );
        }
      } else {
        await runtime.repository.record({
          eventType: "authorization.denied",
          action: mapped.auditAction,
          outcome: "denied",
          actorUserId: session.personaId,
          resourceType: "operational_work_item",
          correlationId,
          metadata: { permission: mapped.permission, reason: decision.reason },
        });
        return apiError(
          "permission-not-granted",
          "The current role cannot perform this work action.",
          403,
          correlationId,
        );
      }
    }
    const work = runtime.workControl;
    const roleKeys = await actorRoles(runtime, session);
    const actor = {
      userId: session.personaId,
      roleKeys,
      correlationId,
      expectedVersion:
        typeof input.expectedVersion === "number" ? input.expectedVersion : undefined,
    };
    const workItemId = asString(input.workItemId);
    if (action === "claim" || action === "release") {
      if (!decision.allowed && alternateDecision.allowed) {
        const existing = await work.repository.getWorkItem(workItemId);
        if (!existing || !actorCanSeeWorkKind(existing.workItemKind, { hasFullWorkView: false })) {
          return apiError(
            "permission-not-granted",
            "The current role cannot claim this work item.",
            403,
            correlationId,
          );
        }
      }
    }
    if (action === "claim") {
      return apiJson({ item: await work.claimWorkItem(workItemId, actor) }, correlationId);
    }
    if (action === "release") {
      return apiJson({ item: await work.releaseClaim(workItemId, actor) }, correlationId);
    }
    if (action === "acknowledge") {
      return apiJson({ item: await work.acknowledgeWorkItem(workItemId, actor) }, correlationId);
    }
    if (action === "start") {
      return apiJson({ item: await work.startWorkItem(workItemId, actor) }, correlationId);
    }
    if (action === "block") {
      return apiJson(
        { item: await work.blockWorkItem(workItemId, actor, asString(input.reason)) },
        correlationId,
      );
    }
    if (action === "unblock") {
      return apiJson({ item: await work.unblockWorkItem(workItemId, actor) }, correlationId);
    }
    if (action === "reassign") {
      return apiJson(
        {
          item: await work.reassignWorkItem(workItemId, actor, {
            assignedUserId: asString(input.assignedUserId) || null,
            assignedRoleKey: asString(input.assignedRoleKey) || null,
          }),
        },
        correlationId,
      );
    }
    if (action === "reconcile-dry-run") {
      return apiJson(
        {
          result: await work.reconcile({
            mode: "dry_run",
            actorUserId: session.personaId,
            correlationId,
          }),
        },
        correlationId,
      );
    }
    if (action === "reconcile-execute") {
      return apiJson(
        {
          result: await work.reconcile({
            mode: "execute",
            actorUserId: session.personaId,
            correlationId,
          }),
        },
        correlationId,
      );
    }
    if (action === "inspect-policy") {
      return apiJson({ preview: work.inspectPolicy() }, correlationId);
    }
    if (action === "validate-policy-preview") {
      return apiJson({ preview: work.validatePolicyPreview() }, correlationId);
    }
    if (action === "activation-readiness-preview") {
      return apiJson({ preview: work.activationReadinessPreview() }, correlationId);
    }
    if (action === "retry-projection") {
      await work.retryProjectionEvent(asString(input.eventId) || workItemId, actor);
      return apiJson({ retried: true, durableHistoryPreserved: true }, correlationId);
    }
    if (action === "retry-job") {
      await work.retryAutomationJob(asString(input.jobId) || workItemId, actor);
      return apiJson({ retried: true, workItemRemainsOpen: true }, correlationId);
    }
    if (action === "cancel-job") {
      await work.cancelAutomationJob(asString(input.jobId) || workItemId, actor);
      return apiJson({ cancelled: true }, correlationId);
    }
    if (action === "provisioning-plan") {
      return apiJson(
        { plan: work.triggerProvisioningPlan(), liveConnection: false },
        correlationId,
      );
    }
    return apiError("unknown-action", "The work action is not recognized.", 400, correlationId);
  } catch (error) {
    const mapped = operationsMutationErrorStatus(error);
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, correlationId);
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Work mutation failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
