"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CplCompanyPage } from "@bea/domain/cpl-company";
import type { CommercialRequest } from "./commercial-ui";
import styles from "./workspace.module.css";
export type CompanyPanelProps = {
  request: CommercialRequest;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
};
export function useCompanyEdit(props: CompanyPanelProps) {
  const { onDirty } = props;
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const attempts = useRef(new Map<string, { payload: string; key: string }>());
  const change = useCallback(
    (value = true) => {
      setDirty(value);
      onDirty(value);
    },
    [onDirty],
  );
  async function save<T>(
    path: string,
    input: Record<string, unknown>,
    idempotent = true,
  ): Promise<T | null> {
    if (busy) return null;
    const payload = JSON.stringify(input);
    let attempt = attempts.current.get(path);
    if (attempt?.payload !== payload) {
      attempt = { payload, key: crypto.randomUUID() };
      attempts.current.set(path, attempt);
    }
    setBusy(true);
    props.onBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await props.request<T>(path, {
        ...input,
        ...(idempotent ? { idempotencyKey: attempt.key } : {}),
      });
      change(false);
      setNotice("Saved. Existing work retains its recorded version.");
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change could not be saved.");
      return null;
    } finally {
      setBusy(false);
      props.onBusy(false);
    }
  }
  return { dirty, busy, error, notice, change, save, setError };
}
export function CompanyFeedback({ edit }: { edit: ReturnType<typeof useCompanyEdit> }) {
  return (
    <>
      {edit.error ? (
        <p role="alert" className={styles.warning}>
          {edit.error}
        </p>
      ) : null}
      {edit.notice ? <p role="status">{edit.notice}</p> : null}
    </>
  );
}
export function useCompanyPage<T>(
  request: CommercialRequest,
  path: string,
  filters: Record<string, string> = {},
) {
  const [page, setPage] = useState<CplCompanyPage<T> | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [cursor, setCursor] = useState(""),
    [reload, setReload] = useState(0);
  const input = JSON.stringify(filters),
    ref = useRef(request);
  useEffect(() => {
    ref.current = request;
  }, [request]);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    let active = true;
    const params = new URLSearchParams({
      ...JSON.parse(input),
      limit: "25",
      ...(cursor ? { cursor } : {}),
    });
    void Promise.resolve()
      .then(() => {
        if (!active || current !== generation.current) return null;
        setBusy(true);
        setError("");
        setPage(null);
        return ref.current<CplCompanyPage<T>>(`${path}?${params}`);
      })
      .then((result) => {
        if (active && current === generation.current && result) setPage(result);
      })
      .catch((e) => {
        if (active && current === generation.current) {
          setPage(null);
          setError(e instanceof Error ? e.message : "List unavailable.");
        }
      })
      .finally(() => {
        if (active && current === generation.current) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [path, input, cursor, reload]);
  return {
    page,
    error,
    busy,
    cursor,
    first: () => setCursor(""),
    next: () => setCursor(page?.nextCursor ?? ""),
    refresh: () => setReload((value) => value + 1),
  };
}
export function PageControls({
  list,
  disabled = false,
  navigate = (fn) => fn(),
}: {
  list: ReturnType<typeof useCompanyPage>;
  disabled?: boolean;
  navigate?: (fn: () => void) => void;
}) {
  return (
    <div className={styles.actions}>
      <span>
        {list.page?.total ?? 0} results · up to 25 per page{list.busy ? " · Loading…" : ""}
      </span>
      <button disabled={disabled || list.busy || !list.cursor} onClick={() => navigate(list.first)}>
        First page
      </button>
      <button
        disabled={disabled || list.busy || !list.page?.nextCursor}
        onClick={() => navigate(list.next)}
      >
        Next page
      </button>
      <button disabled={disabled || list.busy} onClick={() => navigate(list.refresh)}>
        Refresh list
      </button>
      {list.error ? <p role="alert">{list.error}</p> : null}
    </div>
  );
}
