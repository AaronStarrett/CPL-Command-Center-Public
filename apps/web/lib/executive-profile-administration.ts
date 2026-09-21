import "server-only";

import { randomUUID } from "node:crypto";
import {
  ARTIFACT_BRAND_POLICY_SETTING_KEY,
  DEFAULT_ARTIFACT_BRAND_POLICY,
  DEFAULT_EXECUTIVE_PERSONA_POLICY,
  DEFAULT_EXECUTIVE_PROFILE,
  EXECUTIVE_PERSONA_POLICY_SETTING_KEY,
  EXECUTIVE_PROFILE_SETTING_KEY,
  activeExecutiveProfileVersion,
  type ArtifactBrandPolicy,
  type ExecutivePersonaPolicy,
  type ExecutiveProfileRecord,
  type ExecutiveProfileSource,
  type ExecutiveProfileSourceType,
  type ExecutiveProfileVersion,
  type JsonValue,
} from "@bea/domain";
import type { BeaServerRuntime } from "@bea/database";

export interface ExecutiveProfileAdministrationSnapshot {
  readonly profile: ExecutiveProfileRecord;
  readonly activeProfile: ExecutiveProfileVersion;
  readonly profileSettingVersion: number;
  readonly personaPolicy: ExecutivePersonaPolicy;
  readonly personaSettingVersion: number;
  readonly brandPolicy: ArtifactBrandPolicy;
  readonly preview: string;
}

function objectValue(value: JsonValue | undefined): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asProfile(value: JsonValue | undefined): ExecutiveProfileRecord {
  const candidate = objectValue(value);
  return candidate && Array.isArray(candidate.versions) && Array.isArray(candidate.sources)
    ? (candidate as unknown as ExecutiveProfileRecord)
    : DEFAULT_EXECUTIVE_PROFILE;
}

function asPersonaPolicy(value: JsonValue | undefined): ExecutivePersonaPolicy {
  const candidate = objectValue(value);
  return candidate &&
    typeof candidate.activeVersion === "string" &&
    Array.isArray(candidate.availableVersions)
    ? (candidate as unknown as ExecutivePersonaPolicy)
    : DEFAULT_EXECUTIVE_PERSONA_POLICY;
}

