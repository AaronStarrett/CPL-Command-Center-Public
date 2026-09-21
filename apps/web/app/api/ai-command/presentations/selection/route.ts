import {
  authorizeWorkspaceSelection,
  presentationPacketFromStoredRun,
  parseSafeWorkspaceSelection,
} from "@bea/ai";
import type { JsonObject } from "@bea/domain";
import { AccessDeniedError, PERMISSIONS, type Permission } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import { OpenAiAdministrationError } from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REQUEST_KEYS = new Set(["autoFollow", "conversationId", "selection"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/presentations/selection",
    action: "ai-command.presentation.select",
    permission: PERMISSIONS.AI_COMMAND_RUN,
    strictMutation: true,
    rateLimit: { key: "ai-command.presentation.select", limit: 60, windowSeconds: 60 },
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new OpenAiAdministrationError(
        "INVALID_PRESENTATION_SELECTION",
        400,
        "The workspace selection must be valid JSON.",
      );
    }
    const input = record(body);
    if (!input || Object.keys(input).some((key) => !REQUEST_KEYS.has(key))) {
      throw new OpenAiAdministrationError(
        "INVALID_PRESENTATION_SELECTION",
        400,
        "The workspace selection is invalid.",
      );
    }
    const conversationId =
      typeof input.conversationId === "string" ? input.conversationId.trim() : "";
    const conversation = await context.runtime.phase1.getConversation(
      conversationId,
      context.userId,
    );
    if (!conversation) {
      throw new OpenAiAdministrationError(
        "PRESENTATION_CONVERSATION_UNAVAILABLE",
        404,
        "The AI Command conversation is unavailable.",
      );
    }
    const latest = await context.runtime.ai.persistence.getLatestPresentationRunForConversation(
      conversation.id,
      context.userId,
    );
    const packet = latest ? presentationPacketFromStoredRun(latest.packet) : null;
    const selection =
      input.selection === null || input.selection === undefined
        ? null
        : parseSafeWorkspaceSelection(input.selection);
    if (input.selection !== null && input.selection !== undefined && !selection) {
      throw new OpenAiAdministrationError(
        "INVALID_PRESENTATION_SELECTION",
        400,
        "The workspace selection is not a safe application-owned reference.",
      );
    }
    let permissionsAllowed = true;
    try {
      for (const permission of packet?.requiredPermissions ?? []) {
        await context.runtime.authorization.requireUser({
          userId: context.userId,
          permission: permission as Permission,
          action: "ai-command.presentation.select",
          resourceType: "ai-presentation-run",
          resourceId: latest?.id,
          correlationId: context.correlationId,
        });
      }
    } catch (error) {
      if (error instanceof AccessDeniedError) permissionsAllowed = false;
      else throw error;
    }
    const authorized = authorizeWorkspaceSelection({
      latest: packet,
      selection,
      conversationOwnerUserId: conversation.ownerUserId ?? context.userId,
      actingUserId: context.userId,
      permissionsAllowed,
      runVisualArtifactId: latest?.visualArtifactId,
    });
    if (!authorized.ok) {
      throw new OpenAiAdministrationError(authorized.code, authorized.status, authorized.message);
    }
    const autoFollow = input.autoFollow === true;
    const updated = await context.runtime.ai.persistence.updatePresentationSelection({
      id: latest!.id,
      actingUserId: context.userId,
      selectedContext: authorized.selection as unknown as JsonObject | null,
      autoFollow,
    });
    await context.runtime.repository.record({
      eventType: "ai-command.presentation-selection",
      action: "ai-command.presentation.select",
      outcome: "succeeded",
      actorUserId: context.userId,
      resourceType: "ai-presentation-run",
      resourceId: latest!.id,
      correlationId: context.correlationId,
      metadata: {
        conversationId: conversation.id,
        kind: authorized.selection?.kind ?? null,
        elementId: authorized.selection?.elementId ?? null,
        autoFollow,
      },
    });
    return apiJson(
      {
        presentationRunId: latest!.id,
        selected: authorized.selection,
        autoFollow: updated?.autoFollow ?? autoFollow,
      },
      context.correlationId,
    );
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return openAiApiError(
        new OpenAiAdministrationError(
          "PRESENTATION_AUTHORIZATION_DENIED",
          403,
          "You are not authorized to use this presentation.",
        ),
        context.correlationId,
      );
    }
    return openAiApiError(error, context.correlationId);
  }
}
