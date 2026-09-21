import { randomBytes } from "node:crypto";

import {
  expect,
  test,
  type APIResponse,
  type ConsoleMessage,
  type Locator,
  type Page,
  type Request,
  type Response as PlaywrightResponse,
  type TestInfo,
} from "@playwright/test";

const personas = [
  { label: "Workspace Owner — Chief Executive Officer", name: "Workspace Owner" },
  { label: "Sales Specialist — Sales", name: "Sales Specialist" },
  { label: "Operations Coordinator — Operations", name: "Operations Coordinator" },
  { label: "Executive Viewer — Read-only Executive", name: "Executive Viewer" },
  {
    label: "Integration Administrator — Integration Administrator",
    name: "Integration Administrator",
  },
] as const;

const ownerPersonaId = "10000000-0000-4000-8000-000000000001";
const salesPersonaId = "10000000-0000-4000-8000-000000000002";
const appOrigin = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
const unsafeReturnTargets = [
  "//evil.example/path",
  "/\\evil.example/path",
  "/\t/evil.example",
  "/\r\n/evil.example",
  "/%2f%2fevil.example/path",
  "/%5cevil.example/path",
  "/%09/evil.example",
  "/%0d%0a/evil.example",
  "/.//evil.example",
  "/%2e//evil.example",
  "/%2e%2e//evil.example",
] as const;

async function signIn(page: Page, personaLabel: string) {
  await page.goto("/sign-in?returnTo=%2F");
  await page.getByRole("combobox", { name: "Demo persona" }).selectOption({ label: personaLabel });
  await page.getByRole("button", { name: "Sign in to Command Center" }).click();
  await expect(page).toHaveURL(/\/command-center\/?$/u);
  await activeApplicationShell(page);
}

async function activeApplicationShell(page: Page): Promise<Locator> {
  const shells = page.locator(".bea-application-shell");
  await expect
    .poll(
      async () =>
        shells.evaluateAll((elements) => {
          const states = elements.map((element) => {
            const style = getComputedStyle(element);
            const bounds = element.getBoundingClientRect();
            const inactiveAncestor = element.closest('[hidden], [inert], [aria-hidden="true"]');
            return {
              inactive: Boolean(inactiveAncestor),
              visible:
                !inactiveAncestor &&
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                bounds.width > 0 &&
                bounds.height > 0,
            };
          });
          return {
            active: states.filter((state) => state.visible).length,
            unsafeInactive: states.filter((state) => !state.visible && !state.inactive).length,
          };
        }),
      { message: "exactly one shell is interactive and every streamed transition copy is hidden" },
    )
    .toEqual({ active: 1, unsafeInactive: 0 });

  const activeShell = shells.filter({ visible: true });
  await expect(activeShell).toHaveCount(1);
  return activeShell;
}

async function expectNavigationVisibility(
  page: Page,
  expected: { visible: readonly string[]; hidden: readonly string[] },
) {
  const shell = await activeApplicationShell(page);
  const navigation = shell.getByRole("navigation", {
    name: "Command Center navigation",
  });
  await expect(navigation).toBeVisible();
  const primary = new Set(["Command Center", "Automation Flow", "Company Details"]);
  const needsRecords =
    expected.visible.some((label) => !primary.has(label)) || expected.hidden.length > 0;
  if (needsRecords) {
    const more = navigation.getByRole("button", { name: "More" });
    if ((await more.count()) > 0 && (await more.getAttribute("aria-expanded")) !== "true") {
      await more.click();
    }
  }
  for (const label of expected.visible) {
    await expect(navigation.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  for (const label of expected.hidden) {
    await expect(navigation.getByRole("link", { name: label, exact: true })).toHaveCount(0);
  }
}

async function expectDirectRouteDenied(page: Page, path: string, resource: string) {
  await page.goto(path);
  await expect(page).toHaveURL(new RegExp(`/access-denied\\?resource=${resource}(?:&|$)`, "u"));
  await expect(page.getByTestId("access-denied")).toBeVisible();
}

interface AiCommandResponseBody {
  artifact: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
  };
}

async function submitAiCommand(page: Page, message: string): Promise<AiCommandResponseBody> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/ai-command\/messages$/u.test(response.url()),
  );
  const shell = await activeApplicationShell(page);
  await shell.getByTestId("ai-interaction-mode-type").click();
  const composer = shell.getByRole("textbox", { name: "Message BEA AI Command" });
  await composer.fill(message);
  await composer.press("Enter");
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  return (await response.json()) as AiCommandResponseBody;
}

async function submitStreamedAiCommand(
  page: Page,
  message: string,
  expectedRenderer: string,
): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && /\/api\/ai-command\/stream$/u.test(response.url()),
  );
  const shell = await activeApplicationShell(page);
  await shell.getByTestId("ai-interaction-mode-type").click();
  const composer = shell.getByRole("textbox", { name: "Message BEA AI Command" });
  await expect(composer).toBeEnabled();
  await composer.fill(message);
  await composer.press("Enter");
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/event-stream");
  await expect
    .poll(async () => {
      const renderer = await shell
        .getByTestId("workspace-artifact-renderer")
        .getAttribute("data-renderer");
      if (renderer === expectedRenderer) return renderer;
      const visibleAlerts = await page.locator('[role="alert"]:visible').allInnerTexts();
      const error = visibleAlerts.map((value) => value.trim()).find(Boolean);
      return error ? `UI error: ${error}` : renderer;
    })
    .toBe(expectedRenderer);
  await expect(shell.getByTestId("streaming-assistant-message")).toHaveCount(0);
}

function aiCommandDiagnosticPath(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return url.pathname.startsWith("/api/ai-command") || url.pathname.startsWith("/api/artifacts")
      ? url.pathname
      : undefined;
  } catch {
    return undefined;
  }
}

function captureSafeAiCommandBrowserDiagnostics(page: Page) {
  const entries: string[] = [];
  let sequence = 0;
  const record = (entry: string) => entries.push(`${String(++sequence).padStart(2, "0")} ${entry}`);
  const onRequest = (request: Request) => {
    const path = aiCommandDiagnosticPath(request.url());
    if (path) record(`request ${request.method()} ${path}`);
  };
  const onResponse = (response: PlaywrightResponse) => {
    const path = aiCommandDiagnosticPath(response.url());
    if (path) {
      record(
        `response ${response.request().method()} ${path} ${response.status()} ${response.headers()["content-type"] ?? "no-content-type"}`,
      );
    }
  };
  const onRequestFailed = (request: Request) => {
    const path = aiCommandDiagnosticPath(request.url());
    if (path) record(`requestfailed ${request.method()} ${path}`);
  };
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const location = message.location();
    const path = location.url ? aiCommandDiagnosticPath(location.url) : undefined;
    record(
      `console ${message.type()}${path ? ` ${path}:${location.lineNumber ?? 0}` : " (content redacted)"}`,
    );
  };
  const onPageError = (error: Error) => record(`pageerror ${error.name}`);

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  return {
    entries,
    dispose() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    },
  };
}

async function prepareAiTaskPreview(page: Page, taskTitle: string): Promise<string> {
  const body = await submitAiCommand(
    page,
    `Create an internal task titled "${taskTitle}" due tomorrow`,
  );
  expect(body.artifact.type).toBe("action-preview");
  expect(typeof body.artifact.payload.actionId).toBe("string");
  const preview = (await activeApplicationShell(page)).getByTestId(
    "workspace-artifact-action-preview",
  );
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(taskTitle);
  await expect(preview).toContainText("No task has been created yet.");
  return String(body.artifact.payload.actionId);
}

async function executeAiTaskPreview(page: Page, taskTitle: string): Promise<string> {
  await prepareAiTaskPreview(page, taskTitle);
  const preview = (await activeApplicationShell(page)).getByTestId(
    "workspace-artifact-action-preview",
  );
  await preview.getByRole("button", { name: "Review and confirm task" }).click();
  const dialog = page.getByRole("dialog", { name: "Create this internal task?" });
  await expect(dialog).toBeVisible();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/ai-command\/actions\/[^/]+\/confirm$/u.test(response.url()),
  );
  await dialog.getByRole("button", { name: "Confirm and create task" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as AiCommandResponseBody;
  expect(body.artifact.type).toBe("action-result");
  expect(body.artifact.payload.href).toMatch(/^\/tasks\//u);
  return String(body.artifact.payload.href);
}

async function expectPermissionDenied(response: APIResponse) {
  expect(response.status()).toBe(403);
  const body = (await response.json()) as {
    error?: { code?: string; message?: string; correlationId?: string };
    task?: unknown;
    artifact?: unknown;
  };
  expect(body.error?.code).toMatch(/permission-not-granted|access_denied/u);
  expect(body.error?.message).toBeTruthy();
  expect(body.error?.correlationId).toBeTruthy();
  expect(body).not.toHaveProperty("task");
  expect(body).not.toHaveProperty("artifact");
}

function uniqueTaskTitle(prefix: string, testInfo: TestInfo): string {
  return `${prefix} ${testInfo.workerIndex}-${testInfo.retry}-${Date.now().toString(36)}`;
}

type Phase11UrlExpectation = string | RegExp;

function resolvedUrlExpectation(expectation: Phase11UrlExpectation): Phase11UrlExpectation {
  return typeof expectation === "string" ? new URL(expectation, appOrigin).toString() : expectation;
}

async function retryPhase11NavigationOnce(operation: () => Promise<unknown>) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const aborted = error instanceof Error && error.message.includes("net::ERR_ABORTED");
      if (!aborted || attempt === 1) throw error;
    }
  }
}

async function expectPhase11AuthenticatedReady(page: Page, expectedUrl: Phase11UrlExpectation) {
  await expect(page).toHaveURL(resolvedUrlExpectation(expectedUrl));
  const shell = await activeApplicationShell(page);
  await expect(shell.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await expect(shell.locator('#bea-motion-preference[data-hydration-ready="true"]')).toBeEnabled();
}

async function gotoPhase11Authenticated(
  page: Page,
  path: string,
  expectedUrl: Phase11UrlExpectation = path,
) {
  await retryPhase11NavigationOnce(() => page.goto(path));
  await expectPhase11AuthenticatedReady(page, expectedUrl);
}

async function reloadPhase11Authenticated(page: Page, expectedUrl: Phase11UrlExpectation) {
  await retryPhase11NavigationOnce(() => page.reload());
  await expectPhase11AuthenticatedReady(page, expectedUrl);
}

async function expectPhase11DirectRouteDenied(page: Page, path: string, resource: string) {
  await gotoPhase11Authenticated(
    page,
    path,
    new RegExp(`/access-denied\\?resource=${resource}(?:&|$)`, "u"),
  );
  await expect(page.getByTestId("access-denied")).toBeVisible();
}

async function openPhase11ProfileMenu(page: Page) {
  const menu = (await activeApplicationShell(page)).getByTestId("account-menu");
  await expect(menu).toBeVisible();
  const open = await menu.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!open) await menu.locator("summary").click();
  await expect(menu.locator(".bea-profile-menu__panel")).toBeVisible();
  return menu;
}

for (const persona of personas) {
  test(`persists a SQL-backed session for ${persona.name}`, async ({ page }) => {
    await signIn(page, persona.label);
    let shell = await activeApplicationShell(page);
    await expect(shell.getByRole("heading", { name: new RegExp(persona.name, "u") })).toBeVisible();
    await page.goto("/account");
    shell = await activeApplicationShell(page);
    const main = shell.getByRole("main");
    await expect(main.getByRole("heading", { name: persona.name, exact: true })).toBeVisible();
    await expect(main.getByText("HttpOnly; token not exposed to client JavaScript")).toBeVisible();
  });
}

