-- Durable original sources, normalization history and narrowly fenced intake work.
CREATE TABLE cpl_inbound_originals (
 organization_id UUID NOT NULL, id UUID NOT NULL,source_id UUID NOT NULL,source_kind TEXT NOT NULL CHECK(source_kind IN('public_form','signed_form','gmail')),
 account_id UUID,external_event_id TEXT NOT NULL,configuration_version INTEGER NOT NULL,generation INTEGER NOT NULL,
 content_sha256 TEXT NOT NULL CHECK(content_sha256~'^[a-f0-9]{64}$'),original_sha256 TEXT NOT NULL CHECK(original_sha256~'^[a-f0-9]{64}$'),
 media_type TEXT NOT NULL,original_bytes BYTEA NOT NULL CHECK(octet_length(original_bytes) BETWEEN 1 AND 4194304),
 source_claims JSONB NOT NULL,plain_text TEXT,attachments JSONB NOT NULL DEFAULT '[]',parse_issues JSONB NOT NULL DEFAULT '[]',
 mapping_id UUID NOT NULL,mapping_version INTEGER NOT NULL,provider_at TIMESTAMPTZ,received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,source_id,configuration_version) REFERENCES cpl_integration_source_versions(organization_id,source_id,version),
 FOREIGN KEY(organization_id,account_id) REFERENCES cpl_integration_accounts(organization_id,id),
 FOREIGN KEY(organization_id,mapping_id,mapping_version) REFERENCES cpl_inbound_mapping_versions(organization_id,id,version)
);
CREATE UNIQUE INDEX cpl_form_event_once ON cpl_inbound_originals(organization_id,source_id,external_event_id) WHERE account_id IS NULL;
CREATE UNIQUE INDEX cpl_gmail_message_once ON cpl_inbound_originals(organization_id,account_id,external_event_id) WHERE account_id IS NOT NULL;
CREATE TABLE cpl_inbound_receipts (
 organization_id UUID NOT NULL,id UUID NOT NULL,reference TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL CHECK(state IN('queued','processing','needs_review','linked_lead','rejected','failed','blocked')),
 processing_attempts INTEGER NOT NULL DEFAULT 0,linked_lead_id UUID,linked_lead_version INTEGER,last_issue JSONB,
 mapping_id UUID NOT NULL,mapping_version INTEGER NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,reference),
 FOREIGN KEY(organization_id,id) REFERENCES cpl_inbound_originals(organization_id,id),
 FOREIGN KEY(organization_id,linked_lead_id) REFERENCES cpl_workflow_leads(organization_id,id),
 FOREIGN KEY(organization_id,mapping_id,mapping_version) REFERENCES cpl_inbound_mapping_versions(organization_id,id,version)
);
CREATE TABLE cpl_inbound_normalizations (
 organization_id UUID NOT NULL,receipt_id UUID NOT NULL,version INTEGER NOT NULL,mapping_id UUID NOT NULL,mapping_version INTEGER NOT NULL,
 fields JSONB NOT NULL,issues JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,receipt_id,version),FOREIGN KEY(organization_id,receipt_id) REFERENCES cpl_inbound_receipts(organization_id,id),
 FOREIGN KEY(organization_id,mapping_id,mapping_version) REFERENCES cpl_inbound_mapping_versions(organization_id,id,version)
);
CREATE TABLE cpl_inbound_attempts (
 organization_id UUID NOT NULL,receipt_id UUID NOT NULL,number INTEGER NOT NULL,job_id UUID NOT NULL,
 state TEXT NOT NULL,issue JSONB,started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at TIMESTAMPTZ,
 PRIMARY KEY(organization_id,receipt_id,number),FOREIGN KEY(organization_id,receipt_id) REFERENCES cpl_inbound_receipts(organization_id,id),
 FOREIGN KEY(organization_id,job_id) REFERENCES cpl_workflow_jobs(organization_id,id)
);
CREATE TABLE cpl_inbound_nonces (
 organization_id UUID NOT NULL,source_id UUID NOT NULL,key_generation INTEGER NOT NULL,nonce_hash TEXT NOT NULL,body_sha256 TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(organization_id,source_id,key_generation,nonce_hash),FOREIGN KEY(organization_id,source_id) REFERENCES cpl_integration_sources(organization_id,id)
);
CREATE INDEX cpl_inbound_nonce_expiry ON cpl_inbound_nonces(expires_at);
-- No caller-controlled IP keys: at most one global row and one row per existing form.
CREATE TABLE cpl_inbound_rate_buckets (bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at TIMESTAMPTZ NOT NULL);
REVOKE ALL ON cpl_inbound_rate_buckets FROM PUBLIC;
ALTER TABLE cpl_workflow_jobs ADD COLUMN integration_source_id UUID,ADD COLUMN integration_generation INTEGER,
 ADD COLUMN integration_configuration_version INTEGER,ADD COLUMN inbound_receipt_id UUID;
