import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import {
  digitalWorkforceContext,
  digitalWorkforceFailure,
  PERMISSIONS,
} from "@/lib/digital-workforce-api";
import { previewNaturalLanguageAgentDraft } from "@/lib/digital-workforce-runtime";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const context = await digitalWorkforceContext(request, {
    route: "/api/digital-workforce/drafts",
    permission: PERMISSIONS.DIGITAL_WORKFORCE_MANAGE,
    mutation: true,
    action: "digital-workforce.draft.preview",
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request, 4_096);
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
    const requestText =
      body &&
      typeof body === "object" &&
      typeof (body as { request?: unknown }).request === "string"
        ? (body as { request: string }).request
        : "";
    const preview = previewNaturalLanguageAgentDraft(requestText);
    return apiJson(
      {
        preview,
        actionPreview: {
          title: "Create Digital Agent draft",
          confirmationRequired: true,
          publishesAutomatically: false,
          warnings: preview.warnings,
        },
      },
      context.correlationId,
    );
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
