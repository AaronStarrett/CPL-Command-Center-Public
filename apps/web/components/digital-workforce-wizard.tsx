"use client";

import {
  DIGITAL_AGENT_AVATARS,
  DIGITAL_WORKFORCE_APPROVAL_POLICIES,
  DIGITAL_WORKFORCE_DATA_SCOPES,
  DIGITAL_WORKFORCE_KNOWLEDGE_SCOPES,
  DIGITAL_WORKFORCE_MODEL_PROFILES,
  DIGITAL_WORKFORCE_REGISTERED_TOOLS,
  DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY,
} from "@bea/domain";
import { Alert, Button, FormField, Input, Select, Textarea } from "@bea/ui";
import { useMemo, useState } from "react";

import { PUBLISH_DIGITAL_AGENT_CONFIRMATION } from "@/lib/digital-workforce";

const STEPS = [
  "Identity",
  "Organization",
  "Responsibilities",
  "AI model",
  "Tools and data",
  "Control",
  "Review",
] as const;

export interface DigitalWorkforceWizardProps {
  readonly departments: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  }[];
  readonly teams: readonly {
    readonly id: string;
    readonly name: string;
    readonly departmentId: string;
    readonly slug: string;
  }[];
  readonly agents: readonly { readonly id: string; readonly displayName: string }[];
  readonly canPublish: boolean;
  readonly onCreated: (agentId: string) => void;
}

