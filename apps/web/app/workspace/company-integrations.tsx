"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  IntegrationWorkspace,
  IntegrationConnection,
  GmailConfiguration,
} from "@bea/domain/cpl-integrations";
import type {
  InquiryForm,
  MappingVersion,
  SourceReceiptSummary,
  SourceReceiptDetail,
} from "@bea/domain/cpl-inbound";
import {
  CompanyFeedback,
  PageControls,
  useCompanyEdit,
  useCompanyPage,
  type CompanyPanelProps,
} from "./company-ui";
import {
  CompanyIntakeForms,
  IntakeMappingEditor,
  IntakeMappingHistory,
  SavedIntakeMapping,
} from "./company-intake-forms";
import { useUnsavedNavigation } from "./commercial-navigation";
import type { InboundEvidenceDownload } from "./integration-evidence-download";
import styles from "./workspace.module.css";

type Choice = { id: string; name: string };
type Area = "connections" | "forms" | "mappings" | "receipts";
export type IntegrationNavigationTarget = {
  kind: "integration" | "source_receipt";
  id: string;
  nonce: number;
};
type Props = CompanyPanelProps & {
  authorityKey: string;
  services: Choice[];
  customFields: Choice[];
  onOpenLead: (leadId: string) => void;
  onAuthorize: (connection: IntegrationConnection) => Promise<void>;
  onDownloadEvidence?: (input: InboundEvidenceDownload) => Promise<void>;
  initialTarget?: IntegrationNavigationTarget;
};
const readable = (value: string) => value.replaceAll("_", " ");
const time = (value: string | null) => (value ? new Date(value).toLocaleString() : "Not recorded");
const normalizationAnswer = (value: string | boolean | null) =>
  value === null ? "Not supplied" : value === true ? "Yes" : value === false ? "No" : value;

