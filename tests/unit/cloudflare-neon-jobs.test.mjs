import { it as test } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHostedJobsDispatcher } from "../../apps/worker/cloudflare-jobs-dispatcher.mjs";
import {
  createNeonHttpScheduledHandler,
  JOBS_HTTP_CONTRACT,
  HOSTED_HTTP_JOB_LIMIT,
} from "../../apps/worker/cloudflare-neon-scheduler.mjs";
import { configureHostedRuntimeRole } from "../../packages/database/src/hosted-database-role.ts";
const password = "SYNTHETIC-CANDIDATE-ONLY";
// Synthetic connection data stays inside injected transport doubles.
const fixtureUrl = new URL(
  "postgresql://ep-synthetic.us-east-2.aws.neon.tech/neondb?sslmode=require",
);
fixtureUrl.username = "cpl_worker_runtime";
fixtureUrl.password = password;
const environment = {
  CPL_JOBS_TRANSPORT: "neon-http",
  CPL_JOBS_HTTP_CONTRACT: JOBS_HTTP_CONTRACT,
  CPL_NEON_JOBS_HOST: "ep-synthetic.us-east-2.aws.neon.tech",
  CPL_NEON_JOBS_DATABASE: "neondb",
  CPL_WORKER_DATABASE_URL: fixtureUrl.toString(),
};
const blank = { claimed: 0, completed: 0, retried: 0, failed: 0 };
function fixture({
  claim = "empty",
  processError = false,
  state = "stopped",
  retry = "queued",
  loadError = false,
} = {}) {
  const calls = {
    driver: 0,
    factory: 0,
    invocations: [],
    claim: 0,
    process: 0,
    retry: 0,
    info: [],
    error: [],
  };
  const handler = createNeonHttpScheduledHandler({
    loadDriver: async () => {
      calls.driver++;
      if (loadError) throw Error(password);
      return {};
    },
    createTransport: () => {
      calls.factory++;
      return {
        invocation(options) {
          calls.invocations.push(options);
          return {
            async claim() {
              calls.claim++;
              return { status: claim };
            },
            async process() {
              calls.process++;
              if (processError) throw Error(password);
              return { status: "completed" };
            },
            status() {
              return { state };
            },
            async retry() {
              calls.retry++;
              return { status: retry };
            },
          };
        },
      };
    },
    identifier: randomUUID,
    logger: {
      info: (value) => calls.info.push(value),
      error: (value) => calls.error.push(value),
    },
  });
  return { handler, calls };
}
for (const legacyTransport of [undefined, "direct", "hyperdrive"])
  test(`unset jobs selector delegates unchanged legacy ${String(legacyTransport)} without HTTP load`, async () => {
    let legacyLoads = 0,
      httpLoads = 0;
    const env = { CPL_DATABASE_TRANSPORT: legacyTransport };
    const handler = createHostedJobsDispatcher({
      loadLegacy: async () => {
        legacyLoads++;
        return {
          createHostedScheduledHandler: () => async (_event, received) => {
            assert.equal(received, env);
            return blank;
          },
        };
      },
      loadHttp: async () => {
        httpLoads++;
        throw Error("unexpected");
      },
    });
    assert.deepEqual(await handler({}, env), blank);
    assert.deepEqual(await handler({}, env), blank);
    assert.equal(legacyLoads, 1);
    assert.equal(httpLoads, 0);
  });
test("legacy failures never load or fall back to HTTPS", async () => {
  let http = 0;
  const handler = createHostedJobsDispatcher({
    loadLegacy: async () => ({
      createHostedScheduledHandler: () => async () => {
        throw Error("legacy refusal");
      },
    }),
    loadHttp: async () => {
      http++;
    },
  });
  await assert.rejects(handler({}, {}), /legacy refusal/);
  assert.equal(http, 0);
});
for (const selected of ["", null, "direct", "unknown", 0])
  test(`unknown explicit jobs selector ${String(selected)} fails without imports`, async () => {
    let loaded = 0;
    const load = async () => {
      loaded++;
    };
    const handler = createHostedJobsDispatcher({
      loadLegacy: load,
      loadHttp: load,
    });
    await assert.rejects(handler({}, { CPL_JOBS_TRANSPORT: selected }), /TRANSPORT_REFUSED/);
    assert.equal(loaded, 0);
  });
