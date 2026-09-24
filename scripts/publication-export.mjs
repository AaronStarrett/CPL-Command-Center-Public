import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import {
  assertRepositoryBoundary,
  AUTHORIZED_REPOSITORY,
  isPathWithin,
} from "./repository-boundary.mjs";
import { prohibitedRepositoryPathReason } from "./repository-data-policy.mjs";
import { detectSecretTypes } from "./secret-scan.mjs";

export const PUBLIC_REPOSITORY = "AaronStarrett/CPL-Command-Center-Public";
export const PUBLICATION_ROOT =
  "D:/Cyber Pirate Labs/93_TOOLS_AND_CACHE/CPL-Command-Center/publication";
export const PUBLIC_CHECKOUTS = Object.freeze([
  PUBLICATION_ROOT + "/source",
  PUBLICATION_ROOT + "/anonymous-clone",
]);
const publicCloudCheckouts = [
  "/workspace/CPL-Command-Center-Public",
  "/workspaces/CPL-Command-Center-Public",
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestName = "PUBLIC_EXPORT_MANIFEST.json";
const generatedNames = new Set([
  manifestName,
  "PUBLIC_DEPENDENCIES.json",
  "THIRD_PARTY_NOTICES.md",
  "docs/FILE_INVENTORY.md",
  ".cpl-repository.json",
]);
const rootFiles = new Set([
  ".dockerignore",
  ".editorconfig",
  ".env.example",
  ".gitignore",
  ".gitattributes",
  ".gitleaksignore",
  ".npmrc",
  ".prettierignore",
  ".prettierrc.json",
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "OPEN-CPL-COMMAND-CENTER.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "compose.yaml",
  "eslint.config.mjs",
  "tsconfig.base.json",
  "turbo.json",
]);
const publicDocs = new Set([
  "docs/PUBLIC_EXPORT.md",
  "docs/PUBLIC_DEPLOYMENT.md",
  "docs/CPL_TENANT_FOUNDATION.md",
  "docs/HOSTING_COMPATIBILITY.md",
  "docs/HOSTED_TEST_COVERAGE.md",
  "docs/PRODUCT_FEATURE_MAP.md",
  "docs/LOCAL_PHASE2_TESTING.md",
  "docs/LOCAL_PHASE3_TESTING.md",
  "docs/LOCAL_PHASE4_TESTING.md",
  "docs/LOCAL_PHASE5_TESTING.md",
  "docs/PHASE5_IMPLEMENTATION.md",
  "docs/PHASE5_HANDOFF.md",
  "docs/LOCAL_PHASE6_INTAKE_TESTING.md",
  "docs/PHASE6_INTAKE_IMPLEMENTATION.md",
  "docs/PHASE6_HANDOFF.md",
  "docs/PHASE6_LIVE_GMAIL_ACCEPTANCE.md",
  "docs/PRODUCT_ROADMAP.md",
  "docs/DEFERRED_HOSTING.md",
]);
const textExtension = /\.(?:[cm]?[jt]sx?|json|jsonc|css|sql|ya?ml|toml|md|mdc|ps1|cmd|example)$/iu;
const assetPaths = new Set(["apps/web/public/brand/cpl-logo.png", "apps/web/public/_headers"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");

function formatGenerated(bytes, relative) {
  return execFileSync(
    process.execPath,
    [path.join(root, "node_modules/prettier/bin/prettier.cjs"), "--stdin-filepath", relative],
    { cwd: root, input: bytes, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
}

export function publicationPathDecision(candidate) {
  if (
    typeof candidate !== "string" ||
    candidate.includes("\\") ||
    candidate.startsWith("/") ||
    candidate.split("/").some((part) => !part || part === "." || part === "..")
  )
    return "unsafe-path";
  if (prohibitedRepositoryPathReason(candidate)) return "runtime-or-secret-path";
  if (candidate.split("/").some((part) => part === ".git" || part === ".local-handoff"))
    return "private-metadata";
  if (assetPaths.has(candidate) || rootFiles.has(candidate) || publicDocs.has(candidate))
    return "include";
  if (
    /^[^/]+\.cmd$/u.test(candidate) ||
    /^(?:playwright|vitest)[^/]*\.(?:ts|mjs)$/u.test(candidate)
  )
    return "include";
  if (
    candidate === ".cursor/rules/pre-commit-verify.mdc" ||
    candidate === ".github/dependabot.yml" ||
    /^\.github\/workflows\/[^/]+\.yml$/u.test(candidate)
  )
    return "include";
  if (
    /^(?:apps|packages|tests|scripts|infra)\//u.test(candidate) &&
    (textExtension.test(candidate) ||
      /\/Dockerfile\.[a-z]+$/u.test(candidate) ||
      candidate === "scripts/git-hooks/pre-commit")
  )
    return "include";
  return "outside-public-allowlist";
}

function git(args) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)),
  );
  return execFileSync(
    "git",
    ["-c", "safe.directory=" + root.replaceAll("\\", "/"), "-C", root, ...args],
    { encoding: "utf8", env: environment, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
}

function canonical(candidate) {
  const resolved = path.resolve(candidate).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function assertUnredirectedPath(candidate, allowedRoot) {
  if (!path.isAbsolute(candidate) || !isPathWithin(candidate, allowedRoot))
    throw new Error("Publication path escaped the authorized SSD root.");
  let existing = candidate;
  while (!existsSync(existing)) existing = path.dirname(existing);
  if (
    lstatSync(existing).isSymbolicLink() ||
    canonical(realpathSync.native(existing)) !== canonical(existing)
  )
    throw new Error("Redirected publication path refused.");
}

function assertPublicCheckout(candidate) {
  if (
    ![...PUBLIC_CHECKOUTS, ...publicCloudCheckouts].some(
      (allowed) => canonical(allowed) === canonical(candidate),
    )
  )
    throw new Error("Public checkout is not an explicitly authorized publication path.");
  assertUnredirectedPath(
    candidate,
    publicCloudCheckouts.includes(candidate) ? candidate : path.resolve(PUBLICATION_ROOT),
  );
}

// Extract privacy-sensitive source literals from preserved private HEAD, never from public inputs.
// The strings remain in process memory and are never included in reports or exceptions.
export function privateProfileLiterals(source) {
  const literals = [];
  for (const key of [
    "professionalSummary",
    "businessPriorities",
    "communicationPreferences",
    "decisionPreferences",
    "approvedPersonalInterests",
  ]) {
    const match = new RegExp(key + ':\\s*(\\[[\\s\\S]*?\\]|"(?:[^"\\\\]|\\\\.)*")', "u").exec(
      source,
    );
    if (!match) continue;
    for (const quoted of match[1].matchAll(/"((?:[^"\\]|\\.)*)"/gu)) {
      const value = JSON.parse('"' + quoted[1] + '"');
      if (value.length >= 3) literals.push(value);
    }
  }
  return [...new Set(literals)];
}

const normalizePrivacyPath = (value) => value.replace(/[\\/]+/gu, "/").toLowerCase();

// userInfo reads the OS account record instead of the redirected HOME/USERPROFILE
// used by isolated verification. Keep the resulting identity only in scan memory.
export function publicationPrivacyContext(identity = userInfo()) {
  if (typeof identity.homedir !== "string" || identity.homedir.length < 4)
    throw new Error("Machine-profile privacy context could not be established.");
  return { profilePaths: [normalizePrivacyPath(identity.homedir).replace(/\/$/u, "")] };
}

export function inspectPublicationContent(
  relative,
  bytes,
  privateLiterals = [],
  privacyContext = { profilePaths: [] },
) {
  const text = bytes.toString("utf8");
  const findings = detectSecretTypes(text).map((type) => ({ path: relative, type }));
  if (!assetPaths.has(relative) && text.includes("\0"))
    findings.push({ path: relative, type: "unexpected-binary-content" });
  if (privateLiterals.some((value) => text.includes(value)))
    findings.push({ path: relative, type: "private-profile-literal" });
  const normalized = normalizePrivacyPath(text);
  if (
    privacyContext.profilePaths.some((profilePath) =>
      normalized.includes(normalizePrivacyPath(profilePath)),
    )
  )
    findings.push({ path: relative, type: "machine-profile-path-literal" });
  if (
    /\.codex\/visualizations\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/u.test(
      normalized,
    )
  )
    findings.push({ path: relative, type: "machine-visualization-session-path" });
  return findings;
}

export function publicationGitBytes(relative, bytes) {
  if (assetPaths.has(relative)) return bytes;
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
}

export function publicationWorkingBytes(relative, bytes) {
  const normalized = publicationGitBytes(relative, bytes);
  return relative.endsWith(".cmd")
    ? Buffer.from(normalized.toString("utf8").replaceAll("\n", "\r\n"))
    : normalized;
}

function replaceExactly(source, before, after, label) {
  if (!source.includes(before))
    throw new Error("Public packaging source contract changed: " + label);
  return source.replace(before, after);
}

export function publicGuardSource(source, repositoryId) {
  let result = replaceExactly(
    source,
    '"D:/Cyber Pirate Labs/03_ENGINEERING/Repositories/CPL-Command-Center"',
    JSON.stringify(PUBLIC_CHECKOUTS[0]),
    "guard-root",
  );
  result = replaceExactly(
    result,
    "export const REPOSITORY_ID = 1347066403;",
    "export const REPOSITORY_ID = " + repositoryId + ";",
    "guard-identity",
  );
  result = replaceExactly(
    result,
    '["BEA-Automation-Command-Center", "CPL-Command-Center"]',
    '["CPL-Command-Center-Public"]',
    "guard-origin",
  );
  result = replaceExactly(
    result,
    '  "/workspace/BEA-Automation-Command-Center",\n  "/workspace/CPL-Command-Center",\n  "/workspaces/BEA-Automation-Command-Center",\n  "/workspaces/CPL-Command-Center",',
    "  " +
      JSON.stringify(PUBLIC_CHECKOUTS[1]) +
      ',\n  "/workspace/CPL-Command-Center-Public",\n  "/workspaces/CPL-Command-Center-Public",',
    "guard-cloud-roots",
  );
  return result;
}

function dependencyInventory() {
  const packages = new Map();
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.name.startsWith(".")) continue;
      const packageRoot = path.join(directory, item.name);
      if (item.name.startsWith("@")) {
        visit(packageRoot);
        continue;
      }
      const metadataPath = path.join(packageRoot, "package.json");
      if (!existsSync(metadataPath)) continue;
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (metadata.name?.startsWith("@bea/")) continue;
      const license =
        typeof metadata.license === "string"
          ? metadata.license
          : (metadata.license?.type ?? "NOT_DECLARED");
      const notices = readdirSync(packageRoot)
        .filter((name) => /^(?:licen[sc]e|notice|copying)(?:[.-]|$)/iu.test(name))
        .sort();
      packages.set(metadata.name + "@" + metadata.version, {
        name: metadata.name,
        version: metadata.version,
        license,
        notices,
      });
      visit(path.join(packageRoot, "node_modules"));
    }
  };
  visit(path.join(root, "node_modules"));
  if (packages.size === 0)
    throw new Error("Installed dependency license metadata is required before export.");
  return {
    schemaVersion: 1,
    scope:
      "Installed dependency package metadata; dependency vendor trees are not exported. Not legal advice or a grant of rights.",
    sourceLicense: "UNLICENSED",
    packages: [...packages.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    ),
  };
}

