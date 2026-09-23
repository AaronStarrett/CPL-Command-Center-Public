import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  inspectPublicationContent,
  privateProfileLiterals,
  publicationPathDecision,
  publicGuardSource,
  publicationGitBytes,
  publicationWorkingBytes,
  publicationPrivacyContext,
  PUBLIC_CHECKOUTS,
} from "../../scripts/publication-export.mjs";

test("publication allowlist retains application, migration, tests, and locked installation source", () => {
  for (const relative of [
    "apps/web/app/api/operations/reports/[id]/route.ts",
    "packages/database/migrations/0025_cpl_tenant_foundation.sql",
    "tests/integration/cpl-tenant-foundation.test.ts",
    "pnpm-lock.yaml",
    "apps/web/public/brand/cpl-logo.png",
    "scripts/git-hooks/pre-commit",
    "infra/docker/Dockerfile.web",
  ])
    assert.equal(publicationPathDecision(relative), "include", relative);
});

test("publication excludes private history, customer assets, historical reports, and runtime paths", () => {
  for (const relative of [
    ".git/config",
    ".git/objects/example",
    ".local-handoff/ORIGINAL_TAKEOVER_REQUIREMENTS.md",
    "docs/source/original/BEA_Automation_Idea.pdf",
    "apps/web/public/brand/BEALogo.png",
    "assets/brand/original/BEALogo.png",
    "docs/DECISIONS.md",
    "docs/PHASE_1_3_1_VERIFICATION.md",
    ".env.production",
    "apps/web/.next/server/app.js",
    "packages/database/node_modules/anything.js",
    "tests/screenshots/profile.png",
    "scripts/private.key",
    "packages/database/customer.sqlite",
    "scripts/../private.json",
    "/scripts/file.mjs",
    "scripts\\file.mjs",
  ])
    assert.notEqual(publicationPathDecision(relative), "include", relative);
});

test("publication includes reviewed product guides without exporting acceptance records or uploads", () => {
  for (const relative of [
    "OPEN-CPL-COMMAND-CENTER.md",
    "docs/PRODUCT_FEATURE_MAP.md",
    "docs/LOCAL_PHASE2_TESTING.md",
    "docs/LOCAL_PHASE3_TESTING.md",
    "docs/LOCAL_PHASE4_TESTING.md",
    "docs/DEFERRED_HOSTING.md",
  ])
    assert.equal(publicationPathDecision(relative), "include", relative);
  for (const relative of [
    "docs/PROJECT_STATE.md",
    "docs/PRODUCT_PHASE3_CHECKPOINTS.md",
    "docs/PUBLICATION_REVIEW.md",
    "docs/LOCAL_PHASE5_TESTING.md",
    ".data/evidence/original.png",
    ".data/local-development/credentials.dpapi",
    "product-phase4-20260923/acceptance.json",
    "packages/artifacts/generated/customer-report.pdf",
  ])
    assert.notEqual(publicationPathDecision(relative), "include", relative);
});

test("private content finding reveals only path and category", () => {
  const fixture =
    'professionalSummary: "Confidential synthetic profile statement", communicationPreferences: ["Private synthetic preference text"]';
  const literals = privateProfileLiterals(fixture);
  assert.equal(literals.length, 2);
  const findings = inspectPublicationContent("packages/example.ts", Buffer.from(fixture), literals);
  assert.deepEqual(findings, [{ path: "packages/example.ts", type: "private-profile-literal" }]);
  assert.equal(JSON.stringify(findings).includes(literals[0]), false);
  assert.deepEqual(
    inspectPublicationContent(
      "packages/example.ts",
      Buffer.from("export const empty = [];"),
      literals,
    ),
    [],
  );
});

test("publication finds OS-derived profile paths through slash and source escaping variants", () => {
  const context = publicationPrivacyContext({ homedir: "C:\\Users\\Synthetic Account" });
  for (const profile of [
    "C:/Users/Synthetic Account/Documents/private.txt",
    "c:\\users\\SYNTHETIC ACCOUNT\\Documents\\private.txt",
    String.raw`C:\\Users\\Synthetic Account\\Documents\\private.txt`,
    String.raw`C:\/Users\/Synthetic Account\/Documents\/private.txt`,
  ]) {
    const findings = inspectPublicationContent(
      "scripts/example.mjs",
      Buffer.from(profile),
      [],
      context,
    );
    assert.deepEqual(findings, [
      { path: "scripts/example.mjs", type: "machine-profile-path-literal" },
    ]);
    assert.equal(JSON.stringify(findings).includes("Synthetic Account"), false);
  }
  assert.deepEqual(
    inspectPublicationContent(
      "scripts/example.mjs",
      Buffer.from("C:/Users/Other Synthetic Account/Documents/example.txt"),
      [],
      context,
    ),
    [],
  );
  assert.throws(() => publicationPrivacyContext({}), /privacy context could not be established/u);
});

