import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  assertDemoResetAllowed,
  DEMO_RESET_CONFIRMATION,
  DemoResetRefusedError,
} from "../../packages/database/src/index.js";
import {
  createLogger,
  redactSensitive,
  toSafeErrorDetails,
} from "../../packages/observability/src/index.js";
import { verifyHmacSha256Webhook } from "../../packages/security/src/index.js";
import {
  createAllowlistedChildEnvironment,
  sanitizeFailureOutput,
} from "../../scripts/web-startup-smoke.js";

describe("security and observability guards", () => {
  it("refuses production and unconfirmed demo reset", () => {
    expect(() =>
      assertDemoResetAllowed({
        appMode: "production",
        nodeEnv: "production",
        confirmation: DEMO_RESET_CONFIRMATION,
      }),
    ).toThrow(DemoResetRefusedError);
    expect(() =>
      assertDemoResetAllowed({ appMode: "demo", nodeEnv: "development", confirmation: "" }),
    ).toThrow(DemoResetRefusedError);
    expect(() =>
      assertDemoResetAllowed({
        appMode: "demo",
        nodeEnv: "test",
        confirmation: DEMO_RESET_CONFIRMATION,
      }),
    ).not.toThrow();
  });
  it("redacts nested tokens, cookies, credentials, and secrets", () => {
    expect(
      redactSensitive({
        token: "sensitive",
        nested: { apiKey: "sensitive", safe: "visible" },
        cookie: "sensitive",
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "visible" },
      cookie: "[REDACTED]",
    });
  });
  it("recursively redacts nested bindings in actual logger and child output", () => {
    const output: string[] = [];
    const logger = createLogger({
      service: "redaction-test",
      environment: "test",
      level: "info",
      destination: {
        write: (chunk) => {
          output.push(chunk);
        },
      },
    });
    logger.info(
      {
        outer: {
          inner: {
            token: "nested-token-value",
            credential: "nested-credential-value",
            safe: "visible",
          },
        },
      },
      "nested test",
    );
    logger
      .child({ context: { password: "child-password-value", safe: "child-visible" } })
      .info({ payload: { api_key: "nested-api-key-value" } }, "child test");

    const serialized = output.join("");
    expect(serialized).not.toContain("nested-token-value");
    expect(serialized).not.toContain("nested-credential-value");
    expect(serialized).not.toContain("child-password-value");
    expect(serialized).not.toContain("nested-api-key-value");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("visible");
    expect(serialized).toContain("child-visible");
  });
  it("reuses default-destination loggers across repeated module initialization", async () => {
    const initialExitListeners = process.listenerCount("exit");
    const initialBeforeExitListeners = process.listenerCount("beforeExit");
    const initializedLoggers: ReturnType<typeof createLogger>[] = [];

    for (let initialization = 0; initialization < 20; initialization += 1) {
      vi.resetModules();
      const reloadedModule = await import("../../packages/observability/src/logger.js");
      initializedLoggers.push(
        reloadedModule.createLogger({
          service: "hot-reload-lifecycle-test",
          environment: "test",
          level: "silent",
        }),
      );
    }

    expect(new Set(initializedLoggers).size).toBe(1);
    expect(process.listenerCount("exit")).toBeLessThanOrEqual(initialExitListeners + 1);
    expect(process.listenerCount("beforeExit")).toBeLessThanOrEqual(initialBeforeExitListeners + 1);

    const reloadedModule = await import("../../packages/observability/src/logger.js");
    const differentEnvironment = reloadedModule.createLogger({
      service: "hot-reload-lifecycle-test",
      environment: "development",
      level: "silent",
    });
    const differentLevel = reloadedModule.createLogger({
      service: "hot-reload-lifecycle-test",
      environment: "test",
      level: "debug",
    });
    expect(differentEnvironment).not.toBe(initializedLoggers[0]);
    expect(differentLevel).not.toBe(initializedLoggers[0]);
  });
  it("keeps caller-supplied logger destinations isolated", () => {
    const firstOutput: string[] = [];
    const secondOutput: string[] = [];
    const firstLogger = createLogger({
      service: "destination-isolation-test",
      environment: "test",
      destination: { write: (chunk) => firstOutput.push(chunk) },
    });
    const secondLogger = createLogger({
      service: "destination-isolation-test",
      environment: "test",
      destination: { write: (chunk) => secondOutput.push(chunk) },
    });

    expect(secondLogger).not.toBe(firstLogger);
    firstLogger.info({ source: "first" }, "first destination");
    secondLogger.info({ source: "second" }, "second destination");
    expect(firstOutput.join("")).toContain("first destination");
    expect(firstOutput.join("")).not.toContain("second destination");
    expect(secondOutput.join("")).toContain("second destination");
    expect(secondOutput.join("")).not.toContain("first destination");
  });
  it("reduces sentinel-bearing CLI failures to stable safe name and code fields", () => {
    const failure = Object.assign(
      new Error("postgresql://owner:private-sentinel@database.example.invalid/bea"),
      { code: "DRIVER_CONNECTION_FAILED" },
    );
    const details = toSafeErrorDetails(failure, "COMMAND_FAILED");
    expect(details).toEqual({ errorName: "Error", errorCode: "DRIVER_CONNECTION_FAILED" });
    expect(JSON.stringify(details)).not.toContain("private-sentinel");
  });
  it("allowlists smoke child environment values and recursively bounds failure output", () => {
    const childEnvironment = createAllowlistedChildEnvironment(
      {
        Path: "C:\\Windows\\System32",
        DATABASE_URL: "postgresql://private-database.example.invalid/bea",
        SESSION_SECRET: "private-parent-session-value",
      },
      {
        NODE_ENV: "production",
        SESSION_SECRET: "explicit-smoke-sentinel",
      },
    );
    expect(childEnvironment).toMatchObject({
      Path: "C:\\Windows\\System32",
      NODE_ENV: "production",
      SESSION_SECRET: "explicit-smoke-sentinel",
    });
    expect(childEnvironment.DATABASE_URL).toBeUndefined();

    const structured = sanitizeFailureOutput(
      {
        nested: {
          token: "nested-token-value",
          visible: "safe",
          child: { cookie: "nested-cookie-value" },
        },
      },
      [],
      160,
    );
    expect(structured).not.toContain("nested-token-value");
    expect(structured).not.toContain("nested-cookie-value");
    expect(structured).toContain("[REDACTED]");
    expect(structured.length).toBeLessThanOrEqual(160);

    const malformed = sanitizeFailureOutput(
      '{"token":"malformed-token-value","nested":{"password":"malformed-password-value"',
      ["explicit-smoke-sentinel"],
      120,
    );
    expect(malformed).not.toContain("malformed-token-value");
    expect(malformed).not.toContain("malformed-password-value");
    expect(malformed).not.toContain("explicit-smoke-sentinel");
    expect(malformed.length).toBeLessThanOrEqual(120);
  });
  it("verifies webhook signatures and rejects missing or changed payloads", () => {
    const rawBody = new TextEncoder().encode('{"synthetic":true}');
    const signingKey = "not-a-secret-example.invalid";
    const signatureHeader = `sha256=${createHmac("sha256", signingKey).update(rawBody).digest("hex")}`;
    expect(verifyHmacSha256Webhook({ rawBody, signatureHeader, secret: signingKey })).toEqual({
      valid: true,
    });
    expect(
      verifyHmacSha256Webhook({
        rawBody: new TextEncoder().encode("changed"),
        signatureHeader,
        secret: signingKey,
      }),
    ).toMatchObject({ valid: false, reason: "signature-mismatch" });
    expect(
      verifyHmacSha256Webhook({ rawBody, signatureHeader: undefined, secret: signingKey }),
    ).toMatchObject({ valid: false, reason: "missing-signature" });
  });
});
