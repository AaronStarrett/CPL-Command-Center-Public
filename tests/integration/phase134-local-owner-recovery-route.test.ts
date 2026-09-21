import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../../packages/config/src/index.js";
import {
  PGliteDatabaseAdapter,
  SqlAiProviderRepository,
  SqlFoundationRepository,
  SqlLocalOwnerAccountStore,
  migrateDatabase,
  seedSystemDatabase,
  type BeaServerRuntime,
} from "../../packages/database/src/index.js";
import { LocalOwnerAuthenticationAdapter } from "../../packages/security/src/index.js";
import { FixedClock } from "../../packages/testing/src/index.js";
import { handleLocalOwnerRecovery } from "../../apps/web/lib/local-owner-recovery.js";

vi.mock("server-only", () => ({}));

let database: PGliteDatabaseAdapter | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

const environment = parseEnvironment({
  NODE_ENV: "production",
  APP_MODE: "production",
  BEA_DEPLOYMENT_PROFILE: "local-live",
  BEA_AUTH_PROVIDER: "local-owner",
  APP_BASE_URL: "https://bea.localhost:3443",
  DATABASE_DRIVER: "postgres",
  DATABASE_URL: "postgresql://bea.invalid/command_center",
  DEMO_AUTH_ENABLED: "false",
  SESSION_SECRET: "phase134-recovery-route-session-secret-".padEnd(80, "x"),
  WORKER_MODE: "serve",
  WORKER_QUEUE_ADAPTER: "pg-boss",
  WORKER_HEALTH_PORT: "3001",
  LOG_LEVEL: "silent",
});

function recoveryRequest(
  values: Readonly<Record<string, string>>,
  origin: string | null = environment.appBaseUrl,
): Request {
  const body = new URLSearchParams(values).toString();
  const headers = new Headers({
    "content-length": String(Buffer.byteLength(body, "utf8")),
    "content-type": "application/x-www-form-urlencoded",
    "sec-fetch-site": "same-origin",
  });
  if (origin !== null) headers.set("origin", origin);
  return new Request(new URL("/api/auth/recover", environment.appBaseUrl), {
    method: "POST",
    headers,
    body,
  });
}

describe("Phase 1.3.4 Local Owner recovery route", () => {
  it("requires strict origin, rotates recovery once, revokes sessions, and returns no-store output", async () => {
    database = new PGliteDatabaseAdapter("memory://");
    await migrateDatabase(database);
    await seedSystemDatabase(database);
    const repository = new SqlFoundationRepository(database);
    const authentication = new LocalOwnerAuthenticationAdapter(
      {
        deploymentProfile: "local-live",
        sessionSecret: environment.sessionSecret as string,
        sessionTtlMinutes: 60,
      },
      repository,
      new SqlLocalOwnerAccountStore(database),
      repository,
      new FixedClock("2026-08-24T13:00:00.000Z"),
    );
    const provisioned = await authentication.provisionOwner(
      "andrew.owner",
      "Original Local Owner passphrase 2026!",
    );
    const runtime = {
      environment,
      authentication,
      repository,
      ai: { persistence: new SqlAiProviderRepository(database) },
    } as unknown as Pick<BeaServerRuntime, "environment" | "authentication" | "repository" | "ai">;
    const form = {
      username: "andrew.owner",
      recoveryCode: provisioned.recoveryCode,
      newPassword: "Recovered Local Owner passphrase 2026!",
      confirmPassword: "Recovered Local Owner passphrase 2026!",
    };

    const crossOrigin = await handleLocalOwnerRecovery(
      recoveryRequest(form, "https://attacker.example"),
      runtime,
      "recovery-cross-origin",
    );
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.text()).not.toContain(provisioned.recoveryCode);

    const missingOrigin = await handleLocalOwnerRecovery(
      recoveryRequest(form, null),
      runtime,
      "recovery-missing-origin",
    );
    expect(missingOrigin.status).toBe(403);

    const recovered = await handleLocalOwnerRecovery(
      recoveryRequest(form),
      runtime,
      "recovery-success",
    );
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("cache-control")).toContain("no-store");
    expect(recovered.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(recovered.headers.get("location")).toBeNull();
    const recoveredBody = await recovered.text();
    expect(recoveredBody).not.toContain(provisioned.recoveryCode);
    expect(recoveredBody).not.toContain(form.newPassword);
    const firstRotatedCode = recoveredBody.match(/bea-recovery-[A-Za-z0-9_-]{43}/u)?.[0];
    expect(firstRotatedCode).toBeDefined();
    expect(recoveredBody.match(/bea-recovery-[A-Za-z0-9_-]{43}/gu)).toHaveLength(1);

    const reused = await handleLocalOwnerRecovery(
      recoveryRequest({
        ...form,
        newPassword: "Another strong replacement passphrase 2026!",
        confirmPassword: "Another strong replacement passphrase 2026!",
      }),
      runtime,
      "recovery-reuse-denied",
    );
    expect(reused.status).toBe(303);
    expect(reused.headers.get("location")).toBe("https://bea.localhost:3443/recover?status=failed");
    expect(await reused.text()).not.toContain(provisioned.recoveryCode);

    const session = await authentication.signIn(
      "andrew.owner",
      form.newPassword,
      "pre-second-recovery-session",
    );
    const secondRecovery = await handleLocalOwnerRecovery(
      recoveryRequest({
        username: "andrew.owner",
        recoveryCode: firstRotatedCode as string,
        newPassword: "Final Local Owner passphrase 2026!",
        confirmPassword: "Final Local Owner passphrase 2026!",
      }),
      runtime,
      "recovery-second-success",
    );
    expect(secondRecovery.status).toBe(200);
    const secondBody = await secondRecovery.text();
    const secondRotatedCode = secondBody.match(/bea-recovery-[A-Za-z0-9_-]{43}/u)?.[0];
    expect(secondRotatedCode).toBeDefined();
    expect(secondRotatedCode).not.toBe(firstRotatedCode);
    await expect(authentication.readSession(session.sessionToken)).resolves.toBeNull();
    await expect(
      authentication.signIn(
        "andrew.owner",
        "Final Local Owner passphrase 2026!",
        "post-recovery-sign-in",
      ),
    ).resolves.toMatchObject({ user: { displayName: "Workspace Owner" } });
  }, 60_000);
});
