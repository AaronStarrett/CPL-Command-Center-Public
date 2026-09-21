import type { JsonObject } from "@bea/domain";
import type { AiToolDefinition } from "./contracts.js";

export const OPENAI_BUILT_IN_TOOL_NAMES = Object.freeze({
  WEB_SEARCH: "web_search",
  CODE_INTERPRETER: "code_interpreter",
  IMAGE_GENERATION: "image_generation",
} as const);

export const BEA_GENERATED_ARTIFACT_TOOL_NAMES = Object.freeze({
  RESEARCH: "bea_research",
  ANALYZE: "bea_analyze",
  CREATE_CHART: "bea_create_chart",
  CREATE_TABLE: "bea_create_table",
  CREATE_BOARD: "bea_create_board",
  CREATE_PDF: "bea_create_pdf",
  CREATE_IMAGE: "bea_create_image",
  OPEN_ARTIFACT: "bea_open_artifact",
  LIST_ARTIFACTS: "bea_list_artifacts",
  DOWNLOAD_ARTIFACT: "bea_download_artifact",
  REVISE_ARTIFACT: "bea_revise_artifact",
} as const);

export const BEA_REALTIME_TOOL_NAMES = Object.freeze({
  SEARCH_WEB: "search_web",
  QUERY_RECORDS: "bea_query_records",
  CONNECTOR_HEALTH: "bea_connector_health",
  WORKFLOW_HISTORY: "bea_workflow_history",
  PREVIEW_TASK: "bea_preview_task",
  SHOW_WORKSPACE: "bea_show_workspace",
  CREATE_PDF: "bea_create_pdf",
  OPEN_ARTIFACT: "bea_open_artifact",
  LIST_ARTIFACTS: "bea_list_artifacts",
  DOWNLOAD_ARTIFACT: "bea_download_artifact",
  REVISE_ARTIFACT: "bea_revise_artifact",
  DELEGATE_TO_AGENT: "bea_delegate_to_agent",
  GET_AGENT: "bea_get_agent",
  LIST_AGENTS: "bea_list_agents",
  GET_AGENT_RUN: "bea_get_agent_run",
  CANCEL_AGENT_RUN: "bea_cancel_agent_run",
  SHOW_AGENT_RUN: "bea_show_agent_run",
  SHOW_DIGITAL_WORKFORCE: "bea_show_digital_workforce",
} as const);

function proposal(
  name: (typeof BEA_GENERATED_ARTIFACT_TOOL_NAMES)[keyof typeof BEA_GENERATED_ARTIFACT_TOOL_NAMES],
  description: string,
  requiredPermissions: readonly string[],
  parameters: AiToolDefinition["parameters"],
  effect: "read" | "preview" = "preview",
): AiToolDefinition {
  return {
    name,
    description,
    parameters,
    strict: true,
    requiredPermissions,
    effect,
  };
}

/**
 * Registered tools only describe a proposal. The application must validate
 * arguments and permissions and must never execute arbitrary code or a write
 * directly from a provider tool call.
 */
