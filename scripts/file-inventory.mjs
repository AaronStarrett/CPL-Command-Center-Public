import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = path.join(repositoryRoot, "docs", "FILE_INVENTORY.md");
const normalizedRoot = repositoryRoot.replaceAll("\\", "/");

const normalize = (value) => value.trim().replaceAll("\\", "/");
const inventoryText = readFileSync(inventoryPath, "utf8");
const listed = [...inventoryText.matchAll(/^\|\s*`([^`]+)`\s*\|/gmu)].map((match) =>
  normalize(match[1]),
);
const duplicatePaths = listed.filter((entry, index) => listed.indexOf(entry) !== index);
if (duplicatePaths.length > 0) {
  throw new Error(
    `FILE_INVENTORY contains duplicate paths: ${[...new Set(duplicatePaths)].join(", ")}`,
  );
}

const actual = execFileSync(
  "git",
  [
    "-c",
    `safe.directory=${normalizedRoot}`,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .split(/\r?\n/u)
  .map(normalize)
  .filter(Boolean);

const listedSet = new Set(listed);
const actualSet = new Set(actual);
const missingFromInventory = actual.filter((entry) => !listedSet.has(entry));
const missingFromRepository = listed.filter((entry) => !actualSet.has(entry));

if (missingFromInventory.length > 0 || missingFromRepository.length > 0) {
  const lines = ["Repository inventory reconciliation failed."];
  if (missingFromInventory.length > 0) {
    lines.push(`Unlisted repository files (${missingFromInventory.length}):`);
    lines.push(...missingFromInventory.map((entry) => `  + ${entry}`));
  }
  if (missingFromRepository.length > 0) {
    lines.push(`Listed files not present (${missingFromRepository.length}):`);
    lines.push(...missingFromRepository.map((entry) => `  - ${entry}`));
  }
  throw new Error(lines.join("\n"));
}

console.log(`BEA_FILE_INVENTORY=PASS files=${actual.length}`);
