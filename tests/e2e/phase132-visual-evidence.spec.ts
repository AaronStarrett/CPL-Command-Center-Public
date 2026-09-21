import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

const evidenceDirectory = process.env.BEA_PHASE132_EVIDENCE_DIR;
const ownerPersona = "Workspace Owner — Chief Executive Officer";

test.skip(!evidenceDirectory, "Set BEA_PHASE132_EVIDENCE_DIR to capture visual evidence.");

async function activeShell(page: Page): Promise<Locator> {
  const shells = page.locator(".bea-application-shell");
  await expect
    .poll(async () => shells.filter({ visible: true }).count(), {
      message: "exactly one application shell is visible",
    })
    .toBe(1);
  return shells.filter({ visible: true });
}

async function signIn(page: Page) {
  await page.goto("/sign-in?returnTo=%2Fai-command");
  await page.getByRole("combobox", { name: "Demo persona" }).selectOption({ label: ownerPersona });
  await page.getByRole("button", { name: "Sign in to Command Center" }).click();
  await expect(page).toHaveURL(/\/ai-command(?:\?|$)/u);
  await activeShell(page);
}

async function submitCommand(page: Page, message: string, expectedRenderer: string) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/ai-command\/(?:messages|stream)$/u.test(response.url()),
  );
  const shell = await activeShell(page);
  await shell.getByTestId("ai-interaction-mode-type").click();
  const composer = shell.getByRole("textbox", { name: "Message BEA AI Command" });
  await expect(composer).toBeEnabled();
  await composer.fill(message);
  await composer.press("Enter");
  const response = await responsePromise;
  expect([200, 201]).toContain(response.status());
  await expect(shell.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
    "data-renderer",
    expectedRenderer,
  );
  await expect(shell.getByTestId("streaming-assistant-message")).toHaveCount(0);
}

async function settleMotion(shell: Locator) {
  await shell.getByTestId("ai-command-workspace").evaluate(async (root) => {
    await Promise.all(
      root
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(
            animation.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY,
          ),
        )
        .map(async (animation) => {
          await animation.finished.catch(() => undefined);
        }),
    );
  });
}

