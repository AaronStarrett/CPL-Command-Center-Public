"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { CplAdminBootstrap } from "@bea/domain/cpl-admin";
import {
  CPL_INTAKE_OPTIONAL_REQUIREMENTS,
  type CplCompanyWorkspace,
  type CplCompanySetting,
  type CplCompanyProfile,
  type CplIntakePolicy,
  type CplIntakeCustomField,
  type CplCompanyAuditEvent,
} from "@bea/domain/cpl-company";
import { TeamAdministration } from "./administration-workspace";
import { CompanyDocuments } from "./company-documents";
import { CompanyCatalog, CompanyDirectory, CompanyAudit } from "./company-records";
import { CompanyIntegrations, type IntegrationNavigationTarget } from "./company-integrations";
import type { InboundEvidenceDownload } from "./integration-evidence-download";
import { CompanyFeedback, useCompanyEdit, type CompanyPanelProps } from "./company-ui";
import { useUnsavedNavigation } from "./commercial-navigation";
import styles from "./workspace.module.css";
type Area =
  | "profile"
  | "team"
  | "catalog"
  | "intake-policy"
  | "documents"
  | "directory"
  | "audit"
  | "integrations";
export function CompanyWorkspace(
  props: CompanyPanelProps & {
    bootstrap: CplAdminBootstrap;
    onChanged: () => Promise<void>;
    onOpenRecipes?: () => void;
    onOpenLead?: (leadId: string) => void;
    onDownloadEvidence?: (input: InboundEvidenceDownload) => Promise<void>;
    initialIntegrationTarget?: IntegrationNavigationTarget;
    onAuthorizeIntegration?: (
      connection: import("@bea/domain/cpl-integrations").IntegrationConnection,
    ) => Promise<void>;
  },
) {
  const { onDirty, onBusy } = props;
  const [area, setArea] = useState<Area>(
      props.initialIntegrationTarget && props.bootstrap.permissions.canReadIntegrations
        ? "integrations"
        : props.bootstrap.permissions.canConfigureCompany
          ? "profile"
          : props.bootstrap.permissions.canReadIntegrations
            ? "integrations"
            : "directory",
    ),
    [data, setData] = useState<CplCompanyWorkspace | null>(null),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [epoch, setEpoch] = useState(0),
    [loadedEpoch, setLoadedEpoch] = useState(0),
    [notice, setNotice] = useState(""),
    [auditTarget, setAuditTarget] = useState<CplCompanyAuditEvent | null>(null),
    navigation = useUnsavedNavigation(dirty),
    request = useRef(props.request);
  useEffect(() => {
    request.current = props.request;
  }, [props.request]);
  const change = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirty(value);
    },
    [onDirty],
  );
  const busyChange = useCallback(
    (value: boolean) => {
      setBusy(value);
      onBusy(value);
    },
    [onBusy],
  );
  const allowed = props.bootstrap.permissions;
  useEffect(() => {
    if (!allowed.canConfigureCompany) return;
    let active = true;
    void request
      .current<CplCompanyWorkspace>("/api/cpl-company/workspace")
      .then((value) => {
        if (active) {
          setData(value);
          setLoadedEpoch(epoch);
          setError("");
          if (epoch) setNotice("Saved company configuration is up to date.");
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Company configuration unavailable.");
      });
    return () => {
      active = false;
    };
  }, [allowed.canConfigureCompany, epoch]);
  const tabs: Area[] = [
    ...(allowed.canConfigureCompany
      ? (["profile", "catalog", "intake-policy", "documents"] as const)
      : []),
    ...(allowed.canManageMembers ? (["team"] as const) : []),
    ...(allowed.canReadDirectory ? (["directory"] as const) : []),
    ...(allowed.canReadAudit ? (["audit"] as const) : []),
    ...(allowed.canReadIntegrations ? (["integrations"] as const) : []),
  ];
  const shared = { request: props.request, onDirty: change, onBusy: busyChange };
  function navigate(next: Area) {
    navigation.navigate(() => {
      change(false);
      setArea(next);
      setAuditTarget(null);
      setEpoch((n) => n + 1);
    });
  }
  async function changed() {
    setNotice("Saved company configuration. Refreshing the persisted version…");
    setEpoch((n) => n + 1);
    await props.onChanged();
  }
  return (
    <section>
      {navigation.dialog}
      <nav className={styles.tabs} aria-label="Company settings sections">
        {tabs.map((value) => (
          <button
            disabled={busy}
            key={value}
            aria-current={area === value ? "page" : undefined}
            onClick={() => navigate(value)}
          >
            {
              (
                {
                  profile: "Setup & profile",
                  team: "Team & invitations",
                  catalog: "Service catalog",
                  "intake-policy": "Intake rules",
                  documents: "Documents & readiness",
                  directory: "Directory",
                  audit: "Activity",
                  integrations: "Integrations & intake",
                } as const
              )[value]
            }
          </button>
        ))}
      </nav>
      {allowed.canConfigureCompany && props.onOpenRecipes ? (
        <button
          disabled={busy}
          onClick={() =>
            navigation.navigate(() => {
              change(false);
              props.onOpenRecipes?.();
            })
          }
        >
          Configure workflow recipes in Action Center
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!tabs.length ? (
        <p>
          Your role has no company administration access. Contact a company owner or administrator.
        </p>
      ) : null}
      {auditTarget ? (
        <p role="status">
          Related {auditTarget.target?.kind} · {auditTarget.target?.id ?? "company setting"}. Use
          the record’s current revision; this activity entry remains historical.
        </p>
      ) : null}
      {area === "profile" && data ? (
        <>
          <SetupSummary data={data} onSection={navigate} />
          <CompanyProfile
            key={`${data.profile.version}:${loadedEpoch}`}
            {...shared}
            value={data.profile}
            refreshing={loadedEpoch !== epoch}
            onSaved={changed}
          />
        </>
      ) : null}
      {area === "team" && allowed.canManageMembers ? (
        <TeamAdministration
          key={epoch}
          {...shared}
          bootstrap={props.bootstrap}
          onChanged={props.onChanged}
        />
      ) : null}
      {area === "catalog" && data ? (
        <CompanyCatalog
          key={epoch}
          {...shared}
          allowed={data.permissions.canConfigure}
          defaultCurrency={data.defaultCurrency}
          initialId={
            auditTarget?.target?.kind === "catalog"
              ? (auditTarget.target.id ?? undefined)
              : undefined
          }
        />
      ) : null}
      {area === "intake-policy" && data ? (
        <IntakePolicy
          key={`${data.intakePolicy.version}:${loadedEpoch}`}
          {...shared}
          value={data.intakePolicy}
          refreshing={loadedEpoch !== epoch}
          onSaved={changed}
        />
      ) : null}
      {area === "documents" && allowed.canConfigureCompany ? (
        <CompanyDocuments key={epoch} {...shared} />
      ) : null}
      {area === "integrations" && allowed.canReadIntegrations ? (
        <CompanyIntegrations
          key={epoch}
          {...shared}
          authorityKey={`${props.bootstrap.identity.id}:${props.bootstrap.selectedOrganizationId}:${props.bootstrap.membership?.version}`}
          services={[]}
          onDownloadEvidence={props.onDownloadEvidence}
          initialTarget={props.initialIntegrationTarget}
          customFields={
            data?.intakePolicy.input.customFields
              .filter((field) => field.active)
              .map((field) => ({ id: field.id, name: field.label })) ?? []
          }
          onOpenLead={(id) =>
            navigation.navigate(() => {
              change(false);
              props.onOpenLead?.(id);
            })
          }
          onAuthorize={async (connection) => {
            if (!props.onAuthorizeIntegration)
              throw new Error("Integration authorization is unavailable.");
            await props.onAuthorizeIntegration(connection);
          }}
        />
      ) : null}
      {area === "directory" && allowed.canReadDirectory ? (
        <CompanyDirectory
          key={epoch}
          {...shared}
          allowed={data?.permissions.canWriteDirectory ?? allowed.canWriteDirectory}
          initialTarget={
            auditTarget?.target?.id &&
            ["customer", "contact", "site"].includes(auditTarget.target.kind)
              ? {
                  id: auditTarget.target.id,
                  kind: auditTarget.target.kind as "customer" | "contact" | "site",
                }
              : undefined
          }
        />
      ) : null}
      {area === "audit" && allowed.canReadAudit ? (
        <CompanyAudit
          request={props.request}
          onTarget={(event) => {
            const kind = event.target?.kind;
            const next: Area =
              kind === "catalog"
                ? "catalog"
                : kind === "profile"
                  ? "profile"
                  : kind === "intake-policy"
                    ? "intake-policy"
                    : "directory";
            navigation.navigate(() => {
              change(false);
              setArea(next);
              setAuditTarget(event);
              setEpoch((n) => n + 1);
            });
          }}
        />
      ) : null}
    </section>
  );
}
function SetupSummary({
  data,
  onSection,
}: {
  data: CplCompanyWorkspace;
  onSection: (area: Area) => void;
}) {
  return (
    <section className={styles.panel}>
      <h2>Saved company setup</h2>
      <p>
        These checks reflect persisted configuration. Saving settings is separate from approving or
        delivering customer work.
      </p>
      <p>
        Profile version {data.profile.version} · intake policy version {data.intakePolicy.version} ·
        default currency {data.defaultCurrency}
      </p>
      {"setup" in data &&
      data.setup &&
      typeof data.setup === "object" &&
      "checks" in data.setup &&
      Array.isArray(data.setup.checks) ? (
        <ul>
          {data.setup.checks.map(
            (item: { key: string; status: string; message: string; blocking: boolean }) => (
              <li key={item.key}>
                <strong>{item.status.replaceAll("_", " ")}</strong> · {item.message}
                {item.blocking ? " · Required" : ""}
              </li>
            ),
          )}
        </ul>
      ) : null}
      <ul>
        {data.readiness.map((item) => (
          <li key={item.code}>
            {item.message}{" "}
            <button
              onClick={() => onSection(item.section === "branding" ? "documents" : item.section)}
            >
              Open {item.section}
            </button>
          </li>
        ))}
      </ul>
      <p>
        Invitation delivery, AI providers and hosted deployment remain separate controlled actions.
        This local application does not send invitations.
      </p>
    </section>
  );
}
function CompanyProfile(
  props: CompanyPanelProps & {
    value: CplCompanySetting<CplCompanyProfile>;
    refreshing: boolean;
    onSaved: () => Promise<void>;
  },
) {
  const edit = useCompanyEdit(props);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      input = Object.fromEntries(
        ["displayName", "legalName", "email", "phone", "address", "timeZone"].map((key) => [
          key,
          String(form.get(key) || ""),
        ]),
      );
    if (
      await edit.save("/api/cpl-company/profile", { expectedVersion: props.value.version, input })
    )
      await props.onSaved();
  }
  return (
    <section className={styles.panel}>
      <h2>Company profile</h2>
      <CompanyFeedback edit={edit} />
      <form
        className={styles.form}
        onChange={() => edit.change()}
        onSubmit={(event) => void save(event)}
      >
        <fieldset disabled={edit.busy || props.refreshing} className={styles.fieldset}>
          {(["displayName", "legalName", "email", "phone", "address", "timeZone"] as const).map(
            (key) => (
              <label className={styles.field} key={key}>
                {
                  (
                    {
                      displayName: "Display name",
                      legalName: "Legal business name",
                      email: "Company email",
                      phone: "Company phone",
                      address: "Business address",
                      timeZone: "Company time zone",
                    } as const
                  )[key]
                }
                <input
                  name={key}
                  defaultValue={props.value.input[key]}
                  required={key === "displayName" || key === "timeZone"}
                  type={key === "email" ? "email" : "text"}
                  maxLength={key === "address" ? 2000 : 240}
                />
                {key === "timeZone" ? (
                  <small>Use an IANA zone, for example America/Indiana/Indianapolis.</small>
                ) : null}
              </label>
            ),
          )}
          <p>
            Currency and customer PDF identity are configured in Documents &amp; readiness. Existing
            approved versions retain their branding.
          </p>
          <button>Save company profile</button>
        </fieldset>
      </form>
    </section>
  );
}
function IntakePolicy(
  props: CompanyPanelProps & {
    value: CplCompanySetting<CplIntakePolicy>;
    refreshing: boolean;
    onSaved: () => Promise<void>;
  },
) {
  const edit = useCompanyEdit(props),
    [input, setInput] = useState(props.value.input);
  function change(next: CplIntakePolicy) {
    setInput(next);
    edit.change();
  }
  function field(id: string, patch: Partial<CplIntakeCustomField>) {
    change({
      ...input,
      customFields: input.customFields.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      await edit.save("/api/cpl-company/intake-policy", {
        expectedVersion: props.value.version,
        input,
      })
    )
      await props.onSaved();
  }
  return (
    <section className={styles.panel}>
      <h2>Intake requirements</h2>
      <p>
        Core title, contact method, requested service, scope, assignment and review requirements
        remain enforced. Add company requirements below. A changed policy must be reviewed before
        existing leads can advance.
      </p>
      <CompanyFeedback edit={edit} />
      <form className={styles.form} onSubmit={(event) => void save(event)}>
        <fieldset disabled={edit.busy || props.refreshing} className={styles.fieldset}>
          <h3>Additional required fields</h3>
          {CPL_INTAKE_OPTIONAL_REQUIREMENTS.map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={input.requiredFields.includes(key)}
                onChange={(event) =>
                  change({
                    ...input,
                    requiredFields: event.target.checked
                      ? [...input.requiredFields, key]
                      : input.requiredFields.filter((item) => item !== key),
                  })
                }
              />
              {
                {
                  contactEmail: "Contact email",
                  contactPhone: "Contact phone",
                  customerName: "Customer name",
                  siteName: "Site name",
                  siteAddress: "Site address",
                  requestedDeadlineAt: "Requested deadline",
                  requestedVisitAt: "Requested visit time",
                }[key]
              }
            </label>
          ))}
          <h3>Company custom fields</h3>
          {input.customFields.map((row) => (
            <section key={row.id} className={styles.panel}>
              <label className={styles.field}>
                Field label
                <input
                  value={row.label}
                  onChange={(event) => field(row.id, { label: event.target.value })}
                  required
                  maxLength={240}
                />
              </label>
              <label className={styles.field}>
                Field type
                <select
                  value={row.type}
                  onChange={(event) =>
                    field(row.id, {
                      type: event.target.value as CplIntakeCustomField["type"],
                      options: event.target.value === "choice" ? row.options : [],
                    })
                  }
                >
                  {["text", "boolean", "choice"].map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              {row.type === "choice" ? (
                <label className={styles.field}>
                  Choice options, one per line
                  <textarea
                    value={row.options.join("\n")}
                    onChange={(event) => field(row.id, { options: event.target.value.split("\n") })}
                    required
                  />
                </label>
              ) : null}
              <label>
                <input
                  type="checkbox"
                  checked={row.required}
                  onChange={(event) => field(row.id, { required: event.target.checked })}
                />
                Required answer
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={row.active}
                  onChange={(event) => field(row.id, { active: event.target.checked })}
                />
                Active for new answers
              </label>
              <p>Stable field ID: {row.id}. Deactivation retains previously saved values.</p>
            </section>
          ))}
          <button
            type="button"
            disabled={input.customFields.length >= 20}
            onClick={() =>
              change({
                ...input,
                customFields: [
                  ...input.customFields,
                  {
                    id: crypto.randomUUID(),
                    label: "",
                    type: "text",
                    required: false,
                    options: [],
                    active: true,
                  },
                ],
              })
            }
          >
            Add custom intake field
          </button>
          <button>Save intake policy version</button>
        </fieldset>
      </form>
    </section>
  );
}