test("contains unsafe sign-in return targets on the configured origin", async ({ page }) => {
  for (const returnTo of unsafeReturnTargets) {
    const response = await page.request.post("/api/auth/sign-in", {
      form: { personaId: ownerPersonaId, returnTo },
      headers: { Origin: appOrigin },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe(`${appOrigin}/command-center`);
  }
});

test("contains unsafe persona-switch return targets on the configured origin", async ({ page }) => {
  await signIn(page, "Workspace Owner — Chief Executive Officer");
  for (const returnTo of unsafeReturnTargets) {
    const response = await page.request.post("/api/auth/switch-persona", {
      form: { personaId: salesPersonaId, returnTo },
      headers: { Origin: appOrigin },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe(`${appOrigin}/account`);
  }
});

test("signs in to the controlled shell and reports honest foundation state", async ({ page }) => {
  await signIn(page, "Workspace Owner — Chief Executive Officer");

  const shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: /Good day, Workspace Owner/u })).toBeVisible();
  await expect(shell.getByText("Demo mode", { exact: true })).toBeVisible();
  await expect(shell.getByTestId("account-menu")).toBeVisible();
  await expect(shell.getByRole("navigation", { name: "Command Center navigation" })).toBeVisible();
  await expect(shell.getByText("Synthetic Demo", { exact: true }).first()).toBeVisible();
  await expect(shell.getByTestId("bea-orb")).toBeVisible();
});

test("reports database, worker, and simulated provider health", async ({ request }) => {
  const response = await request.get("/api/health", {
    headers: { "X-Correlation-ID": "e2e-health-correlation" },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["x-correlation-id"]).toBe("e2e-health-correlation");
  await expect(response.json()).resolves.toMatchObject({
    status: "healthy",
    correlationId: "e2e-health-correlation",
    components: {
      web: "healthy",
      database: "healthy",
      worker: "healthy",
      providerRegistry: { total: 15, simulated: 15, connected: 0, failed: 0 },
    },
  });
});

test("returns the standard safe error shape to an unauthenticated API caller", async ({
  request,
}) => {
  const response = await request.get("/api/foundation/workflow", {
    headers: { "X-Correlation-ID": "e2e-unauthenticated" },
  });
  expect(response.status()).toBe(401);
  expect(response.headers()["x-correlation-id"]).toBe("e2e-unauthenticated");
  const body = (await response.json()) as {
    error: { code: string; message: string; correlationId: string; diagnostics?: unknown };
  };
  expect(body.error).toMatchObject({
    code: "authentication-required",
    correlationId: "e2e-unauthenticated",
  });
  expect(body.error).not.toHaveProperty("diagnostics");
});

test("enforces administration permission on the server", async ({ page }) => {
  await signIn(page, "Sales Specialist — Sales");
  const shell = await activeApplicationShell(page);
  await expect(
    shell
      .getByRole("navigation", { name: "Command Center navigation" })
      .getByRole("link", { name: "Administration", includeHidden: true }),
  ).toHaveCount(0);
  await page.goto("/administration");

  await expect(page).toHaveURL(/\/access-denied\?resource=administration/u);
  await expect(page.getByTestId("access-denied")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Access denied", level: 1 })).toBeVisible();
});

test("rotates the opaque session when switching personas", async ({ page, context }) => {
  await signIn(page, "Workspace Owner — Chief Executive Officer");
  const original = (await context.cookies()).find((cookie) => cookie.name === "bea_session")?.value;
  expect(original).toBeTruthy();

  await page.goto("/account");
  const menu = (await activeApplicationShell(page)).getByTestId("account-menu");
  await menu.locator("summary").click();
  await menu
    .getByRole("combobox", { name: "Demo persona" })
    .selectOption({ label: "Sales Specialist — Sales" });
  await menu.getByRole("button", { name: "Switch persona" }).click();

  await expect(page).toHaveURL(/\/account$/u);
  await expect(
    (await activeApplicationShell(page))
      .getByRole("main")
      .getByText("Sales Specialist", { exact: true }),
  ).toBeVisible();
  const rotated = (await context.cookies()).find((cookie) => cookie.name === "bea_session")?.value;
  expect(rotated).toBeTruthy();
  expect(rotated).not.toBe(original);

  await page.goto("/administration");
  await expect(page).toHaveURL(/\/access-denied\?resource=administration/u);
});

test("revokes the SQL session on sign-out", async ({ page, context }) => {
  await signIn(page, "Workspace Owner — Chief Executive Officer");
  const menu = (await activeApplicationShell(page)).getByTestId("account-menu");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/\/sign-in\?reason=signed-out/u);
  await expect(page.getByRole("heading", { name: "Open the local demo" })).toBeVisible();
  expect((await context.cookies()).find((cookie) => cookie.name === "bea_session")).toBeUndefined();
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in\?reason=required/u);
});

test("treats an expired or unknown opaque session as expired", async ({ page, context }) => {
  await context.addCookies([
    {
      name: "bea_session",
      value: "expired-or-revoked-e2e-session",
      url: appOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in\?reason=expired/u);
  await expect(page.getByText("Session expired", { exact: true })).toBeVisible();
});

test("persists and re-renders the authorized foundation workflow", async ({ page }) => {
  await signIn(page, "Workspace Owner — Chief Executive Officer");
  await page.goto("/records-overview");
  let shell = await activeApplicationShell(page);
  await shell.getByRole("button", { name: "Run foundation check" }).click();
  const dialog = page.getByRole("dialog", { name: "Run the foundation check?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Run check" }).click();
  await expect(
    shell.getByRole("status").filter({ hasText: "Foundation check succeeded" }),
  ).toBeVisible();

  await page.reload();
  shell = await activeApplicationShell(page);
  const latestRun = shell.getByTestId("latest-foundation-run");
  await expect(latestRun).toContainText("succeeded");
  await expect(latestRun).toContainText("database-health");
  await expect(latestRun).toContainText("provider-registry-health");
  await expect(latestRun.getByText("Correlation ID", { exact: true })).toBeVisible();
  await expect(latestRun.getByText("Idempotency key", { exact: true })).toBeVisible();

  await page.goto("/administration");
  shell = await activeApplicationShell(page);
  await expect(
    shell.getByText("foundation.system-health-check", { exact: true }).first(),
  ).toBeVisible();
});

test("runs a zero-external-call integration simulation and persists its audit", async ({
  page,
}) => {
  await signIn(page, "Workspace Owner — Chief Executive Officer");
  await page.goto("/integrations");
  let shell = await activeApplicationShell(page);
  const cards = shell.locator(".bea-integration-card");
  await expect(cards).toHaveCount(15);
  await expect(shell.getByText("15 simulated", { exact: true })).toBeVisible();

  const firstCard = cards.first();
  await firstCard.getByRole("button", { name: "Run simulation" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("No credentials or external systems are used");
  await dialog.getByRole("button", { name: "Run simulation" }).click();
  await expect(firstCard.getByRole("status")).toContainText(
    "Simulation completed with 0 external calls",
  );

  await page.goto("/administration");
  shell = await activeApplicationShell(page);
  await expect(shell.getByText("integration.simulate", { exact: true }).first()).toBeVisible();
  await page.reload();
  shell = await activeApplicationShell(page);
  await expect(shell.getByText("integration.simulate", { exact: true }).first()).toBeVisible();
});

test("runs the owner AI Command flow with persisted artifacts and duplicate-safe confirmation", async ({
  page,
  context,
}, testInfo) => {
  test.slow();
  const taskTitle = `E2E AI duplicate-safe field review ${testInfo.workerIndex}-${testInfo.retry}-${Date.now().toString(36)}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "Workspace Owner — Chief Executive Officer");
  await page.goto("/ai-command");

  let shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: "AI Command", level: 1 })).toBeVisible();
  await expect(shell.getByText("SIMULATED", { exact: true })).toBeVisible();
  await expect(shell.getByText("Your executive partner for BEA operations")).toBeVisible();

  const composer = shell.getByRole("textbox", { name: "Message BEA AI Command" });
  await composer.fill("Show open tasks");
  await composer.press("Enter");
  const taskArtifact = shell.getByTestId("workspace-artifact-task-list");
  await expect(taskArtifact).toBeVisible();
  await expect(taskArtifact.getByRole("heading", { name: "Open tasks" })).toBeVisible();
  await expect(taskArtifact.locator(".bea-ai-record").first()).toBeVisible();
  await expect(taskArtifact.getByRole("complementary", { name: "Artifact sources" })).toBeVisible();
  await expect(taskArtifact.locator(".bea-ai-sources a").first()).toHaveAttribute(
    "href",
    /^\/tasks\//u,
  );

  await composer.fill("Show connector health");
  await composer.press("Enter");
  const connectorArtifact = shell.getByTestId("workspace-artifact-integration-health-summary");
  await expect(connectorArtifact).toBeVisible();
  await expect(connectorArtifact.locator(".bea-ai-record")).toHaveCount(15);
  await expect(connectorArtifact.getByText("simulated", { exact: true })).toHaveCount(15);
  await expect(connectorArtifact).toContainText(
    "SIMULATED provider registry — zero live connections",
  );
  await expect(
    shell.getByText(/All 15 provider entries are simulated and none is live-connected/u),
  ).toBeVisible();
  await expect(shell.getByText(/No external system was contacted\.$/u)).toBeVisible();

  await composer.fill(
    `Create an internal task titled "${taskTitle}" assigned to Operations due tomorrow`,
  );
  await composer.press("Enter");
  const preview = shell.getByTestId("workspace-artifact-action-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(taskTitle);
  await expect(preview).toContainText("No task has been created yet.");
  await preview.getByRole("button", { name: "Review and confirm task" }).click();

  const dialog = page.getByRole("dialog", { name: "Create this internal task?" });
  await expect(dialog).toBeVisible();
  const confirmResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/ai-command\/actions\/[^/]+\/confirm$/u.test(response.url()),
  );
  await dialog.getByRole("button", { name: "Confirm and create task" }).click();
  const confirmResponse = await confirmResponsePromise;
  expect(confirmResponse.status()).toBe(200);
  const firstResult = (await confirmResponse.json()) as {
    artifact: { id: string; payload: { href?: unknown; idempotent?: unknown } };
  };
  expect(firstResult.artifact.payload.idempotent).toBe(true);
  expect(firstResult.artifact.payload.href).toMatch(/^\/tasks\//u);
  const taskHref = String(firstResult.artifact.payload.href);
  const resultArtifactId = firstResult.artifact.id;
  const correlationId = await confirmResponse.headerValue("x-correlation-id");
  expect(correlationId).toBeTruthy();

  const actionResult = shell
    .getByRole("tabpanel", { name: "Workspace" })
    .getByTestId("workspace-artifact-action-result");
  await expect(actionResult).toBeVisible();
  await expect(actionResult).toContainText("Task created");
  await expect(actionResult.getByRole("link", { name: "Open the created task" })).toHaveAttribute(
    "href",
    taskHref,
  );

  const duplicateResponse = await page.request.post(confirmResponse.url(), {
    headers: {
      Origin: appOrigin,
      "X-Correlation-ID": "e2e-ai-duplicate-confirmation",
    },
  });
  expect(duplicateResponse.status()).toBe(200);
  const duplicateResult = (await duplicateResponse.json()) as {
    artifact: { id: string; payload: { href?: unknown; idempotent?: unknown } };
  };
  expect(duplicateResult.artifact.id).toBe(resultArtifactId);
  expect(duplicateResult.artifact.payload.href).toBe(taskHref);
  expect(duplicateResult.artifact.payload.idempotent).toBe(true);

  await page.reload();
  shell = await activeApplicationShell(page);
  await expect(actionResult).toContainText("persisted exactly once");
  await expect(
    shell
      .getByRole("tabpanel", { name: "Conversation" })
      .getByText(/Repeated confirmation safely restores this same result/u),
  ).toBeVisible();

  await page.goto(taskHref);
  shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: taskTitle })).toBeVisible();
  await page.goto("/tasks");
  shell = await activeApplicationShell(page);
  await expect(shell.getByRole("link", { name: taskTitle, exact: true })).toHaveCount(1);

  await page.goto("/activities");
  shell = await activeApplicationShell(page);
  const taskActivity = shell.getByRole("row").filter({ hasText: taskTitle });
  await expect(taskActivity).toHaveCount(1);
  await expect(taskActivity).toContainText("task.created");
  await expect(shell.getByText("Task creation action approved.", { exact: true })).toBeVisible();
  await expect(
    shell.getByText("Confirmed task creation action executed.", { exact: true }),
  ).toBeVisible();

  await page.goto("/audit");
  shell = await activeApplicationShell(page);
  const auditRow = shell
    .getByRole("row")
    .filter({ hasText: "assistant.action-executed" })
    .filter({ hasText: "assistant.task.create" })
    .filter({ hasText: correlationId ?? "missing-correlation" });
  await expect(auditRow).toHaveCount(1);

  const menu = (await activeApplicationShell(page)).getByTestId("account-menu");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in\?reason=signed-out/u);
  expect((await context.cookies()).find((cookie) => cookie.name === "bea_session")).toBeUndefined();
});

test("shows the owner the full Phase 1 navigation and mutation controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "Workspace Owner — Chief Executive Officer");
  await expectNavigationVisibility(page, {
    visible: [
      "Search",
      "Companies",
      "Contacts",
      "Tasks",
      "Activities",
      "Notifications",
      "AI Command",
      "Integrations",
      "Workflow Runs",
      "Audit",
      "Administration",
    ],
    hidden: [],
  });

  await page.goto("/tasks");
  let shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(shell.getByRole("link", { name: "Create task" })).toBeVisible();
  await page.goto("/integrations");
  shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: "Integration Center", level: 1 })).toBeVisible();
  await expect(shell.getByRole("button", { name: "Run simulation" }).first()).toBeVisible();
});

test("enforces the Sales business, AI execution, and restricted-system matrix", async ({
  page,
}, testInfo) => {
  test.slow();
  const taskTitle = uniqueTaskTitle("E2E Sales AI permission task", testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "Sales Specialist — Sales");
  await expectNavigationVisibility(page, {
    visible: [
      "Search",
      "Companies",
      "Contacts",
      "Tasks",
      "Activities",
      "Notifications",
      "AI Command",
    ],
    hidden: ["Integrations", "Workflow Runs", "Audit", "Administration"],
  });
  for (const [path, resource] of [
    ["/integrations", "integrations"],
    ["/workflow-runs", "workflow-runs"],
    ["/audit", "audit"],
    ["/administration", "administration"],
  ] as const) {
    await expectDirectRouteDenied(page, path, resource);
  }
  await expectPermissionDenied(
    await page.request.post("/api/integrations/salesforce/simulate", {
      headers: { Origin: appOrigin },
    }),
  );

  await page.goto("/ai-command");
  const taskHref = await executeAiTaskPreview(page, taskTitle);
  await page.goto(taskHref);
  let shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: taskTitle, level: 1 })).toBeVisible();
  await page.goto(`/tasks?q=${encodeURIComponent(taskTitle)}&scope=mine`);
  shell = await activeApplicationShell(page);
  await expect(shell.getByRole("link", { name: taskTitle, exact: true })).toHaveCount(1);
});

test("enforces the Operations business, workflow, AI execution, and restricted-system matrix", async ({
  page,
}, testInfo) => {
  test.slow();
  const taskTitle = uniqueTaskTitle("E2E Operations AI permission task", testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "Operations Coordinator — Operations");
  await expectNavigationVisibility(page, {
    visible: [
      "Search",
      "Companies",
      "Contacts",
      "Tasks",
      "Activities",
      "Notifications",
      "AI Command",
      "Workflow Runs",
    ],
    hidden: ["Integrations", "Audit", "Administration"],
  });
  await page.goto("/workflow-runs");
  let shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: "Workflow runs", level: 1 })).toBeVisible();
  for (const [path, resource] of [
    ["/integrations", "integrations"],
    ["/audit", "audit"],
    ["/administration", "administration"],
  ] as const) {
    await expectDirectRouteDenied(page, path, resource);
  }
  await expectPermissionDenied(
    await page.request.post("/api/integrations/salesforce/simulate", {
      headers: { Origin: appOrigin },
    }),
  );

  await page.goto("/ai-command");
  const taskHref = await executeAiTaskPreview(page, taskTitle);
  await page.goto(taskHref);
  shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: taskTitle, level: 1 })).toBeVisible();
  await page.goto(`/tasks?q=${encodeURIComponent(taskTitle)}&scope=mine`);
  shell = await activeApplicationShell(page);
  await expect(shell.getByRole("link", { name: taskTitle, exact: true })).toHaveCount(1);
});

test("keeps the Executive business and AI experience read-only", async ({ page }, testInfo) => {
  test.slow();
  const taskTitle = uniqueTaskTitle("E2E Executive view-only preview", testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "Executive Viewer — Read-only Executive");
  await expectNavigationVisibility(page, {
    visible: [
      "Search",
      "Companies",
      "Contacts",
      "Tasks",
      "Activities",
      "Notifications",
      "AI Command",
    ],
    hidden: ["Integrations", "Workflow Runs", "Audit", "Administration"],
  });

  await page.goto("/tasks");
  let shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(shell.getByRole("link", { name: "Create task" })).toHaveCount(0);
  await page.goto("/notifications");
  shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
  await expect(shell.getByRole("button", { name: "Mark read" })).toHaveCount(0);
  for (const [path, resource] of [
    ["/tasks/new", "task-create"],
    ["/integrations", "integrations"],
    ["/workflow-runs", "workflow-runs"],
    ["/audit", "audit"],
    ["/administration", "administration"],
  ] as const) {
    await expectDirectRouteDenied(page, path, resource);
  }

  await expectPermissionDenied(
    await page.request.post("/api/tasks", {
      data: { title: taskTitle },
      headers: { Origin: appOrigin },
    }),
  );
  await expectPermissionDenied(
    await page.request.post("/api/tasks/not-a-task/complete", {
      headers: { Origin: appOrigin },
    }),
  );
  await expectPermissionDenied(
    await page.request.post("/api/notifications/not-a-notification/read", {
      headers: { Origin: appOrigin },
    }),
  );
  await expectPermissionDenied(
    await page.request.post("/api/integrations/salesforce/simulate", {
      headers: { Origin: appOrigin },
    }),
  );

  await page.goto("/ai-command");
  const actionId = await prepareAiTaskPreview(page, taskTitle);
  shell = await activeApplicationShell(page);
  const preview = shell.getByTestId("workspace-artifact-action-preview");
  await expect(preview.getByText("View-only preview", { exact: true })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Review and confirm task" })).toHaveCount(0);
  await expectPermissionDenied(
    await page.request.post(`/api/ai-command/actions/${encodeURIComponent(actionId)}/confirm`, {
      headers: { Origin: appOrigin },
    }),
  );
  await page.goto(`/tasks?q=${encodeURIComponent(taskTitle)}`);
  shell = await activeApplicationShell(page);
  await expect(shell.getByRole("link", { name: taskTitle, exact: true })).toHaveCount(0);
});

test("limits the Integration Administrator to integration, search, and connector-health tools", async ({
  page,
}, testInfo) => {
  test.slow();
  const taskTitle = uniqueTaskTitle("E2E Integration Admin denied task", testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "Integration Administrator — Integration Administrator");
  await expectNavigationVisibility(page, {
    visible: ["Search", "AI Command", "Integrations", "Administration"],
    hidden: [
      "Companies",
      "Contacts",
      "Tasks",
      "Activities",
      "Notifications",
      "Workflow Runs",
      "Audit",
    ],
  });
  for (const [path, resource] of [
    ["/companies", "companies"],
    ["/contacts", "contacts"],
    ["/tasks", "tasks"],
    ["/activities", "activities"],
    ["/notifications", "notifications"],
    ["/workflow-runs", "workflow-runs"],
    ["/audit", "audit"],
  ] as const) {
    await expectDirectRouteDenied(page, path, resource);
  }

  await page.goto("/search");
  let shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: "Search", level: 1 })).toBeVisible();
  await page.goto("/integrations");
  shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: "Integration Center", level: 1 })).toBeVisible();
  const firstIntegration = shell.locator(".bea-integration-card").first();
  await firstIntegration.getByRole("button", { name: "Run simulation" }).click();
  const integrationDialog = page.getByRole("dialog");
  await integrationDialog.getByRole("button", { name: "Run simulation" }).click();
  await expect(firstIntegration.getByRole("status")).toContainText(
    "Simulation completed with 0 external calls",
  );
  await page.goto("/administration");
  shell = await activeApplicationShell(page);
  await expect(shell.getByRole("heading", { name: "Administration", level: 1 })).toBeVisible();

  await page.goto("/ai-command");
  shell = await activeApplicationShell(page);
  const healthBody = await submitAiCommand(page, "Show connector health");
  expect(healthBody.artifact.type).toBe("integration-health-summary");
  const connectorArtifact = shell.getByTestId("workspace-artifact-integration-health-summary");
  await expect(connectorArtifact).toBeVisible();
  await expect(connectorArtifact.locator(".bea-ai-record")).toHaveCount(15);
  await expect(connectorArtifact.getByText("simulated", { exact: true })).toHaveCount(15);
  await expect(connectorArtifact).toContainText("zero live connections");

  const deniedTaskResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/ai-command\/messages$/u.test(response.url()),
  );
  const composer = shell.getByRole("textbox", { name: "Message BEA AI Command" });
  await composer.fill(`Create an internal task titled "${taskTitle}" due tomorrow`);
  await composer.press("Enter");
  await expectPermissionDenied(await deniedTaskResponsePromise);
  await expect(shell.getByTestId("workspace-artifact-action-preview")).toHaveCount(0);
  await expect(connectorArtifact).toBeVisible();
  await expectPermissionDenied(
    await page.request.post("/api/tasks", {
      data: { title: taskTitle },
      headers: { Origin: appOrigin },
    }),
  );
});

test("Phase 1.1 Administration matrix", async ({ page, context }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const matrix = [
    { persona: personas[0], allowed: true, auditDetail: true },
    { persona: personas[1], allowed: false, auditDetail: false },
    { persona: personas[2], allowed: false, auditDetail: false },
    { persona: personas[3], allowed: false, auditDetail: false },
    { persona: personas[4], allowed: true, auditDetail: false },
  ] as const;

  for (const entry of matrix) {
    await context.clearCookies();
    await signIn(page, entry.persona.label);
    await expectPhase11AuthenticatedReady(page, "/command-center");
    let shell = await activeApplicationShell(page);
    const administrationLink = shell
      .getByRole("navigation", { name: "Command Center navigation" })
      .getByRole("link", { name: "Administration", exact: true, includeHidden: true });
    await expect(administrationLink).toHaveCount(entry.allowed ? 1 : 0);

    await gotoPhase11Authenticated(
      page,
      "/administration",
      entry.allowed ? "/administration" : /\/access-denied\?resource=administration/u,
    );
    if (entry.allowed) {
      shell = await activeApplicationShell(page);
      await expect(shell.getByRole("heading", { name: "Administration", level: 1 })).toBeVisible();
      await expect(shell.getByRole("heading", { name: "Runtime facts" })).toBeVisible();
      await expect(shell.getByRole("heading", { name: "Current role grants" })).toBeVisible();
      const main = shell.getByRole("main");
      const auditCard = main.locator(".bea-card").filter({ hasText: "Persistent demo audit" });
      await expect(auditCard).toBeVisible();
      if (entry.auditDetail) {
        await expect(auditCard.locator("tbody tr")).not.toHaveCount(0);
        await expect(auditCard.getByText(/audit\.view permission/u)).toHaveCount(0);
      } else {
        await expect(
          auditCard.getByText("Audit detail requires the separate audit.view permission."),
        ).toBeVisible();
        await expect(auditCard.locator("tbody")).toHaveCount(0);
      }
      // Phase 1.1 has no administration mutation API/action/settings entrypoint; mutation is N/A.
      await expect(main.getByRole("button")).toHaveCount(0);
      await expect(
        main.getByRole("link", { name: /create|delete|edit|manage|settings/u }),
      ).toHaveCount(0);
    } else {
      await expect(page).toHaveURL(/\/access-denied\?resource=administration/u);
      await expect(page.getByTestId("access-denied")).toBeVisible();
      const deniedView = await page.locator("body").innerText();
      expect(deniedView).not.toContain("Runtime facts");
      expect(deniedView).not.toContain("Current role grants");
      expect(deniedView).not.toContain("Persistent demo audit");
    }
  }
});

test("five-persona Phase 1.1 acceptance", async ({ page, context }, testInfo) => {
  test.setTimeout(1_200_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const titleBase = uniqueTaskTitle("P11 persona action", testInfo);

  for (const persona of personas) {
    await context.clearCookies();
    await signIn(page, persona.label);
    await expectPhase11AuthenticatedReady(page, "/command-center");
    let shell = await activeApplicationShell(page);
    await expect(shell.getByText("BEA Operations Command Center").first()).toBeVisible();

    if (persona.name === "Workspace Owner") {
      await expectNavigationVisibility(page, {
        visible: [
          "Search",
          "Companies",
          "Contacts",
          "Tasks",
          "Activities",
          "Notifications",
          "AI Command",
          "Integrations",
          "Workflow Runs",
          "Audit",
          "Administration",
        ],
        hidden: [],
      });
      await page.evaluate(
        ({ motionKey, splitKey }) => {
          window.localStorage.removeItem(motionKey);
          window.localStorage.removeItem(splitKey);
        },
        {
          motionKey: "bea:motion-profile:v1",
          splitKey: `bea:ai-pane-percent:v1:${ownerPersonaId}`,
        },
      );
      let menu = await openPhase11ProfileMenu(page);
      await expect(menu.getByRole("status")).toContainText("Active: Full Motion");
      let motionSelect = menu.getByRole("combobox", { name: "Motion" });
      await expect(motionSelect).toHaveAttribute("data-hydration-ready", "true");
      await expect(motionSelect).toBeEnabled();
      await motionSelect.selectOption("reduced");
      await expect(page.locator("html")).toHaveAttribute("data-motion-profile", "reduced");
      await reloadPhase11Authenticated(page, "/command-center");
      await expect(page.locator("html")).toHaveAttribute("data-motion-profile", "reduced");
      menu = await openPhase11ProfileMenu(page);
      motionSelect = menu.getByRole("combobox", { name: "Motion" });
      await expect(motionSelect).toHaveAttribute("data-hydration-ready", "true");
      await expect(motionSelect).toBeEnabled();
      await motionSelect.selectOption("full");
      await expect(page.locator("html")).toHaveAttribute("data-motion-profile", "full");
      await menu.locator("summary").click();

      await gotoPhase11Authenticated(page, "/ai-command");
      shell = await activeApplicationShell(page);
      let separator = shell.getByRole("separator", { name: "Resize AI Command panes" });
      await expect(separator).toHaveAttribute("aria-valuenow", "36");
      await separator.press("ArrowRight");
      await expect(separator).toHaveAttribute("aria-valuenow", "38");
      await reloadPhase11Authenticated(page, "/ai-command");
      shell = await activeApplicationShell(page);
      separator = shell.getByRole("separator", { name: "Resize AI Command panes" });
      await expect(separator).toHaveAttribute("aria-valuenow", "38");
      const ownerTask = `${titleBase} owner`;
      const taskHref = await executeAiTaskPreview(page, ownerTask);
      await gotoPhase11Authenticated(page, taskHref);
      shell = await activeApplicationShell(page);
      await expect(shell.getByRole("heading", { name: ownerTask, level: 1 })).toBeVisible();
      for (const [path, heading] of [
        ["/integrations", "Integration Center"],
        ["/workflow-runs", "Workflow runs"],
        ["/audit", "Audit"],
        ["/administration", "Administration"],
      ] as const) {
        await gotoPhase11Authenticated(page, path);
        shell = await activeApplicationShell(page);
        await expect(shell.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
      }
      continue;
    }

    if (persona.name === "Sales Specialist") {
      await expectNavigationVisibility(page, {
        visible: [
          "Search",
          "Companies",
          "Contacts",
          "Tasks",
          "Activities",
          "Notifications",
          "AI Command",
        ],
        hidden: ["Integrations", "Workflow Runs", "Audit", "Administration"],
      });
      await gotoPhase11Authenticated(page, "/ai-command");
      const salesTask = `${titleBase} sales`;
      await executeAiTaskPreview(page, salesTask);
      for (const [path, resource] of [
        ["/integrations", "integrations"],
        ["/audit", "audit"],
        ["/administration", "administration"],
      ] as const) {
        await expectPhase11DirectRouteDenied(page, path, resource);
      }
      continue;
    }

    if (persona.name === "Operations Coordinator") {
      await expectNavigationVisibility(page, {
        visible: [
          "Search",
          "Companies",
          "Contacts",
          "Tasks",
          "Activities",
          "Notifications",
          "AI Command",
          "Workflow Runs",
        ],
        hidden: ["Integrations", "Audit", "Administration"],
      });
      await gotoPhase11Authenticated(page, "/workflow-runs");
      shell = await activeApplicationShell(page);
      await expect(shell.getByRole("heading", { name: "Workflow runs", level: 1 })).toBeVisible();
      await gotoPhase11Authenticated(page, "/ai-command");
      const operationsTask = `${titleBase} operations`;
      await executeAiTaskPreview(page, operationsTask);
      for (const [path, resource] of [
        ["/integrations", "integrations"],
        ["/audit", "audit"],
        ["/administration", "administration"],
      ] as const) {
        await expectPhase11DirectRouteDenied(page, path, resource);
      }
      continue;
    }

    if (persona.name === "Executive Viewer") {
      await expectNavigationVisibility(page, {
        visible: [
          "Search",
          "Companies",
          "Contacts",
          "Tasks",
          "Activities",
          "Notifications",
          "AI Command",
        ],
        hidden: ["Integrations", "Workflow Runs", "Audit", "Administration"],
      });
      await gotoPhase11Authenticated(page, "/tasks");
      shell = await activeApplicationShell(page);
      await expect(shell.getByRole("link", { name: "Create task" })).toHaveCount(0);
      await gotoPhase11Authenticated(page, "/ai-command");
      const executiveTask = `${titleBase} executive`;
      const actionId = await prepareAiTaskPreview(page, executiveTask);
      shell = await activeApplicationShell(page);
      const preview = shell.getByTestId("workspace-artifact-action-preview");
      await expect(preview.getByText("View-only preview", { exact: true })).toBeVisible();
      await expect(preview.getByRole("button", { name: "Review and confirm task" })).toHaveCount(0);
      await expectPermissionDenied(
        await page.request.post(`/api/ai-command/actions/${encodeURIComponent(actionId)}/confirm`, {
          headers: { Origin: appOrigin },
        }),
      );
      await expectPhase11DirectRouteDenied(page, "/tasks/new", "task-create");
      continue;
    }

    await expectNavigationVisibility(page, {
      visible: ["Search", "AI Command", "Integrations", "Administration"],
      hidden: [
        "Companies",
        "Contacts",
        "Tasks",
        "Activities",
        "Notifications",
        "Workflow Runs",
        "Audit",
      ],
    });
    await expectPhase11DirectRouteDenied(page, "/companies", "companies");
    await gotoPhase11Authenticated(page, "/ai-command");
    const health = await submitAiCommand(page, "Show connector health");
    expect(health.artifact.type).toBe("integration-health-summary");
    shell = await activeApplicationShell(page);
    const connectorArtifact = shell.getByTestId("workspace-artifact-integration-health-summary");
    await expect(connectorArtifact.locator(".bea-ai-record")).toHaveCount(15);
    await expect(connectorArtifact.getByText("simulated", { exact: true })).toHaveCount(15);
    const deniedTaskResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/ai-command\/messages$/u.test(response.url()),
    );
    const composer = shell.getByRole("textbox", { name: "Message BEA AI Command" });
    await composer.fill(`Create an internal task titled "${titleBase} integration" due tomorrow`);
    await composer.press("Enter");
    await expectPermissionDenied(await deniedTaskResponse);
    await expect(shell.getByTestId("workspace-artifact-action-preview")).toHaveCount(0);
    await expect(connectorArtifact).toBeVisible();
    await shell.getByTestId("ai-interaction-mode-voice").click();
    const orb = shell.getByTestId("bea-ai-orb");
    await expect(orb).toBeVisible();
    await expect(orb.locator(".bea-ai-orb__mic")).toHaveCount(0);

    const menu = (await activeApplicationShell(page)).getByTestId("account-menu");
    await menu.locator("summary").click();
    await menu.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in\?reason=signed-out/u);
    expect(
      (await context.cookies()).find((cookie) => cookie.name === "bea_session"),
    ).toBeUndefined();
  }
});

test("keeps AI Command panels matched and the composer anchored across six required viewport contexts", async ({
  page,
}) => {
  test.slow();
  const viewports = [
    { name: "wide desktop", width: 1920, height: 1080 },
    { name: "desktop", width: 1440, height: 900 },
    { name: "standard laptop", width: 1366, height: 768 },
    { name: "landscape", width: 1024, height: 768 },
    { name: "portrait", width: 768, height: 1024 },
    // 640 CSS pixels represents a 1280-pixel-wide browser at 200% zoom.
    { name: "narrow / 200% zoom equivalent", width: 640, height: 900 },
  ] as const;

  await page.setViewportSize({ width: viewports[0].width, height: viewports[0].height });
  await signIn(page, "Workspace Owner — Chief Executive Officer");
  await page.goto("/ai-command");

  let shell = await activeApplicationShell(page);
  const root = shell.getByTestId("ai-command-workspace");
  const panelSwitch = shell.getByRole("tablist", { name: "AI Command panels" });
  const conversationPanel = shell.getByTestId("ai-conversation-panel");
  const workspacePanel = shell.getByTestId("ai-workspace-panel");
  const composer = shell.getByTestId("ai-command-composer");
  const divider = shell.getByTestId("ai-pane-divider");
  await expect(shell.locator('[data-page="ai-command"]')).toBeVisible();
  const heightChain = await shell.evaluate((shellElement) => {
    const main = shellElement.querySelector<HTMLElement>(".bea-main-content");
    const animated = shellElement.querySelector<HTMLElement>(".bea-animated-page");
    return {
      animatedHeight: animated?.getBoundingClientRect().height ?? 0,
      animatedOverflow: animated ? getComputedStyle(animated).overflowY : "missing",
      legacyPageCount: shellElement.querySelectorAll(".bea-ai-command-page").length,
      mainOverflow: main ? getComputedStyle(main).overflowY : "missing",
    };
  });
  expect(heightChain.legacyPageCount, "legacy Phase 1.1 page marker removed").toBe(0);
  expect(heightChain.mainOverflow, "AI Command main owns no page scroll").toBe("hidden");
  expect(heightChain.animatedOverflow, "animated page owns no page scroll").toBe("hidden");
  expect(heightChain.animatedHeight, "AI Command full-height marker is active").toBeGreaterThan(0);

  async function expectDesktopPanelAlignment(label: string) {
    const geometry = await shell.evaluate((shellElement) => {
      const conversationElement = shellElement.querySelector<HTMLElement>(
        '[data-testid="ai-conversation-panel"]',
      );
      const workspaceElement = shellElement.querySelector<HTMLElement>(
        '[data-testid="ai-workspace-panel"]',
      );
      const composerElement = shellElement.querySelector<HTMLElement>(
        '[data-testid="ai-command-composer"]',
      );
      if (!conversationElement || !workspaceElement || !composerElement) return null;
      const conversationBounds = conversationElement.getBoundingClientRect();
      const workspaceBounds = workspaceElement.getBoundingClientRect();
      const composerBounds = composerElement.getBoundingClientRect();
      return {
        composerBottom: composerBounds.bottom,
        composerInsetAllowance:
          Number.parseFloat(getComputedStyle(conversationElement).borderBottomWidth) +
          1 / window.devicePixelRatio,
        conversationBottom: conversationBounds.bottom,
        conversationHeight: conversationBounds.height,
        conversationTop: conversationBounds.top,
        workspaceBottom: workspaceBounds.bottom,
        workspaceHeight: workspaceBounds.height,
        workspaceTop: workspaceBounds.top,
      };
    });
    expect(geometry, `${label} panel geometry`).not.toBeNull();
    if (!geometry) return;
    expect(
      Math.abs(geometry.conversationTop - geometry.workspaceTop),
      `${label} top alignment`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(geometry.conversationBottom - geometry.workspaceBottom),
      `${label} bottom alignment`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(geometry.conversationHeight - geometry.workspaceHeight),
      `${label} matched height`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(geometry.conversationBottom - geometry.composerBottom),
      `${label} composer bottom anchoring`,
    ).toBeLessThanOrEqual(geometry.composerInsetAllowance);
  }

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(root, viewport.name).toBeVisible();

    let conversationBounds;
    let workspaceBounds;
    if (viewport.width > 1024) {
      await expect(panelSwitch, viewport.name).toBeHidden();
      await expect(conversationPanel, viewport.name).toBeVisible();
      await expect(workspacePanel, viewport.name).toBeVisible();
      conversationBounds = await conversationPanel.boundingBox();
      workspaceBounds = await workspacePanel.boundingBox();
      const dividerBounds = await divider.boundingBox();
      expect(dividerBounds?.height, `${viewport.name} divider height`).toBeCloseTo(
        conversationBounds?.height ?? 0,
        0,
      );
    } else {
      await expect(panelSwitch, viewport.name).toBeVisible();
      const conversationTab = panelSwitch.getByRole("tab", { name: "Conversation" });
      const workspaceTab = panelSwitch.getByRole("tab", { name: "Workspace" });
      await conversationTab.click();
      await expect(conversationPanel, viewport.name).toBeVisible();
      await expect(workspacePanel, viewport.name).toBeHidden();
      conversationBounds = await conversationPanel.boundingBox();
      await conversationTab.press("ArrowLeft");
      await expect(workspaceTab, `${viewport.name} wrapped left tab`).toBeFocused();
      await expect(conversationPanel, viewport.name).toBeHidden();
      await expect(workspacePanel, viewport.name).toBeVisible();
      await workspaceTab.press("ArrowRight");
      await expect(conversationTab, `${viewport.name} wrapped right tab`).toBeFocused();
      await workspaceTab.click();
      await expect(conversationPanel, viewport.name).toBeHidden();
      await expect(workspacePanel, viewport.name).toBeVisible();
      workspaceBounds = await workspacePanel.boundingBox();
      await conversationTab.click();
    }

    expect(conversationBounds, `${viewport.name} conversation bounds`).not.toBeNull();
    expect(workspaceBounds, `${viewport.name} workspace bounds`).not.toBeNull();
    expect(
      Math.abs((conversationBounds?.y ?? 0) - (workspaceBounds?.y ?? 0)),
      `${viewport.name} top alignment`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        (conversationBounds?.y ?? 0) +
          (conversationBounds?.height ?? 0) -
          ((workspaceBounds?.y ?? 0) + (workspaceBounds?.height ?? 0)),
      ),
      `${viewport.name} bottom alignment`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((conversationBounds?.height ?? 0) - (workspaceBounds?.height ?? 0)),
      `${viewport.name} matched height`,
    ).toBeLessThanOrEqual(1);

    await expect(composer, `${viewport.name} composer`).toBeVisible();
    await expect(
      shell.getByTestId("bea-ai-orb"),
      `${viewport.name} orb hidden in Type`,
    ).toBeHidden();
    const composerBounds = await composer.boundingBox();
    const composerInsetAllowance = await conversationPanel.evaluate(
      (panel) =>
        Number.parseFloat(getComputedStyle(panel).borderBottomWidth) + 1 / window.devicePixelRatio,
    );
    expect(
      Math.abs(
        (conversationBounds?.y ?? 0) +
          (conversationBounds?.height ?? 0) -
          ((composerBounds?.y ?? 0) + (composerBounds?.height ?? 0)),
      ),
      `${viewport.name} composer bottom anchoring`,
    ).toBeLessThanOrEqual(composerInsetAllowance);
    if (viewport.name === "landscape") {
      const messageScrollerBounds = await shell.getByTestId("ai-message-scroller").boundingBox();
      expect(
        messageScrollerBounds?.height ?? 0,
        "landscape conversation history practical height",
      ).toBeGreaterThanOrEqual(64);
    }
    if (viewport.width > 1024) {
      await shell.getByTestId("ai-interaction-mode-voice").click();
      const orb = shell.getByTestId("bea-ai-orb");
      await expect(orb, `${viewport.name} Voice orb`).toBeVisible();
      await expect(composer, `${viewport.name} composer hidden in Voice`).toBeHidden();
      const orbBounds = await orb.boundingBox();
      const voiceConversationBounds = await conversationPanel.boundingBox();
      expect(orbBounds, `${viewport.name} orb bounds`).not.toBeNull();
      expect(orbBounds?.width ?? 0, `${viewport.name} orb minimum diameter`).toBeGreaterThanOrEqual(
        180,
      );
      expect(orbBounds?.width ?? 0, `${viewport.name} orb maximum diameter`).toBeLessThanOrEqual(
        430,
      );
      expect(orbBounds?.height ?? 0, `${viewport.name} circular orb`).toBeCloseTo(
        orbBounds?.width ?? 0,
        0,
      );
      expect(orbBounds?.x ?? 0, `${viewport.name} orb left containment`).toBeGreaterThanOrEqual(
        (voiceConversationBounds?.x ?? 0) - 1,
      );
      expect(
        (orbBounds?.x ?? 0) + (orbBounds?.width ?? 0),
        `${viewport.name} orb right containment`,
      ).toBeLessThanOrEqual(
        (voiceConversationBounds?.x ?? 0) + (voiceConversationBounds?.width ?? 0) + 1,
      );
      await shell.getByTestId("ai-interaction-mode-type").click();
      await expect(composer, `${viewport.name} composer restored`).toBeVisible();
    }

    await expect(
      shell.getByTestId("ai-suggestion-rail"),
      `${viewport.name} permanent suggestion rail removed`,
    ).toHaveCount(0);
    await expect(
      shell.getByTestId("ai-capability-launcher"),
      `${viewport.name} permanent launchers removed`,
    ).toHaveCount(0);

    const overflow = await shell.evaluate((shellElement) => {
      const command = shellElement.querySelector<HTMLElement>(
        "[data-testid='ai-command-workspace']",
      )!;
      const styledOwners = Array.from(command.querySelectorAll<HTMLElement>("[data-testid]"))
        .filter((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowY))
        .map((element) => element.dataset.testid)
        .filter(Boolean);
      const unexpectedActualScrollers = Array.from(command.querySelectorAll<HTMLElement>("*"))
        .filter(
          (element) =>
            !["TEXTAREA", "SELECT"].includes(element.tagName) &&
            ["auto", "scroll"].includes(getComputedStyle(element).overflowY) &&
            element.scrollHeight > element.clientHeight + 1 &&
            !["ai-message-scroller", "ai-workspace-scroller"].includes(
              element.dataset.testid ?? "",
            ),
        )
        .map((element) => element.dataset.testid ?? element.className);
      return {
        horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
        conversationOwnsOuterScroll:
          command.querySelector<HTMLElement>("[data-testid='ai-conversation-panel']")!
            .scrollHeight >
          command.querySelector<HTMLElement>("[data-testid='ai-conversation-panel']")!
            .clientHeight +
            1,
        workspaceOwnsOuterScroll:
          command.querySelector<HTMLElement>("[data-testid='ai-workspace-panel']")!.scrollHeight >
          command.querySelector<HTMLElement>("[data-testid='ai-workspace-panel']")!.clientHeight +
            1,
        styledOwners,
        unexpectedActualScrollers,
      };
    });
    expect(overflow.horizontal, `${viewport.name} page horizontal overflow`).toBe(false);
    expect(overflow.vertical, `${viewport.name} page vertical overflow`).toBe(false);
    expect(overflow.conversationOwnsOuterScroll, `${viewport.name} conversation panel scroll`).toBe(
      false,
    );
    expect(overflow.workspaceOwnsOuterScroll, `${viewport.name} workspace panel scroll`).toBe(
      false,
    );
    expect(overflow.styledOwners.sort(), `${viewport.name} intentional scroll owners`).toEqual([
      "ai-message-scroller",
      "ai-workspace-scroller",
    ]);
    expect(
      overflow.unexpectedActualScrollers,
      `${viewport.name} duplicate vertical scrollers`,
    ).toEqual([]);
  }

  await page.setViewportSize({ width: 1366, height: 768 });
  const motionMenu = await openPhase11ProfileMenu(page);
  const motionSelect = motionMenu.getByRole("combobox", { name: "Motion" });
  await motionSelect.selectOption("reduced");
  await expect(page.locator("html")).toHaveAttribute("data-motion-profile", "reduced");
  await expect
    .poll(
      async () =>
        root.locator("[data-primary-glass-tile]").evaluateAll((tiles) =>
          tiles.map((tile) => {
            const transform = getComputedStyle(tile).transform;
            return transform === "none" || new DOMMatrixReadOnly(transform).isIdentity;
          }),
        ),
      { message: "application-selected reduced motion disables outer tile transforms" },
    )
    .toEqual([true, true]);
  await motionSelect.selectOption("full");
  await expect(page.locator("html")).toHaveAttribute("data-motion-profile", "full");
  await motionMenu.locator("summary").click();
  await submitAiCommand(page, "Show open tasks");
  await expect(shell.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
    "data-renderer",
    "task-list",
  );
  await expectDesktopPanelAlignment("after artifact");
  const keyboardValue = Number(await divider.getAttribute("aria-valuenow"));
  await divider.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", String(keyboardValue + 2));
  await root.evaluate(async (command) => {
    await Promise.all(
      command.getAnimations().map(async (animation) => {
        await animation.finished.catch(() => undefined);
      }),
    );
  });
  await expectDesktopPanelAlignment("after keyboard resize");
  const afterKeyboardResize = await conversationPanel.boundingBox();
  const dividerBounds = await divider.boundingBox();
  expect(dividerBounds, "mouse divider bounds").not.toBeNull();
  await page.mouse.move(
    (dividerBounds?.x ?? 0) + (dividerBounds?.width ?? 0) / 2,
    (dividerBounds?.y ?? 0) + (dividerBounds?.height ?? 0) / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    (dividerBounds?.x ?? 0) + (dividerBounds?.width ?? 0) / 2 + 64,
    (dividerBounds?.y ?? 0) + (dividerBounds?.height ?? 0) / 2,
  );
  await page.mouse.up();
  await root.evaluate(async (command) => {
    await Promise.all(
      command.getAnimations().map(async (animation) => {
        await animation.finished.catch(() => undefined);
      }),
    );
  });
  const afterMouseResize = await conversationPanel.boundingBox();
  expect(
    Math.abs((afterMouseResize?.width ?? 0) - (afterKeyboardResize?.width ?? 0)),
    "mouse divider width change",
  ).toBeGreaterThan(20);
  await expectDesktopPanelAlignment("after mouse resize");
  await page.reload();
  shell = await activeApplicationShell(page);
  await expect(shell.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
    "data-renderer",
    "task-list",
  );
  await expectDesktopPanelAlignment("after reload");
});

test("scrolls long Phase 1.3.3 cockpit fixtures across six required viewport contexts", async ({
  page,
}) => {
  test.slow();
  const viewports = [
    { name: "wide desktop", width: 1920, height: 1080 },
    { name: "desktop", width: 1440, height: 900 },
    { name: "standard laptop", width: 1366, height: 768 },
    { name: "landscape", width: 1024, height: 768 },
    { name: "portrait", width: 768, height: 1024 },
    { name: "narrow / 200% zoom equivalent", width: 640, height: 900 },
  ] as const;

  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page, "Workspace Owner — Chief Executive Officer");
  await page.goto("/ai-command");
  let shell = await activeApplicationShell(page);

  // Use real application turns so React owns the long transcript while this isolated browser
  // test remains deterministic and credential-free.
  for (let index = 1; index <= 5; index += 1) {
    await submitAiCommand(page, `Show open tasks for scroll verification ${index}`);
  }

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    shell = await activeApplicationShell(page);
    const panelSwitch = shell.getByRole("tablist", { name: "AI Command panels" });
    const conversationPanel = shell.getByTestId("ai-conversation-panel");
    const workspacePanel = shell.getByTestId("ai-workspace-panel");
    if (viewport.width <= 1024) {
      await panelSwitch.getByRole("tab", { name: "Conversation" }).click();
    }
    await expect(conversationPanel, `${viewport.name} conversation`).toBeVisible();

    const transcript = shell.getByTestId("ai-message-scroller");
    const fadeRegion = shell.locator('[data-transcript-region="single-scroll-owner"]');
    await expect
      .poll(
        () => transcript.evaluate((element) => element.scrollHeight > element.clientHeight + 1),
        { message: `${viewport.name} long transcript overflows its single owner` },
      )
      .toBe(true);
    const fade = await fadeRegion.evaluate((element) => {
      const overlay = getComputedStyle(element, "::after");
      return {
        display: overlay.display,
        pointerEvents: overlay.pointerEvents,
      };
    });
    expect(fade.display, `${viewport.name} orb-overlap fade removed`).toBe("none");
    expect(fade.pointerEvents, `${viewport.name} fade is visual only`).toBe("none");

    await shell.getByTestId("ai-interaction-mode-voice").click();
    const orbLayers = await shell.getByTestId("bea-ai-orb").evaluate((orb) => {
      const shellLayer = orb.querySelector<HTMLElement>('[data-orb-layer="outer-glass"]');
      const core = orb.querySelector<HTMLElement>('[data-orb-layer="core-mark"]');
      return {
        coreOpacity: core ? getComputedStyle(core).opacity : "missing",
        outerBackdrop: shellLayer ? getComputedStyle(shellLayer).backdropFilter : "missing",
        outerPointerEvents: shellLayer ? getComputedStyle(shellLayer).pointerEvents : "missing",
      };
    });
    expect(orbLayers.outerBackdrop, `${viewport.name} layered glass`).not.toBe("none");
    expect(orbLayers.outerPointerEvents, `${viewport.name} outer orb pointer safety`).toBe("none");
    expect(orbLayers.coreOpacity, `${viewport.name} core remains readable`).toBe("1");
    await shell.getByTestId("ai-interaction-mode-type").click();

    await transcript.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(transcript).toHaveAttribute("data-auto-follow", "paused");
    const jump = shell.getByTestId("ai-jump-to-latest");
    await expect(jump, `${viewport.name} jump control`).toBeVisible();
    await transcript.focus();
    await transcript.press("PageDown");
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await transcript.press("Home");
    await expect
      .poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeLessThanOrEqual(1);
    await jump.click();
    await expect(transcript).toHaveAttribute("data-auto-follow", "following");
    await expect
      .poll(() =>
        transcript.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(48);

    if (viewport.width <= 1024) {
      await panelSwitch.getByRole("tab", { name: "Workspace" }).click();
    }
    await expect(workspacePanel, `${viewport.name} workspace`).toBeVisible();
    const workspace = shell.getByTestId("ai-workspace-scroller");
    await workspace.evaluate((element, label) => {
      element.querySelector('[data-testid="phase133-browser-long-fixture"]')?.remove();
      const fixture = document.createElement("section");
      fixture.dataset.testid = "phase133-browser-long-fixture";
      fixture.setAttribute("aria-label", `Long report fixture for ${label}`);
      const heading = document.createElement("h2");
      heading.textContent = "Long report browser fixture";
      fixture.append(heading);
      for (let index = 1; index <= 48; index += 1) {
        const paragraph = document.createElement("p");
        paragraph.textContent = `Section ${index}. Deterministic long report content verifies the continuous glass workspace, readable selection, and end-to-end reachability.`;
        fixture.append(paragraph);
      }
      const link = document.createElement("a");
      link.href = "https://example.invalid/phase133-browser-fixture";
      link.textContent = "Long report source";
      fixture.append(link);
      element.append(fixture);
      element.scrollTop = 0;
    }, viewport.name);
    await expect
      .poll(
        () => workspace.evaluate((element) => element.scrollHeight > element.clientHeight + 1),
        { message: `${viewport.name} long workspace overflows its single owner` },
      )
      .toBe(true);
    await workspace.focus();
    await workspace.press("End");
    await expect.poll(() => workspace.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await workspace.press("Home");
    await expect
      .poll(() => workspace.evaluate((element) => element.scrollTop))
      .toBeLessThanOrEqual(1);
    await workspace.press("PageDown");
    await expect.poll(() => workspace.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(
      workspace.getByRole("link", { name: "Long report source" }),
      `${viewport.name} long-content link`,
    ).toHaveAttribute("href", "https://example.invalid/phase133-browser-fixture");
    const workspaceContract = await workspace.evaluate((element) => ({
      horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
      owner: element.dataset.scrollOwner,
      pageHorizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      unexpectedNestedOwners: Array.from(element.querySelectorAll<HTMLElement>("*"))
        .filter(
          (candidate) =>
            ["auto", "scroll"].includes(getComputedStyle(candidate).overflowY) &&
            candidate.scrollHeight > candidate.clientHeight + 1,
        )
        .map((candidate) => candidate.dataset.testid ?? candidate.className),
    }));
    expect(workspaceContract.owner, `${viewport.name} workspace owner`).toBe("workspace");
    expect(workspaceContract.horizontalOverflow, `${viewport.name} workspace overflow`).toBe(false);
    expect(workspaceContract.pageHorizontalOverflow, `${viewport.name} page overflow`).toBe(false);
    expect(workspaceContract.unexpectedNestedOwners, `${viewport.name} nested owners`).toEqual([]);
  }

  await page.setViewportSize({ width: 1366, height: 768 });
  shell = await activeApplicationShell(page);
  const transcript = shell.getByTestId("ai-message-scroller");
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(transcript).toHaveAttribute("data-auto-follow", "paused");
  const deliberateHistoryPosition = await transcript.evaluate((element) => element.scrollTop);
  await submitAiCommand(page, "Show open tasks while I keep reading the earliest messages");
  expect(await transcript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(
    deliberateHistoryPosition + 1,
  );
  await expect(transcript).toHaveAttribute("data-auto-follow", "paused");
  await shell.getByTestId("ai-jump-to-latest").click();
  await expect(transcript).toHaveAttribute("data-auto-follow", "following");
});

test("keeps AI Command capabilities and divider operable in a true touch context", async ({
  browser,
}) => {
  const touchContext = await browser.newContext({
    baseURL: appOrigin,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 1280, height: 800 },
  });
  try {
    const touchPage = await touchContext.newPage();
    await signIn(touchPage, "Workspace Owner — Chief Executive Officer");
    await touchPage.goto("/ai-command");
    const touchShell = await activeApplicationShell(touchPage);
    expect(await touchPage.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    const touchDivider = touchShell.getByTestId("ai-pane-divider");
    await expect(touchDivider).toBeVisible();
    const touchDividerBounds = await touchDivider.boundingBox();
    expect(touchDividerBounds, "touch divider bounds").not.toBeNull();
    const dividerValueBeforeTouch = Number(await touchDivider.getAttribute("aria-valuenow"));
    const cdp = await touchContext.newCDPSession(touchPage);
    const startX = (touchDividerBounds?.x ?? 0) + (touchDividerBounds?.width ?? 0) / 2;
    const startY = (touchDividerBounds?.y ?? 0) + (touchDividerBounds?.height ?? 0) / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: startX, y: startY, id: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: startX + 64, y: startY, id: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect
      .poll(async () => Number(await touchDivider.getAttribute("aria-valuenow")))
      .not.toBe(dividerValueBeforeTouch);

    await touchPage.setViewportSize({ width: 768, height: 1024 });
    await touchShell.getByRole("tab", { name: "Conversation" }).click();
    await expect(touchDivider).toBeHidden();
    await touchShell.getByTestId("ai-command-options-trigger").tap();
    const webSearchToggle = touchShell.getByTestId("ai-web-search-toggle");
    await expect(webSearchToggle).toBeVisible();
    const webSearchState = await webSearchToggle.getAttribute("aria-pressed");
    await webSearchToggle.tap();
    await expect(webSearchToggle).toHaveAttribute(
      "aria-pressed",
      webSearchState === "true" ? "false" : "true",
    );
  } finally {
    await touchContext.close();
  }
});

test("exposes safe OpenAI administration only to dual-permission administrators", async ({
  browser,
}) => {
  test.slow();
  for (const persona of [
    "Workspace Owner — Chief Executive Officer",
    "Integration Administrator — Integration Administrator",
  ]) {
    const administratorContext = await browser.newContext({ baseURL: appOrigin });
    try {
      const administratorPage = await administratorContext.newPage();
      await signIn(administratorPage, persona);
      await administratorPage.goto("/integrations/ai");
      const panel = (await activeApplicationShell(administratorPage)).getByTestId(
        "openai-administration-panel",
      );
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("openai-api-key-status")).toContainText(
        /not_configured|configured|invalid/u,
      );
      await expect(panel.getByTestId("openai-billing-notice")).toBeVisible();
      await expect(panel.getByTestId("openai-manual-model-controls")).toBeVisible();
      await expect(panel.getByTestId("openai-manual-model-id")).toBeVisible();
      await expect(panel.getByTestId("openai-capability-editor")).toBeVisible();
      await expect(panel.getByTestId("openai-capability-attestation")).toBeVisible();
      const apiKeyInput = panel.getByLabel("OpenAI API key");
      await expect(apiKeyInput).toHaveAttribute("type", "password");
      await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
      await expect(apiKeyInput).toHaveValue("");
      await expect(panel.locator('input[name*="key" i]')).toHaveCount(0);
      await expect(panel.getByText("Credentials are never displayed.")).toBeVisible();
    } finally {
      await administratorContext.close();
    }
  }

  const normalRoleContext = await browser.newContext({ baseURL: appOrigin });
  try {
    const normalRolePage = await normalRoleContext.newPage();
    await signIn(normalRolePage, "Sales Specialist — Sales");
    await normalRolePage.goto("/integrations/ai");
    await expect(normalRolePage).toHaveURL(/\/access-denied\?resource=integration-detail/u);
    await expect(normalRolePage.getByTestId("access-denied")).toBeVisible();
    await expect(normalRolePage.getByTestId("openai-administration-panel")).toHaveCount(0);
  } finally {
    await normalRoleContext.close();
  }
});

test("runs and reopens the Demo research source-board chart and PDF artifact chain", async ({
  browser,
  page,
}, testInfo) => {
  test.slow();
  const diagnostics = captureSafeAiCommandBrowserDiagnostics(page);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "Workspace Owner — Chief Executive Officer");
    await page.goto("/ai-command");
    let shell = await activeApplicationShell(page);

    const uploadResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && /\/api\/artifacts\/upload$/u.test(response.url()),
    );
    await shell.getByTestId("ai-artifact-upload-input").setInputFiles({
      name: "synthetic-handoff.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic envelope handoff for Demo analysis."),
    });
    const uploadResponse = await uploadResponsePromise;
    expect(uploadResponse.status()).toBe(201);
    const uploadBody = (await uploadResponse.json()) as { artifact: { id: string } };
    expect(uploadBody.artifact.id).toMatch(/^art_[a-f0-9]{32}$/u);
    await expect(shell.getByTestId("ai-uploaded-artifact")).toContainText("synthetic-handoff.txt");
    const attachedRequestPromise = page.waitForRequest(
      (request) => request.method() === "POST" && /\/api\/ai-command\/stream$/u.test(request.url()),
    );
    await submitStreamedAiCommand(page, "Analyze the attached synthetic envelope handoff", "chart");
    const attachedRequest = await attachedRequestPromise;
    expect(attachedRequest.postDataJSON()).toMatchObject({
      inputArtifactIds: [uploadBody.artifact.id],
    });
    await expect(shell.getByTestId("ai-uploaded-artifact")).toHaveCount(0);

    const webSearchToggle = shell.getByTestId("ai-web-search-toggle");
    await webSearchToggle.click();
    await expect(webSearchToggle).toHaveAttribute("aria-pressed", "true");
    await submitStreamedAiCommand(page, "Research synthetic envelope sources", "source-board");
    await expect(shell.getByLabel("Artifact sources")).toContainText("Sources and citations");
    await webSearchToggle.click();
    await expect(webSearchToggle).toHaveAttribute("aria-pressed", "false");

    await submitStreamedAiCommand(
      page,
      "Create a source board for synthetic envelope sources",
      "source-board",
    );
    await expect(shell.getByTestId("workspace-artifact-renderer")).toContainText("Synthetic");

    await submitStreamedAiCommand(page, "Create a chart of synthetic envelope priorities", "chart");
    const chartRenderer = shell.getByTestId("workspace-artifact-renderer");
    await expect(chartRenderer).toContainText("Roof");
    await expect(chartRenderer).toContainText("Facade");
    await expect(chartRenderer.locator("article")).toHaveCount(4);
    await expect(chartRenderer.locator("script")).toHaveCount(0);

    await submitStreamedAiCommand(page, "Create a PDF for the synthetic envelope handoff", "pdf");
    const pdfToolbar = shell.getByTestId("workspace-pdf-toolbar");
    await expect(pdfToolbar).toBeVisible();
    const pdfViewer = shell.getByTestId("application-pdf-viewer");
    const pdfScroller = shell.getByTestId("workspace-pdf-scroller");
    const pdfCanvas = pdfScroller.locator("canvas");
    await expect(pdfViewer).toHaveAttribute("data-state", "ready");
    await expect(pdfCanvas).toBeVisible();
    await expect(pdfCanvas).toHaveAttribute("data-page", "1");
    await expect(pdfToolbar).toContainText(/Page 1 of \d+/u);
    await expect(pdfScroller.locator("iframe")).toHaveCount(0);
    const fitWidth = await pdfCanvas.evaluate((canvas) => canvas.style.width);
    await pdfToolbar.getByRole("button", { name: "Next page" }).click();
    await expect(pdfCanvas).toHaveAttribute("data-page", "2");
    await expect(pdfCanvas).toHaveAttribute("aria-label", /page 2$/u);
    await pdfToolbar.getByRole("button", { name: "Zoom in" }).click();
    await expect(pdfToolbar.getByRole("button", { name: "Fit to width" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect.poll(() => pdfCanvas.evaluate((canvas) => canvas.style.width)).not.toBe(fitWidth);
    await pdfToolbar.getByRole("button", { name: "Fit to width" }).click();
    await expect(pdfToolbar.getByRole("button", { name: "Fit to width" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const downloadLink = pdfToolbar.getByRole("link", { name: "Download PDF" });
    const downloadHref = await downloadLink.getAttribute("href");
    expect(downloadHref).toMatch(/^\/api\/artifacts\/art_[a-f0-9]{32}\/download$/u);
    const previewHref = downloadHref?.replace(/\/download$/u, "/preview");
    expect(previewHref).toMatch(/^\/api\/artifacts\/art_[a-f0-9]{32}\/preview$/u);
    const [ownerDownload, ownerPreview] = await Promise.all([
      page.request.get(downloadHref ?? ""),
      page.request.get(previewHref ?? ""),
    ]);
    expect(ownerDownload.status()).toBe(200);
    expect(ownerDownload.headers()["content-type"]).toContain("application/pdf");
    expect(ownerPreview.status()).toBe(200);
    expect(ownerPreview.headers()["content-type"]).toContain("application/pdf");

    await page.reload();
    shell = await activeApplicationShell(page);
    await expect(shell.getByTestId("workspace-artifact-renderer")).toHaveAttribute(
      "data-renderer",
      "pdf",
    );
    await expect(shell.getByTestId("workspace-pdf-toolbar")).toBeVisible();
    await expect(shell.getByTestId("application-pdf-viewer")).toHaveAttribute(
      "data-state",
      "ready",
    );

    const secondUserContext = await browser.newContext({ baseURL: appOrigin });
    try {
      const secondUserPage = await secondUserContext.newPage();
      await signIn(secondUserPage, "Sales Specialist — Sales");
      const [deniedDownload, deniedPreview] = await Promise.all([
        secondUserContext.request.get(downloadHref ?? ""),
        secondUserContext.request.get(previewHref ?? ""),
      ]);
      expect(deniedDownload.status()).toBe(404);
      expect(deniedPreview.status()).toBe(404);
    } finally {
      await secondUserContext.close();
    }
  } finally {
    diagnostics.dispose();
    const body = diagnostics.entries.join("\n") || "No AI Command browser events were observed.";
    console.info(`[safe-ai-command-browser-diagnostics]\n${body}`);
    await testInfo.attach("safe-ai-command-browser-diagnostics", {
      body,
      contentType: "text/plain",
    });
  }
});

test("uses the desktop navigation above the iPad breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "Workspace Owner — Chief Executive Officer");
  const shell = await activeApplicationShell(page);
  const desktopNavigation = shell.getByTestId("desktop-navigation");
  await expect(desktopNavigation).toBeVisible();
  await expect(shell.getByTestId("mobile-navigation")).toBeHidden();
  const navigationHasHorizontalOverflow = await desktopNavigation.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  );
  expect(navigationHasHorizontalOverflow).toBe(false);
});

test("uses the compact navigation at iPad portrait width", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await signIn(page, "Workspace Owner — Chief Executive Officer");

  const shell = await activeApplicationShell(page);
  await expect(shell.getByTestId("desktop-navigation")).toBeHidden();
  const compactNavigation = shell.getByTestId("mobile-navigation");
  await expect(compactNavigation).toBeVisible();
  await compactNavigation.locator("summary").click();
  await expect(
    compactNavigation
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("link", { name: /Integrations/u }),
  ).toBeVisible();
});

test("Phase 1.1 listener lifecycle browser probe", async ({ page }) => {
  test.setTimeout(300_000);
  const consoleFailures: string[] = [];
  const pageFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleFailures.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => pageFailures.push(error.message));
  await page.addInitScript(() => {
    window.localStorage.setItem("bea:motion-profile:v1", "full");
  });

  await signIn(page, "Workspace Owner — Chief Executive Officer");
  await expectPhase11AuthenticatedReady(page, "/command-center");
  await gotoPhase11Authenticated(page, "/ai-command");
  let shell = await activeApplicationShell(page);
  await shell.getByTestId("ai-interaction-mode-voice").click();
  const orb = shell.getByTestId("bea-ai-orb");
  await expect(orb).toBeVisible();
  await shell.getByTestId("bea-start-voice").click();
  await expect(orb).toHaveAttribute("data-state", "listening");
  await shell.getByRole("button", { name: "Cancel" }).click();
  await expect(shell.getByTestId("ai-command-workspace")).toHaveAttribute(
    "data-voice-session",
    "idle",
  );
  await reloadPhase11Authenticated(page, "/ai-command");
  await gotoPhase11Authenticated(page, "/integrations");
  shell = await activeApplicationShell(page);
  await shell
    .locator(".bea-integration-card")
    .first()
    .getByRole("button", { name: "Run simulation" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  const menu = (await activeApplicationShell(page)).getByTestId("account-menu");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in\?reason=signed-out/u);

  expect(pageFailures).toEqual([]);
  expect(consoleFailures).toEqual([]);
});

test("Phase 1.1 global motion surfaces", async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem("bea:motion-profile:v1", "full");
  });
  await page.goto("/sign-in");
  await expect(page.locator("html")).toHaveAttribute("data-motion-profile", "full");
  await expect(page.locator("html")).toHaveAttribute("data-motion-ready", "true");
  await expect(page.locator(".bea-auth-page")).toBeVisible();
  expect(
    await page
      .locator(".bea-auth-page")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toContain("bea-page-enter");
  await page
    .getByRole("combobox", { name: "Demo persona" })
    .selectOption({ label: personas[0].label });
  await page.getByRole("button", { name: "Sign in to Command Center" }).click();
  await expectPhase11AuthenticatedReady(page, "/command-center");

  await gotoPhase11Authenticated(page, "/companies");
  let shell = await activeApplicationShell(page);
  const companyHref = await shell
    .getByRole("main")
    .locator('a[href^="/companies/"]')
    .first()
    .getAttribute("href");
  expect(companyHref).toBeTruthy();
  const representativeRoutes = [
    "/",
    "/companies",
    companyHref as string,
    "/contacts",
    "/tasks",
    "/tasks/new",
    "/activities",
    "/notifications",
    "/search",
    "/workflow-runs",
    "/integrations",
    "/administration",
    "/ai-command",
    "/access-denied?resource=motion-probe",
    "/reports",
  ];
  for (const path of representativeRoutes) {
    await gotoPhase11Authenticated(page, path);
    shell = await activeApplicationShell(page);
    const pageEntry = shell.locator(".bea-animated-page");
    await expect(pageEntry).toBeVisible();
    expect(
      await pageEntry.evaluate((element) => getComputedStyle(element).animationName),
    ).toContain("bea-page-enter");
  }

  await gotoPhase11Authenticated(page, "/command-center");
  shell = await activeApplicationShell(page);
  const floatingCard = shell.locator(".bea-card.bea-floating-surface").first();
  await expect(floatingCard).toBeVisible();
  const floatingStyle = await floatingCard.evaluate((element) => {
    const style = getComputedStyle(element);
    const ambientStyle = getComputedStyle(element, "::before");
    return {
      animationName: style.animationName,
      ambientAnimationName: ambientStyle.animationName,
      ambientPointerEvents: ambientStyle.pointerEvents,
      backdropFilter: style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter"),
    };
  });
  expect(floatingStyle.animationName).toBe("none");
  expect(floatingStyle.ambientAnimationName).toContain("bea-surface-float");
  expect(floatingStyle.ambientPointerEvents).toBe("none");
  expect(floatingStyle.backdropFilter).not.toBe("none");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    ),
  ).toBe(false);
  const desktopNavLink = shell
    .getByRole("navigation", { name: "Command Center navigation" })
    .getByRole("link")
    .first();
  expect(
    await desktopNavLink.evaluate((element) => getComputedStyle(element).transitionDuration),
  ).not.toBe("0s");
  const profileMenu = (await activeApplicationShell(page)).getByTestId("account-menu");
  await profileMenu.locator("summary").click();
  const profilePanel = profileMenu.locator(".bea-profile-menu__panel");
  await expect(profilePanel).toBeVisible();
  expect(
    await profilePanel.evaluate((element) => getComputedStyle(element).animationName),
  ).not.toBe("none");
  await profileMenu.locator("summary").click();

  await gotoPhase11Authenticated(page, "/tasks/new");
  shell = await activeApplicationShell(page);
  const titleInput = shell.getByLabel("Title");
  expect(
    await titleInput.evaluate((element) => getComputedStyle(element).transitionDuration),
  ).not.toBe("0s");
  await expect(shell.getByTestId("task-contact-region")).toHaveAttribute(
    "data-contact-state",
    "idle",
  );

  await gotoPhase11Authenticated(page, "/companies");
  shell = await activeApplicationShell(page);
  const firstTableRow = shell.locator(".bea-table tbody tr").first();
  await expect(firstTableRow).toBeVisible();
  expect(
    await firstTableRow.evaluate((element) => getComputedStyle(element).animationName),
  ).toContain("bea-table-row-enter");
  await expect(shell.locator(".bea-table tbody td.bea-floating-surface")).toHaveCount(0);

  await gotoPhase11Authenticated(page, "/notifications");
  shell = await activeApplicationShell(page);
  await expect(shell.locator(".bea-notification-list.bea-animated-list")).toBeVisible();
  await expect(shell.locator(".bea-list-presence-item").first()).toHaveAttribute(
    "data-list-state",
    "idle",
  );

  await gotoPhase11Authenticated(page, "/integrations");
  shell = await activeApplicationShell(page);
  await shell
    .locator(".bea-integration-card")
    .first()
    .getByRole("button", { name: "Run simulation" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAttribute("data-state", "open");
  await dialog.evaluate((element) => {
    const state = window as typeof window & {
      __beaDialogObserver?: MutationObserver;
      __beaDialogStates?: string[];
    };
    state.__beaDialogStates = [];
    state.__beaDialogObserver = new MutationObserver(() => {
      state.__beaDialogStates?.push((element as HTMLElement).dataset.state ?? "");
    });
    state.__beaDialogObserver.observe(element, {
      attributeFilter: ["data-state"],
      attributes: true,
    });
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  const dialogStates = await page.evaluate(() => {
    const state = window as typeof window & {
      __beaDialogObserver?: MutationObserver;
      __beaDialogStates?: string[];
    };
    state.__beaDialogObserver?.disconnect();
    return state.__beaDialogStates ?? [];
  });
  expect(dialogStates).toContain("closing");
  await expect(page.locator("html")).toHaveAttribute("data-motion-modal", "closed");

  await page.setViewportSize({ width: 820, height: 1180 });
  await gotoPhase11Authenticated(page, "/command-center");
  shell = await activeApplicationShell(page);
  // Phase 1.1 has no drawer primitive; its compact navigation disclosure is the N/A substitute.
  const compactNavigation = shell.getByTestId("mobile-navigation");
  await expect(compactNavigation).toBeVisible();
  await compactNavigation.locator("summary").click();
  await expect(
    compactNavigation.getByRole("navigation", { name: "Mobile navigation" }),
  ).toBeVisible();
});

interface Gate30AdapterProbeSnapshot {
  readonly state?: string;
  readonly stopReason?: string;
  readonly cleanupComplete?: boolean;
  readonly activeTimerCount?: number;
  readonly activeListenerCount?: number;
  readonly activeAnimationFrameCount?: number;
  readonly authorizationRequests?: number;
  readonly allTracksEnded?: boolean;
  readonly allPeerConnectionsClosed?: boolean;
  readonly audioReferencesReleased?: boolean;
  readonly rawAudioPersisted?: boolean;
  readonly externalProviderCalls?: number;
  readonly standardApiKeyExposed?: boolean;
  readonly realtimeCredentialRetained?: boolean;
  readonly errorCode?: string;
}

type Gate30SafeGetUserMediaFailureName =
  | "none"
  | "AbortError"
  | "TypeError"
  | "Error"
  | "InvalidStateError"
  | "NotSupportedError"
  | "OperationError"
  | "UnknownError"
  | "NotAllowedError"
  | "SecurityError"
  | "NotFoundError"
  | "DevicesNotFoundError"
  | "NotReadableError"
  | "TrackStartError"
  | "OverconstrainedError"
  | "OtherError";

interface Gate30BrowserMediaRuntimeEvidence {
  readonly fakeDeviceArgumentPresent: boolean;
  readonly fakeAudioArgumentPresent: boolean;
  readonly audioInputDeviceCount: number;
}

interface Gate30NativeProbeSnapshot {
  readonly mode: string;
  readonly getUserMediaCalls: number;
  readonly getUserMediaSuccesses: number;
  readonly getUserMediaFailures: number;
  readonly lastGetUserMediaFailureName: Gate30SafeGetUserMediaFailureName;
  readonly addTrackCalls: number;
  readonly createdTrackCount: number;
  readonly liveTrackCount: number;
  readonly trackStateHistories: readonly (readonly string[])[];
  readonly createdPeerCount: number;
  readonly openPeerCount: number;
  readonly peerConnectionStateHistories: readonly (readonly string[])[];
  readonly signalingStateHistories: readonly (readonly string[])[];
  readonly iceServerCounts: readonly number[];
  readonly rawAudioWriteCount: number;
  readonly audioReferenceCount: number;
  readonly activeProbeListenerCount: number;
  readonly instrumentationFailureCount: number;
  readonly adapter?: Gate30AdapterProbeSnapshot;
}

const gate30LifecycleSchema = "bea-gate30-pagehide-v1" as const;
const gate30LifecycleMaxPayloadBytes = 48_000;
const gate30LifecycleMaxRecords = 32;
const gate30LifecycleMaxHistoryLength = 16;
const gate30LifecycleScenarios = [
  "connecting-refresh",
  "navigation-cleanup",
  "active-refresh",
  "sign-out",
] as const;
type Gate30LifecycleScenario = (typeof gate30LifecycleScenarios)[number];
const gate30SafeFailureNames: readonly Gate30SafeGetUserMediaFailureName[] = [
  "none",
  "AbortError",
  "TypeError",
  "Error",
  "InvalidStateError",
  "NotSupportedError",
  "OperationError",
  "UnknownError",
  "NotAllowedError",
  "SecurityError",
  "NotFoundError",
  "DevicesNotFoundError",
  "NotReadableError",
  "TrackStartError",
  "OverconstrainedError",
  "OtherError",
];

interface Gate30LifecycleReportPayload {
  readonly schema: typeof gate30LifecycleSchema;
  readonly scenario: Gate30LifecycleScenario;
  readonly nonce: string;
  readonly reportId: string;
  readonly snapshot: Gate30NativeProbeSnapshot;
}

const gate30ProbeModes = ["native", "delay-offer", "unavailable", "peer-failure"] as const;
const gate30TrackStates = ["live", "ended"] as const;
const gate30PeerConnectionStates = [
  "new",
  "connecting",
  "connected",
  "disconnected",
  "failed",
  "closed",
] as const;
const gate30SignalingStates = [
  "stable",
  "have-local-offer",
  "have-remote-offer",
  "have-local-pranswer",
  "have-remote-pranswer",
  "closed",
] as const;
const gate30AdapterStates = [
  "idle",
  "authorizing",
  "requesting-permission",
  "connecting",
  "listening",
  "user-speaking",
  "stopping",
  "error",
] as const;
const gate30StopReasons = [
  "none",
  "component-unmount",
  "pagehide",
  "peer-connection-failed",
  "start-failed",
  "track-ended",
  "user-cancelled",
  "user-stopped",
] as const;
const gate30AdapterErrorCodes = [
  "none",
  "browser-media-unsupported",
  "test-authorization-rejected",
  "microphone-permission-denied",
  "microphone-device-unavailable",
  "peer-connection-failed",
] as const;

function gate30IsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gate30HasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function gate30IsBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;
}

function gate30IsAllowedString(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function gate30IsStateHistories(value: unknown, allowed: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length <= gate30LifecycleMaxRecords &&
    value.every(
      (history) =>
        Array.isArray(history) &&
        history.length <= gate30LifecycleMaxHistoryLength &&
        history.every((state) => gate30IsAllowedString(state, allowed)),
    )
  );
}

function gate30IsSafeAdapterSnapshot(value: unknown): value is Gate30AdapterProbeSnapshot {
  if (!gate30IsRecord(value)) return false;
  if (
    !gate30HasExactKeys(value, [
      "state",
      "stopReason",
      "cleanupComplete",
      "activeTimerCount",
      "activeListenerCount",
      "activeAnimationFrameCount",
      "authorizationRequests",
      "allTracksEnded",
      "allPeerConnectionsClosed",
      "audioReferencesReleased",
      "rawAudioPersisted",
      "externalProviderCalls",
      "standardApiKeyExposed",
      "realtimeCredentialRetained",
      "errorCode",
    ])
  ) {
    return false;
  }
  return (
    gate30IsAllowedString(value.state, gate30AdapterStates) &&
    gate30IsAllowedString(value.stopReason, gate30StopReasons) &&
    gate30IsAllowedString(value.errorCode, gate30AdapterErrorCodes) &&
    typeof value.cleanupComplete === "boolean" &&
    gate30IsBoundedCount(value.activeTimerCount) &&
    gate30IsBoundedCount(value.activeListenerCount) &&
    gate30IsBoundedCount(value.activeAnimationFrameCount) &&
    gate30IsBoundedCount(value.authorizationRequests) &&
    typeof value.allTracksEnded === "boolean" &&
    typeof value.allPeerConnectionsClosed === "boolean" &&
    typeof value.audioReferencesReleased === "boolean" &&
    value.rawAudioPersisted === false &&
    value.externalProviderCalls === 0 &&
    value.standardApiKeyExposed === false &&
    value.realtimeCredentialRetained === false
  );
}

function gate30IsSafeNativeSnapshot(value: unknown): value is Gate30NativeProbeSnapshot {
  if (!gate30IsRecord(value)) return false;
  if (
    !gate30HasExactKeys(value, [
      "mode",
      "getUserMediaCalls",
      "getUserMediaSuccesses",
      "getUserMediaFailures",
      "lastGetUserMediaFailureName",
      "addTrackCalls",
      "createdTrackCount",
      "liveTrackCount",
      "trackStateHistories",
      "createdPeerCount",
      "openPeerCount",
      "peerConnectionStateHistories",
      "signalingStateHistories",
      "iceServerCounts",
      "rawAudioWriteCount",
      "audioReferenceCount",
      "activeProbeListenerCount",
      "instrumentationFailureCount",
      "adapter",
    ])
  ) {
    return false;
  }
  return (
    gate30IsAllowedString(value.mode, gate30ProbeModes) &&
    gate30IsBoundedCount(value.getUserMediaCalls) &&
    gate30IsBoundedCount(value.getUserMediaSuccesses) &&
    gate30IsBoundedCount(value.getUserMediaFailures) &&
    gate30IsAllowedString(value.lastGetUserMediaFailureName, gate30SafeFailureNames) &&
    gate30IsBoundedCount(value.addTrackCalls) &&
    gate30IsBoundedCount(value.createdTrackCount) &&
    gate30IsBoundedCount(value.liveTrackCount) &&
    gate30IsStateHistories(value.trackStateHistories, gate30TrackStates) &&
    gate30IsBoundedCount(value.createdPeerCount) &&
    gate30IsBoundedCount(value.openPeerCount) &&
    gate30IsStateHistories(value.peerConnectionStateHistories, gate30PeerConnectionStates) &&
    gate30IsStateHistories(value.signalingStateHistories, gate30SignalingStates) &&
    Array.isArray(value.iceServerCounts) &&
    value.iceServerCounts.length <= gate30LifecycleMaxRecords &&
    value.iceServerCounts.every(gate30IsBoundedCount) &&
    gate30IsBoundedCount(value.rawAudioWriteCount) &&
    gate30IsBoundedCount(value.audioReferenceCount) &&
    gate30IsBoundedCount(value.activeProbeListenerCount) &&
    gate30IsBoundedCount(value.instrumentationFailureCount) &&
    gate30IsSafeAdapterSnapshot(value.adapter)
  );
}

function gate30IsLifecycleReportPayload(value: unknown): value is Gate30LifecycleReportPayload {
  if (!gate30IsRecord(value)) return false;
  return (
    gate30HasExactKeys(value, ["schema", "scenario", "nonce", "reportId", "snapshot"]) &&
    value.schema === gate30LifecycleSchema &&
    gate30IsAllowedString(value.scenario, gate30LifecycleScenarios) &&
    typeof value.nonce === "string" &&
    /^[a-f0-9]{32}$/u.test(value.nonce) &&
    typeof value.reportId === "string" &&
    /^[a-f0-9]{32}$/u.test(value.reportId) &&
    gate30IsSafeNativeSnapshot(value.snapshot)
  );
}

test("@webrtc executes deterministic browser microphone and WebRTC lifecycle with complete cleanup", async ({
  browser,
  context,
  page,
}, testInfo) => {
  test.setTimeout(900_000);
  expect(testInfo.project.use.trace).toBe("off");
  expect(testInfo.project.use.channel).toBe("chromium");
  const repeatedCycleCount = 6;
  const pagehideReports: Gate30NativeProbeSnapshot[] = [];
  const lifecycleReportsById = new Map<string, Gate30NativeProbeSnapshot>();
  const lifecycleReportExpectations = new Map<
    string,
    {
      nonce: string;
      scenario: Gate30LifecycleScenario;
      storageKey: string;
      accepted: boolean;
    }
  >();
  const lifecycleConsumedStorageKeys = new Set<string>();
  const nativeEvidence: Gate30NativeProbeSnapshot[] = [];
  let externalRequestCount = 0;
  let authRouteRequestCount = 0;
  let malformedAuthRequestCount = 0;
  let credentialRequestLeakCount = 0;
  let consoleFailureCount = 0;
  let maxListenersWarningCount = 0;
  let pageErrorCount = 0;
  let lifecycleInvalidPayloadCount = 0;
  let lifecycleUnknownReportCount = 0;
  let lifecycleDuplicateReportCount = 0;
  let permissionDeniedNativeFailureName: Gate30SafeGetUserMediaFailureName = "none";
  let browserMediaRuntimeEvidence: Gate30BrowserMediaRuntimeEvidence = {
    fakeDeviceArgumentPresent: false,
    fakeAudioArgumentPresent: false,
    audioInputDeviceCount: 0,
  };
  const authResponseChecks: Promise<{
    readonly status: number;
    readonly strictDemoContract: boolean;
    readonly standardCredentialFound: boolean;
    readonly correlationId: string;
    readonly safeErrorCode: string;
    readonly contractFailures: readonly string[];
  }>[] = [];

  const lifecycleStoragePrefix = `__beaGate30Lifecycle_${randomBytes(18).toString("hex")}_`;
  const lifecycleInboxName = `__beaGate30LifecycleInbox_${randomBytes(18).toString("hex")}`;
  await page.addInitScript(
    ({ expectedOrigin, inboxName, storagePrefix }) => {
      if (window.location.origin !== expectedOrigin) return;
      const records: { key: string; raw: string }[] = [];
      try {
        for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
          const key = window.sessionStorage.key(index);
          if (!key?.startsWith(storagePrefix)) continue;
          const raw = window.sessionStorage.getItem(key);
          window.sessionStorage.removeItem(key);
          if (raw !== null) records.push({ key, raw });
        }
      } catch {
        throw new Error("Gate 30 lifecycle storage handoff is inaccessible.");
      }
      if (records.length === 0) return;
      Object.defineProperty(window, inboxName, {
        configurable: true,
        enumerable: false,
        writable: false,
        value: records,
      });
    },
    {
      expectedOrigin: appOrigin,
      inboxName: lifecycleInboxName,
      storagePrefix: lifecycleStoragePrefix,
    },
  );

  await page.addInitScript(() => {
    type ProbeMode = "native" | "delay-offer" | "unavailable" | "peer-failure";
    interface TrackRecord {
      readonly track: MediaStreamTrack;
      readonly states: string[];
      removeEndedListener?: () => void;
    }
    interface PeerRecord {
      readonly peer: RTCPeerConnection;
      readonly connectionStates: string[];
      readonly signalingStates: string[];
      readonly iceServerCount: number;
      readonly removeProbeListeners: (() => void)[];
    }
    interface BrowserProbe {
      setMode(next: ProbeMode): void;
      releaseDelayedOffer(): void;
      endFirstLiveTrack(): boolean;
      snapshot(): Gate30NativeProbeSnapshot;
    }
    type ProbeWindow = typeof window & {
      __BEA_GATE30_NATIVE_PROBE__?: BrowserProbe;
      __BEA_BROWSER_VOICE_TEST_DIAGNOSTICS__?: Gate30AdapterProbeSnapshot;
    };

    const probeWindow = window as ProbeWindow;
    const mediaDevices = window.navigator.mediaDevices;
    const NativePeerConnection = window.RTCPeerConnection;
    if (!mediaDevices || typeof NativePeerConnection !== "function") return;

    const nativeGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    const tracks: TrackRecord[] = [];
    const peers: PeerRecord[] = [];
    let mode: ProbeMode = "native";
    let delayedOfferRelease: (() => void) | undefined;
    let getUserMediaCalls = 0;
    let getUserMediaSuccesses = 0;
    let getUserMediaFailures = 0;
    let lastGetUserMediaFailureName: Gate30SafeGetUserMediaFailureName = "none";
    let addTrackCalls = 0;
    let rawAudioWriteCount = 0;
    let activeProbeListenerCount = 0;
    let instrumentationFailureCount = 0;

    const appendState = (states: string[], state: string) => {
      if (states.at(-1) !== state) states.push(state);
    };
    const safeGetUserMediaFailureName = (error: unknown): Gate30SafeGetUserMediaFailureName => {
      const name = error instanceof DOMException || error instanceof Error ? error.name : "";
      switch (name) {
        case "AbortError":
        case "TypeError":
        case "Error":
        case "InvalidStateError":
        case "NotSupportedError":
        case "OperationError":
        case "UnknownError":
        case "NotAllowedError":
        case "SecurityError":
        case "NotFoundError":
        case "DevicesNotFoundError":
        case "NotReadableError":
        case "TrackStartError":
        case "OverconstrainedError":
          return name;
        default:
          return "OtherError";
      }
    };
    const observe = (target: EventTarget, type: string, listener: EventListener) => {
      target.addEventListener(type, listener);
      activeProbeListenerCount += 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        target.removeEventListener(type, listener);
        activeProbeListenerCount -= 1;
      };
    };
    const registerTrack = (track: MediaStreamTrack) => {
      if (tracks.some((entry) => entry.track === track)) return;
      const entry: TrackRecord = { track, states: [track.readyState] };
      tracks.push(entry);
      const onEnded = () => {
        appendState(entry.states, track.readyState);
        entry.removeEndedListener?.();
      };
      try {
        entry.removeEndedListener = observe(track, "ended", onEnded);
      } catch {
        instrumentationFailureCount += 1;
      }
    };
    const registerPeer = (peer: RTCPeerConnection, configuration?: RTCConfiguration) => {
      const entry: PeerRecord = {
        peer,
        connectionStates: [peer.connectionState],
        signalingStates: [peer.signalingState],
        iceServerCount: configuration?.iceServers?.length ?? 0,
        removeProbeListeners: [],
      };
      peers.push(entry);
      const observePeer = (type: string, listener: EventListener) => {
        try {
          entry.removeProbeListeners.push(observe(peer, type, listener));
        } catch {
          instrumentationFailureCount += 1;
        }
      };
      observePeer("connectionstatechange", () =>
        appendState(entry.connectionStates, peer.connectionState),
      );
      observePeer("signalingstatechange", () =>
        appendState(entry.signalingStates, peer.signalingState),
      );
      observePeer("track", (event) => {
        const trackEvent = event as RTCTrackEvent;
        registerTrack(trackEvent.track);
        for (const stream of trackEvent.streams) {
          for (const track of stream.getTracks()) registerTrack(track);
        }
      });
      const nativeAddTrack = peer.addTrack.bind(peer);
      try {
        Object.defineProperty(peer, "addTrack", {
          configurable: true,
          value: (track: MediaStreamTrack, ...streams: MediaStream[]) => {
            addTrackCalls += 1;
            registerTrack(track);
            return nativeAddTrack(track, ...streams);
          },
        });
      } catch {
        instrumentationFailureCount += 1;
      }
      const nativeCreateOffer = peer.createOffer.bind(peer);
      try {
        Object.defineProperty(peer, "createOffer", {
          configurable: true,
          value: (options?: RTCOfferOptions) => {
            if (mode === "peer-failure") {
              return Promise.reject(
                new DOMException(
                  "Injected deterministic peer negotiation failure.",
                  "OperationError",
                ),
              );
            }
            const offer = nativeCreateOffer(options);
            if (mode !== "delay-offer") return offer;
            return offer.then(
              (value) =>
                new Promise<RTCSessionDescriptionInit>((resolve) => {
                  delayedOfferRelease = () => resolve(value);
                }),
            );
          },
        });
      } catch {
        instrumentationFailureCount += 1;
      }
    };

    const instrumentedPeerConnection = function (configuration?: RTCConfiguration) {
      const peer = new NativePeerConnection(configuration);
      registerPeer(peer, configuration);
      return peer;
    } as unknown as typeof RTCPeerConnection;
    try {
      Object.setPrototypeOf(instrumentedPeerConnection, NativePeerConnection);
      Object.defineProperty(instrumentedPeerConnection, "prototype", {
        value: NativePeerConnection.prototype,
      });
      Object.defineProperty(window, "RTCPeerConnection", {
        configurable: true,
        value: instrumentedPeerConnection,
      });
    } catch {
      instrumentationFailureCount += 1;
    }

    try {
      Object.defineProperty(mediaDevices, "getUserMedia", {
        configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
          getUserMediaCalls += 1;
          if (mode === "unavailable") {
            getUserMediaFailures += 1;
            lastGetUserMediaFailureName = "NotFoundError";
            throw new DOMException("Injected deterministic device absence.", "NotFoundError");
          }
          let stream: MediaStream;
          try {
            stream = await nativeGetUserMedia(constraints);
            getUserMediaSuccesses += 1;
          } catch (error) {
            getUserMediaFailures += 1;
            lastGetUserMediaFailureName = safeGetUserMediaFailureName(error);
            throw error;
          }
          for (const track of stream.getTracks()) registerTrack(track);
          return stream;
        },
      });
    } catch {
      instrumentationFailureCount += 1;
    }

    const containsRawAudio = (value: unknown, key = "") => {
      if (value instanceof Blob) return value.type.toLowerCase().startsWith("audio/");
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
      if (typeof value !== "string") return false;
      return (
        /^data:audio\//iu.test(value) ||
        (/audio|microphone|pcm|wave/iu.test(key) && value.length > 1_024)
      );
    };
    const nativeStorageSetItem = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value(this: Storage, key: string, value: string) {
        if (containsRawAudio(value, key)) rawAudioWriteCount += 1;
        return nativeStorageSetItem.call(this, key, value);
      },
    });
    if (typeof IDBObjectStore !== "undefined") {
      const objectStorePrototype = IDBObjectStore.prototype as unknown as {
        add(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest;
        put(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest;
      };
      const nativeAdd = objectStorePrototype.add;
      const nativePut = objectStorePrototype.put;
      Object.defineProperty(objectStorePrototype, "add", {
        configurable: true,
        value(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
          if (containsRawAudio(value)) rawAudioWriteCount += 1;
          return nativeAdd.call(this, value, key);
        },
      });
      Object.defineProperty(objectStorePrototype, "put", {
        configurable: true,
        value(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
          if (containsRawAudio(value)) rawAudioWriteCount += 1;
          return nativePut.call(this, value, key);
        },
      });
    }
    if (typeof Cache !== "undefined") {
      const nativeCachePut = Cache.prototype.put;
      Object.defineProperty(Cache.prototype, "put", {
        configurable: true,
        async value(this: Cache, request: RequestInfo | URL, response: Response) {
          if ((response.headers.get("content-type") ?? "").toLowerCase().startsWith("audio/")) {
            rawAudioWriteCount += 1;
          }
          return nativeCachePut.call(this, request, response);
        },
      });
    }

    const snapshot = (): Gate30NativeProbeSnapshot => {
      for (const entry of tracks) {
        appendState(entry.states, entry.track.readyState);
        if (entry.track.readyState === "ended") entry.removeEndedListener?.();
      }
      for (const entry of peers) {
        appendState(entry.connectionStates, entry.peer.connectionState);
        appendState(entry.signalingStates, entry.peer.signalingState);
        if (entry.peer.connectionState === "closed" || entry.peer.signalingState === "closed") {
          for (const remove of entry.removeProbeListeners) remove();
        }
      }
      const audioReferenceCount = [...document.querySelectorAll("audio")].filter(
        (element) => element.srcObject !== null || element.dataset.beaVoiceLoopback === "true",
      ).length;
      return {
        mode,
        getUserMediaCalls,
        getUserMediaSuccesses,
        getUserMediaFailures,
        lastGetUserMediaFailureName,
        addTrackCalls,
        createdTrackCount: tracks.length,
        liveTrackCount: tracks.filter((entry) => entry.track.readyState === "live").length,
        trackStateHistories: tracks.map((entry) => [...entry.states]),
        createdPeerCount: peers.length,
        openPeerCount: peers.filter((entry) => entry.peer.connectionState !== "closed").length,
        peerConnectionStateHistories: peers.map((entry) => [...entry.connectionStates]),
        signalingStateHistories: peers.map((entry) => [...entry.signalingStates]),
        iceServerCounts: peers.map((entry) => entry.iceServerCount),
        rawAudioWriteCount,
        audioReferenceCount,
        activeProbeListenerCount,
        instrumentationFailureCount,
        ...(probeWindow.__BEA_BROWSER_VOICE_TEST_DIAGNOSTICS__
          ? { adapter: { ...probeWindow.__BEA_BROWSER_VOICE_TEST_DIAGNOSTICS__ } }
          : {}),
      };
    };
    const probe: BrowserProbe = {
      setMode(next) {
        mode = next;
      },
      releaseDelayedOffer() {
        delayedOfferRelease?.();
        delayedOfferRelease = undefined;
      },
      endFirstLiveTrack() {
        const entry = tracks.find((candidate) => candidate.track.readyState === "live");
        if (!entry) return false;
        entry.track.stop();
        entry.track.dispatchEvent(new Event("ended"));
        appendState(entry.states, entry.track.readyState);
        return true;
      },
      snapshot,
    };
    Object.defineProperty(probeWindow, "__BEA_GATE30_NATIVE_PROBE__", {
      configurable: true,
      enumerable: false,
      value: probe,
    });
  });

  await page.route("**/*", async (route) => {
    try {
      const url = new URL(route.request().url());
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== appOrigin) {
        externalRequestCount += 1;
        await route.abort("blockedbyclient");
        return;
      }
    } catch {
      externalRequestCount += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    consoleFailureCount += 1;
    if (message.text().includes("MaxListenersExceededWarning")) maxListenersWarningCount += 1;
  });
  page.on("pageerror", () => {
    pageErrorCount += 1;
  });
  page.on("request", (request) => {
    if (!/\/api\/ai-command\/realtime\/client-secret$/u.test(request.url())) return;
    authRouteRequestCount += 1;
    let requestBody: unknown;
    try {
      requestBody = JSON.parse(request.postData() ?? "");
    } catch {
      requestBody = undefined;
    }
    if (
      request.method() !== "POST" ||
      !gate30IsRecord(requestBody) ||
      !gate30HasExactKeys(requestBody, ["conversationId"]) ||
      typeof requestBody.conversationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        requestBody.conversationId,
      )
    ) {
      malformedAuthRequestCount += 1;
    }
    if (request.headers().authorization) credentialRequestLeakCount += 1;
  });
  page.on("response", (response) => {
    if (!/\/api\/ai-command\/realtime\/client-secret$/u.test(response.url())) return;
    authResponseChecks.push(
      (async () => {
        const status = response.status();
        const correlationId = response.headers()["x-correlation-id"] ?? "";
        let text: string;
        try {
          text = await response.text();
        } catch {
          return {
            status,
            strictDemoContract: false,
            standardCredentialFound: true,
            correlationId,
            safeErrorCode: "response-body-unavailable",
            contractFailures: ["response-body"],
          };
        }
        let parsedBody: Record<string, unknown> | undefined;
        let authorization: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(text) as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            parsedBody = parsed as Record<string, unknown>;
            const candidate = parsedBody.authorization;
            if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
              authorization = candidate as Record<string, unknown>;
            }
          }
        } catch {
          authorization = undefined;
        }
        const syntheticCredential =
          typeof authorization?.clientSecret === "string" ? authorization.clientSecret : "";
        const expiresAt =
          typeof authorization?.expiresAt === "string"
            ? Date.parse(authorization.expiresAt)
            : Number.NaN;
        const observedAt = Date.now();
        const error = gate30IsRecord(parsedBody?.error) ? parsedBody.error : undefined;
        const safeErrorCode =
          typeof error?.code === "string" && /^[A-Za-z0-9._:-]{1,80}$/u.test(error.code)
            ? error.code
            : "";
        const allowedAuthorizationKeys = new Set([
          "allowInterruption",
          "beaSessionId",
          "clientSecret",
          "expiresAt",
          "interactionMode",
          "model",
          "provider",
          "sessionId",
          "simulated",
          "speakResponses",
          "voice",
          "webrtcEndpoint",
        ]);
        const contractChecks = [
          ["status", status === 200],
          ["body-shape", Boolean(parsedBody && gate30HasExactKeys(parsedBody, ["authorization"]))],
          ["authorization-shape", Boolean(authorization)],
          [
            "authorization-keys",
            Boolean(
              authorization &&
              Object.keys(authorization).every((key) => allowedAuthorizationKeys.has(key)),
            ),
          ],
          ["provider", authorization?.provider === "demo"],
          ["simulated", authorization?.simulated === true],
          ["endpoint", authorization?.webrtcEndpoint === null],
          ["speak-responses", typeof authorization?.speakResponses === "boolean"],
          [
            "credential-shape",
            /^demo-no-network-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              syntheticCredential,
            ),
          ],
          [
            "provider-session-shape",
            typeof authorization?.sessionId === "string" &&
              /^demo-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
                authorization.sessionId,
              ),
          ],
          [
            "bea-session-shape",
            typeof authorization?.beaSessionId === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
                authorization.beaSessionId,
              ),
          ],
          [
            "model-shape",
            typeof authorization?.model === "string" && Boolean(authorization.model.trim()),
          ],
          [
            "voice-shape",
            typeof authorization?.voice === "string" && Boolean(authorization.voice.trim()),
          ],
          [
            "interaction-mode",
            authorization?.interactionMode === "automatic" ||
              authorization?.interactionMode === "push_to_talk",
          ],
          ["allow-interruption", typeof authorization?.allowInterruption === "boolean"],
          [
            "expiry",
            Number.isFinite(expiresAt) &&
              expiresAt > observedAt &&
              expiresAt <= observedAt + 120_000,
          ],
        ] as const;
        const contractFailures = contractChecks
          .filter(([, passed]) => !passed)
          .map(([label]) => label);
        const strictDemoContract = contractFailures.length === 0;
        return {
          status,
          strictDemoContract,
          standardCredentialFound: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/u.test(text),
          correlationId,
          safeErrorCode,
          contractFailures,
        };
      })(),
    );
  });

  const nativeSnapshot = () =>
    page.evaluate(() => {
      const probeWindow = window as typeof window & {
        __BEA_GATE30_NATIVE_PROBE__?: { snapshot(): Gate30NativeProbeSnapshot };
      };
      if (!probeWindow.__BEA_GATE30_NATIVE_PROBE__) {
        throw new Error("Gate 30 native browser probe is unavailable.");
      }
      return probeWindow.__BEA_GATE30_NATIVE_PROBE__.snapshot();
    });
  const armLifecyclePagehideReport = async (scenario: Gate30LifecycleScenario) => {
    const nonce = randomBytes(16).toString("hex");
    const reportId = randomBytes(16).toString("hex");
    const storageKey = `${lifecycleStoragePrefix}${randomBytes(18).toString("hex")}`;
    lifecycleReportExpectations.set(reportId, {
      nonce,
      scenario,
      storageKey,
      accepted: false,
    });
    await page.evaluate(
      ({
        adapterErrorCodes,
        adapterStates,
        failureNames,
        maxHistoryLength,
        maxPayloadBytes,
        maxRecords,
        nonce: expectedNonce,
        peerConnectionStates,
        probeModes,
        reportId: expectedReportId,
        scenario: expectedScenario,
        schema,
        signalingStates,
        storageKey,
        stopReasons,
        trackStates,
      }) => {
        const reportWindow = window as typeof window & {
          __BEA_GATE30_NATIVE_PROBE__?: { snapshot(): Gate30NativeProbeSnapshot };
        };
        const probe = reportWindow.__BEA_GATE30_NATIVE_PROBE__;
        if (!probe) {
          throw new Error("Gate 30 lifecycle probe is unavailable.");
        }
        window.sessionStorage.removeItem(storageKey);
        if (window.sessionStorage.getItem(storageKey) !== null) {
          throw new Error("Gate 30 lifecycle storage could not be cleared before arming.");
        }
        const boundedCount = (value: unknown) => {
          if (!Number.isSafeInteger(value) || Number(value) < 0) return 0;
          return Math.min(Number(value), 10_000);
        };
        const allowedString = (value: unknown, allowed: readonly string[], fallback = "invalid") =>
          typeof value === "string" && allowed.includes(value) ? value : fallback;
        const boundedHistories = (
          histories: readonly (readonly string[])[],
          allowed: readonly string[],
        ) =>
          histories
            .slice(0, maxRecords)
            .map((history) =>
              history.slice(0, maxHistoryLength).map((state) => allowedString(state, allowed)),
            );

        window.addEventListener(
          "pagehide",
          () => {
            const source = probe.snapshot();
            const adapter = source.adapter;
            const safeSnapshot = {
              mode: allowedString(source.mode, probeModes),
              getUserMediaCalls: boundedCount(source.getUserMediaCalls),
              getUserMediaSuccesses: boundedCount(source.getUserMediaSuccesses),
              getUserMediaFailures: boundedCount(source.getUserMediaFailures),
              lastGetUserMediaFailureName: allowedString(
                source.lastGetUserMediaFailureName,
                failureNames,
              ),
              addTrackCalls: boundedCount(source.addTrackCalls),
              createdTrackCount: boundedCount(source.createdTrackCount),
              liveTrackCount: boundedCount(source.liveTrackCount),
              trackStateHistories: boundedHistories(source.trackStateHistories, trackStates),
              createdPeerCount: boundedCount(source.createdPeerCount),
              openPeerCount: boundedCount(source.openPeerCount),
              peerConnectionStateHistories: boundedHistories(
                source.peerConnectionStateHistories,
                peerConnectionStates,
              ),
              signalingStateHistories: boundedHistories(
                source.signalingStateHistories,
                signalingStates,
              ),
              iceServerCounts: source.iceServerCounts.slice(0, maxRecords).map(boundedCount),
              rawAudioWriteCount: boundedCount(source.rawAudioWriteCount),
              audioReferenceCount: boundedCount(source.audioReferenceCount),
              activeProbeListenerCount: boundedCount(source.activeProbeListenerCount),
              instrumentationFailureCount: boundedCount(source.instrumentationFailureCount),
              adapter: {
                state: allowedString(adapter?.state, adapterStates),
                stopReason: allowedString(adapter?.stopReason ?? "none", stopReasons),
                cleanupComplete: adapter?.cleanupComplete === true,
                activeTimerCount: boundedCount(adapter?.activeTimerCount),
                activeListenerCount: boundedCount(adapter?.activeListenerCount),
                activeAnimationFrameCount: boundedCount(adapter?.activeAnimationFrameCount),
                authorizationRequests: boundedCount(adapter?.authorizationRequests),
                allTracksEnded: adapter?.allTracksEnded === true,
                allPeerConnectionsClosed: adapter?.allPeerConnectionsClosed === true,
                audioReferencesReleased: adapter?.audioReferencesReleased === true,
                rawAudioPersisted: adapter?.rawAudioPersisted === true,
                externalProviderCalls: boundedCount(adapter?.externalProviderCalls),
                standardApiKeyExposed: adapter?.standardApiKeyExposed === true,
                realtimeCredentialRetained: adapter?.realtimeCredentialRetained === true,
                errorCode: allowedString(adapter?.errorCode ?? "none", adapterErrorCodes),
              },
            };
            const serialized = JSON.stringify({
              schema,
              scenario: expectedScenario,
              nonce: expectedNonce,
              reportId: expectedReportId,
              snapshot: safeSnapshot,
            });
            window.sessionStorage.setItem(
              storageKey,
              new TextEncoder().encode(serialized).byteLength <= maxPayloadBytes
                ? serialized
                : "{}",
            );
          },
          { capture: false, once: true },
        );
      },
      {
        adapterErrorCodes: gate30AdapterErrorCodes,
        adapterStates: gate30AdapterStates,
        failureNames: gate30SafeFailureNames,
        maxHistoryLength: gate30LifecycleMaxHistoryLength,
        maxPayloadBytes: gate30LifecycleMaxPayloadBytes,
        maxRecords: gate30LifecycleMaxRecords,
        nonce,
        peerConnectionStates: gate30PeerConnectionStates,
        probeModes: gate30ProbeModes,
        reportId,
        scenario,
        schema: gate30LifecycleSchema,
        signalingStates: gate30SignalingStates,
        storageKey,
        stopReasons: gate30StopReasons,
        trackStates: gate30TrackStates,
      },
    );
    return { reportId, storageKey };
  };
  const consumeLifecyclePagehideReport = async (armed: {
    readonly reportId: string;
    readonly storageKey: string;
  }) => {
    if (lifecycleConsumedStorageKeys.has(armed.storageKey)) {
      lifecycleDuplicateReportCount += 1;
      throw new Error("Gate 30 lifecycle storage report was already consumed.");
    }
    lifecycleConsumedStorageKeys.add(armed.storageKey);
    const stored = await page.evaluate(
      ({ inboxName, storagePrefix }) => {
        const inboxWindow = window as unknown as Record<string, unknown>;
        const records = inboxWindow[inboxName];
        Reflect.deleteProperty(inboxWindow, inboxName);
        let matchingStorageKeyCount = 0;
        let storageAccessible = true;
        try {
          for (let index = 0; index < window.sessionStorage.length; index += 1) {
            if (window.sessionStorage.key(index)?.startsWith(storagePrefix)) {
              matchingStorageKeyCount += 1;
            }
          }
        } catch {
          storageAccessible = false;
        }
        return {
          inboxRemoved: !Object.hasOwn(inboxWindow, inboxName),
          matchingStorageKeyCount,
          records,
          storageAccessible,
        };
      },
      { inboxName: lifecycleInboxName, storagePrefix: lifecycleStoragePrefix },
    );
    expect(stored.inboxRemoved).toBe(true);
    expect(stored.storageAccessible).toBe(true);
    expect(stored.matchingStorageKeyCount).toBe(0);
    if (!Array.isArray(stored.records) || stored.records.length !== 1) {
      lifecycleInvalidPayloadCount += 1;
      throw new Error("Gate 30 lifecycle storage inbox did not contain exactly one report.");
    }
    const record = stored.records[0];
    if (
      !gate30IsRecord(record) ||
      !gate30HasExactKeys(record, ["key", "raw"]) ||
      typeof record.key !== "string" ||
      typeof record.raw !== "string"
    ) {
      lifecycleInvalidPayloadCount += 1;
      throw new Error("Gate 30 lifecycle storage inbox failed its safe transport schema.");
    }
    if (record.key !== armed.storageKey) {
      lifecycleUnknownReportCount += 1;
      throw new Error("Gate 30 lifecycle storage inbox did not match the armed key.");
    }
    if (
      record.raw.length === 0 ||
      Buffer.byteLength(record.raw, "utf8") > gate30LifecycleMaxPayloadBytes
    ) {
      lifecycleInvalidPayloadCount += 1;
      throw new Error("Gate 30 lifecycle storage payload is missing or oversized.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.raw) as unknown;
    } catch {
      lifecycleInvalidPayloadCount += 1;
      throw new Error("Gate 30 lifecycle storage payload is not valid JSON.");
    }
    if (!gate30IsLifecycleReportPayload(parsed)) {
      lifecycleInvalidPayloadCount += 1;
      throw new Error("Gate 30 lifecycle storage payload failed its safe schema.");
    }
    const expected = lifecycleReportExpectations.get(parsed.reportId);
    if (
      !expected ||
      parsed.reportId !== armed.reportId ||
      expected.storageKey !== armed.storageKey ||
      expected.nonce !== parsed.nonce ||
      expected.scenario !== parsed.scenario
    ) {
      lifecycleUnknownReportCount += 1;
      throw new Error("Gate 30 lifecycle storage payload did not match the armed scenario.");
    }
    if (expected.accepted || lifecycleReportsById.has(parsed.reportId)) {
      lifecycleDuplicateReportCount += 1;
      throw new Error("Gate 30 lifecycle storage payload was accepted more than once.");
    }
    expected.accepted = true;
    lifecycleReportsById.set(parsed.reportId, parsed.snapshot);
    pagehideReports.push(parsed.snapshot);
    return parsed.snapshot;
  };
  const adapterSnapshot = () =>
    page.evaluate(() => {
      const probeWindow = window as typeof window & {
        __BEA_BROWSER_VOICE_TEST_DIAGNOSTICS__?: Gate30AdapterProbeSnapshot;
      };
      return probeWindow.__BEA_BROWSER_VOICE_TEST_DIAGNOSTICS__ ?? null;
    });
  const setProbeMode = (mode: "native" | "delay-offer" | "unavailable" | "peer-failure") =>
    page.evaluate((next) => {
      const probeWindow = window as typeof window & {
        __BEA_GATE30_NATIVE_PROBE__?: { setMode(value: typeof next): void };
      };
      probeWindow.__BEA_GATE30_NATIVE_PROBE__?.setMode(next);
    }, mode);
  const releaseDelayedOffer = () =>
    page.evaluate(() => {
      const probeWindow = window as typeof window & {
        __BEA_GATE30_NATIVE_PROBE__?: { releaseDelayedOffer(): void };
      };
      probeWindow.__BEA_GATE30_NATIVE_PROBE__?.releaseDelayedOffer();
    });
  const endFirstLiveTrack = () =>
    page.evaluate(() => {
      const probeWindow = window as typeof window & {
        __BEA_GATE30_NATIVE_PROBE__?: { endFirstLiveTrack(): boolean };
      };
      return probeWindow.__BEA_GATE30_NATIVE_PROBE__?.endFirstLiveTrack() ?? false;
    });
  const denyChromiumMicrophonePermission = async () => {
    await context.clearPermissions();
    // Gate 30 has one isolated worker/context: an empty origin grant temporarily rejects every
    // permission for this origin, and the microphone grant is restored before later branches.
    await context.grantPermissions([], { origin: appOrigin });
  };
  const readSafeBrowserMediaRuntimeEvidence =
    async (): Promise<Gate30BrowserMediaRuntimeEvidence> => {
      const session = await context.newCDPSession(page);
      let fakeDeviceArgumentPresent = false;
      let fakeAudioArgumentPresent = false;
      try {
        const commandLine = await session.send("Browser.getBrowserCommandLine");
        const fakeDeviceArgumentPrefix = "--use-fake-device-for-media-stream";
        const fakeAudioArgumentPrefix = "--use-file-for-fake-audio-capture=";
        fakeDeviceArgumentPresent = commandLine.arguments.some(
          (argument) =>
            argument === fakeDeviceArgumentPrefix ||
            argument.startsWith(`${fakeDeviceArgumentPrefix}=`),
        );
        fakeAudioArgumentPresent = commandLine.arguments.some(
          (argument) =>
            argument.startsWith(fakeAudioArgumentPrefix) &&
            argument.length > fakeAudioArgumentPrefix.length,
        );
      } finally {
        await session.detach();
      }
      const audioInputDeviceCount = await page.evaluate(async () => {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((device) => device.kind === "audioinput").length;
      });
      return {
        fakeDeviceArgumentPresent,
        fakeAudioArgumentPresent,
        audioInputDeviceCount,
      };
    };
  const openVoicePanel = async () => {
    const shell = await activeApplicationShell(page);
    await shell.getByTestId("ai-interaction-mode-voice").click();
    const orb = shell.getByTestId("bea-ai-orb");
    const panel = shell.getByTestId("bea-browser-voice-test");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("TEST MODE");
    await expect(shell.getByTestId("ai-voice-panel")).toHaveAttribute(
      "data-voice-mode",
      "test-available",
    );
    return { shell, orb, panel, status: panel.getByTestId("bea-voice-status") };
  };
  const safeNativeStartDiagnostic = async () => {
    const latestAuthorizationCheck = authResponseChecks.at(-1);
    const [adapter, native, authorization] = await Promise.all([
      adapterSnapshot(),
      nativeSnapshot(),
      latestAuthorizationCheck ?? Promise.resolve(undefined),
    ]);
    return {
      adapterState: adapter?.state ?? "missing",
      adapterErrorCode: adapter?.errorCode ?? "none",
      authorization: authorization
        ? {
            status: authorization.status,
            safeErrorCode: authorization.safeErrorCode,
            contractFailures: authorization.contractFailures,
            correlationIdPresent: Boolean(authorization.correlationId),
          }
        : {
            status: 0,
            safeErrorCode: "response-not-observed",
            contractFailures: ["response-not-observed"],
            correlationIdPresent: false,
          },
      authorizationRequestCounters: {
        total: authRouteRequestCount,
        malformed: malformedAuthRequestCount,
        credentialLeak: credentialRequestLeakCount,
      },
      browserMediaRuntime: browserMediaRuntimeEvidence,
      nativeCounters: {
        getUserMediaCalls: native.getUserMediaCalls,
        getUserMediaSuccesses: native.getUserMediaSuccesses,
        getUserMediaFailures: native.getUserMediaFailures,
        lastGetUserMediaFailureName: native.lastGetUserMediaFailureName,
        createdTrackCount: native.createdTrackCount,
        liveTrackCount: native.liveTrackCount,
        addTrackCalls: native.addTrackCalls,
        createdPeerCount: native.createdPeerCount,
        openPeerCount: native.openPeerCount,
        activeProbeListenerCount: native.activeProbeListenerCount,
        instrumentationFailureCount: native.instrumentationFailureCount,
      },
    };
  };
  const startAndWaitForNativeLoopback = async () => {
    const controls = await openVoicePanel();
    await controls.panel.getByTestId("bea-voice-start").click();
    await expect
      .poll(async () => {
        const diagnostic = await safeNativeStartDiagnostic();
        if (diagnostic.adapterState === "error") return "error";
        if (diagnostic.nativeCounters.liveTrackCount > 0) return "live";
        if (["listening", "user-speaking"].includes(diagnostic.adapterState)) {
          return "probe-missed-native-capture";
        }
        return "pending";
      })
      .toMatch(/^(?:error|live|probe-missed-native-capture)$/u);
    const diagnostic = await safeNativeStartDiagnostic();
    if (diagnostic.adapterState === "error") {
      throw new Error(`GATE30_SAFE_NATIVE_START_FAILURE=${JSON.stringify(diagnostic)}`);
    }
    if (
      diagnostic.nativeCounters.liveTrackCount === 0 ||
      diagnostic.nativeCounters.instrumentationFailureCount !== 0
    ) {
      throw new Error(`GATE30_SAFE_NATIVE_PROBE_FAILURE=${JSON.stringify(diagnostic)}`);
    }
    await expect(controls.status).toHaveAttribute("data-track-state", "live");
    await expect
      .poll(async () => (await controls.status.getAttribute("data-state-history")) ?? "")
      .toContain("connecting");
    await expect
      .poll(async () => (await controls.status.getAttribute("data-peer-states")) ?? "")
      .toContain("connected");
    await expect(controls.status).toHaveAttribute("data-microphone-active", "true");
    return controls;
  };
  const expectVisibleCleanup = async (status: Locator, stopReason: string) => {
    await expect(status).toHaveAttribute("data-cleanup-complete", "true");
    await expect(status).toHaveAttribute("data-stop-reason", stopReason);
    await expect(status).toHaveAttribute("data-microphone-active", "false");
    await expect(status).toHaveAttribute("data-all-tracks-ended", "true");
    await expect(status).toHaveAttribute("data-all-peers-closed", "true");
    await expect(status).toHaveAttribute("data-audio-references-released", "true");
    await expect(status).toHaveAttribute("data-active-timers", "0");
    await expect(status).toHaveAttribute("data-active-listeners", "0");
    await expect(status).toHaveAttribute("data-active-animation-frames", "0");
    await expect(status).toHaveAttribute("data-raw-audio-persisted", "false");
    await expect(status).toHaveAttribute("data-external-provider-calls", "0");
    await expect(status).toHaveAttribute("data-standard-api-key-exposed", "false");
    await expect(status).toHaveAttribute("data-realtime-credential-retained", "false");
    const native = await nativeSnapshot();
    expect(native.liveTrackCount).toBe(0);
    expect(native.openPeerCount).toBe(0);
    expect(native.audioReferenceCount).toBe(0);
    expect(native.activeProbeListenerCount).toBe(0);
    nativeEvidence.push(native);
  };
  const expectGlobalCleanup = async (stopReason: string) => {
    await expect.poll(async () => (await adapterSnapshot())?.stopReason).toBe(stopReason);
    const adapter = await adapterSnapshot();
    expect(adapter).toMatchObject({
      state: "idle",
      cleanupComplete: true,
      activeTimerCount: 0,
      activeListenerCount: 0,
      activeAnimationFrameCount: 0,
      allTracksEnded: true,
      allPeerConnectionsClosed: true,
      audioReferencesReleased: true,
      rawAudioPersisted: false,
      externalProviderCalls: 0,
      standardApiKeyExposed: false,
      realtimeCredentialRetained: false,
    });
    const native = await nativeSnapshot();
    expect(native.liveTrackCount).toBe(0);
    expect(native.openPeerCount).toBe(0);
    expect(native.audioReferenceCount).toBe(0);
    expect(native.activeProbeListenerCount).toBe(0);
    nativeEvidence.push(native);
  };

  await signIn(page, "Workspace Owner — Chief Executive Officer");
  const aiCommandResponse = await page.goto("/ai-command");
  expect(aiCommandResponse?.headers()["permissions-policy"]).toBe(
    "camera=(), microphone=(self), geolocation=()",
  );
  let shell = await activeApplicationShell(page);
  await expect(shell.getByTestId("ai-command-workspace")).toHaveAttribute(
    "data-browser-media-test-mode",
    "true",
  );
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  expect(
    await page.evaluate(
      async () =>
        (await navigator.permissions.query({ name: "microphone" as PermissionName })).state,
    ),
  ).toBe("granted");
  browserMediaRuntimeEvidence = await readSafeBrowserMediaRuntimeEvidence();
  expect(browserMediaRuntimeEvidence.fakeDeviceArgumentPresent).toBe(true);
  expect(browserMediaRuntimeEvidence.fakeAudioArgumentPresent).toBe(true);
  expect(browserMediaRuntimeEvidence.audioInputDeviceCount).toBeGreaterThan(0);

  let controls = await openVoicePanel();
  await controls.orb.evaluate((element) => {
    const orbWindow = window as typeof window & {
      __beaGate30OrbObserver?: MutationObserver;
      __beaGate30OrbStates?: string[];
    };
    orbWindow.__beaGate30OrbStates = [element.dataset.state ?? ""];
    orbWindow.__beaGate30OrbObserver = new MutationObserver(() => {
      const state = element.dataset.state ?? "";
      if (orbWindow.__beaGate30OrbStates?.at(-1) !== state) {
        orbWindow.__beaGate30OrbStates?.push(state);
      }
    });
    orbWindow.__beaGate30OrbObserver.observe(element, {
      attributeFilter: ["data-state"],
      attributes: true,
    });
  });
  controls = await startAndWaitForNativeLoopback();
  await expect
    .poll(async () => (await controls.status.getAttribute("data-state-history")) ?? "")
    .toContain("user-speaking");
  await expect(controls.status).toHaveAttribute("data-state", "listening");
  await controls.panel.getByTestId("bea-voice-stop").click();
  await expectVisibleCleanup(controls.status, "user-stopped");
  await expect(controls.orb).toHaveAttribute("data-state", "idle");
  const orbStates = await page.evaluate(() => {
    const orbWindow = window as typeof window & {
      __beaGate30OrbObserver?: MutationObserver;
      __beaGate30OrbStates?: string[];
    };
    orbWindow.__beaGate30OrbObserver?.disconnect();
    return orbWindow.__beaGate30OrbStates ?? [];
  });
  expect(orbStates).toEqual(expect.arrayContaining(["connecting", "listening", "user-speaking"]));

  const permissionDeniedBefore = await nativeSnapshot();
  await denyChromiumMicrophonePermission();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await navigator.permissions.query({ name: "microphone" as PermissionName })).state,
      ),
    )
    .toBe("denied");
  controls = await openVoicePanel();
  await controls.panel.getByTestId("bea-voice-start").click();
  await expect(controls.status).toHaveAttribute("data-state", "error");
  await expect(controls.panel).toContainText("Microphone permission was denied");
  await expectVisibleCleanup(controls.status, "start-failed");
  const permissionDeniedAfter = await nativeSnapshot();
  expect(permissionDeniedAfter.getUserMediaCalls).toBe(
    permissionDeniedBefore.getUserMediaCalls + 1,
  );
  expect(permissionDeniedAfter.getUserMediaFailures).toBe(
    permissionDeniedBefore.getUserMediaFailures + 1,
  );
  expect(permissionDeniedAfter.getUserMediaSuccesses).toBe(
    permissionDeniedBefore.getUserMediaSuccesses,
  );
  expect(["NotAllowedError", "SecurityError"]).toContain(
    permissionDeniedAfter.lastGetUserMediaFailureName,
  );
  permissionDeniedNativeFailureName = permissionDeniedAfter.lastGetUserMediaFailureName;
  await context.grantPermissions(["microphone"], { origin: appOrigin });
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await navigator.permissions.query({ name: "microphone" as PermissionName })).state,
      ),
    )
    .toBe("granted");

  await setProbeMode("unavailable");
  controls = await openVoicePanel();
  await controls.panel.getByTestId("bea-voice-start").click();
  await expect(controls.status).toHaveAttribute("data-state", "error");
  await expect(controls.panel).toContainText("No usable microphone device is available");
  expect((await adapterSnapshot())?.errorCode).toBe("microphone-device-unavailable");
  await expectVisibleCleanup(controls.status, "start-failed");

  await setProbeMode("delay-offer");
  controls = await openVoicePanel();
  await controls.panel.getByTestId("bea-voice-start").click();
  await expect(controls.status).toHaveAttribute("data-state", "connecting");
  await expect.poll(async () => (await nativeSnapshot()).liveTrackCount).toBeGreaterThan(0);
  await controls.shell.getByTestId("ai-interaction-mode-type").click();
  await expect(controls.shell.getByTestId("ai-command-workspace")).toHaveAttribute(
    "data-voice-session",
    "idle",
  );
  await releaseDelayedOffer();
  await expectGlobalCleanup("user-cancelled");
  await expect.poll(async () => (await adapterSnapshot())?.state).toBe("idle");

  await setProbeMode("delay-offer");
  controls = await openVoicePanel();
  await controls.panel.getByTestId("bea-voice-start").click();
  await expect(controls.status).toHaveAttribute("data-state", "connecting");
  await expect.poll(async () => (await nativeSnapshot()).liveTrackCount).toBeGreaterThan(0);
  await expect.poll(async () => (await nativeSnapshot()).createdPeerCount).toBeGreaterThan(1);
  const connectingRefreshArmed = await armLifecyclePagehideReport("connecting-refresh");
  const connectingRefreshResponse = await page.reload();
  expect(connectingRefreshResponse?.headers()["permissions-policy"]).toBe(
    "camera=(), microphone=(self), geolocation=()",
  );
  await activeApplicationShell(page);
  const connectingRefreshReport = await consumeLifecyclePagehideReport(connectingRefreshArmed);
  expect(connectingRefreshReport).toMatchObject({
    liveTrackCount: 0,
    openPeerCount: 0,
    audioReferenceCount: 0,
    activeProbeListenerCount: 0,
    adapter: {
      state: "idle",
      stopReason: "pagehide",
      cleanupComplete: true,
      activeTimerCount: 0,
      activeListenerCount: 0,
      activeAnimationFrameCount: 0,
      allTracksEnded: true,
      allPeerConnectionsClosed: true,
      audioReferencesReleased: true,
    },
  });
  expect(
    connectingRefreshReport?.trackStateHistories.every((history) => history.includes("ended")),
  ).toBe(true);
  expect(
    connectingRefreshReport?.peerConnectionStateHistories.every((history) =>
      history.includes("closed"),
    ),
  ).toBe(true);
  expect(
    connectingRefreshReport?.signalingStateHistories.every((history) => history.includes("closed")),
  ).toBe(true);
  nativeEvidence.push(connectingRefreshReport!);

  await setProbeMode("peer-failure");
  controls = await openVoicePanel();
  await controls.panel.getByTestId("bea-voice-start").click();
  await expect(controls.status).toHaveAttribute("data-state", "error");
  expect((await adapterSnapshot())?.errorCode).toBe("peer-connection-failed");
  await expectVisibleCleanup(controls.status, "start-failed");

  await setProbeMode("native");
  controls = await startAndWaitForNativeLoopback();
  expect(await endFirstLiveTrack()).toBe(true);
  await expectVisibleCleanup(controls.status, "track-ended");

  for (let cycle = 0; cycle < repeatedCycleCount; cycle += 1) {
    controls = await startAndWaitForNativeLoopback();
    await controls.panel.getByTestId("bea-voice-stop").click();
    await expectVisibleCleanup(controls.status, "user-stopped");
  }
  expect((await adapterSnapshot())?.authorizationRequests).toBe(1);

  controls = await startAndWaitForNativeLoopback();
  const navigationCleanupArmed = await armLifecyclePagehideReport("navigation-cleanup");
  shell = await activeApplicationShell(page);
  await shell
    .getByRole("navigation", { name: "Command Center navigation" })
    .getByRole("button", { name: "More" })
    .click();
  await shell
    .getByRole("navigation", { name: "Command Center navigation" })
    .getByRole("link", { name: "Tasks", exact: true })
    .click();
  await expect(page).toHaveURL(/\/tasks$/u);
  const navigationCleanupReport = await consumeLifecyclePagehideReport(navigationCleanupArmed);
  expect(navigationCleanupReport).toMatchObject({
    liveTrackCount: 0,
    openPeerCount: 0,
    audioReferenceCount: 0,
    activeProbeListenerCount: 0,
    adapter: {
      cleanupComplete: true,
      activeTimerCount: 0,
      activeListenerCount: 0,
      activeAnimationFrameCount: 0,
      allTracksEnded: true,
      allPeerConnectionsClosed: true,
      audioReferencesReleased: true,
    },
  });
  const navigationCleanupWinner = navigationCleanupReport.adapter?.stopReason;
  expect(["pagehide", "component-unmount"]).toContain(navigationCleanupWinner);
  nativeEvidence.push(navigationCleanupReport);

  const secondAiCommandResponse = await page.goto("/ai-command");
  expect(secondAiCommandResponse?.headers()["permissions-policy"]).toBe(
    "camera=(), microphone=(self), geolocation=()",
  );
  controls = await startAndWaitForNativeLoopback();
  const refreshArmed = await armLifecyclePagehideReport("active-refresh");
  const refreshResponse = await page.reload();
  expect(refreshResponse?.headers()["permissions-policy"]).toBe(
    "camera=(), microphone=(self), geolocation=()",
  );
  await activeApplicationShell(page);
  const refreshReport = await consumeLifecyclePagehideReport(refreshArmed);
  expect(refreshReport).toMatchObject({
    liveTrackCount: 0,
    openPeerCount: 0,
    audioReferenceCount: 0,
    activeProbeListenerCount: 0,
    adapter: {
      stopReason: "pagehide",
      cleanupComplete: true,
      activeTimerCount: 0,
      activeListenerCount: 0,
      activeAnimationFrameCount: 0,
      allTracksEnded: true,
      allPeerConnectionsClosed: true,
      audioReferencesReleased: true,
    },
  });
  nativeEvidence.push(refreshReport!);

  controls = await startAndWaitForNativeLoopback();
  const signOutArmed = await armLifecyclePagehideReport("sign-out");
  const accountMenu = (await activeApplicationShell(page)).getByTestId("account-menu");
  await accountMenu.locator("summary").click();
  await accountMenu.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in\?reason=signed-out/u);
  const signOutReport = await consumeLifecyclePagehideReport(signOutArmed);
  expect(signOutReport?.liveTrackCount).toBe(0);
  expect(signOutReport?.openPeerCount).toBe(0);
  expect(signOutReport?.audioReferenceCount).toBe(0);
  expect(signOutReport?.activeProbeListenerCount).toBe(0);
  expect(["pagehide", "component-unmount"]).toContain(signOutReport?.adapter?.stopReason);
  expect(signOutReport?.adapter).toMatchObject({
    cleanupComplete: true,
    activeTimerCount: 0,
    activeListenerCount: 0,
    activeAnimationFrameCount: 0,
    allTracksEnded: true,
    allPeerConnectionsClosed: true,
    audioReferencesReleased: true,
  });
  nativeEvidence.push(signOutReport!);
  expect(lifecycleReportsById.size).toBe(4);
  expect(lifecycleReportExpectations.size).toBe(4);
  expect(lifecycleConsumedStorageKeys.size).toBe(4);
  expect([...lifecycleReportExpectations.values()].every((entry) => entry.accepted)).toBe(true);
  expect(lifecycleInvalidPayloadCount).toBe(0);
  expect(lifecycleUnknownReportCount).toBe(0);
  expect(lifecycleDuplicateReportCount).toBe(0);

  const deniedPersonas = [personas[1], personas[2], personas[3]] as const;
  const deniedCorrelations: string[] = [];
  for (const [index, persona] of deniedPersonas.entries()) {
    await signIn(page, persona.label);
    const correlationId = `gate30-rbac-denied-${index + 1}`;
    deniedCorrelations.push(correlationId);
    const response = await page.request.post("/api/ai-command/realtime/client-secret", {
      data: {},
      headers: { Origin: appOrigin, "X-Correlation-ID": correlationId },
    });
    expect(response.status()).toBe(403);
    const body = (await response.json()) as {
      readonly error?: { readonly code?: string };
      readonly authorization?: unknown;
    };
    expect(body.error?.code).toBe("permission-not-granted");
    expect(Object.hasOwn(body, "authorization")).toBe(false);
    await context.clearCookies();
    await page.goto("/sign-in");
  }

  await signIn(page, "Workspace Owner — Chief Executive Officer");
  const authChecks = await Promise.all(authResponseChecks);
  expect(authChecks).toHaveLength(4);
  expect(authChecks.every((check) => check.status === 200 && check.strictDemoContract)).toBe(true);
  expect(authChecks.some((check) => check.standardCredentialFound)).toBe(false);
  expect(authChecks.every((check) => Boolean(check.correlationId))).toBe(true);
  await page.goto("/audit");
  shell = await activeApplicationShell(page);
  for (const correlationId of deniedCorrelations) {
    const row = shell.locator("tbody tr").filter({ hasText: correlationId });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("authorization.denied");
    await expect(row).toContainText("ai-command.realtime.authorize");
    await expect(row).toContainText("denied");
  }
  for (const check of authChecks) {
    const row = shell.locator("tbody tr").filter({ hasText: check.correlationId });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("ai-provider.realtime-authorized");
    await expect(row).toContainText("ai-command.realtime.authorize");
    await expect(row).toContainText("succeeded");
  }

  const lifecycleTokens = [
    gate30LifecycleSchema,
    lifecycleStoragePrefix,
    lifecycleInboxName,
    ...[...lifecycleReportExpectations.entries()].flatMap(([reportId, expectation]) => [
      reportId,
      expectation.nonce,
      expectation.storageKey,
    ]),
  ];
  const lifecycleHarnessResidue = await page.evaluate(
    ({ inboxName, storagePrefix, tokens }) => {
      let storageLocationCount = 0;
      let storageAccessible = true;
      try {
        for (const storage of [window.localStorage, window.sessionStorage]) {
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index) ?? "";
            const value = storage.getItem(key) ?? "";
            if (
              key.includes(storagePrefix) ||
              value.includes(storagePrefix) ||
              tokens.some((token) => key.includes(token) || value.includes(token))
            ) {
              storageLocationCount += 1;
            }
          }
        }
      } catch {
        storageAccessible = false;
      }
      return {
        inboxPropertyCount: Object.hasOwn(window, inboxName) ? 1 : 0,
        storageAccessible,
        storageLocationCount,
      };
    },
    {
      inboxName: lifecycleInboxName,
      storagePrefix: lifecycleStoragePrefix,
      tokens: lifecycleTokens,
    },
  );
  expect(lifecycleHarnessResidue).toEqual({
    inboxPropertyCount: 0,
    storageAccessible: true,
    storageLocationCount: 0,
  });

  const browserLeakScan = await page.evaluate(async () => {
    const standardKeyPattern = /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/u;
    const rawAudioPattern = /^data:audio\//iu;
    const values: string[] = [document.documentElement.outerHTML];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? "";
        values.push(key, storage.getItem(key) ?? "");
      }
    }
    const databaseCount =
      typeof indexedDB.databases === "function" ? (await indexedDB.databases()).length : 0;
    const cacheCount = typeof caches === "undefined" ? 0 : (await caches.keys()).length;
    return {
      standardCredentialLocationCount: values.filter((value) => standardKeyPattern.test(value))
        .length,
      syntheticCredentialLocationCount: values.filter((value) => value.includes("demo-no-network-"))
        .length,
      rawAudioLocationCount: values.filter((value) => rawAudioPattern.test(value)).length,
      databaseCount,
      cacheCount,
    };
  });
  let cookieCredentialLocationCount = 0;
  for (const cookie of await context.cookies()) {
    if (/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/u.test(cookie.value)) {
      cookieCredentialLocationCount += 1;
    }
    if (cookie.value.includes("demo-no-network-")) cookieCredentialLocationCount += 1;
  }
  expect(browserLeakScan).toMatchObject({
    standardCredentialLocationCount: 0,
    syntheticCredentialLocationCount: 0,
    rawAudioLocationCount: 0,
    databaseCount: 0,
    cacheCount: 0,
  });
  expect(cookieCredentialLocationCount).toBe(0);

  const allNativeEvidence = [...nativeEvidence, ...pagehideReports];
  expect(allNativeEvidence.length).toBeGreaterThan(0);
  expect(allNativeEvidence.every((snapshot) => snapshot.rawAudioWriteCount === 0)).toBe(true);
  expect(allNativeEvidence.every((snapshot) => snapshot.liveTrackCount === 0)).toBe(true);
  expect(allNativeEvidence.every((snapshot) => snapshot.openPeerCount === 0)).toBe(true);
  expect(allNativeEvidence.every((snapshot) => snapshot.audioReferenceCount === 0)).toBe(true);
  expect(allNativeEvidence.every((snapshot) => snapshot.activeProbeListenerCount === 0)).toBe(true);
  expect(allNativeEvidence.every((snapshot) => snapshot.instrumentationFailureCount === 0)).toBe(
    true,
  );
  expect(
    allNativeEvidence.flatMap((snapshot) => snapshot.iceServerCounts).every((count) => count === 0),
  ).toBe(true);
  const trackHistories = allNativeEvidence.flatMap((snapshot) => snapshot.trackStateHistories);
  const peerHistories = allNativeEvidence.flatMap(
    (snapshot) => snapshot.peerConnectionStateHistories,
  );
  const signalingHistories = allNativeEvidence.flatMap(
    (snapshot) => snapshot.signalingStateHistories,
  );
  expect(trackHistories.length).toBeGreaterThan(0);
  expect(trackHistories.every((history) => history.includes("ended"))).toBe(true);
  expect(peerHistories.length).toBeGreaterThan(0);
  expect(peerHistories.every((history) => history.includes("closed"))).toBe(true);
  expect(signalingHistories.every((history) => history.includes("closed"))).toBe(true);
  expect(
    trackHistories.some((history) => history.includes("live") && history.includes("ended")),
  ).toBe(true);
  expect(
    peerHistories.some((history) => history.includes("connected") && history.includes("closed")),
  ).toBe(true);
  expect(allNativeEvidence.some((snapshot) => snapshot.addTrackCalls > 0)).toBe(true);
  expect(externalRequestCount).toBe(0);
  expect(authRouteRequestCount).toBe(4);
  expect(malformedAuthRequestCount).toBe(0);
  expect(credentialRequestLeakCount).toBe(0);
  expect(consoleFailureCount).toBe(0);
  expect(pageErrorCount).toBe(0);
  expect(maxListenersWarningCount).toBe(0);

  const fixtureSha256 = process.env.BEA_BROWSER_MEDIA_TEST_WAV_SHA256 ?? "";
  expect(fixtureSha256).toMatch(/^[a-f0-9]{64}$/u);
  const browserVersion = browser.version();
  const evidence = {
    browser: `Chromium ${browserVersion}`,
    browserChannel: testInfo.project.use.channel,
    project: testInfo.project.name,
    launchFlags: [
      "enable automation for sanitized CDP launch verification",
      "autoplay-policy=no-user-gesture-required",
      "disable WebRTC mDNS",
      "fake media device",
      "generated fake audio file",
    ],
    permission: "Playwright empty origin grant denied; microphone grant restored",
    permissionDeniedNativeFailureName,
    traceArtifacts: "off",
    browserMediaRuntime: browserMediaRuntimeEvidence,
    fixture: {
      format: "WAV PCM 48kHz 16-bit mono 12s alternating tone and silence",
      sha256: fixtureSha256,
    },
    route: "/ai-command",
    persona: "Workspace Owner",
    trackTransitions: "live -> ended",
    peerTransitions: "new/connecting -> connected -> closed",
    cleanup: { liveTracks: 0, openPeers: 0, audioReferences: 0, timers: 0, listeners: 0 },
    repeatedCycleCount,
    consoleErrorsOrWarnings: consoleFailureCount,
    pageErrors: pageErrorCount,
    maxListenersWarnings: maxListenersWarningCount,
    externalRequests: externalRequestCount,
    authorizationRequests: authRouteRequestCount,
    rbacDeniedRoles: deniedPersonas.length,
    auditEvidence: "succeeded and denied rows present",
    lifecyclePagehide: {
      schema: gate30LifecycleSchema,
      scenarios: gate30LifecycleScenarios,
      transport: "synchronous sessionStorage pre-app handoff",
      navigationCleanupWinner,
      acceptedReports: lifecycleReportsById.size,
      consumedReports: lifecycleConsumedStorageKeys.size,
      invalidPayloads: lifecycleInvalidPayloadCount,
      unknownReports: lifecycleUnknownReportCount,
      duplicateReports: lifecycleDuplicateReportCount,
      inboxPropertyResidue: lifecycleHarnessResidue.inboxPropertyCount,
      storageResidueLocations: lifecycleHarnessResidue.storageLocationCount,
    },
  };
  console.log(`GATE30_BROWSER_EVIDENCE=PASS ${JSON.stringify(evidence)}`);
});
