"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CommercialRequest } from "./commercial-ui";
import { LeadConfigurationFields } from "./lead-configuration";
import { useUnsavedNavigation } from "./commercial-navigation";
import type {
  CplWorkflowLead,
  CplProposalDraft,
  CplIntakeDirectory,
  CplWorkflowPermissions,
} from "@bea/database/hosted";
import styles from "./workspace.module.css";

export type IntakePermissions = CplWorkflowPermissions;
export type IntakeDirectory = CplIntakeDirectory;
export type LeadInput = Record<string, unknown>;
type Props = {
  leads: CplWorkflowLead[];
  proposals: CplProposalDraft[];
  directory: IntakeDirectory;
  permissions: IntakePermissions;
  selectedId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onSave: (input: LeadInput, id?: string) => Promise<CplWorkflowLead | null>;
  onEvidence: (id: string, input: LeadInput) => Promise<CplWorkflowLead | null>;
  onDirectory: (input: LeadInput) => Promise<boolean>;
  onProposal: (lead: CplWorkflowLead, proposalId?: string) => void;
  onDirty?: (dirty: boolean) => void;
  request?: CommercialRequest;
};
const statuses = {
  new: "New inquiry",
  needs_info: "Needs information",
  ready_for_proposal: "Ready for proposal",
  disqualified: "Disqualified",
} as const;
const sources = {
  manual: "Manual entry",
  phone: "Phone call",
  referral: "Referral",
  in_person: "In person",
  website_form: "Website form",
  email: "Email",
  crm_import: "CRM import",
} as const;
function needsAttention(lead: CplWorkflowLead) {
  return (
    lead.status !== "disqualified" &&
    (lead.status !== "ready_for_proposal" || !lead.readiness.readyForProposal)
  );
}
function duplicateReason(reason: string) {
  const labels: Record<string, string> = {
    same_contact_email: "Same contact email",
    same_contact_phone: "Same contact phone",
    same_customer_and_title: "Same customer and inquiry title",
    same_site_and_title: "Same site and inquiry title",
  };
  return labels[reason] ?? reason;
}
function dateInput(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function timestamp(value: FormDataEntryValue | null) {
  return value ? new Date(String(value)).toISOString() : null;
}
function LeadForm({
  lead,
  latest,
  directory,
  disabled,
  busy,
  onSave,
  request,
}: {
  lead?: CplWorkflowLead;
  latest?: CplWorkflowLead;
  directory: IntakeDirectory;
  disabled: boolean;
  busy: boolean;
  onSave: Props["onSave"];
  request?: CommercialRequest;
}) {
  const [saved, setSaved] = useState(lead);
  const [revision, setRevision] = useState(0);
  const [customerId, setCustomerId] = useState(lead?.customerId ?? "");
  const [configurationInput, setConfigurationInput] = useState<Record<string, unknown>>({});
  const serviceField = useRef<HTMLInputElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const input: LeadInput = {};
    for (const key of [
      "title",
      "contactName",
      "contactEmail",
      "contactPhone",
      "customerName",
      "siteName",
      "siteAddress",
      "requestedService",
      "details",
      "nextAction",
      "notes",
      "sourceType",
    ]) {
      input[key] = String(fields.get(key) ?? "");
    }
    input.contactEmail ||= null;
    for (const key of ["customerId", "contactId", "siteId", "assignedMemberIdentityId"])
      input[key] = fields.get(key) ? String(fields.get(key)) : null;
    for (const key of ["receivedAt", "requestedDeadlineAt", "requestedVisitAt"] as const) {
      const entry = fields.get(key);
      // Do not round the original timestamp merely because another field changed.
      input[key] = saved && entry === dateInput(saved[key]) ? saved[key] : timestamp(entry);
    }
    if (!input.receivedAt) delete input.receivedAt;
    if (saved) input.expectedVersion = saved.version;
    Object.assign(input, configurationInput);
    const result = await onSave(input, saved?.id);
    if (result) {
      setSaved(result);
      setCustomerId(result.customerId ?? "");
      setRevision((value) => value + 1);
      setConfigurationInput({});
    }
  }
  const field = (
    label: string,
    name: string,
    value: string | null | undefined,
    options: { required?: boolean; type?: string; maxLength?: number } = {},
  ) => (
    <label className={styles.field}>
      {label}
      <input
        ref={name === "requestedService" ? serviceField : undefined}
        name={name}
        defaultValue={value ?? ""}
        maxLength={options.maxLength ?? 160}
        {...options}
      />
    </label>
  );
  return (
    <section className={styles.panel} aria-label={saved ? "Lead information" : "New lead"}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>
            {saved
              ? `SAVED RECORD · VERSION ${latest?.version ?? saved.version}`
              : "CAPTURE AN INQUIRY"}
          </p>
          <h2>{saved ? "Lead information" : "New lead"}</h2>
        </div>
        {disabled ? <span className={styles.badge}>Read only</span> : null}
      </div>
      <p className={styles.muted}>
        Capture what is known. Missing information stays visible for review.
      </p>
      {saved && latest && latest.version !== saved.version ? (
        <div className={styles.warning}>
          <p>
            A newer saved version is available. Your current entries have been kept; saving will
            still check version {saved.version}.
          </p>
          <button
            className={styles.secondary}
            disabled={busy}
            onClick={() => {
              setSaved(latest);
              setCustomerId(latest.customerId ?? "");
              setRevision((value) => value + 1);
            }}
          >
            Discard edits and load latest
          </button>
        </div>
      ) : null}
      <form key={revision} className={styles.form} onSubmit={(event) => void submit(event)}>
        <fieldset disabled={disabled || busy} className={styles.fieldset}>
          {field("Lead title", "title", saved?.title, { required: true, maxLength: 180 })}
          <div className={styles.fieldPair}>
            <label className={styles.field}>
              Inquiry source
              <select name="sourceType" defaultValue={saved?.sourceType ?? "manual"}>
                {Object.entries(sources).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {field("Received at", "receivedAt", dateInput(saved?.receivedAt), {
              type: "datetime-local",
            })}
          </div>
          <p className={styles.meta}>
            Source labels describe how the inquiry arrived. They do not connect an inbox, website or
            CRM.
          </p>
          <h3>Customer &amp; contact</h3>
          <label className={styles.field}>
            Customer record
            <select
              name="customerId"
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
            >
              <option value="">Use entered customer name</option>
              {directory.customers.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {field("Customer name", "customerName", saved?.customerName)}
          <label className={styles.field}>
            Contact record
            <select
              key={`contact-${customerId}`}
              name="contactId"
              defaultValue={
                customerId === (saved?.customerId ?? "") ? (saved?.contactId ?? "") : ""
              }
            >
              <option value="">Use entered contact details</option>
              {directory.contacts
                .filter((item) => !customerId || item.customerId === customerId)
                .map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          {field("Contact name", "contactName", saved?.contactName)}
          <div className={styles.fieldPair}>
            {field("Contact email (optional)", "contactEmail", saved?.contactEmail, {
              type: "email",
              maxLength: 254,
            })}
            {field("Contact phone", "contactPhone", saved?.contactPhone, {
              type: "tel",
              maxLength: 80,
            })}
          </div>
          <h3>Site &amp; request</h3>
          <label className={styles.field}>
            Site record
            <select
              key={`site-${customerId}`}
              name="siteId"
              defaultValue={customerId === (saved?.customerId ?? "") ? (saved?.siteId ?? "") : ""}
            >
              <option value="">Use entered site details</option>
              {directory.sites
                .filter((item) => !customerId || item.customerId === customerId)
                .map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <div className={styles.fieldPair}>
            {field("Site name", "siteName", saved?.siteName)}
            {field("Site address", "siteAddress", saved?.siteAddress, { maxLength: 1000 })}
          </div>
          {field("Requested service", "requestedService", saved?.requestedService, {
            maxLength: 500,
          })}
          {request ? (
            <LeadConfigurationFields
              key={revision}
              request={request}
              configuration={saved?.configuration}
              saved={!!saved}
              onChange={(patch) => setConfigurationInput((old) => ({ ...old, ...patch }))}
              onService={(value) => {
                if (serviceField.current) serviceField.current.value = value;
              }}
            />
          ) : null}
          <label className={styles.field}>
            Request details
            <textarea
              name="details"
              defaultValue={saved?.details ?? ""}
              maxLength={10000}
              rows={5}
              placeholder="Paste or record the request as received. The original capture is preserved as source evidence."
            />
          </label>
          <div className={styles.fieldPair}>
            {field(
              "Requested deadline",
              "requestedDeadlineAt",
              dateInput(saved?.requestedDeadlineAt),
              { type: "datetime-local" },
            )}
            {field("Requested visit", "requestedVisitAt", dateInput(saved?.requestedVisitAt), {
              type: "datetime-local",
            })}
          </div>
          <p className={styles.meta}>
            Dates are requests in your local time, not confirmed appointments.
          </p>
          <h3>Responsibility &amp; next action</h3>
          <label className={styles.field}>
            Assigned member
            <select
              name="assignedMemberIdentityId"
              defaultValue={saved?.assignedMemberIdentityId ?? ""}
            >
              <option value="">Unassigned</option>
              {directory.members.map((item) => (
                <option key={item.identityId} value={item.identityId}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
          {field("Next action", "nextAction", saved?.nextAction, { maxLength: 1000 })}
          <label className={styles.field}>
            Internal notes
            <textarea name="notes" defaultValue={saved?.notes ?? ""} maxLength={10000} rows={3} />
          </label>
        </fieldset>
        <button className={styles.primary} disabled={busy || disabled} type="submit">
          {saved ? "Save lead changes" : "Save lead"}
        </button>
      </form>
    </section>
  );
}

function LeadReview({
  lead,
  canReview,
  busy,
  onSave,
  onSelect,
}: {
  lead: CplWorkflowLead;
  canReview: boolean;
  busy: boolean;
  onSave: Props["onSave"];
  onSelect: Props["onSelect"];
}) {
  const [version, setVersion] = useState(lead.version);
  const [status, setStatus] = useState(lead.status);
  const [disposition, setDisposition] = useState(lead.duplicateReview.disposition);
  const [revision, setRevision] = useState(0);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canReview || busy) return;
    const fields = new FormData(event.currentTarget);
    const result = await onSave(
      {
        expectedVersion: version,
        status,
        disqualificationReason: String(fields.get("disqualificationReason") ?? "") || null,
        duplicateDisposition: disposition,
        duplicateReason: String(fields.get("duplicateReason") ?? "") || null,
        duplicateLeadId: String(fields.get("duplicateLeadId") ?? "") || null,
      },
      lead.id,
    );
    if (result) setVersion(result.version);
  }
  return (
    <section id="lead-review" className={styles.panel} aria-label="Lead review">
      <p className={styles.eyebrow}>REVIEW &amp; NEXT STEP</p>
      <h2>{statuses[lead.status]}</h2>
      <div className={lead.readiness.readyForProposal ? styles.ready : styles.warning}>
        <strong>
          {lead.readiness.readyForProposal
            ? "Information ready for a proposal"
            : "Information needs review"}
        </strong>
        {lead.readiness.missingInformation.length ? (
          <ul className={styles.issueList}>
            {lead.readiness.missingInformation.map((item) => (
              <li key={item.code}>
                <span className={styles.issueLabel}>
                  {item.severity === "blocking" ? "Required" : "Optional"}
                </span>
                {item.message}
              </li>
            ))}
          </ul>
        ) : null}
        {lead.readiness.conflicts.length ? (
          <ul className={styles.issueList}>
            {lead.readiness.conflicts.map((item) => (
              <li key={item.code}>
                <strong>Conflict: </strong>
                {item.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {lead.duplicateCandidates.length ? (
        <div className={styles.detail}>
          <h3>Possible duplicates</h3>
          <p className={styles.meta}>
            Suggested matches need a person’s review. Records are never merged automatically.
          </p>
          <ul className={styles.list}>
            {lead.duplicateCandidates.map((item) => (
              <li key={item.leadId}>
                <button
                  className={styles.textButton}
                  disabled={busy}
                  onClick={() => onSelect(item.leadId)}
                >
                  {item.title}
                </button>
                <p className={styles.meta}>{item.reasons.map(duplicateReason).join(" · ")}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form key={revision} className={styles.form} onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy || !canReview} className={styles.fieldset}>
          <label className={styles.field}>
            Lead status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              {Object.entries(statuses).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {status === "disqualified" ? (
            <label className={styles.field}>
              Disqualification reason
              <textarea
                name="disqualificationReason"
                required
                maxLength={2000}
                defaultValue={lead.disqualificationReason ?? ""}
              />
            </label>
          ) : null}
          <label className={styles.field}>
            Duplicate review
            <select
              value={disposition}
              onChange={(event) => setDisposition(event.target.value as typeof disposition)}
            >
              <option value="unreviewed">Not reviewed</option>
              <option value="distinct">Reviewed — separate inquiry</option>
              <option value="duplicate">Reviewed — duplicate inquiry</option>
            </select>
          </label>
          {disposition !== "unreviewed" ? (
            <label className={styles.field}>
              Duplicate review reason
              <textarea
                name="duplicateReason"
                required
                maxLength={2000}
                defaultValue={lead.duplicateReview.reason ?? ""}
              />
            </label>
          ) : null}
          {disposition === "duplicate" ? (
            <label className={styles.field}>
              Related lead
              <select
                name="duplicateLeadId"
                required
                defaultValue={lead.duplicateReview.relatedLeadId ?? ""}
              >
                <option value="">Choose related lead</option>
                {lead.duplicateCandidates.map((item) => (
                  <option key={item.leadId} value={item.leadId}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </fieldset>
        {canReview ? (
          <>
            <button
              className={styles.secondary}
              disabled={busy || version !== lead.version}
              type="submit"
            >
              Save review
            </button>
            {version !== lead.version ? (
              <p className={styles.meta}>
                This review started on an older version.{" "}
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={busy}
                  onClick={() => {
                    setVersion(lead.version);
                    setStatus(lead.status);
                    setDisposition(lead.duplicateReview.disposition);
                    setRevision((value) => value + 1);
                  }}
                >
                  Reload saved review
                </button>
              </p>
            ) : null}
          </>
        ) : (
          <p className={styles.meta}>
            A reviewer can change status and resolve duplicate concerns.
          </p>
        )}
      </form>
    </section>
  );
}

function SourceEvidence({
  lead,
  canEdit,
  busy,
  onEvidence,
}: {
  lead?: CplWorkflowLead;
  canEdit: boolean;
  busy: boolean;
  onEvidence: Props["onEvidence"];
}) {
  async function append(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lead || !canEdit || busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const result = await onEvidence(lead.id, {
      expectedVersion: lead.version,
      label: String(fields.get("label")),
      reference: String(fields.get("reference") ?? "") || null,
      note: String(fields.get("note") ?? "") || null,
    });
    if (result) form.reset();
  }
  return (
    <section className={`${styles.panel} ${styles.evidence}`} aria-label="Source evidence">
      <p className={styles.eyebrow}>PRESERVED CONTEXT</p>
      <h2>Source evidence</h2>
      <p className={styles.muted}>
        {lead
          ? "Original capture and added references stay with this lead. Editing lead information does not rewrite them."
          : "The original inquiry is preserved when you save. Keep source wording in request details; add interpretation in internal notes."}
      </p>
      {lead ? (
        <>
          <p className={styles.meta}>
            {sources[lead.sourceType]} · Received {new Date(lead.receivedAt).toLocaleString()}
          </p>
          <ol className={styles.evidenceList}>
            {lead.evidence.map((item) => (
              <li key={item.id}>
                <span className={styles.badge}>
                  {item.kind === "initial_capture"
                    ? "Original capture"
                    : item.kind === "source_reference"
                      ? "Source reference"
                      : "Note"}
                </span>
                <h3>{item.label}</h3>
                {item.reference ? <p className={styles.document}>{item.reference}</p> : null}
                {item.note ? <p className={styles.document}>{item.note}</p> : null}
                <time className={styles.meta} dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
          {!lead.evidence.length ? (
            <p className={styles.empty}>No source evidence was recorded for this older lead.</p>
          ) : null}
        </>
      ) : (
        <div className={styles.empty}>Save the inquiry to create its source record.</div>
      )}
      {lead && canEdit ? (
        <details className={styles.addEvidence}>
          <summary>Add source evidence</summary>
          <form className={styles.form} onSubmit={(event) => void append(event)}>
            <label className={styles.field}>
              Evidence label
              <input
                name="label"
                required
                maxLength={180}
                placeholder="Original email or call notes"
              />
            </label>
            <label className={styles.field}>
              Source reference
              <input
                name="reference"
                maxLength={2000}
                placeholder="Reference or document location"
              />
            </label>
            <label className={styles.field}>
              Evidence note
              <textarea name="note" maxLength={10000} />
            </label>
            <p className={styles.meta}>
              References and notes only. This does not upload a file or fetch an external source.
            </p>
            <button className={styles.secondary} disabled={busy} type="submit">
              Preserve evidence
            </button>
          </form>
        </details>
      ) : null}
    </section>
  );
}

function DirectoryForm({
  directory,
  busy,
  onDirectory,
}: {
  directory: IntakeDirectory;
  busy: boolean;
  onDirectory: Props["onDirectory"];
}) {
  const [kind, setKind] = useState("customer");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const input: LeadInput = { kind, name: String(fields.get("name")) };
    if (kind !== "customer") input.customerId = String(fields.get("customerId"));
    for (const key of kind === "contact" ? ["email", "phone"] : kind === "site" ? ["address"] : [])
      input[key] = String(fields.get(key) ?? "");
    if (await onDirectory(input)) {
      form.reset();
      setKind("customer");
    }
  }
  return (
    <details className={`${styles.panel} ${styles.directory}`}>
      <summary>Add a company directory record</summary>
      <p className={styles.meta}>
        Create a customer, contact or site for this organization, then select it in the lead.
        Existing records are preserved.
      </p>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <label className={styles.field}>
          Record kind
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="customer">Customer</option>
            <option value="contact">Contact</option>
            <option value="site">Site</option>
          </select>
        </label>
        {kind !== "customer" ? (
          <label className={styles.field}>
            Directory customer
            <select name="customerId" required>
              <option value="">Choose customer</option>
              {directory.customers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className={styles.field}>
          Record name
          <input name="name" required maxLength={160} />
        </label>
        {kind === "contact" ? (
          <>
            <label className={styles.field}>
              Directory email
              <input type="email" name="email" maxLength={254} />
            </label>
            <label className={styles.field}>
              Directory phone
              <input name="phone" maxLength={80} />
            </label>
          </>
        ) : null}
        {kind === "site" ? (
          <label className={styles.field}>
            Directory address
            <input name="address" maxLength={1000} />
          </label>
        ) : null}
        <button className={styles.secondary} disabled={busy} type="submit">
          Save directory record
        </button>
      </form>
    </details>
  );
}

export function LeadWorkspace(props: Props) {
  const { onDirty } = props;
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [epoch, setEpoch] = useState(0);
  const hasDirty = Object.values(dirty).some(Boolean),
    navigation = useUnsavedNavigation(hasDirty);
  useEffect(() => onDirty?.(hasDirty), [onDirty, hasDirty]);
  // A guarded handoff can discard and unmount in the same React batch, before
  // the cleared local map reaches the reporting effect above.
  useEffect(() => () => onDirty?.(false), [onDirty]);
  function navigate(operation: () => void) {
    navigation.navigate(() => {
      setDirty({});
      setEpoch((value) => value + 1);
      operation();
    });
  }
  function saved(region: string) {
    setDirty((previous) => ({ ...previous, [region]: false }));
  }
  const [filter, setFilter] = useState<"all" | "attention" | "ready">("attention");
  const [query, setQuery] = useState("");
  const selected = props.leads.find((lead) => lead.id === props.selectedId);
  const visible = props.leads.filter(
    (lead) =>
      (filter === "all" ||
        (filter === "attention"
          ? needsAttention(lead)
          : lead.status === "ready_for_proposal" && lead.readiness.readyForProposal)) &&
      [lead.title, lead.customerName, lead.contactName, lead.requestedService]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <div
      className={styles.intakeLayout}
      onChangeCapture={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("form")) {
          const region = target.closest("[data-dirty-region]")?.getAttribute("data-dirty-region");
          if (region) setDirty((previous) => ({ ...previous, [region]: true }));
        }
      }}
    >
      {navigation.dialog}
      <aside
        className={styles.queue}
        aria-label="Lead attention queue"
        data-dirty-region="directory"
      >
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>INTAKE DESK</p>
            <h2>Lead queue</h2>
          </div>
          <span className={styles.badge}>{props.leads.length}</span>
        </div>
        <p className={styles.muted}>A clear next step for every inquiry.</p>
        <div className={styles.actions}>
          <button
            className={styles.primary}
            disabled={props.busy || !props.permissions.canCreateLead}
            onClick={() => navigate(() => props.onSelect(""))}
          >
            New lead
          </button>
          <button className={styles.secondary} disabled={props.busy} onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
        <label className={styles.field}>
          Find a lead
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Customer, title or service"
          />
        </label>
        <div className={styles.queueFilters} aria-label="Filter lead queue">
          {(
            [
              ["all", "All", props.leads.length],
              ["attention", "Needs attention", props.leads.filter(needsAttention).length],
              [
                "ready",
                "Ready",
                props.leads.filter(
                  (lead) => lead.status === "ready_for_proposal" && lead.readiness.readyForProposal,
                ).length,
              ],
            ] as const
          ).map(([key, label, count]) => (
            <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
        <ul className={styles.queueList}>
          {visible.map((lead) => (
            <li key={lead.id}>
              <button
                className={styles.queueRecord}
                aria-pressed={selected?.id === lead.id}
                disabled={props.busy}
                onClick={() => navigate(() => props.onSelect(lead.id))}
              >
                <span className={styles.recordTop}>
                  <span
                    className={styles.statusDot}
                    data-ready={lead.status === "ready_for_proposal"}
                  />
                  {statuses[lead.status]}
                </span>
                <strong>{lead.title}</strong>
                <span>{lead.customerName || lead.contactName || "Customer to confirm"}</span>
                <small>{lead.nextAction || "Next action not assigned"}</small>
                {lead.duplicateCandidates.length &&
                lead.duplicateReview.disposition === "unreviewed" ? (
                  <span className={styles.issueLabel}>Possible duplicate</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        {!visible.length ? (
          <p className={styles.empty}>
            {props.leads.length
              ? "No inquiries match this view."
              : "No leads yet. Capture an inquiry to start your review queue."}
          </p>
        ) : null}
        {props.permissions.canCreateLead ? (
          <DirectoryForm
            key={epoch}
            directory={props.directory}
            busy={props.busy}
            onDirectory={async (input) => {
              const result = await props.onDirectory(input);
              if (result) saved("directory");
              return result;
            }}
          />
        ) : null}
      </aside>
      <div className={styles.leadColumns}>
        <div className={styles.stack}>
          <div data-dirty-region="lead">
            <LeadForm
              key={`form:${selected?.id ?? "new"}:${epoch}`}
              lead={selected}
              latest={selected}
              directory={props.directory}
              request={props.request}
              busy={props.busy}
              disabled={
                selected ? !props.permissions.canEditLead : !props.permissions.canCreateLead
              }
              onSave={async (input, id) => {
                const result = await props.onSave(input, id);
                if (result) saved("lead");
                return result;
              }}
            />
          </div>
          {selected ? (
            <div data-dirty-region="review">
              <LeadReview
                key={`review:${selected.id}:${epoch}`}
                lead={selected}
                canReview={props.permissions.canReviewLead}
                busy={props.busy}
                onSave={async (input, id) => {
                  const result = await props.onSave(input, id);
                  if (result) saved("review");
                  return result;
                }}
                onSelect={(id) => navigate(() => props.onSelect(id))}
              />
            </div>
          ) : null}
        </div>
        <div className={styles.stack}>
          <div data-dirty-region="evidence">
            <SourceEvidence
              key={epoch}
              lead={selected}
              canEdit={props.permissions.canEditLead}
              busy={props.busy}
              onEvidence={async (id, input) => {
                const result = await props.onEvidence(id, input);
                if (result) saved("evidence");
                return result;
              }}
            />
          </div>
          {selected ? (
            <section className={styles.panel} aria-label="Associated proposals">
              <p className={styles.eyebrow}>CONTINUE THE WORK</p>
              <h2>Proposals</h2>
              {props.proposals
                .filter((item) => item.leadId === selected.id)
                .map((item) => (
                  <button
                    key={item.id}
                    className={styles.record}
                    disabled={props.busy}
                    onClick={() => navigate(() => props.onProposal(selected, item.id))}
                  >
                    <strong>{item.title}</strong>
                    <small>Legacy draft · Version {item.version}</small>
                  </button>
                ))}
              <p className={styles.muted}>
                Create a structured proposal from the confirmed lead and source evidence. Existing
                manual drafts remain available above. Nothing is sent to the customer.
              </p>
              <button
                className={styles.primary}
                disabled={
                  props.busy ||
                  !props.permissions.canCreateProposal ||
                  selected.status !== "ready_for_proposal" ||
                  !selected.readiness.readyForProposal
                }
                onClick={() => navigate(() => props.onProposal(selected))}
              >
                Create proposal
              </button>
              {selected.status !== "ready_for_proposal" || !selected.readiness.readyForProposal ? (
                <p className={styles.meta}>
                  Resolve the review items and set the status to Ready for proposal to create a
                  draft. <a href="#lead-review">Review lead readiness</a>
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
