"use client";

import { useState } from "react";
import {
  CPL_FIELD_TYPES,
  normalizeCplFieldTemplate,
  type CplFieldTemplateInput,
  type CplFieldTemplateItem,
  type CplFieldTemplateVersion,
} from "@bea/domain/cpl-field";
import { useUnsavedNavigation } from "./commercial-navigation";
import { moveItem } from "./commercial-ui";
import styles from "./workspace.module.css";
import forms from "./execution.module.css";
import css from "./field.module.css";

function blank(): CplFieldTemplateInput {
  return { name: "", description: "", sections: [] };
}
function item(label = "", type: CplFieldTemplateItem["type"] = "text"): CplFieldTemplateItem {
  return {
    id: crypto.randomUUID(),
    label,
    instructions: "",
    type,
    required: false,
    unit: "",
    options: [],
    naReasonRequired: true,
    minimumPhotos: type === "photo" ? 1 : 0,
  };
}
function example(envelope: boolean): CplFieldTemplateInput {
  return {
    name: envelope ? "Fictional building envelope visit" : "Fictional general service visit",
    description:
      "Example checklist. Review and adapt each requirement before using it for work. No professional conclusions are supplied.",
    sections: [
      {
        id: crypto.randomUUID(),
        title: "Visit context",
        items: [{ ...item("Work area / component"), required: true }, item("Recorded conditions")],
      },
      {
        id: crypto.randomUUID(),
        title: envelope ? "Envelope observations" : "Service observations",
        items: [
          item(envelope ? "Visible roof / wall observations" : "Work observations"),
          { ...item("Overview photo", "photo"), required: true },
          item("Human-written follow-up"),
        ],
      },
    ],
  };
}
export function FieldTemplates({
  templates,
  allowed,
  busy,
  onDirty,
  onSave,
}: {
  templates: CplFieldTemplateVersion[];
  allowed: boolean;
  busy: boolean;
  onDirty: (value: boolean) => void;
  onSave: (
    input: CplFieldTemplateInput,
    prior: { templateId: string; expectedVersion: number } | null,
  ) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<CplFieldTemplateInput>(blank);
  const [prior, setPrior] = useState<{ templateId: string; expectedVersion: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const navigation = useUnsavedNavigation(dirty);
  function change(next: CplFieldTemplateInput) {
    setDraft(next);
    setDirty(true);
    onDirty(true);
  }
  function select(template: CplFieldTemplateVersion | null) {
    navigation.navigate(() => {
      setDraft(
        template
          ? {
              name: template.name,
              description: template.description,
              sections: template.sections.map((section) => ({
                ...section,
                items: section.items.map((value) => ({ ...value, options: [...value.options] })),
              })),
            }
          : blank(),
      );
      setPrior(template ? { templateId: template.id, expectedVersion: template.version } : null);
      setDirty(false);
      onDirty(false);
      setError("");
    });
  }
  function updateItem(sectionId: string, itemId: string, patch: Partial<CplFieldTemplateItem>) {
    change({
      ...draft,
      sections: draft.sections.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              items: section.items.map((value) =>
                value.id === itemId ? { ...value, ...patch } : value,
              ),
            }
          : section,
      ),
    });
  }
  return (
    <section className={css.stack} aria-label="Field template settings">
      {navigation.dialog}
      <h3>Visit checklist templates</h3>
      <p className={forms.hint}>
        Save a new template or a new version. Existing visits keep their attached version and
        recorded answers.
      </p>
      <label className={forms.field}>
        <span>Template version to edit</span>
        <select
          disabled={busy}
          value={prior ? `${prior.templateId}:${prior.expectedVersion}` : ""}
          onChange={(event) =>
            select(
              templates.find((value) => `${value.id}:${value.version}` === event.target.value) ??
                null,
            )
          }
        >
          <option value="">Create a new template</option>
          {templates.map((template) => (
            <option
              key={`${template.id}:${template.version}`}
              value={`${template.id}:${template.version}`}
            >
              {template.name} · v{template.version}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.actions}>
        {[
          [false, "Start general service example"],
          [true, "Start building envelope example"],
        ].map(([envelope, label]) => (
          <button
            key={String(label)}
            type="button"
            className={styles.secondary}
            disabled={busy || !allowed}
            onClick={() =>
              navigation.navigate(() => {
                setPrior(null);
                change(example(Boolean(envelope)));
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className={forms.form}
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          let normalized: CplFieldTemplateInput;
          try {
            normalized = normalizeCplFieldTemplate(draft);
          } catch {
            setError(
              "Add a named section with at least one labeled field. Choice fields need options; photo requirements need at least one image. Review the field limits.",
            );
            return;
          }
          void onSave(normalized, prior).then((saved) => {
            if (saved) {
              setDirty(false);
              onDirty(false);
            }
          });
        }}
      >
        {error ? (
          <p role="alert" className={styles.warning}>
            {error}
          </p>
        ) : null}
        <fieldset disabled={busy || !allowed} className={css.stack}>
          <label className={forms.field}>
            <span>Checklist template name</span>
            <input
              required
              maxLength={240}
              value={draft.name}
              onChange={(event) => change({ ...draft, name: event.target.value })}
            />
          </label>
          <label className={forms.field}>
            <span>Template description</span>
            <textarea
              maxLength={4000}
              value={draft.description}
              onChange={(event) => change({ ...draft, description: event.target.value })}
            />
          </label>
          {draft.sections.map((section, sectionIndex) => (
            <section className={css.fieldCard} key={section.id}>
              <label className={forms.field}>
                <span>Section {sectionIndex + 1} title</span>
                <input
                  required
                  maxLength={240}
                  value={section.title}
                  onChange={(event) =>
                    change({
                      ...draft,
                      sections: draft.sections.map((value) =>
                        value.id === section.id ? { ...value, title: event.target.value } : value,
                      ),
                    })
                  }
                />
              </label>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={sectionIndex === 0}
                  onClick={() =>
                    change({ ...draft, sections: moveItem(draft.sections, sectionIndex, -1) })
                  }
                >
                  Move section {sectionIndex + 1} up
                </button>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={sectionIndex === draft.sections.length - 1}
                  onClick={() =>
                    change({ ...draft, sections: moveItem(draft.sections, sectionIndex, 1) })
                  }
                >
                  Move section {sectionIndex + 1} down
                </button>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() =>
                    change({
                      ...draft,
                      sections: draft.sections.filter((value) => value.id !== section.id),
                    })
                  }
                >
                  Remove section {sectionIndex + 1}
                </button>
              </div>
              {section.items.map((field, fieldIndex) => (
                <section
                  key={field.id}
                  className={css.fieldCard}
                  aria-label={`Section ${sectionIndex + 1} field ${fieldIndex + 1}`}
                >
                  <div className={forms.grid}>
                    <label className={forms.field}>
                      <span>
                        Field {sectionIndex + 1}.{fieldIndex + 1} label
                      </span>
                      <input
                        required
                        maxLength={240}
                        value={field.label}
                        onChange={(event) =>
                          updateItem(section.id, field.id, { label: event.target.value })
                        }
                      />
                    </label>
                    <label className={forms.field}>
                      <span>
                        Field {sectionIndex + 1}.{fieldIndex + 1} type
                      </span>
                      <select
                        value={field.type}
                        onChange={(event) => {
                          const type = event.target.value as CplFieldTemplateItem["type"];
                          updateItem(section.id, field.id, {
                            type,
                            unit: type === "number" ? field.unit : "",
                            options: type === "choice" ? field.options : [],
                            minimumPhotos:
                              type === "photo"
                                ? Math.max(1, field.minimumPhotos)
                                : field.minimumPhotos,
                          });
                        }}
                      >
                        {CPL_FIELD_TYPES.map((type) => (
                          <option key={type}>{type}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className={forms.field}>
                    <span>
                      Field {sectionIndex + 1}.{fieldIndex + 1} instructions
                    </span>
                    <textarea
                      maxLength={4000}
                      value={field.instructions}
                      onChange={(event) =>
                        updateItem(section.id, field.id, { instructions: event.target.value })
                      }
                    />
                  </label>
                  <div className={forms.team}>
                    <label className={forms.check}>
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={(event) =>
                          updateItem(section.id, field.id, { required: event.target.checked })
                        }
                      />
                      Required field {sectionIndex + 1}.{fieldIndex + 1}
                    </label>
                    <label className={forms.check}>
                      <input
                        type="checkbox"
                        checked={field.naReasonRequired}
                        onChange={(event) =>
                          updateItem(section.id, field.id, {
                            naReasonRequired: event.target.checked,
                          })
                        }
                      />
                      N/A reason required {sectionIndex + 1}.{fieldIndex + 1}
                    </label>
                  </div>
                  {field.type === "number" ? (
                    <label className={forms.field}>
                      <span>
                        Field {sectionIndex + 1}.{fieldIndex + 1} unit
                      </span>
                      <input
                        maxLength={60}
                        value={field.unit}
                        onChange={(event) =>
                          updateItem(section.id, field.id, { unit: event.target.value })
                        }
                      />
                    </label>
                  ) : null}
                  {field.type === "choice" ? (
                    <label className={forms.field}>
                      <span>
                        Field {sectionIndex + 1}.{fieldIndex + 1} choices · one per line
                      </span>
                      <textarea
                        required
                        value={field.options.join("\n")}
                        onChange={(event) =>
                          updateItem(section.id, field.id, {
                            options: event.target.value.split("\n"),
                          })
                        }
                      />
                    </label>
                  ) : null}
                  <label className={forms.field}>
                    <span>
                      Field {sectionIndex + 1}.{fieldIndex + 1} required photo count
                    </span>
                    <input
                      type="number"
                      min={field.type === "photo" ? 1 : 0}
                      max={20}
                      step={1}
                      value={field.minimumPhotos}
                      onChange={(event) =>
                        updateItem(section.id, field.id, {
                          minimumPhotos: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={fieldIndex === 0}
                      onClick={() =>
                        change({
                          ...draft,
                          sections: draft.sections.map((value) =>
                            value.id === section.id
                              ? { ...value, items: moveItem(value.items, fieldIndex, -1) }
                              : value,
                          ),
                        })
                      }
                    >
                      Move field {sectionIndex + 1}.{fieldIndex + 1} up
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={fieldIndex === section.items.length - 1}
                      onClick={() =>
                        change({
                          ...draft,
                          sections: draft.sections.map((value) =>
                            value.id === section.id
                              ? { ...value, items: moveItem(value.items, fieldIndex, 1) }
                              : value,
                          ),
                        })
                      }
                    >
                      Move field {sectionIndex + 1}.{fieldIndex + 1} down
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() =>
                        change({
                          ...draft,
                          sections: draft.sections.map((value) =>
                            value.id === section.id
                              ? {
                                  ...value,
                                  items: value.items.filter((entry) => entry.id !== field.id),
                                }
                              : value,
                          ),
                        })
                      }
                    >
                      Remove field {sectionIndex + 1}.{fieldIndex + 1}
                    </button>
                  </div>
                </section>
              ))}
              <button
                type="button"
                className={styles.secondary}
                disabled={section.items.length >= 100}
                onClick={() =>
                  change({
                    ...draft,
                    sections: draft.sections.map((value) =>
                      value.id === section.id
                        ? { ...value, items: [...value.items, item()] }
                        : value,
                    ),
                  })
                }
              >
                Add field to section {sectionIndex + 1}
              </button>
            </section>
          ))}
          <button
            type="button"
            className={styles.secondary}
            disabled={draft.sections.length >= 20}
            onClick={() =>
              change({
                ...draft,
                sections: [
                  ...draft.sections,
                  { id: crypto.randomUUID(), title: "", items: [item()] },
                ],
              })
            }
          >
            Add checklist section
          </button>
        </fieldset>
        <div className={forms.save}>
          <span>{dirty ? "Unsaved template changes" : "Template editor"}</span>
          <button type="submit" className={styles.primary} disabled={busy || !allowed}>
            {prior ? "Save new template version" : "Save checklist template"}
          </button>
        </div>
      </form>
    </section>
  );
}
