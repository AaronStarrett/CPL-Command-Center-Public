import { describe, expect, it } from "vitest";
import {
  commercialBody,
  commercialInteger,
  commercialString,
  commercialTenant,
  commercialVersion,
} from "../../apps/web/lib/cpl-commercial-http";

const current = {
  sessionToken: "synthetic-session",
  session: { selectedOrganizationId: "selected-company" },
} as Parameters<typeof commercialTenant>[0];
function request(
  query = "",
  headers: Record<string, string> = { "x-cpl-organization": "selected-company" },
) {
  return new Request(`http://127.0.0.1:3400/api/cpl-commercial/proposals/test/pdf${query}`, {
    headers,
  });
}
describe("commercial HTTP scope and input boundary", () => {
  it("uses the authenticated organization and refuses stale or forged context", () => {
    expect(commercialTenant(current, request())).toEqual({
      sessionToken: "synthetic-session",
      organizationId: "selected-company",
    });
    expect(() => commercialTenant(current, request("", {}))).toThrow(
      "CPL_ORGANIZATION_CONTEXT_CHANGED",
    );
    expect(() =>
      commercialTenant(current, request("", { "x-cpl-organization": "other-company" })),
    ).toThrow("CPL_ORGANIZATION_CONTEXT_CHANGED");
    expect(() =>
      commercialTenant(
        { ...current, session: { ...current.session, selectedOrganizationId: null } },
        request(),
      ),
    ).toThrow("CPL_ORGANIZATION_REQUIRED");
  });
  it("accepts a context query only on download and rejects duplicate or conflicting queries", () => {
    expect(
      commercialTenant(current, request("?organization=selected-company", {}), true).organizationId,
    ).toBe("selected-company");
    expect(() => commercialTenant(current, request("?organization=selected-company"))).toThrow();
    expect(() =>
      commercialTenant(
        current,
        request("?organization=selected-company&organization=selected-company"),
        true,
      ),
    ).toThrow();
    expect(() => commercialTenant(current, request("?organization=other-company"), true)).toThrow();
  });
  it("requires positive integer version syntax without duplicates or coercion", () => {
    expect(commercialVersion(request())).toBeUndefined();
    expect(commercialVersion(request("?version=12"))).toBe(12);
    for (const query of [
      "?version=0",
      "?version=-1",
      "?version=1.1",
      "?version=1e2",
      "?version=01",
      "?version=1&version=2",
      "?version=9999999999",
    ])
      expect(() => commercialVersion(request(query))).toThrow();
  });
  it("refuses caller-controlled tenant/session fields and invalid JSON bodies", async () => {
    const make = (body: string, contentType = "application/json") =>
      new Request("http://127.0.0.1/api", {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
    await expect(commercialBody(make('{"title":"Scope"}'), ["title"])).resolves.toEqual({
      title: "Scope",
    });
    for (const body of [
      '{"organizationId":"forged"}',
      '{"sessionToken":"forged"}',
      '{"__proto__":{}}',
      "[]",
      "null",
      '"text"',
      "{",
    ])
      await expect(commercialBody(make(body), ["title"])).rejects.toMatchObject({
        code: "CPL_INVALID_INPUT",
      });
    await expect(commercialBody(make("{}", "text/plain"), [])).rejects.toMatchObject({
      code: "CPL_INVALID_INPUT",
    });
  });
  it("bounds streamed bytes even when no content-length is supplied", async () => {
    const large = new Request("http://127.0.0.1/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "a".repeat(300) }),
    });
    await expect(commercialBody(large, ["title"], 128)).rejects.toMatchObject({
      code: "CPL_INVALID_INPUT",
    });
  });
  it("rejects malformed UTF-8 instead of replacing customer-facing content", async () => {
    const malformed = new Request("http://127.0.0.1/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    });
    await expect(commercialBody(malformed, ["t"])).rejects.toMatchObject({
      code: "CPL_INVALID_INPUT",
    });
  });
  it("does not coerce revision tokens or optional strings", () => {
    expect(commercialInteger({ revision: 2 }, "revision")).toBe(2);
    for (const revision of [0, -1, "1", 1.2, undefined])
      expect(() => commercialInteger({ revision }, "revision")).toThrow();
    expect(commercialString({}, "note", true)).toBe("");
    expect(() => commercialString({ note: null }, "note", true)).toThrow();
  });
});
