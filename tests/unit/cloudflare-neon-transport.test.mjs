import { afterAll as after, beforeAll as before, it as test } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  connectionPolicy,
  createGuardedDriver,
  DRIVER_VERSION,
  LIMITS,
  TransportError,
} from "../../apps/worker/cloudflare-neon-guard.mjs";
import {
  createJobsTransport,
  DEADLINE_SQL,
  mapStageResult,
  STAGE_SQL,
} from "../../apps/worker/cloudflare-neon-jobs.mjs";

const policy = Object.freeze({
  host: "ep-synthetic-fixture.us-east-2.aws.neon.tech",
  role: "cpl_jobs_fixture",
  database: "neondb",
});
const password = "SYNTHETIC-NOT-A-REAL-PASSWORD";
// Synthetic connection data is consumed only by the guarded fetch fixture below.
const fixtureUrl = new URL(`postgresql://${policy.host}/${policy.database}?sslmode=require`);
fixtureUrl.username = policy.role;
fixtureUrl.password = password;
const connectionString = fixtureUrl.toString();
const endpoint = "https://api.us-east-2.aws.neon.tech/sql";
const leaseToken = "00000000-0000-4000-8000-000000000001";
const claim = Object.freeze({
  id: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000003",
  proposalId: "00000000-0000-4000-8000-000000000004",
  issuedByIdentityId: "00000000-0000-4000-8000-000000000005",
  proposalVersion: 2,
  issuedMembershipVersion: 1,
  attempts: 1,
  maxAttempts: 3,
});
const driverRequire = createRequire(new URL("../../apps/worker/package.json", import.meta.url));
const driverPath = driverRequire.resolve("@neondatabase/serverless");
const driverUrl = pathToFileURL(driverPath);
let originalFetch;
let refusedNetworkCalls = 0;
before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    refusedNetworkCalls += 1;
    throw new Error("REAL_NETWORK_FORBIDDEN");
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(refusedNetworkCalls, 0);
});

async function driver() {
  // Reload only the official self-contained CommonJS bundle so each test has
  // an independent SDK config singleton, without modifying production state.
  delete driverRequire.cache[driverPath];
  return driverRequire(driverPath);
}
function rawResult(value) {
  return {
    results: [
      {
        command: "SELECT",
        rowCount: 1,
        fields: [
          { name: "statement_timeout_ms", dataTypeID: 23 },
          { name: "idle_timeout_ms", dataTypeID: 23 },
        ],
        rows: [["4000", "4000"]],
      },
      {
        command: "SELECT",
        rowCount: 1,
        fields: [{ name: "result", dataTypeID: 3802 }],
        rows: [[JSON.stringify(value)]],
      },
    ],
  };
}
function response(value = { status: "empty" }) {
  return Response.json(rawResult(value));
}
async function setup(fetchImplementation, overrides = {}) {
  const actual = await driver();
  const requests = [];
  const configuration = {
    driver: actual,
    version: DRIVER_VERSION,
    connectionString,
    policy,
    fetchImplementation: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return fetchImplementation ? fetchImplementation(url, options, requests.length) : response();
    },
    ...overrides,
  };
  const transport = createJobsTransport(configuration);
  return {
    actual,
    transport,
    requests,
    invocation: (options = {}) =>
      transport.invocation({
        owner: "local:synthetic",
        leaseToken,
        ...options,
      }),
  };
}
const assertPrivate = (error) => {
  assert.ok(error instanceof TransportError);
  const fields = JSON.stringify(error, Object.getOwnPropertyNames(error));
  assert.ok(!fields.includes(password));
  assert.ok(!fields.includes(connectionString));
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.equal(Object.hasOwn(error, "detail"), false);
  return true;
};

test("published driver and worker dependency are pinned exactly to1.1.0", () => {
  const metadata = JSON.parse(readFileSync(new URL("./package.json", driverUrl)));
  const worker = JSON.parse(
    readFileSync(new URL("../../apps/worker/package.json", import.meta.url)),
  );
  assert.equal(metadata.version, DRIVER_VERSION);
  assert.equal(metadata.engines.node, ">=19.0.0");
  assert.equal(metadata.dependencies, undefined);
  assert.equal(worker.dependencies["@neondatabase/serverless"], DRIVER_VERSION);
});

