import "server-only";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ArtifactValidationError,
  composeBeaPdf,
  documentSpecificationToPdfInput,
  normalizeArtifactManifest,
  pdfNarrationSegments,
  RepositoryArtifactFileStore,
  sanitizePdfFilename,
  validateExecutiveDocumentSpecification,
  OWNER_EVALUATION_DOCUMENT_DISCLOSURE,
  type ExecutiveDocumentLength,
  type ExecutiveDocumentSpecification,
  type ExecutiveDocumentTemplate,
  type PdfArtifactManifest,
  type StoredArtifactFile,
} from "@bea/artifacts";
import type { BeaServerRuntime } from "@bea/database";
import type { JsonObject } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";

import {
  effectiveArtifactRetentionMilliseconds,
  effectiveGeneratedArtifactBytes,
} from "./artifact-settings";
import { OpenAiAdministrationError } from "./openai-administration";

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const SYNTHETIC_CITATION = {
  id: "S1",
  title: "Synthetic BEA evaluation records",
  url: "https://bea.local/synthetic-evaluation",
  domain: "bea.local",
  simulated: true,
  source: "synthetic_bea_record" as const,
};

export interface ExecutivePdfRequest {
  readonly conversationId: string;
  readonly title?: string;
  readonly template?: ExecutiveDocumentTemplate;
  readonly outputLength?: ExecutiveDocumentLength;
  readonly instructions?: string;
  readonly leadId?: string;
  readonly presentationRunId?: string;
  readonly sourceArtifactIds?: readonly string[];
  readonly parentArtifactId?: string;
  readonly model?: string;
  readonly provider?: string;
}

export interface ExecutivePdfResult {
  readonly specification: ExecutiveDocumentSpecification;
  readonly artifactId: string;
  readonly storageId: string;
  readonly filename: string;
  readonly downloadPath: string;
  readonly previewPath: string;
  readonly narration: ReturnType<typeof pdfNarrationSegments>;
  readonly manifest: PdfArtifactManifest;
  readonly workspacePayload: JsonObject;
  readonly stored: StoredArtifactFile;
}

function optionalUuid(value: string | undefined): string | null {
  if (!value) return null;
  return UUID.test(value) ? value.toLowerCase() : null;
}

async function authorizeLead(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly correlationId: string;
  readonly leadId?: string;
}): Promise<{ readonly id: string; readonly label: string } | null> {
  const term = input.leadId?.replace(/\s+/gu, " ").trim();
  if (!term) return null;
  await input.runtime.authorization.requireUser({
    userId: input.userId,
    permission: PERMISSIONS.LEADS_VIEW,
    action: "ai-command.executive-pdf.lead",
    resourceType: "lead",
    correlationId: input.correlationId,
  });
  const uuid = optionalUuid(term);
  if (uuid) {
    const record = await input.runtime.leads.getLead(uuid);
    if (!record) {
      throw new OpenAiAdministrationError(
        "LEAD_NOT_AUTHORIZED",
        404,
        "The requested lead is not an authorized BEA record.",
      );
    }
    return {
      id: record.lead.id,
      label: `${record.lead.reference} ${record.lead.opportunityName}`.trim(),
    };
  }
  const matches = await input.runtime.leads.listLeads({ query: term.slice(0, 80), limit: 5 });
  const match = matches.find(
    (item) =>
      item.lead.opportunityName.toLowerCase().includes(term.toLowerCase()) ||
      item.lead.reference.toLowerCase() === term.toLowerCase() ||
      (item.primaryCompanyName ?? "").toLowerCase().includes(term.toLowerCase()),
  );
  if (!match) {
    throw new OpenAiAdministrationError(
      "LEAD_NOT_AUTHORIZED",
      404,
      "The requested lead is not an authorized BEA record.",
    );
  }
  return {
    id: match.lead.id,
    label: `${match.lead.reference} ${match.lead.opportunityName}`.trim(),
  };
}

function packetRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textItems(value: unknown, max: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      const record = packetRecord(item);
      const text = record?.body ?? record?.detail ?? record?.text ?? record?.title;
      return typeof text === "string" ? [text] : [];
    })
    .map((item) => item.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, max);
}