test("explicit Hyperdrive refuses mismatched legacy selection before loading", async () => {
  let loaded = 0;
  const handler = createHostedJobsDispatcher({
    loadLegacy: async () => {
      loaded++;
    },
  });
  await assert.rejects(
    handler({}, { CPL_JOBS_TRANSPORT: "hyperdrive", CPL_DATABASE_TRANSPORT: "direct" }),
    /TRANSPORT_REFUSED/,
  );
  assert.equal(loaded, 0);
});
test("explicit HTTPS imports only its selected handler and caches its factory", async () => {
  let http = 0,
    legacy = 0;
  const handler = createHostedJobsDispatcher({
    loadHttp: async () => {
      http++;
      return { createNeonHttpScheduledHandler: () => async () => blank };
    },
    loadLegacy: async () => {
      legacy++;
    },
  });
  await handler({}, environment);
  await handler({}, environment);
  assert.equal(http, 1);
  assert.equal(legacy, 0);
});
test("HTTPS load rejection is cached and never falls back", async () => {
  let http = 0,
    legacy = 0;
  const handler = createHostedJobsDispatcher({
    loadHttp: async () => {
      http++;
      throw Error("HTTP_REFUSED");
    },
    loadLegacy: async () => {
      legacy++;
    },
  });
  await assert.rejects(handler({}, environment), /HTTP_REFUSED/);
  await assert.rejects(handler({}, environment), /HTTP_REFUSED/);
  assert.equal(http, 1);
  assert.equal(legacy, 0);
});
test("concurrent invocations share only initialized factory, with distinct claims/leases and fixed logs", async () => {
  const { handler, calls } = fixture();
  const results = await Promise.all([handler({}, environment), handler({}, environment)]);
  assert.deepEqual(results, [blank, blank]);
  assert.equal(calls.driver, 1);
  assert.equal(calls.factory, 1);
  assert.equal(calls.invocations.length, 2);
  assert.notEqual(calls.invocations[0].leaseToken, calls.invocations[1].leaseToken);
  assert.notEqual(calls.invocations[0].owner, calls.invocations[1].owner);
  assert.equal(calls.claim, 2);
  assert.equal(calls.process, 0);
  assert.equal(HOSTED_HTTP_JOB_LIMIT, 1);
  for (const log of calls.info)
    assert.deepEqual(JSON.parse(log), {
      code: "CPL_HOSTED_JOBS_COMPLETE",
      ...blank,
    });
});
for (const changed of [
  { CPL_JOBS_HTTP_CONTRACT: "wrong" },
  { CPL_JOBS_TRANSPORT: "hyperdrive" },
  { CPL_WEB_DB: {} },
  { CPL_NEON_JOBS_HOST: undefined },
  { CPL_NEON_JOBS_DATABASE: undefined },
  { CPL_WORKER_DATABASE_URL: undefined },
])
  test(`HTTP configuration gate refuses ${Object.keys(changed)[0]} before driver init`, async () => {
    const { handler, calls } = fixture();
    await assert.rejects(handler({}, { ...environment, ...changed }), /CPL_HOSTED_JOBS_FAILED/);
    assert.equal(calls.driver, 0);
    assert.deepEqual(calls.error, [JSON.stringify({ code: "CPL_HOSTED_JOBS_FAILED" })]);
  });
for (const changed of [
  {
    CPL_WORKER_DATABASE_URL: environment.CPL_WORKER_DATABASE_URL + "&changed=true",
  },
  { CPL_NEON_JOBS_HOST: "ep-other.us-east-2.aws.neon.tech" },
  { CPL_NEON_JOBS_DATABASE: "other" },
])
  test(`initialized SDK refuses later ${Object.keys(changed)[0]} drift`, async () => {
    const { handler, calls } = fixture();
    await handler({}, environment);
    await assert.rejects(handler({}, { ...environment, ...changed }), /CPL_HOSTED_JOBS_FAILED/);
    assert.equal(calls.driver, 1);
    assert.equal(calls.claim, 1);
    assert.ok(!calls.error.join().includes(password));
  });
