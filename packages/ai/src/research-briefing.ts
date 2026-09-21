import type {
  AiPresentationFinding,
  AiPresentationImplication,
  AiPresentationNarrationSegment,
  AiPresentationPacket,
  AiPresentationRecommendation,
  AiPresentationRisk,
} from "@bea/domain";
import { visualElementIdFor } from "./presentation.js";
import { EXECUTIVE_NARRATION_CLOSING } from "./executive-narration.js";

const HTML_OR_SCRIPT = /<\/?[a-z][\s\S]*>|javascript:|on\w+=/iu;
const SECRET_LIKE =
  /(?:sk-[A-Za-z0-9]{10,}|ek_[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9._\-]{12,}|api[_-]?key\s*[:=]\s*\S+)/iu;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const LIMITS = Object.freeze({
  summary: 800,
  findingBody: 800,
  analysisBody: 600,
  nextStep: 400,
  findings: 8,
  implications: 4,
  risks: 4,
  recommendations: 4,
});

export interface StructuredResearchBriefing {
  readonly executiveSummary: string;
  readonly keyFindings: readonly AiPresentationFinding[];
  readonly implicationsForBea: readonly AiPresentationImplication[];
  readonly risksAndUncertainty: readonly AiPresentationRisk[];
  readonly recommendations: readonly AiPresentationRecommendation[];
  readonly suggestedNextStep: string;
  readonly narrationSegments?: readonly AiPresentationNarrationSegment[];
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (!cleaned || cleaned.length > maximum) return null;
  if (HTML_OR_SCRIPT.test(cleaned) || SECRET_LIKE.test(cleaned)) return null;
  return cleaned;
}

function boundedItems<T>(
  value: unknown,
  maximum: number,
  mapItem: (item: Record<string, unknown>, index: number) => T | null,
): T[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const items: T[] = [];
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const mapped = mapItem(entry as Record<string, unknown>, index);
    if (!mapped) return null;
    items.push(mapped);
  }
  return items;
}

export function validateStructuredResearchBriefing(
  value: unknown,
  authorized: {
    readonly citationIds: ReadonlySet<string>;
    readonly sourceIds: ReadonlySet<string>;
  },
): StructuredResearchBriefing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const executiveSummary = boundedText(input.executiveSummary ?? input.summary, LIMITS.summary);
  const suggestedNextStep = boundedText(input.suggestedNextStep, LIMITS.nextStep);
  if (!executiveSummary || !suggestedNextStep) return null;
  const keyFindings = boundedItems(
    input.keyFindings ?? input.findings,
    LIMITS.findings,
    (item, index) => {
      const id =
        typeof item.id === "string" && STABLE_ID.test(item.id) ? item.id : `finding-${index + 1}`;
      const title = boundedText(item.title, 160) ?? `Finding ${index + 1}`;
      const body = boundedText(item.body, LIMITS.findingBody);
      if (!body) return null;
      const citationIds = Array.isArray(item.citationIds)
        ? item.citationIds.filter((idValue): idValue is string => typeof idValue === "string")
        : [];
      if (citationIds.some((citationId) => !authorized.citationIds.has(citationId))) return null;
      const sourceIds = Array.isArray(item.sourceIds)
        ? item.sourceIds.filter((idValue): idValue is string => typeof idValue === "string")
        : [];
      if (sourceIds.some((sourceId) => !authorized.sourceIds.has(sourceId))) return null;
      return { id, title, body, sourceIds, citationIds };
    },
  );
  const implicationsForBea = boundedItems(
    input.implicationsForBea ?? input.implications,
    LIMITS.implications,
    (item, index) => {
      const id =
        typeof item.id === "string" && STABLE_ID.test(item.id)
          ? item.id
          : `implication-${index + 1}`;
      const title = boundedText(item.title, 160) ?? "What this means for BEA";
      const body = boundedText(item.body, LIMITS.analysisBody);
      if (!body) return null;
      return { id, title, body };
    },
  );
  const risksAndUncertainty = boundedItems(
    input.risksAndUncertainty ?? input.risks,
    LIMITS.risks,
    (item, index) => {
      const id =
        typeof item.id === "string" && STABLE_ID.test(item.id) ? item.id : `risk-${index + 1}`;
      const title = boundedText(item.title, 160) ?? "Risks and uncertainty";
      const body = boundedText(item.body, LIMITS.analysisBody);
      if (!body) return null;
      return { id, title, body };
    },
  );
  const recommendations = boundedItems(
    input.recommendations,
    LIMITS.recommendations,
    (item, index) => {
      const id =
        typeof item.id === "string" && STABLE_ID.test(item.id)
          ? item.id
          : `recommendation-${index + 1}`;
      const title = boundedText(item.title, 160) ?? "Recommended next step";
      const body = boundedText(item.body, LIMITS.analysisBody);
      if (!body) return null;
      return { id, title, body };
    },
  );
  if (!keyFindings || !implicationsForBea || !risksAndUncertainty || !recommendations) return null;
  if (keyFindings.length === 0) return null;
  return {
    executiveSummary,
    keyFindings,
    implicationsForBea,
    risksAndUncertainty,
    recommendations,
    suggestedNextStep,
  };
}

export function evidenceFirstAnalysisFallback(): Pick<
  StructuredResearchBriefing,
  "implicationsForBea" | "risksAndUncertainty" | "recommendations" | "suggestedNextStep"
