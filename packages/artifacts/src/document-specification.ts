import {
  ArtifactValidationError,
  type ArtifactCitation,
  type BeaPdfDocumentInput,
  type BeaPdfFinding,
} from "./contracts.js";

export const EXECUTIVE_DOCUMENT_TEMPLATES = [
  "executive_briefing",
  "lead_review_brief",
  "research_brief",
  "decision_memo",
] as const;

export type ExecutiveDocumentTemplate = (typeof EXECUTIVE_DOCUMENT_TEMPLATES)[number];

export const EXECUTIVE_DOCUMENT_LENGTHS = [
  "one_page",
  "two_pages",
  "concise",
  "standard",
  "detailed",
] as const;

export type ExecutiveDocumentLength = (typeof EXECUTIVE_DOCUMENT_LENGTHS)[number];

export const OWNER_EVALUATION_DOCUMENT_DISCLOSURE =
  "Generated using live OpenAI with synthetic BEA evaluation records. External BEA systems are not connected.";

export const DRAFT_REVIEW_STATUS = "draft_human_review_required" as const;

const SECRET_LIKE =
  /\b(?:sk-[A-Za-z0-9]{10,}|api[_-]?key|authorization:\s*bearer|-----BEGIN (?:RSA )?PRIVATE KEY-----)\b/iu;
const MARKUP = /<\/?[a-z][\s\S]*>|javascript:|expression\(|url\(/iu;
const MAX_TITLE = 160;
const MAX_SECTION = 4_000;
const MAX_SUMMARY = 4_000;
const MAX_SECTIONS = 12;
const MAX_ITEMS = 20;

export interface ExecutiveDocumentSection {
  readonly id: string;
  readonly heading: string;
  readonly body: string;
}

export interface ExecutiveDocumentCitation {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly simulated: boolean;
  readonly source:
    "live_web_search" | "synthetic_bea_record" | "owner_provided" | "application_analysis";
}

export interface ExecutiveDocumentRecordRef {
  readonly id: string;
  readonly type: "lead" | "company" | "contact" | "task" | "activity" | "presentation";
  readonly label: string;
}

export interface ExecutiveDocumentSpecification {
  readonly documentId: string;
  readonly artifactId: string;
  readonly conversationId: string;
  readonly presentationRunId: string | null;
  readonly requestedByUserId: string;
  readonly template: ExecutiveDocumentTemplate;
  readonly title: string;
  readonly subtitle: string;
  readonly intendedAudience: string;
  readonly purpose: string;
  readonly executiveSummary: string;
  readonly sections: readonly ExecutiveDocumentSection[];
  readonly findings: readonly {
    readonly id: string;
    readonly title: string;
    readonly detail: string;
    readonly severity: "info" | "attention" | "critical";
  }[];
  readonly implications: readonly string[];
  readonly risks: readonly string[];
  readonly recommendations: readonly string[];
  readonly nextSteps: readonly string[];
  readonly sourceCitations: readonly ExecutiveDocumentCitation[];
  readonly beaRecordReferences: readonly ExecutiveDocumentRecordRef[];
  readonly disclosure: string;
  readonly liveDataDisclosure: string;
  readonly provider: string;
  readonly model: string;
  readonly route: string;
  readonly generatedAt: string;
  readonly version: number;
  readonly parentVersion: number | null;
  readonly requiredPermissions: readonly string[];
  readonly reviewStatus: typeof DRAFT_REVIEW_STATUS | "reviewed" | "client_deliverable";
  readonly outputLength: ExecutiveDocumentLength;
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.trim())) {
    throw new ArtifactValidationError("INVALID_DOCUMENT_SPEC", `${label} is invalid.`);
  }
  return value.trim();
}

function requiredUuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new ArtifactValidationError("INVALID_DOCUMENT_SPEC", `${label} is invalid.`);
  }
  return value.toLowerCase();
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") {
    throw new ArtifactValidationError("INVALID_DOCUMENT_SPEC", `${label} is required.`);
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > max) {
    throw new ArtifactValidationError("INVALID_DOCUMENT_SPEC", `${label} is invalid.`);
  }
  if (SECRET_LIKE.test(normalized) || MARKUP.test(normalized)) {
    throw new ArtifactValidationError(
      "INVALID_DOCUMENT_SPEC",
      `${label} contains unsupported content.`,
    );
  }
  return normalized;
}

