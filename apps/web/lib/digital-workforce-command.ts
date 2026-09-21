import "server-only";

import type { BeaServerRuntime } from "@bea/database";
import {
  DIGITAL_AGENT_LABEL,
  EXECUTIVE_TEAM_WORKFLOW_GOAL,
  type JsonObject,
  type WorkspaceArtifactType,
} from "@bea/domain";
import type { DemoIntent } from "@bea/ai";
import { createCorrelationId } from "@bea/observability";
import { AccessDeniedError, PERMISSIONS } from "@bea/security";

import type { AiCommandArtifactView } from "./ai-command-contracts";
import { startDigitalWorkforceRun } from "./digital-workforce-runtime";

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function artifact(input: {
  readonly type: WorkspaceArtifactType;
  readonly title: string;
  readonly subtitle: string;
  readonly payload: JsonObject;
  readonly sources?: AiCommandArtifactView["sources"];
  readonly links?: AiCommandArtifactView["links"];
}): Omit<
  import("@bea/database").CreateWorkspaceArtifactInput,
  "conversationId" | "requestedByUserId" | "createdAt"
> {
  return {
    type: input.type,
    title: input.title,
    subtitle: input.subtitle,
    state: "ready",
    payload: input.payload,
    sources: input.sources ?? [],
    links: input.links ?? [],
    requiredPermissions: [PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
  };
}

export async function routeDigitalWorkforceIntent(
  runtime: BeaServerRuntime,
  userId: string,
  conversationId: string,
  intent: DemoIntent,
): Promise<{
  readonly content: string;
  readonly artifact: ReturnType<typeof artifact>;
} | null> {
  if (!intent.type.startsWith("digital-workforce-")) return null;
  const allowed = await runtime.authorization.authorizeUser(
    userId,
    PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
  );
  if (!allowed.allowed) throw new AccessDeniedError("permission-not-granted");
  const user = await runtime.repository.findActiveUserById(userId);
  const organization = await runtime.digitalWorkforce.listOrganization({
    ...(user && !user.roleIds.includes("owner-admin") ? { availableToRoleIds: user.roleIds } : {}),
  });

  if (intent.type === "digital-workforce-organization") {
    return {
      content: `Here is the ${DIGITAL_AGENT_LABEL} organization. Hierarchy never grants permissions.`,
      artifact: artifact({
        type: "digital-workforce-organization",
        title: "Digital Workforce",
        subtitle: `${DIGITAL_AGENT_LABEL} organization · not human employees`,
        payload: {
          items: organization.map((node) => ({
            id: node.agentId,
            title: node.displayName,
            subtitle: `${node.roleTitle} · ${node.workingState}`,
            status: node.status,
            href: `/digital-workforce/agents/${node.agentId}`,
          })),
        },
        links: [{ label: "Open Digital Workforce", href: "/digital-workforce" }],
      }),
    };
  }

  if (intent.type === "digital-workforce-active") {
    const runs = await runtime.digitalWorkforce.listRuns({ limit: 20 });
    const working = organization.filter((node) => node.workingState === "working");
    return {
      content:
        working.length > 0
          ? `${working.map((node) => node.displayName).join(", ")} ${working.length === 1 ? "is" : "are"} working.`
          : "No Digital Agents are working right now.",
      artifact: artifact({
        type: "digital-workforce-run-list",
        title: "Active Digital Workforce work",
        subtitle: "Application-owned runs",
        payload: {
          items: runs.map((run) => ({
            id: run.id,
            title: run.goal,
            subtitle: run.status,
            status: run.status,
            href: `/digital-workforce/runs/${run.id}`,
          })),
        },
      }),
    };
  }

  if (intent.type === "digital-workforce-handoff-latest") {
    const runs = await runtime.digitalWorkforce.listRuns({ limit: 10 });
    for (const run of runs) {
      const handoffs = await runtime.digitalWorkforce.listHandoffs(run.id);
      const latest = handoffs.at(-1);
      if (!latest) continue;
      return {
        content: `Latest handoff: ${latest.packet.reason} (${latest.status}).`,
        artifact: artifact({
          type: "digital-workforce-handoff-detail",
          title: "Latest handoff",
          subtitle: DIGITAL_AGENT_LABEL,
          payload: {
            record: {
              id: latest.id,
              status: latest.status,
              reason: latest.packet.reason,
              summary: latest.packet.boundedContextSummary,
              href: `/digital-workforce/handoffs/${latest.id}`,
            },
          },
          links: [{ label: "Open run", href: `/digital-workforce/runs/${run.id}` }],
        }),
      };
    }
    return {
      content: "No Digital Workforce handoffs are available yet.",
      artifact: artifact({
        type: "digital-workforce-handoff-list",
        title: "Handoffs",
        subtitle: "No structured handoffs yet",
        payload: { items: [] },
      }),
    };
  }

  if (intent.type === "digital-workforce-agent-open") {
    const term = (intent.agentTerm ?? "").toLocaleLowerCase("en-US");
    const match =
      organization.find((node) => node.displayName.toLocaleLowerCase("en-US").includes(term)) ??
      organization.find((node) => node.roleTitle.toLocaleLowerCase("en-US").includes(term)) ??
      organization.find((node) => node.slug.includes(term.replaceAll(" ", "-")));
    if (!match) {
      return {
        content: "That Digital Agent was not found in the authorized organization.",
        artifact: artifact({
          type: "digital-workforce-agent-list",
          title: "Digital Agents",
          subtitle: DIGITAL_AGENT_LABEL,
          payload: {
            items: organization.map((node) => ({ id: node.agentId, title: node.displayName })),
          },
        }),
      };
    }
    return {
      content: `${match.displayName} is a ${DIGITAL_AGENT_LABEL}. ${match.roleTitle}. Hierarchy does not grant permissions.`,
      artifact: artifact({
        type: "digital-workforce-agent-detail",
        title: match.displayName,
        subtitle: `${DIGITAL_AGENT_LABEL} · ${match.workingState}`,
        payload: {
          record: {
            id: match.agentId,
            roleTitle: match.roleTitle,
            department: match.departmentName,
            team: match.teamName,
            modelProfile: match.modelProfile,
            href: `/digital-workforce/agents/${match.agentId}`,
          },
        },
        links: [
          { label: "Open Digital Agent", href: `/digital-workforce/agents/${match.agentId}` },
        ],
      }),
    };
  }

  if (intent.type === "digital-workforce-create-draft") {
    const manage = await runtime.authorization.authorizeUser(
      userId,
      PERMISSIONS.DIGITAL_WORKFORCE_MANAGE,
    );
    if (!manage.allowed) throw new AccessDeniedError("permission-not-granted");
    const { previewNaturalLanguageAgentDraft } = await import("./digital-workforce-runtime");
    const preview = previewNaturalLanguageAgentDraft(intent.normalizedInput);
    return {
      content: `I prepared a Digital Agent draft named ${preview.displayName}. It is not published. Confirm in Agent Studio to save it.`,
      artifact: artifact({
        type: "digital-workforce-agent-draft",
        title: "Digital Agent draft preview",
        subtitle: "Not published · owner confirmation required",
        payload: {
          preview: preview as unknown as JsonObject,
          publishesAutomatically: false,
        },
        links: [{ label: "Open Agent Studio", href: "/digital-workforce?tab=agents" }],
      }),
    };
  }

  if (intent.type === "digital-workforce-run-start") {
    const started = await startDigitalWorkforceRun({
      runtime,
      userId,
      roleIds: user?.roleIds ?? ["owner-admin"],
      goal: EXECUTIVE_TEAM_WORKFLOW_GOAL,
      idempotencyKey: `ai-command:${conversationId}:${intent.normalizedInput.slice(0, 80)}`,
      conversationId,
      correlationId: createCorrelationId(),
      awaitExecution: true,
    });
    const trace = await loadDigitalWorkforceWorkspace(
      runtime,
      userId,
      "digital-workforce-run-trace",
      started.runId,
    );
    return {
      content:
        started.status === "completed" || started.status === "partially_completed"
          ? "The executive briefing is ready. The right pane shows the Digital Workforce run trace."
          : "I’ve assigned the lead review and public research in parallel. The right pane shows the Digital Workforce run trace.",
      artifact: artifact({
        type: "digital-workforce-run-trace",
        title: trace.title,
        subtitle: DIGITAL_AGENT_LABEL,
        payload: trace.payload,
        sources: trace.sources,
        links: [{ label: "Open run", href: `/digital-workforce/runs/${started.runId}` }],
      }),
    };
  }

  if (intent.type === "digital-workforce-run-stop") {
    const runs = await runtime.digitalWorkforce.listRuns({ limit: 5 });
    const active = runs.find(
      (run) =>
        ![
          "completed",
          "cancelled",
          "failed",
          "expired",
          "budget_exceeded",
          "partially_completed",
        ].includes(run.status),
    );
    if (!active) {
      return {
        content: "There is no active Digital Workforce run to stop.",
        artifact: artifact({
          type: "digital-workforce-run-list",
          title: "Digital Workforce runs",
          subtitle: DIGITAL_AGENT_LABEL,
          payload: {
            items: runs.map((run) => ({ id: run.id, title: run.goal, status: run.status })),
          },
        }),
      };
    }
    const { cancelDigitalWorkforceRun } = await import("./digital-workforce-runtime");
    await cancelDigitalWorkforceRun({
      runtime,
      userId,
      runId: active.id,
      reason: "Owner stopped the run from AI Command.",
      correlationId: createCorrelationId(),
    });
    return {
      content: "The run was stopped. Completed evidence was retained.",
      artifact: artifact({
        type: "digital-workforce-run-trace",
        title: "Run cancelled",
        subtitle: DIGITAL_AGENT_LABEL,
        payload: { runId: active.id, status: "cancelled" },
      }),
    };
  }

  if (intent.type === "digital-workforce-failures") {
    const runs = await runtime.digitalWorkforce.listRuns({ limit: 20 });
    const failed = runs.filter((run) =>
      ["failed", "partially_completed", "budget_exceeded"].includes(run.status),
    );
    return {
      content:
        failed.length === 0
          ? "No failed Digital Workforce runs are visible."
          : failed.map((run) => run.safeError ?? run.status).join(" "),
      artifact: artifact({
        type: "digital-workforce-error",
        title: "Failed Digital Workforce work",
        subtitle: DIGITAL_AGENT_LABEL,
        payload: {
          items: failed.map((run) => ({
            id: run.id,
            title: run.goal,
            subtitle: run.safeError ?? run.status,
            href: `/digital-workforce/runs/${run.id}`,
          })),
        },
      }),
    };
  }

  if (intent.type === "digital-workforce-models" || intent.type === "digital-workforce-records") {
    const runs = await runtime.digitalWorkforce.listRuns({ limit: 5 });
    const run = runs[0];
    const steps = run ? await runtime.digitalWorkforce.listSteps(run.id) : [];
    return {
      content:
        intent.type === "digital-workforce-models"
          ? steps.map((step) => `${step.stepKey}: ${step.model ?? "unconfigured"}`).join(" ") ||
            "No model provenance is available yet."
          : steps.flatMap((step) => step.authorizedRecordIds).join(" ") ||
            "No authorized records were attached to the latest run.",
      artifact: artifact({
        type: "digital-workforce-run-trace",
        title: run?.goal ?? "Digital Workforce run",
        subtitle: DIGITAL_AGENT_LABEL,
        payload: jsonObject({
          steps: steps.map((step) => ({
            key: step.stepKey,
            model: step.model,
            tools: step.toolNames,
            records: step.authorizedRecordIds,
          })),
        }),
      }),
    };
  }

  return null;
}

export async function loadDigitalWorkforceWorkspace(
  runtime: BeaServerRuntime,
  userId: string,
  view: string,
  recordId: string | null,
): Promise<AiCommandArtifactView> {
  const allowed = await runtime.authorization.authorizeUser(
    userId,
    PERMISSIONS.DIGITAL_WORKFORCE_VIEW,
  );
  if (!allowed.allowed) throw new AccessDeniedError("permission-not-granted");
  const now = new Date().toISOString();
  if (view === "digital-workforce-agent-detail" && recordId) {
    const agent = await runtime.digitalWorkforce.getAgent(recordId);
    return {
      id: `workspace-agent-${recordId}`,
      type: "digital-workforce-agent-detail",
      title: agent?.displayName ?? "Digital Agent",
      subtitle: DIGITAL_AGENT_LABEL,
      state: agent ? "ready" : "empty",
      payload: jsonObject({ record: agent ?? {} }),
      sources: [],
      links: [{ label: "Open Digital Workforce", href: "/digital-workforce" }],
      requiredPermissions: [PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
      createdAt: now,
      errorCode: null,
    };
  }
  if (view === "digital-workforce-run-trace" && recordId) {
    const run = await runtime.digitalWorkforce.getRun(recordId);
    const [steps, handoffs, events] = run
      ? await Promise.all([
          runtime.digitalWorkforce.listSteps(run.id),
          runtime.digitalWorkforce.listHandoffs(run.id),
          runtime.digitalWorkforce.listEvents(run.id, 100),
        ])
      : [[], [], []];
    return {
      id: `workspace-run-${recordId}`,
      type: "digital-workforce-run-trace",
      title: run?.goal ?? "Digital Workforce run",
      subtitle: DIGITAL_AGENT_LABEL,
      state: run ? "ready" : "empty",
      payload: { run, steps, handoffs, events } as unknown as JsonObject,
      sources: [],
      links: [{ label: "Open run", href: `/digital-workforce/runs/${recordId}` }],
      requiredPermissions: [PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
      createdAt: now,
      errorCode: null,
    };
  }
  if (view === "digital-workforce-handoff-detail" && recordId) {
    const handoff = await runtime.digitalWorkforce.getHandoff(recordId);
    return {
      id: `workspace-handoff-${recordId}`,
      type: "digital-workforce-handoff-detail",
      title: "Handoff",
      subtitle: DIGITAL_AGENT_LABEL,
      state: handoff ? "ready" : "empty",
      payload: { record: handoff ?? {} } as unknown as JsonObject,
      sources: [],
      links: [],
      requiredPermissions: [PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
      createdAt: now,
      errorCode: null,
    };
  }
  const organization = await runtime.digitalWorkforce.listOrganization();
  return {
    id: `workspace-workforce-${now}`,
    type: "digital-workforce-organization",
    title: "Digital Workforce",
    subtitle: DIGITAL_AGENT_LABEL,
    state: "ready",
    payload: {
      items: organization.map((node) => ({
        id: node.agentId,
        title: node.displayName,
        subtitle: node.roleTitle,
        href: `/digital-workforce/agents/${node.agentId}`,
      })),
    },
    sources: [],
    links: [{ label: "Open Digital Workforce", href: "/digital-workforce" }],
    requiredPermissions: [PERMISSIONS.DIGITAL_WORKFORCE_VIEW],
    createdAt: now,
    errorCode: null,
  };
}