> & { readonly analysisValidated: false } {
  return {
    analysisValidated: false,
    implicationsForBea: [],
    risksAndUncertainty: [
      {
        id: "risk-evidence-only",
        title: "Analysis unavailable",
        body: "Situation-specific implications and recommendations were not validated. Review the cited sources directly. Public sources can disagree or omit building-envelope specifics.",
      },
    ],
    recommendations: [],
    suggestedNextStep:
      "Inspect the displayed sources. Ask about a selected source after reviewing the evidence.",
  };
}

export function deriveSituationSpecificAnalysis(input: {
  readonly query: string;
  readonly summary: string;
  readonly findings: readonly AiPresentationFinding[];
  readonly sourceTitles: readonly string[];
}): StructuredResearchBriefing {
  const query = input.query.replace(/\s+/gu, " ").trim();
  const findingBodies = input.findings.map((finding) => finding.body);
  const disagreement = findingBodies.find((body) =>
    /\b(disagree|uncertain|omit|conflict|insufficient|without a defined)\b/iu.test(body),
  );
  const protocol = findingBodies.find((body) =>
    /\b(astm|aama|laboratory|field|protocol|test)/iu.test(body),
  );
  const implicationBody = protocol
    ? `For this request (“${query.slice(0, 160)}”), the cited material indicates ${protocol.slice(0, 280)} Treat this as industry context for BEA scoping, not as a change to an authorized lead or procedure.`
    : `The cited public sources for “${query.slice(0, 160)}” should be used as industry context only. They are not BEA project records and do not change a lead, proposal, or field procedure by themselves.`;
  const riskBody = disagreement
    ? `${disagreement.slice(0, 280)} Confirm against authorized BEA records before acting.`
    : "Public sources can disagree or omit building-envelope specifics. Confirm against authorized BEA records before acting.";
  const recommendationBody = findingBodies.find((body) => /\brecommend/iu.test(body))
    ? `${findingBodies.find((body) => /\brecommend/iu.test(body))?.slice(0, 280)} Then inspect the displayed sources or select one for a follow-up.`
    : "Review the source board, then ask about a selected source or an authorized BEA lead if you want this applied to a live opportunity.";
  return {
    executiveSummary: input.summary.slice(0, LIMITS.summary),
    keyFindings: input.findings,
    implicationsForBea: [
      {
        id: "implication-1",
        title: "What this means for BEA",
        body: implicationBody.slice(0, LIMITS.analysisBody),
      },
    ],
    risksAndUncertainty: [
      {
        id: "risk-1",
        title: disagreement ? "Disagreement or uncertainty" : "Uncertainty",
        body: riskBody.slice(0, LIMITS.analysisBody),
      },
    ],
    recommendations: [
      {
        id: "recommendation-1",
        title: "Recommended next step",
        body: recommendationBody.slice(0, LIMITS.analysisBody),
      },
    ],
    suggestedNextStep: "Inspect the displayed sources, or select one and ask me to explain it.",
  };
}

export function narrationSegmentsForPacket(packet: {
  readonly summary: string;
  readonly findings: readonly AiPresentationFinding[];
  readonly implications: readonly AiPresentationImplication[];
  readonly risks: readonly AiPresentationRisk[];
  readonly recommendations: readonly AiPresentationRecommendation[];
  readonly suggestedNextStep: string;
}): AiPresentationNarrationSegment[] {
  const segments: AiPresentationNarrationSegment[] = [
    {
      id: "narration-summary",
      order: 1,
      visualElementId: visualElementIdFor("summary"),
      spokenText: `Here is the main takeaway. ${packet.summary}`.slice(0, 1_200),
    },
  ];
  packet.findings.slice(0, 5).forEach((finding, index) => {
    segments.push({
      id: `narration-finding-${index + 1}`,
      order: segments.length + 1,
      visualElementId: visualElementIdFor("finding", finding.id),
      spokenText: finding.body.slice(0, 1_200),
    });
  });
  if (packet.implications[0]) {
    segments.push({
      id: "narration-implication",
      order: segments.length + 1,
      visualElementId: visualElementIdFor("implication", packet.implications[0].id),
      spokenText: `What this means for BEA. ${packet.implications[0].body}`.slice(0, 1_200),
    });
  }
  if (packet.risks[0]) {
    segments.push({
      id: "narration-risk",
      order: segments.length + 1,
      visualElementId: visualElementIdFor("risk", packet.risks[0].id),
      spokenText: `A risk to keep in view: ${packet.risks[0].body}`.slice(0, 1_200),
    });
  }
  if (packet.recommendations[0]) {
    segments.push({
      id: "narration-recommendation",
      order: segments.length + 1,
      visualElementId: visualElementIdFor("recommendation", packet.recommendations[0].id),
      spokenText: `${packet.recommendations[0].body} ${packet.suggestedNextStep}`.slice(0, 1_200),
    });
  }
  segments.push({
    id: "narration-close",
    order: segments.length + 1,
    visualElementId: visualElementIdFor("summary"),
    spokenText: EXECUTIVE_NARRATION_CLOSING,
  });
  return segments;
}

export function applyBriefingToPacket(
  packet: AiPresentationPacket,
  briefing: StructuredResearchBriefing,
  analysisValidated: boolean,
): AiPresentationPacket {
  const next: AiPresentationPacket = {
    ...packet,
    summary: briefing.executiveSummary,
    findings: briefing.keyFindings,
    implications: briefing.implicationsForBea,
    risks: briefing.risksAndUncertainty,
    recommendations: briefing.recommendations,
    suggestedNextStep: briefing.suggestedNextStep,
    narrationSegments: [],
    analysisValidated,
  };
  return {
    ...next,
    narrationSegments: briefing.narrationSegments ?? narrationSegmentsForPacket(next),
  };
}
