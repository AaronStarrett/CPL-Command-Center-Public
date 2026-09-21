import { expect, test, type Page } from "@playwright/test";

const ownerPersona = "Workspace Owner — Chief Executive Officer";
const salesPersona = "Sales Specialist — Sales";
const integrationPersona = "Integration Administrator — Integration Administrator";

function visibleTestId(page: Page, testId: string) {
  return page.getByTestId(testId).filter({ visible: true }).first();
}

function visibleText(page: Page, pattern: string | RegExp) {
  return page.getByText(pattern).filter({ visible: true }).first();
}

async function signIn(page: Page, personaLabel: string, returnTo = "/operations") {
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

async function openInspection(page: Page, reference: string) {
  await page.getByRole("main").getByRole("link", { name: reference }).click();
  await expect(page.getByRole("heading", { name: reference })).toBeVisible();
}

async function technicallyApproveThenAuthorizeDelivery(page: Page) {
  await page.getByRole("button", { name: "Approve technical content" }).click();
  await expect(page.getByText(/Ready for delivery/i).first()).toBeVisible();
  await expect(visibleTestId(page, "ready-for-delivery-gate")).toContainText(
    "Client delivery has not been authorized",
  );
  await expect(visibleTestId(page, "report-deliveries")).toContainText("No delivery attempts yet");
  await page.getByRole("button", { name: "Authorize client delivery" }).click();
  await expect(visibleTestId(page, "report-deliveries")).toContainText("delivered");
}

test.describe("@phase30-operations Inspection-to-report automation core", () => {
  test("owner can complete the synthetic happy path to delivered", async ({ page }) => {
    await signIn(page, ownerPersona);
    await expect(page).toHaveURL(/\/operations/u);
    await expect(page.getByRole("heading", { name: "Turnaround board" })).toBeVisible();
    await expect(page.getByText(/SYNTHETIC FIXTURE/i).first()).toBeVisible();
    await openInspection(page, "BEA-IN-000001");
    await page.getByRole("button", { name: "Submit complete synthetic package" }).click();
    const reportLink = page.getByRole("main").getByRole("link", { name: /BEA-RP-/u });
    await expect(reportLink).toBeVisible();
    await reportLink.click();
    await expect(page.getByRole("heading", { name: /BEA-RP-/u })).toBeVisible();
    await expect(page.getByText(/SYNTHETIC FIXTURE/i).first()).toBeVisible();
    await technicallyApproveThenAuthorizeDelivery(page);
    await expect(visibleTestId(page, "report-turnaround")).toBeVisible();
    await expect(visibleTestId(page, "north-star-turnaround")).not.toHaveText(/\d+d\b/u);
    await expect(visibleTestId(page, "stage-durations")).toContainText(
      "Inspection completed → submission received",
    );
    await expect(visibleTestId(page, "stage-durations")).toContainText(
      "Delivery authorized → confirmed delivery",
    );
  });

  test("incomplete submission blocks delivery until correction and revision waits", async ({
    page,
  }) => {
    await signIn(page, ownerPersona, "/inspections");
    await openInspection(page, "BEA-IN-000002");
    await page.getByRole("button", { name: "Submit incomplete package" }).click();
    await expect(
      page.getByText(/Failed|Incomplete synthetic package submitted/i).first(),
    ).toBeVisible();
    await expect(visibleTestId(page, "inspection-age")).toBeVisible();
    await expect(page.getByText(/Paused duration/i).first()).toBeVisible();
    await expect(visibleTestId(page, "inspection-blocker-owner")).toContainText(
      "Operations Coordinator",
    );
    await page.goto("/exceptions");
    await expect(page.getByText(/SYNTHETIC FIXTURE/i).first()).toBeVisible();
    await expect(visibleTestId(page, "exception-queue")).toContainText("incomplete");
    await expect(visibleTestId(page, "exception-queue")).toContainText("Operations Coordinator");
    await page.getByRole("link", { name: "Open inspection" }).first().click();
    await page.getByRole("button", { name: "Submit complete synthetic package" }).click();
    const reportLink = page.getByRole("main").getByRole("link", { name: /BEA-RP-/u });
    await expect(reportLink).toBeVisible();
    await reportLink.click();
    await expect(page.getByRole("heading", { name: /BEA-RP-/u })).toBeVisible();
    await expect(visibleTestId(page, "report-current-version")).toContainText(/report version 1/i);
    await expect(visibleText(page, /report version 1/i)).toBeVisible();
    await page.getByLabel("Review comment").fill("Revise the envelope finding narrative.");
    await page.getByRole("button", { name: "Request revision" }).click();
    await expect(visibleText(page, /Revision required/i)).toBeVisible();
    await expect(visibleTestId(page, "report-current-version")).toContainText(/report version 1/i);
    await expect(page.getByRole("button", { name: "Authorize client delivery" })).toHaveCount(0);
    await page.getByRole("link", { name: /BEA-IN-000002/u }).click();
    await page.getByRole("button", { name: "Submit complete synthetic package" }).click();
    const revisedReport = page.getByRole("main").getByRole("link", { name: /BEA-RP-/u });
    await expect(revisedReport).toBeVisible();
    await revisedReport.click();
    await expect(visibleTestId(page, "report-current-version")).toContainText(/report version 2/i);
    await expect(visibleText(page, /report version 2/i)).toBeVisible();
    await technicallyApproveThenAuthorizeDelivery(page);
    await expect(visibleTestId(page, "report-deliveries")).toContainText("delivered");
  });

  test("sales cannot approve and integration-admin cannot open the board", async ({ browser }) => {
    const salesPage = await browser.newPage();
    await signIn(salesPage, salesPersona, "/operations");
    await expect(salesPage.getByRole("heading", { name: "Turnaround board" })).toBeVisible();
    await openInspection(salesPage, "BEA-IN-000001");
    await expect(
      salesPage.getByRole("button", { name: "Submit complete synthetic package" }),
    ).toHaveCount(0);
    await expect(salesPage.getByRole("button", { name: "Approve technical content" })).toHaveCount(
      0,
    );

    const integrationPage = await browser.newPage();
    await signIn(integrationPage, integrationPersona, "/operations");
    await expect(integrationPage).toHaveURL(/access-denied/u);
    await salesPage.close();
    await integrationPage.close();
  });
});
