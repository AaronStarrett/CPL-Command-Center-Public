"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  CPL_COMMERCIAL_CURRENCIES,
  normalizeCplCommercialTemplate,
  validateCplCommercialLogo,
  type CplCommercialBranding,
  type CplCommercialTemplate,
  type CplCommercialTemplateInput,
} from "@bea/domain/cpl-commercial";
import { decimalMoney, moveItem, parseMinorUnits, sectionLabels } from "./commercial-ui";
import styles from "./workspace.module.css";
import css from "./commercial.module.css";
import { useUnsavedNavigation } from "./commercial-navigation";

export function BrandingSettings({
  value,
  busy,
  allowed,
  onDirty,
  onSave,
}: {
  value: CplCommercialBranding;
  busy: boolean;
  allowed: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (
    input: Omit<CplCommercialBranding, "revision">,
    expectedRevision: number,
  ) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const upload = useRef(0);
  useEffect(
    () => () => {
      upload.current++;
    },
    [],
  );
  useEffect(() => {
    onDirty(changed);
    return () => onDirty(false);
  }, [changed, onDirty]);
  function update<K extends keyof CplCommercialBranding>(key: K, next: CplCommercialBranding[K]) {
    setDraft((previous) => ({ ...previous, [key]: next }));
    setChanged(true);
  }
  async function logo(file?: File) {
    if (!file) return;
    const generation = ++upload.current;
    setError("");
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 131072) {
      setError("Choose a PNG or JPEG up to 128 KB and 2048 × 2048 pixels.");
      return;
    }
    setReading(true);
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Unreadable image"));
        reader.readAsDataURL(file);
      });
      const validated = validateCplCommercialLogo(result);
      if (generation === upload.current) update("logoDataUrl", validated);
    } catch {
      if (generation === upload.current)
        setError(
          "This image could not be accepted. Use a valid PNG or JPEG up to 128 KB and 2048 × 2048 pixels.",
        );
    } finally {
      if (generation === upload.current) setReading(false);
    }
  }
  return (
    <section className={`${styles.panel} ${styles.narrow}`}>
      <p className={styles.eyebrow}>YOUR COMPANY, YOUR DOCUMENTS</p>
      <h2>Artifact branding</h2>
      <p className={styles.muted}>
        This identity is saved into proposal versions and customer PDFs. The Command Center
        application keeps its CPL branding. Existing versions keep their saved company identity.
      </p>
      {!allowed ? (
        <p className={styles.warning}>
          Company configuration permission is required to change these settings.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.warning}>
          {error}
        </p>
      ) : null}
      {value.revision !== draft.revision ? (
        <p className={styles.warning}>
          Company settings changed elsewhere. Reload this section before saving; your current
          entries are retained.
        </p>
      ) : null}
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          const { revision, ...input } = draft;
          void onSave(input, revision);
        }}
      >
        <fieldset className={styles.fieldset} disabled={!allowed || busy || reading}>
          <label className={styles.field}>
            Document business name
            <input
              required
              maxLength={240}
              value={draft.businessName}
              onChange={(event) => update("businessName", event.target.value)}
            />
          </label>
          <div className={styles.fieldPair}>
            <label className={styles.field}>
              Company contact email
              <input
                type="email"
                maxLength={254}
                value={draft.email}
                onChange={(event) => update("email", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              Company contact phone
              <input
                maxLength={80}
                value={draft.phone}
                onChange={(event) => update("phone", event.target.value)}
              />
            </label>
          </div>
          <label className={styles.field}>
            Company address
            <textarea
              rows={3}
              maxLength={2000}
              value={draft.address}
              onChange={(event) => update("address", event.target.value)}
            />
          </label>
          <label className={styles.field}>
            Document logo
            <input
              aria-label="Document logo"
              type="file"
              accept="image/png,image/jpeg"
              onChange={(event) => {
                void logo(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <small>
              PNG or JPEG · 128 KB maximum · up to 2048 × 2048 pixels. Stored within the company
              record; no external image links.
            </small>
          </label>
          {draft.logoDataUrl ? (
            <>
              <Image
                className={css.logoPreview}
                src={draft.logoDataUrl}
                alt="Document logo preview"
                width={180}
                height={90}
                unoptimized
              />
              <button
                type="button"
                className={styles.secondary}
                onClick={() => update("logoDataUrl", null)}
              >
                Remove document logo
              </button>
            </>
          ) : null}
          <div className={styles.fieldPair}>
            <label className={styles.field}>
              Document accent color
              <input
                type="color"
                value={draft.accentColor}
                onChange={(event) => update("accentColor", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              Default currency
              <select
                value={draft.defaultCurrency}
                onChange={(event) => update("defaultCurrency", event.target.value)}
              >
                {CPL_COMMERCIAL_CURRENCIES.map((currency) => (
                  <option key={currency}>{currency}</option>
                ))}
              </select>
            </label>
          </div>
          <label className={css.check}>
            <input
              type="checkbox"
              checked={draft.discountEnabled}
              onChange={(event) => update("discountEnabled", event.target.checked)}
            />
            Allow proposal discounts
          </label>
          <label className={css.check}>
            <input
              type="checkbox"
              checked={draft.taxEnabled}
              onChange={(event) => update("taxEnabled", event.target.checked)}
            />
            Allow proposal tax
          </label>
        </fieldset>
        <button
          className={styles.primary}
          disabled={!allowed || busy || reading || !changed || value.revision !== draft.revision}
        >
          Save artifact branding
        </button>
      </form>
    </section>
  );
}

const emptyTemplate: CplCommercialTemplateInput = {
  name: "",
  summary: "",
  scope: "",
  schedule: "",
  deliverables: "",
  assumptions: "",
  exclusions: "",
  terms: "",
  paymentTerms: "",
  sections: [],
  catalog: [],
};

export function TemplateSettings({
  templates,
  busy,
  allowed,
  onDirty,
  onSave,
  defaultCurrency = "USD",
}: {
  templates: CplCommercialTemplate[];
  busy: boolean;
  allowed: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (input: CplCommercialTemplateInput) => Promise<boolean>;
  defaultCurrency?: string;
}) {
  const [draft, setDraft] = useState({ ...emptyTemplate, currency: defaultCurrency });
  const [catalog, setCatalog] = useState<
    Array<CplCommercialTemplateInput["catalog"][number] & { editId: string; price: string }>
  >([]);
  const [changed, setChanged] = useState(false);
  const navigation = useUnsavedNavigation(changed);
  const [error, setError] = useState("");
  useEffect(() => {
    onDirty(changed);
    return () => onDirty(false);
  }, [changed, onDirty]);
  function update<K extends keyof CplCommercialTemplateInput>(
    key: K,
    value: CplCommercialTemplateInput[K],
  ) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setChanged(true);
  }
  function copy(template: CplCommercialTemplate) {
    navigation.navigate(() => {
      setDraft({ ...template, currency: template.currency ?? "", name: `${template.name} — copy` });
      setCatalog(
        template.catalog.map((item, index) => ({
          ...item,
          price: decimalMoney(item.unitPriceMinor),
          editId: `copy-${index}`,
        })),
      );
      setChanged(true);
    });
  }
  async function save() {
    try {
      const input = normalizeCplCommercialTemplate({
        ...draft,
        catalog: catalog.map((item) => ({
          serviceCode: item.serviceCode,
          description: item.description,
          unit: item.unit,
          unitPriceMinor: parseMinorUnits(item.price),
        })),
      });
      setError("");
      if (await onSave(input)) {
        setChanged(false);
        setDraft({ ...emptyTemplate, currency: defaultCurrency });
        setCatalog([]);
      }
    } catch {
      setError(
        "Check template names, section headings, unique service codes and valid prices. Your entries are kept.",
      );
    }
  }
  return (
    <div className={css.configGrid}>
      {navigation.dialog}
      <section className={styles.panel}>
        <p className={styles.eyebrow}>REUSABLE STARTING POINTS</p>
        <h2>Proposal templates</h2>
        <p className={styles.muted}>
          Company-owned scope, terms and service pricing. Editing creates a new template; proposals
          retain the template used to create them.
        </p>
        {!templates.length ? (
          <p className={styles.empty}>
            No templates configured. An authorized member can create the first company template.
          </p>
        ) : null}
        {templates.map((template) => (
          <article className={styles.detail} key={template.id}>
            <h3>{template.name}</h3>
            <p className={css.hint}>
              {template.catalog.length} catalog services · {template.sections.length} additional
              sections
              {" · "}
              {template.currency ?? "Legacy currency requires review when copied"}
            </p>
            <button
              className={styles.secondary}
              disabled={busy || !allowed}
              onClick={() => copy(template)}
            >
              Edit a new copy of {template.name}
            </button>
          </article>
        ))}
      </section>
      <section className={styles.panel}>
        <h2>Create a template</h2>
        <p className={css.hint}>No example or service price is added automatically.</p>
        {error ? (
          <p role="alert" className={styles.warning}>
            {error}
          </p>
        ) : null}
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className={styles.fieldset} disabled={busy || !allowed}>
            <label className={styles.field}>
              Template name
              <input
                required
                maxLength={240}
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              Template price currency
              <select
                required
                value={draft.currency ?? ""}
                onChange={(event) => update("currency", event.target.value)}
              >
                <option value="">Confirm the currency of these prices</option>
                {CPL_COMMERCIAL_CURRENCIES.map((currency) => (
                  <option key={currency}>{currency}</option>
                ))}
              </select>
              <small>
                The saved currency stays with these prices when company defaults change.
              </small>
            </label>
            {(Object.entries(sectionLabels) as [keyof typeof sectionLabels, string][]).map(
              ([key, label]) => (
                <label className={styles.field} key={key}>
                  Default {label.toLowerCase()}
                  <textarea
                    rows={3}
                    maxLength={20000}
                    value={draft[key]}
                    onChange={(event) => update(key, event.target.value)}
                  />
                </label>
              ),
            )}
            <h3>Additional template sections</h3>
            {draft.sections.map((section, index) => (
              <div className={css.item} key={section.id}>
                <div className={css.order}>
                  <button
                    type="button"
                    aria-label={`Move template section ${index + 1} up`}
                    disabled={!index}
                    onClick={() => update("sections", moveItem(draft.sections, index, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move template section ${index + 1} down`}
                    disabled={index === draft.sections.length - 1}
                    onClick={() => update("sections", moveItem(draft.sections, index, 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove template section ${index + 1}`}
                    onClick={() =>
                      update(
                        "sections",
                        draft.sections.filter((_, i) => i !== index),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
                <label className={styles.field}>
                  Template section {index + 1} heading
                  <input
                    required
                    maxLength={240}
                    value={section.title}
                    onChange={(event) =>
                      update(
                        "sections",
                        draft.sections.map((row, i) =>
                          i === index ? { ...row, title: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <label className={styles.field}>
                  Template section {index + 1} text
                  <textarea
                    value={section.body}
                    rows={3}
                    maxLength={20000}
                    onChange={(event) =>
                      update(
                        "sections",
                        draft.sections.map((row, i) =>
                          i === index ? { ...row, body: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
              </div>
            ))}
            <button
              type="button"
              className={styles.secondary}
              disabled={draft.sections.length >= 30}
              onClick={() =>
                update("sections", [
                  ...draft.sections,
                  { id: crypto.randomUUID(), title: "", body: "" },
                ])
              }
            >
              Add template section
            </button>
            <h3>Service catalog</h3>
            {catalog.map((item, index) => (
              <div className={css.item} key={item.editId}>
                {(
                  [
                    ["serviceCode", "code"],
                    ["description", "description"],
                    ["unit", "unit"],
                    ["price", "unit price"],
                  ] as const
                ).map(([key, label]) => (
                  <label className={styles.field} key={key}>
                    Service {index + 1} {label}
                    <input
                      required
                      value={item[key]}
                      maxLength={key === "description" ? 2000 : 120}
                      onChange={(event) => {
                        setCatalog(
                          catalog.map((row, i) =>
                            i === index ? { ...row, [key]: event.target.value } : row,
                          ),
                        );
                        setChanged(true);
                      }}
                    />
                  </label>
                ))}
                <div className={css.order}>
                  <button
                    type="button"
                    aria-label={`Move service ${index + 1} up`}
                    disabled={!index}
                    onClick={() => {
                      setCatalog(moveItem(catalog, index, -1));
                      setChanged(true);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move service ${index + 1} down`}
                    disabled={index === catalog.length - 1}
                    onClick={() => {
                      setCatalog(moveItem(catalog, index, 1));
                      setChanged(true);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove service ${index + 1}`}
                    onClick={() => {
                      setCatalog(catalog.filter((_, i) => i !== index));
                      setChanged(true);
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className={styles.secondary}
              disabled={catalog.length >= 100}
              onClick={() => {
                setCatalog([
                  ...catalog,
                  {
                    editId: crypto.randomUUID(),
                    serviceCode: "",
                    description: "",
                    unit: "each",
                    unitPriceMinor: 0,
                    price: "0.00",
                  },
                ]);
                setChanged(true);
              }}
            >
              Add catalog service
            </button>
          </fieldset>
          <button className={styles.primary} disabled={busy || !allowed || !changed}>
            Save new template
          </button>
        </form>
      </section>
    </div>
  );
}
