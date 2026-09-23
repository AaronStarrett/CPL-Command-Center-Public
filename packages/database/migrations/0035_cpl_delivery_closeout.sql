-- Delivery truth is separate from document approval, export and invoice accounting.
CREATE TABLE cpl_delivery_packages (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, id UUID NOT NULL, reference TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), current_version INTEGER NOT NULL CHECK(current_version>0),
 state TEXT NOT NULL CHECK(state IN ('draft','ready','exported','manually_sent','acknowledged')),
 created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,project_id,id), UNIQUE(organization_id,reference),
 FOREIGN KEY(organization_id,project_id) REFERENCES cpl_commercial_projects(organization_id,id),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_delivery_versions (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, package_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 snapshot JSONB NOT NULL, prepared_by_identity_id UUID NOT NULL, prepared_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,package_id,version), UNIQUE(organization_id,project_id,package_id,version),
 FOREIGN KEY(organization_id,project_id,package_id) REFERENCES cpl_delivery_packages(organization_id,project_id,id),
 FOREIGN KEY(organization_id,prepared_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_delivery_attachments (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, package_id UUID NOT NULL, package_version INTEGER NOT NULL,
 report_id UUID NOT NULL, report_version INTEGER NOT NULL, sort_order INTEGER NOT NULL CHECK(sort_order>=0 AND sort_order<10),
 PRIMARY KEY(organization_id,package_id,package_version,report_id,report_version),
 UNIQUE(organization_id,package_id,package_version,sort_order),
 FOREIGN KEY(organization_id,project_id,package_id,package_version) REFERENCES cpl_delivery_versions(organization_id,project_id,package_id,version),
 FOREIGN KEY(organization_id,project_id,report_id,report_version) REFERENCES cpl_report_versions(organization_id,project_id,report_id,version),
 FOREIGN KEY(organization_id,report_id,report_version) REFERENCES cpl_report_artifacts(organization_id,report_id,version)
);
CREATE TABLE cpl_delivery_events (
 id UUID PRIMARY KEY, organization_id UUID NOT NULL, project_id UUID NOT NULL, package_id UUID NOT NULL,
 version INTEGER NOT NULL, action TEXT NOT NULL, details JSONB NOT NULL, actor_identity_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(organization_id,project_id,package_id,version) REFERENCES cpl_delivery_versions(organization_id,project_id,package_id,version),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE INDEX cpl_delivery_events_lookup ON cpl_delivery_events(organization_id,package_id,version,created_at,id);
CREATE TABLE cpl_report_approval_withdrawals (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, report_id UUID NOT NULL, version INTEGER NOT NULL,
 reason TEXT NOT NULL CHECK(length(btrim(reason))>0), actor_identity_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,report_id,version),
 FOREIGN KEY(organization_id,project_id,report_id,version) REFERENCES cpl_report_versions(organization_id,project_id,report_id,version),
 FOREIGN KEY(organization_id,report_id,version) REFERENCES cpl_report_artifacts(organization_id,report_id,version),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_closeout_policies (
 organization_id UUID NOT NULL, service_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 snapshot JSONB NOT NULL, created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,service_key,version),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_closeout_facts (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), snapshot JSONB NOT NULL,
 created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,project_id,revision),
 FOREIGN KEY(organization_id,project_id) REFERENCES cpl_commercial_projects(organization_id,id),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_closeout_overrides (
 id UUID PRIMARY KEY, organization_id UUID NOT NULL, project_id UUID NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), UNIQUE(organization_id,project_id,revision),
 fact_key TEXT NOT NULL CHECK(fact_key IN ('award','work','report','delivery','purchase_order','issues')),
 evidence_hash TEXT NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'), active BOOLEAN NOT NULL,
 reason TEXT NOT NULL CHECK(length(btrim(reason))>0), actor_identity_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(organization_id,project_id) REFERENCES cpl_commercial_projects(organization_id,id),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_delivery_mutations (
 organization_id UUID NOT NULL, mutation_kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), resource_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,mutation_kind,idempotency_key), FOREIGN KEY(organization_id) REFERENCES cpl_organizations(id)
);
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['cpl_delivery_packages','cpl_delivery_versions','cpl_delivery_attachments','cpl_delivery_events','cpl_report_approval_withdrawals','cpl_closeout_policies','cpl_closeout_facts','cpl_closeout_overrides','cpl_delivery_mutations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (organization_id::text=current_setting(''cpl.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''cpl.organization_id'',true))',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['cpl_delivery_versions','cpl_delivery_attachments','cpl_delivery_events','cpl_report_approval_withdrawals','cpl_closeout_policies','cpl_closeout_facts','cpl_closeout_overrides','cpl_delivery_mutations'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record()',name);
 END LOOP;
END; $$;
DO $$ DECLARE role_name NAME; BEGIN
 FOR role_name IN SELECT r.role_name FROM cpl_runtime_roles r JOIN pg_roles p ON p.rolname=r.role_name WHERE r.purpose='web' LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON cpl_delivery_packages TO %I',role_name);
  EXECUTE format('GRANT SELECT,INSERT ON cpl_delivery_versions,cpl_delivery_attachments,cpl_delivery_events,cpl_report_approval_withdrawals,cpl_closeout_policies,cpl_closeout_facts,cpl_closeout_overrides,cpl_delivery_mutations TO %I',role_name);
 END LOOP;
END; $$;
