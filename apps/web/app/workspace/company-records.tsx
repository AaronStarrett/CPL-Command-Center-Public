"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  CplCatalogItem,
  CplCatalogInput,
  CplDirectoryKind,
  CplDirectoryEntry,
  CplDirectoryDetail,
  CplDirectoryInput,
  CplCompanyAuditEvent,
} from "@bea/domain/cpl-company";
import { CPL_COMMERCIAL_CURRENCIES } from "@bea/domain/cpl-commercial";
import { useUnsavedNavigation } from "./commercial-navigation";
import { decimalMoney, parseMinorUnits, money, type CommercialRequest } from "./commercial-ui";
import {
  CompanyFeedback,
  PageControls,
  useCompanyEdit,
  useCompanyPage,
  type CompanyPanelProps,
} from "./company-ui";
import styles from "./workspace.module.css";

export function CompanyCatalog(
  props: CompanyPanelProps & { defaultCurrency: string; allowed: boolean; initialId?: string },
) {
  const edit = useCompanyEdit(props),
    navigation = useUnsavedNavigation(edit.dirty),
    [q, setQ] = useState(""),
    [status, setStatus] = useState("active"),
    [filters, setFilters] = useState({ q: "", status: "active" }),
    [selected, setSelected] = useState<CplCatalogItem | null>(null),
    [loadingDetail, setLoadingDetail] = useState(Boolean(props.initialId)),
    [editingArea, setEditingArea] = useState<"record" | "status" | null>(null),
    [epoch, setEpoch] = useState(0),
    list = useCompanyPage<CplCatalogItem>(props.request, "/api/cpl-company/catalog", filters);
  const initialRequest = useRef(props.request);
  const setError = edit.setError;
  useEffect(() => {
    initialRequest.current = props.request;
  }, [props.request]);
  useEffect(() => {
    if (!props.initialId) return;
    let active = true;
    void initialRequest
      .current<CplCatalogItem>(`/api/cpl-company/catalog/${props.initialId}`)
      .then((value) => {
        if (active) setSelected(value);
      })
      .catch((error) => {
        if (active) setError(error instanceof Error ? error.message : "Catalog item unavailable.");
      })
      .finally(() => {
        if (active) setLoadingDetail(false);
      });
    return () => {
      active = false;
    };
  }, [props.initialId, setError]);
  function navigate(fn: () => void) {
    navigation.navigate(() => {
      edit.change(false);
      setEditingArea(null);
      setSelected(null);
      setEpoch((value) => value + 1);
      fn();
    });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let price: number | null;
    try {
      price = form.get("price") ? parseMinorUnits(String(form.get("price"))) : null;
    } catch (e) {
      edit.setError(e instanceof Error ? e.message : "Invalid price.");
      return;
    }
    const input: CplCatalogInput = {
      code: String(form.get("code")),
      name: String(form.get("name")),
      description: String(form.get("description")),
      unit: String(form.get("unit")),
      unitPriceMinor: price,
      currency: String(form.get("currency")),
      workflowKey: selected?.workflowKey || String(form.get("workflowKey") || form.get("code")),
    };
    const result = await edit.save<CplCatalogItem>(
      `/api/cpl-company/catalog${selected ? "/" + selected.id : ""}`,
      { expectedRevision: selected?.revision ?? 0, input },
    );
    if (result) {
      setEditingArea(null);
      setSelected(result);
      setEpoch((n) => n + 1);
      list.refresh();
    }
  }
  async function lifecycle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const reason = String(new FormData(event.currentTarget).get("reason"));
    const result = await edit.save<CplCatalogItem>(
      `/api/cpl-company/catalog/${selected.id}/${selected.status === "active" ? "archive" : "reactivate"}`,
      { expectedRevision: selected.revision, reason },
    );
    if (result) {
      setEditingArea(null);
      setSelected(result);
      setEpoch((n) => n + 1);
      list.refresh();
    }
  }
  return (
    <fieldset disabled={edit.busy || loadingDetail} className={styles.fieldset}>
      <section className={styles.panel}>
        {navigation.dialog}
        <h2>Service &amp; line-item catalog</h2>
        <p>
          Stable item IDs and workflow keys retain history. Renaming, repricing or archiving affects
          deliberate future selections; existing leads and proposals retain their snapshots.
        </p>
        <CompanyFeedback edit={edit} />
        <form
          className={styles.actions}
          onSubmit={(event) => {
            event.preventDefault();
            navigate(() => {
              list.first();
              setFilters({ q, status });
            });
          }}
        >
          <label>
            Search catalog
            <input value={q} onChange={(event) => setQ(event.target.value)} />
          </label>
          <label>
            Catalog status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              {["active", "archived", "all"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <button disabled={edit.busy}>Search catalog</button>
        </form>
        <PageControls list={list} disabled={edit.busy} navigate={navigate} />
        <ul className={styles.list}>
          {list.page?.items.map((item) => (
            <li key={item.id}>
              <button disabled={edit.busy} onClick={() => navigate(() => setSelected(item))}>
                {item.code} · {item.name} · revision {item.revision} · {item.status}
              </button>
              <p>
                {item.unitPriceMinor === null
                  ? "No default price"
                  : money(item.unitPriceMinor, item.currency)}{" "}
                / {item.unit} · workflow key {item.workflowKey}
              </p>
            </li>
          ))}
        </ul>
        {props.allowed ? (
          <>
            <button disabled={edit.busy} onClick={() => navigate(() => setSelected(null))}>
              New catalog item
            </button>
            <form
              key={`${selected?.id ?? "new"}:${epoch}`}
              className={styles.form}
              onChange={() => {
                setEditingArea("record");
                edit.change();
              }}
              onSubmit={(event) => void save(event)}
            >
              <h3>{selected ? "Edit saved catalog item" : "New catalog item"}</h3>
              <fieldset
                className={styles.fieldset}
                disabled={edit.busy || editingArea === "status" || selected?.status === "archived"}
              >
                <label className={styles.field}>
                  Catalog code
                  <input
                    name="code"
                    defaultValue={selected?.code ?? ""}
                    required
                    maxLength={80}
                    pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                  />
                </label>
                <label className={styles.field}>
                  Catalog item name
                  <input name="name" defaultValue={selected?.name ?? ""} required maxLength={240} />
                </label>
                <label className={styles.field}>
                  Description
                  <textarea
                    name="description"
                    defaultValue={selected?.description ?? ""}
                    maxLength={2000}
                  />
                </label>
                <label className={styles.field}>
                  Unit
                  <input
                    name="unit"
                    defaultValue={selected?.unit ?? "service"}
                    required
                    maxLength={80}
                  />
                </label>
                <label className={styles.field}>
                  Default unit price
                  <input
                    name="price"
                    inputMode="decimal"
                    defaultValue={
                      selected?.unitPriceMinor == null ? "" : decimalMoney(selected.unitPriceMinor)
                    }
                  />
                  <small>Optional; blank means no price, not a zero-priced service.</small>
                </label>
                <label className={styles.field}>
                  Currency
                  <select
                    name="currency"
                    defaultValue={selected?.currency ?? props.defaultCurrency}
                  >
                    {CPL_COMMERCIAL_CURRENCIES.map((currency) => (
                      <option key={currency}>{currency}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  Fixed workflow key
                  <input
                    name="workflowKey"
                    defaultValue={selected?.workflowKey ?? ""}
                    disabled={!!selected}
                    maxLength={2000}
                  />
                  <small>
                    New items default to the code. Set an existing service key only for deliberate
                    compatibility; it cannot be renamed later.
                  </small>
                </label>
                <button>Save catalog item revision</button>
              </fieldset>
            </form>
            {selected ? (
              <form
                key={`state:${selected.id}:${epoch}`}
                className={styles.form}
                onChange={() => {
                  setEditingArea("status");
                  edit.change();
                }}
                onSubmit={(event) => void lifecycle(event)}
              >
                <fieldset disabled={editingArea === "record"} className={styles.fieldset}>
                  <label className={styles.field}>
                    Reason to {selected.status === "active" ? "archive" : "reactivate"}
                    <textarea name="reason" required maxLength={2000} />
                  </label>
                  <button disabled={edit.busy}>
                    {selected.status === "active" ? "Archive" : "Reactivate"} catalog item
                  </button>
                </fieldset>
                {editingArea === "record" ? (
                  <p>Save or discard the item edits before changing its status.</p>
                ) : null}
                {editingArea === "status" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingArea(null);
                      edit.change(false);
                      setEpoch((n) => n + 1);
                    }}
                  >
                    Discard status reason
                  </button>
                ) : null}
              </form>
            ) : null}
          </>
        ) : (
          <p>Your role can use this catalog but cannot change it.</p>
        )}
      </section>
    </fieldset>
  );
}

export function CompanyCustomerPicker({
  request,
  value,
  onChange,
  disabled = false,
}: {
  request: CommercialRequest;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState(""),
    [q, setQ] = useState(""),
    list = useCompanyPage<CplDirectoryEntry>(request, "/api/cpl-company/directory/customer", {
      q,
      status: "active",
    });
  return (
    <div>
      <label className={styles.field}>
        Customer selection
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose customer</option>
          {value && !list.page?.items.some((item) => item.id === value) ? (
            <option value={value}>Saved customer · {value}</option>
          ) : null}
          {list.page?.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Find customer
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          list.first();
          setQ(query);
        }}
      >
        Find customer
      </button>
      <div>
        {list.page?.total ?? 0} matching customers{" "}
        <button type="button" disabled={disabled || !list.page?.nextCursor} onClick={list.next}>
          More customers
        </button>
        <button type="button" disabled={disabled || !list.cursor} onClick={list.first}>
          First customers
        </button>
      </div>
      {list.error ? <p role="alert">{list.error}</p> : null}
    </div>
  );
}

export function CompanyDirectory(
  props: CompanyPanelProps & {
    allowed: boolean;
    initialTarget?: { kind: CplDirectoryKind; id: string };
  },
) {
  const edit = useCompanyEdit(props),
    navigation = useUnsavedNavigation(edit.dirty),
    [kind, setKind] = useState<CplDirectoryKind>(props.initialTarget?.kind ?? "customer"),
    [q, setQ] = useState(""),
    [status, setStatus] = useState("active"),
    [filters, setFilters] = useState({ q: "", status: "active" }),
    [selected, setSelected] = useState<CplDirectoryDetail | null>(null),
    [loadingDetail, setLoadingDetail] = useState(Boolean(props.initialTarget)),
    [editingArea, setEditingArea] = useState<"record" | "status" | null>(null),
    [customerId, setCustomerId] = useState(""),
    [epoch, setEpoch] = useState(0),
    list = useCompanyPage<CplDirectoryDetail>(
      props.request,
      `/api/cpl-company/directory/${kind}`,
      filters,
    );
  const detailGeneration = useRef(0),
    detailRequest = useRef(props.request);
  useEffect(() => {
    detailRequest.current = props.request;
  }, [props.request]);
  const initialId = props.initialTarget?.id,
    initialKind = props.initialTarget?.kind;
  const setError = edit.setError;
  useEffect(() => {
    if (!initialId || !initialKind) return;
    const run = ++detailGeneration.current;
    let active = true;
    void detailRequest
      .current<CplDirectoryDetail>(`/api/cpl-company/directory/${initialKind}/${initialId}`)
      .then((value) => {
        if (active && run === detailGeneration.current) {
          setSelected(value);
          setCustomerId(value.customerId ?? "");
        }
      })
      .catch((error) => {
        if (active && run === detailGeneration.current)
          setError(error instanceof Error ? error.message : "Directory record unavailable.");
      })
      .finally(() => {
        if (active && run === detailGeneration.current) setLoadingDetail(false);
      });
    return () => {
      active = false;
    };
  }, [initialId, initialKind, setError]);
  function navigate(fn: () => void) {
    navigation.navigate(() => {
      detailGeneration.current++;
      edit.change(false);
      setEditingArea(null);
      setSelected(null);
      setCustomerId("");
      setEpoch((n) => n + 1);
      fn();
    });
  }
  async function open(id: string) {
    const run = ++detailGeneration.current;
    setLoadingDetail(true);
    try {
      const value = await props.request<CplDirectoryDetail>(
        `/api/cpl-company/directory/${kind}/${id}`,
      );
      if (run === detailGeneration.current) {
        setSelected(value);
        setCustomerId(value.customerId ?? "");
      }
    } catch (e) {
      if (run === detailGeneration.current)
        edit.setError(e instanceof Error ? e.message : "Record unavailable.");
    } finally {
      if (run === detailGeneration.current) setLoadingDetail(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      input: CplDirectoryInput = {
        name: String(form.get("name")),
        customerId: kind === "customer" ? null : customerId || null,
        email: kind === "contact" ? String(form.get("email") || "") || null : null,
        phone: kind === "contact" ? String(form.get("phone") || "") : "",
        address: kind === "site" ? String(form.get("address") || "") : "",
      };
    const result = await edit.save<CplDirectoryDetail>(
      `/api/cpl-company/directory/${kind}${selected ? "/" + selected.id : ""}`,
      { expectedRevision: selected?.revision ?? 0, input },
    );
    if (result) {
      setEditingArea(null);
      setSelected(result);
      setCustomerId(result.customerId ?? "");
      setEpoch((n) => n + 1);
      list.refresh();
    }
  }
  async function lifecycle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const result = await edit.save<CplDirectoryDetail>(
      `/api/cpl-company/directory/${kind}/${selected.id}/${selected.status === "active" ? "archive" : "reactivate"}`,
      {
        expectedRevision: selected.revision,
        reason: String(new FormData(event.currentTarget).get("reason")),
      },
    );
    if (result) {
      setEditingArea(null);
      setSelected(result);
      setEpoch((n) => n + 1);
      list.refresh();
    }
  }
  return (
    <fieldset disabled={edit.busy || loadingDetail} className={styles.fieldset}>
      <section className={styles.panel}>
        {navigation.dialog}
        <h2>Company directory</h2>
        <p>
          Edit canonical customer, contact and site records here. Saved leads, proposals, projects
          and reports keep their captured wording until a deliberate supported refresh.
        </p>
        <CompanyFeedback edit={edit} />
        <div className={styles.tabs}>
          {(["customer", "contact", "site"] as const).map((value) => (
            <button
              key={value}
              aria-current={kind === value ? "page" : undefined}
              disabled={edit.busy}
              onClick={() =>
                navigate(() => {
                  setKind(value);
                  list.first();
                })
              }
            >
              {value === "customer" ? "Customers" : value === "contact" ? "Contacts" : "Sites"}
            </button>
          ))}
        </div>
        <form
          className={styles.actions}
          onSubmit={(event) => {
            event.preventDefault();
            navigate(() => {
              list.first();
              setFilters({ q, status });
            });
          }}
        >
          <label>
            Search directory
            <input value={q} onChange={(event) => setQ(event.target.value)} />
          </label>
          <label>
            Directory status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              {["active", "archived", "all"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <button disabled={edit.busy}>Search directory</button>
        </form>
        <PageControls list={list} disabled={edit.busy} navigate={navigate} />
        <ul className={styles.list}>
          {list.page?.items.map((item) => (
            <li key={item.id}>
              <button disabled={edit.busy} onClick={() => navigate(() => void open(item.id))}>
                {item.name} · {item.status} · revision {item.revision}
              </button>
            </li>
          ))}
        </ul>
        {props.allowed ? (
          <button disabled={edit.busy} onClick={() => navigate(() => setSelected(null))}>
            New {kind}
          </button>
        ) : null}
        <form
          key={`${kind}:${selected?.id ?? "new"}:${epoch}`}
          className={styles.form}
          onChange={() => {
            setEditingArea("record");
            edit.change();
          }}
          onSubmit={(event) => void save(event)}
        >
          <h3>{selected ? `Saved ${kind}` : `New ${kind}`}</h3>
          <fieldset
            className={styles.fieldset}
            disabled={
              edit.busy ||
              editingArea === "status" ||
              !props.allowed ||
              selected?.status === "archived"
            }
          >
            <label className={styles.field}>
              {kind === "customer"
                ? "Customer name"
                : kind === "contact"
                  ? "Contact name"
                  : "Site name"}
              <input name="name" defaultValue={selected?.name ?? ""} required maxLength={240} />
            </label>
            {kind !== "customer" ? (
              <CompanyCustomerPicker
                request={props.request}
                value={customerId}
                disabled={edit.busy || !props.allowed}
                onChange={(value) => {
                  setCustomerId(value);
                  edit.change();
                }}
              />
            ) : null}
            {kind === "contact" ? (
              <>
                <label className={styles.field}>
                  Contact email
                  <input name="email" type="email" defaultValue={selected?.email ?? ""} />
                </label>
                <label className={styles.field}>
                  Contact phone
                  <input name="phone" defaultValue={selected?.phone ?? ""} />
                </label>
              </>
            ) : null}
            {kind === "site" ? (
              <label className={styles.field}>
                Site address
                <textarea name="address" defaultValue={selected?.address ?? ""} maxLength={2000} />
              </label>
            ) : null}
            <button>Save directory revision</button>
          </fieldset>
        </form>
        {selected ? (
          <>
            <p>Stable record ID: {selected.id}</p>
            {selected.duplicateCandidates.length ? (
              <div className={styles.warning}>
                Possible duplicates:{" "}
                {selected.duplicateCandidates.map((candidate) => candidate.name).join(", ")}. Review
                deliberately; no automatic merge is performed.
              </div>
            ) : null}
            <details>
              <summary>Directory history · {selected.revisions.length} revisions</summary>
              <ul>
                {selected.revisions.map((row) => (
                  <li key={row.revision}>
                    Version {row.revision} · {row.status} ·{" "}
                    {new Date(row.createdAt).toLocaleString()} · actor {row.actorIdentityId}
                    <p>
                      {row.snapshot.name} · {row.snapshot.email} · {row.snapshot.phone} ·{" "}
                      {row.snapshot.address}
                    </p>
                    {row.reason ? <p>Reason: {row.reason}</p> : null}
                  </li>
                ))}
              </ul>
            </details>
            {props.allowed ? (
              <form
                key={`state:${selected.id}:${epoch}`}
                className={styles.form}
                onChange={() => {
                  setEditingArea("status");
                  edit.change();
                }}
                onSubmit={(event) => void lifecycle(event)}
              >
                <fieldset disabled={editingArea === "record"} className={styles.fieldset}>
                  <label className={styles.field}>
                    Reason to {selected.status === "active" ? "archive" : "reactivate"}
                    <textarea name="reason" required maxLength={2000} />
                  </label>
                  <button disabled={edit.busy}>
                    {selected.status === "active" ? "Archive" : "Reactivate"} {kind}
                  </button>
                </fieldset>
                {editingArea === "record" ? (
                  <p>Save or discard the record edits before changing its status.</p>
                ) : null}
                {editingArea === "status" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingArea(null);
                      edit.change(false);
                      setEpoch((n) => n + 1);
                    }}
                  >
                    Discard status reason
                  </button>
                ) : null}
              </form>
            ) : null}
          </>
        ) : null}
      </section>
    </fieldset>
  );
}

export function CompanyAudit({
  request,
  onTarget,
}: {
  request: CommercialRequest;
  onTarget: (event: CplCompanyAuditEvent) => void;
}) {
  const [filters, setFilters] = useState<Record<string, string>>({}),
    list = useCompanyPage<CplCompanyAuditEvent>(request, "/api/cpl-company/audit", filters);
  return (
    <section className={styles.panel}>
      <h2>Company activity</h2>
      <p>
        Permission-safe summaries identify who changed which record. Raw credentials, invitation
        tokens and private payloads are excluded.
      </p>
      <form
        className={styles.actions}
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget),
            next: Record<string, string> = {};
          for (const key of ["action", "actorIdentityId", "from", "to"]) {
            const value = String(values.get(key) || "");
            if (value)
              next[key] =
                key === "from" || key === "to"
                  ? `${value}T${key === "from" ? "00:00:00.000" : "23:59:59.999"}Z`
                  : value;
          }
          list.first();
          setFilters(next);
        }}
      >
        <label>
          Action filter
          <input name="action" maxLength={160} />
        </label>
        <label>
          Actor identity ID
          <input name="actorIdentityId" />
        </label>
        <label>
          From date (UTC)
          <input name="from" type="date" />
        </label>
        <label>
          Through date (UTC)
          <input name="to" type="date" />
        </label>
        <button>Filter activity</button>
      </form>
      <PageControls list={list} />
      <ul className={styles.list}>
        {list.page?.items.map((event) => (
          <li key={event.id}>
            <strong>{event.action}</strong> · {event.actorName} ·{" "}
            {new Date(event.createdAt).toLocaleString()}
            <p>{event.summary}</p>
            {event.version !== null ? <p>Version {event.version}</p> : null}
            {event.target ? (
              <button onClick={() => onTarget(event)}>Open related record</button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