export const BEA_GENERATED_ARTIFACT_TOOLS: readonly AiToolDefinition[] = Object.freeze([
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.RESEARCH,
    "Propose a sourced research artifact.",
    ["ai-command.run", "search.view", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        query: { type: "string", minLength: 1, maxLength: 2000 },
        sourceIds: { type: "array", items: { type: "string" }, maxItems: 50 },
      },
      required: ["title", "query"],
    },
  ),
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.ANALYZE,
    "Propose an analysis artifact without executing arbitrary code.",
    ["ai-command.run", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        objective: { type: "string", minLength: 1, maxLength: 2000 },
        sourceArtifactIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
      },
      required: ["title", "objective", "sourceArtifactIds"],
    },
  ),
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.CREATE_CHART,
    "Propose a chart artifact.",
    ["ai-command.run", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        sourceArtifactId: { type: "string", minLength: 1, maxLength: 100 },
        chartType: {
          type: "string",
          enum: [
            "line",
            "bar",
            "stacked_bar",
            "area",
            "pie",
            "pie_or_donut",
            "scatter",
            "timeline",
            "single_metric",
            "comparison",
          ],
        },
        xField: { type: "string", minLength: 1, maxLength: 100 },
        yFields: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 12 },
      },
      required: ["title", "sourceArtifactId", "chartType", "xField", "yFields"],
    },
  ),
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.CREATE_TABLE,
    "Propose a table artifact.",
    ["ai-command.run", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        sourceArtifactId: { type: "string", minLength: 1, maxLength: 100 },
        columns: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 40 },
      },
      required: ["title", "sourceArtifactId", "columns"],
    },
  ),
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.CREATE_BOARD,
    "Propose a board artifact.",
    ["ai-command.run", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        columns: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 12 },
        sourceArtifactIds: { type: "array", items: { type: "string" }, maxItems: 50 },
      },
      required: ["title", "columns"],
    },
  ),
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.CREATE_PDF,
    "Propose a BEA-branded PDF; the application owns layout, branding, storage, and download. Supply a title and optional template, length, lead, or presentation identifiers. Never send HTML, CSS, file paths, or credentials.",
    ["ai-command.run", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        template: {
          type: "string",
          enum: ["executive_briefing", "lead_review_brief", "research_brief", "decision_memo"],
        },
        outputLength: {
          type: "string",
          enum: ["one_page", "two_pages", "concise", "standard", "detailed"],
        },
        instructions: { type: "string", minLength: 1, maxLength: 2000 },
        leadId: { type: "string", minLength: 1, maxLength: 100 },
        presentationRunId: { type: "string", minLength: 1, maxLength: 100 },
        parentArtifactId: { type: "string", minLength: 1, maxLength: 100 },
        sourceArtifactIds: { type: "array", items: { type: "string" }, maxItems: 50 },
        pageSize: { type: "string", enum: ["letter", "a4"] },
      },
      required: ["title"],
    },
  ),
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.CREATE_IMAGE,
    "Propose one image-generation request; paid execution remains policy-gated.",
    ["ai-command.run", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"] },
        count: { type: "integer", const: 1 },
      },
      required: ["title", "prompt", "size", "count"],
    },
  ),
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.OPEN_ARTIFACT,
    "Open an accessible existing artifact.",
    ["ai-command.view", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: { artifactId: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["artifactId"],
    },
    "read",
  ),
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.LIST_ARTIFACTS,
    "List accessible generated artifacts.",
    ["ai-command.view", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: [
            "research_report",
            "source_board",
            "chart",
            "graph",
            "table",
            "metric_summary",
            "timeline",
            "comparison",
            "pdf",
            "image",
            "data_file",
            "text_document",
            "analysis_result",
            "web_search_result",
            "code_interpreter_output",
            "research_presentation",
          ],
        },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["limit"],
    },
    "read",
  ),
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.DOWNLOAD_ARTIFACT,
    "Propose downloading an accessible generated artifact.",
    ["ai-command.view", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: { artifactId: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["artifactId"],
    },
    "read",
  ),
  proposal(
    BEA_GENERATED_ARTIFACT_TOOL_NAMES.REVISE_ARTIFACT,
    "Propose a new immutable version of an existing BEA PDF from the authoritative specification. Never overwrite the original file.",
    ["ai-command.run", "documents.view"],
    {
      type: "object",
      additionalProperties: false,
      properties: {
        parentArtifactId: { type: "string", minLength: 1, maxLength: 100 },
        title: { type: "string", minLength: 1, maxLength: 160 },
        instructions: { type: "string", minLength: 1, maxLength: 2000 },
        outputLength: {
          type: "string",
          enum: ["one_page", "two_pages", "concise", "standard", "detailed"],
        },
      },
      required: ["parentArtifactId"],
    },
  ),
]);

/**
 * Realtime receives a deliberately smaller tool surface than text generation. Every tool is
 * executed by the authenticated BEA backend; the browser and model never receive an arbitrary URL
 * or a direct write primitive. Task creation stops at the existing confirmation-gated preview.
 */
