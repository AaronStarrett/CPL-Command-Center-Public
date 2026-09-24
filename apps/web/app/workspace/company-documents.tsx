"use client";
import { useEffect, useRef, useState } from "react";
import type {
  CplCompanyConfiguration,
  CplCompanyTemplate,
  CplCompanyTemplateKind,
} from "@bea/domain/cpl-company";
import type { CplCommercialTemplate } from "@bea/domain/cpl-commercial";
import type { CplFieldTemplateVersion } from "@bea/domain/cpl-field";
import type { CplReportTemplateVersion } from "@bea/domain/cpl-report";
import type { CplCloseoutPolicy } from "@bea/domain/cpl-delivery";
import { BrandingSettings, TemplateSettings } from "./commercial-config";
import { ReportBranding, ReportTemplates } from "./report-settings";
import { FieldTemplates } from "./field-templates";
import { CompanyReadinessPolicy } from "./delivery-settings";
import {
  CompanyFeedback,
  PageControls,
  useCompanyEdit,
  useCompanyPage,
  type CompanyPanelProps,
} from "./company-ui";
import { useUnsavedNavigation } from "./commercial-navigation";
import styles from "./workspace.module.css";
export function CompanyDocuments(props: CompanyPanelProps) {
  const edit = useCompanyEdit(props),
    navigation = useUnsavedNavigation(edit.dirty),
    [config, setConfig] = useState<CplCompanyConfiguration | null>(null),
    [area, setArea] = useState("proposal-branding"),
    [epoch, setEpoch] = useState(0),
    [loadedEpoch, setLoadedEpoch] = useState(0),
    [childBusy, setChildBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef(props.request);
  useEffect(() => {
    request.current = props.request;
  }, [props.request]);
  useEffect(() => {
    let active = true;
    void request
      .current<CplCompanyConfiguration>("/api/cpl-company/configuration")
      .then((value) => {
        if (active) {
          setConfig(value);
          setLoadedEpoch(epoch);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Configuration unavailable.");
      });
    return () => {
      active = false;
    };
  }, [epoch]);
  async function save(path: string, input: Record<string, unknown>) {
    const value = await edit.save(path, input, path !== "/api/cpl-commercial/branding");
    if (value) {
      setEpoch((n) => n + 1);
      return true;
    }
    return false;
  }
  const sections = config
    ? [
        ...(config.modules.proposal ? ["proposal-branding", "proposal-templates"] : []),
        ...(config.modules.field ? ["field-templates"] : []),
        ...(config.modules.report ? ["report-branding", "report-templates"] : []),
        ...(config.modules.delivery ? ["readiness"] : []),
      ]
    : [];
  return (
    <section>
      {navigation.dialog}
      <h2>Documents &amp; readiness</h2>
      <p>
        Configure the existing product templates and branding without a dummy project. Current setup
        changes do not rewrite frozen historical documents.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <CompanyFeedback edit={edit} />
      <div className={styles.tabs}>
        {sections.map((section) => (
          <button
            disabled={edit.busy || childBusy || loadedEpoch !== epoch}
            key={section}
            aria-current={area === section ? "page" : undefined}
            onClick={() =>
              navigation.navigate(() => {
                edit.change(false);
                setArea(section);
              })
            }
          >
            {section.replaceAll("-", " ")}
          </button>
        ))}
      </div>
      {config && area === "proposal-branding" && config.commercialBranding ? (
        <BrandingSettings
          key={`${config.commercialBranding.revision}:${loadedEpoch}`}
          value={config.commercialBranding}
          allowed
          busy={edit.busy || loadedEpoch !== epoch}
          onDirty={edit.change}
          onSave={(input, expectedRevision) =>
            save("/api/cpl-commercial/branding", { input, expectedRevision })
          }
        />
      ) : null}
      {config && area === "report-branding" && config.modules.report ? (
        <ReportBranding
          key={`${config.reportBranding?.revision ?? 0}:${loadedEpoch}`}
          value={config.reportBranding}
          allowed
          busy={edit.busy || loadedEpoch !== epoch}
          onDirty={edit.change}
          onSave={(input, expectedRevision) =>
            save("/api/cpl-reports/branding", { input, expectedRevision })
          }
        />
      ) : null}
      {config && area.endsWith("-templates") && sections.includes(area) ? (
        <CompanyTemplatePage
          key={`${area}:${epoch}`}
          {...props}
          onDirty={edit.change}
          onBusy={(value) => {
            setChildBusy(value);
            props.onBusy(value);
          }}
          kind={area.split("-")[0] as CplCompanyTemplateKind}
          defaultCurrency={config.commercialBranding?.defaultCurrency ?? "USD"}
        />
      ) : null}
      {config && area === "readiness" && config.modules.delivery ? (
        <CompanyPolicyPage
          key={epoch}
          {...props}
          onDirty={edit.change}
          onBusy={(value) => {
            setChildBusy(value);
            props.onBusy(value);
          }}
        />
      ) : null}
      {config && !sections.length ? (
        <p>
          No document modules are enabled for this company. Only a platform administrator can change
          entitlement configuration.
        </p>
      ) : null}
    </section>
  );
}
function CompanyTemplatePage(
  props: CompanyPanelProps & { kind: CplCompanyTemplateKind; defaultCurrency: string },
) {
  const edit = useCompanyEdit(props),
    navigation = useUnsavedNavigation(edit.dirty),
    [q, setQ] = useState(""),
    [query, setQuery] = useState(""),
    [epoch, setEpoch] = useState(0),
    list = useCompanyPage<CplCompanyTemplate>(
      props.request,
      `/api/cpl-company/templates/${props.kind}`,
      { q },
    );
  function navigate(fn: () => void) {
    navigation.navigate(() => {
      edit.change(false);
      setEpoch((n) => n + 1);
      fn();
    });
  }
  async function save(
    input: unknown,
    prior?: { templateId: string; expectedVersion: number } | null,
  ) {
    const result = await edit.save(
      `/api/cpl-${props.kind === "proposal" ? "commercial" : props.kind === "field" ? "field" : "reports"}/templates`,
      props.kind === "proposal" ? { input } : { input, ...(prior ?? { expectedVersion: 0 }) },
    );
    if (result) {
      list.refresh();
      setEpoch((n) => n + 1);
      return true;
    }
    return false;
  }
  return (
    <section>
      {navigation.dialog}
      <CompanyFeedback edit={edit} />
      <form
        className={styles.actions}
        onSubmit={(event) => {
          event.preventDefault();
          navigate(() => {
            list.first();
            setQ(query);
          });
        }}
      >
        <label>
          Find template
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button>Find template</button>
      </form>
      <PageControls list={list} disabled={edit.busy} navigate={navigate} />
      {props.kind === "proposal" ? (
        <TemplateSettings
          defaultCurrency={props.defaultCurrency}
          key={epoch}
          templates={(list.page?.items ?? []) as CplCommercialTemplate[]}
          allowed
          busy={edit.busy}
          onDirty={edit.change}
          onSave={(input) => save(input)}
        />
      ) : props.kind === "field" ? (
        <FieldTemplates
          key={epoch}
          templates={(list.page?.items ?? []) as CplFieldTemplateVersion[]}
          allowed
          busy={edit.busy}
          onDirty={edit.change}
          onSave={save}
        />
      ) : (
        <ReportTemplates
          key={epoch}
          templates={(list.page?.items ?? []) as CplReportTemplateVersion[]}
          allowed
          busy={edit.busy}
          onDirty={edit.change}
          onSave={save}
        />
      )}
    </section>
  );
}
function CompanyPolicyPage(props: CompanyPanelProps) {
  const edit = useCompanyEdit(props),
    navigation = useUnsavedNavigation(edit.dirty),
    [query, setQuery] = useState(""),
    [q, setQ] = useState(""),
    [epoch, setEpoch] = useState(0),
    list = useCompanyPage<CplCloseoutPolicy>(props.request, "/api/cpl-company/policies", { q });
  return (
    <section>
      {navigation.dialog}
      <CompanyFeedback edit={edit} />
      <form
        className={styles.actions}
        onSubmit={(event) => {
          event.preventDefault();
          navigation.navigate(() => {
            edit.change(false);
            setEpoch((n) => n + 1);
            list.first();
            setQ(query);
          });
        }}
      >
        <label>
          Find readiness policy
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button>Find policy</button>
      </form>
      <PageControls
        list={list}
        disabled={edit.busy}
        navigate={(fn) =>
          navigation.navigate(() => {
            edit.change(false);
            setEpoch((n) => n + 1);
            fn();
          })
        }
      />
      <CompanyReadinessPolicy
        key={epoch}
        policies={list.page?.items ?? []}
        allowed
        busy={edit.busy}
        onDirty={edit.change}
        onSave={async (input, expectedVersion) => {
          const result = await edit.save("/api/cpl-company/policies", { input, expectedVersion });
          if (result) list.refresh();
          return !!result;
        }}
      />
    </section>
  );
}
