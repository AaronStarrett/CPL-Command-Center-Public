import { expect, test, type Locator, type Page } from "@playwright/test";

const ownerPersona = "Workspace Owner — Chief Executive Officer";

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

async function copresenterWorkspace(page: Page): Promise<Locator> {
  const shell = await activeApplicationShell(page);
  const workspace = shell.getByRole("main").getByTestId("ai-command-workspace");
  await expect(workspace).toHaveCount(1);
  await expect(workspace).toBeVisible();
  await expect(workspace).not.toHaveAttribute("data-browser-voice-state", "disabled");
  return workspace;
}

async function signIn(page: Page) {
  await page.goto("/sign-in?returnTo=%2Fai-command");
  await page.getByRole("combobox", { name: "Demo persona" }).selectOption({ label: ownerPersona });
  await page.getByRole("button", { name: "Sign in to Command Center" }).click();
  await expect(page).toHaveURL(/\/ai-command/u);
  await copresenterWorkspace(page);
}

async function sendCommand(page: Page, message: string) {
  const workspace = await copresenterWorkspace(page);
  await workspace.getByTestId("ai-interaction-mode-type").click();
  await workspace.getByLabel("Message BEA AI Command").fill(message);
  await workspace.getByRole("button", { name: "Send" }).click();
}

test.describe("@phase21-copresenter Phase 2.1 live AI executive co-presenter", () => {
  test("scrolls and clicks during simulated narration without dropping the presentation", async ({
    page,
  }) => {
    await signIn(page);
    await sendCommand(
      page,
      "Research the latest information relevant to water penetration testing and explain what matters to BEA.",
    );
    const presenting = await copresenterWorkspace(page);
    await expect(presenting.getByTestId("research-presentation")).toBeVisible({ timeout: 30_000 });
    await expect(presenting.getByTestId("source-board")).toBeVisible();
    await presenting.getByTestId("start-voice-to-hear").click();
    await expect(presenting).toHaveAttribute("data-interaction-mode", "voice");
    await expect(presenting).toHaveAttribute("data-narration-active", "true");
    await presenting.getByTestId("ai-workspace-scroller").hover();
    await page.mouse.wheel(0, 420);
    await expect(presenting).toHaveAttribute("data-narration-active", "true");
    await expect(presenting).toHaveAttribute("data-auto-follow", "false");
    await expect(presenting.getByTestId("follow-narration")).toBeVisible();
    await presenting.getByTestId("follow-narration").click();
    await expect(presenting).toHaveAttribute("data-auto-follow", "true");
    await presenting.getByTestId("source-source-2").locator("button").click();
    await expect(presenting.getByTestId("source-source-2")).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(presenting).toHaveAttribute("data-narration-active", "true");
    await presenting.getByTestId("ai-interaction-mode-type").click();
    await sendCommand(page, "What does this source mean for us?");
    const followUp = await copresenterWorkspace(page);
    await expect(followUp.getByTestId("research-presentation")).toBeVisible();
    await expect(followUp.getByText(/Source 2/u).first()).toBeVisible();
    await page.setViewportSize({ width: 768, height: 1024 });
    await followUp.getByRole("tab", { name: "Conversation" }).click();
    await expect(followUp).toHaveAttribute("data-interaction-mode", "type");
    await followUp.getByRole("tab", { name: "Workspace" }).click();
    await expect(followUp.getByTestId("research-presentation")).toBeVisible();
    await followUp.getByRole("tab", { name: "Conversation" }).click();
    await followUp.getByTestId("ai-interaction-mode-voice").click();
    await expect(followUp).toHaveAttribute("data-interaction-mode", "voice");
    await followUp.getByTestId("ai-interaction-mode-type").click();
    await expect(followUp).toHaveAttribute("data-voice-session", "idle");
  });

  test("typed research without connected voice renders the packet and does not mark narration active", async ({
    page,
  }) => {
    await signIn(page);
    await sendCommand(
      page,
      "Research the latest information relevant to water penetration testing and explain what matters to BEA.",
    );
    const workspace = await copresenterWorkspace(page);
    await expect(workspace.getByTestId("research-presentation")).toBeVisible({ timeout: 30_000 });
    await expect(workspace).toHaveAttribute("data-narration-active", "false");
    await expect(workspace).toHaveAttribute("data-voice-session", "idle");
    await expect(workspace.getByTestId("start-voice-to-hear")).toBeVisible();
    await expect(workspace.getByTestId("citation-source-2")).toHaveAttribute(
      "data-simulated-source",
      "true",
    );
    await expect(workspace.getByTestId("citation-source-2")).not.toHaveAttribute("href");
  });

  test("owner live acceptance center keeps physical observations NOT RUN in Demo", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/integrations/ai");
    const administrationShell = await activeApplicationShell(page);
    await expect(administrationShell.getByTestId("openai-administration-panel")).toBeVisible();
    await page.goto("/integrations/ai/owner-acceptance");
    const ownerShell = await activeApplicationShell(page);
    await expect(ownerShell.getByTestId("owner-live-acceptance-center")).toBeVisible();
    await expect(ownerShell.getByTestId("owner-acceptance-physical")).toContainText("NOT_RUN");
    await expect(ownerShell.getByTestId("owner-acceptance-confirm-heard_ai_speak")).toBeDisabled();
    await expect(ownerShell.getByTestId("openai-administration-panel")).toBeVisible();
    await expect(
      ownerShell.getByRole("heading", { name: "OpenAI Provider", exact: true }),
    ).toBeVisible();
  });
});
