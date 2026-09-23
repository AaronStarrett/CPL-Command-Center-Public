"use client";

import { useEffect, useState } from "react";
import {
  CPL_COMMERCIAL_CURRENCIES,
  calculateCplCommercialTotals,
  normalizeCplCommercialContent,
  type CplCommercialBranding,
  type CplCommercialContent,
  type CplCommercialProposal,
  type CplCommercialSourceLead,
  type CplCommercialTemplate,
  type CplCommercialTotals,
} from "@bea/domain/cpl-commercial";
import { decimalMoney, money, moveItem, parseMinorUnits, sectionLabels } from "./commercial-ui";
import styles from "./workspace.module.css";
import css from "./commercial.module.css";

export function SourceSnapshot({
  source,
  onOpenLead,
}: {
  source: CplCommercialSourceLead;
  onOpenLead: (id: string) => void;
}) {
  const lead = source.fields;
  return (
    <aside className={`${styles.panel} ${css.provenance}`} aria-label="Confirmed lead snapshot">
      <p className={styles.eyebrow}>SOURCE OF THIS PROPOSAL</p>
      <h3>{lead.title}</h3>
      <p className={css.hint}>
        Lead version {source.version} · captured when this proposal was created.
      </p>
      <button type="button" className={styles.secondary} onClick={() => onOpenLead(source.id)}>
        Open source lead
      </button>
      <p className={css.hint}>
        The current lead may include later changes. This saved snapshot stays unchanged.
      </p>
      <dl>
        <dt>Customer / contact</dt>
        <dd>
          {lead.customerName || "Not recorded"}
          <br />
          {lead.contactName}
          <br />
          {lead.contactEmail || lead.contactPhone}
        </dd>
        <dt>Site</dt>
        <dd>{[lead.siteName, lead.siteAddress].filter(Boolean).join("\n") || "Not recorded"}</dd>
        <dt>Requested service</dt>
        <dd>{lead.requestedService || "Not recorded"}</dd>
        <dt>Confirmed request</dt>
        <dd>{lead.details || "Not recorded"}</dd>
        <dt>Requested visit / deadline</dt>
        <dd>
          {lead.requestedVisitAt?.slice(0, 10) || "Not recorded"} /{" "}
          {lead.requestedDeadlineAt?.slice(0, 10) || "Not recorded"}
        </dd>
      </dl>
      <details className={css.source} open>
        <summary>Original source evidence ({source.evidence.length})</summary>
        {source.evidence.map((item) => (
          <div key={item.id}>
            <strong>{item.label}</strong>
            {item.reference ? <p>{item.reference}</p> : null}
            {item.note ? <p>{item.note}</p> : null}
          </div>
        ))}
      </details>
      <p className={css.hint}>
        Source evidence and internal notes stay inside the company workspace.
      </p>
    </aside>
  );
}

export function Totals({ value }: { value: CplCommercialTotals }) {
  return (
    <dl className={css.total} aria-label="Proposal totals">
      <div>
        <dt>Subtotal</dt>
        <dd>{money(value.subtotalMinor, value.currency)}</dd>
      </div>
      <div>
        <dt>Discount</dt>
        <dd>−{money(value.discountMinor, value.currency)}</dd>
      </div>
      <div>
        <dt>Tax</dt>
        <dd>{money(value.taxMinor, value.currency)}</dd>
      </div>
      <div className={css.grand}>
        <dt>Total</dt>
        <dd>{money(value.totalMinor, value.currency)}</dd>
      </div>
    </dl>
  );
}

type EditableLine = CplCommercialContent["lineItems"][number] & { editId: string; price: string };

