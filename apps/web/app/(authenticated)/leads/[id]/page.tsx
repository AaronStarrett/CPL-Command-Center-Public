import { getServerRuntime } from "@bea/database";
import { LEAD_PARTY_ROLES, catalogContextKeyForLead } from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Link,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CreateProposalButton } from "@/components/create-proposal-button";
import { LeadReviewActions } from "@/components/lead-review-actions";
import { TaskCreateForm } from "@/components/task-create-form";
import { requirePermission } from "@/lib/auth/authorization";
import {
  leadPartyDisplayName,
  leadPartyRoleLabel,
  leadReadinessTone,
  leadSourceLabel,
  leadStatusLabel,
  leadStatusTone,
} from "@/lib/lead-presentation";
import {
  formatProposalMoney,
  proposalStatusLabel,
  proposalStatusTone,
} from "@/lib/commercial-presentation";
import { displayContactName, formatDateTime, safeText } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Lead Command Record" };
export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission(PERMISSIONS.LEADS_VIEW, "lead-detail");
  const runtime = await getServerRuntime();
  if (runtime.environment.appMode === "demo") {
    await runtime.workControl.processPendingEvents();
  }
  const { id } = await params;
  const record = await runtime.leads.getLead(id);
  if (!record) notFound();
  const [
    manageDecision,
    reviewDecision,
    disqualifyDecision,
    companyDecision,
    contactDecision,
    taskDecision,
    taskManageDecision,
    taskReadScope,
    activityDecision,
    createProposalDecision,
    reviewers,
  ] = await Promise.all([
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.LEADS_MANAGE),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.LEADS_REVIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.LEADS_DISQUALIFY),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.COMPANIES_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.CONTACTS_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.TASKS_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.TASKS_MANAGE),
    runtime.authorization.taskReadScopeForUser(session.personaId),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.ACTIVITIES_VIEW),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.PROPOSALS_CREATE),
    runtime.leads.listReviewerCandidates(),
  ]);
  const [companies, contacts, tasks, activities, linkedProposals, catalogVersions] =
    await Promise.all([
      companyDecision.allowed ? runtime.phase1.listCompanies({ limit: 250 }) : Promise.resolve([]),
      contactDecision.allowed ? runtime.phase1.listContacts({ limit: 250 }) : Promise.resolve([]),
      taskDecision.allowed
        ? runtime.phase1.listTasks({
            leadId: record.lead.id,
            limit: 100,
            ...(taskReadScope !== "all" ? { assigneeUserId: session.personaId } : {}),
          })
        : Promise.resolve([]),
      activityDecision.allowed
        ? runtime.phase1.listActivities({ leadId: record.lead.id, limit: 50 })
        : Promise.resolve(record.activities),
      runtime.commercial.repository.listProposalsForLead(record.lead.id),
      runtime.commercial.repository.listCatalogVersions(),
    ]);
  const companyNames = new Map(companies.map((company) => [company.id, company.name]));
  const contactNames = new Map(
    contacts.map((contact) => [contact.id, displayContactName(contact)]),
  );
  const reviewer =
    reviewers.find((candidate) => candidate.id === record.lead.reviewerUserId) ?? null;
  const site = [
    record.lead.siteName,
    record.lead.siteAddressLine1,
    record.lead.siteAddressLine2,
    [record.lead.siteCity, record.lead.siteRegion, record.lead.sitePostalCode]
      .filter(Boolean)
      .join(", "),
    record.lead.siteCountry,
  ]
    .filter((value) => value?.trim())
    .join("\n");
  const activeCatalogs = catalogVersions.filter(
    (item) => item.synthetic && item.status === "active",
  );
  const mappedContext = catalogContextKeyForLead({
    requestedService: record.lead.requestedService,
    opportunityName: record.lead.opportunityName,
  });
  const mappedCatalogs = mappedContext
    ? activeCatalogs.filter((item) => item.serviceContextKey === mappedContext)
    : [];
  const defaultCatalogVersionId = mappedCatalogs.length === 1 ? mappedCatalogs[0]!.id : "";

  return (
    <div className="bea-stack bea-stack--large">
      <PageHeader
        eyebrow="Lead command record"
        title={record.lead.opportunityName}
        description={`${record.lead.reference} · ${leadSourceLabel(record.lead.sourceType)}`}
        actions={
          <div className="bea-cluster">
            <Badge tone={leadStatusTone(record.lead.status)}>
              {leadStatusLabel(record.lead.status)}
            </Badge>
            <Badge tone={leadReadinessTone(record.readiness.readyForProposal)}>
              {record.readiness.readyForProposal ? "Review-ready" : "Missing information"}
            </Badge>
          </div>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Lead summary</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>Reference</dt>
              <dd>
                <span className="bea-code">{record.lead.reference}</span>
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{leadSourceLabel(record.lead.sourceType)}</dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd>{formatDateTime(record.lead.receivedAt)}</dd>
            </div>
            <div>
              <dt>Reviewer</dt>
              <dd>{reviewer?.displayName ?? "Unassigned"}</dd>
            </div>
            <div>
              <dt>Requested service</dt>
              <dd>{safeText(record.lead.requestedService)}</dd>
            </div>
            <div>
              <dt>Desired deadline</dt>
              <dd>{formatDateTime(record.lead.desiredDeadlineAt)}</dd>
            </div>
            <div>
              <dt>Requested visit</dt>
              <dd>{formatDateTime(record.lead.requestedVisitAt)}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{record.lead.version}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Request and source</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>Request summary</dt>
              <dd className="bea-preserve-lines">{safeText(record.lead.requestSummary)}</dd>
            </div>
            <div>
              <dt>Source details</dt>
              <dd className="bea-preserve-lines">{safeText(record.lead.sourceDetails)}</dd>
            </div>
            <div>
              <dt>Site / project location</dt>
              <dd className="bea-preserve-lines">{safeText(site || null)}</dd>
            </div>
            {record.lead.disqualificationReason ? (
              <div>
                <dt>Disqualification reason</dt>
                <dd className="bea-preserve-lines">{record.lead.disqualificationReason}</dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Companies, contacts, and business roles</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="bea-field-message">
            Requester, client company, approval authority, and billing contact are separate roles.
            Incomplete intake is allowed.
          </p>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Identity</th>
                  <th scope="col">Linked records</th>
                </tr>
              </thead>
              <tbody>
                {LEAD_PARTY_ROLES.map((role) => {
                  const party = record.parties.find((entry) => entry.role === role);
                  return (
                    <tr key={role}>
                      <td>{leadPartyRoleLabel(role)}</td>
                      <td>
                        {party
                          ? leadPartyDisplayName(party, {
                              companyName: party.companyId
                                ? (companyNames.get(party.companyId) ?? null)
                                : null,
                              contactName: party.contactId
                                ? (contactNames.get(party.contactId) ?? null)
                                : null,
                            })
                          : "Not identified"}
                      </td>
                      <td>
                        {party?.companyId && companyNames.get(party.companyId) ? (
                          <Link href={`/companies/${encodeURIComponent(party.companyId)}`}>
                            {companyNames.get(party.companyId)}
                          </Link>
                        ) : null}
                        {party?.contactId && contactNames.get(party.contactId) ? (
                          <>
                            {party.companyId ? " · " : null}
                            <Link href={`/contacts/${encodeURIComponent(party.contactId)}`}>
                              {contactNames.get(party.contactId)}
                            </Link>
                          </>
                        ) : null}
                        {!party?.companyId && !party?.contactId ? "—" : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className="bea-record-heading">
            <CardTitle>Missing information and readiness</CardTitle>
            <Badge tone={leadReadinessTone(record.readiness.readyForProposal)}>
              {record.readiness.readyForProposal
                ? "Enough information for proposal work"
                : "Not review-ready"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="bea-field-message">
            This checklist is a deterministic review-readiness evaluator. It is not commercial
            authorization, billing approval, scheduling, or project conversion.
          </p>
          {record.readiness.blocking.length ? (
            <ul className="bea-lead-missing-list">
              {record.readiness.blocking.map((item) => (
                <li key={item.code}>
                  <Badge tone="warning">Blocking</Badge> {item.message}
                </li>
              ))}
            </ul>
          ) : (
            <p>No blocking intake information is missing.</p>
          )}
          {record.readiness.optional.length ? (
            <ul className="bea-lead-missing-list">
              {record.readiness.optional.map((item) => (
                <li key={item.code}>
                  <Badge>Optional</Badge> {item.message}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className="bea-record-heading">
            <CardTitle>Review actions</CardTitle>
            {record.lead.status === "ready_for_proposal" ? (
              <Badge tone="success">Ready for proposal</Badge>
            ) : (
              <Badge>Proposal creation blocked until ready_for_proposal</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <LeadReviewActions
            lead={record.lead}
            readiness={record.readiness}
            canReview={reviewDecision.allowed}
            canDisqualify={disqualifyDecision.allowed}
            canManage={manageDecision.allowed}
          />
          {createProposalDecision.allowed && record.lead.status === "ready_for_proposal" ? (
            <CreateProposalButton
              leadId={record.lead.id}
              catalogs={activeCatalogs}
              defaultCatalogVersionId={defaultCatalogVersionId}
            />
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Linked proposals</CardTitle>
        </CardHeader>
        <CardContent>
          {linkedProposals.length ? (
            <TableFoundation>
              <Table data-testid="lead-linked-proposals">
                <thead>
                  <tr>
                    <th>Proposal</th>
                    <th>Status</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {linkedProposals.map((proposal) => (
                    <tr key={proposal.id}>
                      <td>
                        <Link href={`/proposals/${proposal.id}`}>{proposal.reference}</Link>
                      </td>
                      <td>
                        <Badge tone={proposalStatusTone(proposal.status)}>
                          {proposalStatusLabel(proposal.status)}
                        </Badge>
                      </td>
                      <td>{formatProposalMoney(proposal.totalMinor, proposal.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFoundation>
          ) : (
            <p>No proposals are linked to this lead.</p>
          )}
        </CardContent>
      </Card>
      {taskDecision.allowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Follow-up tasks</CardTitle>
          </CardHeader>
          <CardContent>
            {tasks.length ? (
              <TableFoundation>
                <Table>
                  <thead>
                    <tr>
                      <th scope="col">Task</th>
                      <th scope="col">Priority</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <Link href={`/tasks/${encodeURIComponent(task.id)}`}>{task.title}</Link>
                        </td>
                        <td>
                          <Badge>{task.priority}</Badge>
                        </td>
                        <td>
                          <Badge>{task.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableFoundation>
            ) : (
              <EmptyState
                title="No follow-up tasks"
                description="No tasks are linked to this lead yet."
              />
            )}
            {taskManageDecision.allowed ? (
              <div className="bea-lead-follow-up">
                <h3>Create a follow-up task</h3>
                <TaskCreateForm
                  companies={companies.map((company) => ({ id: company.id, label: company.name }))}
                  contactsEnabled={companyDecision.allowed && contactDecision.allowed}
                  leadId={record.lead.id}
                  defaultTitle={`Follow up: ${record.lead.reference}`}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {activityDecision.allowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Activity history</CardTitle>
          </CardHeader>
          <CardContent>
            {activities.length ? (
              <ol className="bea-timeline">
                {activities.map((activity) => (
                  <li key={activity.id}>
                    <time dateTime={activity.createdAt}>{formatDateTime(activity.createdAt)}</time>
                    <strong>{activity.summary}</strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No activity is linked to this lead.</p>
            )}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Status history</CardTitle>
        </CardHeader>
        <CardContent>
          {record.statusEvents.length ? (
            <ol className="bea-timeline">
              {record.statusEvents.map((event) => (
                <li key={event.id}>
                  <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                  <strong>
                    {event.fromStatus
                      ? `${leadStatusLabel(event.fromStatus)} → ${leadStatusLabel(event.toStatus)}`
                      : `Opened as ${leadStatusLabel(event.toStatus)}`}
                  </strong>
                  {event.reason ? <p>{event.reason}</p> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p>No status events are recorded.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
