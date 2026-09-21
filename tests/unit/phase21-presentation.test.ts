import { describe, expect, it } from "vitest";

import {
  applyWorkspaceSelection,
  authorizeWorkspaceSelection,
  beaRecordDisclosure,
  buildRealtimeVoiceBriefing,
  buildSelectedEvidenceContext,
  canTransitionPresentation,
  compatibleModelsForRoute,
  createSimulatedResearchResult,
  inferAiPresentationIntent,
  inferAiWorkloadRoute,
  interruptPresentation,
  isFollowUpAboutSelection,
  isRateLimitAllowed,
  liveVoiceLabel,
  liveWebSearchLabel,
  mapFindingsToVerifiedCitations,
  narrationVisualElement,
  parseSafeWorkspaceSelection,
  parseVisualElementId,
  pauseAutoFollow,
  presentationPacketContainsSecret,
  presentationPacketFromStoredRun,
  productionRejectsDemoFallback,
  realtimeSessionWithinMaxAge,
  redactUnsafeErrorText,
  resumeAutoFollow,
  selectedEvidenceInstructions,
  transitionPresentation,
  visualElementIdFor,
  webSearchToolSucceeded,
  buildLeadPresentation,
  buildResearchPresentation,
  researchLabelForPacket,
  normalizeResearchSources,
  PHASE21_LIMITS,
  answerFromSelectedContext,
  validateStructuredResearchBriefing,
  evidenceFirstAnalysisFallback,
} from "../../packages/ai/src/index.js";
import { AI_PRESENTATION_CONTRACT_VERSION } from "../../packages/domain/src/index.js";

const PRESENTATION_RUN_ID = "b1000000-0000-4000-8000-000000000021";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000010";

function packet() {
  const result = createSimulatedResearchResult("water penetration testing");
  return buildResearchPresentation({
    presentationRunId: PRESENTATION_RUN_ID,
    conversationId: CONVERSATION_ID,
    actingUserId: USER_ID,
    query: "Research the latest information relevant to water penetration testing",
    result,
    provider: "demo",
    requiredPermissions: ["ai-command.view", "search.view"],
  });
}

