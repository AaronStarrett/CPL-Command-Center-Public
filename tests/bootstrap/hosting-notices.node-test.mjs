import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  collectHostingNotices,
  emittedEsbuildInputs,
  readmeLicenseSection,
} from "../../scripts/hosting-notices.mjs";
import {
  emittedDependencyResources,
  HostedDependencyInputsPlugin,
} from "../../apps/web/lib/webpack-dependency-inputs.ts";

function fixture(t) {
  const parent = path.resolve(".data", "hosting", "notice-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = (name, license = "Upstream copyright\r\nMIT license text\r\n", version = "1.2.3") => {
    const directory = path.join(root, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name, version, license: "MIT" }),
    );
    if (license !== null) writeFileSync(path.join(directory, "LICENSE"), license);
    writeFileSync(path.join(directory, "index.js"), "export const value = 1;\n");
    return path.join(directory, "index.js");
  };
  return { root, add };
}

test("notices use emitted packages only and preserve original notice bytes deterministically", (t) => {
  const { root, add } = fixture(t);
  const beta = add("beta"),
    alpha = add("alpha");
  add("unused-build-tool");
  const first = collectHostingNotices({ repositoryRoot: root, resources: [beta, alpha, beta] });
  const second = collectHostingNotices({ repositoryRoot: root, resources: [alpha, beta] });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.manifest.packages.map((item) => item.name),
    ["alpha", "beta"],
  );
  assert.ok(first.text.includes(Buffer.from("Upstream copyright\r\nMIT license text\r\n")));
  assert.ok(!first.text.includes(Buffer.from(root)));
  assert.ok(!JSON.stringify(first.manifest).includes(root));
});

test("bundled nested runtime notices retain attribution without inventing a version", (t) => {
  const { root, add } = fixture(t);
  add("framework");
  const embedded = path.join(root, "node_modules", "framework", "dist", "compiled", "embedded");
  mkdirSync(embedded, { recursive: true });
  writeFileSync(path.join(embedded, "package.json"), JSON.stringify({ name: "embedded" }));
  writeFileSync(path.join(embedded, "LICENSE"), "Embedded upstream copyright\n");
  const resource = path.join(embedded, "index.js");
  writeFileSync(resource, "export default 1;");
  const result = collectHostingNotices({ repositoryRoot: root, resources: [resource] });
  assert.equal(
    result.manifest.packages.find((item) => item.name === "embedded").version,
    "embedded in framework@1.2.3",
  );
  assert.match(result.text.toString(), /Embedded upstream copyright/u);
});

test("missing notices and inputs outside the checkout stop notice preparation", (t) => {
  const { root, add } = fixture(t);
  const resource = add("missing", null);
  assert.throws(
    () => collectHostingNotices({ repositoryRoot: root, resources: [resource] }),
    /upstream notice review/u,
  );
  assert.throws(
    () => collectHostingNotices({ repositoryRoot: root, resources: [import.meta.filename] }),
    /leaves the reviewed checkout/u,
  );
});

test("workspace copies do not become third-party dependencies", (t) => {
  const { root, add } = fixture(t);
  const resource = add("@example/workspace", null);
  const directory = path.join(root, "packages", "workspace");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "@example/workspace" }),
  );
  assert.equal(
    collectHostingNotices({ repositoryRoot: root, resources: [resource] }).manifest.packages.length,
    0,
  );
});

test("README license extraction preserves exact section bytes and excludes later prose", () => {
  const bytes = Buffer.from(
    "# Package\r\nUsage\r\n## License\r\nCopyright Example\r\nTerms\r\n## Development\r\nOther text\r\n",
  );
  assert.deepEqual(
    readmeLicenseSection(bytes),
    Buffer.from("## License\r\nCopyright Example\r\nTerms\r\n"),
  );
  assert.equal(readmeLicenseSection(Buffer.from("# Package\nNo notice supplied")), null);
});

test("the exact empty marker keeps its metadata declaration and rejects authored code", (t) => {
  const { root, add } = fixture(t);
  const resource = add("client-only", null, "0.0.1");
  writeFileSync(resource, "");
  const result = collectHostingNotices({ repositoryRoot: root, resources: [resource] });
  assert.match(result.manifest.packages[0].provenance.join(" "), /audited-empty-marker/u);
  writeFileSync(resource, "throw new Error('authored code');");
  assert.throws(
    () => collectHostingNotices({ repositoryRoot: root, resources: [resource] }),
    /nonempty or unreviewed/u,
  );
});

test("version-pinned upstream notice supplements retain their reviewed bytes", () => {
  const directory = path.resolve("scripts", "publication", "licenses");
  const entries = JSON.parse(readFileSync(path.join(directory, "upstream-notices.json")));
  for (const [name, entry] of Object.entries(entries)) {
    assert.equal(path.basename(entry.filename), entry.filename);
    assert.match(entry.source, new RegExp(entry.commit, "u"));
    assert.equal(
      createHash("sha256")
        .update(readFileSync(path.join(directory, entry.filename)))
        .digest("hex"),
      entry.sha256,
      name,
    );
  }
});

test("esbuild excludes removed inputs and webpack includes concatenated emitted resources", () => {
  assert.deepEqual(
    emittedEsbuildInputs(
      {
        outputs: {
          bundle: {
            inputs: {
              "used.js": { bytesInOutput: 3 },
              "removed.js": { bytesInOutput: 0 },
            },
          },
        },
      },
      process.cwd(),
    ),
    [path.resolve("used.js")],
  );
  const used = { resource: "/synthetic/used.js?query" };
  const removed = { resource: "/synthetic/removed.js" };
  const concatenated = { modules: [used, { resource: "/synthetic/nested.js" }] };
  const compilation = {
    modules: [removed, concatenated],
    chunkGraph: {
      getNumberOfModuleChunks: (module) => (module === removed ? 0 : 1),
    },
  };
  assert.deepEqual(emittedDependencyResources(compilation), [
    "/synthetic/nested.js",
    "/synthetic/used.js",
  ]);
});

test("hosted compiler emits private provenance for the correct compilation", (t) => {
  const { root } = fixture(t);
  let hook;
  new HostedDependencyInputsPlugin(root).apply({
    name: "client",
    hooks: {
      afterEmit: {
        tap: (_name, callback) => {
          hook = callback;
        },
      },
    },
  });
  hook({
    modules: [{ resource: "/synthetic/browser.js" }],
    chunkGraph: { getNumberOfModuleChunks: () => 1 },
  });
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "client.json"))), {
    resources: ["/synthetic/browser.js"],
  });
});