test("strict origin policy produces exactly the pinned official HTTPS endpoint", () => {
  assert.deepEqual(connectionPolicy(connectionString, policy), { endpoint });
  assert.throws(
    () => connectionPolicy(connectionString.replace("?sslmode=require", ":unused"), policy),
    assertPrivate,
  );
});

for (const [label, change] of [
  ["HTTP URL", (url) => url.replace("postgresql:", "http:")],
  ["lookalike endpoint", (url) => url.replace("neon.tech", "neon.tech.attacker.test")],
  ["different Neon endpoint", (url) => url.replace("ep-synthetic-fixture", "ep-another-fixture")],
  ["different role", (url) => url.replace(policy.role, "cpl_web_fixture")],
  ["different database", (url) => url.replace("/neondb", "/other")],
  ["nonstandard port", (url) => url.replace("/neondb", ":5433/neondb")],
  ["missing TLS mode", (url) => url.replace("?sslmode=require", "")],
  ["disabled TLS mode", (url) => url.replace("sslmode=require", "sslmode=disable")],
  ["duplicate TLS mode", (url) => `${url}&sslmode=require`],
  ["unknown option", (url) => `${url}&options=arbitrary`],
  ["fragment", (url) => `${url}#fragment`],
  ["control in password", (url) => url.replace(password, "synthetic%0A")],
])
  test(`rejects ${label} without revealing URL`, () => {
    assert.throws(() => connectionPolicy(change(connectionString), policy), assertPrivate);
  });

test("real driver sends only deadline then fixed parameterized claim and parses int4/JSONB", async () => {
  const context = await setup();
  const invocation = context.invocation();
  assert.deepEqual(await invocation.claim(), { status: "empty" });
  assert.equal(context.requests.length, 1);
  const request = context.requests[0];
  assert.equal(request.url, endpoint);
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.credentials, "omit");
  assert.deepEqual(request.body, {
    queries: [
      { query: DEADLINE_SQL, params: [] },
      { query: STAGE_SQL.claim, params: ["local:synthetic", leaseToken] },
    ],
  });
  assert.deepEqual(invocation.status(), { state: "done", requests: 1 });
  await assert.rejects(invocation.process(), assertPrivate);
  await assert.rejects(invocation.claim(), assertPrivate);
  assert.equal(context.requests.length, 1);
});

test("claimed and completed stages are separate requests and preserve all eight claim fields", async () => {
  const context = await setup((_url, _options, count) =>
    response(count === 1 ? { status: "claimed", claim } : { status: "completed" }),
  );
  const invocation = context.invocation();
  const selected = await invocation.claim();
  assert.deepEqual(selected, { status: "claimed", claim });
  assert.ok(Object.isFrozen(selected.claim));
  assert.deepEqual(await invocation.process(), { status: "completed" });
  assert.equal(context.requests.length, 2);
  assert.deepEqual(context.requests[1].body.queries[1], {
    query: STAGE_SQL.process,
    params: [JSON.stringify(selected.claim), leaseToken],
  });
  await assert.rejects(invocation.retry(), assertPrivate);
});

test("exhausted and superseded outcomes are recognized without extra requests", async () => {
  const exhausted = await setup(() => response({ status: "exhausted", id: claim.id }));
  assert.deepEqual(await exhausted.invocation().claim(), {
    status: "exhausted",
    id: claim.id,
  });
  const superseded = await setup((_url, _options, count) =>
    response(count === 1 ? { status: "claimed", claim } : { status: "superseded" }),
  );
  const invocation = superseded.invocation();
  await invocation.claim();
  assert.deepEqual(await invocation.process(), { status: "superseded" });
});