describe("Phase 2.1 presentation contract", () => {
  it("maps narration segments to application-owned visual element IDs only", () => {
    expect(visualElementIdFor("summary")).toBe("summary");
    expect(visualElementIdFor("finding", "finding-1")).toBe("finding:finding-1");
    expect(parseVisualElementId("source:source-2")).toEqual({
      kind: "source",
      elementId: "source-2",
    });
    expect(parseVisualElementId("javascript:alert(1)")).toBeNull();
    expect(() => visualElementIdFor("finding", "<script>")).toThrow(/stable identifiers/u);
    const built = packet();
    expect(narrationVisualElement(built, built.narrationSegments[0]?.id ?? null)).toBe("summary");
    expect(built.contractVersion).toBe(AI_PRESENTATION_CONTRACT_VERSION);
  });

  it("rejects unsafe visual selection references", () => {
    expect(
      parseSafeWorkspaceSelection({
        presentationRunId: PRESENTATION_RUN_ID,
        artifactId: "artifact-1",
        kind: "source",
        elementId: "source-2",
      }),
    ).toMatchObject({ kind: "source", elementId: "source-2" });
    expect(
      parseSafeWorkspaceSelection({
        presentationRunId: PRESENTATION_RUN_ID,
        artifactId: "artifact-1",
        kind: "source",
        elementId: "<div id=x>",
      }),
    ).toBeNull();
    expect(
      parseSafeWorkspaceSelection({
        presentationRunId: "not-a-uuid",
        artifactId: "artifact-1",
        kind: "finding",
        elementId: "finding-1",
      }),
    ).toBeNull();
  });

  it("pauses auto-follow and interrupts without dropping the packet", () => {
    const built = packet();
    expect(canTransitionPresentation("ready", "narrating")).toBe(true);
    expect(transitionPresentation("ready", "narrating")).toBe("narrating");
    const narrating = { ...built, status: "narrating" as const };
    const interrupted = interruptPresentation(narrating);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.findings).toEqual(built.findings);
    expect(pauseAutoFollow(interrupted).autoFollow).toBe(false);
    expect(resumeAutoFollow(pauseAutoFollow(interrupted)).autoFollow).toBe(true);
  });

  it("answers follow-ups from the selected source evidence", () => {
    const built = packet();
    const selection = parseSafeWorkspaceSelection({
      presentationRunId: PRESENTATION_RUN_ID,
      artifactId: PRESENTATION_RUN_ID,
      kind: "source",
      elementId: "source-2",
    });
    expect(selection).not.toBeNull();
    const selected = applyWorkspaceSelection(built, selection!);
    expect(selected.autoFollow).toBe(false);
    expect(isFollowUpAboutSelection("Explain this one.")).toBe(true);
    expect(isFollowUpAboutSelection("Show me the full record.")).toBe(true);
    expect(isFollowUpAboutSelection("What is the weather in Dallas?")).toBe(false);
    const answer = answerFromSelectedContext(
      selected,
      selection!,
      "What does this source mean for us?",
    );
    expect(answer).toMatch(/Source 2/u);
    expect(answer).not.toMatch(/sk-/u);
  });

  it("labels live versus simulated web research and voice honestly", () => {
    expect(liveWebSearchLabel({ simulated: false, webSearchToolCompleted: true })).toBe(
      "LIVE WEB RESEARCH",
    );
    expect(liveWebSearchLabel({ simulated: true, webSearchToolCompleted: true })).toBe(
      "SIMULATED WEB RESEARCH",
    );
    expect(liveWebSearchLabel({ simulated: false, webSearchToolCompleted: false })).toBeNull();
    expect(liveVoiceLabel({ simulated: false, realtimeConnected: true })).toBe("LIVE VOICE");
    expect(liveVoiceLabel({ simulated: true, realtimeConnected: true })).toBe("TEST-ONLY VOICE");
    expect(liveVoiceLabel({ simulated: false, realtimeConnected: false })).toBeNull();
    expect(beaRecordDisclosure(false)).toMatch(/not live business data/u);
    const built = packet();
    expect(researchLabelForPacket(built)).toBe("SIMULATED WEB RESEARCH");
    expect(webSearchToolSucceeded(createSimulatedResearchResult("q"))).toBe(true);
  });

  it("redacts secrets and rate-limits session/search use", () => {
    expect(
      redactUnsafeErrorText(["Bearer ", "sk", "-", "abcdefghijklmnopqrstuvwxyz"].join("")),
    ).toContain("[redacted]");
    expect(
      presentationPacketContainsSecret({
        summary: ["Use ", "ek", "_", "abcdefghijklmnopqrstuvwxyz"].join(""),
      }),
    ).toBe(true);
    expect(isRateLimitAllowed({ used: 7, limit: PHASE21_LIMITS.webSearchPerUserPerMinute })).toBe(
      true,
    );
    expect(isRateLimitAllowed({ used: 8, limit: PHASE21_LIMITS.webSearchPerUserPerMinute })).toBe(
      false,
    );
    expect(PHASE21_LIMITS.realtimeSessionsPerUser).toBe(1);
  });

  it("fails closed for unknown capabilities and production Demo fallback", () => {
    expect(productionRejectsDemoFallback("production", "demo")).toBe(true);
    expect(productionRejectsDemoFallback("demo", "demo")).toBe(false);
    expect(
      compatibleModelsForRoute(
        [
          {
            id: "gpt-test",
            provider: "openai",
            displayName: "gpt-test",
            available: true,
            capabilities: { responsesText: true, streaming: true, webSearch: true },
            capabilitySource: "configured",
            validation: {
              registryVersion: "test",
              validatedAt: "2026-08-29T00:00:00.000Z",
              validationMethod: "registry",
              evidence: {},
            },
          },
          {
            id: "unknown-model",
            provider: "openai",
            displayName: "unknown-model",
            available: true,
            capabilities: { webSearch: "unknown" },
            capabilitySource: "unknown",
            validation: {
              registryVersion: "test",
              validatedAt: null,
              validationMethod: "unknown",
              evidence: {},
            },
          },
        ],
        ["webSearch"],
      ).map((model) => model.id),
    ).toEqual(["gpt-test"]);
    expect(inferAiWorkloadRoute({ input: "water penetration latest information" })).toBe(
      "public_web_research",
    );
    expect(inferAiWorkloadRoute({ input: "water penetration" })).not.toBe("public_web_research");
    expect(inferAiPresentationIntent("water penetration")).toBe("other");
    expect(inferAiPresentationIntent("Research current water penetration testing standards")).toBe(
      "public_web_research",
    );
    expect(inferAiPresentationIntent("Open the water penetration lead")).toBe("record_retrieval");
    expect(inferAiPresentationIntent("Summarize our water penetration lead")).toBe(
      "record_retrieval",
    );
    expect(inferAiPresentationIntent("Search the web for water penetration testing changes")).toBe(
      "public_web_research",
    );
    expect(inferAiWorkloadRoute({ input: "Open the water penetration lead" })).not.toBe(
      "public_web_research",
    );
  });

  it("builds a lead presentation that is not labeled live web research", () => {
    const leadPacket = buildLeadPresentation({
      conversationId: CONVERSATION_ID,
      actingUserId: USER_ID,
      query: "Show me the leads that still need information",
      leads: [
        {
          id: "a1000000-0000-4000-8000-000000000001",
          reference: "BEA-LD-000001",
          opportunityName: "Northstar",
          status: "needs_info",
          blocking: ["Requested service is missing."],
        },
      ],
      provider: "demo",
      model: "deterministic-demo-router",
      requiredPermissions: ["leads.view"],
    });
    expect(researchLabelForPacket(leadPacket)).toBeNull();
    expect(leadPacket.liveWebSearch).toBe(false);
    expect(leadPacket.beaRecordsLive).toBe(false);
    expect(leadPacket.sources[0]?.url).toBe("/leads/a1000000-0000-4000-8000-000000000001");
  });

  it("maps citation annotations by overlap rather than sentence position", () => {
    const text =
      "Alpha finding remains material for envelope work. Bravo finding covers field spray limits. Charlie finding is uncited model text.";
    const alpha = "Alpha finding remains material for envelope work.";
    const bravo = "Bravo finding covers field spray limits.";
    const sources = [
      {
        id: "source-b",
        number: 1,
        title: "Bravo source",
        domain: "bravo.example.invalid",
        url: "https://bravo.example.invalid/b",
        retrievedAt: "2026-08-29T00:00:00.000Z",
        supportsFindingIds: [],
        simulated: false,
      },
      {
        id: "source-a",
        number: 2,
        title: "Alpha source",
        domain: "alpha.example.invalid",
        url: "https://alpha.example.invalid/a",
        retrievedAt: "2026-08-29T00:00:00.000Z",
        supportsFindingIds: [],
        simulated: false,
      },
    ];
    const mapped = mapFindingsToVerifiedCitations({
      text,
      sources,
      citations: [
        {
          id: "citation-a",
          sourceId: "source-a",
          title: "Alpha source",
          url: "https://alpha.example.invalid/a",
          domain: "alpha.example.invalid",
          startIndex: text.indexOf(alpha),
          endIndex: text.indexOf(alpha) + alpha.length,
          retrievedAt: "2026-08-29T00:00:00.000Z",
          simulated: false,
        },
        {
          id: "citation-b",
          sourceId: "source-b",
          title: "Bravo source",
          url: "https://bravo.example.invalid/b",
          domain: "bravo.example.invalid",
          startIndex: text.indexOf(bravo),
          endIndex: text.indexOf(bravo) + bravo.length,
          retrievedAt: "2026-08-29T00:00:00.000Z",
          simulated: false,
        },
        {
          id: "citation-a2",
          sourceId: "source-a",
          title: "Alpha source",
          url: "https://alpha.example.invalid/a",
          domain: "alpha.example.invalid",
          startIndex: text.indexOf(alpha),
          endIndex: text.indexOf(alpha) + alpha.length,
          retrievedAt: "2026-08-29T00:00:00.000Z",
          simulated: false,
        },
        {
          id: "citation-outside",
          sourceId: "source-b",
          title: "Outside",
          url: "https://bravo.example.invalid/b",
          domain: "bravo.example.invalid",
          startIndex: 900,
          endIndex: 940,
          retrievedAt: "2026-08-29T00:00:00.000Z",
          simulated: false,
        },
        {
          id: "citation-invalid-offset",
          sourceId: "source-b",
          title: "Invalid",
          url: "https://bravo.example.invalid/b",
          domain: "bravo.example.invalid",
          startIndex: 40,
          endIndex: 10,
          retrievedAt: "2026-08-29T00:00:00.000Z",
          simulated: false,
        },
      ],
    });
    const finding1 = mapped.findings.find((finding) => finding.body.startsWith("Alpha"));
    const finding2 = mapped.findings.find((finding) => finding.body.startsWith("Bravo"));
    const finding3 = mapped.findings.find((finding) => finding.body.includes("uncited"));
    expect(finding1?.citationIds).toEqual(["citation-a", "citation-a2"]);
    expect(finding1?.sourceIds).toEqual(["source-a"]);
    expect(finding2?.citationIds).toEqual(["citation-b"]);
    expect(finding3?.citationIds).toEqual([]);
    expect(mapped.sources.find((source) => source.id === "source-a")?.supportsFindingIds).toEqual([
      finding1?.id,
    ]);
    expect(mapped.citations.some((citation) => citation.id === "citation-invalid-offset")).toBe(
      true,
    );
    const shared = mapFindingsToVerifiedCitations({
      text,
      sources,
      citations: [
        {
          id: "citation-shared",
          sourceId: "source-a",
          title: "Alpha source",
          url: "https://alpha.example.invalid/a",
          domain: "alpha.example.invalid",
          startIndex: 0,
          endIndex: text.length,
          retrievedAt: "2026-08-29T00:00:00.000Z",
          simulated: false,
        },
      ],
    });
    expect(
      shared.findings.filter((finding) => finding.citationIds.includes("citation-shared")).length,
    ).toBeGreaterThan(1);
    const duplicate = normalizeResearchSources({
      webSources: [
        {
          id: "source-dup-1",
          title: "First",
          url: "https://dup.example.invalid/a",
          domain: "dup.example.invalid",
          retrievedAt: "2026-08-29T00:00:00.000Z",
          toolCallId: "tool-1",
          simulated: false,
        },
        {
          id: "source-dup-2",
          title: "Second same URL",
          url: "https://dup.example.invalid/a",
          domain: "dup.example.invalid",
          retrievedAt: "2026-08-29T00:00:00.000Z",
          toolCallId: "tool-1",
          simulated: false,
        },
      ],
      citations: [
        {
          id: "citation-dup-1",
          sourceId: "source-dup-1",
          title: "First",
          url: "https://dup.example.invalid/a",
          domain: "dup.example.invalid",
          startIndex: 0,
          endIndex: 12,
          retrievedAt: "2026-08-29T00:00:00.000Z",
          simulated: false,
        },
        {
          id: "citation-dup-2",
          sourceId: "source-dup-2",
          title: "Second",
          url: "https://dup.example.invalid/a",
          domain: "dup.example.invalid",
          startIndex: 20,
          endIndex: 40,
          retrievedAt: "2026-08-29T00:00:00.000Z",
          simulated: false,
        },
        {
          id: "citation-invalid-url",
          title: "Invalid",
          url: "javascript:alert(1)",
          domain: "invalid",
          retrievedAt: "2026-08-29T00:00:00.000Z",
          simulated: false,
        },
      ],
    });
    expect(duplicate.sources).toHaveLength(1);
    expect(duplicate.citations.map((citation) => citation.id)).toEqual([
      "citation-dup-1",
      "citation-dup-2",
    ]);
    expect(duplicate.citations.every((citation) => citation.sourceId === "source-dup-1")).toBe(
      true,
    );
  });

  it("preserves duplicate-URL annotations without positional source mapping", () => {
    const built = packet();
    expect(built.sources.every((source) => source.url.includes("example.invalid"))).toBe(true);
    expect(built.findings.some((finding) => finding.citationIds.length === 0)).toBe(true);
    expect(built.analysisValidated).toBe(true);
    expect(built.implications[0]?.body).toMatch(/water penetration|protocol|laboratory/iu);
    const briefing = buildRealtimeVoiceBriefing(built);
    expect(briefing.presentationRunId).toBe(PRESENTATION_RUN_ID);
    expect(JSON.stringify(briefing)).not.toMatch(/<script>/u);
    const evidence = buildSelectedEvidenceContext(
      built,
      parseSafeWorkspaceSelection({
        presentationRunId: PRESENTATION_RUN_ID,
        artifactId: PRESENTATION_RUN_ID,
        kind: "source",
        elementId: "source-2",
      })!,
    );
    expect(evidence?.sourceTitle).toMatch(/AAMA/u);
    expect(evidence?.findings.length).toBeGreaterThan(0);
    expect(evidence?.findings[0]?.body.length).toBeGreaterThan(0);
    const liveInstructions = selectedEvidenceInstructions(evidence!);
    expect(liveInstructions).toContain(evidence!.sourceTitle ?? "");
    expect(liveInstructions).toContain(evidence!.findings[0]!.body);
    expect(liveInstructions).toMatch(/sourceTitle=/u);
    expect(liveInstructions).toMatch(/findings=/u);
    expect(liveInstructions).toMatch(/evidenceIds=/u);
    expect(liveInstructions).not.toMatch(/(?:sk-[A-Za-z0-9]{10,}|ek_[A-Za-z0-9]{10,})/u);
  });

  it("authorizes only selections that exist on the current packet", () => {
    const built = { ...packet(), visualArtifactId: "artifact-research-1" };
    const validSource = parseSafeWorkspaceSelection({
      presentationRunId: PRESENTATION_RUN_ID,
      artifactId: "artifact-research-1",
      kind: "source",
      elementId: "source-2",
    });
    const validFinding = parseSafeWorkspaceSelection({
      presentationRunId: PRESENTATION_RUN_ID,
      artifactId: "artifact-research-1",
      kind: "finding",
      elementId: "finding-1",
    });
    expect(
      authorizeWorkspaceSelection({
        latest: built,
        selection: validSource,
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
      }).ok,
    ).toBe(true);
    expect(
      authorizeWorkspaceSelection({
        latest: { ...built, visualArtifactId: null },
        selection: validSource,
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
        runVisualArtifactId: "artifact-research-1",
      }).ok,
    ).toBe(true);
    expect(
      authorizeWorkspaceSelection({
        latest: { ...built, visualArtifactId: null },
        selection: parseSafeWorkspaceSelection({
          presentationRunId: PRESENTATION_RUN_ID,
          artifactId: "wrong-artifact",
          kind: "source",
          elementId: "source-2",
        }),
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
        runVisualArtifactId: "artifact-research-1",
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      authorizeWorkspaceSelection({
        latest: built,
        selection: validFinding,
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
      }).ok,
    ).toBe(true);
    expect(
      authorizeWorkspaceSelection({
        latest: built,
        selection: parseSafeWorkspaceSelection({
          presentationRunId: PRESENTATION_RUN_ID,
          artifactId: PRESENTATION_RUN_ID,
          kind: "source",
          elementId: "source-invented",
        }),
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      authorizeWorkspaceSelection({
        latest: built,
        selection: parseSafeWorkspaceSelection({
          presentationRunId: PRESENTATION_RUN_ID,
          artifactId: PRESENTATION_RUN_ID,
          kind: "finding",
          elementId: "finding-invented",
        }),
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      authorizeWorkspaceSelection({
        latest: built,
        selection: parseSafeWorkspaceSelection({
          presentationRunId: PRESENTATION_RUN_ID,
          artifactId: "wrong-artifact",
          kind: "source",
          elementId: "source-2",
        }),
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      authorizeWorkspaceSelection({
        latest: built,
        selection: parseSafeWorkspaceSelection({
          presentationRunId: "c1000000-0000-4000-8000-000000000099",
          artifactId: PRESENTATION_RUN_ID,
          kind: "source",
          elementId: "source-2",
        }),
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      authorizeWorkspaceSelection({
        latest: null,
        selection: validSource,
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      authorizeWorkspaceSelection({
        latest: built,
        selection: validSource,
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: false,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    const lead = buildLeadPresentation({
      presentationRunId: PRESENTATION_RUN_ID,
      conversationId: CONVERSATION_ID,
      actingUserId: USER_ID,
      query: "Open the water penetration lead",
      leads: [
        {
          id: "a1000000-0000-4000-8000-000000000001",
          reference: "BEA-LD-000001",
          opportunityName: "Northstar",
          status: "needs_info",
          blocking: ["Requested service is missing."],
        },
      ],
      provider: "demo",
      model: "deterministic-demo-router",
      requiredPermissions: ["leads.view"],
    });
    expect(
      authorizeWorkspaceSelection({
        latest: lead,
        selection: parseSafeWorkspaceSelection({
          presentationRunId: PRESENTATION_RUN_ID,
          artifactId: PRESENTATION_RUN_ID,
          kind: "lead",
          elementId: "lead-a1000000-0000-4000-8000-000000000001",
          recordType: "lead",
          recordId: "a1000000-0000-4000-8000-000000000001",
        }),
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
      }).ok,
    ).toBe(true);
    expect(
      authorizeWorkspaceSelection({
        latest: lead,
        selection: parseSafeWorkspaceSelection({
          presentationRunId: PRESENTATION_RUN_ID,
          artifactId: PRESENTATION_RUN_ID,
          kind: "record",
          elementId: "lead-missing",
          recordType: "lead",
          recordId: "missing-lead",
        }),
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      authorizeWorkspaceSelection({
        latest: lead,
        selection: parseSafeWorkspaceSelection({
          presentationRunId: PRESENTATION_RUN_ID,
          artifactId: PRESENTATION_RUN_ID,
          kind: "record",
          elementId: "lead-a1000000-0000-4000-8000-000000000001",
          recordType: "task",
          recordId: "a1000000-0000-4000-8000-000000000001",
        }),
        conversationOwnerUserId: USER_ID,
        actingUserId: USER_ID,
        permissionsAllowed: true,
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("falls back to evidence-first analysis when structured briefing is invalid", () => {
    expect(
      validateStructuredResearchBriefing(
        { executiveSummary: "<script>alert(1)</script>", suggestedNextStep: "x" },
        { citationIds: new Set(), sourceIds: new Set() },
      ),
    ).toBeNull();
    const fallback = evidenceFirstAnalysisFallback();
    expect(fallback.analysisValidated).toBe(false);
    expect(fallback.implicationsForBea).toEqual([]);
    const invalidStructured = buildResearchPresentation({
      presentationRunId: PRESENTATION_RUN_ID,
      conversationId: CONVERSATION_ID,
      actingUserId: USER_ID,
      query: "Research current water penetration testing standards",
      result: {
        ...createSimulatedResearchResult("water penetration testing"),
        text: JSON.stringify({
          executiveSummary: "<script>alert(1)</script>",
          keyFindings: [{ id: "finding-1", title: "A", body: "Not valid because of the summary." }],
          implicationsForBea: [],
          risksAndUncertainty: [],
          recommendations: [],
          suggestedNextStep: "Inspect the sources.",
        }),
      },
      provider: "demo",
      requiredPermissions: ["ai-command.view", "search.view"],
    });
    expect(invalidStructured.analysisValidated).toBe(false);
    expect(invalidStructured.implications).toEqual([]);
    expect(invalidStructured.sources.length).toBeGreaterThan(0);
  });

  it("parses stored presentation packets from either the contract or a workspace payload", () => {
    const built = packet();
    expect(presentationPacketFromStoredRun(built)?.presentationRunId).toBe(PRESENTATION_RUN_ID);
    expect(
      presentationPacketFromStoredRun({
        renderer: "research",
        presentation: built,
      })?.presentationRunId,
    ).toBe(PRESENTATION_RUN_ID);
  });

  it("enforces application Realtime session max age rather than client-secret expiry", () => {
    const authorizedAt = "2026-08-29T00:00:00.000Z";
    const start = Date.parse(authorizedAt);
    expect(
      realtimeSessionWithinMaxAge({
        authorizedAt,
        nowMs: start + PHASE21_LIMITS.realtimeSessionMaxAgeMs,
        maxAgeMs: PHASE21_LIMITS.realtimeSessionMaxAgeMs,
      }),
    ).toBe(true);
    expect(
      realtimeSessionWithinMaxAge({
        authorizedAt,
        nowMs: start + PHASE21_LIMITS.realtimeSessionMaxAgeMs + 1,
        maxAgeMs: PHASE21_LIMITS.realtimeSessionMaxAgeMs,
      }),
    ).toBe(false);
    expect(PHASE21_LIMITS.realtimeToolsPerSessionPerMinute).toBe(20);
  });
});
