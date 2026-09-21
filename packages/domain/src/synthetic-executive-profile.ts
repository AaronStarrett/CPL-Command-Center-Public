import {
  EXECUTIVE_EXTERNAL_CONTEXT_POLICY_VERSION,
  type ExecutiveProfileRecord,
} from "./executive-profile.js";

// Fictional, test-only data exercises private context without embedding a person's profile.
export const SYNTHETIC_EXECUTIVE_PROFILE: ExecutiveProfileRecord = {
  profileId: "synthetic-executive",
  userId: "10000000-0000-4000-8000-000000000001",
  activeVersion: "synthetic-profile-v1",
  versions: [
    {
      version: "synthetic-profile-v1",
      status: "active",
      fullName: "Jordan Example",
      preferredName: "Jordan",
      title: "Organization owner",
      organization: "Example Services",
      professionalSummary: "Fictional test profile",
      businessPriorities: ["Synthetic priority"],
      communicationPreferences: [],
      decisionPreferences: [],
      approvedPersonalInterests: ["Synthetic private interest"],
      externalContextAuthorization: {
        version: EXECUTIVE_EXTERNAL_CONTEXT_POLICY_VERSION,
        fields: {
          fullName: true,
          preferredName: true,
          title: true,
          organization: true,
          professionalSummary: false,
          businessPriorities: false,
          communicationPreferences: false,
          decisionPreferences: false,
          approvedPersonalInterests: false,
        },
      },
      sourceIds: ["synthetic-source"],
      reviewedByUserId: "10000000-0000-4000-8000-000000000001",
      reviewedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  sources: [
    {
      id: "synthetic-source",
      type: "OWNER_CONFIRMED",
      url: "https://example.test/profile",
      label: "Fictional profile source",
      status: "approved",
      accessNote: null,
      approvedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};
