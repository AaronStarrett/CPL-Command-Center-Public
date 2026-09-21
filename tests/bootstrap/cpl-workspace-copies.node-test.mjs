import assert from "node:assert/strict";
import { test } from "node:test";
import { REPOSITORY_ID } from "../../scripts/repository-boundary.mjs";
import {
  inspectWorkspaceCopies,
  sourceToDestination,
  staleCopyPaths,
  validateCopyManifest,
} from "../../scripts/cpl-workspace-copies.mjs";

const checksum = "a".repeat(64);
const entry = {
  source: "packages/config/src/runtime-policy.ts",
  destination: "node_modules/@bea/config/src/runtime-policy.ts",
  sha256: checksum,
};
const manifest = (files) => ({ schemaVersion: 1, repositoryId: REPOSITORY_ID, files });

test("copy mapping includes package entry points, current source, CSS, and required SQL migrations", () => {
  for (const source of [
    "packages/ui/package.json",
    "packages/ui/src/styles.css",
    "packages/config/src/runtime-policy.ts",
    "packages/database/migrations/0024_schema.sql",
  ]) {
    assert.equal(sourceToDestination(source), source.replace(/^packages\//u, "node_modules/@bea/"));
  }
});

test("copy mapping excludes traversal, runtime data, secrets, dependencies, built output, and tests", () => {
  for (const source of [
    "../outside.ts",
    "packages/config/src/../../.env",
    "packages/config/.env",
    "packages/config/src/.env.json",
    "packages/config/src/secrets/key.json",
    "packages/config/src/credentials.json",
    "packages/config/node_modules/x/index.js",
    "packages/config/dist/index.js",
    "packages/config/src/security.test.ts",
    "packages/config/src/data.db",
    "packages/config/src/logs/output.json",
    "packages/config/src\\outside.ts",
  ]) {
    assert.equal(sourceToDestination(source), null, source);
  }
});

test("manifest validation refuses path injection, duplicate entries, and wrong repository identity", () => {
  assert.deepEqual(validateCopyManifest(manifest([entry])), [entry]);
  assert.throws(() => validateCopyManifest(manifest([{ ...entry, destination: "C:/outside.ts" }])));
  assert.throws(() => validateCopyManifest(manifest([entry, entry])));
  assert.throws(() => validateCopyManifest({ ...manifest([entry]), repositoryId: 1 }));
});

test("stale cleanup removes only formerly copied files with matching recorded bytes", () => {
  assert.deepEqual(
    staleCopyPaths([entry], [], () => checksum),
    [entry.destination],
  );
  assert.deepEqual(
    staleCopyPaths([entry], [entry], () => checksum),
    [],
  );
  assert.deepEqual(
    staleCopyPaths([entry], [], () => null),
    [],
  );
  assert.throws(() => staleCopyPaths([entry], [], () => "b".repeat(64)), /refusing to remove/u);
});

test("live workspace copies match current source and verified manifest", () => {
  const status = inspectWorkspaceCopies();
  assert.equal(status.state, "FRESH");
  assert.equal(status.packages, 13);
  assert.ok(status.files > 100);
  assert.equal(status.changed, 0);
  assert.equal(status.stale, 0);
});
