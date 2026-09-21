import { describe, expect, it } from "vitest";

import {
  canConfirmPhysicalObservation,
  isOwnerAcceptancePhysicalObservationId,
  ownerLiveTechnicalStatus,
} from "../../packages/domain/src/index.js";

describe("Phase 2.1 owner live acceptance policy", () => {
  it("rejects Cloud, CI, Demo, and non-local-live physical confirmations", () => {
    expect(
      canConfirmPhysicalObservation({
        authProvider: "local-owner",
        appMode: "production",
        runtimeMode: "production",
        deploymentProfile: "local-live",
        ci: true,
      }).allowed,
    ).toBe(false);
    expect(
      canConfirmPhysicalObservation({
        authProvider: "demo",
        appMode: "demo",
        runtimeMode: "test",
        deploymentProfile: "demo",
        ci: false,
      }).allowed,
    ).toBe(false);
    expect(isOwnerAcceptancePhysicalObservationId("heard_ai_speak")).toBe(true);
    expect(isOwnerAcceptancePhysicalObservationId("openai_key_configured")).toBe(false);
    expect(
      ownerLiveTechnicalStatus({
        confirmableEnvironment: false,
        evidenceStatus: "EVIDENCE_RECORDED",
      }),
    ).toBe("NOT_RUN");
  });

  it("allows Local Owner production confirmation only off CI", () => {
    expect(
      canConfirmPhysicalObservation({
        authProvider: "local-owner",
        appMode: "production",
        runtimeMode: "production",
        deploymentProfile: "local-live",
        ci: false,
      }),
    ).toMatchObject({ allowed: true });
  });
});
