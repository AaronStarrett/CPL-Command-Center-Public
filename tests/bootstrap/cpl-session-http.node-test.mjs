import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createSessionTransport,
  sessionReadTransport,
  DEADLINE_SQL,
  READ_SQL,
  PASSKEY_SQL,
} from "../../apps/web/lib/session-http.mjs";
import { TransportError, DRIVER_VERSION } from "../../apps/web/lib/guarded-session-driver.mjs";
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const driverUrl = new URL(
  "./index.mjs",
  pathToFileURL(webRequire.resolve("@neondatabase/serverless")),
);
const policy = {
  host: "ep-synthetic-fixture.us-east-2.aws.neon.tech",
  role: "cpl_web_runtime",
  database: "neondb",
};
const url = new URL(`postgresql://${policy.host}/neondb?sslmode=require`);
url.username = policy.role;
url.password = "SYNTHETIC-NOT-A-REAL-PASSWORD";
const connectionString = url.href;
export const now = "2026-09-23T02:00:00.000Z",
  tokenHash = "a".repeat(64);
export const session = Object.freeze({
  id: "00000000-0000-4000-8000-000000000001",
  identityId: "00000000-0000-4000-8000-000000000002",
  issuer: "https://accounts.google.com",
  subject: "synthetic",
  email: "synthetic@example.invalid",
  displayName: "Synthetic",
  createdAt: now,
  authenticatedAt: now,
  expiresAt: "2026-09-23T03:00:00.000Z",
  absoluteExpiresAt: "2026-09-23T10:00:00.000Z",
  mfaVerifiedAt: null,
  selectedOrganizationId: null,
  csrfTokenHash: "b".repeat(64),
  platformAdministrator: false,
});
let originalFetch,
  realRequests = 0;
