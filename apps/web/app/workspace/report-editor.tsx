"use client";

import type {
  CplReportContent,
  CplReportPhotoSelection,
  CplReportSourceOption,
  CplReportSources,
  CplReportTemplateInput,
  CplReportVisitSelection,
} from "@bea/domain/cpl-report";
import { CPL_REPORT_SECTION_KEYS } from "@bea/domain/cpl-report";
import { moveItem } from "./commercial-ui";
import styles from "./workspace.module.css";
import forms from "./execution.module.css";
import css from "./field.module.css";

export const reportLabels = {
  scope: "Scope",
  summary: "Summary",
  limitations: "Limitations",
  visits: "Visit findings & photos",
  conclusion: "Conclusion",
  sections: "Additional sections",
};
type TextContent = Omit<CplReportContent, "visits">;
export function blankReportText(): TextContent {
  return {
    title: "",
    scope: "",
    summary: "",
    limitations: "",
    conclusion: "",
    sections: [],
    sectionOrder: [...CPL_REPORT_SECTION_KEYS],
  };
}
export function ReportTextFields<T extends TextContent>({
  value,
  onChange,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled} className={css.stack}>
      <label className={forms.field}>
        <span>Report title</span>
        <input
          required
          maxLength={240}
          value={value.title}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
        />
      </label>
      {(["scope", "summary", "limitations", "conclusion"] as const).map((key) => (
        <label key={key} className={forms.field}>
          <span>Report {reportLabels[key].toLowerCase()}</span>
          <textarea
            maxLength={30000}
            rows={4}
            value={value[key]}
            onChange={(event) => onChange({ ...value, [key]: event.target.value })}
          />
        </label>
      ))}
      <section className={css.fieldCard}>
        <h3>Document order</h3>
        <p className={forms.hint}>
          Choose which sections appear and their order. Removing a section from the document keeps
          its written draft text.
        </p>
        <div className={forms.team}>
          {CPL_REPORT_SECTION_KEYS.map((key) => (
            <label className={forms.check} key={key}>
              <input
                type="checkbox"
                checked={value.sectionOrder.includes(key)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    sectionOrder: event.target.checked
                      ? [...value.sectionOrder, key]
                      : value.sectionOrder.filter((item) => item !== key),
                  })
                }
              />
              Include {reportLabels[key]}
            </label>
          ))}
        </div>
        <ol>
          {value.sectionOrder.map((key, index) => (
            <li key={key}>
              {reportLabels[key]}{" "}
              <button
                type="button"
                disabled={index === 0}
                onClick={() =>
                  onChange({ ...value, sectionOrder: moveItem(value.sectionOrder, index, -1) })
                }
                aria-label={`Move ${reportLabels[key]} earlier`}
              >
                ↑
              </button>{" "}
              <button
                type="button"
                disabled={index === value.sectionOrder.length - 1}
                onClick={() =>
                  onChange({ ...value, sectionOrder: moveItem(value.sectionOrder, index, 1) })
                }
                aria-label={`Move ${reportLabels[key]} later`}
              >
                ↓
              </button>
            </li>
          ))}
        </ol>
      </section>
      <section className={css.stack}>
        <h3>Additional report sections</h3>
        {value.sections.map((section, index) => (
          <section className={css.fieldCard} key={section.id}>
            <label className={forms.field}>
              <span>Report section {index + 1} heading</span>
              <input
                required
                maxLength={240}
                value={section.title}
                onChange={(event) =>
                  onChange({
                    ...value,
                    sections: value.sections.map((item) =>
                      item.id === section.id ? { ...item, title: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
            <label className={forms.field}>
              <span>Report section {index + 1} text</span>
              <textarea
                maxLength={30000}
                rows={4}
                value={section.body}
                onChange={(event) =>
                  onChange({
                    ...value,
                    sections: value.sections.map((item) =>
                      item.id === section.id ? { ...item, body: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={!index}
                onClick={() =>
                  onChange({ ...value, sections: moveItem(value.sections, index, -1) })
                }
              >
                Move report section {index + 1} up
              </button>
              <button
                type="button"
                disabled={index === value.sections.length - 1}
                onClick={() => onChange({ ...value, sections: moveItem(value.sections, index, 1) })}
              >
                Move report section {index + 1} down
              </button>
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...value,
                    sections: value.sections.filter((item) => item.id !== section.id),
                  })
                }
              >
                Remove report section {index + 1}
              </button>
            </div>
          </section>
        ))}
        <button
          type="button"
          className={styles.secondary}
          disabled={value.sections.length >= 20}
          onClick={() =>
            onChange({
              ...value,
              sections: [...value.sections, { id: crypto.randomUUID(), title: "", body: "" }],
            })
          }
        >
          Add report section
        </button>
      </section>
    </fieldset>
  );
}
function PhotoChoices({
  source,
  value,
  onChange,
  ids,
  organizationId,
  projectId,
}: {
  source: CplReportSourceOption;
  value: CplReportPhotoSelection[];
  onChange: (value: CplReportPhotoSelection[]) => void;
  ids: string[];
  organizationId: string;
  projectId: string;
}) {
  return (
    <section className={css.stack}>
      {value
        .filter((item) => !source.photos.some((photo) => photo.id === item.photoId))
        .map((item) => (
          <div className={styles.warning} key={item.photoId}>
            <p>A retained photo is no longer available in this visit.</p>
            <button
              type="button"
              onClick={() => onChange(value.filter((photo) => photo.photoId !== item.photoId))}
            >
              Remove unavailable photo
            </button>
          </div>
        ))}
      {source.photos
        .filter(
          (photo) => ids.includes(photo.id) || value.some((item) => item.photoId === photo.id),
        )
        .map((photo) => {
          const selection = value.find((item) => item.photoId === photo.id);
          return (
            <div key={photo.id} className={css.fieldCard}>
              <label className={forms.check}>
                <input
                  type="checkbox"
                  checked={Boolean(selection)}
                  disabled={!selection && (!photo.reportEligible || photo.state !== "ready")}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...value, { photoId: photo.id, layout: "large" }]
                        : value.filter((item) => item.photoId !== photo.id),
                    )
                  }
                />
                Include photo: {photo.caption || "Uncaptioned photo"}{" "}
                {photo.state !== "ready"
                  ? `· ${photo.state}`
                  : !photo.reportEligible
                    ? "· internal only"
                    : ""}
                {!ids.includes(photo.id)
                  ? " · no longer linked here; remove before refreshing"
                  : ""}
              </label>
              {photo.state === "ready" ? (
                <svg
                  role="img"
                  aria-label={photo.caption || "Saved field photo"}
                  className={css.photoImage}
                  viewBox="0 0 300 200"
                >
                  <image
                    href={`/api/cpl-field/projects/${projectId}/visits/${source.visitId}/photos/${photo.id}/file?variant=thumbnail&organization=${encodeURIComponent(organizationId)}`}
                    width={300}
                    height={200}
                    preserveAspectRatio="xMidYMid meet"
                  />
                </svg>
              ) : null}
              {selection ? (
                <label className={forms.field}>
                  <span>Layout for {photo.caption || "selected photo"}</span>
                  <select
                    value={selection.layout}
                    onChange={(event) =>
                      onChange(
                        value.map((item) =>
                          item.photoId === photo.id
                            ? {
                                ...item,
                                layout: event.target.value as CplReportPhotoSelection["layout"],
                              }
                            : item,
                        ),
                      )
                    }
                  >
                    <option value="large">Large photo</option>
                    <option value="pair">Two-photo row</option>
                    <option value="appendix">Photo appendix</option>
                  </select>
                </label>
              ) : null}
            </div>
          );
        })}
      {value.length ? (
        <ol>
          {value.map((item, index) => (
            <li key={item.photoId}>
              {source.photos.find((photo) => photo.id === item.photoId)?.caption ||
                "Selected photo"}{" "}
              <button
                type="button"
                disabled={!index}
                onClick={() => onChange(moveItem(value, index, -1))}
                aria-label={`Move selected photo ${index + 1} earlier`}
              >
                ↑
              </button>{" "}
              <button
                type="button"
                disabled={index === value.length - 1}
                onClick={() => onChange(moveItem(value, index, 1))}
                aria-label={`Move selected photo ${index + 1} later`}
              >
                ↓
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
export function ReportSourceFields({
  value,
  sources,
  onChange,
  disabled,
  projectId,
  organizationId,
  onOpenField,
  retainedSources,
}: {
  value: CplReportContent;
  sources: CplReportSourceOption[];
  onChange: (value: CplReportContent) => void;
  disabled: boolean;
  projectId: string;
  organizationId: string;
  onOpenField?: (visitId: string) => void;
  retainedSources?: CplReportSources;
}) {
  const update = (id: string, next: CplReportVisitSelection) =>
    onChange({
      ...value,
      visits: value.visits.map((visit) => (visit.visitId === id ? next : visit)),
    });
  return (
    <fieldset disabled={disabled} className={css.stack}>
      <h3>Choose field evidence</h3>
      <p className={forms.hint}>
        Only ready, report-eligible photos and observations can be selected. Report wording edits
        stay separate from the original field record.
      </p>
      {value.visits.some((visit) => !sources.some((source) => source.visitId === visit.visitId)) ? (
        <p role="alert" className={styles.warning}>
          A selected visit is no longer in the available source list. Its retained report version
          remains available. Refresh sources or review access before saving.
        </p>
      ) : null}
      {value.visits
        .filter((visit) => !sources.some((source) => source.visitId === visit.visitId))
        .map((visit) => (
          <button
            type="button"
            key={visit.visitId}
            onClick={() =>
              onChange({
                ...value,
                visits: value.visits.filter((item) => item.visitId !== visit.visitId),
              })
            }
          >
            Remove unavailable visit
          </button>
        ))}
      {sources.map((source) => {
        const selected = value.visits.find((visit) => visit.visitId === source.visitId);
        return (
          <section className={css.fieldCard} key={source.visitId}>
            {onOpenField ? (
              <button
                type="button"
                className={styles.secondary}
                onClick={() => onOpenField(source.visitId)}
              >
                Open source field visit {source.title}
              </button>
            ) : null}
            <label className={forms.check}>
              <input
                type="checkbox"
                checked={Boolean(selected)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    visits: event.target.checked
                      ? [
                          ...value.visits,
                          { visitId: source.visitId, observations: [], overviewPhotos: [] },
                        ]
                      : value.visits.filter((visit) => visit.visitId !== source.visitId),
                  })
                }
              />
              Include visit: {source.title} · {source.status.replaceAll("_", " ")}
            </label>
            {selected ? (
              <>
                {selected.observations
                  .filter(
                    (item) =>
                      !source.observations.some(
                        (observation) => observation.id === item.observationId,
                      ),
                  )
                  .map((item) => (
                    <div className={styles.warning} key={item.observationId}>
                      <p>A retained finding is no longer available in this visit.</p>
                      <button
                        type="button"
                        onClick={() =>
                          update(source.visitId, {
                            ...selected,
                            observations: selected.observations.filter(
                              (observation) => observation.observationId !== item.observationId,
                            ),
                          })
                        }
                      >
                        Remove unavailable finding
                      </button>
                    </div>
                  ))}
                {source.observations.map((observation) => {
                  const retained = retainedSources?.visits
                    .find((visit) => visit.id === source.visitId)
                    ?.observations.find((item) => item.id === observation.id);
                  const wording = retained ?? observation;
                  const choice = selected.observations.find(
                    (item) => item.observationId === observation.id,
                  );
                  return (
                    <section key={observation.id} className={css.fieldCard}>
                      <label className={forms.check}>
                        <input
                          type="checkbox"
                          checked={Boolean(choice)}
                          disabled={!choice && !observation.reportEligible}
                          onChange={(event) =>
                            update(source.visitId, {
                              ...selected,
                              observations: event.target.checked
                                ? [
                                    ...selected.observations,
                                    {
                                      observationId: observation.id,
                                      titleOverride: null,
                                      descriptionOverride: null,
                                      followUpOverride: null,
                                      photos: [],
                                    },
                                  ]
                                : selected.observations.filter(
                                    (item) => item.observationId !== observation.id,
                                  ),
                            })
                          }
                        />
                        Include finding: {observation.title}
                        {!observation.reportEligible ? " · internal only" : ""}
                      </label>
                      {choice ? (
                        <>
                          {(
                            [
                              ["titleOverride", "title", "Finding title"],
                              ["descriptionOverride", "description", "Finding description"],
                              ["followUpOverride", "followUp", "Recommendations / follow-up"],
                            ] as const
                          ).map(([key, original, label]) => (
                            <label className={forms.field} key={key}>
                              <span>
                                {label} · {observation.title}
                              </span>
                              <textarea
                                rows={key === "titleOverride" ? 1 : 4}
                                maxLength={key === "titleOverride" ? 240 : 30000}
                                value={choice[key] ?? wording[original]}
                                onChange={(event) =>
                                  update(source.visitId, {
                                    ...selected,
                                    observations: selected.observations.map((item) =>
                                      item.observationId === observation.id
                                        ? { ...item, [key]: event.target.value }
                                        : item,
                                    ),
                                  })
                                }
                              />
                            </label>
                          ))}
                          <button
                            type="button"
                            className={styles.secondary}
                            onClick={() =>
                              update(source.visitId, {
                                ...selected,
                                observations: selected.observations.map((item) =>
                                  item.observationId === observation.id
                                    ? {
                                        ...item,
                                        titleOverride: null,
                                        descriptionOverride: null,
                                        followUpOverride: null,
                                      }
                                    : item,
                                ),
                              })
                            }
                          >
                            Use {retained ? "retained" : "field"} wording for {observation.title}
                          </button>
                          <details>
                            <summary>Preserved field wording · revision {wording.revision}</summary>
                            <p className={styles.document}>{wording.description}</p>
                            <p className={styles.document}>{wording.followUp}</p>
                          </details>
                          {retained && retained.revision !== observation.revision ? (
                            <details>
                              <summary>
                                Newer field wording · revision {observation.revision}
                              </summary>
                              <p className={styles.warning}>
                                Refresh sources explicitly to use this newer field record in the
                                report.
                              </p>
                              <p className={styles.document}>{observation.description}</p>
                              <p className={styles.document}>{observation.followUp}</p>
                            </details>
                          ) : null}
                          <PhotoChoices
                            source={source}
                            value={choice.photos}
                            onChange={(photos) =>
                              update(source.visitId, {
                                ...selected,
                                observations: selected.observations.map((item) =>
                                  item.observationId === observation.id
                                    ? { ...item, photos }
                                    : item,
                                ),
                              })
                            }
                            ids={source.photos
                              .filter((photo) => photo.observationId === observation.id)
                              .map((photo) => photo.id)}
                            projectId={projectId}
                            organizationId={organizationId}
                          />
                        </>
                      ) : null}
                    </section>
                  );
                })}
                {!source.observations.length ? (
                  <p>No field observations have been recorded for this visit.</p>
                ) : null}
                {selected.observations.length > 1 ? (
                  <ol>
                    {selected.observations.map((observation, index) => (
                      <li key={observation.observationId}>
                        {source.observations.find((item) => item.id === observation.observationId)
                          ?.title || "Retained finding"}{" "}
                        <button
                          type="button"
                          disabled={!index}
                          onClick={() =>
                            update(source.visitId, {
                              ...selected,
                              observations: moveItem(selected.observations, index, -1),
                            })
                          }
                          aria-label={`Move finding ${index + 1} earlier`}
                        >
                          ↑
                        </button>{" "}
                        <button
                          type="button"
                          disabled={index === selected.observations.length - 1}
                          onClick={() =>
                            update(source.visitId, {
                              ...selected,
                              observations: moveItem(selected.observations, index, 1),
                            })
                          }
                          aria-label={`Move finding ${index + 1} later`}
                        >
                          ↓
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : null}
                <details>
                  <summary>Overview / standalone photos</summary>
                  <PhotoChoices
                    source={source}
                    value={selected.overviewPhotos}
                    onChange={(overviewPhotos) =>
                      update(source.visitId, { ...selected, overviewPhotos })
                    }
                    ids={source.photos
                      .filter(
                        (photo) =>
                          photo.overview &&
                          (photo.observationId === null ||
                            source.observations.some(
                              (observation) =>
                                observation.id === photo.observationId &&
                                observation.reportEligible,
                            )),
                      )
                      .map((photo) => photo.id)}
                    organizationId={organizationId}
                    projectId={projectId}
                  />
                </details>
              </>
            ) : null}
          </section>
        );
      })}
      {!sources.length ? (
        <p className={styles.empty}>
          No field visits are available yet. Record fieldwork before selecting report evidence.
        </p>
      ) : null}
      {value.visits.length > 1 ? (
        <ol>
          {value.visits.map((visit, index) => (
            <li key={visit.visitId}>
              {sources.find((source) => source.visitId === visit.visitId)?.title ||
                "Retained visit"}{" "}
              <button
                type="button"
                disabled={!index}
                onClick={() => onChange({ ...value, visits: moveItem(value.visits, index, -1) })}
                aria-label={`Move report visit ${index + 1} earlier`}
              >
                ↑
              </button>{" "}
              <button
                type="button"
                disabled={index === value.visits.length - 1}
                onClick={() => onChange({ ...value, visits: moveItem(value.visits, index, 1) })}
                aria-label={`Move report visit ${index + 1} later`}
              >
                ↓
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </fieldset>
  );
}
export function reportTemplateText(value: CplReportTemplateInput): TextContent {
  const { title, scope, summary, limitations, conclusion, sections, sectionOrder } = value;
  return {
    title,
    scope,
    summary,
    limitations,
    conclusion,
    sections: sections.map((section) => ({ ...section })),
    sectionOrder: [...sectionOrder],
  };
}
