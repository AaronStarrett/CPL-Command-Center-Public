-- Forward tenant automation extension. Existing history and proposal.prepare jobs are preserved.
ALTER TABLE cpl_runtime_roles ADD COLUMN automation_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE cpl_automation_recipes (
 organization_id UUID NOT NULL REFERENCES cpl_organizations(id), id UUID NOT NULL,
 current_version INTEGER NOT NULL CHECK(current_version>0), enabled BOOLEAN NOT NULL,
 trigger_type TEXT NOT NULL CHECK(trigger_type IN ('lead.ready','proposal.awarded','fieldwork.submitted','report.approved','delivery.recorded')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id)
);
CREATE TABLE cpl_automation_recipe_versions (
 organization_id UUID NOT NULL, recipe_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 configuration JSONB NOT NULL, configured_by_identity_id UUID NOT NULL,
 authorized_membership_version INTEGER NOT NULL CHECK(authorized_membership_version>0),
 configured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,recipe_id,version),
 FOREIGN KEY(organization_id,recipe_id) REFERENCES cpl_automation_recipes(organization_id,id),
 FOREIGN KEY(organization_id,configured_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_business_events (
 organization_id UUID NOT NULL REFERENCES cpl_organizations(id), id UUID NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('lead.ready','proposal.awarded','fieldwork.submitted','report.approved','delivery.recorded')),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('lead','proposal','visit','report','delivery')),
 source_id UUID NOT NULL, source_version INTEGER NOT NULL CHECK(source_version>0), project_id UUID,
 actor_identity_id UUID NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('human','automation')),
 causation_execution_id UUID, context JSONB NOT NULL DEFAULT '{}', occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,event_type,source_id,source_version),
 FOREIGN KEY(organization_id,project_id) REFERENCES cpl_commercial_projects(organization_id,id),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
