import { getServerRuntime } from "@bea/database";
import { DIGITAL_AGENT_LABEL } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import { Badge, PageHeader } from "@bea/ui";
import type { Metadata } from "next";

import { DigitalWorkforceStudio } from "@/components/digital-workforce-studio";
import { requirePermission } from "@/lib/auth/authorization";
import { isDigitalWorkforceTab, type DigitalWorkforceTab } from "@/lib/digital-workforce";
import { audienceRoles } from "@/lib/digital-workforce-runtime";

export const metadata: Metadata = { title: "Digital Workforce" };
export const dynamic = "force-dynamic";

function queryValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

export default async function DigitalWorkforcePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission(PERMISSIONS.DIGITAL_WORKFORCE_VIEW, "digital-workforce");
  const runtime = await getServerRuntime();
  const query = await searchParams;
  const tabValue = queryValue(query.tab);
  const tab: DigitalWorkforceTab = isDigitalWorkforceTab(tabValue) ? tabValue : "organization";
  const agentId = queryValue(query.agent);
  const runId = queryValue(query.run);
  const roles = audienceRoles(session.roleIds);
  const [organization, departments, teams, agents, runs, manage, publish, run, cancel] =
    await Promise.all([
      runtime.digitalWorkforce.listOrganization({
        ...(roles ? { availableToRoleIds: roles } : {}),
      }),
      runtime.digitalWorkforce.listDepartments(),
      runtime.digitalWorkforce.listTeams(),
      runtime.digitalWorkforce.listAgents({
        includeArchived: true,
        limit: 100,
        ...(roles ? { availableToRoleIds: roles } : {}),
      }),
      runtime.digitalWorkforce.listRuns({ limit: 50 }),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.DIGITAL_WORKFORCE_MANAGE),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.DIGITAL_WORKFORCE_PUBLISH),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.DIGITAL_WORKFORCE_RUN),
      runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.DIGITAL_WORKFORCE_CANCEL),
    ]);
  const versionsByAgentId: Record<
    string,
    Awaited<ReturnType<typeof runtime.digitalWorkforce.getPublishedVersion>>
  > = {};
  await Promise.all(
    agents.map(async (agent) => {
      versionsByAgentId[agent.id] = agent.currentPublishedVersionId
        ? await runtime.digitalWorkforce.getPublishedVersion(agent.id)
        : null;
    }),
  );
  const selectedAgent = agentId
    ? ((await runtime.digitalWorkforce.getAgent(agentId)) ?? null)
    : null;
  const selectedVersions = selectedAgent
    ? await runtime.digitalWorkforce.listAgentVersions(selectedAgent.id)
    : [];
  const selectedRun =
    (runId ? await runtime.digitalWorkforce.getRun(runId) : null) ?? runs[0] ?? null;
  const [selectedSteps, selectedHandoffs, selectedEvents] = selectedRun
    ? await Promise.all([
        runtime.digitalWorkforce.listSteps(selectedRun.id),
        runtime.digitalWorkforce.listHandoffs(selectedRun.id),
        runtime.digitalWorkforce.listEvents(selectedRun.id, 200),
      ])
    : [[], [], []];

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Phase 2.3 Digital Workforce Alpha"
        title="Digital Workforce"
        description={`${DIGITAL_AGENT_LABEL}s are application-owned workers. They are not human employees and cannot expand permissions.`}
        actions={<Badge tone="info">{organization.length} Digital Agents</Badge>}
      />
      <DigitalWorkforceStudio
        tab={tab}
        organization={organization}
        departments={departments}
        teams={teams}
        agents={agents}
        versionsByAgentId={versionsByAgentId}
        runs={runs}
        selectedAgent={selectedAgent}
        selectedVersions={selectedVersions}
        selectedRun={selectedRun}
        selectedSteps={selectedSteps}
        selectedHandoffs={selectedHandoffs}
        selectedEvents={selectedEvents}
        canManage={manage.allowed}
        canPublish={publish.allowed}
        canRun={run.allowed}
        canCancel={cancel.allowed}
      />
    </div>
  );
}
