"use client";

import { useState } from "react";
import {
  CPL_AUTOMATION_ROLES,
  CPL_AUTOMATION_TRIGGERS,
  normalizeCplAutomationRecipe,
  type CplActionOwner,
  type CplAutomationRecipe,
  type CplAutomationRecipeInput,
  type CplAutomationWorkspace,
} from "@bea/domain/cpl-automation";
import { useUnsavedNavigation } from "./commercial-navigation";
import styles from "./workspace.module.css";
import forms from "./execution.module.css";
import css from "./action-center.module.css";

export const triggerLabels = {
  "lead.ready": "Lead reviewed and ready",
  "proposal.awarded": "Proposal award recorded",
  "fieldwork.submitted": "Field work submitted",
  "report.approved": "Report version approved",
  "delivery.recorded": "Manual delivery recorded",
};
const actionLabels = {
  "lead.ready": "Create the next proposal action",
  "proposal.awarded": "Create or reuse the linked project and create its kickoff action",
  "fieldwork.submitted": "Create the report review action",
  "report.approved": "Prepare a package for the exact approved PDF and create a delivery action",
  "delivery.recorded": "Re-evaluate configured readiness and create a closeout action",
};
export function ownerValue(owner: CplActionOwner) {
  return owner.kind === "person"
    ? `person:${owner.identityId}`
    : owner.kind === "role"
      ? `role:${owner.role}`
      : "unassigned";
}
export function selectedOwner(value: string): CplActionOwner {
  if (value.startsWith("person:"))
    return { kind: "person", identityId: value.slice(7), role: null };
  if (value.startsWith("role:"))
    return {
      kind: "role",
      role: value.slice(5) as CplActionOwner["role"] & string,
      identityId: null,
    };
  return { kind: "unassigned", role: null, identityId: null };
}
export function OwnerOptions({ members }: { members: CplAutomationWorkspace["members"] }) {
  return (
    <>
      <option value="unassigned">Unassigned — visible in the company queue</option>
      <optgroup label="Role queue">
        {CPL_AUTOMATION_ROLES.map((role) => (
          <option key={role} value={`role:${role}`}>
            {role}
          </option>
        ))}
      </optgroup>
      <optgroup label="Current company members">
        {members.map((member) => (
          <option key={member.identityId} value={`person:${member.identityId}`}>
            {member.displayName} · {member.role}
          </option>
        ))}
      </optgroup>
    </>
  );
}
function blank(): CplAutomationRecipeInput {
  return {
    name: "",
    trigger: "lead.ready",
    enabled: false,
    service: null,
    prepareDraft: false,
    templateId: null,
    templateVersion: null,
    templateApprovedForAutomation: false,
    owner: selectedOwner("unassigned"),
    dueAfterHours: null,
    taskTitle: "",
  };
}
export function AutomationRecipes({
  data,
  busy,
  onDirty,
  onSave,
}: {
  data: CplAutomationWorkspace;
  busy: boolean;
  onDirty: (value: boolean) => void;
  onSave: (input: CplAutomationRecipeInput, prior: CplAutomationRecipe | null) => Promise<boolean>;
}) {
  const [prior, setPrior] = useState<CplAutomationRecipe | null>(null);
  const [draft, setDraft] = useState<CplAutomationRecipeInput>(blank);
  const [dirty, setDirty] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState("");
  const navigation = useUnsavedNavigation(dirty);
  const change = (patch: Partial<CplAutomationRecipeInput>) => {
    setDraft((value) => ({ ...value, ...patch }));
    setDirty(true);
    onDirty(true);
    setConfirmed(false);
    setError("");
  };
  function edit(recipe: CplAutomationRecipe | null) {
    navigation.navigate(() => {
      setPrior(recipe);
      setDraft(recipe ? { ...recipe, owner: { ...recipe.owner } } : blank());
      setConfirmed(false);
      setDirty(false);
      onDirty(false);
      setError("");
    });
  }
  const templates = draft.trigger === "lead.ready" ? data.proposalTemplates : data.reportTemplates;
  const canPrepare = draft.trigger === "lead.ready" || draft.trigger === "fieldwork.submitted";
  return (
    <div className={css.layout}>
      {navigation.dialog}
      <aside className={css.records} aria-label="Configured recipes">
        <button
          className={styles.secondary}
          type="button"
          disabled={busy || !data.permissions.canConfigure}
          onClick={() => edit(null)}
        >
          New internal recipe
        </button>
        {data.recipes.map((recipe) => (
          <button
            className={`${css.record} ${prior?.id === recipe.id ? css.selected : ""}`}
            key={`${recipe.id}:${recipe.version}`}
            type="button"
            disabled={busy}
            onClick={() => edit(recipe)}
            aria-pressed={prior?.id === recipe.id}
          >
            <strong>{recipe.name}</strong>
            <span>{triggerLabels[recipe.trigger]}</span>
            <span className={css.meta}>
              Version {recipe.version} · {recipe.enabled ? "Enabled" : "Disabled"}
            </span>
          </button>
        ))}
        {!data.recipes.length ? (
          <p className={css.hint}>No recipes configured. Nothing is enabled automatically.</p>
        ) : null}
      </aside>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>COMPANY AUTOMATION</p>
        <h3>{prior ? `Edit ${prior.name}` : "Configure an internal handoff"}</h3>
        <p className={css.hint}>
          Each save records a new configuration version. Enabling applies to future events; it does
          not backfill existing records. A saved recipe never approves a proposal or report, sends a
          message, or creates an invoice.
        </p>
        <form
          className={forms.form}
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              try {
                const input = normalizeCplAutomationRecipe(draft);
                if (input.enabled && !confirmed) {
                  setError("Review and confirm this enabled configuration before saving.");
                  return;
                }
                if (await onSave(input, prior)) {
                  setDirty(false);
                  onDirty(false);
                  setConfirmed(false);
                  setPrior(null);
                  setDraft(blank());
                }
              } catch {
                setError(
                  "Review the recipe name, task title, due hours and selected template authorization.",
                );
              }
            })();
          }}
        >
          <fieldset className={styles.fieldset} disabled={busy || !data.permissions.canConfigure}>
            <label className={styles.field}>
              Recipe name
              <input
                required
                maxLength={160}
                value={draft.name}
                onChange={(e) => change({ name: e.target.value })}
              />
            </label>
            <div className={forms.grid}>
              <label className={styles.field}>
                When this happens
                <select
                  value={draft.trigger}
                  onChange={(e) =>
                    change({
                      trigger: e.target.value as CplAutomationRecipeInput["trigger"],
                      prepareDraft: false,
                      templateId: null,
                      templateVersion: null,
                      templateApprovedForAutomation: false,
                    })
                  }
                >
                  {CPL_AUTOMATION_TRIGGERS.map((trigger) => (
                    <option key={trigger} value={trigger}>
                      {triggerLabels[trigger]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                Service filter (optional)
                <input
                  maxLength={240}
                  value={draft.service ?? ""}
                  onChange={(e) => change({ service: e.target.value || null })}
                />
                <small>Exact service name. Leave blank to match any service.</small>
              </label>
            </div>
            <div className={styles.notice}>
              <strong>Supported action</strong>
              <p>{actionLabels[draft.trigger]}</p>
            </div>
            {canPrepare ? (
              <>
                <label className={css.check}>
                  <input
                    type="checkbox"
                    checked={draft.prepareDraft}
                    onChange={(e) =>
                      change({
                        prepareDraft: e.target.checked,
                        templateId: null,
                        templateVersion: null,
                        templateApprovedForAutomation: false,
                      })
                    }
                  />
                  <span>
                    Also prepare a linked {draft.trigger === "lead.ready" ? "proposal" : "report"}{" "}
                    draft using confirmed source information
                  </span>
                </label>
                {draft.prepareDraft ? (
                  <>
                    <label className={styles.field}>
                      Approved template for automatic drafts
                      <select
                        required
                        value={
                          draft.templateId ? `${draft.templateId}:${draft.templateVersion}` : ""
                        }
                        onChange={(e) => {
                          const selected = templates.find(
                            (t) => `${t.id}:${t.version}` === e.target.value,
                          );
                          change({
                            templateId: selected?.id ?? null,
                            templateVersion: selected?.version ?? null,
                            templateApprovedForAutomation: false,
                          });
                        }}
                      >
                        <option value="">Choose a company template version</option>
                        {templates.map((t) => (
                          <option key={`${t.id}:${t.version}`} value={`${t.id}:${t.version}`}>
                            {t.name} · version {t.version}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={css.check}>
                      <input
                        type="checkbox"
                        checked={draft.templateApprovedForAutomation}
                        onChange={(e) =>
                          change({ templateApprovedForAutomation: e.target.checked })
                        }
                      />
                      <span>
                        I authorize this exact template version for automatic draft preparation.
                        Drafts still require human review.
                      </span>
                    </label>
                  </>
                ) : null}
              </>
            ) : null}
            <label className={styles.field}>
              Action title
              <input
                required
                maxLength={240}
                value={draft.taskTitle}
                onChange={(e) => change({ taskTitle: e.target.value })}
              />
              <small>Tell the assigned person what to do next.</small>
            </label>
            <div className={forms.grid}>
              <label className={styles.field}>
                Action owner
                <select
                  value={ownerValue(draft.owner)}
                  onChange={(e) => change({ owner: selectedOwner(e.target.value) })}
                >
                  <OwnerOptions members={data.members} />
                </select>
              </label>
              <label className={styles.field}>
                Due after event (hours, optional)
                <input
                  type="number"
                  min={0}
                  max={8760}
                  step={1}
                  value={draft.dueAfterHours ?? ""}
                  onChange={(e) =>
                    change({ dueAfterHours: e.target.value === "" ? null : Number(e.target.value) })
                  }
                />
                <small>
                  Elapsed hours from the recorded event. Blank leaves the deadline unconfigured.
                </small>
              </label>
            </div>
            <label className={css.check}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => change({ enabled: e.target.checked })}
              />
              <span>Enable this recipe for future matching events</span>
            </label>
            {draft.enabled ? (
              <label className={css.check}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>
                  I reviewed the action, ownership, deadline and template. This version may perform
                  the supported internal handoff without a separate approval for each run.
                </span>
              </label>
            ) : null}
            {error ? (
              <p role="alert" className={`${styles.notice} ${styles.error}`}>
                {error}
              </p>
            ) : null}
            <div className={styles.actions}>
              <button
                className={styles.primary}
                disabled={!dirty || (draft.enabled && !confirmed)}
                type="submit"
              >
                Save recipe version
              </button>
              <span className={css.hint}>
                {prior ? `Based on saved version ${prior.version}` : "New recipe"} ·{" "}
                {dirty ? "Unsaved changes" : "No unsaved changes"}
              </span>
            </div>
          </fieldset>
          {!data.permissions.canConfigure ? (
            <p className={css.hint}>Recipe configuration is read only for your role.</p>
          ) : null}
        </form>
      </section>
    </div>
  );
}
