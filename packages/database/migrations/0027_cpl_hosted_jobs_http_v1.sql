-- Additive versioned HTTP jobs capability. No application records are changed.
-- The migration runner owns BEGIN/advisory lock/ledger/COMMIT; never wrap this file.
-- New namespace only: pre-existing cpl_jobs_http objects cause CREATE to fail.
DO $migration_owner$
BEGIN
  IF current_user IN ('cpl_worker_runtime','cpl_web_runtime') OR EXISTS
    (SELECT 1 FROM public.cpl_runtime_roles WHERE role_name=current_user) THEN
    RAISE EXCEPTION 'CPL_JOBS_HTTP_MIGRATION_OWNER_REFUSED';
  END IF;
END;
$migration_owner$;

CREATE SCHEMA cpl_jobs_http;
REVOKE ALL ON SCHEMA cpl_jobs_http FROM PUBLIC;

CREATE TYPE cpl_jobs_http.claim_snapshot_v1 AS (
  id uuid, organization_id uuid, proposal_id uuid, proposal_version integer,
  issued_by_identity_id uuid, issued_membership_version integer,
  attempts integer, max_attempts integer
);

CREATE FUNCTION cpl_jobs_http.assert_worker_v1() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_role record;
BEGIN
  -- These deadlines must already be armed by the preceding transaction query.
  -- Setting statement_timeout inside this function would not bound its own call.
  IF (extract(epoch FROM current_setting('statement_timeout')::interval)*1000)::integer IS DISTINCT FROM 4000
     OR (extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval)*1000)::integer IS DISTINCT FROM 4000 THEN
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
  IF NOT FOUND OR v_role.purpose IS DISTINCT FROM 'worker'
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

CREATE FUNCTION cpl_jobs_http.parse_claim_v1(p_claim jsonb)
RETURNS cpl_jobs_http.claim_snapshot_v1
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_claim cpl_jobs_http.claim_snapshot_v1; v_key text;
BEGIN
  IF jsonb_typeof(p_claim) IS DISTINCT FROM 'object' OR octet_length(p_claim::text)>2048 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_INVALID_JOB_INVOCATION';
  END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_claim) AS key)
     IS DISTINCT FROM ARRAY['attempts','id','issuedByIdentityId','issuedMembershipVersion','maxAttempts','organizationId','proposalId','proposalVersion'] THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_INVALID_JOB_INVOCATION';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['id','organizationId','proposalId','issuedByIdentityId'] LOOP
    IF jsonb_typeof(p_claim->v_key) IS DISTINCT FROM 'string'
       OR (p_claim->>v_key) !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_INVALID_JOB_INVOCATION';
    END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['proposalVersion','issuedMembershipVersion','attempts','maxAttempts'] LOOP
    IF jsonb_typeof(p_claim->v_key) IS DISTINCT FROM 'number'
       OR (p_claim->>v_key) !~ '^[1-9][0-9]{0,9}$'
       OR (p_claim->>v_key)::numeric>2147483647 THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_INVALID_JOB_INVOCATION';
    END IF;
  END LOOP;
  v_claim := ROW((p_claim->>'id')::uuid,(p_claim->>'organizationId')::uuid,(p_claim->>'proposalId')::uuid,
    (p_claim->>'proposalVersion')::integer,(p_claim->>'issuedByIdentityId')::uuid,
    (p_claim->>'issuedMembershipVersion')::integer,(p_claim->>'attempts')::integer,(p_claim->>'maxAttempts')::integer);
  IF v_claim.max_attempts>3 OR v_claim.attempts>v_claim.max_attempts THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_INVALID_JOB_INVOCATION';
  END IF;
  RETURN v_claim;
END;
$function$;