export function DigitalWorkforceWizard({
  departments,
  teams,
  agents,
  canPublish,
  onCreated,
}: DigitalWorkforceWizardProps) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishConfirm, setPublishConfirm] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [shortDescription, setShortDescription] = useState("Digital Agent");
  const [slug, setSlug] = useState("");
  const [avatar, setAvatar] =
    useState<(typeof DIGITAL_AGENT_AVATARS)[number]>("specialist-operations");
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [supervisorAgentId, setSupervisorAgentId] = useState("");
  const [goals, setGoals] = useState("Support authorized owner work.");
  const [successCriteria, setSuccessCriteria] = useState("Stay inside registered tools.");
  const [escalation, setEscalation] = useState(
    "Escalate to the owner. A Digital Agent cannot approve its own work.",
  );
  const [modelProfile, setModelProfile] =
    useState<(typeof DIGITAL_WORKFORCE_MODEL_PROFILES)[number]>("balanced");
  const [toolNames, setToolNames] = useState<string[]>(["bea_list_agents", "bea_get_agent"]);
  const [dataScopes, setDataScopes] = useState<string[]>(["current-conversation"]);
  const [knowledgeScopes, setKnowledgeScopes] = useState<string[]>(["current-conversation"]);
  const [approvalPolicy, setApprovalPolicy] =
    useState<(typeof DIGITAL_WORKFORCE_APPROVAL_POLICIES)[number]>("confirmation-required");
  const filteredTeams = useMemo(
    () => teams.filter((team) => !departmentId || team.departmentId === departmentId),
    [teams, departmentId],
  );

  function toggle(list: string[], value: string, setter: (next: string[]) => void) {
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  }

  async function save(publish: boolean) {
    setBusy(true);
    setError(null);
    try {
      const created = await fetch("/api/digital-workforce/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: slug || displayName.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-"),
          displayName,
          roleTitle,
          shortDescription,
          avatar,
          departmentId,
          teamId,
          supervisorAgentId: supervisorAgentId || null,
          persona: `${shortDescription} This Digital Agent never expands permissions.`,
          roleDefinition: roleTitle,
          goals: goals
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean),
          successCriteria: successCriteria
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean),
          modelProfile,
          toolNames,
          dataScopes,
          knowledgeScopes,
          approvalPolicy,
          escalationInstructions: escalation,
          runtimePolicy: DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY,
        }),
      });
      const payload = (await created.json()) as {
        agent?: { id: string };
        draft?: { id: string };
        error?: { message?: string };
      };
      if (!created.ok || !payload.agent) {
        throw new Error(payload.error?.message ?? "The Digital Agent draft could not be saved.");
      }
      if (publish) {
        if (!canPublish) throw new Error("Publishing requires digital-workforce.publish.");
        const published = await fetch(`/api/digital-workforce/agents/${payload.agent.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "publish",
            versionId: payload.draft?.id,
            confirmation: PUBLISH_DIGITAL_AGENT_CONFIRMATION,
          }),
        });
        if (!published.ok) {
          const failure = (await published.json()) as { error?: { message?: string } };
          throw new Error(failure.error?.message ?? "Publishing was rejected.");
        }
      }
      onCreated(payload.agent.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The Digital Agent could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="bea-stack bea-workforce-wizard"
      data-testid="workforce-wizard"
      onSubmit={(event) => {
        event.preventDefault();
        if (step < STEPS.length - 1) setStep(step + 1);
      }}
    >
      <p id="workforce-wizard-step">
        Step {step + 1} of {STEPS.length}: {STEPS[step]}
      </p>
      {step === 0 ? (
        <>
          <FormField label="Digital Agent name" htmlFor="agent-name">
            <Input
              id="agent-name"
              required
              maxLength={160}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </FormField>
          <FormField label="Role title" htmlFor="agent-role">
            <Input
              id="agent-role"
              required
              maxLength={160}
              value={roleTitle}
              onChange={(event) => setRoleTitle(event.target.value)}
            />
          </FormField>
          <FormField label="Description" htmlFor="agent-description">
            <Textarea
              id="agent-description"
              maxLength={2000}
              value={shortDescription}
              onChange={(event) => setShortDescription(event.target.value)}
            />
          </FormField>
          <FormField label="Slug" htmlFor="agent-slug">
            <Input
              id="agent-slug"
              maxLength={80}
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
            />
          </FormField>
          <FormField label="Avatar" htmlFor="agent-avatar">
            <Select
              id="agent-avatar"
              value={avatar}
              onChange={(event) => setAvatar(event.target.value as typeof avatar)}
            >
              {DIGITAL_AGENT_AVATARS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </FormField>
        </>
      ) : null}
      {step === 1 ? (
        <>
          <FormField label="Department" htmlFor="agent-department">
            <Select
              id="agent-department"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Team" htmlFor="agent-team">
            <Select
              id="agent-team"
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            >
              {filteredTeams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Supervisor Digital Agent" htmlFor="agent-supervisor">
            <Select
              id="agent-supervisor"
              value={supervisorAgentId}
              onChange={(event) => setSupervisorAgentId(event.target.value)}
            >
              <option value="">None</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </Select>
          </FormField>
        </>
      ) : null}
      {step === 2 ? (
        <>
          <FormField label="Goals" htmlFor="agent-goals">
            <Textarea
              id="agent-goals"
              value={goals}
              onChange={(event) => setGoals(event.target.value)}
            />
          </FormField>
          <FormField label="Success criteria" htmlFor="agent-success">
            <Textarea
              id="agent-success"
              value={successCriteria}
              onChange={(event) => setSuccessCriteria(event.target.value)}
            />
          </FormField>
          <FormField label="Escalation" htmlFor="agent-escalation">
            <Textarea
              id="agent-escalation"
              value={escalation}
              onChange={(event) => setEscalation(event.target.value)}
            />
          </FormField>
        </>
      ) : null}
      {step === 3 ? (
        <FormField label="Verified model profile" htmlFor="agent-model">
          <Select
            id="agent-model"
            value={modelProfile}
            onChange={(event) => setModelProfile(event.target.value as typeof modelProfile)}
          >
            {DIGITAL_WORKFORCE_MODEL_PROFILES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}
      {step === 4 ? (
        <>
          <fieldset>
            <legend>Registered tools</legend>
            {DIGITAL_WORKFORCE_REGISTERED_TOOLS.map((tool) => (
              <label key={tool}>
                <input
                  type="checkbox"
                  checked={toolNames.includes(tool)}
                  onChange={() => toggle(toolNames, tool, setToolNames)}
                />{" "}
                {tool}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Data scopes</legend>
            {DIGITAL_WORKFORCE_DATA_SCOPES.map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={dataScopes.includes(scope)}
                  onChange={() => toggle(dataScopes, scope, setDataScopes)}
                />{" "}
                {scope}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Knowledge scopes</legend>
            {DIGITAL_WORKFORCE_KNOWLEDGE_SCOPES.map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={knowledgeScopes.includes(scope)}
                  onChange={() => toggle(knowledgeScopes, scope, setKnowledgeScopes)}
                />{" "}
                {scope}
              </label>
            ))}
          </fieldset>
        </>
      ) : null}
      {step === 5 ? (
        <>
          <FormField label="Approval policy" htmlFor="agent-approval">
            <Select
              id="agent-approval"
              value={approvalPolicy}
              onChange={(event) => setApprovalPolicy(event.target.value as typeof approvalPolicy)}
            >
              {DIGITAL_WORKFORCE_APPROVAL_POLICIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </FormField>
          <p>
            Runtime defaults: {DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY.maximumSteps} steps,{" "}
            {DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY.maximumHandoffs} handoffs, $
            {DEFAULT_DIGITAL_WORKFORCE_RUNTIME_POLICY.maximumEstimatedCostUsd} ceiling.
          </p>
        </>
      ) : null}
      {step === 6 ? (
        <>
          <Alert tone="info" title="Review Digital Agent draft">
            {displayName} remains unpublished until you confirm. Hidden global security instructions
            stay server-side.
          </Alert>
          <p>
            {roleTitle} in the selected department and team. Model profile {modelProfile}. Tools{" "}
            {toolNames.length}. Approval {approvalPolicy}.
          </p>
          {canPublish ? (
            <label>
              <input
                type="checkbox"
                data-testid="workforce-publish-confirm"
                checked={publishConfirm}
                onChange={(event) => setPublishConfirm(event.target.checked)}
              />{" "}
              I confirm publication of this Digital Agent
            </label>
          ) : (
            <p>The current role can save drafts but cannot publish.</p>
          )}
        </>
      ) : null}
      {error ? (
        <Alert tone="danger" title="Digital Agent was not saved">
          {error}
        </Alert>
      ) : null}
      <div className="bea-cluster">
        {step > 0 ? (
          <Button type="button" variant="secondary" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        ) : null}
        {step < STEPS.length - 1 ? (
          <Button type="submit" data-testid="workforce-wizard-continue">
            Continue
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="secondary"
              busy={busy}
              data-testid="workforce-wizard-save-draft"
              onClick={() => void save(false)}
            >
              Save draft
            </Button>
            <Button
              type="button"
              busy={busy}
              disabled={!canPublish || !publishConfirm}
              data-testid="workforce-wizard-publish"
              onClick={() => void save(true)}
            >
              Publish agent
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
