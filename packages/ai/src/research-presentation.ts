import { randomUUID } from "node:crypto";

import {
  AI_PRESENTATION_CONTRACT_VERSION,
  type AiPresentationCitation,
  type AiPresentationPacket,
  type AiPresentationSource,
  type AiWorkloadRouteKey,
} from "@bea/domain";
import type { AiCitation, AiConversationResult, AiWebSource } from "./contracts.js";
import { liveWebSearchLabel } from "./presentation.js";
import { mapFindingsToVerifiedCitations } from "./citation-spans.js";
import {
  applyBriefingToPacket,
  deriveSituationSpecificAnalysis,
  evidenceFirstAnalysisFallback,
  narrationSegmentsForPacket,
  validateStructuredResearchBriefing,
} from "./research-briefing.js";

const HTTPS_URL = /^https:\/\/[^/\s]+/u;
const CREDENTIAL_QUERY = /(?:api[_-]?key|token|secret|password|signature)=/iu;

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "invalid";
  }
}

function safeHttpsUrl(url: string): string | null {
  if (!HTTPS_URL.test(url) || CREDENTIAL_QUERY.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function sanitizeTitle(value: string, fallback: string): string {
  const cleaned = value.replace(/\s+/gu, " ").trim().slice(0, 240);
  return cleaned || fallback;
}

export function webSearchToolSucceeded(result: Pick<AiConversationResult, "toolCalls">): boolean {
  return result.toolCalls.some(
    (call) =>
      (call.name === "web_search" || call.name === "search_web") && call.status === "completed",
  );
}

function citationUrlKey(url: string): string | null {
  return safeHttpsUrl(url);
}

export function normalizeResearchSources(input: {
  readonly webSources: readonly AiWebSource[];
  readonly citations: readonly AiCitation[];
}): {
  readonly sources: readonly AiPresentationSource[];
  readonly citations: readonly AiPresentationCitation[];
} {
  const byUrl = new Map<string, AiPresentationSource>();
  for (const source of input.webSources) {
    const url = safeHttpsUrl(source.url);
    if (!url || byUrl.has(url)) continue;
    const id = source.id || `source-${byUrl.size + 1}`;
    byUrl.set(url, {
      id,
      number: byUrl.size + 1,
      title: sanitizeTitle(source.title, `Source ${byUrl.size + 1}`),
      domain: source.domain || domainFromUrl(url),
      url,
      retrievedAt: source.retrievedAt,
      supportsFindingIds: [],
      simulated: source.simulated,
    });
  }
  for (const citation of input.citations) {
    const url = safeHttpsUrl(citation.url);
    if (!url || byUrl.has(url)) continue;
    const id = citation.sourceId || citation.id || `source-${byUrl.size + 1}`;
    byUrl.set(url, {
      id,
      number: byUrl.size + 1,
      title: sanitizeTitle(citation.title, `Source ${byUrl.size + 1}`),
      domain: citation.domain || domainFromUrl(url),
      url,
      retrievedAt: citation.retrievedAt,
      supportsFindingIds: [],
      simulated: citation.simulated,
    });
  }
  const sources = [...byUrl.values()].slice(0, 32);
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  const citations: AiPresentationCitation[] = [];
  for (const citation of input.citations) {
    const url = citationUrlKey(citation.url);
    if (!url) continue;
    const source = sourceByUrl.get(url);
    if (!source) continue;
    if (
      typeof citation.startIndex === "number" &&
      typeof citation.endIndex === "number" &&
      (citation.endIndex <= citation.startIndex || citation.startIndex < 0)
    ) {
      continue;
    }
    citations.push({
      id: citation.id,
      sourceId: source.id,
      title: source.title,
      url: source.url,
      domain: source.domain,
      ...(typeof citation.startIndex === "number" ? { startIndex: citation.startIndex } : {}),
      ...(typeof citation.endIndex === "number" ? { endIndex: citation.endIndex } : {}),
      retrievedAt: citation.retrievedAt,
      simulated: citation.simulated,
    });
    if (citations.length >= 64) break;
  }
  return { sources, citations };
}

export function buildResearchPresentation(input: {
  readonly presentationRunId?: string;
  readonly conversationId: string;
  readonly actingUserId: string;
  readonly query: string;
  readonly result: AiConversationResult;
  readonly routeKey?: AiWorkloadRouteKey;
  readonly provider: string;
  readonly initiatingUserMessageId?: string | null;
  readonly assistantMessageId?: string | null;
  readonly visualArtifactId?: string | null;
  readonly requiredPermissions: readonly string[];
}): AiPresentationPacket {
  const liveTool = webSearchToolSucceeded(input.result);
  const { sources: normalizedSources, citations: normalizedCitations } = normalizeResearchSources(
    input.result,
  );
  const mapped = mapFindingsToVerifiedCitations({
    text: input.result.text,
    citations: normalizedCitations.map((citation) => ({
      id: citation.id,
      sourceId: citation.sourceId,
      title: citation.title,
      url: citation.url,
      domain: citation.domain,
      retrievedAt: citation.retrievedAt,
      simulated: citation.simulated,
      ...(citation.startIndex === undefined ? {} : { startIndex: citation.startIndex }),
      ...(citation.endIndex === undefined ? {} : { endIndex: citation.endIndex }),
    })),
    sources: normalizedSources,
  });
  const findings = mapped.findings;
  const sourcesWithFindings = mapped.sources;
  const citations = mapped.citations;
  const insufficient = sourcesWithFindings.length === 0 || findings.length === 0;
  const summary = insufficient
    ? "No valid public-web evidence was returned for this request. I will not treat this as live web research."
    : input.result.text.split(/(?<=[.!?])\s+/u)[0]?.slice(0, 400) ||
      "The authorized research result is ready for review.";
  const packet: AiPresentationPacket = {
    contractVersion: AI_PRESENTATION_CONTRACT_VERSION,
    presentationRunId: input.presentationRunId ?? randomUUID(),
    conversationId: input.conversationId,
    initiatingUserMessageId: input.initiatingUserMessageId ?? null,
    assistantMessageId: input.assistantMessageId ?? null,
    actingUserId: input.actingUserId,
    routeKey: input.routeKey ?? "public_web_research",
    provider: input.provider,
    model: input.result.model,
    providerResponseId: input.result.responseId,
    status: insufficient ? "insufficient_evidence" : "ready",
    query: input.query.slice(0, 2_000),
    title: insufficient ? "Research evidence unavailable" : "Research presentation",
    summary,
    findings,
    implications: [],
    risks: insufficient
      ? [
          {
            id: "risk-1",
            title: "Insufficient evidence",
            body: "The provider did not return a valid cited source. Treat any remaining text as ungrounded.",
          },
        ]
      : [],
    recommendations: [],
    suggestedNextStep: insufficient
      ? "Retry with a more specific public question, or inspect authorized BEA records instead."
      : "Inspect the displayed sources, or select one and ask me to explain it.",
    sources: sourcesWithFindings,
    citations,
    visualArtifactId: input.visualArtifactId ?? null,
    narrationSegments: [],
    selected: null,
    autoFollow: true,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    usage: input.result.usage
      ? {
          inputTokens: input.result.usage.inputTokens,
          outputTokens: input.result.usage.outputTokens,
          totalTokens: input.result.usage.totalTokens,
          costClass: "standard",
          costStatus: "unavailable",
        }
      : null,
    error: insufficient
      ? {
          code: "INSUFFICIENT_RESEARCH_EVIDENCE",
          safeMessage: "No valid cited web evidence was returned.",
        }
      : null,
    simulated: input.result.simulated,
    liveWebSearch: liveTool && !input.result.simulated,
    requiredPermissions: input.requiredPermissions,
    beaRecordsLive: false,
    analysisValidated: false,
    lastCompletedNarrationSegmentId: null,
  };
  if (insufficient) {
    const fallback = evidenceFirstAnalysisFallback();
    return applyBriefingToPacket(
      {
        ...packet,
        risks: fallback.risksAndUncertainty,
        suggestedNextStep: fallback.suggestedNextStep,
      },
      {
        executiveSummary: packet.summary,
        keyFindings: packet.findings,
        implicationsForBea: fallback.implicationsForBea,
        risksAndUncertainty: fallback.risksAndUncertainty,
        recommendations: fallback.recommendations,
        suggestedNextStep: fallback.suggestedNextStep,
      },
      false,
    );
  }
  const authorized = {
    citationIds: new Set(citations.map((citation) => citation.id)),
    sourceIds: new Set(sourcesWithFindings.map((source) => source.id)),
  };
  const parsedBriefing = parseStructuredBriefingPayload(input.result.text);
  if (parsedBriefing !== null) {
    const structured = validateStructuredResearchBriefing(parsedBriefing, authorized);
    if (structured) return applyBriefingToPacket(packet, structured, true);
    const fallback = evidenceFirstAnalysisFallback();
    return applyBriefingToPacket(
      packet,
      {
        executiveSummary: packet.summary,
        keyFindings: packet.findings,
        implicationsForBea: fallback.implicationsForBea,
        risksAndUncertainty: fallback.risksAndUncertainty,
        recommendations: fallback.recommendations,
        suggestedNextStep: fallback.suggestedNextStep,
      },
      false,
    );
  }
  return applyBriefingToPacket(
    packet,
    deriveSituationSpecificAnalysis({
      query: input.query,
      summary: packet.summary,
      findings: packet.findings,
      sourceTitles: sourcesWithFindings.map((source) => source.title),
    }),
    true,
  );
}

function parseStructuredBriefingPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

export function buildLeadPresentation(input: {
  readonly presentationRunId?: string;
  readonly conversationId: string;
  readonly actingUserId: string;
  readonly query: string;
  readonly leads: readonly {
    readonly id: string;
    readonly reference: string;
    readonly opportunityName: string;
    readonly status: string;
    readonly blocking: readonly string[];
  }[];
  readonly provider: string;
  readonly model: string;
  readonly requiredPermissions: readonly string[];
  readonly initiatingUserMessageId?: string | null;
  readonly assistantMessageId?: string | null;
  readonly visualArtifactId?: string | null;
}): AiPresentationPacket {
  const blocked = input.leads.filter((lead) => lead.blocking.length > 0);
  const findings = (blocked.length > 0 ? blocked : input.leads).slice(0, 8).map((lead) => ({
    id: `lead-${lead.id}`,
    title: `${lead.reference} ${lead.opportunityName}`,
    body:
      lead.blocking.length > 0
        ? `${lead.opportunityName} is ${lead.status}. Blocking: ${lead.blocking.join("; ")}.`
        : `${lead.opportunityName} is ${lead.status} and is not blocked on missing intake information.`,
    sourceIds: [lead.id],
    citationIds: [],
  }));
  const summary =
    blocked.length > 0
      ? `${blocked.length} authorized lead${blocked.length === 1 ? "" : "s"} still need information before proposal work.`
      : `${input.leads.length} authorized lead${input.leads.length === 1 ? "" : "s"} matched. None currently report blocking intake gaps.`;
  const packet: AiPresentationPacket = {
    contractVersion: AI_PRESENTATION_CONTRACT_VERSION,
    presentationRunId: input.presentationRunId ?? randomUUID(),
    conversationId: input.conversationId,
    initiatingUserMessageId: input.initiatingUserMessageId ?? null,
    assistantMessageId: input.assistantMessageId ?? null,
    actingUserId: input.actingUserId,
    routeKey: "record_retrieval",
    provider: input.provider,
    model: input.model,
    providerResponseId: null,
    status: "ready",
    query: input.query.slice(0, 2_000),
    title: "Lead intake presentation",
    summary,
    findings,
    implications: [
      {
        id: "implication-1",
        title: "What this means for BEA",
        body: "Missing intake fields block proposal readiness. This is application-evaluated readiness, not a commercial authorization.",
      },
    ],
    risks: [
      {
        id: "risk-1",
        title: "Record class",
        body: "These are authorized records in the current environment. Demonstration fixtures are not live business data.",
      },
    ],
    recommendations: [
      {
        id: "recommendation-1",
        title: "Recommended next step",
        body: "Select a lead and ask what Russ should do next, or open the full Lead Command Record. I will not change status or send email.",
      },
    ],
    suggestedNextStep: "Select a lead in the right pane and ask me to explain it.",
    sources: input.leads.slice(0, 20).map((lead, index) => ({
      id: lead.id,
      number: index + 1,
      title: lead.opportunityName,
      domain: "command-center",
      url: `/leads/${lead.id}`,
      retrievedAt: new Date().toISOString(),
      supportsFindingIds: [`lead-${lead.id}`],
      simulated: true,
    })),
    citations: [],
    visualArtifactId: input.visualArtifactId ?? null,
    narrationSegments: [],
    selected: null,
    autoFollow: true,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    usage: null,
    error: null,
    simulated: true,
    liveWebSearch: false,
    beaRecordsLive: false,
    analysisValidated: true,
    lastCompletedNarrationSegmentId: null,
    requiredPermissions: input.requiredPermissions,
  };
  return {
    ...packet,
    narrationSegments: narrationSegmentsForPacket(packet),
  };
}

export function researchLabelForPacket(packet: AiPresentationPacket): string | null {
  if (packet.routeKey !== "public_web_research") return null;
  return liveWebSearchLabel({
    simulated: packet.simulated,
    webSearchToolCompleted: packet.liveWebSearch || (packet.simulated && packet.sources.length > 0),
  });
}

export function researchWorkspaceSubtitle(packet: AiPresentationPacket): string {
  const label = researchLabelForPacket(packet);
  if (label) return `${label} · ${packet.model}`;
  if (packet.routeKey === "record_retrieval") {
    return packet.beaRecordsLive
      ? "Authorized BEA records"
      : "Demonstration BEA records · not live business data";
  }
  if (packet.status === "insufficient_evidence") {
    return "No valid cited web evidence was returned";
  }
  return packet.simulated ? "Simulated research presentation" : `OpenAI · ${packet.model}`;
}

export function researchWorkspacePayload(packet: AiPresentationPacket): Record<string, unknown> {
  return {
    schemaVersion: 1,
    renderer: "research",
    summary: packet.summary,
    findings: packet.findings.map((finding) => finding.body),
    sections: [
      {
        heading: "Implications for BEA",
        body:
          packet.implications.map((item) => item.body).join("\n\n") ||
          (packet.analysisValidated === false
            ? "Situation-specific analysis is unavailable. Verified sources are retained."
            : ""),
      },
      {
        heading: "Risks and uncertainty",
        body: packet.risks.map((item) => item.body).join("\n\n"),
      },
      {
        heading: "Recommendations",
        body:
          packet.recommendations.map((item) => item.body).join("\n\n") ||
          (packet.analysisValidated === false
            ? "No validated recommendation is available. Review the cited evidence first."
            : ""),
      },
    ],
    sources: packet.sources,
    citations: packet.citations,
    disclosure: packet.simulated
      ? "DEMO MODE - these are deterministic synthetic web-search sources."
      : packet.liveWebSearch
        ? "OpenAI web-search sources. Review each source before relying on the result."
        : "No live web-search tool call completed. Do not treat this as live web research.",
    presentation: packet,
  };
}

export function createSimulatedResearchResult(query: string): AiConversationResult {
  const retrievedAt = new Date().toISOString();
  const text =
    "Water penetration testing remains a core envelope diagnostic. ASTM and AAMA methods distinguish laboratory ratings from field performance. For BEA, the material point is whether a project needs laboratory classification, field spray testing, or forensic leakage diagnosis. Sources disagree on which protocol is sufficient without a defined failure mode. I recommend mapping the request to intake fields before any site visit.";
  const sources: AiWebSource[] = [
    {
      id: "source-1",
      title: "ASTM water penetration testing methods",
      url: "https://astm.example.invalid/standards/water-penetration-testing",
      domain: "astm.example.invalid",
      retrievedAt,
      toolCallId: "tool-web-search-demo",
      simulated: true,
    },
    {
      id: "source-2",
      title: "AAMA field testing notes for fenestration",
      url: "https://aama.example.invalid/pages/field-testing",
      domain: "aama.example.invalid",
      retrievedAt,
      toolCallId: "tool-web-search-demo",
      simulated: true,
    },
    {
      id: "source-3",
      title: "Building envelope quality assurance overview",
      url: "https://nibs.example.invalid/building-enclosure",
      domain: "nibs.example.invalid",
      retrievedAt,
      toolCallId: "tool-web-search-demo",
      simulated: true,
    },
  ];
  const sentenceOne = "Water penetration testing remains a core envelope diagnostic.";
  const sentenceTwo =
    "ASTM and AAMA methods distinguish laboratory ratings from field performance.";
  const sentenceThree =
    "For BEA, the material point is whether a project needs laboratory classification, field spray testing, or forensic leakage diagnosis.";
  const startOne = text.indexOf(sentenceOne);
  const startTwo = text.indexOf(sentenceTwo);
  const startThree = text.indexOf(sentenceThree);
  return {
    responseId: `demo-research-${randomUUID()}`,
    model: "deterministic-demo-router",
    text,
    citations: [
      {
        id: "citation-1",
        sourceId: "source-1",
        title: sources[0]!.title,
        url: sources[0]!.url,
        domain: sources[0]!.domain,
        startIndex: startOne,
        endIndex: startOne + sentenceOne.length,
        retrievedAt,
        toolCallId: "tool-web-search-demo",
        simulated: true,
      },
      {
        id: "citation-2",
        sourceId: "source-2",
        title: sources[1]!.title,
        url: sources[1]!.url,
        domain: sources[1]!.domain,
        startIndex: startTwo,
        endIndex: startTwo + sentenceTwo.length,
        retrievedAt,
        toolCallId: "tool-web-search-demo",
        simulated: true,
      },
      {
        id: "citation-3",
        sourceId: "source-3",
        title: sources[2]!.title,
        url: sources[2]!.url,
        domain: sources[2]!.domain,
        startIndex: startThree,
        endIndex: startThree + sentenceThree.length,
        retrievedAt,
        toolCallId: "tool-web-search-demo",
        simulated: true,
      },
    ],
    webSources: sources,
    toolCalls: [
      {
        id: "tool-web-search-demo",
        name: "web_search",
        arguments: { query },
        status: "completed",
      },
    ],
    generatedArtifacts: [],
    usage: { inputTokens: 120, outputTokens: 180, totalTokens: 300 },
    completedAt: retrievedAt,
    simulated: true,
  };
}
