import { beforeEach, describe, expect, it, vi } from "vitest";

import { PERMISSIONS } from "../../packages/security/src/rbac";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({
  requireAiApiContext: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai-command-api", () => ({
  requireAiApiContext: mocks.requireAiApiContext,
}));
vi.mock("@/lib/openai-api", () => ({
  openAiApiError: () => new Response("safe provider error", { status: 500 }),
}));

import {
  GET as getPreference,
  PUT as putPreference,
} from "../../apps/web/app/api/ai-command/realtime/preferences/route";

function mutation(value: Record<string, unknown>) {
  const body = JSON.stringify(value);
  return new Request("https://bea.example/api/ai-command/realtime/preferences", {
    method: "PUT",
    headers: {
      "Content-Length": String(new TextEncoder().encode(body).length),
      "Content-Type": "application/json",
    },
    body,
  });
}

describe("Phase 1.3.3 Realtime speak-response preference", () => {
  const getUserVoicePreference = vi.fn();
  const setUserVoicePreference = vi.fn();
  const record = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getUserVoicePreference.mockResolvedValue({
      id: USER_ID,
      userId: USER_ID,
      speakResponses: true,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      version: 1,
    });
    setUserVoicePreference.mockImplementation(async ({ speakResponses }) => ({
      id: USER_ID,
      userId: USER_ID,
      speakResponses,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:01:00.000Z",
      version: 2,
    }));
    record.mockResolvedValue({ id: "audit-voice-preference" });
    mocks.requireAiApiContext.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      correlationId: "voice-preference-fixture",
      runtime: {
        ai: { persistence: { getUserVoicePreference, setUserVoicePreference } },
        repository: { record },
      },
    });
  });

  it("defaults the persisted per-user preference to spoken voice replies", async () => {
    const response = await getPreference(
      new Request("https://bea.example/api/ai-command/realtime/preferences") as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ preference: { speakResponses: true } });
    expect(mocks.requireAiApiContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ permission: PERMISSIONS.AI_COMMAND_VIEW }),
    );
  });

  it("persists and audits an explicit speak-responses change", async () => {
    const response = await putPreference(mutation({ speakResponses: false }) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ preference: { speakResponses: false } });
    expect(setUserVoicePreference).toHaveBeenCalledWith({
      userId: USER_ID,
      speakResponses: false,
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai-command.realtime.preferences.update",
        actorUserId: USER_ID,
        metadata: { speakResponses: false },
      }),
    );
    expect(mocks.requireAiApiContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        permission: PERMISSIONS.AI_COMMAND_RUN,
        strictMutation: true,
      }),
    );
  });

  it("rejects extra fields and non-boolean values before persistence", async () => {
    const response = await putPreference(
      mutation({ speakResponses: "yes", model: "must-not-be-accepted" }) as never,
    );
    expect(response.status).toBe(400);
    expect(setUserVoicePreference).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