test("confirmed server error permits only an explicit third retry request, never automatic replay", async () => {
  const context = await setup((_url, _options, count) =>
    count === 2
      ? Response.json(
          {
            code: "P0001",
            message: "CPL_JOB_AUTHORIZATION_REVOKED",
            detail: connectionString,
          },
          { status: 400 },
        )
      : response(count === 1 ? { status: "claimed", claim } : { status: "failed" }),
  );
  const invocation = context.invocation();
  await invocation.claim();
  await assert.rejects(invocation.process(), (error) => {
    assertPrivate(error);
    assert.equal(error.outcome, "SERVER_REPORTED_ERROR");
    assert.equal(error.databaseCode, "CPL_JOB_AUTHORIZATION_REVOKED");
    return true;
  });
  assert.equal(context.requests.length, 2);
  assert.deepEqual(await invocation.retry(), { status: "failed" });
  assert.deepEqual(context.requests[2].body.queries[1].params.slice(1), [
    leaseToken,
    "CPL_JOB_AUTHORIZATION_REVOKED",
  ]);
  await assert.rejects(invocation.retry(), assertPrivate);
  assert.equal(context.requests.length, 3);
});

test("generic SQL errors expose only SQLSTATE and map to the existing bounded processing-failed retry", async () => {
  const context = await setup((_url, _options, count) =>
    count === 2
      ? Response.json(
          {
            code: "22012",
            message: connectionString,
            detail: password,
            internalQuery: password,
          },
          { status: 400 },
        )
      : response(count === 1 ? { status: "claimed", claim } : { status: "queued" }),
  );
  const invocation = context.invocation();
  await invocation.claim();
  await assert.rejects(invocation.process(), (error) => {
    assertPrivate(error);
    assert.equal(error.sqlstate, "22012");
    assert.equal(error.databaseCode, null);
    return true;
  });
  assert.deepEqual(await invocation.retry(), { status: "queued" });
  assert.equal(context.requests[2].body.queries[1].params[2], "CPL_JOB_PROCESSING_FAILED");
});

for (const code of [
  null,
  "00000",
  "01000",
  "02000",
  "08006",
  "08007",
  "40003",
  "57P01",
  "57P02",
  "57P03",
  "57014",
  "P0001",
  "23505",
  "XX000",
  "invalid",
]) {
  test(`ambiguous or invalid HTTP400 SQLSTATE ${String(code)} cannot enable retry`, async () => {
    const context = await setup((_url, _options, count) =>
      count === 1
        ? response({ status: "claimed", claim })
        : Response.json({ code, message: password, detail: connectionString }, { status: 400 }),
    );
    const invocation = context.invocation();
    await invocation.claim();
    await assert.rejects(invocation.process(), (error) => {
      assertPrivate(error);
      assert.equal(error.outcome, "UNKNOWN");
      assert.equal(error.sqlstate, null);
      return true;
    });
    await assert.rejects(invocation.retry(), assertPrivate);
    assert.equal(context.requests.length, 2);
  });
}

for (const code of ["40001", "40P01"]) {
  test(`reviewed transaction rollback ${code} permits only explicit fenced retry`, async () => {
    const context = await setup((_url, _options, count) =>
      count === 2
        ? Response.json({ code, message: password }, { status: 400 })
        : response(count === 1 ? { status: "claimed", claim } : { status: "queued" }),
    );
    const invocation = context.invocation();
    await invocation.claim();
    await assert.rejects(invocation.process(), (error) => {
      assertPrivate(error);
      assert.equal(error.outcome, "SERVER_REPORTED_ERROR");
      assert.equal(error.sqlstate, code);
      return true;
    });
    assert.equal(context.requests.length, 2);
    assert.deepEqual(await invocation.retry(), { status: "queued" });
    assert.equal(context.requests.length, 3);
    assert.equal(context.requests[2].body.queries[1].params[2], "CPL_JOB_PROCESSING_FAILED");
  });
}

test("claim result cannot expand the server's three-attempt budget", async () => {
  const context = await setup(() =>
    response({ status: "claimed", claim: { ...claim, maxAttempts: 4 } }),
  );
  await assert.rejects(context.invocation().claim(), assertPrivate);
  assert.equal(context.requests.length, 1);
});

for (const code of [
  "CPL_JOB_LEASE_LOST",
  "CPL_HOSTED_DATABASE_ROLE_REFUSED",
  "CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED",
])
  test(`does not retry ${code}`, async () => {
    const context = await setup((_url, _options, count) =>
      count === 1
        ? response({ status: "claimed", claim })
        : Response.json({ code: "P0001", message: code }, { status: 400 }),
    );
    const invocation = context.invocation();
    await invocation.claim();
    await assert.rejects(invocation.process(), assertPrivate);
    await assert.rejects(invocation.retry(), assertPrivate);
    assert.equal(context.requests.length, 2);
  });

