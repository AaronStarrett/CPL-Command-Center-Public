"use client";

import { useEffect, useRef, useState } from "react";
import type {
  CplActionOwner,
  CplActionTarget,
  CplActionTask,
  CplAutomationExecutionDetail,
  CplAutomationRecipe,
  CplAutomationRecipeInput,
  CplAutomationWorkspace,
} from "@bea/domain/cpl-automation";
import type { CommercialRequest } from "./commercial-ui";
import { useUnsavedNavigation } from "./commercial-navigation";
import {
  AutomationRecipes,
  OwnerOptions,
  ownerValue,
  selectedOwner,
  triggerLabels,
} from "./automation-recipes";
import styles from "./workspace.module.css";
import forms from "./execution.module.css";
import css from "./action-center.module.css";

const base = "/api/cpl-automation";
const active = new Set(["open", "in_progress", "blocked"]);
type Group =
  | "all"
  | "mine"
  | "reviews"
  | "missing_information"
  | "delivery"
  | "closeout"
  | "automation_failures";
const groupLabels: Record<Group, string> = {
  all: "All open actions",
  mine: "My actions",
  reviews: "Reviews",
  missing_information: "Missing information",
  delivery: "Delivery ready",
  closeout: "Closeout / invoice issues",
  automation_failures: "Automation failures",
};
const stateLabels: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  completed: "Completed",
  dismissed: "Dismissed with reason",
  blocked: "Blocked",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  retrying: "Retry scheduled",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};
