import { getServerRuntime } from "@bea/database";
import {
  LEAD_SOURCE_TYPES,
  LEAD_STATUSES,
  type LeadSourceType,
  type LeadStatus,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Button,
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

import { requirePermission } from "@/lib/auth/authorization";
import { formatDateTime } from "@/lib/phase1-presentation";
import {
  leadQueuePrimaryLabel,
  leadReadinessTone,
  leadSourceLabel,
  leadStatusLabel,
  leadStatusTone,
} from "@/lib/lead-presentation";

export const metadata: Metadata = { title: "Lead Review Queue" };
export const dynamic = "force-dynamic";

function queryValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission(PERMISSIONS.LEADS_VIEW, "leads");
  const runtime = await getServerRuntime();
  const query = await searchParams;
  const text = queryValue(query.q);
  const requestedStatus = queryValue(query.status);
  const requestedSource = queryValue(query.source);
  const requestedReviewer = queryValue(query.reviewer);
  const status = LEAD_STATUSES.includes(requestedStatus as LeadStatus)
    ? (requestedStatus as LeadStatus)
    : undefined;
  const sourceType = LEAD_SOURCE_TYPES.includes(requestedSource as LeadSourceType)
    ? (requestedSource as LeadSourceType)
    : undefined;
  const [manageDecision, reviewers] = await Promise.all([
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.LEADS_MANAGE),
    runtime.leads.listReviewerCandidates(),
  ]);
  const reviewerUserId =
    requestedReviewer === "unassigned"
      ? null
      : reviewers.some((reviewer) => reviewer.id === requestedReviewer)
        ? requestedReviewer
        : undefined;
  const leads = await runtime.leads.listLeads({
    limit: 100,
    ...(text ? { query: text } : {}),
    ...(status ? { status } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(reviewerUserId !== undefined ? { reviewerUserId } : {}),
  });

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Phase 2.0 review queue"
        title="Leads"
        description="Manual, referral, and in-person intake records. Ready for proposal means review-ready only, not commercially authorized or scheduled."
        actions={
          <div className="bea-cluster">
            <Badge tone="info">{leads.length} shown</Badge>
            {manageDecision.allowed ? (
              <Link href="/leads/new" variant="button">
                Create lead
              </Link>
            ) : null}
          </div>
        }
      />
      <form action="/leads" className="bea-filter-bar bea-filter-bar--leads">
        <FormField label="Reference, opportunity, or request" htmlFor="lead-query">
          <Input id="lead-query" name="q" type="search" defaultValue={text} maxLength={120} />
        </FormField>
        <FormField label="Status" htmlFor="lead-status">
          <Select id="lead-status" name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {LEAD_STATUSES.map((option) => (
              <option key={option} value={option}>
                {leadStatusLabel(option)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Source" htmlFor="lead-source">
          <Select id="lead-source" name="source" defaultValue={sourceType ?? ""}>
            <option value="">All sources</option>
            {LEAD_SOURCE_TYPES.map((option) => (
              <option key={option} value={option}>
                {leadSourceLabel(option)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Reviewer" htmlFor="lead-reviewer">
          <Select id="lead-reviewer" name="reviewer" defaultValue={requestedReviewer}>
            <option value="">All reviewers</option>
            <option value="unassigned">Unassigned</option>
            {reviewers.map((reviewer) => (
              <option key={reviewer.id} value={reviewer.id}>
                {reviewer.displayName}
              </option>
            ))}
          </Select>
        </FormField>
        <Button type="submit" variant="secondary">
          Apply filters
        </Button>
      </form>
      {leads.length ? (
        <TableFoundation>
          <Table>
            <thead>
              <tr>
                <th scope="col">Lead</th>
                <th scope="col">Status</th>
                <th scope="col">Source</th>
                <th scope="col">Received</th>
                <th scope="col">Company / contact</th>
                <th scope="col">Reviewer</th>
                <th scope="col">Readiness</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((item) => (
                <tr key={item.lead.id}>
                  <td>
                    <Link href={`/leads/${encodeURIComponent(item.lead.id)}`}>
                      {item.lead.opportunityName}
                    </Link>
                    <div className="bea-muted-line">
                      <span className="bea-code">{item.lead.reference}</span>
                    </div>
                  </td>
                  <td>
                    <Badge tone={leadStatusTone(item.lead.status)}>
                      {leadStatusLabel(item.lead.status)}
                    </Badge>
                  </td>
                  <td>{leadSourceLabel(item.lead.sourceType)}</td>
                  <td>
                    <time dateTime={item.lead.receivedAt}>
                      {formatDateTime(item.lead.receivedAt)}
                    </time>
                  </td>
                  <td>{leadQueuePrimaryLabel(item)}</td>
                  <td>{item.reviewerDisplayName ?? "Unassigned"}</td>
                  <td>
                    <Badge tone={leadReadinessTone(item.readiness.readyForProposal)}>
                      {item.readiness.readyForProposal
                        ? "Review-ready"
                        : `${item.readiness.blocking.length} blocking`}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFoundation>
      ) : (
        <EmptyState
          title="No leads found"
          description="No lead records match the current filters. Authorized staff can create a manual, referral, or in-person intake record."
        />
      )}
    </div>
  );
}
