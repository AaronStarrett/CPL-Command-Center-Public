import {
  getServerRuntime,
  TaskRelationshipValidationError,
  type BeaServerRuntime,
  type TaskRelationshipField,
} from "@bea/database";
import type { TaskPriority } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { NextRequest } from "next/server";

import { requestCorrelationId, requestSession, webRouteLogger } from "@/app/api/route-helpers";
import { apiError, apiException, apiJson } from "@/lib/api-response";
import { canIncludeApiDiagnostics } from "@/lib/diagnostics-authorization";
import { validateTaskRelationshipIdentifiers } from "@/lib/company-contacts";
import { isSameOriginRequest } from "@/lib/request-security";

const priorities = ["low", "normal", "high", "urgent"] as const;

function optionalString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized || null : undefined;
}

function optionalDateTime(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function taskFieldError(
  code: string,
  message: string,
  field: TaskRelationshipField,
  correlationId: string,
) {
  return apiJson({ error: { code, message, field, correlationId } }, correlationId, {
    status: 400,
  });
}

export async function POST(request: NextRequest) {
  const correlationId = requestCorrelationId(request);
  const logger = webRouteLogger(correlationId, "/api/tasks", "POST");
  let runtime: BeaServerRuntime | undefined;
  let authenticatedUserId: string | undefined;
  try {
    runtime = await getServerRuntime();
    const session = await requestSession(request);
    authenticatedUserId = session?.personaId;
    if (!isSameOriginRequest(request, runtime.environment.appBaseUrl)) {
      return apiError(
        "cross-origin-request-rejected",
        "Cross-origin task creation was rejected.",
        403,
        correlationId,
      );
    }
    if (!session)
      return apiError(
        "authentication-required",
        "A valid demo session is required.",
        401,
        correlationId,
      );
    const decision = await runtime.authorization.authorizeUser(
      session.personaId,
      PERMISSIONS.TASKS_MANAGE,
    );
    if (!decision.allowed) {
      await runtime.repository.record({
        eventType: "authorization.denied",
        action: "task.create",
        outcome: "denied",
        actorUserId: session.personaId,
        resourceType: "task",
        correlationId,
        metadata: { permission: PERMISSIONS.TASKS_MANAGE, reason: decision.reason },
      });
      return apiError(
        "permission-not-granted",
        "The current role cannot create tasks.",
        403,
        correlationId,
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("invalid-json", "The request body must be valid JSON.", 400, correlationId);
    }
    if (!body || typeof body !== "object")
      return apiError("invalid-task", "Task details are required.", 400, correlationId);
    const input = body as Record<string, unknown>;
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const description = optionalString(input.description, 4000);
    const dueAt = optionalDateTime(input.dueAt);
    const companyId = optionalString(input.companyId, 128);
    const contactId = optionalString(input.contactId, 128);
    const leadId = optionalString(input.leadId, 128);
    const priority = priorities.includes(input.priority as TaskPriority)
      ? (input.priority as TaskPriority)
      : "normal";
    if (
      !title ||
      title.length > 160 ||
      description === undefined ||
      dueAt === undefined ||
      companyId === undefined ||
      contactId === undefined ||
      leadId === undefined
    ) {
      return apiError(
        "invalid-task",
        "Task fields are invalid or exceed their allowed length.",
        400,
        correlationId,
      );
    }
    const relationshipIdentifiers = validateTaskRelationshipIdentifiers(companyId, contactId);
    if (!relationshipIdentifiers.ok) {
      return taskFieldError(
        relationshipIdentifiers.code,
        relationshipIdentifiers.message,
        relationshipIdentifiers.field,
        correlationId,
      );
    }
    if (companyId) {
      const companyAccess = await runtime.authorization.authorizeUser(
        session.personaId,
        PERMISSIONS.COMPANIES_VIEW,
      );
      if (!companyAccess.allowed || !(await runtime.phase1.getCompany(companyId))) {
        return taskFieldError(
          "invalid-company",
          "The linked company is unavailable.",
          "companyId",
          correlationId,
        );
      }
    }
    if (contactId) {
      const contactAccess = await runtime.authorization.authorizeUser(
        session.personaId,
        PERMISSIONS.CONTACTS_VIEW,
      );
      const contact = contactAccess.allowed ? await runtime.phase1.getContact(contactId) : null;
      if (!contact || contact.companyId !== companyId) {
        return taskFieldError(
          "invalid-contact",
          "The linked contact is unavailable or does not match the company.",
          "contactId",
          correlationId,
        );
      }
    }
    if (leadId) {
      const leadAccess = await runtime.authorization.authorizeUser(
        session.personaId,
        PERMISSIONS.LEADS_VIEW,
      );
      if (!leadAccess.allowed || !(await runtime.leads.getLead(leadId))) {
        return apiError("invalid-lead", "The linked lead is unavailable.", 400, correlationId);
      }
    }
    const task = await runtime.phase1.createTask({
      title,
      description,
      priority,
      assigneeUserId: session.personaId,
      dueAt,
      companyId,
      contactId,
      leadId,
      createdByUserId: session.personaId,
      correlationId,
    });
    logger.info({ userId: session.personaId, taskId: task.id }, "Phase 1 task created");
    return apiJson({ task }, correlationId, { status: 201 });
  } catch (error) {
    if (error instanceof TaskRelationshipValidationError) {
      return taskFieldError(
        error.code.toLocaleLowerCase("en-US"),
        error.message,
        error.field,
        correlationId,
      );
    }
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Task creation failed",
    );
    const diagnosticsAllowed = await canIncludeApiDiagnostics(runtime, authenticatedUserId);
    return apiException(error, 500, correlationId, diagnosticsAllowed);
  }
}
