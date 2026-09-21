import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { prepareHostedWorkspaceAsset } from "../../scripts/hosting-static-shell.mjs";

function fixture(t) {
  const parent = path.resolve(".data", "hosting", "static-shell-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "apps", "web");
  const next = path.join(app, ".next");
  const output = path.join(app, ".open-next");
  const html = Buffer.from("<!doctype html><html><body>Public workspace shell π</body></html>\n");
  mkdirSync(path.join(next, "server", "app"), { recursive: true });
  mkdirSync(path.join(output, "cache", "synthetic-build"), { recursive: true });
  writeFileSync(path.join(next, "BUILD_ID"), "synthetic-build\n");
  writeFileSync(path.join(next, "server", "app", "workspace.html"), html);
  const cache = path.join(output, "cache", "synthetic-build", "workspace.cache");
  writeFileSync(cache, JSON.stringify({ type: "app", html: html.toString("utf8"), rsc: "flight" }));
  return { root, next, output, cache, html };
}

test("hosted shell copies exact Next HTML and produces deterministic build provenance", (t) => {
  const f = fixture(t);
  const result = prepareHostedWorkspaceAsset(f.root);
  assert.deepEqual(result, {
    buildId: "synthetic-build",
    workspaceAsset: "/cdn-cgi/cpl-shell/synthetic-build/workspace.html",
    bytes: f.html.length,
    sha256: createHash("sha256").update(f.html).digest("hex"),
  });
  assert.deepEqual(
    readFileSync(path.join(f.output, "assets", result.workspaceAsset.slice(1))),
    f.html,
  );
  assert.deepEqual(prepareHostedWorkspaceAsset(f.root), result);
  assert.match(
    readFileSync(path.join(f.output, "cpl-shell.mjs"), "utf8"),
    /synthetic-build\/workspace\.html/u,
  );
});

test("shell preparation refuses cache drift and non-prerendered output", (t) => {
  const f = fixture(t);
  writeFileSync(f.cache, JSON.stringify({ type: "app", html: "different" }));
  assert.throws(() => prepareHostedWorkspaceAsset(f.root), /disagree/u);
  writeFileSync(f.cache, JSON.stringify({ type: "route", html: f.html.toString("utf8") }));
  assert.throws(() => prepareHostedWorkspaceAsset(f.root), /Prerendered/u);
});

test("shell preparation refuses a build ID that could escape the generated path", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.next, "BUILD_ID"), "../../outside");
  assert.throws(() => prepareHostedWorkspaceAsset(f.root), /Invalid Next build ID/u);
});