ALTER TABLE cpl_workflow_jobs DROP CONSTRAINT cpl_job_kind;
ALTER TABLE cpl_workflow_jobs DROP CONSTRAINT cpl_job_shape;
ALTER TABLE cpl_workflow_jobs DROP CONSTRAINT cpl_job_attempt_budget;
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_kind CHECK(kind IN('proposal.prepare','automation.recipe','integration.gmail.sync','inbound.receipt.process'));
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_attempt_budget CHECK(max_attempts BETWEEN 1 AND 30 AND (kind<>'proposal.prepare' OR max_attempts<=3));
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_shape CHECK(
 (kind='proposal.prepare' AND proposal_id IS NOT NULL AND proposal_version IS NOT NULL AND event_id IS NULL AND recipe_id IS NULL AND integration_source_id IS NULL AND inbound_receipt_id IS NULL)
 OR (kind='automation.recipe' AND proposal_id IS NULL AND proposal_version IS NULL AND event_id IS NOT NULL AND recipe_id IS NOT NULL AND recipe_version IS NOT NULL AND integration_source_id IS NULL AND inbound_receipt_id IS NULL)
 OR (kind IN('integration.gmail.sync','inbound.receipt.process') AND proposal_id IS NULL AND proposal_version IS NULL AND event_id IS NULL AND recipe_id IS NULL AND recipe_version IS NULL AND integration_source_id IS NOT NULL AND integration_generation>0 AND integration_configuration_version>0 AND (kind='inbound.receipt.process')=(inbound_receipt_id IS NOT NULL)));
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_integration_source FOREIGN KEY(organization_id,integration_source_id,integration_configuration_version) REFERENCES cpl_integration_source_versions(organization_id,source_id,version);
ALTER TABLE cpl_workflow_jobs ADD CONSTRAINT cpl_job_inbound_receipt FOREIGN KEY(organization_id,inbound_receipt_id) REFERENCES cpl_inbound_receipts(organization_id,id);
CREATE UNIQUE INDEX cpl_inbound_active_job ON cpl_workflow_jobs(organization_id,inbound_receipt_id) WHERE kind='inbound.receipt.process' AND status IN('queued','running','retrying');
CREATE UNIQUE INDEX cpl_gmail_active_job ON cpl_workflow_jobs(organization_id,integration_source_id) WHERE kind='integration.gmail.sync' AND status IN('queued','running','retrying');
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['cpl_inbound_originals','cpl_inbound_receipts','cpl_inbound_normalizations','cpl_inbound_attempts','cpl_inbound_nonces'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(organization_id::text=current_setting(''cpl.organization_id'',true)) WITH CHECK(organization_id::text=current_setting(''cpl.organization_id'',true))',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['cpl_inbound_originals','cpl_inbound_normalizations'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record()',name);
 END LOOP;
END; $$;
DROP POLICY cpl_workflow_job_dispatch_read ON cpl_workflow_jobs;
DROP POLICY cpl_workflow_job_dispatch_update ON cpl_workflow_jobs;
DROP POLICY cpl_workflow_job_worker_kind ON cpl_workflow_jobs;
CREATE POLICY cpl_workflow_job_dispatch_read ON cpl_workflow_jobs FOR SELECT USING(
 EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker' AND
 (kind='proposal.prepare' OR (kind='automation.recipe' AND automation_enabled) OR (kind IN('integration.gmail.sync','inbound.receipt.process') AND ingestion_enabled))));