export function ProposalEditor({
  proposal,
  branding,
  template,
  busy,
  canEdit,
  onDirty,
  onSave,
  onReload,
  onOpenLead,
}: {
  proposal: CplCommercialProposal;
  branding: CplCommercialBranding;
  template?: CplCommercialTemplate | null;
  busy: boolean;
  canEdit: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (
    content: CplCommercialContent,
    internalNotes: string,
    expectedRevision: number,
  ) => Promise<boolean>;
  onReload: () => void;
  onOpenLead: (id: string) => void;
}) {
  const [baseline] = useState(() => proposal);
  const version = baseline.versions.find((item) => item.version === baseline.currentVersion)!;
  const [content, setContent] = useState(version.content);
  const [lines, setLines] = useState<EditableLine[]>(() =>
    version.content.lineItems.map((line, index) => ({
      ...line,
      editId: `saved-${index}`,
      price: decimalMoney(line.unitPriceMinor),
    })),
  );
  const [discount, setDiscount] = useState(decimalMoney(content.discountMinor));
  const [tax, setTax] = useState(decimalMoney(content.taxBasisPoints));
  const [internalNotes, setInternalNotes] = useState(baseline.internalNotes);
  const [changed, setChanged] = useState(false);
  const [validation, setValidation] = useState("");
  const [catalogCode, setCatalogCode] = useState("");
  const stale = proposal.revision !== baseline.revision;
  const editable = canEdit && ["draft", "revision_requested"].includes(proposal.state);
  useEffect(() => {
    onDirty(changed);
    return () => onDirty(false);
  }, [changed, onDirty]);
  function change<K extends keyof CplCommercialContent>(key: K, value: CplCommercialContent[K]) {
    setContent((previous) => ({ ...previous, [key]: value }));
    setChanged(true);
  }
  function changeLine(index: number, patch: Partial<EditableLine>) {
    setLines((previous) => previous.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setChanged(true);
  }
  function encoded(): CplCommercialContent {
    return {
      ...content,
      lineItems: lines.map((row) => ({
        description: row.description,
        serviceCode: row.serviceCode,
        quantity: row.quantity,
        unit: row.unit,
        unitPriceMinor: parseMinorUnits(row.price),
      })),
      discountMinor: parseMinorUnits(discount),
      taxBasisPoints: parseMinorUnits(tax),
    };
  }
  let totals: CplCommercialTotals | null = null;
  try {
    totals = calculateCplCommercialTotals(encoded());
  } catch {
    /* In-progress decimal input is retained until valid. */
  }
  async function save() {
    try {
      const normalized = normalizeCplCommercialContent(encoded(), branding);
      setValidation("");
      await onSave(normalized, internalNotes, baseline.revision);
    } catch {
      setValidation(
        "Check quantities, amounts, dates, required descriptions and the enabled tax/discount settings. Your entries are kept.",
      );
    }
  }
  return (
    <div className={css.editorGrid}>
      <form
        className={css.stack}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {stale ? (
          <div className={styles.warning} role="alert">
            A newer saved revision is available. Your unsaved entries are kept. Review them before
            discarding and loading the latest version.
            <button className={styles.secondary} type="button" onClick={onReload}>
              Discard edits and load latest
            </button>
          </div>
        ) : null}
        {!editable ? (
          <div className={styles.notice}>
            This version is locked for{" "}
            {proposal.state === "review" ? "review" : "the recorded outcome"}. A permitted revision
            must be opened before editing.
          </div>
        ) : null}
        {validation ? (
          <div role="alert" className={styles.warning}>
            {validation}
          </div>
        ) : null}
        <section className={styles.panel}>
          <p className={styles.eyebrow}>PROPOSAL BUILDER · VERSION {version.version}</p>
          <fieldset className={styles.fieldset} disabled={busy || !editable}>
            <label className={styles.field}>
              Proposal title
              <input
                value={content.title}
                maxLength={240}
                required
                onChange={(event) => change("title", event.target.value)}
              />
            </label>
            {(Object.entries(sectionLabels) as [keyof typeof sectionLabels, string][]).map(
              ([key, label]) => (
                <label className={styles.field} key={key}>
                  {label}
                  <textarea
                    rows={key === "scope" ? 5 : 3}
                    maxLength={20000}
                    value={content[key]}
                    onChange={(event) => change(key, event.target.value)}
                  />
                </label>
              ),
            )}
            <h3>Additional sections</h3>
            {content.sections.map((section, index) => (
              <div className={css.item} key={section.id}>
                <div className={css.itemTop}>
                  <strong>Section {index + 1}</strong>
                  <div className={css.order}>
                    <button
                      type="button"
                      aria-label={`Move section ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => change("sections", moveItem(content.sections, index, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move section ${index + 1} down`}
                      disabled={index === content.sections.length - 1}
                      onClick={() => change("sections", moveItem(content.sections, index, 1))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove section ${index + 1}`}
                      onClick={() =>
                        change(
                          "sections",
                          content.sections.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <label className={styles.field}>
                  Section {index + 1} heading
                  <input
                    required
                    value={section.title}
                    maxLength={240}
                    onChange={(event) =>
                      change(
                        "sections",
                        content.sections.map((row, i) =>
                          i === index ? { ...row, title: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <label className={styles.field}>
                  Section {index + 1} text
                  <textarea
                    rows={4}
                    maxLength={20000}
                    value={section.body}
                    onChange={(event) =>
                      change(
                        "sections",
                        content.sections.map((row, i) =>
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
              disabled={content.sections.length >= 30}
              onClick={() =>
                change("sections", [
                  ...content.sections,
                  { id: crypto.randomUUID(), title: "", body: "" },
                ])
              }
            >
              Add section
            </button>
          </fieldset>
        </section>
        <section className={styles.panel}>
          <div className={css.toolbar}>
            <div>
              <p className={styles.eyebrow}>CLEAR COMMERCIAL TERMS</p>
              <h3>Pricing</h3>
            </div>
            <span className={styles.badge}>{content.currency}</span>
          </div>
          <fieldset className={styles.fieldset} disabled={busy || !editable}>
            <label className={styles.field}>
              Currency
              <select
                value={content.currency}
                onChange={(event) => change("currency", event.target.value)}
              >
                {CPL_COMMERCIAL_CURRENCIES.map((currency) => (
                  <option key={currency}>{currency}</option>
                ))}
              </select>
            </label>
            {lines.map((line, index) => (
              <div className={css.item} key={line.editId}>
                <div className={css.itemTop}>
                  <h4>Item {index + 1}</h4>
                  <div className={css.order}>
                    <button
                      type="button"
                      aria-label={`Move item ${index + 1} up`}
                      disabled={!index}
                      onClick={() => {
                        setLines(moveItem(lines, index, -1));
                        setChanged(true);
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move item ${index + 1} down`}
                      disabled={index === lines.length - 1}
                      onClick={() => {
                        setLines(moveItem(lines, index, 1));
                        setChanged(true);
                      }}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove item ${index + 1}`}
                      onClick={() => {
                        setLines(lines.filter((_, i) => i !== index));
                        setChanged(true);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <label className={styles.field}>
                  Item {index + 1} description
                  <textarea
                    required
                    rows={2}
                    maxLength={2000}
                    value={line.description}
                    onChange={(event) => changeLine(index, { description: event.target.value })}
                  />
                </label>
                <label className={styles.field}>
                  Item {index + 1} service code
                  <input
                    maxLength={120}
                    value={line.serviceCode}
                    onChange={(event) => changeLine(index, { serviceCode: event.target.value })}
                  />
                </label>
                <div className={css.itemFields}>
                  <label className={styles.field}>
                    Item {index + 1} quantity
                    <input
                      required
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(event) => changeLine(index, { quantity: event.target.value })}
                    />
                  </label>
                  <label className={styles.field}>
                    Item {index + 1} unit
                    <input
                      required
                      maxLength={80}
                      value={line.unit}
                      onChange={(event) => changeLine(index, { unit: event.target.value })}
                    />
                  </label>
                  <label className={styles.field}>
                    Item {index + 1} unit price
                    <input
                      required
                      inputMode="decimal"
                      value={line.price}
                      onChange={(event) => changeLine(index, { price: event.target.value })}
                    />
                  </label>
                </div>
                <p className={css.hint}>
                  Line total:{" "}
                  {totals
                    ? money(totals.lineTotalsMinor[index]!, content.currency)
                    : "Check amount and quantity"}
                </p>
              </div>
            ))}
            <button
              type="button"
              className={styles.secondary}
              disabled={lines.length >= 100}
              onClick={() => {
                setLines([
                  ...lines,
                  {
                    editId: crypto.randomUUID(),
                    description: "",
                    serviceCode: "",
                    quantity: "1",
                    unit: "each",
                    unitPriceMinor: 0,
                    price: "0.00",
                  },
                ]);
                setChanged(true);
              }}
            >
              Add line item
            </button>
            {template?.catalog.length ? (
              <div className={styles.fieldPair}>
                <label className={styles.field}>
                  Template service
                  <select
                    value={catalogCode}
                    onChange={(event) => setCatalogCode(event.target.value)}
                  >
                    <option value="">Choose a service</option>
                    {template.catalog.map((item) => (
                      <option key={item.serviceCode} value={item.serviceCode}>
                        {item.serviceCode} · {item.description}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={!catalogCode || lines.length >= 100}
                  onClick={() => {
                    const item = template.catalog.find((row) => row.serviceCode === catalogCode)!;
                    setLines([
                      ...lines,
                      {
                        ...item,
                        quantity: "1",
                        price: decimalMoney(item.unitPriceMinor),
                        editId: crypto.randomUUID(),
                      },
                    ]);
                    setChanged(true);
                  }}
                >
                  Add selected service
                </button>
              </div>
            ) : null}
            <div className={styles.fieldPair}>
              <label className={styles.field}>
                Discount amount
                <input
                  aria-label="Discount amount"
                  inputMode="decimal"
                  value={discount}
                  disabled={!branding.discountEnabled}
                  onChange={(event) => {
                    setDiscount(event.target.value);
                    setChanged(true);
                  }}
                />
                <small>
                  {branding.discountEnabled
                    ? "Fixed amount, before tax."
                    : "Disabled in company artifact settings."}
                </small>
              </label>
              <label className={styles.field}>
                Tax percent
                <input
                  aria-label="Tax percent"
                  inputMode="decimal"
                  value={tax}
                  disabled={!branding.taxEnabled}
                  onChange={(event) => {
                    setTax(event.target.value);
                    setChanged(true);
                  }}
                />
                <small>
                  {branding.taxEnabled
                    ? "Applied to the subtotal less discount."
                    : "Disabled in company artifact settings."}
                </small>
              </label>
            </div>
            {!branding.discountEnabled && !/^0(?:\.0{1,2})?$/u.test(discount) ? (
              <div className={styles.warning}>
                <p>
                  Discounts are now disabled. The saved amount is kept until you choose to remove
                  it. Remove it before saving a new version, or ask an administrator to enable
                  discounts.
                </p>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => {
                    setDiscount("0.00");
                    setChanged(true);
                  }}
                >
                  Remove disabled discount
                </button>
              </div>
            ) : null}
            {!branding.taxEnabled && !/^0(?:\.0{1,2})?$/u.test(tax) ? (
              <div className={styles.warning}>
                <p>
                  Tax is now disabled. The saved rate is kept until you choose to remove it. Remove
                  it before saving a new version, or ask an administrator to enable tax.
                </p>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => {
                    setTax("0.00");
                    setChanged(true);
                  }}
                >
                  Remove disabled tax
                </button>
              </div>
            ) : null}
          </fieldset>
          {totals ? (
            <Totals value={totals} />
          ) : (
            <p role="status" className={styles.warning}>
              Totals will appear when quantities, prices, discount and tax are valid.
            </p>
          )}
        </section>
        <section className={styles.panel}>
          <h3>Schedule &amp; handoff</h3>
          <fieldset className={styles.fieldset} disabled={busy || !editable}>
            <div className={styles.fieldPair}>
              <label className={styles.field}>
                Planned start
                <input
                  type="date"
                  value={content.startDate ?? ""}
                  onChange={(event) => change("startDate", event.target.value || null)}
                />
              </label>
              <label className={styles.field}>
                Planned finish
                <input
                  type="date"
                  value={content.endDate ?? ""}
                  onChange={(event) => change("endDate", event.target.value || null)}
                />
              </label>
            </div>
            <label className={styles.field}>
              Customer notes
              <textarea
                rows={3}
                maxLength={20000}
                value={content.customerNotes}
                onChange={(event) => change("customerNotes", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              Internal site / access instructions
              <textarea
                rows={3}
                maxLength={20000}
                value={content.accessInstructions}
                onChange={(event) => change("accessInstructions", event.target.value)}
              />
              <small>
                Private operational requirements. Excluded from customer preview and PDF.
              </small>
            </label>
            <label className={styles.field}>
              Internal operational constraints
              <textarea
                rows={3}
                maxLength={20000}
                value={content.constraints}
                onChange={(event) => change("constraints", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              Internal / operations notes
              <textarea
                rows={4}
                maxLength={20000}
                value={internalNotes}
                onChange={(event) => {
                  setInternalNotes(event.target.value);
                  setChanged(true);
                }}
              />
              <small>
                Private to the workspace and project handoff. Excluded from customer preview and
                PDF.
              </small>
            </label>
          </fieldset>
        </section>
        <div className={css.saveBar}>
          <div>
            <strong>{changed ? "Unsaved changes" : "Saved version"}</strong>
            <small>Version {version.version} · Review uses saved content only.</small>
          </div>
          <button type="submit" disabled={busy || !editable || !changed || stale}>
            Save proposal
          </button>
        </div>
      </form>
      <SourceSnapshot source={version.sourceLead} onOpenLead={onOpenLead} />
    </div>
  );
}