/** Parent keys this panel by identity/company/membership version. Requests remain server scoped. */
export function CompanyIntegrations(props: Props) {
  const [workspace, setWorkspace] = useState<IntegrationWorkspace | null>(null),
    [error, setError] = useState(""),
    [area, setArea] = useState<Area>(
      props.initialTarget?.kind === "source_receipt" ? "receipts" : "connections",
    ),
    [targetLoading, setTargetLoading] = useState(props.initialTarget?.kind === "integration"),
    [targetError, setTargetError] = useState(""),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0),
    [selectedConnection, setSelectedConnection] = useState<IntegrationConnection | null>(null),
    [selectedMapping, setSelectedMapping] = useState<MappingVersion | null>(null),
    [epoch, setEpoch] = useState(0);
  const { onDirty, onBusy } = props;
  const navigation = useUnsavedNavigation(dirty),
    request = useRef(props.request);
  useEffect(() => {
    request.current = props.request;
  }, [props.request]);
  const changed = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirty(value);
    },
    [onDirty],
  );
  const working = useCallback(
    (value: boolean) => {
      setBusy(value);
      onBusy(value);
    },
    [onBusy],
  );
  useEffect(
    () => () => {
      onDirty(false);
      onBusy(false);
    },
    [onDirty, onBusy],
  );
  useEffect(() => {
    const target = props.initialTarget;
    if (target?.kind !== "integration") return;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      working(true);
      try {
        const value = await request.current<IntegrationConnection>(
          `/api/cpl-integrations/connections/${encodeURIComponent(target.id)}`,
        );
        if (value.id !== target.id)
          throw new Error("The requested connection could not be verified.");
        if (active) setSelectedConnection(value);
      } catch (error) {
        if (active)
          setTargetError(
            error instanceof Error ? error.message : "The requested connection is unavailable.",
          );
      } finally {
        if (active) {
          setTargetLoading(false);
          working(false);
        }
      }
    });
    return () => {
      active = false;
    };
  }, [props.initialTarget, working]);
  useEffect(() => {
    let active = true;
    void request
      .current<IntegrationWorkspace>("/api/cpl-integrations/workspace")
      .then((value) => {
        if (active) {
          setWorkspace(value);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Integration status is unavailable.");
      });
    return () => {
      active = false;
    };
  }, [props.authorityKey, refresh]);
  function navigate(next: Area) {
    if (busy) return;
    navigation.navigate(() => {
      changed(false);
      setArea(next);
      setEpoch((value) => value + 1);
    });
  }
  function savedConnection(value: IntegrationConnection) {
    setWorkspace((current) =>
      current
        ? {
            ...current,
            connections: {
              ...current.connections,
              items: current.connections.items.some((item) => item.id === value.id)
                ? current.connections.items.map((item) => (item.id === value.id ? value : item))
                : [...current.connections.items, value],
            },
          }
        : current,
    );
    setSelectedConnection(value);
    changed(false);
    setEpoch((current) => current + 1);
    setRefresh((current) => current + 1);
  }
  function savedForm(value: InquiryForm) {
    setWorkspace((current) =>
      current
        ? {
            ...current,
            forms: {
              ...current.forms,
              items: current.forms.items.some((item) => item.id === value.id)
                ? current.forms.items.map((item) => (item.id === value.id ? value : item))
                : [...current.forms.items, value],
            },
          }
        : current,
    );
    setRefresh((current) => current + 1);
  }
  function savedMapping(value: MappingVersion) {
    setSelectedMapping(value);
    changed(false);
    setEpoch((current) => current + 1);
    setWorkspace((current) =>
      current
        ? {
            ...current,
            mappings: [
              ...current.mappings.filter(
                (item) => !(item.id === value.id && item.version === value.version),
              ),
              value,
            ],
          }
        : current,
    );
    setRefresh((current) => current + 1);
  }
  const shared = { request: props.request, onDirty: changed, onBusy: working };
  const connection = selectedConnection;
  const visibleArea =
    workspace && !workspace.permissions.canViewStatus && workspace.permissions.canReadSource
      ? "receipts"
      : area;
  return (
    <section>
      {navigation.dialog}
      <h2>Company integrations &amp; intake</h2>
      <p>
        Connections and inquiry sources belong to the selected company. Intake creates work for
        human review; it does not approve, send or book anything.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {targetError ? <p role="alert">{targetError}</p> : null}
      {!workspace && !error ? <p role="status">Loading integration status…</p> : null}
      {workspace ? (
        <>
          <p role="status">
            Provider environment: <strong>{readable(workspace.runtime.providerMode)}</strong>. Live
            Gmail verification is deferred.
          </p>
          {workspace.runtime.providerMode === "local_fixture" ? (
            <p className={styles.warning}>
              LOCAL FIXTURE — controlled messages exercise the provider adapter. No real mailbox is
              connected or accessed.
            </p>
          ) : null}
          <nav aria-label="Integration settings sections" className={styles.tabs}>
            {(["connections", "forms", "mappings", "receipts"] as Area[])
              .filter((value) =>
                value === "receipts"
                  ? workspace.permissions.canReadSource
                  : workspace.permissions.canViewStatus,
              )
              .map((value) => (
                <button
                  key={value}
                  disabled={busy}
                  aria-current={visibleArea === value ? "page" : undefined}
                  onClick={() => navigate(value)}
                >
                  {value === "connections"
                    ? "Gmail connections"
                    : value === "forms"
                      ? "Inquiry forms"
                      : value === "mappings"
                        ? "Mappings"
                        : "Source receipts"}
                </button>
              ))}
          </nav>
          {visibleArea === "connections" && workspace.permissions.canViewStatus ? (
            <>
              <ConnectionChoices
                key={refresh}
                request={props.request}
                initial={workspace.connections.items}
                busy={busy}
                canConfigure={workspace.permissions.canConfigure}
                navigate={(action) =>
                  navigation.navigate(() => {
                    changed(false);
                    setSelectedConnection(null);
                    setEpoch((value) => value + 1);
                    action();
                  })
                }
                onSelect={(value) => {
                  setSelectedConnection(value);
                  setEpoch((current) => current + 1);
                }}
              />
              {targetLoading ? (
                <p role="status">Loading the selected connection…</p>
              ) : (
                <ConnectionEditor
                  key={`${connection?.id ?? "new"}:${epoch}`}
                  {...shared}
                  value={connection}
                  workspace={workspace}
                  onSaved={savedConnection}
                  onAuthorize={props.onAuthorize}
                />
              )}
            </>
          ) : null}
          {visibleArea === "forms" && workspace.permissions.canViewStatus ? (
            <CompanyIntakeForms
              key={epoch}
              {...shared}
              forms={workspace.forms.items}
              total={workspace.forms.total}
              mappings={workspace.mappings}
              services={props.services}
              customFields={props.customFields}
              canConfigure={workspace.permissions.canConfigure}
              onSaved={savedForm}
            />
          ) : null}
          {visibleArea === "mappings" && workspace.permissions.canViewStatus ? (
            <>
              <div className={styles.actions}>
                {workspace.mappings.map((item) => (
                  <button
                    key={`${item.id}:${item.version}`}
                    disabled={busy}
                    onClick={() =>
                      navigation.navigate(() => {
                        changed(false);
                        setSelectedMapping(item);
                        setEpoch((value) => value + 1);
                      })
                    }
                  >
                    {item.input.name} · version {item.version}
                  </button>
                ))}
                {workspace.permissions.canConfigure ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      navigation.navigate(() => {
                        changed(false);
                        setSelectedMapping(null);
                        setEpoch((value) => value + 1);
                      })
                    }
                  >
                    New mapping
                  </button>
                ) : null}
              </div>
              <IntakeMappingEditor
                key={`${selectedMapping?.id ?? "new"}:${epoch}`}
                {...shared}
                value={selectedMapping}
                customFields={props.customFields}
                canConfigure={workspace.permissions.canConfigure}
                onSaved={savedMapping}
              />
              {selectedMapping ? (
                <IntakeMappingHistory
                  key={`${selectedMapping.id}:${selectedMapping.version}`}
                  request={props.request}
                  mapping={selectedMapping}
                />
              ) : null}
            </>
          ) : null}
          {visibleArea === "receipts" && workspace.permissions.canReadSource ? (
            <SourceReceipts
              key={epoch}
              {...shared}
              mappings={workspace.mappings}
              customFields={props.customFields}
              onOpenLead={props.onOpenLead}
              onDownloadEvidence={props.onDownloadEvidence}
              initialId={
                props.initialTarget?.kind === "source_receipt" ? props.initialTarget.id : undefined
              }
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ConnectionChoices({
  request,
  initial,
  busy,
  canConfigure,
  navigate,
  onSelect,
}: {
  request: CompanyPanelProps["request"];
  initial: IntegrationConnection[];
  busy: boolean;
  canConfigure: boolean;
  navigate: (action: () => void) => void;
  onSelect: (connection: IntegrationConnection | null) => void;
}) {
  const list = useCompanyPage<IntegrationConnection>(request, "/api/cpl-integrations/connections");
  return (
    <section>
      <PageControls list={list} disabled={busy} navigate={navigate} />
      <div className={styles.actions}>
        {(list.page?.items ?? initial).map((item) => (
          <button
            key={item.id}
            disabled={busy || list.busy}
            onClick={() => navigate(() => onSelect(item))}
          >
            {item.displayName} · {readable(item.state)}
            {item.mode === "local_fixture" ? " · LOCAL FIXTURE" : ""}
          </button>
        ))}
        {canConfigure ? (
          <button disabled={busy} onClick={() => navigate(() => onSelect(null))}>
            New Gmail connection
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ConnectionEditor(
  props: CompanyPanelProps & {
    value: IntegrationConnection | null;
    workspace: IntegrationWorkspace;
    onSaved: (connection: IntegrationConnection) => void;
    onAuthorize: (connection: IntegrationConnection) => Promise<void>;
  },
) {
  const edit = useCompanyEdit(props),
    [input, setInput] = useState<GmailConfiguration>(
      props.value?.configuration ?? {
        displayName: "",
        selection: null,
        mappingId: null,
        mappingVersion: null,
      },
    ),
    [labels, setLabels] = useState<Choice[]>([]),
    [labelBusy, setLabelBusy] = useState(false),
    [reason, setReason] = useState(""),
    [providerBusy, setProviderBusy] = useState(false);
  const permission = props.workspace.permissions;
  function change(value: Partial<GmailConfiguration>) {
    setInput((current) => ({ ...current, ...value }));
    edit.change();
  }
  async function labelsForConnection() {
    if (!props.value || labelBusy || edit.busy) return;
    setLabelBusy(true);
    props.onBusy(true);
    edit.setError("");
    try {
      setLabels(
        await props.request<Choice[]>(`/api/cpl-integrations/connections/${props.value.id}/labels`),
      );
    } catch (e) {
      edit.setError(e instanceof Error ? e.message : "Labels are unavailable.");
    } finally {
      setLabelBusy(false);
      props.onBusy(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await edit.save<IntegrationConnection>(
      props.value
        ? `/api/cpl-integrations/connections/${props.value.id}/save`
        : "/api/cpl-integrations/connections",
      {
        input,
        ...(props.value
          ? {
              expectedRevision: props.value.revision,
              reconcile: input.selection?.start.kind ?? "from_now",
            }
          : {}),
      },
    );
    if (result) props.onSaved(result);
  }
  async function state(action: "pause" | "resume" | "disconnect" | "sync") {
    if (!props.value) return;
    const result = await edit.save<IntegrationConnection | { connection: IntegrationConnection }>(
      `/api/cpl-integrations/connections/${props.value.id}/${action === "sync" ? "sync" : "state"}`,
      { expectedRevision: props.value.revision, reason, ...(action === "sync" ? {} : { action }) },
    );
    if (result) props.onSaved("connection" in result ? result.connection : result);
  }
  async function authorize() {
    if (!props.value) return;
    setProviderBusy(true);
    props.onBusy(true);
    edit.setError("");
    try {
      await props.onAuthorize(props.value);
    } catch (e) {
      edit.setError(e instanceof Error ? e.message : "Authorization could not begin.");
    } finally {
      setProviderBusy(false);
      props.onBusy(false);
    }
  }
  const changedConfig =
    JSON.stringify(input) !==
    JSON.stringify(
      props.value?.configuration ?? {
        displayName: "",
        selection: null,
        mappingId: null,
        mappingVersion: null,
      },
    );
  return (
    <section className={styles.panel}>
      <CompanyFeedback edit={edit} />
      {props.value ? (
        <>
          <h3>{props.value.displayName}</h3>
          <p>
            {readable(props.value.state)} · generation {props.value.generation} · configuration{" "}
            {props.value.configurationVersion}
          </p>
          <p>Account: {props.value.account?.email ?? "Authorization required"}</p>
          <dl>
            <dt>Granted scopes</dt>
            <dd>
              {props.value.grantedScopes.length ? props.value.grantedScopes.join(", ") : "None"}
            </dd>
            <dt>Coverage</dt>
            <dd>{readable(props.value.coverage)}</dd>
            <dt>Last attempt</dt>
            <dd>{time(props.value.lastAttemptAt)}</dd>
            <dt>Last successful sync</dt>
            <dd>{time(props.value.lastSuccessAt)}</dd>
            <dt>Next eligible attempt</dt>
            <dd>{time(props.value.nextEligibleAt)}</dd>
          </dl>
          {props.value.lastIssue ? (
            <p role="alert">
              {props.value.lastIssue.message} · {props.value.lastIssue.code}
              {props.value.lastIssue.correlationId
                ? ` · Reference ${props.value.lastIssue.correlationId}`
                : ""}
            </p>
          ) : null}
          <p>
            The selected label restricts this application’s intake. Google grants mailbox-wide
            read-only scope; messages, labels and attachments are not modified.
          </p>
          {permission.canAuthorize ? (
            <button
              disabled={
                edit.busy ||
                providerBusy ||
                labelBusy ||
                changedConfig ||
                reason.trim().length > 0 ||
                props.workspace.runtime.providerMode === "disabled"
              }
              onClick={() => void authorize()}
            >
              {props.value.mode === "local_fixture"
                ? "Authorize controlled local fixture"
                : props.value.account
                  ? "Reconnect Google authorization"
                  : "Authorize Google read-only intake"}
            </button>
          ) : null}
        </>
      ) : null}
      <form className={styles.form} onSubmit={(event) => void save(event)}>
        <fieldset
          disabled={!permission.canConfigure || edit.busy || providerBusy || labelBusy}
          className={styles.fieldset}
        >
          <label className={styles.field}>
            Connection name
            <input
              required
              maxLength={160}
              value={input.displayName}
              onChange={(event) => change({ displayName: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            Intake mapping
            <select
              value={input.mappingId ? `${input.mappingId}:${input.mappingVersion}` : ""}
              onChange={(event) => {
                const selected = props.workspace.mappings.find(
                  (item) => `${item.id}:${item.version}` === event.target.value,
                );
                change({
                  mappingId: selected?.id ?? null,
                  mappingVersion: selected?.version ?? null,
                });
              }}
            >
              <option value="">Choose a Gmail mapping</option>
              {props.workspace.mappings
                .filter((item) => item.input.sourceKind === "gmail")
                .map((item) => (
                  <option key={`${item.id}:${item.version}`} value={`${item.id}:${item.version}`}>
                    {item.input.name} · version {item.version}
                  </option>
                ))}
            </select>
          </label>
          {props.value?.account ? (
            <>
              <button type="button" onClick={() => void labelsForConnection()}>
                Load authorized label choices
              </button>
              <label className={styles.field}>
                Selected label
                <select
                  value={input.selection?.labelId ?? ""}
                  onChange={(event) => {
                    const label = labels.find((item) => item.id === event.target.value);
                    if (label)
                      change({
                        selection: {
                          kind: "label",
                          labelId: label.id,
                          labelName: label.name,
                          start: input.selection?.start ?? { kind: "from_now" },
                          cadenceMinutes: input.selection?.cadenceMinutes ?? 15,
                        },
                      });
                  }}
                >
                  <option value="">Choose one authorized label</option>
                  {input.selection &&
                  !labels.some((item) => item.id === input.selection?.labelId) ? (
                    <option value={input.selection.labelId}>
                      {input.selection.labelName} (saved)
                    </option>
                  ) : null}
                  {labels.map((label) => (
                    <option key={label.id} value={label.id}>
                      {label.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <p>Save the connection, authorize it, then select an existing label.</p>
          )}
          {input.selection ? (
            <>
              <label className={styles.field}>
                Start policy
                <select
                  value={input.selection.start.kind}
                  onChange={(event) => {
                    if (input.selection)
                      change({
                        selection: {
                          ...input.selection,
                          start:
                            event.target.value === "from_now"
                              ? { kind: "from_now" }
                              : { kind: "bounded_backfill", after: "", maxMessages: 100 },
                        },
                      });
                  }}
                >
                  <option value="from_now">Only messages from the saved starting checkpoint</option>
                  <option value="bounded_backfill">Explicit bounded backfill</option>
                </select>
              </label>
              {input.selection.start.kind === "bounded_backfill" ? (
                <>
                  <label className={styles.field}>
                    Backfill after (UTC date)
                    <input
                      required
                      type="date"
                      value={input.selection.start.after.slice(0, 10)}
                      onChange={(event) => {
                        if (input.selection?.start.kind === "bounded_backfill")
                          change({
                            selection: {
                              ...input.selection,
                              start: {
                                ...input.selection.start,
                                after: event.target.value
                                  ? `${event.target.value}T00:00:00.000Z`
                                  : "",
                              },
                            },
                          });
                      }}
                    />
                  </label>
                  <label className={styles.field}>
                    Maximum messages
                    <input
                      required
                      type="number"
                      min={1}
                      max={500}
                      value={input.selection.start.maxMessages}
                      onChange={(event) => {
                        if (input.selection?.start.kind === "bounded_backfill")
                          change({
                            selection: {
                              ...input.selection,
                              start: {
                                ...input.selection.start,
                                maxMessages: Number(event.target.value),
                              },
                            },
                          });
                      }}
                    />
                  </label>
                </>
              ) : null}
              <label className={styles.field}>
                Check interval (minutes)
                <input
                  required
                  type="number"
                  min={5}
                  max={1440}
                  value={input.selection.cadenceMinutes}
                  onChange={(event) => {
                    if (input.selection)
                      change({
                        selection: {
                          ...input.selection,
                          cadenceMinutes: Number(event.target.value),
                        },
                      });
                  }}
                />
              </label>
            </>
          ) : null}
          <button>Save connection configuration</button>
        </fieldset>
      </form>
      {props.value ? (
        <fieldset
          disabled={
            !permission.canOperate || edit.busy || providerBusy || labelBusy || changedConfig
          }
          className={styles.fieldset}
        >
          <label className={styles.field}>
            Operation reason
            <input
              value={reason}
              maxLength={2000}
              onChange={(event) => {
                setReason(event.target.value);
                edit.change();
              }}
            />
          </label>
          <button
            disabled={!reason.trim() || props.value.state !== "active"}
            onClick={() => void state("sync")}
          >
            Queue sync now
          </button>
          <button
            disabled={!reason.trim() || props.value.state !== "active"}
            onClick={() => void state("pause")}
          >
            Pause intake
          </button>
          <button
            disabled={!reason.trim() || props.value.state !== "paused"}
            onClick={() => void state("resume")}
          >
            Resume intake
          </button>
          {permission.canConfigure ? (
            <button
              disabled={!reason.trim() || props.value.state === "disconnected"}
              onClick={() => void state("disconnect")}
            >
              Disconnect local grant
            </button>
          ) : null}
          <p>
            Sync now queues bounded work for the normal worker. Disconnect fences work and removes
            this local grant; it does not revoke unrelated Google authorizations.
          </p>
        </fieldset>
      ) : null}
    </section>
  );
}

function SourceReceipts(
  props: CompanyPanelProps & {
    mappings: MappingVersion[];
    customFields: Choice[];
    onOpenLead: (leadId: string) => void;
    onDownloadEvidence?: (input: InboundEvidenceDownload) => Promise<void>;
    initialId?: string;
  },
) {
  const [status, setStatus] = useState(""),
    [detail, setDetail] = useState<SourceReceiptDetail | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
  const list = useCompanyPage<SourceReceiptSummary>(
      props.request,
      "/api/cpl-integrations/receipts",
      status ? { status } : {},
    ),
    navigation = useUnsavedNavigation(dirty),
    generation = useRef(0),
    request = useRef(props.request),
    onBusy = useRef(props.onBusy);
  useEffect(() => {
    request.current = props.request;
    onBusy.current = props.onBusy;
  }, [props.request, props.onBusy]);
  useEffect(() => {
    const current = generation;
    return () => {
      current.current += 1;
    };
  }, []);
  const open = useCallback(async (id: string) => {
    const run = ++generation.current;
    setLoading(true);
    onBusy.current(true);
    setDetail(null);
    setError("");
    try {
      const value = await request.current<SourceReceiptDetail>(
        `/api/cpl-integrations/receipts/${id}`,
      );
      if (value.id !== id) throw new Error("The requested source receipt could not be verified.");
      if (run === generation.current) setDetail(value);
    } catch (e) {
      if (run === generation.current)
        setError(e instanceof Error ? e.message : "Source receipt unavailable.");
    } finally {
      if (run === generation.current) {
        setLoading(false);
        onBusy.current(false);
      }
    }
  }, []);
  useEffect(() => {
    if (!props.initialId) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return open(props.initialId!);
    });
    return () => {
      active = false;
    };
  }, [props.initialId, open]);
  function navigate(action: () => void) {
    if (busy || loading) return;
    navigation.navigate(() => {
      setDirty(false);
      props.onDirty(false);
      setDetail(null);
      action();
    });
  }
  return (
    <section>
      {navigation.dialog}
      <h2>Source receipts</h2>
      <p>
        Source claims are unverified incoming information. Human review is required before a lead
        becomes ready.
      </p>
      <label className={styles.field}>
        Processing state
        <select
          disabled={busy || loading}
          value={status}
          onChange={(event) => {
            const value = event.target.value;
            navigate(() => {
              setStatus(value);
              list.first();
            });
          }}
        >
          <option value="">All states</option>
          {[
            "queued",
            "processing",
            "needs_review",
            "linked_lead",
            "rejected",
            "failed",
            "blocked",
          ].map((value) => (
            <option key={value} value={value}>
              {readable(value)}
            </option>
          ))}
        </select>
      </label>
      <PageControls list={list} disabled={busy || loading} navigate={navigate} />
      {list.page?.items.map((item) => (
        <button
          key={item.id}
          disabled={busy || loading}
          onClick={() => navigate(() => void open(item.id))}
        >
          {item.reference} · {readable(item.sourceKind)} · {readable(item.state)}
        </button>
      ))}
      {loading ? <p role="status">Loading the authorized source receipt…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {detail ? (
        <ReceiptDetail
          key={`${detail.id}:${detail.revision}`}
          {...props}
          value={detail}
          onDirty={(value) => {
            setDirty(value);
            props.onDirty(value);
          }}
          onBusy={(value) => {
            setBusy(value);
            props.onBusy(value);
          }}
          onSaved={(value) => {
            setDetail(value);
            list.refresh();
          }}
        />
      ) : null}
    </section>
  );
}
function ReceiptDetail(
  props: CompanyPanelProps & {
    value: SourceReceiptDetail;
    mappings: MappingVersion[];
    customFields: Choice[];
    onSaved: (value: SourceReceiptDetail) => void;
    onOpenLead: (leadId: string) => void;
    onDownloadEvidence?: (input: InboundEvidenceDownload) => Promise<void>;
  },
) {
  const edit = useCompanyEdit(props),
    [downloading, setDownloading] = useState(false),
    [inspectMapping, setInspectMapping] = useState<{ id: string; version: number } | null>(null),
    [reason, setReason] = useState(""),
    [mapping, setMapping] = useState(`${props.value.mappingId}:${props.value.mappingVersion}`),
    navigation = useUnsavedNavigation(edit.dirty);
  async function download() {
    if (downloading || edit.busy || !props.onDownloadEvidence) return;
    setDownloading(true);
    props.onBusy(true);
    edit.setError("");
    try {
      await props.onDownloadEvidence({
        receiptId: props.value.id,
        sha256: props.value.original.sha256,
        bytes: props.value.original.bytes,
      });
    } catch (error) {
      edit.setError(
        error instanceof Error ? error.message : "The original evidence could not be downloaded.",
      );
    } finally {
      setDownloading(false);
      props.onBusy(false);
    }
  }
  async function act(kind: "retry" | "reprocess") {
    const selected = props.mappings.find((item) => `${item.id}:${item.version}` === mapping);
    if (kind === "reprocess" && !selected) return;
    const result = await edit.save<SourceReceiptDetail>(
      `/api/cpl-integrations/receipts/${props.value.id}/${kind}`,
      {
        expectedRevision: props.value.revision,
        reason,
        ...(kind === "reprocess"
          ? { mappingId: selected!.id, mappingVersion: selected!.version }
          : {}),
      },
    );
    if (result) props.onSaved(result);
  }
  return (
    <section className={styles.panel}>
      {navigation.dialog}
      <h3>{props.value.reference}</h3>
      <CompanyFeedback edit={edit} />
      <p>
        {readable(props.value.state)} · received {time(props.value.receivedAt)} · source hash{" "}
        <code>{props.value.contentSha256}</code>
      </p>
      {props.value.permissions.canReadEvidence ? (
        <>
          <h4>Original source claims</h4>
          {props.value.original.safeEvidenceAvailable && props.onDownloadEvidence ? (
            <button disabled={edit.busy || downloading} onClick={() => void download()}>
              Download original evidence
            </button>
          ) : null}
          <p>
            The download contains only the saved source response as an inert file. It is untrusted
            evidence, not a verified customer claim. It does not include attachment bytes, fetch
            remote content or open HTML.
          </p>
          <dl>
            {Object.entries(props.value.original.sourceClaims).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {props.value.original.plainText ??
              "No plain text is available. HTML and remote content are not rendered."}
          </pre>
          <h4>Attachment metadata</h4>
          <ul>
            {props.value.original.attachments.map((item, index) => (
              <li key={index}>
                {item.name} · {item.mediaType} · {item.bytes} bytes · {readable(item.status)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>Normalization history</h4>
      {props.value.normalizations.map((item) => (
        <section key={item.version}>
          <h5>
            Revision {item.version} · mapping {item.mappingVersion}
          </h5>
          <button
            type="button"
            disabled={edit.busy || downloading}
            onClick={() => setInspectMapping({ id: item.mappingId, version: item.mappingVersion })}
          >
            View mapping for normalization {item.version}
          </button>
          <dl>
            {Object.entries(item.fields).map(([name, value]) => (
              <div key={name}>
                <dt>{name === "customValues" ? "Custom answers" : name}</dt>
                <dd>
                  {typeof value === "object" && value !== null ? (
                    Object.keys(value).length ? (
                      <dl aria-label="Saved custom answers">
                        {Object.entries(value).map(([fieldId, answer]) => {
                          const currentField = props.customFields.find(
                            (field) => field.id === fieldId,
                          );
                          return (
                            <div key={fieldId}>
                              <dt>
                                {currentField
                                  ? `${currentField.name} (current label) · `
                                  : "Field "}
                                <code>{fieldId}</code>
                              </dt>
                              <dd>{normalizationAnswer(answer)}</dd>
                            </div>
                          );
                        })}
                      </dl>
                    ) : (
                      "No custom answers recorded."
                    )
                  ) : (
                    normalizationAnswer(value)
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {item.issues.map((issue, index) => (
            <p key={index}>
              {issue.message} · {issue.code}
            </p>
          ))}
        </section>
      ))}
      <h4>Processing attempts</h4>
      {inspectMapping ? (
        <SavedIntakeMapping
          key={`${inspectMapping.id}:${inspectMapping.version}`}
          request={props.request}
          mappingId={inspectMapping.id}
          version={inspectMapping.version}
        />
      ) : null}
      <ol>
        {props.value.attempts.map((item) => (
          <li key={item.number}>
            {item.number} · {item.state} · {time(item.startedAt)}
            {item.issue ? ` · ${item.issue.code}` : ""}
          </li>
        ))}
      </ol>
      {props.value.linkedLeadId && props.value.permissions.canOpenLead ? (
        <button
          disabled={edit.busy || downloading}
          onClick={() =>
            navigation.navigate(() => {
              edit.change(false);
              props.onOpenLead(props.value.linkedLeadId!);
            })
          }
        >
          Open linked lead for human review
        </button>
      ) : null}
      <fieldset disabled={edit.busy || downloading} className={styles.fieldset}>
        <label className={styles.field}>
          Recovery reason
          <input
            value={reason}
            maxLength={2000}
            onChange={(event) => {
              setReason(event.target.value);
              edit.change();
            }}
          />
        </label>
        {props.value.permissions.canReprocess ? (
          <label className={styles.field}>
            Explicit mapping version
            <select
              value={mapping}
              onChange={(event) => {
                setMapping(event.target.value);
                edit.change();
              }}
            >
              {props.mappings
                .filter(
                  (item) =>
                    item.input.sourceKind ===
                    (props.value.sourceKind === "gmail" ? "gmail" : "form"),
                )
                .map((item) => (
                  <option key={`${item.id}:${item.version}`} value={`${item.id}:${item.version}`}>
                    {item.input.name} · version {item.version}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        {props.value.permissions.canRetry ? (
          <button disabled={!reason.trim()} onClick={() => void act("retry")}>
            Queue retry
          </button>
        ) : null}
        {props.value.permissions.canReprocess ? (
          <button disabled={!reason.trim()} onClick={() => void act("reprocess")}>
            Reprocess with selected mapping
          </button>
        ) : null}
        <p>
          Reprocessing retains the original source and prior normalization. It does not overwrite
          human lead edits or create a second linked lead.
        </p>
      </fieldset>
    </section>
  );
}