async function viewportEvidence(page: Page, shell: Locator, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await expect(shell.getByTestId("ai-command-workspace")).toBeVisible();
  const result = await shell.evaluate((shellElement) => {
    const root = shellElement.querySelector<HTMLElement>('[data-testid="ai-command-workspace"]')!;
    const tiles = Array.from(root.querySelectorAll<HTMLElement>("[data-primary-glass-tile]")).map(
      (tile) => {
        const bounds = tile.getBoundingClientRect();
        const style = getComputedStyle(tile);
        return {
          bottom: bounds.bottom,
          height: bounds.height,
          tile: tile.dataset.primaryGlassTile,
          top: bounds.top,
          visible: style.display !== "none" && bounds.width > 0 && bounds.height > 0,
          width: bounds.width,
        };
      },
    );
    const orb = root.querySelector<HTMLElement>('[data-testid="bea-ai-orb"]')!;
    const orbBounds = orb.getBoundingClientRect();
    const visibleConversation = tiles.find((tile) => tile.tile === "conversation" && tile.visible);
    const verticalScrollers = Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
      (element) =>
        !["SELECT", "TEXTAREA"].includes(element.tagName) &&
        ["auto", "scroll"].includes(getComputedStyle(element).overflowY) &&
        element.scrollHeight > element.clientHeight + 1,
    );
    const describeScroller = (element: HTMLElement) => ({
      testId: element.dataset.testid ?? element.tagName.toLowerCase(),
      tile:
        element.closest<HTMLElement>("[data-primary-glass-tile]")?.dataset.primaryGlassTile ??
        "outside",
    });
    const actualVerticalScrollers = verticalScrollers
      .filter((element) => !element.closest('dialog, [role="dialog"]'))
      .map(describeScroller);
    const transientOverlayVerticalScrollers = verticalScrollers
      .filter((element) => Boolean(element.closest('dialog, [role="dialog"]')))
      .map(describeScroller);
    return {
      actualVerticalScrollers,
      composerCount: root.querySelectorAll('[data-testid="ai-command-composer"]').length,
      height: window.innerHeight,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      interactionMode: root.getAttribute("data-interaction-mode"),
      messageScrollerCount: root.querySelectorAll('[data-testid="ai-message-scroller"]').length,
      nestedPermanentCards: root.querySelectorAll(
        "[data-primary-glass-tile] .bea-card, [data-primary-glass-tile] .bea-floating-surface",
      ).length,
      orbDiameter: orbBounds.width,
      orbRatio: visibleConversation ? orbBounds.height / visibleConversation.height : null,
      primaryTileCount: tiles.length,
      tiles,
      transientOverlayVerticalScrollers,
      verticalOverflow:
        document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      width: window.innerWidth,
      workspaceScrollerCount: root.querySelectorAll('[data-testid="ai-workspace-scroller"]').length,
    };
  });
  expect(result.width).toBe(width);
  expect(result.height).toBe(height);
  expect(result.primaryTileCount).toBe(2);
  expect(result.composerCount).toBe(1);
  expect(result.messageScrollerCount).toBe(1);
  expect(result.workspaceScrollerCount).toBe(1);
  expect(result.nestedPermanentCards).toBe(0);
  expect(result.horizontalOverflow).toBe(false);
  expect(result.verticalOverflow).toBe(false);
  const unexpectedVerticalScrollers = result.actualVerticalScrollers.filter(
    (scroller) =>
      !["ai-message-scroller", "ai-workspace-scroller", "workspace-pdf-scroller"].includes(
        scroller.testId,
      ),
  );
  expect(
    unexpectedVerticalScrollers,
    `Unexpected permanent vertical scrollers: ${JSON.stringify(unexpectedVerticalScrollers)}`,
  ).toEqual([]);
  for (const tile of ["conversation", "workspace"]) {
    expect(
      result.actualVerticalScrollers.filter((scroller) => scroller.tile === tile).length,
    ).toBeLessThanOrEqual(1);
  }
  if (width > 1024) {
    const visibleTiles = result.tiles.filter((tile) => tile.visible);
    expect(visibleTiles).toHaveLength(2);
    expect(Math.abs(visibleTiles[0].top - visibleTiles[1].top)).toBeLessThanOrEqual(1);
    expect(Math.abs(visibleTiles[0].bottom - visibleTiles[1].bottom)).toBeLessThanOrEqual(1);
    if (result.interactionMode === "voice") {
      expect(result.orbDiameter).toBeGreaterThanOrEqual(180);
      expect(result.orbDiameter).toBeLessThanOrEqual(430);
      expect(result.orbRatio).toBeGreaterThanOrEqual(0.28);
      expect(result.orbRatio).toBeLessThanOrEqual(0.72);
    }
  } else {
    expect(result.tiles.filter((tile) => tile.visible)).toHaveLength(1);
    await expect(shell.getByRole("tablist", { name: "AI Command panels" })).toBeVisible();
  }
  return result;
}

