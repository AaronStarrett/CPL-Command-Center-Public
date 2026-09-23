-- Tenant commercial spine; legacy drafts and all prior versions remain untouched.
CREATE TABLE cpl_commercial_branding (
  organization_id UUID PRIMARY KEY REFERENCES cpl_organizations(id),
  revision INTEGER NOT NULL CHECK (revision>0),
  configuration JSONB NOT NULL,
  updated_by_identity_id UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id,updated_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_commercial_templates (
  id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  name TEXT NOT NULL, snapshot JSONB NOT NULL, created_by_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_commercial_proposals (
  id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  reference TEXT NOT NULL, lead_id UUID NOT NULL, legacy_draft_id UUID,
  title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','review','approved','revision_requested','lost','withdrawn','awarded')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  current_version INTEGER NOT NULL CHECK(current_version>0), approved_version INTEGER,
  internal_notes TEXT NOT NULL DEFAULT '', created_by_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,id), UNIQUE(organization_id,reference), UNIQUE(organization_id,legacy_draft_id),
  CHECK(state NOT IN ('approved','awarded') OR (approved_version IS NOT NULL AND approved_version=current_version)),
  FOREIGN KEY(organization_id,lead_id) REFERENCES cpl_workflow_leads(organization_id,id),
  FOREIGN KEY(organization_id,legacy_draft_id) REFERENCES cpl_proposal_drafts(organization_id,id),
  FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE INDEX cpl_commercial_lead_idx ON cpl_commercial_proposals(organization_id,lead_id);
CREATE TABLE cpl_commercial_versions (
  organization_id UUID NOT NULL, proposal_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  snapshot JSONB NOT NULL, created_by_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(organization_id,proposal_id,version),
  FOREIGN KEY(organization_id,proposal_id) REFERENCES cpl_commercial_proposals(organization_id,id),
  FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
ALTER TABLE cpl_commercial_proposals ADD CONSTRAINT cpl_commercial_current_fk FOREIGN KEY(organization_id,id,current_version) REFERENCES cpl_commercial_versions(organization_id,proposal_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cpl_commercial_proposals ADD CONSTRAINT cpl_commercial_approved_fk FOREIGN KEY(organization_id,id,approved_version) REFERENCES cpl_commercial_versions(organization_id,proposal_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE cpl_commercial_events (
  id UUID PRIMARY KEY, organization_id UUID NOT NULL, proposal_id UUID NOT NULL,
  version INTEGER NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT,
  reason_code TEXT CHECK(reason_code IN ('price','competitor','timing','scope_changed','no_response','other')), note TEXT,
  CHECK(action<>'lost' OR reason_code IS NOT NULL),
  actor_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id,proposal_id,revision),
  FOREIGN KEY(organization_id,proposal_id,version) REFERENCES cpl_commercial_versions(organization_id,proposal_id,version),
  FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_commercial_awards (
  id UUID PRIMARY KEY, organization_id UUID NOT NULL, proposal_id UUID NOT NULL, proposal_version INTEGER NOT NULL,
  snapshot JSONB NOT NULL, actor_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id,id), UNIQUE(organization_id,proposal_id),
  UNIQUE(organization_id,id,proposal_id,proposal_version),
  FOREIGN KEY(organization_id,proposal_id,proposal_version) REFERENCES cpl_commercial_versions(organization_id,proposal_id,version),
  FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_commercial_projects (
  id UUID PRIMARY KEY, organization_id UUID NOT NULL, reference TEXT NOT NULL,
  award_id UUID NOT NULL, proposal_id UUID NOT NULL, proposal_version INTEGER NOT NULL, lead_id UUID NOT NULL,
  snapshot JSONB NOT NULL, created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id,id), UNIQUE(organization_id,reference), UNIQUE(organization_id,award_id),
  FOREIGN KEY(organization_id,award_id,proposal_id,proposal_version) REFERENCES cpl_commercial_awards(organization_id,id,proposal_id,proposal_version),
  FOREIGN KEY(organization_id,lead_id) REFERENCES cpl_workflow_leads(organization_id,id),
  FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_commercial_artifacts (
  id UUID PRIMARY KEY, organization_id UUID NOT NULL, proposal_id UUID NOT NULL, version INTEGER NOT NULL,
  projection_sha256 TEXT NOT NULL CHECK(projection_sha256 ~ '^[0-9a-f]{64}$'),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), renderer_version TEXT NOT NULL,
  bytes BYTEA NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 8 AND 5242880),
  created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(octet_length(bytes)=byte_length), CHECK(encode(sha256(bytes),'hex')=sha256),
  UNIQUE(organization_id,proposal_id,version),
  FOREIGN KEY(organization_id,proposal_id,version) REFERENCES cpl_commercial_versions(organization_id,proposal_id,version),
  FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE FUNCTION cpl_commercial_immutable_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'CPL_COMMERCIAL_RECORD_IMMUTABLE' USING ERRCODE='42501'; END;
$$;
REVOKE ALL ON FUNCTION cpl_commercial_immutable_record() FROM PUBLIC;
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['cpl_commercial_templates','cpl_commercial_versions','cpl_commercial_events','cpl_commercial_awards','cpl_commercial_projects','cpl_commercial_artifacts'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record()',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['cpl_commercial_branding','cpl_commercial_templates','cpl_commercial_proposals','cpl_commercial_versions','cpl_commercial_events','cpl_commercial_awards','cpl_commercial_projects','cpl_commercial_artifacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (organization_id::text=current_setting(''cpl.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''cpl.organization_id'',true))',name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
  END LOOP;
END; $$;
ALTER TABLE cpl_workflow_mutations DROP CONSTRAINT cpl_workflow_mutations_mutation_kind_check;
ALTER TABLE cpl_workflow_mutations ADD CONSTRAINT cpl_workflow_mutations_mutation_kind_check CHECK(mutation_kind IN ('lead.create','proposal.create','lead.evidence','directory.customer','directory.contact','directory.site','commercial.create','commercial.template','commercial.award','commercial.project'));
DO $$ DECLARE role_name NAME; BEGIN
  FOR role_name IN SELECT r.role_name FROM cpl_runtime_roles r JOIN pg_roles p ON p.rolname=r.role_name WHERE r.purpose='web' LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON cpl_commercial_branding,cpl_commercial_proposals TO %I',role_name);
    EXECUTE format('GRANT SELECT,INSERT ON cpl_commercial_templates,cpl_commercial_versions,cpl_commercial_events,cpl_commercial_awards,cpl_commercial_projects,cpl_commercial_artifacts TO %I',role_name);
  END LOOP;
END; $$;
