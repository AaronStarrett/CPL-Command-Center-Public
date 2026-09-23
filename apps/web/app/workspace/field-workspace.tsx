"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CplCommercialProject } from "@bea/domain/cpl-commercial";
import type { CplVisit, CplExecutionMember } from "@bea/domain/cpl-execution";
import {
  CPL_FIELD_RESULTS,
  cplFieldReadiness,
  type CplFieldAnswer,
  type CplFieldObservation,
  type CplFieldObservationInput,
  type CplFieldPhoto,
  type CplFieldPhotoMetadata,
  type CplFieldTemplateInput,
  type CplFieldWorkspace,
} from "@bea/domain/cpl-field";
import type { CommercialRequest } from "./commercial-ui";
import type { FieldUpload } from "./field-upload";
import { FieldTemplates } from "./field-templates";
import { PhotoAnnotations, validateCplPhotoAnnotations } from "./field-annotations";
import { useUnsavedNavigation } from "./commercial-navigation";
import styles from "./workspace.module.css";
import forms from "./execution.module.css";
import css from "./field.module.css";

type Area = "checklist" | "observations" | "photos" | "review" | "templates" | "history";
type UploadRow = {
  id: string;
  file: File;
  key: string;
  state: "queued" | "uploading" | "stored" | "failed";
  percent: number;
  error: string;
  photoId?: string;
};
const resultLabels = {
  complete: "Complete / pass",
  issue: "Issue / fail",
  not_applicable: "Not applicable",
  not_inspected: "Not inspected",
};
const emptyObservation = (): CplFieldObservationInput => ({
  title: "",
  location: "",
  component: "",
  description: "",
  checklistItemId: null,
  category: "",
  priority: "",
  followUp: "",
  internalNotes: "",
  reportEligible: false,
});
const messages: Record<string, string> = {
  CPL_FIELD_VERSION_CONFLICT:
    "Field information changed elsewhere. Your entries are kept. Refresh saved fieldwork and reconcile before saving again.",
  CPL_FIELD_TEMPLATE_ALREADY_ATTACHED:
    "This visit already has a retained checklist version. Create a new template version for future visits.",
  CPL_FIELD_INVALID_INPUT:
    "Review the field values, required labels, photo links and limits. Incomplete findings can remain drafts.",
  CPL_FIELD_READ_ONLY:
    "This visit is closed. Reopen completed work with a reason before changing evidence.",
  CPL_FIELD_VISIT_LOCKED:
    "This visit is closed. Reopen completed work with a reason before changing evidence.",
  CPL_EXECUTION_VERSION_CONFLICT:
    "The visit changed elsewhere. Your entries are kept. Refresh saved fieldwork before reopening.",
  CPL_IMAGE_INVALID_ANNOTATIONS:
    "Review the annotation coordinates and labels. Shapes must stay inside the image.",
  CPL_IMAGE_INVALID_TYPE: "Choose a JPEG or PNG image with matching file contents.",
  CPL_RECORD_NOT_FOUND: "This field record is not available in the selected company.",
};
const errorMessage = (error: unknown) =>
  messages[(error as { code?: string })?.code ?? ""] ??
  (error instanceof Error
    ? error.message
    : "The action could not be completed. Your entries are retained.");
function photoInput(photo: CplFieldPhoto): CplFieldPhotoMetadata {
  const { caption, observationId, order, overview, reportEligible, annotations } = photo.metadata;
  return {
    caption,
    observationId,
    order,
    overview,
    reportEligible,
    annotations: {
      coordinateSpace: annotations.coordinateSpace,
      shapes: annotations.shapes.map((shape) => ({ ...shape })),
    },
  };
}
function observationInput(observation: CplFieldObservation): CplFieldObservationInput {
  const {
    title,
    location,
    component,
    description,
    checklistItemId,
    category,
    priority,
    followUp,
    internalNotes,
    reportEligible,
  } = observation;
  return {
    title,
    location,
    component,
    description,
    checklistItemId,
    category,
    priority,
    followUp,
    internalNotes,
    reportEligible,
  };
}
function completeAnswers(data: CplFieldWorkspace): CplFieldAnswer[] {
  return (
    data.template?.sections.flatMap((section) =>
      section.items.map((item) => {
        const answer = data.answers.find((row) => row.itemId === item.id);
        return answer
          ? { ...answer, photoIds: [...answer.photoIds] }
          : {
              itemId: item.id,
              result: "not_inspected" as const,
              value: null,
              note: "",
              photoIds: [],
            };
      }),
    ) ?? []
  );
}

