import { expect, test, type Locator, type Page } from "@playwright/test";

const ownerPersona = "Workspace Owner — Chief Executive Officer";
const salesPersona = "Sales Specialist — Sales";
const executivePersona = "Executive Viewer — Read-only Executive";
const integrationPersona = "Integration Administrator — Integration Administrator";
const READY_LEAD = "a1000000-0000-4000-8000-000000000003";
const MOISTURE_LEAD = "a1000000-0000-4000-8000-000000000005";
const MOISTURE_CATALOG = "e1100000-0000-4000-8000-000000000002";
const MOISTURE_LINE_KEY = "syn-moi-probe-unit";
const MOISTURE_CATALOG_RATE_MINOR = 450;
const MOISTURE_OVERRIDE_MINOR = 500;
const TECHNICAL_WORK_ID = "d2000000-0000-4000-8000-000000000001";

function visibleShell(page: Page): Locator {
  return page.locator(".bea-application-shell").filter({ visible: true });
}

async function waitForVisibleShell(page: Page): Promise<Locator> {
  const shell = visibleShell(page);
  await expect(shell).toHaveCount(1);
  return shell;
}

function inMain(page: Page, testId: string) {
  return visibleShell(page).getByRole("main").getByTestId(testId);
}

function accountMenu(page: Page) {
  return visibleShell(page).getByTestId("account-menu");
}

async function signIn(page: Page, personaLabel: string, returnTo = "/leads") {
  await page.goto(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  const persona = page.getByRole("combobox", { name: "Demo persona" });
  if ((await persona.count()) === 0) {
    await accountMenu(page).locator("summary").click();
    await accountMenu(page).getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("combobox", { name: "Demo persona" })).toBeVisible();
  }
  await page.getByRole("combobox", { name: "Demo persona" }).selectOption({ label: personaLabel });
  await page.getByRole("button", { name: "Sign in to Command Center" }).click();
  await waitForVisibleShell(page);
}

async function signOut(page: Page) {
  await accountMenu(page).locator("summary").click();
  await accountMenu(page).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("combobox", { name: "Demo persona" })).toBeVisible();
}

type ProposalDetail = {
  record?: {
    lines?: Array<{
      lineKey?: string;
      unitAmountMinor?: number;
      catalogUnitAmountMinor?: number;
      overrideId?: string | null;
    }>;
    versions?: Array<{
      id?: string;
      renderedChecksum?: string;
      fileName?: string;
      versionNumber?: number;
      totalMinor?: number;
    }>;
    manifests?: Array<{ attachmentChecksum?: string; attachmentFileName?: string }>;
    proposal?: { informationCycleNumber?: number; totalMinor?: number; version?: number };
    overrides?: Array<{ id?: string; status?: string }>;
  };
  workItems?: Array<{
    id?: string;
    workItemKind?: string;
    cycleIdentity?: string;
    status?: string;
  }>;
};

async function loadProposal(page: Page, proposalId: string): Promise<ProposalDetail> {
  return (await page.request
    .get(`/api/proposals/${proposalId}`)
    .then((response) => response.json())) as ProposalDetail;
}

