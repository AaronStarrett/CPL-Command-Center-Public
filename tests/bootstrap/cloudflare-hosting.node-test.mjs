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
  staticCacheEnvironment,
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

test("static cache preparation isolates its inert binding from credentials and runtime children", () => {
  const repositoryRoot = "D:/Cyber Pirate Labs/03_ENGINEERING/Repositories/CPL-Command-Center";
  const source = {
    DATABASE_URL: "synthetic-private",
    CLOUDFLARE_API_TOKEN: "synthetic-private",
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CPL_WEB_DB: "synthetic-private",
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CPL_JOBS_DB: "synthetic-private",
  };
  const environment = staticCacheEnvironment(repositoryRoot, source);
  const connection = new URL(environment.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CPL_WEB_DB);
  assert.equal(connection.hostname, "127.0.0.1");
  assert.equal(connection.port, "1");
  assert.equal(connection.pathname, "/cpl_build");
  assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(environment.DATABASE_URL, "");
  assert.equal(environment.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CPL_JOBS_DB, undefined);
  assert.equal(environment.WRANGLER_WRITE_LOGS, "false");
  assert.equal(
    source.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CPL_WEB_DB,
    "synthetic-private",
  );
  const runtime = hostingEnvironment(repositoryRoot, environment);
  assert.equal(runtime.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CPL_WEB_DB, undefined);
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

// Resource identifiers were verified against the approved Hyperdrive readback.
// They identify capabilities; origin credentials remain outside source control.
const approvedHyperdriveBindings = {
  web: { binding: "CPL_WEB_DB", id: "0e8dc3085db3408eaed23ab12e7a3c7e" },
  jobs: { binding: "CPL_JOBS_DB", id: "aae79b27dcfd4586943400d1ab0084eb" },
};
function hostingConfiguration(target) {
  const file =
    target === "web" ? "../../apps/web/wrangler.jsonc" : "../../apps/worker/wrangler.jsonc";
  // These data-only JSONC files use Prettier's trailing commas, without comments.
  return JSON.parse(
    readFileSync(new URL(file, import.meta.url), "utf8").replace(/,\s*(?=[}\]])/gu, ""),
  );
}
function assertHostingConfiguration(configuration, target) {
  assert.ok(Object.hasOwn(approvedHyperdriveBindings, target));
  assert.equal(
    configuration.name,
    target === "web" ? "cpl-command-center" : "cpl-command-center-jobs",
  );
  assert.equal(configuration.main, "cloudflare-worker.mjs");
  assert.equal(configuration.compatibility_date, "2026-09-21");
  assert.deepEqual(configuration.compatibility_flags, [
    "nodejs_compat",
    "global_fetch_strictly_public",
  ]);
  for (const binding of [
    "r2_buckets",
    "kv_namespaces",
    "d1_databases",
    "durable_objects",
    "queues",
    "images",
  ])
    assert.equal(configuration[binding], undefined);
  assert.deepEqual(configuration.hyperdrive, [approvedHyperdriveBindings[target]]);
  assert.equal(configuration.preview_urls, false);
  assert.equal(configuration.workers_dev, target === "web");
  assert.deepEqual(configuration.observability, { enabled: true, head_sampling_rate: 1 });
  assert.deepEqual(configuration.vars, {
    ...(target === "web"
      ? {
          APP_MODE: "production",
          BEA_RUNTIME_MODE: "production",
          BEA_DISABLE_ENV_FILE: "true",
          NODE_ENV: "production",
          APP_BASE_URL: "https://cpl-command-center.astarrett.workers.dev",
          CPL_HOSTING_ADAPTER: "cloudflare-opennext",
          CPL_HOSTED_ENABLED: "true",
        }
      : {}),
    CPL_DATABASE_TRANSPORT: "hyperdrive",
    CPL_PUBLIC_COMMIT: "UNPUBLISHED",
  });
  if (target === "web") {
    assert.deepEqual(configuration.alias, {
      "next/server": "./lib/cloudflare-next-response.mjs",
      "server-only": "next/dist/compiled/server-only/empty.js",
    });
    assert.deepEqual(configuration.assets, { directory: ".open-next/assets", binding: "ASSETS" });
    assert.equal(configuration.triggers, undefined);
  } else {
    assert.deepEqual(configuration.triggers, { crons: ["*/15 * * * *"] });
    assert.equal(configuration.assets, undefined);
  }
}
test("hosting configurations select the approved Hyperdrive roles and preserve storage/routing restrictions", () => {
  assert.notEqual(approvedHyperdriveBindings.web.id, approvedHyperdriveBindings.jobs.id);
  for (const target of ["web", "jobs"])
    assertHostingConfiguration(hostingConfiguration(target), target);
});

for (const target of ["web", "jobs"]) {
  const other = target === "web" ? "jobs" : "web";
  for (const [label, mutate] of [
    [
      "missing Hyperdrive binding",
      (configuration) => {
        delete configuration.hyperdrive;
      },
    ],
    [
      "duplicate Hyperdrive binding",
      (configuration) => {
        configuration.hyperdrive.push({ ...configuration.hyperdrive[0] });
      },
    ],
    [
      "swapped role binding",
      (configuration) => {
        configuration.hyperdrive = [{ ...approvedHyperdriveBindings[other] }];
      },
    ],
    [
      "unknown resource ID",
      (configuration) => {
        configuration.hyperdrive[0].id = "f".repeat(32);
      },
    ],
    [
      "wrong resource ID type",
      (configuration) => {
        configuration.hyperdrive[0].id = 123;
      },
    ],
    [
      "unknown extra binding",
      (configuration) => {
        configuration.hyperdrive.push({ binding: "OTHER_DB", id: "f".repeat(32) });
      },
    ],
    [
      "local origin override",
      (configuration) => {
        configuration.hyperdrive[0].localConnectionString = "synthetic-local-endpoint";
      },
    ],
    [
      "missing transport selector",
      (configuration) => {
        delete configuration.vars.CPL_DATABASE_TRANSPORT;
      },
    ],
    [
      "direct transport selector",
      (configuration) => {
        configuration.vars.CPL_DATABASE_TRANSPORT = "direct";
      },
    ],
    [
      "wrong selector type",
      (configuration) => {
        configuration.vars.CPL_DATABASE_TRANSPORT = true;
      },
    ],
    [
      "unapproved storage",
      (configuration) => {
        configuration.r2_buckets = [];
      },
    ],
    [
      "preview URLs",
      (configuration) => {
        configuration.preview_urls = true;
      },
    ],
    [
      "unpublished commit override",
      (configuration) => {
        configuration.vars.CPL_PUBLIC_COMMIT = published.commit;
      },
    ],
    [
      "plaintext database credential",
      (configuration) => {
        configuration.vars.DATABASE_URL = "synthetic-private";
      },
    ],
  ])
    test(`${target} configuration rejects ${label}`, () => {
      const configuration = hostingConfiguration(target);
      mutate(configuration);
      assert.throws(() => assertHostingConfiguration(configuration, target));
    });
}
test("Hyperdrive activation retains the exact jobs cron and disabled jobs HTTP", () => {
  for (const change of [
    { workers_dev: true },
    { triggers: { crons: ["*/5 * * * *"] } },
    { triggers: { crons: ["*/15 * * * *", "*/15 * * * *"] } },
  ])
    assert.throws(() =>
      assertHostingConfiguration({ ...hostingConfiguration("jobs"), ...change }, "jobs"),
    );
});
