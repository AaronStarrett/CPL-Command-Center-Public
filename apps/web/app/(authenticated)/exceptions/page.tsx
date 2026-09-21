import { getServerRuntime } from "@bea/database";
import { PERMISSIONS } from "@bea/security";
import { Badge, EmptyState, Link, PageHeader, Table, TableFoundation } from "@bea/ui";
import type { Metadata } from "next";

import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import { operationsStatusTone } from "@/lib/operations-presentation";

export const metadata: Metadata = { title: "Exceptions" };
export const dynamic = "force-dynamic";

export default async function ExceptionsPage() {
  await requirePermission(PERMISSIONS.EXCEPTIONS_VIEW, "exceptions");
  const runtime = await getServerRuntime();
  const exceptions = await runtime.operations.repository.listExceptions();
  const synthetic = runtime.environment.appMode === "demo";

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Fail visibly"
        title="Exceptions"
        description="Validation blockers, delivery failures, and other automation stops. Nothing in this queue is allowed to disappear."
        actions={
          <div className="bea-cluster">
            <Badge tone="info">{exceptions.length} records</Badge>
            <SyntheticFixtureBadge synthetic={synthetic} />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic={synthetic} />
      {exceptions.length === 0 ? (
        <EmptyState
          title="No exceptions"
          description="Incomplete submissions and failed deliveries appear here automatically."
        />
      ) : (
        <TableFoundation>
          <Table data-testid="exception-queue">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Title</th>
                <th>Owner</th>
                <th>Related inspection</th>
              </tr>
            </thead>
            <tbody>
              {exceptions.map((exception) => (
                <tr key={exception.id}>
                  <td>{exception.reference}</td>
                  <td>{exception.kind}</td>
                  <td>
                    <Badge tone={operationsStatusTone(exception.status)}>{exception.status}</Badge>
                  </td>
                  <td>
                    {exception.title}
                    <div>{exception.detail}</div>
                    {exception.resolvedAt ? (
                      <div data-testid={`exception-resolved-${exception.reference}`}>
                        Resolved {exception.resolvedAt}
                        {exception.resolvedByActorType
                          ? ` by ${exception.resolvedByActorType}`
                          : ""}
                      </div>
                    ) : null}
                  </td>
                  <td data-testid={`exception-owner-${exception.reference}`}>
                    {exception.ownerDisplayName ?? exception.ownerUserId ?? "Unassigned"}
                  </td>
                  <td>
                    {exception.inspectionId ? (
                      <Link href={`/inspections/${exception.inspectionId}`}>Open inspection</Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      )}
    </div>
  );
}