export const BEA_REALTIME_TOOLS: readonly AiToolDefinition[] = Object.freeze<AiToolDefinition[]>([
  {
    name: BEA_REALTIME_TOOL_NAMES.SEARCH_WEB,
    description:
      "Search the current public web through BEA's server-authorized OpenAI Responses web_search path, persist one Research Presentation, and return the same evidence packet for voice narration and the right workspace.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string", minLength: 1, maxLength: 2000 } },
      required: ["query"],
    },
    strict: true,
    requiredPermissions: ["ai-command.run", "search.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.QUERY_RECORDS,
    description:
      "Run a permission-filtered read query against BEA's synthetic local business records.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { request: { type: "string", minLength: 1, maxLength: 2000 } },
      required: ["request"],
    },
    strict: true,
    requiredPermissions: ["ai-command.run"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.CONNECTOR_HEALTH,
    description:
      "Read BEA's connector-health registry. Business connectors remain simulated or disconnected.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    strict: true,
    requiredPermissions: ["ai-command.run", "ai-command.integration-health.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.WORKFLOW_HISTORY,
    description: "Read the recent permission-filtered BEA workflow-run history.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { latestOnly: { type: "boolean" } },
      required: [],
    },
    strict: true,
    requiredPermissions: ["ai-command.run", "workflow.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.PREVIEW_TASK,
    description:
      "Prepare an internal BEA task preview. This never creates or changes a task; the existing UI confirmation remains required.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { request: { type: "string", minLength: 1, maxLength: 2000 } },
      required: ["request"],
    },
    strict: true,
    requiredPermissions: ["ai-command.run", "tasks.view"],
    effect: "preview",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.SHOW_WORKSPACE,
    description:
      "Show an authorized existing BEA record or workspace artifact in the right pane without ending the voice session. Use a stable application record type and ID, never arbitrary HTML or URLs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "string",
          enum: [
            "artifact",
            "lead",
            "company",
            "contact",
            "task",
            "activity",
            "notification",
            "integration",
            "workflow-run",
          ],
        },
        id: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["target", "id"],
    },
    strict: true,
    requiredPermissions: ["ai-command.run"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.CREATE_PDF,
    description:
      "Create a BEA-branded executive PDF from the current authorized research, selected lead, or owner instructions. The application renders, stores, and displays the PDF. Never send HTML, CSS, filesystem paths, or credentials.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        template: {
          type: "string",
          enum: ["executive_briefing", "lead_review_brief", "research_brief", "decision_memo"],
        },
        outputLength: {
          type: "string",
          enum: ["one_page", "two_pages", "concise", "standard", "detailed"],
        },
        instructions: { type: "string", minLength: 1, maxLength: 2000 },
        leadId: { type: "string", minLength: 1, maxLength: 100 },
        presentationRunId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: [],
    },
    strict: true,
    requiredPermissions: ["ai-command.run", "documents.view"],
    effect: "preview",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.OPEN_ARTIFACT,
    description: "Open an authorized existing generated artifact in the right workspace.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { artifactId: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["artifactId"],
    },
    strict: true,
    requiredPermissions: ["ai-command.view", "documents.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.LIST_ARTIFACTS,
    description: "List authorized generated PDF artifacts for this conversation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
      required: [],
    },
    strict: true,
    requiredPermissions: ["ai-command.view", "documents.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.DOWNLOAD_ARTIFACT,
    description:
      "Prepare an authorized download of a generated PDF. The application serves the file; do not invent a filesystem path.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { artifactId: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["artifactId"],
    },
    strict: true,
    requiredPermissions: ["ai-command.view", "documents.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.REVISE_ARTIFACT,
    description:
      "Create a new immutable PDF version from the authoritative specification. Prior versions remain available.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        parentArtifactId: { type: "string", minLength: 1, maxLength: 100 },
        instructions: { type: "string", minLength: 1, maxLength: 2000 },
        outputLength: {
          type: "string",
          enum: ["one_page", "two_pages", "concise", "standard", "detailed"],
        },
        title: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["parentArtifactId"],
    },
    strict: true,
    requiredPermissions: ["ai-command.run", "documents.view"],
    effect: "preview",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.LIST_AGENTS,
    description: "List authorized Digital Agents. Agents are not human security principals.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string", minLength: 1, maxLength: 80 } },
      required: [],
    },
    strict: true,
    requiredPermissions: ["digital-workforce.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.GET_AGENT,
    description: "Get one authorized Digital Agent identity and published version summary.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { agentId: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["agentId"],
    },
    strict: true,
    requiredPermissions: ["digital-workforce.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.SHOW_DIGITAL_WORKFORCE,
    description: "Open the Digital Workforce organization in the right workspace.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    strict: true,
    requiredPermissions: ["digital-workforce.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.GET_AGENT_RUN,
    description: "Get an authorized Digital Workforce run, steps, and handoffs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { runId: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["runId"],
    },
    strict: true,
    requiredPermissions: ["digital-workforce.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.SHOW_AGENT_RUN,
    description: "Open an authorized Digital Workforce run trace in the right workspace.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { runId: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["runId"],
    },
    strict: true,
    requiredPermissions: ["digital-workforce.view"],
    effect: "read",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.DELEGATE_TO_AGENT,
    description:
      "Propose a bounded handoff to an approved Digital Agent. The application validates the plan; the model cannot expand permissions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        toAgentId: { type: "string", minLength: 1, maxLength: 100 },
        reason: { type: "string", minLength: 1, maxLength: 500 },
        requestedDeliverable: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["toAgentId", "reason", "requestedDeliverable"],
    },
    strict: true,
    requiredPermissions: ["digital-workforce.run"],
    effect: "preview",
  },
  {
    name: BEA_REALTIME_TOOL_NAMES.CANCEL_AGENT_RUN,
    description: "Request cancellation of an authorized Digital Workforce run.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1, maxLength: 100 },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["runId"],
    },
    strict: true,
    requiredPermissions: ["digital-workforce.cancel"],
    effect: "preview",
  },
]);