function optionalText(value: unknown, label: string, max: number, fallback = ""): string {
  if (value === undefined || value === null || value === "") return fallback;
  return requiredText(value, label, max);
}

function stringList(
  value: unknown,
  label: string,
  maxItems: number,
  maxLength: number,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ArtifactValidationError("INVALID_DOCUMENT_SPEC", `${label} is invalid.`);
  }
  if (value.length > maxItems) {
    throw new ArtifactValidationError(
      "INVALID_DOCUMENT_SPEC",
      `${label} exceeds the allowed count.`,
    );
  }
  return value.map((item, index) => requiredText(item, `${label} ${index + 1}`, maxLength));
}

export function sanitizePdfFilename(input: {
  readonly template: ExecutiveDocumentTemplate;
  readonly subject: string;
  readonly generatedAt: string;
  readonly version: number;
}): string {
  const templateLabel: Record<ExecutiveDocumentTemplate, string> = {
    executive_briefing: "Executive-Briefing",
    lead_review_brief: "Lead-Review-Brief",
    research_brief: "Research-Brief",
    decision_memo: "Decision-Memo",
  };
  const subject =
    input.subject
      .normalize("NFKD")
      .replace(/[^\w]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "Document";
  const date = input.generatedAt.slice(0, 10) || "undated";
  const version = Number.isSafeInteger(input.version) && input.version > 0 ? input.version : 1;
  return `BEA-${templateLabel[input.template]}-${subject}-${date}-v${version}.pdf`;
}

export function validateExecutiveDocumentSpecification(
  value: unknown,
): ExecutiveDocumentSpecification {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactValidationError(
      "INVALID_DOCUMENT_SPEC",
      "The document specification is invalid.",
    );
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.template !== "string" ||
    !EXECUTIVE_DOCUMENT_TEMPLATES.includes(input.template as ExecutiveDocumentTemplate)
  ) {
    throw new ArtifactValidationError(
      "INVALID_DOCUMENT_SPEC",
      "The document template is unsupported.",
    );
  }
  if (
    typeof input.outputLength === "string" &&
    !EXECUTIVE_DOCUMENT_LENGTHS.includes(input.outputLength as ExecutiveDocumentLength)
  ) {
    throw new ArtifactValidationError(
      "INVALID_DOCUMENT_SPEC",
      "The requested output length is unsupported.",
    );
  }
  const generatedAt =
    typeof input.generatedAt === "string" && !Number.isNaN(Date.parse(input.generatedAt))
      ? new Date(input.generatedAt).toISOString()
      : new Date().toISOString();
  const sectionsRaw = Array.isArray(input.sections) ? input.sections : [];
  if (sectionsRaw.length > MAX_SECTIONS) {
    throw new ArtifactValidationError(
      "INVALID_DOCUMENT_SPEC",
      "The document has too many sections.",
    );
  }
  const citationsRaw = Array.isArray(input.sourceCitations) ? input.sourceCitations : [];
  const citationIds = new Set<string>();
  const sourceCitations: ExecutiveDocumentCitation[] = citationsRaw.map((item, index) => {
    const citation = item as Record<string, unknown>;
    const url = requiredText(citation.url, `Citation ${index + 1} URL`, 500);
    if (
      !/^https:\/\/[A-Za-z0-9.-]+(?:\/[\w./\-?#&=%]*)?$/u.test(url) &&
      url !== "https://bea.local/synthetic-evaluation"
    ) {
      throw new ArtifactValidationError("INVALID_DOCUMENT_SPEC", "A citation URL is not allowed.");
    }
    const id = requiredId(citation.id ?? `S${index + 1}`, `Citation ${index + 1} ID`);
    if (citationIds.has(id)) {
      throw new ArtifactValidationError("INVALID_DOCUMENT_SPEC", "Citation IDs must be unique.");
    }
    citationIds.add(id);
    const source = citation.source;
    if (
      source !== "live_web_search" &&
      source !== "synthetic_bea_record" &&
      source !== "owner_provided" &&
      source !== "application_analysis"
    ) {
      throw new ArtifactValidationError(
        "INVALID_DOCUMENT_SPEC",
        "Citation source class is invalid.",
      );
    }
    return {
      id,
      title: requiredText(citation.title, `Citation ${index + 1} title`, 200),
      url,
      domain: requiredText(citation.domain ?? "bea.local", `Citation ${index + 1} domain`, 120),
      simulated: citation.simulated === true || source !== "live_web_search",
      source,
    };
  });
  const records = Array.isArray(input.beaRecordReferences) ? input.beaRecordReferences : [];
  const beaRecordReferences: ExecutiveDocumentRecordRef[] = records.map((item, index) => {
    const record = item as Record<string, unknown>;
    const type = record.type;
    if (
      type !== "lead" &&
      type !== "company" &&
      type !== "contact" &&
      type !== "task" &&
      type !== "activity" &&
      type !== "presentation"
    ) {
      throw new ArtifactValidationError(
        "INVALID_DOCUMENT_SPEC",
        "A BEA record reference type is invalid.",
      );
    }
    return {
      id: requiredUuid(record.id, `Record ${index + 1}`),
      type,
      label: requiredText(record.label, `Record ${index + 1} label`, 160),
    };
  });
  const findingsRaw = Array.isArray(input.findings) ? input.findings : [];
  const spec: ExecutiveDocumentSpecification = {
    documentId: requiredUuid(input.documentId, "document ID"),
    artifactId: requiredUuid(input.artifactId, "artifact ID"),
    conversationId: requiredUuid(input.conversationId, "conversation ID"),
    presentationRunId:
      input.presentationRunId === null || input.presentationRunId === undefined
        ? null
        : requiredUuid(input.presentationRunId, "presentation run ID"),
    requestedByUserId: requiredUuid(input.requestedByUserId, "requestedByUserId"),
    template: input.template as ExecutiveDocumentTemplate,
    title: requiredText(input.title, "title", MAX_TITLE),
    subtitle: optionalText(input.subtitle, "subtitle", 200),
    intendedAudience: optionalText(input.intendedAudience, "intended audience", 120, "Owner"),
    purpose: optionalText(input.purpose, "purpose", 500, "Executive briefing"),
    executiveSummary: requiredText(input.executiveSummary, "executive summary", MAX_SUMMARY),
    sections: sectionsRaw.map((item, index) => {
      const section = item as Record<string, unknown>;
      return {
        id: requiredId(section.id ?? `section-${index + 1}`, `Section ${index + 1} ID`),
        heading: requiredText(section.heading, `Section ${index + 1} heading`, 120),
        body: requiredText(section.body, `Section ${index + 1} body`, MAX_SECTION),
      };
    }),
    findings: findingsRaw.map((item, index) => {
      const finding = item as Record<string, unknown>;
      const severity = finding.severity;
      if (severity !== "info" && severity !== "attention" && severity !== "critical") {
        throw new ArtifactValidationError(
          "INVALID_DOCUMENT_SPEC",
          "Finding severity is unsupported.",
        );
      }
      return {
        id: requiredId(finding.id ?? `F${index + 1}`, `Finding ${index + 1} ID`),
        title: requiredText(finding.title, `Finding ${index + 1} title`, 200),
        detail: requiredText(finding.detail, `Finding ${index + 1} detail`, 2_000),
        severity,
      };
    }),
    implications: stringList(input.implications ?? [], "implications", MAX_ITEMS, 500),
    risks: stringList(input.risks ?? [], "risks", MAX_ITEMS, 500),
    recommendations: stringList(input.recommendations ?? [], "recommendations", MAX_ITEMS, 500),
    nextSteps: stringList(input.nextSteps ?? [], "next steps", MAX_ITEMS, 500),
    sourceCitations,
    beaRecordReferences,
    disclosure: OWNER_EVALUATION_DOCUMENT_DISCLOSURE,
    liveDataDisclosure: requiredText(
      input.liveDataDisclosure ?? OWNER_EVALUATION_DOCUMENT_DISCLOSURE,
      "live data disclosure",
      1_000,
    ),
    provider: requiredText(input.provider ?? "openai", "provider", 64),
    model: requiredText(input.model ?? "unassigned", "model", 255),
    route: requiredText(input.route ?? "pdf_narrative_generation", "route", 64),
    generatedAt,
    version:
      typeof input.version === "number" && Number.isSafeInteger(input.version) && input.version > 0
        ? input.version
        : 1,
    parentVersion:
      input.parentVersion === null || input.parentVersion === undefined
        ? null
        : typeof input.parentVersion === "number" &&
            Number.isSafeInteger(input.parentVersion) &&
            input.parentVersion > 0
          ? input.parentVersion
          : (() => {
              throw new ArtifactValidationError(
                "INVALID_DOCUMENT_SPEC",
                "Parent version is invalid.",
              );
            })(),
    requiredPermissions: stringList(
      input.requiredPermissions ?? ["ai-command.run", "documents.view"],
      "permissions",
      12,
      80,
    ),
    reviewStatus: DRAFT_REVIEW_STATUS,
    outputLength: (input.outputLength as ExecutiveDocumentLength | undefined) ?? "standard",
  };
  if (spec.findings.length < 1) {
    throw new ArtifactValidationError("INVALID_DOCUMENT_SPEC", "At least one finding is required.");
  }
  if (spec.sourceCitations.length < 1) {
    throw new ArtifactValidationError(
      "INVALID_DOCUMENT_SPEC",
      "At least one citation is required.",
    );
  }
  return spec;
}

export function documentSpecificationToPdfInput(
  specification: ExecutiveDocumentSpecification,
): BeaPdfDocumentInput {
  const findings: BeaPdfFinding[] = specification.findings.map((finding) => ({
    title: finding.title,
    detail: finding.detail,
    severity: finding.severity,
  }));
  const citations: ArtifactCitation[] = specification.sourceCitations.map((citation) => ({
    title: citation.title,
    url: citation.url,
    domain: citation.domain,
    accessedAt: specification.generatedAt,
  }));
  const extraSections = [
    ...specification.implications.map((item) => `Implication: ${item}`),
    ...specification.risks.map((item) => `Risk: ${item}`),
    ...specification.recommendations.map((item) => `Recommendation: ${item}`),
    ...specification.nextSteps.map((item) => `Next step: ${item}`),
    `Review status: DRAFT — HUMAN REVIEW REQUIRED.`,
    specification.liveDataDisclosure,
  ];
  return {
    title: specification.title,
    summary: [
      specification.executiveSummary,
      ...specification.sections.map((section) => `${section.heading}: ${section.body}`),
      ...extraSections,
    ]
      .join("\n\n")
      .slice(0, 5_000),
    findings,
    citations,
    disclosure: specification.disclosure,
    generatedAt: specification.generatedAt,
    reportDate: specification.generatedAt.slice(0, 10),
    requestedBy: specification.intendedAudience,
  };
}

export function pdfNarrationSegments(specification: ExecutiveDocumentSpecification): readonly {
  readonly id: string;
  readonly kind: "summary" | "section" | "finding" | "recommendation" | "source";
  readonly label: string;
  readonly text: string;
}[] {
  return [
    {
      id: "summary",
      kind: "summary",
      label: "Executive summary",
      text: specification.executiveSummary,
    },
    ...specification.sections.map((section) => ({
      id: section.id,
      kind: "section" as const,
      label: section.heading,
      text: section.body,
    })),
    ...specification.findings.map((finding) => ({
      id: finding.id,
      kind: "finding" as const,
      label: finding.title,
      text: finding.detail,
    })),
    ...specification.recommendations.map((item, index) => ({
      id: `recommendation-${index + 1}`,
      kind: "recommendation" as const,
      label: `Recommendation ${index + 1}`,
      text: item,
    })),
    ...specification.sourceCitations.map((citation) => ({
      id: citation.id,
      kind: "source" as const,
      label: citation.title,
      text: `${citation.title} (${citation.source.replaceAll("_", " ")})`,
    })),
  ];
}
