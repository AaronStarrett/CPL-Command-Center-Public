-- Additive integration control plane. No provider credentials or company data seeded.
ALTER TABLE cpl_runtime_roles ADD COLUMN ingestion_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE cpl_integration_sources (
 organization_id UUID NOT NULL REFERENCES cpl_organizations(id),id UUID NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('gmail','form')),revision INTEGER NOT NULL CHECK(revision>0),
 generation INTEGER NOT NULL CHECK(generation>0),configuration_version INTEGER NOT NULL CHECK(configuration_version>0),
 state TEXT NOT NULL CHECK(state IN('unconfigured','authorization_required','active','paused','reconnect_required','failed','disconnected')),
 mode TEXT NOT NULL CHECK(mode IN('disabled','local_fixture','live')),public_id TEXT UNIQUE,
 configured_by_identity_id UUID NOT NULL,authorized_membership_version INTEGER NOT NULL CHECK(authorized_membership_version>0),
 account_id UUID,history_id TEXT,page_json JSONB,coverage TEXT NOT NULL DEFAULT 'not_started',
 next_eligible_at TIMESTAMPTZ,last_attempt_at TIMESTAMPTZ,last_success_at TIMESTAMPTZ,last_issue JSONB,
 operation_token UUID,operation_expires_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,configured_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id),
 CHECK((kind='form' AND public_id IS NOT NULL) OR (kind='gmail' AND public_id IS NULL))
);
CREATE TABLE cpl_integration_source_versions (
 organization_id UUID NOT NULL,source_id UUID NOT NULL,version INTEGER NOT NULL CHECK(version>0),
 input JSONB NOT NULL,configured_by_identity_id UUID NOT NULL,authorized_membership_version INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(organization_id,source_id,version),
 FOREIGN KEY(organization_id,source_id) REFERENCES cpl_integration_sources(organization_id,id),
 FOREIGN KEY(organization_id,configured_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_integration_accounts (
 organization_id UUID NOT NULL REFERENCES cpl_organizations(id),id UUID NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(organization_id,id),UNIQUE(organization_id,issuer,subject)
);
ALTER TABLE cpl_integration_sources ADD CONSTRAINT cpl_integration_account_fk FOREIGN KEY(organization_id,account_id) REFERENCES cpl_integration_accounts(organization_id,id);
CREATE TABLE cpl_integration_credentials (
 organization_id UUID NOT NULL,source_id UUID NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN('gmail_tokens','signed_intake_key')),
 revision INTEGER NOT NULL CHECK(revision>0),envelope JSONB NOT NULL,scopes JSONB NOT NULL DEFAULT '[]',key_id TEXT,key_generation INTEGER NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(organization_id,source_id,purpose),
 FOREIGN KEY(organization_id,source_id) REFERENCES cpl_integration_sources(organization_id,id)
);
CREATE TABLE cpl_integration_oauth_attempts (
 organization_id UUID NOT NULL,source_id UUID NOT NULL,state_hash TEXT NOT NULL CHECK(state_hash~'^[a-f0-9]{64}$'),
 session_id UUID NOT NULL REFERENCES cpl_sessions(id),identity_id UUID NOT NULL,membership_version INTEGER NOT NULL,
 generation INTEGER NOT NULL,envelope JSONB NOT NULL,expires_at TIMESTAMPTZ NOT NULL,consumed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(organization_id,state_hash),UNIQUE(state_hash),
 FOREIGN KEY(organization_id,source_id) REFERENCES cpl_integration_sources(organization_id,id),
 FOREIGN KEY(organization_id,identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE INDEX cpl_integration_oauth_expiry ON cpl_integration_oauth_attempts(expires_at);
CREATE TABLE cpl_inbound_mapping_versions (
 organization_id UUID NOT NULL REFERENCES cpl_organizations(id),id UUID NOT NULL,version INTEGER NOT NULL CHECK(version>0),input JSONB NOT NULL,
 created_by_identity_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(organization_id,id,version),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_integration_mutations (
 organization_id UUID NOT NULL REFERENCES cpl_organizations(id),kind TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(organization_id,kind,idempotency_key)
);
CREATE TABLE cpl_integration_events (
 organization_id UUID NOT NULL,source_id UUID NOT NULL,id UUID NOT NULL,action TEXT NOT NULL,actor_identity_id UUID NOT NULL,
 revision INTEGER NOT NULL,generation INTEGER NOT NULL,reason TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,source_id) REFERENCES cpl_integration_sources(organization_id,id),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['cpl_integration_sources','cpl_integration_source_versions','cpl_integration_accounts','cpl_integration_credentials','cpl_integration_oauth_attempts','cpl_inbound_mapping_versions','cpl_integration_mutations','cpl_integration_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(organization_id::text=current_setting(''cpl.organization_id'',true)) WITH CHECK(organization_id::text=current_setting(''cpl.organization_id'',true))',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['cpl_integration_source_versions','cpl_integration_accounts','cpl_inbound_mapping_versions','cpl_integration_mutations','cpl_integration_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record()',name);
 END LOOP;
END; $$;
-- Callback ownership is resolved solely from a single-use state and its exact
-- initiating live session, never a selected-company header or provider claims.
CREATE FUNCTION cpl_integration_oauth_context(p_state_hash text,p_session_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.cpl_runtime_roles WHERE role_name=session_user AND purpose='web') THEN RAISE EXCEPTION 'CPL_ACCESS_DENIED'; END IF;
 SELECT jsonb_build_object('organizationId',a.organization_id,'connectionId',a.source_id) INTO result
 FROM public.cpl_integration_oauth_attempts a JOIN public.cpl_sessions s ON s.id=a.session_id JOIN public.cpl_identities i ON i.id=s.identity_id
 WHERE a.state_hash=p_state_hash AND s.token_hash=p_session_hash AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND (s.absolute_expires_at IS NULL OR s.absolute_expires_at>clock_timestamp()) AND i.status='active' AND a.identity_id=s.identity_id
 AND a.expires_at>clock_timestamp() AND a.consumed_at IS NULL;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION cpl_integration_oauth_context(text,text) FROM PUBLIC;
