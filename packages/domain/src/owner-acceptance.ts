export const OWNER_ACCEPTANCE_APPLICATION_VERSION = "phase-2.1";
export const OWNER_ACCEPTANCE_CONTRACT_VERSION = "phase2.1-owner-acceptance-v1";
export const OWNER_ACCEPTANCE_AUDIT_EVENT = "owner-acceptance.physical-observation";
export const OWNER_ACCEPTANCE_AUDIT_ACTION = "owner-acceptance.confirm";

export const OWNER_ACCEPTANCE_TECHNICAL_EVIDENCE_IDS = [
  "openai_key_configured",
  "connection_test",
  "model_discovery",
  "route_compatibility",
  "executive_text_request",
  "web_search_execution",
  "citation_presence",
  "realtime_connection",
  "transcript_persistence",
  "usage_persistence",
  "provider_deactivation",
  "fail_closed_behavior",
] as const;

export type OwnerAcceptanceTechnicalEvidenceId =
  (typeof OWNER_ACCEPTANCE_TECHNICAL_EVIDENCE_IDS)[number];

export const OWNER_ACCEPTANCE_PHYSICAL_OBSERVATION_IDS = [
  "heard_ai_speak",
  "displayed_section_matched",
  "voice_continued_while_scrolled",
  "voice_continued_while_clicked_source",
  "follow_narration_returned",
  "barge_in_stopped_old_response",
  "follow_up_used_selected_source",
  "stop_voice_released_microphone",
  "no_old_audio_resumed",
  "experience_understandable_responsive",
] as const;

export type OwnerAcceptancePhysicalObservationId =
  (typeof OWNER_ACCEPTANCE_PHYSICAL_OBSERVATION_IDS)[number];

export type OwnerLiveStatus = "NOT_RUN" | "CONFIRMED";
export type OwnerTechnicalEvidenceStatus = "NOT_RUN" | "EVIDENCE_RECORDED" | "FAIL";

export const OWNER_ACCEPTANCE_PHYSICAL_OBSERVATIONS = Object.freeze({
  heard_ai_speak: "I heard the AI speak",
  displayed_section_matched: "The displayed section matched what the AI was explaining",
  voice_continued_while_scrolled: "Voice continued while I scrolled",
  voice_continued_while_clicked_source: "Voice continued while I clicked a source",
  follow_narration_returned: "Follow Narration returned to the current spoken section",
  barge_in_stopped_old_response: "Barge-in stopped the old response",
  follow_up_used_selected_source: "The follow-up used the selected source",
  stop_voice_released_microphone: "Stop Voice released the microphone",
  no_old_audio_resumed: "No old audio resumed",
  experience_understandable_responsive: "The experience was understandable and responsive",
} as const satisfies Record<OwnerAcceptancePhysicalObservationId, string>);

export const OWNER_ACCEPTANCE_TECHNICAL_EVIDENCE_LABELS = Object.freeze({
  openai_key_configured: "OpenAI key configured",
  connection_test: "Connection test",
  model_discovery: "Model discovery",
  route_compatibility: "Route compatibility",
  executive_text_request: "Executive text request",
  web_search_execution: "Web Search execution",
  citation_presence: "Citation presence",
  realtime_connection: "Realtime connection",
  transcript_persistence: "Transcript persistence",
  usage_persistence: "Usage persistence",
  provider_deactivation: "Provider deactivation",
  fail_closed_behavior: "Fail-closed behavior",
} as const satisfies Record<OwnerAcceptanceTechnicalEvidenceId, string>);

export const OWNER_ACCEPTANCE_GUIDED_TESTS = Object.freeze([
  {
    id: "test-a-lead-review",
    title: "TEST A — Lead review",
    prompt: "Show me the leads that still need information and explain what Russ should do next.",
    expected:
      "The right pane can display authorized lead records and blocking reasons. The AI should give a concise executive explanation. Synthetic or empty records are not live CRM data.",
  },
  {
    id: "test-b-live-public-research",
    title: "TEST B — Live public research",
    prompt:
      "Search the current public web for recent guidance or developments relevant to field water-penetration testing and explain what matters to BEA.",
    expected:
      "A real Web Search tool call, LIVE WEB RESEARCH only after successful tool use, executive summary, findings, implications, risks, recommendations, clickable citations, source board, and synchronized narration when voice is connected.",
  },
  {
    id: "test-c-source-follow-up",
    title: "TEST C — Source follow-up",
    prompt: "Explain what this source means for BEA.",
    expected:
      "Select one displayed source first. The response should use that evidence, state limitations, and not treat public information as BEA project data.",
  },
  {
    id: "test-d-interruption",
    title: "TEST D — Interruption",
    prompt: "Stop there. What are the two biggest risks?",
    expected:
      "Speak this while the AI is talking. Old audio should stop, unplayed output should not resume, the right-pane presentation should remain, and the new answer should continue in the same context.",
  },
] as const);

export const OWNER_ACCEPTANCE_ROUTE_FOCUS = Object.freeze([
  {
    routeKey: "executive_conversation",
    profileLabel: "Executive / Premium",
    capabilityHint:
      "Workload: Executive conversation. Primary, fallback, tools, cost class, and status are in the routing table.",
  },
  {
    routeKey: "fast_general_conversation",
    profileLabel: "Fast",
    capabilityHint: "Workload: Fast general conversation.",
  },
  {
    routeKey: "public_web_research",
    profileLabel: "Public Web Research",
    capabilityHint: "Workload: Public web research.",
  },
  {
    routeKey: "realtime_voice",
    profileLabel: "Realtime Voice",
    capabilityHint:
      "Workload: Realtime voice. Select Realtime model and Realtime voice above the table.",
  },
] as const);

export function isOwnerAcceptancePhysicalObservationId(
  value: unknown,
): value is OwnerAcceptancePhysicalObservationId {
  return (
    typeof value === "string" &&
    (OWNER_ACCEPTANCE_PHYSICAL_OBSERVATION_IDS as readonly string[]).includes(value)
  );
}

export function canConfirmPhysicalObservation(input: {
  readonly authProvider: string;
  readonly appMode: string;
  readonly runtimeMode: string;
  readonly deploymentProfile: string;
  readonly ci: boolean;
}): { readonly allowed: boolean; readonly reason: string } {
  if (input.ci) {
    return {
      allowed: false,
      reason: "Cloud, CI, and automated tests cannot mark physical Owner Live observations PASS.",
    };
  }
  if (input.authProvider !== "local-owner") {
    return {
      allowed: false,
      reason: "Physical observations can be confirmed only by the authenticated Local Owner.",
    };
  }
  if (input.appMode !== "production" || input.runtimeMode !== "production") {
    return {
      allowed: false,
      reason: "Physical observations can be confirmed only on the Local Live production runtime.",
    };
  }
  if (input.deploymentProfile !== "local-live") {
    return {
      allowed: false,
      reason: "Physical observations can be confirmed only on the local-live deployment profile.",
    };
  }
  return { allowed: true, reason: "Local Owner may record this physical observation." };
}

export function ownerLiveTechnicalStatus(input: {
  readonly confirmableEnvironment: boolean;
  readonly evidenceStatus: OwnerTechnicalEvidenceStatus;
}): OwnerTechnicalEvidenceStatus {
  if (!input.confirmableEnvironment) return "NOT_RUN";
  return input.evidenceStatus;
}
