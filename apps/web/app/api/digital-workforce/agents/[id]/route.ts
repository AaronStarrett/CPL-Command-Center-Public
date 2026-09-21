import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import {
  digitalWorkforceContext,
  digitalWorkforceFailure,
  PERMISSIONS,
} from "@/lib/digital-workforce-api";
import { publishDigitalAgent } from "@/lib/digital-workforce-runtime";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const context = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce/agents/[id]",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    mutation: false,
    action: "digital-workforce.agent.read",
  });
  if (!context.ok) return context.response;
  try {
    const { id } = await params;
    const agent = await context.runtime.digitalWorkforce.getAgent(id);
    if (!agent) {
      return apiError("not-found", "Digital Agent was not found.", 404, context.correlationId);
    }
    const versions = await context.runtime.digitalWorkforce.listAgentVersions(id);
    const published = agent.currentPublishedVersionId
      ? await context.runtime.digitalWorkforce.getVersion(agent.currentPublishedVersionId)
      : null;
    return apiJson({ agent, versions, published }, context.correlationId);
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

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const transport = validateBoundedJsonMutation(request, 8_192);
  const previewContext = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce/agents/[id]",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
    mutation: true,
    action: "digital-workforce.agent.mutate",
  });
  if (!previewContext.ok) return previewContext.response;
  if (!transport.ok) {
    return apiError(
      transport.code,
      transport.message,
      transport.status,
      previewContext.correlationId,
    );
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
        previewContext.correlationId,
      );
    }
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const action = typeof input.action === "string" ? input.action : "";
    if (action === "publish") {
      const context = await digitalWorkforceContext(request, {
        route: "/api/digital-workforce/agents/[id]",
        permission: PERMISSIONS.DIGITAL_WORKFORCE_PUBLISH,
        mutation: true,
        action: "digital-workforce.agent.publish",
      });
      if (!context.ok) return context.response;
      const published = await publishDigitalAgent({
        runtime: context.runtime,
        userId: context.session.personaId,
        agentId: id,
        versionId: typeof input.versionId === "string" ? input.versionId : "",
        confirmation: typeof input.confirmation === "string" ? input.confirmation : "",
        correlationId: context.correlationId,
      });
      return apiJson({ published }, context.correlationId);
    }
    if (action === "clone") {
      const context = await digitalWorkforceContext(request, {
        route: "/api/digital-workforce/agents/[id]",
        permission: PERMISSIONS.DIGITAL_WORKFORCE_MANAGE,
        mutation: true,
        action: "digital-workforce.agent.clone",
      });
      if (!context.ok) return context.response;
      const cloned = await context.runtime.digitalWorkforce.cloneAgent({
        sourceAgentId: id,
        createdByUserId: context.session.personaId,
        displayName:
          typeof input.displayName === "string" ? input.displayName : "Cloned Digital Agent",
        slug: typeof input.slug === "string" ? input.slug : `cloned-digital-agent-${Date.now()}`,
      });
      return apiJson(cloned, context.correlationId, { status: 201 });
    }
    if (action === "pause" || action === "resume" || action === "archive") {
      const context = await digitalWorkforceContext(request, {
        route: "/api/digital-workforce/agents/[id]",
        permission: PERMISSIONS.DIGITAL_WORKFORCE_MANAGE,
        mutation: true,
        action: "digital-workforce.agent.status",
      });
      if (!context.ok) return context.response;
      const status = action === "pause" ? "paused" : action === "archive" ? "archived" : "active";
      const agent = await context.runtime.digitalWorkforce.setAgentStatus({
        agentId: id,
        status,
        actorUserId: context.session.personaId,
      });
      return apiJson({ agent }, context.correlationId);
    }
    return apiError(
      "invalid-digital-workforce",
      "Unsupported agent action.",
      400,
      previewContext.correlationId,
    );
  } catch (error) {
    return digitalWorkforceFailure(
      error,
      previewContext.runtime,
      previewContext.session.personaId,
      previewContext.correlationId,
      previewContext.logger,
    );
  }
}
