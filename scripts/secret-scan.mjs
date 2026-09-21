import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryBoundary, targetForEnvironment } from "./repository-boundary.mjs";
import { findProhibitedRepositoryPaths } from "./repository-data-policy.mjs";

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

const joined = (...parts) => parts.join("");
const detectors = [
  {
    pattern: new RegExp(
      `\\b${joined("s", "k")}-${joined("p", "r", "o", "j")}-[A-Za-z0-9_-]{20,}\\b`,
      "gu",
    ),
    type: "openai-project-api-key",
  },
  {
    pattern: new RegExp(
      `\\b${joined("s", "k")}-${joined("s", "v", "c", "a", "c", "c", "t")}-[A-Za-z0-9_-]{20,}\\b`,
      "gu",
    ),
    type: "openai-service-account-api-key",
  },
  {
    pattern: new RegExp(
      `\\b${joined("s", "k")}-(?!(?:${joined("p", "r", "o", "j")}|${joined("s", "v", "c", "a", "c", "c", "t")})-)[A-Za-z0-9_-]{20,}\\b`,
      "gu",
    ),
    type: "openai-api-key",
  },
  {
    pattern: new RegExp(`\\b${joined("A", "K", "I", "A")}[A-Z0-9]{16}\\b`, "gu"),
    type: "aws-access-key-id",
  },
  {
    pattern: new RegExp(`\\b${joined("g", "h")}[pousr]_[A-Za-z0-9]{30,}\\b`, "gu"),
    type: "github-token",
  },
  {
    pattern: new RegExp(
      `\\b${joined("s", "k", "_", "l", "i", "v", "e", "_")}[A-Za-z0-9]{16,}\\b`,
      "gu",
    ),
    type: "stripe-live-secret-key",
  },
  {
    pattern: new RegExp(`\\b${joined("x", "o", "x")}[baprs]-[A-Za-z0-9-]{20,}\\b`, "gu"),
    type: "slack-token",
  },
  {
    pattern: new RegExp(
      joined("-", "-", "-", "-", "-", "BEGIN ") +
        "(?:RSA |EC |OPENSSH )?PRIVATE KEY" +
        joined("-", "-", "-", "-", "-"),
      "gu",
    ),
    type: "private-key-block",
  },
  {
    pattern: new RegExp(`\\b${joined("A", "I", "z", "a")}[A-Za-z0-9_-]{30,}\\b`, "gu"),
    type: "google-api-key",
  },
  {
    pattern: /(?:^|\n)\s*\/\/[^=\r\n]*:_authToken\s*=\s*[A-Za-z0-9._-]{20,}/gu,
    type: "npm-auth-token",
  },
  {
    pattern: /\bAccountKey=[A-Za-z0-9+/=]{32,}/gu,
    type: "cloud-storage-account-key",
  },
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/gu,
    type: "us-social-security-number",
  },
];

const namedSecretPattern =
  /\b(?:SESSION_SECRET|OAUTH_CLIENT_SECRET|RECOVERY_CODE|PRODUCTION_CONTROL_TOKEN|CLOUDFLARE_API_TOKEN|SUPABASE_SERVICE_ROLE_KEY|DATABASE_PASSWORD)\b\s*[:=]\s*["']?([A-Za-z0-9+/_=-]{24,})/giu;
const postgresUrlPattern = /\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu;

function isPlaceholder(value) {
  return /(?:^phase\d|example|placeholder|redacted|synthetic|test-only|build-only|private-value|production-session-secret|verification-secret)/iu.test(
    value,
  );
}

function hasSecretEntropyShape(value) {
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter((pattern) =>
    pattern.test(value),
  ).length;
  return classes >= 3 || /^[a-f0-9]{32,}$/iu.test(value);
}

function containsNamedSecret(contents) {
  namedSecretPattern.lastIndex = 0;
  for (const match of contents.matchAll(namedSecretPattern)) {
    const candidate = match[1] ?? "";
    if (!isPlaceholder(candidate) && hasSecretEntropyShape(candidate)) return true;
  }
  return false;
}

function containsCredentialedPostgresUrl(contents) {
  postgresUrlPattern.lastIndex = 0;
  for (const match of contents.matchAll(postgresUrlPattern)) {
    try {
      const candidate = new URL((match[0] ?? "").replace(/[),.;]+$/u, ""));
      const hostname = candidate.hostname.toLowerCase();
      const password = decodeURIComponent(candidate.password);
      const reservedHost =
        hostname === "localhost" ||
        hostname === "::1" ||
        /^127\./u.test(hostname) ||
        /(?:^|\.)(?:invalid|test|example)$/u.test(hostname) ||
        /(?:^|\.)example\.(?:com|net|org)$/u.test(hostname);
      const placeholderPassword =
        /^(?:change-?me|example|pass(?:word)?|private(?:-value)?|redacted|secret|test)$/iu.test(
          password,
        );
      if (candidate.username && password && !reservedHost && !placeholderPassword) return true;
    } catch {
      // An invalid URL is not sufficient evidence of a credential.
    }
  }
  return false;
}

