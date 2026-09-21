import { expect, test, type Page } from "@playwright/test";

const ownerPersona = "Workspace Owner — Chief Executive Officer";
const operationsPersona = "Operations Coordinator — Operations";
const integrationPersona = "Integration Administrator — Integration Administrator";
const andrewExecutiveTestId = "workforce-agent-83000000-0000-4000-8000-000000000001";
const projectReadinessTestId = "workforce-agent-83000000-0000-4000-8000-000000000009";

function visibleTestId(page: Page, testId: string) {
  return page.getByTestId(testId).filter({ visible: true }).first();
}

async function signIn(page: Page, personaLabel: string, returnTo = "/digital-workforce") {
  await page.goto(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("combobox", { name: "Demo persona" }).selectOption({ label: personaLabel });
  await page.getByRole("button", { name: "Sign in to Command Center" }).click();
}

test.describe("@phase23-workforce Digital Workforce Agent Studio", () => {
  test("owner can open the hierarchy, walk the wizard, and run the executive team workflow", async ({
    page,
  }) => {
    await signIn(page, ownerPersona);
    await expect(page).toHaveURL(/\/digital-workforce/u);
    await expect(page.getByRole("heading", { name: "Digital Workforce" })).toBeVisible();
    await expect(visibleTestId(page, "workforce-hierarchy")).toBeVisible();
    await expect(visibleTestId(page, andrewExecutiveTestId)).toBeVisible();
    await expect(page.getByText("Owner Executive Business Partner").first()).toBeVisible();
    await expect(page.getByText("Digital Agent").first()).toBeVisible();
    await expect(
      page.getByText(/Scheduling system is not connected|paused/i).first(),
    ).toBeVisible();

    await visibleTestId(page, "workforce-tab-agents").click();
    await expect(visibleTestId(page, "workforce-wizard")).toBeVisible();
    await expect(visibleTestId(page, "workforce-wizard-continue")).toBeVisible();
    await page.getByLabel(/digital agent name/i).fill("Field Briefing Specialist");
    await page.getByLabel(/role title/i).fill("Specialist — Digital Agent");
    for (let step = 0; step < 6; step += 1) {
      await visibleTestId(page, "workforce-wizard-continue").click();
    }
    await expect(page.getByText(/step 7 of 7/i).first()).toBeVisible();
    await expect(visibleTestId(page, "workforce-wizard-publish")).toBeDisabled();
    await visibleTestId(page, "workforce-publish-confirm").check();
    await expect(visibleTestId(page, "workforce-wizard-publish")).toBeEnabled();

    await visibleTestId(page, "workforce-tab-active").click();
    await visibleTestId(page, "workforce-start-executive-run").click();
    await expect(visibleTestId(page, "workforce-run-trace")).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          page.getByTestId("workforce-step-lead-review").filter({ visible: true }).count(),
        {
          timeout: 60_000,
        },
      )
      .toBeGreaterThan(0);
    await expect(visibleTestId(page, "workforce-step-public-research")).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page
        .getByText(
          /assigned the lead review and public research in parallel|executive briefing is ready/i,
        )
        .first(),
    ).toBeVisible({
      timeout: 60_000,
    });
  });

  test("operations sees an audience-filtered organization", async ({ page }) => {
    await signIn(page, operationsPersona);
    await expect(page).toHaveURL(/\/digital-workforce/u);
    await expect(visibleTestId(page, "workforce-hierarchy")).toBeVisible();
    await expect(page.getByTestId(andrewExecutiveTestId)).toHaveCount(0);
    await expect(page.getByText("Owner Executive Business Partner")).toHaveCount(0);
    await expect(visibleTestId(page, projectReadinessTestId)).toBeVisible();
    await expect(page.getByText("Project Readiness Specialist").first()).toBeVisible();
    await expect(page.getByTestId("workforce-wizard")).toHaveCount(0);
  });

  test("integration administrator is denied Digital Workforce", async ({ page }) => {
    await signIn(page, integrationPersona);
    await expect(page).toHaveURL(/access-denied/u);
    await expect(visibleTestId(page, "access-denied")).toBeVisible();
  });
});