async function loadPresentationContext(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly conversationId: string;
  readonly presentationRunId?: string;
}): Promise<{
  readonly presentationRunId: string | null;
  readonly findings: ExecutiveDocumentSpecification["findings"];
  readonly implications: readonly string[];
  readonly risks: readonly string[];
  readonly recommendations: readonly string[];
  readonly citations: ExecutiveDocumentSpecification["sourceCitations"];
  readonly summary: string | null;
}> {
  const requestedId = optionalUuid(input.presentationRunId);
  const latest = await input.runtime.ai.persistence.getLatestPresentationRunForConversation(
    input.conversationId,
    input.userId,
  );
  const packet = packetRecord(latest?.packet);
  if (!latest || !packet) {
    return {
      presentationRunId: requestedId,
      findings: [],
      implications: [],
      risks: [],
      recommendations: [],
      citations: [],
      summary: null,
    };
  }
  const findingsRaw = Array.isArray(packet.findings) ? packet.findings : [];
  const sources = Array.isArray(packet.sources) ? packet.sources : [];
  const citations = sources.flatMap((item, index) => {
    const source = packetRecord(item);
    const url = typeof source?.url === "string" ? source.url : "";
    if (!url.startsWith("https://")) return [];
    return [
      {
        id: typeof source?.id === "string" ? source.id : `S${index + 1}`,
        title: typeof source?.title === "string" ? source.title : `Source ${index + 1}`,
        url,
        domain: typeof source?.domain === "string" ? source.domain : "bea.local",
        simulated: source?.simulated === true,
        source: (source?.simulated === true ? "synthetic_bea_record" : "live_web_search") as
          "synthetic_bea_record" | "live_web_search",
      },
    ];
  });
  return {
    presentationRunId: latest.id,
    findings: findingsRaw.flatMap((item, index) => {
      const finding = packetRecord(item);
      const title = typeof finding?.title === "string" ? finding.title : "";
      const detail =
        typeof finding?.body === "string"
          ? finding.body
          : typeof finding?.detail === "string"
            ? finding.detail
            : "";
      if (!title || !detail) return [];
      return [
        {
          id: typeof finding?.id === "string" ? finding.id : `F${index + 1}`,
          title,
          detail,
          severity: "attention" as const,
        },
      ];
    }),
    implications: textItems(packet.implications, 12),
    risks: textItems(packet.risks, 12),
    recommendations: textItems(packet.recommendations, 12),
    citations,
    summary: typeof packet.summary === "string" ? packet.summary : null,
  };
}

function applyRevisionInstructions(
  spec: Omit<ExecutiveDocumentSpecification, "outputLength"> & {
    readonly outputLength: ExecutiveDocumentLength;
  },
  instructions: string,
  outputLength: ExecutiveDocumentLength,
): typeof spec {
  const lower = instructions.toLowerCase();
  let sections = [...spec.sections];
  if (lower.includes("remove the technical background") || lower.includes("remove technical")) {
    sections = sections.filter((section) => !/technical|background/iu.test(section.heading));
  }
  if (lower.includes("recommendations first")) {
    sections = [
      {
        id: "recommendations",
        heading: "Recommendations",
        body: spec.recommendations.join(" "),
      },
      ...sections.filter((section) => section.id !== "recommendations"),
    ];
  }
  const audience = lower.includes("address this to russ")
    ? "Russ"
    : lower.includes("client")
      ? "Client review"
      : spec.intendedAudience;
  const summary =
    outputLength === "one_page" || outputLength === "concise" || lower.includes("more concise")
      ? spec.executiveSummary.slice(0, 720)
      : spec.executiveSummary;
  return {
    ...spec,
    intendedAudience: audience,
    executiveSummary: summary,
    sections:
      outputLength === "one_page" || outputLength === "concise" ? sections.slice(0, 3) : sections,
    outputLength,
  };
}

