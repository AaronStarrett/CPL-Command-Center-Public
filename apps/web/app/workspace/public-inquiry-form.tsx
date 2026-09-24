"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  PublicInquiryForm as Definition,
  PublicInquiryInput,
  PublicReceipt,
} from "@bea/domain/cpl-inbound";
import styles from "./workspace.module.css";

type Failure = { message: string; correlationId: string | null };
const reference = /^[a-zA-Z0-9_-]{8,100}$/u;
function failed(status: number, body: unknown): Failure {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    message:
      status === 429
        ? "There have been too many requests. Please wait before trying again. Your answers are retained."
        : status === 409
          ? "This inquiry form changed or this submission conflicts with an earlier attempt. Your answers are retained; contact the company before resubmitting."
          : status === 404 || status === 410
            ? "This inquiry form is not accepting submissions."
            : status === 400 || status === 422
              ? "The submission could not be accepted. Check the required fields and try again."
              : "The inquiry service is temporarily unavailable. Your answers are retained; retrying the same submission will not create a duplicate.",
    correlationId:
      typeof value.correlationId === "string" && reference.test(value.correlationId)
        ? value.correlationId
        : null,
  };
}

/** Anonymous customer UI. No employee session, company selector, pricing or source-record API. */
export function PublicInquiryForm({
  publicId,
  development = false,
}: {
  publicId: string;
  development?: boolean;
}) {
  const [definition, setDefinition] = useState<Definition | null>(null),
    [values, setValues] = useState<Record<string, string | boolean | null>>({}),
    [serviceId, setServiceId] = useState(""),
    [failure, setFailure] = useState<Failure | null>(null),
    [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState<PublicReceipt | null>(null);
  const attempt = useRef<{ payload: string; eventId: string } | null>(null);
  const active = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++active.current;
    let current = true;
    void Promise.resolve()
      .then(async () => {
        if (!current) return;
        setDefinition(null);
        setReceipt(null);
        setFailure(null);
        setValues({});
        setServiceId("");
        setBusy(false);
        attempt.current = null;
        const response = await fetch(`/api/cpl-inbound/forms/${encodeURIComponent(publicId)}`, {
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (!current || generation !== active.current) return;
        if (!response.ok) {
          setFailure(failed(response.status, body));
          return;
        }
        const form = body as Definition;
        if (
          !form ||
          form.publicId !== publicId ||
          !Array.isArray(form.fields) ||
          !Array.isArray(form.services)
        ) {
          setFailure(failed(503, null));
          return;
        }
        setDefinition(form);
      })
      .catch(() => {
        if (current && generation === active.current) setFailure(failed(503, null));
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [publicId]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!definition || busy || receipt) return;
    const generation = active.current;
    const selectedValues = Object.fromEntries(
      definition.fields.map((field) => [
        field.key,
        values[field.key] ?? (field.type === "boolean" ? null : ""),
      ]),
    );
    const content = {
      configurationVersion: definition.version,
      values: selectedValues,
      serviceId: serviceId || null,
    };
    const payload = JSON.stringify(content);
    if (!attempt.current) attempt.current = { payload, eventId: crypto.randomUUID() };
    const input: PublicInquiryInput = { ...content, eventId: attempt.current.eventId };
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/cpl-inbound/forms/${encodeURIComponent(publicId)}`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body: unknown = await response.json().catch(() => null);
      if (generation !== active.current) return;
      if (!response.ok) {
        setFailure(failed(response.status, body));
        return;
      }
      const result = body as PublicReceipt;
      if (!result || typeof result.reference !== "string" || result.status !== "accepted") {
        setFailure(failed(422, null));
        return;
      }
      setReceipt(result);
    } catch {
      if (generation === active.current) setFailure(failed(503, null));
    } finally {
      if (generation === active.current) setBusy(false);
    }
  }
  return (
    <main className={styles.panel}>
      {development ? (
        <p className={styles.warning}>
          <strong>DEVELOPMENT · Synthetic local inquiry</strong> — use fictional information only.
          This local form is not a live company website.
        </p>
      ) : null}
      {definition ? (
        <>
          <h1>{definition.title}</h1>
          <p>{definition.description}</p>
        </>
      ) : (
        <h1>Company inquiry</h1>
      )}
      {failure ? (
        <p role="alert">
          {failure.message}
          {failure.correlationId ? (
            <>
              {" "}
              Reference: <code>{failure.correlationId}</code>.
            </>
          ) : null}
        </p>
      ) : null}
      {!definition && !failure ? <p role="status">Loading the inquiry form…</p> : null}
      {receipt ? (
        <section role="status">
          <h2>Inquiry received</h2>
          <p>{definition?.confirmationText}</p>
          <p>
            Receipt: <strong>{receipt.reference}</strong>
          </p>
          <p>
            The company will review your inquiry. This receipt does not confirm a booking, proposal
            or acceptance of work.
          </p>
        </section>
      ) : definition ? (
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <fieldset className={styles.fieldset} disabled={busy}>
            {definition.fields.map((field) => (
              <label className={styles.field} key={field.key}>
                {field.label}
                {field.required ? " (required)" : ""}
                {field.type === "textarea" ? (
                  <textarea
                    required={field.required}
                    maxLength={field.maxLength ?? undefined}
                    value={String(values[field.key] ?? "")}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                ) : field.type === "choice" ? (
                  <select
                    required={field.required}
                    value={String(values[field.key] ?? "")}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  >
                    <option value="">Choose an option</option>
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : field.type === "boolean" ? (
                  <select
                    required={field.required}
                    value={
                      values[field.key] === true ? "yes" : values[field.key] === false ? "no" : ""
                    }
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.key]:
                          event.target.value === "" ? null : event.target.value === "yes",
                      }))
                    }
                  >
                    <option value="">Choose an answer</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                ) : (
                  <input
                    type={
                      field.type === "date" ? "date" : field.type === "email" ? "email" : "text"
                    }
                    required={field.required}
                    maxLength={field.maxLength ?? undefined}
                    value={String(values[field.key] ?? "")}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                )}
              </label>
            ))}
            {definition.services.length ? (
              <label className={styles.field}>
                Requested service
                <select
                  required
                  value={serviceId}
                  onChange={(event) => setServiceId(event.target.value)}
                >
                  <option value="">Choose a service</option>
                  {definition.services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <p>
              Do not include passwords, payment details or other sensitive information. Attachments
              are not accepted.
            </p>
            <button type="submit">{busy ? "Submitting…" : "Submit inquiry"}</button>
          </fieldset>
        </form>
      ) : null}
    </main>
  );
}
