import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import {
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
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/authorization";
import { formatDateTime, statusTone } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Workflow Run Detail" };
export const dynamic = "force-dynamic";

export default async function WorkflowRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission(PERMISSIONS.WORKFLOW_VIEW, "workflow-run-detail");
  const runtime = await getServerRuntime();
  const { id } = await params;
  const detail = await runtime.phase1.getWorkflowRun(id);
  if (!detail) notFound();
  const { run, steps } = detail;

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Workflow evidence"
        title={run.workflowKey}
        description={`Correlation ${run.correlationId}`}
        actions={<Badge tone={statusTone(run.status)}>{run.status}</Badge>}
      />
      <Card>
        <CardHeader>
          <CardTitle>Run details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>Run ID</dt>
              <dd>
                <span className="bea-code">{run.id}</span>
              </dd>
            </div>
            <div>
              <dt>Idempotency key</dt>
              <dd>
                <span className="bea-code">{run.idempotencyKey}</span>
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{formatDateTime(run.startedAt)}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>{formatDateTime(run.finishedAt)}</dd>
            </div>
            <div>
              <dt>Retry count</dt>
              <dd>{run.retryCount}</dd>
            </div>
            <div>
              <dt>Cancellation requested</dt>
              <dd>{run.cancellationRequested ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Error</dt>
              <dd>{run.error?.message ?? "None"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Step evidence</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th scope="col">Sequence</th>
                  <th scope="col">Step</th>
                  <th scope="col">Status</th>
                  <th scope="col">Started</th>
                  <th scope="col">Finished</th>
                  <th scope="col">Retries</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step) => (
                  <tr key={step.id}>
                    <td>{step.sequence}</td>
                    <td>{step.stepKey}</td>
                    <td>
                      <Badge tone={statusTone(step.status)}>{step.status}</Badge>
                    </td>
                    <td>{formatDateTime(step.startedAt)}</td>
                    <td>{formatDateTime(step.finishedAt)}</td>
                    <td>{step.retryCount}</td>
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