const errorLabels: Record<string, string> = {
  CPL_AUTOMATION_VERSION_CONFLICT:
    "This record changed elsewhere. Your entries are kept. Refresh saved actions and reconcile before retrying.",
  CPL_AUTOMATION_SOURCE_CHANGED:
    "The source changed. Open the current business record before continuing.",
  CPL_AUTOMATION_TEMPLATE_AUTHORIZATION_REQUIRED:
    "Select and explicitly authorize the exact company template version.",
  CPL_AUTOMATION_INVALID_INPUT: "Review the form, required reason and selected owner.",
  CPL_AUTOMATION_STATE_CONFLICT:
    "The saved state no longer permits this action. Refresh and review the current record.",
  CPL_AUTOMATION_FORBIDDEN: "Your current role does not permit this action.",
};
function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Not set";
}
function ownerLabel(owner: CplActionOwner, data: CplAutomationWorkspace) {
  return owner.kind === "unassigned"
    ? "Unassigned"
    : owner.kind === "role"
      ? `${owner.role} role queue`
      : (data.members.find((m) => m.identityId === owner.identityId)?.displayName ??
        "Assigned member unavailable");
}
function TaskEditor({
  task,
  data,
  busy,
  onDirty,
  onAction,
  onOpen,
  onExecution,
}: {
  task: CplActionTask;
  data: CplAutomationWorkspace;
  busy: boolean;
  onDirty: (value: boolean) => void;
  onAction: (
    action: "assign" | "start" | "complete" | "dismiss",
    input: { owner?: CplActionOwner; reason?: string },
  ) => Promise<boolean>;
  onOpen: (target: CplActionTarget) => void;
  onExecution: (id: string) => void;
}) {
  const [owner, setOwner] = useState(task.owner),
    [reason, setReason] = useState("");
  const ownerChanged = ownerValue(owner) !== ownerValue(task.owner);
  function changeReason(value: string) {
    setReason(value);
    onDirty(ownerChanged || Boolean(value));
  }
  async function act(action: "assign" | "start" | "complete" | "dismiss") {
    const input = action === "assign" ? { owner, reason } : reason ? { reason } : {};
    if (await onAction(action, input)) {
      setReason("");
      onDirty(false);
    }
  }
  return (
    <section className={styles.panel} aria-label="Selected action">
      <p className={styles.eyebrow}>{groupLabels[task.group as Group] ?? "Next action"}</p>
      <h3>{task.title}</h3>
      <p className={css.message}>{task.reason}</p>
      <p>{[task.customerName, task.projectName].filter(Boolean).join(" · ")}</p>
      <p>
        <strong>Next action:</strong> {task.nextAction}
      </p>
      <p className={css.meta}>
        <span>{stateLabels[task.status]}</span>
        <span>Owner: {ownerLabel(task.owner, data)}</span>
        <span>Due: {date(task.dueAt)}</span>
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy}
          onClick={() => onOpen(task.target)}
        >
          Open related record
        </button>
        {task.executionId ? (
          <button
            type="button"
            className={styles.secondary}
            disabled={busy || !data.permissions.canViewExecutions}
            onClick={() => {
              if (task.executionId) onExecution(task.executionId);
            }}
          >
            View related execution
          </button>
        ) : null}
      </div>
      {task.resolutionReason ? (
        <p className={css.message}>Recorded reason: {task.resolutionReason}</p>
      ) : null}
      <div className={forms.form}>
        <fieldset className={styles.fieldset} disabled={busy}>
          {task.availableActions.canAssign ? (
            <label className={styles.field}>
              Action owner
              <select
                value={ownerValue(owner)}
                onChange={(e) => {
                  const next = selectedOwner(e.target.value);
                  setOwner(next);
                  onDirty(ownerValue(next) !== ownerValue(task.owner) || Boolean(reason));
                }}
              >
                <OwnerOptions members={data.members} />
              </select>
            </label>
          ) : null}
          {Object.values(task.availableActions).some(Boolean) ? (
            <label className={styles.field}>
              Action reason
              <textarea
                maxLength={2000}
                value={reason}
                onChange={(e) => changeReason(e.target.value)}
              />
              <small>
                Completion and dismissal require a reason. Neither action approves business work or
                records delivery; use the linked business record for those decisions.
              </small>
            </label>
          ) : null}
          <div className={styles.actions}>
            {task.availableActions.canAssign ? (
              <button
                type="button"
                className={styles.secondary}
                disabled={!ownerChanged || !reason.trim()}
                onClick={() => void act("assign")}
              >
                Save assignment
              </button>
            ) : null}
            {task.availableActions.canStart ? (
              <button
                type="button"
                className={styles.secondary}
                disabled={ownerChanged}
                onClick={() => void act("start")}
              >
                Start action
              </button>
            ) : null}
            {task.availableActions.canComplete ? (
              <button
                type="button"
                className={styles.primary}
                disabled={ownerChanged || !reason.trim()}
                onClick={() => void act("complete")}
              >
                Complete action
              </button>
            ) : null}
            {task.availableActions.canDismiss ? (
              <button
                type="button"
                className={styles.secondary}
                disabled={ownerChanged || !reason.trim()}
                onClick={() => void act("dismiss")}
              >
                Dismiss with reason
              </button>
            ) : null}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
export function ActionCenter({
  organizationId,
  request,
  onDirty,
  onBusy,
  onOpen,
}: {
  organizationId: string;
  request: CommercialRequest;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
  onOpen: (target: CplActionTarget) => void;
}) {
  const [data, setData] = useState<CplAutomationWorkspace | null>(null),
    [area, setArea] = useState<"actions" | "recipes" | "executions">("actions");
  const [group, setGroup] = useState<Group>("mine"),
    [showClosed, setShowClosed] = useState(false);
  const [task, setTask] = useState<CplActionTask | null>(null),
    [execution, setExecution] = useState<CplAutomationExecutionDetail | null>(null);
  const [dirty, setDirty] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [epoch, setEpoch] = useState(0);
  const refs = useRef({ request, onDirty, onBusy, onOpen });
  useEffect(() => {
    refs.current = { request, onDirty, onBusy, onOpen };
  }, [request, onDirty, onBusy, onOpen]);
  const alive = useRef(true),
    working = useRef(false),
    polling = useRef(false),
    readGeneration = useRef(0),
    attempts = useRef<Record<string, { payload: string; key: string }>>({});
  const dirtyRef = useRef(false),
    navigation = useUnsavedNavigation(dirty || Boolean(reason));
  useEffect(() => {
    dirtyRef.current = dirty || Boolean(reason);
    refs.current.onDirty(dirtyRef.current);
  }, [dirty, reason]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  function key(action: string, input: unknown) {
    const payload = JSON.stringify({ organizationId, input });
    if (attempts.current[action]?.payload !== payload)
      attempts.current[action] = { payload, key: crypto.randomUUID() };
    return attempts.current[action]!.key;
  }
  async function read() {
    const generation = ++readGeneration.current;
    const value = await refs.current.request<CplAutomationWorkspace>(`${base}/workspace`);
    if (
      value.tasks.some((item) => item.organizationId !== organizationId) ||
      value.executions.some((item) => item.organizationId !== organizationId) ||
      value.recipes.some((item) => item.organizationId !== organizationId)
    )
      throw new Error("The response did not match the selected company.");
    if (alive.current && generation === readGeneration.current) setData(value);
    return value;
  }
  async function run(action: () => Promise<void>) {
    if (working.current) return false;
    working.current = true;
    readGeneration.current++;
    setBusy(true);
    refs.current.onBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      return true;
    } catch (caught) {
      if (alive.current) {
        const code = (caught as { code?: string })?.code;
        setError(
          errorLabels[code ?? ""] ??
            (caught instanceof Error
              ? caught.message
              : "The action failed. Your entries are kept."),
        );
      }
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
          await read();
        }),
    );
    return () => {
      alive.current = false;
      refs.current.onDirty(false);
      refs.current.onBusy(false);
    };
    // A keyed company component retains drafts across session-token refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        !alive.current ||
        working.current ||
        polling.current ||
        dirtyRef.current ||
        document.visibilityState === "hidden"
      )
        return;
      polling.current = true;
      void read()
        .catch(() => undefined)
        .finally(() => {
          polling.current = false;
        });
    }, 5000);
    return () => window.clearInterval(timer);
    // Background readback updates counts without erasing an open edit or announcing a false save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);
  function discard() {
    setDirty(false);
    setReason("");
    setTask(null);
    setExecution(null);
    setEpoch((value) => value + 1);
  }
  function changeArea(next: typeof area) {
    if (next === area) return;
    navigation.navigate(() => {
      discard();
      setArea(next);
    });
  }
  function open(target: CplActionTarget) {
    if (target.kind === "execution") {
      openExecution(target.id);
      return;
    }
    navigation.navigate(() => {
      discard();
      refs.current.onOpen(target);
    });
  }
  function openExecution(id: string) {
    navigation.navigate(
      () =>
        void run(async () => {
          const value = await refs.current.request<CplAutomationExecutionDetail>(
            `${base}/executions/${id}`,
          );
          if (value.id !== id || value.organizationId !== organizationId)
            throw new Error("The execution did not match the selected record.");
          if (alive.current) {
            discard();
            setExecution(value);
            setArea("executions");
          }
        }),
    );
  }
  async function saveRecipe(input: CplAutomationRecipeInput, prior: CplAutomationRecipe | null) {
    return run(async () => {
      const body = {
        ...(prior ? { recipeId: prior.id } : {}),
        expectedVersion: prior?.version ?? 0,
        input,
      };
      await refs.current.request(`${base}/recipes`, {
        ...body,
        idempotencyKey: key("recipe", body),
      });
      await read();
      delete attempts.current.recipe;
      setNotice(
        "Recipe version saved. Future matching events use this configuration; historical records were not backfilled.",
      );
    });
  }
  async function taskAction(
    action: "assign" | "start" | "complete" | "dismiss",
    input: { owner?: CplActionOwner; reason?: string },
  ) {
    if (!task) return false;
    const current = task;
    return run(async () => {
      const body = { action, expectedRevision: current.revision, ...input };
      await refs.current.request(`${base}/tasks/${current.id}`, {
        ...body,
        idempotencyKey: key(`task:${current.id}:${action}`, body),
      });
      const value = await read();
      if (alive.current) {
        setTask(value.tasks.find((item) => item.id === current.id) ?? null);
        setEpoch((v) => v + 1);
        setDirty(false);
        setNotice("Action updated. Business approvals and delivery facts remain separate.");
      }
      delete attempts.current[`task:${current.id}:${action}`];
    });
  }
  async function executionAction(action: "retry" | "cancel" | "replay") {
    if (!execution || !reason.trim()) return;
    const selected = execution;
    await run(async () => {
      const body =
        action === "replay" ? { reason } : { reason, expectedRevision: selected.revision };
      await refs.current.request(
        action === "replay"
          ? `${base}/events/${selected.event.id}/replay`
          : `${base}/executions/${selected.id}/${action}`,
        { ...body, idempotencyKey: key(`${selected.id}:${action}`, body) },
      );
      const value = await refs.current.request<CplAutomationExecutionDetail>(
        `${base}/executions/${selected.id}`,
      );
      await read();
      if (value.id !== selected.id || value.organizationId !== organizationId)
        throw new Error("The execution readback did not match.");
      if (alive.current) {
        setExecution(value);
        setReason("");
        setNotice(
          action === "replay"
            ? "Replay requested. Successful recorded results are reused; this does not request a second business record."
            : action === "retry"
              ? "Retry requested for the unfinished work. Recorded successful steps are retained."
              : "Cancellation recorded. Completed business records remain in history.",
        );
      }
      delete attempts.current[`${selected.id}:${action}`];
    });
  }
  const shown =
    data?.tasks.filter(
      (item) =>
        (showClosed || active.has(item.status)) &&
        (group === "all" || (group === "mine" ? item.isMine : item.group === group)),
    ) ?? [];
  const counts = data
    ? {
        all: data.counts.openTasks,
        mine: data.counts.myTasks,
        reviews: data.counts.reviews,
        missing_information: data.counts.missingInformation,
        delivery: data.counts.delivery,
        closeout: data.counts.closeout,
        automation_failures: data.counts.failedExecutions,
      }
    : null;
  return (
    <section className={css.shell} aria-label="Action Center">
      {navigation.dialog}
      <header className={css.heading}>
        <div>
          <p className={styles.eyebrow}>CURRENT COMPANY · NEXT ACTIONS</p>
          <h2>Action Center</h2>
          <p className={css.hint}>
            See what needs a person, what completed automatically, and what is waiting.
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
                  await read();
                  discard();
                  setNotice("Saved actions refreshed.");
                }),
            )
          }
        >
          Refresh saved actions
        </button>
      </header>
      <nav className={forms.tabs} aria-label="Action Center sections">
        {(
          [
            ["actions", "Actions"],
            ["recipes", "Recipes"],
            ["executions", "Execution history"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            disabled={busy || (value === "executions" && !data?.permissions.canViewExecutions)}
            aria-current={area === value ? "page" : undefined}
            onClick={() => changeArea(value)}
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
      {!data ? (
        <p role="status" className={styles.muted}>
          {error
            ? "Action Center could not be loaded. Other company records remain available."
            : "Loading company actions…"}
        </p>
      ) : (
        <>
          {area === "recipes" ? (
            <AutomationRecipes
              key={epoch}
              data={data}
              busy={busy}
              onDirty={setDirty}
              onSave={saveRecipe}
            />
          ) : null}
          {area === "actions" ? (
            <>
              <div className={css.queues} aria-label="Action queues">
                {(
                  [
                    "mine",
                    "reviews",
                    "missing_information",
                    "delivery",
                    "closeout",
                    "automation_failures",
                  ] as Group[]
                ).map((value) => (
                  <button
                    type="button"
                    className={css.queue}
                    disabled={busy}
                    key={value}
                    aria-pressed={group === value}
                    onClick={() =>
                      navigation.navigate(() => {
                        discard();
                        setGroup(value);
                      })
                    }
                  >
                    <span>{groupLabels[value]}</span>
                    <strong>{counts?.[value] ?? "—"}</strong>
                  </button>
                ))}
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={busy}
                  aria-pressed={group === "all"}
                  onClick={() =>
                    navigation.navigate(() => {
                      discard();
                      setGroup("all");
                    })
                  }
                >
                  All open actions · {data.counts.openTasks}
                </button>
                <label className={css.check}>
                  <input
                    type="checkbox"
                    checked={showClosed}
                    disabled={busy}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      navigation.navigate(() => {
                        discard();
                        setShowClosed(checked);
                      });
                    }}
                  />{" "}
                  Include completed and dismissed records
                </label>
              </div>
              <p className={css.hint}>
                Counts cover the authorized company queue. Up to {data.listLimit} recent action
                records are loaded; {shown.length} match this view. Background refresh pauses while
                you edit.
              </p>
              <div className={css.layout}>
                <ul className={css.records} aria-label={groupLabels[group]}>
                  {shown.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`${css.record} ${task?.id === item.id ? css.selected : ""}`}
                        disabled={busy}
                        aria-pressed={task?.id === item.id}
                        onClick={() =>
                          navigation.navigate(() => {
                            discard();
                            setTask(item);
                          })
                        }
                      >
                        <span className={css.tag}>{stateLabels[item.status]}</span>
                        <strong>{item.title}</strong>
                        <span>{item.reason}</span>
                        <span>
                          {[item.customerName, item.projectName].filter(Boolean).join(" · ")}
                        </span>
                        <span className={css.meta}>
                          {ownerLabel(item.owner, data)} · {date(item.dueAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                  {!shown.length ? (
                    <li className={styles.empty}>
                      No matching actions in the loaded records. Nothing has been marked complete by
                      this empty view.
                    </li>
                  ) : null}
                </ul>
                {task ? (
                  <TaskEditor
                    key={`${task.id}:${task.revision}:${epoch}`}
                    task={task}
                    data={data}
                    busy={busy}
                    onDirty={setDirty}
                    onAction={taskAction}
                    onOpen={open}
                    onExecution={openExecution}
                  />
                ) : (
                  <section className={styles.panel}>
                    <h3>{groupLabels[group]}</h3>
                    <p className={styles.muted}>
                      Select an action to inspect its reason, ownership and related record. Review
                      approvals stay in the proposal and report workspaces.
                    </p>
                  </section>
                )}
              </div>
            </>
          ) : null}
          {area === "executions" ? (
            <div className={css.layout}>
              <aside className={css.records} aria-label="Automation executions">
                {data.executions.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    disabled={busy}
                    className={`${css.record} ${execution?.id === item.id ? css.selected : ""}`}
                    onClick={() => openExecution(item.id)}
                  >
                    <span className={css.tag}>{stateLabels[item.status]}</span>
                    <strong>{item.recipeName}</strong>
                    <span>
                      {triggerLabels[item.event.type]} · source version {item.event.sourceVersion}
                    </span>
                    <span className={css.meta}>
                      Recipe v{item.recipeVersion} · {item.attempts} attempt
                      {item.attempts === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
                {!data.executions.length ? (
                  <p className={styles.empty}>No captured recipe executions yet.</p>
                ) : null}
              </aside>
              <section className={styles.panel}>
                {execution ? (
                  <>
                    <p className={styles.eyebrow}>{stateLabels[execution.status]}</p>
                    <h3>{execution.recipeName}</h3>
                    <p className={css.hint}>
                      Recorded recipe version {execution.recipeVersion} · source version{" "}
                      {execution.event.sourceVersion}. Editing a recipe does not silently replace
                      this execution’s configuration.
                    </p>
                    <ol className={css.timeline}>
                      <li>
                        <strong>{triggerLabels[execution.event.type]}</strong>
                        <p>
                          {date(execution.event.occurredAt)} ·{" "}
                          {execution.event.origin === "human"
                            ? "Recorded business event"
                            : "Internal follow-up event"}
                        </p>
                        <button
                          type="button"
                          disabled={busy}
                          className={styles.secondary}
                          onClick={() =>
                            open({
                              kind:
                                execution.event.sourceKind === "delivery"
                                  ? "package"
                                  : execution.event.sourceKind,
                              id: execution.event.sourceId,
                              projectId: execution.event.projectId,
                              version: execution.event.sourceVersion,
                            })
                          }
                        >
                          Open source record
                        </button>
                      </li>
                      {execution.results.map((result) => (
                        <li key={`${result.step}:${result.target.id}`}>
                          <strong>
                            {result.step === "task"
                              ? "Follow-up action recorded"
                              : result.step === "handoff"
                                ? execution.event.type === "delivery.recorded"
                                  ? "Closeout readiness evaluated"
                                  : result.target.kind === "proposal"
                                    ? "Proposal draft prepared"
                                    : result.target.kind === "report"
                                      ? "Report draft prepared"
                                      : result.target.kind === "package"
                                        ? "Delivery package prepared"
                                        : result.target.kind === "project"
                                          ? "Project handoff recorded"
                                          : result.target.kind === "visit"
                                            ? "Field review handoff recorded"
                                            : "Lead handoff recorded"
                                : "Internal result recorded"}
                          </strong>
                          <p>Recorded {date(result.completedAt)}</p>
                          <button
                            type="button"
                            className={styles.secondary}
                            disabled={busy}
                            onClick={() => open(result.target)}
                          >
                            Open recorded result
                          </button>
                        </li>
                      ))}
                      {execution.attemptHistory.map((attempt) => (
                        <li key={attempt.attempt}>
                          <strong>
                            Attempt {attempt.attempt} · {stateLabels[attempt.status]}
                          </strong>
                          <p>
                            {date(attempt.startedAt)}
                            {attempt.finishedAt
                              ? ` – ${date(attempt.finishedAt)}`
                              : " · still running"}
                          </p>
                          {attempt.errorCode ? <p>Reason code: {attempt.errorCode}</p> : null}
                        </li>
                      ))}
                    </ol>
                    {execution.nextRetryAt ? (
                      <p>Next retry: {date(execution.nextRetryAt)}</p>
                    ) : null}
                    {execution.availableActions.canRetry ||
                    execution.availableActions.canCancel ||
                    execution.availableActions.canReplay ? (
                      <div className={forms.form}>
                        <label className={styles.field}>
                          Execution action reason
                          <textarea
                            maxLength={2000}
                            value={reason}
                            disabled={busy}
                            onChange={(e) => setReason(e.target.value)}
                          />
                        </label>
                        <div className={styles.actions}>
                          {execution.availableActions.canRetry ? (
                            <button
                              type="button"
                              className={styles.primary}
                              disabled={busy || !reason.trim()}
                              onClick={() => void executionAction("retry")}
                            >
                              Retry unfinished steps
                            </button>
                          ) : null}
                          {execution.availableActions.canReplay ? (
                            <button
                              type="button"
                              className={styles.secondary}
                              disabled={busy || !reason.trim()}
                              onClick={() => void executionAction("replay")}
                            >
                              Replay recorded event safely
                            </button>
                          ) : null}
                          {execution.availableActions.canCancel ? (
                            <button
                              type="button"
                              className={styles.secondary}
                              disabled={busy || !reason.trim()}
                              onClick={() => void executionAction("cancel")}
                            >
                              Cancel pending work
                            </button>
                          ) : null}
                        </div>
                        <p className={css.hint}>
                          Replay reuses durable result identities. It is not an intentional second
                          proposal, project or delivery package.
                        </p>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <h3>Readable execution history</h3>
                    <p className={styles.muted}>
                      Select a run to inspect its source version, saved configuration, attempts and
                      actual linked results.
                    </p>
                  </>
                )}
              </section>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