function asBrandPolicy(value: JsonValue | undefined): ArtifactBrandPolicy {
  const candidate = objectValue(value);
  return candidate &&
    typeof candidate.activeVersion === "string" &&
    typeof candidate.templateVersion === "string"
    ? (candidate as unknown as ArtifactBrandPolicy)
    : DEFAULT_ARTIFACT_BRAND_POLICY;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid.`);
  return normalized;
}

function textList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error(`${label} must contain 1 to 20 entries.`);
  }
  return value.map((entry) => text(entry, label, 240));
}

export async function readExecutiveProfileAdministration(
  runtime: BeaServerRuntime,
): Promise<ExecutiveProfileAdministrationSnapshot> {
  const [profileSetting, personaSetting, brandSetting] = await Promise.all([
    runtime.settings.get(EXECUTIVE_PROFILE_SETTING_KEY),
    runtime.settings.get(EXECUTIVE_PERSONA_POLICY_SETTING_KEY),
    runtime.settings.get(ARTIFACT_BRAND_POLICY_SETTING_KEY),
  ]);
  const profile = asProfile(profileSetting?.value);
  const activeProfile = activeExecutiveProfileVersion(profile);
  if (!activeProfile) throw new Error("The active Executive Profile version is unavailable.");
  const personaPolicy = asPersonaPolicy(personaSetting?.value);
  return {
    profile,
    activeProfile,
    profileSettingVersion: profileSetting?.version ?? 0,
    personaPolicy,
    personaSettingVersion: personaSetting?.version ?? 0,
    brandPolicy: asBrandPolicy(brandSetting?.value),
    preview: `${activeProfile.preferredName}, my recommendation is to identify the highest-impact authorized next action, name its owner, and set a measurable checkpoint. I’ll separate facts, assumptions, risks, and recommendations.`,
  };
}

export async function updateExecutiveProfileAdministration(input: {
  readonly runtime: BeaServerRuntime;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly value: unknown;
}): Promise<ExecutiveProfileAdministrationSnapshot> {
  const body = objectValue(input.value as JsonValue);
  if (!body) throw new Error("Executive Profile update must be an object.");
  const operation = text(body.operation, "Operation", 60);
  const current = await readExecutiveProfileAdministration(input.runtime);
  if (operation === "update-profile") {
    const candidate = objectValue(body.profile as JsonValue);
    if (!candidate) throw new Error("Profile fields are required.");
    const now = new Date().toISOString();
    const nextVersion = `andrew-executive-profile-v${current.profile.versions.length + 1}`;
    const next: ExecutiveProfileVersion = {
      ...current.activeProfile,
      version: nextVersion,
      status: "active",
      fullName: text(candidate.fullName, "Full name", 120),
      preferredName: text(candidate.preferredName, "Preferred name", 80),
      title: text(candidate.title, "Title", 120),
      professionalSummary: text(candidate.professionalSummary, "Professional summary", 1_200),
      businessPriorities: textList(candidate.businessPriorities, "Business priorities"),
      communicationPreferences: textList(
        candidate.communicationPreferences,
        "Communication preferences",
      ),
      decisionPreferences: textList(candidate.decisionPreferences, "Decision preferences"),
      approvedPersonalInterests: textList(
        candidate.approvedPersonalInterests,
        "Approved personal interests",
      ),
      reviewedByUserId: input.actorUserId,
      reviewedAt: now,
    };
    const profile: ExecutiveProfileRecord = {
      ...current.profile,
      activeVersion: nextVersion,
      versions: [
        ...current.profile.versions.map((version) => ({
          ...version,
          status: "superseded" as const,
        })),
        next,
      ],
    };
    await input.runtime.settings.set({
      key: EXECUTIVE_PROFILE_SETTING_KEY,
      value: jsonValue(profile),
      actorUserId: input.actorUserId,
      expectedVersion: Number(body.expectedVersion),
      correlationId: input.correlationId,
    });
  } else if (operation === "add-source") {
    const source = objectValue(body.source as JsonValue);
    if (!source) throw new Error("Source fields are required.");
    const type = text(source.type, "Source type", 80) as ExecutiveProfileSourceType;
    const allowed: readonly ExecutiveProfileSourceType[] = [
      "OWNER_CONFIRMED",
      "ORGANIZATION_WEBSITE",
      "LINKEDIN_REFERENCE",
      "UPLOADED_BIOGRAPHY",
      "APPROVED_PUBLIC_SOURCE",
      "OWNER_CORRECTION",
    ];
    if (!allowed.includes(type)) throw new Error("Source type is unsupported.");
    const urlText =
      source.url === null || source.url === "" ? null : text(source.url, "Source URL", 2_048);
    if (urlText) {
      const url = new URL(urlText);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Source URL must be credential-free HTTPS.");
    }
    const nextSource: ExecutiveProfileSource = {
      id: randomUUID(),
      type,
      url: urlText,
      label: text(source.label, "Source label", 240),
      status: type === "LINKEDIN_REFERENCE" ? "reference-only" : "approved",
      accessNote: source.accessNote ? text(source.accessNote, "Access note", 500) : null,
      approvedAt: new Date().toISOString(),
    };
    await input.runtime.settings.set({
      key: EXECUTIVE_PROFILE_SETTING_KEY,
      value: jsonValue({ ...current.profile, sources: [...current.profile.sources, nextSource] }),
      actorUserId: input.actorUserId,
      expectedVersion: Number(body.expectedVersion),
      correlationId: input.correlationId,
    });
  } else if (operation === "remove-source") {
    const sourceId = text(body.sourceId, "Source ID", 120);
    if (!current.profile.sources.some((source) => source.id === sourceId))
      throw new Error("Source was not found.");
    await input.runtime.settings.set({
      key: EXECUTIVE_PROFILE_SETTING_KEY,
      value: jsonValue({
        ...current.profile,
        sources: current.profile.sources.map((source) =>
          source.id === sourceId ? { ...source, status: "superseded" as const } : source,
        ),
      }),
      actorUserId: input.actorUserId,
      expectedVersion: Number(body.expectedVersion),
      correlationId: input.correlationId,
    });
  } else if (operation === "activate-prompt" || operation === "rollback-prompt") {
    const versions = current.personaPolicy.availableVersions;
    const activeIndex = versions.indexOf(current.personaPolicy.activeVersion);
    const requested =
      operation === "activate-prompt"
        ? text(body.version, "Prompt version", 120)
        : versions[Math.max(0, activeIndex - 1)];
    if (!requested || !versions.includes(requested))
      throw new Error("Prompt version is unavailable.");
    await input.runtime.settings.set({
      key: EXECUTIVE_PERSONA_POLICY_SETTING_KEY,
      value: jsonValue({ ...current.personaPolicy, activeVersion: requested }),
      actorUserId: input.actorUserId,
      expectedVersion: Number(body.expectedVersion),
      correlationId: input.correlationId,
    });
  } else {
    throw new Error("Executive Profile operation is unsupported.");
  }
  await input.runtime.repository.record({
    eventType: "executive-profile.changed",
    action: `executive-profile.${operation}`,
    outcome: "succeeded",
    actorUserId: input.actorUserId,
    resourceType: "executive-profile",
    resourceId: null,
    correlationId: input.correlationId,
    metadata: { operation, sensitiveValuesRecorded: false },
  });
  return readExecutiveProfileAdministration(input.runtime);
}
