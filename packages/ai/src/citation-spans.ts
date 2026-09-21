import type {
  AiPresentationCitation,
  AiPresentationFinding,
  AiPresentationSource,
} from "@bea/domain";
import type { AiCitation } from "./contracts.js";

export interface FindingTextSpan {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly start: number;
  readonly end: number;
}

const MINIMUM_FINDING_LENGTH = 24;
const MAXIMUM_FINDINGS = 8;

export function findingSpansFromText(text: string): readonly FindingTextSpan[] {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return [];
  const spans: FindingTextSpan[] = [];
  const sentencePattern = /[^.!?]+[.!?]+|[^.!?]+$/gu;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = sentencePattern.exec(normalized)) && spans.length < MAXIMUM_FINDINGS) {
    const body = match[0].trim();
    if (body.length < MINIMUM_FINDING_LENGTH && spans.length > 0) continue;
    if (body.length < 8) continue;
    const start = normalized.indexOf(body, match.index);
    const end = start + body.length;
    spans.push({
      id: `finding-${index + 1}`,
      title: `Finding ${index + 1}`,
      body: body.slice(0, 800),
      start: start < 0 ? match.index : start,
      end: start < 0 ? match.index + body.length : end,
    });
    index += 1;
  }
  if (spans.length === 0 && normalized) {
    return [
      {
        id: "finding-1",
        title: "Finding 1",
        body: normalized.slice(0, 400),
        start: 0,
        end: Math.min(normalized.length, 400),
      },
    ];
  }
  return spans;
}

export function citationOverlapsSpan(
  citation: Pick<AiCitation, "startIndex" | "endIndex">,
  span: Pick<FindingTextSpan, "start" | "end">,
): boolean {
  if (
    typeof citation.startIndex !== "number" ||
    typeof citation.endIndex !== "number" ||
    !Number.isFinite(citation.startIndex) ||
    !Number.isFinite(citation.endIndex) ||
    citation.endIndex <= citation.startIndex ||
    citation.startIndex < 0
  ) {
    return false;
  }
  return citation.startIndex < span.end && citation.endIndex > span.start;
}

export function mapFindingsToVerifiedCitations(input: {
  readonly text: string;
  readonly citations: readonly AiCitation[];
  readonly sources: readonly AiPresentationSource[];
  readonly explicitFindingCitations?: Readonly<Record<string, readonly string[]>>;
}): {
  readonly findings: readonly AiPresentationFinding[];
  readonly sources: readonly AiPresentationSource[];
  readonly citations: readonly AiPresentationCitation[];
} {
  const spans = findingSpansFromText(input.text);
  const citationsById = new Map(input.citations.map((citation) => [citation.id, citation]));
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const sourceByUrl = new Map(input.sources.map((source) => [source.url, source]));

  const findings: AiPresentationFinding[] = spans.map((span) => {
    const overlapping = input.citations.filter((citation) => citationOverlapsSpan(citation, span));
    const explicitIds = input.explicitFindingCitations?.[span.id] ?? [];
    const explicit = explicitIds
      .map((id) => citationsById.get(id))
      .filter((citation): citation is AiCitation => citation !== undefined);
    const verified = [...overlapping, ...explicit].filter(
      (citation, index, list) => list.findIndex((item) => item.id === citation.id) === index,
    );
    const citationIds = verified.map((citation) => citation.id);
    const sourceIds = [
      ...new Set(
        verified
          .map((citation) => {
            if (citation.sourceId && sourceById.has(citation.sourceId)) return citation.sourceId;
            return sourceByUrl.get(citation.url)?.id;
          })
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    return {
      id: span.id,
      title: span.title,
      body: span.body,
      sourceIds,
      citationIds,
    };
  });

  const supports = new Map<string, string[]>();
  for (const finding of findings) {
    for (const sourceId of finding.sourceIds) {
      const current = supports.get(sourceId) ?? [];
      current.push(finding.id);
      supports.set(sourceId, current);
    }
  }

  const sources = input.sources.map((source) => ({
    ...source,
    supportsFindingIds: supports.get(source.id) ?? [],
  }));

  const presentationCitations: AiPresentationCitation[] = input.citations.flatMap((citation) => {
    const source =
      (citation.sourceId ? sourceById.get(citation.sourceId) : undefined) ??
      sourceByUrl.get(citation.url);
    if (!source) return [];
    return [
      {
        id: citation.id,
        sourceId: source.id,
        title: source.title,
        url: source.url,
        domain: source.domain,
        ...(typeof citation.startIndex === "number" ? { startIndex: citation.startIndex } : {}),
        ...(typeof citation.endIndex === "number" ? { endIndex: citation.endIndex } : {}),
        retrievedAt: citation.retrievedAt,
        simulated: citation.simulated,
      },
    ];
  });

  return { findings, sources, citations: presentationCitations };
}