CREATE FUNCTION cpl_jobs_http.claim_v1(p_owner text,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_job record;
BEGIN
  PERFORM cpl_jobs_http.assert_worker_v1();
  IF p_owner IS NULL OR p_owner !~ '^[A-Za-z0-9._:-]{1,120}$' OR p_lease IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_INVALID_JOB_INVOCATION';
  END IF;
  SELECT id,attempts,max_attempts INTO v_job FROM public.cpl_workflow_jobs
    WHERE (status='queued' AND available_at<=CURRENT_TIMESTAMP) OR (status='running' AND lease_expires_at<=CURRENT_TIMESTAMP)
    ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','empty'); END IF;
  IF v_job.attempts>=v_job.max_attempts THEN
    UPDATE public.cpl_workflow_jobs SET status='failed',last_error_code='CPL_JOB_RETRY_EXHAUSTED',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=v_job.id;
    RETURN jsonb_build_object('status','exhausted','id',v_job.id);
  END IF;
  UPDATE public.cpl_workflow_jobs SET status='running',attempts=attempts+1,lease_token=p_lease,lease_owner=p_owner,
    lease_expires_at=CURRENT_TIMESTAMP+INTERVAL '30 seconds',updated_at=CURRENT_TIMESTAMP WHERE id=v_job.id
    RETURNING id,organization_id,proposal_id,proposal_version,issued_by_identity_id,issued_membership_version,attempts,max_attempts INTO v_job;
  RETURN jsonb_build_object('status','claimed','claim',jsonb_build_object(
    'id',v_job.id,'organizationId',v_job.organization_id,'proposalId',v_job.proposal_id,'proposalVersion',v_job.proposal_version,
    'issuedByIdentityId',v_job.issued_by_identity_id,'issuedMembershipVersion',v_job.issued_membership_version,
    'attempts',v_job.attempts,'maxAttempts',v_job.max_attempts));
END;
$function$;

CREATE FUNCTION cpl_jobs_http.process_v1(p_claim jsonb,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_claim cpl_jobs_http.claim_snapshot_v1; v_job record; v_draft record; v_access record;
  v_content text; v_sha text; v_count integer; v_superseded boolean;
BEGIN
  PERFORM cpl_jobs_http.assert_worker_v1();
  v_claim := cpl_jobs_http.parse_claim_v1(p_claim);
  IF p_lease IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_INVALID_JOB_INVOCATION'; END IF;
  PERFORM set_config('cpl.organization_id',v_claim.organization_id::text,true),set_config('cpl.identity_id',v_claim.issued_by_identity_id::text,true);
  SELECT id,organization_id,proposal_id,proposal_version,issued_by_identity_id,issued_membership_version,attempts,max_attempts INTO v_job
    FROM public.cpl_workflow_jobs WHERE organization_id=v_claim.organization_id AND id=v_claim.id AND status='running'
    AND lease_token=p_lease AND lease_expires_at>CURRENT_TIMESTAMP FOR UPDATE;
  IF NOT FOUND OR ROW(v_job.id,v_job.organization_id,v_job.proposal_id,v_job.proposal_version,v_job.issued_by_identity_id,v_job.issued_membership_version,v_job.attempts,v_job.max_attempts)
      IS DISTINCT FROM ROW(v_claim.id,v_claim.organization_id,v_claim.proposal_id,v_claim.proposal_version,v_claim.issued_by_identity_id,v_claim.issued_membership_version,v_claim.attempts,v_claim.max_attempts) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_JOB_LEASE_LOST';
  END IF;
  SELECT id,title,content,version INTO v_draft FROM public.cpl_proposal_drafts
    WHERE organization_id=v_claim.organization_id AND id=v_claim.proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_RECORD_NOT_FOUND'; END IF;
  -- Preserve canonical order: draft lock, live authorization SELECT, then the
  -- conditional preparation UPDATE. Worker metadata privileges remain SELECT-only.
  SELECT m.role,m.version INTO v_access FROM public.cpl_memberships m JOIN public.cpl_organizations o ON o.id=m.organization_id
    JOIN public.cpl_identities i ON i.id=m.identity_id JOIN public.cpl_module_entitlements e ON e.organization_id=m.organization_id AND e.module_key='proposal-builder'
    WHERE m.organization_id=v_claim.organization_id AND m.identity_id=v_claim.issued_by_identity_id
      AND m.status='active' AND i.status='active' AND o.status='active' AND e.enabled=TRUE AND (e.usage_limit IS NULL OR e.usage_limit>0)
      AND m.role IN ('owner','admin','manager','member','field-user');
  IF NOT FOUND OR v_access.version IS DISTINCT FROM v_claim.issued_membership_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_JOB_AUTHORIZATION_REVOKED';
  END IF;
  v_content := '# '||v_draft.title||E'\n\nProposal draft · version '||v_draft.version::text||E'\n\n'||v_draft.content||E'\n\n---\nManually supplied content. This draft has not been sent to a customer.\n';
  v_sha := encode(sha256(convert_to(v_content,'UTF8')),'hex');
  v_superseded := v_draft.version<>v_claim.proposal_version;
  IF NOT v_superseded THEN
    UPDATE public.cpl_proposal_drafts SET prepared_version=version,prepared_sha256=v_sha
      WHERE organization_id=v_claim.organization_id AND id=v_claim.proposal_id AND EXISTS (
        SELECT 1 FROM public.cpl_memberships m JOIN public.cpl_organizations o ON o.id=m.organization_id
        JOIN public.cpl_identities i ON i.id=m.identity_id JOIN public.cpl_module_entitlements e ON e.organization_id=m.organization_id AND e.module_key='proposal-builder'
        WHERE m.organization_id=v_claim.organization_id AND m.identity_id=v_claim.issued_by_identity_id AND m.version=v_claim.issued_membership_version
          AND m.status='active' AND i.status='active' AND o.status='active'
          AND e.enabled=TRUE AND (e.usage_limit IS NULL OR e.usage_limit>0)
          AND m.role IN ('owner','admin','manager','member','field-user'));
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count<>1 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_JOB_AUTHORIZATION_REVOKED'; END IF;
  END IF;
  UPDATE public.cpl_workflow_jobs SET status='completed',result_sha256=v_sha,last_error_code=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE organization_id=v_claim.organization_id AND id=v_claim.id AND lease_token=p_lease;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_JOB_LEASE_LOST'; END IF;
  INSERT INTO public.cpl_tenant_audit_events(id,organization_id,actor_identity_id,action,resource_id)
    VALUES(gen_random_uuid(),v_claim.organization_id,v_claim.issued_by_identity_id,
      CASE WHEN v_superseded THEN 'proposal.preparation-superseded' ELSE 'proposal.prepared' END,v_claim.proposal_id::text);
  RETURN jsonb_build_object('status',CASE WHEN v_superseded THEN 'superseded' ELSE 'completed' END);
END;
$function$;

CREATE FUNCTION cpl_jobs_http.retry_v1(p_claim jsonb,p_lease uuid,p_code text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_claim cpl_jobs_http.claim_snapshot_v1; v_terminal boolean; v_count integer;
BEGIN
  PERFORM cpl_jobs_http.assert_worker_v1();
  v_claim := cpl_jobs_http.parse_claim_v1(p_claim);
  IF p_lease IS NULL OR p_code IS NULL OR p_code NOT IN ('CPL_JOB_AUTHORIZATION_REVOKED','CPL_RECORD_NOT_FOUND','CPL_JOB_PROCESSING_FAILED') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_INVALID_JOB_INVOCATION';
  END IF;
  v_terminal := p_code IN ('CPL_JOB_AUTHORIZATION_REVOKED','CPL_RECORD_NOT_FOUND') OR v_claim.attempts>=v_claim.max_attempts;
  UPDATE public.cpl_workflow_jobs SET status=CASE WHEN v_terminal THEN 'failed' ELSE 'queued' END,last_error_code=p_code,
    available_at=CURRENT_TIMESTAMP+INTERVAL '1 minute',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE id=v_claim.id AND lease_token=p_lease AND status='running'
      AND ROW(organization_id,proposal_id,proposal_version,issued_by_identity_id,issued_membership_version,attempts,max_attempts)
       IS NOT DISTINCT FROM ROW(v_claim.organization_id,v_claim.proposal_id,v_claim.proposal_version,v_claim.issued_by_identity_id,v_claim.issued_membership_version,v_claim.attempts,v_claim.max_attempts);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CPL_JOB_LEASE_LOST'; END IF;
  RETURN jsonb_build_object('status',CASE WHEN v_terminal THEN 'failed' ELSE 'queued' END);
END;
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cpl_jobs_http FROM PUBLIC;
REVOKE ALL ON TYPE cpl_jobs_http.claim_snapshot_v1 FROM PUBLIC;

-- Fresh installations create runtime roles later. Existing hosted installations
-- grant only the exact worker role, after checking its registered purpose.
DO $grant_worker$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='cpl_worker_runtime') THEN
    IF NOT EXISTS (SELECT 1 FROM public.cpl_runtime_roles WHERE role_name='cpl_worker_runtime' AND purpose='worker') THEN
      RAISE EXCEPTION 'CPL_JOBS_HTTP_WORKER_ROLE_REFUSED';
    END IF;
    GRANT USAGE ON SCHEMA cpl_jobs_http TO cpl_worker_runtime;
GRANT USAGE ON TYPE cpl_jobs_http.claim_snapshot_v1 TO cpl_worker_runtime;
GRANT EXECUTE ON FUNCTION cpl_jobs_http.assert_worker_v1(),cpl_jobs_http.parse_claim_v1(jsonb),
  cpl_jobs_http.claim_v1(text,uuid),cpl_jobs_http.process_v1(jsonb,uuid),cpl_jobs_http.retry_v1(jsonb,uuid,text) TO cpl_worker_runtime;
  END IF;
END;
$grant_worker$;

-- Reject unexpected inherited default ACL grants on these NEW objects only.
-- Do not change database-wide default privileges or any existing object ACL.
DO $verify_new_acl$
DECLARE v_schema oid; v_owner oid; v_worker oid;
BEGIN
  SELECT oid,nspowner INTO STRICT v_schema,v_owner FROM pg_catalog.pg_namespace WHERE nspname='cpl_jobs_http';
  SELECT oid INTO v_worker FROM pg_catalog.pg_roles WHERE rolname='cpl_worker_runtime';
  IF v_owner IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'CPL_JOBS_HTTP_OBJECT_OWNER_REFUSED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
    WHERE n.oid=v_schema AND (a.grantor<>v_owner OR (a.grantee<>v_owner AND (v_worker IS NULL OR a.grantee<>v_worker)) OR (a.grantee=v_worker AND (a.is_grantable OR a.privilege_type<>'USAGE')))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE p.pronamespace=v_schema AND (p.proowner<>v_owner OR p.prosecdef OR a.grantor<>v_owner OR (a.grantee<>v_owner AND (v_worker IS NULL OR a.grantee<>v_worker)) OR (a.grantee=v_worker AND (a.is_grantable OR a.privilege_type<>'EXECUTE')))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(t.typacl,pg_catalog.acldefault('T',t.typowner))) a
    WHERE t.typnamespace=v_schema AND t.typname='claim_snapshot_v1' AND (t.typowner<>v_owner OR a.grantor<>v_owner OR (a.grantee<>v_owner AND (v_worker IS NULL OR a.grantee<>v_worker)) OR (a.grantee=v_worker AND (a.is_grantable OR a.privilege_type<>'USAGE')))
  ) THEN RAISE EXCEPTION 'CPL_JOBS_HTTP_NEW_ACL_REFUSED'; END IF;
END;
$verify_new_acl$;
