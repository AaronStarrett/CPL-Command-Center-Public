-- Additive versioned session-read capability. Existing application records are untouched.
-- The migration runner owns transaction, advisory lock and migration ledger.
DO $migration_owner$
BEGIN
  IF current_user IN ('cpl_worker_runtime','cpl_web_runtime') OR EXISTS
    (SELECT 1 FROM public.cpl_runtime_roles WHERE role_name=current_user) THEN
    RAISE EXCEPTION 'CPL_SESSION_HTTP_MIGRATION_OWNER_REFUSED';
  END IF;
END;
$migration_owner$;
CREATE SCHEMA cpl_session_http;
REVOKE ALL ON SCHEMA cpl_session_http FROM PUBLIC;

CREATE FUNCTION cpl_session_http.assert_web_v1() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_role record;
BEGIN
  -- These deadlines must already be armed by the preceding transaction query.
  -- Setting statement_timeout inside this function would not bound its own call.
  IF current_setting('transaction_read_only') IS DISTINCT FROM 'on'
     OR (extract(epoch FROM current_setting('statement_timeout')::interval)*1000)::integer IS DISTINCT FROM 15000
     OR (extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval)*1000)::integer IS DISTINCT FROM 15000 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_HYPERDRIVE_SERVER_DEADLINES_REFUSED';
  END IF;
  SELECT * INTO v_role FROM (
-- BEGIN CANONICAL ROLE QUERY
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
    WHERE r.rolname=current_user
-- END CANONICAL ROLE QUERY
  ) AS checked;
  IF NOT FOUND OR v_role.purpose IS DISTINCT FROM 'web'
     OR v_role.tenant_tables_protected IS DISTINCT FROM true
     OR v_role.rolsuper IS DISTINCT FROM false OR v_role.rolbypassrls IS DISTINCT FROM false
     OR v_role.rolcreatedb IS DISTINCT FROM false OR v_role.rolcreaterole IS DISTINCT FROM false
     OR v_role.rolreplication IS DISTINCT FROM false OR v_role.owns_database IS DISTINCT FROM false
     OR v_role.owns_schema IS DISTINCT FROM false OR v_role.owns_application_tables IS DISTINCT FROM false
     OR v_role.schema_create IS DISTINCT FROM false OR v_role.elevated_membership IS DISTINCT FROM false
     OR v_role.can_change_role_registry IS DISTINCT FROM false OR v_role.can_read_legacy_leads IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_HOSTED_DATABASE_ROLE_REFUSED';
  END IF;
END;
$function$;


