import { describe, expect, it } from "vitest";

import {
  createPendingSetupCompletion,
  createOneTimeSetupAuthorization,
  validateSetupSubmission,
} from "../../scripts/phase134/production-setup-session.mjs";

describe("Phase 1.3.4 one-time setup authorization", () => {
  it("rejects downgrade-prone TLS preference for managed or remote PostgreSQL", () => {
    const base = {
      databaseChoice: "managed",
      databaseUrl: "postgresql://bea:secret@db.example.com/bea",
      tlsMode: "prefer",
      postgresToolsDirectory: null,
      ownerUsername: "andrew",
      password: "a strong local passphrase",
      passwordConfirmation: "a strong local passphrase",
    };
    expect(() => validateSetupSubmission(base)).toThrow(/require TLS/iu);
    expect(() => validateSetupSubmission({ ...base, databaseChoice: "existing" })).toThrow(
      /require TLS/iu,
    );
  });

  it("is single-flight, expires, and is consumed only after success", () => {
    const token = "a".repeat(43);
    const authorization = createOneTimeSetupAuthorization({ now: 1_000, ttlMs: 60_000, token });
    expect(authorization.begin(token, 2_000)).toBe(true);
    expect(authorization.begin(token, 2_001)).toBe(false);
    authorization.finish(false);
    expect(authorization.begin(token, 2_002)).toBe(true);
    authorization.finish(true);
    expect(authorization.consumed).toBe(true);
    expect(authorization.begin(token, 2_003)).toBe(false);
    expect(
      createOneTimeSetupAuthorization({ now: 1_000, ttlMs: 60_000, token }).begin(token, 61_000),
    ).toBe(false);
  });

  it("validates only the bounded PostgreSQL and Local Owner contract", () => {
    expect(
      validateSetupSubmission({
        databaseChoice: "managed",
        databaseUrl: "postgresql://bea:redacted@db.example.test/bea?sslmode=require",
        tlsMode: "verify-full",
        postgresToolsDirectory: "",
        ownerUsername: "Owner",
        password: "a strong local passphrase",
        passwordConfirmation: "a strong local passphrase",
      }),
    ).toMatchObject({
      databaseChoice: "managed",
      ownerUsername: "owner",
      postgresToolsDirectory: null,
    });
    expect(() =>
      validateSetupSubmission({
        databaseChoice: "existing",
        databaseUrl: "postgresql://bea:secret@localhost/bea",
        tlsMode: "prefer",
        ownerUsername: "andrew",
        password: "a strong local passphrase",
        passwordConfirmation: "different passphrase",
        unexpected: true,
      }),
    ).toThrow("unknown fields");
    expect(validateSetupSubmission({ databaseChoice: "dedicated-local" })).toEqual({
      databaseChoice: "dedicated-local",
    });
  });

  it("keeps the recovery code available until retryable finalization succeeds", async () => {
    let attempts = 0;
    const pending = createPendingSetupCompletion({
      recoveryCode: "bea-recovery-once",
      finalize: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient final verification failure");
      },
    });
    expect(pending.publicResult).toEqual({
      recoveryCode: "bea-recovery-once",
      acknowledgementRequired: true,
    });
    await expect(pending.finalize()).rejects.toThrow(/verification failure/iu);
    expect(pending.finalized).toBe(false);
    expect(pending.publicResult.recoveryCode).toBe("bea-recovery-once");
    await expect(pending.finalize()).resolves.toBeUndefined();
    expect(pending.finalized).toBe(true);
    expect(attempts).toBe(2);
  });
});
