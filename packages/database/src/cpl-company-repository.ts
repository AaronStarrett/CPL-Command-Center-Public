import { createHash, randomUUID } from "node:crypto";
import { intakeId, intakeText } from "@bea/domain/cpl-intake";
import {
  cplCompanyRevision,
  normalizeCplCatalogInput,
  normalizeCplCompanyProfile,
  normalizeCplDirectoryInput,
  normalizeCplIntakePolicy,
  type CplCatalogItem,
  type CplCompanyAuditEvent,
  type CplCompanyAuditFilters,
  type CplCompanyListInput,
  type CplCompanyPage,
  type CplCompanyProfile,
  type CplCompanySetting,
  type CplCompanyStatus,
  type CplCompanyWorkspace,
  type CplDirectoryDetail,
  type CplDirectoryInput,
  type CplDirectoryKind,
  type CplIntakePolicy,
} from "@bea/domain/cpl-company";
import { CPL_EXECUTION_TIME_ZONE } from "@bea/domain/cpl-execution";
import {
  defaultCplCommercialBranding,
  type CplCommercialBranding,
} from "@bea/domain/cpl-commercial";
import type {
  CplCompanyConfiguration,
  CplCompanyTemplate,
  CplCompanyTemplateKind,
} from "@bea/domain/cpl-company";
import type { CplCloseoutPolicy } from "@bea/domain/cpl-delivery";
import type { CplReportBranding } from "@bea/domain/cpl-report";
import type { SqlExecutor } from "./adapter.js";
import {
  SqlCplTenantRepository,
  cplTenantRoleAllows,
  type CplTenantAccess,
  type CplTenantPermission,
  type CplTenantRequest,
} from "./tenant-repository.js";
import {
  auditCplCompany,
  companyIso,
  companyJson,
  directoryTables,
  mapCplCatalog,
  mapCplDirectory,
  readCplCatalog,
  readCplDirectory,
  readCplIntakePolicy,
  type CompanyRow as Row,
} from "./cpl-company-data.js";

export class CplCompanyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CplCompanyError";
  }
}
function fail(code: string): never {
  throw new CplCompanyError(code);
}
const id = (value: unknown) => intakeId(value) ?? fail("CPL_COMPANY_INVALID_INPUT");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const kindOf = (value: unknown): CplDirectoryKind =>
  ["customer", "contact", "site"].includes(String(value))
    ? (value as CplDirectoryKind)
    : fail("CPL_COMPANY_INVALID_INPUT");
