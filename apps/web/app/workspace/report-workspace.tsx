"use client";

import Image from "next/image";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  normalizeCplReportContent,
  type CplReportContent,
  type CplReportDetail,
  type CplReportPublicProjection,
  type CplReportWorkspace,
  type CplReportVersion,
} from "@bea/domain/cpl-report";
import type { CplCommercialProject } from "@bea/domain/cpl-commercial";
import type { CommercialRequest } from "./commercial-ui";
import { projectCplPhotoAnnotations } from "@bea/artifacts/cpl-photo-annotations";
import { useUnsavedNavigation } from "./commercial-navigation";
import { ReportSourceFields, ReportTextFields, reportLabels } from "./report-editor";
import { ReportBranding, ReportTemplates } from "./report-settings";
import styles from "./workspace.module.css";
import forms from "./execution.module.css";
import css from "./field.module.css";

type Area = "builder" | "preview" | "history" | "templates" | "branding";
type Preview = {
  reportId: string;
  version: number;
  approvalState: "approved" | "unapproved";
  projection: CplReportPublicProjection;
};
const labels = {
  draft: "Draft",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
};
const errors: Record<string, string> = {
  CPL_REPORT_VERSION_CONFLICT:
    "The saved report changed elsewhere. Your entries are kept. Refresh the saved report and reconcile before trying again.",
  CPL_REPORT_SOURCES_CHANGED:
    "Selected field evidence changed. Your report wording is kept. Refresh sources deliberately before saving or submitting.",
  CPL_REPORT_SOURCE_UNAVAILABLE:
    "Selected source evidence is no longer available. Review the selections before saving.",
  CPL_REPORT_SOURCE_NOT_ELIGIBLE:
    "Selected field evidence is no longer eligible for a report. Remove it or review the field record before saving.",
  CPL_REPORT_NOT_READY:
    "The report is not ready for review. Check the listed requirements and field evidence.",
  CPL_REPORT_STATE_CONFLICT:
    "The report state changed or does not permit this action. Refresh the saved report.",
  CPL_REPORT_INVALID_INPUT:
    "Review the title, section headings and selected evidence. Each photo can appear only once.",
  CPL_RECORD_NOT_FOUND: "This report or selected evidence is unavailable in the current company.",
};
function copyContent(value: CplReportContent): CplReportContent {
  return structuredClone(value);
}
function savedVersion(value: CplReportDetail) {
  const version = value.versions.find((item) => item.version === value.currentVersion);
  if (!version) throw new Error("The report response did not contain its saved version.");
  return version;
}
function ReportPreviewPhoto({
  photo,
  url,
}: {
  photo: CplReportPublicProjection["visits"][number]["observations"][number]["photos"][number];
  url: string;
}) {
  const marker = useId().replaceAll(":", "");
  const shapes = projectCplPhotoAnnotations(photo.annotations, {
    x: 0,
    y: 0,
    width: photo.width,
    height: photo.height,
  });
  return (
    <svg
      className={css.photoImage}
      viewBox={`0 0 ${photo.width} ${photo.height}`}
      role="img"
      aria-label={photo.caption || "Selected report photo"}
    >
      <defs>
        <marker
          id={marker}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      </defs>
      <image
        href={url}
        width={photo.width}
        height={photo.height}
        preserveAspectRatio="xMidYMid meet"
      />
      {shapes.map((shape, index) => (
        <g key={index} data-annotation-kind={shape.kind}>
          {shape.kind === "arrow" ? (
            <line
              x1={shape.x1}
              y1={shape.y1}
              x2={shape.x2}
              y2={shape.y2}
              stroke={shape.color}
              strokeWidth={shape.strokeWidth}
              markerEnd={`url(#${marker})`}
            />
          ) : shape.kind === "rectangle" ? (
            <rect
              x={shape.x}
              y={shape.y}
              width={shape.width}
              height={shape.height}
              stroke={shape.color}
              strokeWidth={shape.strokeWidth}
              fill="none"
            />
          ) : shape.kind === "ellipse" ? (
            <ellipse
              cx={shape.x + shape.width / 2}
              cy={shape.y + shape.height / 2}
              rx={shape.width / 2}
              ry={shape.height / 2}
              stroke={shape.color}
              strokeWidth={shape.strokeWidth}
              fill="none"
            />
          ) : shape.kind === "label" ? (
            <text
              x={shape.x}
              y={shape.y}
              fill={shape.color}
              fontSize={shape.fontSize}
              dominantBaseline="hanging"
              fontFamily="Arial, sans-serif"
            >
              {shape.text}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}
function CustomerReport({
  preview,
  projectId,
  organizationId,
}: {
  preview: Preview;
  projectId: string;
  organizationId: string;
}) {
  const document = preview.projection;
  return (
    <article className={`${styles.panel} ${css.stack}`} aria-label="Customer report preview">
      <p className={preview.approvalState === "approved" ? styles.ready : styles.warning}>
        {preview.approvalState === "approved" ? "Approved report" : "UNAPPROVED DRAFT"} ·{" "}
        {document.reference} · Version {preview.version}
      </p>
      <header className={css.context} style={{ borderColor: document.company.accentColor }}>
        {document.company.logoDataUrl ? (
          <Image
            unoptimized
            src={document.company.logoDataUrl}
            alt={`${document.company.businessName} logo`}
            width={180}
            height={90}
            style={{ objectFit: "contain" }}
          />
        ) : null}
        <h3>{document.company.businessName}</h3>
        <p>{[document.company.email, document.company.phone].filter(Boolean).join(" · ")}</p>
        <p>{document.company.address}</p>
      </header>
      <h2>{document.title}</h2>
      <p>
        {document.project.customerName} · {document.project.siteName}
      </p>
      <p>{document.project.siteAddress}</p>
      {document.sectionOrder.map((key) =>
        key === "visits" ? (
          <section key={key} className={css.stack}>
            <h3>{reportLabels.visits}</h3>
            {document.visits.map((visit, index) => (
              <section key={index} className={css.fieldCard}>
                <h3>{visit.title}</h3>
                <p>
                  {visit.date
                    ? /^\d{4}-\d{2}-\d{2}$/u.test(visit.date)
                      ? visit.date
                      : new Date(visit.date).toLocaleString("en-US", { timeZone: visit.timeZone })
                    : "Date not recorded"}{" "}
                  · {visit.timeZone}
                </p>
                <p>{visit.personnel.join(", ")}</p>
                {visit.observations.map((observation, findingIndex) => (
                  <section key={findingIndex} className={css.stack}>
                    <h4>{observation.title}</h4>
                    {observation.location ? <p>{observation.location}</p> : null}
                    {observation.category || observation.priority ? (
                      <p>
                        {[observation.category, observation.priority].filter(Boolean).join(" · ")}
                      </p>
                    ) : null}
                    <p className={styles.document}>{observation.description}</p>
                    {observation.followUp ? (
                      <div>
                        <strong>Recommendations / follow-up</strong>
                        <p className={styles.document}>{observation.followUp}</p>
                      </div>
                    ) : null}
                    <div className={css.photos}>
                      {observation.photos.map((photo) => (
                        <figure className={css.photo} key={photo.photoId}>
                          <ReportPreviewPhoto
                            photo={photo}
                            url={`/api/cpl-field/projects/${projectId}/visits/${visit.visitId}/photos/${photo.photoId}/file?variant=report&organization=${encodeURIComponent(organizationId)}`}
                          />
                          <figcaption className={css.photoBody}>
                            {photo.caption || "Photo"} ·{" "}
                            {photo.layout === "pair"
                              ? "Two-photo row"
                              : photo.layout === "appendix"
                                ? "Photo appendix"
                                : "Large photo"}
                            {photo.annotations.shapes.length ? (
                              <span>{photo.annotations.shapes.length} saved annotation(s)</span>
                            ) : null}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  </section>
                ))}
              </section>
            ))}
          </section>
        ) : key === "sections" ? (
          <section key={key} className={css.stack}>
            {document.sections.map((section) => (
              <section key={section.id}>
                <h3>{section.title}</h3>
                <p className={styles.document}>{section.body}</p>
              </section>
            ))}
          </section>
        ) : (
          <section key={key}>
            <h3>{reportLabels[key]}</h3>
            <p className={styles.document}>{document[key] || "Not recorded"}</p>
          </section>
        ),
      )}
      <p className={forms.hint}>
        This is a content preview. The approved PDF is the exact paginated artifact. Downloading is
        not evidence of customer delivery.
      </p>
    </article>
  );
}
export function ReportWorkspace({
  project,
  organizationId,
  request,
  onDirty,
  onBusy,
  onOpenField,
  initialReportId,
  initialPreviewVersion,
}: {
  project: CplCommercialProject;
  organizationId: string;
  request: CommercialRequest;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
  onOpenField?: (visitId: string) => void;
  initialReportId?: string;
  initialPreviewVersion?: number;
}) {
  const base = `/api/cpl-reports/projects/${project.id}`;
  const [data, setData] = useState<CplReportWorkspace | null>(null),
    [detail, setDetail] = useState<CplReportDetail | null>(null);
  const [content, setContent] = useState<CplReportContent | null>(null),
    [area, setArea] = useState<Area>("builder"),
    [dirty, setDirty] = useState(false),
    [note, setNote] = useState("");
  const [templateChoice, setTemplateChoice] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [refreshConfirm, setRefreshConfirm] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [stale, setStale] = useState(false),
    [epoch, setEpoch] = useState(0);
  const refs = useRef({ request, onDirty, onBusy });
  useEffect(() => {
    refs.current = { request, onDirty, onBusy };
  }, [request, onDirty, onBusy]);
  const alive = useRef(true),
    working = useRef(false),
    attempts = useRef<Record<string, { payload: string; key: string }>>({});
  const navigation = useUnsavedNavigation(dirty || note.length > 0);
  useEffect(() => {
    refs.current.onDirty(dirty || note.length > 0);
  }, [dirty, note]);
  const changeDirty = useCallback((value: boolean) => setDirty(value), []);
  function key(kind: string, input: unknown) {
    const payload = JSON.stringify({ organizationId, projectId: project.id, input });
    if (attempts.current[kind]?.payload !== payload)
      attempts.current[kind] = { payload, key: crypto.randomUUID() };
    return attempts.current[kind]!.key;
  }
  function accept(value: CplReportDetail) {
    if (value.projectId !== project.id || value.organizationId !== organizationId)
      throw new Error("The report response did not match this project and company.");
    const version = savedVersion(value);
    if (!alive.current) return;
    setDetail(value);
    setContent(copyContent(version.content));
    setDirty(false);
    setNote("");
    setPreview(null);
    setStale(false);
    setRefreshConfirm(false);
  }
  async function workspace() {
    const value = await refs.current.request<CplReportWorkspace>(base);
    if (value.projectId !== project.id)
      throw new Error("The report workspace did not match this project.");
    if (alive.current) setData(value);
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
        const code = (caught as { code?: string })?.code ?? "";
        setError(
          errors[code] ??
            (caught instanceof Error
              ? caught.message
              : "The action could not be completed. Your entries are retained."),
        );
        if (code.includes("VERSION_CONFLICT")) setStale(true);
        if (code === "CPL_REPORT_SOURCES_CHANGED")
          setDetail((value) => (value ? { ...value, sourcesStale: true } : value));
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
          await workspace();
          if (initialReportId) {
            const value = await refs.current.request<CplReportDetail>(
              `${base}/reports/${initialReportId}`,
            );
            if (value.id !== initialReportId)
              throw new Error("The response did not match the selected report.");
            accept(value);
            if (initialPreviewVersion !== undefined)
              await readPreview(initialReportId, initialPreviewVersion);
          }
        });
    });
    return () => {
      alive.current = false;
      refs.current.onDirty(false);
      refs.current.onBusy(false);
    }; // Auth refresh must preserve this project’s draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, organizationId]);
  function discard() {
    setDirty(false);
    setNote("");
    setRefreshConfirm(false);
    setError("");
    setNotice("");
    if (detail) setContent(copyContent(savedVersion(detail).content));
  }
  function navigate(next: Area) {
    if (next === area) return;
    navigation.navigate(() => {
      discard();
      setArea(next);
      setEpoch((value) => value + 1);
    });
  }
  function open(id: string) {
    navigation.navigate(
      () =>
        void run(async () => {
          const value = await refs.current.request<CplReportDetail>(`${base}/reports/${id}`);
          accept(value);
          setArea("builder");
          setEpoch((value) => value + 1);
        }),
    );
  }
  async function mutate(action: string, input: Record<string, unknown>, message: string) {
    if (!detail) return false;
    const id = detail.id;
    return run(async () => {
      const body = { ...input, expectedRevision: detail.revision };
      const value = await refs.current.request<CplReportDetail>(`${base}/reports/${id}/${action}`, {
        ...body,
        idempotencyKey: key(`${id}:${action}`, body),
      });
      if (value.id !== id) throw new Error("The saved response did not match this report.");
      await workspace();
      accept(value);
      delete attempts.current[`${id}:${action}`];
      setNotice(message);
    });
  }
  async function readPreview(id: string, version: number) {
    const value = await refs.current.request<Preview>(
      `${base}/reports/${id}/preview?version=${version}`,
    );
    if (value.reportId !== id || value.version !== version || value.projection.version !== version)
      throw new Error("The preview did not match the selected report version.");
    if (alive.current) {
      setPreview(value);
      setArea("preview");
    }
  }
  async function loadPreview(version: number) {
    if (!detail) return;
    await run(() => readPreview(detail.id, version));
  }
  const current = detail ? savedVersion(detail) : null;
  const editable = Boolean(
    detail?.permissions.canWrite && ["draft", "changes_requested"].includes(detail.state),
  );
  const reviewable = Boolean(detail?.permissions.canReview && detail.state === "in_review");
  const selectedArtifact = detail?.artifacts.find(
    (artifact) =>
      artifact.version ===
      (area === "preview" ? (preview?.version ?? detail.currentVersion) : detail.currentVersion),
  );
  return (
    <section className={css.stack} aria-label="Project reports">
      {navigation.dialog}
      <header className={forms.header}>
        <div>
          <p className={styles.eyebrow}>REPORTS · {project.reference}</p>
          <h2>From field evidence to a reviewed report</h2>
          <p className={forms.hint}>
            Write the report, select evidence, review the saved version, then approve its final PDF.
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
                  await workspace();
                  if (detail)
                    accept(
                      await refs.current.request<CplReportDetail>(`${base}/reports/${detail.id}`),
                    );
                  else discard();
                  setEpoch((value) => value + 1);
                  setNotice("Saved reports refreshed. Discarded edits were not saved.");
                }),
            )
          }
        >
          Refresh saved reports
        </button>
      </header>
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
      {busy ? <p role="status">Saving or loading report information…</p> : null}
      {!data ? (
        <p>
          {error
            ? "Reports could not be loaded. Refresh to try again."
            : "Loading project reports…"}
        </p>
      ) : (
        <>
          <div className={forms.grid}>
            <section className={css.fieldCard}>
              <h3>Project reports</h3>
              {data.reports.map((report) => (
                <button
                  key={report.id}
                  type="button"
                  className={styles.secondary}
                  disabled={busy}
                  aria-current={detail?.id === report.id ? "page" : undefined}
                  onClick={() => open(report.id)}
                >
                  {report.reference} · {report.title} · {labels[report.state]} · v
                  {report.currentVersion}
                </button>
              ))}
              {!data.reports.length ? <p>No reports have been created for this project.</p> : null}
            </section>
            <form
              className={css.fieldCard}
              onSubmit={(event) => {
                event.preventDefault();
                const template = data.templates.find(
                  (value) => `${value.id}:${value.version}` === templateChoice,
                );
                if (!template) return;
                navigation.navigate(
                  () =>
                    void run(async () => {
                      const input = { templateId: template.id, templateVersion: template.version };
                      const value = await refs.current.request<CplReportDetail>(`${base}/reports`, {
                        ...input,
                        idempotencyKey: key("create", input),
                      });
                      await workspace();
                      accept(value);
                      delete attempts.current.create;
                      setTemplateChoice("");
                      setArea("builder");
                      setNotice(
                        "Report created from the selected template version. Choose and write its evidence before review.",
                      );
                    }),
                );
              }}
            >
              <h3>Create another report</h3>
              <label className={forms.field}>
                <span>New report template version</span>
                <select
                  required
                  value={templateChoice}
                  disabled={busy || !data.permissions.canWrite}
                  onChange={(event) => setTemplateChoice(event.target.value)}
                >
                  <option value="">Choose a report template</option>
                  {data.templates.map((template) => (
                    <option
                      key={`${template.id}:${template.version}`}
                      value={`${template.id}:${template.version}`}
                    >
                      {template.name} · v{template.version}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={styles.primary}
                type="submit"
                disabled={busy || !data.permissions.canWrite || !templateChoice}
              >
                Create report
              </button>
              {!data.templates.length ? <p>Create a company report template first.</p> : null}
            </form>
          </div>
          <nav className={forms.tabs} aria-label="Report workspace sections">
            {(
              [
                ["builder", "Report builder"],
                ["preview", "Customer report preview"],
                ["history", "Report versions & history"],
                ["templates", "Report templates"],
                ["branding", "Report company identity"],
              ] as const
            ).map(([next, label]) => (
              <button
                key={next}
                type="button"
                disabled={busy}
                aria-current={area === next ? "page" : undefined}
                onClick={() =>
                  next === "preview" && detail
                    ? navigation.navigate(() => {
                        discard();
                        void loadPreview(detail.currentVersion);
                      })
                    : navigate(next)
                }
              >
                {label}
              </button>
            ))}
          </nav>
          {area === "templates" ? (
            <ReportTemplates
              key={epoch}
              templates={data.templates}
              busy={busy}
              allowed={data.permissions.canConfigure}
              onDirty={changeDirty}
              onSave={(input, prior) =>
                run(async () => {
                  const body = {
                    input,
                    expectedVersion: prior?.expectedVersion ?? 0,
                    ...(prior ? { templateId: prior.templateId } : {}),
                  };
                  await refs.current.request("/api/cpl-reports/templates", {
                    ...body,
                    idempotencyKey: key("template", body),
                  });
                  await workspace();
                  delete attempts.current.template;
                  setDirty(false);
                  setEpoch((value) => value + 1);
                  setNotice("Report template version saved. Existing reports are unchanged.");
                })
              }
            />
          ) : null}
          {area === "branding" ? (
            <ReportBranding
              key={epoch}
              value={data.branding}
              busy={busy}
              allowed={data.permissions.canConfigure}
              onDirty={changeDirty}
              onSave={(input, expectedRevision) =>
                run(async () => {
                  const body = { input, expectedRevision };
                  await refs.current.request("/api/cpl-reports/branding", {
                    ...body,
                    idempotencyKey: key("branding", body),
                  });
                  await workspace();
                  delete attempts.current.branding;
                  setDirty(false);
                  setEpoch((value) => value + 1);
                  setNotice(
                    "Report company identity saved. Retained report versions remain unchanged.",
                  );
                })
              }
            />
          ) : null}
          {["builder", "preview", "history"].includes(area) && !detail ? (
            <p className={styles.empty}>Open a report or create one from a company template.</p>
          ) : detail && current ? (
            <>
              {["builder", "preview", "history"].includes(area) ? (
                <header className={css.context}>
                  <h3>
                    {detail.reference} · {detail.title}
                  </h3>
                  <p>
                    {labels[detail.state]} · Saved version {detail.currentVersion}
                  </p>
                  {detail.sourcesStale ? (
                    <p className={styles.warning}>
                      Field evidence has changed since this report version. Retained versions and
                      approved PDFs remain unchanged.
                    </p>
                  ) : null}
                  {selectedArtifact ? (
                    <a
                      className={styles.secondary}
                      href={`${base}/reports/${detail.id}/pdf?version=${selectedArtifact.version}&organization=${encodeURIComponent(organizationId)}`}
                    >
                      Download approved report PDF · v{selectedArtifact.version}
                    </a>
                  ) : (
                    <p>No approved PDF is recorded for this selected version.</p>
                  )}
                </header>
              ) : null}
              {area === "builder" && content ? (
                <>
                  {!editable ? (
                    <p className={styles.warning}>
                      This saved report is read only in its current state or for your role. Open a
                      revision to edit an approved report.
                    </p>
                  ) : null}
                  <form
                    className={forms.form}
                    onSubmit={(event) => {
                      event.preventDefault();
                      try {
                        const input = normalizeCplReportContent(content);
                        void mutate(
                          "save",
                          { input },
                          "A new report version was saved. Field observations remain unchanged.",
                        );
                      } catch {
                        setError(errors.CPL_REPORT_INVALID_INPUT!);
                      }
                    }}
                  >
                    <ReportTextFields
                      value={content}
                      disabled={busy || !editable}
                      onChange={(value) => {
                        setContent(value);
                        setDirty(true);
                      }}
                    />
                    <ReportSourceFields
                      value={content}
                      sources={data.sources}
                      retainedSources={current.sources}
                      disabled={busy || !editable}
                      projectId={project.id}
                      organizationId={organizationId}
                      onOpenField={
                        onOpenField
                          ? (visitId) => navigation.navigate(() => onOpenField(visitId))
                          : undefined
                      }
                      onChange={(value) => {
                        setContent(value);
                        setDirty(true);
                      }}
                    />
                    <div className={forms.save}>
                      <span role="status">
                        {dirty
                          ? "Unsaved report edits"
                          : `Saved report version ${detail.currentVersion}`}
                      </span>
                      <button
                        type="submit"
                        className={styles.primary}
                        disabled={busy || !editable || stale || detail.sourcesStale}
                      >
                        Save report version
                      </button>
                    </div>
                  </form>
                  <section className={css.fieldCard}>
                    <h3>Source evidence & review</h3>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await workspace();
                          setNotice(
                            "Available field choices refreshed. Your report edits and retained source version are unchanged.",
                          );
                        })
                      }
                    >
                      Refresh available field choices
                    </button>
                    {onOpenField && current.sources.visits.length ? (
                      <div className={styles.actions}>
                        {current.sources.visits.map((visit) => (
                          <button
                            key={visit.id}
                            type="button"
                            className={styles.secondary}
                            disabled={busy}
                            onClick={() => navigation.navigate(() => onOpenField(visit.id))}
                          >
                            Open retained field visit {visit.title}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <p className={forms.hint}>
                      Template: {current.template.name} · v{current.template.version}. Saving report
                      wording never rewrites field observations. Refresh sources deliberately to
                      incorporate changed field evidence into a new report version.
                    </p>
                    {detail.readiness.length ? (
                      <div className={styles.warning}>
                        <strong>Before review</strong>
                        <ul>
                          {detail.readiness.map((item, index) => (
                            <li key={`${item.code}:${index}`}>{item.message}</li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className={forms.hint}>
                        No saved readiness requirements are outstanding. Human review is still
                        required.
                      </p>
                    )}
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy || stale || !editable}
                      onClick={() => setRefreshConfirm(true)}
                    >
                      Review source refresh
                    </button>
                    {refreshConfirm ? (
                      <section
                        className={styles.warning}
                        aria-label="Confirm report source refresh"
                      >
                        <p>
                          This creates a new report version using your current wording and evidence
                          selections, refreshed field evidence and company identity. Removed
                          selections will be omitted. Review the resulting sources before
                          submitting; earlier versions remain unchanged.
                        </p>
                        <button
                          type="button"
                          disabled={busy || stale || !editable}
                          onClick={() =>
                            (() => {
                              try {
                                const input = normalizeCplReportContent(content);
                                void mutate(
                                  "sources",
                                  { input },
                                  "Current field sources saved into a new report version. Review the updated evidence before submitting.",
                                );
                              } catch {
                                setError(errors.CPL_REPORT_INVALID_INPUT!);
                              }
                            })()
                          }
                        >
                          Refresh sources into a new version
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setRefreshConfirm(false)}
                        >
                          Keep retained sources
                        </button>
                      </section>
                    ) : null}
                    {editable ? (
                      <button
                        type="button"
                        className={styles.primary}
                        disabled={
                          busy ||
                          dirty ||
                          stale ||
                          detail.sourcesStale ||
                          detail.readiness.length > 0
                        }
                        onClick={() =>
                          void mutate("submit", {}, "Saved report submitted for human review.")
                        }
                      >
                        Submit saved report for review
                      </button>
                    ) : null}
                    {reviewable || (detail.permissions.canWrite && detail.state === "approved") ? (
                      <label className={forms.field}>
                        <span>Report revision reason</span>
                        <textarea
                          maxLength={4000}
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          disabled={busy}
                        />
                      </label>
                    ) : null}
                    {note.length > 0 ? (
                      <div className={styles.warning}>
                        <p>
                          This reason is recorded when requesting changes or opening a revision.
                          Clear it explicitly before approving without a revision.
                        </p>
                        <button type="button" disabled={busy} onClick={() => setNote("")}>
                          Clear report revision reason
                        </button>
                      </div>
                    ) : null}
                    {reviewable ? (
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.secondary}
                          disabled={busy || dirty || stale || !note.trim()}
                          onClick={() =>
                            void mutate(
                              "review",
                              { reason: note },
                              "Revision requested. The review note is retained with this report.",
                            )
                          }
                        >
                          Request report revisions
                        </button>
                        <button
                          type="button"
                          className={styles.primary}
                          disabled={
                            busy ||
                            dirty ||
                            stale ||
                            note.length > 0 ||
                            detail.sourcesStale ||
                            detail.readiness.length > 0
                          }
                          onClick={() =>
                            void mutate(
                              "approve",
                              {},
                              "Report approved and its exact PDF recorded. Downloading does not record customer delivery.",
                            )
                          }
                        >
                          Approve & generate final PDF
                        </button>
                      </div>
                    ) : null}
                    {detail.permissions.canWrite && detail.state === "approved" ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={busy || dirty || stale || !note.trim()}
                        onClick={() =>
                          void mutate(
                            "revise",
                            { reason: note },
                            "Report reopened for revision. Earlier approved artifacts remain available.",
                          )
                        }
                      >
                        Open report revision
                      </button>
                    ) : null}
                  </section>
                </>
              ) : null}
              {area === "preview" ? (
                preview ? (
                  <CustomerReport
                    preview={preview}
                    projectId={project.id}
                    organizationId={organizationId}
                  />
                ) : (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={busy}
                    onClick={() => void loadPreview(detail.currentVersion)}
                  >
                    Load saved customer preview
                  </button>
                )
              ) : null}
              {area === "history" ? (
                <section className={css.stack}>
                  <h3>Retained report versions</h3>
                  {[...detail.versions].reverse().map((version: CplReportVersion) => (
                    <article className={css.fieldCard} key={version.version}>
                      <h4>
                        Version {version.version} · {version.content.title}
                      </h4>
                      <p>
                        {new Date(version.createdAt).toLocaleString()} · {version.template.name} v
                        {version.template.version} · {version.sources.visits.length} visit(s)
                      </p>
                      <p className={forms.hint}>
                        {version.branding.businessName} · Source proof{" "}
                        {version.sourceHash.slice(0, 12)}
                      </p>
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={busy}
                        onClick={() => void loadPreview(version.version)}
                      >
                        View report version {version.version}
                      </button>
                      {detail.artifacts.some((artifact) => artifact.version === version.version) ? (
                        <a
                          href={`${base}/reports/${detail.id}/pdf?version=${version.version}&organization=${encodeURIComponent(organizationId)}`}
                        >
                          Download approved PDF version {version.version}
                        </a>
                      ) : (
                        <span>Unapproved version · no final PDF</span>
                      )}
                    </article>
                  ))}
                  <h3>Review & approval history</h3>
                  {detail.events.map((event) => (
                    <article className={css.fieldCard} key={event.id}>
                      <strong>{event.action.replaceAll(".", " ").replaceAll("_", " ")}</strong>
                      <p>
                        {new Date(event.createdAt).toLocaleString()} · Version {event.version}
                      </p>
                      {event.note ? <p className={styles.document}>{event.note}</p> : null}
                    </article>
                  ))}
                </section>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
