import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRepositoryBoundary, isPathWithin, REPOSITORY_ID } from "./repository-boundary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestRelative = ".data/cpl-local/workspace-copies.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function sourceToDestination(source) {
  if (
    typeof source !== "string" ||
    source.includes("\\") ||
    source.split("/").some((part) => !part || part.startsWith("."))
  )
    return null;
  const match = /^packages\/([a-z][a-z0-9-]*)\/(package\.json|(?:src|migrations)\/.+)$/u.exec(
    source,
  );
  if (!match) return null;
  const relative = match[2];
  if (relative !== "package.json") {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|css|sql|json)$/u.test(relative)) return null;
    if (
      relative
        .split("/")
        .some((part) =>
          /^(?:node_modules|dist|coverage|logs?|backups?|test-results|tests?|__tests__|secrets?|credentials)$/iu.test(
            part,
          ),
        )
    )
      return null;
    if (
      /\.(?:test|spec)\.[^.]+$/u.test(relative) ||
      /(?:^|\/)(?:credentials|secret|cookies|storage-state)(?:[.-]|$)/iu.test(relative)
    )
      return null;
  }
  return "node_modules/@bea/" + match[1] + "/" + relative;
}

function assertContained(candidate) {
  if (!isPathWithin(candidate, root))
    throw new Error("Workspace copy path escaped the authorized checkout.");
  let existing = candidate;
  while (!existsSync(existing)) existing = path.dirname(existing);
  if (
    lstatSync(existing).isSymbolicLink() ||
    realpathSync.native(existing).toLowerCase() !== path.resolve(existing).toLowerCase()
  ) {
    throw new Error("Workspace copy refused a redirected path.");
  }
}

function walk(directory) {
  assertContained(directory);
  const paths = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (
      item.name.startsWith(".") ||
      /^(?:node_modules|dist|coverage|logs?|backups?|tests?|__tests__|secrets?|credentials)$/iu.test(
        item.name,
      )
    )
      continue;
    const candidate = path.join(directory, item.name);
    assertContained(candidate);
    if (item.isSymbolicLink()) throw new Error("Workspace source links are not supported.");
    if (item.isDirectory()) paths.push(...walk(candidate));
    else if (item.isFile()) paths.push(candidate);
  }
  return paths;
}

function collectSources() {
  const packagesDirectory = path.join(root, "packages");
  assertContained(packagesDirectory);
  const entries = [];
  let packages = 0;
  for (const item of readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (!item.isDirectory() || !/^[a-z][a-z0-9-]*$/u.test(item.name)) continue;
    const packageDirectory = path.join(packagesDirectory, item.name);
    const packageJson = path.join(packageDirectory, "package.json");
    assertContained(packageJson);
    const identity = JSON.parse(readFileSync(packageJson, "utf8"));
    if (identity.name !== "@bea/" + item.name || identity.private !== true)
      throw new Error("Workspace package identity mismatch.");
    packages++;
    const files = [packageJson];
    for (const subdirectory of ["src", "migrations"]) {
      const candidate = path.join(packageDirectory, subdirectory);
      if (existsSync(candidate)) files.push(...walk(candidate));
    }
    for (const file of files) {
      const source = path.relative(root, file).replaceAll("\\", "/");
      const destination = sourceToDestination(source);
      if (!destination) continue;
      assertContained(file);
      const bytes = readFileSync(file);
      entries.push({ source, destination, sha256: hash(bytes), bytes });
    }
  }
  entries.sort((left, right) => left.destination.localeCompare(right.destination, "en"));
  return { packages, entries };
}

export function validateCopyManifest(manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.repositoryId !== REPOSITORY_ID ||
    !Array.isArray(manifest.files)
  )
    throw new Error("Workspace copy manifest identity is invalid.");
  const destinations = new Set();
  for (const file of manifest.files) {
    if (
      !file ||
      sourceToDestination(file.source) !== file.destination ||
      !file.destination ||
      !/^[a-f0-9]{64}$/u.test(file.sha256 ?? "") ||
      destinations.has(file.destination)
    )
      throw new Error("Workspace copy manifest contains an unsafe or duplicate path.");
    destinations.add(file.destination);
  }
  return manifest.files;
}

