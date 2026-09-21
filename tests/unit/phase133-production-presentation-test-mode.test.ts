import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isPhase133ProductionPresentationTest,
  PHASE133_PRODUCTION_PRESENTATION_TEST_AUTHORITY,
} from "../../apps/web/lib/phase133-production-presentation-test";

const exactEnvironment = Object.freeze({
  NODE_ENV: "test",
  APP_MODE: "demo",
  BEA_RUNTIME_MODE: "",
  APP_BASE_URL: "http://127.0.0.1:3132",
  BEA_DISABLE_ENV_FILE: "true",
  DATABASE_DRIVER: "pglite",
  DEMO_AUTH_ENABLED: "true",
  DEMO_DATABASE_PATH: "memory://",
  WORKER_QUEUE_ADAPTER: "inline",
  OPENAI_API_KEY: "",
  BEA_PHASE133_PRESENTATION_TEST_MODE: "true",
  BEA_PHASE133_PRESENTATION_TEST_AUTHORITY: PHASE133_PRODUCTION_PRESENTATION_TEST_AUTHORITY,
});

describe("Phase 1.3.3 TEST-ONLY production-presentation authority", () => {
  it("allows only the exact isolated credential-free browser environment", () => {
    expect(isPhase133ProductionPresentationTest(exactEnvironment)).toBe(true);
  });

  it.each(Object.keys(exactEnvironment))("fails closed when %s is absent", (key) => {
    expect(isPhase133ProductionPresentationTest({ ...exactEnvironment, [key]: undefined })).toBe(
      false,
    );
  });

  it.each([
    ["NODE_ENV", "production"],
    ["APP_MODE", "production"],
    ["BEA_RUNTIME_MODE", "production"],
    ["APP_BASE_URL", "https://bea.example"],
    ["DATABASE_DRIVER", "postgres"],
    ["DEMO_AUTH_ENABLED", "false"],
    ["DEMO_DATABASE_PATH", "file://presentation"],
    ["WORKER_QUEUE_ADAPTER", "pg-boss"],
    ["OPENAI_API_KEY", "test-must-never-be-used"],
    ["BEA_PHASE133_PRESENTATION_TEST_MODE", "false"],
    ["BEA_PHASE133_PRESENTATION_TEST_AUTHORITY", "ambient"],
  ] as const)("rejects %s=%s", (key, value) => {
    expect(isPhase133ProductionPresentationTest({ ...exactEnvironment, [key]: value })).toBe(false);
  });
});
