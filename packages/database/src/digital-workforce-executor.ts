import { randomUUID } from "node:crypto";
import {
  DIGITAL_WORKFORCE_CONTRACT_VERSION,
  EXECUTIVE_TEAM_WORKFLOW_GOAL,
  SEEDED_DIGITAL_WORKFORCE_IDS,
  assertHandoffAllowed,
  assertRunBudget,
  boundedHandoffContext,
  isTerminalRunStatus,
  sanitizeUntrustedSourceText,
  validateExecutionPlan,
  type DigitalAgentRun,
  type DigitalWorkforceExecutionPlan,
  type JsonObject,
} from "@bea/domain";
import { SqlDigitalWorkforceRepository } from "./digital-workforce-repository.js";
import { SqlLeadRepository } from "./lead-repository.js";

export { EXECUTIVE_TEAM_WORKFLOW_GOAL };

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export interface DigitalWorkforcePdfResult {
  readonly artifactId: string;
  readonly title: string;
}

export interface DigitalWorkforceLiveStepResult {
  readonly text: string;
  readonly model: string;
  readonly provider: string;
  readonly citations: readonly {
    readonly id: string;
    readonly title: string;
    readonly url: string;
  }[];
  readonly estimatedCostUsd: number;
}

export interface DigitalWorkforceExecutorAdapters {
  readonly liveEnabled: boolean;
  readonly demoFallbackAllowed: boolean;
  readonly resolveModel: (input: {
    readonly profile: string;
    readonly primaryModel: string;
    readonly fallbackModel: string | null;
  }) => Promise<{
    readonly model: string;
    readonly fallbackUsed: string | null;
    readonly provider: string;
  }>;
  readonly generatePdf: (input: {
    readonly runId: string;
    readonly title: string;
    readonly summary: string;
    readonly findings: readonly string[];
    readonly recommendations: readonly string[];
    readonly citations: readonly {
      readonly id: string;
      readonly title: string;
      readonly url: string;
    }[];
    readonly recordIds: readonly string[];
    readonly initiatingUserId: string;
  }) => Promise<DigitalWorkforcePdfResult>;
  readonly liveLeadAnalysis?: (input: {
    readonly goal: string;
    readonly leads: JsonObject;
    readonly model: string;
    readonly signal?: AbortSignal;
  }) => Promise<DigitalWorkforceLiveStepResult>;
  readonly liveWebSearch?: (input: {
    readonly query: string;
    readonly model: string;
    readonly signal?: AbortSignal;
  }) => Promise<DigitalWorkforceLiveStepResult>;
  readonly liveDocumentSpec?: (input: {
    readonly evidence: JsonObject;
    readonly model: string;
    readonly signal?: AbortSignal;
  }) => Promise<DigitalWorkforceLiveStepResult>;
  readonly liveSynthesis?: (input: {
    readonly evidence: JsonObject;
    readonly model: string;
    readonly signal?: AbortSignal;
  }) => Promise<DigitalWorkforceLiveStepResult>;
}

export function isExecutiveTeamWorkflowGoal(goal: string): boolean {
  const normalized = goal.toLocaleLowerCase("en-US");
  return (
    normalized.includes("need information") &&
    (normalized.includes("research") || normalized.includes("water-penetration")) &&
    (normalized.includes("briefing") ||
      normalized.includes("pdf") ||
      normalized.includes("executive"))
  );
}

