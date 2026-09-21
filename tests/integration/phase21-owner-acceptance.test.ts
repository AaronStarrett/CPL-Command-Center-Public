import { afterEach, describe, expect, it, vi } from "vitest";

import { DEMO_PERSONAS, DEMO_ROLE_IDS } from "../../packages/domain/src/index.js";
import { createServerRuntime, type BeaServerRuntime } from "../../packages/database/src/index.js";
import { OpenAiAdministrationError } from "../../apps/web/lib/openai-administration.js";
import {
  confirmOwnerPhysicalObservation,
  readOwnerLiveAcceptance,
} from "../../apps/web/lib/owner-live-acceptance.js";
import type { AuthSession } from "../../apps/web/lib/auth/session-store.ts";

vi.mock("server-only", () => ({}));

const OWNER_USER_ID = DEMO_PERSONAS[0].id;
let runtime: BeaServerRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function demoRuntime() {
  runtime = await createServerRuntime({
    loadEnvFile: false,
    processEnvironment: {
      NODE_ENV: "test",
      APP_MODE: "demo",
      DATABASE_DRIVER: "pglite",
      DEMO_DATABASE_PATH: "memory://",
      DEMO_AUTH_ENABLED: "true",
      LOG_LEVEL: "silent",
      OPENAI_API_KEY: "",
    },
  });
  return runtime;
}

function demoSession(): AuthSession {
  return {
    provider: "demo",
    personaId: OWNER_USER_ID,
    personaKey: "owner-administrator",
    displayName: "Workspace Owner",
    email: null,
    title: "Chief Executive Officer",
    roleIds: [DEMO_ROLE_IDS.OWNER_ADMIN],
    createdAt: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-08-30T12:00:00.000Z",
  };
}

describe("Phase 2.1 owner live acceptance persistence", () => {
  it("keeps physical observations NOT RUN in Demo and rejects confirmation", async () => {
    const server = await demoRuntime();
    const snapshot = await readOwnerLiveAcceptance(server, demoSession());
    expect(snapshot.ownerLiveStatus).toBe("NOT_RUN");
    expect(snapshot.physicalConfirmable).toBe(false);
    expect(snapshot.physicalObservations.every((item) => item.status === "NOT_RUN")).toBe(true);
    expect(snapshot.technicalEvidence.every((item) => item.ownerLiveStatus === "NOT_RUN")).toBe(
      true,
    );
    await expect(
      confirmOwnerPhysicalObservation({
        runtime: server,
        session: demoSession(),
        correlationId: "phase21-owner-acceptance-denied",
        observationId: "heard_ai_speak",
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(OpenAiAdministrationError);
  });
});
