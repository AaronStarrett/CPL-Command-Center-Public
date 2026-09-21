import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  EmptyState,
  FormField,
  Link,
  PageHeader,
  Select,
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
  exceptionSummary,
  filterTurnaroundBoard,
  formatDurationMs,
  inspectionStatusLabel,
  isSyntheticOperationsFixture,
  operationsStatusTone,
  reportStatusLabel,
  slaTone,
  TURNAROUND_BOARD_FILTERS,
} from "@/lib/operations-presentation";

export const metadata: Metadata = { title: "Turnaround Board" };
export const dynamic = "force-dynamic";

function queryValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export default async function OperationsBoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission(PERMISSIONS.OPERATIONS_BOARD_VIEW, "operations");
  const runtime = await getServerRuntime();
  const query = await searchParams;
  const filter = queryValue(query.filter);
  const items = filterTurnaroundBoard(
    await runtime.operations.repository.listTurnaroundBoard(),
    filter,
  );
  const syntheticBoard =
    runtime.environment.appMode === "demo" ||
    items.some((item) =>
      isSyntheticOperationsFixture(runtime.environment.appMode, item.project.acceptedScopeSnapshot),
    );

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Inspection-to-report automation"
        title="Turnaround board"
        description="North-star metric: report delivered at minus inspection completed at. This board is the operational queue, not a chart wall."
        actions={<SyntheticFixtureBadge synthetic={syntheticBoard} />}
      />
      <SyntheticFixtureBanner synthetic={syntheticBoard} />
      <form action="/operations" className="bea-filter-bar">
        <FormField label="Queue filter" htmlFor="operations-filter">
          <Select id="operations-filter" name="filter" defaultValue={filter}>
            {TURNAROUND_BOARD_FILTERS.map((option) => (
              <option key={option.key || "all"} value={option.key}>
                {option.label}
              </option>
            ))}
          </Select>
        </FormField>
        <button className="bea-button bea-button--secondary" type="submit">
          Apply
        </button>
      </form>
      {items.length === 0 ? (
        <EmptyState
          title="No inspections match this filter"
          description="Seeded synthetic inspections appear here after demo reset. Submit inspection data to move work."
        />
      ) : (
        <TableFoundation>
          <Table data-testid="operations-board">
            <thead>
              <tr>
                <th>Project</th>
                <th>Client / site</th>
                <th>Inspection</th>
                <th>Stage</th>
                <th>Owner</th>
                <th>Age since complete</th>
                <th>Stage age</th>
                <th>Paused</th>
                <th>SLA</th>
                <th>Blocker</th>
                <th>Current work</th>
                <th>Work owner</th>
                <th>Queue</th>
                <th>Work age</th>
                <th>Due</th>
                <th>Reminder</th>
                <th>Escalation</th>
                <th>Human waiting</th>
                <th>System processing</th>
                <th>Next action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.inspection.id} data-testid={`board-row-${item.inspection.reference}`}>
                  <td>
                    <Link href={`/projects`}>{item.project.reference}</Link>
                    <div>{item.project.name}</div>
                  </td>
                  <td>
                    {item.project.clientName}
                    <div>
                      {item.project.siteName}
                      {item.project.siteCity ? `, ${item.project.siteCity}` : ""}
                    </div>
                  </td>
                  <td>
                    <Link href={`/inspections/${item.inspection.id}`}>
                      {item.inspection.reference}
                    </Link>
                    <div>{item.inspectorName ?? "Unassigned"}</div>
                  </td>
                  <td>
                    <Badge tone={operationsStatusTone(item.inspection.status)}>
                      {inspectionStatusLabel(item.inspection.status)}
                    </Badge>
                    {item.report ? (
                      <div>
                        <Link href={`/reports/${item.report.id}`}>{item.report.reference}</Link>
                        <Badge tone={operationsStatusTone(item.report.status)}>
                          {reportStatusLabel(item.report.status)}
                        </Badge>
                      </div>
                    ) : null}
                  </td>
                  <td data-testid={`board-owner-${item.inspection.reference}`}>
                    {item.currentOwner ?? "Unassigned"}
                  </td>
                  <td data-testid={`board-age-${item.inspection.reference}`}>
                    {formatDurationMs(item.metrics.currentAgeMs)}
                  </td>
                  <td>{formatDurationMs(item.metrics.currentStageAgeMs)}</td>
                  <td data-testid={`board-paused-${item.inspection.reference}`}>
                    {formatDurationMs(item.metrics.pausedDurationMs)}
                    {item.metrics.pauseReason ? ` · ${item.metrics.pauseReason}` : ""}
                  </td>
                  <td>
                    <Badge tone={slaTone(item.metrics)}>{item.metrics.slaStatus}</Badge>
                    <div>
                      Remaining {formatDurationMs(item.metrics.slaRemainingMs)} /{" "}
                      {item.metrics.slaTargetMinutes} min
                    </div>
                    <div>SLA elapsed {formatDurationMs(item.metrics.slaElapsedMs)}</div>
                    {item.metrics.totalTurnaroundMs !== null ? (
                      <div data-testid={`turnaround-${item.inspection.reference}`}>
                        Turnaround {formatDurationMs(item.metrics.totalTurnaroundMs)}
                      </div>
                    ) : null}
                    {item.metrics.confirmedDeliveryAt ? (
                      <div>Confirmed {item.metrics.confirmedDeliveryAt}</div>
                    ) : null}
                  </td>
                  <td>{exceptionSummary(item.exception)}</td>
                  <td data-testid={`board-work-${item.inspection.reference}`}>
                    {item.work.workItemId ? (
                      <>
                        <Link href={`/work/${item.work.workItemId}`}>{item.work.reference}</Link>
                        <div>{item.work.kind}</div>
                      </>
                    ) : (
                      "None open"
                    )}
                  </td>
                  <td>
                    {item.work.assignedUserName ??
                      item.work.assignedRoleKey ??
                      item.currentOwner ??
                      "Unassigned"}
                  </td>
                  <td>{item.work.queueKey ?? "—"}</td>
                  <td>{formatDurationMs(item.work.ageMs)}</td>
                  <td>{item.work.dueAt ? formatDateTime(item.work.dueAt) : "—"}</td>
                  <td>{item.work.reminderState ?? "none"}</td>
                  <td>{item.work.escalationLevel ?? "none"}</td>
                  <td>{formatDurationMs(item.work.humanWaitingMs)}</td>
                  <td>{formatDurationMs(item.work.systemProcessingMs)}</td>
                  <td>
                    {item.work.requiredAction ?? item.nextAction}
                    {item.work.blockedReason ? <div>Blocked: {item.work.blockedReason}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      )}
      <p className="bea-muted">
        Last clock sample {formatDateTime(new Date().toISOString())} UTC display.
      </p>
    </div>
  );
}