export function buildCanonicalExecutiveTeamPlan(input: {
  readonly rootAgentId: string;
  readonly rootAgentVersionId: string;
  readonly leadReviewAgentId: string;
  readonly leadReviewVersionId: string;
  readonly researchAgentId: string;
  readonly researchVersionId: string;
  readonly documentAgentId: string;
  readonly documentVersionId: string;
  readonly goal: string;
}): DigitalWorkforceExecutionPlan {
  return {
    planVersion: DIGITAL_WORKFORCE_CONTRACT_VERSION,
    rootAgentId: input.rootAgentId,
    rootAgentVersionId: input.rootAgentVersionId,
    goal: input.goal,
    steps: [
      {
        key: "lead-review",
        stepType: "analyze_records",
        agentId: input.leadReviewAgentId,
        agentVersionId: input.leadReviewVersionId,
        dependsOn: [],
        parallelGroup: "discovery",
        assignedWhy: "Lead Review Specialist is configured for authorized lead readiness analysis.",
      },
      {
        key: "public-research",
        stepType: "public_research",
        agentId: input.researchAgentId,
        agentVersionId: input.researchVersionId,
        dependsOn: [],
        parallelGroup: "discovery",
        assignedWhy: "Public Research Specialist is granted authorized Web Search with citations.",
      },
      {
        key: "executive-document",
        stepType: "generate_artifact",
        agentId: input.documentAgentId,
        agentVersionId: input.documentVersionId,
        dependsOn: ["lead-review", "public-research"],
        parallelGroup: null,
        assignedWhy:
          "Executive Document Specialist is granted BEA PDF generation from authorized evidence.",
      },
      {
        key: "executive-synthesis",
        stepType: "synthesize",
        agentId: input.rootAgentId,
        agentVersionId: input.rootAgentVersionId,
        dependsOn: ["executive-document"],
        parallelGroup: null,
        assignedWhy: "The executive Digital Agent synthesizes specialist results for the owner.",
      },
      {
        key: "complete",
        stepType: "complete",
        agentId: input.rootAgentId,
        agentVersionId: input.rootAgentVersionId,
        dependsOn: ["executive-synthesis"],
        parallelGroup: null,
        assignedWhy: "Application-owned completion after synthesis.",
      },
    ],
  };
}