export function executivePdfWorkspacePayload(input: {
  readonly specification: ExecutiveDocumentSpecification;
  readonly stored: StoredArtifactFile;
  readonly ownerId: string;
  readonly relatedLeadId: string | null;
  readonly parentArtifactId: string | null;
  readonly generatedArtifactId: string;
  readonly versions: readonly {
    readonly id: string;
    readonly version: number;
    readonly createdAt: string;
    readonly title: string;
  }[];
}): JsonObject {
  const manifest = normalizeArtifactManifest({
    artifactId: input.stored.id,
    citations: input.specification.sourceCitations.map((citation) => ({
      title: citation.title,
      url: citation.url,
      domain: citation.domain,
      accessedAt: input.specification.generatedAt,
    })),
    createdAt: input.specification.generatedAt,
    disclosure: input.specification.disclosure,
    ownerId: input.ownerId,
    schemaVersion: 1,
    summary: input.specification.executiveSummary.slice(0, 2_000),
    title: input.specification.title,
    renderer: "pdf",
    file: {
      filename: input.stored.filename,
      id: input.stored.id,
      mimeType: input.stored.mimeType,
      sha256: input.stored.sha256,
      size: input.stored.size,
    },
  });
  return jsonObject({
    ...manifest,
    executiveDocument: {
      documentId: input.specification.documentId,
      generatedArtifactId: input.generatedArtifactId,
      reviewStatus: input.specification.reviewStatus,
      reviewLabel: "DRAFT — HUMAN REVIEW REQUIRED",
      version: input.specification.version,
      parentVersion: input.specification.parentVersion,
      parentArtifactId: input.parentArtifactId,
      presentationRunId: input.specification.presentationRunId,
      relatedLeadId: input.relatedLeadId,
      relatedLeadPath: input.relatedLeadId ? `/leads/${input.relatedLeadId}` : null,
      template: input.specification.template,
      disclosure: input.specification.liveDataDisclosure,
      versions: input.versions,
      narration: pdfNarrationSegments(input.specification),
    },
  });
}

