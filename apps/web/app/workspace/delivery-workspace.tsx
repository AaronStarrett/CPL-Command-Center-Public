"use client";

import { useEffect, useRef, useState } from "react";
import {
  normalizeCplDeliveryInput,
  type CplDeliveryInput,
  type CplDeliveryPackage,
  type CplDeliveryWorkspace,
  type CplDeliveryVersion,
  type CplManualDeliveryInput,
  type CplDeliveryAcknowledgmentInput,
} from "@bea/domain/cpl-delivery";
import type { CommercialRequest } from "./commercial-ui";
import { useUnsavedNavigation } from "./commercial-navigation";
import { ApprovedArtifacts, CloseoutReadiness, ReadinessPolicy } from "./delivery-settings";
import styles from "./workspace.module.css";
import forms from "./execution.module.css";
import css from "./action-center.module.css";

const stateLabels = {
  draft: "Draft",
  ready: "Ready",
  exported: "Export recorded",
  manually_sent: "Manually recorded sent",
  acknowledged: "Acknowledgment recorded",
};
const historyLabels = {
  reason: "Reason",
  sentAt: "Stated send time",
  channel: "Channel used",
  recipient: "Recipient",
  reference: "External reference",
  note: "Note",
  acknowledgedAt: "Stated acknowledgment time",
  evidence: "Evidence",
};
const errors: Record<string, string> = {
  CPL_DELIVERY_REVISION_CONFLICT:
    "This record changed elsewhere. Your entries are kept. Refresh the saved project and reconcile before saving.",
  CPL_DELIVERY_APPROVAL_WITHDRAWN:
    "Approval of a selected artifact was withdrawn. Historical records remain; select an authorized approved version for a new package.",
  CPL_DELIVERY_NOT_READY:
    "The package is not ready. Check the recipient confirmation and exact approved attachments.",
  CPL_DELIVERY_INVALID_INPUT:
    "Review the recipient, subject, selected approved attachments and required dates or reasons.",
  CPL_DELIVERY_INVALID_STATE:
    "The package state no longer permits this action. Refresh the saved package and review its history.",
  CPL_DELIVERY_INVALID_EVIDENCE:
    "Use the actual event time and evidence. Sending cannot predate package preparation; acknowledgment cannot predate sending.",
  CPL_DELIVERY_RECIPIENT_CHANGED:
    "The recorded recipient must match the saved package. Save and confirm a revised package if the recipient changed.",
  CPL_DELIVERY_RECIPIENT_REQUIRED:
    "Enter and save the intended recipient before marking this package ready.",
  CPL_DELIVERY_APPROVED_ARTIFACT_REQUIRED:
    "Select an available approved report artifact. An editable draft is not an approved attachment.",
  CPL_DELIVERY_PROJECT_UNAVAILABLE:
    "The current project state does not allow this handoff. Open project operations and review it.",
  CPL_CLOSEOUT_ISSUE_CHANGED:
    "Source evidence changed since this issue was reviewed. Refresh the current facts and record a new disposition against that evidence.",
  CPL_CLOSEOUT_EVIDENCE_CHANGED:
    "The readiness evidence changed. Refresh and review it before recording an override.",
  CPL_CLOSEOUT_ISSUE_DISPOSITION_REQUIRED:
    "Retain recorded handoff issues and resolve, accept or reopen them with a reason instead of removing their history.",
};
function inputFor(data: CplDeliveryWorkspace): CplDeliveryInput {
  return {
    customerName: data.project.customerName,
    contactName: data.project.contactName,
    recipient: data.project.contactEmail ?? "",
    subject: "",
    message: "",
    attachments: [],
  };
}
function versionOf(pkg: CplDeliveryPackage) {
  const value = pkg.versions.find((v) => v.version === pkg.currentVersion);
  if (!value) throw new Error("The saved delivery version is unavailable.");
  return value;
}
function HumanDeliveryRecord({
  kind,
  recipient,
  busy,
  onDirty,
  onSave,
}: {
  kind: "sent" | "acknowledge";
  recipient: string;
  busy: boolean;
  onDirty: (value: boolean) => void;
  onSave: (input: CplManualDeliveryInput | CplDeliveryAcknowledgmentInput) => Promise<boolean>;
}) {
  const [at, setAt] = useState(""),
    [channel, setChannel] = useState(""),
    [to, setTo] = useState(recipient),
    [reference, setReference] = useState(""),
    [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState("");
  const change = (set: (v: string) => void, value: string) => {
    set(value);
    onDirty(true);
    setConfirmed(false);
    setError("");
  };
  return (
    <form
      className={forms.form}
      onSubmit={(e) => {
        e.preventDefault();
        void (async () => {
          try {
            if (!confirmed) return;
            const eventTime = new Date(at);
            if (!at || !Number.isFinite(eventTime.getTime()))
              throw new Error("Enter a complete event date and time, or choose Use current time.");
            const instant = eventTime.toISOString();
            if (Date.parse(instant) > Date.now())
              throw new Error("Use the actual past event time.");
            const input =
              kind === "sent"
                ? { sentAt: instant, channel, recipient: to, reference, note }
                : { acknowledgedAt: instant, evidence: note };
            if (await onSave(input)) {
              onDirty(false);
              setAt("");
              setChannel("");
              setReference("");
              setNote("");
              setConfirmed(false);
            }
          } catch (caught) {
            setError(
              caught instanceof Error ? caught.message : "Review the event date and evidence.",
            );
          }
        })();
      }}
    >
      <fieldset className={styles.fieldset} disabled={busy}>
        <h3>{kind === "sent" ? "Record a manual send" : "Record an actual acknowledgment"}</h3>
        <p className={css.hint}>
          {kind === "sent"
            ? "Use this after a person has sent the approved files outside CPL. This action does not send email or create a provider receipt."
            : "Record acknowledgment only when you have real supporting evidence. Sending or downloading alone is not acknowledgment."}
        </p>
        <label className={styles.field}>
          {kind === "sent" ? "Actual send date and time" : "Acknowledgment date and time"}
          <input
            type="datetime-local"
            step="1"
            required
            value={at}
            onChange={(e) => change(setAt, e.target.value)}
          />
          <small>
            Entered in this device’s timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}.
            Recorded separately from the server’s audit time.
          </small>
        </label>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            const now = new Date();
            const pad = (value: number) => String(value).padStart(2, "0");
            change(
              setAt,
              `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
            );
          }}
        >
          Use current time
        </button>
        {kind === "sent" ? (
          <>
            <label className={styles.field}>
              Channel used
              <input
                required
                maxLength={120}
                value={channel}
                onChange={(e) => change(setChannel, e.target.value)}
                placeholder="For example, your existing email client"
              />
            </label>
            <label className={styles.field}>
              Recipient actually sent to
              <input
                required
                maxLength={320}
                value={to}
                onChange={(e) => change(setTo, e.target.value)}
              />
            </label>
            <label className={styles.field}>
              External reference (optional)
              <input
                maxLength={500}
                value={reference}
                onChange={(e) => change(setReference, e.target.value)}
              />
            </label>
          </>
        ) : null}
        <label className={styles.field}>
          {kind === "sent" ? "Send note (optional)" : "Acknowledgment evidence"}
          <textarea
            required={kind === "acknowledge"}
            maxLength={2000}
            value={note}
            onChange={(e) => change(setNote, e.target.value)}
          />
        </label>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => {
              setConfirmed(e.target.checked);
              onDirty(true);
            }}
          />
          <span>
            {kind === "sent"
              ? "I am recording an actual manual send of this exact package version."
              : "I have evidence of this acknowledgment and have described it above."}
          </span>
        </label>
        {error ? (
          <p className={`${styles.notice} ${styles.error}`} role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className={styles.primary} disabled={!confirmed}>
          {kind === "sent" ? "Record manually sent" : "Record acknowledgment with evidence"}
        </button>
      </fieldset>
    </form>
  );
}
function PackageDocument({
  pkg,
  version,
  organizationId,
  base,
  onCopy,
}: {
  pkg: CplDeliveryPackage;
  version: CplDeliveryVersion;
  organizationId: string;
  base: string;
  onCopy: () => void;
}) {
  return (
    <section className={styles.panel} aria-label="Customer delivery package preview">
      <p className={styles.eyebrow}>EXACT SAVED PACKAGE · VERSION {version.version}</p>
      <h3>{version.input.subject}</h3>
      <p>
        <strong>To:</strong> {version.input.recipient || "Recipient not confirmed"}
      </p>
      <p>
        {version.input.customerName}
        {version.input.contactName ? ` · ${version.input.contactName}` : ""}
      </p>
      <p className={css.message}>{version.input.message || "No message entered."}</p>
      <h3>Selected approved files</h3>
      <div className={css.records}>
        {version.attachments.map((file) => (
          <div className={css.attachment} key={`${file.reportId}:${file.version}`}>
            <strong>
              {file.reference} · approved version {file.version}
            </strong>
            <span>
              {file.title} · {file.byteLength.toLocaleString()} bytes
            </span>
            <code>SHA-256 {file.sha256}</code>
            <a
              className={`${styles.button} ${styles.secondary}`}
              href={`${base}/packages/${pkg.id}/attachments/${file.reportId}?version=${version.version}&reportVersion=${file.version}&organization=${encodeURIComponent(organizationId)}`}
            >
              Download {file.reference} PDF version {file.version}
            </a>
          </div>
        ))}
      </div>
      <p className={css.hint}>
        These are recorded approved bytes. This preview does not regenerate a PDF from the current
        project or report draft.
      </p>
      <button type="button" className={styles.secondary} onClick={onCopy}>
        Copy saved message
      </button>
      <p className={css.hint}>A copied message or download does not record sending.</p>
    </section>
  );
}
export function DeliveryWorkspace({
  projectId,
  organizationId,
  request,
  members,
  onDirty,
  onBusy,
  onOpenReport,
  initialPackageId,
}: {
  projectId: string;
  organizationId: string;
  request: CommercialRequest;
  members: readonly { identityId: string; displayName: string }[];
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
  onOpenReport?: (id: string, version: number) => void;
  initialPackageId?: string;
}) {
  const base = `/api/cpl-delivery/projects/${projectId}`;
  const memberName = (identityId: string) =>
    members.find((member) => member.identityId === identityId)?.displayName.trim() ||
    `Identity ${identityId}`;
  const [data, setData] = useState<CplDeliveryWorkspace | null>(null),
    [pkg, setPackage] = useState<CplDeliveryPackage | null>(null),
    [draft, setDraft] = useState<CplDeliveryInput | null>(null);
  const [area, setArea] = useState<"packages" | "readiness" | "policy" | "approvals">("packages"),
    [tab, setTab] = useState<"editor" | "preview" | "history">("editor"),
    [historyVersion, setHistoryVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false),
    [childDirty, setChildDirty] = useState(false),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [record, setRecord] = useState<"sent" | "acknowledge" | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [epoch, setEpoch] = useState(0);
  const refs = useRef({ request, onDirty, onBusy, onOpenReport });
  useEffect(() => {
    refs.current = { request, onDirty, onBusy, onOpenReport };
  }, [request, onDirty, onBusy, onOpenReport]);
  const alive = useRef(true),
    working = useRef(false),
    attempts = useRef<Record<string, { payload: string; key: string }>>({});
  const navigation = useUnsavedNavigation(dirty || childDirty || Boolean(reason));
  useEffect(() => {
    refs.current.onDirty(dirty || childDirty || Boolean(reason));
  }, [dirty, childDirty, reason]);
  function key(action: string, input: unknown) {
    const payload = JSON.stringify({ organizationId, projectId, input });
    if (attempts.current[action]?.payload !== payload)
      attempts.current[action] = { payload, key: crypto.randomUUID() };
    return attempts.current[action]!.key;
  }
  async function read() {
    const value = await refs.current.request<CplDeliveryWorkspace>(base);
    if (value.project.id !== projectId || value.packages.some((p) => p.projectId !== projectId))
      throw new Error("The delivery workspace did not match this project.");
    if (alive.current) setData(value);
    return value;
  }
  function accept(value: CplDeliveryPackage | null, workspace: CplDeliveryWorkspace) {
    if (value && value.projectId !== projectId)
      throw new Error("The delivery package did not match this project.");
    if (!alive.current) return;
    setPackage(value);
    setDraft(value ? structuredClone(versionOf(value).input) : inputFor(workspace));
    setDirty(false);
    setChildDirty(false);
    setReason("");
    setConfirmed(false);
    setRecord(null);
    setHistoryVersion(null);
    setEpoch((v) => v + 1);
  }
  async function run(action: () => Promise<void>) {
    if (working.current) return false;
    working.current = true;
    setBusy(true);
    refs.current.onBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      return true;
    } catch (caught) {
      if (alive.current)
        setError(
          errors[(caught as { code?: string })?.code ?? ""] ??
            (caught instanceof Error
              ? caught.message
              : "The operation failed. Your entries are retained."),
        );
      return false;
    } finally {
      working.current = false;
      if (alive.current) {
        setBusy(false);
        refs.current.onBusy(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void Promise.resolve().then(
      () =>
        alive.current &&
        run(async () => {
          const value = await read();
          const selected = initialPackageId
            ? await refs.current.request<CplDeliveryPackage>(`${base}/packages/${initialPackageId}`)
            : null;
          if (selected && selected.id !== initialPackageId)
            throw new Error("The package did not match the requested record.");
          accept(selected, value);
        }),
    );
    return () => {
      alive.current = false;
      refs.current.onDirty(false);
      refs.current.onBusy(false);
    };
    // Company/project scope is keyed by the parent; token refresh must retain unsaved edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, organizationId, initialPackageId]);
  function change(patch: Partial<CplDeliveryInput>) {
    setDraft((value) => (value ? { ...value, ...patch } : null));
    setDirty(true);
    setConfirmed(false);
  }
  function discard() {
    setDirty(false);
    setChildDirty(false);
    setReason("");
    setConfirmed(false);
    setRecord(null);
    if (data) setDraft(pkg ? structuredClone(versionOf(pkg).input) : inputFor(data));
    setEpoch((v) => v + 1);
  }
  function navigate(next: typeof area) {
    if (next === area) return;
    navigation.navigate(() => {
      discard();
      setArea(next);
    });
  }
  function select(id: string | null) {
    navigation.navigate(
      () =>
        void run(async () => {
          if (!data) return;
          const value = id
            ? await refs.current.request<CplDeliveryPackage>(`${base}/packages/${id}`)
            : null;
          if (value && value.id !== id) throw new Error("The selected package did not match.");
          accept(value, data);
          setTab("editor");
        }),
    );
  }
  async function mutation(
    path: string,
    input: Record<string, unknown>,
    message: string,
    selectPackage = false,
  ) {
    return run(async () => {
      const result = await refs.current.request<CplDeliveryPackage | unknown>(path, {
        ...input,
        idempotencyKey: key(path, input),
      });
      if (selectPackage) {
        const saved = result as CplDeliveryPackage;
        if (
          !saved ||
          saved.projectId !== projectId ||
          typeof saved.id !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
            saved.id,
          ) ||
          (pkg && path.startsWith(`${base}/packages/${pkg.id}/`) && saved.id !== pkg.id)
        )
          throw new Error(
            "The saved response did not match the selected package and project. Your entries are retained.",
          );
      }
      const workspace = await read();
      const id = selectPackage ? (result as CplDeliveryPackage).id : pkg?.id;
      const updated = id
        ? (workspace.packages.find((p) => p.id === id) ??
          (await refs.current.request<CplDeliveryPackage>(`${base}/packages/${id}`)))
        : null;
      if (selectPackage && !updated)
        throw new Error("The saved package readback is unavailable. Retry with the same entries.");
      accept(updated, workspace);
      delete attempts.current[path];
      setNotice(message);
    });
  }
  async function save() {
    if (!draft) return;
    try {
      const input = normalizeCplDeliveryInput(draft);
      const historical = pkg && ["manually_sent", "acknowledged"].includes(pkg.state);
      if (historical && !reason.trim()) {
        setError("Record why a new package revision is needed. The prior send remains in history.");
        return;
      }
      await mutation(
        pkg ? `${base}/packages/${pkg.id}/${historical ? "revise" : "save"}` : `${base}/packages`,
        {
          input,
          ...(pkg ? { expectedRevision: pkg.revision } : {}),
          ...(historical ? { reason } : {}),
        },
        "Delivery package version saved as a draft. Recipient confirmation and readiness must be reviewed again.",
        true,
      );
    } catch (caught) {
      setError(
        errors[(caught as { code?: string })?.code ?? ""] ??
          "Enter a subject and select at least one approved report PDF.",
      );
    }
  }
  async function packageAction(action: string, input: Record<string, unknown>, message: string) {
    if (!pkg) return false;
    return mutation(
      `${base}/packages/${pkg.id}/${action}`,
      { ...input, expectedRevision: pkg.revision },
      message,
      true,
    );
  }
  const selected = pkg?.versions.find((v) => v.version === (historyVersion ?? pkg.currentVersion));
  const editable = Boolean(data?.permissions.canWrite),
    historical = Boolean(pkg && ["manually_sent", "acknowledged"].includes(pkg.state));
  return (
    <section className={css.shell} aria-label="Delivery and readiness">
      {navigation.dialog}
      <header className={css.heading}>
        <div>
          <p className={styles.eyebrow}>PROJECT HANDOFF</p>
          <h2>Delivery & readiness</h2>
          <p className={css.hint}>
            Prepare approved files, record human delivery, and evaluate your company’s actual
            requirements.
          </p>
        </div>
        <button
          type="button"
          className={styles.secondary}
          disabled={busy}
          onClick={() =>
            navigation.navigate(
              () =>
                void run(async () => {
                  const value = await read();
                  const current = pkg
                    ? (value.packages.find((p) => p.id === pkg.id) ??
                      (await refs.current.request<CplDeliveryPackage>(
                        `${base}/packages/${pkg.id}`,
                      )))
                    : null;
                  accept(current, value);
                  setNotice("Saved delivery and current readiness refreshed.");
                }),
            )
          }
        >
          Refresh delivery & readiness
        </button>
      </header>
      <nav className={forms.tabs} aria-label="Delivery sections">
        {(
          [
            ["packages", "Delivery packages"],
            ["readiness", "Closeout & invoice readiness"],
            ["policy", "Readiness policies"],
            ["approvals", "Approved artifacts"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            disabled={busy}
            key={value}
            aria-current={area === value ? "page" : undefined}
            onClick={() => navigate(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error ? (
        <p role="alert" className={`${styles.notice} ${styles.error}`}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      ) : null}
      {!data || !draft ? (
        <p role="status" className={styles.muted}>
          {error
            ? "Delivery could not be loaded. Existing project and report records remain available."
            : "Loading saved packages and current facts…"}
        </p>
      ) : (
        <>
          {area === "approvals" ? (
            <ApprovedArtifacts
              key={`approvals:${epoch}`}
              data={data}
              busy={busy}
              onDirty={setChildDirty}
              onWithdraw={(reportId, version, reason) =>
                mutation(
                  `${base}/reports/${reportId}/withdraw`,
                  { version, reason },
                  "Approval withdrawal recorded for the selected version. Historical files and delivery records remain retained.",
                )
              }
              onOpenReport={
                onOpenReport
                  ? (id, version) =>
                      navigation.navigate(() => {
                        discard();
                        refs.current.onOpenReport?.(id, version);
                      })
                  : undefined
              }
            />
          ) : null}
          {area === "policy" ? (
            <ReadinessPolicy
              key={`policy:${epoch}`}
              data={data}
              busy={busy}
              onDirty={setChildDirty}
              onSave={(input, expectedVersion) =>
                mutation(
                  `${base}/policy`,
                  { input, expectedVersion },
                  "Company readiness policy version saved. Current facts were re-evaluated.",
                )
              }
            />
          ) : null}
          {area === "readiness" ? (
            <CloseoutReadiness
              key={`facts:${epoch}`}
              data={data}
              organizationId={organizationId}
              busy={busy}
              onDirty={setChildDirty}
              onSave={(input, expectedRevision) =>
                mutation(
                  `${base}/closeout`,
                  { input, expectedRevision },
                  "Supporting facts saved. Current readiness was re-evaluated.",
                )
              }
              onOverride={(key, evidenceHash, active, reason) =>
                mutation(
                  `${base}/override`,
                  { key, evidenceHash, active, reason },
                  "Authorized override recorded against the reviewed facts. The underlying facts remain unchanged.",
                )
              }
            />
          ) : null}
          {area === "packages" ? (
            <div className={css.layout}>
              <aside className={css.records} aria-label="Delivery packages">
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={busy || !editable}
                  onClick={() => select(null)}
                >
                  New delivery package
                </button>
                {data.packages.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={busy}
                    className={`${css.record} ${pkg?.id === item.id ? css.selected : ""}`}
                    aria-pressed={pkg?.id === item.id}
                    onClick={() => select(item.id)}
                  >
                    <span className={css.tag}>{stateLabels[item.state]}</span>
                    <strong>{item.reference}</strong>
                    <span>Package version {item.currentVersion}</span>
                  </button>
                ))}
                {!data.packages.length ? (
                  <p className={css.hint}>
                    No packages yet. An approved PDF is required; a draft report cannot be
                    delivered.
                  </p>
                ) : null}
              </aside>
              <div className={css.shell}>
                {pkg ? (
                  <nav className={forms.tabs} aria-label="Package views">
                    {(
                      [
                        ["editor", "Prepare & record"],
                        ["preview", "Customer package preview"],
                        ["history", "Package history"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        disabled={busy}
                        aria-current={tab === value ? "page" : undefined}
                        onClick={() => {
                          if (tab !== value)
                            navigation.navigate(() => {
                              discard();
                              setTab(value);
                              setHistoryVersion(null);
                            });
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </nav>
                ) : null}
                {tab === "preview" && pkg && selected ? (
                  <PackageDocument
                    pkg={pkg}
                    version={selected}
                    organizationId={organizationId}
                    base={base}
                    onCopy={() =>
                      void run(async () => {
                        const v = selected;
                        await navigator.clipboard.writeText(
                          `To: ${v.input.recipient}\nSubject: ${v.input.subject}\n\n${v.input.message}`,
                        );
                        setNotice("Saved message copied. No delivery was recorded.");
                      })
                    }
                  />
                ) : null}
                {tab === "editor" ? (
                  <section className={styles.panel}>
                    <p className={styles.eyebrow}>
                      {pkg ? `${pkg.reference} · ${stateLabels[pkg.state]}` : "NEW PACKAGE"}
                    </p>
                    <h3>
                      {pkg
                        ? `Prepare package version ${pkg.currentVersion}`
                        : "Prepare an approved deliverable"}
                    </h3>
                    <p className={css.hint}>
                      Customer-facing fields only. Keep private notes, access codes and unrelated
                      evidence out of this message. Saving changes creates a new draft and
                      invalidates ready status.
                    </p>
                    <form
                      className={forms.form}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                      }}
                    >
                      <fieldset
                        className={styles.fieldset}
                        disabled={busy || !editable || Boolean(record)}
                      >
                        <div className={forms.grid}>
                          <label className={styles.field}>
                            Customer name
                            <input
                              required
                              maxLength={240}
                              value={draft.customerName}
                              onChange={(e) => change({ customerName: e.target.value })}
                            />
                          </label>
                          <label className={styles.field}>
                            Contact name
                            <input
                              maxLength={240}
                              value={draft.contactName}
                              onChange={(e) => change({ contactName: e.target.value })}
                            />
                          </label>
                        </div>
                        <label className={styles.field}>
                          Intended recipient
                          <input
                            maxLength={320}
                            value={draft.recipient}
                            onChange={(e) => change({ recipient: e.target.value })}
                          />
                          <small>
                            Confirm the actual recipient before marking this package ready.
                          </small>
                        </label>
                        <label className={styles.field}>
                          Customer subject
                          <input
                            required
                            maxLength={240}
                            value={draft.subject}
                            onChange={(e) => change({ subject: e.target.value })}
                          />
                        </label>
                        <label className={styles.field}>
                          Customer message
                          <textarea
                            maxLength={20000}
                            value={draft.message}
                            onChange={(e) => change({ message: e.target.value })}
                          />
                        </label>
                        <h3>Choose exact approved PDF versions</h3>
                        {data.approvedReports.map((report) => {
                          const chosen = draft.attachments.some(
                            (a) => a.reportId === report.reportId && a.version === report.version,
                          );
                          return (
                            <div
                              className={css.attachment}
                              key={`${report.reportId}:${report.version}`}
                            >
                              <label className={css.check}>
                                <input
                                  type="checkbox"
                                  checked={chosen}
                                  disabled={report.withdrawn && !chosen}
                                  onChange={(e) =>
                                    change({
                                      attachments: e.target.checked
                                        ? [
                                            ...draft.attachments,
                                            { reportId: report.reportId, version: report.version },
                                          ]
                                        : draft.attachments.filter(
                                            (a) =>
                                              a.reportId !== report.reportId ||
                                              a.version !== report.version,
                                          ),
                                    })
                                  }
                                />
                                <span>
                                  <strong>
                                    {report.reference} · approved version {report.version}
                                  </strong>
                                  <br />
                                  {report.title}
                                  <br />
                                  {report.latestEditableVersion !== report.version
                                    ? `Current editable report is version ${report.latestEditableVersion}; it does not replace this PDF.`
                                    : "Exact approved artifact"}
                                  {report.withdrawn
                                    ? ` Approval withdrawn: ${report.withdrawalReason}`
                                    : ""}
                                </span>
                              </label>
                              {onOpenReport ? (
                                <button
                                  type="button"
                                  className={styles.secondary}
                                  onClick={() =>
                                    navigation.navigate(() => {
                                      discard();
                                      refs.current.onOpenReport?.(report.reportId, report.version);
                                    })
                                  }
                                >
                                  Open report version {report.version}
                                </button>
                              ) : null}
                            </div>
                          );
                        })}
                        {!data.approvedReports.length ? (
                          <p className={styles.warning}>
                            No approved report artifact is available for this project.
                          </p>
                        ) : null}
                        {historical ? (
                          <label className={styles.field}>
                            Reason for a new package revision
                            <textarea
                              required
                              maxLength={2000}
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                            />
                            <small>
                              The prior package, manual send and acknowledgment stay unchanged.
                            </small>
                          </label>
                        ) : null}
                        <div className={styles.actions}>
                          <button
                            type="submit"
                            className={styles.primary}
                            disabled={
                              !dirty || !draft.attachments.length || (historical && !reason.trim())
                            }
                          >
                            {historical
                              ? "Create revised draft package"
                              : "Save draft package version"}
                          </button>
                          <span>{dirty ? "Unsaved changes" : "Saved content"}</span>
                        </div>
                      </fieldset>
                    </form>
                    {pkg ? (
                      <div className={forms.section}>
                        <h3>Readiness & human delivery</h3>
                        {pkg.readiness.reasons.length ? (
                          <ul>
                            {pkg.readiness.reasons.map((message, i) => (
                              <li key={`${i}:${message}`}>{message}</li>
                            ))}
                          </ul>
                        ) : null}
                        {data.permissions.canConfirm && pkg.state === "draft" ? (
                          <>
                            <label className={css.check}>
                              <input
                                type="checkbox"
                                disabled={busy || dirty}
                                checked={confirmed}
                                onChange={(e) => {
                                  setConfirmed(e.target.checked);
                                  setChildDirty(e.target.checked);
                                }}
                              />
                              <span>
                                I reviewed the saved recipient, message and exact approved
                                attachments.
                              </span>
                            </label>
                            <button
                              type="button"
                              className={styles.primary}
                              disabled={busy || dirty || !confirmed || !pkg.readiness.canMarkReady}
                              onClick={() =>
                                void packageAction(
                                  "ready",
                                  { recipientConfirmed: true },
                                  "Saved package marked ready. It has not been sent.",
                                )
                              }
                            >
                              Mark saved package ready
                            </button>
                          </>
                        ) : null}
                        {data.permissions.canWrite && ["ready", "exported"].includes(pkg.state) ? (
                          <button
                            type="button"
                            className={styles.secondary}
                            disabled={
                              busy ||
                              dirty ||
                              childDirty ||
                              Boolean(reason) ||
                              Boolean(record) ||
                              !pkg.readiness.ready
                            }
                            onClick={() =>
                              void packageAction(
                                "export",
                                {},
                                "Package export recorded. Download the manifest or message; this is not a send event.",
                              )
                            }
                          >
                            Record package export
                          </button>
                        ) : null}
                        {["exported", "manually_sent", "acknowledged"].includes(pkg.state) ? (
                          <div className={styles.actions}>
                            <a
                              className={`${styles.button} ${styles.secondary}`}
                              href={`${base}/packages/${pkg.id}/manifest?version=${pkg.currentVersion}&organization=${encodeURIComponent(organizationId)}`}
                            >
                              Download saved manifest v{pkg.currentVersion}
                            </a>
                            <a
                              className={`${styles.button} ${styles.secondary}`}
                              href={`${base}/packages/${pkg.id}/message?version=${pkg.currentVersion}&organization=${encodeURIComponent(organizationId)}`}
                            >
                              Download saved message v{pkg.currentVersion}
                            </a>
                          </div>
                        ) : null}
                        {!record &&
                        data.permissions.canConfirm &&
                        ["ready", "exported"].includes(pkg.state) ? (
                          <button
                            type="button"
                            className={styles.secondary}
                            disabled={busy || dirty || !pkg.readiness.ready}
                            onClick={() =>
                              navigation.navigate(() => {
                                setChildDirty(false);
                                setRecord("sent");
                              })
                            }
                          >
                            Record a manual send
                          </button>
                        ) : null}
                        {!record && data.permissions.canConfirm && pkg.state === "manually_sent" ? (
                          <button
                            type="button"
                            className={styles.secondary}
                            disabled={busy || dirty}
                            onClick={() =>
                              navigation.navigate(() => {
                                setChildDirty(false);
                                setRecord("acknowledge");
                              })
                            }
                          >
                            Record customer acknowledgment
                          </button>
                        ) : null}
                        {record ? (
                          <>
                            <HumanDeliveryRecord
                              key={`${pkg.id}:${pkg.currentVersion}:${record}:${epoch}`}
                              kind={record}
                              recipient={versionOf(pkg).input.recipient}
                              busy={busy || dirty}
                              onDirty={setChildDirty}
                              onSave={(input) =>
                                packageAction(
                                  record === "sent" ? "record-sent" : "acknowledge",
                                  { input },
                                  record === "sent"
                                    ? "Manual send recorded with your stated time, recipient and evidence. No provider send was performed."
                                    : "Acknowledgment evidence recorded for this exact package version.",
                                )
                              }
                            />
                            <button
                              type="button"
                              className={styles.secondary}
                              disabled={busy}
                              onClick={() =>
                                navigation.navigate(() => {
                                  setRecord(null);
                                  setChildDirty(false);
                                })
                              }
                            >
                              Cancel delivery record entry
                            </button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                ) : null}
                {tab === "history" && pkg ? (
                  <section className={styles.panel}>
                    <h3>Saved package versions</h3>
                    <ul className={css.records}>
                      {pkg.versions.map((version) => (
                        <li key={version.version} className={css.record}>
                          <strong>
                            Package version {version.version} · {stateLabels[version.state]}
                          </strong>
                          <span>
                            {new Date(version.preparedAt).toLocaleString()} ·{" "}
                            {version.attachments
                              .map((a) => `${a.reference} v${a.version}`)
                              .join(", ")}
                          </span>
                          <span title={`Identity: ${version.preparedByIdentityId}`}>
                            Prepared by: {memberName(version.preparedByIdentityId)}
                          </span>
                          <button
                            type="button"
                            className={styles.secondary}
                            onClick={() => {
                              setHistoryVersion(version.version);
                              setTab("preview");
                            }}
                          >
                            Preview package version {version.version}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <h3>Delivery history</h3>
                    <ol className={css.timeline}>
                      {pkg.events.map((event) => (
                        <li key={event.id}>
                          <strong>{event.action.replaceAll("_", " ").replaceAll(".", " ")}</strong>
                          <p>
                            Package v{event.version} · {new Date(event.createdAt).toLocaleString()}
                          </p>
                          <p title={`Identity: ${event.actorIdentityId}`}>
                            Recorded by: {memberName(event.actorIdentityId)}
                          </p>
                          {Object.entries(historyLabels).map(([key, label]) => {
                            const value = event.details[key];
                            if (typeof value !== "string" || !value.trim()) return null;
                            const isTime = key === "sentAt" || key === "acknowledgedAt";
                            const time = isTime ? new Date(value) : null;
                            return (
                              <p key={key}>
                                {label}:{" "}
                                {time && Number.isFinite(time.getTime()) ? (
                                  <time dateTime={value} title={value}>
                                    {time.toLocaleString()}
                                  </time>
                                ) : (
                                  value
                                )}
                              </p>
                            );
                          })}
                        </li>
                      ))}
                    </ol>
                    <p className={css.hint}>
                      Manual records describe a person’s stated action. They are not generated
                      provider receipts.
                    </p>
                  </section>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