function adapt(relative, bytes, repositoryId) {
  const text = bytes.toString("utf8").replaceAll("\r\n", "\n");
  if (relative === "scripts/repository-boundary.mjs")
    return [
      Buffer.from(publicGuardSource(text, repositoryId)),
      "public-identity-and-allowlisted-paths",
    ];
  if (relative === "scripts/source-integrity.mjs")
    return [
      Buffer.from(
        readFileSync(path.join(root, "scripts/publication/source-integrity.mjs"), "utf8").replace(
          'from "../repository-boundary.mjs"',
          'from "./repository-boundary.mjs"',
        ),
      ),
      "public-assets-only-integrity",
    ];
  if (["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md"].includes(relative))
    return [
      readFileSync(path.join(root, "scripts/publication", relative)),
      "reviewed-public-template",
    ];
  return [bytes, null];
}

export function buildPublicationPlan(repositoryId) {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || repositoryId === 1347066403)
    throw new Error("Distinct positive public repository identity required.");
  const boundary = assertRepositoryBoundary();
  if (boundary.repositoryId !== 1347066403 || canonical(root) !== canonical(AUTHORIZED_REPOSITORY))
    throw new Error("Only the canonical private checkout may export source.");
  const candidates = [
    ...new Set(
      git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const privateLiterals = privateProfileLiterals(
    git([
      "show",
      "7634a3d0503e21a8aee8a1ae0687023e9eeddffe:packages/domain/src/executive-profile.ts",
    ]),
  );
  if (privateLiterals.length === 0)
    throw new Error("Private-profile exclusion evidence could not be loaded.");
  const privacyContext = publicationPrivacyContext();
  const files = [];
  const excluded = [];
  const findings = [];
  for (const relative of candidates) {
    const decision = publicationPathDecision(relative);
    if (decision !== "include") {
      excluded.push({ path: relative, reason: decision });
      continue;
    }
    const absolute = path.join(root, relative);
    assertUnredirectedPath(absolute, root);
    if (!lstatSync(absolute).isFile())
      throw new Error("Export input is not a regular file: " + relative);
    const input = readFileSync(absolute);
    const [adapted, packaging] = adapt(relative, input, repositoryId);
    const bytes = publicationWorkingBytes(relative, adapted);
    const adaptation =
      [packaging, adapted.equals(bytes) ? null : "line-endings"].filter(Boolean).join("+") || null;
    findings.push(...inspectPublicationContent(relative, bytes, privateLiterals, privacyContext));
    files.push({
      path: relative,
      sha256: sha256(bytes),
      sourceSha256: sha256(input),
      size: bytes.length,
      adaptation,
      bytes,
    });
  }
  const generated = new Map([
    [
      ".cpl-repository.json",
      jsonBytes({
        schemaVersion: 1,
        repositoryId,
        owner: "AaronStarrett",
        publication: PUBLIC_REPOSITORY,
      }),
    ],
    ["PUBLIC_DEPENDENCIES.json", jsonBytes(dependencyInventory())],
    [
      "THIRD_PARTY_NOTICES.md",
      readFileSync(path.join(root, "scripts/publication/THIRD_PARTY_NOTICES.md")),
    ],
  ]);
  const inventoryPaths = [
    ...files.map((file) => file.path),
    ...generated.keys(),
    "docs/FILE_INVENTORY.md",
    manifestName,
  ].sort();
  generated.set(
    "docs/FILE_INVENTORY.md",
    Buffer.from(
      "# Public file inventory\n\n| Path | Purpose |\n| --- | --- |\n" +
        inventoryPaths
          .map((relative) => "| `" + relative + "` | Reviewed source publication |\n")
          .join(""),
    ),
  );
  for (const [relative, raw] of generated) {
    const bytes = formatGenerated(raw, relative);
    findings.push(...inspectPublicationContent(relative, bytes, privateLiterals, privacyContext));
    files.push({
      path: relative,
      sha256: sha256(bytes),
      sourceSha256: null,
      size: bytes.length,
      adaptation: "generated-public-metadata",
      bytes,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const plan = {
    schemaVersion: 1,
    repository: PUBLIC_REPOSITORY,
    repositoryId,
    privateHistoryIncluded: false,
    paidProviderCalls: 0,
    files: files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      sourceSha256: file.sourceSha256,
      size: file.size,
      adaptation: file.adaptation,
    })),
    excluded,
    findings,
  };
  return { plan, files };
}

export function verifyExport(destination) {
  assertPublicCheckout(destination);
  const manifest = JSON.parse(readFileSync(path.join(destination, manifestName), "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== PUBLIC_REPOSITORY ||
    manifest.privateHistoryIncluded !== false ||
    !Array.isArray(manifest.files)
  )
    throw new Error("Invalid public export identity.");
  const expected = new Set([manifestName]);
  for (const file of manifest.files) {
    if (
      (!generatedNames.has(file.path) && publicationPathDecision(file.path) !== "include") ||
      expected.has(file.path)
    )
      throw new Error("Export manifest includes a forbidden or duplicate path.");
    expected.add(file.path);
    const absolute = path.join(destination, file.path);
    assertUnredirectedPath(absolute, destination);
    if (!existsSync(absolute) || sha256(readFileSync(absolute)) !== file.sha256)
      throw new Error("Exported file mismatch: " + file.path);
  }
  const walk = (directory, prefix = "") => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + item.name;
      if (
        item.name === ".git" ||
        prohibitedRepositoryPathReason(relative) ||
        relative === "apps/web/next-env.d.ts" ||
        relative.endsWith(".tsbuildinfo")
      )
        continue;
      if (item.isSymbolicLink()) throw new Error("Linked export content refused: " + relative);
      if (item.isDirectory()) walk(path.join(directory, item.name), relative + "/");
      else if (!expected.has(relative)) throw new Error("Unexpected export source: " + relative);
    }
  };
  walk(destination);
  if (existsSync(path.join(destination, ".git"))) {
    const tracked = execFileSync(
      "git",
      [
        "-c",
        "safe.directory=" + destination.replaceAll("\\", "/"),
        "-C",
        destination,
        "ls-files",
        "-z",
      ],
      { encoding: "utf8", windowsHide: true },
    )
      .split("\0")
      .filter(Boolean);
    if (tracked.some((relative) => !expected.has(relative)))
      throw new Error("Public Git index contains a path outside the reviewed export.");
  }
  return { ok: true, files: manifest.files.length, repositoryId: manifest.repositoryId };
}