function previousManifest() {
  const manifestPath = path.join(root, manifestRelative);
  assertContained(manifestPath);
  if (!existsSync(manifestPath)) return [];
  return validateCopyManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
}

export function staleCopyPaths(previous, current, digestForPath) {
  const currentPaths = new Set(current.map((entry) => entry.destination));
  const stale = [];
  for (const entry of previous) {
    if (currentPaths.has(entry.destination)) continue;
    const actual = digestForPath(entry.destination);
    if (actual === null) continue;
    if (actual !== entry.sha256)
      throw new Error("A stale workspace copy was modified; refusing to remove unknown content.");
    stale.push(entry.destination);
  }
  return stale.sort();
}

function destinationDigest(relative) {
  const candidate = path.join(root, relative);
  assertContained(candidate);
  if (!existsSync(candidate)) return null;
  if (!lstatSync(candidate).isFile())
    throw new Error("Workspace copy target must be a regular file.");
  return hash(readFileSync(candidate));
}

export function inspectWorkspaceCopies() {
  assertRepositoryBoundary({ cwd: root, target: root });
  const current = collectSources();
  const previous = previousManifest();
  const recorded = new Map(previous.map((entry) => [entry.destination, entry.sha256]));
  const changed = current.entries.filter(
    (entry) =>
      recorded.get(entry.destination) !== entry.sha256 ||
      destinationDigest(entry.destination) !== entry.sha256,
  ).length;
  const currentPaths = new Set(current.entries.map((entry) => entry.destination));
  const stale = previous.filter((entry) => !currentPaths.has(entry.destination)).length;
  return {
    state: changed === 0 && stale === 0 && previous.length > 0 ? "FRESH" : "REFRESH_REQUIRED",
    packages: current.packages,
    files: current.entries.length,
    changed,
    stale,
  };
}

export function synchronizeWorkspaceCopies() {
  assertRepositoryBoundary({ cwd: root, target: root });
  const current = collectSources();
  const previous = previousManifest();
  const known = new Set(previous.map((entry) => entry.destination));
  // Validate every destination and stale removal before the first mutation.
  const stale = staleCopyPaths(previous, current.entries, destinationDigest);
  const changed = [];
  for (const entry of current.entries) {
    const actual = destinationDigest(entry.destination);
    if (actual === entry.sha256) continue;
    if (actual !== null && !known.has(entry.destination))
      throw new Error("An unmanaged workspace destination exists; refusing to overwrite it.");
    changed.push(entry);
  }
  for (const entry of changed) {
    const destination = path.join(root, entry.destination);
    assertContained(destination);
    mkdirSync(path.dirname(destination), { recursive: true });
    assertContained(destination);
    writeFileSync(destination, entry.bytes);
  }
  for (const relative of stale) {
    const destination = path.join(root, relative);
    assertContained(destination);
    unlinkSync(destination); // Exact previously copied file only; never recursive deletion.
  }
  for (const entry of current.entries) {
    if (destinationDigest(entry.destination) !== entry.sha256)
      throw new Error("Workspace copy checksum readback failed.");
  }
  const manifestPath = path.join(root, manifestRelative);
  assertContained(manifestPath);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    repositoryId: REPOSITORY_ID,
    files: current.entries.map(({ source, destination, sha256 }) => ({
      source,
      destination,
      sha256,
    })),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  validateCopyManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  return {
    state: "FRESH",
    packages: current.packages,
    files: current.entries.length,
    copied: changed.length,
    removed: stale.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(
      JSON.stringify({
        code: "CPL_WORKSPACE_COPIES",
        ...(process.argv.includes("--check")
          ? inspectWorkspaceCopies()
          : synchronizeWorkspaceCopies()),
      }) + "\n",
    );
  } catch (error) {
    process.stderr.write("CPL_WORKSPACE_COPIES_FAILED: " + error.message + "\n");
    process.exitCode = 1;
  }
}
