import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AI_ORB_STATE_LABELS,
  AiCommandWorkspace,
} from "../../apps/web/components/ai-command-workspace";
import type {
  AiCommandArtifactView,
  AiCommandSnapshot,
} from "../../apps/web/lib/ai-command-contracts";
import { NotificationReadButton } from "../../apps/web/components/notification-read-button";
import { ProfileMenu } from "../../apps/web/components/profile-menu";
import {
  ApplicationShell,
  Card,
  ConfirmationDialog,
  Header,
  MobileNavigation,
  MotionPreferenceControl,
  MotionProvider,
} from "../../packages/ui/src/index";
import { setTestRouterRefresh, setTestRouterReplace } from "./stubs/next-navigation";

vi.mock("@/lib/auth/personas", () => ({ getDemoPersonas: () => [] }));

const userId = "10000000-0000-4000-8000-000000000001";
const splitStorageKey = `bea:ai-pane-percent:v1:${userId}`;

function artifact(overrides: Partial<AiCommandArtifactView> = {}): AiCommandArtifactView {
  return {
    id: "artifact-help",
    type: "help",
    title: "AI Command capabilities",
    subtitle: "Deterministic, permission-aware Demo Mode",
    state: "ready",
    payload: { commands: ["Show open tasks"] },
    sources: [],
    links: [],
    requiredPermissions: ["ai-command.view"],
    createdAt: "2026-08-19T12:00:00.000Z",
    errorCode: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AiCommandSnapshot> = {}): AiCommandSnapshot {
  const conversation = {
    id: "conversation-motion",
    title: "Phase 1.1 motion test",
    updatedAt: "2026-08-19T12:00:00.000Z",
  };
  return {
    conversation,
    conversations: [conversation],
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "The current workspace remains visible while a replacement is prepared.",
        createdAt: "2026-08-19T12:00:00.000Z",
        provider: "simulated",
        executionMs: 0,
        links: [],
      },
    ],
    artifact: artifact(),
    provider: {
      name: "BEA deterministic demo assistant",
      mode: "SIMULATED",
      model: "deterministic-demo-router",
      routerVersion: "phase11-test-router",
      liveConnected: false,
      simulated: true,
    },
    permissions: { canExecuteTaskAction: true },
    actingUser: {
      id: userId,
      displayName: "Owner Administrator",
      title: "Owner / Administrator",
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

function jsonResponse(value: AiCommandSnapshot, status = 201) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function reservationResponse(generation = 1, requestId = "a1200000-0000-4000-8000-000000000001") {
  return new Response(JSON.stringify({ generation, requestId }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

function rect(width: number, height: number, left = 0, top = 0): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function firePointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  options: {
    clientX?: number;
    clientY?: number;
    pointerId?: number;
    pointerType?: string;
  } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    pointerType: { value: options.pointerType ?? "mouse" },
  });
  fireEvent(target, event);
}

function installMatchMedia(matches = false) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  } as MediaQueryList;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
  return { listeners, media };
}

