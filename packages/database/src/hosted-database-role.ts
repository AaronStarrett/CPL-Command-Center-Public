import type { DatabaseAdapter, SqlExecutor } from "./adapter.js";

export type CplHostedDatabasePurpose = "web" | "worker";

/** Explicit operator opt-in for the local/internal automation processor. The
 * historical hosted HTTP worker keeps its original capabilities and job kind. */
export async function configureCplAutomationWorker(
  database: DatabaseAdapter,
  roleName: string,
): Promise<void> {
  if (
    database.kind !== "postgres" ||
    !/^cpl_[a-z0-9_]{1,58}$/u.test(roleName) ||
    roleName === "cpl_worker_runtime"
  )
    throw new Error("CPL_AUTOMATION_WORKER_REFUSED");
  const role = `"${roleName}"`;
  await database.transaction(async (e) => {
    const r = await e.query<Record<string, unknown>>(
      `SELECT registry.purpose,p.rolsuper,p.rolbypassrls,p.rolcreatedb,p.rolcreaterole,p.rolreplication,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=p.oid) AS inherited,
      EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='cpl_jobs_http' AND has_function_privilege(p.oid,f.oid,'EXECUTE')) AS http_capability,
      has_table_privilege(p.oid,'cpl_runtime_roles','INSERT,UPDATE,DELETE') AS registry_write
      FROM pg_roles p JOIN cpl_runtime_roles registry ON registry.role_name=p.rolname WHERE p.rolname=$1`,
      [roleName],
    );
    const row = r.rows[0];
    if (
      !row ||
      row.purpose !== "worker" ||
      Object.entries(row).some(([key, value]) => key !== "purpose" && value !== false)
    )
      throw new Error("CPL_AUTOMATION_WORKER_REFUSED");
    const contract = await e.query<{
      valid: boolean;
    }>(`SELECT p.prosecdef AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND p.prorettype='jsonb'::regtype AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='604da5f939cebc105dde6a1c2d7a016fc3d88009bdec82ce2baeea653c68c8f4'
      AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS valid
      FROM pg_proc p WHERE p.oid=to_regprocedure('public.cpl_automation_lock_authority(uuid,uuid,uuid)')`);
    if (contract.rows[0]?.valid !== true)
      throw new Error("CPL_AUTOMATION_AUTHORITY_CONTRACT_REFUSED");
    await e.execute(`GRANT SELECT ON cpl_workflow_leads,cpl_lead_evidence,cpl_lead_review_events,cpl_customers,cpl_contacts,cpl_sites,cpl_commercial_branding,cpl_commercial_templates,cpl_commercial_proposals,cpl_commercial_versions,cpl_commercial_events,cpl_commercial_awards,cpl_commercial_projects,cpl_commercial_artifacts,cpl_workflow_mutations,cpl_project_operations,cpl_project_team,cpl_project_visits,cpl_project_tasks,cpl_execution_events,cpl_field_records,cpl_field_templates,cpl_field_observations,cpl_field_observation_revisions,cpl_field_photos,cpl_field_photo_revisions,cpl_report_branding,cpl_report_templates,cpl_reports,cpl_report_versions,cpl_report_events,cpl_report_attempts,cpl_report_artifacts,cpl_report_mutations,cpl_automation_recipes,cpl_automation_recipe_versions,cpl_business_events,cpl_automation_steps,cpl_automation_attempts,cpl_action_tasks,cpl_action_task_events,cpl_delivery_packages,cpl_delivery_versions,cpl_delivery_attachments,cpl_delivery_events,cpl_report_approval_withdrawals,cpl_closeout_policies,cpl_closeout_facts,cpl_closeout_overrides,cpl_delivery_mutations TO ${role};
      GRANT INSERT ON cpl_workflow_mutations,cpl_commercial_proposals,cpl_commercial_versions,cpl_commercial_events,cpl_commercial_projects,cpl_reports,cpl_report_versions,cpl_report_events,cpl_report_mutations,cpl_automation_steps,cpl_automation_attempts,cpl_action_tasks,cpl_action_task_events,cpl_delivery_packages,cpl_delivery_versions,cpl_delivery_attachments,cpl_delivery_events,cpl_delivery_mutations TO ${role};
      GRANT UPDATE(updated_at) ON cpl_workflow_leads,cpl_commercial_proposals TO ${role};
      GRANT UPDATE(resource_id) ON cpl_workflow_mutations TO ${role};
      GRANT UPDATE ON cpl_automation_attempts TO ${role};
      GRANT EXECUTE ON FUNCTION cpl_automation_lock_authority(uuid,uuid,uuid) TO ${role};`);
    await e.query(
      "UPDATE cpl_runtime_roles SET automation_enabled=TRUE WHERE role_name=$1 AND purpose='worker'",
      [roleName],
    );
  });
}
/** Runtime roles cannot migrate, own the database/schema, bypass RLS, register
 * themselves, or inherit a privileged role. Separate credentials serve cron. */
