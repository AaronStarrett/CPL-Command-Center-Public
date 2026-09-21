import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectSecretTypes,
  listGitVisibleFiles,
  scanRepository,
} from "../../scripts/secret-scan.mjs";

const cleanupDirectories = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0).reverse()) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fakeProjectKey(character = "a") {
  return ["s", "k", "-", "p", "r", "o", "j", "-", character.repeat(48)].join("");
}

function git(root, ...args) {
  const result = spawnSync("git", ["-c", "safe.directory=" + root.replaceAll("\\", "/"), ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

describe("Git-aware secret scanner", () => {
  it("detects modern OpenAI key forms while returning only safe finding labels", () => {
    const key = fakeProjectKey();
    const types = detectSecretTypes(`OPENAI_API_KEY=${key}`);

    expect(types).toContain("openai-project-api-key");
    expect(JSON.stringify(types)).not.toContain(key);
  });

  it("does not treat a sequential-alphabet OpenAI-shaped fixture as a secret", () => {
    const alphabetFixture = ["s", "k", "-", "abcdefghijklmnopqrstuvwxyz"].join("");
    const mixedEntropyKey = ["s", "k", "-", "Aa7_".repeat(10)].join("");

    expect(detectSecretTypes(`persona ${alphabetFixture}`)).toEqual([]);
    expect(detectSecretTypes(`OPENAI_API_KEY=${mixedEntropyKey}`)).toEqual(["openai-api-key"]);
  });

  it("enumerates tracked and untracked non-ignored files without opening ignored files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bea-secret-scan-"));
    cleanupDirectories.push(root);
    git(root, "init", "--quiet");
    writeFileSync(path.join(root, ".gitignore"), "ignored-secret.txt\n", "utf8");
    writeFileSync(path.join(root, "tracked-safe.txt"), "synthetic safe text\n", "utf8");
    writeFileSync(path.join(root, "untracked-finding.txt"), fakeProjectKey("b"), "utf8");
    writeFileSync(path.join(root, "ignored-secret.txt"), fakeProjectKey("c"), "utf8");
    git(root, "add", ".gitignore", "tracked-safe.txt");

    expect(listGitVisibleFiles(root)).toEqual([
      ".gitignore",
      "tracked-safe.txt",
      "untracked-finding.txt",
    ]);
    const result = scanRepository(root);
    expect(result.findings).toEqual([
      { file: "untracked-finding.txt", type: "openai-project-api-key" },
    ]);
    expect(JSON.stringify(result)).not.toContain(fakeProjectKey("b"));
    expect(JSON.stringify(result)).not.toContain(fakeProjectKey("c"));
  });

  it("fails closed when Git enumeration fails", () => {
    expect(() =>
      listGitVisibleFiles("C:/synthetic", () => ({
        error: undefined,
        status: 1,
        stdout: "",
      })),
    ).toThrowError(/could not enumerate Git tracked and non-ignored files/iu);
  });
});