test("redirected child environment does not replace the OS privacy scan identity", () => {
  const expected = JSON.stringify(publicationPrivacyContext());
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = "D:/Synthetic verification home";
    process.env.USERPROFILE = "D:/Synthetic verification home";
    assert.equal(JSON.stringify(publicationPrivacyContext()) === expected, true);
  } finally {
    for (const key of ["HOME", "USERPROFILE"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("publication rejects concrete visualization sessions without exposing their identity", () => {
  const session = ["00000000", "0000", "4000", "8000", "000000000000"].join("-");
  const segments = [".codex", "visualizations", "2025", "01", "02", session, "artifact.html"];
  for (const separator of ["/", "\\", "\\\\"]) {
    const findings = inspectPublicationContent(
      "scripts/example.mjs",
      Buffer.from(segments.join(separator)),
    );
    assert.deepEqual(findings, [
      { path: "scripts/example.mjs", type: "machine-visualization-session-path" },
    ]);
    assert.equal(JSON.stringify(findings).includes(session), false);
  }
  assert.deepEqual(
    inspectPublicationContent(
      "docs/example.md",
      Buffer.from(".codex/visualizations/YYYY/MM/DD/<session>"),
    ),
    [],
  );
});

test("export rejects secret-shaped content and unexpected binary source", () => {
  const credential = ["gh", "p_", "x".repeat(40)].join("");
  assert.ok(
    inspectPublicationContent("scripts/config.mjs", Buffer.from(credential)).some(
      (entry) => entry.type === "github-token",
    ),
  );
  assert.ok(
    inspectPublicationContent("packages/example.ts", Buffer.from([0, 1, 2])).some(
      (entry) => entry.type === "unexpected-binary-content",
    ),
  );
});

test("known product images still scan embedded metadata for secrets and private profile text", () => {
  const asset = "apps/web/public/brand/cpl-logo.png";
  assert.deepEqual(inspectPublicationContent(asset, Buffer.from([0, 1, 2, 3])), []);
  const credential = ["gh", "p_", "x".repeat(40)].join("");
  const privateText = "Synthetic confidential metadata fixture";
  const findings = inspectPublicationContent(
    asset,
    Buffer.from("\0c2pa " + credential + " " + privateText),
    [privateText],
  );
  assert.deepEqual(findings.map((entry) => entry.type).sort(), [
    "github-token",
    "private-profile-literal",
  ]);
  assert.equal(JSON.stringify(findings).includes(privateText), false);
});

test("publication working bytes and Git index bytes follow the exported attributes", () => {
  const script = Buffer.from("line one\r\nline two\r\n");
  assert.equal(
    publicationWorkingBytes("scripts/tool.ps1", script).toString(),
    "line one\nline two\n",
  );
  const command = publicationWorkingBytes("Start-CPL.cmd", Buffer.from("@echo off\necho CPL\n"));
  assert.equal(command.toString(), "@echo off\r\necho CPL\r\n");
  assert.equal(publicationGitBytes("Start-CPL.cmd", command).toString(), "@echo off\necho CPL\n");
  assert.deepEqual(publicationWorkingBytes("Start-CPL.cmd", command), command);
  const image = Buffer.from([0, 13, 10, 255]);
  assert.strictEqual(publicationWorkingBytes("apps/web/public/brand/cpl-logo.png", image), image);
  assert.strictEqual(publicationGitBytes("apps/web/public/brand/cpl-logo.png", image), image);
});

test("public guard has independent identity and excludes all private origins", () => {
  const original = readFileSync(
    new URL("../../scripts/repository-boundary.mjs", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const generated = original.includes("export const REPOSITORY_ID = 1380072423;")
    ? original
    : publicGuardSource(original, 1380072423);
  assert.ok(generated.includes("export const REPOSITORY_ID = 1380072423;"));
  assert.ok(generated.includes('["CPL-Command-Center-Public"]'));
  assert.ok(generated.includes(PUBLIC_CHECKOUTS[0]));
  assert.ok(generated.includes(PUBLIC_CHECKOUTS[1]));
  assert.equal(generated.includes('"/workspace/BEA-Automation-Command-Center"'), false);
  assert.equal(generated.includes('"/workspace/CPL-Command-Center"'), false);
  assert.ok(generated.includes("validateRepositoryIdentity"));
  assert.ok(generated.includes("canonicalize(markerPath)"));
  assert.throws(
    () => publicGuardSource("unexpected guard", 1380072423),
    /source contract changed/u,
  );
});
