import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const noticeName = /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/iu;
const within = (root, target) => {
  const relative = path.relative(root, target);
  return !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
};

export function emittedEsbuildInputs(metadata, directory) {
  const names = new Set();
  for (const output of Object.values(metadata.outputs ?? {})) {
    for (const [name, detail] of Object.entries(output.inputs ?? {})) {
      // This adapter namespace is a generated missing-optional-module shim,
      // attributed with the copied adapter runtime, rather than a disk package.
      if (
        detail.bytesInOutput > 0 &&
        !name.startsWith("<") &&
        !name.startsWith("optional-deps-missing-dependency:") &&
        !name.startsWith("node-built-in-modules:")
      )
        names.add(path.resolve(directory, name));
    }
  }
  return [...names].sort();
}

export function readmeLicenseSection(bytes) {
  const text = bytes.toString("utf8");
  const start = /^#{1,6}\s+licen[cs]e\s*\r?$/imu.exec(text);
  if (!start) return null;
  const remaining = text.slice(start.index + start[0].length);
  const next = /^#{1,6}\s+/mu.exec(remaining);
  const end = next ? start.index + start[0].length + next.index : text.length;
  return Buffer.from(text.slice(start.index, end));
}

/** Only inspected emitted inputs identify packages; dependency declarations do not. */
export function collectHostingNotices({ repositoryRoot, resources, copiedRuntimePackages = [] }) {
  const root = realpathSync(repositoryRoot);
  const packages = new Map();
  const notices = new Map();
  const resolvedPaths = new Map();
  const installedPackages = new Map();
  const inspectedDirectories = new Set();
  const metadataCache = new Map();
  const emittedPackageResources = new Map();
  const packageDirectories = new Map();
  const firstParty = new Set();
  for (const parent of ["apps", "packages"]) {
    const directory = path.join(root, parent);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const metadata = path.join(directory, name, "package.json");
      if (existsSync(metadata)) firstParty.add(JSON.parse(readFileSync(metadata, "utf8")).name);
    }
  }
  function checked(file) {
    if (resolvedPaths.has(file)) return resolvedPaths.get(file);
    const resolved = realpathSync(file);
    if (!within(root, resolved))
      throw new Error("Bundled dependency input leaves the reviewed checkout.");
    resolvedPaths.set(file, resolved);
    return resolved;
  }
  function metadataAt(file) {
    if (!metadataCache.has(file))
      metadataCache.set(file, JSON.parse(readFileSync(checked(file), "utf8")));
    return metadataCache.get(file);
  }
  function installedEquivalent(metadata, original) {
    const key = `${metadata.name}@${metadata.version}`;
    if (installedPackages.has(key)) return installedPackages.get(key);
    const candidates = [path.join(root, "node_modules", metadata.name)];
    const store = path.join(root, "node_modules", ".pnpm");
    if (metadata.version && existsSync(store)) {
      const prefix = `${metadata.name.replaceAll("/", "+")}@${metadata.version}`;
      for (const directory of readdirSync(store)) {
        if (directory === prefix || directory.startsWith(prefix + "_"))
          candidates.push(path.join(store, directory, "node_modules", metadata.name));
      }
    }
    for (const directory of candidates) {
      const file = path.join(directory, "package.json");
      if (!existsSync(file)) continue;
      const candidate = metadataAt(file);
      if (candidate.name === metadata.name && candidate.version === metadata.version) {
        installedPackages.set(key, checked(directory));
        return installedPackages.get(key);
      }
    }
    return original;
  }
  function addPackage(directory, metadata, container, provenance) {
    if (firstParty.has(metadata.name)) return null;
    if (typeof metadata.name !== "string") throw new Error("Bundled package has no package name.");
    const version = metadata.version ?? `embedded in ${container}`;
    const key = `${metadata.name}@${version}`;
    if (!packages.has(key))
      packages.set(key, {
        name: metadata.name,
        version,
        declaredLicense: metadata.license ?? null,
        provenance: new Set(),
        notices: new Set(),
      });
    const record = packages.get(key);
    if (!packageDirectories.has(key)) packageDirectories.set(key, directory);
    record.provenance.add(provenance);
    if (inspectedDirectories.has(directory)) return { key, record };
    inspectedDirectories.add(directory);
    for (const name of readdirSync(directory)) {
      if (!noticeName.test(name) && !/^readme(?:\..*)?$/iu.test(name)) continue;
      const file = path.join(directory, name);
      if (!statSync(checked(file)).isFile()) continue;
      let bytes = readFileSync(checked(file));
      let label = name;
      if (!noticeName.test(name)) {
        bytes = readmeLicenseSection(bytes);
        if (!bytes) continue;
        label += "#license";
      }
      const hash = digest(bytes);
      const noticeKey = `${key}/${label}`;
      if (notices.has(noticeKey) && notices.get(noticeKey).sha256 !== hash)
        throw new Error("Same bundled package has conflicting upstream notice bytes.");
      notices.set(noticeKey, { package: key, filename: label, sha256: hash, bytes });
      record.notices.add(noticeKey);
    }
    return { key, record };
  }
  function inspect(resource, provenance = "emitted-module") {
    const file = checked(resource);
    const normalized = file.replaceAll("\\", "/");
    const index = normalized.lastIndexOf("/node_modules/");
    if (index < 0) return;
    const parts = normalized.slice(index + 14).split("/");
    const depth = parts[0].startsWith("@") ? 2 : 1;
    const original = path.resolve(normalized.slice(0, index + 14), ...parts.slice(0, depth));
    const metadataFile = path.join(original, "package.json");
    if (!existsSync(metadataFile))
      throw new Error("Bundled dependency package metadata is absent.");
    const metadata = metadataAt(metadataFile);
    if (firstParty.has(metadata.name)) return;
    const installed = installedEquivalent(metadata, original);
    const base = addPackage(installed, metadata, undefined, provenance);
    let owningPackage = base;
    const relative = path.relative(original, path.dirname(file));
    let current = installed;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (!existsSync(current)) break;
      const embeddedMetadata = path.join(current, "package.json");
      if (existsSync(embeddedMetadata)) {
        const nested = metadataAt(embeddedMetadata);
        if (nested.name) owningPackage = addPackage(current, nested, base.key, "embedded-runtime");
      } else if (readdirSync(current).some((name) => noticeName.test(name))) {
        owningPackage = addPackage(
          current,
          { name: `${metadata.name}/${path.relative(installed, current).replaceAll("\\", "/")}` },
          base.key,
          "embedded-runtime",
        );
      }
    }
    if (provenance === "emitted-module" && owningPackage) {
      if (!emittedPackageResources.has(owningPackage.key))
        emittedPackageResources.set(owningPackage.key, new Set());
      emittedPackageResources.get(owningPackage.key).add(file);
    }
  }
  for (const resource of [...new Set(resources)].sort()) inspect(resource);
  for (const name of [...new Set(copiedRuntimePackages)].sort()) {
    inspect(
      path.join(root, "node_modules", name, "package.json"),
      name === "wrangler" ? "bundler-generated-compatibility-shim" : "adapter-copied-runtime",
    );
  }
  // Next's prebundled next-server runtime conceals its internal module graph.
  // Preserve its complete distributed compiled-notice set as a clearly labelled
  // conservative supplement; do not assert that every listed library ships.
  const nextDirectory = path.join(root, "node_modules", "next");
  const compiledDirectory = path.join(nextDirectory, "dist", "compiled");
  if (
    existsSync(compiledDirectory) &&
    [...packages.values()].some((record) => record.name === "next")
  ) {
    const next = metadataAt(path.join(nextDirectory, "package.json"));
    function supplement(directory) {
      const entries = readdirSync(directory, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && noticeName.test(entry.name))) {
        const metadataFile = path.join(directory, "package.json");
        const metadata = existsSync(metadataFile) ? metadataAt(metadataFile) : {};
        addPackage(
          directory,
          {
            ...metadata,
            name:
              metadata.name ??
              `next/${path.relative(nextDirectory, directory).replaceAll("\\", "/")}`,
          },
          `next@${next.version}`,
          "framework-notice-supplement",
        );
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink())
          throw new Error("Linked embedded notice directory is not accepted.");
        if (entry.isDirectory()) supplement(path.join(directory, entry.name));
      }
    }
    supplement(compiledDirectory);
  }
  for (const [key, record] of packages) {
    if (record.notices.size) continue;
    const provenanceFile = path.join(
      root,
      "scripts",
      "publication",
      "licenses",
      "upstream-notices.json",
    );
    const upstream = existsSync(provenanceFile)
      ? JSON.parse(readFileSync(checked(provenanceFile), "utf8"))[key]
      : null;
    if (upstream) {
      if (path.basename(upstream.filename) !== upstream.filename)
        throw new Error("Invalid upstream notice path.");
      const bytes = readFileSync(
        checked(path.join(path.dirname(provenanceFile), upstream.filename)),
      );
      if (digest(bytes) !== upstream.sha256)
        throw new Error("Reviewed upstream notice bytes changed.");
      const id = `${key}/${upstream.filename}`;
      notices.set(id, {
        package: key,
        filename: upstream.filename,
        sha256: upstream.sha256,
        source: upstream.source,
        bytes,
      });
      record.notices.add(id);
      record.provenance.add("version-pinned-upstream-notice");
      continue;
    }
    const emptyMarker = {
      "client-only@0.0.1": "index.js",
      "server-only@0.0.1": "empty.js",
    }[key];
    if (emptyMarker) {
      const inputs = [...(emittedPackageResources.get(key) ?? [])];
      if (
        !inputs.length ||
        inputs.some(
          (file) => path.basename(file) !== emptyMarker || readFileSync(file).length !== 0,
        )
      )
        throw new Error(
          `${record.name} emitted nonempty or unreviewed authored source; upstream notice review is required.`,
        );
      const file = path.join(packageDirectories.get(key), "package.json");
      const bytes = readFileSync(checked(file));
      const metadata = JSON.parse(bytes);
      if (
        metadata.name !== record.name ||
        metadata.version !== "0.0.1" ||
        metadata.license !== "MIT"
      )
        throw new Error(`${record.name} audited marker metadata changed.`);
      const id = `${key}/package.json (license declaration; emitted ${emptyMarker} is empty)`;
      notices.set(id, { package: key, filename: "package.json", sha256: digest(bytes), bytes });
      record.notices.add(id);
      record.provenance.add(
        "audited-empty-marker; metadata declaration only, no inferred copyright notice",
      );
    }
  }
  const inventory = [...packages.values()]
    .map((record) => ({
      ...record,
      provenance: [...record.provenance].sort(),
      notices: [...record.notices].sort(),
    }))
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en"),
    );
  const missing = inventory
    .filter((record) => record.notices.length === 0)
    .map((record) => `${record.name}@${record.version}`);
  if (missing.length)
    throw new Error(`Bundled dependencies need upstream notice review: ${missing.join(", ")}`);
  const ordered = [...notices.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
  const header = Buffer.from(
    "CPL Command Center hosted web and scheduler third-party notices\n\nGenerated from emitted webpack/esbuild inputs and identified adapter/compatibility runtime. Next's complete embedded notice set is preserved as a conservative supplement because its prebundled server runtime conceals internal module provenance; inclusion in that supplement does not assert the library is shipped.\nPackage declarations and original upstream notice bytes follow; this inventory is not a license grant for CPL source or branding.\n\n",
  );
  const buffers = [header];
  for (const [, notice] of ordered) {
    buffers.push(
      Buffer.from(`===== ${notice.package} / ${notice.filename} =====\n`),
      notice.bytes,
      Buffer.from("\n\n"),
    );
  }
  const text = Buffer.concat(buffers);
  return {
    text,
    manifest: {
      schemaVersion: 1,
      scope:
        "emitted web and scheduler dependencies, copied adapter runtime, and conservative Next embedded-notice supplement; not the installed toolchain",
      packages: inventory,
      notices: ordered.map(([id, notice]) => ({
        id,
        package: notice.package,
        filename: notice.filename,
        sha256: notice.sha256,
        ...(notice.source ? { source: notice.source } : {}),
      })),
      artifactSha256: digest(text),
    },
  };
}

