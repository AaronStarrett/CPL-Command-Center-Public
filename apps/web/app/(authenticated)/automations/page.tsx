import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";

import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import { formatDateTime } from "@/lib/phase1-presentation";
import {
  connectorStatusLabel,
  formatJobAttemptLabel,
  operationsStatusTone,
} from "@/lib/operations-presentation";

export const metadata: Metadata = { title: "Automations" };
export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  await requirePermission(PERMISSIONS.AUTOMATIONS_VIEW, "automations");
  const runtime = await getServerRuntime();
  const [blueprints, jobs, connectors, workBlueprints, schedules, plan] = await Promise.all([
    runtime.operations.repository.listBlueprints(),
    runtime.operations.repository.listJobs(),
    runtime.operations.repository.listConnectorReadiness(),
    runtime.workControl.repository.listBlueprints(),
    runtime.workControl.repository.listSchedules(),
    Promise.resolve(runtime.workControl.triggerProvisioningPlan()),
  ]);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Versioned blueprints"
        title="Automations"
        description="Code-defined inspection-to-report blueprints. This is not a general no-code workflow builder."
        actions={
          <div className="bea-cluster">
            <Badge tone="info">{blueprints.length} blueprints</Badge>
            <SyntheticFixtureBadge synthetic={runtime.environment.appMode === "demo"} />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic={runtime.environment.appMode === "demo"} />
      <Alert tone="info" title="Activation boundary">
        Blueprints run against durable jobs in this database. Live connector writes remain
        fail-closed. LIVE CONNECTION: NOT RUN.
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>Blueprints</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="automation-blueprints">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Version</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th>Human gate</th>
                </tr>
              </thead>
              <tbody>
                {blueprints.map((blueprint) => (
                  <tr key={`${blueprint.key}:${blueprint.blueprintVersion}`}>
                    <td>{blueprint.displayName}</td>
                    <td>{blueprint.blueprintVersion}</td>
                    <td>{blueprint.triggerEventType}</td>
                    <td>
                      <Badge tone={operationsStatusTone(blueprint.status)}>
                        {blueprint.status}
                      </Badge>
                    </td>
                    <td>{blueprint.parameters.humanGate === true ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 40).map((job) => (
                  <tr key={job.id}>
                    <td>{job.jobType}</td>
                    <td>
                      <Badge tone={operationsStatusTone(job.status)}>{job.status}</Badge>
                    </td>
                    <td>{formatJobAttemptLabel(job)}</td>
                    <td>{formatDateTime(job.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Internal work-routing triggers</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="work-routing-blueprints">
              <thead>
                <tr>
                  <th>Blueprint</th>
                  <th>Trigger</th>
                  <th>Work produced</th>
                  <th>Status</th>
                  <th>Policy</th>
                </tr>
              </thead>
              <tbody>
                {workBlueprints.map((blueprint) => (
                  <tr key={`${blueprint.blueprintKey}:${blueprint.blueprintVersion}`}>
                    <td>{blueprint.title}</td>
                    <td>{blueprint.triggerEventTypes.join(", ")}</td>
                    <td>{blueprint.workItemKind}</td>
                    <td>
                      <Badge
                        tone={blueprint.triggerStatus === "active_internal" ? "success" : "warning"}
                      >
                        {blueprint.triggerStatus}
                      </Badge>
                    </td>
                    <td>v{blueprint.blueprintVersion} · synthetic</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Pending scheduled actions</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="automation-schedules">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Action</th>
                  <th>Status</th>
                  <th>Scheduled for</th>
                </tr>
              </thead>
              <tbody>
                {schedules.slice(0, 20).map((item) => (
                  <tr key={item.id}>
                    <td>{item.scheduleKey}</td>
                    <td>{item.actionType}</td>
                    <td>{item.status}</td>
                    <td>{formatDateTime(item.scheduledFor)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Alert tone="warning" data-testid="external-trigger-placeholders">
        Outlook, SharePoint, and calendar placeholders remain {plan.status}. LIVE CONNECTION: NOT
        RUN. No subscription is installed.
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>Connector readiness</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th>Connector</th>
                  <th>Status</th>
                  <th>Required action</th>
                </tr>
              </thead>
              <tbody>
                {connectors.map((connector) => (
                  <tr key={connector.id}>
                    <td>{connector.displayName}</td>
                    <td>
                      <Badge tone={connector.readinessStatus === "healthy" ? "success" : "warning"}>
                        {connectorStatusLabel(connector.readinessStatus)}
                      </Badge>
                    </td>
                    <td>{connector.requiredAction ?? "None"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
    </div>
  );
}