test("captures Phase 1.3.2 production visual evidence across the required UI states", async ({
  page,
}) => {
  test.slow();
  if (!evidenceDirectory) return;
  await mkdir(evidenceDirectory, { recursive: true });

  const browserErrors: string[] = [];
  const controlledTransportClosures: string[] = [];
  const successfulSseResponses = new WeakMap<
    Request,
    { readonly correlationId: string | null; readonly status: number }
  >();
  const expectedOrigin = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:3000").origin;
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      browserErrors.push(`console:${message.type()}:${message.text()}`);
    }
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror:${error.name}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown";
    const successfulSse = successfulSseResponses.get(request);
    if (failure === "net::ERR_ABORTED" && successfulSse) {
      controlledTransportClosures.push(
        `completed-sse:${successfulSse.status}:${successfulSse.correlationId ?? "no-correlation-id"}`,
      );
      return;
    }
    const requestUrl = new URL(request.url());
    const requestHeaders = request.headers();
    const referer = requestHeaders.referer ? new URL(requestHeaders.referer) : null;
    if (
      failure === "net::ERR_ABORTED" &&
      request.method() === "GET" &&
      requestUrl.origin === expectedOrigin &&
      requestUrl.searchParams.has("_rsc") &&
      requestHeaders.rsc === "1" &&
      referer?.pathname === "/ai-command"
    ) {
      controlledTransportClosures.push(`cancelled-next-rsc-prefetch:${requestUrl.pathname}`);
      return;
    }
    browserErrors.push(`requestfailed:${request.method()}:${request.url()}:${failure}`);
  });
  page.on("response", (response) => {
    const request = response.request();
    if (
      response.status() === 200 &&
      request.method() === "POST" &&
      new URL(response.url()).pathname === "/api/ai-command/stream" &&
      response.headers()["content-type"]?.includes("text/event-stream")
    ) {
      successfulSseResponses.set(request, {
        correlationId: response.headers()["x-correlation-id"] ?? null,
        status: response.status(),
      });
    }
    if (response.status() >= 400) {
      browserErrors.push(
        `http:${response.status()}:${response.request().method()}:${response.url()}`,
      );
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== expectedOrigin) {
      browserErrors.push(`external:${request.method()}:${request.url()}`);
    }
  });

  const captures: Array<Record<string, unknown>> = [];
  async function capture(fileName: string, width: number, height: number) {
    const shell = await activeShell(page);
    const metrics = await viewportEvidence(page, shell, width, height);
    await settleMotion(shell);
    const path = join(evidenceDirectory!, fileName);
    await page.screenshot({ animations: "disabled", fullPage: false, path });
    captures.push({ fileName, height, metrics, width });
  }

  await page.setViewportSize({ width: 1920, height: 1080 });
  await signIn(page);
  let shell = await activeShell(page);
  await expect(shell.getByTestId("ai-command-progressive-controls")).not.toHaveAttribute("open");
  await capture("01-1920x1080-quiet-two-tiles.png", 1920, 1080);

  await submitCommand(page, "Show open tasks", "task-list");
  shell = await activeShell(page);
  await expect(shell.locator('[data-workspace-content="records"]')).toBeVisible();
  await capture("02-1920x1080-active-record.png", 1920, 1080);

  await page.setViewportSize({ width: 1440, height: 900 });
  shell = await activeShell(page);
  const options = shell.getByTestId("ai-command-progressive-controls");
  await shell.getByTestId("ai-command-options-trigger").click();
  await expect(options).toHaveAttribute("open");
  const webSearch = shell.getByTestId("ai-web-search-toggle");
  if ((await webSearch.getAttribute("aria-pressed")) !== "true") await webSearch.click();
  await shell.getByTestId("ai-command-options-trigger").click();
  await expect(options).not.toHaveAttribute("open");
  await submitCommand(page, "Research synthetic envelope sources", "source-board");
  shell = await activeShell(page);
  await expect(
    shell
      .getByTestId("ai-workspace-panel")
      .getByRole("link", { name: "Synthetic BEA research fixture" }),
  ).toHaveCount(1);
  await capture("03-1440x900-research.png", 1440, 900);

  await shell.getByTestId("ai-command-options-trigger").click();
  await expect(options).toHaveAttribute("open");
  await webSearch.click();
  await expect(webSearch).toHaveAttribute("aria-pressed", "false");
  await shell.getByTestId("ai-command-options-trigger").click();
  await expect(options).not.toHaveAttribute("open");
  await submitCommand(page, "Create a chart of synthetic envelope priorities", "chart");
  shell = await activeShell(page);
  await expect(shell.locator('[data-workspace-content="chart"]')).toBeVisible();
  await capture("04-1440x900-chart.png", 1440, 900);

  await page.setViewportSize({ width: 1024, height: 768 });
  shell = await activeShell(page);
  await shell.getByRole("tab", { name: "Conversation" }).click();
  await submitCommand(page, "Create a PDF for the synthetic envelope handoff", "pdf");
  await shell.getByRole("tab", { name: "Workspace" }).click();
  await expect(shell.getByTestId("application-pdf-viewer")).toHaveAttribute("data-state", "ready");
  await expect(shell.getByTestId("workspace-pdf-scroller").locator("canvas")).toBeVisible();
  await capture("05-1024x768-pdf-workspace.png", 1024, 768);

  await shell.getByRole("tab", { name: "Conversation" }).click();
  await shell.getByTestId("ai-interaction-mode-voice").click();
  await shell.getByTestId("bea-start-voice").click();
  const transientTranscript = shell.getByTestId("ai-voice-transcript");
  await expect(transientTranscript).toBeVisible({ timeout: 5_000 });
  await expect(
    transientTranscript.getByRole("textbox", {
      name: "Review and correct simulated transcript",
    }),
  ).toBeVisible();
  await expect(transientTranscript.getByRole("button", { name: "Use transcript" })).toBeVisible();
  await expect(transientTranscript.getByRole("button", { name: "Discard" })).toBeVisible();
  await capture("06-1024x768-voice-transcript.png", 1024, 768);
  await shell.getByRole("button", { name: "Discard" }).click();
  await expect(shell.getByTestId("ai-voice-transcript")).toHaveCount(0);

  await page.setViewportSize({ width: 768, height: 1024 });
  await shell.getByRole("tab", { name: "Conversation" }).click();
  await capture("07-768x1024-narrow-conversation.png", 768, 1024);
  await shell.getByRole("tab", { name: "Workspace" }).click();
  await capture("08-768x1024-narrow-workspace.png", 768, 1024);

  await page.setViewportSize({ width: 1440, height: 900 });
  await submitCommand(page, "Create an internal follow-up task", "action-preview");
  shell = await activeShell(page);
  await shell.getByRole("button", { name: "Review and confirm task" }).click();
  await expect(page.getByRole("dialog", { name: "Create this internal task?" })).toBeVisible();
  await capture("09-1440x900-action-confirmation-overlay.png", 1440, 900);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await submitCommand(page, "Show recent activity", "activity-timeline");
  await expect(shell.locator('[data-workspace-content="activity"]')).toBeVisible();
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 640, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    let checks: Record<string, unknown> = {};
    if (viewport.width === 640) {
      const conversationTab = shell.getByRole("tab", { name: "Conversation" });
      const workspaceTab = shell.getByRole("tab", { name: "Workspace" });
      await conversationTab.click();
      await conversationTab.press("ArrowLeft");
      await expect(workspaceTab).toBeFocused();
      await expect(shell.getByTestId("ai-workspace-panel")).toBeVisible();
      await workspaceTab.press("ArrowRight");
      await expect(conversationTab).toBeFocused();
      await expect(shell.getByTestId("ai-conversation-panel")).toBeVisible();
      const narrowOptions = shell.getByTestId("ai-command-progressive-controls");
      await shell.getByTestId("ai-command-options-trigger").click();
      await expect(narrowOptions).toHaveAttribute("open");
      const narrowWebSearch = narrowOptions.getByTestId("ai-web-search-toggle");
      await expect(narrowWebSearch).toBeVisible();
      await expect(narrowWebSearch).toBeEnabled();
      const initialWebSearchState = await narrowWebSearch.getAttribute("aria-pressed");
      await narrowWebSearch.click();
      await expect(narrowWebSearch).not.toHaveAttribute(
        "aria-pressed",
        initialWebSearchState ?? "false",
      );
      await narrowWebSearch.click();
      await expect(narrowWebSearch).toHaveAttribute(
        "aria-pressed",
        initialWebSearchState ?? "false",
      );
      const configurationLink = narrowOptions.getByRole("link", {
        name: "Open AI configuration",
      });
      await expect(configurationLink).toBeVisible();
      await expect(configurationLink).toHaveAttribute("href", "/integrations/ai");
      const optionBounds = await narrowOptions
        .getByText("AI controls", { exact: true })
        .locator("../..")
        .boundingBox();
      expect(optionBounds).not.toBeNull();
      expect(optionBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((optionBounds?.x ?? 0) + (optionBounds?.width ?? 0)).toBeLessThanOrEqual(
        viewport.width,
      );
      await shell.getByTestId("ai-command-options-trigger").click();
      await expect(narrowOptions).not.toHaveAttribute("open");

      const accountMenu = shell.getByTestId("account-menu");
      await accountMenu.locator("summary").click();
      const motionSelect = accountMenu.getByRole("combobox", { name: "Motion" });
      await motionSelect.selectOption("reduced");
      await expect(page.locator("html")).toHaveAttribute("data-motion-profile", "reduced");
      await expect
        .poll(async () =>
          shell.locator("[data-primary-glass-tile]").evaluateAll((tiles) =>
            tiles.map((tile) => {
              const transform = getComputedStyle(tile).transform;
              return transform === "none" || new DOMMatrixReadOnly(transform).isIdentity;
            }),
          ),
        )
        .toEqual([true, true]);
      const reducedTileStates = await shell
        .locator("[data-primary-glass-tile]")
        .evaluateAll((tiles) =>
          tiles.map((tile) => ({ transform: getComputedStyle(tile).transform })),
        );
      const reducedTileTransforms = reducedTileStates.map(({ transform }) => transform);
      await motionSelect.selectOption("full");
      await expect(page.locator("html")).toHaveAttribute("data-motion-profile", "full");
      await accountMenu.locator("summary").click();
      checks = {
        configurationLinkVisible: true,
        keyboardWrap: true,
        progressiveControlsOpened: true,
        reducedTileTransforms,
        webSearchToggledAndRestored: true,
      };
    }
    captures.push({
      checks,
      kind: "metrics-only",
      metrics: await viewportEvidence(page, shell, viewport.width, viewport.height),
      ...viewport,
    });
  }

  await writeFile(
    join(evidenceDirectory, "phase132-visual-evidence.json"),
    `${JSON.stringify({ browserErrors, captures, controlledTransportClosures }, null, 2)}\n`,
    "utf8",
  );
  expect(browserErrors).toEqual([]);
});
