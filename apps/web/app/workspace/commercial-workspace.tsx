"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { CplWorkflowLead, CplProposalDraft } from "@bea/database/hosted";
import {
  CPL_COMMERCIAL_LOST_REASONS,
  type CplCommercialLostReason,
} from "@bea/domain/cpl-commercial";
import type {
  CplCommercialArtifact,
  CplCommercialAwardInput,
  CplCommercialCustomerPreview,
  CplCommercialProject,
  CplCommercialProjectSnapshot,
  CplCommercialProposal,
} from "@bea/domain/cpl-commercial";
import { BrandingSettings, TemplateSettings } from "./commercial-config";
import { CustomerDocument, VersionContent } from "./commercial-document";
import { useUnsavedNavigation } from "./commercial-navigation";
import { ExecutionWorkspace } from "./execution-workspace";
import type { WorkspaceRecordIntent } from "./phase4-ui";
import type { FieldUpload } from "./field-upload";
import { ProposalEditor, SourceSnapshot, Totals } from "./commercial-proposal-editor";
import {
  commercialStates,
  decimalMoney,
  money,
  parseMinorUnits,
  type CommercialRequest,
  type CommercialWorkspaceData,
  type ProposalIntent,
} from "./commercial-ui";
import styles from "./workspace.module.css";
import css from "./commercial.module.css";

const base = "/api/cpl-commercial";
type Area = "proposals" | "projects" | "templates" | "branding";
type DetailTab = "builder" | "history" | "customer" | "handoff";

function ProjectRecord({
  project,
  onProposal,
  onOpenLead,
}: {
  project: CplCommercialProject;
  onProposal: (id: string) => void;
  onOpenLead: (id: string) => void;
}) {
  const snapshot = project.snapshot;
  return (
    <article className={styles.panel} aria-label="Linked project">
      <p className={styles.eyebrow}>PROJECT CREATED FROM APPROVED WORK</p>
      <h2>{project.reference}</h2>
      <h3>{snapshot.version.content.title}</h3>
      <p className={styles.muted}>
        Source proposal {snapshot.proposalReference} · approved version {project.proposalVersion}.
        This project retains the awarded scope, customer, pricing, schedule, source evidence and
        operations notes.
      </p>
      <p>
        <strong>{snapshot.version.sourceLead.fields.customerName}</strong> ·{" "}
        {snapshot.version.sourceLead.fields.siteName || "Site to confirm"}
      </p>
      <p>
        Award {snapshot.award.awardDate} ·{" "}
        {money(snapshot.award.amountMinor, snapshot.award.currency)}
        {snapshot.award.purchaseOrder ? ` · PO ${snapshot.award.purchaseOrder}` : ""}
      </p>
      <p>
        <strong>Agreed project start:</strong>{" "}
        {snapshot.award.startDate || snapshot.version.content.startDate || "To confirm"}
        {snapshot.award.startDate ? " · from the award record" : " · from the quoted schedule"}
      </p>
      <button className={styles.secondary} onClick={() => onProposal(project.proposalId)}>
        Open source proposal
      </button>
      <div className={css.document}>
        <p className={styles.eyebrow}>ORIGINAL APPROVED QUOTE &amp; SCHEDULE</p>
        <VersionContent value={snapshot.version.content} />
        <Totals value={snapshot.version.totals} />
      </div>
      <section className={styles.detail}>
        <h3>Private operations handoff</h3>
        <p className={styles.document}>
          {[
            snapshot.internalNotes,
            snapshot.version.content.accessInstructions,
            snapshot.version.content.constraints,
          ]
            .filter(Boolean)
            .join("\n\n") || "No private notes recorded."}
        </p>
      </section>
      <SourceSnapshot source={snapshot.version.sourceLead} onOpenLead={onOpenLead} />
      <p className={css.hint}>
        This agreement is preserved from the award. Operational changes are saved separately in the
        project workspace.
      </p>
    </article>
  );
}

