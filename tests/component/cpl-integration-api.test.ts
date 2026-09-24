// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  mutation: vi.fn(),
  runtime: vi.fn(),
  workspace: vi.fn(),
  oauth: vi.fn(),
  credential: vi.fn(),
  receipt: vi.fn(),
  evidence: vi.fn(),
  accept: vi.fn(),
  publicForm: vi.fn(),
}));
vi.mock("@bea/database/hosted", () => ({
  SqlCplIntegrationRepository: class {
    getWorkspace = mocks.workspace;
    completeOAuth = mocks.oauth;
    getReceipt = mocks.receipt;
    getReceiptEvidence = mocks.evidence;
  },
  SqlCplInboundRepository: class {
    rotateSourceCredential = mocks.credential;
    acceptSubmission = mocks.accept;
    readPublicForm = mocks.publicForm;
  },
}));
vi.mock("@bea/database/cpl-integration-runtime", () => ({
  createCplIntegrationRuntime: mocks.runtime,
}));
vi.mock("@/lib/hosted-auth", () => ({
  withHostedRuntime: async (fn: (runtime: unknown) => Promise<unknown>) =>
    fn({ database: {}, tenants: {}, origin: "http://127.0.0.1:3400" }),
  requireHostedSession: mocks.session,
  requireHostedMutation: mocks.mutation,
}));
import { GET, POST } from "../../apps/web/app/api/cpl-integrations/[...path]/route";
import {
  GET as PUBLIC_GET,
  POST as PUBLIC_POST,
} from "../../apps/web/app/api/cpl-inbound/[...path]/route";