export async function generateExecutivePdfArtifact(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly correlationId: string;
  readonly responseRunId?: string | null;
  readonly request: ExecutivePdfRequest;
}): Promise<ExecutivePdfResult> {
  for (const permission of [PERMISSIONS.AI_COMMAND_RUN, PERMISSIONS.DOCUMENTS_VIEW] as const) {
    await input.runtime.authorization.requireUser({
      userId: input.userId,
      permission,
      action: "ai-command.executive-pdf.generate",
      resourceType: "generated-artifact",
      correlationId: input.correlationId,
    });
  }
  const settings = await input.runtime.ai.persistence.getProviderSettings();
  if (settings.pdfGenerationAllowed === false && input.runtime.environment.appMode !== "demo") {
    throw new OpenAiAdministrationError(
      "EXECUTIVE_PDF_DISABLED",
      409,
      "PDF generation is disabled in provider settings.",
    );
  }
  const rate = await input.runtime.ai.persistence.consumeRateLimit({
    subjectKey: `executive-pdf:${input.userId}`,
    routeKey: "executive-pdf.generate",
    limit: 8,
    windowSeconds: 300,
  });
  if (!rate.allowed) {
    throw new OpenAiAdministrationError(
      "EXECUTIVE_PDF_RATE_LIMITED",
      429,
      "PDF generation is temporarily rate limited.",
    );
  }

  let parentSpec: ExecutiveDocumentSpecification | null = null;
  let parentVersion: number | null = null;
  if (input.request.parentArtifactId) {
    const parentId = input.request.parentArtifactId.trim();
    const parentResult = await input.runtime.database.query<{
      specification: unknown;
    }>(
      `SELECT specification FROM generated_artifacts
       WHERE (id::text=$1 OR storage_reference=$1) AND requested_by_user_id::text=$2 LIMIT 1`,
      [parentId, input.userId],
    );
    const parent = parentResult.rows[0];
    if (!parent) {
      throw new OpenAiAdministrationError(
        "ARTIFACT_NOT_FOUND",
        404,
        "The source PDF artifact was not found.",
      );
    }
    try {
      parentSpec = validateExecutiveDocumentSpecification(parent.specification);
      parentVersion = parentSpec.version;
    } catch {
      parentSpec = null;
    }
  }

  const lead = await authorizeLead({
    runtime: input.runtime,
    userId: input.userId,
    correlationId: input.correlationId,
    leadId: input.request.leadId,
  });
  const presentation = await loadPresentationContext({
    runtime: input.runtime,
    userId: input.userId,
    conversationId: input.request.conversationId,
    presentationRunId:
      input.request.presentationRunId ?? parentSpec?.presentationRunId ?? undefined,
  });

  const generatedAt = new Date().toISOString();
  const documentId = randomUUID();
  const artifactId = randomUUID();
  const template = input.request.template ?? parentSpec?.template ?? "executive_briefing";
  const title =
    input.request.title ??
    parentSpec?.title ??
    (lead ? `${lead.label} executive briefing` : "BEA executive briefing");
  const instructions = input.request.instructions?.trim() ?? "";
  const outputLength = input.request.outputLength ?? parentSpec?.outputLength ?? "standard";
  const summarySeed =
    parentSpec?.executiveSummary ??
    presentation.summary ??
    (instructions
      ? instructions.slice(0, 1_200)
      : "This draft briefing summarizes authorized BEA evaluation evidence. It is not a final client deliverable.");
  const draft = validateExecutiveDocumentSpecification({
    documentId,
    artifactId,
    conversationId: input.request.conversationId,
    presentationRunId: presentation.presentationRunId ?? parentSpec?.presentationRunId ?? null,
    requestedByUserId: input.userId,
    template,
    title,
    subtitle: parentSpec?.subtitle ?? "Owner Evaluation draft",
    intendedAudience: parentSpec?.intendedAudience ?? "Owner",
    purpose: parentSpec?.purpose ?? "Create a BEA-branded executive briefing for review.",
    executiveSummary: summarySeed,
    sections: parentSpec?.sections.length
      ? parentSpec.sections
      : [
          {
            id: "context",
            heading: "Context",
            body: lead
              ? `Authorized lead ${lead.label} and cited public research were reauthorized before this draft was composed.`
              : "Authorized synthetic BEA records and any cited public research were reauthorized before this draft was composed.",
          },
        ],
    findings:
      parentSpec?.findings.length || presentation.findings.length
        ? parentSpec?.findings.length
          ? parentSpec.findings
          : presentation.findings
        : [
            {
              id: "F1",
              title: "Evaluation evidence is bounded",
              detail:
                "This Owner Evaluation draft uses synthetic BEA records. External CRM, accounting, and Microsoft systems are not connected.",
              severity: "attention",
            },
          ],
    implications:
      parentSpec?.implications.length || presentation.implications.length
        ? parentSpec?.implications.length
          ? parentSpec.implications
          : presentation.implications
        : ["Treat this document as an internal draft until a human marks it reviewed."],
    risks:
      parentSpec?.risks.length || presentation.risks.length
        ? parentSpec?.risks.length
          ? parentSpec.risks
          : presentation.risks
        : ["Live provider content may be incomplete if Web Search or Realtime is not enabled."],
    recommendations:
      parentSpec?.recommendations.length || presentation.recommendations.length
        ? parentSpec?.recommendations.length
          ? parentSpec.recommendations
          : presentation.recommendations
        : [
            "Review the briefing in the right workspace, then request a revision rather than editing the file directly.",
          ],
    nextSteps: parentSpec?.nextSteps ?? [
      "Keep the PDF open while asking follow-up questions in Type or Voice Mode.",
    ],
    sourceCitations:
      parentSpec?.sourceCitations.length || presentation.citations.length
        ? parentSpec?.sourceCitations.length
          ? parentSpec.sourceCitations
          : presentation.citations
        : [SYNTHETIC_CITATION],
    beaRecordReferences: parentSpec?.beaRecordReferences.length
      ? parentSpec.beaRecordReferences
      : lead
        ? [{ id: lead.id, type: "lead", label: lead.label }]
        : [],
    disclosure: OWNER_EVALUATION_DOCUMENT_DISCLOSURE,
    liveDataDisclosure: OWNER_EVALUATION_DOCUMENT_DISCLOSURE,
    provider: input.request.provider ?? "openai",
    model: input.request.model ?? "unassigned",
    route: "pdf_narrative_generation",
    generatedAt,
    version: parentVersion ? parentVersion + 1 : 1,
    parentVersion,
    requiredPermissions: lead
      ? ["ai-command.run", "documents.view", "leads.view"]
      : ["ai-command.run", "documents.view"],
    reviewStatus: "draft_human_review_required",
    outputLength,
  });
  const spec = instructions
    ? validateExecutiveDocumentSpecification(
        applyRevisionInstructions(draft, instructions, outputLength),
      )
    : draft;

  const logoBytes = await readFile(
    join(input.runtime.repositoryRoot, "apps", "web", "public", "brand", "cpl-logo.png"),
  );
  const pdfBytes = await composeBeaPdf(documentSpecificationToPdfInput(spec), { logoBytes });
  const maxBytes = effectiveGeneratedArtifactBytes(settings.maxUploadBytes);
  if (pdfBytes.byteLength > maxBytes) {
    throw new ArtifactValidationError(
      "ARTIFACT_TOO_LARGE",
      "The generated PDF exceeds the allowed size.",
    );
  }
  const filename = sanitizePdfFilename({
    template: spec.template,
    subject: spec.title,
    generatedAt: spec.generatedAt,
    version: spec.version,
  });
  const store = new RepositoryArtifactFileStore({
    repositoryRoot: input.runtime.repositoryRoot,
    retentionMilliseconds: effectiveArtifactRetentionMilliseconds(settings.artifactRetentionDays),
  });
  const stored = await store.put(input.userId, {
    bytes: pdfBytes,
    filename,
    mimeType: "application/pdf",
  });
  const persistedId = await input.runtime.ai.persistence.recordGeneratedArtifact({
    conversationId: spec.conversationId,
    responseRunId: input.responseRunId ?? null,
    requestedByUserId: input.userId,
    kind: "pdf",
    title: spec.title,
    status: "ready",
    artifactVersion: spec.version,
    provider: "application",
    providerItemId: null,
    providerContainerId: null,
    providerFileId: null,
    filename,
    mediaType: "application/pdf",
    storageReference: stored.id,
    specification: jsonObject(spec),
    sourceMetadata: jsonObject({
      presentationRunId: spec.presentationRunId,
      parentArtifactId: input.request.parentArtifactId ?? null,
      leadId: lead?.id ?? null,
      sourceArtifactIds: input.request.sourceArtifactIds ?? [],
    }),
    citationIds: spec.sourceCitations.map((citation) => citation.id),
    fileMetadata: jsonObject({
      filename,
      mimeType: "application/pdf",
      size: stored.size,
      sha256: stored.sha256,
    }),
    renderMetadata: jsonObject({ renderer: "pdf", applicationOwned: true }),
    generationMetadata: jsonObject({
      correlationId: input.correlationId,
      reviewStatus: spec.reviewStatus,
      narration: pdfNarrationSegments(spec),
    }),
    requiredPermissions: spec.requiredPermissions,
    simulated: spec.sourceCitations.some((citation) => citation.simulated),
    errorCode: null,
  });
  await input.runtime.database.query(
    `UPDATE generated_artifacts
     SET parent_artifact_id=COALESCE($2::uuid,parent_artifact_id),
         presentation_run_id=COALESCE($3::uuid,presentation_run_id),
         review_status=$4,
         updated_at=$5::timestamptz,
         version=version+1
     WHERE id=$1::uuid`,
    [
      persistedId,
      input.request.parentArtifactId && UUID.test(input.request.parentArtifactId)
        ? input.request.parentArtifactId
        : null,
      spec.presentationRunId,
      spec.reviewStatus,
      generatedAt,
    ],
  );
  await input.runtime.database.query(
    `INSERT INTO executive_document_specifications
     (id,artifact_id,conversation_id,presentation_run_id,requested_by_user_id,template,title,specification,validation_status,document_version,parent_specification_id,review_status,related_record_ids,citation_ids,required_permissions,error_code,created_at,updated_at,version)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb,'rendered',$9::integer,NULL,$10,$11::jsonb,$12::jsonb,$13::jsonb,NULL,$14::timestamptz,$14::timestamptz,1)`,
    [
      spec.documentId,
      persistedId,
      spec.conversationId,
      spec.presentationRunId,
      input.userId,
      spec.template,
      spec.title,
      JSON.stringify(spec),
      spec.version,
      spec.reviewStatus,
      JSON.stringify(spec.beaRecordReferences.map((record) => record.id)),
      JSON.stringify(spec.sourceCitations.map((citation) => citation.id)),
      JSON.stringify(spec.requiredPermissions),
      generatedAt,
    ],
  );
  const versionsResult = await input.runtime.database.query<{
    id: string;
    artifact_version: number;
    created_at: string;
    title: string;
  }>(
    `SELECT id, artifact_version, created_at, title
     FROM generated_artifacts
     WHERE requested_by_user_id=$1::uuid AND conversation_id=$2::uuid AND kind='pdf'
     ORDER BY created_at DESC, artifact_version DESC
     LIMIT 20`,
    [input.userId, spec.conversationId],
  );
  const versions = versionsResult.rows.map((row) => ({
    id: row.id,
    version: Number(row.artifact_version),
    createdAt: row.created_at,
    title: row.title,
  }));
  await input.runtime.repository.record({
    eventType: input.request.parentArtifactId ? "artifact.revised" : "artifact.created",
    action: input.request.parentArtifactId
      ? "ai-command.executive-pdf.revise"
      : "ai-command.executive-pdf.generate",
    outcome: "succeeded",
    actorUserId: input.userId,
    resourceType: "generated-artifact",
    resourceId: persistedId,
    correlationId: input.correlationId,
    metadata: {
      filename,
      version: spec.version,
      parentVersion: spec.parentVersion,
      template: spec.template,
      provider: spec.provider,
      model: spec.model,
      storageId: stored.id,
    },
  });
  const workspacePayload = executivePdfWorkspacePayload({
    specification: spec,
    stored,
    ownerId: input.userId,
    relatedLeadId: lead?.id ?? null,
    parentArtifactId: input.request.parentArtifactId ?? null,
    generatedArtifactId: persistedId,
    versions,
  });
  return {
    specification: spec,
    artifactId: persistedId,
    storageId: stored.id,
    filename,
    downloadPath: `/api/artifacts/${stored.id}/download`,
    previewPath: `/api/artifacts/${stored.id}/preview`,
    narration: pdfNarrationSegments(spec),
    manifest: workspacePayload as unknown as PdfArtifactManifest,
    workspacePayload,
    stored,
  };
}

