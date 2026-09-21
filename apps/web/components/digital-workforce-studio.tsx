"use client";

import {
  DIGITAL_AGENT_LABEL,
  EXECUTIVE_TEAM_WORKFLOW_GOAL,
  type DigitalAgentRun,
  type DigitalAgentRunStep,
  type DigitalWorkforceAgentIdentity,
  type DigitalWorkforceAgentVersion,
  type DigitalWorkforceDepartment,
  type DigitalWorkforceHandoff,
  type DigitalWorkforceOrganizationNode,
  type DigitalWorkforceRunEvent,
  type DigitalWorkforceTeam,
} from "@bea/domain";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  Input,
  Select,
  Table,
  TableFoundation,
} from "@bea/ui";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { DigitalWorkforceHierarchy } from "@/components/digital-workforce-hierarchy";
import { DigitalWorkforceRunTrace } from "@/components/digital-workforce-run-trace";
import { DigitalWorkforceWizard } from "@/components/digital-workforce-wizard";
import {
  agentStatusLabel,
  isDigitalWorkforceTab,
  knowledgeDisclosure,
  toolGrantCount,
  type DigitalWorkforceTab,
} from "@/lib/digital-workforce";

export interface DigitalWorkforceStudioProps {
  readonly tab: DigitalWorkforceTab;
  readonly organization: readonly DigitalWorkforceOrganizationNode[];
  readonly departments: readonly DigitalWorkforceDepartment[];
  readonly teams: readonly DigitalWorkforceTeam[];
  readonly agents: readonly DigitalWorkforceAgentIdentity[];
  readonly versionsByAgentId: Readonly<Record<string, DigitalWorkforceAgentVersion | null>>;
  readonly runs: readonly DigitalAgentRun[];
  readonly selectedAgent: DigitalWorkforceAgentIdentity | null;
  readonly selectedVersions: readonly DigitalWorkforceAgentVersion[];
  readonly selectedRun: DigitalAgentRun | null;
  readonly selectedSteps: readonly DigitalAgentRunStep[];
  readonly selectedHandoffs: readonly DigitalWorkforceHandoff[];
  readonly selectedEvents: readonly DigitalWorkforceRunEvent[];
  readonly canManage: boolean;
  readonly canPublish: boolean;
  readonly canRun: boolean;
  readonly canCancel: boolean;
}

