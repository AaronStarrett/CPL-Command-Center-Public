import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTIVE_PROFILE,
  activeExecutiveProfileVersion,
} from "../../packages/domain/src/executive-profile";
import { assembleAssistantPolicyContext } from "../../packages/ai/src/executive-context";
import {
  DEFAULT_ARTIFACT_BRAND_POLICY,
  DEFAULT_EXECUTIVE_PERSONA_POLICY,
} from "../../packages/domain/src/executive-profile";

describe("CPL empty installation profile", () => {
  it("contains no personal profile or provenance and cannot select an executive persona", () => {
    expect(DEFAULT_EXECUTIVE_PROFILE.versions).toEqual([]);
    expect(DEFAULT_EXECUTIVE_PROFILE.sources).toEqual([]);
    expect(activeExecutiveProfileVersion(DEFAULT_EXECUTIVE_PROFILE)).toBeNull();
    const context = assembleAssistantPolicyContext({
      authenticatedUser: {
        id: DEFAULT_EXECUTIVE_PROFILE.userId,
        displayName: "Unconfigured",
        title: null,
        roleIds: ["owner-admin"],
      },
      executiveProfileAuthorized: true,
      executiveProfile: DEFAULT_EXECUTIVE_PROFILE,
      personaPolicy: DEFAULT_EXECUTIVE_PERSONA_POLICY,
      brandPolicy: DEFAULT_ARTIFACT_BRAND_POLICY,
    });
    expect(context.persona.kind).toBe("general-support");
    expect(context.persona.preferredName).toBeNull();
    expect(context.provenance.executiveProfileVersion).toBeNull();
  });
});