describe("Phase 1.1 motion acceptance", () => {
  beforeEach(() => {
    setTestRouterRefresh(vi.fn());
    setTestRouterReplace(vi.fn());
    window.localStorage.clear();
    window.history.replaceState(null, "", "/ai-command");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => true),
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.documentElement.dataset.motionPreference = "system";
    document.documentElement.dataset.motionProfile = "full";
    document.documentElement.dataset.motionVisibility = "visible";
    document.documentElement.dataset.motionLoad = "idle";
    document.documentElement.dataset.motionModal = "closed";
  });

  it("resizes the AI split with pointer and accessible keyboard controls", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const root = screen.getByTestId("ai-command-workspace");
    const separator = screen.getByRole("separator", { name: "Resize AI Command panes" });
    const readSplitBounds = vi.fn(() => rect(1000, 800));
    root.getBoundingClientRect = readSplitBounds;

    expect(separator).toHaveAttribute("aria-valuemin", "28");
    expect(separator).toHaveAttribute("aria-valuemax", "55");
    expect(separator).toHaveAttribute("aria-valuenow", "36");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "38");
    fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });
    expect(separator).toHaveAttribute("aria-valuenow", "43");
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(separator).toHaveAttribute("aria-valuenow", "36");

    firePointer(separator, "pointerdown", { pointerId: 7 });
    expect(root).toHaveAttribute("data-resizing", "true");
    firePointer(separator, "pointermove", { clientX: 600, pointerId: 7 });
    firePointer(separator, "pointermove", { clientX: 750, pointerId: 7 });
    firePointer(separator, "pointermove", { clientX: 900, pointerId: 7 });
    firePointer(separator, "pointerup", { clientX: 900, pointerId: 7 });
    expect(readSplitBounds).toHaveBeenCalled();
    expect(root).toHaveAttribute("data-resizing", "false");
    expect(separator).toHaveAttribute("aria-valuenow", "55");
    expect(window.localStorage.getItem(splitStorageKey)).toBe("55");
    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute("aria-valuenow", "36");

    firePointer(separator, "pointerdown", { pointerId: 8, pointerType: "touch" });
    firePointer(separator, "pointermove", {
      clientX: -100,
      pointerId: 8,
      pointerType: "touch",
    });
    firePointer(separator, "pointerup", {
      clientX: -100,
      pointerId: 8,
      pointerType: "touch",
    });
    expect(separator).toHaveAttribute("aria-valuenow", "28");
    expect(window.localStorage.getItem(splitStorageKey)).toBe("28");
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(separator).toHaveAttribute("aria-valuenow", "36");

    const appCss = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    expect(appCss).toMatch(
      /\.bea-ai-command\s*\{[\s\S]*?transition:\s*grid-template-columns[\s\S]*?var\(--bea-ease-spring\)/u,
    );
    expect(appCss).toMatch(
      /\.bea-ai-command\[data-resizing="true"\]\s*\{[\s\S]*?transition:\s*none/u,
    );
  });

  it("persists the user-keyed pane width and restores it", async () => {
    window.localStorage.setItem(splitStorageKey, "57");
    const first = render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const separator = await screen.findByRole("separator", { name: "Resize AI Command panes" });
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "55"));
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(window.localStorage.getItem(splitStorageKey)).toBe("55");
    first.unmount();

    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    await waitFor(() =>
      expect(screen.getByRole("separator", { name: "Resize AI Command panes" })).toHaveAttribute(
        "aria-valuenow",
        "55",
      ),
    );
  });

  it("publishes every required BEA orb state and integrated simulated voice flow", async () => {
    vi.useFakeTimers();
    installMatchMedia(false);
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    expect(AI_ORB_STATE_LABELS).toEqual({
      idle: "Ready",
      connecting: "Connecting",
      listening: "Listening",
      "user-speaking": "User speaking",
      transcribing: "Preparing transcript",
      researching: "Researching",
      thinking: "Thinking",
      presenting: "Presenting",
      speaking: "Speaking",
      "awaiting-confirmation": "Awaiting confirmation",
      executing: "Executing approved action",
      success: "Action complete",
      error: "Action could not be completed",
      interrupted: "Interrupted",
      disconnected: "Disconnected",
      offline: "Offline or unavailable",
    });
    render(
      <MotionProvider>
        <AiCommandWorkspace initialSnapshot={snapshot()} />
      </MotionProvider>,
    );
    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    fireEvent.click(screen.getByTestId("bea-start-voice"));
    const orb = screen.getByTestId("bea-ai-orb");
    expect(orb).toHaveAttribute("data-state", "listening");
    expect(orb.querySelector(".bea-ai-orb__mic")).toBeNull();
    expect(screen.getByTestId("ai-orb-state")).toHaveTextContent("Listening");
    visibility = "hidden";
    act(() => fireEvent(document, new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-voice-session",
      "idle",
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    visibility = "visible";
    act(() => fireEvent(document, new Event("visibilitychange")));
    fireEvent.click(screen.getByTestId("bea-start-voice"));
    expect(orb).toHaveAttribute("data-state", "listening");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-voice-session",
      "idle",
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.click(screen.getByTestId("bea-start-voice"));
    expect(orb).toHaveAttribute("data-state", "listening");
    act(() => vi.advanceTimersByTime(2_000));
    expect(orb).toHaveAttribute("data-state", "transcribing");
    expect(screen.getAllByText("Preparing transcript", { exact: true })).toHaveLength(2);
    act(() => vi.advanceTimersByTime(350));
    const transcript = screen.getByRole("textbox", {
      name: "Review and correct simulated transcript",
    });
    fireEvent.change(transcript, { target: { value: "Show overdue tasks" } });
    fireEvent.click(screen.getByRole("button", { name: "Use transcript" }));
    expect(screen.getByRole("textbox", { name: "Message BEA AI Command" })).toHaveValue(
      "Show overdue tasks",
    );
    expect(fetch).not.toHaveBeenCalled();

    const previewSnapshot = snapshot({
      artifact: artifact({
        id: "artifact-preview",
        type: "action-preview",
        title: "Create internal task",
        payload: {
          actionId: "action-motion",
          executable: true,
          actingUser: "Owner Administrator",
          requiredPermission: "ai-command.task-action.execute",
          fields: { title: "Review motion evidence", assignee: "Owner Administrator" },
        },
      }),
    });
    let resolveMessage!: (response: Response) => void;
    vi.mocked(fetch)
      .mockResolvedValueOnce(reservationResponse())
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveMessage = resolve;
          }),
      );
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Create a review task" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(orb).toHaveAttribute("data-state", "thinking");

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolveMessage(jsonResponse(previewSnapshot));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(orb).toHaveAttribute("data-state", "speaking");
    act(() => vi.advanceTimersByTime(900));
    expect(screen.getByTestId("workspace-artifact-action-preview")).toBeVisible();
    expect(orb).toHaveAttribute("data-state", "awaiting-confirmation");

    fireEvent.click(screen.getByRole("button", { name: "Review and confirm task" }));
    expect(orb).toHaveAttribute("data-state", "awaiting-confirmation");
    const resultSnapshot = snapshot({
      artifact: artifact({
        id: "artifact-result",
        type: "action-result",
        title: "Task created",
        payload: {
          message: "Task persisted exactly once.",
          href: "/tasks/task-motion",
          reused: false,
        },
      }),
    });
    let resolveConfirmation!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm and create task" }));
    expect(orb).toHaveAttribute("data-state", "executing");
    await act(async () => Promise.resolve());
    expect(document.documentElement).toHaveAttribute("data-motion-load", "busy");
    const executingDialog = screen.getByRole("dialog", { name: "Create this internal task?" });
    fireEvent(executingDialog, new Event("cancel", { cancelable: true }));
    expect(executingDialog).toBeVisible();
    expect(orb).toHaveAttribute("data-state", "executing");
    await act(async () => {
      resolveConfirmation(jsonResponse(resultSnapshot, 200));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(orb).toHaveAttribute("data-state", "success");
    act(() => vi.advanceTimersByTime(220));
    expect(executingDialog).toHaveAttribute("data-state", "closed");
    expect(screen.getByTestId("ai-workspace-status")).toHaveFocus();

    vi.mocked(fetch)
      .mockResolvedValueOnce(reservationResponse(2, "a1200000-0000-4000-8000-000000000002"))
      .mockRejectedValueOnce(new Error("Simulated request failure"));
    fireEvent.change(composer, { target: { value: "Trigger a safe error" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(orb).toHaveAttribute("data-state", "thinking");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(orb).toHaveAttribute("data-state", "error");
    expect(screen.queryByTestId("optimistic-user-message")).toBeNull();

    const onlineSpy = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    expect(orb).toHaveAttribute("data-state", "offline");
    onlineSpy.mockRestore();
  });

  it("keeps simulated listening cancellation actionable through the stable window", () => {
    vi.useFakeTimers();
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    fireEvent.click(screen.getByTestId("bea-start-voice"));
    const orb = screen.getByTestId("bea-ai-orb");
    const conversation = screen.getByRole("tabpanel", { name: "Conversation" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(conversation).toHaveAttribute("data-voice-active", "true");
    expect(cancel).toHaveClass("bea-ai-voice-cancel");

    act(() => vi.advanceTimersByTime(1_999));
    expect(orb).toHaveAttribute("data-state", "listening");
    expect(cancel).toBeVisible();
    fireEvent.click(cancel);
    expect(screen.getByTestId("ai-command-workspace")).toHaveAttribute(
      "data-voice-session",
      "idle",
    );
    expect(conversation).toHaveAttribute("data-voice-active", "false");

    act(() => vi.advanceTimersByTime(1_000));
    expect(
      screen.queryByRole("textbox", { name: "Review and correct simulated transcript" }),
    ).toBeNull();
    const appCss = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    expect(appCss).toMatch(
      /\.bea-ai-conversation\[data-voice-active="true"\][\s\S]*?animation-play-state:\s*paused/u,
    );
    expect(appCss).toMatch(
      /\.bea-ai-voice-cancel:hover:not\(:disabled\)[\s\S]*?transform:\s*none/u,
    );
  });

  it("keeps the motion preference disabled until hydration attaches its handler", async () => {
    installMatchMedia(false);
    window.localStorage.setItem("bea:motion-profile:v1", "reduced");
    const app = (
      <MotionProvider>
        <MotionPreferenceControl />
      </MotionProvider>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(app);
    document.body.append(container);
    const serverSelect = container.querySelector("#bea-motion-preference");
    if (!(serverSelect instanceof HTMLSelectElement))
      throw new Error("Expected the server-rendered motion preference control.");
    expect(serverSelect).toBeDisabled();
    expect(serverSelect).toHaveAttribute("data-hydration-ready", "false");
    expect(serverSelect).toHaveValue("system");
    const recoverableErrors: unknown[] = [];
    const consoleError = vi.spyOn(console, "error");
    let root!: ReturnType<typeof hydrateRoot>;

    await act(async () => {
      root = hydrateRoot(container, app, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const hydratedSelect = container.querySelector("#bea-motion-preference");
    expect(hydratedSelect).toBe(serverSelect);
    expect(serverSelect).toBeEnabled();
    expect(serverSelect).toHaveAttribute("data-hydration-ready", "true");
    expect(serverSelect).toHaveValue("reduced");
    fireEvent.change(serverSelect, { target: { value: "full" } });
    expect(window.localStorage.getItem("bea:motion-profile:v1")).toBe("full");
    expect(recoverableErrors).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
  });

  it("defaults to Full Motion and persists an explicit reduced preference", async () => {
    installMatchMedia(false);
    const first = render(
      <MotionProvider>
        <MotionPreferenceControl />
      </MotionProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Active: Full Motion");
    expect(document.documentElement).toHaveAttribute("data-motion-profile", "full");
    expect(document.documentElement).toHaveAttribute("data-motion-preference", "system");
    fireEvent.change(screen.getByRole("combobox", { name: "Motion" }), {
      target: { value: "reduced" },
    });
    expect(window.localStorage.getItem("bea:motion-profile:v1")).toBe("reduced");
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-motion-profile", "reduced"),
    );
    first.unmount();

    window.localStorage.setItem("bea:motion-profile:v1", "full");
    installMatchMedia(true);
    const storedFull = render(
      <MotionProvider>
        <MotionPreferenceControl />
      </MotionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Motion" })).toHaveValue("full"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Active: Full Motion");
    expect(document.documentElement).toHaveAttribute("data-motion-preference", "full");
    expect(document.documentElement).toHaveAttribute("data-motion-profile", "full");
    storedFull.unmount();

    window.localStorage.setItem("bea:motion-profile:v1", "system");
    installMatchMedia(true);
    render(
      <MotionProvider>
        <MotionPreferenceControl />
      </MotionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Active: Reduced Motion"),
    );
    expect(screen.getByRole("combobox", { name: "Motion" })).toHaveValue("system");
    expect(document.documentElement).toHaveAttribute("data-motion-preference", "system");
    expect(document.documentElement).toHaveAttribute("data-motion-profile", "reduced");
    fireEvent.change(screen.getByRole("combobox", { name: "Motion" }), {
      target: { value: "full" },
    });
    expect(window.localStorage.getItem("bea:motion-profile:v1")).toBe("full");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Active: Full Motion"),
    );
    expect(document.documentElement).toHaveAttribute("data-motion-preference", "full");
    const sharedCss = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
    const appCss = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    expect(sharedCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?:root:not\(\[data-motion-preference="full"\]\)/u,
    );
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?:root:not\(\[data-motion-preference="full"\]\)/u,
    );
    const layoutSource = readFileSync(resolve(process.cwd(), "apps/web/app/layout.tsx"), "utf8");
    expect(layoutSource).toContain("MOTION_BOOTSTRAP");
    expect(layoutSource).toContain('localStorage.getItem("bea:motion-profile:v1")');
    expect(layoutSource).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(layoutSource).toContain('root.dataset.motionReady = "true"');
  });

  it("preserves prepaint reduced motion and pauses ambient surfaces for an owned busy load", async () => {
    installMatchMedia(false);
    window.localStorage.setItem("bea:motion-profile:v1", "reduced");
    document.documentElement.dataset.motionPreference = "reduced";
    document.documentElement.dataset.motionProfile = "reduced";
    document.documentElement.dataset.motionReady = "true";
    const profileWrites: string[] = [];
    const profileObserver = new MutationObserver((records) => {
      if (records.some((record) => record.attributeName === "data-motion-profile")) {
        profileWrites.push(document.documentElement.dataset.motionProfile ?? "");
      }
    });
    profileObserver.observe(document.documentElement, {
      attributeFilter: ["data-motion-profile"],
      attributes: true,
    });

    const view = render(
      <MotionProvider>
        <MotionPreferenceControl />
        <button className="bea-button" type="button" aria-busy="false">
          Load records
        </button>
      </MotionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Motion" })).toHaveValue("reduced"),
    );
    await act(async () => Promise.resolve());
    expect(profileWrites).not.toContain("full");
    expect(document.documentElement).toHaveAttribute("data-motion-profile", "reduced");
    expect(document.documentElement).toHaveAttribute("data-motion-load", "idle");

    view.rerender(
      <MotionProvider>
        <MotionPreferenceControl />
        <button className="bea-button" type="button" aria-busy="true">
          Load records
        </button>
      </MotionProvider>,
    );
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-motion-load", "busy"),
    );
    view.rerender(
      <MotionProvider>
        <MotionPreferenceControl />
        <button className="bea-button" type="button" aria-busy="false">
          Load records
        </button>
      </MotionProvider>,
    );
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-motion-load", "idle"),
    );
    profileObserver.disconnect();
  });

  it("defines shared glass motion tokens and pauses motion while hidden", async () => {
    const sharedCss = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
    const appCss = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    for (const token of [
      "--bea-motion-press-depth",
      "--bea-motion-panel-float-distance",
      "--bea-motion-panel-float-cycle",
      "--bea-motion-orb-float-cycle",
      "--bea-glass-opacity",
      "--bea-glass-border-opacity",
      "--bea-glow-intensity",
      "--bea-shadow-depth",
      "--bea-motion-pointer-tilt-range",
      "--bea-motion-parallax-range",
      "--bea-motion-artifact-stagger",
      "--bea-motion-workspace-distance",
    ]) {
      expect(sharedCss).toContain(token);
    }
    expect(sharedCss).toMatch(
      /:root\[data-motion-visibility="hidden"\][\s\S]*?animation-play-state:\s*paused !important/u,
    );
    expect(appCss).toContain("@keyframes bea-ai-orb-float");
    expect(appCss).toContain("@keyframes bea-workspace-enter");
    expect(sharedCss).toContain("@media (hover: hover) and (pointer: fine)");
    expect(sharedCss).toMatch(/\.bea-card:active[\s\S]*?--bea-motion-press-depth/u);
    expect(appCss).toMatch(
      /\.bea-ai-orb\[data-state="error"\] \.bea-ai-orb__halo\s*\{[\s\S]*?animation:\s*bea-ai-error/u,
    );
    expect(appCss).toMatch(
      /\.bea-ai-orb\[data-state="awaiting-confirmation"\] \.bea-ai-orb__ring--inner[\s\S]*?animation-play-state:\s*paused/u,
    );
    expect(appCss).toContain("@keyframes bea-ai-confirmation-attention");
    expect(appCss).toContain(':root[data-motion-load="busy"] .bea-ai-orb::before {');
    expect(appCss).not.toContain(':root[data-motion-load="busy"] .bea-ai-orb *');
    expect(appCss).toMatch(
      /\.bea-ai-orb\[data-state="executing"\] \.bea-ai-orb__ring[\s\S]*?animation-duration:\s*0\.95s/u,
    );
    const cardSource = readFileSync(resolve(process.cwd(), "packages/ui/src/card.tsx"), "utf8");
    expect(cardSource).toContain('cn("bea-card", "bea-floating-surface"');
    expect(sharedCss).toMatch(
      /@keyframes bea-surface-float[\s\S]*?transform:\s*translate3d\(0, var\(--bea-motion-panel-float-distance\), 0\)/u,
    );
    expect(sharedCss).toMatch(
      /:root\[data-motion-modal="open"\] \.bea-floating-surface::before[\s\S]*?animation-play-state:\s*paused/u,
    );
    expect(sharedCss).toMatch(
      /:root\[data-motion-load="busy"\] \.bea-floating-surface::before[\s\S]*?animation-play-state:\s*paused/u,
    );
    expect(appCss).toMatch(/\.bea-ai-conversation::before\s*\{[\s\S]*?animation-delay:/u);

    installMatchMedia(false);
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    render(<MotionProvider>Motion surface</MotionProvider>);
    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-motion-visibility", "hidden"),
    );
  });

  it("keeps interactive surfaces stable while pointer-transparent layers carry ambient motion", () => {
    const preview = snapshot({
      artifact: artifact({
        id: "artifact-stable-action-preview",
        type: "action-preview",
        title: "Create internal task",
        payload: {
          actionId: "action-stable-preview",
          executable: true,
          actingUser: "Owner Administrator",
          requiredPermission: "ai-command.task-action.execute",
          fields: { title: "Review stable preview", assignee: "Owner Administrator" },
        },
      }),
    });
    render(<AiCommandWorkspace initialSnapshot={preview} />);
    const artifactSurface = screen.getByTestId("workspace-artifact-action-preview");
    const review = screen.getByRole("button", { name: "Review and confirm task" });
    const orb = screen.getByTestId("bea-ai-orb");
    expect(artifactSurface).toHaveClass("bea-floating-surface");
    expect(review.closest(".bea-floating-surface")).toBe(artifactSurface);
    expect(orb).toHaveClass("bea-ai-orb");
    fireEvent.click(review);
    expect(screen.getByRole("dialog", { name: "Create this internal task?" })).toBeVisible();

    const sharedCss = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
    const appCss = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    expect(sharedCss).not.toMatch(/\.bea-floating-surface\s*\{[^}]*animation:/u);
    expect(sharedCss).not.toMatch(/\.bea-floating-surface\s*\{[^}]*will-change:/u);
    expect(sharedCss).toMatch(
      /\.bea-floating-surface::before\s*\{[^}]*animation:\s*bea-surface-float[^}]*pointer-events:\s*none/u,
    );
    expect(appCss).not.toMatch(/\.bea-ai-orb\s*\{[^}]*animation:/u);
    expect(appCss).toMatch(
      /\.bea-ai-orb::before\s*\{[^}]*animation:\s*bea-ai-orb-float[^}]*pointer-events:\s*none/u,
    );
  });

  it("transitions a notification row before refreshing its filtered list", async () => {
    vi.useFakeTimers();
    installMatchMedia(false);
    const refresh = vi.fn();
    setTestRouterRefresh(refresh);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(
      <MotionProvider>
        <article className="bea-list-presence-item" data-list-state="idle">
          <NotificationReadButton notificationId="notification-motion" />
        </article>
      </MotionProvider>,
    );

    const row = screen.getByRole("article");
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    expect(row).toHaveAttribute("data-list-state", "pending");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(row).toHaveAttribute("data-list-state", "exiting");
    expect(refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(239));
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledOnce();

    const sharedCss = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
    expect(sharedCss).toMatch(
      /\.bea-list-presence-item\[data-list-state="exiting"\][\s\S]*?opacity:\s*0/u,
    );
  });

  it("cleans MotionProvider media and visibility listeners on unmount", () => {
    const { listeners } = installMatchMedia(false);
    const mediaBaseline = listeners.size;
    let intersectionCallback: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const intersectionDisconnect = vi.fn();
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = intersectionDisconnect;
    }
    const mutationDisconnect = vi.fn();
    class TestMutationObserver {
      constructor(callback: MutationCallback) {
        void callback;
      }
      observe = vi.fn();
      disconnect = mutationDisconnect;
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.stubGlobal("MutationObserver", TestMutationObserver);
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const view = render(
      <MotionProvider>
        <div className="bea-floating-surface">Motion surface</div>
      </MotionProvider>,
    );
    expect(listeners.size).toBe(mediaBaseline + 1);
    expect(addSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    const surface = screen.getByText("Motion surface");
    const updatePlaybackRate = vi.fn();
    Object.defineProperty(surface, "getAnimations", {
      configurable: true,
      value: vi.fn(() => [{ animationName: "bea-surface-float", updatePlaybackRate }]),
    });
    expect(observe).toHaveBeenCalledWith(surface);
    act(() =>
      intersectionCallback?.(
        [{ isIntersecting: false, target: surface } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(surface).not.toHaveAttribute("data-motion-in-view");
    expect(updatePlaybackRate).toHaveBeenCalledWith(0);
    const visibilityListener = addSpy.mock.calls.find(
      ([eventName]) => eventName === "visibilitychange",
    )?.[1];
    view.unmount();
    expect(listeners.size).toBe(mediaBaseline);
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", visibilityListener);
    expect(intersectionDisconnect).toHaveBeenCalledOnce();
    expect(mutationDisconnect).toHaveBeenCalledOnce();
    expect(updatePlaybackRate).toHaveBeenLastCalledWith(1);
  });

  it("keeps floating-surface markup hydration-stable while pausing offscreen animation", async () => {
    installMatchMedia(false);
    let intersectionCallback: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe = observe;
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);

    const app = (
      <MotionProvider>
        <Card>Hydration-stable surface</Card>
      </MotionProvider>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(app);
    document.body.append(container);
    const serverSurface = container.querySelector(".bea-floating-surface");
    if (!(serverSurface instanceof HTMLElement)) throw new Error("Expected server surface markup.");
    const updatePlaybackRate = vi.fn();
    Object.defineProperty(serverSurface, "getAnimations", {
      configurable: true,
      value: vi.fn(() => [{ animationName: "bea-surface-float", updatePlaybackRate }]),
    });
    expect(serverSurface).not.toHaveAttribute("data-motion-in-view");
    const recoverableErrors: unknown[] = [];
    const consoleError = vi.spyOn(console, "error");
    let root!: ReturnType<typeof hydrateRoot>;

    await act(async () => {
      root = hydrateRoot(container, app, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const hydratedSurface = container.querySelector(".bea-floating-surface");
    expect(hydratedSurface).toBe(serverSurface);
    expect(observe).toHaveBeenCalledWith(serverSurface);
    act(() =>
      intersectionCallback?.(
        [{ isIntersecting: false, target: serverSurface } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(serverSurface).not.toHaveAttribute("data-motion-in-view");
    expect(updatePlaybackRate).toHaveBeenCalledWith(0);
    expect(recoverableErrors).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
  });

  it.each([
    {
      label: "profile menu",
      testId: "account-menu",
      app: (
        <ProfileMenu
          session={{
            personaId: userId,
            personaKey: "ownerAdministrator",
            displayName: "Owner Administrator",
            email: "owner@example.test",
            title: "Owner / Administrator",
            roleIds: [],
            createdAt: "2026-08-19T12:00:00.000Z",
            expiresAt: "2026-08-20T12:00:00.000Z",
          }}
        />
      ),
    },
    {
      label: "mobile navigation",
      testId: "mobile-navigation",
      app: (
        <MobileNavigation>
          <a href="/">Command Center</a>
        </MobileNavigation>
      ),
    },
  ])(
    "accepts browser-restored open state for the $label details without hydration errors",
    async ({ app, testId }) => {
      const container = document.createElement("div");
      container.innerHTML = renderToString(app);
      document.body.append(container);
      const serverDetails = container.querySelector(`[data-testid="${testId}"]`);
      if (!(serverDetails instanceof HTMLDetailsElement))
        throw new Error(`Expected server-rendered ${testId} details.`);
      const serverContent = serverDetails.textContent;
      expect(serverDetails.open).toBe(false);
      serverDetails.open = true;
      const recoverableErrors: unknown[] = [];
      const consoleError = vi.spyOn(console, "error");
      let root!: ReturnType<typeof hydrateRoot>;

      await act(async () => {
        root = hydrateRoot(container, app, {
          onRecoverableError: (error) => recoverableErrors.push(error),
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      const hydratedDetails = container.querySelector(`[data-testid="${testId}"]`);
      expect(hydratedDetails).toBe(serverDetails);
      expect(serverDetails.open).toBe(true);
      expect(serverDetails.textContent).toBe(serverContent);
      expect(recoverableErrors).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();

      await act(async () => root.unmount());
      container.remove();
    },
  );

  it("keeps account-menu actions in a header layer above the isolated main workspace", () => {
    const session = {
      provider: "demo" as const,
      personaId: userId,
      personaKey: "ownerAdministrator",
      displayName: "Owner Administrator",
      email: "owner@example.test",
      title: "Owner / Administrator",
      roleIds: [],
      createdAt: "2026-08-19T12:00:00.000Z",
      expiresAt: "2026-08-20T12:00:00.000Z",
    };
    render(
      <ApplicationShell
        logo={<span>BEA</span>}
        productName="Operations Command Center"
        navigation={null}
        mobileNavigation={null}
        header={<Header actions={<ProfileMenu session={session} />} />}
      >
        <button type="button">Main workspace action</button>
      </ApplicationShell>,
    );

    const menu = screen.getByTestId("account-menu") as HTMLDetailsElement;
    const summary = menu.querySelector("summary");
    if (!(summary instanceof HTMLElement)) throw new Error("Expected account-menu summary.");
    fireEvent.click(summary);
    expect(menu).toHaveAttribute("open");
    expect(within(menu).getByRole("button", { name: "Switch persona" })).toBeEnabled();
    expect(within(menu).getByRole("button", { name: "Sign out" })).toBeEnabled();

    const sharedCss = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
    const appCss = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    expect(sharedCss).toMatch(
      /\.bea-header\s*\{[\s\S]*?position:\s*relative;[\s\S]*?z-index:\s*20;/u,
    );
    expect(appCss).toMatch(/\.bea-profile-menu\[open\]\s*\{[\s\S]*?z-index:\s*1;/u);
    expect(appCss).toMatch(/\.bea-main-content\s*\{[\s\S]*?isolation:\s*isolate;/u);
  });

  it("cleans AI workspace timers, animation frames, and pending writes on unmount", async () => {
    vi.useFakeTimers();
    let frameId = 100;
    const frames = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    const cancelFrame = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const preview = snapshot({
      artifact: artifact({
        id: "artifact-cleanup-preview",
        type: "action-preview",
        title: "Create internal task",
        payload: {
          actionId: "action-cleanup",
          executable: true,
          actingUser: "Owner Administrator",
          requiredPermission: "ai-command.task-action.execute",
          fields: { title: "Cleanup timers", assignee: "Owner Administrator" },
        },
      }),
    });
    const result = snapshot({
      artifact: artifact({
        id: "artifact-cleanup-result",
        type: "action-result",
        title: "Task created",
        payload: {
          href: "/tasks/task-cleanup",
          message: "Cleanup task persisted exactly once.",
          reused: false,
        },
      }),
    });
    let pendingReservationSignal: AbortSignal | undefined;
    let resolvePendingReservation: ((response: Response) => void) | undefined;
    const pendingReservationAborted = vi.fn();
    vi.mocked(fetch)
      .mockResolvedValueOnce(reservationResponse(4, "a1200000-0000-4000-8000-000000000041"))
      .mockResolvedValueOnce(jsonResponse(preview))
      .mockResolvedValueOnce(jsonResponse(result, 200))
      .mockImplementationOnce((_input, init) => {
        pendingReservationSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolvePendingReservation = resolve;
          pendingReservationSignal?.addEventListener("abort", pendingReservationAborted, {
            once: true,
          });
        });
      });
    const view = render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Create a cleanup task" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(160));
    act(() => vi.advanceTimersByTime(680));
    expect(screen.getByRole("button", { name: "Review and confirm task" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Review and confirm task" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and create task" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(composer, { target: { value: "Start a request before unmount" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(pendingReservationSignal).toBeDefined();
    expect(pendingReservationSignal?.aborted).toBe(false);

    act(() => {
      for (const id of [...frames.keys()]) cancelFrame(id);
    });
    cancelFrame.mockClear();
    requestFrame.mockClear();

    const root = screen.getByTestId("ai-command-workspace");
    root.getBoundingClientRect = () => rect(1000, 800);
    const separator = screen.getByRole("separator", { name: "Resize AI Command panes" });
    firePointer(separator, "pointerdown", { pointerId: 71 });
    firePointer(separator, "pointermove", { clientX: 620, pointerId: 71 });
    expect(frames.size).toBe(1);
    const paneStyleBeforeUnmount = root.style.getPropertyValue("--bea-ai-pane-percent");
    const orb = screen.getByTestId("bea-ai-orb");
    const orbStyleBeforeUnmount = orb.style.cssText;
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");

    await act(async () => {
      view.unmount();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pendingReservationSignal?.aborted).toBe(true);
    expect(pendingReservationAborted).toHaveBeenCalledOnce();
    await act(async () => {
      resolvePendingReservation?.(reservationResponse(5, "a1200000-0000-4000-8000-000000000051"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(cancelFrame).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(5000));
    expect(root.style.getPropertyValue("--bea-ai-pane-percent")).toBe(paneStyleBeforeUnmount);
    expect(orb.style.cssText).toBe(orbStyleBeforeUnmount);
  });

  it("animates shared dialog exit before closing and skips it in reduced motion", async () => {
    vi.useFakeTimers();
    installMatchMedia(false);
    const closeSpy = vi.spyOn(HTMLDialogElement.prototype, "close");
    const dialogProps = {
      title: "Close with motion?",
      description: "The dialog remains modal through its bounded exit.",
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    };
    const full = render(
      <MotionProvider>
        <ConfirmationDialog open {...dialogProps} />
      </MotionProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Close with motion?" });
    expect(dialog).toHaveAttribute("data-state", "open");
    expect(document.documentElement).toHaveAttribute("data-motion-modal", "open");
    full.rerender(
      <MotionProvider>
        <ConfirmationDialog open={false} {...dialogProps} />
      </MotionProvider>,
    );
    expect(dialog).toHaveAttribute("data-state", "closing");
    expect((dialog as HTMLDialogElement).inert).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    const closingConfirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(closingConfirm).toBeDisabled();
    fireEvent.click(closingConfirm);
    expect(dialogProps.onConfirm).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(179));
    expect(closeSpy).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(dialog).toHaveAttribute("data-state", "closed");
    expect(document.documentElement).toHaveAttribute("data-motion-modal", "closed");
    full.unmount();

    closeSpy.mockClear();
    window.localStorage.setItem("bea:motion-profile:v1", "reduced");
    installMatchMedia(false);
    const reduced = render(
      <MotionProvider>
        <ConfirmationDialog open {...dialogProps} />
      </MotionProvider>,
    );
    await act(async () => Promise.resolve());
    expect(document.documentElement).toHaveAttribute("data-motion-profile", "reduced");
    const reducedDialog = screen.getByRole("dialog", { name: "Close with motion?" });
    reduced.rerender(
      <MotionProvider>
        <ConfirmationDialog open={false} {...dialogProps} />
      </MotionProvider>,
    );
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(reducedDialog).toHaveAttribute("data-state", "closed");

    const sharedCss = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
    expect(sharedCss).toContain("--bea-motion-dialog-exit-duration: 180ms");
    expect(sharedCss).toContain("@keyframes bea-dialog-exit");
  });

  it("keeps the current workspace visible until the staged replacement is ready", async () => {
    vi.useFakeTimers();
    const next = snapshot({
      artifact: artifact({
        id: "artifact-company-list",
        type: "company-list",
        title: "Companies",
        state: "empty",
        payload: { items: [] },
      }),
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(jsonResponse(next));
    const fullMotion = render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Show all companies" } });
    await act(async () => {
      fireEvent.keyDown(composer, { key: "Enter" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("workspace-artifact-help")).toBeVisible();
    expect(screen.queryByTestId("workspace-artifact-company-list")).toBeNull();
    expect(screen.getByText("New workspace results are ready.")).toBeVisible();
    act(() => vi.advanceTimersByTime(159));
    expect(screen.getByTestId("workspace-artifact-help")).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("workspace-artifact-company-list")).toBeVisible();
    expect(screen.getByText("Workspace updated.")).toBeVisible();
    const stage = screen
      .getByTestId("workspace-artifact-company-list")
      .closest("[data-transition]");
    expect(stage).toHaveAttribute("data-transition", "entering");
    act(() => vi.advanceTimersByTime(679));
    expect(stage).toHaveAttribute("data-transition", "entering");
    act(() => vi.advanceTimersByTime(1));
    expect(stage).toHaveAttribute("data-transition", "settled");
    expect(screen.getByText("Companies is ready.")).toBeVisible();

    fullMotion.unmount();
    window.localStorage.setItem("bea:motion-profile:v1", "reduced");
    installMatchMedia(false);
    vi.mocked(fetch)
      .mockResolvedValueOnce(reservationResponse())
      .mockResolvedValueOnce(jsonResponse(next));
    render(
      <MotionProvider>
        <AiCommandWorkspace initialSnapshot={snapshot()} />
      </MotionProvider>,
    );
    await act(async () => Promise.resolve());
    expect(document.documentElement).toHaveAttribute("data-motion-profile", "reduced");
    const reducedComposer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(reducedComposer, { target: { value: "Show all companies" } });
    await act(async () => {
      fireEvent.keyDown(reducedComposer, { key: "Enter" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("workspace-artifact-company-list")).toBeVisible();
    expect(
      screen.getByTestId("workspace-artifact-company-list").closest("[data-transition]"),
    ).toHaveAttribute("data-transition", "settled");
  });

  it("aborts a superseded client request and accepts only the latest generated response", async () => {
    let firstSignal: AbortSignal | undefined;
    vi.mocked(fetch)
      .mockResolvedValueOnce(reservationResponse(1, "a1200000-0000-4000-8000-000000000011"))
      .mockImplementationOnce((_input, init) => {
        firstSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          firstSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Superseded", "AbortError")),
            { once: true },
          );
        });
      })
      .mockResolvedValueOnce(reservationResponse(2, "a1200000-0000-4000-8000-000000000012"))
      .mockResolvedValueOnce(
        jsonResponse(
          snapshot({
            artifact: artifact({
              id: "artifact-latest",
              type: "company-list",
              title: "Latest companies",
              state: "empty",
              payload: { items: [] },
            }),
          }),
        ),
      );
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Show open tasks" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("optimistic-user-message")).toHaveTextContent("Show open tasks");
    fireEvent.change(composer, { target: { value: "Show all companies" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(screen.getByTestId("optimistic-user-message")).toHaveTextContent("Show all companies");
    expect(screen.getAllByTestId("optimistic-user-message")).toHaveLength(1);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(firstSignal?.aborted).toBe(true);
    const messageBodies = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => url === "/api/ai-command/messages")
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(messageBodies).toEqual([
      expect.objectContaining({
        generation: 1,
        requestId: "a1200000-0000-4000-8000-000000000011",
      }),
      expect.objectContaining({
        generation: 2,
        requestId: "a1200000-0000-4000-8000-000000000012",
      }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("workspace-artifact-company-list")).toBeVisible(),
    );
    expect(screen.queryByTestId("optimistic-user-message")).toBeNull();
    expect(
      within(screen.getByTestId("ai-workspace-header")).getByRole("heading", {
        name: "Latest companies",
      }),
    ).toBeVisible();
  });

  it("ignores delayed JSON from an older request after a newer request starts", async () => {
    vi.useFakeTimers();
    const older = snapshot({
      artifact: artifact({
        id: "artifact-older",
        type: "task-list",
        title: "Older tasks",
        payload: { items: [] },
      }),
    });
    const latestMessage = {
      id: "message-latest-user",
      role: "user" as const,
      content: "Show all companies",
      createdAt: "2026-08-19T12:01:00.000Z",
      provider: null,
      executionMs: null,
      links: [],
    };
    const latest = snapshot({
      messages: [...snapshot().messages, latestMessage],
      artifact: artifact({
        id: "artifact-latest-json",
        type: "company-list",
        title: "Latest companies",
        payload: { items: [] },
      }),
    });
    let resolveOlderJson!: (value: AiCommandSnapshot) => void;
    const delayedResponse = {
      json: () =>
        new Promise<AiCommandSnapshot>((resolve) => {
          resolveOlderJson = resolve;
        }),
      ok: true,
      status: 201,
    } as Response;
    vi.mocked(fetch)
      .mockResolvedValueOnce(reservationResponse(1, "a1200000-0000-4000-8000-000000000021"))
      .mockResolvedValueOnce(delayedResponse)
      .mockResolvedValueOnce(reservationResponse(2, "a1200000-0000-4000-8000-000000000022"))
      .mockResolvedValueOnce(jsonResponse(latest));
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Show open tasks" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("optimistic-user-message")).toHaveTextContent("Show open tasks");

    fireEvent.change(composer, { target: { value: "Show all companies" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(screen.getByTestId("optimistic-user-message")).toHaveTextContent("Show all companies");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(160));
    expect(screen.getByTestId("workspace-artifact-company-list")).toBeVisible();
    expect(screen.queryByTestId("optimistic-user-message")).toBeNull();
    expect(
      within(screen.getByLabelText("Conversation history")).getAllByText("Show all companies", {
        exact: true,
      }),
    ).toHaveLength(1);

    await act(async () => {
      resolveOlderJson(older);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("workspace-artifact-company-list")).toBeVisible();
    expect(screen.queryByTestId("workspace-artifact-task-list")).toBeNull();
    expect(
      within(screen.getByLabelText("Conversation history")).getAllByText("Show all companies", {
        exact: true,
      }),
    ).toHaveLength(1);
  });

  it("makes a reserved prior task preview non-actionable when message processing fails", async () => {
    const preview = snapshot({
      artifact: artifact({
        id: "artifact-reserved-preview",
        type: "action-preview",
        title: "Create internal task",
        payload: {
          actionId: "action-reserved-preview",
          executable: true,
          actingUser: "Owner Administrator",
          requiredPermission: "ai-command.task-action.execute",
          fields: { title: "Supersede this preview", assignee: "Owner Administrator" },
        },
      }),
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(reservationResponse(3, "a1200000-0000-4000-8000-000000000031"))
      .mockRejectedValueOnce(new Error("Credential-safe message rejection"));
    render(<AiCommandWorkspace initialSnapshot={preview} />);
    expect(screen.getByRole("button", { name: "Review and confirm task" })).toBeVisible();
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });
    fireEvent.change(composer, { target: { value: "Show a credential" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await screen.findByText("Credential-safe message rejection");
    expect(screen.queryByRole("button", { name: "Review and confirm task" })).toBeNull();
    expect(screen.getByText("Preview superseded")).toBeVisible();
    expect(screen.getByText(/can no longer be confirmed/u)).toBeVisible();
  });

  it("keeps a preview non-actionable when a stale reservation succeeds before the current reservation fails", async () => {
    const preview = snapshot({
      artifact: artifact({
        id: "artifact-stale-reservation-preview",
        type: "action-preview",
        title: "Create internal task",
        payload: {
          actionId: "action-stale-reservation-preview",
          executable: true,
          actingUser: "Owner Administrator",
          requiredPermission: "ai-command.task-action.execute",
          fields: { title: "Supersede this stale preview", assignee: "Owner Administrator" },
        },
      }),
    });
    let resolveStaleReservation!: (response: Response) => void;
    vi.mocked(fetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveStaleReservation = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("Current reservation failed"));
    render(<AiCommandWorkspace initialSnapshot={preview} />);
    expect(screen.getByRole("button", { name: "Review and confirm task" })).toBeVisible();
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });

    fireEvent.change(composer, { target: { value: "First request" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.change(composer, { target: { value: "Current request" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(screen.getByTestId("optimistic-user-message")).toHaveTextContent("Current request");

    await act(async () => {
      resolveStaleReservation(reservationResponse(4, "a1200000-0000-4000-8000-000000000041"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await screen.findByText("Current reservation failed");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Review and confirm task" })).toBeNull();
    expect(screen.getByText("Preview superseded")).toBeVisible();
    expect(screen.getByText(/can no longer be confirmed/u)).toBeVisible();
  });

  it("invalidates a preview before a stale successful reservation body settles when the current reservation fails", async () => {
    const preview = snapshot({
      artifact: artifact({
        id: "artifact-delayed-reservation-preview",
        type: "action-preview",
        title: "Create internal task",
        payload: {
          actionId: "action-delayed-reservation-preview",
          executable: true,
          actingUser: "Owner Administrator",
          requiredPermission: "ai-command.task-action.execute",
          fields: { title: "Supersede before body parsing", assignee: "Owner Administrator" },
        },
      }),
    });
    let resolveStaleReservation!: (response: Response) => void;
    let rejectStaleReservationBody: ((reason?: unknown) => void) | undefined;
    const delayedMalformedReservation = {
      ok: true,
      status: 201,
      json: () =>
        new Promise<never>((_resolve, reject) => {
          rejectStaleReservationBody = reject;
        }),
    } as Response;
    vi.mocked(fetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveStaleReservation = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("Current reservation failed after stale success"));
    render(<AiCommandWorkspace initialSnapshot={preview} />);
    const composer = screen.getByRole("textbox", { name: "Message BEA AI Command" });

    fireEvent.change(composer, { target: { value: "First request" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.change(composer, { target: { value: "Current request" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await act(async () => {
      resolveStaleReservation(delayedMalformedReservation);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await screen.findByText("Current reservation failed after stale success");
    expect(rejectStaleReservationBody).toEqual(expect.any(Function));
    expect(screen.queryByRole("button", { name: "Review and confirm task" })).toBeNull();
    expect(screen.getByText("Preview superseded")).toBeVisible();
    expect(screen.getByText(/can no longer be confirmed/u)).toBeVisible();

    await act(async () => {
      rejectStaleReservationBody?.(new SyntaxError("Malformed reservation response"));
      await Promise.resolve();
    });
  });

  it("coalesces orb pointer proximity through rAF, ignores touch, and resets on leave", () => {
    render(<AiCommandWorkspace initialSnapshot={snapshot()} />);
    fireEvent.click(screen.getByTestId("ai-interaction-mode-voice"));
    const orb = screen.getByTestId("bea-ai-orb");
    const readOrbBounds = vi.fn(() => rect(200, 200));
    orb.getBoundingClientRect = readOrbBounds;
    firePointer(orb, "pointermove", { clientX: 200, clientY: 0, pointerType: "mouse" });
    firePointer(orb, "pointermove", { clientX: 180, clientY: 20, pointerType: "mouse" });
    expect(orb.style.getPropertyValue("--bea-orb-tilt-x") || "0deg").toBe("0deg");
    expect(orb.style.getPropertyValue("--bea-orb-parallax-x") || "0rem").toBe("0rem");
    firePointer(orb, "pointermove", { clientX: 180, clientY: 20, pointerType: "touch" });
    expect(orb.style.getPropertyValue("--bea-orb-tilt-x") || "0deg").toBe("0deg");
    fireEvent.pointerLeave(orb);
    expect(orb.style.getPropertyValue("--bea-orb-tilt-y") || "0deg").toBe("0deg");
  });
});