export async function verifyHostedDatabaseRole(
  database: DatabaseAdapter,
  purpose: CplHostedDatabasePurpose,
  // A caller already in a transaction supplies that database's executor. This
  // preserves the full check without checking out a second max-one pool client.
  executor: SqlExecutor = database,
): Promise<{ role: string; purpose: CplHostedDatabasePurpose }> {
  if (database.kind !== "postgres") throw new Error("CPL_HOSTED_POSTGRES_REQUIRED");
  const result = await executor.query<Record<string, unknown>>(`
    WITH RECURSIVE inherited AS (
      SELECT roleid FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      UNION SELECT m.roleid FROM pg_auth_members m JOIN inherited i ON m.member=i.roleid
    )
    SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
      (d.datdba=r.oid OR d.datdba IN (SELECT roleid FROM inherited)) AS owns_database,
      (n.nspowner=r.oid OR n.nspowner IN (SELECT roleid FROM inherited)) AS owns_schema,
      EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND (c.relowner=r.oid OR c.relowner IN (SELECT roleid FROM inherited)) AND c.relkind IN ('r','p','v','m','f')) AS owns_application_tables,
      (SELECT count(*)=65 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c WHERE c.relnamespace=n.oid AND c.relname IN ('cpl_organizations','cpl_memberships','cpl_module_entitlements','cpl_organization_settings','cpl_invitations','cpl_service_grants','cpl_tenant_audit_events','cpl_platform_audit_events','cpl_workflow_leads','cpl_proposal_drafts','cpl_workflow_mutations','cpl_workflow_jobs','cpl_customers','cpl_contacts','cpl_sites','cpl_lead_evidence','cpl_lead_review_events','cpl_commercial_branding','cpl_commercial_templates','cpl_commercial_proposals','cpl_commercial_versions','cpl_commercial_events','cpl_commercial_awards','cpl_commercial_projects','cpl_commercial_artifacts','cpl_project_operations','cpl_project_team','cpl_project_visits','cpl_project_tasks','cpl_execution_events','cpl_execution_mutations','cpl_field_templates','cpl_field_records','cpl_field_checklist_revisions','cpl_field_observations','cpl_field_observation_revisions','cpl_field_photos','cpl_field_photo_revisions','cpl_field_events','cpl_field_mutations','cpl_report_branding','cpl_report_templates','cpl_reports','cpl_report_versions','cpl_report_events','cpl_report_attempts','cpl_report_artifacts','cpl_report_mutations','cpl_automation_recipes','cpl_automation_recipe_versions','cpl_business_events','cpl_automation_steps','cpl_automation_attempts','cpl_action_tasks','cpl_action_task_events','cpl_automation_mutations','cpl_delivery_packages','cpl_delivery_versions','cpl_delivery_attachments','cpl_delivery_events','cpl_report_approval_withdrawals','cpl_closeout_policies','cpl_closeout_facts','cpl_closeout_overrides','cpl_delivery_mutations')) AS tenant_tables_protected,
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
      "INSERT INTO cpl_runtime_roles (role_name,purpose,automation_enabled) VALUES ($1,$2,FALSE) ON CONFLICT (role_name) DO UPDATE SET purpose=EXCLUDED.purpose,automation_enabled=FALSE",
      [roleName, purpose],
    );
    await executor.execute(
      `GRANT SELECT ON cpl_runtime_roles,bea_schema_migrations TO ${role}; REVOKE EXECUTE ON FUNCTION cpl_automation_lock_authority(uuid,uuid,uuid) FROM ${role};`,
    );
    if (purpose === "web") {
      await executor.execute(
        `GRANT SELECT,INSERT,UPDATE ON cpl_automation_recipes,cpl_action_tasks,cpl_delivery_packages TO ${role}; GRANT SELECT,INSERT ON cpl_automation_recipe_versions,cpl_business_events,cpl_automation_steps,cpl_action_task_events,cpl_automation_mutations,cpl_delivery_versions,cpl_delivery_attachments,cpl_delivery_events,cpl_report_approval_withdrawals,cpl_closeout_policies,cpl_closeout_facts,cpl_closeout_overrides,cpl_delivery_mutations TO ${role}; GRANT SELECT,UPDATE ON cpl_automation_attempts TO ${role};`,
      );
      await executor.execute(`GRANT SELECT,INSERT,UPDATE ON cpl_identities,cpl_sessions,cpl_organizations,cpl_memberships,cpl_module_entitlements,cpl_organization_settings,cpl_invitations,cpl_service_grants,cpl_workflow_leads,cpl_proposal_drafts,cpl_workflow_mutations,cpl_workflow_jobs,cpl_webauthn_credentials TO ${role};
        GRANT SELECT,INSERT ON cpl_platform_administrators,cpl_platform_owner_binding,cpl_tenant_audit_events,cpl_platform_audit_events TO ${role};
        GRANT UPDATE (status) ON cpl_platform_administrators TO ${role};
        GRANT INSERT ON cpl_auth_audit_events TO ${role};
        GRANT SELECT,INSERT ON cpl_customers,cpl_contacts,cpl_sites,cpl_lead_evidence,cpl_lead_review_events TO ${role};
        GRANT SELECT,INSERT,UPDATE ON cpl_reports,cpl_field_records,cpl_field_observations,cpl_field_photos,cpl_project_operations,cpl_project_team,cpl_project_visits,cpl_project_tasks,cpl_commercial_branding,cpl_commercial_proposals TO ${role};
        GRANT SELECT,INSERT ON cpl_report_branding,cpl_report_templates,cpl_report_versions,cpl_report_events,cpl_report_attempts,cpl_report_artifacts,cpl_report_mutations,cpl_field_templates,cpl_field_checklist_revisions,cpl_field_observation_revisions,cpl_field_photo_revisions,cpl_field_events,cpl_field_mutations,cpl_execution_events,cpl_execution_mutations,cpl_commercial_templates,cpl_commercial_versions,cpl_commercial_events,cpl_commercial_awards,cpl_commercial_projects,cpl_commercial_artifacts TO ${role};
        GRANT SELECT,INSERT,UPDATE,DELETE ON cpl_oauth_flows,cpl_webauthn_challenges,cpl_auth_rate_limits TO ${role};`);

      // Fresh provisioning grants only the reviewed versioned session capability.
      if (roleName === "cpl_web_runtime") {
        const capability = await executor.query<{
          contract_valid: boolean;
        }>(`WITH expected(name,signature,return_type,language,source_hash) AS (VALUES ('assert_web_v1','cpl_session_http.assert_web_v1()','void','plpgsql','228ac01e3a5347980fe450b052cca8f837f1aa5457af1bffcf01f9503ed5d36d'),
('read_core_v1','cpl_session_http.read_core_v1(text,timestamptz,boolean)','jsonb','plpgsql','dcef0edf97166811a99b50d858b0d499f66d1289fa86a2eb9d06eb5ca648d4e9'),
('read_v1','cpl_session_http.read_v1(text,timestamptz)','jsonb','sql','c4ac3962135c8a6c4b7963a38878c1bc777731365c46df98568608b85bfd6b0d'),
('read_with_passkey_v1','cpl_session_http.read_with_passkey_v1(text,timestamptz)','jsonb','sql','672e6255d4e4be61c4ce78834b1896fa6e1bcdf41f4e9d415c25b8851c33dbf4'))
SELECT n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND (SELECT count(*)=4 FROM pg_proc WHERE pronamespace=n.oid)
  AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace=n.oid)
  AND (SELECT count(*)=4 AND bool_and(p.proowner=n.nspowner AND NOT p.prosecdef AND NOT p.proretset AND NOT p.proisstrict AND NOT p.proleakproof
    AND p.prokind='f' AND l.lanname=e.language AND p.provolatile='v' AND p.proparallel='u'
    AND p.oid=to_regprocedure(e.signature) AND p.prorettype=to_regtype(e.return_type)
    AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.source_hash)
    FROM expected e JOIN pg_proc p ON p.pronamespace=n.oid AND p.proname=e.name JOIN pg_language l ON l.oid=p.prolang)
  AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantor<>n.nspowner OR (a.grantee<>n.nspowner AND a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='cpl_web_runtime')) OR (a.grantee=(SELECT oid FROM pg_roles WHERE rolname='cpl_web_runtime') AND (a.is_grantable OR a.privilege_type<>'USAGE')))
  AND NOT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace=n.oid AND (a.grantor<>n.nspowner OR (a.grantee<>n.nspowner AND a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='cpl_web_runtime')) OR (a.grantee=(SELECT oid FROM pg_roles WHERE rolname='cpl_web_runtime') AND (a.is_grantable OR a.privilege_type<>'EXECUTE')))) AS contract_valid