export async function listConversationPdfArtifacts(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly conversationId: string;
  readonly limit?: number;
}): Promise<
  readonly {
    readonly id: string;
    readonly title: string;
    readonly version: number;
    readonly createdAt: string;
    readonly storageReference: string | null;
  }[]
> {
  const result = await input.runtime.database.query<{
    id: string;
    title: string;
    artifact_version: number;
    created_at: string;
    storage_reference: string | null;
  }>(
    `SELECT id, title, artifact_version, created_at, storage_reference
     FROM generated_artifacts
     WHERE requested_by_user_id=$1::uuid AND conversation_id=$2::uuid AND kind='pdf'
     ORDER BY created_at DESC
     LIMIT $3`,
    [input.userId, input.conversationId, Math.min(input.limit ?? 10, 20)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    version: Number(row.artifact_version),
    createdAt: row.created_at,
    storageReference: row.storage_reference,
  }));
}

export async function loadExecutivePdfWorkspace(input: {
  readonly runtime: BeaServerRuntime;
  readonly userId: string;
  readonly artifactId: string;
}): Promise<ExecutivePdfResult | null> {
  const result = await input.runtime.database.query<{
    id: string;
    conversation_id: string;
    specification: unknown;
    storage_reference: string | null;
    filename: string | null;
    file_metadata: unknown;
  }>(
    `SELECT id, conversation_id, specification, storage_reference, filename, file_metadata
     FROM generated_artifacts
     WHERE (id::text=$1 OR storage_reference=$1) AND requested_by_user_id::text=$2 AND kind='pdf'
     LIMIT 1`,
    [input.artifactId, input.userId],
  );
  const row = result.rows[0];
  if (!row?.storage_reference) return null;
  let spec: ExecutiveDocumentSpecification;
  try {
    spec = validateExecutiveDocumentSpecification(row.specification);
  } catch {
    return null;
  }
  const settings = await input.runtime.ai.persistence.getProviderSettings();
  const store = new RepositoryArtifactFileStore({
    repositoryRoot: input.runtime.repositoryRoot,
    retentionMilliseconds: effectiveArtifactRetentionMilliseconds(settings.artifactRetentionDays),
  });
  const stored = (await store.get(input.userId, row.storage_reference)).metadata;
  const versions = await listConversationPdfArtifacts({
    runtime: input.runtime,
    userId: input.userId,
    conversationId: row.conversation_id,
  });
  const workspacePayload = executivePdfWorkspacePayload({
    specification: spec,
    stored,
    ownerId: input.userId,
    relatedLeadId: spec.beaRecordReferences.find((record) => record.type === "lead")?.id ?? null,
    parentArtifactId: null,
    generatedArtifactId: row.id,
    versions: versions.map((item) => ({
      id: item.id,
      version: item.version,
      createdAt: item.createdAt,
      title: item.title,
    })),
  });
  return {
    specification: spec,
    artifactId: row.id,
    storageId: stored.id,
    filename: stored.filename,
    downloadPath: `/api/artifacts/${stored.id}/download`,
    previewPath: `/api/artifacts/${stored.id}/preview`,
    narration: pdfNarrationSegments(spec),
    manifest: workspacePayload as unknown as PdfArtifactManifest,
    workspacePayload,
    stored,
  };
}
