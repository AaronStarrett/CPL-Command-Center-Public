import { expect, test, type Page } from "@playwright/test";

const ownerPersona = "Workspace Owner — Chief Executive Officer";
const operationsPersona = "Operations Coordinator — Operations";
const operationsBPersona = "Operations Coordinator B — Operations";
const salesPersona = "Sales Specialist — Sales";
const executivePersona = "Executive Viewer — Read-only Executive";
const integrationPersona = "Integration Administrator — Integration Administrator";

function visibleText(page: Page, pattern: string | RegExp) {
  return page.getByText(pattern).filter({ visible: true }).first();
}

function inMain(page: Page, testId: string) {
  return page.getByRole("main").getByTestId(testId);
}

async function signIn(page: Page, personaLabel: string, returnTo = "/work") {
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

test.describe("@phase32a-work Operational work control plane", () => {
  test("operations A can claim, release, and operations B can claim the role-queue item", async ({
    page,
  }) => {
    await signIn(page, operationsPersona, "/work/queues");
    await expect(page.getByRole("heading", { name: "Team queues" })).toBeVisible();
    await page.getByRole("link", { name: "BEA-WK-000001" }).click();
    await expect(inMain(page, "work-item-detail")).toBeVisible();
    await inMain(page, "work-claim").click();
    await expect(inMain(page, "work-item-detail")).toBeVisible();
    await expect(page.getByText("Unclaimed")).toHaveCount(0);
    await inMain(page, "work-release").click();
    await expect(page.getByText("Unclaimed")).toBeVisible();
    await page.getByTestId("account-menu").locator("summary").click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await signIn(page, operationsBPersona, "/work/queues");
    await page.getByRole("link", { name: "BEA-WK-000001" }).click();
    await inMain(page, "work-claim").click();
    await expect(inMain(page, "work-action-error")).toHaveCount(0);
    await expect(page.getByText("Unclaimed")).toHaveCount(0);
    await page.goto("/work/queues");
    await page.getByRole("link", { name: "BEA-WK-000002" }).click();
    await expect(page.getByRole("heading", { name: "Authorize report delivery" })).toBeVisible();
    await expect(inMain(page, "owner-only-work")).toBeVisible();
    await inMain(page, "work-claim").click();
    await expect(inMain(page, "work-action-error")).toBeVisible();
  });

  test("owner sees delivery authorization and the protected report path", async ({ page }) => {
    await signIn(page, ownerPersona, "/work/queues");
    await page.getByRole("link", { name: "BEA-WK-000002" }).click();
    await expect(page.getByRole("heading", { name: "Authorize report delivery" })).toBeVisible();
    await expect(inMain(page, "owner-only-work")).toBeVisible();
    await expect(inMain(page, "owner-only-work")).toContainText(/reports\.deliver/i);
    await expect(inMain(page, "work-required-action")).toContainText(
      /Authorize delivery through the Owner-only reports\.deliver command|Authorize report delivery/i,
    );
    await page.getByRole("link", { name: "Open protected domain record" }).click();
    await expect(page.getByRole("heading", { name: /BEA-RP-000101/u })).toBeVisible();
  });

  test("escalated synthetic work appears in At Risk", async ({ page }) => {
    await signIn(page, ownerPersona, "/work/at-risk");
    await expect(page.getByRole("heading", { name: "At risk", exact: true })).toBeVisible();
    await expect(
      inMain(page, "work-breached").getByRole("link", { name: "BEA-WK-000003" }),
    ).toBeVisible();
  });

  test("notification manifests state that no email or Teams message was sent", async ({ page }) => {
    await signIn(page, operationsPersona, "/work/notifications");
    await expect(inMain(page, "work-email-dry-run")).toContainText(
      "EMAIL DRY-RUN — NO MESSAGE SENT",
    );
    await expect(inMain(page, "work-teams-dry-run")).toContainText(
      "TEAMS DRY-RUN — NO MESSAGE POSTED",
    );
    await expect(visibleText(page, /example\.invalid/i)).toBeVisible();
  });

  test("executive can view work but cannot mutate", async ({ page }) => {
    await signIn(page, executivePersona, "/work");
    await expect(page.getByRole("heading", { name: "My Work" })).toBeVisible();
    await page.goto("/work/queues");
    await page.getByRole("link", { name: "BEA-WK-000001" }).click();
    await expect(inMain(page, "work-item-detail")).toBeVisible();
    await expect(inMain(page, "work-claim")).toHaveCount(0);
    const response = await page.request.post("/api/work", {
      data: {
        action: "claim",
        workItemId: "d2000000-0000-4000-8000-000000000001",
        expectedVersion: 1,
      },
    });
    expect(response.status()).toBe(403);
  });

  test("integration administrator can see automation-failure work and projection failures", async ({
    page,
  }) => {
    await signIn(page, integrationPersona, "/work/queues");
    await page.getByRole("link", { name: "BEA-WK-000004" }).click();
    await expect(
      page.getByRole("heading", { name: "Resolve automation dead letter" }),
    ).toBeVisible();
    await page.goto("/work/scheduler");
    await expect(inMain(page, "work-projection-failures")).toBeVisible();
    await expect(inMain(page, "work-code-defined-policy")).toBeVisible();
  });

  test("sales is denied operational work queues", async ({ page }) => {
    await signIn(page, salesPersona, "/work");
    await expect(page.getByRole("heading", { name: "My Work", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "BEA-WK-000001" })).toHaveCount(0);
    await page.goto("/work/queues");
    await expect(page.getByRole("heading", { name: "Team queues", exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Inspection readiness", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Technical review", exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("heading", { name: "Delivery authorization", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Automation failures", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "BEA-WK-000001" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "BEA-WK-000002" })).toHaveCount(0);
    const technical = await page.request.get("/api/work/d2000000-0000-4000-8000-000000000001");
    expect([403, 404]).toContain(technical.status());
    await page.goto("/work/d2000000-0000-4000-8000-000000000001");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await page.goto("/work/scheduler");
    await expect(page).toHaveURL(/access-denied/u);
    await page.goto("/work/notifications");
    await expect(page).toHaveURL(/access-denied/u);
  });
});
