import { expect, test, type Page } from "@playwright/test";

const salesPersona = "Sales Specialist — Sales";
const operationsPersona = "Operations Coordinator — Operations";

async function signIn(page: Page, personaLabel: string) {
  await page.goto("/sign-in?returnTo=%2Fleads");
  await page.getByRole("combobox", { name: "Demo persona" }).selectOption({ label: personaLabel });
  await page.getByRole("button", { name: "Sign in to Command Center" }).click();
}

test.describe("@phase20-leads Phase 2.0 lead command and review queue", () => {
  test("sales can open the review queue and a lead command record", async ({ page }) => {
    await signIn(page, salesPersona);
    await expect(page).toHaveURL(/\/leads/u);
    await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Create lead" })).toBeVisible();
    await page.getByRole("link", { name: "Synthetic Northstar curtain-wall review" }).click();
    await expect(
      page.getByRole("heading", { name: "Synthetic Northstar curtain-wall review" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Missing information and readiness" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("main").getByText("Enough information for proposal work").first(),
    ).toBeVisible();
    await expect(page.getByRole("main").getByTestId("create-proposal")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Linked proposals" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create a follow-up task" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create task" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Northstar Facade Group" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Morgan Demo" }).first()).toBeVisible();
    await page.goto("/leads/new");
    await expect(page.getByLabel(/address line 1/i)).toBeVisible();
    await expect(page.getByLabel(/^country/i)).toBeVisible();
    await expect(page.getByLabel(/linked contact/i).first()).toBeVisible();
    await page.goto("/leads/a1000000-0000-4000-8000-000000000003/edit");
    await expect(page.getByLabel(/address line 1/i)).toBeVisible();
    await expect(page.getByLabel(/postal code/i)).toBeVisible();
    await expect(page.getByLabel(/linked contact/i).first()).toBeVisible();
    await expect(page.getByLabel(/^email$/i).first()).toBeVisible();
    await page.goto("/leads");
    await expect(page.getByText("Northstar Facade Group").first()).toBeVisible();
  });

  test("operations is denied the lead review queue", async ({ page }) => {
    await signIn(page, operationsPersona);
    await expect(page).toHaveURL(/access-denied/u);
    await expect(page.getByTestId("access-denied")).toBeVisible();
  });
});
