import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGliteDatabaseAdapter } from "../../packages/database/src/pglite-adapter";
import { migrateDatabase } from "../../packages/database/src/migrations";
import { SqlCplHostedAuthStore } from "../../packages/database/src/hosted-auth-store";

// Disposable in-memory SQL evidence only; this is not live PostgreSQL/RLS or
// Hyperdrive acceptance. Apply the real migrations without any business seed.
let database: PGliteDatabaseAdapter;
let store: SqlCplHostedAuthStore;
const now = "2026-09-22T20:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
beforeAll(async () => {
  database = new PGliteDatabaseAdapter();
  await migrateDatabase(database);
  store = new SqlCplHostedAuthStore(database);
}, 60_000);
afterAll(async () => {
  await database?.close();
});
async function signIn() {
  const subject = randomUUID(),
    tokenHash = hash(randomUUID());
  const session = await store.createSession({
    now,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email: "synthetic@example.invalid",
      emailVerified: true,
      hostedDomain: null,
      displayName: "Synthetic Test Identity",
      authenticatedAt: now,
      expiresAt: "2026-09-22T21:00:00.000Z",
    },
    material: {
      tokenHash,
      csrfTokenHash: hash(randomUUID()),
      expiresAt: "2026-09-22T21:00:00.000Z",
      absoluteExpiresAt: "2026-09-23T04:00:00.000Z",
    },
  });
  return { session, tokenHash };
}
async function addCredential(identityId: string) {
  await database.query(
    "INSERT INTO cpl_webauthn_credentials (id,identity_id,public_key,counter,transports_json,device_type,backed_up) VALUES ($1,$2,$3,0,'[\"internal\"]','singleDevice',FALSE)",
    [randomUUID(), identityId, "synthetic-public-key"],
  );
}
describe("fresh SQL session and passkey existence in one transaction", () => {
  it("returns only a boolean, scoped to the active session identity", async () => {
    const left = await signIn(),
      right = await signIn();
    await addCredential(right.session.identityId);
    expect(await store.readSessionWithPasskey(left.tokenHash, now)).toEqual({
      session: left.session,
      hasPasskey: false,
    });
    expect((await store.readSessionWithPasskey(right.tokenHash, now))?.hasPasskey).toBe(true);
    await addCredential(left.session.identityId);
    const result = await store.readSessionWithPasskey(left.tokenHash, now);
    expect(result?.hasPasskey).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-public-key");
    expect(await store.listCredentials(left.session.identityId)).toHaveLength(1);
    await database.query("DELETE FROM cpl_webauthn_credentials WHERE identity_id=$1", [
      left.session.identityId,
    ]);
    expect((await store.readSessionWithPasskey(left.tokenHash, now))?.hasPasskey).toBe(false);
  });
  it.each(["revoked", "suspended", "unverified", "csrf-missing", "expired", "absolute-expired"])(
    "rejects %s between the first route read and composite",
    async (condition) => {
      const user = await signIn();
      await addCredential(user.session.identityId);
      expect(await store.readSession(user.tokenHash, now)).not.toBeNull();
      let secondTime = now;
      if (condition === "revoked")
        await database.query("UPDATE cpl_sessions SET revoked_at=$2 WHERE id=$1", [
          user.session.id,
          now,
        ]);
      if (condition === "suspended")
        await database.query("UPDATE cpl_identities SET status='suspended' WHERE id=$1", [
          user.session.identityId,
        ]);
      if (condition === "unverified")
        await database.query("UPDATE cpl_identities SET email_verified=FALSE WHERE id=$1", [
          user.session.identityId,
        ]);
      if (condition === "csrf-missing")
        await database.query("UPDATE cpl_sessions SET csrf_token_hash=NULL WHERE id=$1", [
          user.session.id,
        ]);
      if (condition === "expired") secondTime = user.session.expiresAt;
      if (condition === "absolute-expired")
        await database.query("UPDATE cpl_sessions SET absolute_expires_at=$2 WHERE id=$1", [
          user.session.id,
          now,
        ]);
      expect(await store.readSessionWithPasskey(user.tokenHash, secondTime)).toBeNull();
    },
  );
  it("retains selected organization representation and rechecks membership and organization status", async () => {
    const user = await signIn(),
      organizationId = randomUUID();
    await database.query(
      "INSERT INTO cpl_organizations (id,slug,display_name) VALUES ($1,$2,'Synthetic organization')",
      [organizationId, randomUUID()],
    );
    await database.query(
      "INSERT INTO cpl_memberships (organization_id,identity_id,role) VALUES ($1,$2,'member')",
      [organizationId, user.session.identityId],
    );
    await database.query("UPDATE cpl_sessions SET selected_organization_id=$2 WHERE id=$1", [
      user.session.id,
      organizationId,
    ]);
    await addCredential(user.session.identityId);
    expect(
      (await store.readSessionWithPasskey(user.tokenHash, now))?.session.selectedOrganizationId,
    ).toBe(organizationId);
    await database.query(
      "UPDATE cpl_memberships SET status='removed' WHERE organization_id=$1 AND identity_id=$2",
      [organizationId, user.session.identityId],
    );
    expect(
      (await store.readSessionWithPasskey(user.tokenHash, now))?.session.selectedOrganizationId,
    ).toBeNull();
    await database.query(
      "UPDATE cpl_memberships SET status='active' WHERE organization_id=$1 AND identity_id=$2",
      [organizationId, user.session.identityId],
    );
    await database.query("UPDATE cpl_organizations SET status='suspended' WHERE id=$1", [
      organizationId,
    ]);
    expect(
      (await store.readSessionWithPasskey(user.tokenHash, now))?.session.selectedOrganizationId,
    ).toBeNull();
  });
  it("a credential-query failure rolls back and a later fresh read remains usable", async () => {
    const user = await signIn();
    await database.execute(
      "ALTER TABLE cpl_webauthn_credentials RENAME TO unavailable_credentials",
    );
    await expect(store.readSessionWithPasskey(user.tokenHash, now)).rejects.toThrow();
    await database.execute(
      "ALTER TABLE unavailable_credentials RENAME TO cpl_webauthn_credentials",
    );
    expect(await store.readSessionWithPasskey(user.tokenHash, now)).toEqual({
      session: user.session,
      hasPasskey: false,
    });
  });
});
