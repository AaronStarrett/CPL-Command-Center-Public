import { describe, expect, it } from "vitest";

import {
  BEA_REALTIME_TOOL_NAMES,
  BEA_REALTIME_TOOLS,
  validateRegisteredRealtimeToolCall,
} from "../../packages/ai/src/tools.js";

describe("Phase 1.3 Realtime tool registry", () => {
  it("exposes only the approved read or preview tools", () => {
    expect(BEA_REALTIME_TOOLS.map((tool) => tool.name)).toEqual([
      BEA_REALTIME_TOOL_NAMES.SEARCH_WEB,
      BEA_REALTIME_TOOL_NAMES.QUERY_RECORDS,
      BEA_REALTIME_TOOL_NAMES.CONNECTOR_HEALTH,
      BEA_REALTIME_TOOL_NAMES.WORKFLOW_HISTORY,
      BEA_REALTIME_TOOL_NAMES.PREVIEW_TASK,
      BEA_REALTIME_TOOL_NAMES.SHOW_WORKSPACE,
      BEA_REALTIME_TOOL_NAMES.CREATE_PDF,
      BEA_REALTIME_TOOL_NAMES.OPEN_ARTIFACT,
      BEA_REALTIME_TOOL_NAMES.LIST_ARTIFACTS,
      BEA_REALTIME_TOOL_NAMES.DOWNLOAD_ARTIFACT,
      BEA_REALTIME_TOOL_NAMES.REVISE_ARTIFACT,
      BEA_REALTIME_TOOL_NAMES.LIST_AGENTS,
      BEA_REALTIME_TOOL_NAMES.GET_AGENT,
      BEA_REALTIME_TOOL_NAMES.SHOW_DIGITAL_WORKFORCE,
      BEA_REALTIME_TOOL_NAMES.GET_AGENT_RUN,
      BEA_REALTIME_TOOL_NAMES.SHOW_AGENT_RUN,
      BEA_REALTIME_TOOL_NAMES.DELEGATE_TO_AGENT,
      BEA_REALTIME_TOOL_NAMES.CANCEL_AGENT_RUN,
    ]);
    expect(
      BEA_REALTIME_TOOLS.every((tool) => tool.effect === "read" || tool.effect === "preview"),
    ).toBe(true);
    expect(BEA_REALTIME_TOOLS.find((tool) => tool.name === "bea_preview_task")?.effect).toBe(
      "preview",
    );
  });

  it("accepts strict registered arguments and rejects arbitrary URLs, writes, or extra keys", () => {
    expect(
      validateRegisteredRealtimeToolCall("search_web", {
        query: "latest building-envelope inspection guidance",
      }),
    ).toMatchObject({ ok: true, tool: { effect: "read" } });
    expect(
      validateRegisteredRealtimeToolCall("bea_workflow_history", { latestOnly: true }),
    ).toMatchObject({ ok: true });
    expect(
      validateRegisteredRealtimeToolCall("bea_show_workspace", {
        target: "lead",
        id: "a1000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ ok: true, tool: { effect: "read" } });
    expect(
      validateRegisteredRealtimeToolCall("search_web", {
        query: "approved query",
        url: "https://arbitrary.example",
      }),
    ).toEqual({ ok: false, reason: "invalid-arguments" });
    expect(validateRegisteredRealtimeToolCall("create_task", { title: "Bypass" })).toEqual({
      ok: false,
      reason: "unknown-tool",
    });
  });
});
