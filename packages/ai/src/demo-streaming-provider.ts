import type { JsonObject } from "@bea/domain";
import type {
  AiAuthorizedInputFileUpload,
  AiCommandProvider,
  AiConnectionTestResult,
  AiConversationRequest,
  AiConversationResult,
  AiGeneratedArtifactReference,
  AiInputFileReference,
  AiModelMetadata,
  AiRealtimeClientAuthorization,
  AiRealtimeSessionConfig,
  AiRequestOptions,
  AiResponseStreamEvent,
} from "./contracts.js";
import { DEMO_MODEL_FIXTURES } from "./capabilities.js";
import { isProtectedAssistantPolicyRequest } from "./executive-context.js";
import { DeterministicMockAiProvider } from "./mock-provider.js";

function demoToolName(input: string): string | null {
  const normalized = input.toLowerCase();
  if (normalized.includes("chart")) return "bea_create_chart";
  if (normalized.includes("table") || normalized.includes("spreadsheet")) return "bea_create_table";
  if (normalized.includes("board")) return "bea_create_board";
  if (normalized.includes("pdf")) return "bea_create_pdf";
  if (normalized.includes("image")) return "bea_create_image";
  if (normalized.includes("research")) return "bea_research";
  if (normalized.includes("analy")) return "bea_analyze";
  return null;
}

function demoToolArguments(
  name: string,
  input: string,
  sourceArtifactIds: readonly string[],
): JsonObject {
  const title = "Synthetic artifact preview";
  const sourceArtifactId = sourceArtifactIds[0] ?? "art_demo_source_data";
  switch (name) {
    case "bea_research":
      return { title, query: input, sourceIds: ["demo-source-bea-operations"] };
    case "bea_analyze":
      return { title, objective: input, sourceArtifactIds: [...sourceArtifactIds] };
    case "bea_create_chart":
      return {
        title,
        sourceArtifactId,
        chartType: "bar",
        xField: "system",
        yFields: ["priority_score"],
      };
    case "bea_create_table":
      return { title, sourceArtifactId, columns: ["system", "observation", "priority"] };
    case "bea_create_board":
      return {
        title,
        columns: ["Source", "Finding", "Status"],
        sourceArtifactIds: [...sourceArtifactIds],
      };
    case "bea_create_pdf":
      return { title, sourceArtifactIds: [...sourceArtifactIds], pageSize: "letter" };
    case "bea_create_image":
      return {
        title,
        prompt: input,
        size: "1024x1024",
        count: 1,
      };
    default:
      return {};
  }
}

function executiveDemoText(request: AiConversationRequest, baseText: string): string {
  if (request.persona?.kind !== "executive-business-partner") return baseText;
  const preferredName = request.persona.preferredName?.trim() || "Owner";
  const normalized = request.input.toLowerCase();
  if (isProtectedAssistantPolicyRequest(request.input)) {
    return `${preferredName}, I can’t reveal or disable protected instructions or private profile data. I can still help with the authorized business objective.`;
  }
  if (/cycl|bike|trail|mountain biking|outdoor recreation/u.test(normalized)) {
    return `${preferredName}, I’d approach this like a well-planned ride: choose the objective and constraints first, then sequence the route, resources, and checkpoints. Recommendation: define the desired outcome and timing; the main risks are capacity and unclear ownership. Next, assign one owner and a measurable checkpoint.`;
  }
  return `${preferredName}, my recommendation is to prioritize the highest-impact authorized next action, assign a clear owner, and set a near-term checkpoint. Why it matters: that converts visibility into execution while protecting team capacity. Key risks are incomplete data and diffuse ownership. Next: confirm the decision owner, evidence, and due date. ${baseText}`;
}

