import type { DatabaseAdapter } from "./adapter.js";

export type CplHostedDatabasePurpose = "web" | "worker";
/** Runtime roles cannot migrate, own the database/schema, bypass RLS, register
 * themselves, or inherit a privileged role. Separate credentials serve cron. */
export async function verifyHostedDatabaseRole(
  database: DatabaseAdapter,
  purpose: CplHostedDatabasePurpose,
): Promise<{ role: string; purpose: CplHostedDatabasePurpose }> {
  if (database.kind !== "postgres") throw new Error("CPL_HOSTED_POSTGRES_REQUIRED");
  const result = await database.query<Record<string, unknown>>(`
    WITH RECURSIVE inherited AS (
      SELECT roleid FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      UNION SELECT m.roleid FROM pg_auth_members m JOIN inherited i ON m.member=i.roleid
    )
    SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
      (d.datdba=r.oid OR d.datdba IN (SELECT roleid FROM inherited)) AS owns_database,
      (n.nspowner=r.oid OR n.nspowner IN (SELECT roleid FROM inherited)) AS owns_schema,
      EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND (c.relowner=r.oid OR c.relowner IN (SELECT roleid FROM inherited)) AND c.relkind IN ('r','p','v','m','f')) AS owns_application_tables,
      (SELECT count(*)=12 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c WHERE c.relnamespace=n.oid AND c.relname IN ('cpl_organizations','cpl_memberships','cpl_module_entitlements','cpl_organization_settings','cpl_invitations','cpl_service_grants','cpl_tenant_audit_events','cpl_platform_audit_events','cpl_workflow_leads','cpl_proposal_drafts','cpl_workflow_mutations','cpl_workflow_jobs')) AS tenant_tables_protected,
      (has_schema_privilege(current_user,'public','CREATE') OR EXISTS (SELECT 1 FROM inherited i WHERE has_schema_privilege(i.roleid,'public','CREATE'))) AS schema_create,
      EXISTS (SELECT 1 FROM inherited i JOIN pg_roles p ON p.oid=i.roleid WHERE p.rolsuper OR p.rolbypassrls OR p.rolcreatedb OR p.rolcreaterole OR p.rolreplication OR p.rolname LIKE 'pg_%') AS elevated_membership,
      registry.purpose,
      (has_table_privilege(current_user,'public.cpl_runtime_roles','INSERT,UPDATE,DELETE') OR EXISTS (SELECT 1 FROM inherited i WHERE has_table_privilege(i.roleid,'public.cpl_runtime_roles','INSERT,UPDATE,DELETE'))) AS can_change_role_registry,
      (has_table_privilege(current_user,'public.leads','SELECT') OR EXISTS (SELECT 1 FROM inherited i WHERE has_table_privilege(i.roleid,'public.leads','SELECT'))) AS can_read_legacy_leads
    FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      JOIN pg_namespace n ON n.nspname='public'
      LEFT JOIN public.cpl_runtime_roles registry ON registry.role_name=r.rolname
    WHERE r.rolname=current_user`);
  const row = result.rows[0];
  if (
    !row ||
    row.purpose !== purpose ||
    row.tenant_tables_protected !== true ||
    [
      "rolsuper",
      "rolbypassrls",
      "rolcreatedb",
      "rolcreaterole",
      "rolreplication",
      "owns_database",
      "owns_schema",
      "owns_application_tables",
      "schema_create",
      "elevated_membership",
      "can_change_role_registry",
      "can_read_legacy_leads",
    ].some((key) => row[key] !== false)
  )
    throw new Error("CPL_HOSTED_DATABASE_ROLE_REFUSED");
  return { role: String(row.rolname), purpose };
}

/** Operator/migration connection only. Does not create users or accept passwords.
 * Explicit grants intentionally leave all legacy operational tables inaccessible. */
export async function configureHostedRuntimeRole(
  database: DatabaseAdapter,
  roleName: string,
  purpose: CplHostedDatabasePurpose,
): Promise<void> {
  if (
    database.kind !== "postgres" ||
    !/^cpl_[a-z0-9_]{1,58}$/u.test(roleName) ||
    !["web", "worker"].includes(purpose)
  )
    throw new Error("CPL_INVALID_RUNTIME_ROLE");
  const role = `"${roleName}"`;
  await database.transaction(async (executor) => {
    const existing = await executor.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
    }>(
      "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1",
      [roleName],
    );
    if (!existing.rows[0] || Object.values(existing.rows[0]).some(Boolean))
      throw new Error("CPL_RUNTIME_ROLE_MUST_BE_RESTRICTED");
    await executor.execute(
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}; REVOKE CREATE ON SCHEMA public FROM ${role}; GRANT USAGE ON SCHEMA public TO ${role};`,
    );
    await executor.query(
      "INSERT INTO cpl_runtime_roles (role_name,purpose) VALUES ($1,$2) ON CONFLICT (role_name) DO UPDATE SET purpose=EXCLUDED.purpose",
      [roleName, purpose],
    );
    await executor.execute(`GRANT SELECT ON cpl_runtime_roles,bea_schema_migrations TO ${role};`);
    if (purpose === "web") {
      await executor.execute(`GRANT SELECT,INSERT,UPDATE ON cpl_identities,cpl_sessions,cpl_organizations,cpl_memberships,cpl_module_entitlements,cpl_organization_settings,cpl_invitations,cpl_service_grants,cpl_workflow_leads,cpl_proposal_drafts,cpl_workflow_mutations,cpl_workflow_jobs,cpl_webauthn_credentials TO ${role};
        GRANT SELECT,INSERT ON cpl_platform_administrators,cpl_platform_owner_binding,cpl_tenant_audit_events,cpl_platform_audit_events TO ${role};
        GRANT UPDATE (status) ON cpl_platform_administrators TO ${role};
        GRANT INSERT ON cpl_auth_audit_events TO ${role};
        GRANT SELECT,INSERT,UPDATE,DELETE ON cpl_oauth_flows,cpl_webauthn_challenges,cpl_auth_rate_limits TO ${role};`);
    } else {
      await executor.execute(`GRANT SELECT ON cpl_identities,cpl_organizations,cpl_memberships,cpl_module_entitlements,cpl_proposal_drafts TO ${role};
        GRANT SELECT,UPDATE ON cpl_workflow_jobs TO ${role};
        GRANT UPDATE (prepared_version,prepared_sha256) ON cpl_proposal_drafts TO ${role};
        GRANT INSERT ON cpl_tenant_audit_events TO ${role};`);
    }
  });
}