type MutationInput = CplTenantRequest & { idempotencyKey: string };
type SettingInput = MutationInput & { expectedVersion: number; input: unknown };
type CatalogWrite = MutationInput & { itemId?: string; expectedRevision: number; input: unknown };
type DirectoryWrite = MutationInput & {
  kind: CplDirectoryKind;
  entryId?: string;
  expectedRevision: number;
  input: unknown;
};
function directoryInput(entry: CplDirectoryInput): CplDirectoryInput {
  const { name, customerId, email, phone, address } = entry;
  return { name, customerId, email, phone, address };
}
export class SqlCplCompanyRepository {
  constructor(private readonly tenants: SqlCplTenantRepository) {}
  private async modules(e: SqlExecutor, a: CplTenantAccess) {
    const rows = await e.query<Row>(
      "SELECT module_key FROM cpl_module_entitlements WHERE organization_id=$1 AND enabled=TRUE AND (usage_limit IS NULL OR usage_limit<>0) FOR SHARE",
      [a.organizationId],
    );
    const enabled = new Set(rows.rows.map((r) => String(r.module_key)));
    return {
      proposal: enabled.has("proposal-builder"),
      field: enabled.has("field-report-assembler") && enabled.has("award-to-project-launcher"),
      report: enabled.has("field-report-assembler") && enabled.has("award-to-project-launcher"),
      delivery: enabled.has("field-report-assembler") && enabled.has("award-to-project-launcher"),
    };
  }
  async readConfiguration(request: CplTenantRequest): Promise<CplCompanyConfiguration> {
    return this.run(request, "company:configure", false, async (e, a) => {
      const modules = await this.modules(e, a);
      const commercial = modules.proposal
        ? await e.query<Row>(
            "SELECT configuration,revision FROM cpl_commercial_branding WHERE organization_id=$1",
            [a.organizationId],
          )
        : null;
      const report = modules.report
        ? await e.query<Row>(
            "SELECT configuration,revision FROM cpl_report_branding WHERE organization_id=$1 ORDER BY revision DESC LIMIT 1",
            [a.organizationId],
          )
        : null;
      const policies = modules.delivery
        ? await e.query<Row>(
            "SELECT DISTINCT ON(service_key) * FROM cpl_closeout_policies WHERE organization_id=$1 ORDER BY service_key,version DESC LIMIT 201",
            [a.organizationId],
          )
        : null;
      // Never silently call a truncated policy set complete. The dedicated paged list remains available.
      const closeoutPolicies = (policies?.rows ?? []).slice(0, 200).map((r) => ({
        ...companyJson<CplCloseoutPolicy>(r.snapshot),
        version: Number(r.version),
        createdAt: companyIso(r.created_at),
        createdByIdentityId: String(r.created_by_identity_id),
      }));
      return {
        modules,
        commercialBranding: modules.proposal
          ? commercial?.rows[0]
            ? {
                ...companyJson<CplCommercialBranding>(commercial.rows[0].configuration),
                revision: Number(commercial.rows[0].revision),
              }
            : defaultCplCommercialBranding()
          : null,
        reportBranding: report?.rows[0]
          ? {
              ...companyJson<CplReportBranding>(report.rows[0].configuration),
              revision: Number(report.rows[0].revision),
            }
          : null,
        closeoutPolicies,
        closeoutPoliciesTruncated: (policies?.rows.length ?? 0) > 200,
      };
    });
  }
  async listTemplates(
    request: CplTenantRequest & CplCompanyListInput & { kind: CplCompanyTemplateKind },
  ): Promise<CplCompanyPage<CplCompanyTemplate>> {
    const kind = request.kind;
    if (!["proposal", "field", "report"].includes(kind)) fail("CPL_COMPANY_INVALID_INPUT");
    const q = intakeText(request.q ?? "", 120),
      needle = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    return this.run(request, "company:configure", false, async (e, a) => {
      if (!(await this.modules(e, a))[kind]) fail("CPL_MODULE_DISABLED");
      const table =
        kind === "proposal"
          ? "cpl_commercial_templates"
          : kind === "field"
            ? "cpl_field_templates"
            : "cpl_report_templates";
      const source =
        kind === "proposal"
          ? `SELECT * FROM ${table} WHERE organization_id=$1 AND name ILIKE $2`
          : `SELECT * FROM(SELECT DISTINCT ON(id) * FROM ${table} WHERE organization_id=$1 ORDER BY id,version DESC) latest WHERE snapshot->>'name' ILIKE $2`;
      return this.page(
        e,
        a,
        request,
        { kind: "template." + kind, q },
        source,
        [a.organizationId, needle],
        (r) => ({
          ...companyJson<CplCompanyTemplate>(r.snapshot),
          id: String(r.id),
          organizationId: a.organizationId,
          ...(kind === "proposal"
            ? {}
            : {
                version: Number(r.version),
                createdByIdentityId: String(r.created_by_identity_id),
              }),
          createdAt: companyIso(r.created_at),
        }),
      );
    });
  }
  async listPolicies(
    request: CplTenantRequest & CplCompanyListInput,
  ): Promise<CplCompanyPage<CplCloseoutPolicy>> {
    const q = intakeText(request.q ?? "", 120),
      needle = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    return this.run(request, "company:configure", false, async (e, a) => {
      if (!(await this.modules(e, a)).delivery) fail("CPL_MODULE_DISABLED");
      return this.page(
        e,
        a,
        request,
        { kind: "closeout-policy", q },
        "SELECT *,md5(service_key)::uuid AS id FROM(SELECT DISTINCT ON(service_key) * FROM cpl_closeout_policies WHERE organization_id=$1 ORDER BY service_key,version DESC) latest WHERE service_key ILIKE $2 OR snapshot->>'name' ILIKE $2",
        [a.organizationId, needle],
        (r) => ({
          ...companyJson<CplCloseoutPolicy>(r.snapshot),
          version: Number(r.version),
          createdAt: companyIso(r.created_at),
          createdByIdentityId: String(r.created_by_identity_id),
        }),
      );
    });
  }
  private run<T>(
    request: CplTenantRequest,
    permission: CplTenantPermission,
    write: boolean,
    operation: (e: SqlExecutor, a: CplTenantAccess) => Promise<T>,
  ): Promise<T> {
    return this.tenants.withOrganizationTransaction(request, permission, async (e, a) => {
      const protectedRows = await e.query<Row>(
        "SELECT count(*)=6 AND bool_and(relrowsecurity AND relforcerowsecurity) AS protected FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN('cpl_catalog_items','cpl_catalog_versions','cpl_directory_current','cpl_directory_versions','cpl_company_setting_versions','cpl_company_mutations')",
      );
      if (protectedRows.rows[0]?.protected !== true) fail("CPL_COMPANY_SCHEMA_UNSAFE");
      // Same lock as intake/review/proposal eligibility. Configuration cannot change mid-decision.
      if (write)
        await e.query("SELECT pg_advisory_xact_lock(hashtextextended($1,29))", [a.organizationId]);
      return operation(e, a);
    });
  }
  private async mutate<T>(
    e: SqlExecutor,
    a: CplTenantAccess,
    kind: string,
    key: string,
    input: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/u.test(key))
      fail("CPL_INVALID_IDEMPOTENCY_KEY");
    const requestHash = hash(input),
      prior = await e.query<Row>(
        "SELECT request_hash,result_json FROM cpl_company_mutations WHERE organization_id=$1 AND kind=$2 AND idempotency_key=$3",
        [a.organizationId, kind, key],
      );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) fail("CPL_IDEMPOTENCY_CONFLICT");
      return companyJson<T>(prior.rows[0].result_json);
    }
    const result = await operation();
    await e.query(
      "INSERT INTO cpl_company_mutations(organization_id,kind,idempotency_key,request_hash,result_json) VALUES($1,$2,$3,$4,$5::jsonb)",
      [a.organizationId, kind, key, requestHash, JSON.stringify(result)],
    );
    return result;
  }
  private async profile(
    e: SqlExecutor,
    a: CplTenantAccess,
  ): Promise<CplCompanySetting<CplCompanyProfile>> {
    const rows = await e.query<Row>(
      "SELECT value_json,version FROM cpl_organization_settings WHERE organization_id=$1 AND setting_key='company.profile'",
      [a.organizationId],
    );
    if (rows.rows[0])
      return {
        version: Number(rows.rows[0].version),
        input: normalizeCplCompanyProfile(companyJson(rows.rows[0].value_json)),
      };
    const org = await e.query<Row>("SELECT display_name FROM cpl_organizations WHERE id=$1", [
      a.organizationId,
    ]);
    return {
      version: 0,
      input: {
        displayName: String(org.rows[0]?.display_name ?? ""),
        legalName: "",
        email: "",
        phone: "",
        address: "",
        timeZone: CPL_EXECUTION_TIME_ZONE,
      },
    };
  }
  async readWorkspace(request: CplTenantRequest): Promise<CplCompanyWorkspace> {
    return this.run(request, "company:configure", false, async (e, a) => {
      const profile = await this.profile(e, a),
        policy = await readCplIntakePolicy(e, a.organizationId);
      const modules = await this.modules(e, a);
      const branding = modules.proposal
        ? await e.query<Row>(
            "SELECT configuration FROM cpl_commercial_branding WHERE organization_id=$1",
            [a.organizationId],
          )
        : { rows: [] };
      const config = branding.rows[0]
        ? companyJson<Record<string, unknown>>(branding.rows[0].configuration)
        : {};
      const catalog = await e.query<Row>(
        "SELECT count(*)::integer AS count FROM cpl_catalog_items WHERE organization_id=$1 AND status='active'",
        [a.organizationId],
      );
      const readiness: CplCompanyWorkspace["readiness"] = [];
      if (!profile.version)
        readiness.push({
          code: "profile.unsaved",
          message: "Review and save the company profile.",
          section: "profile",
          blocking: true,
        });
      if (!profile.input.email && !profile.input.phone)
        readiness.push({
          code: "profile.contact",
          message: "Add a company contact email or phone when available.",
          section: "profile",
          blocking: false,
        });
      if (!Number(catalog.rows[0]?.count))
        readiness.push({
          code: "catalog.empty",
          message:
            "No active catalogue services are configured; free-text intake remains available.",
          section: "catalog",
          blocking: false,
        });
      if (modules.proposal && !config.businessName)
        readiness.push({
          code: "branding.incomplete",
          message: "Configure proposal branding before submitting a proposal.",
          section: "branding",
          blocking: false,
        });
      return {
        organizationId: a.organizationId,
        profile,
        intakePolicy: policy,
        defaultCurrency: String(config.defaultCurrency ?? "USD"),
        readiness,
        setup: await this.setup(e, a, profile, modules, Boolean(config.businessName)),
        permissions: {
          canConfigure: cplTenantRoleAllows(a.role, "company:configure"),
          canReadDirectory: cplTenantRoleAllows(a.role, "directory:read"),
          canWriteDirectory: cplTenantRoleAllows(a.role, "directory:write"),
          canReadAudit: cplTenantRoleAllows(a.role, "audit:read"),
        },
      };
    });
  }
  private async setup(
    e: SqlExecutor,
    a: CplTenantAccess,
    profile: CplCompanySetting<CplCompanyProfile>,
    modules: Awaited<ReturnType<SqlCplCompanyRepository["modules"]>>,
    proposalBranding: boolean,
  ): Promise<CplCompanyWorkspace["setup"]> {
    const checks: CplCompanyWorkspace["setup"]["checks"] = [
      {
        key: "profile",
        status: profile.version ? "saved" : "missing",
        message: profile.version
          ? `Company profile version ${profile.version} is saved.`
          : "Save the company profile to finish basic setup.",
        blocking: !profile.version,
      },
    ];
    const team = await e.query<Row>(
      "SELECT (SELECT count(*)::integer FROM cpl_memberships m JOIN cpl_identities i ON i.id=m.identity_id WHERE m.organization_id=$1 AND m.status='active' AND i.status='active') AS active,(SELECT count(*)::integer FROM cpl_invitations WHERE organization_id=$1 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP) AS pending",
      [a.organizationId],
    );
    checks.push({
      key: "team",
      status: Number(team.rows[0]?.active) > 1 ? "configured" : "optional",
      message: `${Number(team.rows[0]?.active)} active members; ${Number(team.rows[0]?.pending)} pending invitations. Additional members are optional for an owner-operated company.`,
      blocking: false,
    });
    const count = async (table: string) =>
      Number(
        (
          await e.query<Row>(
            `SELECT count(*)::integer AS count FROM ${table} WHERE organization_id=$1`,
            [a.organizationId],
          )
        ).rows[0]?.count ?? 0,
      );
    const moduleCheck = async (key: string, enabled: boolean, table: string, message: string) => {
      const saved = enabled ? await count(table) : 0;
      checks.push({
        key,
        status: !enabled ? "disabled" : saved ? "configured" : "missing",
        message: !enabled
          ? `${message} module is disabled.`
          : saved
            ? `${saved} saved ${message.toLowerCase()} records.`
            : `No ${message.toLowerCase()} is configured yet.`,
        blocking: false,
      });
    };
    checks.push({
      key: "proposal-branding",
      status: !modules.proposal ? "disabled" : proposalBranding ? "configured" : "missing",
      message: !modules.proposal
        ? "Proposal module is disabled."
        : proposalBranding
          ? "Proposal branding is configured."
          : "Proposal branding is required before review.",
      blocking: false,
    });
    await moduleCheck(
      "proposal-templates",
      modules.proposal,
      "cpl_commercial_templates",
      "Proposal templates",
    );
    await moduleCheck("field-templates", modules.field, "cpl_field_templates", "Field templates");
    await moduleCheck(
      "report-templates",
      modules.report,
      "cpl_report_templates",
      "Report templates",
    );
    await moduleCheck("report-branding", modules.report, "cpl_report_branding", "Report branding");
    await moduleCheck(
      "closeout-policies",
      modules.delivery,
      "cpl_closeout_policies",
      "Closeout policies",
    );
    const automation = await e.query<Row>(
      "SELECT count(*) FILTER(WHERE enabled)::integer AS enabled,count(*) FILTER(WHERE NOT enabled)::integer AS disabled FROM cpl_automation_recipes WHERE organization_id=$1",
      [a.organizationId],
    );
    checks.push({
      key: "workflow",
      status: Number(automation.rows[0]?.enabled) ? "configured" : "disabled",
      message: `${Number(automation.rows[0]?.enabled ?? 0)} enabled recipes; ${Number(automation.rows[0]?.disabled ?? 0)} disabled recipes. Disabled recipes are an intentional manual workflow, not a setup failure.`,
      blocking: false,
    });
    return {
      status: !profile.version
        ? "incomplete"
        : checks.some((c) => c.status === "missing")
          ? "configured"
          : "operationally_ready",
      checks,
    };
  }
  async getIntakePolicy(request: CplTenantRequest): Promise<CplCompanySetting<CplIntakePolicy>> {
    return this.run(request, "leads:read", false, (e, a) =>
      readCplIntakePolicy(e, a.organizationId),
    );
  }
  private async setting<T>(
    e: SqlExecutor,
    a: CplTenantAccess,
    key: string,
    expected: number,
    input: T,
  ): Promise<CplCompanySetting<T>> {
    const prior = await e.query<Row>(
      "SELECT value_json,version,updated_by_identity_id,updated_at FROM cpl_organization_settings WHERE organization_id=$1 AND setting_key=$2 FOR UPDATE",
      [a.organizationId, key],
    );
    if (Number(prior.rows[0]?.version ?? 0) !== expected) fail("CPL_COMPANY_VERSION_CONFLICT");
    if (prior.rows[0])
      await e.query(
        "INSERT INTO cpl_company_setting_versions(organization_id,setting_key,version,value_json,actor_identity_id,created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT DO NOTHING",
        [
          a.organizationId,
          key,
          expected,
          JSON.stringify(prior.rows[0].value_json),
          prior.rows[0].updated_by_identity_id,
          prior.rows[0].updated_at,
        ],
      );
    await e.query(
      "INSERT INTO cpl_organization_settings(organization_id,setting_key,value_json,version,updated_by_identity_id) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(organization_id,setting_key) DO UPDATE SET value_json=EXCLUDED.value_json,version=EXCLUDED.version,updated_by_identity_id=EXCLUDED.updated_by_identity_id,updated_at=CURRENT_TIMESTAMP",
      [a.organizationId, key, JSON.stringify(input), expected + 1, a.identityId],
    );
    await e.query(
      "INSERT INTO cpl_company_setting_versions(organization_id,setting_key,version,value_json,actor_identity_id) VALUES($1,$2,$3,$4::jsonb,$5)",
      [a.organizationId, key, expected + 1, JSON.stringify(input), a.identityId],
    );
    await auditCplCompany(
      e,
      a,
      key + ".saved",
      key === "company.profile" ? "profile" : "intake-policy",
      key,
      expected + 1,
      "Saved a new company configuration version.",
    );
    return { version: expected + 1, input };
  }
  async saveProfile(request: SettingInput): Promise<CplCompanySetting<CplCompanyProfile>> {
    const input = normalizeCplCompanyProfile(request.input),
      expected = cplCompanyRevision(request.expectedVersion);
    return this.run(request, "company:configure", true, (e, a) =>
      this.mutate(e, a, "profile.save", request.idempotencyKey, { expected, input }, () =>
        this.setting(e, a, "company.profile", expected, input),
      ),
    );
  }
  async saveIntakePolicy(request: SettingInput): Promise<CplCompanySetting<CplIntakePolicy>> {
    const input = normalizeCplIntakePolicy(request.input),
      expected = cplCompanyRevision(request.expectedVersion);
    return this.run(request, "company:configure", true, (e, a) =>
      this.mutate(
        e,
        a,
        "intake-policy.save",
        request.idempotencyKey,
        { expected, input },
        async () => {
          const prior = await readCplIntakePolicy(e, a.organizationId);
          for (const field of prior.input.customFields) {
            const next = input.customFields.find((x) => x.id === field.id);
            if (!next || next.type !== field.type) fail("CPL_COMPANY_FIELD_IDENTITY_CONFLICT");
          }
          return this.setting(e, a, "company.intake-policy", expected, input);
        },
      ),
    );
  }
  private async page<T>(
    e: SqlExecutor,
    a: CplTenantAccess,
    input: CplCompanyListInput,
    context: unknown,
    source: string,
    parameters: unknown[],
    map: (r: Row) => T,
  ): Promise<CplCompanyPage<T>> {
    const limit = input.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("CPL_COMPANY_INVALID_INPUT");
    const binding = hash({ organizationId: a.organizationId, context, limit });
    let after: string | null = null,
      afterId: string | null = null;
    if (input.cursor) {
      if (typeof input.cursor !== "string" || input.cursor.length > 1000)
        fail("CPL_COMPANY_INVALID_INPUT");
      try {
        const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        if (c.binding !== binding || typeof c.at !== "string" || !Number.isFinite(Date.parse(c.at)))
          fail("CPL_COMPANY_INVALID_INPUT");
        after = c.at;
        afterId = id(c.id);
      } catch {
        fail("CPL_COMPANY_INVALID_INPUT");
      }
    }
    const n = parameters.length;
    const rows = await e.query<Row>(
      `WITH filtered AS(${source}), selected AS(SELECT * FROM filtered WHERE ($${n + 1}::timestamptz IS NULL OR (created_at,id)>($${n + 1}::timestamptz,$${n + 2}::uuid)) ORDER BY created_at,id LIMIT $${n + 3}) SELECT (SELECT count(*)::integer FROM filtered) AS total,COALESCE((SELECT jsonb_agg(selected ORDER BY created_at,id) FROM selected),'[]'::jsonb) AS items`,
      [...parameters, after, afterId, limit + 1],
    );
    const items = companyJson<Row[]>(rows.rows[0]?.items ?? []),
      hasMore = items.length > limit,
      selected = items.slice(0, limit),
      last = selected.at(-1);
    return {
      items: selected.map(map),
      total: Number(rows.rows[0]?.total ?? 0),
      hasMore,
      limit,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ binding, at: String(last.created_at), id: last.id }),
            ).toString("base64url")
          : null,
    };
  }
  private filters(input: CplCompanyListInput) {
    const q = intakeText(input.q ?? "", 120),
      status = input.status ?? "active";
    if (!["active", "archived", "all"].includes(status)) fail("CPL_COMPANY_INVALID_INPUT");
    return { q, status, needle: "%" + q.replace(/[\\%_]/g, "\\$&") + "%" };
  }
  async listCatalog(
    request: CplTenantRequest & CplCompanyListInput,
  ): Promise<CplCompanyPage<CplCatalogItem>> {
    const f = this.filters(request);
    return this.run(request, "directory:read", false, (e, a) =>
      this.page(
        e,
        a,
        request,
        { kind: "catalog", ...f },
        "SELECT * FROM cpl_catalog_items WHERE organization_id=$1 AND ($2='all' OR status=$2) AND (code ILIKE $3 OR snapshot->>'name' ILIKE $3 OR snapshot->>'description' ILIKE $3)",
        [a.organizationId, f.status, f.needle],
        mapCplCatalog,
      ),
    );
  }
  async getCatalog(request: CplTenantRequest & { itemId: string }): Promise<CplCatalogItem> {
    return this.run(
      request,
      "directory:read",
      false,
      async (e, a) =>
        (await readCplCatalog(e, a.organizationId, id(request.itemId))) ??
        fail("CPL_RECORD_NOT_FOUND"),
    );
  }
  private async catalogVersion(
    e: SqlExecutor,
    a: CplTenantAccess,
    itemId: string,
    revision: number,
    status: CplCompanyStatus,
    input: unknown,
    reason: string | null,
  ) {
    await e.query(
      "INSERT INTO cpl_catalog_versions(organization_id,id,revision,status,snapshot,reason,actor_identity_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",
      [a.organizationId, itemId, revision, status, JSON.stringify(input), reason, a.identityId],
    );
    await auditCplCompany(
      e,
      a,
      "catalog.saved",
      "catalog",
      itemId,
      revision,
      status === "active"
        ? "Saved an active catalogue item revision."
        : "Archived the catalogue item; existing snapshots remain unchanged.",
    );
    return (await readCplCatalog(e, a.organizationId, itemId))!;
  }
  async saveCatalog(request: CatalogWrite): Promise<CplCatalogItem> {
    const input = normalizeCplCatalogInput(request.input),
      expected = cplCompanyRevision(request.expectedRevision),
      itemId = request.itemId ? id(request.itemId) : null;
    return this.run(request, "company:configure", true, (e, a) =>
      this.mutate(
        e,
        a,
        "catalog.save",
        request.idempotencyKey,
        { input, expected, itemId },
        async () => {
          const prior = itemId ? await readCplCatalog(e, a.organizationId, itemId) : null;
          if (itemId && !prior) fail("CPL_RECORD_NOT_FOUND");
          if ((prior?.revision ?? 0) !== expected) fail("CPL_COMPANY_VERSION_CONFLICT");
          if (prior && prior.workflowKey !== input.workflowKey)
            fail("CPL_COMPANY_WORKFLOW_KEY_IMMUTABLE");
          const duplicate = await e.query(
            "SELECT id FROM cpl_catalog_items WHERE organization_id=$1 AND (lower(code)=lower($2) OR workflow_key=$3) AND ($4::uuid IS NULL OR id<>$4)",
            [a.organizationId, input.code, input.workflowKey, itemId],
          );
          if (duplicate.rows.length) fail("CPL_CATALOG_DUPLICATE_CODE_OR_KEY");
          const savedId = itemId ?? randomUUID(),
            status = prior?.status ?? "active";
          await e.query(
            "INSERT INTO cpl_catalog_items(organization_id,id,revision,code,workflow_key,status,snapshot,created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(organization_id,id) DO UPDATE SET revision=EXCLUDED.revision,code=EXCLUDED.code,snapshot=EXCLUDED.snapshot,updated_at=CURRENT_TIMESTAMP",
            [
              a.organizationId,
              savedId,
              expected + 1,
              input.code,
              input.workflowKey,
              status,
              JSON.stringify(input),
              a.identityId,
            ],
          );
          return this.catalogVersion(e, a, savedId, expected + 1, status, input, null);
        },
      ),
    );
  }
  async setCatalogStatus(
    request: MutationInput & {
      itemId: string;
      expectedRevision: number;
      status: CplCompanyStatus;
      reason: string;
    },
  ): Promise<CplCatalogItem> {
    const itemId = id(request.itemId),
      expected = cplCompanyRevision(request.expectedRevision),
      reason = intakeText(request.reason, 2000, true),
      status = request.status;
    if (!["active", "archived"].includes(status)) fail("CPL_COMPANY_INVALID_INPUT");
    return this.run(request, "company:configure", true, (e, a) =>
      this.mutate(
        e,
        a,
        "catalog.status",
        request.idempotencyKey,
        { itemId, expected, reason, status },
        async () => {
          const prior = await readCplCatalog(e, a.organizationId, itemId);
          if (!prior) fail("CPL_RECORD_NOT_FOUND");
          if (prior.revision !== expected) fail("CPL_COMPANY_VERSION_CONFLICT");
          await e.query(
            "UPDATE cpl_catalog_items SET status=$3,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=$1 AND id=$2",
            [a.organizationId, itemId, status],
          );
          return this.catalogVersion(
            e,
            a,
            itemId,
            expected + 1,
            status,
            normalizeCplCatalogInput(prior),
            reason,
          );
        },
      ),
    );
  }
  async listDirectory(
    request: CplTenantRequest & CplCompanyListInput & { kind: CplDirectoryKind },
  ): Promise<CplCompanyPage<CplDirectoryDetail>> {
    const kind = kindOf(request.kind),
      f = this.filters(request),
      customerId = request.customerId ? id(request.customerId) : null;
    return this.run(request, "directory:read", false, (e, a) =>
      this.page(
        e,
        a,
        request,
        { kind, ...f, customerId },
        `SELECT b.*,c.snapshot AS current_snapshot,c.revision AS current_revision,c.status AS current_status,c.updated_at AS current_updated_at FROM ${directoryTables[kind]} b LEFT JOIN cpl_directory_current c ON c.organization_id=b.organization_id AND c.id=b.id AND c.kind=$2 WHERE b.organization_id=$1 AND ($3='all' OR COALESCE(c.status,'active')=$3) AND (COALESCE(c.snapshot->>'name',b.name) ILIKE $4 ${kind === "contact" ? "OR COALESCE(CASE WHEN c.id IS NULL THEN b.email ELSE c.snapshot->>'email' END,'') ILIKE $4 OR COALESCE(c.snapshot->>'phone',b.phone,'') ILIKE $4" : kind === "site" ? "OR COALESCE(c.snapshot->>'address',b.address,'') ILIKE $4" : ""}) AND ($5::uuid IS NULL OR ${kind === "customer" ? "b.id" : "CASE WHEN c.id IS NULL THEN b.customer_id ELSE c.customer_id END"}=$5)`,
        [a.organizationId, kind, f.status, f.needle, customerId],
        (r) => ({ ...mapCplDirectory(kind, r), revisions: [], duplicateCandidates: [] }),
      ),
    );
  }
  private async directoryDetail(
    e: SqlExecutor,
    a: CplTenantAccess,
    kind: CplDirectoryKind,
    entryId: string,
  ): Promise<CplDirectoryDetail> {
    const current = await readCplDirectory(e, a.organizationId, kind, entryId);
    if (!current) fail("CPL_RECORD_NOT_FOUND");
    const revisions = await e.query<Row>(
      "SELECT * FROM cpl_directory_versions WHERE organization_id=$1 AND kind=$2 AND id=$3 ORDER BY revision DESC",
      [a.organizationId, kind, entryId],
    );
    const base = await e.query<Row>(
      `SELECT * FROM ${directoryTables[kind]} WHERE organization_id=$1 AND id=$2`,
      [a.organizationId, entryId],
    );
    const histories = revisions.rows.map((r) => ({
      revision: Number(r.revision),
      snapshot: companyJson<CplDirectoryInput>(r.snapshot),
      status: r.status as CplCompanyStatus,
      actorIdentityId: String(r.actor_identity_id),
      createdAt: companyIso(r.created_at),
      reason: r.reason == null ? null : String(r.reason),
    }));
    if (!histories.some((r) => r.revision === 1)) {
      const original = mapCplDirectory(kind, base.rows[0]!);
      histories.push({
        revision: 1,
        snapshot: directoryInput(original),
        status: "active",
        actorIdentityId: String(base.rows[0]!.created_by_identity_id),
        createdAt: original.createdAt,
        reason: null,
      });
    }
    const candidates = await e.query<Row>(
      `SELECT b.id,COALESCE(c.snapshot->>'name',b.name) AS name FROM ${directoryTables[kind]} b LEFT JOIN cpl_directory_current c ON c.organization_id=b.organization_id AND c.id=b.id AND c.kind=$2 WHERE b.organization_id=$1 AND b.id<>$3 AND lower(COALESCE(c.snapshot->>'name',b.name))=lower($4) ORDER BY b.created_at,b.id LIMIT 20`,
      [a.organizationId, kind, entryId, current.name],
    );
    return {
      ...current,
      revisions: histories,
      duplicateCandidates: candidates.rows.map((r) => ({ id: String(r.id), name: String(r.name) })),
    };
  }
  async getDirectory(
    request: CplTenantRequest & { kind: CplDirectoryKind; entryId: string },
  ): Promise<CplDirectoryDetail> {
    const kind = kindOf(request.kind),
      entryId = id(request.entryId);
    return this.run(request, "directory:read", false, (e, a) =>
      this.directoryDetail(e, a, kind, entryId),
    );
  }
  private async directoryVersion(
    e: SqlExecutor,
    a: CplTenantAccess,
    kind: CplDirectoryKind,
    entryId: string,
    revision: number,
    status: CplCompanyStatus,
    input: CplDirectoryInput,
    reason: string | null,
  ) {
    await e.query(
      "INSERT INTO cpl_directory_current(organization_id,kind,id,customer_id,revision,status,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(organization_id,kind,id) DO UPDATE SET customer_id=EXCLUDED.customer_id,revision=EXCLUDED.revision,status=EXCLUDED.status,snapshot=EXCLUDED.snapshot,updated_at=CURRENT_TIMESTAMP",
      [a.organizationId, kind, entryId, input.customerId, revision, status, JSON.stringify(input)],
    );
    await e.query(
      "INSERT INTO cpl_directory_versions(organization_id,kind,id,revision,status,snapshot,reason,actor_identity_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
      [
        a.organizationId,
        kind,
        entryId,
        revision,
        status,
        JSON.stringify(input),
        reason,
        a.identityId,
      ],
    );
    await auditCplCompany(
      e,
      a,
      `directory.${kind}.saved`,
      kind,
      entryId,
      revision,
      status === "active"
        ? "Saved current directory details; captured business snapshots remain unchanged."
        : "Archived directory entry; references and original history remain available.",
    );
    return this.directoryDetail(e, a, kind, entryId);
  }
  async saveDirectory(request: DirectoryWrite): Promise<CplDirectoryDetail> {
    const kind = kindOf(request.kind),
      entryId = request.entryId ? id(request.entryId) : null,
      expected = cplCompanyRevision(request.expectedRevision),
      input = normalizeCplDirectoryInput(kind, request.input);
    return this.run(request, "directory:write", true, (e, a) =>
      this.mutate(
        e,
        a,
        `directory.${kind}.save`,
        request.idempotencyKey,
        { entryId, expected, input },
        async () => {
          const prior = entryId ? await readCplDirectory(e, a.organizationId, kind, entryId) : null;
          if (entryId && !prior) fail("CPL_RECORD_NOT_FOUND");
          if ((prior?.revision ?? 0) !== expected) fail("CPL_COMPANY_VERSION_CONFLICT");
          if (input.customerId) {
            const customer = await readCplDirectory(
              e,
              a.organizationId,
              "customer",
              input.customerId,
            );
            if (!customer) fail("CPL_RECORD_NOT_FOUND");
            if (customer.status !== "active" && prior?.customerId !== input.customerId)
              fail("CPL_DIRECTORY_ARCHIVED");
          }
          const savedId = entryId ?? randomUUID();
          if (!prior) {
            if (kind === "customer")
              await e.query(
                "INSERT INTO cpl_customers(id,organization_id,name,created_by_identity_id) VALUES($1,$2,$3,$4)",
                [savedId, a.organizationId, input.name, a.identityId],
              );
            else if (kind === "contact")
              await e.query(
                "INSERT INTO cpl_contacts(id,organization_id,customer_id,name,email,phone,created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
                [
                  savedId,
                  a.organizationId,
                  input.customerId,
                  input.name,
                  input.email,
                  input.phone,
                  a.identityId,
                ],
              );
            else
              await e.query(
                "INSERT INTO cpl_sites(id,organization_id,customer_id,name,address,created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6)",
                [
                  savedId,
                  a.organizationId,
                  input.customerId,
                  input.name,
                  input.address,
                  a.identityId,
                ],
              );
          }
          return this.directoryVersion(
            e,
            a,
            kind,
            savedId,
            expected + 1,
            prior?.status ?? "active",
            input,
            null,
          );
        },
      ),
    );
  }
  async setDirectoryStatus(
    request: MutationInput & {
      kind: CplDirectoryKind;
      entryId: string;
      expectedRevision: number;
      status: CplCompanyStatus;
      reason: string;
    },
  ): Promise<CplDirectoryDetail> {
    const kind = kindOf(request.kind),
      entryId = id(request.entryId),
      expected = cplCompanyRevision(request.expectedRevision),
      reason = intakeText(request.reason, 2000, true),
      status = request.status;
    if (!["active", "archived"].includes(status)) fail("CPL_COMPANY_INVALID_INPUT");
    return this.run(request, "directory:write", true, (e, a) =>
      this.mutate(
        e,
        a,
        `directory.${kind}.status`,
        request.idempotencyKey,
        { entryId, expected, reason, status },
        async () => {
          const prior = await readCplDirectory(e, a.organizationId, kind, entryId);
          if (!prior) fail("CPL_RECORD_NOT_FOUND");
          if (prior.revision !== expected) fail("CPL_COMPANY_VERSION_CONFLICT");
          return this.directoryVersion(
            e,
            a,
            kind,
            entryId,
            expected + 1,
            status,
            directoryInput(prior),
            reason,
          );
        },
      ),
    );
  }
  async listAudit(
    request: CplTenantRequest & CplCompanyAuditFilters,
  ): Promise<CplCompanyPage<CplCompanyAuditEvent>> {
    const action = intakeText(request.action ?? "", 120),
      actor = request.actorIdentityId ? id(request.actorIdentityId) : null;
    const date = (v: string | undefined) => {
      if (!v) return null;
      if (v.length > 40 || !Number.isFinite(Date.parse(v))) fail("CPL_COMPANY_INVALID_INPUT");
      return new Date(v).toISOString();
    };
    const from = date(request.from),
      to = date(request.to);
    if (from && to && from > to) fail("CPL_COMPANY_INVALID_INPUT");
    return this.run(request, "audit:read", false, (e, a) =>
      this.page(
        e,
        a,
        request,
        { kind: "audit", action, actor, from, to },
        `SELECT * FROM(
          SELECT ev.id,ev.actor_identity_id,ev.created_at,ev.action,ev.resource_id,ev.resource_type,ev.resource_version,ev.safe_summary,i.display_name AS actor_name
          FROM cpl_tenant_audit_events ev LEFT JOIN cpl_identities i ON i.id=ev.actor_identity_id WHERE ev.organization_id=$1
          UNION ALL
          SELECT id,NULL::uuid AS actor_identity_id,created_at,action,organization_id::text AS resource_id,'company'::text AS resource_type,1 AS resource_version,
          '{"message":"A platform operator provisioned this company and its initial owner. No customer message was sent."}'::jsonb AS safe_summary,'Platform operator'::text AS actor_name
          FROM cpl_platform_audit_events WHERE organization_id=$1 AND action='company.provisioned'
        ) ev WHERE ($2='' OR ev.action=$2) AND ($3::uuid IS NULL OR ev.actor_identity_id=$3) AND ($4::timestamptz IS NULL OR ev.created_at>=$4) AND ($5::timestamptz IS NULL OR ev.created_at<=$5)`,
        [a.organizationId, action, actor, from, to],
        (r) => {
          const type = r.resource_type == null ? null : String(r.resource_type),
            resource = r.resource_id == null ? null : String(r.resource_id),
            safe = companyJson<Record<string, unknown>>(r.safe_summary ?? {});
          const validTarget =
            type &&
            ["customer", "contact", "site", "catalog", "profile", "intake-policy"].includes(type);
          return {
            id: String(r.id),
            actorIdentityId: r.actor_identity_id == null ? null : String(r.actor_identity_id),
            actorName: String(r.actor_name ?? "Former member"),
            createdAt: companyIso(r.created_at),
            action: String(r.action),
            resourceId: resource,
            resourceType: type,
            version: r.resource_version == null ? null : Number(r.resource_version),
            summary:
              typeof safe.message === "string"
                ? safe.message.slice(0, 500)
                : "Recorded company activity.",
            target: validTarget
              ? { kind: type as NonNullable<CplCompanyAuditEvent["target"]>["kind"], id: resource }
              : null,
          };
        },
      ),
    );
  }
}
