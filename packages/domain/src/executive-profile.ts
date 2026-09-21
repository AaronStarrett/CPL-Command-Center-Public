import type { EntityId, IsoDateTime, JsonObject } from "./entities.js";

export const ANDREW_OWNER_USER_ID = "10000000-0000-4000-8000-000000000001";
export const EXECUTIVE_PROFILE_SETTING_KEY = "assistant.executive-profile.andrew";
export const EXECUTIVE_PERSONA_POLICY_SETTING_KEY = "assistant.persona-policy";
export const ARTIFACT_BRAND_POLICY_SETTING_KEY = "artifacts.brand-policy";

export const EXECUTIVE_PERSONA_VERSION = "bea-executive-business-partner-v1";
export const EXECUTIVE_PERSONA_PREVIOUS_VERSION = "bea-executive-business-partner-v0";
export const ROLE_PERSONA_VERSION = "bea-role-assistant-v1";
export const EXECUTIVE_PROFILE_VERSION = "andrew-executive-profile-v1";
export const EXECUTIVE_EXTERNAL_CONTEXT_POLICY_VERSION = "andrew-external-context-v1";
export const ARTIFACT_BRAND_POLICY_VERSION = "bea-artifact-brand-v1";
export const ARTIFACT_TEMPLATE_VERSION = "bea-artifact-template-v1";

export type ExecutiveProfileSourceType =
  | "OWNER_CONFIRMED"
  | "ORGANIZATION_WEBSITE"
  | "LINKEDIN_REFERENCE"
  | "UPLOADED_BIOGRAPHY"
  | "APPROVED_PUBLIC_SOURCE"
  | "OWNER_CORRECTION";

export interface ExecutiveProfileSource {
  readonly id: string;
  readonly type: ExecutiveProfileSourceType;
  readonly url: string | null;
  readonly label: string;
  readonly status: "approved" | "reference-only" | "superseded";
  readonly accessNote: string | null;
  readonly approvedAt: IsoDateTime;
}

export interface ExecutiveProfileVersion {
  readonly version: string;
  readonly status: "active" | "superseded";
  readonly fullName: string;
  readonly preferredName: string;
  readonly title: string;
  readonly organization: string;
  readonly professionalSummary: string;
  readonly businessPriorities: readonly string[];
  readonly communicationPreferences: readonly string[];
  readonly decisionPreferences: readonly string[];
  readonly approvedPersonalInterests: readonly string[];
  readonly externalContextAuthorization: {
    readonly version: typeof EXECUTIVE_EXTERNAL_CONTEXT_POLICY_VERSION;
    readonly fields: Readonly<
      Record<
        | "fullName"
        | "preferredName"
        | "title"
        | "organization"
        | "professionalSummary"
        | "businessPriorities"
        | "communicationPreferences"
        | "decisionPreferences"
        | "approvedPersonalInterests",
        boolean
      >
    >;
  };
  readonly sourceIds: readonly string[];
  readonly reviewedByUserId: EntityId;
  readonly reviewedAt: IsoDateTime;
}

export interface ExecutiveProfileRecord {
  readonly profileId: string;
  readonly userId: EntityId;
  readonly activeVersion: string;
  readonly versions: readonly ExecutiveProfileVersion[];
  readonly sources: readonly ExecutiveProfileSource[];
}

export interface AssistantPolicyProvenance extends JsonObject {
  readonly personaPromptVersion: string;
  readonly executiveProfileVersion: string | null;
  readonly brandPolicyVersion: string;
  readonly artifactTemplateVersion: string;
}

export interface ExecutivePersonaPolicy {
  readonly activeVersion: string;
  readonly availableVersions: readonly string[];
}

export interface ArtifactBrandPolicy {
  readonly activeVersion: string;
  readonly templateVersion: string;
  readonly logoPath: "/brand/cpl-logo.png";
  readonly logoSha256: string;
  readonly palette: readonly string[];
}

// Installation starts without a personal profile. Legacy setting keys are retained
// solely for existing data compatibility; they grant no identity or permission.
export const DEFAULT_EXECUTIVE_PROFILE: ExecutiveProfileRecord = Object.freeze({
  profileId: "unconfigured-executive-profile",
  userId: "00000000-0000-4000-8000-000000000000",
  activeVersion: "unconfigured",
  versions: [],
  sources: [],
});

export const DEFAULT_EXECUTIVE_PERSONA_POLICY: ExecutivePersonaPolicy = Object.freeze({
  activeVersion: EXECUTIVE_PERSONA_VERSION,
  availableVersions: [EXECUTIVE_PERSONA_PREVIOUS_VERSION, EXECUTIVE_PERSONA_VERSION],
});

export const DEFAULT_ARTIFACT_BRAND_POLICY: ArtifactBrandPolicy = Object.freeze({
  activeVersion: ARTIFACT_BRAND_POLICY_VERSION,
  templateVersion: ARTIFACT_TEMPLATE_VERSION,
  logoPath: "/brand/cpl-logo.png",
  logoSha256: "30c43d3ce4728e1a6d0fac689b6bce7cf3088b0ec4e46f30bd0bbff19fad8dd8",
  palette: ["#08304A", "#4AA346", "#1769AA", "#6F8797", "#DCE7EC", "#FFFFFF"],
});

export const DEFAULT_ASSISTANT_POLICY_PROVENANCE: AssistantPolicyProvenance = Object.freeze({
  personaPromptVersion: ROLE_PERSONA_VERSION,
  executiveProfileVersion: null,
  brandPolicyVersion: ARTIFACT_BRAND_POLICY_VERSION,
  artifactTemplateVersion: ARTIFACT_TEMPLATE_VERSION,
});

export function activeExecutiveProfileVersion(
  profile: ExecutiveProfileRecord,
): ExecutiveProfileVersion | null {
  return profile.versions.find((version) => version.version === profile.activeVersion) ?? null;
}