before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    realRequests++;
    throw Error("NETWORK_FORBIDDEN");
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(realRequests, 0);
});
const raw = (value) => ({
  results: [
    {
      command: "SELECT",
      rowCount: 1,
      fields: [
        { name: "statement_timeout_ms", dataTypeID: 23 },
        { name: "idle_timeout_ms", dataTypeID: 23 },
      ],
      rows: [["15000", "15000"]],
    },
    {
      command: "SELECT",
      rowCount: 1,
      fields: [{ name: "result", dataTypeID: 3802 }],
      rows: [[value === null ? null : JSON.stringify(value)]],
    },
  ],
});
const safe = (e) => {
  assert.ok(e instanceof TransportError);
  const printed = JSON.stringify(e, Object.getOwnPropertyNames(e));
  assert.ok(!printed.includes(url.password));
  assert.ok(!printed.includes(connectionString));
  assert.ok(!Object.hasOwn(e, "cause"));
  return true;
};
async function setup(
  reply = (_u, _o, n) => Response.json(raw(n === 1 ? session : { session, hasPasskey: true })),
  overrides = {},
) {
  const driver = await import(`${driverUrl.href}?isolated=${randomUUID()}`),
    requests = [];
  const transport = createSessionTransport({
    driver,
    version: DRIVER_VERSION,
    policy,
    connectionString,
    fetchImplementation: async (u, o) => {
      requests.push({ u, o, body: JSON.parse(o.body) });
      return reply(u, o, requests.length);
    },
    ...overrides,
  });
  return { transport, requests, driver, reader: transport.invocation() };
}
test("selector defaults to unchanged runtime and accepts only explicit HTTP", () => {
  assert.equal(sessionReadTransport(), "hyperdrive");
  assert.equal(sessionReadTransport("hyperdrive"), "hyperdrive");
  assert.equal(sessionReadTransport("neon-http"), "neon-http");
  for (const v of ["", null, "direct", "NEON-HTTP", true])
    assert.throws(() => sessionReadTransport(v), safe);
});
test("real SDK emits exactly two fresh read-only ReadCommitted batches with fixed15s deadlines", async () => {
  const s = await setup();
  assert.deepEqual(await s.reader.readSession(tokenHash, now), session);
  assert.deepEqual(await s.reader.readSessionWithPasskey(tokenHash, now), {
    session,
    hasPasskey: true,
  });
  assert.equal(s.requests.length, 2);
  for (const [r, index] of s.requests.map((r, i) => [r, i])) {
    assert.equal(r.u, "https://api.us-east-2.aws.neon.tech/sql");
    const h = new Headers(r.o.headers);
    assert.equal(h.get("neon-batch-read-only"), "true");
    assert.equal(h.get("neon-batch-isolation-level"), "ReadCommitted");
    assert.equal(r.o.redirect, "error");
    assert.equal(r.o.cache, "no-store");
    assert.equal(r.o.credentials, "omit");
    assert.deepEqual(r.body, {
      queries: [
        { query: DEADLINE_SQL, params: [] },
        { query: index ? PASSKEY_SQL : READ_SQL, params: [tokenHash, now] },
      ],
    });
    assert.equal(r.o.signal.aborted, true);
  }
  assert.deepEqual(s.reader.status(), { state: "done", requests: 2 });
});
test("SQL NULL is unauthenticated and prevents second request", async () => {
  const s = await setup(() => Response.json(raw(null)));
  assert.equal(await s.reader.readSession(tokenHash, now), null);
  await assert.rejects(s.reader.readSessionWithPasskey(tokenHash, now), safe);
  assert.equal(s.requests.length, 1);
});
test("revocation between reads is fresh NULL, never cached first session", async () => {
  const s = await setup((_u, _o, n) => Response.json(raw(n === 1 ? session : null)));
  await s.reader.readSession(tokenHash, now);
  assert.equal(await s.reader.readSessionWithPasskey(tokenHash, now), null);
  assert.equal(s.requests.length, 2);
});
test("second read may update membership and credential representation", async () => {
  const updated = {
    ...session,
    selectedOrganizationId: "00000000-0000-4000-8000-000000000003",
  };
  const s = await setup((_u, _o, n) =>
    Response.json(raw(n === 1 ? session : { session: updated, hasPasskey: false })),
  );
  await s.reader.readSession(tokenHash, now);
  assert.deepEqual(await s.reader.readSessionWithPasskey(tokenHash, now), {
    session: updated,
    hasPasskey: false,
  });
});
test("email fallback display name up to254 characters remains representable", async () => {
  const email = "a".repeat(241) + "@example.test",
    value = { ...session, email, displayName: email };
  assert.equal(email.length, 254);
  const s = await setup(() => Response.json(raw(value)));
  assert.deepEqual(await s.reader.readSession(tokenHash, now), value);
});
test("standalone second, repeated first, third and switched token are refused without I/O", async () => {
  const s = await setup();
  await assert.rejects(s.reader.readSessionWithPasskey(tokenHash, now), safe);
  await s.reader.readSession(tokenHash, now);
  await assert.rejects(s.reader.readSession(tokenHash, now), safe);
  await assert.rejects(s.reader.readSessionWithPasskey("c".repeat(64), now), safe);
  await s.reader.readSessionWithPasskey(tokenHash, now);
  await assert.rejects(s.reader.readSessionWithPasskey(tokenHash, now), safe);
  assert.equal(s.requests.length, 2);
});
for (const [label, hash, time] of [
  ["hash", tokenHash + "x", now],
  ["uppercase", "A".repeat(64), now],
  ["date", tokenHash, "invalid"],
  ["noncanonical", tokenHash, "2026-09-23"],
  ["null", null, now],
])
  test(`invalid ${label} input is sanitized before request`, async () => {
    const s = await setup();
    await assert.rejects(s.reader.readSession(hash, time), safe);
    assert.equal(s.requests.length, 0);
  });
for (const [label, mutate] of [
  ["extra", (s) => ({ ...s, secret: "excluded" })],
  [
    "missing",
    (s) => {
      delete s.subject;
      return s;
    },
  ],
  ["boolean", (s) => ({ ...s, platformAdministrator: "true" })],
  ["uuid", (s) => ({ ...s, identityId: "bad" })],
  ["csrf", (s) => ({ ...s, csrfTokenHash: "bad" })],
  ["expiry", (s) => ({ ...s, expiresAt: "not-date" })],
  ["email", (s) => ({ ...s, email: null })],
])
  test(`malformed ${label} response fails closed without retry`, async () => {
    const s = await setup(() => Response.json(raw(mutate({ ...session }))));
    await assert.rejects(s.reader.readSession(tokenHash, now), safe);
    await assert.rejects(s.reader.readSession(tokenHash, now), safe);
    assert.equal(s.requests.length, 1);
  });
