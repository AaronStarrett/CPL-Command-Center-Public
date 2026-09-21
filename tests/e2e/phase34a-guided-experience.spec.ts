import { expect, test, type Locator, type Page } from "@playwright/test";

const ownerPersona = "Workspace Owner — Chief Executive Officer";
const salesPersona = "Sales Specialist — Sales";
const operationsPersona = "Operations Coordinator — Operations";
const executivePersona = "Executive Viewer — Read-only Executive";
const integrationPersona = "Integration Administrator — Integration Administrator";

function visibleShell(page: Page): Locator {
  return page.locator(".bea-application-shell").filter({ visible: true });
}

async function waitForVisibleShell(page: Page): Promise<Locator> {
  const shell = visibleShell(page);
  await expect(shell).toHaveCount(1);
  return shell;
}

async function signIn(page: Page, personaLabel: string, returnTo = "/command-center") {
  await page.goto(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  const persona = page.getByRole("combobox", { name: "Demo persona" });
  if ((await persona.count()) === 0) {
    await visibleShell(page).getByTestId("account-menu").locator("summary").click();
    await visibleShell(page)
      .getByTestId("account-menu")
      .getByRole("button", { name: "Sign out" })
      .click();
    await expect(page.getByRole("combobox", { name: "Demo persona" })).toBeVisible();
  }
  await page.getByRole("combobox", { name: "Demo persona" }).selectOption({ label: personaLabel });
  await page.getByRole("button", { name: "Sign in to Command Center" }).click();
  await waitForVisibleShell(page);
}

async function primaryNav(page: Page) {
  return (await waitForVisibleShell(page)).getByRole("navigation", {
    name: "Command Center navigation",
  });
}

async function waitForGate(page: Page, testId: string) {
  await expect(page.getByTestId(testId).first()).toBeVisible({ timeout: 120_000 });
}

async function clickGate(page: Page, testId: string) {
  await page.getByTestId(testId).first().click();
}

async function postGuidedDemo(page: Page, action: string, extra: Record<string, unknown> = {}) {
  return page.request.post("/api/guided-demo/meridian", {
    data: { action, ...extra },
    headers: {
      origin: new URL(page.url()).origin,
      "content-type": "application/json",
    },
  });
}

async function guidedEnvelope(page: Page) {
  const response = await page.request.get("/api/guided-demo/meridian");
  return (await response.json()) as {
    snapshot?: {
      machineState?: string;
      optimisticVersion?: number;
      recentEvents?: readonly { plainLanguageMessage?: string }[];
    };
    report?: {
      id?: string;
      reference?: string;
      versionNumber?: number;
      status?: string;
      versionId?: string;
      workspace?: { versionMarker?: string; findingCount?: number; evidenceCount?: number } | null;
    };
  };
}

async function advanceToTechnicalReview(page: Page) {
  await postGuidedDemo(page, "reset", { skipDelay: true, speedMode: "fast" });
  await postGuidedDemo(page, "start", { skipDelay: true, speedMode: "fast" });
  await postGuidedDemo(page, "submit_human_decision", {
    decisionKey: "add_simulated_authorization",
    skipDelay: true,
    speedMode: "fast",
  });
  return postGuidedDemo(page, "approve_proposal", { skipDelay: true, speedMode: "fast" });
}

async function advanceToOwnerDeliveryGate(page: Page) {
  await advanceToTechnicalReview(page);
  return postGuidedDemo(page, "approve_technical_content", {
    skipDelay: true,
    speedMode: "fast",
  });
}

test.describe.serial("@phase34a-guided Phase 3.4A simplified Meridian experience", () => {
  test("Owner walkthrough from Command Center through no-send closeout", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, ownerPersona);
    const nav = await primaryNav(page);
    await expect(nav.getByRole("link", { name: "Command Center" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Automation Flow" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Company Details" })).toBeVisible();
    await expect(page.getByTestId("bea-orb")).toBeVisible();
    await expect(page.getByTestId("start-meridian-demo")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("start-meridian-demo").click();
    await page.getByTestId("speed-fast").first().click();
    await nav.getByRole("link", { name: "Automation Flow" }).click();
    await expect(page.getByTestId("automation-flow-canvas")).toBeVisible();
    await page.getByTestId("run-to-next-decision").click();
    await waitForGate(page, "human-decision-card");
    await expect(page.getByTestId("flow-node-information_check")).toHaveAttribute(
      "data-status",
      "human_decision_required",
    );
    await clickGate(page, "add-simulated-authorization");
    await waitForGate(page, "approve-proposal");
    await clickGate(page, "approve-proposal");
    await waitForGate(page, "request-technical-changes");
    await clickGate(page, "request-technical-changes");
    await expect(page.getByTestId("flow-node-report_assembly")).toHaveAttribute(
      "data-status",
      /processing|completed/u,
      { timeout: 30_000 },
    );
    await waitForGate(page, "approve-technical-content");
    await clickGate(page, "approve-technical-content");
    await waitForGate(page, "authorize-demo-delivery");
    await nav.getByRole("link", { name: "Command Center" }).click();
    await page.getByTestId("play-preset-voice-demo").click();
    await expect(page.getByTestId("bea-orb")).toHaveAttribute("data-state", "listening");
    await expect(page.getByTestId("voice-transcript")).toHaveText(
      "Show me the Meridian Commerce Center inspection report.",
    );
    await expect(page.getByTestId("report-workspace")).toBeVisible();
    await expect(page.getByTestId("finding-F-1")).toBeVisible();
    await expect(page.getByTestId("finding-F-2")).toBeVisible();
    await expect(page.getByTestId("finding-F-3")).toBeVisible();
    await expect(page.getByTestId("finding-F-1")).toContainText(
      "Roof Membrane Puncture Near RTU-4",
    );
    await expect(page.getByTestId("source-chip-findings")).toBeVisible();
    await expect(page.getByTestId("source-chip-findings")).toHaveAttribute("data-record-id", /.+/);
    await expect(page.getByTestId("report-version-marker")).toContainText(
      "REVIEW UPDATE — Version 2",
    );
    await expect(page.getByTestId("synthetic-photo-grid").locator("figure")).toHaveCount(12);
    await expect(page.getByTestId("report-review-history")).toBeVisible();
    await expect(page.getByTestId("stored-report-unavailable")).toHaveCount(0);
    const fullRecord = page
      .getByTestId("report-workspace")
      .getByRole("link", { name: "Open full record" });
    await expect(fullRecord).toBeVisible();
    const workspaceReference = await page
      .getByTestId("report-workspace")
      .locator("header p")
      .nth(1)
      .textContent();
    expect(workspaceReference).toMatch(/BEA-RP-\d+/);
    await fullRecord.click();
    await expect(page.getByRole("heading", { name: /BEA-RP-\d+/ })).toBeVisible();
    await expect(page.getByTestId("report-current-version")).toContainText("report version 2");
    await nav.getByRole("link", { name: "Command Center" }).click();
    await waitForGate(page, "authorize-demo-delivery");
    await clickGate(page, "authorize-demo-delivery");
    await expect(page.getByTestId("command-center-status")).toContainText(
      /Billing|Closeout|complete/i,
      {
        timeout: 60_000,
      },
    );
    await nav.getByRole("link", { name: "Company Details" }).click();
    await expect(page.getByTestId("integration-readiness")).toContainText("Outlook: Not connected");
    await expect(page.getByText("Production Service Catalog: Unconfigured")).toBeVisible();
    await page.getByTestId("reset-meridian-demo").click();
    await nav.getByRole("link", { name: "Command Center" }).click();
    await expect(page.getByTestId("start-meridian-demo")).toBeVisible();
  });

  test("Sales cannot approve the Proposal or authorize delivery", async ({ page }) => {
    await signIn(page, salesPersona);
    await expect(await primaryNav(page)).toBeVisible();
    await page.goto("/automation-flow");
    await expect(page.getByTestId("approve-proposal")).toHaveCount(0);
    await expect(page.getByTestId("authorize-demo-delivery")).toHaveCount(0);
    const denied = await postGuidedDemo(page, "approve_proposal");
    expect(denied.status()).toBeGreaterThanOrEqual(400);
  });

  test("Operations can technically review and cannot authorize delivery", async ({ page }) => {
    await signIn(page, operationsPersona);
    await page.goto("/automation-flow");
    await expect(page.getByTestId("approve-proposal")).toHaveCount(0);
    const denied = await postGuidedDemo(page, "authorize_demo_delivery");
    expect([403, 409, 400]).toContain(denied.status());
  });

  test("Integration Administrator and Executive Read-only cannot mutate the story", async ({
    page,
  }) => {
    await signIn(page, integrationPersona);
    const integrationDenied = await postGuidedDemo(page, "start");
    expect(integrationDenied.status()).toBe(403);
    await signIn(page, executivePersona);
    await expect(page.getByTestId("start-meridian-demo")).toHaveCount(0);
    const executiveDenied = await postGuidedDemo(page, "reset");
    expect(executiveDenied.status()).toBe(403);
  });

  test("keyboard list fallback and reduced-motion remain available", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, ownerPersona);
    await (await primaryNav(page)).getByRole("link", { name: "Automation Flow" }).click();
    const shell = await waitForVisibleShell(page);
    await expect(shell.getByTestId("automation-flow-canvas")).toBeVisible();
    await expect(shell.getByTestId("meridian-demo-controller")).toBeVisible();
    await shell.getByTestId("workflow-list-fallback").click();
    await expect(shell.getByTestId("workflow-list")).toBeVisible();
    const firstStage = shell.getByTestId("workflow-list-stage-lead_intake");
    await firstStage.scrollIntoViewIfNeeded();
    await firstStage.click();
    await expect(shell.getByTestId("node-detail-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(shell.getByTestId("node-detail-drawer")).toHaveCount(0);
    await firstStage.focus();
    await expect(firstStage).toBeFocused();
    await firstStage.press("Enter");
    await expect(shell.getByTestId("node-detail-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(shell.getByTestId("node-detail-drawer")).toHaveCount(0);
  });

  test("Owner delivery-gate changes create a new reviewed Report version", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, ownerPersona);
    const gate = await advanceToOwnerDeliveryGate(page);
    expect(gate.status()).toBe(200);
    const before = await guidedEnvelope(page);
    expect(before.snapshot?.machineState).toBe("waiting_delivery_authorization");
    expect(before.report?.status).toBe("ready_for_delivery");
    const previousVersion = before.report?.versionNumber;
    expect(previousVersion).toBeGreaterThan(0);
    const nav = await primaryNav(page);
    await nav.getByRole("link", { name: "Automation Flow" }).click();
    await waitForGate(page, "request-delivery-changes");
    await page
      .getByTestId("delivery-change-reason")
      .fill("Clarify the recommended repair priority before release.");
    await clickGate(page, "request-delivery-changes");
    await expect(page.getByTestId("flow-node-report_assembly")).toHaveAttribute(
      "data-status",
      /processing|completed/u,
      { timeout: 30_000 },
    );
    await waitForGate(page, "approve-technical-content");
    const revised = await guidedEnvelope(page);
    expect(revised.snapshot?.machineState).toBe("waiting_technical_review");
    expect(revised.report?.status).toBe("in_review");
    expect(revised.report?.versionNumber).toBe((previousVersion ?? 0) + 1);
    const activity = (revised.snapshot?.recentEvents ?? [])
      .map((event) => event.plainLanguageMessage ?? "")
      .join("\n");
    expect(activity).toContain(
      `Owner requested delivery changes for Report Version ${previousVersion}.`,
    );
    expect(activity).toContain(
      `Report Version ${revised.report?.versionNumber} was prepared for technical review.`,
    );
    await signIn(page, operationsPersona);
    await (await primaryNav(page)).getByRole("link", { name: "Automation Flow" }).click();
    await waitForGate(page, "approve-technical-content");
    await clickGate(page, "approve-technical-content");
    await expect
      .poll(async () => (await guidedEnvelope(page)).snapshot?.machineState, { timeout: 60_000 })
      .toBe("waiting_delivery_authorization");
    await signIn(page, ownerPersona);
    await waitForGate(page, "authorize-demo-delivery");
    const ready = await guidedEnvelope(page);
    expect(ready.report?.versionNumber).toBe(revised.report?.versionNumber);
    expect(ready.report?.status).toBe("ready_for_delivery");
    await page.getByTestId("play-preset-voice-demo").click();
    await expect(page.getByTestId("report-workspace")).toBeVisible();
    await expect(page.getByTestId("report-version-marker")).toContainText(
      `REVIEW UPDATE — Version ${revised.report?.versionNumber}`,
    );
    await page.getByTestId("report-workspace").getByTestId("authorize-demo-delivery").click();
    await expect(page.getByTestId("command-center-status")).toContainText(
      /Billing|Closeout|complete/i,
      {
        timeout: 60_000,
      },
    );
    await expect
      .poll(async () => (await guidedEnvelope(page)).snapshot?.machineState, { timeout: 60_000 })
      .toBe("completed");
    const completed = await guidedEnvelope(page);
    expect(completed.report?.status).toBe("delivered");
    expect(completed.report?.versionNumber).toBe(revised.report?.versionNumber);
    await page.getByTestId("play-preset-voice-demo").click();
    await expect(page.getByTestId("simulated-command-response")).toContainText(
      "No real email was sent",
    );
    await postGuidedDemo(page, "reset", { skipDelay: true });
  });

  test("Operations cannot request delivery changes at the Owner gate", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, ownerPersona);
    const gate = await advanceToOwnerDeliveryGate(page);
    expect(gate.status()).toBe(200);
    await signIn(page, operationsPersona);
    await page.goto("/automation-flow");
    await expect(page.getByTestId("request-delivery-changes")).toHaveCount(0);
    await expect(page.getByTestId("authorize-demo-delivery")).toHaveCount(0);
    const denied = await postGuidedDemo(page, "request_delivery_changes", {
      comments: "Operations must not reopen the Owner gate.",
    });
    expect(denied.status()).toBe(403);
    const after = await guidedEnvelope(page);
    expect(after.snapshot?.machineState).toBe("waiting_delivery_authorization");
    expect(after.report?.status).toBe("ready_for_delivery");
    expect(after.report?.versionNumber).toBe((await gate.json()).report?.versionNumber);
    await signIn(page, ownerPersona);
    await postGuidedDemo(page, "reset", { skipDelay: true });
  });

  test("missing stored snapshot shows a controlled unavailable workspace", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, ownerPersona);
    const review = await advanceToTechnicalReview(page);
    expect(review.status()).toBe(200);
    await page.route("**/api/guided-demo/meridian", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const json = (await response.json()) as {
        report?: { workspace?: unknown; workspaceError?: string | null };
        command?: { openReport?: boolean; message?: string };
      };
      if (json.report) {
        json.report.workspace = null;
        json.report.workspaceError =
          "The stored Report workspace snapshot is missing for this demonstration run.";
      }
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        contentType: "application/json",
        body: JSON.stringify(json),
      });
    });
    await page.route("**/api/command-center/demo-command", async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as {
        report?: { workspace?: unknown; workspaceError?: string | null };
        command?: { openReport?: boolean; message?: string };
      };
      if (json.report) {
        json.report.workspace = null;
        json.report.workspaceError =
          "The stored Report workspace snapshot is missing for this demonstration run.";
      }
      if (json.command) {
        json.command.openReport = true;
        json.command.message =
          "Stored Report content is unavailable for this demonstration run. I will not invent Report facts.";
      }
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        contentType: "application/json",
        body: JSON.stringify(json),
      });
    });
    await page.goto("/command-center");
    await page.getByTestId("play-preset-voice-demo").click();
    await expect(page.getByTestId("stored-report-unavailable")).toBeVisible();
    await expect(page.getByTestId("finding-F-1")).toHaveCount(0);
    await expect(page.getByTestId("approve-technical-content")).toHaveCount(0);
    await expect(page.getByText("Roof Membrane Puncture Near RTU-4")).toHaveCount(0);
    await postGuidedDemo(page, "reset", { skipDelay: true });
  });
});