CREATE POLICY cpl_workflow_job_dispatch_update ON cpl_workflow_jobs FOR UPDATE USING(
 EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker' AND
 (kind='proposal.prepare' OR (kind='automation.recipe' AND automation_enabled) OR (kind IN('integration.gmail.sync','inbound.receipt.process') AND ingestion_enabled)))) WITH CHECK(
 EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker' AND
 (kind='proposal.prepare' OR (kind='automation.recipe' AND automation_enabled) OR (kind IN('integration.gmail.sync','inbound.receipt.process') AND ingestion_enabled))));
CREATE POLICY cpl_workflow_job_worker_kind ON cpl_workflow_jobs AS RESTRICTIVE USING(
 NOT EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker') OR EXISTS(
 SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker' AND
 (kind='proposal.prepare' OR (kind='automation.recipe' AND automation_enabled) OR (kind IN('integration.gmail.sync','inbound.receipt.process') AND ingestion_enabled)))) WITH CHECK(
 NOT EXISTS(SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker') OR EXISTS(
 SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker' AND
 (kind='proposal.prepare' OR (kind='automation.recipe' AND automation_enabled) OR (kind IN('integration.gmail.sync','inbound.receipt.process') AND ingestion_enabled))));

CREATE FUNCTION cpl_inbound_admission_budget(p_public_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n integer; form_id uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.cpl_runtime_roles WHERE role_name=session_user AND purpose='web') THEN RAISE EXCEPTION 'CPL_ACCESS_DENIED'; END IF;
 -- Global budget includes invalid IDs and invalid bodies; this function is committed separately.
 INSERT INTO public.cpl_inbound_rate_buckets(bucket,count,expires_at) VALUES('global',1,clock_timestamp()+interval '1 minute')
 ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN cpl_inbound_rate_buckets.expires_at<=clock_timestamp() THEN 1 ELSE LEAST(cpl_inbound_rate_buckets.count+1,1001) END,
 expires_at=CASE WHEN cpl_inbound_rate_buckets.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '1 minute' ELSE cpl_inbound_rate_buckets.expires_at END RETURNING count INTO n;
 IF n>1000 THEN RETURN FALSE; END IF;
 SELECT id INTO form_id FROM public.cpl_integration_sources WHERE public_id=p_public_id AND kind='form';
 IF form_id IS NULL THEN RETURN TRUE; END IF;
 INSERT INTO public.cpl_inbound_rate_buckets(bucket,count,expires_at) VALUES(form_id::text,1,clock_timestamp()+interval '1 minute')
 ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN cpl_inbound_rate_buckets.expires_at<=clock_timestamp() THEN 1 ELSE LEAST(cpl_inbound_rate_buckets.count+1,61) END,
 expires_at=CASE WHEN cpl_inbound_rate_buckets.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '1 minute' ELSE cpl_inbound_rate_buckets.expires_at END RETURNING count INTO n;
 RETURN n<=60;
END; $$;
REVOKE ALL ON FUNCTION cpl_inbound_admission_budget(text) FROM PUBLIC;
CREATE FUNCTION cpl_inbound_public_context(p_public_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s record;m record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.cpl_runtime_roles WHERE role_name=session_user AND purpose='web') THEN RAISE EXCEPTION 'CPL_ACCESS_DENIED'; END IF;
 SELECT * INTO s FROM public.cpl_integration_sources WHERE public_id=p_public_id AND kind='form';
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,38));
 SELECT * INTO s FROM public.cpl_integration_sources WHERE public_id=p_public_id AND kind='form' AND state='active' FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM set_config('cpl.organization_id',s.organization_id::text,true);
 SELECT member.role,member.version INTO m FROM public.cpl_memberships member JOIN public.cpl_identities identity ON identity.id=member.identity_id
 JOIN public.cpl_organizations organization ON organization.id=member.organization_id WHERE member.organization_id=s.organization_id AND member.identity_id=s.configured_by_identity_id
 AND member.status='active' AND identity.status='active' AND organization.status='active' FOR SHARE OF member,identity,organization;
 IF NOT FOUND OR m.version<>s.authorized_membership_version OR m.role NOT IN('owner','admin') THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.cpl_integration_source_versions v WHERE v.organization_id=s.organization_id AND v.source_id=s.id AND v.version=s.configuration_version AND v.configured_by_identity_id=s.configured_by_identity_id AND v.authorized_membership_version=s.authorized_membership_version) THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.cpl_module_entitlements WHERE organization_id=s.organization_id AND module_key='intake-job-tracker' AND enabled AND (usage_limit IS NULL OR usage_limit>0) FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('organizationId',s.organization_id,'identityId',s.configured_by_identity_id,'role',m.role,'membershipVersion',m.version,'sourceId',s.id,'generation',s.generation,'configurationVersion',s.configuration_version);