function CreateProposal({
  leads,
  legacy,
  data,
  intent,
  busy,
  onCreate,
}: {
  leads: CplWorkflowLead[];
  legacy: CplProposalDraft[];
  data: CommercialWorkspaceData;
  intent?: ProposalIntent;
  busy: boolean;
  onCreate: (input: {
    leadId: string;
    templateId?: string;
    legacyDraftId?: string;
    allowAdditional: boolean;
  }) => void;
}) {
  const [leadId, setLeadId] = useState(intent?.leadId ?? "");
  const [templateId, setTemplateId] = useState("");
  const [allowAdditional, setAllowAdditional] = useState(false);
  const lead = leads.find((item) => item.id === leadId);
  const previous = data.proposals.filter((item) => item.leadId === leadId);
  const legacyDraft = legacy.find((item) => item.id === intent?.legacyDraftId);
  const ready = lead?.status === "ready_for_proposal" && lead.readiness.readyForProposal;
  return (
    <section className={styles.panel}>
      <p className={styles.eyebrow}>LEAD → PROPOSAL</p>
      <h2>{legacyDraft ? "Upgrade a legacy draft" : "Create a structured proposal"}</h2>
      <p className={styles.muted}>
        Start from confirmed lead information. Creation saves a source snapshot and template
        defaults; it does not submit for approval or send to the customer.
      </p>
      {legacyDraft ? (
        <div className={styles.notice}>
          <strong>{legacyDraft.title}</strong>
          <p>
            The original manual draft and its downloads stay intact. A separate structured proposal
            is created for review and commercial handoff.
          </p>
        </div>
      ) : null}
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({
            leadId,
            ...(templateId ? { templateId } : {}),
            ...(legacyDraft ? { legacyDraftId: legacyDraft.id } : {}),
            allowAdditional,
          });
        }}
      >
        <fieldset className={styles.fieldset} disabled={busy || !data.permissions.canEdit}>
          <label className={styles.field}>
            Confirmed lead
            <select
              required
              value={leadId}
              disabled={Boolean(legacyDraft)}
              onChange={(event) => {
                setLeadId(event.target.value);
                setAllowAdditional(false);
              }}
            >
              <option value="">Choose a ready lead</option>
              {leads.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                  {item.status !== "ready_for_proposal" || !item.readiness.readyForProposal
                    ? " — review required"
                    : ""}
                </option>
              ))}
            </select>
          </label>
          {lead ? (
            <div className={styles.detail}>
              <h3>{lead.customerName || lead.contactName}</h3>
              <p>
                {[lead.contactName, lead.contactEmail, lead.siteName, lead.siteAddress]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <p className={styles.document}>{lead.details}</p>
              <p className={css.hint}>
                Requested service: {lead.requestedService || "Not recorded"} · Source:{" "}
                {lead.sourceType} · Lead version {lead.version}
              </p>
              <details open>
                <summary>Source evidence ({lead.evidence.length})</summary>
                {lead.evidence.map((item) => (
                  <div key={item.id} className={styles.document}>
                    <strong>{item.label}</strong>
                    {item.reference ? <p>{item.reference}</p> : null}
                    {item.note ? <p>{item.note}</p> : null}
                  </div>
                ))}
              </details>
            </div>
          ) : null}
          {lead && !ready ? (
            <div className={styles.warning}>
              <strong>Lead review required</strong>
              <p>Mark the lead Ready for proposal after resolving these items.</p>
              {lead.readiness.missingInformation.map((item) => (
                <p key={item.code}>{item.message}</p>
              ))}
              {lead.readiness.conflicts.map((item) => (
                <p key={item.code}>{item.message}</p>
              ))}
            </div>
          ) : null}
          <label className={styles.field}>
            Proposal template
            <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <option value="">Start from confirmed lead only</option>
              {data.templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          {!data.branding.businessName ? (
            <p className={styles.warning}>
              Company artifact branding needs configuration before a proposal can complete review.
            </p>
          ) : null}
          {previous.length ? (
            <div className={styles.warning}>
              <p>
                {previous.length} structured proposal
                {previous.length === 1 ? " already exists" : "s already exist"} for this lead.
                Existing proposals are listed in the queue.
              </p>
              <label className={css.check}>
                <input
                  type="checkbox"
                  checked={allowAdditional}
                  onChange={(event) => setAllowAdditional(event.target.checked)}
                />
                Intentionally create an additional proposal for this lead
              </label>
            </div>
          ) : null}
        </fieldset>
        <button
          className={styles.primary}
          disabled={
            busy ||
            !data.permissions.canEdit ||
            !ready ||
            Boolean(previous.length && !allowAdditional)
          }
        >
          Create proposal
        </button>
      </form>
    </section>
  );
}