FROM pg_namespace n WHERE n.nspname='cpl_session_http'`);
        if (capability.rows.length) {
          if (capability.rows.length !== 1 || capability.rows[0]?.contract_valid !== true)
            throw new Error("CPL_SESSION_HTTP_FUNCTION_CONTRACT_REFUSED");
          await executor.execute(`GRANT USAGE ON SCHEMA cpl_session_http TO cpl_web_runtime;
    GRANT EXECUTE ON FUNCTION cpl_session_http.assert_web_v1(),cpl_session_http.read_core_v1(text,timestamptz,boolean),
      cpl_session_http.read_v1(text,timestamptz),cpl_session_http.read_with_passkey_v1(text,timestamptz) TO cpl_web_runtime;`);
        }
      }
    } else {
      await executor.execute(`GRANT SELECT ON cpl_identities,cpl_organizations,cpl_memberships,cpl_module_entitlements,cpl_proposal_drafts TO ${role};
        GRANT SELECT,UPDATE ON cpl_workflow_jobs TO ${role};
        GRANT UPDATE (prepared_version,prepared_sha256) ON cpl_proposal_drafts TO ${role};
        GRANT INSERT ON cpl_tenant_audit_events TO ${role};`);
      // Fresh provisioning applies migrations before creating the fixed worker.
      // Existing populated deployments receive this same narrow grant in0027.
      if (roleName === "cpl_worker_runtime") {
        const capability = await executor.query<{
          contract_valid: boolean;
        }>(`WITH expected(name,signature,return_type,volatility,source_hash) AS (VALUES ('assert_worker_v1','cpl_jobs_http.assert_worker_v1()','void','v','469815c3dc45f2d060d705a7aa0c7ba77ec2143d9b0a00ad13d9ebde472fb6fd'),
('parse_claim_v1','cpl_jobs_http.parse_claim_v1(jsonb)','cpl_jobs_http.claim_snapshot_v1','i','c96f0b748c8fb69388a55a1bfc78c0fae9503d001321f84ab2f081f43ed13fac'),
('claim_v1','cpl_jobs_http.claim_v1(text,uuid)','jsonb','v','10f4284e0f164b6be0ebfc29cbffd72fbcf5325d9a01812b6dfd3d6796a48d67'),
('process_v1','cpl_jobs_http.process_v1(jsonb,uuid)','jsonb','v','32ce3d2adabbe7a874e189bbf3e85f01f7a8e69f64d4e846c8288bf071b6f794'),
('retry_v1','cpl_jobs_http.retry_v1(jsonb,uuid,text)','jsonb','v','eb0bef88d8233bf03ca394a8bb25a703ea6c41c046979d9f89b840de839ee510'))
SELECT n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND (SELECT count(*)=5 FROM pg_proc WHERE pronamespace=n.oid)
  AND (SELECT count(*)=5 AND bool_and(p.proowner=n.nspowner AND NOT p.prosecdef AND NOT p.proretset
    AND p.prokind='f' AND l.lanname='plpgsql' AND p.provolatile=e.volatility::"char"
    AND p.oid=to_regprocedure(e.signature) AND p.prorettype=to_regtype(e.return_type)
    AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.source_hash)
    FROM expected e JOIN pg_proc p ON p.pronamespace=n.oid AND p.proname=e.name JOIN pg_language l ON l.oid=p.prolang) AS contract_valid
FROM pg_namespace n WHERE n.nspname='cpl_jobs_http'`);
        if (capability.rows.length) {
          if (capability.rows.length !== 1 || capability.rows[0]?.contract_valid !== true)
            throw new Error("CPL_JOBS_HTTP_FUNCTION_CONTRACT_REFUSED");
          await executor.execute(`GRANT USAGE ON SCHEMA cpl_jobs_http TO cpl_worker_runtime;
            GRANT USAGE ON TYPE cpl_jobs_http.claim_snapshot_v1 TO cpl_worker_runtime;
            GRANT EXECUTE ON FUNCTION cpl_jobs_http.assert_worker_v1(),cpl_jobs_http.parse_claim_v1(jsonb),
              cpl_jobs_http.claim_v1(text,uuid),cpl_jobs_http.process_v1(jsonb,uuid),cpl_jobs_http.retry_v1(jsonb,uuid,text) TO cpl_worker_runtime;`);
        }
      }
    }
  });
}