END; $$;
REVOKE ALL ON FUNCTION cpl_inbound_public_context(text) FROM PUBLIC;

CREATE FUNCTION cpl_ingestion_lock_authority(p_organization uuid,p_job uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j record;s record;v record;m record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.cpl_runtime_roles WHERE role_name=session_user AND purpose='worker' AND ingestion_enabled) THEN RAISE EXCEPTION 'CPL_INGESTION_WORKER_REFUSED'; END IF;
 PERFORM set_config('cpl.organization_id',p_organization::text,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_organization::text,38));
 SELECT * INTO j FROM public.cpl_workflow_jobs WHERE organization_id=p_organization AND id=p_job AND kind IN('integration.gmail.sync','inbound.receipt.process')
 AND status='running' AND lease_token=p_lease AND lease_expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CPL_INTEGRATION_LEASE_LOST'; END IF;
 SELECT * INTO s FROM public.cpl_integration_sources WHERE organization_id=p_organization AND id=j.integration_source_id FOR SHARE;
 IF NOT FOUND OR s.state<>'active' OR s.generation<>j.integration_generation OR s.configuration_version<>j.integration_configuration_version THEN RAISE EXCEPTION 'CPL_INTEGRATION_CONFIGURATION_CHANGED'; END IF;
 SELECT * INTO v FROM public.cpl_integration_source_versions WHERE organization_id=p_organization AND source_id=s.id AND version=s.configuration_version;
 IF NOT FOUND OR v.configured_by_identity_id<>j.issued_by_identity_id OR v.authorized_membership_version<>j.issued_membership_version
 OR s.configured_by_identity_id<>v.configured_by_identity_id OR s.authorized_membership_version<>v.authorized_membership_version THEN RAISE EXCEPTION 'CPL_INTEGRATION_AUTHORIZATION_REVOKED'; END IF;
 SELECT member.role,member.version INTO m FROM public.cpl_memberships member JOIN public.cpl_identities identity ON identity.id=member.identity_id
 JOIN public.cpl_organizations organization ON organization.id=member.organization_id WHERE member.organization_id=p_organization AND member.identity_id=j.issued_by_identity_id
 AND member.status='active' AND identity.status='active' AND organization.status='active' FOR SHARE OF member,identity,organization;
 IF NOT FOUND OR m.version<>j.issued_membership_version OR m.role NOT IN('owner','admin') THEN RAISE EXCEPTION 'CPL_INTEGRATION_AUTHORIZATION_REVOKED'; END IF;
 PERFORM 1 FROM public.cpl_module_entitlements WHERE organization_id=p_organization AND module_key='intake-job-tracker' AND enabled AND (usage_limit IS NULL OR usage_limit>0) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CPL_INTEGRATION_AUTHORIZATION_REVOKED'; END IF;
 PERFORM set_config('cpl.identity_id',j.issued_by_identity_id::text,true);
 RETURN jsonb_build_object('organizationId',p_organization,'identityId',j.issued_by_identity_id,'role',m.role,'membershipVersion',m.version);
END; $$;
REVOKE ALL ON FUNCTION cpl_ingestion_lock_authority(uuid,uuid,uuid) FROM PUBLIC;
