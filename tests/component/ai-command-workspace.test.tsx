import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AI_ORB_STATE_LABELS,
  AiCommandWorkspace,
} from "../../apps/web/components/ai-command-workspace";
import type {
  AiCommandArtifactView,
  AiCommandSnapshot,
} from "../../apps/web/lib/ai-command-contracts";
import { setTestRouterReplace } from "./stubs/next-navigation";

const navigation = { replace: vi.fn() };

function artifact(overrides: Partial<AiCommandArtifactView> = {}): AiCommandArtifactView {
  return {
    id: "artifact-1",
    type: "help",
    title: "AI Command capabilities",
    subtitle: "Deterministic, permission-aware Demo Mode",
    state: "ready",
    payload: { commands: ["Show open tasks"] },
    sources: [],
    links: [],
    requiredPermissions: ["ai-command.view"],
    createdAt: "2026-08-18T12:00:00.000Z",
    errorCode: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AiCommandSnapshot> = {}): AiCommandSnapshot {
  const conversation = {
    id: "conversation-1",
    title: "AI Command test conversation",
    updatedAt: "2026-08-18T12:00:00.000Z",
  };
  return {
    conversation,
    conversations: [conversation],
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "I am the simulated BEA demo assistant.",
        createdAt: "2026-08-18T12:00:00.000Z",
        provider: "simulated",
        executionMs: 0,
        links: [
          { label: "Safe message record", href: "/tasks/task-1" },
          { label: "Unsafe message record", href: "/\\evil.example/path" },
        ],
      },
    ],
    artifact: artifact(),
    provider: {
      name: "BEA deterministic demo assistant",
      mode: "SIMULATED",
      model: "deterministic-demo-router",
      routerVersion: "test-router-v1",
      liveConnected: false,
      simulated: true,
    },
    permissions: { canExecuteTaskAction: true },
    actingUser: {
      id: "10000000-0000-4000-8000-000000000001",
      displayName: "Workspace Owner",
      title: "Chief Executive Officer",
    },
    assistant: {
      kind: "executive-business-partner",
      preferredName: "Owner",
      label: "BEA Executive Business Partner",
      subtitle: "Your executive partner for BEA operations",
      promptVersion: "bea-executive-business-partner-v1",
      executiveProfileVersion: "andrew-executive-profile-v1",
      brandPolicyVersion: "bea-artifact-brand-v1",
      artifactTemplateVersion: "bea-artifact-template-v1",
    },
    ...overrides,
  };
}

