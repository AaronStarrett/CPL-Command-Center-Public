"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  normalizeCplReportBranding,
  normalizeCplReportTemplate,
  type CplReportBranding,
  type CplReportTemplateInput,
  type CplReportTemplateVersion,
} from "@bea/domain/cpl-report";
import { validateCplCommercialLogo } from "@bea/domain/cpl-commercial";
import { ReportTextFields, blankReportText, reportTemplateText } from "./report-editor";
import { useUnsavedNavigation } from "./commercial-navigation";
import styles from "./workspace.module.css";
import forms from "./execution.module.css";
import css from "./field.module.css";

export function ReportTemplates({
  templates,
  allowed,
  busy,
  onDirty,
  onSave,
}: {
  templates: CplReportTemplateVersion[];
  allowed: boolean;
  busy: boolean;
  onDirty: (value: boolean) => void;
  onSave: (
    input: CplReportTemplateInput,
    prior: { templateId: string; expectedVersion: number } | null,
  ) => Promise<boolean>;
}) {
  const [value, setValue] = useState<CplReportTemplateInput>(() => ({
    name: "",
    description: "",
    ...blankReportText(),
  }));
  const [prior, setPrior] = useState<{ templateId: string; expectedVersion: number } | null>(null);
  const [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  const navigation = useUnsavedNavigation(dirty);
  function change(next: CplReportTemplateInput) {
    setValue(next);
    setDirty(true);
    onDirty(true);
  }
  function select(template: CplReportTemplateVersion | null) {
    navigation.navigate(() => {
      setValue(
        template
          ? {
              name: template.name,
              description: template.description,
              ...reportTemplateText(template),
            }
          : { name: "", description: "", ...blankReportText() },
      );
      setPrior(template ? { templateId: template.id, expectedVersion: template.version } : null);
      setDirty(false);
      onDirty(false);
      setError("");
    });
  }
  return (
    <section className={css.stack}>
      {navigation.dialog}
      <h3>Report templates</h3>
      <p className={forms.hint}>
        Each save creates a new template version. Existing reports keep their selected version and
        wording. Templates contain no generated findings.
      </p>
      <label className={forms.field}>
        <span>Report template to edit</span>
        <select
          value={prior ? `${prior.templateId}:${prior.expectedVersion}` : ""}
          disabled={busy}
          onChange={(event) =>
            select(
              templates.find((item) => `${item.id}:${item.version}` === event.target.value) ?? null,
            )
          }
        >
          <option value="">New report template</option>
          {templates.map((item) => (
            <option key={`${item.id}:${item.version}`} value={`${item.id}:${item.version}`}>
              {item.name} · v{item.version}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert" className={styles.warning}>
          {error}
        </p>
      ) : null}
      <form
        className={forms.form}
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          try {
            const input = normalizeCplReportTemplate(value);
            void onSave(input, prior).then((ok) => {
              if (ok) {
                setDirty(false);
                onDirty(false);
              }
            });
          } catch {
            setError(
              "Provide a template name, report title, at least one included document section, and a heading for each additional section.",
            );
          }
        }}
      >
        <fieldset disabled={busy || !allowed} className={css.stack}>
          <label className={forms.field}>
            <span>Report template name</span>
            <input
              required
              maxLength={240}
              value={value.name}
              onChange={(event) => change({ ...value, name: event.target.value })}
            />
          </label>
          <label className={forms.field}>
            <span>Report template description</span>
            <textarea
              maxLength={4000}
              value={value.description}
              onChange={(event) => change({ ...value, description: event.target.value })}
            />
          </label>
          <ReportTextFields value={value} disabled={busy || !allowed} onChange={change} />
        </fieldset>
        <div className={forms.save}>
          <span>{dirty ? "Unsaved template changes" : "Template defaults"}</span>
          <button className={styles.primary} type="submit" disabled={busy || !allowed}>
            {prior ? "Save new report template version" : "Create report template"}
          </button>
        </div>
      </form>
    </section>
  );
}
export function ReportBranding({
  value,
  allowed,
  busy,
  onDirty,
  onSave,
}: {
  value: CplReportBranding | null;
  allowed: boolean;
  busy: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (
    input: Omit<CplReportBranding, "revision">,
    expectedRevision: number,
  ) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<CplReportBranding>(
    value ?? {
      revision: 0,
      businessName: "",
      email: "",
      phone: "",
      address: "",
      accentColor: "#163B4F",
      logoDataUrl: null,
    },
  );
  const [dirty, setDirty] = useState(false),
    [error, setError] = useState(""),
    [reading, setReading] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function change<K extends keyof CplReportBranding>(key: K, next: CplReportBranding[K]) {
    setDraft((current) => ({ ...current, [key]: next }));
    setDirty(true);
    onDirty(true);
  }
  async function logo(file?: File) {
    if (!file) return;
    const current = ++generation.current;
    setError("");
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size < 1 || file.size > 131072) {
      setError("Use a PNG or JPEG up to 128 KB and 2048 × 2048 pixels.");
      return;
    }
    setReading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Unreadable logo"));
        reader.readAsDataURL(file);
      });
      const verified = validateCplCommercialLogo(data);
      if (generation.current === current) change("logoDataUrl", verified);
    } catch {
      if (generation.current === current)
        setError(
          "The logo could not be read. Use a valid PNG or JPEG up to 128 KB and 2048 × 2048 pixels.",
        );
    } finally {
      if (generation.current === current) setReading(false);
    }
  }
  return (
    <section className={css.stack}>
      <h3>Report company identity</h3>
      <p className={forms.hint}>
        These settings are saved into report versions. Existing approved reports retain their
        company identity. The application remains Cyber Pirate Labs.
      </p>
      {!value ? (
        <p className={styles.warning}>
          Configure your company before submitting a report for approval.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.warning}>
          {error}
        </p>
      ) : null}
      <form
        className={forms.form}
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          try {
            const input = normalizeCplReportBranding(draft);
            void onSave(input, draft.revision).then((ok) => {
              if (ok) {
                setDirty(false);
                onDirty(false);
              }
            });
          } catch {
            setError("Review the business name, email and accent color before saving.");
          }
        }}
      >
        <fieldset disabled={busy || reading || !allowed} className={forms.grid}>
          {(
            [
              ["businessName", "Report business name"],
              ["email", "Report contact email"],
              ["phone", "Report contact phone"],
              ["address", "Report business address"],
            ] as const
          ).map(([key, label]) => (
            <label className={forms.field} key={key}>
              <span>{label}</span>
              <input
                required={key === "businessName"}
                type={key === "email" ? "email" : "text"}
                maxLength={key === "address" ? 2000 : key === "phone" ? 80 : 254}
                value={draft[key]}
                onChange={(event) => change(key, event.target.value)}
              />
            </label>
          ))}
          <label className={forms.field}>
            <span>Report accent color</span>
            <input
              type="color"
              value={draft.accentColor}
              onChange={(event) => change("accentColor", event.target.value)}
            />
          </label>
          <label className={forms.field}>
            <span>Report logo · PNG/JPEG up to 128 KB</span>
            <input
              type="file"
              accept="image/png,image/jpeg"
              onChange={(event) => {
                void logo(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
          {draft.logoDataUrl ? (
            <div>
              <Image
                unoptimized
                src={draft.logoDataUrl}
                alt="Report company logo preview"
                width={180}
                height={90}
                style={{ objectFit: "contain" }}
              />
              <button
                type="button"
                className={styles.secondary}
                onClick={() => change("logoDataUrl", null)}
              >
                Remove report logo
              </button>
            </div>
          ) : null}
        </fieldset>
        <div className={forms.save}>
          <span>
            {reading
              ? "Reading logo…"
              : dirty
                ? "Unsaved report identity"
                : "Saved report identity"}
          </span>
          <button type="submit" disabled={busy || reading || !allowed} className={styles.primary}>
            Save report company identity
          </button>
        </div>
      </form>
    </section>
  );
}