export function findRegisteredArtifactTool(name: string): AiToolDefinition | null {
  return BEA_GENERATED_ARTIFACT_TOOLS.find((tool) => tool.name === name) ?? null;
}

function schemaRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function matchesSchema(value: unknown, schemaValue: unknown): boolean {
  const schema = schemaRecord(schemaValue);
  if (!schema || typeof schema.type !== "string") return false;
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
    return true;
  }
  if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) return false;
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) return false;
    if (typeof schema.maximum === "number" && (value as number) > schema.maximum) return false;
    if (typeof schema.const === "number" && value !== schema.const) return false;
    return true;
  }
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    return value.every((item) => matchesSchema(item, schema.items));
  }
  if (schema.type === "object") {
    const object = schemaRecord(value);
    const properties = schemaRecord(schema.properties);
    if (!object || !properties) return false;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    if (!required.every((key) => Object.hasOwn(object, key))) return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(object).some((key) => !Object.hasOwn(properties, key))
    ) {
      return false;
    }
    return Object.entries(object).every(([key, item]) => matchesSchema(item, properties[key]));
  }
  return false;
}

export type RegisteredArtifactToolValidation =
  | { readonly ok: true; readonly tool: AiToolDefinition; readonly arguments: JsonObject }
  | { readonly ok: false; readonly reason: "unknown-tool" | "invalid-arguments" };

export function validateRegisteredArtifactToolCall(
  name: string,
  argumentsValue: unknown,
): RegisteredArtifactToolValidation {
  const tool = findRegisteredArtifactTool(name);
  if (!tool) return { ok: false, reason: "unknown-tool" };
  const argumentsObject = schemaRecord(argumentsValue);
  if (!argumentsObject || !matchesSchema(argumentsObject, tool.parameters)) {
    return { ok: false, reason: "invalid-arguments" };
  }
  return { ok: true, tool, arguments: argumentsObject as JsonObject };
}

export function findRegisteredRealtimeTool(name: string): AiToolDefinition | null {
  return BEA_REALTIME_TOOLS.find((tool) => tool.name === name) ?? null;
}

export function validateRegisteredRealtimeToolCall(
  name: string,
  argumentsValue: unknown,
): RegisteredArtifactToolValidation {
  const tool = findRegisteredRealtimeTool(name);
  if (!tool) return { ok: false, reason: "unknown-tool" };
  const argumentsObject = schemaRecord(argumentsValue);
  if (!argumentsObject || !matchesSchema(argumentsObject, tool.parameters)) {
    return { ok: false, reason: "invalid-arguments" };
  }
  return { ok: true, tool, arguments: argumentsObject as JsonObject };
}