export function DigitalWorkforceStudio({
  tab: initialTab,
  organization,
  departments,
  teams,
  agents,
  versionsByAgentId,
  runs,
  selectedAgent,
  selectedVersions,
  selectedRun,
  selectedSteps,
  selectedHandoffs,
  selectedEvents,
  canManage,
  canPublish,
  canRun,
  canCancel,
}: DigitalWorkforceStudioProps) {
  const router = useRouter();
  const [tab, setTab] = useState<DigitalWorkforceTab>(initialTab);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState(selectedAgent?.id ?? null);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [naturalLanguage, setNaturalLanguage] = useState("");
  const [draftPreview, setDraftPreview] = useState<string | null>(null);
  const [polledSnapshot, setPolledSnapshot] = useState<{
    readonly runId: string;
    readonly run: DigitalAgentRun;
    readonly steps: readonly DigitalAgentRunStep[];
    readonly handoffs: readonly DigitalWorkforceHandoff[];
    readonly events: readonly DigitalWorkforceRunEvent[];
  } | null>(null);
  const liveRun =
    polledSnapshot && (!selectedRun || polledSnapshot.runId === selectedRun.id)
      ? polledSnapshot.run
      : selectedRun;
  const liveSteps =
    polledSnapshot && (!selectedRun || polledSnapshot.runId === selectedRun.id)
      ? polledSnapshot.steps
      : selectedSteps;
  const liveHandoffs =
    polledSnapshot && (!selectedRun || polledSnapshot.runId === selectedRun.id)
      ? polledSnapshot.handoffs
      : selectedHandoffs;
  const liveEvents =
    polledSnapshot && (!selectedRun || polledSnapshot.runId === selectedRun.id)
      ? polledSnapshot.events
      : selectedEvents;

  const selectedHandoff =
    liveHandoffs.find((item) => item.id === handoffId) ?? liveHandoffs.at(-1) ?? null;

  useEffect(() => {
    const runId = polledSnapshot?.runId ?? selectedRun?.id;
    const status = liveRun?.status;
    const terminal = [
      "completed",
      "partially_completed",
      "failed",
      "cancelled",
      "expired",
      "budget_exceeded",
    ];
    if (!runId || (status && terminal.includes(status))) return undefined;
    const timer = window.setInterval(() => {
      void (async () => {
        const response = await fetch(`/api/digital-workforce/runs/${runId}`);
        if (!response.ok) return;
        const payload = (await response.json()) as {
          run?: DigitalAgentRun;
          steps?: DigitalAgentRunStep[];
          handoffs?: DigitalWorkforceHandoff[];
          events?: DigitalWorkforceRunEvent[];
        };
        if (!payload.run) return;
        setPolledSnapshot({
          runId,
          run: payload.run,
          steps: payload.steps ?? [],
          handoffs: payload.handoffs ?? [],
          events: payload.events ?? [],
        });
      })();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [selectedRun?.id, polledSnapshot?.runId, liveRun?.status]);

  const filteredAgents = useMemo(() => {
    return agents.filter((agent) => {
      if (
        query &&
        !`${agent.displayName} ${agent.roleTitle} ${agent.slug}`
          .toLowerCase()
          .includes(query.toLowerCase())
      ) {
        return false;
      }
      if (status && agent.status !== status) return false;
      if (departmentId && agent.departmentId !== departmentId) return false;
      return true;
    });
  }, [agents, query, status, departmentId]);

  const currentAgent = agents.find((agent) => agent.id === selectedAgentId) ?? selectedAgent;
  const published = currentAgent
    ? (selectedVersions.find((version) => version.id === currentAgent.currentPublishedVersionId) ??
      versionsByAgentId[currentAgent.id])
    : null;

  async function postJson(url: string, body: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
        run?: { id: string };
        runId?: string;
      };
      if (!response.ok) throw new Error(payload.error?.message ?? "The request was rejected.");
      setMessage("Saved.");
      const runId = payload.runId ?? payload.run?.id;
      if (runId) {
        setTab("active");
        const snapshot = await fetch(`/api/digital-workforce/runs/${runId}`);
        if (snapshot.ok) {
          const body = (await snapshot.json()) as {
            run?: DigitalAgentRun;
            steps?: DigitalAgentRunStep[];
            handoffs?: DigitalWorkforceHandoff[];
            events?: DigitalWorkforceRunEvent[];
          };
          if (body.run) {
            setPolledSnapshot({
              runId,
              run: body.run,
              steps: body.steps ?? [],
              handoffs: body.handoffs ?? [],
              events: body.events ?? [],
            });
          }
        }
        router.push(`/digital-workforce?tab=active&run=${encodeURIComponent(runId)}`);
        router.refresh();
        return;
      }
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="bea-stack bea-stack--large bea-workforce-studio"
      data-testid="digital-workforce-studio"
    >
      <div className="bea-workforce-tabs" role="tablist" aria-label="Digital Workforce">
        {(
          [
            ["organization", "Organization"],
            ["agents", "Agents"],
            ["active", "Active Work"],
            ["handoffs", "Handoffs"],
            ["templates", "Templates"],
            ["settings", "Settings"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`workforce-tab-${id}`}
            className="bea-workforce-tab"
            onClick={() => {
              if (isDigitalWorkforceTab(id)) setTab(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {message ? (
        <Alert tone={message === "Saved." ? "success" : "danger"} title="Digital Workforce">
          {message}
        </Alert>
      ) : null}

      {tab === "organization" ? (
        <section className="bea-workforce-pane" data-testid="workforce-organization">
          <DigitalWorkforceHierarchy
            nodes={organization}
            selectedAgentId={selectedAgentId}
            onSelect={(agentId) => {
              setSelectedAgentId(agentId);
              setTab("agents");
              window.history.replaceState(
                null,
                "",
                `/digital-workforce?tab=agents&agent=${agentId}`,
              );
            }}
          />
        </section>
      ) : null}

      {tab === "agents" ? (
        <section className="bea-workforce-pane" data-testid="workforce-agents">
          <form className="bea-filter-bar" onSubmit={(event) => event.preventDefault()}>
            <FormField label="Search Digital Agents" htmlFor="workforce-agent-query">
              <Input
                id="workforce-agent-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </FormField>
            <FormField label="Status" htmlFor="workforce-agent-status">
              <Select
                id="workforce-agent-status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="">All</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </Select>
            </FormField>
            <FormField label="Department" htmlFor="workforce-agent-department">
              <Select
                id="workforce-agent-department"
                value={departmentId}
                onChange={(event) => setDepartmentId(event.target.value)}
              >
                <option value="">All departments</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </Select>
            </FormField>
          </form>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Model</th>
                  <th>Tools</th>
                  <th>Knowledge</th>
                </tr>
              </thead>
              <tbody>
                {filteredAgents.map((agent) => {
                  const version = versionsByAgentId[agent.id];
                  return (
                    <tr key={agent.id}>
                      <td>
                        <button
                          type="button"
                          onClick={() => setSelectedAgentId(agent.id)}
                          data-testid={`workforce-agent-row-${agent.slug}`}
                        >
                          {agent.displayName}
                        </button>
                        <div>
                          <small>{DIGITAL_AGENT_LABEL}</small>
                        </div>
                      </td>
                      <td>{agent.roleTitle}</td>
                      <td>
                        <Badge>{agentStatusLabel(agent.status)}</Badge>
                      </td>
                      <td>{version?.modelAssignment.profile ?? "Unpublished"}</td>
                      <td>{toolGrantCount(version ?? null)}</td>
                      <td>{knowledgeDisclosure(version ?? null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableFoundation>
          {currentAgent ? (
            <Card data-testid="workforce-agent-detail">
              <CardHeader>
                <CardTitle>
                  {currentAgent.displayName} · {DIGITAL_AGENT_LABEL}
                </CardTitle>
              </CardHeader>
              <CardContent className="bea-stack">
                <p>{currentAgent.roleTitle}</p>
                <p>{currentAgent.shortDescription}</p>
                <p>Published version {published?.versionNumber ?? "none"}</p>
                <p>{knowledgeDisclosure(published ?? null)}</p>
                <p>Supported employee association does not grant that employee’s permissions.</p>
                <div className="bea-cluster">
                  {canManage ? (
                    <>
                      <Button
                        variant="secondary"
                        busy={busy}
                        data-testid="workforce-clone-agent"
                        onClick={() =>
                          void postJson(`/api/digital-workforce/agents/${currentAgent.id}`, {
                            action: "clone",
                            displayName: `${currentAgent.displayName} copy`,
                            slug: `${currentAgent.slug}-copy-${crypto.randomUUID().slice(0, 8)}`,
                          })
                        }
                      >
                        Clone
                      </Button>
                      <Button
                        variant="secondary"
                        busy={busy}
                        data-testid="workforce-pause-agent"
                        onClick={() =>
                          void postJson(`/api/digital-workforce/agents/${currentAgent.id}`, {
                            action: currentAgent.status === "paused" ? "resume" : "pause",
                          })
                        }
                      >
                        {currentAgent.status === "paused" ? "Resume" : "Pause"}
                      </Button>
                      <Button
                        variant="danger"
                        busy={busy}
                        onClick={() =>
                          void postJson(`/api/digital-workforce/agents/${currentAgent.id}`, {
                            action: "archive",
                          })
                        }
                      >
                        Archive
                      </Button>
                    </>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : null}
          {canManage ? (
            <DigitalWorkforceWizard
              departments={departments}
              teams={teams}
              agents={organization.map((node) => ({
                id: node.agentId,
                displayName: node.displayName,
              }))}
              canPublish={canPublish}
              onCreated={() => window.location.reload()}
            />
          ) : null}
          {canManage ? (
            <form
              className="bea-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void (async () => {
                  const response = await fetch("/api/digital-workforce/drafts", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ request: naturalLanguage }),
                  });
                  const payload = (await response.json()) as {
                    preview?: { displayName: string; warnings: string[] };
                    error?: { message?: string };
                  };
                  setDraftPreview(
                    payload.preview
                      ? `${payload.preview.displayName}. ${payload.preview.warnings.join(" ")}`
                      : (payload.error?.message ?? "Draft preview failed."),
                  );
                })();
              }}
            >
              <FormField label="Natural-language Digital Agent draft" htmlFor="workforce-nl">
                <Input
                  id="workforce-nl"
                  value={naturalLanguage}
                  onChange={(event) => setNaturalLanguage(event.target.value)}
                  maxLength={2000}
                />
              </FormField>
              <Button type="submit">Prepare draft preview</Button>
              {draftPreview ? <p data-testid="workforce-nl-preview">{draftPreview}</p> : null}
            </form>
          ) : null}
        </section>
      ) : null}

      {tab === "active" ? (
        <section className="bea-workforce-pane" data-testid="workforce-active">
          {canRun ? (
            <Button
              busy={busy}
              data-testid="workforce-start-executive-run"
              onClick={() =>
                void postJson("/api/digital-workforce/runs", {
                  goal: EXECUTIVE_TEAM_WORKFLOW_GOAL,
                  idempotencyKey: crypto.randomUUID(),
                })
              }
            >
              Start executive team workflow
            </Button>
          ) : null}
          {canCancel && selectedRun ? (
            <Button
              variant="danger"
              busy={busy}
              data-testid="workforce-cancel-run"
              onClick={() =>
                void postJson(`/api/digital-workforce/runs/${selectedRun.id}/cancel`, {
                  reason: "Owner stopped the run.",
                })
              }
            >
              Stop run
            </Button>
          ) : null}
          <ul>
            {runs.map((run) => (
              <li key={run.id}>
                <a href={`/digital-workforce?tab=active&run=${run.id}`}>{run.goal}</a>{" "}
                <Badge>{run.status}</Badge>
              </li>
            ))}
          </ul>
          <DigitalWorkforceRunTrace
            run={liveRun}
            steps={liveSteps}
            handoffs={liveHandoffs}
            events={liveEvents}
            onOpenHandoff={(id) => {
              setHandoffId(id);
              setTab("handoffs");
            }}
          />
        </section>
      ) : null}

      {tab === "handoffs" ? (
        <section className="bea-workforce-pane" data-testid="workforce-handoffs">
          {!selectedHandoff ? (
            <EmptyState
              title="No handoff selected"
              description="Structured Digital Agent handoffs appear here after a run starts."
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Handoff {selectedHandoff.status}</CardTitle>
              </CardHeader>
              <CardContent>
                <p>{selectedHandoff.packet.reason}</p>
                <p>{selectedHandoff.packet.boundedContextSummary}</p>
                <p>Requested: {selectedHandoff.packet.requestedDeliverable}</p>
              </CardContent>
            </Card>
          )}
        </section>
      ) : null}

      {tab === "templates" ? (
        <section className="bea-workforce-pane">
          <p>
            Seeded Digital Agents are labeled templates for Owner Evaluation. They are not human
            employees. Proposal Builder, Project Command Record, scheduling, email, and
            organizational File Search remain not connected.
          </p>
        </section>
      ) : null}

      {tab === "settings" ? (
        <section className="bea-workforce-pane">
          <p>
            Effective permission is the intersection of the initiating human user, the published
            agent version grants, data scopes, record authorization, approval policy, and model
            capability policy. Hierarchy never grants access.
          </p>
          <p>Pause behavior: finish the current safe step, then prevent the next step.</p>
        </section>
      ) : null}
    </div>
  );
}