export class SecretScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SecretScanError";
  }
}

function safeRelativePath(root, candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || path.isAbsolute(candidate)) {
    throw new SecretScanError(
      "UNSAFE_REPOSITORY_ENTRY",
      "Git returned an unsafe repository entry.",
    );
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SecretScanError(
      "UNSAFE_REPOSITORY_ENTRY",
      "Git returned an entry outside the repository.",
    );
  }
  return { relative: relative.split(path.sep).join("/"), resolved };
}

export function listGitVisibleFiles(root, run = spawnSync) {
  const result = run(
    "git",
    [
      "-c",
      `safe.directory=${path.resolve(root).replaceAll("\\", "/")}`,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new SecretScanError(
      "GIT_ENUMERATION_FAILED",
      "Secret scan could not enumerate Git tracked and non-ignored files.",
    );
  }
  const entries = result.stdout.split("\0").filter(Boolean);
  return [...new Set(entries.map((entry) => safeRelativePath(root, entry).relative))].sort();
}

const sequentialLatinAlphabet = "abcdefghijklmnopqrstuvwxyz";

function openaiSecretBody(token, type) {
  if (type === "openai-project-api-key") {
    return token.replace(
      new RegExp(`^${joined("s", "k")}-${joined("p", "r", "o", "j")}-`, "u"),
      "",
    );
  }
  if (type === "openai-service-account-api-key") {
    return token.replace(
      new RegExp(`^${joined("s", "k")}-${joined("s", "v", "c", "a", "c", "c", "t")}-`, "u"),
      "",
    );
  }
  if (type === "openai-api-key") {
    return token.replace(new RegExp(`^${joined("s", "k")}-`, "u"), "");
  }
  return token;
}

function isKnownNonSecretOpenAiFixture(body) {
  const normalized = body.toLowerCase();
  return normalized === sequentialLatinAlphabet || isPlaceholder(body);
}

export function detectSecretTypes(contents) {
  const findings = [];
  for (const detector of detectors) {
    detector.pattern.lastIndex = 0;
    let matched = false;
    for (const match of contents.matchAll(detector.pattern)) {
      const token = match[0] ?? "";
      if (
        detector.type.startsWith("openai-") &&
        isKnownNonSecretOpenAiFixture(openaiSecretBody(token, detector.type))
      ) {
        continue;
      }
      matched = true;
      break;
    }
    if (matched) findings.push(detector.type);
  }
  if (containsNamedSecret(contents)) findings.push("named-production-secret");
  if (containsCredentialedPostgresUrl(contents)) findings.push("postgresql-credential-url");
  return findings;
}

function looksBinary(buffer) {
  const sampleLength = Math.min(buffer.length, 8_192);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export function scanRepository(root, options = {}) {
  const files = listGitVisibleFiles(root, options.runGit);
  const prohibitedPaths = findProhibitedRepositoryPaths(files);
  const findings = [];
  let filesScanned = 0;
  let binaryFilesSkipped = 0;
  for (const relativeFile of files) {
    const { resolved } = safeRelativePath(root, relativeFile);
    const metadata = lstatSync(resolved);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new SecretScanError(
        "UNSAFE_REPOSITORY_ENTRY",
        "Secret scan refuses non-file or symbolic-link repository entries.",
      );
    }
    if (binaryExtensions.has(path.extname(relativeFile).toLowerCase())) {
      binaryFilesSkipped += 1;
      continue;
    }
    const buffer = readFileSync(resolved);
    if (looksBinary(buffer)) {
      binaryFilesSkipped += 1;
      continue;
    }
    filesScanned += 1;
    for (const type of detectSecretTypes(buffer.toString("utf8"))) {
      findings.push({ file: relativeFile, type });
    }
  }
  return {
    binaryFilesSkipped,
    filesDiscovered: files.length,
    filesScanned,
    findings,
    prohibitedPaths,
  };
}

export function runSecretScan(environment = process.env) {
  const boundary = assertRepositoryBoundary({ target: targetForEnvironment(environment) });
  const result = scanRepository(boundary.target);
  if (result.findings.length > 0 || result.prohibitedPaths.length > 0) {
    process.stderr.write(
      JSON.stringify({ code: "BEA_SECRET_SCAN_FINDINGS", ...result, ok: false }, null, 2) + "\n",
    );
    return 1;
  }
  process.stdout.write(
    JSON.stringify({ code: "BEA_SECRET_SCAN_CLEAR", ...result, ok: true }) + "\n",
  );
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    process.exitCode = runSecretScan();
  } catch (error) {
    const code = error instanceof SecretScanError ? error.code : "BEA_SECRET_SCAN_FAILED";
    process.stderr.write(JSON.stringify({ code, ok: false }) + "\n");
    process.exitCode = 1;
  }
}