export function writeHostingNotices({
  repositoryRoot,
  webpackDirectory,
  metafiles,
  outputDirectory,
}) {
  if (!existsSync(webpackDirectory))
    throw new Error("Hosted webpack dependency provenance is missing; rebuild.");
  const resources = [];
  const compilerFiles = readdirSync(webpackDirectory).filter((name) => name.endsWith(".json"));
  if (!compilerFiles.some((name) => name === "client.json"))
    throw new Error("Browser bundle provenance is missing; rebuild.");
  for (const name of compilerFiles)
    resources.push(
      ...JSON.parse(readFileSync(path.join(webpackDirectory, name), "utf8")).resources,
    );
  for (const { file, directory } of metafiles)
    resources.push(...emittedEsbuildInputs(JSON.parse(readFileSync(file, "utf8")), directory));
  const collected = collectHostingNotices({
    repositoryRoot,
    resources,
    copiedRuntimePackages: ["@opennextjs/cloudflare", "@opennextjs/aws", "wrangler"],
  });
  writeFileSync(path.join(outputDirectory, "THIRD_PARTY_NOTICES.txt"), collected.text);
  writeFileSync(
    path.join(outputDirectory, "THIRD_PARTY_NOTICES.json"),
    JSON.stringify(collected.manifest, null, 2) + "\n",
  );
  return {
    packages: collected.manifest.packages.length,
    notices: collected.manifest.notices.length,
    artifactSha256: collected.manifest.artifactSha256,
  };
}