export class DemoStreamingAiProvider
  extends DeterministicMockAiProvider
  implements AiCommandProvider
{
  readonly providerKey = "demo";

  async generateResponse(request: AiConversationRequest): Promise<AiConversationResult> {
    this.assertTestOnly();
    const toolName = demoToolName(request.input);
    const registeredTool = request.tools?.find((tool) => tool.name === toolName);
    const requestedSourceArtifactIds =
      request.files?.flatMap((file) => (file.fileId ? [file.fileId] : [])) ?? [];
    const sourceArtifactIds =
      requestedSourceArtifactIds.length > 0 ? requestedSourceArtifactIds : ["art_demo_source_data"];
    const responseId = `demo-${request.options.requestId}`;
    const webSearch =
      request.webSearch ||
      request.builtInTools?.some((tool) => tool.type === "web_search") === true;
    const citations = webSearch
      ? [
          {
            id: `${responseId}:citation:0`,
            title: "Synthetic CPL research fixture",
            url: "https://example.invalid/bea-demo-research",
            domain: "example.invalid",
            retrievedAt: new Date().toISOString(),
            simulated: true,
          },
        ]
      : [];
    const webSources = citations.map((citation) => ({
      id: `${responseId}:source:0`,
      title: citation.title,
      url: citation.url,
      domain: citation.domain,
      retrievedAt: citation.retrievedAt,
      toolCallId: `${responseId}:web-search:0`,
      simulated: true,
    }));
    const toolCalls = registeredTool
      ? [
          {
            id: `${responseId}:tool:0`,
            name: registeredTool.name,
            arguments: demoToolArguments(registeredTool.name, request.input, sourceArtifactIds),
            status: "proposed" as const,
          },
        ]
      : [];
    const generatedArtifacts: AiGeneratedArtifactReference[] = registeredTool
      ? [
          {
            id: `${responseId}:artifact:0`,
            kind: registeredTool.name === "bea_create_image" ? "generated_image" : "container_file",
            providerItemId: `${responseId}:tool:0`,
            filename:
              registeredTool.name === "bea_create_image" ? "demo-image.png" : "demo-artifact.json",
            simulated: true,
            rawBytesPersisted: false,
          },
        ]
      : [];
    const baseText = registeredTool
      ? `SIMULATED: I prepared a ${registeredTool.name.replaceAll("_", " ")} proposal for review.`
      : webSearch
        ? "SIMULATED: Synthetic web research is ready with a clearly labeled citation."
        : `SIMULATED: ${request.input.trim() || "Demo response ready."}`;
    const text = executiveDemoText(request, baseText);
    const inputTokens = Math.max(1, Math.ceil(request.input.length / 4));
    const outputTokens = Math.max(1, Math.ceil(text.length / 4));
    return {
      responseId,
      model: request.model || "deterministic-demo-router",
      text,
      citations,
      webSources,
      fileSources: [],
      toolCalls,
      generatedArtifacts,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      completedAt: new Date().toISOString(),
      simulated: true,
    };
  }

  async *streamResponse(request: AiConversationRequest): AsyncIterable<AiResponseStreamEvent> {
    const result = await this.generateResponse(request);
    if (request.options.signal?.aborted) {
      yield { type: "response.cancelled", requestId: request.options.requestId };
      return;
    }
    yield {
      type: "response.started",
      requestId: request.options.requestId,
      providerResponseId: result.responseId,
      model: result.model,
      simulated: true,
    };
    for (let offset = 0; offset < result.text.length; offset += 16) {
      if (request.options.signal?.aborted) {
        yield { type: "response.cancelled", requestId: request.options.requestId };
        return;
      }
      yield { type: "response.output_text.delta", delta: result.text.slice(offset, offset + 16) };
    }
    for (const citation of result.citations) yield { type: "response.citation", citation };
    for (const source of result.webSources) yield { type: "response.web_source", source };
    for (const source of result.fileSources ?? []) yield { type: "response.file_source", source };
    for (const toolCall of result.toolCalls) yield { type: "response.tool_call", toolCall };
    for (const artifact of result.generatedArtifacts) {
      yield { type: "response.generated_artifact", artifact };
    }
    if (result.usage) yield { type: "response.usage", usage: result.usage };
    yield { type: "response.completed", result };
  }

  async listModels(): Promise<readonly AiModelMetadata[]> {
    this.assertTestOnly();
    return DEMO_MODEL_FIXTURES;
  }

  async testConnection(): Promise<AiConnectionTestResult> {
    this.assertTestOnly();
    return {
      provider: "demo",
      healthy: true,
      authenticated: false,
      testedAt: new Date().toISOString(),
      safeMessage: "Demo provider ready. No external provider is connected.",
      modelCount: DEMO_MODEL_FIXTURES.length,
    };
  }

  async createRealtimeClientAuthorization(
    configuration: AiRealtimeSessionConfig,
    options: AiRequestOptions,
  ): Promise<AiRealtimeClientAuthorization> {
    this.assertTestOnly();
    return {
      provider: "demo",
      clientSecret: `demo-no-network-${options.requestId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sessionId: `demo-session-${options.requestId}`,
      model: configuration.model,
      voice: configuration.voice,
      simulated: true,
    };
  }

  async uploadInputFile(input: AiAuthorizedInputFileUpload): Promise<AiInputFileReference> {
    this.assertTestOnly();
    if (!input.ownerId.trim() || !input.artifactId.trim() || input.bytes.byteLength < 1) {
      throw new Error("Demo input file must be an authorized non-empty artifact.");
    }
    return { type: "input_file", fileId: input.artifactId, detail: input.detail ?? "auto" };
  }
}