ALTER TABLE cpl_workflow_jobs ALTER COLUMN proposal_id DROP NOT NULL;
ALTER TABLE cpl_workflow_jobs ALTER COLUMN proposal_version DROP NOT NULL;
ALTER TABLE cpl_workflow_jobs DROP CONSTRAINT cpl_workflow_jobs_kind_check;
ALTER TABLE cpl_workflow_jobs DROP CONSTRAINT cpl_workflow_jobs_status_check;
ALTER TABLE cpl_workflow_jobs DROP CONSTRAINT cpl_workflow_jobs_max_attempts_check;
ALTER TABLE cpl_workflow_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE cpl_workflow_jobs ADD COLUMN event_id UUID;
ALTER TABLE cpl_workflow_jobs ADD COLUMN recipe_id UUID;
ALTER TABLE cpl_workflow_jobs ADD COLUMN recipe_version INTEGER;
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_kind CHECK(kind IN ('proposal.prepare','automation.recipe'));
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_attempt_budget CHECK(max_attempts BETWEEN 1 AND 30 AND (kind='automation.recipe' OR max_attempts<=3));
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_status CHECK(status IN ('queued','running','completed','retrying','failed','skipped','cancelled'));
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_shape CHECK(
 (kind='proposal.prepare' AND proposal_id IS NOT NULL AND proposal_version IS NOT NULL AND event_id IS NULL AND recipe_id IS NULL AND recipe_version IS NULL)
 OR (kind='automation.recipe' AND proposal_id IS NULL AND proposal_version IS NULL AND event_id IS NOT NULL AND recipe_id IS NOT NULL AND recipe_version IS NOT NULL));
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_event FOREIGN KEY(organization_id,event_id) REFERENCES cpl_business_events(organization_id,id);
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_recipe FOREIGN KEY(organization_id,recipe_id,recipe_version) REFERENCES cpl_automation_recipe_versions(organization_id,recipe_id,version);
CREATE UNIQUE INDEX cpl_recipe_event_once ON cpl_workflow_jobs(organization_id,event_id,recipe_id) WHERE kind='automation.recipe';
ALTER TABLE cpl_business_events ADD CONSTRAINT cpl_event_cause FOREIGN KEY(organization_id,causation_execution_id) REFERENCES cpl_workflow_jobs(organization_id,id);
CREATE TABLE cpl_automation_steps (
 organization_id UUID NOT NULL, execution_id UUID NOT NULL, step_key TEXT NOT NULL,
 result JSONB NOT NULL, completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,execution_id,step_key),
 FOREIGN KEY(organization_id,execution_id) REFERENCES cpl_workflow_jobs(organization_id,id)
);
CREATE TABLE cpl_automation_attempts (
 organization_id UUID NOT NULL, execution_id UUID NOT NULL, attempt INTEGER NOT NULL CHECK(attempt>0),
 started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMPTZ,
 status TEXT NOT NULL CHECK(status IN ('running','succeeded','retrying','failed','skipped','cancelled')), error_code TEXT,
 PRIMARY KEY(organization_id,execution_id,attempt),
 FOREIGN KEY(organization_id,execution_id) REFERENCES cpl_workflow_jobs(organization_id,id)
);
CREATE TABLE cpl_action_tasks (
 organization_id UUID NOT NULL, id UUID NOT NULL, execution_id UUID, step_key TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), title TEXT NOT NULL, reason TEXT NOT NULL, task_group TEXT NOT NULL,
 target JSONB NOT NULL, owner JSONB NOT NULL, due_at TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed','dismissed','cancelled','blocked')),
 resolution_reason TEXT, display_context JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,execution_id,step_key),
 FOREIGN KEY(organization_id,execution_id) REFERENCES cpl_workflow_jobs(organization_id,id)
);
CREATE UNIQUE INDEX cpl_source_attention_once ON cpl_action_tasks(organization_id,step_key) WHERE execution_id IS NULL;
CREATE TABLE cpl_action_task_events (
 organization_id UUID NOT NULL, id UUID NOT NULL, task_id UUID NOT NULL, revision INTEGER NOT NULL,
 action TEXT NOT NULL, actor_identity_id UUID NOT NULL, reason TEXT NOT NULL DEFAULT '', snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(organization_id,id),
 FOREIGN KEY(organization_id,task_id) REFERENCES cpl_action_tasks(organization_id,id),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_automation_mutations (
 organization_id UUID NOT NULL REFERENCES cpl_organizations(id), mutation_kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), resource_id UUID NOT NULL, details JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(organization_id,mutation_kind,idempotency_key)
);
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['cpl_automation_recipes','cpl_automation_recipe_versions','cpl_business_events','cpl_automation_steps','cpl_automation_attempts','cpl_action_tasks','cpl_action_task_events','cpl_automation_mutations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (organization_id::text=current_setting(''cpl.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''cpl.organization_id'',true))',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['cpl_automation_recipe_versions','cpl_business_events','cpl_automation_steps','cpl_action_task_events','cpl_automation_mutations'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record()',name);
 END LOOP;
END; $$;
-- Existing HTTP worker functions see only their historical kind. Only an explicitly
-- provisioned separate automation worker can see new jobs before setting tenant scope.
DROP POLICY cpl_workflow_job_dispatch_read ON cpl_workflow_jobs;
DROP POLICY cpl_workflow_job_dispatch_update ON cpl_workflow_jobs;
CREATE POLICY cpl_workflow_job_dispatch_read ON cpl_workflow_jobs FOR SELECT USING (
 EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker' AND (kind='proposal.prepare' OR automation_enabled)));
CREATE POLICY cpl_workflow_job_dispatch_update ON cpl_workflow_jobs FOR UPDATE USING (
 EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker' AND (kind='proposal.prepare' OR automation_enabled))) WITH CHECK (
 EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker' AND (kind='proposal.prepare' OR automation_enabled)));
CREATE POLICY cpl_workflow_job_worker_kind ON cpl_workflow_jobs AS RESTRICTIVE USING (
 NOT EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker')
 OR kind='proposal.prepare'
 OR EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker' AND automation_enabled)) WITH CHECK (
 NOT EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker')
 OR kind='proposal.prepare'
 OR EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker' AND automation_enabled));
-- Authorization row locks without granting the worker write access to identities,
-- roles or entitlements. Scope and actor derive from a durable live fenced job.
CREATE FUNCTION cpl_automation_lock_authority(p_organization uuid,p_job uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j record; r record; m record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.cpl_runtime_roles WHERE role_name=session_user AND purpose='worker' AND automation_enabled) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CPL_AUTOMATION_WORKER_REFUSED';
 END IF;
 PERFORM set_config('cpl.organization_id',p_organization::text,true);
 SELECT * INTO j FROM public.cpl_workflow_jobs WHERE organization_id=p_organization AND id=p_job
  AND kind='automation.recipe' AND status='running' AND lease_token=p_lease AND lease_expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CPL_JOB_LEASE_LOST'; END IF;
 SELECT * INTO r FROM public.cpl_automation_recipes WHERE organization_id=j.organization_id AND id=j.recipe_id FOR SHARE;
 IF NOT FOUND OR NOT r.enabled OR r.current_version<>j.recipe_version THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CPL_AUTOMATION_CONFIGURATION_CHANGED';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.cpl_automation_recipe_versions v
   JOIN public.cpl_business_events b ON b.organization_id=v.organization_id AND b.id=j.event_id
   WHERE v.organization_id=j.organization_id AND v.recipe_id=j.recipe_id AND v.version=j.recipe_version
     AND v.configured_by_identity_id=j.issued_by_identity_id AND v.authorized_membership_version=j.issued_membership_version
     AND b.event_type=r.trigger_type AND v.configuration->>'trigger'=b.event_type AND b.origin='human') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CPL_AUTOMATION_AUTHORIZATION_REVOKED';
 END IF;
 -- Hold all potentially selected active membership/identity rows so assignment and
 -- source-assignee revocation cannot race the already-authorized action commit.
 PERFORM 1 FROM public.cpl_memberships member JOIN public.cpl_identities identity ON identity.id=member.identity_id
  WHERE member.organization_id=j.organization_id FOR SHARE OF member,identity;
 SELECT member.role,member.version INTO m FROM public.cpl_memberships member
  JOIN public.cpl_identities identity ON identity.id=member.identity_id
  JOIN public.cpl_organizations organization ON organization.id=member.organization_id
  WHERE member.organization_id=j.organization_id AND member.identity_id=j.issued_by_identity_id
   AND member.status='active' AND identity.status='active' AND organization.status='active' FOR SHARE OF member,identity,organization;
 IF NOT FOUND OR m.version<>j.issued_membership_version OR m.role NOT IN ('owner','admin') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CPL_AUTOMATION_AUTHORIZATION_REVOKED';
 END IF;
 PERFORM 1 FROM public.cpl_module_entitlements WHERE organization_id=j.organization_id FOR SHARE;
 PERFORM set_config('cpl.identity_id',j.issued_by_identity_id::text,true);
 RETURN jsonb_build_object('organizationId',j.organization_id,'identityId',j.issued_by_identity_id,'role',m.role,'membershipVersion',m.version);
END; $$;
REVOKE ALL ON FUNCTION cpl_automation_lock_authority(uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE runtime_role NAME; BEGIN
 FOR runtime_role IN SELECT role_name FROM cpl_runtime_roles WHERE purpose='web' LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON cpl_automation_recipes,cpl_action_tasks TO %I',runtime_role);
  EXECUTE format('GRANT SELECT,INSERT ON cpl_automation_recipe_versions,cpl_business_events,cpl_automation_steps,cpl_action_task_events,cpl_automation_mutations TO %I',runtime_role);
  EXECUTE format('GRANT SELECT ON cpl_automation_attempts TO %I',runtime_role);
 END LOOP;
END; $$;