function jsonResponse(value: AiCommandSnapshot, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function reservationResponse(generation = 1, requestId = "a1100000-0000-4000-8000-000000000001") {
  return new Response(JSON.stringify({ generation, requestId }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

function providerSnapshot(
  providerOverrides: Record<string, unknown> = {},
  snapshotOverrides: Partial<AiCommandSnapshot> = {},
): AiCommandSnapshot {
  return snapshot({
    ...snapshotOverrides,
    provider: {
      label: "BEA AI Command",
      mode: "demo",
      simulated: true,
      liveConnected: false,
      streaming: true,
      webSearchAllowed: true,
      ...providerOverrides,
    } as unknown as AiCommandSnapshot["provider"],
  });
}

function sseFrame(type: string, payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`,
  );
}

function eventStreamResponse(
  events: readonly (readonly [type: string, payload: Record<string, unknown>])[],
): Response {
  const decoder = new TextDecoder();
  return new Response(
    events.map(([type, payload]) => decoder.decode(sseFrame(type, payload))).join(""),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

describe("AI Command workspace", () => {
  beforeEach(() => {
    navigation.replace.mockReset();
    setTestRouterReplace(navigation.replace);
    vi.stubGlobal("fetch", vi.fn());
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    window.history.replaceState(null, "", "/ai-command");
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the split conversation/workspace contract with an explicit test-only label", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);

    const root = screen.getByTestId("ai-command-workspace");
    expect(within(root).getByRole("tablist", { name: "AI Command panels" })).toBeInTheDocument();
    expect(within(root).getByRole("tabpanel", { name: "Conversation" })).toHaveAttribute(
      "data-mobile-active",
      "true",
    );
    expect(within(root).getByRole("tabpanel", { name: "Workspace" })).toHaveAttribute(
      "data-mobile-active",
      "false",
    );
    expect(within(root).getByText("TEST-ONLY", { exact: true })).toBeInTheDocument();
    expect(within(root).getByText("Simulated · 0 ms", { exact: true })).toBeInTheDocument();
    expect(within(root).getByText("Ready", { selector: '[role="status"]' })).toBeInTheDocument();
    expect(within(root).getByText(/Your executive partner for BEA operations/u)).toHaveClass(
      "bea-visually-hidden",
    );
    expect(within(root).queryByLabelText("AI Command component status")).not.toBeInTheDocument();
    expect(within(root).getByRole("link", { name: "Safe message record" })).toHaveAttribute(
      "href",
      "/tasks/task-1",
    );
    expect(within(root).getByText("Unsafe message record").closest("a")).toBeNull();
  });

  it("labels selected but inactive OpenAI as setup required", () => {
    render(
      <AiCommandWorkspace
        initialSnapshot={providerSnapshot({
          mode: "openai",
          simulated: false,
          liveConnected: false,
        })}
      />,
    );

    const root = screen.getByTestId("ai-command-workspace");
    expect(within(root).getByText("SETUP REQUIRED", { exact: true })).toBeInTheDocument();
    expect(within(root).queryByLabelText("AI Command component status")).not.toBeInTheDocument();
    expect(within(root).queryByText("OPENAI", { exact: true })).not.toBeInTheDocument();
  });

  it("shows compact Hybrid component truth without relabeling synthetic BEA data", () => {
    render(
      <AiCommandWorkspace
        initialSnapshot={providerSnapshot({
          mode: "hybrid",
          simulated: false,
          liveConnected: true,
          textModel: "gpt-live-text",
          realtimeModel: "gpt-live-realtime",
          voice: "coral",
        })}
      />,
    );

    expect(screen.getByText("CONNECTED", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Ready", { selector: '[role="status"]' })).toBeInTheDocument();
    expect(screen.queryByLabelText("AI Command component status")).not.toBeInTheDocument();
    expect(screen.queryByText("BEA dataLive", { exact: true })).not.toBeInTheDocument();
  });

  it("renders only safe HTTPS citation links in persisted conversation content", () => {
    const initial = providerSnapshot(
      { mode: "hybrid", simulated: false, liveConnected: true },
      {
        messages: [
          {
            id: "message-citations",
            role: "assistant",
            content: "Grounded provider answer.",
            createdAt: "2026-08-20T12:00:00.000Z",
            provider: "openai",
            executionMs: 42,
            links: [
              { label: "Official guidance", href: "https://example.com/guidance" },
              { label: "Blocked citation", href: "javascript:private()" },
            ],
          },
        ],
      },
    );
    render(<AiCommandWorkspace initialSnapshot={initial} />);

    expect(screen.getByRole("link", { name: "Official guidance" })).toHaveAttribute(
      "href",
      "https://example.com/guidance",
    );
    expect(
      screen.getByRole("link", { name: "Official guidance" }).getAttribute("rel")?.split(" "),
    ).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    expect(screen.getByText("Blocked citation").closest("a")).toBeNull();
  });

  it("switches mobile panels with pointer and roving-tab keyboard controls", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const conversationTab = screen.getByRole("tab", { name: "Conversation" });
    const workspaceTab = screen.getByRole("tab", { name: "Workspace" });
    const conversationPanel = screen.getByRole("tabpanel", { name: "Conversation" });
    const workspacePanel = screen.getByRole("tabpanel", { name: "Workspace" });

    fireEvent.click(workspaceTab);
    expect(workspaceTab).toHaveAttribute("aria-selected", "true");
    expect(workspaceTab).toHaveAttribute("tabindex", "0");
    expect(conversationPanel).toHaveAttribute("data-mobile-active", "false");
    expect(workspacePanel).toHaveAttribute("data-mobile-active", "true");

    fireEvent.keyDown(workspaceTab, { key: "ArrowLeft" });
    expect(conversationTab).toHaveFocus();
    expect(conversationTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(conversationTab, { key: "End" });
    expect(workspaceTab).toHaveFocus();
    expect(workspaceTab).toHaveAttribute("aria-selected", "true");
  });

  it("reviews and edits a simulated voice transcript without requesting speech or sending it", () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);

    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    fireEvent.click(screen.getByTestId("bea-start-voice"));
    expect(screen.queryByText(/does not request microphone access or store audio/u)).toBeNull();
    expect(screen.getAllByText(/Listening/u).length).toBeGreaterThan(0);

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getAllByText(/Preparing transcript/u).length).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(350));

    const transcript = screen.getByRole("textbox", {
      name: "Review and correct simulated transcript",
    });
    expect(transcript).toHaveValue("Show open tasks");
    fireEvent.change(transcript, { target: { value: "Show overdue tasks" } });
    fireEvent.click(screen.getByRole("button", { name: "Use transcript" }));

    expect(screen.getByRole("textbox", { name: "Message BEA AI Command" })).toHaveValue(
      "Show overdue tasks",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps browser media TEST MODE server-gated while preserving normal simulated voice", () => {
    const normal = render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    expect(screen.queryByTestId("bea-browser-voice-test")).toBeNull();
    expect(screen.getByTestId("ai-interaction-mode-voice")).toBeInTheDocument();
    normal.unmount();

    render(<AiCommandWorkspace initialSnapshot={snapshot()} browserMediaTestMode />);
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-browser-media-test-mode",
      "true",
    );
    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    expect(screen.getByTestId("bea-browser-voice-test")).toHaveTextContent("TEST MODE");
    expect(screen.getByTestId("bea-voice-start")).toHaveAccessibleName("Start browser media test");
    expect(screen.getByTestId("bea-voice-stop")).toBeDisabled();
    expect(screen.getByTestId("bea-voice-status")).toHaveAttribute("data-state", "idle");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses Enter to send, preserves Shift+Enter, and activates the returned workspace", async () => {
    const nextSnapshot = snapshot({
      messages: [
        ...snapshot().messages,
        {
          id: "message-2",
          role: "assistant",
          content: "I found two companies.",
          createdAt: "2026-08-18T12:01:00.000Z",
          provider: "simulated",
          executionMs: 3,
          links: [],
        },
      ],
      artifact: artifact({
        id: "artifact-2",
        type: "company-list",
        title: "Companies",
        payload: { items: [] },
        state: "empty",
      }),
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(jsonResponse(nextSnapshot, 201));
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });

    fireEvent.change(composer, { target: { value: "Show all companies" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [reservationUrl, reservationInit] = fetchMock.mock.calls[0] ?? [];
    expect(reservationUrl).toBe("/api/ai-command/requests");
    expect(reservationInit).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(reservationInit?.body))).toEqual({
      conversationId: "conversation-1",
    });
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe("/api/ai-command/messages");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      conversationId: "conversation-1",
      generation: 1,
      message: "Show all companies",
      requestId: "a1100000-0000-4000-8000-000000000001",
    });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(composer).toHaveValue("");
    await waitFor(() =>
      expect(screen.getByTestId("workspace-artifact-company-list")).toBeInTheDocument(),
    );
  });

  it("streams general provider work incrementally and refreshes the persistent conversation", async () => {
    const nextSnapshot = providerSnapshot(
      {},
      {
        messages: [
          ...snapshot().messages,
          {
            id: "message-streamed",
            role: "assistant",
            content: "Synthetic envelopes sequence scope before handoff.",
            createdAt: "2026-08-18T12:01:00.000Z",
            provider: "simulated",
            executionMs: 12,
            links: [],
          },
        ],
        artifact: artifact({
          id: "artifact-streamed",
          type: "analysis",
          title: "Synthetic envelope plan",
          payload: { summary: "Persistent streamed result" },
        }),
      },
    );
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const streamResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(streamResponse)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            validation: {
              callId: "call-research-1",
              name: "bea_research",
              status: "validated",
              effect: "preview",
              requiredPermissions: ["ai-command.run", "search.view", "documents.view"],
              executable: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(nextSnapshot));
    render(<AiCommandWorkspace initialSnapshot={providerSnapshot()} />);

    fireEvent.click(screen.getByTestId("ai-web-search-toggle"));
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Explain synthetic envelope planning" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [streamUrl, streamInit] = fetchMock.mock.calls[1] ?? [];
    expect(streamUrl).toBe("/api/ai-command/stream");
    expect(JSON.parse(String(streamInit?.body))).toMatchObject({
      conversationId: "conversation-1",
      message: "Explain synthetic envelope planning",
      requestId: "a1100000-0000-4000-8000-000000000001",
      generation: 1,
      inputMode: "text",
      webSearch: true,
      builtInTools: ["web_search"],
    });

    await act(async () => {
      streamController?.enqueue(
        sseFrame("response.started", {
          requestId: "a1100000-0000-4000-8000-000000000001",
          providerResponseId: "provider-response-1",
          model: "gpt-test",
          simulated: true,
        }),
      );
      streamController?.enqueue(
        sseFrame("response.output_text.delta", {
          delta: "Synthetic envelopes sequence scope",
        }),
      );
      streamController?.enqueue(
        sseFrame("response.tool_call", {
          toolCall: {
            id: "call-web-search-1",
            name: "web_search",
            arguments: {},
            status: "completed",
          },
        }),
      );
      streamController?.enqueue(
        sseFrame("response.tool_call", {
          toolCall: {
            id: "call-research-1",
            name: "bea_research",
            arguments: {
              title: "Synthetic envelope research",
              query: "Synthetic envelope planning",
            },
            status: "proposed",
          },
        }),
      );
      streamController?.enqueue(
        sseFrame("response.file_source", {
          source: {
            id: "file-source-1",
            filename: "approved-envelope-guidance.pdf",
            excerpt: "Approved organizational guidance excerpt.",
          },
        }),
      );
      await Promise.resolve();
    });
    const streamedMessage = await screen.findByTestId("streaming-assistant-message");
    expect(streamedMessage).toHaveTextContent("Synthetic envelopes sequence scope");
    expect(streamedMessage).toHaveAttribute("data-stream-status", "streaming");
    expect(screen.getByTestId("bea-ai-orb")).toHaveAttribute("data-state", "speaking");
    expect(await screen.findByText("web_search · provider completed")).toBeInTheDocument();
    expect(await screen.findByText("bea_research · validated")).toBeInTheDocument();
    expect(screen.getByLabelText("Streaming organizational file sources")).toHaveTextContent(
      "approved-envelope-guidance.pdf — Approved organizational guidance excerpt.",
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/ai-command/tools/validate"),
    ).toHaveLength(1);

    await act(async () => {
      streamController?.enqueue(
        sseFrame("response.completed", { result: { conversationId: "conversation-1" } }),
      );
      streamController?.close();
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-artifact-analysis")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("streaming-assistant-message")).not.toBeInTheDocument();
  });

  it("ignores a registered-tool validation that resolves after request and conversation supersession", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const streamResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    let resolveValidation: ((response: Response) => void) | undefined;
    const pendingValidation = new Promise<Response>((resolve) => {
      resolveValidation = resolve;
    });
    const conversation = {
      id: "conversation-2",
      title: "Superseding conversation",
      updatedAt: "2026-08-20T15:00:00.000Z",
    };
    const nextSnapshot = providerSnapshot(
      {},
      { conversation, conversations: [conversation], messages: [] },
    );
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(streamResponse)
      .mockImplementationOnce(() => pendingValidation)
      .mockResolvedValueOnce(jsonResponse(nextSnapshot));
    render(<AiCommandWorkspace initialSnapshot={providerSnapshot()} />);

    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Research delayed validation behavior" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      streamController?.enqueue(
        sseFrame("response.started", {
          requestId: "a1100000-0000-4000-8000-000000000001",
          providerResponseId: "provider-delayed-validation",
          model: "deterministic-demo-router",
          simulated: true,
        }),
      );
      streamController?.enqueue(
        sseFrame("response.tool_call", {
          toolCall: {
            id: "call-delayed-research",
            name: "bea_research",
            arguments: { query: "delayed validation" },
            status: "proposed",
          },
        }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByText("bea_research · validating")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByTestId("ai-stop-generation"));
    await waitFor(() => expect(screen.queryByTestId("ai-stop-generation")).not.toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Open conversation history"));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Saved conversations" })).toHaveValue(
        "conversation-2",
      ),
    );

    await act(async () => {
      resolveValidation?.(
        new Response(
          JSON.stringify({
            validation: {
              callId: "call-delayed-research",
              name: "bea_research",
              status: "validated",
              effect: "preview",
              requiredPermissions: ["ai-command.run", "search.view", "documents.view"],
              executable: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      await Promise.resolve();
    });
    expect(screen.queryByText("bea_research · validating")).not.toBeInTheDocument();
    expect(screen.queryByText("bea_research · validated")).not.toBeInTheDocument();
  });

  it("uses the safe web-search default and preserves an explicit user override", async () => {
    const defaultSnapshot = providerSnapshot({ webSearchDefault: true });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(
        eventStreamResponse([
          [
            "response.started",
            {
              requestId: "a1100000-0000-4000-8000-000000000001",
              providerResponseId: "provider-default-search",
              model: "deterministic-demo-router",
              simulated: true,
            },
          ],
          ["response.completed", { result: { conversationId: "conversation-1" } }],
        ]),
      )
      .mockResolvedValueOnce(jsonResponse(defaultSnapshot))
      .mockResolvedValueOnce(reservationResponse(2, "a1100000-0000-4000-8000-000000000002"))
      .mockResolvedValueOnce(
        eventStreamResponse([
          [
            "response.started",
            {
              requestId: "a1100000-0000-4000-8000-000000000002",
              providerResponseId: "provider-disabled-search",
              model: "deterministic-demo-router",
              simulated: true,
            },
          ],
          ["response.completed", { result: { conversationId: "conversation-1" } }],
        ]),
      )
      .mockResolvedValueOnce(jsonResponse(defaultSnapshot));
    render(<AiCommandWorkspace initialSnapshot={defaultSnapshot} />);

    const searchToggle = screen.getByTestId("ai-web-search-toggle");
    expect(searchToggle).toHaveAttribute("aria-pressed", "true");
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Research the synthetic envelope" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      webSearch: true,
      builtInTools: ["web_search"],
    });

    fireEvent.click(searchToggle);
    expect(searchToggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.change(composer, { target: { value: "Summarize the synthetic envelope" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toMatchObject({
      webSearch: false,
      builtInTools: [],
    });
  });

  it("marks an accepted simulated voice transcript on the shared stream contract", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(
        eventStreamResponse([
          [
            "response.started",
            {
              requestId: "a1100000-0000-4000-8000-000000000001",
              providerResponseId: "provider-response-voice",
              model: "gpt-test",
              simulated: true,
            },
          ],
          ["response.completed", { result: { conversationId: "conversation-1" } }],
        ]),
      )
      .mockResolvedValueOnce(jsonResponse(providerSnapshot()));
    render(<AiCommandWorkspace initialSnapshot={providerSnapshot()} />);

    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    fireEvent.click(screen.getByTestId("bea-start-voice"));
    act(() => vi.advanceTimersByTime(2_350));
    const transcript = screen.getByRole("textbox", {
      name: "Review and correct simulated transcript",
    });
    fireEvent.change(transcript, {
      target: { value: "Draft a synthetic handoff narrative" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use transcript" }));
    vi.useRealTimers();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message BEA AI Command" }), {
      key: "Enter",
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [streamUrl, streamInit] = fetchMock.mock.calls[1] ?? [];
    expect(streamUrl).toBe("/api/ai-command/stream");
    expect(JSON.parse(String(streamInit?.body))).toMatchObject({
      message: "Draft a synthetic handoff narrative",
      inputMode: "simulated_voice",
    });
  });

  it("preserves deterministic BEA commands on the legacy JSON route in explicit Demo Mode", async () => {
    const nextSnapshot = providerSnapshot(
      {},
      {
        artifact: artifact({
          id: "artifact-open-tasks",
          type: "task-list",
          title: "Open tasks",
          payload: { items: [] },
          state: "empty",
        }),
      },
    );
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(jsonResponse(nextSnapshot, 201));
    render(<AiCommandWorkspace initialSnapshot={providerSnapshot()} />);

    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Show open tasks" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/ai-command/messages");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/ai-command/stream")).toBe(false);
  });

  it("never downgrades a connected OpenAI command to the deterministic JSON route", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    render(
      <AiCommandWorkspace
        initialSnapshot={providerSnapshot({
          mode: "openai",
          simulated: false,
          liveConnected: true,
          textModel: "gpt-live-text",
        })}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Show open tasks" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/ai-command/stream");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/ai-command/messages")).toBe(false);
    expect(
      await screen.findByText(
        "The live OpenAI response route is unavailable. No test-provider fallback was used.",
      ),
    ).toBeVisible();
  });

  it("retains unsupported-stream compatibility only for the explicit Demo provider", async () => {
    const nextSnapshot = providerSnapshot(
      {},
      {
        messages: [
          ...snapshot().messages,
          {
            id: "message-demo-fallback",
            role: "assistant",
            content: "The deterministic Demo fallback completed.",
            createdAt: "2026-08-18T12:01:00.000Z",
            provider: "simulated",
            executionMs: 3,
            links: [],
          },
        ],
      },
    );
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(new Response(null, { status: 501 }))
      .mockResolvedValueOnce(jsonResponse(nextSnapshot, 201));
    render(<AiCommandWorkspace initialSnapshot={providerSnapshot()} />);

    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Draft a quarterly update" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/ai-command/stream");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/ai-command/messages");
    expect(await screen.findByText("The deterministic Demo fallback completed.")).toBeVisible();
  });

  it("stops an active stream, cancels its reader, and preserves partial text", async () => {
    const cancelled = vi.fn();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const streamResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel: cancelled,
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(reservationResponse()).mockResolvedValueOnce(streamResponse);
    render(<AiCommandWorkspace initialSnapshot={providerSnapshot()} />);

    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Draft a synthetic handoff narrative" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      streamController?.enqueue(
        sseFrame("response.output_text.delta", { delta: "Partial handoff narrative" }),
      );
      await Promise.resolve();
    });
    await screen.findByText("Partial handoff narrative");

    fireEvent.click(screen.getByTestId("ai-stop-generation"));

    await waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    const partial = screen.getByTestId("streaming-assistant-message");
    expect(partial).toHaveTextContent("Partial handoff narrative");
    expect(partial).toHaveAttribute("data-stream-status", "partial");
    await waitFor(() => expect(screen.queryByTestId("ai-stop-generation")).not.toBeInTheDocument());
  });

  it("keeps live Realtime ready but inactive until the owner explicitly starts it", () => {
    const fetchMock = vi.mocked(fetch);
    render(
      <AiCommandWorkspace
        initialSnapshot={providerSnapshot({
          mode: "openai",
          simulated: false,
          liveConnected: true,
          textModel: "gpt-test",
          realtimeModel: "gpt-realtime-test",
          voice: "alloy-test",
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));

    expect(screen.getByText("Realtime ready to start", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("ai-realtime-status")).toHaveTextContent("Realtime ready to start");
    expect(screen.getByTestId("ai-realtime-status")).toHaveTextContent("gpt-realtime-test");
    expect(screen.getByTestId("ai-realtime-status")).toHaveTextContent("alloy-test");
    expect(screen.getByTestId("bea-ai-orb")).toHaveAttribute("data-state", "idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps explicit live authorization and fail-closed media availability to orb states", async () => {
    const fetchMock = vi.mocked(fetch);
    const authorization = deferred<Response>();
    const liveConversation = {
      id: "10000000-0000-4000-8000-000000000010",
      title: "Live Realtime conversation",
      updatedAt: "2026-08-21T12:00:00.000Z",
    };
    fetchMock.mockImplementationOnce(() => authorization.promise);
    render(
      <AiCommandWorkspace
        initialSnapshot={providerSnapshot(
          {
            mode: "openai",
            simulated: false,
            liveConnected: true,
            textModel: "gpt-test",
            realtimeModel: "gpt-realtime-test",
            voice: "coral",
          },
          { conversation: liveConversation, conversations: [liveConversation] },
        )}
      />,
    );
    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    fireEvent.click(screen.getByTestId("bea-live-voice-start"));

    await waitFor(() => {
      expect(screen.getByTestId("bea-live-voice-status")).toHaveAttribute(
        "data-state",
        "authorizing",
      );
      expect(screen.getByTestId("bea-ai-orb")).toHaveAttribute("data-state", "connecting");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai-command/realtime/client-secret",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ conversationId: liveConversation.id }),
      }),
    );

    authorization.resolve(
      new Response(
        JSON.stringify({
          authorization: {
            provider: "openai",
            clientSecret: "ek_realtime_ephemeral_test_1234567890",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            sessionId: "sess_realtime_test",
            beaSessionId: "20000000-0000-4000-8000-000000000020",
            model: "gpt-realtime-test",
            voice: "coral",
            simulated: false,
            webrtcEndpoint: "https://api.openai.com/v1/realtime/calls",
            interactionMode: "automatic",
            allowInterruption: true,
          },
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId("bea-live-voice-status")).toHaveAttribute("data-state", "error");
      expect(screen.getByTestId("bea-ai-orb")).toHaveAttribute("data-state", "error");
    });
    expect(
      screen.getAllByText(/media APIs required for live Realtime voice/u).length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("bea-live-voice-status")).toHaveAttribute(
      "data-standard-api-key-exposed",
      "false",
    );
    expect(screen.getByTestId("bea-live-voice-status")).toHaveAttribute(
      "data-realtime-credential-retained",
      "false",
    );
    expect(screen.getByTestId("bea-live-voice-status")).toHaveAttribute(
      "data-cleanup-complete",
      "true",
    );
  });

  it("sends only the staged internal artifact ID with the next accepted Demo analysis", async () => {
    const artifactId = "art_0123456789abcdef0123456789abcdef";
    const manifest = {
      artifactId,
      schemaVersion: 1,
      renderer: "data",
      title: "handoff.txt",
      summary: "Restricted owner upload: handoff.txt",
      disclosure: "Owner-uploaded file accepted after validation.",
      data: {
        format: "txt",
        recordCount: 0,
        file: {
          id: artifactId,
          filename: "handoff.txt",
          mimeType: "text/plain",
          size: 17,
        },
      },
    };
    const fetchMock = vi.mocked(fetch);
    let acceptStream: ((response: Response) => void) | undefined;
    const pendingStream = new Promise<Response>((resolve) => {
      acceptStream = resolve;
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            artifact: {
              id: artifactId,
              filename: "handoff.txt",
              mimeType: "text/plain",
              size: 17,
              createdAt: "2026-08-20T13:00:00.000Z",
            },
            conversationId: "conversation-1",
            generatedArtifactId: "generated-1",
            workspaceArtifactId: "workspace-upload-1",
            manifest,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(reservationResponse())
      .mockImplementationOnce(() => pendingStream)
      .mockResolvedValueOnce(jsonResponse(providerSnapshot()));
    render(
      <AiCommandWorkspace
        initialSnapshot={providerSnapshot(
          { maxUploadBytes: 10_000_000 },
          { permissions: { canExecuteTaskAction: true, canUploadArtifact: true } },
        )}
      />,
    );

    const input = screen.getByTestId("ai-artifact-upload-input");
    const file = new File(["Synthetic handoff"], "handoff.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/artifacts/upload");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    const entries = [...(init?.body as FormData).keys()];
    expect(entries).toEqual(["file", "conversationId"]);
    expect(init?.headers).toBeUndefined();

    expect(await screen.findByTestId("ai-uploaded-artifact")).toHaveTextContent("handoff.txt");
    await waitFor(() =>
      expect(screen.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
        "data-renderer",
        "data",
      ),
    );
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Analyze the attached synthetic handoff" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const requestBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(requestBody.inputArtifactIds).toEqual([artifactId]);
    expect(screen.getByTestId("ai-uploaded-artifact")).toHaveTextContent("handoff.txt");

    await act(async () => {
      acceptStream?.(
        eventStreamResponse([
          [
            "response.started",
            {
              requestId: "a1100000-0000-4000-8000-000000000001",
              providerResponseId: "demo-upload-analysis",
              model: "deterministic-demo-router",
              simulated: true,
            },
          ],
          ["response.completed", { result: { conversationId: "conversation-1" } }],
        ]),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(screen.queryByTestId("ai-uploaded-artifact")).not.toBeInTheDocument();
  });

  it.each([
    ["OpenAI", { mode: "openai", simulated: false, liveConnected: true }],
    ["unknown", { mode: "unknown", simulated: false, liveConnected: false }],
  ])("never sends a staged artifact ID for an %s provider", async (label, providerOverrides) => {
    const artifactId = "art_0123456789abcdef0123456789abcdef";
    const manifest = {
      artifactId,
      schemaVersion: 1,
      renderer: "data",
      title: "private-note.txt",
      summary: "Restricted owner upload",
      data: {
        format: "txt",
        recordCount: 0,
        file: {
          id: artifactId,
          filename: "private-note.txt",
          mimeType: "text/plain",
          size: 12,
        },
      },
    };
    const nextSnapshot = providerSnapshot(providerOverrides, {
      permissions: { canExecuteTaskAction: true, canUploadArtifact: true },
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            artifact: {
              id: artifactId,
              filename: "private-note.txt",
              mimeType: "text/plain",
              size: 12,
              createdAt: "2026-08-20T13:00:00.000Z",
            },
            conversationId: "conversation-1",
            generatedArtifactId: "generated-private-note",
            workspaceArtifactId: "workspace-private-note",
            manifest,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(
        eventStreamResponse([
          [
            "response.started",
            {
              requestId: "a1100000-0000-4000-8000-000000000001",
              providerResponseId: "non-demo-request",
              model: "provider-model",
              simulated: false,
            },
          ],
          ["response.completed", { result: { conversationId: "conversation-1" } }],
        ]),
      )
      .mockResolvedValueOnce(jsonResponse(nextSnapshot));
    render(<AiCommandWorkspace initialSnapshot={nextSnapshot} />);

    fireEvent.change(screen.getByTestId("ai-artifact-upload-input"), {
      target: {
        files: [new File(["Private note"], "private-note.txt", { type: "text/plain" })],
      },
    });
    expect(await screen.findByTestId("ai-uploaded-artifact")).toHaveTextContent("private-note.txt");
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Analyze the private note" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    if (label === "OpenAI") {
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
      const requestBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
      expect(requestBody).not.toHaveProperty("inputArtifactIds");
    } else {
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(screen.getByText(/AI provider is unavailable/u)).toBeInTheDocument();
    }
    expect(screen.getByTestId("ai-uploaded-artifact")).toHaveTextContent("private-note.txt");
  });

  it("aborts and ignores a stale upload when a new conversation starts", async () => {
    const staleArtifactId = "art_fedcba9876543210fedcba9876543210";
    const nextConversation = {
      id: "conversation-2",
      title: "New guarded conversation",
      updatedAt: "2026-08-20T14:00:00.000Z",
    };
    const nextSnapshot = providerSnapshot(
      { maxUploadBytes: 10_000_000 },
      {
        conversation: nextConversation,
        conversations: [nextConversation],
        permissions: { canExecuteTaskAction: true, canUploadArtifact: true },
      },
    );
    let resolveUpload: ((response: Response) => void) | undefined;
    let uploadSignal: AbortSignal | null = null;
    const uploadResponse = new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockImplementationOnce((_url, init) => {
        uploadSignal = init?.signal as AbortSignal;
        return uploadResponse;
      })
      .mockResolvedValueOnce(jsonResponse(nextSnapshot));
    render(
      <AiCommandWorkspace
        initialSnapshot={providerSnapshot(
          { maxUploadBytes: 10_000_000 },
          { permissions: { canExecuteTaskAction: true, canUploadArtifact: true } },
        )}
      />,
    );

    const input = screen.getByTestId("ai-artifact-upload-input");
    fireEvent.change(input, {
      target: { files: [new File(["stale"], "stale-handoff.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText("Open conversation history"));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(uploadSignal?.aborted).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Saved conversations" })).toHaveValue(
        "conversation-2",
      ),
    );

    await act(async () => {
      resolveUpload?.(
        new Response(
          JSON.stringify({
            ok: true,
            artifact: {
              id: staleArtifactId,
              filename: "stale-handoff.txt",
              mimeType: "text/plain",
              size: 5,
              createdAt: "2026-08-20T13:59:00.000Z",
            },
            conversationId: "conversation-1",
            generatedArtifactId: "generated-stale",
            workspaceArtifactId: "workspace-stale",
            manifest: {
              artifactId: staleArtifactId,
              schemaVersion: 1,
              renderer: "data",
              title: "stale-handoff.txt",
              summary: "Stale upload that must not be staged",
              data: {
                format: "txt",
                recordCount: 0,
                file: {
                  id: staleArtifactId,
                  filename: "stale-handoff.txt",
                  mimeType: "text/plain",
                  size: 5,
                },
              },
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
      await Promise.resolve();
    });

    expect(screen.queryByTestId("ai-uploaded-artifact")).not.toBeInTheDocument();
    expect(screen.queryByText("stale-handoff.txt")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Saved conversations" })).toHaveValue(
      "conversation-2",
    );
  });

  it("reopens a persisted normalized upload from the conversation snapshot", () => {
    const artifactId = "art_abcdef0123456789abcdef0123456789";
    render(
      <AiCommandWorkspace
        initialSnapshot={providerSnapshot(
          {},
          {
            artifact: artifact({
              id: "workspace-upload-persisted",
              type: "empty",
              title: "persisted.pdf",
              payload: {
                artifactId,
                schemaVersion: 1,
                renderer: "pdf",
                title: "persisted.pdf",
                summary: "Restricted owner upload",
                file: {
                  id: artifactId,
                  filename: "persisted.pdf",
                  mimeType: "application/pdf",
                  size: 1024,
                },
              },
            }),
          },
        )}
      />,
    );

    expect(screen.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
      "data-renderer",
      "pdf",
    );
    expect(screen.getByTestId("workspace-pdf-toolbar")).toBeInTheDocument();
  });

  it("enables code and image controls only for deterministic Demo Mode", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(
        eventStreamResponse([
          [
            "response.started",
            {
              requestId: "a1100000-0000-4000-8000-000000000001",
              providerResponseId: "demo-tools",
              model: "deterministic-demo-router",
              simulated: true,
            },
          ],
          ["response.completed", { result: { conversationId: "conversation-1" } }],
        ]),
      )
      .mockResolvedValueOnce(jsonResponse(providerSnapshot()));
    render(
      <AiCommandWorkspace
        initialSnapshot={providerSnapshot({
          codeInterpreterAllowed: true,
          imageGenerationAllowed: true,
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("ai-command-options-trigger"));
    fireEvent.click(screen.getByTestId("ai-code-interpreter-toggle"));
    fireEvent.click(screen.getByTestId("ai-image-generation-toggle"));
    const dialog = screen.getByRole("dialog", {
      name: "Enable simulated image generation for one request?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use simulated image generation" }));
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Create a synthetic visual analysis" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({
      builtInTools: ["code_interpreter", "image_generation"],
      confirmHighCostTools: true,
    });
    expect(body).not.toHaveProperty("inputArtifactIds");
  });

  it("keeps live provider code and image seams visibly disabled", () => {
    render(
      <AiCommandWorkspace
        initialSnapshot={providerSnapshot({
          mode: "openai",
          simulated: false,
          liveConnected: true,
          codeInterpreterAllowed: true,
          imageGenerationAllowed: true,
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("ai-command-options-trigger"));
    expect(screen.getByTestId("ai-code-interpreter-toggle")).toBeDisabled();
    expect(screen.getByTestId("ai-image-generation-toggle")).toBeDisabled();
    expect(screen.getByTestId("ai-provider-tool-safety")).toHaveTextContent(
      "blocked pending explicit owner authorization",
    );
  });

  it("requires the explicit dialog confirmation before posting an executable action", async () => {
    const previewSnapshot = snapshot({
      artifact: artifact({
        type: "action-preview",
        title: "Create internal task",
        payload: {
          actionId: "action-1",
          executable: true,
          actingUser: "Owner Administrator",
          requiredPermission: "ai-command.task-action.execute",
          fields: { title: "Review field notes", assignee: "Operations Coordinator" },
        },
      }),
    });
    const resultSnapshot = snapshot({
      artifact: artifact({
        type: "action-result",
        title: "Task created",
        payload: {
          message: "Task persisted exactly once.",
          href: "/tasks/task-1",
          reused: false,
        },
      }),
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(resultSnapshot));
    render(<AiCommandWorkspace initialSnapshot={previewSnapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Review and confirm task" }));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Create this internal task?" });
    expect(dialog).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and create task" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai-command/actions/action-1/confirm",
        expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("workspace-artifact-action-result")).toBeInTheDocument(),
    );
  });
});

describe("AI Command responsive CSS contract", () => {
  const moduleCss = readFileSync(
    resolve(process.cwd(), "apps/web/components/ai-command.module.css"),
    "utf8",
  );
  const workspaceSource = readFileSync(
    resolve(process.cwd(), "apps/web/components/ai-command-motion-workspace.tsx"),
    "utf8",
  );
  const pageSource = readFileSync(
    resolve(process.cwd(), "apps/web/app/(authenticated)/ai-command/page.tsx"),
    "utf8",
  );
  const shellCss = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
  const applicationCss = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");

  beforeEach(() => {
    setTestRouterReplace(navigation.replace);
    vi.stubGlobal("fetch", vi.fn());
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    window.history.replaceState(null, "", "/ai-command");
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("publishes the matched-height panel contract", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);

    expect(screen.getByTestId("ai-conversation-panel")).toBeInTheDocument();
    expect(screen.getByTestId("ai-workspace-panel")).toBeInTheDocument();
    expect(moduleCss).toMatch(/\.command\s*\{[\s\S]*?height:\s*100%/u);
    expect(moduleCss).toMatch(/\.panel\s*\{[\s\S]*?height:\s*100%[\s\S]*?min-height:\s*0/u);
  });

  it("keeps only a compact account control in the AI Command focus header", () => {
    expect(applicationCss).toMatch(
      /data-page="ai-command"\]\)\s*> \.bea-demo-banner\s*\{\s*display:\s*none/u,
    );
    expect(applicationCss).toMatch(
      /data-page="ai-command"\]\) > \.bea-header\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?min-height:\s*3rem/u,
    );
    expect(applicationCss).toMatch(
      /data-page="ai-command"\]\)[\s\S]*?> \.bea-header[\s\S]*?\.bea-header__leading\s*\{\s*display:\s*none/u,
    );
    expect(applicationCss).toMatch(
      /data-page="ai-command"\]\)[\s\S]*?> \.bea-header[\s\S]*?\.bea-profile-menu\s*> summary\s*\{[\s\S]*?border:/u,
    );
  });

  it("publishes the bottom-aligned panel region contract", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);

    expect(screen.getByTestId("ai-conversation-panel")).toBeInTheDocument();
    expect(screen.getByTestId("ai-workspace-panel")).toBeInTheDocument();
    expect(moduleCss).toMatch(
      /\/\* Phase 1\.3\.2:[\s\S]*?\.conversation\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) auto/u,
    );
    expect(moduleCss).toMatch(
      /\/\* Phase 1\.3\.2:[\s\S]*?\.workspace\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\)/u,
    );
  });

  it("publishes the intentional two-scroller architecture", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);

    expect(screen.getByTestId("ai-message-scroller")).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("ai-workspace-scroller")).toBeInTheDocument();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(moduleCss).toMatch(/\.messages\s*\{[\s\S]*?overflow-y:\s*auto/u);
    expect(moduleCss).toMatch(/\.workspaceBody\s*\{[\s\S]*?overflow-y:\s*auto/u);
  });

  it("removes the permanent capability-launcher rail", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);

    expect(screen.queryByTestId("ai-suggestion-rail")).toBeNull();
    expect(screen.queryAllByTestId("ai-capability-launcher")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Lead Intake" })).toBeNull();
    expect(screen.getByTestId("ai-command-options-trigger")).toHaveAccessibleName();
  });

  it("publishes the composer anchoring contract", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);

    expect(screen.getByTestId("ai-command-composer")).toBeInTheDocument();
    expect(moduleCss).toMatch(
      /\/\* Phase 1\.3\.2:[\s\S]*?\.conversation\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) auto/u,
    );
    expect(moduleCss).toMatch(
      /\.composer\s*\{[\s\S]*?align-self:\s*end[\s\S]*?grid-template-columns/u,
    );
    expect(moduleCss).toMatch(/\.composerInput\s*\{[\s\S]*?min-height:\s*2\.85rem/u);
  });

  it("defines the resizable desktop split and compact single-panel breakpoint", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    expect(screen.getByTestId("ai-pane-divider")).toBeInTheDocument();
    expect(moduleCss).toMatch(/\.command\s*\{[\s\S]*?--bea-ai-pane-percent:\s*36%/u);
    expect(moduleCss).toMatch(/\.divider\s*\{[\s\S]*?touch-action:\s*none/u);
    expect(moduleCss).toMatch(
      /@media \(max-width: 64rem\)[\s\S]*?\.panelSwitch\s*\{[^}]*display:\s*grid/u,
    );
    expect(moduleCss).toMatch(
      /@media \(max-width: 64rem\)[\s\S]*?\.conversation\[data-mobile-active="true"\][\s\S]*?display:\s*grid/u,
    );
    expect(workspaceSource).not.toMatch(
      /className=.*bea-ai-(?:command|conversation|workspace|avatar-header|suggestions|composer|divider)/u,
    );
    expect(pageSource).not.toContain("bea-ai-command-page");
    expect(pageSource).toContain('data-page="ai-command"');
    expect(shellCss).toMatch(/\.bea-main-content:has\(\[data-page="ai-command"\]\)/u);
    expect(shellCss).toMatch(/\.bea-animated-page:has\(\[data-page="ai-command"\]\)/u);
    expect(moduleCss).toMatch(/\.orbLayer \.orb\s*\{[\s\S]*?height:\s*var\(--bea-orb-diameter\)/u);
    expect(moduleCss).toMatch(
      /@media \(max-width: 64rem\)[\s\S]*?\.orbLayer \.orb\s*\{[\s\S]*?height:\s*clamp\(15rem, 34vh, 22rem\)/u,
    );
  });

  it("publishes explicit accessible and visible connecting/user-speaking orb contracts", () => {
    expect(AI_ORB_STATE_LABELS.connecting).toBe("Connecting");
    expect(AI_ORB_STATE_LABELS["user-speaking"]).toBe("User speaking");
    expect(workspaceSource).toMatch(
      /browserVoice\.state === "connecting"[\s\S]*?return "connecting"/u,
    );
    expect(workspaceSource).toMatch(
      /browserVoice\.state === "user-speaking"[\s\S]*?return "user-speaking"/u,
    );
    expect(moduleCss).toMatch(/\.orbLayer \.orb\[data-state="connecting"\]/u);
    expect(moduleCss).toMatch(/\.orbLayer \.orb\[data-state="user-speaking"\]/u);
  });

  it("removes AI animation and smooth scrolling for reduced-motion users", () => {
    expect(moduleCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none !important/u,
    );
    expect(moduleCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?scroll-behavior:\s*auto !important/u,
    );
    expect(moduleCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration:\s*0\.01ms !important/u,
    );
  });
});
