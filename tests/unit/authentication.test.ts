import { describe, expect, it } from "vitest";
import {
  DemoAuthenticationAdapter,
  AuthenticationUnavailableError,
} from "../../packages/security/src/index.js";
import {
  FixedClock,
  InMemoryAuditSink,
  InMemorySessionStore,
  InMemoryUserDirectory,
} from "../../packages/testing/src/index.js";

const tokens = {
  createSessionId: () => "90000000-0000-4000-8000-000000000001",
  createSessionToken: () => "deterministic-test-token-not-a-secret",
};

describe("demo authentication", () => {
  it("creates, authenticates, and revokes a server-side session", async () => {
    const sessions = new InMemorySessionStore();
    const audit = new InMemoryAuditSink();
    const adapter = new DemoAuthenticationAdapter(
      { appMode: "demo", enabled: true, sessionTtlMinutes: 60, secureCookies: false },
      new InMemoryUserDirectory(),
      sessions,
      audit,
      new FixedClock(),
      tokens,
    );
    const signIn = await adapter.signIn("sales-specialist", "correlation-test");
    expect(signIn.user.roleIds).toEqual(["sales"]);
    expect(signIn.session.tokenHash).not.toContain(signIn.sessionToken);
    expect(await adapter.authenticate(signIn.sessionToken)).toMatchObject({
      personaKey: "sales-specialist",
    });
    expect(await adapter.signOut(signIn.sessionToken)).toBe(true);
    expect(await adapter.authenticate(signIn.sessionToken)).toBeNull();
    expect(audit.events.map((event) => event.eventType)).toEqual([
      "authentication.signed-in",
      "authentication.signed-out",
    ]);
  });
  it("cannot activate in production mode", async () => {
    const adapter = new DemoAuthenticationAdapter(
      { appMode: "production", enabled: false, sessionTtlMinutes: 60, secureCookies: true },
      new InMemoryUserDirectory(),
      new InMemorySessionStore(),
      new InMemoryAuditSink(),
      new FixedClock(),
      tokens,
    );
    await expect(adapter.signIn("owner-administrator")).rejects.toBeInstanceOf(
      AuthenticationUnavailableError,
    );
  });
  it("refuses persona switching without an active current session and audits the denial", async () => {
    const audit = new InMemoryAuditSink();
    const adapter = new DemoAuthenticationAdapter(
      { appMode: "demo", enabled: true, sessionTtlMinutes: 60, secureCookies: false },
      new InMemoryUserDirectory(),
      new InMemorySessionStore(),
      audit,
      new FixedClock(),
      tokens,
    );
    await expect(
      adapter.switchPersona("invalid-session-token", "operations-coordinator"),
    ).rejects.toBeInstanceOf(AuthenticationUnavailableError);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      eventType: "authentication.persona-switch-denied",
      outcome: "denied",
    });
  });
});
