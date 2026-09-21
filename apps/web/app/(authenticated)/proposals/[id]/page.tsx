import { getServerRuntime } from "@bea/database";
import {
  COMMERCIAL_PRODUCTION_UNCONFIGURED,
  COMMERCIAL_SYNTHETIC_DISCLOSURE,
  PROPOSAL_ACCEPTANCE_NON_EXECUTABLE,
  PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE,
  compareProposalVersions,
} from "@bea/domain";
import { PERMISSIONS } from "@bea/security";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Link,
  PageHeader,
  Table,
  TableFoundation,
} from "@bea/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ProposalBuilderForm } from "@/components/proposal-builder-form";
import { ProposalCommandActions } from "@/components/proposal-command-actions";
import {
  SyntheticFixtureBadge,
  SyntheticFixtureBanner,
} from "@/components/synthetic-fixture-banner";
import { requirePermission } from "@/lib/auth/authorization";
import {
  formatProposalMoney,
  previewKindLabel,
  proposalNextAction,
  proposalStatusLabel,
  proposalStatusTone,
} from "@/lib/commercial-presentation";
import { formatDateTime, safeText } from "@/lib/phase1-presentation";

export const metadata: Metadata = { title: "Proposal command record" };
export const dynamic = "force-dynamic";

export default async function ProposalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission(PERMISSIONS.PROPOSALS_VIEW, "proposal-detail");
  const runtime = await getServerRuntime();
  if (runtime.environment.appMode === "demo") {
    await runtime.workControl.processPendingEvents();
  }
  const { id } = await params;
  let inspected: Awaited<ReturnType<typeof runtime.commercial.inspectProposal>>;
  try {
    inspected = await runtime.commercial.inspectProposal(id);
  } catch {
    notFound();
  }
  const { record, readiness, pricing } = inspected;
  const [
    editDecision,
    submitDecision,
    approveDecision,
    overrideRequestDecision,
    overrideApproveDecision,
    deliveryDecision,
    cancelDecision,
  ] = await Promise.all([
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.PROPOSALS_EDIT),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.PROPOSALS_SUBMIT),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.PROPOSALS_APPROVE),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.PROPOSALS_OVERRIDE_REQUEST),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.PROPOSALS_OVERRIDE_APPROVE),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.PROPOSALS_DELIVERY_PLAN),
    runtime.authorization.authorizeUser(session.personaId, PERMISSIONS.PROPOSALS_CANCEL),
  ]);
  const items = record.catalogVersion
    ? await runtime.commercial.repository.listCatalogItems(record.catalogVersion.id)
    : [];
  const workItems = await runtime.workControl.repository.listWorkItems({
    proposalId: record.proposal.id,
    limit: 50,
  });
  const [audit, statusEvents] = await Promise.all([
    runtime.commercial.repository.listAudit(record.proposal.id),
    runtime.commercial.repository.listStatusEvents(record.proposal.id),
  ]);
  const currentVersion =
    record.versions.find((item) => item.versionNumber === record.proposal.currentVersionNumber) ??
    null;
  const previousVersion = record.versions.at(-2) ?? null;
  const comparison =
    currentVersion && previousVersion
      ? compareProposalVersions(previousVersion, currentVersion)
      : null;
  const mutable =
    record.proposal.status === "draft" ||
    record.proposal.status === "needs_information" ||
    record.proposal.status === "ready_for_review" ||
    record.proposal.status === "revision_required";
  const preview = await runtime.commercial.previewDocument({
    proposalId: record.proposal.id,
    ...(currentVersion ? { proposalVersionId: currentVersion.id } : {}),
  });
  const snapshot = record.proposal.leadSnapshot;

  return (
    <div className="bea-stack bea-stack--large" data-testid="proposal-detail">
      <PageHeader
        eyebrow="Proposal command record"
        title={record.proposal.reference}
        description={`${record.proposal.opportunityName} · ${COMMERCIAL_SYNTHETIC_DISCLOSURE}`}
        actions={
          <div className="bea-cluster">
            <Badge tone={proposalStatusTone(record.proposal.status)}>
              {proposalStatusLabel(record.proposal.status)}
            </Badge>
            <SyntheticFixtureBadge synthetic />
          </div>
        }
      />
      <SyntheticFixtureBanner synthetic />
      <p className="bea-muted" data-testid="synthetic-disclosure">
        {COMMERCIAL_SYNTHETIC_DISCLOSURE} {COMMERCIAL_PRODUCTION_UNCONFIGURED}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Identity and next action</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="bea-meta-list">
            <div>
              <dt>Lead</dt>
              <dd>
                <Link href={`/leads/${record.proposal.leadId}`}>
                  {snapshot?.leadReference ?? record.proposal.leadId}
                </Link>
              </dd>
            </div>
            <div>
              <dt>Catalog</dt>
              <dd>
                {record.catalogVersion?.catalogKey} v{record.catalogVersion?.versionNumber}
              </dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>{record.proposal.currency}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd data-testid="proposal-total">
                {formatProposalMoney(record.proposal.totalMinor, record.proposal.currency)}
              </dd>
            </div>
            <div>
              <dt>Current version</dt>
              <dd>{record.proposal.currentVersionNumber || "Mutable draft"}</dd>
            </div>
            <div>
              <dt>Next action</dt>
              <dd data-testid="proposal-next-action">
                {proposalNextAction({
                  status: record.proposal.status,
                  readiness,
                  openOverrideCount: record.overrides.filter((item) => item.status === "requested")
                    .length,
                })}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Lead and party snapshot</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="bea-field-message">
            Later Lead edits do not rewrite a frozen proposal version. Refreshing a draft requires
            an explicit command.
          </p>
          <dl className="bea-meta-list">
            <div>
              <dt>Opportunity</dt>
              <dd>{safeText(snapshot?.opportunityName ?? record.proposal.opportunityName)}</dd>
            </div>
            <div>
              <dt>Request summary</dt>
              <dd className="bea-preserve-lines">{safeText(snapshot?.requestSummary ?? null)}</dd>
            </div>
            <div>
              <dt>Requested service</dt>
              <dd>{safeText(snapshot?.requestedService ?? null)}</dd>
            </div>
          </dl>
          <TableFoundation>
            <Table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Name</th>
                </tr>
              </thead>
              <tbody>
                {(snapshot?.parties ?? []).map((party) => (
                  <tr key={`${party.role}-${party.displayName}`}>
                    <td>{party.role}</td>
                    <td>{party.displayName}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Readiness</CardTitle>
        </CardHeader>
        <CardContent data-testid="proposal-readiness">
          {readiness.blocking.length ? (
            <ul>
              {readiness.blocking.map((item) => (
                <li key={item.code}>
                  <Badge tone="warning">{item.origin}</Badge> {item.message}
                </li>
              ))}
            </ul>
          ) : (
            <p>No blocking commercial readiness items.</p>
          )}
          {readiness.warnings.map((item) => (
            <p key={item.code} className="bea-muted">
              Warning ({item.origin}): {item.message}
            </p>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Pricing snapshot</CardTitle>
        </CardHeader>
        <CardContent>
          <TableFoundation>
            <Table data-testid="proposal-lines">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Model</th>
                  <th>Catalog amount</th>
                  <th>Unit amount</th>
                  <th>Quantity</th>
                  <th>Line total</th>
                </tr>
              </thead>
              <tbody>
                {pricing.lines.map((line) => (
                  <tr key={line.lineKey}>
                    <td>{line.displayName}</td>
                    <td>{line.pricingModel}</td>
                    <td>{formatProposalMoney(line.catalogUnitAmountMinor, line.currency)}</td>
                    <td>{formatProposalMoney(line.unitAmountMinor, line.currency)}</td>
                    <td>{line.quantityScaled / 10_000}</td>
                    <td>{formatProposalMoney(line.lineSubtotalMinor, line.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFoundation>
          <p>
            Subtotal {formatProposalMoney(pricing.subtotalMinor, pricing.currency)} · Allowance{" "}
            {formatProposalMoney(pricing.allowanceMinor, pricing.currency)} · Reimbursable{" "}
            {formatProposalMoney(pricing.reimbursableMinor, pricing.currency)} · Tax unconfigured ·
            Total {formatProposalMoney(pricing.totalMinor, pricing.currency)}
          </p>
        </CardContent>
      </Card>
      {mutable ? (
        <Card>
          <CardHeader>
            <CardTitle>Proposal builder</CardTitle>
          </CardHeader>
          <CardContent>
            <ProposalBuilderForm
              proposal={record.proposal}
              lines={record.lines}
              items={items}
              canEdit={editDecision.allowed}
            />
          </CardContent>
        </Card>
      ) : (
        <p className="bea-muted">Approved or in-review content cannot be edited in place.</p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Review, override, and delivery</CardTitle>
        </CardHeader>
        <CardContent>
          <ProposalCommandActions
            proposal={record.proposal}
            currentVersion={currentVersion}
            overrides={record.overrides}
            canEdit={editDecision.allowed}
            canSubmit={submitDecision.allowed}
            canApprove={approveDecision.allowed}
            canOverride={overrideRequestDecision.allowed}
            canDecideOverride={overrideApproveDecision.allowed}
            canDelivery={deliveryDecision.allowed}
            canCancel={cancelDecision.allowed}
          />
        </CardContent>
      </Card>
      {record.overrides.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Pricing overrides</CardTitle>
          </CardHeader>
          <CardContent data-testid="proposal-overrides">
            <TableFoundation>
              <Table>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Original</th>
                    <th>Proposed</th>
                    <th>Reason</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {record.overrides.map((item) => (
                    <tr key={item.id}>
                      <td>{item.lineKey}</td>
                      <td>
                        {formatProposalMoney(item.originalAmountMinor, record.proposal.currency)}
                      </td>
                      <td>
                        {formatProposalMoney(item.proposedAmountMinor, record.proposal.currency)}
                      </td>
                      <td>{item.reason}</td>
                      <td>{item.status}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFoundation>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
        </CardHeader>
        <CardContent data-testid="proposal-versions">
          {record.versions.length ? (
            <ol>
              {record.versions.map((version) => (
                <li key={version.id}>
                  Version {version.versionNumber} · {version.status} ·{" "}
                  {formatProposalMoney(version.totalMinor, version.currency)} · checksum{" "}
                  {version.renderedChecksum ?? "n/a"}
                </li>
              ))}
            </ol>
          ) : (
            <p>No frozen versions yet. Saving a draft does not freeze a version.</p>
          )}
          {comparison ? (
            <p data-testid="proposal-version-compare">
              Changed from previous version: {comparison.changed.join(", ") || "none"}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Document preview · {previewKindLabel(preview.previewKind)}</CardTitle>
        </CardHeader>
        <CardContent data-testid="proposal-document-preview">
          {preview.document.nodes.map((node, index) => (
            <p key={`${node.kind}-${index}`}>{node.title ?? node.text}</p>
          ))}
          <p className="bea-muted">Checksum {preview.pdf.checksumSha256}</p>
          <p>{PROPOSAL_ACCEPTANCE_NON_EXECUTABLE}</p>
        </CardContent>
      </Card>
      {record.manifests.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Delivery dry-run</CardTitle>
          </CardHeader>
          <CardContent data-testid="delivery-manifest-result">
            {record.manifests.map((manifest) => (
              <dl key={manifest.id} className="bea-meta-list">
                <div>
                  <dt>Disclosure</dt>
                  <dd data-testid="proposal-no-send">{PROPOSAL_EMAIL_DRY_RUN_DISCLOSURE}</dd>
                </div>
                <div>
                  <dt>To</dt>
                  <dd>{manifest.toRecipient}</dd>
                </div>
                <div>
                  <dt>Subject</dt>
                  <dd>{manifest.subject}</dd>
                </div>
                <div>
                  <dt>liveWrites</dt>
                  <dd>{String(manifest.liveWrites)}</dd>
                </div>
                <div>
                  <dt>Attachment</dt>
                  <dd>
                    {manifest.attachmentFileName} · {manifest.attachmentChecksum}
                  </dd>
                </div>
              </dl>
            ))}
            <p>
              Generating this manifest does not send a message and does not mean the proposal was
              sent.
            </p>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Current work</CardTitle>
        </CardHeader>
        <CardContent>
          {workItems.length ? (
            <ul>
              {workItems.map((item) => (
                <li key={item.id}>
                  {item.reference} · {item.title} · {item.status}
                </li>
              ))}
            </ul>
          ) : (
            <p>No open proposal work items.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Audit and activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="bea-timeline">
            {statusEvents.map((event) => (
              <li key={String(event.id)}>
                <time dateTime={String(event.created_at)}>
                  {formatDateTime(String(event.created_at))}
                </time>
                <strong>{String(event.event_type)}</strong>
              </li>
            ))}
            {audit.map((event) => (
              <li key={String(event.id)}>
                <time dateTime={String(event.created_at)}>
                  {formatDateTime(String(event.created_at))}
                </time>
                <strong>{String(event.action)}</strong>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