export async function executeDigitalWorkforceRun(input: {
  readonly workforce: SqlDigitalWorkforceRepository;
  readonly leads: SqlLeadRepository;
  readonly runId: string;
  readonly adapters: DigitalWorkforceExecutorAdapters;
  readonly signal?: AbortSignal;
  readonly claimOwner?: string;
}): Promise<DigitalAgentRun> {
  const claimed =
    (await input.workforce.claimRun({
      runId: input.runId,
      claimOwner: input.claimOwner ?? "bea-digital-workforce-executor",
    })) ?? (await input.workforce.getRun(input.runId));
  if (!claimed) throw new Error("Digital workforce run was not found.");
  if (isTerminalRunStatus(claimed.status) && claimed.status !== "queued") {
    return claimed;
  }
  const started = Date.now();
  let run = claimed;
  const abort = () => input.signal?.aborted || run.cancellationRequested;
  try {
    if (run.status !== "planning" && run.status !== "running") {
      if (run.status === "draft") {
        run = await input.workforce.transitionRun({ runId: run.id, to: "validating" });
      }
      if (run.status === "validating") {
        run = await input.workforce.transitionRun({ runId: run.id, to: "queued" });
      }
      if (run.status === "queued") {
        run = await input.workforce.transitionRun({ runId: run.id, to: "planning" });
      }
    }
    const organization = await input.workforce.listOrganization();
    const published = new Map(
      (
        await Promise.all(
          organization.map(async (node) => {
            const version = node.publishedVersionId
              ? await input.workforce.getVersion(node.publishedVersionId)
              : null;
            return version && node.status === "active"
              ? ([
                  node.agentId,
                  { versionId: version.id, supervisorAgentId: version.supervisorAgentId, version },
                ] as const)
              : null;
          }),
        )
      ).filter((item): item is NonNullable<typeof item> => item !== null),
    );
    const ids = SEEDED_DIGITAL_WORKFORCE_IDS.agents;
    const leadReview = published.get(ids.leadReview);
    const research = published.get(ids.publicResearch);
    const document = published.get(ids.executiveDocument);
    const root = published.get(run.rootAgentId);
    if (abort()) {
      return cancel("Owner stopped the run.");
    }
    if (!leadReview || !research || !document || !root) {
      throw new Error("Seeded executive-team agents are not published.");
    }
    if (
      leadReview.version.lifecycle !== "published" ||
      research.version.lifecycle !== "published"
    ) {
      throw new Error("Specialist agents must be published.");
    }
    const plan = buildCanonicalExecutiveTeamPlan({
      rootAgentId: run.rootAgentId,
      rootAgentVersionId: run.rootAgentVersionId,
      leadReviewAgentId: ids.leadReview,
      leadReviewVersionId: leadReview.versionId,
      researchAgentId: ids.publicResearch,
      researchVersionId: research.versionId,
      documentAgentId: ids.executiveDocument,
      documentVersionId: document.versionId,
      goal: run.goal,
    });
    validateExecutionPlan({
      plan,
      activePublishedAgents: new Map(
        [...published.entries()].map(([agentId, value]) => [
          agentId,
          { versionId: value.versionId, supervisorAgentId: value.supervisorAgentId },
        ]),
      ),
      runtimePolicy: root.version.runtimePolicy,
    });
    await input.workforce.appendEvent({
      runId: run.id,
      eventType: "run.planned",
      agentId: run.rootAgentId,
      narration: "I've assigned the lead review and public research in parallel.",
      metadata: { planVersion: plan.planVersion },
    });
    run = await input.workforce.transitionRun({
      runId: run.id,
      to: "running",
      executionPlan: plan,
      currentStepKey: "lead-review",
    });
    await input.workforce.createNotification({
      userId: run.initiatingUserId,
      type: "run-started",
      title: "Digital Workforce run started",
      body: "The executive team Digital Agents started a bounded run.",
      sourceType: "digital-workforce-run",
      sourceId: run.id,
      href: `/digital-workforce?tab=active&run=${run.id}`,
    });

    const parallel = await Promise.allSettled([executeLeadReview(), executePublicResearch()]);
    if (abort()) {
      return cancel("Owner stopped the run.");
    }
    const leadResult = parallel[0];
    const researchResult = parallel[1];
    const leadOk = leadResult.status === "fulfilled" ? leadResult.value : null;
    const researchOk = researchResult.status === "fulfilled" ? researchResult.value : null;
    if (!leadOk && !researchOk) {
      throw leadResult.status === "rejected" ? leadResult.reason : researchResult;
    }
    await input.workforce.appendEvent({
      runId: run.id,
      eventType: "run.progress",
      narration:
        leadOk && researchOk
          ? "The research findings are back, and the document agent is preparing the briefing."
          : leadOk
            ? "The lead review is complete. Research did not finish."
            : "Research is complete. Lead review did not finish.",
      metadata: {
        leadReview: Boolean(leadOk),
        publicResearch: Boolean(researchOk),
      },
    });

    const citations = researchOk?.citations ?? deterministicCitations();
    const findings = [
      ...(leadOk?.findings ?? ["Lead review did not complete."]),
      ...(researchOk?.findings ?? []),
    ];
    const pdf = await executeDocument(findings, citations, leadOk?.recordIds ?? []);
    const summary = await executeSynthesis(findings, citations, pdf);
    const missing: string[] = [];
    if (!leadOk) missing.push("lead-review");
    if (!researchOk) missing.push("public-research");
    const terminal = missing.length > 0 ? "partially_completed" : "completed";
    run = await input.workforce.transitionRun({
      runId: run.id,
      to: terminal,
      currentStepKey: "complete",
      executiveSummary: summary,
      outputArtifactIds: pdf ? [pdf.artifactId] : [],
      estimatedCostUsd: (leadOk?.cost ?? 0) + (researchOk?.cost ?? 0),
    });
    await input.workforce.appendEvent({
      runId: run.id,
      eventType: terminal === "completed" ? "run.completed" : "run.partially_completed",
      narration: "The executive briefing is ready.",
      metadata: { missingDeliverables: missing, artifactId: pdf?.artifactId ?? null },
    });
    await input.workforce.createNotification({
      userId: run.initiatingUserId,
      type: terminal === "completed" ? "run-completed" : "run-partially-completed",
      title:
        terminal === "completed"
          ? "Digital Workforce run completed"
          : "Digital Workforce run partially completed",
      body: summary.slice(0, 400),
      sourceType: "digital-workforce-run",
      sourceId: run.id,
      href: `/digital-workforce?tab=active&run=${run.id}`,
    });
    return run;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Digital workforce run failed.";
    const safe = message.slice(0, 500);
    if (run.cancellationRequested || /cancel/iu.test(safe)) {
      return cancel(safe);
    }
    const to = /budget/iu.test(safe)
      ? "budget_exceeded"
      : /duration/iu.test(safe)
        ? "expired"
        : "failed";
    run = await input.workforce.transitionRun({
      runId: input.runId,
      to,
      safeError: safe,
    });
    await input.workforce.appendEvent({
      runId: input.runId,
      eventType: "run.failed",
      narration:
        "The Digital Workforce run stopped because a controlled limit or failure was reached.",
      metadata: { safeError: safe },
    });
    await input.workforce.createNotification({
      userId: claimed.initiatingUserId,
      type: to === "budget_exceeded" ? "budget-exceeded" : "run-failed",
      title: "Digital Workforce run failed",
      body: safe,
      sourceType: "digital-workforce-run",
      sourceId: input.runId,
      href: `/digital-workforce?tab=active&run=${input.runId}`,
    });
    return run;
  }

  async function cancel(reason: string): Promise<DigitalAgentRun> {
    const cancelled = await input.workforce.transitionRun({
      runId: input.runId,
      to: "cancelled",
      safeError: reason,
    });
    await input.workforce.appendEvent({
      runId: input.runId,
      eventType: "run.cancelled",
      narration: "The run was stopped. Completed evidence was retained.",
      metadata: { reason },
    });
    return cancelled;
  }

  async function executeLeadReview(): Promise<{
    readonly findings: readonly string[];
    readonly recordIds: readonly string[];
    readonly cost: number;
    readonly citations: readonly {
      readonly id: string;
      readonly title: string;
      readonly url: string;
    }[];
  }> {
    if (abort()) throw new Error("cancelled");
    const version = (await input.workforce.getPublishedVersion(
      SEEDED_DIGITAL_WORKFORCE_IDS.agents.leadReview,
    ))!;
    const model = await input.adapters.resolveModel(version.modelAssignment);
    const leads = await input.leads.listLeads({ status: "needs_info", limit: 25 });
    const findings = leads.map(
      (item) =>
        `${item.lead.reference} ${item.lead.opportunityName || item.lead.requestSummary || "Lead"} is blocked: ${
          item.readiness.blocking.join("; ") || "needs information"
        }.`,
    );
    if (findings.length === 0) {
      findings.push("No authorized leads currently require information.");
    }
    const recordIds = leads.map((item) => item.lead.id);
    let live: DigitalWorkforceLiveStepResult | undefined;
    if (input.adapters.liveEnabled && input.adapters.liveLeadAnalysis) {
      live = await input.adapters.liveLeadAnalysis({
        goal: run.goal,
        leads: jsonObject({
          leads: leads.map((item) => ({
            id: item.lead.id,
            reference: item.lead.reference,
            blocking: [...item.readiness.blocking],
          })),
        }),
        model: model.model,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } else if (input.adapters.liveEnabled && !input.adapters.demoFallbackAllowed) {
      throw new Error("Lead-analysis model is unavailable.");
    }
    const step = await input.workforce.upsertStep({
      id: randomUUID(),
      runId: run.id,
      stepKey: "lead-review",
      stepType: "analyze_records",
      agentId: version.agentId,
      agentVersionId: version.id,
      status: "completed",
      idempotencyKey: `run:${run.id}:step:lead-review`,
      sequence: 1,
      parallelGroup: "discovery",
      assignedWhy: "Lead Review Specialist matches authorized lead readiness analysis.",
      provider: model.provider,
      model: live?.model ?? model.model,
      fallbackModelUsed: model.fallbackUsed,
      toolNames: ["bea_query_records"],
      authorizedRecordIds: recordIds,
      citationIds: [],
      artifactIds: [],
      usageJson: { estimatedCostUsd: live?.estimatedCostUsd ?? 0 },
      resultJson: { findings: live ? [live.text, ...findings] : findings },
      safeError: null,
      retryCount: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const handoff = await input.workforce.createHandoff({
      runId: run.id,
      parentStepId: step.id,
      fromAgentId: version.agentId,
      fromAgentVersionId: version.id,
      toAgentId: SEEDED_DIGITAL_WORKFORCE_IDS.agents.executiveDocument,
      toAgentVersionId: (await input.workforce.getPublishedVersion(
        SEEDED_DIGITAL_WORKFORCE_IDS.agents.executiveDocument,
      ))!.id,
      depth: 1,
      packet: {
        reason: "Lead review complete",
        requestedDeliverable: "Include blocked-lead evidence in the executive briefing.",
        boundedContextSummary: boundedHandoffContext(findings.join(" ")),
        knownFacts: findings,
        uncertainties: ["Follow-up effort is estimated from deterministic readiness only."],
        authorizedRecordIds: recordIds,
        authorizedPresentationIds: [],
        authorizedArtifactIds: [],
        citationIds: [],
        allowedTools: ["bea_create_pdf", "bea_query_records"],
        outputSchema: DIGITAL_WORKFORCE_CONTRACT_VERSION,
        budgetAllocationUsd: 0.25,
      },
    });
    await input.workforce.transitionHandoff({ handoffId: handoff.id, to: "validated" });
    await input.workforce.transitionHandoff({ handoffId: handoff.id, to: "accepted" });
    await input.workforce.transitionHandoff({
      handoffId: handoff.id,
      to: "running",
    });
    await input.workforce.transitionHandoff({
      handoffId: handoff.id,
      to: "returned",
      returnedResult: { findings },
    });
    await input.workforce.transitionHandoff({ handoffId: handoff.id, to: "reviewed" });
    await input.workforce.transitionHandoff({ handoffId: handoff.id, to: "completed" });
    assertRunBudget({
      runtimePolicy: version.runtimePolicy,
      estimatedCostUsd: live?.estimatedCostUsd ?? 0,
      providerCallCount: live ? 1 : 0,
      webSearchCount: 0,
      pdfGenerationCount: 0,
      elapsedMs: Date.now() - started,
      stepCount: 1,
    });
    return {
      findings: live ? [live.text, ...findings] : findings,
      recordIds,
      cost: live?.estimatedCostUsd ?? 0,
      citations: [],
    };
  }

  async function executePublicResearch(): Promise<{
    readonly findings: readonly string[];
    readonly citations: readonly {
      readonly id: string;
      readonly title: string;
      readonly url: string;
    }[];
    readonly cost: number;
  }> {
    if (abort()) throw new Error("cancelled");
    const version = (await input.workforce.getPublishedVersion(
      SEEDED_DIGITAL_WORKFORCE_IDS.agents.publicResearch,
    ))!;
    if (
      version.knowledgeScopes.every(
        (scope) => scope.scope !== "public-web" || scope.connectionState !== "connected",
      ) &&
      input.adapters.liveEnabled
    ) {
      throw new Error("Web Search is not connected for the Research Agent.");
    }
    const model = await input.adapters.resolveModel(version.modelAssignment);
    let live: DigitalWorkforceLiveStepResult | undefined;
    if (input.adapters.liveEnabled && input.adapters.liveWebSearch) {
      live = await input.adapters.liveWebSearch({
        query: "field water-penetration testing building envelope public guidance",
        model: model.model,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } else if (input.adapters.liveEnabled && !input.adapters.demoFallbackAllowed) {
      throw new Error("Web Search model is unavailable.");
    }
    const citations = live?.citations.length ? live.citations : deterministicCitations();
    const findings = live
      ? [live.text]
      : [
          "Deterministic evaluation evidence: field water-penetration testing requires documented openings, calibrated spray apparatus, and recorded differentials. This is SIMULATED public-research evidence, not a live Web Search.",
        ];
    const step = await input.workforce.upsertStep({
      id: randomUUID(),
      runId: run.id,
      stepKey: "public-research",
      stepType: "public_research",
      agentId: version.agentId,
      agentVersionId: version.id,
      status: "completed",
      idempotencyKey: `run:${run.id}:step:public-research`,
      sequence: 2,
      parallelGroup: "discovery",
      assignedWhy: "Public Research Specialist is granted authorized Web Search.",
      provider: model.provider,
      model: live?.model ?? model.model,
      fallbackModelUsed: model.fallbackUsed,
      toolNames: ["search_web"],
      authorizedRecordIds: [],
      citationIds: citations.map((item) => item.id),
      artifactIds: [],
      usageJson: { estimatedCostUsd: live?.estimatedCostUsd ?? 0 },
      resultJson: jsonObject({
        findings,
        citations,
        untrusted: sanitizeUntrustedSourceText(findings.join(" ")),
      }),
      safeError: null,
      retryCount: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const documentVersion = (await input.workforce.getPublishedVersion(
      SEEDED_DIGITAL_WORKFORCE_IDS.agents.executiveDocument,
    ))!;
    assertHandoffAllowed({
      fromAgentId: version.agentId,
      toAgentId: documentVersion.agentId,
      depth: 1,
      existingHandoffCount: (await input.workforce.listHandoffs(run.id)).length,
      runtimePolicy: version.runtimePolicy,
      preferredHandoffAgentIds: version.preferredHandoffAgentIds,
      priorPairs: [],
    });
    const handoff = await input.workforce.createHandoff({
      runId: run.id,
      parentStepId: step.id,
      fromAgentId: version.agentId,
      fromAgentVersionId: version.id,
      toAgentId: documentVersion.agentId,
      toAgentVersionId: documentVersion.id,
      depth: 1,
      packet: {
        reason: "Public research complete",
        requestedDeliverable: "Include cited public guidance in the executive briefing.",
        boundedContextSummary: boundedHandoffContext(findings.join(" ")),
        knownFacts: findings,
        uncertainties: ["Public guidance is not BEA project data."],
        authorizedRecordIds: [],
        authorizedPresentationIds: [],
        authorizedArtifactIds: [],
        citationIds: citations.map((item) => item.id),
        allowedTools: ["bea_create_pdf"],
        outputSchema: DIGITAL_WORKFORCE_CONTRACT_VERSION,
        budgetAllocationUsd: 0.5,
      },
    });
    await input.workforce.transitionHandoff({ handoffId: handoff.id, to: "validated" });
    await input.workforce.transitionHandoff({ handoffId: handoff.id, to: "accepted" });
    await input.workforce.transitionHandoff({ handoffId: handoff.id, to: "running" });
    await input.workforce.transitionHandoff({
      handoffId: handoff.id,
      to: "returned",
      returnedResult: { findings, citations },
    });
    await input.workforce.transitionHandoff({ handoffId: handoff.id, to: "reviewed" });
    await input.workforce.transitionHandoff({ handoffId: handoff.id, to: "completed" });
    return { findings, citations, cost: live?.estimatedCostUsd ?? 0 };
  }

  async function executeDocument(
    findings: readonly string[],
    citations: readonly { readonly id: string; readonly title: string; readonly url: string }[],
    recordIds: readonly string[],
  ): Promise<DigitalWorkforcePdfResult | null> {
    if (abort()) return null;
    const version = (await input.workforce.getPublishedVersion(
      SEEDED_DIGITAL_WORKFORCE_IDS.agents.executiveDocument,
    ))!;
    if (version.agentId && (await input.workforce.getAgent(version.agentId))?.status === "paused") {
      throw new Error("Document Agent is paused.");
    }
    const model = await input.adapters.resolveModel(version.modelAssignment);
    let live: DigitalWorkforceLiveStepResult | undefined;
    if (input.adapters.liveEnabled && input.adapters.liveDocumentSpec) {
      live = await input.adapters.liveDocumentSpec({
        evidence: jsonObject({ findings, citations, recordIds }),
        model: model.model,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } else if (input.adapters.liveEnabled && !input.adapters.demoFallbackAllowed) {
      throw new Error("Document-generation model is unavailable.");
    }
    const pdf = await input.adapters.generatePdf({
      runId: run.id,
      title: "Executive briefing — lead review and field water-penetration testing",
      summary:
        "The executive team reviewed leads that still need information and bounded public guidance for field water-penetration testing.",
      findings: [...findings].slice(0, 8),
      recommendations: [
        "Collect the missing lead information before proposal work.",
        "Treat public testing guidance as external evidence, not BEA project data.",
        "Keep the briefing in draft human review.",
      ],
      citations,
      recordIds,
      initiatingUserId: run.initiatingUserId,
    });
    await input.workforce.upsertStep({
      id: randomUUID(),
      runId: run.id,
      stepKey: "executive-document",
      stepType: "generate_artifact",
      agentId: version.agentId,
      agentVersionId: version.id,
      status: "completed",
      idempotencyKey: `run:${run.id}:step:executive-document`,
      sequence: 3,
      parallelGroup: null,
      assignedWhy: "Executive Document Specialist generates BEA-branded draft PDFs.",
      provider: model.provider,
      model: live?.model ?? model.model,
      fallbackModelUsed: model.fallbackUsed,
      toolNames: ["bea_create_pdf"],
      authorizedRecordIds: recordIds,
      citationIds: citations.map((item) => item.id),
      artifactIds: [pdf.artifactId],
      usageJson: { estimatedCostUsd: live?.estimatedCostUsd ?? 0 },
      resultJson: { artifactId: pdf.artifactId, title: pdf.title, liveBrief: live?.text ?? null },
      safeError: null,
      retryCount: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    return pdf;
  }

  async function executeSynthesis(
    findings: readonly string[],
    citations: readonly { readonly id: string; readonly title: string; readonly url: string }[],
    pdf: DigitalWorkforcePdfResult | null,
  ): Promise<string> {
    const version = (await input.workforce.getPublishedVersion(run.rootAgentId))!;
    const model = await input.adapters.resolveModel(version.modelAssignment);
    let live: DigitalWorkforceLiveStepResult | undefined;
    if (input.adapters.liveEnabled && input.adapters.liveSynthesis) {
      live = await input.adapters.liveSynthesis({
        evidence: jsonObject({ findings, citations, pdf: pdf?.artifactId ?? null }),
        model: model.model,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
    const summary =
      live?.text ??
      [
        "Main takeaway: blocked leads still need documented intake details before proposal work.",
        `Material lead blockers: ${findings.slice(0, 3).join(" ")}`,
        `Material research findings: ${findings.at(-1) ?? "No research finding."}`,
        "Risks: public guidance is not project data; documents remain draft.",
        "Recommendations: complete missing lead information, then review the briefing.",
        `Next action: open the ${pdf ? "generated executive PDF" : "run trace"} in the right workspace.`,
      ].join(" ");
    await input.workforce.upsertStep({
      id: randomUUID(),
      runId: run.id,
      stepKey: "executive-synthesis",
      stepType: "synthesize",
      agentId: version.agentId,
      agentVersionId: version.id,
      status: "completed",
      idempotencyKey: `run:${run.id}:step:executive-synthesis`,
      sequence: 4,
      parallelGroup: null,
      assignedWhy: "The executive Digital Agent returns the owner-facing summary.",
      provider: model.provider,
      model: live?.model ?? model.model,
      fallbackModelUsed: model.fallbackUsed,
      toolNames: ["bea_show_agent_run"],
      authorizedRecordIds: [],
      citationIds: citations.map((item) => item.id),
      artifactIds: pdf ? [pdf.artifactId] : [],
      usageJson: { estimatedCostUsd: live?.estimatedCostUsd ?? 0 },
      resultJson: { summary },
      safeError: null,
      retryCount: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    return summary;
  }
}

function deterministicCitations(): readonly {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}[] {
  return [
    {
      id: "cite-astm-e1105",
      title: "ASTM E1105 field water penetration overview (synthetic evaluation source)",
      url: "https://www.astm.org/e1105",
    },
    {
      id: "cite-bea-eval-water",
      title: "BEA synthetic evaluation note on field water-penetration testing",
      url: "https://buildingenvelopeallies.example.invalid/evaluation/water-penetration",
    },
  ];
}
