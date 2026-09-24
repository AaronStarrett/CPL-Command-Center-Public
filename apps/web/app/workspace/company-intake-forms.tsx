"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  FormBuiltin,
  FormField,
  FormInput,
  InquiryForm,
  MappingInput,
  MappingRule,
  MappingVersion,
  PublicInquiryForm,
} from "@bea/domain/cpl-inbound";
import {
  CompanyFeedback,
  PageControls,
  useCompanyEdit,
  useCompanyPage,
  type CompanyPanelProps,
} from "./company-ui";
import { useUnsavedNavigation } from "./commercial-navigation";
import styles from "./workspace.module.css";

export const INQUIRY_TARGETS: { value: FormBuiltin; label: string }[] = [
  { value: "title", label: "Inquiry title" },
  { value: "contactName", label: "Contact name" },
  { value: "contactEmail", label: "Contact email" },
  { value: "contactPhone", label: "Contact phone" },
  { value: "customerName", label: "Customer name" },
  { value: "siteName", label: "Site name" },
  { value: "siteAddress", label: "Site address" },
  { value: "details", label: "Requested work" },
  { value: "requestedDeadlineAt", label: "Requested deadline" },
  { value: "requestedVisitAt", label: "Requested visit date" },
];
type Choice = { id: string; name: string };
type FormProps = CompanyPanelProps & {
  forms: InquiryForm[];
  total: number;
  mappings: MappingVersion[];
  services: Choice[];
  customFields: Choice[];
  canConfigure: boolean;
  onSaved: (form: InquiryForm) => void;
};
function emptyForm(): FormInput {
  return {
    name: "",
    title: "",
    description: "",
    fields: [
      {
        key: "title",
        target: { kind: "builtin", field: "title" },
        label: "Inquiry title",
        type: "text",
        required: true,
        maxLength: 240,
        options: [],
      },
      {
        key: "contact_name",
        target: { kind: "builtin", field: "contactName" },
        label: "Contact name",
        type: "text",
        required: false,
        maxLength: 240,
        options: [],
      },
      {
        key: "contact_email",
        target: { kind: "builtin", field: "contactEmail" },
        label: "Contact email",
        type: "email",
        required: true,
        maxLength: 254,
        options: [],
      },
      {
        key: "details",
        target: { kind: "builtin", field: "details" },
        label: "Requested work",
        type: "textarea",
        required: true,
        maxLength: 12000,
        options: [],
      },
    ],
    publishedServiceIds: [],
    confirmationText: "Your inquiry has been received for review.",
    mappingId: "",
    mappingVersion: 0,
  };
}
function targetValue(target: FormField["target"]) {
  return target.kind === "builtin" ? `builtin:${target.field}` : `custom:${target.fieldId}`;
}
function target(value: string): FormField["target"] {
  return value.startsWith("custom:")
    ? { kind: "custom", fieldId: value.slice(7) }
    : { kind: "builtin", field: value.slice(8) as FormBuiltin };
}
function Targets({ customFields }: { customFields: Choice[] }) {
  return (
    <>
      {INQUIRY_TARGETS.map((item) => (
        <option key={item.value} value={`builtin:${item.value}`}>
          {item.label}
        </option>
      ))}
      {customFields.map((item) => (
        <option key={item.id} value={`custom:${item.id}`}>
          {item.name} (company field)
        </option>
      ))}
    </>
  );
}
function answerTypes(value: FormField["target"]): FormField["type"][] {
  if (value.kind === "custom") return ["text", "textarea", "boolean", "choice"];
  if (value.field === "contactEmail") return ["email"];
  if (value.field === "requestedDeadlineAt" || value.field === "requestedVisitAt") return ["date"];
  return ["text", "textarea"];
}
function maximumCharacters(value: FormField["target"]) {
  if (value.kind === "custom") return 2000;
  return {
    title: 240,
    contactName: 240,
    contactEmail: 254,
    contactPhone: 80,
    customerName: 240,
    siteName: 240,
    siteAddress: 2000,
    details: 20000,
    requestedDeadlineAt: 10,
    requestedVisitAt: 10,
  }[value.field];
}