const organization = "10000000-0000-4000-8000-000000000001";
const record = "20000000-0000-4000-8000-000000000002";
const publicId = "synthetic_public_form_identifier_1234";
const origin = "http://127.0.0.1:3400";
function request(
  path: string,
  body?: string,
  headers: Record<string, string> = {},
  inbound = false,
) {
  return new Request(`${origin}/api/${inbound ? "cpl-inbound" : "cpl-integrations"}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-cpl-organization": organization,
      origin,
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });
}
const context = (path: string) => ({
  params: Promise.resolve({ path: path.split("?")[0]!.split("/") }),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_BASE_URL", origin);
  mocks.session.mockResolvedValue({
    sessionToken: "server-session",
    session: { selectedOrganizationId: organization },
  });
  mocks.mutation.mockImplementation(() => mocks.session());
  mocks.runtime.mockResolvedValue({ providerMode: "local_fixture" });
  mocks.workspace.mockResolvedValue({ connections: [] });
  mocks.credential.mockResolvedValue({
    keyId: "synthetic-key",
    secret: "synthetic-one-time-value",
  });
  mocks.accept.mockResolvedValue({ accepted: true, reference: "INQ-SYNTHETIC" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("integration route trust boundaries", () => {
  it("checks current session and stale company before returning integration data", async () => {
    const response = await GET(
      request("workspace", undefined, { "x-cpl-organization": "other" }),
      context("workspace"),
    );
    expect(response.status).toBe(409);
    expect(mocks.workspace).not.toHaveBeenCalled();
    mocks.session.mockRejectedValue({ code: "CPL_AUTHENTICATION_REQUIRED" });
    expect((await GET(request("workspace"), context("workspace"))).status).toBe(401);
  });
  it("requires CSRF before credential creation and never trusts extra tenant assignments", async () => {
    const path = `forms/${record}/credential`;
    const input = {
      expectedRevision: 2,
      idempotencyKey: "rotate-fixture-1",
      reason: "Synthetic sender",
    };
    mocks.mutation.mockRejectedValueOnce({ code: "CPL_CSRF_REJECTED" });
    expect((await POST(request(path, JSON.stringify(input)), context(path))).status).toBe(403);
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(
      (
        await POST(
          request(path, JSON.stringify({ ...input, organizationId: "other" })),
          context(path),
        )
      ).status,
    ).toBe(400);
    expect(mocks.credential).not.toHaveBeenCalled();
    const success = await POST(request(path, JSON.stringify(input)), context(path));
    expect(success.status).toBe(200);
    expect(success.headers.get("cache-control")).toContain("no-store");
    expect(mocks.credential).toHaveBeenCalledWith({
      ...input,
      sessionToken: "server-session",
      organizationId: organization,
      formId: record,
    });
  });
  it("callback ownership uses initiating session and state even after a company switch", async () => {
    const path = "oauth/google/callback?state=synthetic-state&code=synthetic-code";
    mocks.session.mockResolvedValue({
      sessionToken: "initiating-session",
      session: { selectedOrganizationId: null },
    });
    const response = await GET(
      request(path, undefined, { "x-cpl-organization": "other" }),
      context(path),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(origin + "/workspace");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.oauth).toHaveBeenCalledWith({
      sessionToken: "initiating-session",
      state: "synthetic-state",
      code: "synthetic-code",
    });
  });
  it.each(["&organizationId=other", "&state=second", "&error=access_denied"])(
    "rejects ambiguous or authority-bearing callback input %s",
    async (extra) => {
      const path = "oauth/google/callback?state=s&code=c" + extra;
      expect((await GET(request(path), context(path))).status).toBe(400);
      expect(mocks.oauth).not.toHaveBeenCalled();
    },
  );
  it("rejects unbounded or duplicated list parameters", async () => {
    for (const suffix of ["?limit=101", "?limit=2&limit=3", "?organizationId=other"]) {
      expect((await GET(request("workspace" + suffix), context("workspace"))).status).toBe(400);
    }
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
  it("redacts unknown provider/database failures to correlation-only diagnostics", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.receipt.mockRejectedValue({ code: "42501", message: "PRIVATE_SOURCE_AND_CREDENTIAL" });
    const path = `receipts/${record}`;
    const response = await GET(request(path), context(path));
    const result = await response.json();
    expect(response.status).toBe(503);
    expect(result).toEqual({
      code: "CPL_INTEGRATION_UNAVAILABLE",
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("PRIVATE_SOURCE_AND_CREDENTIAL");
  });
  it("serves authorized original evidence only as an inert download under the current tenant", async () => {
    const bytes = new TextEncoder().encode('{"text":"<script>hostile()</script>"}');
    mocks.evidence.mockResolvedValue({
      bytes,
      byteLength: bytes.length,
      sha256: "a".repeat(64),
      filename: `source-${record}.json`,
    });
    const path = `receipts/${record}/evidence`;
    const response = await GET(request(path), context(path));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(mocks.evidence).toHaveBeenCalledWith({
      sessionToken: "server-session",
      organizationId: organization,
      receiptId: record,
    });
  });
});

describe("anonymous durable submission HTTP boundary", () => {
  it("uses exact original bytes and server form lookup without employee identity", async () => {
    const raw =
      '{ "eventId": "synthetic-event-1", "configurationVersion": 1, "fields": {"title":"Synthetic inquiry"} }';
    const path = `forms/${publicId}`;
    const response = await PUBLIC_POST(
      request(path, raw, { "x-forwarded-for": "forged" }, true),
      context(path),
    );
    expect(response.status).toBe(202);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
    const input = mocks.accept.mock.calls[0]![0];
    expect(Buffer.from(input.rawBody).toString("utf8")).toBe(raw);
    expect(input).toMatchObject({ publicId, source: "browser_form", addressKey: "unattributed" });
    expect(input).not.toHaveProperty("organizationId");
  });
  it("does not acknowledge before source persistence completes", async () => {
    let complete!: (value: unknown) => void;
    mocks.accept.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const path = `forms/${publicId}`;
    let settled = false;
    const response = PUBLIC_POST(request(path, "{}", {}, true), context(path)).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(mocks.accept).toHaveBeenCalled());
    expect(settled).toBe(false);
    complete({ accepted: true, reference: "INQ-SYNTHETIC" });
    expect((await response).status).toBe(202);
  });
  it("rejects hostile origin, oversized body and unsigned server submissions before ingestion", async () => {
    const path = `forms/${publicId}`;
    expect(
      (
        await PUBLIC_POST(
          request(path, "{}", { origin: "https://hostile.invalid" }, true),
          context(path),
        )
      ).status,
    ).toBe(400);
    expect(
      (await PUBLIC_POST(request(path, "x".repeat(65_537), {}, true), context(path))).status,
    ).toBe(400);
    const signed = `sources/${publicId}`;
    expect((await PUBLIC_POST(request(signed, "{}", {}, true), context(signed))).status).toBe(400);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it("never exposes internal error data and uses an explicit retry delay", async () => {
    mocks.accept.mockRejectedValue({
      code: "CPL_INTEGRATION_RATE_LIMITED",
      organizationId: organization,
      leadId: record,
    });
    const path = `forms/${publicId}`;
    const response = await PUBLIC_POST(request(path, "{}", {}, true), context(path));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ code: "CPL_INBOUND_RATE_LIMITED" });
  });
  it("does not expose a form directory or accept tenant selectors", async () => {
    expect((await PUBLIC_GET(request("forms", undefined, {}, true), context("forms"))).status).toBe(
      404,
    );
    const path = `forms/${publicId}?organizationId=other`;
    expect((await PUBLIC_GET(request(path, undefined, {}, true), context(path))).status).toBe(400);
    expect(mocks.publicForm).not.toHaveBeenCalled();
  });
});
