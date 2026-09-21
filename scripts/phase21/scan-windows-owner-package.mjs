import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectSecretTypes } from "../secret-scan.mjs";
import { prohibitedRepositoryPathReason } from "../repository-data-policy.mjs";
import {
  CANONICAL_EXTRACTION_PATH,
  START_LAUNCHER,
  STOP_LAUNCHER,
} from "./owner-acceptance-package-policy.mjs";

const binaryExtensions = new Set([
  ".7z",
  ".docx",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".tar",
  ".webp",
  ".woff",
  ".woff2",
  ".xlsx",
  ".zip",
]);

const prohibitedNames = new Set([
  ".env",
  ".env.local",
  ".git",
  "node_modules",
  ".data",
  ".next",
  "coverage",
  "playwright-report",
  "test-results",
]);

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else files.push(fullPath);
    }
  }
  return files;
}

function looksBinary(buffer) {
  const sampleLength = Math.min(buffer.length, 8_192);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export function scanOwnerAcceptancePackage(stagingDir) {
  if (!existsSync(stagingDir)) {
    throw new Error("Owner package staging directory is missing.");
  }
  const findings = [];
  const prohibited = [];
  const files = walk(stagingDir);
  for (const filePath of files) {
    const relative = path.relative(stagingDir, filePath).split(path.sep).join("/");
    const metadata = lstatSync(filePath);
    if (metadata.isSymbolicLink()) {
      prohibited.push({ file: relative, reason: "SYMBOLIC_LINK" });
      continue;
    }
    const segments = relative.split("/");
    if (segments.some((segment) => prohibitedNames.has(segment))) {
      prohibited.push({ file: relative, reason: "PROHIBITED_PACKAGE_ENTRY" });
      continue;
    }
    const policyReason = prohibitedRepositoryPathReason(relative);
    if (
      policyReason &&
      relative !== "PACKAGE-MANIFEST.json" &&
      relative !== "PACKAGE-CHECKSUMS.txt"
    ) {
      prohibited.push({ file: relative, reason: policyReason });
    }
    if (
      binaryExtensions.has(path.extname(relative).toLowerCase()) ||
      looksBinary(readFileSync(filePath))
    ) {
      continue;
    }
    const contents = readFileSync(filePath, "utf8");
    for (const type of detectSecretTypes(contents)) {
      findings.push({ file: relative, type });
    }
  }

  const required = [
    "READ-ME-FIRST.txt",
    "PACKAGE-MANIFEST.json",
    "PACKAGE-CHECKSUMS.txt",
    START_LAUNCHER,
    STOP_LAUNCHER,
  ];
  for (const name of required) {
    if (!existsSync(path.join(stagingDir, name))) {
      prohibited.push({ file: name, reason: "REQUIRED_OWNER_FILE_MISSING" });
    }
  }

  const readme = existsSync(path.join(stagingDir, "READ-ME-FIRST.txt"))
    ? readFileSync(path.join(stagingDir, "READ-ME-FIRST.txt"), "utf8")
    : "";
  if (readme && !readme.includes(CANONICAL_EXTRACTION_PATH)) {
    prohibited.push({ file: "READ-ME-FIRST.txt", reason: "CANONICAL_PATH_MISSING" });
  }

  return {
    filesScanned: files.length,
    extractedBytes: files.reduce((total, filePath) => total + statSync(filePath).size, 0),
    findings,
    prohibited,
    ok: findings.length === 0 && prohibited.length === 0,
  };
}

export function verifyZipChecksum(zipFile, expectedSha256) {
  const actual = createHash("sha256").update(readFileSync(zipFile)).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error("Owner package SHA-256 mismatch.");
  }
  return actual;
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const stagingFlag = process.argv.indexOf("--staging");
  const staging = stagingFlag >= 0 ? process.argv[stagingFlag + 1] : undefined;
  if (!staging) {
    process.stderr.write("Usage: scan-windows-owner-package.mjs --staging <directory>\n");
    process.exitCode = 1;
  } else {
    const result = scanOwnerAcceptancePackage(staging);
    process.stdout.write(
      JSON.stringify(
        {
          code: result.ok ? "BEA_OWNER_PACKAGE_SCAN=PASS" : "BEA_OWNER_PACKAGE_SCAN=FAIL",
          ...result,
        },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = result.ok ? 0 : 1;
  }
}
