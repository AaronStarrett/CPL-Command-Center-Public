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
      { message: "exactly one shell is interactive" },
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
  return workspace;
}

test.describe("@phase21-copresenter Voice/Type modes and in-pane workspace", () => {
  test("keeps Voice and Type exclusive, stops capture on Type, and opens companies in-pane", async ({
    page,
  }) => {
    await page.goto("/sign-in?returnTo=%2Fai-command");
    await page
      .getByRole("combobox", { name: "Demo persona" })
      .selectOption({ label: ownerPersona });
    await page.getByRole("button", { name: "Sign in to Command Center" }).click();
    await expect(page).toHaveURL(/\/ai-command/u);
    const workspace = await copresenterWorkspace(page);
    await expect(workspace).toHaveAttribute("data-interaction-mode", "type");
    await expect(workspace.getByTestId("ai-command-composer")).toBeVisible();
    await expect(workspace.getByTestId("bea-ai-orb")).toBeHidden();
    await workspace.getByTestId("ai-interaction-mode-voice").click();
    await expect(workspace).toHaveAttribute("data-interaction-mode", "voice");
    await expect(workspace.getByTestId("bea-ai-orb")).toBeVisible();
    await expect(workspace.getByTestId("ai-command-composer")).toBeHidden();
    await expect(workspace.getByTestId("ai-message-scroller")).toBeHidden();
    await workspace.getByTestId("ai-interaction-mode-type").click();
    await expect(workspace).toHaveAttribute("data-voice-session", "idle");
    await workspace.getByLabel("Message BEA AI Command").fill("Show companies");
    await workspace.getByRole("button", { name: "Send" }).click();
    const companiesLink = workspace.getByRole("link", { name: "View companies" }).first();
    if (await companiesLink.count()) {
      await companiesLink.click();
      await expect(page).toHaveURL(/\/ai-command/u);
      await expect(workspace.getByTestId("ai-workspace-panel")).toBeVisible();
    }
    await page.setViewportSize({ width: 768, height: 1024 });
    await workspace.getByRole("tab", { name: "Conversation" }).click();
    await expect(workspace.getByTestId("ai-interaction-mode-voice")).toBeVisible();
    await workspace.getByTestId("ai-interaction-mode-voice").click();
    await expect(workspace).toHaveAttribute("data-interaction-mode", "voice");
    await workspace.getByTestId("ai-interaction-mode-type").click();
    await expect(workspace).toHaveAttribute("data-interaction-mode", "type");
  });
});
