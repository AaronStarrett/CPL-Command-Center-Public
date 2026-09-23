import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readLocalDevelopmentConfiguration,
  assertLocalDevelopmentRequest,
  signLocalSessionCookie,
  verifyLocalSessionCookie,
} from "../../packages/security/src/local-development-auth";
import { assertNoLocalDevelopmentConfiguration } from "../../scripts/local-development-policy.mjs";
import configurationForPhase from "../../apps/web/next.config";
import { spawnSync } from "node:child_process";
import { runNextWithoutRepositoryEnv } from "../../scripts/next-no-env.mjs";
import { NextRequest } from "next/server";
import { proxy } from "../../apps/web/proxy";

const origin = "http://127.0.0.1:3400";
const environment = {
  NODE_ENV: "test",
  CPL_LOCAL_DEVELOPMENT_AUTH: "true",
  APP_BASE_URL: origin,
  CPL_LOCAL_DATABASE_URL:
    "postgresql://cpl_local_web:synthetic@127.0.0.1:55433/cpl_local_development",
  CPL_LOCAL_SESSION_SECRET: "a".repeat(43),
};
beforeEach(() => {
  for (const name of [
    "DATABASE_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "CPL_HOSTED_ENABLED",
    "CPL_HOSTED_BUILD",
    "CPL_DATABASE_TRANSPORT",
    "CPL_SESSION_READ_TRANSPORT",
  ])
    vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
});
afterEach(() => vi.unstubAllEnvs());
function request(method = "GET", headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/auth/local/sign-in`, {
    method,
    headers: { host: "127.0.0.1:3400", origin, ...headers },
  });
}
describe("strict local development identity boundary", () => {
  it("accepts only the explicit local configuration and exact request origin", () => {
    expect(readLocalDevelopmentConfiguration().origin).toBe(origin);
    expect(() => assertLocalDevelopmentRequest(request("POST"))).not.toThrow();
  });
  it("accepts actual NextRequest loopback canonicalization only with the exact original Host and Origin", () => {
    const next = new NextRequest(origin + "/api/auth/local/sign-in", {
      method: "POST",
      headers: { host: "127.0.0.1:3400", origin, "sec-fetch-site": "same-origin" },
    });
    expect(new URL(next.url).hostname).toBe("localhost");
    expect(() => assertLocalDevelopmentRequest(next)).not.toThrow();
    next.headers.set("host", "localhost:3400");
    expect(() => assertLocalDevelopmentRequest(next)).toThrow();
    next.headers.set("host", "127.0.0.1:3400");
    next.headers.set("origin", "http://localhost:3400");
    expect(() => assertLocalDevelopmentRequest(next)).toThrow();
  });
  it("local proxy redirects retain the configured numeric Host after Next normalizes its URL", () => {
    vi.stubEnv("NODE_ENV", "development");
    const input = new NextRequest(origin + "/", { headers: { host: "127.0.0.1:3400" } });
    expect(proxy(input).headers.get("location")).toBe(origin + "/workspace");
    input.headers.set("host", "localhost:3400");
    expect(proxy(input).status).toBe(503);
  });
  it.each([
    ["NODE_ENV", "production"],
    ["CPL_LOCAL_DEVELOPMENT_AUTH", "false"],
    ["CPL_HOSTED_ENABLED", "true"],
    ["CPL_HOSTED_BUILD", "true"],
    ["DATABASE_URL", "postgresql://remote.invalid/production"],
    ["GOOGLE_CLIENT_ID", "synthetic"],
    ["GOOGLE_CLIENT_SECRET", "synthetic"],
    ["CPL_DATABASE_TRANSPORT", "hyperdrive"],
    ["CPL_SESSION_READ_TRANSPORT", "neon-http"],
    ["APP_BASE_URL", "https://127.0.0.1:3400"],
    ["APP_BASE_URL", "http://localhost:3400"],
    ["APP_BASE_URL", "http://127.0.0.1.evil.invalid:3400"],
    [
      "CPL_LOCAL_DATABASE_URL",
      environment.CPL_LOCAL_DATABASE_URL.replace("127.0.0.1", "remote.invalid"),
    ],
    ["CPL_LOCAL_DATABASE_URL", environment.CPL_LOCAL_DATABASE_URL.replace("55433", "55432")],
    [
      "CPL_LOCAL_DATABASE_URL",
      environment.CPL_LOCAL_DATABASE_URL.replace("cpl_local_web", "postgres"),
    ],
    [
      "CPL_LOCAL_DATABASE_URL",
      environment.CPL_LOCAL_DATABASE_URL.replace("cpl_local_development", "production"),
    ],
    ["CPL_LOCAL_DATABASE_URL", environment.CPL_LOCAL_DATABASE_URL + "?options=-c%20role=postgres"],
    ["CPL_LOCAL_SESSION_SECRET", "short"],
  ])("refuses unsafe %s configuration", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => readLocalDevelopmentConfiguration()).toThrow("CPL_LOCAL_DEVELOPMENT_REFUSED");
  });
  it("a supplied test environment cannot override the real production process", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => readLocalDevelopmentConfiguration(environment)).toThrow();
  });
  it.each([
    { host: "evil.invalid" },
    { origin: "https://evil.invalid" },
    { "sec-fetch-site": "cross-site" },
  ])("refuses hostile browser context %j", (headers) => {
    expect(() => assertLocalDevelopmentRequest(request("POST", headers))).toThrow();
  });
  it("requires mutation Origin and ignores spoofed forwarded host", () => {
    const missing = request("POST");
    missing.headers.delete("origin");
    expect(() => assertLocalDevelopmentRequest(missing)).toThrow();
    const remote = new Request("http://evil.invalid:3400/", {
      headers: { host: "evil.invalid:3400", "x-forwarded-host": "127.0.0.1:3400" },
    });
    expect(() => assertLocalDevelopmentRequest(remote)).toThrow();
  });
  it("signs only opaque sessions and rejects tampering, raw tokens and prior-launch secrets", () => {
    const token = "b".repeat(43),
      signed = signLocalSessionCookie(token);
    expect(verifyLocalSessionCookie(signed)).toBe(token);
    expect(verifyLocalSessionCookie(token)).toBeUndefined();
    expect(verifyLocalSessionCookie("c" + signed.slice(1))).toBeUndefined();
    vi.stubEnv("CPL_LOCAL_SESSION_SECRET", "d".repeat(43));
    expect(verifyLocalSessionCookie(signed)).toBeUndefined();
  });
  it.each(["CPL_LOCAL_DEVELOPMENT_AUTH", "CPL_LOCAL_DATABASE_URL", "CPL_LOCAL_SESSION_SECRET"])(
    "production policy refuses even empty or false %s",
    (key) => {
      for (const value of ["", "false", "synthetic"])
        expect(() => assertNoLocalDevelopmentConfiguration({ [key]: value })).toThrow(
          "CPL_LOCAL_DEVELOPMENT_PRODUCTION_REFUSED",
        );
    },
  );
  it("Next production phases refuse the fixture even with a development NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => configurationForPhase("phase-development-server")).not.toThrow();
    expect(() => configurationForPhase("phase-production-build")).toThrow();
    expect(() => configurationForPhase("phase-production-server")).toThrow();
  });
  it("outer build wrapper refuses fixture flags before Turbo can filter its child environment", () => {
    const child = spawnSync(
      process.execPath,
      ["scripts/run-guarded.mjs", "cpl-test-do-not-execute", "exec", "turbo", "run", "build"],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "development" },
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      },
    );
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("CPL_LOCAL_DEVELOPMENT_PRODUCTION_REFUSED");
    expect(child.stderr).not.toContain("Guarded command could not start");
  });
  it.each(["build", "start"])(
    "direct Next %s refuses before environment priming or CLI import",
    async (command) => {
      const prime = vi.fn(),
        load = vi.fn();
      await expect(
        runNextWithoutRepositoryEnv([command], {
          environment: { ...environment, NODE_ENV: "development" },
          assertBoundary: () => ({ ok: true }),
          primeEnvironment: prime,
          importNextCli: load,
        }),
      ).rejects.toThrow("CPL_LOCAL_DEVELOPMENT_PRODUCTION_REFUSED");
      expect(prime).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    },
  );
});
