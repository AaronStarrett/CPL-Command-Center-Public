"use client";

import { useState } from "react";
import type {
  CplCloseoutFactsInput,
  CplCloseoutFactKey,
  CplCloseoutPolicy,
  CplCloseoutPolicyInput,
  CplDeliveryWorkspace,
} from "@bea/domain/cpl-delivery";
import { money } from "./commercial-ui";
import { useUnsavedNavigation } from "./commercial-navigation";
import styles from "./workspace.module.css";
import forms from "./execution.module.css";
import css from "./action-center.module.css";

const requirements = [
  ["requireAward", "Award linked"],
  ["requireWorkCompleted", "Required work completed"],
  ["requireApprovedReport", "Selected report version approved"],
  ["requireDelivery", "Selected deliverable manually recorded sent"],
  ["requirePurchaseOrder", "Purchase order recorded"],
  ["requireIssuesDisposed", "Open issues resolved or accepted with reasons"],
] as const;
export function ApprovedArtifacts({
  data,
  busy,
  onDirty,
  onWithdraw,
  onOpenReport,
}: {
  data: CplDeliveryWorkspace;
  busy: boolean;
  onDirty: (value: boolean) => void;
  onWithdraw: (reportId: string, version: number, reason: string) => Promise<boolean>;
  onOpenReport?: ((reportId: string, version: number) => void) | undefined;
}) {
  const [choice, setChoice] = useState(""),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const selected = data.approvedReports.find(
    (report) => `${report.reportId}:${report.version}` === choice,
  );
  return (
    <section className={styles.panel}>
      <p className={styles.eyebrow}>RETAINED APPROVED VERSIONS</p>
      <h3>Approved artifact availability</h3>
      <p className={css.hint}>
        Opening a report revision keeps earlier approved PDFs. Withdraw an earlier approval only
        through an explicit authorized decision. The file and delivery history remain retained; new
        preparation and sending will recheck its eligibility.
      </p>
      <ul className={css.records}>
        {data.approvedReports.map((report) => (
          <li key={`${report.reportId}:${report.version}`} className={css.record}>
            <strong>
              {report.reference} · approved version {report.version}
            </strong>
            <p>
              {report.withdrawn
                ? `Approval withdrawn: ${report.withdrawalReason}`
                : "Approval retained"}{" "}
              · current editable report version {report.latestEditableVersion}
            </p>
            {onOpenReport ? (
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => onOpenReport(report.reportId, report.version)}
              >
                Inspect report version {report.version}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {data.permissions.canWithdrawApproval ? (
        <form
          className={forms.form}
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              if (!selected || !confirmed || !reason.trim()) return;
              if (await onWithdraw(selected.reportId, selected.version, reason)) {
                setChoice("");
                setReason("");
                setConfirmed(false);
                onDirty(false);
              }
            })();
          }}
        >
          <fieldset className={styles.fieldset} disabled={busy}>
            <label className={styles.field}>
              Approval to withdraw
              <select
                value={choice}
                required
                onChange={(e) => {
                  setChoice(e.target.value);
                  setConfirmed(false);
                  onDirty(Boolean(e.target.value) || Boolean(reason));
                }}
              >
                <option value="">Choose an exact approved version</option>
                {data.approvedReports
                  .filter((report) => !report.withdrawn)
                  .map((report) => (
                    <option
                      key={`${report.reportId}:${report.version}`}
                      value={`${report.reportId}:${report.version}`}
                    >
                      {report.reference} · version {report.version}
                    </option>
                  ))}
              </select>
            </label>
            <label className={styles.field}>
              Approval withdrawal reason
              <textarea
                required
                maxLength={2000}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setConfirmed(false);
                  onDirty(Boolean(choice) || Boolean(e.target.value));
                }}
              />
            </label>
            <label className={css.check}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => {
                  setConfirmed(e.target.checked);
                  onDirty(Boolean(choice) || Boolean(reason) || e.target.checked);
                }}
              />
              <span>
                I intend to withdraw this exact version’s approval. This is separate from opening a
                new editable report draft.
              </span>
            </label>
            <button
              className={styles.secondary}
              type="submit"
              disabled={!selected || !reason.trim() || !confirmed}
            >
              Record approval withdrawal
            </button>
          </fieldset>
        </form>
      ) : null}
    </section>
  );
}
export function ReadinessPolicy({
  data,
  busy,
  onDirty,
  onSave,
}: {
  data: CplDeliveryWorkspace;
  busy: boolean;
  onDirty: (v: boolean) => void;
  onSave: (input: CplCloseoutPolicyInput, expectedVersion: number) => Promise<boolean>;
}) {
  const blank = (): CplCloseoutPolicyInput => ({
    serviceKey: data.project.serviceKey || "*",
    name: "",
    requireAward: false,
    requireWorkCompleted: false,
    requireApprovedReport: false,
    requireDelivery: false,
    requirePurchaseOrder: false,
    requireIssuesDisposed: false,
  });
  const [input, setInput] = useState(blank),
    [prior, setPrior] = useState<CplCloseoutPolicy | null>(null),
    [dirty, setDirty] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const navigation = useUnsavedNavigation(dirty);
  function change(patch: Partial<CplCloseoutPolicyInput>) {
    setInput((value) => ({ ...value, ...patch }));
    setDirty(true);
    onDirty(true);
    setConfirmed(false);
  }
  function select(policy: CplCloseoutPolicy | null) {
    navigation.navigate(() => {
      setPrior(policy);
      setInput(policy ? { ...policy } : blank());
      setDirty(false);
      onDirty(false);
      setConfirmed(false);
    });
  }
  return (
    <section className={styles.panel}>
      {navigation.dialog}
      <p className={styles.eyebrow}>COMPANY RULES</p>
      <h3>Closeout & invoice-readiness policy</h3>
      <p className={css.hint}>
        Choose your actual requirements. Final delivery is optional: deposits and milestone billing
        may follow a different policy. A readiness decision does not issue an invoice or record
        payment.
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          disabled={busy}
          onClick={() => select(null)}
        >
          New readiness policy
        </button>
        {data.policies.map((policy) => (
          <button
            key={`${policy.serviceKey}:${policy.version}`}
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={() => select(policy)}
          >
            {policy.name} · v{policy.version}
          </button>
        ))}
      </div>
      <form
        className={forms.form}
        onSubmit={(e) => {
          e.preventDefault();
          void (async () => {
            if (!confirmed) return;
            if (await onSave(input, prior?.version ?? 0)) {
              setDirty(false);
              onDirty(false);
              setPrior(null);
              setInput(blank());
              setConfirmed(false);
            }
          })();
        }}
      >
        <fieldset className={styles.fieldset} disabled={busy || !data.permissions.canConfigure}>
          <label className={styles.field}>
            Policy name
            <input
              required
              maxLength={240}
              value={input.name}
              onChange={(e) => change({ name: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            Applies to service
            <input
              required
              maxLength={240}
              value={input.serviceKey}
              disabled={Boolean(prior)}
              onChange={(e) => change({ serviceKey: e.target.value })}
            />
            <small>
              Use the exact service name, or * for the company fallback. Current project service:{" "}
              {data.project.serviceKey || "Not recorded"}.
            </small>
          </label>
          {requirements.map(([key, label]) => (
            <label key={key} className={css.check}>
              <input
                type="checkbox"
                checked={input[key]}
                onChange={(e) => change({ [key]: e.target.checked })}
              />
              <span>{label}</span>
            </label>
          ))}
          <label className={css.check}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I reviewed these company requirements. Unselected facts will remain visible but will
              not block this policy.
            </span>
          </label>
          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={!dirty || !confirmed}>
              Save readiness policy version
            </button>
            <span className={css.hint}>
              {prior ? `Based on version ${prior.version}` : "New policy"}
            </span>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
export function CloseoutReadiness({
  data,
  busy,
  organizationId,
  onDirty,
  onSave,
  onOverride,
}: {
  data: CplDeliveryWorkspace;
  busy: boolean;
  organizationId: string;
  onDirty: (v: boolean) => void;
  onSave: (input: CplCloseoutFactsInput, expectedRevision: number) => Promise<boolean>;
  onOverride: (
    key: CplCloseoutFactKey,
    evidenceHash: string,
    active: boolean,
    reason: string,
  ) => Promise<boolean>;
}) {
  const [input, setInput] = useState<CplCloseoutFactsInput>(() =>
      structuredClone(data.readiness.facts),
    ),
    [dirty, setDirty] = useState(false),
    [reasons, setReasons] = useState<Record<string, string>>({});
  const readiness = data.readiness;
  function change(patch: Partial<CplCloseoutFactsInput>) {
    setInput((v) => ({ ...v, ...patch }));
    setDirty(true);
    onDirty(true);
  }
  function reason(key: string, value: string) {
    setReasons((current) => ({ ...current, [key]: value }));
    onDirty(dirty || Object.entries({ ...reasons, [key]: value }).some(([, v]) => Boolean(v)));
  }
  const selected = input.requiredReport
    ? `${input.requiredReport.reportId}:${input.requiredReport.version}`
    : "";
  return (
    <div className={css.shell}>
      <div className={css.facts}>
        <section className={css.fact}>
          <h3>Operations</h3>
          <strong>
            {readiness.operationalCompletion ? "Required work completed" : "Work remains open"}
          </strong>
          <p className={css.hint}>Project status: {readiness.projectStatus.replaceAll("_", " ")}</p>
        </section>
        <section className={css.fact}>
          <h3>Delivery</h3>
          <strong>
            {readiness.deliveryRecorded
              ? "Delivery recorded by a person"
              : "No qualifying send recorded"}
          </strong>
          <p className={css.hint}>Preparation and export are separate from sending.</p>
        </section>
        <section className={css.fact}>
          <h3>Invoice readiness</h3>
          <strong>
            {readiness.status === "not_configured"
              ? "Readiness policy not configured"
              : readiness.status === "ready"
                ? "Ready under configured policy"
                : "Requirements remain"}
          </strong>
          <p className={css.hint}>Invoice issued and payment received remain outside this phase.</p>
        </section>
      </div>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>CURRENT FACTS</p>
        <h3>
          {readiness.policy
            ? `${readiness.policy.name} · policy v${readiness.policy.version}`
            : "Configure a policy to evaluate readiness"}
        </h3>
        <p className={css.hint}>
          Evaluated {new Date(readiness.evaluatedAt).toLocaleString()}. Reopened work and changed
          evidence are re-evaluated; readiness is not permanently latched.
        </p>
        <ul className={css.records}>
          {readiness.checks.map((check) => (
            <li className={css.record} key={check.key}>
              <div className={css.meta}>
                <strong>{check.key.replaceAll("_", " ")}</strong>
                <span>{check.required ? "Required by policy" : "Not required by policy"}</span>
                <span>{check.met ? "Fact satisfied" : "Fact not satisfied"}</span>
              </div>
              <p>{check.message}</p>
              {check.override ? (
                <p>
                  Authorized override: {check.override.reason} ·{" "}
                  {new Date(check.override.createdAt).toLocaleString()}. The underlying fact remains{" "}
                  {check.met ? "satisfied" : "unsatisfied"}.
                </p>
              ) : null}
              {data.permissions.canOverride &&
              (check.override || (check.required && !check.met)) ? (
                <div className={forms.form}>
                  <label className={styles.field}>
                    Override reason for {check.key.replaceAll("_", " ")}
                    <textarea
                      disabled={busy || dirty}
                      value={reasons[check.key] ?? ""}
                      maxLength={2000}
                      onChange={(e) => reason(check.key, e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={
                      busy ||
                      dirty ||
                      !reasons[check.key]?.trim() ||
                      Object.entries(reasons).some(
                        ([key, value]) => key !== check.key && value.trim(),
                      )
                    }
                    onClick={() =>
                      void (async () => {
                        if (
                          await onOverride(
                            check.key,
                            check.evidenceHash,
                            !check.override,
                            reasons[check.key]!,
                          )
                        ) {
                          reason(check.key, "");
                        }
                      })()
                    }
                  >
                    {check.override ? "Remove override" : "Record authorized override"}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.panel}>
        <h3>Supporting facts & issue dispositions</h3>
        <form
          className={forms.form}
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              if (await onSave(input, readiness.facts.revision)) {
                setDirty(false);
                onDirty(Object.values(reasons).some(Boolean));
              }
            })();
          }}
        >
          <fieldset className={styles.fieldset} disabled={busy || !data.permissions.canConfirm}>
            <label className={styles.field}>
              Purchase order / billing reference
              <input
                maxLength={240}
                value={input.purchaseOrder}
                onChange={(e) => change({ purchaseOrder: e.target.value })}
              />
              <small>
                Supplemental handoff information; the awarded commercial snapshot is unchanged.
              </small>
            </label>
            <label className={styles.field}>
              Required approved deliverable
              <select
                value={selected}
                onChange={(e) => {
                  const report = data.approvedReports.find(
                    (r) => `${r.reportId}:${r.version}` === e.target.value,
                  );
                  change({
                    requiredReport: report
                      ? { reportId: report.reportId, version: report.version }
                      : null,
                  });
                }}
              >
                <option value="">Not selected</option>
                {data.approvedReports.map((report) => (
                  <option
                    key={`${report.reportId}:${report.version}`}
                    value={`${report.reportId}:${report.version}`}
                    disabled={report.withdrawn}
                  >
                    {report.reference} · approved version {report.version}
                    {report.withdrawn ? " · approval withdrawn" : ""}
                  </option>
                ))}
              </select>
              <small>
                Select the version relevant to this handoff. A higher editable version is not
                automatically deliverable.
              </small>
            </label>
            {readiness.issues.map((issue) => {
              const saved = input.issueDispositions.find(
                (d) => d.sourceKey === issue.sourceKey && d.factHash === issue.factHash,
              );
              return (
                <div key={issue.sourceKey} className={css.record}>
                  <h3>{issue.title}</h3>
                  <p className={css.hint}>
                    {issue.disposed
                      ? `Recorded disposition: ${issue.reason}`
                      : "Unresolved source issue"}
                  </p>
                  <label className={styles.field}>
                    Disposition for {issue.title}
                    <select
                      value={saved?.disposition ?? ""}
                      onChange={(e) => {
                        const remaining = input.issueDispositions.filter(
                          (d) => d.sourceKey !== issue.sourceKey,
                        );
                        change({
                          issueDispositions: e.target.value
                            ? [
                                ...remaining,
                                {
                                  sourceKey: issue.sourceKey,
                                  factHash: issue.factHash,
                                  disposition: e.target.value as "resolved" | "accepted",
                                  reason: saved?.reason ?? "",
                                },
                              ]
                            : remaining,
                        });
                      }}
                    >
                      <option value="">Leave unresolved</option>
                      <option value="resolved">Resolved by authorized review</option>
                      <option value="accepted">Accepted exception</option>
                    </select>
                  </label>
                  {saved ? (
                    <label className={styles.field}>
                      Disposition reason for {issue.title}
                      <textarea
                        required
                        maxLength={2000}
                        value={saved.reason}
                        onChange={(e) =>
                          change({
                            issueDispositions: input.issueDispositions.map((d) =>
                              d === saved ? { ...d, reason: e.target.value } : d,
                            ),
                          })
                        }
                      />
                    </label>
                  ) : null}
                </div>
              );
            })}
            {input.manualIssues.map((issue, index) => (
              <div className={css.record} key={issue.id}>
                <label className={styles.field}>
                  Additional issue {index + 1}
                  <input
                    required
                    maxLength={240}
                    value={issue.title}
                    onChange={(e) =>
                      change({
                        manualIssues: input.manualIssues.map((i) =>
                          i.id === issue.id ? { ...i, title: e.target.value } : i,
                        ),
                      })
                    }
                  />
                </label>
                <label className={styles.field}>
                  Issue {index + 1} status
                  <select
                    value={issue.status}
                    onChange={(e) =>
                      change({
                        manualIssues: input.manualIssues.map((i) =>
                          i.id === issue.id
                            ? { ...i, status: e.target.value as typeof issue.status }
                            : i,
                        ),
                      })
                    }
                  >
                    <option value="open">Open</option>
                    <option value="resolved">Resolved</option>
                    <option value="accepted">Accepted exception</option>
                  </select>
                </label>
                <label className={styles.field}>
                  Issue {index + 1} reason
                  <textarea
                    maxLength={2000}
                    required={issue.status !== "open"}
                    value={issue.reason}
                    onChange={(e) =>
                      change({
                        manualIssues: input.manualIssues.map((i) =>
                          i.id === issue.id ? { ...i, reason: e.target.value } : i,
                        ),
                      })
                    }
                  />
                </label>
              </div>
            ))}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() =>
                  change({
                    manualIssues: [
                      ...input.manualIssues,
                      { id: crypto.randomUUID(), title: "", status: "open", reason: "" },
                    ],
                  })
                }
              >
                Add handoff issue
              </button>
              <button type="submit" className={styles.primary} disabled={!dirty}>
                Save readiness facts
              </button>
              <span>{dirty ? "Unsaved changes" : "Saved facts"}</span>
            </div>
          </fieldset>
        </form>
      </section>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>INTERNAL BILLING HANDOFF</p>
        <h3>
          {readiness.agreedAmount.label}:{" "}
          {money(readiness.agreedAmount.amountMinor, readiness.agreedAmount.currency)}
        </h3>
        <p>
          From {readiness.agreedAmount.proposalReference} · awarded version{" "}
          {readiness.agreedAmount.proposalVersion}. No current catalog price, new tax or unapproved
          field extra has been substituted.
        </p>
        <p className={css.hint}>
          This export is a human handoff. It is not an invoice, payment request, tax decision or
          revenue record.
        </p>
        <a
          className={`${styles.button} ${styles.secondary}`}
          href={`/api/cpl-delivery/projects/${data.project.id}/billing-handoff?organization=${encodeURIComponent(organizationId)}`}
        >
          Download current billing handoff
        </a>
      </section>
    </div>
  );
}
