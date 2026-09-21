import { describe, expect, it } from "vitest";

import { ArtifactValidationError } from "../../packages/artifacts/src/contracts.js";
import {
  OWNER_EVALUATION_DOCUMENT_DISCLOSURE,
  pdfNarrationSegments,
  sanitizePdfFilename,
  validateExecutiveDocumentSpecification,
} from "../../packages/artifacts/src/document-specification.js";

const IDS = {
  document: "11111111-1111-4111-8111-111111111111",
  artifact: "22222222-2222-4222-8222-222222222222",
  conversation: "33333333-3333-4333-8333-333333333333",
  user: "44444444-4444-4444-8444-444444444444",
  lead: "55555555-5555-4555-8555-555555555555",
};

function spec(overrides: Record<string, unknown> = {}) {
  return {
    documentId: IDS.document,
    artifactId: IDS.artifact,
    conversationId: IDS.conversation,
    presentationRunId: null,
    requestedByUserId: IDS.user,
    template: "executive_briefing",
    title: "Northstar briefing",
    subtitle: "Owner Evaluation draft",
    intendedAudience: "Owner",
    purpose: "Review",
    executiveSummary: "Authorized evaluation evidence remains synthetic.",
    sections: [{ id: "context", heading: "Context", body: "Synthetic BEA records only." }],
    findings: [
      {
        id: "F1",
        title: "Evidence is bounded",
        detail: "External CRM systems are not connected.",
        severity: "attention",
      },
    ],
    implications: ["Treat as draft."],
    risks: ["Live provider content may be incomplete."],
    recommendations: ["Review in the right workspace."],
    nextSteps: ["Keep the PDF open."],
    sourceCitations: [
      {
        id: "S1",
        title: "Synthetic BEA evaluation records",
        url: "https://bea.local/synthetic-evaluation",
        domain: "bea.local",
        simulated: true,
        source: "synthetic_bea_record",
      },
    ],
    beaRecordReferences: [{ id: IDS.lead, type: "lead", label: "Northstar" }],
    disclosure: OWNER_EVALUATION_DOCUMENT_DISCLOSURE,
    liveDataDisclosure: OWNER_EVALUATION_DOCUMENT_DISCLOSURE,
    provider: "openai",
    model: "gpt-5.6",
    route: "pdf_narrative_generation",
    generatedAt: "2026-08-31T00:00:00.000Z",
    version: 1,
    parentVersion: null,
    requiredPermissions: ["ai-command.run", "documents.view"],
    reviewStatus: "draft_human_review_required",
    outputLength: "standard",
    ...overrides,
  };
}

describe("Phase 2.2 document specification", () => {
  it("validates a supported template and sanitizes a deterministic filename", () => {
    const validated = validateExecutiveDocumentSpecification(spec());
    expect(validated.template).toBe("executive_briefing");
    expect(validated.reviewStatus).toBe("draft_human_review_required");
    expect(validated.disclosure).toContain("synthetic BEA evaluation records");
    expect(
      sanitizePdfFilename({
        template: validated.template,
        subject: validated.title,
        generatedAt: validated.generatedAt,
        version: validated.version,
      }),
    ).toBe("BEA-Executive-Briefing-Northstar-briefing-2026-08-31-v1.pdf");
  });

  it("rejects unknown templates, markup, secrets, and invalid citations", () => {
    expect(() => validateExecutiveDocumentSpecification(spec({ template: "invoice" }))).toThrow(
      ArtifactValidationError,
    );
    expect(() =>
      validateExecutiveDocumentSpecification(
        spec({ executiveSummary: "<script>alert(1)</script>" }),
      ),
    ).toThrow(/unsupported content/u);
    expect(() =>
      validateExecutiveDocumentSpecification(
        spec({ title: ["s", "k", "-", "abcdefghijklmnopqrstuvwxyz"].join("") }),
      ),
    ).toThrow(/unsupported content/u);
    expect(() =>
      validateExecutiveDocumentSpecification(
        spec({
          sourceCitations: [
            {
              id: "S1",
              title: "Bad",
              url: "javascript:alert(1)",
              domain: "bad",
              simulated: true,
              source: "owner_provided",
            },
          ],
        }),
      ),
    ).toThrow(/Citation 1 URL contains unsupported content/u);
  });

  it("links parent versions and builds PDF narration segments", () => {
    const child = validateExecutiveDocumentSpecification(spec({ version: 2, parentVersion: 1 }));
    expect(child.parentVersion).toBe(1);
    const narration = pdfNarrationSegments(child);
    expect(narration.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["summary", "section", "finding", "recommendation", "source"]),
    );
  });

  it("rejects unauthorized record identifiers", () => {
    expect(() =>
      validateExecutiveDocumentSpecification(
        spec({
          beaRecordReferences: [{ id: "../etc/passwd", type: "lead", label: "Traversal" }],
        }),
      ),
    ).toThrow(/Record 1 is invalid/u);
  });
});