test.describe
  .serial("@phase33a-proposals Configurable service catalog and proposal builder", () => {
  let envelopeProposalId = "";
  let moistureProposalId = "";

  test("sales claims and releases assigned proposal-preparation work", async ({ page }) => {
    await signIn(page, salesPersona, "/work/f2000000-0000-4000-8000-000000000001");
    await expect(page.getByRole("heading", { name: "Prepare proposal" })).toBeVisible();
    await expect(inMain(page, "work-item-detail")).toBeVisible();
    await inMain(page, "work-claim").click();
    await expect(page.getByText("Unclaimed")).toHaveCount(0);
    await inMain(page, "work-release").click();
    await expect(page.getByText("Unclaimed")).toBeVisible();
    await page.getByRole("link", { name: "Open protected domain record" }).click();
    await expect(visibleShell(page).getByText("BEA-LD-000003", { exact: true })).toBeVisible();
  });

  test("sales creates a proposal from a ready lead and submits for review", async ({ page }) => {
    await signIn(page, salesPersona, `/leads/${READY_LEAD}`);
    await expect(visibleShell(page).getByText("BEA-LD-000003", { exact: true })).toBeVisible();
    await inMain(page, "create-proposal").click();
    await expect(page).toHaveURL(/\/proposals\/[0-9a-f-]{36}/u);
    await waitForVisibleShell(page);
    envelopeProposalId = page.url().split("/proposals/")[1]?.split("?")[0] ?? "";
    expect(envelopeProposalId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(inMain(page, "proposal-builder")).toBeVisible();
    await inMain(page, "proposal-service-syn-env-fixed-advisory").check();
    await inMain(page, "proposal-scope").fill(
      "Synthetic laboratory scope of services for Phase 3.3A Playwright.",
    );
    await inMain(page, "proposal-save-draft").click();
    await expect(page.getByText("Ready for review")).toBeVisible();
    await inMain(page, "proposal-submit").click();
    await expect(page.getByText("In review")).toBeVisible();
    await expect(inMain(page, "proposal-versions")).toContainText("Version 1");
  });

  test("sales cannot approve a proposal", async ({ page }) => {
    await signIn(page, salesPersona, `/proposals/${envelopeProposalId}`);
    await expect(inMain(page, "proposal-detail")).toBeVisible();
    await expect(inMain(page, "proposal-approve")).toHaveCount(0);
    const response = await page.request.post(`/api/proposals/${envelopeProposalId}`, {
      data: {
        action: "review",
        expectedVersion: 1,
        proposalVersionId: "00000000-0000-4000-8000-000000000099",
        decision: "approve",
      },
    });
    expect(response.status()).toBe(403);
  });

  test("integration administrator cannot commercially approve", async ({ page }) => {
    await signIn(page, integrationPersona, `/proposals/${envelopeProposalId}`);
    await expect(inMain(page, "proposal-detail")).toBeVisible();
    await expect(inMain(page, "proposal-approve")).toHaveCount(0);
    const response = await page.request.post(`/api/proposals/${envelopeProposalId}`, {
      data: {
        action: "review",
        expectedVersion: 1,
        proposalVersionId: "00000000-0000-4000-8000-000000000099",
        decision: "approve",
      },
    });
    expect(response.status()).toBe(403);
  });

  test("executive cannot mutate a proposal", async ({ page }) => {
    await signIn(page, executivePersona, `/proposals/${envelopeProposalId}`);
    await expect(inMain(page, "proposal-detail")).toBeVisible();
    await expect(inMain(page, "proposal-submit")).toHaveCount(0);
    await expect(inMain(page, "proposal-approve")).toHaveCount(0);
    const response = await page.request.post(`/api/proposals/${envelopeProposalId}`, {
      data: {
        action: "update-draft",
        expectedVersion: 1,
        scopeText: "Executive mutation attempt",
      },
    });
    expect(response.status()).toBe(403);
    const overrideDenied = await page.request.post(`/api/proposals/${envelopeProposalId}`, {
      data: {
        action: "decide-override",
        expectedVersion: 1,
        overrideId: "00000000-0000-4000-8000-000000000099",
        approve: true,
      },
    });
    expect(overrideDenied.status()).toBe(403);
  });

  test("owner reviews and approves the exact Version 1", async ({ page }) => {
    await signIn(page, ownerPersona, `/proposals/${envelopeProposalId}`);
    await expect(inMain(page, "proposal-detail")).toBeVisible();
    await inMain(page, "proposal-approve").click();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  });

  test("sales generates the no-send manifest for the frozen approved artifact", async ({
    page,
  }) => {
    await signIn(page, salesPersona, `/proposals/${envelopeProposalId}`);
    await expect(inMain(page, "proposal-detail")).toBeVisible();
    await expect(inMain(page, "proposal-approve")).toHaveCount(0);
    await inMain(page, "delivery-manifest").click();
    await expect(inMain(page, "proposal-no-send")).toContainText(
      "PROPOSAL EMAIL DRY-RUN — NO MESSAGE SENT",
    );
    await expect(inMain(page, "delivery-manifest-result")).toContainText("liveWrites");
    await expect(inMain(page, "delivery-manifest-result")).toContainText("false");
    await expect(page.getByText("Ready for delivery")).toBeVisible();
    const detail = await loadProposal(page, envelopeProposalId);
    const version = detail.record?.versions?.find((item) => item.versionNumber === 1);
    expect(version?.renderedChecksum).toBeTruthy();
    const preview = (await page.request
      .post(`/api/proposals/${envelopeProposalId}`, {
        data: { action: "preview", proposalVersionId: version?.id },
      })
      .then((response) => response.json())) as {
      checksumSha256?: string;
      previewKind?: string;
      document?: { previewKind?: string };
    };
    expect(preview.previewKind).toBe("approved");
    expect(preview.document?.previewKind).toBe("frozen_review");
    expect(preview.checksumSha256).toBe(version?.renderedChecksum);
    expect(detail.record?.manifests?.[0]?.attachmentChecksum).toBe(version?.renderedChecksum);
    expect(detail.record?.manifests?.[0]?.attachmentFileName).toBe(version?.fileName);
  });

  test("revision produces a new immutable version without inheriting the prior override", async ({
    page,
  }) => {
    await signIn(page, salesPersona, `/leads/${MOISTURE_LEAD}`);
    await expect(visibleShell(page).getByText("BEA-LD-000005", { exact: true })).toBeVisible();
    await inMain(page, "create-proposal-catalog").selectOption(MOISTURE_CATALOG);
    await inMain(page, "create-proposal").click();
    await expect(page).toHaveURL(/\/proposals\/[0-9a-f-]{36}/u);
    await waitForVisibleShell(page);
    moistureProposalId = page.url().split("/proposals/")[1]?.split("?")[0] ?? "";
    await expect(inMain(page, "proposal-builder")).toBeVisible();
    await inMain(page, "proposal-service-syn-moi-probe-unit").check();
    await inMain(page, "proposal-scope").fill(
      "Synthetic moisture investigation scope for Phase 3.3A revision.",
    );
    await inMain(page, "proposal-save-draft").click();
    await expect(page.getByText("Ready for review")).toBeVisible();
    const drafted = await loadProposal(page, moistureProposalId);
    const overrideRequest = await page.request.post(`/api/proposals/${moistureProposalId}`, {
      data: {
        action: "request-override",
        expectedVersion: drafted.record?.proposal?.version,
        lineKey: MOISTURE_LINE_KEY,
        proposedAmountMinor: MOISTURE_OVERRIDE_MINOR,
        reason: "Playwright version-bound override for Version 1 only.",
      },
    });
    expect(overrideRequest.ok()).toBe(true);
    const pendingAsSales = await loadProposal(page, moistureProposalId);
    const salesOverrideId = pendingAsSales.record?.overrides?.find(
      (item) => item.status === "requested",
    )?.id;
    expect(salesOverrideId).toBeTruthy();
    const salesDenied = await page.request.post(`/api/proposals/${moistureProposalId}`, {
      data: {
        action: "decide-override",
        expectedVersion: pendingAsSales.record?.proposal?.version,
        overrideId: salesOverrideId,
        approve: true,
      },
    });
    expect(salesDenied.status()).toBe(403);
    await expect(inMain(page, `proposal-approve-override-${salesOverrideId}`)).toHaveCount(0);
    await signOut(page);
    await signIn(page, ownerPersona, `/proposals/${moistureProposalId}`);
    const pending = await loadProposal(page, moistureProposalId);
    const overrideId = pending.record?.overrides?.find((item) => item.status === "requested")?.id;
    expect(overrideId).toBeTruthy();
    await expect(inMain(page, `proposal-approve-override-${overrideId}`)).toBeVisible();
    const overrideDecision = await page.request.post(`/api/proposals/${moistureProposalId}`, {
      data: {
        action: "decide-override",
        expectedVersion: pending.record?.proposal?.version,
        overrideId,
        approve: true,
      },
    });
    expect(overrideDecision.ok()).toBe(true);
    await page.goto(`/proposals/${moistureProposalId}`);
    await waitForVisibleShell(page);
    await expect(inMain(page, "proposal-overrides")).toContainText("approved");
    await signOut(page);
    await signIn(page, salesPersona, `/proposals/${moistureProposalId}`);
    const overridden = await loadProposal(page, moistureProposalId);
    const overriddenLine = overridden.record?.lines?.find(
      (item) => item.lineKey === MOISTURE_LINE_KEY,
    );
    expect(overriddenLine?.unitAmountMinor).toBe(MOISTURE_OVERRIDE_MINOR);
    await inMain(page, "proposal-submit").click();
    await expect(page.getByText("In review")).toBeVisible();
    await signOut(page);
    await signIn(page, ownerPersona, `/proposals/${moistureProposalId}`);
    await inMain(page, "proposal-request-revision").click();
    await expect(page.getByText("Revision required")).toBeVisible();
    await signOut(page);
    await signIn(page, salesPersona, `/proposals/${moistureProposalId}`);
    await inMain(page, "proposal-scope").fill(
      "Revised synthetic moisture investigation scope after Owner comments.",
    );
    await inMain(page, "proposal-save-draft").click();
    await expect(page.getByText("Ready for review")).toBeVisible();
    const revised = await loadProposal(page, moistureProposalId);
    const revisedLine = revised.record?.lines?.find((item) => item.lineKey === MOISTURE_LINE_KEY);
    expect(revisedLine?.unitAmountMinor).toBe(MOISTURE_CATALOG_RATE_MINOR);
    expect(revisedLine?.catalogUnitAmountMinor).toBe(MOISTURE_CATALOG_RATE_MINOR);
    expect(revisedLine?.overrideId ?? null).toBeNull();
    await inMain(page, "proposal-submit").click();
    await expect(page.getByText("In review")).toBeVisible();
    await expect(inMain(page, "proposal-versions")).toContainText("Version 2");
    const frozen = await loadProposal(page, moistureProposalId);
    const version1 = frozen.record?.versions?.find((item) => item.versionNumber === 1);
    const version2 = frozen.record?.versions?.find((item) => item.versionNumber === 2);
    expect(version1?.totalMinor).toBe(MOISTURE_OVERRIDE_MINOR);
    expect(version2?.totalMinor).toBe(MOISTURE_CATALOG_RATE_MINOR);
  });

  test("sales sees commercial work queues and cannot open technical work", async ({ page }) => {
    await signIn(page, salesPersona, "/work/queues");
    const queues = visibleShell(page);
    await expect(queues.getByTestId("work-queue-section-proposal.preparation")).toBeVisible();
    await expect(queues.getByTestId("work-queue-section-proposal.information")).toBeVisible();
    await expect(queues.getByTestId("work-queue-section-proposal.revision")).toBeVisible();
    await expect(
      queues.getByTestId("work-queue-section-proposal.delivery-preparation"),
    ).toBeVisible();
    await expect(
      queues.getByRole("heading", { name: "Proposal preparation", exact: true }),
    ).toHaveCount(1);
    await expect(
      queues.getByRole("heading", { name: "Proposal information", exact: true }),
    ).toHaveCount(1);
    await expect(
      queues.getByRole("heading", { name: "Proposal revision", exact: true }),
    ).toHaveCount(1);
    await expect(
      queues.getByRole("heading", { name: "Proposal delivery preparation", exact: true }),
    ).toHaveCount(1);
    await expect(
      queues.getByRole("heading", { name: "Inspection readiness", exact: true }),
    ).toHaveCount(0);
    await expect(
      queues.getByRole("heading", { name: "Technical review", exact: true }),
    ).toHaveCount(0);
    await expect(queues.getByRole("heading", { name: "Proposal review", exact: true })).toHaveCount(
      0,
    );
    await expect(
      queues.getByRole("heading", { name: "Pricing override", exact: true }),
    ).toHaveCount(0);
    const technical = await page.request.get("/api/work?view=my");
    expect(technical.ok()).toBe(true);
    const body = (await technical.json()) as {
      items?: Array<{ id?: string; workItemKind?: string }>;
    };
    expect(
      body.items?.every((item) =>
        [
          "proposal_preparation",
          "proposal_information",
          "proposal_revision",
          "proposal_delivery_preparation",
        ].includes(item.workItemKind ?? ""),
      ),
    ).toBe(true);
    await signOut(page);
    await signIn(page, ownerPersona, "/work/queues");
    const ownerList = (await page.request
      .get("/api/work?view=my")
      .then((response) => response.json())) as {
      items?: Array<{ id?: string; workItemKind?: string }>;
    };
    const hidden = ownerList.items?.find(
      (item) =>
        item.workItemKind === "inspection_readiness" ||
        item.workItemKind === "proposal_review" ||
        item.workItemKind === "report_technical_review",
    );
    await signOut(page);
    await signIn(page, salesPersona, "/work");
    const hiddenId = hidden?.id ?? TECHNICAL_WORK_ID;
    const response = await page.request.get(`/api/work/${hiddenId}`);
    expect([403, 404]).toContain(response.status());
    await page.goto(`/work/${TECHNICAL_WORK_ID}`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  test("production catalog remains UNCONFIGURED", async ({ page }) => {
    await signIn(page, ownerPersona, "/configuration/catalog");
    await expect(page.getByText(/UNCONFIGURED/u).first()).toBeVisible();
    await expect(page.getByText(/Production catalog/u).first()).toBeVisible();
  });
});
