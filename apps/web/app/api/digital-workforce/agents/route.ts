import { DIGITAL_AGENT_AVATARS, assertAvatar, assertSlug } from "@bea/domain";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import {
  digitalWorkforceContext,
  digitalWorkforceFailure,
  PERMISSIONS,
} from "@/lib/digital-workforce-api";
import { audienceRoles, buildAgentVersionInput } from "@/lib/digital-workforce-runtime";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const context = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce/agents",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    mutation: false,
    action: "digital-workforce.agents.read",
  });
  if (!context.ok) return context.response;
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const departmentId = url.searchParams.get("departmentId") ?? undefined;
    const teamId = url.searchParams.get("teamId") ?? undefined;
    const agents = await context.runtime.digitalWorkforce.listAgents({
      ...(query ? { query } : {}),
      ...(status === "draft" || status === "active" || status === "paused" || status === "archived"
        ? { status }
        : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(teamId ? { teamId } : {}),
      includeArchived: status === "archived",
      limit: 100,
      ...(audienceRoles(context.session.roleIds)
        ? { availableToRoleIds: audienceRoles(context.session.roleIds) }
        : {}),
    });
    return apiJson({ agents }, context.correlationId);
  } catch (error) {
    return digitalWorkforceFailure(
      error,
      context.runtime,
      context.session.personaId,
      context.correlationId,
      context.logger,
    );
  }
}

export async function POST(request: NextRequest) {
  const context = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce/agents",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_MANAGE,
    mutation: true,
    action: "digital-workforce.agents.create",
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request, 16_384);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(
        "invalid-json",
        "The request body must be valid JSON.",
        400,
        context.correlationId,
      );
    }
    if (!body || typeof body !== "object") {
      return apiError(
        "invalid-digital-workforce",
        "Agent details are required.",
        400,
        context.correlationId,
      );
    }
    const input = body as Record<string, unknown>;
    const slug = typeof input.slug === "string" ? assertSlug(input.slug) : "";
    const displayName = typeof input.displayName === "string" ? input.displayName : "";
    const roleTitle = typeof input.roleTitle === "string" ? input.roleTitle : "";
    const shortDescription =
      typeof input.shortDescription === "string" ? input.shortDescription : "Digital Agent";
    const departmentId = typeof input.departmentId === "string" ? input.departmentId : "";
    const teamId = typeof input.teamId === "string" ? input.teamId : "";
    const avatar =
      typeof input.avatar === "string" &&
      (DIGITAL_AGENT_AVATARS as readonly string[]).includes(input.avatar)
        ? assertAvatar(input.avatar)
        : "specialist-operations";
    const created = await context.runtime.digitalWorkforce.createAgentDraft({
      slug,
      displayName,
      roleTitle,
      shortDescription,
      departmentId,
      teamId,
      supportedHumanUserId:
        typeof input.supportedHumanUserId === "string" ? input.supportedHumanUserId : null,
      avatar,
      createdByUserId: context.session.personaId,
      version: buildAgentVersionInput({
        createdByUserId: context.session.personaId,
        departmentId,
        teamId,
        supervisorAgentId:
          typeof input.supervisorAgentId === "string" ? input.supervisorAgentId : null,
        preferredHandoffAgentIds: Array.isArray(input.preferredHandoffAgentIds)
          ? input.preferredHandoffAgentIds.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        persona:
          typeof input.persona === "string"
            ? input.persona
            : "You are a Digital Agent. You never expand permissions.",
        roleDefinition: typeof input.roleDefinition === "string" ? input.roleDefinition : roleTitle,
        goals: Array.isArray(input.goals)
          ? input.goals.filter((item): item is string => typeof item === "string")
          : [],
        successCriteria: Array.isArray(input.successCriteria)
          ? input.successCriteria.filter((item): item is string => typeof item === "string")
          : [],
        modelProfile:
          typeof input.modelProfile === "string" ? (input.modelProfile as "balanced") : "balanced",
        toolNames: Array.isArray(input.toolNames)
          ? input.toolNames.filter((item): item is string => typeof item === "string")
          : ["bea_list_agents", "bea_get_agent"],
        dataScopes: Array.isArray(input.dataScopes)
          ? input.dataScopes.filter((item): item is string => typeof item === "string")
          : ["current-conversation"],
        knowledgeScopes: Array.isArray(input.knowledgeScopes)
          ? input.knowledgeScopes.filter((item): item is string => typeof item === "string")
          : ["current-conversation"],
        memoryPolicy: typeof input.memoryPolicy === "string" ? input.memoryPolicy : "run-only",
        approvalPolicy:
          typeof input.approvalPolicy === "string" ? input.approvalPolicy : "confirmation-required",
        escalationInstructions:
          typeof input.escalationInstructions === "string"
            ? input.escalationInstructions
            : "Escalate to the owner. A Digital Agent cannot approve its own work.",
      }),
    });
    await context.runtime.digitalWorkforce.createNotification({
      userId: context.session.personaId,
      type: "agent-draft-ready",
      title: "Digital Agent draft ready for review",
      body: `${created.agent.displayName} is saved as a draft and is not published.`,
      sourceType: "digital-workforce-agent",
      sourceId: created.agent.id,
      href: `/digital-workforce?tab=agents&agent=${created.agent.id}`,
    });
    return apiJson(created, context.correlationId, { status: 201 });
  } catch (error) {
    return digitalWorkforceFailure(
      error,
      context.runtime,
      context.session.personaId,
      context.correlationId,
      context.logger,
    );
  }
}