function OutcomeForm({
  proposal,
  busy,
  allowed,
  dirty,
  onSave,
  onDirty,
  onReload,
}: {
  proposal: CplCommercialProposal;
  busy: boolean;
  allowed: boolean;
  dirty: boolean;
  onDirty: (dirty: boolean) => void;
  onReload: () => void;
  onSave: (input: {
    outcome: string;
    expectedRevision: number;
    reasonCode?: CplCommercialLostReason;
    note: string;
    award?: CplCommercialAwardInput;
  }) => void;
}) {
  const [baseline] = useState(proposal);
  const [outcome, setOutcome] = useState(proposal.state === "approved" ? "awarded" : "lost");
  const [error, setError] = useState("");
  const approved = baseline.versions.find((item) => item.version === baseline.approvedVersion);
  const stale = proposal.revision !== baseline.revision;
  useEffect(() => () => onDirty(false), [onDirty]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    try {
      const note = String(fields.get("note") ?? "");
      const award: CplCommercialAwardInput | undefined =
        outcome === "awarded"
          ? {
              awardDate: String(fields.get("awardDate")),
              amountMinor: parseMinorUnits(String(fields.get("amount"))),
              currency: approved!.content.currency,
              purchaseOrder: String(fields.get("purchaseOrder") ?? ""),
              startDate: String(fields.get("startDate") ?? "") || null,
              notes: String(fields.get("notes") ?? ""),
            }
          : undefined;
      setError("");
      onSave({
        outcome,
        expectedRevision: baseline.revision,
        note,
        ...(outcome === "lost"
          ? { reasonCode: String(fields.get("reasonCode")) as CplCommercialLostReason }
          : {}),
        ...(award ? { award } : {}),
      });
    } catch {
      setError("Check the award amount and required details. Your entries are kept.");
    }
  }
  return (
    <section className={styles.panel}>
      <h3>Record the commercial outcome</h3>
      <p className={css.hint}>
        This records a business decision inside your company. It does not represent an electronic
        customer signature or send a message.
      </p>
      {error ? (
        <p role="alert" className={styles.warning}>
          {error}
        </p>
      ) : null}
      {stale ? (
        <div className={styles.warning} role="alert">
          The saved proposal changed. Your outcome entries are kept. Review them before loading the
          latest proposal.
          <button type="button" className={styles.secondary} onClick={onReload}>
            Discard outcome entries and load latest
          </button>
        </div>
      ) : null}
      <form className={styles.form} onSubmit={submit} onChange={() => onDirty(true)}>
        <fieldset className={styles.fieldset} disabled={busy || !allowed || dirty}>
          <label className={styles.field}>
            Outcome
            <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
              <option value="awarded" disabled={!approved || proposal.state !== "approved"}>
                Awarded
              </option>
              <option value="lost">Lost</option>
              <option value="withdrawn">Withdrawn</option>
            </select>
          </label>
          {outcome === "lost" ? (
            <label className={styles.field}>
              Lost reason
              <select name="reasonCode" required defaultValue="">
                <option value="">Choose a reason</option>
                {CPL_COMMERCIAL_LOST_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className={styles.field}>
            Outcome note
            <textarea name="note" required={outcome !== "awarded"} maxLength={2000} rows={3} />
          </label>
          {outcome === "awarded" && approved ? (
            <>
              <div className={styles.fieldPair}>
                <label className={styles.field}>
                  Award date
                  <input type="date" name="awardDate" required />
                </label>
                <label className={styles.field}>
                  Award amount ({approved.content.currency})
                  <input
                    name="amount"
                    inputMode="decimal"
                    defaultValue={decimalMoney(approved.totals.totalMinor)}
                    required
                  />
                </label>
              </div>
              <label className={styles.field}>
                Purchase order / acceptance reference
                <input name="purchaseOrder" maxLength={240} />
              </label>
              <label className={styles.field}>
                Award start date
                <input
                  name="startDate"
                  type="date"
                  defaultValue={approved.content.startDate ?? ""}
                />
              </label>
              <label className={styles.field}>
                Internal award notes
                <textarea name="notes" maxLength={20000} rows={3} />
              </label>
            </>
          ) : null}
          <button
            className={styles.primary}
            disabled={
              stale || (outcome === "awarded" && (!approved || proposal.state !== "approved"))
            }
          >
            Record {outcome === "awarded" ? "award" : outcome}
          </button>
        </fieldset>
      </form>
    </section>
  );
}

export function CommercialWorkspace({
  organizationId,
  leads,
  legacyDrafts,
  intent,
  recordIntent,
  request,
  upload,
  onDirty: notifyDirty,
  onBusy,
  onLegacy,
  onOpenLead,
}: {
  organizationId: string;
  leads: CplWorkflowLead[];
  legacyDrafts: CplProposalDraft[];
  intent?: ProposalIntent;
  recordIntent?: WorkspaceRecordIntent;
  request: CommercialRequest;
  upload?: FieldUpload;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  onLegacy: () => void;
  onOpenLead: (id: string) => void;
}) {
  const [data, setData] = useState<CommercialWorkspaceData | null>(null);
  const [area, setArea] = useState<Area>("proposals");
  const [detail, setDetail] = useState<CplCommercialProposal | null>(null);
  const [displayedRevision, setDisplayedRevision] = useState<number | null>(null);
  const [tab, setTab] = useState<DetailTab>("builder");
  const [creating, setCreating] = useState(Boolean(intent));
  const [setupIntent, setSetupIntent] = useState(intent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [outcomeDirty, setOutcomeDirty] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [preview, setPreview] = useState<CplCommercialCustomerPreview | null>(null);
  const [handoff, setHandoff] = useState<CplCommercialProjectSnapshot | null>(null);
  const [project, setProject] = useState<CplCommercialProject | null>(null);
  const [executionIntent, setExecutionIntent] = useState(recordIntent);
  const [historyVersion, setHistoryVersion] = useState<number | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const navigationDirty = dirty || outcomeDirty || reviewNote.length > 0;
  const navigation = useUnsavedNavigation(navigationDirty);
  const [projectConfirmed, setProjectConfirmed] = useState(false);
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  }, [request]);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const attempts = useRef<Record<string, { payload: string; key: string }>>({});
  const dirtyRef = useRef(false);
  const onDirty = useCallback((value: boolean) => {
    setDirty(value);
  }, []);
  const onExecutionBusy = useCallback(
    (value: boolean) => {
      setBusy(value);
      onBusy(value);
    },
    [onBusy],
  );
  useEffect(() => {
    dirtyRef.current = navigationDirty;
    notifyDirty(navigationDirty);
  }, [navigationDirty, notifyDirty]);
  function discardTransient() {
    onDirty(false);
    setOutcomeDirty(false);
    setReviewNote("");
    setDisplayedRevision(detail?.revision ?? null);
  }
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  function key(kind: string, input: unknown) {
    const payload = JSON.stringify({ organizationId, input });
    if (attempts.current[kind]?.payload === payload) return attempts.current[kind]!.key;
    const value = crypto.randomUUID();
    attempts.current[kind] = { payload, key: value };
    return value;
  }
  async function refreshWorkspace() {
    const value = await requestRef.current<CommercialWorkspaceData>(`${base}/workspace`);
    if (alive.current) setData(value);
  }
  async function run(operation: () => Promise<void>) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      return true;
    } catch (caught) {
      if (alive.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "This action could not be completed. Your entries are kept.",
        );
      return false;
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void Promise.resolve().then(() => {
      if (alive.current)
        return run(async () => {
          await refreshWorkspace();
          if (!recordIntent || !alive.current) return;
          if (recordIntent.kind === "proposal") {
            const value = await requestRef.current<CplCommercialProposal>(
              `${base}/proposals/${recordIntent.id}`,
            );
            if (value.id !== recordIntent.id || value.organizationId !== organizationId)
              throw new Error("The action did not match this company’s proposal.");
            replace(value);
            setCreating(false);
            setArea("proposals");
            setTab("builder");
          } else {
            const id = recordIntent.kind === "project" ? recordIntent.id : recordIntent.projectId;
            if (!id) throw new Error("The action is missing its project reference.");
            const value = await requestRef.current<CplCommercialProject>(`${base}/projects/${id}`);
            if (value.id !== id || value.organizationId !== organizationId)
              throw new Error("The action did not match this company’s project.");
            if (alive.current) {
              setProject(value);
              setArea("projects");
            }
          }
        });
    });
    return () => {
      alive.current = false;
      notifyDirty(false);
      onBusy(false);
    };
    // A company gets its own keyed component. Token refreshes must not erase edited content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);
  function replace(value: CplCommercialProposal) {
    if (!alive.current) return;
    setDetail(value);
    setEpoch((n) => n + 1);
    discardTransient();
    setDisplayedRevision(value.revision);
    setPreview(null);
    setHandoff(null);
    setProjectConfirmed(false);
    setReviewNote("");
    setHistoryVersion(null);
  }
  function openProposal(id: string) {
    navigation.navigate(
      () =>
        void run(async () => {
          const value = await requestRef.current<CplCommercialProposal>(`${base}/proposals/${id}`);
          replace(value);
          setCreating(false);
          setArea("proposals");
          setTab("builder");
        }),
    );
  }
  async function mutate(action: string, body: Record<string, unknown>, message: string) {
    if (!detail) return false;
    return run(async () => {
      const value = await requestRef.current<CplCommercialProposal>(
        `${base}/proposals/${detail.id}/${action}`,
        body,
      );
      replace(value);
      await refreshWorkspace();
      setNotice(message);
    });
  }
  async function refreshDetail() {
    await run(async () => {
      await refreshWorkspace();
      if (detail) {
        const value = await requestRef.current<CplCommercialProposal>(
          `${base}/proposals/${detail.id}`,
        );
        if (alive.current) {
          if (dirtyRef.current) setDetail(value);
          else replace(value);
        }
      }
      setNotice("Latest saved state loaded. Unsaved editor entries have been retained.");
    });
  }
  const current = detail?.versions.find((version) => version.version === detail.currentVersion);
  const reviewStale = detail !== null && displayedRevision !== detail.revision;
  const approved = detail?.versions.find((version) => version.version === detail.approvedVersion);
  const artifact = detail?.artifacts.find((item) => item.version === detail.approvedVersion);
  if (!data)
    return (
      <section className={styles.panel}>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button
              className={styles.secondary}
              disabled={busy}
              onClick={() => void run(refreshWorkspace)}
            >
              Retry loading proposals
            </button>
          </>
        ) : (
          <p role="status">Loading company proposals…</p>
        )}
      </section>
    );
  return (
    <div className={css.shell}>
      {navigation.dialog}
      <div className={css.toolbar}>
        <div>
          <p className={styles.eyebrow}>FROM CONFIRMED SCOPE TO APPROVED WORK</p>
          <h2>Proposals &amp; projects</h2>
        </div>
        <div className={styles.actions}>
          <button className={styles.secondary} disabled={busy} onClick={() => void refreshDetail()}>
            Refresh saved state
          </button>
          <button
            className={styles.secondary}
            disabled={busy}
            onClick={() => {
              navigation.navigate(onLegacy);
            }}
          >
            Open legacy drafts
          </button>
        </div>
      </div>
      <nav className={css.subnav} aria-label="Commercial workspace sections">
        {(
          [
            ["proposals", "Proposal queue"],
            ["projects", "Projects"],
            ["templates", "Templates & services"],
            ["branding", "Artifact branding"],
          ] as const
        ).map(([value, label]) => (
          <button
            disabled={busy}
            key={value}
            aria-current={area === value ? "page" : undefined}
            onClick={() => {
              if (area !== value)
                navigation.navigate(() => {
                  discardTransient();
                  setArea(value);
                  setEpoch((n) => n + 1);
                });
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {error ? (
        <div role="alert" className={`${styles.notice} ${styles.error}`}>
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className={styles.notice}>
          {notice}
        </div>
      ) : null}
      {area === "branding" ? (
        <BrandingSettings
          key={`branding-${epoch}`}
          value={data.branding}
          busy={busy}
          allowed={data.permissions.canConfigure}
          onDirty={onDirty}
          onSave={(input, expectedRevision) =>
            run(async () => {
              await requestRef.current(`${base}/branding`, { input, expectedRevision });
              await refreshWorkspace();
              onDirty(false);
              setEpoch((n) => n + 1);
              setNotice(
                "Company artifact branding saved. Existing proposal versions remain unchanged.",
              );
            })
          }
        />
      ) : null}
      {area === "templates" ? (
        <TemplateSettings
          templates={data.templates}
          busy={busy}
          allowed={data.permissions.canConfigure}
          onDirty={onDirty}
          onSave={(input) =>
            run(async () => {
              await requestRef.current(`${base}/templates`, {
                input,
                idempotencyKey: key("template", input),
              });
              await refreshWorkspace();
              delete attempts.current.template;
              setNotice(
                "New company template saved. Existing templates and proposal snapshots remain intact.",
              );
            })
          }
        />
      ) : null}
      {area === "projects" ? (
        <div className={css.layout}>
          <aside className={css.queue} aria-label="Project queue">
            {data.projects.map((item) => (
              <button
                disabled={busy}
                key={item.id}
                aria-pressed={project?.id === item.id}
                onClick={() =>
                  navigation.navigate(
                    () =>
                      void run(async () => {
                        const value = await requestRef.current<CplCommercialProject>(
                          `${base}/projects/${item.id}`,
                        );
                        if (alive.current) {
                          discardTransient();
                          setProject(value);
                          setExecutionIntent(undefined);
                          setEpoch((n) => n + 1);
                        }
                      }),
                  )
                }
              >
                <span className={css.status}>{item.reference}</span>
                <strong>{item.snapshot.version.content.title}</strong>
                <small>From proposal version {item.proposalVersion}</small>
              </button>
            ))}
            {!data.projects.length ? (
              <p className={styles.empty}>
                No projects yet. Record an award on an approved proposal, review the handoff, then
                create the project.
              </p>
            ) : null}
          </aside>
          {project ? (
            <ExecutionWorkspace
              key={`${project.id}-${epoch}`}
              organizationId={organizationId}
              project={project}
              initialIntent={executionIntent}
              request={request}
              upload={upload}
              onDirty={onDirty}
              onBusy={onExecutionBusy}
              onOpenProject={(id) =>
                navigation.navigate(
                  () =>
                    void run(async () => {
                      const value = await requestRef.current<CplCommercialProject>(
                        `${base}/projects/${id}`,
                      );
                      if (alive.current) {
                        discardTransient();
                        setProject(value);
                        setExecutionIntent(undefined);
                        setEpoch((n) => n + 1);
                      }
                    }),
                )
              }
              agreement={
                <ProjectRecord
                  project={project}
                  onProposal={openProposal}
                  onOpenLead={onOpenLead}
                />
              }
            />
          ) : (
            <section className={styles.panel}>
              <h3>Project handoffs</h3>
              <p className={styles.muted}>
                Select a project to retrieve its saved awarded scope and source records.
              </p>
            </section>
          )}
        </div>
      ) : null}
      {area === "proposals" ? (
        <div className={css.layout}>
          <aside className={css.queue} aria-label="Structured proposal queue">
            <button
              disabled={busy || !data.permissions.canEdit}
              onClick={() => {
                navigation.navigate(() => {
                  discardTransient();
                  setSetupIntent(undefined);
                  setCreating(true);
                  setDetail(null);
                  setEpoch((n) => n + 1);
                });
              }}
            >
              <strong>+ New structured proposal</strong>
              <small>Start from a reviewed lead</small>
            </button>
            {data.proposals.map((proposal) => (
              <button
                key={proposal.id}
                disabled={busy}
                aria-pressed={!creating && detail?.id === proposal.id}
                onClick={() => void openProposal(proposal.id)}
              >
                <span className={css.status}>{commercialStates[proposal.state]}</span>
                <strong>{proposal.title}</strong>
                <small>
                  {proposal.reference} · Version {proposal.currentVersion}
                </small>
              </button>
            ))}
            {!data.proposals.length ? (
              <p className={styles.empty}>Your company has no structured proposals yet.</p>
            ) : null}
          </aside>
          <div className={css.stack}>
            {creating ? (
              <CreateProposal
                key={`setup-${epoch}`}
                leads={leads}
                legacy={legacyDrafts}
                data={data}
                intent={setupIntent}
                busy={busy}
                onCreate={(input) =>
                  void run(async () => {
                    const value = await requestRef.current<CplCommercialProposal>(
                      `${base}/proposals`,
                      { ...input, idempotencyKey: key("create", input) },
                    );
                    delete attempts.current.create;
                    replace(value);
                    setCreating(false);
                    setTab("builder");
                    await refreshWorkspace();
                    setNotice(
                      "Structured proposal created from the confirmed lead. Review and save your content before submitting.",
                    );
                  })
                }
              />
            ) : !detail || !current ? (
              <section className={styles.panel}>
                <p className={styles.eyebrow}>THE NEXT COMMITMENT</p>
                <h2>Prepare work worth approving.</h2>
                <p className={styles.muted}>
                  Choose a proposal, or start from a ready lead. Scope, pricing, review history and
                  award handoff stay together.
                </p>
              </section>
            ) : (
              <>
                <section className={styles.panel}>
                  <div className={css.toolbar}>
                    <div>
                      <p className={styles.eyebrow}>
                        {detail.reference} · VERSION {detail.currentVersion}
                      </p>
                      <h2>{detail.title}</h2>
                    </div>
                    <span className={styles.badge}>{commercialStates[detail.state]}</span>
                  </div>
                  <p className={css.hint}>
                    Saved proposal version {detail.currentVersion}
                    {detail.legacyDraftId ? " · Created from a preserved legacy draft" : ""}. No
                    customer delivery is performed here.
                  </p>
                  <nav className={css.subnav} aria-label="Proposal detail sections">
                    {(
                      [
                        ["builder", "Builder"],
                        ["history", "Versions & review"],
                        ["customer", "Customer preview & PDF"],
                        ["handoff", "Outcome & project"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        disabled={busy}
                        aria-current={tab === value ? "page" : undefined}
                        onClick={() => {
                          if (tab !== value)
                            navigation.navigate(() => {
                              discardTransient();
                              setEpoch((n) => n + 1);
                              setTab(value);
                            });
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </nav>
                </section>
                {tab === "builder" ? (
                  <ProposalEditor
                    key={`${detail.id}-${epoch}`}
                    proposal={detail}
                    branding={data.branding}
                    template={current.templateSnapshot}
                    busy={busy}
                    canEdit={data.permissions.canEdit}
                    onDirty={onDirty}
                    onReload={() => {
                      navigation.navigate(() => {
                        discardTransient();
                        setEpoch((n) => n + 1);
                      });
                    }}
                    onOpenLead={(id) => navigation.navigate(() => onOpenLead(id))}
                    onSave={(content, internalNotes, expectedRevision) =>
                      mutate(
                        "save",
                        { content, internalNotes, expectedRevision },
                        "Proposal version saved. Submit it when ready for review.",
                      )
                    }
                  />
                ) : null}
                {tab === "history" ? (
                  <>
                    <section className={styles.panel}>
                      <h3>Saved proposal versions</h3>
                      <label className={styles.field}>
                        View saved version
                        <select
                          value={historyVersion ?? detail.currentVersion}
                          onChange={(event) => setHistoryVersion(Number(event.target.value))}
                        >
                          {detail.versions.map((version) => (
                            <option key={version.version} value={version.version}>
                              Version {version.version}
                              {version.version === detail.approvedVersion ? " — approved" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      {(() => {
                        const version =
                          detail.versions.find(
                            (item) => item.version === (historyVersion ?? detail.currentVersion),
                          ) ?? current;
                        return (
                          <div className={css.document}>
                            <p className={styles.badge}>READ ONLY · VERSION {version.version}</p>
                            <VersionContent value={version.content} />
                            <Totals value={version.totals} />
                          </div>
                        );
                      })()}
                    </section>
                    <section className={styles.panel}>
                      <h3>Review trail</h3>
                      <ol className={css.history}>
                        {detail.events.map((event) => (
                          <li key={event.id}>
                            <strong>
                              {event.action.replaceAll("_", " ")} · Version {event.version}
                            </strong>
                            <small>{new Date(event.createdAt).toLocaleString()}</small>
                            {event.reason ? <p>{event.reason}</p> : null}
                            {event.reasonCode ? (
                              <p>Reason: {event.reasonCode.replaceAll("_", " ")}</p>
                            ) : null}
                            {event.note && event.note !== event.reason ? <p>{event.note}</p> : null}
                          </li>
                        ))}
                      </ol>
                      {detail.artifacts.length ? (
                        <div className={styles.actions}>
                          {detail.artifacts.map((item) => (
                            <a
                              key={item.id}
                              className={`${styles.button} ${styles.secondary}`}
                              href={`${base}/proposals/${detail.id}/pdf?version=${item.version}&organization=${encodeURIComponent(organizationId)}`}
                            >
                              Download recorded PDF v{item.version}
                            </a>
                          ))}
                        </div>
                      ) : null}
                      {detail.artifacts.length ? (
                        <p className={css.hint}>
                          Recorded PDFs preserve earlier approved versions. A historical approval
                          does not approve later edits or reopen a lost or withdrawn proposal.
                        </p>
                      ) : null}
                    </section>
                  </>
                ) : null}
                {tab === "builder" || tab === "history" ? (
                  <section className={styles.panel}>
                    <h3>Review &amp; approval</h3>
                    <p className={css.hint}>
                      Actions apply to saved version {detail.currentVersion}. Any edit after
                      approval requires a new review; earlier versions remain available.
                    </p>
                    {dirty ? (
                      <p className={styles.warning}>
                        Save your changes before review actions, or discard them explicitly.
                      </p>
                    ) : null}
                    {reviewStale ? (
                      <div className={styles.warning} role="alert">
                        The saved proposal changed while you were reviewing it. Your note is
                        retained; load the latest version before approving or requesting changes.
                        <button
                          type="button"
                          className={styles.secondary}
                          onClick={() =>
                            navigation.navigate(() => {
                              discardTransient();
                              setEpoch((n) => n + 1);
                            })
                          }
                        >
                          Discard pending review and load latest
                        </button>
                      </div>
                    ) : null}
                    {["review", "approved", "revision_requested"].includes(detail.state) ? (
                      <label className={styles.field}>
                        Review / revision note
                        <textarea
                          rows={3}
                          maxLength={2000}
                          value={reviewNote}
                          onChange={(event) => setReviewNote(event.target.value)}
                          disabled={
                            busy || (!data.permissions.canEdit && !data.permissions.canReview)
                          }
                        />
                      </label>
                    ) : null}
                    <div className={styles.actions}>
                      {["draft", "revision_requested"].includes(detail.state) ? (
                        <button
                          className={styles.primary}
                          disabled={
                            busy ||
                            dirty ||
                            reviewStale ||
                            !data.permissions.canEdit ||
                            detail.state !== "draft"
                          }
                          onClick={() =>
                            void mutate(
                              "submit",
                              { expectedRevision: detail.revision },
                              "Saved proposal submitted for review.",
                            )
                          }
                        >
                          Submit for review
                        </button>
                      ) : null}
                      {detail.state === "review" ? (
                        <>
                          <button
                            className={styles.primary}
                            disabled={busy || dirty || reviewStale || !data.permissions.canReview}
                            onClick={() =>
                              void mutate(
                                "review",
                                {
                                  expectedRevision: detail.revision,
                                  decision: "approve",
                                  note: reviewNote,
                                },
                                "This saved version is approved. Customer preview and final PDF are available.",
                              )
                            }
                          >
                            Approve version {detail.currentVersion}
                          </button>
                          <button
                            className={styles.secondary}
                            disabled={
                              busy ||
                              dirty ||
                              reviewStale ||
                              !data.permissions.canReview ||
                              !reviewNote.trim()
                            }
                            onClick={() =>
                              void mutate(
                                "review",
                                {
                                  expectedRevision: detail.revision,
                                  decision: "request_revision",
                                  note: reviewNote,
                                },
                                "Changes requested. The review note is preserved in the proposal history.",
                              )
                            }
                          >
                            Request revision
                          </button>
                        </>
                      ) : null}
                      {["approved", "review", "revision_requested"].includes(detail.state) ? (
                        <button
                          className={styles.secondary}
                          disabled={
                            busy ||
                            dirty ||
                            reviewStale ||
                            !data.permissions.canEdit ||
                            !reviewNote.trim()
                          }
                          onClick={() =>
                            void mutate(
                              "revise",
                              { expectedRevision: detail.revision, note: reviewNote },
                              "A revision is open. Save the revised content and submit it for approval again.",
                            )
                          }
                        >
                          Open revision
                        </button>
                      ) : null}
                    </div>
                  </section>
                ) : null}
                {tab === "customer" ? (
                  <>
                    <section className={styles.panel}>
                      <h3>Customer document</h3>
                      <p className={styles.muted}>
                        Preview the saved scope, pricing and company branding the customer will see.
                        Internal notes, access instructions and source evidence stay private.
                      </p>
                      <div className={styles.actions}>
                        <button
                          className={styles.secondary}
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const value = await requestRef.current<CplCommercialCustomerPreview>(
                                `${base}/proposals/${detail.id}/customer-preview?version=${detail.approvedVersion ?? detail.currentVersion}`,
                              );
                              if (alive.current) setPreview(value);
                            })
                          }
                        >
                          Load {approved ? "approved" : "draft"} customer preview
                        </button>
                        {approved && ["approved", "awarded"].includes(detail.state) ? (
                          <button
                            className={styles.primary}
                            disabled={busy || !data.permissions.canEdit}
                            onClick={() =>
                              void run(async () => {
                                const value = await requestRef.current<CplCommercialArtifact>(
                                  `${base}/proposals/${detail.id}/pdf`,
                                  { version: approved.version },
                                );
                                if (alive.current)
                                  setDetail((previous) =>
                                    previous
                                      ? {
                                          ...previous,
                                          artifacts: [
                                            ...previous.artifacts.filter(
                                              (item) => item.version !== value.version,
                                            ),
                                            value,
                                          ],
                                        }
                                      : previous,
                                  );
                                setNotice(
                                  "Approved PDF generated and recorded for this exact saved version.",
                                );
                              })
                            }
                          >
                            Generate approved PDF
                          </button>
                        ) : null}
                        {artifact ? (
                          <a
                            className={`${styles.button} ${styles.primary}`}
                            href={`${base}/proposals/${detail.id}/pdf?version=${artifact.version}&organization=${encodeURIComponent(organizationId)}`}
                          >
                            Download approved PDF v{artifact.version}
                          </a>
                        ) : null}
                      </div>
                      {artifact ? (
                        <p className={css.hint}>
                          Recorded artifact · {artifact.byteLength.toLocaleString()} bytes · SHA-256{" "}
                          {artifact.sha256}
                        </p>
                      ) : null}
                      {!approved ? (
                        <p className={styles.warning}>
                          Final PDF generation requires an approved saved version.
                        </p>
                      ) : null}
                    </section>
                    {preview ? <CustomerDocument preview={preview} /> : null}
                  </>
                ) : null}
                {tab === "handoff" ? (
                  <>
                    {!["awarded", "lost", "withdrawn"].includes(detail.state) ? (
                      <OutcomeForm
                        key={`${detail.id}-${epoch}`}
                        proposal={detail}
                        busy={busy}
                        allowed={data.permissions.canAward}
                        dirty={dirty}
                        onDirty={setOutcomeDirty}
                        onReload={() =>
                          navigation.navigate(() => {
                            discardTransient();
                            setEpoch((n) => n + 1);
                          })
                        }
                        onSave={(input) =>
                          void mutate(
                            "outcome",
                            {
                              ...input,
                              expectedRevision: input.expectedRevision,
                              idempotencyKey: key("outcome", {
                                ...input,
                                proposalId: detail.id,
                                revision: input.expectedRevision,
                              }),
                            },
                            "Commercial outcome recorded with its source proposal version.",
                          )
                        }
                      />
                    ) : (
                      <section className={styles.panel}>
                        <h3>Outcome: {commercialStates[detail.state]}</h3>
                        {detail.outcome?.reasonCode ? (
                          <p>Reason: {detail.outcome.reasonCode.replaceAll("_", " ")}</p>
                        ) : null}
                        {detail.outcome?.note ? (
                          <p className={styles.document}>{detail.outcome.note}</p>
                        ) : null}
                        {detail.award ? (
                          <p>
                            Awarded {detail.award.awardDate} ·{" "}
                            {money(detail.award.amountMinor, detail.award.currency)} ·{" "}
                            {detail.award.purchaseOrder || "No purchase order recorded"}
                          </p>
                        ) : null}
                      </section>
                    )}
                    {detail.award ? (
                      <section className={styles.panel}>
                        <p className={styles.eyebrow}>APPROVED SCOPE → PROJECT</p>
                        <h3>
                          {detail.project ? "Project already linked" : "Review the project handoff"}
                        </h3>
                        {detail.project ? (
                          <button
                            className={styles.primary}
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const value = await requestRef.current<CplCommercialProject>(
                                  `${base}/projects/${detail.project!.id}`,
                                );
                                if (alive.current) {
                                  setProject(value);
                                  setArea("projects");
                                }
                              })
                            }
                          >
                            Open linked project {detail.project.reference}
                          </button>
                        ) : (
                          <>
                            <p className={styles.muted}>
                              Preview the awarded scope and operations notes. Enabled company
                              recipes may prepare the linked project; refresh saved state to see
                              current results.
                            </p>
                            <button
                              className={styles.secondary}
                              disabled={busy || !data.permissions.canCreateProject}
                              onClick={() =>
                                void run(async () => {
                                  const value =
                                    await requestRef.current<CplCommercialProjectSnapshot>(
                                      `${base}/proposals/${detail.id}/project-preview`,
                                    );
                                  if (alive.current) {
                                    setHandoff(value);
                                    setProjectConfirmed(false);
                                  }
                                })
                              }
                            >
                              Preview project handoff
                            </button>
                            {handoff ? (
                              <div className={styles.detail}>
                                <h3>{handoff.version.content.title}</h3>
                                <p>
                                  Source {handoff.proposalReference} · Approved version{" "}
                                  {handoff.version.version} ·{" "}
                                  {handoff.version.sourceLead.fields.customerName}
                                </p>
                                <p className={styles.document}>{handoff.version.content.scope}</p>
                                <p className={styles.document}>
                                  {handoff.version.content.deliverables}
                                </p>
                                <p>
                                  Award {money(handoff.award.amountMinor, handoff.award.currency)} ·
                                  Start{" "}
                                  {handoff.award.startDate ||
                                    handoff.version.content.startDate ||
                                    "To confirm"}
                                </p>
                                <h4>Private operations notes</h4>
                                <p className={styles.document}>
                                  {[
                                    handoff.internalNotes,
                                    handoff.version.content.accessInstructions,
                                    handoff.version.content.constraints,
                                  ]
                                    .filter(Boolean)
                                    .join("\n\n") || "None recorded"}
                                </p>
                                <label className={css.check}>
                                  <input
                                    type="checkbox"
                                    checked={projectConfirmed}
                                    disabled={busy}
                                    onChange={(event) => setProjectConfirmed(event.target.checked)}
                                  />
                                  I reviewed the awarded scope and want to create its linked
                                  project.
                                </label>
                                <button
                                  className={styles.primary}
                                  disabled={
                                    busy || !data.permissions.canCreateProject || !projectConfirmed
                                  }
                                  onClick={() =>
                                    void run(async () => {
                                      const value = await requestRef.current<CplCommercialProject>(
                                        `${base}/proposals/${detail.id}/project`,
                                        {
                                          idempotencyKey: key("project", { proposalId: detail.id }),
                                        },
                                      );
                                      if (alive.current) {
                                        setProject(value);
                                        setDetail({ ...detail, project: value });
                                        setArea("projects");
                                      }
                                      await refreshWorkspace();
                                      setNotice(
                                        "Linked project created from the immutable awarded proposal. No scheduling or field work has been started.",
                                      );
                                    })
                                  }
                                >
                                  Create linked project
                                </button>
                              </div>
                            ) : null}
                          </>
                        )}
                      </section>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
