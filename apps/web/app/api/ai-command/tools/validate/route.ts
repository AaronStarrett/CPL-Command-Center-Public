import { validateRegisteredArtifactToolCall } from "@bea/ai";
import { PERMISSIONS, type Permission } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const knownPermissions = new Set<string>(Object.values(PERMISSIONS));

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/tools/validate",
    action: "ai-command.tool.validate",
    permission: PERMISSIONS.AI_COMMAND_RUN,
    strictMutation: true,
    rateLimit: { key: "ai-command.tool.validate", limit: 30, windowSeconds: 60 },
  });
  if (!context.ok) return context.response;

  const transport = validateBoundedJsonMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(
      "invalid-json",
      "Tool proposals must be valid JSON.",
      400,
      context.correlationId,
    );
  }
  const input = record(body);
  const callId = typeof input?.callId === "string" ? input.callId.trim() : "";
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!CALL_ID_PATTERN.test(callId) || !name) {
    return apiError(
      "invalid-tool-proposal",
      "The tool proposal identity is invalid.",
      400,
      context.correlationId,
    );
  }
  const validation = validateRegisteredArtifactToolCall(name, input?.arguments);
  if (!validation.ok) {
    await context.runtime.repository.record({
      eventType: "ai-provider.tool-rejected",
      action: "ai-command.tool.validate",
      outcome: "denied",
      actorUserId: context.userId,
      resourceType: "ai-tool-call",
      resourceId: null,
      correlationId: context.correlationId,
      metadata: { callId, name, reason: validation.reason },
    });
    return apiError(
      validation.reason === "unknown-tool" ? "unknown-tool" : "invalid-tool-arguments",
      "The proposed tool is not registered or its arguments are invalid.",
      400,
      context.correlationId,
    );
  }
  if (validation.tool.requiredPermissions.some((permission) => !knownPermissions.has(permission))) {
    return apiError(
      "invalid-tool-permission",
      "The tool permission policy is invalid.",
      500,
      context.correlationId,
    );
  }
  for (const permission of validation.tool.requiredPermissions) {
    const decision = await context.runtime.authorization.authorizeUser(
      context.userId,
      permission as Permission,
    );
    if (!decision.allowed) {
      await context.runtime.repository.record({
        eventType: "authorization.denied",
        action: "ai-command.tool.validate",
        outcome: "denied",
        actorUserId: context.userId,
        resourceType: "ai-tool-call",
        resourceId: null,
        correlationId: context.correlationId,
        metadata: { callId, name, permission, reason: decision.reason },
      });
      return apiError(
        "tool-permission-not-granted",
        "The current role cannot use this proposed tool.",
        403,
        context.correlationId,
      );
    }
  }
  await context.runtime.repository.record({
    eventType: "ai-provider.tool-validated",
    action: "ai-command.tool.validate",
    outcome: "succeeded",
    actorUserId: context.userId,
    resourceType: "ai-tool-call",
    resourceId: null,
    correlationId: context.correlationId,
    metadata: {
      callId,
      name,
      effect: validation.tool.effect,
      requiredPermissions: [...validation.tool.requiredPermissions],
      executed: false,
    },
  });
  return apiJson(
    {
      validation: {
        callId,
        name,
        status: "validated",
        effect: validation.tool.effect,
        requiredPermissions: validation.tool.requiredPermissions,
        executable: false,
      },
    },
    context.correlationId,
  );
}
