import type { AiPresentationPacket, AiSafeWorkspaceSelection } from "@bea/domain";

const LIMITS = Object.freeze({
  title: 160,
  summary: 500,
  itemBody: 280,
  spokenText: 400,
  findings: 5,
  implications: 3,
  risks: 3,
  recommendations: 3,
  sources: 8,
  segments: 8,
});

export interface RealtimeVoiceBriefing {
  readonly presentationRunId: string;
  readonly title: string;
  readonly executiveSummary: string;
  readonly findings: readonly {
    readonly id: string;
    readonly title: string;
    readonly body: string;
  }[];
  readonly implications: readonly { readonly id: string; readonly body: string }[];
  readonly risks: readonly { readonly id: string; readonly body: string }[];
  readonly recommendations: readonly { readonly id: string; readonly body: string }[];
  readonly narrationSegments: readonly {
    readonly id: string;
    readonly visualElementId: string;
    readonly spokenText: string;
  }[];
  readonly sources: readonly {
    readonly number: number;
    readonly title: string;
    readonly simulated: boolean;
  }[];
  readonly selectedContext: AiSafeWorkspaceSelection | null;
  readonly visualArtifactId: string | null;
  readonly liveWebSearch: boolean;
  readonly simulated: boolean;
  readonly analysisValidated: boolean;
  readonly label:
    | "LIVE WEB RESEARCH"
    | "SIMULATED WEB RESEARCH"
    | "AUTHORIZED BEA RECORDS"
    | "DEMONSTRATION BEA RECORDS";
}

function clip(value: string, maximum: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maximum);
}

export function buildRealtimeVoiceBriefing(packet: AiPresentationPacket): RealtimeVoiceBriefing {
  const label = packet.liveWebSearch
    ? packet.simulated
      ? "SIMULATED WEB RESEARCH"
      : "LIVE WEB RESEARCH"
    : packet.routeKey === "record_retrieval"
      ? packet.beaRecordsLive
        ? "AUTHORIZED BEA RECORDS"
        : "DEMONSTRATION BEA RECORDS"
      : packet.simulated
        ? "SIMULATED WEB RESEARCH"
        : "LIVE WEB RESEARCH";
  return {
    presentationRunId: packet.presentationRunId,
    title: clip(packet.title, LIMITS.title),
    executiveSummary: clip(packet.summary, LIMITS.summary),
    findings: packet.findings.slice(0, LIMITS.findings).map((finding) => ({
      id: finding.id,
      title: clip(finding.title, 120),
      body: clip(finding.body, LIMITS.itemBody),
    })),
    implications: packet.implications.slice(0, LIMITS.implications).map((item) => ({
      id: item.id,
      body: clip(item.body, LIMITS.itemBody),
    })),
    risks: packet.risks.slice(0, LIMITS.risks).map((item) => ({
      id: item.id,
      body: clip(item.body, LIMITS.itemBody),
    })),
    recommendations: packet.recommendations.slice(0, LIMITS.recommendations).map((item) => ({
      id: item.id,
      body: clip(item.body, LIMITS.itemBody),
    })),
    narrationSegments: packet.narrationSegments.slice(0, LIMITS.segments).map((segment) => ({
      id: segment.id,
      visualElementId: segment.visualElementId,
      spokenText: clip(segment.spokenText, LIMITS.spokenText),
    })),
    sources: packet.sources.slice(0, LIMITS.sources).map((source) => ({
      number: source.number,
      title: clip(source.title, 160),
      simulated: source.simulated,
    })),
    selectedContext: packet.selected,
    visualArtifactId: packet.visualArtifactId,
    liveWebSearch: packet.liveWebSearch,
    simulated: packet.simulated,
    analysisValidated: packet.analysisValidated !== false,
    label,
  };
}

export function realtimeSessionWithinMaxAge(input: {
  readonly authorizedAt: string;
  readonly nowMs: number;
  readonly maxAgeMs: number;
}): boolean {
  const started = Date.parse(input.authorizedAt);
  if (!Number.isFinite(started)) return false;
  return input.nowMs - started <= input.maxAgeMs;
}
