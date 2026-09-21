import {
  BEA_REALTIME_TOOL_NAMES,
  PHASE21_LIMITS,
  buildRealtimeVoiceBriefing,
  parsePresentationFromPayload,
  realtimeSessionWithinMaxAge,
  validateRegisteredRealtimeToolCall,
  type AiConversationResult,
} from "@bea/ai";
import type { AiCommandSnapshot } from "@/lib/ai-command-contracts";
import { PERMISSIONS, requireCredentialSafeContent, type Permission } from "@bea/security";
import { NextRequest } from "next/server";

import { apiError, apiJson } from "@/lib/api-response";
import { requireAiApiContext } from "@/lib/ai-command-api";
import {
  getAiCommandSnapshotWithRuntime,
  processAiCommandMessageWithRuntime,
  reserveAiCommandRequestWithRuntime,
} from "@/lib/ai-command";
import { authorizeLiveVoiceWebSearch, processAiCommandStream } from "@/lib/ai-command-stream";
import {
  generateExecutivePdfArtifact,
  listConversationPdfArtifacts,
  loadExecutivePdfWorkspace,
} from "@/lib/executive-artifact";
import { OpenAiAdministrationError } from "@/lib/openai-administration";
import { openAiApiError } from "@/lib/openai-api";
import { validateBoundedJsonMutation } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const REQUEST_KEYS = new Set(["arguments", "callId", "conversationId", "name", "sessionId"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function argumentText(value: Record<string, unknown>, key: "query" | "request"): string {
  const text = typeof value[key] === "string" ? value[key].replace(/\s+/gu, " ").trim() : "";
  if (!text || text.length > 2_000) {
    throw new OpenAiAdministrationError(
      "INVALID_REALTIME_TOOL_ARGUMENTS",
      400,
      "The Realtime tool arguments are invalid.",
    );
  }
  requireCredentialSafeContent(text);
  return text;
}

function showWorkspaceCommand(argumentsValue: Record<string, unknown>): string | null {
  const target = typeof argumentsValue.target === "string" ? argumentsValue.target : "";
  const id =
    typeof argumentsValue.id === "string" ? argumentsValue.id.replace(/\s+/gu, " ").trim() : "";
  if (!id || id.length > 100) {
    throw new OpenAiAdministrationError(
      "INVALID_REALTIME_TOOL_ARGUMENTS",
      400,
      "The Realtime tool arguments are invalid.",
    );
  }
  requireCredentialSafeContent(id);
  switch (target) {
    case "lead":
      return `Open lead ${id}`;
    case "company":
      return `Open ${id}`;
    case "contact":
      return `Search for ${id}`;
    case "task":
    case "activity":
    case "notification":
    case "integration":
    case "workflow-run":
      throw new OpenAiAdministrationError(
        "REALTIME_EXACT_TARGET_UNSUPPORTED",
        400,
        "Exact-target workspace retrieval is not supported for this record type.",
      );
    case "artifact":
      return null;
    default:
      throw new OpenAiAdministrationError(
        "INVALID_REALTIME_TOOL_ARGUMENTS",
        400,
        "The Realtime tool arguments are invalid.",
      );
  }
}

function safeWorkspacePayload(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 16_000
      ? value
      : { omitted: true, reason: "workspace-payload-limit" };
  } catch {
    return { omitted: true, reason: "workspace-payload-invalid" };
  }
}

function toolOutput(snapshot: AiCommandSnapshot) {
  const assistant = [...snapshot.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const packet = parsePresentationFromPayload(snapshot.artifact.payload);
  const voiceBriefing = packet ? buildRealtimeVoiceBriefing(packet) : null;
  const payload =
    snapshot.artifact.payload && typeof snapshot.artifact.payload === "object"
      ? (snapshot.artifact.payload as Record<string, unknown>)
      : {};
  const executive =
    payload.executiveDocument && typeof payload.executiveDocument === "object"
      ? (payload.executiveDocument as Record<string, unknown>)
      : null;
  const spokenSummary =
    executive && typeof payload.summary === "string"
      ? payload.summary
      : (assistant?.content ?? "The authorized BEA tool completed.");
  return {
    summary: spokenSummary.slice(0, 8_000),
    workspace: {
      type: snapshot.artifact.type,
      title: snapshot.artifact.title,
      subtitle: snapshot.artifact.subtitle,
      state: snapshot.artifact.state,
      payload: voiceBriefing ?? safeWorkspacePayload(snapshot.artifact.payload),
      sources: snapshot.artifact.sources.slice(0, 20),
      links: snapshot.artifact.links.slice(0, 20),
    },
    ...(voiceBriefing
      ? {
          voiceBriefing,
          presentationRunId: voiceBriefing.presentationRunId,
          suppressAutomaticSpokenResponse: true,
          authoritativeNarration: true,
        }
      : executive
        ? {
            pdfReady: true,
            reviewLabel: executive.reviewLabel,
            version: executive.version,
            suppressAutomaticSpokenResponse: false,
            authoritativeNarration: false,
          }
        : {}),
    actionConfirmationRequired: snapshot.artifact.type === "action-preview",
    workspaceUpdated: true,
  };
}

export async function POST(request: NextRequest) {
  const context = await requireAiApiContext(request, {
    route: "/api/ai-command/realtime/tools/execute",
    action: "ai-command.realtime.tool.execute",
    permissions: [PERMISSIONS.AI_COMMAND_RUN],
    strictMutation: true,
    rateLimit: {
      key: "ai-command.realtime.tool.execute",
      limit: PHASE21_LIMITS.realtimeToolsPerSessionPerMinute,
      windowSeconds: 60,
    },
  });
  if (!context.ok) return context.response;
  const transport = validateBoundedJsonMutation(request, 16_384);
  if (!transport.ok) {
    return apiError(transport.code, transport.message, transport.status, context.correlationId);
  }

  let input: Record<string, unknown> | null = null;
  let auditedTool = "invalid";
  try {
    try {
      input = record(await request.json());
    } catch {
      throw new OpenAiAdministrationError(
        "INVALID_REALTIME_TOOL_REQUEST",
        400,
        "The Realtime tool request must be valid JSON.",
      );
    }
    if (
      !input ||
      Object.keys(input).some((key) => !REQUEST_KEYS.has(key)) ||
      typeof input.callId !== "string" ||
      !PROVIDER_CALL_ID.test(input.callId) ||
      typeof input.name !== "string" ||
      typeof input.sessionId !== "string" ||
      !UUID.test(input.sessionId) ||
      typeof input.conversationId !== "string" ||
      !UUID.test(input.conversationId)
    ) {
      throw new OpenAiAdministrationError(
        "INVALID_REALTIME_TOOL_REQUEST",
        400,
        "The Realtime tool request is invalid.",
      );
    }
    const validation = validateRegisteredRealtimeToolCall(input.name, input.arguments);
    if (!validation.ok) {
      throw new OpenAiAdministrationError(
        validation.reason === "unknown-tool"
          ? "REALTIME_TOOL_NOT_REGISTERED"
          : "INVALID_REALTIME_TOOL_ARGUMENTS",
        400,
        validation.reason === "unknown-tool"
          ? "The Realtime tool is not registered."
          : "The Realtime tool arguments are invalid.",
      );
    }
    auditedTool = validation.tool.name;
    const [session, conversation] = await Promise.all([
      context.runtime.ai.persistence.getRealtimeSessionForUser(input.sessionId, context.userId),
      context.runtime.phase1.getConversation(input.conversationId, context.userId),
    ]);
    if (
      !session ||
      !conversation ||
      session.conversationId !== conversation.id ||
      session.provider !== "openai" ||
      session.simulated ||
      session.status !== "connected"
    ) {
      throw new OpenAiAdministrationError(
        "REALTIME_SESSION_UNAVAILABLE",
        404,
        "The connected Realtime session is unavailable.",
      );
    }
    if (
      !realtimeSessionWithinMaxAge({
        authorizedAt: session.authorizedAt,
        nowMs: Date.now(),
        maxAgeMs: PHASE21_LIMITS.realtimeSessionMaxAgeMs,
      })
    ) {
      await context.runtime.ai.persistence.transitionRealtimeSession({
        id: session.id,
        requestedByUserId: context.userId,
        status: "failed",
        errorCode: "REALTIME_SESSION_EXPIRED",
        completedAt: new Date().toISOString(),
      });
      throw new OpenAiAdministrationError(
        "REALTIME_SESSION_EXPIRED",
        409,
        "The Realtime session reached the application maximum duration.",
      );
    }
    if (!session.routeDecision?.toolAllowlist.includes(validation.tool.name)) {
      throw new OpenAiAdministrationError(
        "REALTIME_TOOL_NOT_ALLOWED",
        403,
        "The Realtime tool is not allowed for this session route.",
      );
    }
    for (const permission of validation.tool.requiredPermissions as readonly Permission[]) {
      await context.runtime.authorization.requireUser({
        userId: context.userId,
        permission,
        action: "ai-command.realtime.tool.execute",
        resourceType: "ai-realtime-session",
        resourceId: session.id,
        correlationId: context.correlationId,
      });
    }
    const rateLimit = await context.runtime.ai.persistence.consumeRateLimit({
      subjectKey: `realtime-session:${context.userId}:${session.id}`,
      routeKey: "ai-command.realtime.tool",
      limit: PHASE21_LIMITS.realtimeToolsPerSessionPerMinute,
      windowSeconds: 60,
    });
    if (!rateLimit.allowed) {
      throw new OpenAiAdministrationError(
        "REALTIME_TOOL_RATE_LIMITED",
        429,
        "Realtime tool execution is temporarily rate limited.",
      );
    }
    await context.runtime.repository.record({
      eventType: "ai-provider.realtime-tool-validated",
      action: "ai-command.realtime.tool.execute",
      outcome: "succeeded",
      actorUserId: context.userId,
      resourceType: "ai-realtime-session",
      resourceId: session.id,
      correlationId: context.correlationId,
      metadata: {
        conversationId: conversation.id,
        callId: input.callId,
        tool: validation.tool.name,
        effect: validation.tool.effect,
      },
    });

    let snapshot: AiCommandSnapshot;
    if (validation.tool.name === BEA_REALTIME_TOOL_NAMES.SEARCH_WEB) {
      const query = argumentText(validation.arguments, "query");
      const reservation = await reserveAiCommandRequestWithRuntime(context.runtime, {
        userId: context.userId,
        conversationId: conversation.id,
        correlationId: context.correlationId,
      });
      const liveVoiceWebSearchAuthorization = await authorizeLiveVoiceWebSearch({
        runtime: context.runtime,
        userId: context.userId,
        conversationId: conversation.id,
        correlationId: context.correlationId,
      });
      let completed: AiConversationResult | null = null;
      for await (const event of processAiCommandStream({
        runtime: context.runtime,
        userId: context.userId,
        conversationId: conversation.id,
        message: query,
        requestId: reservation.requestId,
        generation: reservation.generation,
        correlationId: context.correlationId,
        webSearch: true,
        builtInTools: ["web_search"],
        confirmHighCostTools: false,
        inputMode: "live_voice",
        inputArtifactIds: [],
        liveVoiceWebSearchAuthorization,
        signal: request.signal,
      })) {
        if (event.type === "response.completed") completed = event.result;
        if (event.type === "response.error") {
          throw new OpenAiAdministrationError(event.code, 502, event.safeMessage);
        }
      }
      if (!completed) {
        throw new OpenAiAdministrationError(
          "REALTIME_WEB_SEARCH_INCOMPLETE",
          502,
          "The live voice web search did not complete.",
        );
      }
      snapshot = await getAiCommandSnapshotWithRuntime(
        context.runtime,
        context.userId,
        conversation.id,
      );
    } else if (
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.CREATE_PDF ||
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.REVISE_ARTIFACT
    ) {
      const title =
        typeof validation.arguments.title === "string" ? validation.arguments.title.trim() : "";
      const instructions =
        typeof validation.arguments.instructions === "string"
          ? validation.arguments.instructions.trim()
          : "";
      if (title) requireCredentialSafeContent(title);
      if (instructions) requireCredentialSafeContent(instructions);
      const generated = await generateExecutivePdfArtifact({
        runtime: context.runtime,
        userId: context.userId,
        correlationId: context.correlationId,
        request: {
          conversationId: conversation.id,
          ...(title ? { title } : {}),
          ...(typeof validation.arguments.template === "string"
            ? {
                template: validation.arguments.template as
                  "executive_briefing" | "lead_review_brief" | "research_brief" | "decision_memo",
              }
            : {}),
          ...(typeof validation.arguments.outputLength === "string"
            ? {
                outputLength: validation.arguments.outputLength as
                  "one_page" | "two_pages" | "concise" | "standard" | "detailed",
              }
            : {}),
          ...(instructions ? { instructions } : {}),
          ...(typeof validation.arguments.leadId === "string"
            ? { leadId: validation.arguments.leadId }
            : {}),
          ...(typeof validation.arguments.presentationRunId === "string"
            ? { presentationRunId: validation.arguments.presentationRunId }
            : {}),
          ...(typeof validation.arguments.parentArtifactId === "string"
            ? { parentArtifactId: validation.arguments.parentArtifactId }
            : {}),
          provider: "openai",
        },
      });
      await context.runtime.phase1.createWorkspaceArtifact({
        conversationId: conversation.id,
        requestedByUserId: context.userId,
        type: "help",
        title: generated.specification.title,
        subtitle: "DRAFT — HUMAN REVIEW REQUIRED",
        state: "ready",
        payload: generated.workspacePayload,
        sources: generated.specification.sourceCitations.map((citation) => ({
          id: citation.id,
          type: "web-source",
          title: citation.title,
          href: citation.url,
        })),
        links: [
          { label: "Download PDF", href: generated.downloadPath },
          ...generated.specification.beaRecordReferences
            .filter((record) => record.type === "lead")
            .map((record) => ({ label: record.label, href: `/leads/${record.id}` })),
        ],
        requiredPermissions: generated.specification.requiredPermissions,
      });
      snapshot = await getAiCommandSnapshotWithRuntime(
        context.runtime,
        context.userId,
        conversation.id,
      );
    } else if (
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.OPEN_ARTIFACT ||
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.DOWNLOAD_ARTIFACT
    ) {
      const artifactId =
        typeof validation.arguments.artifactId === "string"
          ? validation.arguments.artifactId.trim()
          : "";
      if (!artifactId) {
        throw new OpenAiAdministrationError(
          "INVALID_REALTIME_TOOL_ARGUMENTS",
          400,
          "The Realtime tool arguments are invalid.",
        );
      }
      requireCredentialSafeContent(artifactId);
      const loaded = await loadExecutivePdfWorkspace({
        runtime: context.runtime,
        userId: context.userId,
        artifactId,
      });
      if (!loaded) {
        throw new OpenAiAdministrationError(
          "ARTIFACT_NOT_FOUND",
          404,
          "The requested PDF artifact was not found.",
        );
      }
      await context.runtime.phase1.createWorkspaceArtifact({
        conversationId: conversation.id,
        requestedByUserId: context.userId,
        type: "help",
        title: loaded.specification.title,
        subtitle: "DRAFT — HUMAN REVIEW REQUIRED",
        state: "ready",
        payload: loaded.workspacePayload,
        sources: loaded.specification.sourceCitations.map((citation) => ({
          id: citation.id,
          type: "web-source",
          title: citation.title,
          href: citation.url,
        })),
        links: [{ label: "Download PDF", href: loaded.downloadPath }],
        requiredPermissions: loaded.specification.requiredPermissions,
      });
      await context.runtime.repository.record({
        eventType:
          validation.tool.name === BEA_REALTIME_TOOL_NAMES.DOWNLOAD_ARTIFACT
            ? "artifact.downloaded"
            : "artifact.opened",
        action: "ai-command.realtime.tool.execute",
        outcome: "succeeded",
        actorUserId: context.userId,
        resourceType: "generated-artifact",
        resourceId: loaded.artifactId,
        correlationId: context.correlationId,
        metadata: { storageId: loaded.storageId, tool: validation.tool.name },
      });
      snapshot = await getAiCommandSnapshotWithRuntime(
        context.runtime,
        context.userId,
        conversation.id,
      );
    } else if (validation.tool.name === BEA_REALTIME_TOOL_NAMES.LIST_ARTIFACTS) {
      const artifacts = await listConversationPdfArtifacts({
        runtime: context.runtime,
        userId: context.userId,
        conversationId: conversation.id,
        limit: typeof validation.arguments.limit === "number" ? validation.arguments.limit : 10,
      });
      snapshot = await getAiCommandSnapshotWithRuntime(
        context.runtime,
        context.userId,
        conversation.id,
      );
      const listed = {
        ...toolOutput(snapshot),
        summary:
          artifacts.length === 0
            ? "No authorized PDF artifacts are available in this conversation."
            : artifacts
                .map((item) => `${item.title} (v${item.version})`)
                .join("; ")
                .slice(0, 8_000),
        artifacts: artifacts.map((item) => ({
          id: item.id,
          title: item.title,
          version: item.version,
          createdAt: item.createdAt,
        })),
      };
      await context.runtime.repository.record({
        eventType: "ai-provider.realtime-tool-completed",
        action: "ai-command.realtime.tool.execute",
        outcome: "succeeded",
        actorUserId: context.userId,
        resourceType: "ai-realtime-session",
        resourceId: session.id,
        correlationId: context.correlationId,
        metadata: {
          conversationId: conversation.id,
          callId: input.callId,
          tool: validation.tool.name,
          workspaceType: snapshot.artifact.type,
          actionConfirmationRequired: false,
        },
      });
      return apiJson({ callId: input.callId, output: listed }, context.correlationId);
    } else if (
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.SHOW_DIGITAL_WORKFORCE ||
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.SHOW_AGENT_RUN ||
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.LIST_AGENTS ||
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.GET_AGENT ||
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.GET_AGENT_RUN ||
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.CANCEL_AGENT_RUN ||
      validation.tool.name === BEA_REALTIME_TOOL_NAMES.DELEGATE_TO_AGENT
    ) {
      const message =
        validation.tool.name === BEA_REALTIME_TOOL_NAMES.CANCEL_AGENT_RUN
          ? "Stop this run"
          : validation.tool.name === BEA_REALTIME_TOOL_NAMES.GET_AGENT
            ? "Open the Research Agent"
            : validation.tool.name === BEA_REALTIME_TOOL_NAMES.SHOW_AGENT_RUN ||
                validation.tool.name === BEA_REALTIME_TOOL_NAMES.GET_AGENT_RUN
              ? "Which agents are working right now?"
              : "Show me my digital workforce";
      const reservation = await reserveAiCommandRequestWithRuntime(context.runtime, {
        userId: context.userId,
        conversationId: conversation.id,
        correlationId: context.correlationId,
      });
      snapshot = await processAiCommandMessageWithRuntime(context.runtime, {
        userId: context.userId,
        conversationId: conversation.id,
        message,
        requestId: reservation.requestId,
        generation: reservation.generation,
        correlationId: context.correlationId,
      });
    } else if (validation.tool.name === BEA_REALTIME_TOOL_NAMES.SHOW_WORKSPACE) {
      const command = showWorkspaceCommand(validation.arguments);
      if (command === null) {
        snapshot = await getAiCommandSnapshotWithRuntime(
          context.runtime,
          context.userId,
          conversation.id,
        );
      } else {
        const reservation = await reserveAiCommandRequestWithRuntime(context.runtime, {
          userId: context.userId,
          conversationId: conversation.id,
          correlationId: context.correlationId,
        });
        snapshot = await processAiCommandMessageWithRuntime(context.runtime, {
          userId: context.userId,
          conversationId: conversation.id,
          message: command,
          requestId: reservation.requestId,
          generation: reservation.generation,
          correlationId: context.correlationId,
        });
      }
    } else {
      const message =
        validation.tool.name === BEA_REALTIME_TOOL_NAMES.QUERY_RECORDS
          ? argumentText(validation.arguments, "request")
          : validation.tool.name === BEA_REALTIME_TOOL_NAMES.CONNECTOR_HEALTH
            ? "Show connector health"
            : validation.tool.name === BEA_REALTIME_TOOL_NAMES.WORKFLOW_HISTORY
              ? validation.arguments.latestOnly === true
                ? "Show latest workflow run"
                : "Show recent workflow runs"
              : argumentText(validation.arguments, "request");
      const reservation = await reserveAiCommandRequestWithRuntime(context.runtime, {
        userId: context.userId,
        conversationId: conversation.id,
        correlationId: context.correlationId,
      });
      snapshot = await processAiCommandMessageWithRuntime(context.runtime, {
        userId: context.userId,
        conversationId: conversation.id,
        message,
        requestId: reservation.requestId,
        generation: reservation.generation,
        correlationId: context.correlationId,
      });
    }

    const output = toolOutput(snapshot);
    await context.runtime.repository.record({
      eventType: "ai-provider.realtime-tool-completed",
      action: "ai-command.realtime.tool.execute",
      outcome: "succeeded",
      actorUserId: context.userId,
      resourceType: "ai-realtime-session",
      resourceId: session.id,
      correlationId: context.correlationId,
      metadata: {
        conversationId: conversation.id,
        callId: input.callId,
        tool: validation.tool.name,
        workspaceType: snapshot.artifact.type,
        actionConfirmationRequired: output.actionConfirmationRequired,
      },
    });
    return apiJson({ callId: input.callId, output }, context.correlationId);
  } catch (error) {
    if (input && typeof input.sessionId === "string" && UUID.test(input.sessionId)) {
      await context.runtime.repository
        .record({
          eventType: "ai-provider.realtime-tool-failed",
          action: "ai-command.realtime.tool.execute",
          outcome: "failed",
          actorUserId: context.userId,
          resourceType: "ai-realtime-session",
          resourceId: input.sessionId,
          correlationId: context.correlationId,
          metadata: { tool: auditedTool },
        })
        .catch(() => undefined);
    }
    return openAiApiError(error, context.correlationId);
  }
}