test("passkey must be exact boolean without credential fields", async () => {
  const s = await setup((_u, _o, n) =>
    Response.json(raw(n === 1 ? session : { session, hasPasskey: true, credentials: [] })),
  );
  await s.reader.readSession(tokenHash, now);
  await assert.rejects(s.reader.readSessionWithPasskey(tokenHash, now), safe);
});
test("deadline readback mismatch is UNKNOWN", async () => {
  const s = await setup(() => {
    const r = raw(session);
    r.results[0].rows[0][0] = "0";
    return Response.json(r);
  });
  await assert.rejects(
    s.reader.readSession(tokenHash, now),
    (e) => safe(e) && e.outcome === "UNKNOWN",
  );
});
test("transport HTTP500 does not retry or fallback and does not expose body", async () => {
  const s = await setup(() => new Response(connectionString, { status: 500 }));
  await assert.rejects(s.reader.readSession(tokenHash, now), safe);
  assert.equal(s.requests.length, 1);
});
test("fixed server role failure is reported safely and closes read sequence", async () => {
  const s = await setup(() =>
    Response.json(
      {
        code: "P0001",
        message: "CPL_HOSTED_DATABASE_ROLE_REFUSED",
        detail: connectionString,
      },
      { status: 400 },
    ),
  );
  await assert.rejects(
    s.reader.readSession(tokenHash, now),
    (e) =>
      safe(e) &&
      e.outcome === "SERVER_REPORTED_ERROR" &&
      e.databaseCode === "CPL_HOSTED_DATABASE_ROLE_REFUSED",
  );
  await assert.rejects(s.reader.readSessionWithPasskey(tokenHash, now), safe);
  assert.equal(s.requests.length, 1);
});
test("uncertain cancellation is UNKNOWN, never replayed", async () => {
  const s = await setup(() =>
    Response.json({ code: "57014", message: connectionString }, { status: 400 }),
  );
  await assert.rejects(
    s.reader.readSession(tokenHash, now),
    (e) => safe(e) && e.outcome === "UNKNOWN",
  );
  assert.equal(s.requests.length, 1);
});
test("oversized responses are rejected before mapping", async () => {
  const s = await setup(
    () =>
      new Response("x".repeat(32769), {
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(s.reader.readSession(tokenHash, now), safe);
});
test("close during in-flight response withholds session and future work", async () => {
  let release;
  const s = await setup(() => new Promise((resolve) => (release = resolve)));
  const work = s.reader.readSession(tokenHash, now);
  await new Promise((resolve) => setImmediate(resolve));
  s.reader.close();
  release(Response.json(raw(session)));
  await assert.rejects(work, safe);
  await assert.rejects(s.reader.readSession(tokenHash, now), safe);
});
test("overlapping calls on one reader are refused before an extra request", async () => {
  let release;
  const s = await setup(() => new Promise((resolve) => (release = resolve)));
  const first = s.reader.readSession(tokenHash, now);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(s.reader.readSession(tokenHash, now), safe);
  release(Response.json(raw(session)));
  await first;
  assert.equal(s.requests.length, 1);
});
test("same configured facade permits isolated concurrent request states", async () => {
  const s = await setup(() => Response.json(raw(session)));
  const a = s.transport.invocation(),
    b = s.transport.invocation();
  const values = await Promise.all([
    a.readSession(tokenHash, now),
    b.readSession("c".repeat(64), now),
  ]);
  assert.deepEqual(values, [session, session]);
  assert.equal(s.requests.length, 2);
  a.close();
  assert.equal(b.status().state, "first-complete");
});
test("deadline abort is bounded and later calls cannot retry", async () => {
  const s = await setup(
    (_u, o) =>
      new Promise((_r, fail) =>
        o.signal.addEventListener("abort", () => fail(Error(connectionString)), { once: true }),
      ),
  );
  const reader = s.transport.invocation({ timeoutMs: 20 });
  await assert.rejects(
    reader.readSession(tokenHash, now),
    (e) => safe(e) && e.outcome === "UNKNOWN",
  );
  await assert.rejects(reader.readSession(tokenHash, now), safe);
  assert.equal(s.requests.length, 1);
});
for (const [label, change] of [
  ["role", (c) => ({ ...c, policy: { ...policy, role: "cpl_worker_runtime" } })],
  [
    "host",
    (c) => ({
      ...c,
      policy: { ...policy, host: "ep-other.us-east-2.aws.neon.tech" },
    }),
  ],
  ["database", (c) => ({ ...c, policy: { ...policy, database: "other" } })],
  [
    "TLS",
    (c) => ({
      ...c,
      connectionString: connectionString.replace("sslmode=require", "sslmode=disable"),
    }),
  ],
])
  test(`origin ${label} mismatch refuses before I/O`, async () => {
    await assert.rejects(setup(undefined, change({ policy, connectionString })), safe);
  });
test("SDK configuration drift fails before I/O", async () => {
  const s = await setup();
  s.driver.neonConfig.fetchEndpoint = () => "https://example.invalid";
  await assert.rejects(s.reader.readSession(tokenHash, now), safe);
  assert.equal(s.requests.length, 0);
});
