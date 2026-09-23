import type { CSSProperties } from "react";
import Image from "next/image";
import type {
  CplCommercialCustomerPreview,
  CplApprovedProposalPdf,
} from "@bea/domain/cpl-commercial";
import { money, sectionLabels } from "./commercial-ui";
import { Totals } from "./commercial-proposal-editor";
import css from "./commercial.module.css";
import styles from "./workspace.module.css";

export function VersionContent({ value }: { value: CplApprovedProposalPdf["content"] }) {
  return (
    <>
      <h2>{value.title}</h2>
      {(Object.entries(sectionLabels) as [keyof typeof sectionLabels, string][]).map(
        ([key, label]) =>
          value[key] ? (
            <section key={key}>
              <h3>{label}</h3>
              <p>{value[key]}</p>
            </section>
          ) : null,
      )}
      {value.sections.map((section) => (
        <section key={section.id}>
          <h3>{section.title}</h3>
          <p>{section.body}</p>
        </section>
      ))}
      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead>
            <tr>
              <th>Service</th>
              <th>Quantity / unit</th>
              <th>Unit price</th>
            </tr>
          </thead>
          <tbody>
            {value.lineItems.map((line, index) => (
              <tr key={index}>
                <td>
                  {line.description}
                  {line.serviceCode ? <small> · {line.serviceCode}</small> : null}
                </td>
                <td>
                  {line.quantity} {line.unit}
                </td>
                <td>{money(line.unitPriceMinor, value.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {value.startDate || value.endDate ? (
        <section>
          <h3>Schedule</h3>
          <p>
            {value.startDate || "Start to confirm"} — {value.endDate || "Finish to confirm"}
          </p>
        </section>
      ) : null}
      {value.customerNotes ? (
        <section>
          <h3>Customer notes</h3>
          <p>{value.customerNotes}</p>
        </section>
      ) : null}
    </>
  );
}

export function CustomerDocument({ preview }: { preview: CplCommercialCustomerPreview }) {
  const { document } = preview;
  return (
    <article
      className={css.document}
      aria-label="Customer proposal preview"
      style={{ "--artifact-accent": document.company.accentColor } as CSSProperties}
    >
      <p className={preview.approved ? css.approval : styles.warning}>
        {preview.approved
          ? ["approved", "awarded"].includes(preview.state)
            ? "APPROVED CUSTOMER DOCUMENT"
            : `HISTORICALLY APPROVED · CURRENT STATE ${preview.state.toUpperCase()} — NOT FOR CUSTOMER DELIVERY`
          : "DRAFT — NOT APPROVED FOR CUSTOMER DELIVERY"}{" "}
        · Version {document.version}
      </p>
      <header className={css.documentHeader}>
        <div>
          {document.company.logoDataUrl ? (
            <Image
              src={document.company.logoDataUrl}
              alt={`${document.company.businessName} logo`}
              width={180}
              height={90}
              unoptimized
            />
          ) : null}
          <h3>{document.company.businessName || "Company branding not configured"}</h3>
          <p>
            {[document.company.address, document.company.email, document.company.phone]
              .filter(Boolean)
              .join("\n")}
          </p>
        </div>
        <div>
          <strong>{document.reference}</strong>
          <p>
            {document.customer.name}
            <br />
            {document.customer.contactName}
            <br />
            {document.customer.contactEmail || document.customer.contactPhone}
          </p>
          <p>
            {document.site.name}
            <br />
            {document.site.address}
          </p>
        </div>
      </header>
      <VersionContent value={document.content} />
      <Totals value={document.totals} />
      <p className={css.hint}>Preview only. No customer message has been sent.</p>
    </article>
  );
}
