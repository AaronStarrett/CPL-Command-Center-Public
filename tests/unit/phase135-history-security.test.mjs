import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanReachableHistory } from "../../scripts/history-secret-scan.mjs";
import { inspectRepositoryHealth } from "../../scripts/repository-health.mjs";
import { findProhibitedRepositoryPaths } from "../../scripts/repository-data-policy.mjs";
import { detectSecretTypes } from "../../scripts/secret-scan.mjs";
import { verifyPublicIndex } from "../../scripts/publication-export.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

describe("Phase 1.3.5 history and repository health", () => {
  it("finds no secret or prohibited runtime path in reachable history", () => {
    const result = scanReachableHistory(repositoryRoot);
    if (
      existsSync(path.join(repositoryRoot, "PUBLIC_EXPORT_MANIFEST.json")) &&
      result.commitsScanned === 0
    ) {
      const initial = verifyPublicIndex(repositoryRoot);
      expect(initial.ok).toBe(true);
      expect(initial.stagedFiles).toBeGreaterThan(0);
      expect(initial.initialHistory).toBe("EMPTY_WITH_REVIEWED_INDEX");
    } else {
      expect(result.commitsScanned).toBeGreaterThan(0);
      expect(result.blobsScanned).toBeGreaterThan(0);
    }
    expect(result.findings).toEqual([]);
    expect(result.prohibitedPaths).toEqual([]);
  }, 60_000);

  it("keeps tracked blobs below the large-object threshold", () => {
    const result = inspectRepositoryHealth(repositoryRoot);
    expect(result.ok).toBe(true);
    expect(result.blobsAtLeast10MiB).toBe(0);
    if (existsSync(path.join(repositoryRoot, "PUBLIC_EXPORT_MANIFEST.json"))) {
      expect(result.blobsAtLeast1MiB).toBeLessThanOrEqual(1);
      expect(result.largestBlobs.some((blob) => blob.path.startsWith("docs/source/"))).toBe(false);
    } else {
      expect(result.blobsAtLeast1MiB).toBe(1);
      expect(result.largestBlobs[0]?.path).toBe("docs/source/original/BEA_Automation_Idea.pdf");
    }
  });

  it("classifies prohibited runtime and credential paths independently of contents", () => {
    expect(
      findProhibitedRepositoryPaths([
        ".env.production",
        "runtime/process.pid",
        "certificates/owner.pfx",
        "app.log",
        "build/app.js",
        "reports/report.html",
        "backup.zip",
        "config/production.json",
        "screenshots/generated.png",
        "toolchain/archive.zip",
        ".npmrc",
        ".npmrc.example",
        "safe/source.ts",
        "apps/web/app/(authenticated)/reports/page.tsx",
        "apps/web/app/api/operations/reports/[id]/route.ts",
        "tests/unit/phase21-audio-locked-narration.test.ts",
        "captured-audio.bin",
      ]),
    ).toEqual([
      ".env.production",
      "app.log",
      "backup.zip",
      "build/app.js",
      "captured-audio.bin",
      "certificates/owner.pfx",
      "config/production.json",
      "reports/report.html",
      "runtime/process.pid",
      "screenshots/generated.png",
      "toolchain/archive.zip",
    ]);
  });

  it("detects high-confidence cloud, database, npm, and personal-data shapes", () => {
    const strong = ["Aa", "7+", "z".repeat(28)].join("");
    const npm = ["npm", "_", "A".repeat(28)].join("");
    const google = ["AI", "za", "B".repeat(32)].join("");
    const values = [
      `SESSION_SECRET=${strong}`,
      ["postgres", "ql://bea:", strong, "@db.internal.corp/bea"].join(""),
      `//registry.npmjs.org/:_authToken=${npm}`,
      google,
      ["123", "45", "6789"].join("-"),
    ].join("\n");
    expect(detectSecretTypes(values).sort()).toEqual([
      "google-api-key",
      "named-production-secret",
      "npm-auth-token",
      "postgresql-credential-url",
      "us-social-security-number",
    ]);
  });

  it("scans annotated tags and every historical path alias", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bea-phase135-history-"));
    const git = (...arguments_) =>
      execFileSync("git", ["-c", "safe.directory=" + root.replaceAll("\\", "/"), ...arguments_], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "BEA Test");
      git("config", "user.email", "bea-test@example.invalid");
      const syntheticToken = ["gh", "p_", "A".repeat(32)].join("");
      writeFileSync(path.join(root, "safe.txt"), syntheticToken + "\n");
      writeFileSync(path.join(root, "z-runtime.pid"), syntheticToken + "\n");
      mkdirSync(path.join(root, "nested dir"));
      writeFileSync(path.join(root, "nested dir", "utf8-é.txt"), syntheticToken + "\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      git("tag", "-a", "v-test", "-m", syntheticToken);
      renameSync(path.join(root, "safe.txt"), path.join(root, "renamed.txt"));
      git("add", ".");
      git("commit", "-m", syntheticToken);
      git("checkout", "-b", "reflog-fixture");
      writeFileSync(path.join(root, "reflog-only.txt"), "safe fixture\n");
      git("add", ".");
      git("commit", "-m", "reflog-only fixture");
      git("checkout", "main");
      git("branch", "-D", "reflog-fixture");

      const result = scanReachableHistory(root);
      expect(result.prohibitedPaths).toContain("z-runtime.pid");
      const commits = git("rev-list", "--all", "--reflog").trim().split(/\r?\n/u);
      const gitPaths = commits.flatMap((commit) =>
        git("ls-tree", "-r", "-z", "--name-only", commit).split("\0").filter(Boolean),
      );
      expect(result.historicalPaths).toEqual([...new Set(gitPaths)].sort());
      expect(result.historicalPaths).toEqual([
        "nested dir/utf8-é.txt",
        "reflog-only.txt",
        "renamed.txt",
        "safe.txt",
        "z-runtime.pid",
      ]);
      expect(result.commitsScanned).toBe(3);
      expect(result.annotatedTagsScanned).toBe(1);
      expect(
        result.findings.some((finding) => finding.commit && finding.type === "github-token"),
      ).toBe(true);
      expect(
        result.findings.some(
          (finding) =>
            finding.type === "github-token" &&
            finding.paths?.includes("safe.txt") &&
            finding.paths?.includes("z-runtime.pid"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