export function verifyPublicIndex(destination) {
  const verified = verifyExport(destination);
  const manifest = JSON.parse(readFileSync(path.join(destination, manifestName), "utf8"));
  const args = ["-c", "safe.directory=" + destination.replaceAll("\\", "/"), "-C", destination];
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)),
  );
  const gitRead = (command) =>
    execFileSync("git", [...args, ...command], {
      encoding: "utf8",
      env: environment,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  const algorithm = gitRead(["rev-parse", "--show-object-format"]).trim();
  if (!["sha1", "sha256"].includes(algorithm)) throw new Error("Unsupported Git object format.");
  const expected = new Set([...manifest.files.map((file) => file.path), manifestName]);
  const records = gitRead(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
  if (records.length !== expected.size)
    throw new Error("Public initial index must contain the complete reviewed export.");
  for (const record of records) {
    const separator = record.indexOf("\t");
    const [mode, objectId, stage] = record.slice(0, separator).split(" ");
    const relative = record.slice(separator + 1);
    if (!expected.delete(relative) || stage !== "0" || !["100644", "100755"].includes(mode))
      throw new Error("Unexpected or unresolved public index entry.");
    const bytes = publicationGitBytes(relative, readFileSync(path.join(destination, relative)));
    const actual = createHash(algorithm)
      .update("blob " + bytes.length + "\0")
      .update(bytes)
      .digest("hex");
    if (actual !== objectId)
      throw new Error("Staged public content differs from the reviewed export: " + relative);
  }
  return { ...verified, stagedFiles: records.length, initialHistory: "EMPTY_WITH_REVIEWED_INDEX" };
}

function exportPlan(result, reviewPath, refresh) {
  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  if (sha256(jsonBytes(review)) !== sha256(jsonBytes(result.plan)))
    throw new Error("Reviewed publication plan is stale; re-plan and review before export.");
  if (review.findings.length > 0)
    throw new Error("Publication content findings must be resolved before export.");
  const destination = path.resolve(PUBLIC_CHECKOUTS[0]);
  assertPublicCheckout(destination);
  if (existsSync(destination) && readdirSync(destination).length > 0) {
    if (!refresh) throw new Error("Public destination is nonempty; reviewed refresh is required.");
    verifyExport(destination);
    const old = JSON.parse(readFileSync(path.join(destination, manifestName), "utf8"));
    if (old.files.some((file) => !result.files.some((next) => next.path === file.path)))
      throw new Error(
        "Refresh would need file removal; preserve candidate and choose a reviewed cleanup separately.",
      );
  }
  for (const file of result.files) {
    const absolute = path.join(destination, file.path);
    assertUnredirectedPath(absolute, destination);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.bytes);
  }
  const publicManifest = { ...result.plan };
  delete publicManifest.excluded;
  delete publicManifest.findings;
  writeFileSync(
    path.join(destination, manifestName),
    formatGenerated(jsonBytes(publicManifest), manifestName),
  );
  return verifyExport(destination);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const option = (name) => {
      const index = args.indexOf(name);
      return index < 0 ? undefined : args[index + 1];
    };
    const verification = option("--verify");
    if (verification)
      process.stdout.write(JSON.stringify(verifyExport(path.resolve(verification))) + "\n");
    else {
      const result = buildPublicationPlan(Number(option("--repository-id")));
      const reviewPath = option("--plan") ?? option("--review");
      if (!reviewPath)
        throw new Error("Provide --plan or --export --review with an absolute SSD review path.");
      assertUnredirectedPath(reviewPath, path.resolve("D:/Cyber Pirate Labs/93_TOOLS_AND_CACHE"));
      if (args.includes("--export"))
        process.stdout.write(
          JSON.stringify(exportPlan(result, reviewPath, args.includes("--refresh"))) + "\n",
        );
      else {
        mkdirSync(path.dirname(reviewPath), { recursive: true });
        writeFileSync(reviewPath, jsonBytes(result.plan));
        process.stdout.write(
          JSON.stringify({
            files: result.plan.files.length,
            excluded: result.plan.excluded.length,
            findings: result.plan.findings,
            reviewPath,
          }) + "\n",
        );
        if (result.plan.findings.length > 0) process.exitCode = 1;
      }
    }
  } catch (error) {
    process.stderr.write("PUBLIC_EXPORT_REFUSED: " + error.message + "\n");
    process.exitCode = 1;
  }
}