test("driver initialization failure is cached and sanitized", async () => {
  const { handler, calls } = fixture({ loadError: true });
  await assert.rejects(handler({}, environment), /CPL_HOSTED_JOBS_FAILED/);
  await assert.rejects(handler({}, environment), /CPL_HOSTED_JOBS_FAILED/);
  assert.equal(calls.driver, 1);
  assert.ok(!calls.error.join().includes(password));
});
test("empty/exhausted/completed results preserve original one-job counts", async () => {
  for (const [claim, result] of [
    ["empty", blank],
    ["exhausted", { ...blank, claimed: 1, failed: 1 }],
    ["claimed", { ...blank, claimed: 1, completed: 1 }],
  ]) {
    const { handler, calls } = fixture({ claim });
    assert.deepEqual(await handler({}, environment), result);
    assert.equal(calls.claim, 1);
    assert.equal(calls.process, claim === "claimed" ? 1 : 0);
    assert.equal(calls.retry, 0);
  }
});
for (const retry of ["queued", "failed"])
  test(`only explicit retryable state commits one separate ${retry} retry`, async () => {
    const { handler, calls } = fixture({
      claim: "claimed",
      processError: true,
      state: "retryable",
      retry,
    });
    assert.deepEqual(await handler({}, environment), {
      ...blank,
      claimed: 1,
      [retry === "failed" ? "failed" : "retried"]: 1,
    });
    assert.equal(calls.claim, 1);
    assert.equal(calls.process, 1);
    assert.equal(calls.retry, 1);
  });
test("unknown/lease/role failure states stop without retry or completion log", async () => {
  const { handler, calls } = fixture({
    claim: "claimed",
    processError: true,
    state: "stopped",
  });
  await assert.rejects(handler({}, environment), /CPL_HOSTED_JOBS_FAILED/);
  assert.equal(calls.retry, 0);
  assert.equal(calls.info.length, 0);
  assert.ok(!calls.error.join().includes(password));
});
function grantDatabase(contractRows) {
  const calls = [];
  const tx = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith("SELECT rolsuper"))
        return {
          rows: [
            {
              rolsuper: false,
              rolbypassrls: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolreplication: false,
            },
          ],
        };
      if (sql.includes("WITH expected(name")) return { rows: contractRows };
      return { rows: [] };
    },
    async execute(sql) {
      calls.push(sql);
    },
  };
  return {
    calls,
    database: {
      kind: "postgres",
      async transaction(operation) {
        return operation(tx);
      },
    },
  };
}
test("fresh fixed worker grant requires accepted exact function catalog contract", async () => {
  const { database, calls } = grantDatabase([{ contract_valid: true }]);
  await configureHostedRuntimeRole(database, "cpl_worker_runtime", "worker");
  assert.ok(calls.some((sql) => sql.includes("GRANT USAGE ON SCHEMA cpl_jobs_http")));
  const contract = calls.find((sql) => sql.includes("WITH expected(name"));
  for (const predicate of [
    "p.proowner=n.nspowner",
    "NOT p.prosecdef",
    "p.oid=to_regprocedure(e.signature)",
    "encode(sha256(convert_to(p.prosrc",
  ])
    assert.ok(contract.includes(predicate));
});
test("unexpected existing function owner/body/flags contract refuses fresh grant", async () => {
  for (const rows of [
    [{ contract_valid: false }],
    [{ contract_valid: null }],
    [{ contract_valid: true }, { contract_valid: true }],
  ]) {
    const { database, calls } = grantDatabase(rows);
    await assert.rejects(
      configureHostedRuntimeRole(database, "cpl_worker_runtime", "worker"),
      /FUNCTION_CONTRACT_REFUSED/,
    );
    assert.ok(!calls.some((sql) => sql.includes("GRANT USAGE ON SCHEMA cpl_jobs_http")));
  }
});
test("absent HTTP schema and other runtime roles receive no HTTP function grant", async () => {
  for (const [name, purpose] of [
    ["cpl_worker_runtime", "worker"],
    ["cpl_fixture_worker", "worker"],
    ["cpl_web_runtime", "web"],
  ]) {
    const { database, calls } = grantDatabase([]);
    await configureHostedRuntimeRole(database, name, purpose);
    assert.ok(!calls.some((sql) => sql.includes("GRANT USAGE ON SCHEMA cpl_jobs_http")));
    if (name !== "cpl_worker_runtime")
      assert.ok(
        !calls.some(
          (sql) => sql.includes("WITH expected(name") && sql.includes("n.nspname='cpl_jobs_http'"),
        ),
      );
    // Web roles check their separate session capability; that is not a jobs grant.
    if (name === "cpl_web_runtime")
      assert.ok(
        calls.some(
          (sql) =>
            sql.includes("WITH expected(name") && sql.includes("n.nspname='cpl_session_http'"),
        ),
      );
  }
});
