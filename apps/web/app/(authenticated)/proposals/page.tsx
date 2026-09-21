import { getServerRuntime } from "@bea/database";
import {
  COMMERCIAL_PRODUCTION_UNCONFIGURED,
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  PROPOSAL_STATUSES,
  type ProposalStatus,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  Input,
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
import {
  COMMERCIAL_PRODUCTION_LABEL,
  formatProposalMoney,
  proposalAgeLabel,
  proposalNextAction,
  proposalStatusLabel,
  proposalStatusTone,
} from "@/lib/commercial-presentation";

export const metadata: Metadata = { title: "Proposal queue" };
export const dynamic = "force-dynamic";

function queryValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

export default async function ProposalQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission(PERMISSIONS.PROPOSALS_VIEW, "proposals");
  const runtime = await getServerRuntime();
  if (runtime.environment.appMode === "demo") {
    await runtime.workControl.processPendingEvents();
  }
  const query = await searchParams;
  const text = queryValue(query.q);
  const requestedStatus = queryValue(query.status);
  const status = PROPOSAL_STATUSES.includes(requestedStatus as ProposalStatus)
    ? (requestedStatus as ProposalStatus)
    : undefined;
  const [items, metrics] = await Promise.all([
    runtime.commercial.repository.listProposals({
      ...(text ? { search: text } : {}),
      ...(status ? { status } : {}),
    }),
    runtime.commercial.repository.metrics(),
  ]);

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Commercial command record"
        title="Proposals"
        description="Internal proposal preparation, review, and no-write delivery planning. This is not client acceptance or a job award."
        actions={
          <div className="bea-cluster">
            <Badge tone="info">{metrics.total} proposals</Badge>
            <SyntheticFixtureBadge synthetic />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic />
      <p className="bea-muted" data-testid="synthetic-disclosure">
        {COMMERCIAL_SYNTHETIC_DISCLOSURE} {COMMERCIAL_PRODUCTION_LABEL}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Synthetic commercial metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="bea-cluster" data-testid="proposal-metrics">
            <Badge>Total {metrics.total}</Badge>
            <Badge tone="success">Ready for delivery {metrics.readyForDelivery}</Badge>
            <Badge tone="warning">Open overrides {metrics.withUnapprovedOverrides}</Badge>
          </div>
          <p className="bea-muted">
            These counts are laboratory metrics. Production catalog and pricing remain UNCONFIGURED.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="bea-cluster" method="get">
            <FormField label="Search" htmlFor="proposal-search">
              <Input id="proposal-search" name="q" defaultValue={text} />
            </FormField>
            <FormField label="Status" htmlFor="proposal-status">
              <Select id="proposal-status" name="status" defaultValue={status ?? ""}>
                <option value="">All statuses</option>
                {PROPOSAL_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {proposalStatusLabel(value)}
                  </option>
                ))}
              </Select>
            </FormField>
            <button className="bea-button bea-button--secondary" type="submit">
              Apply
            </button>
          </form>
        </CardContent>
      </Card>
      {items.length ? (
        <TableFoundation>
          <Table data-testid="proposal-queue">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Status</th>
                <th>Opportunity</th>
                <th>Total</th>
                <th>Currency</th>
                <th>Version</th>
                <th>Age</th>
                <th>Synthetic</th>
                <th>Next action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((proposal) => (
                <tr key={proposal.id} data-testid={`proposal-row-${proposal.reference}`}>
                  <td>
                    <Link href={`/proposals/${proposal.id}`}>{proposal.reference}</Link>
                  </td>
                  <td>
                    <Badge tone={proposalStatusTone(proposal.status)}>
                      {proposalStatusLabel(proposal.status)}
                    </Badge>
                  </td>
                  <td>{proposal.opportunityName}</td>
                  <td>{formatProposalMoney(proposal.totalMinor, proposal.currency)}</td>
                  <td>{proposal.currency}</td>
                  <td>{proposal.currentVersionNumber || "Draft"}</td>
                  <td>{proposalAgeLabel(proposal.createdAt)}</td>
                  <td>{proposal.synthetic ? "Synthetic" : "Production"}</td>
                  <td>
                    {proposalNextAction({
                      status: proposal.status,
                      openOverrideCount: 0,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      ) : (
        <EmptyState
          title="No proposals"
          description="Create a proposal from a ready_for_proposal Lead. Unready leads cannot bypass readiness."
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Proposal lab</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            Use ready Lead <span className="bea-code">BEA-LD-000003</span> for the envelope catalog
            and <span className="bea-code">BEA-LD-000005</span> for the moisture catalog. Both
            catalogs are synthetic. Production pricing is {COMMERCIAL_PRODUCTION_UNCONFIGURED}.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