for (const [label, make] of [
  [
    "redirect",
    () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.test" },
      }),
  ],
  ["HTTP500", () => new Response(connectionString, { status: 500 })],
  ["HTML", () => new Response(password, { headers: { "content-type": "text/html" } })],
  ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
  [
    "oversize declared body",
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(LIMITS.responseBytes + 1),
        },
      }),
  ],
  [
    "oversize streamed body",
    () =>
      new Response("x".repeat(LIMITS.responseBytes + 1), {
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "too many rows",
    () => {
      const value = rawResult({ status: "empty" });
      value.results[1].rows.push(["{}"]);
      return Response.json(value);
    },
  ],
  [
    "duplicate result column",
    () => {
      const value = rawResult({ status: "empty" });
      value.results[1].fields.push(value.results[1].fields[0]);
      value.results[1].rows[0].push("{}");
      return Response.json(value);
    },
  ],
  [
    "wrong deadline",
    () => {
      const value = rawResult({ status: "empty" });
      value.results[0].rows[0][0] = "0";
      return Response.json(value);
    },
  ],
  ["extra status field", () => response({ status: "empty", leaked: password })],
  [
    "string numeric claim",
    () => response({ status: "claimed", claim: { ...claim, attempts: "1" } }),
  ],
  ["null claim", () => response({ status: "claimed", claim: null })],
  ["excessive attempts", () => response({ status: "claimed", claim: { ...claim, attempts: 4 } })],
])
  test(`fails closed on ${label}, with no automatic follow-up`, async () => {
    const context = await setup(make);
    const invocation = context.invocation();
    await assert.rejects(invocation.claim(), (error) => {
      assertPrivate(error);
      assert.equal(error.outcome, "UNKNOWN");
      return true;
    });
    await assert.rejects(invocation.claim(), assertPrivate);
    await assert.rejects(invocation.process(), assertPrivate);
    assert.equal(context.requests.length, 1);
  });