export function FieldWorkspace({
  project,
  visit,
  members = [],
  organizationId,
  request,
  upload,
  onDirty,
  onBusy,
  onOpenVisit,
}: {
  project: CplCommercialProject;
  visit: CplVisit;
  members?: CplExecutionMember[];
  organizationId: string;
  request: CommercialRequest;
  upload: FieldUpload;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
  onOpenVisit: () => void;
}) {
  const base = `/api/cpl-field/projects/${project.id}/visits/${visit.id}`;
  const fileInputId = useId();
  const [data, setData] = useState<CplFieldWorkspace | null>(null);
  const [area, setArea] = useState<Area>("checklist");
  const [answers, setAnswers] = useState<CplFieldAnswer[]>([]);
  const [observation, setObservation] = useState<CplFieldObservationInput | null>(null);
  const [observationId, setObservationId] = useState<string | null>(null);
  const [photo, setPhoto] = useState<CplFieldPhoto | null>(null);
  const [metadata, setMetadata] = useState<CplFieldPhotoMetadata | null>(null);
  const [editRevision, setEditRevision] = useState(0);
  const [templateSelection, setTemplateSelection] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [queue, setQueue] = useState<UploadRow[]>([]);
  const unsavedUploads = queue.some((row) => row.state === "queued" || row.state === "failed");
  const navigation = useUnsavedNavigation(dirty || unsavedUploads);
  const refs = useRef({ request, upload, onDirty, onBusy });
  useEffect(() => {
    refs.current = { request, upload, onDirty, onBusy };
  }, [request, upload, onDirty, onBusy]);
  useEffect(() => {
    refs.current.onDirty(dirty || unsavedUploads);
  }, [dirty, unsavedUploads]);
  const alive = useRef(true);
  const working = useRef(false);
  const activeUpload = useRef<AbortController | null>(null);
  const attempts = useRef<Record<string, { payload: string; key: string }>>({});
  const changeDirty = useCallback((value: boolean) => setDirty(value), []);
  const canEdit = data?.permissions.canEdit ?? false;
  const author = (id: string | null) =>
    members.find((member) => member.identityId === id)?.displayName ??
    (id ? "Recorded company member" : "Unassigned");
  function key(kind: string, input: unknown) {
    const payload = JSON.stringify({
      organizationId,
      projectId: project.id,
      visitId: visit.id,
      input,
    });
    if (attempts.current[kind]?.payload !== payload)
      attempts.current[kind] = { payload, key: crypto.randomUUID() };
    return attempts.current[kind]!.key;
  }
  function accept(value: CplFieldWorkspace) {
    if (
      value.projectId !== project.id ||
      value.visit.id !== visit.id ||
      value.visit.organizationId !== organizationId
    )
      throw new Error("The field response did not match this company, project and visit.");
    if (!alive.current) return;
    setData(value);
    setAnswers(completeAnswers(value));
    setEditRevision(value.revision);
    setStale(false);
  }
  async function read() {
    const value = await refs.current.request<CplFieldWorkspace>(base);
    accept(value);
    return value;
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
      if (alive.current) {
        setError(errorMessage(caught));
        if ((caught as { code?: string })?.code?.includes("VERSION_CONFLICT")) setStale(true);
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
    void Promise.resolve().then(() => {
      if (alive.current)
        return run(async () => {
          await read();
        });
    });
    return () => {
      alive.current = false;
      activeUpload.current?.abort();
      refs.current.onDirty(false);
      refs.current.onBusy(false);
    };
    // Parent keys by company, project and visit. Auth token changes must not erase unsaved work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, visit.id, organizationId]);
  function discard(current = data) {
    setDirty(false);
    setObservation(null);
    setObservationId(null);
    setPhoto(null);
    setMetadata(null);
    setReopenReason("");
    setTemplateSelection("");
    setQueue((items) => items.filter((row) => row.state === "stored"));
    setStale(false);
    setError("");
    setNotice("");
    if (current) {
      setAnswers(completeAnswers(current));
      setEditRevision(current.revision);
    }
  }
  function navigate(next: Area) {
    if (area !== next)
      navigation.navigate(() => {
        discard();
        setArea(next);
        setEpoch((value) => value + 1);
      });
  }
  async function mutate(action: string, body: Record<string, unknown>, message: string) {
    return run(async () => {
      const input = { ...body, expectedRevision: editRevision };
      const value = await refs.current.request<CplFieldWorkspace>(`${base}/${action}`, {
        ...input,
        idempotencyKey: key(action, input),
      });
      accept(value);
      setDirty(false);
      delete attempts.current[action];
      setNotice(message);
      if (observationId) {
        const updated = value.observations.find((item) => item.id === observationId);
        if (updated) setObservation(observationInput(updated));
      } else if (action === "observations") setObservation(null);
      if (photo) {
        const updated = value.photos.find((item) => item.id === photo.id);
        if (updated) {
          setPhoto(updated);
          setMetadata(photoInput(updated));
        }
      }
      if (action === "reopen") setReopenReason("");
    });
  }
  function answer(itemId: string, patch: Partial<CplFieldAnswer>) {
    setAnswers((items) =>
      items.map((item) => (item.itemId === itemId ? { ...item, ...patch } : item)),
    );
    setDirty(true);
  }
  function editObservation(value: CplFieldObservation | null) {
    navigation.navigate(() => {
      discard();
      setObservation(value ? observationInput(value) : emptyObservation());
      setObservationId(value?.id ?? null);
      if (data) setEditRevision(data.revision);
    });
  }
  function editPhoto(value: CplFieldPhoto) {
    navigation.navigate(() => {
      discard();
      setPhoto(value);
      setMetadata(photoInput(value));
      if (data) setEditRevision(data.revision);
    });
  }
  function fileUrl(value: CplFieldPhoto, variant: "thumbnail" | "report" | "original") {
    return `${base}/photos/${value.id}/file?variant=${variant}&organization=${encodeURIComponent(organizationId)}`;
  }
  function addFiles(files: FileList | null) {
    if (!files) return;
    const rows: UploadRow[] = Array.from(files).map((file) => ({
      id: crypto.randomUUID(),
      key: crypto.randomUUID(),
      file,
      state: "queued",
      percent: 0,
      error: "",
    }));
    setQueue((current) => [...current, ...rows]);
  }
  async function uploadRows(rows: UploadRow[]) {
    await run(async () => {
      for (const row of rows) {
        if (!alive.current) break;
        const controller = new AbortController();
        activeUpload.current = controller;
        setQueue((items) =>
          items.map((item) =>
            item.id === row.id ? { ...item, state: "uploading", percent: 0, error: "" } : item,
          ),
        );
        try {
          const value = await refs.current.upload<CplFieldPhoto>({
            projectId: project.id,
            visitId: visit.id,
            file: row.file,
            idempotencyKey: row.key,
            signal: controller.signal,
            onProgress: (percent) => {
              if (alive.current)
                setQueue((items) =>
                  items.map((item) => (item.id === row.id ? { ...item, percent } : item)),
                );
            },
          });
          if (
            value.projectId !== project.id ||
            value.visitId !== visit.id ||
            value.organizationId !== organizationId
          )
            throw new Error("The upload response did not match this visit.");
          const originalUnconfirmed =
            value.state === "reserved" || value.failureCode === "CPL_PHOTO_ORIGINAL_UNAVAILABLE";
          if (alive.current)
            setQueue((items) =>
              items.map((item) =>
                item.id === row.id
                  ? {
                      ...item,
                      state: originalUnconfirmed ? "failed" : "stored",
                      photoId: value.id,
                      percent: 100,
                      error: originalUnconfirmed
                        ? "The photo record exists but the original file is not confirmed. Retry this same file."
                        : "",
                    }
                  : item,
              ),
            );
        } catch (caught) {
          if (alive.current)
            setQueue((items) =>
              items.map((item) =>
                item.id === row.id
                  ? { ...item, state: "failed", error: errorMessage(caught) }
                  : item,
              ),
            );
        } finally {
          activeUpload.current = null;
        }
      }
      if (alive.current) {
        await read();
        setPhoto(null);
        setMetadata(null);
        setNotice(
          "Upload attempts finished. Check each file and the saved photo processing status below.",
        );
      }
    });
  }
  const items = data?.template?.sections.flatMap((section) => section.items) ?? [];
  const photos = [...(data?.photos ?? [])].sort(
    (a, b) =>
      a.metadata.order - b.metadata.order ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const readiness = data ? cplFieldReadiness(data.template, answers, data.photos) : [];
  return (
    <section className={css.shell} aria-label="Visit field workspace">
      {navigation.dialog}
      <header className={css.context}>
        <p className={styles.eyebrow}>FIELD WORK · {project.reference}</p>
        <h3>{data?.visit.purpose ?? visit.purpose}</h3>
        <p>
          {project.snapshot.version.sourceLead.fields.customerName} ·{" "}
          {data?.visit.siteName || visit.siteName}
        </p>
        <p className={forms.hint}>
          {data?.visit.siteAddress || visit.siteAddress} · {visit.timeZone}
        </p>
        <p className={forms.hint}>
          Responsible: {author((data?.visit ?? visit).responsibleIdentityId)} · Planned:{" "}
          {(data?.visit ?? visit).plannedStartLocal?.replace("T", " ") || "Not scheduled"} ·{" "}
          {(data?.visit ?? visit).status.replaceAll("_", " ")}
        </p>
        <details>
          <summary>Visit scope & access</summary>
          <p className={styles.document}>{project.snapshot.version.content.scope}</p>
          <p className={styles.document}>
            Internal access instructions:{" "}
            {data?.visit.accessInstructions || visit.accessInstructions || "Not recorded"}
          </p>
        </details>
      </header>
      <div className={css.actions}>
        <p className={forms.hint}>
          Online saves are authoritative. Unsaved entries remain in this tab only; offline
          synchronization is not available.
        </p>
        <button
          className={styles.secondary}
          disabled={busy}
          type="button"
          onClick={() =>
            navigation.navigate(
              () =>
                void run(async () => {
                  const latest = await read();
                  discard(latest);
                  setEpoch((value) => value + 1);
                  setNotice("Saved fieldwork refreshed. Discarded entries were not saved.");
                }),
            )
          }
        >
          Refresh saved fieldwork
        </button>
      </div>
      <nav className={forms.tabs} aria-label="Field workspace sections">
        {(
          [
            ["checklist", "Checklist"],
            ["observations", "Observations"],
            ["photos", "Photos"],
            ["review", "Review visit"],
            ["templates", "Checklist templates"],
            ["history", "Field history"],
          ] as const
        ).map(([next, label]) => (
          <button
            key={next}
            disabled={busy}
            type="button"
            aria-current={area === next ? "page" : undefined}
            onClick={() => navigate(next)}
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
      {busy ? (
        <p role="status" className={forms.hint}>
          Saving or loading field information…
        </p>
      ) : null}
      {!data ? (
        <p>
          {error ? "Fieldwork is unavailable. Refresh to try again." : "Loading saved fieldwork…"}
        </p>
      ) : (
        <>
          {!canEdit ? (
            <p className={styles.warning}>
              Field records are read only for your role or this visit status. Existing evidence
              remains available.
            </p>
          ) : null}
          {area === "checklist" ? (
            <section className={css.stack}>
              {!data.template ? (
                <form
                  className={forms.form}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const chosen = data.templates.find(
                      (value) => `${value.id}:${value.version}` === templateSelection,
                    );
                    if (chosen)
                      void mutate(
                        "template",
                        { templateId: chosen.id, templateVersion: chosen.version },
                        "Checklist version attached. This visit will retain it when newer templates are created.",
                      );
                  }}
                >
                  <h3>Choose this visit’s checklist</h3>
                  <p className={forms.hint}>
                    An attached template version is retained with this visit. Review the service fit
                    before attaching it.
                  </p>
                  <label className={forms.field}>
                    <span>Visit checklist version</span>
                    <select
                      required
                      disabled={busy || !data.permissions.canAttachTemplate}
                      value={templateSelection}
                      onChange={(event) => {
                        setTemplateSelection(event.target.value);
                        setDirty(true);
                      }}
                    >
                      <option value="">Choose a checklist version</option>
                      {data.templates.map((value) => (
                        <option
                          key={`${value.id}:${value.version}`}
                          value={`${value.id}:${value.version}`}
                        >
                          {value.name} · v{value.version}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="submit"
                    className={styles.primary}
                    disabled={
                      busy || stale || !data.permissions.canAttachTemplate || !templateSelection
                    }
                  >
                    Attach checklist version
                  </button>
                  {!data.templates.length ? (
                    <p>
                      No templates are saved yet. Use Checklist templates to create or adapt an
                      example.
                    </p>
                  ) : null}
                </form>
              ) : (
                <form
                  className={forms.form}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate(
                      "checklist",
                      { answers },
                      "Checklist draft saved. Incomplete items remain visible until they are addressed.",
                    );
                  }}
                >
                  <div>
                    <h3>
                      {data.template.name} · v{data.template.version}
                    </h3>
                    <p className={forms.hint}>{data.template.description}</p>
                  </div>
                  <fieldset disabled={busy || !canEdit} className={css.stack}>
                    {data.template.sections.map((section) => (
                      <section key={section.id} className={css.stack}>
                        <h3>{section.title}</h3>
                        {section.items.map((item) => {
                          const row = answers.find((value) => value.itemId === item.id)!;
                          return (
                            <section
                              key={item.id}
                              className={css.fieldCard}
                              aria-label={item.label}
                              id={`field-${item.id}`}
                            >
                              <h4>
                                {item.label}
                                {item.required ? " · required" : ""}
                              </h4>
                              {item.instructions ? (
                                <p className={forms.hint}>{item.instructions}</p>
                              ) : null}
                              <div
                                className={css.result}
                                role="radiogroup"
                                aria-label={`${item.label} result`}
                              >
                                {CPL_FIELD_RESULTS.map((result) => (
                                  <label key={result}>
                                    <input
                                      type="radio"
                                      name={`result-${item.id}`}
                                      checked={row.result === result}
                                      onChange={() => answer(item.id, { result })}
                                    />
                                    {resultLabels[result]}
                                  </label>
                                ))}
                              </div>
                              {item.type === "text" ? (
                                <label className={forms.field}>
                                  <span>{item.label} value</span>
                                  <textarea
                                    maxLength={8000}
                                    value={typeof row.value === "string" ? row.value : ""}
                                    onChange={(event) =>
                                      answer(item.id, { value: event.target.value })
                                    }
                                  />
                                </label>
                              ) : item.type === "number" ? (
                                <label className={forms.field}>
                                  <span>
                                    {item.label} value{item.unit ? ` (${item.unit})` : ""}
                                  </span>
                                  <input
                                    type="number"
                                    step="any"
                                    value={typeof row.value === "number" ? row.value : ""}
                                    onChange={(event) =>
                                      answer(item.id, {
                                        value:
                                          event.target.value === ""
                                            ? null
                                            : Number(event.target.value),
                                      })
                                    }
                                  />
                                </label>
                              ) : item.type === "date" ? (
                                <label className={forms.field}>
                                  <span>{item.label} value</span>
                                  <input
                                    type="date"
                                    value={typeof row.value === "string" ? row.value : ""}
                                    onChange={(event) =>
                                      answer(item.id, { value: event.target.value || null })
                                    }
                                  />
                                </label>
                              ) : item.type === "choice" ? (
                                <label className={forms.field}>
                                  <span>{item.label} value</span>
                                  <select
                                    value={typeof row.value === "string" ? row.value : ""}
                                    onChange={(event) =>
                                      answer(item.id, { value: event.target.value || null })
                                    }
                                  >
                                    <option value="">Not recorded</option>
                                    {item.options.map((option) => (
                                      <option key={option}>{option}</option>
                                    ))}
                                  </select>
                                </label>
                              ) : item.type === "checkbox" ? (
                                <label className={forms.check}>
                                  <input
                                    type="checkbox"
                                    checked={row.value === true}
                                    onChange={(event) =>
                                      answer(item.id, { value: event.target.checked })
                                    }
                                  />
                                  {item.label} confirmed
                                </label>
                              ) : (
                                <p className={forms.hint}>
                                  Select at least {item.minimumPhotos} saved, ready photo(s) below.
                                </p>
                              )}
                              <label className={forms.field}>
                                <span>{item.label} note / N/A reason</span>
                                <textarea
                                  maxLength={8000}
                                  value={row.note}
                                  onChange={(event) =>
                                    answer(item.id, { note: event.target.value })
                                  }
                                />
                              </label>
                              {data.photos.length ? (
                                <details open={item.minimumPhotos > 0}>
                                  <summary>
                                    Linked photos
                                    {item.minimumPhotos ? ` · ${item.minimumPhotos} required` : ""}
                                  </summary>
                                  <div className={forms.team}>
                                    {photos.map((value) => (
                                      <label key={value.id} className={forms.check}>
                                        <input
                                          type="checkbox"
                                          checked={row.photoIds.includes(value.id)}
                                          onChange={(event) =>
                                            answer(item.id, {
                                              photoIds: event.target.checked
                                                ? [...row.photoIds, value.id]
                                                : row.photoIds.filter((id) => id !== value.id),
                                            })
                                          }
                                        />
                                        {value.metadata.caption || value.original.filename} ·{" "}
                                        {value.state}
                                      </label>
                                    ))}
                                  </div>
                                </details>
                              ) : item.minimumPhotos ? (
                                <p className={styles.warning}>
                                  No saved photos are available yet. Save this draft and use Photos
                                  to add evidence.
                                </p>
                              ) : null}
                            </section>
                          );
                        })}
                      </section>
                    ))}
                  </fieldset>
                  <div className={forms.save}>
                    <span role="status">
                      {dirty ? "Unsaved checklist entries" : "Saved checklist draft"}
                    </span>
                    <button
                      type="submit"
                      className={styles.primary}
                      disabled={busy || !canEdit || stale}
                    >
                      Save checklist draft
                    </button>
                  </div>
                </form>
              )}
              {readiness.length ? (
                <section className={styles.warning} aria-label="Field readiness">
                  <strong>Incomplete field requirements</strong>
                  <ul>
                    {readiness.map((item, index) => (
                      <li key={`${item.field}:${index}`}>
                        <a href={`#field-${item.field}`}>{item.message}</a>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : data.template ? (
                <p className={styles.ready}>
                  Current checklist requirements are met. Visit completion still requires a
                  deliberate human action.
                </p>
              ) : null}
            </section>
          ) : null}
          {area === "observations" ? (
            <section className={css.stack}>
              <div className={css.actions}>
                <h3>Observed conditions</h3>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy || !canEdit}
                  onClick={() => editObservation(null)}
                >
                  New observation
                </button>
              </div>
              <p className={forms.hint}>
                Record what was actually observed. Category, priority and follow-up are human
                decisions; no diagnosis is generated.
              </p>
              {data.observations.map((value) => (
                <article className={css.fieldCard} key={value.id}>
                  <h4>{value.title}</h4>
                  <p>
                    {value.location || "Location not recorded"}
                    {value.component ? ` · ${value.component}` : ""}
                  </p>
                  <p className={styles.document}>
                    {value.description || "Description not yet recorded"}
                  </p>
                  <p className={forms.hint}>
                    {value.reportEligible ? "Eligible for report selection" : "Internal only"} ·
                    revision {value.revision} · {author(value.createdByIdentityId)} ·{" "}
                    {new Date(value.createdAt).toLocaleString()}
                  </p>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() => editObservation(value)}
                  >
                    Open observation {value.title}
                  </button>
                </article>
              ))}
              {!data.observations.length ? (
                <p className={styles.empty}>
                  No observations saved yet. A title is enough to start a draft.
                </p>
              ) : null}
              {observation ? (
                <form
                  className={forms.form}
                  aria-label="Observation editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate(
                      "observations",
                      { ...(observationId ? { observationId } : {}), input: observation },
                      "Observation saved with its evidence history.",
                    );
                  }}
                >
                  <fieldset className={forms.grid} disabled={busy || !canEdit}>
                    {(
                      [
                        ["title", "Observation title"],
                        ["location", "Area / location"],
                        ["component", "Component"],
                        ["category", "Category · human selected"],
                        ["priority", "Priority · human selected"],
                      ] as const
                    ).map(([field, label]) => (
                      <label key={field} className={forms.field}>
                        <span>{label}</span>
                        <input
                          required={field === "title"}
                          maxLength={
                            field === "title"
                              ? 240
                              : field === "category" || field === "priority"
                                ? 120
                                : 1000
                          }
                          value={observation[field]}
                          onChange={(event) => {
                            setObservation({ ...observation, [field]: event.target.value });
                            setDirty(true);
                          }}
                        />
                      </label>
                    ))}
                    <label className={forms.field}>
                      <span>Linked checklist item</span>
                      <select
                        value={observation.checklistItemId ?? ""}
                        onChange={(event) => {
                          setObservation({
                            ...observation,
                            checklistItemId: event.target.value || null,
                          });
                          setDirty(true);
                        }}
                      >
                        <option value="">No checklist link</option>
                        {items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(
                      [
                        ["description", "Observation text"],
                        ["followUp", "Human-written follow-up"],
                        ["internalNotes", "Private observation notes"],
                      ] as const
                    ).map(([field, label]) => (
                      <label key={field} className={`${forms.field} ${forms.wide}`}>
                        <span>{label}</span>
                        <textarea
                          maxLength={20000}
                          value={observation[field]}
                          onChange={(event) => {
                            setObservation({ ...observation, [field]: event.target.value });
                            setDirty(true);
                          }}
                        />
                      </label>
                    ))}
                    <label className={`${forms.check} ${forms.wide}`}>
                      <input
                        type="checkbox"
                        checked={observation.reportEligible}
                        onChange={(event) => {
                          setObservation({ ...observation, reportEligible: event.target.checked });
                          setDirty(true);
                        }}
                      />
                      Observation eligible for report selection
                    </label>
                    <p className={`${forms.hint} ${forms.wide}`}>
                      Unchecked observations remain internal. Private observation notes are excluded
                      from customer content even when the observation is eligible. Report inclusion
                      is a separate choice.
                    </p>
                  </fieldset>
                  <div className={forms.save}>
                    <span>{dirty ? "Unsaved observation" : "Observation draft"}</span>
                    <button
                      type="submit"
                      className={styles.primary}
                      disabled={busy || !canEdit || stale}
                    >
                      Save observation
                    </button>
                  </div>
                </form>
              ) : null}
            </section>
          ) : null}
          {area === "photos" ? (
            <section className={css.stack}>
              <h3>Photo evidence</h3>
              <p className={css.preserved}>
                Originals are retained. Captions, ordering, report eligibility and annotations are
                saved as metadata; excluding a photo from a report does not delete its original.
              </p>
              <section className={css.upload}>
                <label htmlFor={fileInputId}>Choose JPEG or PNG photos · up to 12 MiB each</label>
                <input
                  id={fileInputId}
                  type="file"
                  accept="image/jpeg,image/png"
                  multiple
                  disabled={busy || !canEdit || dirty}
                  onChange={(event) => {
                    addFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
                <details>
                  <summary>Optional camera capture</summary>
                  <label className={forms.field}>
                    <span>Take a photo with a supported device</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png"
                      capture="environment"
                      disabled={busy || !canEdit || dirty}
                      onChange={(event) => {
                        addFiles(event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  <p className={forms.hint}>
                    Device support varies. Ordinary file selection always remains available. This
                    loopback development app is not exposed to a phone over the network.
                  </p>
                </details>
                {dirty ? (
                  <p className={forms.hint}>
                    Save or discard photo edits before uploading additional files.
                  </p>
                ) : null}
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy || !canEdit || dirty || !unsavedUploads}
                  onClick={() =>
                    void uploadRows(
                      queue.filter((row) => row.state === "queued" || row.state === "failed"),
                    )
                  }
                >
                  Upload selected photos
                </button>
              </section>
              <ul className={css.queue} aria-label="Photo upload progress">
                {queue.map((row) => (
                  <li key={row.id}>
                    <strong>{row.file.name}</strong>
                    <p role="status">
                      {row.state === "queued"
                        ? "Waiting to upload"
                        : row.state === "uploading"
                          ? row.percent === 100
                            ? "Transferred · validating and storing…"
                            : `Uploading ${row.percent}%`
                          : row.state === "stored"
                            ? "Photo record saved · see original and preview status below"
                            : "Upload not confirmed"}
                    </p>
                    {row.state === "uploading" ? (
                      <>
                        <progress
                          max={100}
                          value={row.percent}
                          aria-label={`${row.file.name} upload progress`}
                        />
                        <button
                          type="button"
                          className={styles.secondary}
                          onClick={() => activeUpload.current?.abort()}
                        >
                          Cancel current upload
                        </button>
                      </>
                    ) : null}
                    {row.error ? <p role="alert">{row.error}</p> : null}
                    {row.state === "failed" ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={busy || !canEdit || dirty}
                        onClick={() => void uploadRows([row])}
                      >
                        Retry {row.file.name}
                      </button>
                    ) : null}
                    {row.state === "queued" || row.state === "failed" ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={busy}
                        onClick={() =>
                          setQueue((current) => current.filter((value) => value.id !== row.id))
                        }
                      >
                        Remove {row.file.name} from upload queue
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <ul className={css.photos}>
                {photos.map((value) => (
                  <li key={value.id} className={css.photo}>
                    {value.thumbnail ? (
                      <svg
                        className={css.photoImage}
                        viewBox={`0 0 ${value.thumbnail.width} ${value.thumbnail.height}`}
                        role="img"
                        aria-label={value.metadata.caption || value.original.filename}
                      >
                        <image
                          href={fileUrl(value, "thumbnail")}
                          width={value.thumbnail.width}
                          height={value.thumbnail.height}
                          preserveAspectRatio="xMidYMid meet"
                        />
                      </svg>
                    ) : (
                      <div className={css.photoBody}>
                        Preview {value.state === "failed" ? "failed" : "not ready"}. Original status
                        is retained separately.
                      </div>
                    )}
                    <div className={css.photoBody}>
                      <strong>{value.metadata.caption || value.original.filename}</strong>
                      <p className={forms.hint}>
                        {value.state} · order {value.metadata.order}
                        {value.metadata.overview ? " · overview" : ""} ·{" "}
                        {value.metadata.reportEligible
                          ? "Eligible for report selection"
                          : "Internal only"}
                      </p>
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={busy}
                        onClick={() => editPhoto(value)}
                      >
                        Edit photo {value.original.filename}
                      </button>
                      {value.state !== "ready" ? (
                        <button
                          type="button"
                          className={styles.secondary}
                          disabled={busy || !canEdit || dirty}
                          onClick={() =>
                            void run(async () => {
                              const input = { photoId: value.id };
                              const checked = await refs.current.request<CplFieldPhoto>(
                                `${base}/photos/${value.id}/retry`,
                                {
                                  idempotencyKey: key(`retry:${value.id}`, input),
                                },
                              );
                              await read();
                              delete attempts.current[`retry:${value.id}`];
                              setNotice(
                                checked.failureCode === "CPL_PHOTO_ORIGINAL_UNAVAILABLE"
                                  ? "The original file is unavailable. Choose the photo again to start a new upload. The earlier failed attempt remains in the history."
                                  : "Photo processing retried. Check the recorded preview status.",
                              );
                            })
                          }
                        >
                          {value.state === "reserved" ||
                          value.failureCode === "CPL_PHOTO_ORIGINAL_UNAVAILABLE"
                            ? "Check original and recover"
                            : "Retry preview"}{" "}
                          {value.original.filename}
                        </button>
                      ) : null}
                      {value.state !== "reserved" &&
                      value.failureCode !== "CPL_PHOTO_ORIGINAL_UNAVAILABLE" ? (
                        <a href={fileUrl(value, "original")}>
                          Download original {value.original.filename}
                        </a>
                      ) : (
                        <p className={styles.warning}>
                          Original file is not confirmed. Retry the original upload using the same
                          file.
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {!photos.length ? (
                <p className={styles.empty}>
                  No saved photos yet. Original evidence will appear here after upload.
                </p>
              ) : null}
              {photo && metadata ? (
                <form
                  className={forms.form}
                  aria-label="Photo editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    try {
                      validateCplPhotoAnnotations(metadata.annotations);
                    } catch {
                      setError(messages.CPL_IMAGE_INVALID_ANNOTATIONS!);
                      return;
                    }
                    void mutate(
                      `photos/${photo.id}`,
                      { input: metadata },
                      "Photo metadata and annotation revision saved. The original image is unchanged.",
                    );
                  }}
                >
                  <h3>{photo.original.filename}</h3>
                  <fieldset className={forms.grid} disabled={busy || !canEdit}>
                    <label className={`${forms.field} ${forms.wide}`}>
                      <span>Photo caption</span>
                      <textarea
                        maxLength={4000}
                        value={metadata.caption}
                        onChange={(event) => {
                          setMetadata({ ...metadata, caption: event.target.value });
                          setDirty(true);
                        }}
                      />
                    </label>
                    <label className={forms.field}>
                      <span>Photo observation</span>
                      <select
                        value={metadata.observationId ?? ""}
                        onChange={(event) => {
                          setMetadata({ ...metadata, observationId: event.target.value || null });
                          setDirty(true);
                        }}
                      >
                        <option value="">Visit-level photo</option>
                        {data.observations.map((value) => (
                          <option key={value.id} value={value.id}>
                            {value.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={forms.field}>
                      <span>Photo display order · lowest first</span>
                      <input
                        type="number"
                        min={0}
                        max={9999}
                        step={1}
                        value={metadata.order}
                        onChange={(event) => {
                          setMetadata({ ...metadata, order: Number(event.target.value) });
                          setDirty(true);
                        }}
                      />
                    </label>
                    <label className={forms.check}>
                      <input
                        type="checkbox"
                        checked={metadata.overview}
                        onChange={(event) => {
                          setMetadata({ ...metadata, overview: event.target.checked });
                          setDirty(true);
                        }}
                      />
                      Overview / primary photo
                    </label>
                    <label className={forms.check}>
                      <input
                        type="checkbox"
                        checked={metadata.reportEligible}
                        onChange={(event) => {
                          setMetadata({ ...metadata, reportEligible: event.target.checked });
                          setDirty(true);
                        }}
                      />
                      Photo eligible for report selection
                    </label>
                  </fieldset>
                  <p className={forms.hint}>
                    Equal display-order values retain their upload order. Uncheck report eligibility
                    to exclude this image while preserving the original.
                  </p>
                  {photo.upright && photo.thumbnail ? (
                    <PhotoAnnotations
                      value={metadata.annotations}
                      src={fileUrl(photo, "thumbnail")}
                      width={photo.upright.width}
                      height={photo.upright.height}
                      disabled={busy || !canEdit}
                      onChange={(value) => {
                        setMetadata({ ...metadata, annotations: value });
                        setDirty(true);
                      }}
                    />
                  ) : (
                    <p className={styles.warning}>
                      Annotation preview is unavailable until image processing succeeds. Caption and
                      report choices remain separate from the original.
                    </p>
                  )}
                  <div className={forms.save}>
                    <span>
                      {dirty
                        ? "Unsaved photo changes"
                        : `Saved photo metadata v${photo.metadata.revision}`}
                    </span>
                    <button
                      type="submit"
                      className={styles.primary}
                      disabled={busy || !canEdit || stale}
                    >
                      Save photo changes
                    </button>
                  </div>
                </form>
              ) : null}
            </section>
          ) : null}
          {area === "review" ? (
            <section className={css.stack}>
              <h3>Review this visit’s fieldwork</h3>
              <p>Visit status: {data.visit.status.replaceAll("_", " ")}</p>
              <p>
                {data.observations.length} saved observations ·{" "}
                {data.photos.filter((value) => value.state === "ready").length}/{data.photos.length}{" "}
                photos ready
              </p>
              {data.readiness.length ? (
                <section className={styles.warning}>
                  <strong>Address these before completion</strong>
                  <ul>
                    {data.readiness.map((item, index) => (
                      <li key={`${item.field}:${index}`}>{item.message}</li>
                    ))}
                  </ul>
                </section>
              ) : (
                <p className={styles.ready}>
                  No saved field requirements are outstanding. Review the content and actual visit
                  work before completing it.
                </p>
              )}
              <button
                type="button"
                className={styles.primary}
                disabled={busy}
                onClick={() => navigation.navigate(onOpenVisit)}
              >
                Open visit progress & completion
              </button>
              <p className={forms.hint}>
                Field readiness is separate from visit completion and project status. A download or
                saved record is not customer delivery.
              </p>
              {data.permissions.canReopen && data.visit.status === "completed" ? (
                <form
                  className={forms.form}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate(
                      "reopen",
                      { reason: reopenReason, expectedVisitRevision: data.visit.revision },
                      "Completed visit reopened with its history retained. Earlier evidence revisions remain unchanged.",
                    );
                  }}
                >
                  <label className={forms.field}>
                    <span>Reason to reopen completed fieldwork</span>
                    <textarea
                      required
                      maxLength={2000}
                      value={reopenReason}
                      onChange={(event) => {
                        setReopenReason(event.target.value);
                        setDirty(true);
                      }}
                    />
                  </label>
                  <button
                    type="submit"
                    className={styles.secondary}
                    disabled={busy || stale || !reopenReason.trim()}
                  >
                    Reopen completed visit
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}
          {area === "templates" ? (
            <FieldTemplates
              key={epoch}
              templates={data.templates}
              allowed={data.permissions.canManageTemplates}
              busy={busy}
              onDirty={changeDirty}
              onSave={(input: CplFieldTemplateInput, prior) =>
                run(async () => {
                  const body = {
                    input,
                    expectedVersion: prior?.expectedVersion ?? 0,
                    ...(prior ? { templateId: prior.templateId } : {}),
                  };
                  await refs.current.request("/api/cpl-field/templates", {
                    ...body,
                    idempotencyKey: key("template-create", body),
                  });
                  await read();
                  delete attempts.current["template-create"];
                  setDirty(false);
                  setEpoch((value) => value + 1);
                  setNotice(
                    "Checklist template version saved. Existing visits retain their attached version.",
                  );
                })
              }
            />
          ) : null}
          {area === "history" ? (
            <section className={css.stack}>
              <h3>Field evidence history</h3>
              <p className={forms.hint}>
                Saved checklist, observation and photo metadata revisions remain available to the
                report workflow.
              </p>
              <ol className={forms.history}>
                {data.events.map((event) => (
                  <li key={event.id}>
                    <strong>{event.action.replaceAll("_", " ").replaceAll(".", " · ")}</strong>
                    <p>
                      {new Date(event.createdAt).toLocaleString()} · saved revision {event.revision}
                    </p>
                    {event.note ? <p>{event.note}</p> : null}
                  </li>
                ))}
              </ol>
              {!data.events.length ? <p>No field changes recorded yet.</p> : null}
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
