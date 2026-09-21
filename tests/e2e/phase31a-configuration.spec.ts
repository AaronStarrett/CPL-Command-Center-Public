import { expect, test, type Page } from "@playwright/test";

const ownerPersona = "Workspace Owner — Chief Executive Officer";
const salesPersona = "Sales Specialist — Sales";

function visibleText(page: Page, pattern: string | RegExp) {
  return page.getByText(pattern).filter({ visible: true }).first();
}

async function signIn(page: Page, personaLabel: string, returnTo = "/configuration") {
  await page.goto(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  const persona = page.getByRole("combobox", { name: "Demo persona" });
  if ((await persona.count()) === 0) {
    await page.getByTestId("account-menu").locator("summary").click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("combobox", { name: "Demo persona" })).toBeVisible();
  }
  await page.getByRole("combobox", { name: "Demo persona" }).selectOption({ label: personaLabel });
  await page.getByRole("button", { name: "Sign in to Command Center" }).click();
}

test.describe("@phase31a-configuration Configurable report production studio", () => {
  test("owner sees readiness, synthetic disclosure, and can open the lab", async ({ page }) => {
    await signIn(page, ownerPersona);
    await expect(page).toHaveURL(/\/configuration/u);
    await expect(page.getByRole("heading", { name: "Readiness" })).toBeVisible();
    await expect(visibleText(page, /SYNTHETIC FIXTURE/i)).toBeVisible();
    await expect(page.getByTestId("configuration-readiness-distinctions")).toContainText(
      "Awaiting BEA confirmation",
    );
    await page
      .getByRole("navigation", { name: "Configuration studio" })
      .getByRole("link", { name: "Synthetic lab" })
      .click();
    await expect(page.getByRole("heading", { name: "Synthetic lab" })).toBeVisible();
    await expect(visibleText(page, /Synthetic Exterior Observation/i)).toBeVisible();
    await expect(visibleText(page, /Synthetic Moisture Investigation/i)).toBeVisible();
  });

  test("sales cannot open configuration studio", async ({ page }) => {
    await signIn(page, salesPersona, "/configuration");
    await expect(page).toHaveURL(/access-denied/u);
  });
});
