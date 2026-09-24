"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { CplAssignedWorkWorkspace, CplVisit, CplVisitInput } from "@bea/domain/cpl-execution";
import type { CommercialRequest } from "./commercial-ui";
import type { FieldUpload } from "./field-upload";
import { FieldWorkspace } from "./field-workspace";
import { useUnsavedNavigation } from "./commercial-navigation";
import styles from "./workspace.module.css";
function visitInput(visit: CplVisit): CplVisitInput {
  const {
    purpose,
    serviceType,
    status,
    timeZone,
    plannedStartLocal,
    plannedEndLocal,
    plannedStartOffsetMinutes,
    plannedEndOffsetMinutes,
    responsibleIdentityId,
    siteName,
    siteAddress,
    accessInstructions,
    actualStartAt,
    actualEndAt,
    completionNote,
    cancellationReason,
    tasks,
  } = visit;
  return {
    purpose,
    serviceType,
    status,
    timeZone,
    plannedStartLocal,
    plannedEndLocal,
    plannedStartOffsetMinutes,
    plannedEndOffsetMinutes,
    responsibleIdentityId,
    siteName,
    siteAddress,
    accessInstructions,
    actualStartAt,
    actualEndAt,
    completionNote,
    cancellationReason,
    tasks: tasks.map((task) => ({ ...task })),
  };
}
type Props = {
  organizationId: string;
  request: CommercialRequest;
  upload: FieldUpload;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
};
export function AssignedWorkspace(props: Props) {
  const [data, setData] = useState<CplAssignedWorkWorkspace | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [field, setField] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const requests = useRef(props.request);
  useEffect(() => {
    requests.current = props.request;
  }, [props.request]);
  const generation = useRef(0),
    mounted = useRef(false),
    navigation = useUnsavedNavigation(dirty);
  const load = useCallback(async () => {
    const run = ++generation.current;
    try {
      const value = await requests.current<CplAssignedWorkWorkspace>("/api/cpl-execution/assigned");
      if (mounted.current && run === generation.current) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (mounted.current && run === generation.current)
        setError(e instanceof Error ? e.message : "Assigned work unavailable.");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  function change(value: boolean) {
    setDirty(value);
    props.onDirty(value);
  }
  const item = data?.items.find((row) => row.visit.id === selected);
  return (
    <section className={styles.panel}>
      {navigation.dialog}
      <h2>Assigned work</h2>
      <p>
        Only visits currently assigned to your verified membership are shown. Commercial pricing and
        company-wide records are not included.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <button
        disabled={busy}
        onClick={() =>
          navigation.navigate(() => {
            change(false);
            setRevision((n) => n + 1);
            void load();
          })
        }
      >
        Refresh assigned work
      </button>
      {data?.truncated ? (
        <p>
          More than 200 assignments exist. Ask a manager to narrow or reassign outstanding work.
        </p>
      ) : null}
      <ul className={styles.list}>
        {data?.items.map((row) => (
          <li key={row.visit.id}>
            <button
              disabled={busy}
              onClick={() =>
                navigation.navigate(() => {
                  change(false);
                  setSelected(row.visit.id);
                  setField(false);
                  setRevision((n) => n + 1);
                })
              }
            >
              {row.projectName} · {row.projectReference} · {row.visit.purpose} ·{" "}
              {row.visit.status.replaceAll("_", " ")}
            </button>
          </li>
        ))}
      </ul>
      {data && !data.items.length ? (
        <p>No visits are currently assigned to you. A company manager can assign upcoming work.</p>
      ) : null}
      {item ? (
        <>
          <div className={styles.actions}>
            <button
              disabled={busy}
              onClick={() =>
                navigation.navigate(() => {
                  change(false);
                  setField(false);
                  setRevision((n) => n + 1);
                })
              }
            >
              Visit progress
            </button>
            <button
              disabled={busy}
              onClick={() =>
                navigation.navigate(() => {
                  change(false);
                  setField(true);
                  setRevision((n) => n + 1);
                })
              }
            >
              Open assigned fieldwork
            </button>
          </div>
          {field ? (
            <FieldWorkspace
              key={`${item.visit.id}:${revision}`}
              project={{ id: item.projectId, reference: item.projectReference }}
              visit={item.visit}
              organizationId={props.organizationId}
              request={props.request}
              upload={props.upload}
              onDirty={change}
              onBusy={(value) => {
                setBusy(value);
                props.onBusy(value);
              }}
              onOpenVisit={() =>
                navigation.navigate(() => {
                  change(false);
                  setField(false);
                })
              }
            />
          ) : (
            <AssignedProgress
              key={`${item.visit.id}:${revision}`}
              visit={item.visit}
              request={props.request}
              permitted={data!.permissions.canCompleteAssignedVisits}
              onDirty={change}
              onBusy={(value) => {
                setBusy(value);
                props.onBusy(value);
              }}
              onSaved={async () => {
                change(false);
                await load();
                setRevision((n) => n + 1);
              }}
            />
          )}
        </>
      ) : null}
    </section>
  );
}
function AssignedProgress({
  visit,
  request,
  permitted,
  onDirty,
  onBusy,
  onSaved,
}: {
  visit: CplVisit;
  request: CommercialRequest;
  permitted: boolean;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [input, setInput] = useState(() => visitInput(visit)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    attempt = useRef<{ payload: string; key: string } | null>(null);
  function change<K extends keyof CplVisitInput>(key: K, value: CplVisitInput[K]) {
    setInput((old) => ({ ...old, [key]: value }));
    onDirty(true);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onBusy(true);
    setError("");
    const payload = JSON.stringify(input);
    if (attempt.current?.payload !== payload)
      attempt.current = { payload, key: crypto.randomUUID() };
    try {
      await request(`/api/cpl-execution/visits/${visit.id}`, {
        projectId: visit.projectId,
        expectedRevision: visit.revision,
        idempotencyKey: attempt.current.key,
        input,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Progress could not be saved.");
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <form className={styles.form} onSubmit={(event) => void save(event)}>
      <h3>{visit.purpose}</h3>
      <p>
        {visit.siteName} · {visit.siteAddress} · {visit.timeZone}
      </p>
      <p>
        Planning, assignment and company scope are controlled by your manager. These controls save
        your actual progress.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <fieldset
        className={styles.fieldset}
        disabled={busy || !permitted || ["completed", "cancelled"].includes(visit.status)}
      >
        <label className={styles.field}>
          Visit progress
          <select
            value={input.status}
            onChange={(event) => change("status", event.target.value as CplVisitInput["status"])}
          >
            {["draft", "scheduled", "in_progress", "completed"].map((status) => (
              <option key={status} value={status}>
                {status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <p>
          Actual start:{" "}
          {input.actualStartAt ? new Date(input.actualStartAt).toLocaleString() : "Not recorded"}
        </p>
        <button type="button" onClick={() => change("actualStartAt", new Date().toISOString())}>
          Record actual start now
        </button>
        <p>
          Actual finish:{" "}
          {input.actualEndAt ? new Date(input.actualEndAt).toLocaleString() : "Not recorded"}
        </p>
        <button type="button" onClick={() => change("actualEndAt", new Date().toISOString())}>
          Record actual finish now
        </button>
        <label className={styles.field}>
          Completion note
          <textarea
            value={input.completionNote}
            onChange={(event) => change("completionNote", event.target.value)}
            maxLength={10000}
          />
        </label>
        {input.tasks.map((task, index) => (
          <label key={task.id}>
            <input
              type="checkbox"
              checked={task.status === "completed"}
              onChange={(event) =>
                change(
                  "tasks",
                  input.tasks.map((row, i) =>
                    i === index
                      ? { ...row, status: event.target.checked ? "completed" : "pending" }
                      : row,
                  ),
                )
              }
            />
            {task.title}
            {task.required ? " (required)" : ""}
          </label>
        ))}
        <button>Save visit progress</button>
      </fieldset>
      <p>
        Completion remains blocked by required checklist, evidence and visit conditions until the
        server verifies them.
      </p>
    </form>
  );
}
