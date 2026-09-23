"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CplCommercialProject } from "@bea/domain/cpl-commercial";
import {
  CPL_PROJECT_STATUSES,
  CPL_VISIT_STATUSES,
  CPL_TASK_STATUSES,
  CPL_EXECUTION_TIME_ZONE,
  cplVisitReadiness,
  resolveCplLocalDateTime,
  type CplProjectWorkspace,
  type CplProjectOperationsInput,
  type CplVisit,
  type CplVisitInput,
  type CplExecutionAgenda,
  type CplExecutionMember,
} from "@bea/domain/cpl-execution";
import type { CommercialRequest } from "./commercial-ui";
import { useUnsavedNavigation } from "./commercial-navigation";
import { FieldWorkspace } from "./field-workspace";
import { ReportWorkspace } from "./report-workspace";
import { DeliveryWorkspace } from "./delivery-workspace";
import type { WorkspaceRecordIntent } from "./phase4-ui";
import type { FieldUpload } from "./field-upload";
import styles from "./workspace.module.css";
import css from "./execution.module.css";

const base = "/api/cpl-execution";
type Area =
  "operations" | "visits" | "field" | "reports" | "delivery" | "agenda" | "agreement" | "history";
const labels: Record<string, string> = {
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
  draft: "Draft",
  scheduled: "Scheduled",
  in_progress: "In progress",
  pending: "Pending",
};
const errors: Record<string, string> = {
  CPL_EXECUTION_VERSION_CONFLICT:
    "This record changed elsewhere. Your entries are kept. Refresh saved project and reconcile before saving again.",
  CPL_EXECUTION_SCHEDULE_CONFLICT:
    "This member already has a visit during that time. Review the conflicts below and choose another time or member.",
  CPL_EXECUTION_TIME_AMBIGUOUS:
    "This time occurs twice when daylight saving ends. Choose its UTC offset in Time details.",
  CPL_EXECUTION_TIME_NONEXISTENT:
    "This local time does not exist when daylight saving starts. Choose a valid time.",
  CPL_EXECUTION_TIME_OFFSET_INVALID:
    "The chosen UTC offset does not match this time and timezone. Choose Automatic or the correct offset.",
  CPL_EXECUTION_TIME_ZONE_INVALID:
    "Enter a valid IANA timezone, such as America/Indiana/Indianapolis.",
  CPL_EXECUTION_VISIT_NOT_READY:
    "Required visit information, actual times or tasks are incomplete. Review the readiness list before completing this visit.",
  CPL_EXECUTION_MEMBER_UNAVAILABLE:
    "An assigned member is no longer active. Select an available company member.",
  CPL_EXECUTION_STATE_CONFLICT:
    "This action does not match the saved project or visit status. Refresh saved project and review its state.",
  CPL_EXECUTION_OPEN_VISITS:
    "Complete or cancel outstanding visits before completing or cancelling the project.",
  CPL_INVALID_INPUT:
    "Review required fields, date order, task notes and actual times. Actual completion cannot be in the future.",
};
type Conflict = {
  visitId: string;
  projectId: string;
  purpose: string;
  plannedStartAt: string;
  plannedEndAt: string;
  timeZone: string;
};
function errorText(error: unknown): string {
  const code = (error as { code?: string })?.code;
  return (
    errors[code ?? ""] ??
    (error instanceof Error
      ? error.message
      : "The action could not be completed. Your entries are kept.")
  );
}
function dateLabel(value: string | null, zone: string) {
  if (!value) return "Not recorded";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return "Date unavailable";
  }
}
function projectInput(data: CplProjectWorkspace): CplProjectOperationsInput {
  const {
    name,
    status,
    ownerIdentityId,
    teamIdentityIds,
    nextAction,
    operationalInstructions,
    internalNotes,
    timeZone,
    statusReason,
  } = data.operations;
  return {
    name,
    status,
    ownerIdentityId,
    teamIdentityIds: [...teamIdentityIds],
    nextAction,
    operationalInstructions,
    internalNotes,
    timeZone,
    statusReason,
  };
}
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
function newVisit(data: CplProjectWorkspace): CplVisitInput {
  const source = data.project.snapshot.version;
  return {
    purpose: "",
    serviceType: source.sourceLead.fields.requestedService,
    status: "draft",
    timeZone: data.operations.timeZone || CPL_EXECUTION_TIME_ZONE,
    plannedStartLocal: null,
    plannedEndLocal: null,
    plannedStartOffsetMinutes: null,
    plannedEndOffsetMinutes: null,
    responsibleIdentityId: data.operations.ownerIdentityId,
    siteName: source.sourceLead.fields.siteName,
    siteAddress: source.sourceLead.fields.siteAddress,
    accessInstructions:
      data.operations.operationalInstructions || source.content.accessInstructions,
    actualStartAt: null,
    actualEndAt: null,
    completionNote: "",
    cancellationReason: "",
    tasks: [],
  };
}
function MemberOptions({
  members,
  value,
}: {
  members: CplExecutionMember[];
  value: string | null;
}) {
  return (
    <>
      <option value="">Unassigned</option>
      {value && !members.some((member) => member.identityId === value) ? (
        <option value={value}>Previously assigned member · unavailable</option>
      ) : null}
      {members.map((member) => (
        <option key={member.identityId} value={member.identityId}>
          {member.displayName}
        </option>
      ))}
    </>
  );
}
function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`${css.field} ${wide ? css.wide : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function ExecutionWorkspace({
  project,
  organizationId,
  request,
  upload,
  agreement,
  onDirty,
  onBusy,
  onOpenProject,
  initialIntent,
}: {
  project: CplCommercialProject;
  organizationId: string;
  request: CommercialRequest;
  upload?: FieldUpload;
  agreement: ReactNode;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  onOpenProject?: (id: string) => void;
  initialIntent?: WorkspaceRecordIntent;
}) {
  const [data, setData] = useState<CplProjectWorkspace | null>(null);
  const [area, setArea] = useState<Area>(
    initialIntent?.kind === "visit"
      ? "field"
      : initialIntent?.kind === "report"
        ? "reports"
        : initialIntent?.kind === "package"
          ? "delivery"
          : "operations",
  );
  const [operations, setOperations] = useState<CplProjectOperationsInput | null>(null);
  const [visit, setVisit] = useState<CplVisitInput | null>(null);
  const [editing, setEditing] = useState<CplVisit | null>(null);
  const [dirty, setDirty] = useState(false);
  const [fieldDirty, setFieldDirty] = useState(false);
  const [reportDirty, setReportDirty] = useState(false);
  const [deliveryDirty, setDeliveryDirty] = useState(false);
  const [ownBusy, setBusy] = useState(false);
  const [fieldBusy, setFieldBusy] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [reportSelection, setReportSelection] = useState<{
    id: string;
    previewVersion?: number;
  } | null>(initialIntent?.kind === "report" ? { id: initialIntent.id } : null);
  const [fieldVisitId, setFieldVisitId] = useState<string | null>(
    initialIntent?.kind === "visit" ? initialIntent.id : null,
  );
  const [fieldEpoch, setFieldEpoch] = useState(0);
  const busy = ownBusy || fieldBusy || reportBusy || deliveryBusy;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [stale, setStale] = useState(false);
  const [agenda, setAgenda] = useState<CplExecutionAgenda | null>(null);
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(() =>
    new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  );
  const navigation = useUnsavedNavigation(dirty || fieldDirty || reportDirty || deliveryDirty);
  const refs = useRef({ request, onDirty, onBusy });
  useEffect(() => {
    refs.current = { request, onDirty, onBusy };
  }, [request, onDirty, onBusy]);
  const alive = useRef(true);
  const dirtyParts = useRef({ operations: false, field: false, report: false, delivery: false });
  useEffect(() => {
    refs.current.onBusy(busy);
  }, [busy]);
  const working = useRef(false);
  const attempts = useRef<Record<string, { payload: string; key: string }>>({});
  const changeDirty = useCallback((value: boolean) => {
    setDirty(value);
    dirtyParts.current.operations = value;
    refs.current.onDirty(Object.values(dirtyParts.current).some(Boolean));
  }, []);
  const changeFieldDirty = useCallback((value: boolean) => {
    setFieldDirty(value);
    dirtyParts.current.field = value;
    refs.current.onDirty(Object.values(dirtyParts.current).some(Boolean));
  }, []);
  const changeReportDirty = useCallback((value: boolean) => {
    setReportDirty(value);
    dirtyParts.current.report = value;
    refs.current.onDirty(Object.values(dirtyParts.current).some(Boolean));
  }, []);
  const changeDeliveryDirty = useCallback((value: boolean) => {
    setDeliveryDirty(value);
    dirtyParts.current.delivery = value;
    refs.current.onDirty(Object.values(dirtyParts.current).some(Boolean));
  }, []);
  function key(kind: string, input: unknown) {
    const payload = JSON.stringify({ organizationId, projectId: project.id, input });
    if (attempts.current[kind]?.payload !== payload)
      attempts.current[kind] = { payload, key: crypto.randomUUID() };
    return attempts.current[kind]!.key;
  }
  function accept(value: CplProjectWorkspace) {
    if (value.project.id !== project.id || value.project.organizationId !== organizationId)
      throw new Error("The selected project changed. Return to Projects and choose it again.");
    if (!alive.current) return;
    setData(value);
    setOperations(projectInput(value));
    setStale(false);
  }
  async function read() {
    const value = await refs.current.request<CplProjectWorkspace>(`${base}/projects/${project.id}`);
    accept(value);
    return value;
  }
  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    refs.current.onBusy(true);
    setError("");
    setNotice("");
    setConflicts([]);
    try {
      await action();
    } catch (caught) {
      if (alive.current) {
        setError(errorText(caught));
        const code = (caught as { code?: string })?.code ?? "";
        if (code.includes("REVISION") || code.includes("VERSION_CONFLICT")) setStale(true);
        const details = (caught as { conflicts?: Conflict[] })?.conflicts;
        if (Array.isArray(details)) setConflicts(details);
      }
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
    void Promise.resolve().then(() => {
      if (alive.current)
        return run(async () => {
          const value = await read();
          if (
            initialIntent?.kind === "visit" &&
            !value.visits.some((visit) => visit.id === initialIntent.id)
          )
            throw new Error("This visit is not available in the selected project.");
        });
    });
    return () => {
      alive.current = false;
      refs.current.onDirty(false);
      refs.current.onBusy(false);
    };
    // The parent keys this component by company and project. Token refresh must retain edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, organizationId]);
  function navigate(next: Area) {
    if (area === next) return;
    navigation.navigate(() => {
      changeDirty(false);
      setVisit(null);
      setEditing(null);
      setError("");
      setNotice("");
      setStale(false);
      if (data) setOperations(projectInput(data));
      setReportSelection(null);
      setArea(next);
    });
  }
  function editVisit(value: CplVisit | null) {
    if (!data) return;
    navigation.navigate(() => {
      setVisit(value ? visitInput(value) : newVisit(data));
      setEditing(value);
      changeDirty(false);
      setStale(false);
      setError("");
      setNotice("");
      setArea("visits");
    });
  }
  function openField(id: string) {
    navigation.navigate(() => {
      changeDirty(false);
      changeFieldDirty(false);
      setVisit(null);
      setEditing(null);
      setFieldVisitId(id);
      setFieldEpoch((value) => value + 1);
      setArea("field");
    });
  }
  function updateOperations<K extends keyof CplProjectOperationsInput>(
    field: K,
    value: CplProjectOperationsInput[K],
  ) {
    setOperations((current) => (current ? { ...current, [field]: value } : current));
    changeDirty(true);
  }
  function updateVisit<K extends keyof CplVisitInput>(field: K, value: CplVisitInput[K]) {
    setVisit((current) => (current ? { ...current, [field]: value } : current));
    changeDirty(true);
  }
  async function saveOperations() {
    if (!data || !operations) return;
    await run(async () => {
      const body = { expectedRevision: data.operations.revision, input: operations };
      const value = await refs.current.request<CplProjectWorkspace>(
        `${base}/projects/${project.id}`,
        { ...body, idempotencyKey: key("operations", body) },
      );
      accept(value);
      changeDirty(false);
      delete attempts.current.operations;
      setNotice("Project operations saved. The awarded agreement is unchanged.");
    });
  }
  async function saveVisit() {
    if (!visit) return;
    await run(async () => {
      const body = {
        input: visit,
        ...(editing ? { projectId: project.id, expectedRevision: editing.revision } : {}),
      };
      const value = await refs.current.request<CplVisit>(
        editing ? `${base}/visits/${editing.id}` : `${base}/projects/${project.id}/visits`,
        { ...body, idempotencyKey: key("visit", body) },
      );
      if (value.projectId !== project.id || value.organizationId !== organizationId)
        throw new Error("The saved visit did not match this project.");
      // Keep the same retry key and form until the scoped readback also succeeds.
      await read();
      if (!alive.current) return;
      setVisit(visitInput(value));
      setEditing(value);
      changeDirty(false);
      delete attempts.current.visit;
      setNotice("Visit saved. Its schedule, tasks and status are recorded.");
    });
  }
  async function loadAgenda() {
    if (!data) return;
    await run(async () => {
      const start = resolveCplLocalDateTime(`${from}T00:00`, data.operations.timeZone)!.instant;
      const endDate = new Date(`${to}T00:00:00Z`);
      endDate.setUTCDate(endDate.getUTCDate() + 1);
      const end = resolveCplLocalDateTime(
        `${endDate.toISOString().slice(0, 10)}T00:00`,
        data.operations.timeZone,
      )!.instant;
      if (end <= start) throw new Error("Choose an end date on or after the start date.");
      const result = await refs.current.request<CplExecutionAgenda>(
        `${base}/agenda?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`,
      );
      if (alive.current) setAgenda(result);
    });
  }
  const canPlan = data?.permissions.canPlan ?? false;
  const locked = editing?.status === "completed" || editing?.status === "cancelled";
  const canEditPlan = canPlan && !locked;
  const canComplete =
    !locked &&
    (canPlan ||
      Boolean(
        editing &&
        data?.permissions.canCompleteAssignedVisits &&
        editing.responsibleIdentityId === data.currentIdentityId,
      ));
  const allowedStatuses = editing
    ? {
        draft: ["draft", "scheduled", "cancelled"],
        scheduled: ["scheduled", "draft", "in_progress", "completed", "cancelled"],
        in_progress: ["in_progress", "completed", "cancelled"],
        completed: ["completed"],
        cancelled: ["cancelled"],
      }[editing.status]
    : ["draft", "scheduled"];
  const readiness = visit ? cplVisitReadiness(visit) : [];
  if (visit && ["in_progress", "completed"].includes(visit.status) && !visit.actualStartAt)
    readiness.push({
      code: "actual_start_required",
      field: "actualStartAt",
      message: "Record when work actually started.",
    });
  if (visit?.status === "completed") {
    if (!visit.actualEndAt)
      readiness.push({
        code: "actual_end_required",
        field: "actualEndAt",
        message: "Record when work actually finished.",
      });
    if (!visit.completionNote.trim())
      readiness.push({
        code: "completion_note_required",
        field: "completionNote",
        message: "Add a human-written completion note.",
      });
  }
  const memberName = (id: string | null) =>
    data?.members.find((member) => member.identityId === id)?.displayName ??
    (id ? "Unavailable member" : "Unassigned");
  const visits = [...(data?.visits ?? [])].sort((a, b) =>
    (a.plannedStartAt ?? "9999").localeCompare(b.plannedStartAt ?? "9999"),
  );
  return (
    <section className={`${styles.panel} ${css.shell}`} aria-label="Project execution">
      {navigation.dialog}
      <header className={css.header}>
        <div>
          <p className={styles.eyebrow}>{project.reference} · PROJECT EXECUTION</p>
          <h2>{data?.operations.name || project.snapshot.version.content.title}</h2>
          <p className={styles.muted}>
            {project.snapshot.version.sourceLead.fields.customerName} ·{" "}
            {project.snapshot.version.sourceLead.fields.siteName || "Site to confirm"}
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
                  const latest = await read();
                  setVisit(
                    editing
                      ? visitInput(latest.visits.find((item) => item.id === editing.id) ?? editing)
                      : null,
                  );
                  setEditing(
                    editing ? (latest.visits.find((item) => item.id === editing.id) ?? null) : null,
                  );
                  changeDirty(false);
                  changeFieldDirty(false);
                  changeReportDirty(false);
                  setFieldEpoch((value) => value + 1);
                  setNotice("Saved project refreshed. Discarded entries were not saved.");
                }),
            )
          }
        >
          Refresh saved project
        </button>
      </header>
      <nav className={css.tabs} aria-label="Project workspace sections">
        {(
          [
            ["operations", "Operations"],
            ["visits", "Visits"],
            ["field", "Field work"],
            ["reports", "Reports"],
            ["delivery", "Delivery & readiness"],
            ["agenda", "Agenda"],
            ["agreement", "Awarded agreement"],
            ["history", "Activity history"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            disabled={busy}
            aria-current={area === value ? "page" : undefined}
            onClick={() => navigate(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error ? (
        <div role="alert" className={`${styles.notice} ${styles.error}`}>
          <p>{error}</p>
          {conflicts.length ? (
            <ul>
              {conflicts.map((item) => (
                <li key={item.visitId}>
                  {item.purpose} · {dateLabel(item.plannedStartAt, item.timeZone)} –{" "}
                  {dateLabel(item.plannedEndAt, item.timeZone)} · {item.timeZone}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}
      {busy ? (
        <p className={css.hint} role="status">
          Saving or loading project information…
        </p>
      ) : null}
      {area === "agreement" ? (
        agreement
      ) : !data || !operations ? (
        <p className={styles.muted}>
          {error
            ? "Project operations could not be loaded. Your awarded agreement remains available."
            : "Loading project operations…"}
        </p>
      ) : (
        <>
          {!canPlan ? (
            <p className={css.hint}>
              Planning is read only for your role.
              {data.permissions.canCompleteAssignedVisits
                ? " You can update progress on your assigned visits."
                : ""}
            </p>
          ) : null}
          {area === "operations" ? (
            <form
              className={css.form}
              onSubmit={(event) => {
                event.preventDefault();
                void saveOperations();
              }}
            >
              <p className={css.hint}>
                Organize delivery here. Changes do not rewrite the awarded scope, proposal, pricing
                or source evidence.
              </p>
              <fieldset disabled={busy || !canPlan} className={css.grid}>
                <Field label="Operational project name" wide>
                  <input
                    required
                    maxLength={240}
                    value={operations.name}
                    onChange={(event) => updateOperations("name", event.target.value)}
                  />
                </Field>
                <Field label="Project status">
                  <select
                    value={operations.status}
                    onChange={(event) =>
                      updateOperations(
                        "status",
                        event.target.value as CplProjectOperationsInput["status"],
                      )
                    }
                  >
                    {CPL_PROJECT_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {labels[value]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Project owner">
                  <select
                    value={operations.ownerIdentityId ?? ""}
                    onChange={(event) =>
                      updateOperations("ownerIdentityId", event.target.value || null)
                    }
                  >
                    <MemberOptions members={data.members} value={operations.ownerIdentityId} />
                  </select>
                </Field>
                <Field label="Project timezone">
                  <input
                    required
                    maxLength={100}
                    value={operations.timeZone}
                    onChange={(event) => updateOperations("timeZone", event.target.value)}
                  />
                </Field>
                <Field label="Next action">
                  <input
                    maxLength={2000}
                    value={operations.nextAction}
                    onChange={(event) => updateOperations("nextAction", event.target.value)}
                  />
                </Field>
                <div className={css.wide}>
                  <h3>Project team</h3>
                  <div className={css.team}>
                    {data.members.map((member) => (
                      <label key={member.identityId} className={css.check}>
                        <input
                          type="checkbox"
                          checked={operations.teamIdentityIds.includes(member.identityId)}
                          onChange={(event) =>
                            updateOperations(
                              "teamIdentityIds",
                              event.target.checked
                                ? [...operations.teamIdentityIds, member.identityId]
                                : operations.teamIdentityIds.filter(
                                    (id) => id !== member.identityId,
                                  ),
                            )
                          }
                        />
                        {member.displayName}
                      </label>
                    ))}
                  </div>
                </div>
                <Field label="Operational instructions · internal" wide>
                  <textarea
                    maxLength={20000}
                    value={operations.operationalInstructions}
                    onChange={(event) =>
                      updateOperations("operationalInstructions", event.target.value)
                    }
                  />
                </Field>
                <Field label="Private project notes" wide>
                  <textarea
                    maxLength={20000}
                    value={operations.internalNotes}
                    onChange={(event) => updateOperations("internalNotes", event.target.value)}
                  />
                </Field>
                <Field label="Project status reason" wide>
                  <textarea
                    required={operations.status !== "active"}
                    maxLength={2000}
                    value={operations.statusReason}
                    onChange={(event) => updateOperations("statusReason", event.target.value)}
                  />
                </Field>
              </fieldset>
              <div className={css.save}>
                <span role="status">
                  {dirty ? "Unsaved project changes" : "Saved project details"}
                </span>
                <button
                  className={styles.primary}
                  disabled={busy || !canPlan || stale}
                  type="submit"
                >
                  Save project operations
                </button>
              </div>
            </form>
          ) : null}
          {area === "reports" ? (
            <ReportWorkspace
              key={`${project.id}-${fieldEpoch}`}
              project={project}
              organizationId={organizationId}
              request={request}
              onDirty={changeReportDirty}
              onBusy={setReportBusy}
              initialReportId={reportSelection?.id}
              initialPreviewVersion={reportSelection?.previewVersion}
              onOpenField={(id) => {
                changeReportDirty(false);
                changeDirty(false);
                changeFieldDirty(false);
                setVisit(null);
                setEditing(null);
                setFieldVisitId(id);
                setFieldEpoch((value) => value + 1);
                setArea("field");
              }}
            />
          ) : null}
          {area === "delivery" ? (
            <DeliveryWorkspace
              key={`${project.id}-${fieldEpoch}`}
              projectId={project.id}
              organizationId={organizationId}
              request={request}
              members={data.members}
              initialPackageId={initialIntent?.kind === "package" ? initialIntent.id : undefined}
              onDirty={changeDeliveryDirty}
              onBusy={setDeliveryBusy}
              onOpenReport={(id, version) => {
                changeDeliveryDirty(false);
                changeReportDirty(false);
                changeDirty(false);
                setReportSelection({ id, previewVersion: version });
                setFieldEpoch((value) => value + 1);
                setArea("reports");
              }}
            />
          ) : null}
          {area === "field" ? (
            <section className={css.section}>
              <Field label="Field visit">
                <select
                  value={fieldVisitId ?? ""}
                  disabled={busy}
                  onChange={(event) => openField(event.target.value)}
                >
                  <option value="">Choose a visit</option>
                  {visits.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.purpose} · {labels[item.status]}
                    </option>
                  ))}
                </select>
              </Field>
              {fieldVisitId && upload && data.visits.some((item) => item.id === fieldVisitId) ? (
                <FieldWorkspace
                  key={`${project.id}-${fieldVisitId}-${fieldEpoch}`}
                  project={project}
                  visit={data.visits.find((item) => item.id === fieldVisitId)!}
                  members={data.members}
                  organizationId={organizationId}
                  request={request}
                  upload={upload}
                  onDirty={changeFieldDirty}
                  onBusy={setFieldBusy}
                  onOpenVisit={() =>
                    void run(async () => {
                      const latest = await read();
                      const selected = latest.visits.find((item) => item.id === fieldVisitId);
                      if (!selected) throw new Error("The selected visit is no longer available.");
                      changeFieldDirty(false);
                      changeDirty(false);
                      setVisit(visitInput(selected));
                      setEditing(selected);
                      setArea("visits");
                    })
                  }
                />
              ) : (
                <p className={styles.empty}>
                  {visits.length
                    ? "Choose the visit whose evidence you want to view or record."
                    : "Create a project visit before recording field evidence."}
                </p>
              )}
            </section>
          ) : null}
          {area === "visits" ? (
            <>
              <div className={css.header}>
                <div>
                  <h3>Visits & assignments</h3>
                  <p className={css.hint}>
                    Plan more than one visit. Cancelling a visit does not cancel the project.
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy || !canPlan || data.operations.status !== "active"}
                  onClick={() => editVisit(null)}
                >
                  New visit
                </button>
              </div>
              <ul className={css.agenda}>
                {visits.map((item) => (
                  <li
                    key={item.id}
                    className={css.visit}
                    data-cancelled={item.status === "cancelled"}
                  >
                    <span className={css.tag}>{labels[item.status]}</span>
                    <h3>{item.purpose}</h3>
                    <p>
                      {dateLabel(item.plannedStartAt, item.timeZone)} –{" "}
                      {dateLabel(item.plannedEndAt, item.timeZone)}
                    </p>
                    <div className={css.meta}>
                      <span>{item.timeZone}</span>
                      <span>{memberName(item.responsibleIdentityId)}</span>
                      <span>
                        {item.tasks.filter((task) => task.status === "completed").length}/
                        {item.tasks.length} tasks completed
                      </span>
                    </div>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => editVisit(item)}
                    >
                      Open visit {item.purpose}
                    </button>
                    {upload ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={busy}
                        onClick={() => openField(item.id)}
                      >
                        Open field work {item.purpose}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {!visits.length ? (
                <p className={styles.empty}>
                  No visits yet. Start with a draft or schedule the first visit.
                </p>
              ) : null}
              {visit ? (
                <form
                  className={css.form}
                  aria-label={editing ? "Edit visit" : "Create visit"}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveVisit();
                  }}
                >
                  <section className={css.section}>
                    <h3>{editing ? "Edit visit" : "New visit"}</h3>
                    {locked ? (
                      <p className={styles.warning}>
                        This visit is {labels[editing!.status].toLowerCase()} and is read only. Its
                        recorded history is retained.
                      </p>
                    ) : null}
                    <fieldset className={css.grid} disabled={busy || !canEditPlan}>
                      <Field label="Visit purpose" wide>
                        <input
                          required
                          maxLength={240}
                          value={visit.purpose}
                          onChange={(event) => updateVisit("purpose", event.target.value)}
                        />
                      </Field>
                      <Field label="Service / visit type">
                        <input
                          maxLength={240}
                          value={visit.serviceType}
                          onChange={(event) => updateVisit("serviceType", event.target.value)}
                        />
                      </Field>
                      <Field label="Responsible member">
                        <select
                          value={visit.responsibleIdentityId ?? ""}
                          onChange={(event) =>
                            updateVisit("responsibleIdentityId", event.target.value || null)
                          }
                        >
                          <MemberOptions
                            members={data.members}
                            value={visit.responsibleIdentityId}
                          />
                        </select>
                      </Field>
                      <Field label="Planned start · visit timezone">
                        <input
                          type="datetime-local"
                          value={visit.plannedStartLocal ?? ""}
                          onChange={(event) => {
                            updateVisit("plannedStartLocal", event.target.value || null);
                            updateVisit("plannedStartOffsetMinutes", null);
                          }}
                        />
                      </Field>
                      <Field label="Planned end · visit timezone">
                        <input
                          type="datetime-local"
                          value={visit.plannedEndLocal ?? ""}
                          onChange={(event) => {
                            updateVisit("plannedEndLocal", event.target.value || null);
                            updateVisit("plannedEndOffsetMinutes", null);
                          }}
                        />
                      </Field>
                      <Field label="Visit timezone" wide>
                        <input
                          required
                          maxLength={100}
                          value={visit.timeZone}
                          onChange={(event) => {
                            updateVisit("timeZone", event.target.value);
                            updateVisit("plannedStartOffsetMinutes", null);
                            updateVisit("plannedEndOffsetMinutes", null);
                          }}
                        />
                      </Field>
                      <details className={css.wide}>
                        <summary>Time details · daylight saving ambiguity</summary>
                        <p className={css.hint}>
                          Leave offsets empty for automatic validation. If a time repeats,
                          Indianapolis daylight time is −240 minutes from UTC; standard time is
                          −300.
                        </p>
                        <div className={css.grid}>
                          <Field label="Start UTC offset minutes">
                            <input
                              type="number"
                              min={-840}
                              max={840}
                              step={1}
                              value={visit.plannedStartOffsetMinutes ?? ""}
                              onChange={(event) =>
                                updateVisit(
                                  "plannedStartOffsetMinutes",
                                  event.target.value === "" ? null : Number(event.target.value),
                                )
                              }
                            />
                          </Field>
                          <Field label="End UTC offset minutes">
                            <input
                              type="number"
                              min={-840}
                              max={840}
                              step={1}
                              value={visit.plannedEndOffsetMinutes ?? ""}
                              onChange={(event) =>
                                updateVisit(
                                  "plannedEndOffsetMinutes",
                                  event.target.value === "" ? null : Number(event.target.value),
                                )
                              }
                            />
                          </Field>
                        </div>
                      </details>
                      <Field label="Visit site">
                        <input
                          maxLength={240}
                          value={visit.siteName}
                          onChange={(event) => updateVisit("siteName", event.target.value)}
                        />
                      </Field>
                      <Field label="Visit address">
                        <input
                          maxLength={2000}
                          value={visit.siteAddress}
                          onChange={(event) => updateVisit("siteAddress", event.target.value)}
                        />
                      </Field>
                      <Field label="Visit access instructions · internal" wide>
                        <textarea
                          maxLength={20000}
                          value={visit.accessInstructions}
                          onChange={(event) =>
                            updateVisit("accessInstructions", event.target.value)
                          }
                        />
                      </Field>
                    </fieldset>
                  </section>
                  <section className={css.section}>
                    <h3>Tasks & readiness</h3>
                    <p className={css.hint}>
                      Pending is not complete. Required tasks must be completed before the visit can
                      be completed.
                    </p>
                    {visit.tasks.map((task, index) => (
                      <fieldset key={task.id} className={css.task} disabled={busy || !canComplete}>
                        <Field label={`Task ${index + 1} title`}>
                          <input
                            required
                            disabled={!canEditPlan}
                            maxLength={240}
                            value={task.title}
                            onChange={(event) =>
                              updateVisit(
                                "tasks",
                                visit.tasks.map((item) =>
                                  item.id === task.id
                                    ? { ...item, title: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </Field>
                        <Field label={`Task ${index + 1} status`}>
                          <select
                            value={task.status}
                            onChange={(event) =>
                              updateVisit(
                                "tasks",
                                visit.tasks.map((item) =>
                                  item.id === task.id
                                    ? { ...item, status: event.target.value as typeof task.status }
                                    : item,
                                ),
                              )
                            }
                          >
                            {CPL_TASK_STATUSES.map((value) => (
                              <option key={value} value={value}>
                                {labels[value]}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <button
                          type="button"
                          className={styles.secondary}
                          disabled={!canEditPlan}
                          onClick={() =>
                            updateVisit(
                              "tasks",
                              visit.tasks.filter((item) => item.id !== task.id),
                            )
                          }
                        >
                          Remove task {index + 1}
                        </button>
                        <Field label={`Task ${index + 1} instructions`} wide>
                          <textarea
                            disabled={!canEditPlan}
                            maxLength={4000}
                            value={task.instructions}
                            onChange={(event) =>
                              updateVisit(
                                "tasks",
                                visit.tasks.map((item) =>
                                  item.id === task.id
                                    ? { ...item, instructions: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </Field>
                        <label className={css.check}>
                          <input
                            type="checkbox"
                            disabled={!canEditPlan}
                            checked={task.required}
                            onChange={(event) =>
                              updateVisit(
                                "tasks",
                                visit.tasks.map((item) =>
                                  item.id === task.id
                                    ? { ...item, required: event.target.checked }
                                    : item,
                                ),
                              )
                            }
                          />
                          Required task {index + 1}
                        </label>
                        <Field label={`Task ${index + 1} progress / cancellation note`} wide>
                          <textarea
                            required={task.status === "cancelled"}
                            maxLength={4000}
                            value={task.note}
                            onChange={(event) =>
                              updateVisit(
                                "tasks",
                                visit.tasks.map((item) =>
                                  item.id === task.id
                                    ? { ...item, note: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </Field>
                      </fieldset>
                    ))}
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy || !canEditPlan || visit.tasks.length >= 100}
                      onClick={() =>
                        updateVisit("tasks", [
                          ...visit.tasks,
                          {
                            id: crypto.randomUUID(),
                            title: "",
                            instructions: "",
                            required: true,
                            status: "pending",
                            note: "",
                          },
                        ])
                      }
                    >
                      Add visit task
                    </button>
                  </section>
                  <fieldset className={css.section} disabled={busy || !canComplete}>
                    <h3>Progress & completion</h3>
                    <div className={css.grid}>
                      <Field label="Visit status">
                        <select
                          value={visit.status}
                          onChange={(event) =>
                            updateVisit("status", event.target.value as CplVisitInput["status"])
                          }
                        >
                          {CPL_VISIT_STATUSES.filter((value) =>
                            allowedStatuses.includes(value),
                          ).map((value) => (
                            <option
                              key={value}
                              value={value}
                              disabled={
                                !canPlan &&
                                (value === "draft" ||
                                  value === "scheduled" ||
                                  value === "cancelled")
                              }
                            >
                              {labels[value]}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Visit completion note">
                        <textarea
                          maxLength={4000}
                          value={visit.completionNote}
                          onChange={(event) => updateVisit("completionNote", event.target.value)}
                        />
                      </Field>
                    </div>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => updateVisit("actualStartAt", new Date().toISOString())}
                      >
                        Record actual start now
                      </button>
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => updateVisit("actualEndAt", new Date().toISOString())}
                      >
                        Record actual finish now
                      </button>
                    </div>
                    <p className={css.hint}>
                      Actual start: {dateLabel(visit.actualStartAt, visit.timeZone)} · finish:{" "}
                      {dateLabel(visit.actualEndAt, visit.timeZone)} · {visit.timeZone}. Times are
                      recorded only when you choose an action.
                    </p>
                    <details>
                      <summary>Correct actual timestamps</summary>
                      <div className={css.grid}>
                        <Field label="Actual start · UTC">
                          <input
                            type="datetime-local"
                            value={visit.actualStartAt?.slice(0, 16) ?? ""}
                            onChange={(event) =>
                              updateVisit(
                                "actualStartAt",
                                event.target.value ? `${event.target.value}:00.000Z` : null,
                              )
                            }
                          />
                        </Field>
                        <Field label="Actual finish · UTC">
                          <input
                            type="datetime-local"
                            value={visit.actualEndAt?.slice(0, 16) ?? ""}
                            onChange={(event) =>
                              updateVisit(
                                "actualEndAt",
                                event.target.value ? `${event.target.value}:00.000Z` : null,
                              )
                            }
                          />
                        </Field>
                      </div>
                    </details>
                    {visit.status === "cancelled" ? (
                      <Field label="Visit cancellation reason">
                        <textarea
                          required
                          maxLength={2000}
                          value={visit.cancellationReason}
                          onChange={(event) =>
                            updateVisit("cancellationReason", event.target.value)
                          }
                        />
                      </Field>
                    ) : null}
                  </fieldset>
                  {readiness.length ? (
                    <section className={styles.warning} aria-label="Visit readiness">
                      <strong>Before completing this visit</strong>
                      <ul>
                        {readiness.map((item, index) => (
                          <li key={`${item.field}-${index}`}>{item.message}</li>
                        ))}
                      </ul>
                    </section>
                  ) : (
                    <p className={styles.ready}>
                      Required planning details and tasks are complete. Record actual work and
                      choose the visit status deliberately.
                    </p>
                  )}
                  <div className={css.save}>
                    <span role="status">
                      {dirty
                        ? "Unsaved visit changes"
                        : editing
                          ? "Saved visit details"
                          : "New visit · not saved"}
                    </span>
                    <button
                      className={styles.primary}
                      type="submit"
                      disabled={busy || !canComplete || stale}
                    >
                      Save visit
                    </button>
                  </div>
                </form>
              ) : null}
            </>
          ) : null}
          {area === "agenda" ? (
            <>
              <h3>Company visit agenda</h3>
              <p className={css.hint}>
                Dates use {data.operations.timeZone}. This agenda uses internal visits; no external
                calendar connection is needed.
              </p>
              <form
                className={css.grid}
                onSubmit={(event) => {
                  event.preventDefault();
                  void loadAgenda();
                }}
              >
                <Field label="Agenda from">
                  <input
                    required
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </Field>
                <Field label="Agenda through">
                  <input
                    required
                    type="date"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                  />
                </Field>
                <button type="submit" className={styles.secondary} disabled={busy}>
                  Load agenda
                </button>
              </form>
              {agenda?.truncated ? (
                <p className={styles.warning}>
                  More visits match this period. Narrow the date range to see all results.
                </p>
              ) : null}
              <ul className={css.agenda}>
                {agenda?.items.map((item) => (
                  <li key={item.visit.id} className={css.visit}>
                    <span className={css.tag}>
                      {labels[item.visit.status]} · {item.projectReference}
                    </span>
                    <h3>{item.visit.purpose}</h3>
                    <p>{item.projectName}</p>
                    <p>
                      {dateLabel(item.visit.plannedStartAt, item.visit.timeZone)} –{" "}
                      {dateLabel(item.visit.plannedEndAt, item.visit.timeZone)}
                    </p>
                    <p className={css.hint}>
                      {item.visit.timeZone} · {memberName(item.visit.responsibleIdentityId)}
                    </p>
                    {item.visit.projectId === project.id ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => editVisit(item.visit)}
                      >
                        Open visit {item.visit.purpose}
                      </button>
                    ) : onOpenProject ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => onOpenProject(item.visit.projectId)}
                      >
                        Open project {item.projectReference}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {agenda && !agenda.items.length ? (
                <p className={styles.empty}>No scheduled visits in this period.</p>
              ) : null}
            </>
          ) : null}
          {area === "history" ? (
            <>
              <h3>Project activity</h3>
              <p className={css.hint}>
                Saved operational changes are separate from the original awarded agreement.
              </p>
              <ol className={css.history}>
                {data.events.map((event) => (
                  <li key={event.id}>
                    <strong>{event.action.replaceAll("_", " ").replaceAll(".", " · ")}</strong>
                    <p className={css.meta}>
                      {dateLabel(event.createdAt, data.operations.timeZone)} ·{" "}
                      {memberName(event.actorIdentityId)}
                    </p>
                    <p>
                      {"purpose" in event.after ? event.after.purpose : event.after.name} ·{" "}
                      {labels[event.after.status] ?? event.after.status}
                    </p>
                    {"cancellationReason" in event.after && event.after.cancellationReason ? (
                      <p>Reason: {event.after.cancellationReason}</p>
                    ) : null}
                    {"statusReason" in event.after && event.after.statusReason ? (
                      <p>Reason: {event.after.statusReason}</p>
                    ) : null}
                    {event.before &&
                    "plannedStartLocal" in event.before &&
                    "plannedStartLocal" in event.after &&
                    (event.before.plannedStartLocal !== event.after.plannedStartLocal ||
                      event.before.plannedEndLocal !== event.after.plannedEndLocal) ? (
                      <p>
                        Schedule changed from {event.before.plannedStartLocal || "unscheduled"} –{" "}
                        {event.before.plannedEndLocal || "unscheduled"} ({event.before.timeZone}) to{" "}
                        {event.after.plannedStartLocal || "unscheduled"} –{" "}
                        {event.after.plannedEndLocal || "unscheduled"} ({event.after.timeZone}).
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
              {!data.events.length ? (
                <p className={styles.empty}>No saved operational changes yet.</p>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