export function CompanyIntakeForms(props: FormProps) {
  const [selected, setSelected] = useState<InquiryForm | null>(null),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [epoch, setEpoch] = useState(0),
    navigation = useUnsavedNavigation(dirty);
  const list = useCompanyPage<InquiryForm>(props.request, "/api/cpl-integrations/forms");
  const forms = list.page?.items ?? props.forms;
  const { onDirty, onBusy } = props;
  const change = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirty(value);
    },
    [onDirty],
  );
  const work = useCallback(
    (value: boolean) => {
      setBusy(value);
      onBusy(value);
    },
    [onBusy],
  );
  function select(form: InquiryForm | null) {
    navigation.navigate(() => {
      setSelected(form);
      setDirty(false);
      props.onDirty(false);
      setEpoch((value) => value + 1);
    });
  }
  return (
    <section>
      {navigation.dialog}
      <h2>Inquiry forms</h2>
      <p>
        Publish only the questions and services customers should see. Submitted inquiries require
        human review before they become ready for a proposal.
      </p>
      <p>
        Showing {forms.length} of {list.page?.total ?? props.total} forms.
      </p>
      <PageControls
        list={list}
        disabled={busy}
        navigate={(action) =>
          navigation.navigate(() => {
            change(false);
            setSelected(null);
            setEpoch((value) => value + 1);
            action();
          })
        }
      />
      <div className={styles.actions}>
        {forms.map((form) => (
          <button key={form.id} disabled={busy || list.busy} onClick={() => select(form)}>
            {form.input.name} · {form.enabled ? "Published" : "Disabled"} · version{" "}
            {form.configurationVersion}
          </button>
        ))}
        {props.canConfigure ? (
          <button disabled={busy} onClick={() => select(null)}>
            New inquiry form
          </button>
        ) : null}
      </div>
      <InquiryFormEditor
        key={`${selected?.id ?? "new"}:${epoch}`}
        {...props}
        value={selected}
        onDirty={change}
        onBusy={work}
        onSaved={(form) => {
          setSelected(form);
          setEpoch((value) => value + 1);
          list.refresh();
          props.onSaved(form);
        }}
      />
    </section>
  );
}

