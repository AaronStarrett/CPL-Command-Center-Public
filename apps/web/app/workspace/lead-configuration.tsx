"use client";
import { useEffect, useRef, useState } from "react";
import type {
  CplCatalogItem,
  CplLeadConfiguration,
  CplIntakePolicy,
  CplCompanySetting,
  CplIntakeCustomValues,
} from "@bea/domain/cpl-company";
import type { CommercialRequest } from "./commercial-ui";
import { useCompanyPage } from "./company-ui";
import styles from "./workspace.module.css";
export function LeadConfigurationFields({
  request,
  configuration,
  onChange,
  onService,
  saved,
}: {
  request: CommercialRequest;
  configuration?: CplLeadConfiguration;
  onChange: (input: Record<string, unknown>) => void;
  onService: (value: string) => void;
  saved: boolean;
}) {
  const [policy, setPolicy] = useState<CplCompanySetting<CplIntakePolicy> | null>(
      configuration ? { version: configuration.policyVersion, input: configuration.policy } : null,
    ),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [q, setQ] = useState(""),
    [catalogId, setCatalogId] = useState(configuration?.catalog?.id ?? ""),
    [custom, setCustom] = useState<CplIntakeCustomValues>({}),
    [changedValues, setChangedValues] = useState<CplIntakeCustomValues>({});
  const list = useCompanyPage<CplCatalogItem>(request, "/api/cpl-company/catalog", {
      q,
      status: "active",
    }),
    ref = useRef(request);
  useEffect(() => {
    ref.current = request;
  }, [request]);
  useEffect(() => {
    let active = true;
    void ref
      .current<CplCompanySetting<CplIntakePolicy>>("/api/cpl-company/intake-policy")
      .then((value) => {
        if (active) setPolicy(value);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Intake policy unavailable.");
      });
    return () => {
      active = false;
    };
  }, []);
  function answer(id: string, value: string | boolean | null) {
    setCustom((old) => ({ ...old, [id]: value }));
    const next = { ...changedValues, [id]: value };
    setChangedValues(next);
    onChange({ customValues: next });
  }
  return (
    <section className={styles.panel}>
      <h3>Company intake configuration</h3>
      {error || list.error ? (
        <p role="alert">
          {error || list.error} Save and readiness checks still validate the current policy on the
          server.
        </p>
      ) : null}
      <label className={styles.field}>
        Catalog service
        <select
          value={catalogId}
          onChange={(event) => {
            const id = event.target.value;
            setCatalogId(id);
            onChange({ catalogItemId: id || null });
            const item = list.page?.items.find((row) => row.id === id);
            if (item) onService(item.workflowKey);
          }}
        >
          <option value="">Use human-entered requested service</option>
          {catalogId && !list.page?.items.some((item) => item.id === catalogId) ? (
            <option value={catalogId}>
              {configuration?.catalog?.name ?? "Saved catalog selection"} · retained revision{" "}
              {configuration?.catalog?.revision}
            </option>
          ) : null}
          {list.page?.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.code} · {item.name} · {item.currency} · revision {item.revision}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        Find catalog service
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <button
        type="button"
        onClick={() => {
          list.first();
          setQ(query);
        }}
      >
        Find catalog service
      </button>
      <span>{list.page?.total ?? 0} matching services</span>
      <button type="button" disabled={!list.page?.nextCursor} onClick={list.next}>
        More services
      </button>
      <button type="button" disabled={!list.cursor} onClick={list.first}>
        First services
      </button>
      {saved && configuration?.catalog ? (
        <label>
          <input
            type="checkbox"
            onChange={(event) => onChange({ refreshCatalog: event.target.checked })}
          />
          Explicitly refresh this lead’s selected catalog snapshot from its current revision
        </label>
      ) : null}
      {saved ? (
        <label>
          <input
            type="checkbox"
            onChange={(event) => onChange({ refreshDirectory: event.target.checked })}
          />
          Explicitly refresh this lead’s linked customer/contact/site wording
        </label>
      ) : null}
      <p>
        Selection saves a server-verified snapshot. Later catalog or directory edits do not silently
        rewrite this lead.
      </p>
      {policy ? (
        <>
          <p>
            Current policy version {policy.version} ·{" "}
            {configuration?.reviewedPolicyVersion === policy.version
              ? "Reviewed for this lead"
              : "Review required before proposal readiness"}
          </p>
          {policy.input.requiredFields.length ? (
            <p>
              Additional required fields:{" "}
              {policy.input.requiredFields.map((key) => key.replace(/([A-Z])/g, " $1")).join(", ")}.
            </p>
          ) : null}
          {policy.input.customFields
            .filter((field) => field.active)
            .map((field) => {
              const value = Object.hasOwn(custom, field.id)
                ? custom[field.id]
                : (configuration?.customValues[field.id] ?? null);
              return (
                <label className={styles.field} key={field.id}>
                  {field.label}
                  {field.required ? " · Required for readiness" : ""}
                  {field.type === "boolean" ? (
                    <select
                      value={value === null ? "" : String(value)}
                      onChange={(event) =>
                        answer(
                          field.id,
                          event.target.value === "" ? null : event.target.value === "true",
                        )
                      }
                    >
                      <option value="">Not answered</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  ) : field.type === "choice" ? (
                    <select
                      value={typeof value === "string" ? value : ""}
                      onChange={(event) => answer(field.id, event.target.value || null)}
                    >
                      <option value="">Not answered</option>
                      {field.options.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={typeof value === "string" ? value : ""}
                      maxLength={2000}
                      onChange={(event) => answer(field.id, event.target.value || null)}
                    />
                  )}
                </label>
              );
            })}
        </>
      ) : (
        <p>Loading the current company intake policy…</p>
      )}
    </section>
  );
}
