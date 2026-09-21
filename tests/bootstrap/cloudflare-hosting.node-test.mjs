import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertPublishedDeployment,
  bundledEnvironmentFile,
  hostingEnvironment,
  parseHostingArguments,
} from "../../scripts/cloudflare-hosting.mjs";
import { publicationPathDecision } from "../../scripts/publication-export.mjs";

const published = {
  identity: 1380072423,
  commit: "a".repeat(40),
  head: "a".repeat(40),
  remoteHead: "a".repeat(40),
  dirty: false,
  origin: "https://github.com/AaronStarrett/CPL-Command-Center-Public.git",
};

test("deployment requires an exact public commit with clean matching reviewed source", () => {
  assert.doesNotThrow(() => assertPublishedDeployment(published));
  for (const override of [
    { identity: 1347066403 },
    { dirty: true },
    { commit: undefined },
    { head: "b".repeat(40) },
    { remoteHead: "b".repeat(40) },
    { origin: "https://example.invalid/unreviewed.git" },
  ])
    assert.throws(() => assertPublishedDeployment({ ...published, ...override }));
});

test("hosting CLI accepts bounded actions and refuses unpinned deployment", () => {
  assert.deepEqual(parseHostingArguments(["dry-run", "jobs"]), {
    action: "dry-run",
    target: "jobs",
    commit: undefined,
  });
  assert.equal(
    parseHostingArguments(["deploy", "web", "--commit", published.commit]).commit,
    published.commit,
  );
  for (const arguments_ of [
    ["deploy", "web"],
    ["build", "jobs"],
    ["build", "web", "--force"],
    ["delete", "web"],
    ["preview", "unknown"],
  ])
    assert.throws(() => parseHostingArguments(arguments_));
});

test("local hosting toolchain cannot inherit provider or database credentials", () => {
  const environment = hostingEnvironment(
    "D:/Cyber Pirate Labs/03_ENGINEERING/Repositories/CPL-Command-Center",
    {
      DATABASE_URL: "synthetic-private",
      CPL_WORKER_DATABASE_URL: "synthetic-private",
      OPENAI_API_KEY: "synthetic-private",
      CLOUDFLARE_API_TOKEN: "synthetic-private",
    },
  );
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.CPL_HOSTED_BUILD, "true");
  assert.equal(environment.DATABASE_URL, "");
  assert.equal(environment.OPENAI_API_KEY, "");
  assert.equal(environment.CPL_WORKER_DATABASE_URL, undefined);
  assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
  assert.match(environment.WRANGLER_LOG_PATH.replaceAll("\\", "/"), /^D:\/Cyber Pirate Labs\//u);
});

test("hosting children use the invoking Node when inherited Path and PATH conflict", () => {
  const preferredPath = "D:/Cyber Pirate Labs/synthetic-preferred-tools";
  const environment = hostingEnvironment(
    "D:/Cyber Pirate Labs/03_ENGINEERING/Repositories/CPL-Command-Center",
    { ...process.env, Path: preferredPath, PATH: "D:/Cyber Pirate Labs/synthetic-other-tools" },
  );
  const expectedKey = process.platform === "win32" ? "Path" : "PATH";
  assert.deepEqual(
    Object.keys(environment).filter((key) => key.toLowerCase() === "path"),
    [expectedKey],
  );
  assert.equal(
    environment[expectedKey],
    path.dirname(process.execPath) + path.delimiter + preferredPath,
  );
  const child = spawnSync("node", ["-p", "process.execPath"], {
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), process.execPath);
});

test("generated adapters and local Wrangler secrets cannot enter public export", () => {
  for (const file of [
    "apps/web/.open-next/worker.js",
    "apps/web/.wrangler/state.json",
    "apps/web/.dev.vars",
    "apps/worker/.dev.vars.production",
  ])
    assert.equal(publicationPathDecision(file), "runtime-or-secret-path");
  assert.equal(publicationPathDecision("apps/web/open-next.config.ts"), "include");
  assert.equal(publicationPathDecision("apps/worker/cloudflare-worker.mjs"), "include");
});

test("OpenNext cannot silently compile local environment files into its Worker bundle", () => {
  for (const file of [".env", ".env.local", ".env.production", ".env.test.local"])
    assert.equal(bundledEnvironmentFile(file), true);
  assert.equal(bundledEnvironmentFile(".env.example"), false);
  assert.equal(bundledEnvironmentFile("wrangler.jsonc"), false);
  assert.equal(bundledEnvironmentFile(".dev.vars"), true);
  assert.equal(bundledEnvironmentFile(".dev.vars.production"), true);
  assert.equal(bundledEnvironmentFile(".dev.vars", "preview"), false);
});

test("hosting configurations require no paid storage and keep scheduler off HTTP", () => {
  // These data-only JSONC files use Prettier's trailing commas, without comments.
  const configuration = (file) =>
    JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8").replace(/,\s*(?=[}\]])/gu, ""));
  const web = configuration("../../apps/web/wrangler.jsonc");
  const jobs = configuration("../../apps/worker/wrangler.jsonc");
  assert.equal(web.main, "cloudflare-worker.mjs");
  assert.deepEqual(web.alias, {
    "next/server": "./lib/cloudflare-next-response.mjs",
    "server-only": "next/dist/compiled/server-only/empty.js",
  });
  for (const configuration of [web, jobs]) {
    for (const binding of [
      "r2_buckets",
      "kv_namespaces",
      "d1_databases",
      "durable_objects",
      "queues",
      "images",
      "hyperdrive",
    ])
      assert.equal(configuration[binding], undefined);
    assert.equal(configuration.preview_urls, false);
    assert.equal(configuration.vars.CPL_PUBLIC_COMMIT, "UNPUBLISHED");
  }
  assert.equal(jobs.workers_dev, false);
  assert.deepEqual(jobs.triggers.crons, ["*/15 * * * *"]);
});