CREATE FUNCTION cpl_session_http.read_core_v1(p_token_hash text,p_now timestamptz,p_passkey boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_row record; v_organization uuid; v_member record; v_session jsonb; v_passkey boolean;
BEGIN
  PERFORM cpl_session_http.assert_web_v1();
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' OR p_now IS NULL OR NOT isfinite(p_now) OR p_passkey IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CPL_AUTHENTICATION_REQUIRED';
  END IF;
  -- Same current read contract: no row locks. Mutation/ceremony locks stay elsewhere.
  SELECT s.*,i.issuer,i.subject,i.email,i.email_verified,i.hosted_domain,i.display_name,
    EXISTS (SELECT 1 FROM public.cpl_platform_administrators a WHERE a.identity_id=i.id AND a.status='active') AS platform_administrator
    INTO v_row FROM public.cpl_sessions s JOIN public.cpl_identities i ON i.id=s.identity_id
    WHERE s.token_hash=p_token_hash AND s.revoked_at IS NULL AND s.expires_at>p_now AND s.absolute_expires_at>p_now
      AND s.csrf_token_hash IS NOT NULL AND i.status='active' AND i.email_verified=TRUE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_organization := v_row.selected_organization_id;
  IF v_organization IS NOT NULL THEN
    PERFORM set_config('cpl.organization_id',v_organization::text,true),set_config('cpl.identity_id',v_row.identity_id::text,true);
    SELECT m.identity_id INTO v_member FROM public.cpl_memberships m JOIN public.cpl_organizations o ON o.id=m.organization_id
      WHERE m.organization_id=v_organization AND m.identity_id=v_row.identity_id AND m.status='active' AND o.status='active';
    IF NOT FOUND THEN v_organization := NULL; END IF;
  END IF;
  v_session := jsonb_build_object(
    'id',v_row.id::text,'identityId',v_row.identity_id::text,'issuer',v_row.issuer,'subject',v_row.subject,
    'email',coalesce(v_row.email,'null'),'displayName',v_row.display_name,
    'createdAt',v_row.created_at,'authenticatedAt',v_row.authenticated_at,'expiresAt',v_row.expires_at,
    'absoluteExpiresAt',v_row.absolute_expires_at,'mfaVerifiedAt',v_row.mfa_verified_at,
    'selectedOrganizationId',v_organization,'csrfTokenHash',v_row.csrf_token_hash,
    'platformAdministrator',v_row.platform_administrator);
  IF NOT p_passkey THEN RETURN v_session; END IF;
  SELECT EXISTS (SELECT 1 FROM public.cpl_webauthn_credentials c JOIN public.cpl_identities i ON i.id=c.identity_id
    WHERE c.identity_id=v_row.identity_id AND i.status='active') INTO v_passkey;
  RETURN jsonb_build_object('session',v_session,'hasPasskey',v_passkey);
END;
$function$;

CREATE FUNCTION cpl_session_http.read_v1(p_token_hash text,p_now timestamptz) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $function$ SELECT cpl_session_http.read_core_v1(p_token_hash,p_now,false) $function$;

CREATE FUNCTION cpl_session_http.read_with_passkey_v1(p_token_hash text,p_now timestamptz) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $function$ SELECT cpl_session_http.read_core_v1(p_token_hash,p_now,true) $function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cpl_session_http FROM PUBLIC;
-- Fresh installations configure the exact web role after migration.
DO $grant_web$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='cpl_web_runtime') THEN
    IF NOT EXISTS (SELECT 1 FROM public.cpl_runtime_roles WHERE role_name='cpl_web_runtime' AND purpose='web') THEN
      RAISE EXCEPTION 'CPL_SESSION_HTTP_WEB_ROLE_REFUSED';
    END IF;
    GRANT USAGE ON SCHEMA cpl_session_http TO cpl_web_runtime;
    GRANT EXECUTE ON FUNCTION cpl_session_http.assert_web_v1(),cpl_session_http.read_core_v1(text,timestamptz,boolean),
      cpl_session_http.read_v1(text,timestamptz),cpl_session_http.read_with_passkey_v1(text,timestamptz) TO cpl_web_runtime;
  END IF;
END;
$grant_web$;

-- Reject unexpected default grants on new objects; preserve database defaults.
DO $verify_new_acl$
DECLARE v_schema oid; v_owner oid; v_web oid;
BEGIN
  SELECT oid,nspowner INTO STRICT v_schema,v_owner FROM pg_catalog.pg_namespace WHERE nspname='cpl_session_http';
  SELECT oid INTO v_web FROM pg_catalog.pg_roles WHERE rolname='cpl_web_runtime';
  IF v_owner IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'CPL_SESSION_HTTP_OBJECT_OWNER_REFUSED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
    WHERE n.oid=v_schema AND (a.grantor<>v_owner OR (a.grantee<>v_owner AND (v_web IS NULL OR a.grantee<>v_web)) OR (a.grantee=v_web AND (a.is_grantable OR a.privilege_type<>'USAGE')))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE p.pronamespace=v_schema AND (p.proowner<>v_owner OR p.prosecdef OR a.grantor<>v_owner OR (a.grantee<>v_owner AND (v_web IS NULL OR a.grantee<>v_web)) OR (a.grantee=v_web AND (a.is_grantable OR a.privilege_type<>'EXECUTE')))
  ) THEN RAISE EXCEPTION 'CPL_SESSION_HTTP_NEW_ACL_REFUSED'; END IF;
END;
$verify_new_acl$;