test("wait timeout is UNKNOWN after dispatch and cancels a stalled synthetic response reader", async () => {
  let canceled = 0;
  const context = await setup(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled += 1;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const invocation = context.invocation({ timeoutMs: 20 });
  await assert.rejects(invocation.claim(), (error) => {
    assertPrivate(error);
    assert.equal(error.code, "CPL_NEON_WAIT_ABORTED");
    assert.equal(error.outcome, "UNKNOWN");
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(canceled, 1);
  assert.equal(context.requests[0].options.signal.aborted, true);
  await assert.rejects(invocation.process(), assertPrivate);
  await assert.rejects(invocation.retry(), assertPrivate);
});

test("a stalled fetch cannot extend the caller wait or cause a second dispatch", async () => {
  const context = await setup(() => new Promise(() => {}));
  const invocation = context.invocation({ timeoutMs: 10 });
  await assert.rejects(invocation.claim(), (error) => {
    assertPrivate(error);
    assert.equal(error.outcome, "UNKNOWN");
    return true;
  });
  assert.equal(context.requests.length, 1);
});

test("a late response after timeout is canceled without being accepted or replayed", async () => {
  let release;
  let canceled = 0;
  const context = await setup(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const invocation = context.invocation({ timeoutMs: 10 });
  await assert.rejects(invocation.claim(), assertPrivate);
  release(
    new Response(
      new ReadableStream({
        cancel() {
          canceled += 1;
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(canceled, 1);
  assert.deepEqual(invocation.status(), { state: "stopped", requests: 1 });
});

test("refused response metadata still cancels its unread body", async () => {
  let canceled = 0;
  const context = await setup(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled += 1;
          },
        }),
        { status: 500 },
      ),
  );
  await assert.rejects(context.invocation().claim(), assertPrivate);
  assert.equal(canceled, 1);
});

test("empty-frame response flooding is bounded and canceled", async () => {
  let canceled = 0;
  const context = await setup(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array());
          },
          cancel() {
            canceled += 1;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(context.invocation().claim(), assertPrivate);
  assert.equal(canceled, 1);
  assert.equal(context.requests.length, 1);
});

test("rejects overlapping stage calls and shares no invocation state", async () => {
  let release;
  const context = await setup(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const invocation = context.invocation();
  const pending = invocation.claim();
  await assert.rejects(invocation.claim(), assertPrivate);
  await assert.rejects(invocation.process(), assertPrivate);
  release(response());
  await pending;
  assert.deepEqual(context.invocation().status(), {
    state: "new",
    requests: 0,
  });
});

test("driver fetch configuration drift is rejected before dispatch", async () => {
  const context = await setup();
  context.actual.neonConfig.fetchEndpoint = () => "https://attacker.test/sql";
  await assert.rejects(context.invocation().claim(), assertPrivate);
  assert.equal(context.requests.length, 0);
});

test("oversize requests and altered supported-driver fetch options never dispatch", async () => {
  const actual = await driver();
  let sent = 0;
  const guarded = createGuardedDriver({
    driver: actual,
    version: DRIVER_VERSION,
    connectionString,
    policy,
    fetchImplementation: async () => {
      sent += 1;
      return response();
    },
  });
  await assert.rejects(
    guarded.transaction([
      { query: DEADLINE_SQL, params: [] },
      { query: STAGE_SQL.claim, params: ["x".repeat(9000), leaseToken] },
    ]),
    assertPrivate,
  );
  assert.equal(sent, 0);
  const underlying = await driver();
  const altered = {
    neonConfig: underlying.neonConfig,
    neon: (...args) => {
      const sql = underlying.neon(...args);
      return {
        query: sql.query,
        transaction: (queries, options) =>
          sql.transaction(queries, {
            ...options,
            fetchOptions: { ...options.fetchOptions, redirect: "follow" },
          }),
      };
    },
  };
  const second = createGuardedDriver({
    driver: altered,
    version: DRIVER_VERSION,
    connectionString,
    policy,
    fetchImplementation: async () => {
      sent += 1;
      return response();
    },
  });
  await assert.rejects(
    second.transaction([
      { query: DEADLINE_SQL, params: [] },
      { query: STAGE_SQL.claim, params: ["synthetic", leaseToken] },
    ]),
    assertPrivate,
  );
  assert.equal(sent, 0);
});

test("raw SDK errors never escape and a driver bypassing guarded fetch cannot fabricate success", async () => {
  const actual = await driver();
  const context = await setup(undefined, {
    driver: {
      neonConfig: actual.neonConfig,
      neon: () => {
        throw new Error(connectionString);
      },
    },
  });
  await assert.rejects(context.invocation().claim(), assertPrivate);
  const other = await driver();
  const bypass = await setup(undefined, {
    driver: {
      neonConfig: other.neonConfig,
      neon: () => ({
        query() {},
        transaction: async () => [{ rows: [], command: "SELECT", rowCount: 0 }],
      }),
    },
  });
  await assert.rejects(bypass.invocation().claim(), assertPrivate);
  assert.equal(bypass.requests.length, 0);
});

test("mapper rejects unparsed JSON, noninteger deadlines, extra rows and arbitrary stages", () => {
  const good = [
    {
      command: "SELECT",
      rowCount: 1,
      rows: [{ statement_timeout_ms: 4000, idle_timeout_ms: 4000 }],
    },
    { command: "SELECT", rowCount: 1, rows: [{ result: { status: "empty" } }] },
  ];
  assert.deepEqual(mapStageResult("claim", good), { status: "empty" });
  assert.throws(() => mapStageResult("arbitrary", good), assertPrivate);
  for (const mutate of [
    (value) => {
      value[1].rows[0].result = JSON.stringify({ status: "empty" });
    },
    (value) => {
      value[0].rows[0].statement_timeout_ms = "4000";
    },
    (value) => {
      value[1].rows.push(value[1].rows[0]);
    },
  ]) {
    const value = structuredClone(good);
    mutate(value);
    assert.throws(() => mapStageResult("claim", value), assertPrivate);
  }
});