function InquiryFormEditor(props: FormProps & { value: InquiryForm | null }) {
  const edit = useCompanyEdit(props),
    [input, setInput] = useState<FormInput>(props.value?.input ?? emptyForm()),
    [createdMapping, setCreatedMapping] = useState<MappingVersion | null>(null),
    [reason, setReason] = useState(""),
    [secret, setSecret] = useState<{
      form: InquiryForm;
      credential: { keyId: string; secret: string };
    } | null>(null),
    [preview, setPreview] = useState<PublicInquiryForm | null>(null),
    [previewBusy, setPreviewBusy] = useState(false),
    [reveal, setReveal] = useState(false);
  function change(patch: Partial<FormInput>) {
    setInput((current) => ({ ...current, ...patch }));
    edit.change();
  }
  const mappings = createdMapping
    ? [...props.mappings.filter((item) => item.id !== createdMapping.id), createdMapping]
    : props.mappings;
  const nextTarget: FormField["target"] | undefined = [
    ...INQUIRY_TARGETS.map((item) => ({ kind: "builtin", field: item.value }) as const),
    ...props.customFields.map((item) => ({ kind: "custom", fieldId: item.id }) as const),
  ].find((value) => !input.fields.some((item) => targetValue(item.target) === targetValue(value)));
  async function matchingMapping() {
    const mappingInput: MappingInput = {
      name: `${input.name || input.title || "Inquiry form"} questions`.slice(0, 160),
      sourceKind: "form",
      rules: input.fields.map((item) => ({
        source: { kind: "form_field", key: item.key },
        target: item.target,
        transform: item.type === "boolean" ? "none" : "trim",
      })),
    };
    const result = await edit.save<MappingVersion>("/api/cpl-integrations/mappings", {
      expectedVersion: 0,
      input: mappingInput,
    });
    if (result) {
      setCreatedMapping(result);
      change({ mappingId: result.id, mappingVersion: result.version });
    }
  }
  function field(key: string, patch: Partial<FormField>) {
    change({
      fields: input.fields.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await edit.save<InquiryForm>("/api/cpl-integrations/forms", {
      ...(props.value ? { formId: props.value.id } : {}),
      expectedRevision: props.value?.revision ?? 0,
      input,
    });
    if (result) props.onSaved(result);
  }
  async function action(kind: "state" | "credential" | "revoke-credential") {
    if (!props.value || (edit.dirty && !reason.trim())) return;
    if (kind === "credential") {
      const result = await edit.save<{
        form: InquiryForm;
        credential: { keyId: string; secret: string };
      }>(`/api/cpl-integrations/forms/${props.value.id}/credential`, {
        expectedRevision: props.value.revision,
        reason,
      });
      if (result) {
        setSecret(result);
        edit.change(true); /* Navigation requires explicit dismissal of a one-time secret. */
      }
      return;
    }
    const result = await edit.save<InquiryForm>(
      `/api/cpl-integrations/forms/${props.value.id}/${kind}`,
      {
        expectedRevision: props.value.revision,
        reason,
        ...(kind === "state" ? { enabled: !props.value.enabled } : {}),
      },
    );
    if (result) props.onSaved(result);
  }
  async function showPreview() {
    if (!props.value || previewBusy || edit.busy) return;
    setPreviewBusy(true);
    props.onBusy(true);
    edit.setError("");
    try {
      setPreview(
        await props.request<PublicInquiryForm>(
          `/api/cpl-integrations/forms/${props.value.id}/preview`,
        ),
      );
    } catch (e) {
      edit.setError(e instanceof Error ? e.message : "Saved form preview is unavailable.");
    } finally {
      setPreviewBusy(false);
      props.onBusy(false);
    }
  }
  return (
    <section className={styles.panel}>
      <CompanyFeedback edit={edit} />
      <form className={styles.form} onSubmit={(event) => void save(event)}>
        <fieldset
          disabled={!props.canConfigure || edit.busy || previewBusy || secret !== null}
          className={styles.fieldset}
        >
          <label className={styles.field}>
            Internal form name
            <input
              required
              maxLength={160}
              value={input.name}
              onChange={(event) => change({ name: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            Customer form title
            <input
              required
              maxLength={240}
              value={input.title}
              onChange={(event) => change({ title: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            Customer introduction
            <textarea
              maxLength={2000}
              value={input.description}
              onChange={(event) => change({ description: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            Mapping version
            <select
              required
              value={`${input.mappingId}:${input.mappingVersion}`}
              onChange={(event) => {
                const found = mappings.find(
                  (item) => `${item.id}:${item.version}` === event.target.value,
                );
                if (found) change({ mappingId: found.id, mappingVersion: found.version });
              }}
            >
              <option value=":0">Choose a saved form mapping</option>
              {mappings
                .filter((item) => item.input.sourceKind === "form")
                .map((item) => (
                  <option key={`${item.id}:${item.version}`} value={`${item.id}:${item.version}`}>
                    {item.input.name} · version {item.version}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void matchingMapping()}
            disabled={!input.fields.length}
          >
            Create matching form mapping
          </button>
          <p>
            The saved mapping must match these question keys and destinations. Create a matching
            mapping after changing questions, then save the form configuration.
          </p>
          <h3>Customer questions</h3>
          {input.fields.map((item, index) => (
            <section key={item.key} className={styles.panel}>
              <p>
                Question {index + 1} · stable source key <code>{item.key}</code>
              </p>
              <label className={styles.field}>
                Question label
                <input
                  required
                  maxLength={160}
                  value={item.label}
                  onChange={(event) => field(item.key, { label: event.target.value })}
                />
              </label>
              <label className={styles.field}>
                Intake destination
                <select
                  value={targetValue(item.target)}
                  onChange={(event) => {
                    const destination = target(event.target.value);
                    const type = answerTypes(destination)[0]!;
                    field(item.key, {
                      target: destination,
                      type,
                      maxLength: type === "date" ? null : maximumCharacters(destination),
                      options: [],
                    });
                  }}
                >
                  <Targets customFields={props.customFields} />
                </select>
              </label>
              <label className={styles.field}>
                Answer type
                <select
                  value={item.type}
                  onChange={(event) =>
                    field(item.key, {
                      type: event.target.value as FormField["type"],
                      options: event.target.value === "choice" ? item.options : [],
                      maxLength: ["boolean", "choice", "date"].includes(event.target.value)
                        ? null
                        : maximumCharacters(item.target),
                    })
                  }
                >
                  {answerTypes(item.target).map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              {item.type === "choice" ? (
                <label className={styles.field}>
                  Choices, one per line
                  <textarea
                    required
                    value={item.options.join("\n")}
                    onChange={(event) =>
                      field(item.key, { options: event.target.value.split("\n") })
                    }
                  />
                </label>
              ) : null}
              <label>
                <input
                  type="checkbox"
                  checked={item.required}
                  onChange={(event) => field(item.key, { required: event.target.checked })}
                />
                Required answer
              </label>
              <label className={styles.field}>
                Maximum characters
                <input
                  type="number"
                  min={1}
                  max={maximumCharacters(item.target)}
                  disabled={["boolean", "choice", "date"].includes(item.type)}
                  value={item.maxLength ?? ""}
                  onChange={(event) =>
                    field(item.key, {
                      maxLength: event.target.value ? Number(event.target.value) : null,
                    })
                  }
                />
              </label>
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => {
                    const fields = [...input.fields];
                    [fields[index - 1], fields[index]] = [fields[index]!, fields[index - 1]!];
                    change({ fields });
                  }}
                >
                  Move question up
                </button>
                <button
                  type="button"
                  onClick={() =>
                    change({ fields: input.fields.filter((row) => row.key !== item.key) })
                  }
                >
                  Remove question
                </button>
              </div>
            </section>
          ))}
          <button
            type="button"
            disabled={input.fields.length >= 30 || !nextTarget}
            onClick={() => {
              if (!nextTarget) return;
              const type = answerTypes(nextTarget)[0]!;
              change({
                fields: [
                  ...input.fields,
                  {
                    key:
                      nextTarget.kind === "builtin"
                        ? nextTarget.field.replace(
                            /[A-Z]/gu,
                            (letter) => `_${letter.toLowerCase()}`,
                          )
                        : `field_${crypto.randomUUID().replaceAll("-", "")}`,
                    target: nextTarget,
                    label:
                      nextTarget.kind === "builtin"
                        ? INQUIRY_TARGETS.find((item) => item.value === nextTarget.field)!.label
                        : props.customFields.find((item) => item.id === nextTarget.fieldId)!.name,
                    type,
                    required: false,
                    maxLength: type === "date" ? null : maximumCharacters(nextTarget),
                    options: [],
                  },
                ],
              });
            }}
          >
            Add customer question
          </button>
          <h3>Published services</h3>
          {props.canConfigure ? (
            <PublishedServicePicker
              request={props.request}
              selected={input.publishedServiceIds}
              initial={props.services}
              onChange={(publishedServiceIds) => change({ publishedServiceIds })}
            />
          ) : (
            <p>{input.publishedServiceIds.length} explicitly published services.</p>
          )}
          <label className={styles.field}>
            Receipt confirmation text
            <textarea
              required
              maxLength={1000}
              value={input.confirmationText}
              onChange={(event) => change({ confirmationText: event.target.value })}
            />
          </label>
          <button type="submit">Save form configuration</button>
        </fieldset>
      </form>
      {props.value ? (
        <section>
          <p>
            Saved configuration {props.value.configurationVersion} ·{" "}
            {props.value.enabled ? "Published" : "Disabled"}. Saving answers above does not submit a
            customer inquiry.
          </p>
          <button
            type="button"
            disabled={edit.busy || previewBusy}
            onClick={() => void showPreview()}
          >
            Preview saved customer form
          </button>
          {props.value.enabled ? (
            <a
              href={`/inquiry/${encodeURIComponent(props.value.publicId)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open saved public inquiry form
            </a>
          ) : null}
          {preview ? (
            <section className={styles.panel}>
              <h3>{preview.title}</h3>
              <p>{preview.description}</p>
              <p>Preview of saved version {preview.version}; unsaved edits above are excluded.</p>
              <ul>
                {preview.fields.map((item) => (
                  <li key={item.key}>
                    {item.label} · {item.type}
                    {item.required ? " · Required" : ""}
                    {item.options.length ? ` · ${item.options.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
              <p>
                Published services: {preview.services.map((item) => item.name).join(", ") || "None"}
              </p>
              <p>{preview.confirmationText}</p>
            </section>
          ) : null}
          <fieldset
            disabled={!props.canConfigure || edit.busy || previewBusy || secret !== null}
            className={styles.fieldset}
          >
            <label className={styles.field}>
              Lifecycle reason
              <input
                value={reason}
                maxLength={2000}
                onChange={(event) => {
                  setReason(event.target.value);
                  edit.change();
                }}
              />
            </label>
            <p>
              Publish or disable the saved version. Save form edits before using these controls.
              Rotating a source key invalidates the previous key.
            </p>
            <button
              type="button"
              disabled={
                !reason.trim() || JSON.stringify(input) !== JSON.stringify(props.value.input)
              }
              onClick={() => void action("state")}
            >
              {props.value.enabled ? "Disable form" : "Publish form"}
            </button>
            <button
              type="button"
              disabled={
                !reason.trim() || JSON.stringify(input) !== JSON.stringify(props.value.input)
              }
              onClick={() => void action("credential")}
            >
              Rotate signed source credential
            </button>
            <button
              type="button"
              disabled={
                !reason.trim() ||
                !props.value.signedSource.enabled ||
                JSON.stringify(input) !== JSON.stringify(props.value.input)
              }
              onClick={() => void action("revoke-credential")}
            >
              Revoke signed source credential
            </button>
          </fieldset>
        </section>
      ) : null}
      {secret ? (
        <section className={styles.panel}>
          <h3>One-time signed source credential</h3>
          <p>
            Store this in the authorized sender’s server secret store. It will not appear in the
            form URL, history or ordinary settings. Do not paste it into an inquiry.
          </p>
          <label className={styles.field}>
            Key ID
            <input readOnly value={secret.credential.keyId} />
          </label>
          <label className={styles.field}>
            Source secret
            <input
              readOnly
              type={reveal ? "text" : "password"}
              autoComplete="off"
              value={secret.credential.secret}
            />
          </label>
          <button type="button" onClick={() => setReveal((value) => !value)}>
            {reveal ? "Hide secret" : "Show secret for secure copying"}
          </button>
          <button
            type="button"
            onClick={() => {
              const form = secret.form;
              setSecret(null);
              setReveal(false);
              edit.change(false);
              props.onSaved(form);
            }}
          >
            I have stored it; hide credential
          </button>
        </section>
      ) : null}
    </section>
  );
}

function PublishedServicePicker({
  request,
  selected,
  initial,
  onChange,
}: {
  request: CompanyPanelProps["request"];
  selected: string[];
  initial: Choice[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState(""),
    [applied, setApplied] = useState("");
  const list = useCompanyPage<Choice>(request, "/api/cpl-company/catalog", {
    status: "active",
    ...(applied ? { q: applied } : {}),
  });
  return (
    <section>
      <label className={styles.field}>
        Find an active service
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <button
        type="button"
        onClick={() => {
          setApplied(query);
          list.first();
        }}
      >
        Search services
      </button>
      <p>{selected.length} selected. Selections are retained across service pages.</p>
      <p>{list.page?.total ?? 0} matching services.</p>
      <button type="button" disabled={list.busy || !list.cursor} onClick={list.first}>
        First service page
      </button>
      <button type="button" disabled={list.busy || !list.page?.nextCursor} onClick={list.next}>
        Next service page
      </button>
      {list.error ? <p role="alert">{list.error}</p> : null}
      {(list.page?.items ?? initial).map((service) => (
        <label key={service.id}>
          <input
            type="checkbox"
            checked={selected.includes(service.id)}
            disabled={!selected.includes(service.id) && selected.length >= 30}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, service.id]
                  : selected.filter((id) => id !== service.id),
              )
            }
          />
          {service.name}
        </label>
      ))}
      {selected.length ? (
        <button type="button" onClick={() => onChange([])}>
          Clear published service selection
        </button>
      ) : null}
    </section>
  );
}

/** Inspection reads one immutable mapping version; it never updates configuration. */
export function SavedIntakeMapping({
  request,
  mappingId,
  version,
}: {
  request: CompanyPanelProps["request"];
  mappingId: string;
  version: number;
}) {
  const [value, setValue] = useState<MappingVersion | null>(null),
    [error, setError] = useState("");
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  }, [request]);
  useEffect(() => {
    let active = true;
    void requestRef
      .current<MappingVersion>(
        `/api/cpl-integrations/mappings/${encodeURIComponent(mappingId)}?version=${version}`,
      )
      .then((result) => {
        if (result.id !== mappingId || result.version !== version)
          throw new Error("The requested saved mapping version could not be verified.");
        if (active) {
          setValue(result);
          setError("");
        }
      })
      .catch((caught) => {
        if (active)
          setError(caught instanceof Error ? caught.message : "Saved mapping version unavailable.");
      });
    return () => {
      active = false;
    };
  }, [mappingId, version]);
  return (
    <section aria-label="Saved mapping version">
      {error ? (
        <p role="alert">{error}</p>
      ) : value && value.id === mappingId && value.version === version ? (
        <>
          <h3>
            {value.input.name} · saved version {value.version}
          </h3>
          <p>
            Read only · {value.input.sourceKind === "gmail" ? "Gmail message" : "Inquiry form"} ·{" "}
            {new Date(value.createdAt).toLocaleString()}
          </p>
          <ol>
            {value.input.rules.map((rule, index) => (
              <li key={index}>
                {rule.source.kind === "form_field"
                  ? rule.source.key
                  : rule.source.kind === "gmail"
                    ? rule.source.field
                    : rule.source.value}
                {" → "}
                {rule.target.kind === "builtin" ? rule.target.field : "Saved company custom field"}
                {" · "}
                {rule.transform.replaceAll("_", " ")}
              </li>
            ))}
          </ol>
          <p>Viewing this version does not change a form, connection, receipt or lead.</p>
        </>
      ) : (
        <p role="status">Loading the exact saved mapping version…</p>
      )}
    </section>
  );
}

export function IntakeMappingHistory({
  request,
  mapping,
}: {
  request: CompanyPanelProps["request"];
  mapping: MappingVersion;
}) {
  const [choice, setChoice] = useState(String(mapping.version)),
    [version, setVersion] = useState(mapping.version);
  return (
    <section className={styles.panel}>
      <h3>Inspect saved mapping history</h3>
      <label className={styles.field}>
        Saved version number
        <input
          type="number"
          min={1}
          max={mapping.version}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!/^[1-9][0-9]*$/u.test(choice) || Number(choice) > mapping.version}
        onClick={() => setVersion(Number(choice))}
      >
        View saved mapping version
      </button>
      <SavedIntakeMapping
        key={`${mapping.id}:${version}`}
        request={request}
        mappingId={mapping.id}
        version={version}
      />
    </section>
  );
}

export function IntakeMappingEditor(
  props: CompanyPanelProps & {
    value: MappingVersion | null;
    customFields: Choice[];
    canConfigure: boolean;
    onSaved: (mapping: MappingVersion) => void;
  },
) {
  const edit = useCompanyEdit(props),
    [sample, setSample] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState<{
      fields: Record<string, unknown>;
      issues: { code: string; message: string }[];
    } | null>(null),
    [previewBusy, setPreviewBusy] = useState(false),
    [input, setInput] = useState<MappingInput>(
      props.value?.input ?? {
        name: "",
        sourceKind: "form",
        rules: ["title", "contactName", "contactEmail", "details"].map((field) => ({
          source: {
            kind: "form_field",
            key: field.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
          },
          target: { kind: "builtin", field: field as FormBuiltin },
          transform: "trim",
        })),
      },
    );
  function change(patch: Partial<MappingInput>) {
    setInput((current) => ({ ...current, ...patch }));
    edit.change();
  }
  function rule(index: number, patch: Partial<MappingRule>) {
    change({ rules: input.rules.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await edit.save<MappingVersion>("/api/cpl-integrations/mappings", {
      ...(props.value ? { mappingId: props.value.id } : {}),
      expectedVersion: props.value?.version ?? 0,
      input,
    });
    if (result) props.onSaved(result);
  }
  async function previewMapping() {
    if (previewBusy || edit.busy) return;
    setPreviewBusy(true);
    props.onBusy(true);
    edit.setError("");
    try {
      setPreview(await props.request("/api/cpl-integrations/mappings/preview", { input, sample }));
    } catch (e) {
      edit.setError(e instanceof Error ? e.message : "Mapping preview is unavailable.");
    } finally {
      setPreviewBusy(false);
      props.onBusy(false);
    }
  }
  return (
    <form className={styles.form} onSubmit={(event) => void save(event)}>
      <h2>Intake mapping</h2>
      <p>
        Mappings copy supported source fields into a non-ready lead. They do not infer facts or
        overwrite human-reviewed lead edits.
      </p>
      <CompanyFeedback edit={edit} />
      <fieldset
        disabled={!props.canConfigure || edit.busy || previewBusy}
        className={styles.fieldset}
      >
        <label className={styles.field}>
          Mapping name
          <input
            required
            maxLength={160}
            value={input.name}
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          Source type
          <select
            value={input.sourceKind}
            disabled={Boolean(props.value)}
            onChange={(event) =>
              change({ sourceKind: event.target.value as MappingInput["sourceKind"], rules: [] })
            }
          >
            <option value="form">Inquiry form</option>
            <option value="gmail">Gmail message</option>
          </select>
        </label>
        {input.rules.map((item, index) => (
          <section key={index} className={styles.panel}>
            {item.source.kind === "form_field" ? (
              <label className={styles.field}>
                Stable form question key
                <input
                  required
                  value={item.source.key}
                  onChange={(event) =>
                    rule(index, { source: { kind: "form_field", key: event.target.value } })
                  }
                />
              </label>
            ) : item.source.kind === "gmail" ? (
              <label className={styles.field}>
                Message field
                <select
                  value={item.source.field}
                  onChange={(event) =>
                    rule(index, {
                      source: {
                        kind: "gmail",
                        field: event.target.value as
                          "subject" | "senderNameClaim" | "senderEmailClaim" | "plainText",
                      },
                    })
                  }
                >
                  <option value="subject">Subject</option>
                  <option value="senderNameClaim">Sender name claim</option>
                  <option value="senderEmailClaim">Sender email claim</option>
                  <option value="plainText">Plain message text</option>
                </select>
              </label>
            ) : (
              <label className={styles.field}>
                Literal value
                <input
                  value={item.source.value}
                  onChange={(event) =>
                    rule(index, { source: { kind: "literal", value: event.target.value } })
                  }
                />
              </label>
            )}
            <label className={styles.field}>
              Destination
              <select
                value={targetValue(item.target)}
                onChange={(event) => rule(index, { target: target(event.target.value) })}
              >
                <Targets customFields={props.customFields} />
              </select>
            </label>
            <label className={styles.field}>
              Text normalization
              <select
                value={item.transform}
                onChange={(event) =>
                  rule(index, { transform: event.target.value as MappingRule["transform"] })
                }
              >
                <option value="none">Keep source text</option>
                <option value="trim">Trim surrounding whitespace</option>
                <option value="collapse_whitespace">Collapse whitespace</option>
                <option value="lowercase_email">Normalize email letter case</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => change({ rules: input.rules.filter((_, i) => i !== index) })}
            >
              Remove mapping rule
            </button>
          </section>
        ))}
        <button
          type="button"
          disabled={input.rules.length >= 30}
          onClick={() =>
            change({
              rules: [
                ...input.rules,
                {
                  source:
                    input.sourceKind === "form"
                      ? { kind: "form_field", key: "" }
                      : { kind: "gmail", field: "subject" },
                  target: { kind: "builtin", field: "title" },
                  transform: "trim",
                },
              ],
            })
          }
        >
          Add mapping rule
        </button>
        <button>Save mapping version</button>
        <h3>Preview with a fictional sample</h3>
        <p>This preview does not create an inquiry, lead or provider call.</p>
        {[
          ...new Set(
            input.rules
              .flatMap((item) =>
                item.source.kind === "form_field"
                  ? [item.source.key]
                  : item.source.kind === "gmail"
                    ? [item.source.field]
                    : [],
              )
              .filter(Boolean),
          ),
        ].map((key) => (
          <label className={styles.field} key={key}>
            Sample {key}
            <textarea
              maxLength={20000}
              value={sample[key] ?? ""}
              onChange={(event) => {
                setSample((current) => ({ ...current, [key]: event.target.value }));
                edit.change();
              }}
            />
          </label>
        ))}
        <button type="button" onClick={() => void previewMapping()}>
          Preview mapping
        </button>
        {preview ? (
          <section aria-label="Mapping preview">
            <dl>
              {Object.entries(preview.fields).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value == null ? "Not supplied" : String(value)}</dd>
                </div>
              ))}
            </dl>
            {preview.issues.map((issue, index) => (
              <p key={index}>
                {issue.message} · {issue.code}
              </p>
            ))}
          </section>
        ) : null}
      </fieldset>
    </form>
  );
}
