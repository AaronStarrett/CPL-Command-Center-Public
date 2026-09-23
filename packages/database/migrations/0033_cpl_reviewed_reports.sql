-- Reviewed report versions bind explicit public sources and immutable artifacts.
CREATE TABLE cpl_report_branding (
 organization_id UUID NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), configuration JSONB NOT NULL,
 created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,revision), FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_report_templates (
 organization_id UUID NOT NULL, id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0), snapshot JSONB NOT NULL,
 created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id,version), FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_reports (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, id UUID NOT NULL, reference TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), current_version INTEGER NOT NULL CHECK(current_version>0),
 state TEXT NOT NULL CHECK(state IN ('draft','in_review','changes_requested','approved')),
 title TEXT NOT NULL, created_by_identity_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,project_id,id), UNIQUE(organization_id,reference),
 FOREIGN KEY(organization_id,project_id) REFERENCES cpl_commercial_projects(organization_id,id),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_report_versions (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, report_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 snapshot JSONB NOT NULL, source_hash TEXT NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 template_id UUID NOT NULL, template_version INTEGER NOT NULL, branding_revision INTEGER NOT NULL,
 created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,report_id,version), UNIQUE(organization_id,project_id,report_id,version),
 FOREIGN KEY(organization_id,project_id,report_id) REFERENCES cpl_reports(organization_id,project_id,id),
 FOREIGN KEY(organization_id,template_id,template_version) REFERENCES cpl_report_templates(organization_id,id,version),
 FOREIGN KEY(organization_id,branding_revision) REFERENCES cpl_report_branding(organization_id,revision),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_report_events (
 id UUID PRIMARY KEY, organization_id UUID NOT NULL, project_id UUID NOT NULL, report_id UUID NOT NULL,
 action TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), version INTEGER NOT NULL CHECK(version>0),
 note TEXT NOT NULL DEFAULT '', actor_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(organization_id,project_id,report_id,version) REFERENCES cpl_report_versions(organization_id,project_id,report_id,version),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_report_attempts (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, report_id UUID NOT NULL, version INTEGER NOT NULL,
 id UUID NOT NULL, expected_revision INTEGER NOT NULL, artifact_object_id UUID NOT NULL UNIQUE,
 source_hash TEXT NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'), projection JSONB NOT NULL,
 approved_at TIMESTAMPTZ NOT NULL, prepared_by_identity_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,project_id,report_id,version,id),
 FOREIGN KEY(organization_id,project_id,report_id,version) REFERENCES cpl_report_versions(organization_id,project_id,report_id,version),
 FOREIGN KEY(organization_id,prepared_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_report_artifacts (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, report_id UUID NOT NULL, version INTEGER NOT NULL,
 attempt_id UUID NOT NULL, object_id UUID NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=67108864), renderer_version TEXT NOT NULL,
 source_hash TEXT NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'), approved_at TIMESTAMPTZ NOT NULL, approved_by_identity_id UUID NOT NULL,
 PRIMARY KEY(organization_id,report_id,version),
 FOREIGN KEY(organization_id,project_id,report_id,version,attempt_id) REFERENCES cpl_report_attempts(organization_id,project_id,report_id,version,id),
 FOREIGN KEY(organization_id,approved_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_report_mutations (
 organization_id UUID NOT NULL, mutation_kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), resource_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,mutation_kind,idempotency_key), FOREIGN KEY(organization_id) REFERENCES cpl_organizations(id)
);
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['cpl_report_branding','cpl_report_templates','cpl_reports','cpl_report_versions','cpl_report_events','cpl_report_attempts','cpl_report_artifacts','cpl_report_mutations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (organization_id::text=current_setting(''cpl.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''cpl.organization_id'',true))',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['cpl_report_branding','cpl_report_templates','cpl_report_versions','cpl_report_events','cpl_report_attempts','cpl_report_artifacts','cpl_report_mutations'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record()',name);
 END LOOP;
END; $$;
DO $$ DECLARE role_name NAME; BEGIN
 FOR role_name IN SELECT r.role_name FROM cpl_runtime_roles r JOIN pg_roles p ON p.rolname=r.role_name WHERE r.purpose='web' LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON cpl_reports TO %I',role_name);
  EXECUTE format('GRANT SELECT,INSERT ON cpl_report_branding,cpl_report_templates,cpl_report_versions,cpl_report_events,cpl_report_attempts,cpl_report_artifacts,cpl_report_mutations TO %I',role_name);
 END LOOP;
END; $$;
