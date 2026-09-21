import "server-only";

import { assembleAssistantPolicyContext, type AssistantPolicyContext } from "@bea/ai";
import {
  ARTIFACT_BRAND_POLICY_SETTING_KEY,
  DEFAULT_ARTIFACT_BRAND_POLICY,
  DEFAULT_EXECUTIVE_PERSONA_POLICY,
  DEFAULT_EXECUTIVE_PROFILE,
  EXECUTIVE_PERSONA_POLICY_SETTING_KEY,
  EXECUTIVE_PROFILE_SETTING_KEY,
  type ArtifactBrandPolicy,
  type ExecutivePersonaPolicy,
  type ExecutiveProfileRecord,
  type JsonValue,
} from "@bea/domain";
import type { BeaServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";

function objectValue(value: JsonValue | undefined): Record<string, unknown> | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function profileValue(value: JsonValue | undefined): ExecutiveProfileRecord {
  const candidate = objectValue(value);
  return candidate && Array.isArray(candidate.versions) && Array.isArray(candidate.sources)
    ? (candidate as unknown as ExecutiveProfileRecord)
    : DEFAULT_EXECUTIVE_PROFILE;
}

function personaPolicyValue(value: JsonValue | undefined): ExecutivePersonaPolicy {
  const candidate = objectValue(value);
  return candidate &&
    typeof candidate.activeVersion === "string" &&
    Array.isArray(candidate.availableVersions)
    ? (candidate as unknown as ExecutivePersonaPolicy)
    : DEFAULT_EXECUTIVE_PERSONA_POLICY;
}

function brandPolicyValue(value: JsonValue | undefined): ArtifactBrandPolicy {
  const candidate = objectValue(value);
  return candidate &&
    typeof candidate.activeVersion === "string" &&
    typeof candidate.templateVersion === "string"
    ? (candidate as unknown as ArtifactBrandPolicy)
    : DEFAULT_ARTIFACT_BRAND_POLICY;
}

export async function getAssistantPolicyContext(
  runtime: BeaServerRuntime,
  userId: string,
): Promise<AssistantPolicyContext> {
  const user = await runtime.repository.findActiveUserById(userId);
  if (!user) throw new Error("Authenticated user is unavailable.");
  const profileAuthorized = (
    await runtime.authorization.authorizeUser(userId, PERMISSIONS.EXECUTIVE_PROFILE_USE)
  ).allowed;
  const [profileSetting, personaSetting, brandSetting] = await Promise.all([
    profileAuthorized ? runtime.settings.get(EXECUTIVE_PROFILE_SETTING_KEY) : Promise.resolve(null),
    runtime.settings.get(EXECUTIVE_PERSONA_POLICY_SETTING_KEY),
    runtime.settings.get(ARTIFACT_BRAND_POLICY_SETTING_KEY),
  ]);
  return assembleAssistantPolicyContext({
    authenticatedUser: {
      id: user.id,
      displayName: user.displayName,
      title: user.title,
      roleIds: user.roleIds,
    },
    executiveProfileAuthorized: profileAuthorized,
    executiveProfile: profileAuthorized ? profileValue(profileSetting?.value) : null,
    personaPolicy: personaPolicyValue(personaSetting?.value),
    brandPolicy: brandPolicyValue(brandSetting?.value),
  });
}
