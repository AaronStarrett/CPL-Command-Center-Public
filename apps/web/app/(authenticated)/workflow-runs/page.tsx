import { getServerRuntime } from "@bea/database";
import type { WorkflowStatus } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Button,
  EmptyState,
  FormField,
  Link,
  PageHeader,
  Select,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/authorization";
import { formatDateTime, statusTone } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Workflow Runs" };
export const dynamic = "force-dynamic";

const workflowStatuses = [
  "pending",
  "running",
  "succeeded",
  "degraded",
  "failed",
  "cancelled",
] as const;

export default async function WorkflowRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission(PERMISSIONS.WORKFLOW_VIEW, "workflow-runs");
  const runtime = await getServerRuntime();
  const query = await searchParams;
  const requestedStatus = typeof query.status === "string" ? query.status : "";
  const status = workflowStatuses.includes(requestedStatus as WorkflowStatus)
    ? (requestedStatus as WorkflowStatus)
    : undefined;
  const runs = await runtime.phase1.listWorkflowRuns({
    limit: 100,
    ...(status ? { status } : {}),
  });

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Automation evidence"
        title="Workflow runs"
        description="Inspect persisted workflow status, timing, correlation, and retry evidence."
        actions={<Badge tone="info">{runs.length} shown</Badge>}
      />
      <form action="/workflow-runs" className="bea-filter-bar bea-filter-bar--compact">
        <FormField label="Status" htmlFor="workflow-status">
          <Select id="workflow-status" name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {workflowStatuses.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </FormField>
        <Button type="submit" variant="secondary">
          Apply filter
        </Button>
      </form>
      {runs.length ? (
        <TableFoundation>
          <Table>
            <thead>
              <tr>
                <th scope="col">Workflow</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col">Finished</th>
                <th scope="col">Retries</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link href={`/workflow-runs/${encodeURIComponent(run.id)}`}>
                      {run.workflowKey}
                    </Link>
                  </td>
                  <td>
                    <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                  </td>
                  <td>{formatDateTime(run.startedAt)}</td>
                  <td>{formatDateTime(run.finishedAt)}</td>
                  <td>{run.retryCount}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      ) : (
        <EmptyState
          title="No workflow runs found"
          description="No workflow runs match the current filter."
        />
      )}
    </div>
  );
}
