-- Additive company configuration. Immutable operational/source records are untouched.
CREATE TABLE cpl_catalog_items (
 organization_id UUID NOT NULL REFERENCES cpl_organizations(id), id UUID NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), code TEXT NOT NULL,
 workflow_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('active','archived')),
 snapshot JSONB NOT NULL, created_by_identity_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,workflow_key),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE UNIQUE INDEX cpl_catalog_code_idx ON cpl_catalog_items(organization_id,lower(code));
CREATE INDEX cpl_catalog_page_idx ON cpl_catalog_items(organization_id,created_at,id);
CREATE TABLE cpl_catalog_versions (
 organization_id UUID NOT NULL,id UUID NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN('active','archived')),snapshot JSONB NOT NULL,
 reason TEXT,actor_identity_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id,revision), FOREIGN KEY(organization_id,id) REFERENCES cpl_catalog_items(organization_id,id),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
-- Existing directory tables remain immutable identity and original-capture records.
CREATE TABLE cpl_directory_current (
 organization_id UUID NOT NULL,kind TEXT NOT NULL CHECK(kind IN('customer','contact','site')),id UUID NOT NULL,
 customer_record_id UUID GENERATED ALWAYS AS (CASE WHEN kind='customer' THEN id END) STORED,
 contact_record_id UUID GENERATED ALWAYS AS (CASE WHEN kind='contact' THEN id END) STORED,
 site_record_id UUID GENERATED ALWAYS AS (CASE WHEN kind='site' THEN id END) STORED,
 customer_id UUID,revision INTEGER NOT NULL CHECK(revision>0),status TEXT NOT NULL CHECK(status IN('active','archived')),
 snapshot JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,kind,id),
 FOREIGN KEY(organization_id,customer_record_id) REFERENCES cpl_customers(organization_id,id),
 FOREIGN KEY(organization_id,contact_record_id) REFERENCES cpl_contacts(organization_id,id),
 FOREIGN KEY(organization_id,site_record_id) REFERENCES cpl_sites(organization_id,id),
 FOREIGN KEY(organization_id,customer_id) REFERENCES cpl_customers(organization_id,id)
);
CREATE TABLE cpl_directory_versions (
 organization_id UUID NOT NULL,kind TEXT NOT NULL,id UUID NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN('active','archived')),snapshot JSONB NOT NULL,reason TEXT,
 actor_identity_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,kind,id,revision),
 FOREIGN KEY(organization_id,kind,id) REFERENCES cpl_directory_current(organization_id,kind,id),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_company_setting_versions (
 organization_id UUID NOT NULL,setting_key TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),
 value_json JSONB NOT NULL,actor_identity_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,setting_key,version),
 FOREIGN KEY(organization_id,setting_key) REFERENCES cpl_organization_settings(organization_id,setting_key),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_company_mutations (
 organization_id UUID NOT NULL REFERENCES cpl_organizations(id),kind TEXT NOT NULL,idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result_json JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(organization_id,kind,idempotency_key)
);
ALTER TABLE cpl_workflow_leads ADD COLUMN catalog_snapshot JSONB,
 ADD COLUMN custom_values JSONB NOT NULL DEFAULT '{}'::jsonb,
 ADD COLUMN reviewed_policy_version INTEGER CHECK(reviewed_policy_version>=0);
CREATE INDEX cpl_company_audit_page_idx ON cpl_tenant_audit_events(organization_id,created_at,id);
CREATE INDEX cpl_company_audit_actor_idx ON cpl_tenant_audit_events(organization_id,actor_identity_id,created_at,id);
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['cpl_catalog_items','cpl_catalog_versions','cpl_directory_current','cpl_directory_versions','cpl_company_setting_versions','cpl_company_mutations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(organization_id::text=current_setting(''cpl.organization_id'',true)) WITH CHECK(organization_id::text=current_setting(''cpl.organization_id'',true))',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['cpl_catalog_versions','cpl_directory_versions','cpl_company_setting_versions','cpl_company_mutations'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record()',name);
 END LOOP;
END; $$;
DO $$ DECLARE name NAME; BEGIN
 FOR name IN SELECT role_name FROM cpl_runtime_roles WHERE purpose='web' LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON cpl_catalog_items,cpl_directory_current TO %I',name);
  EXECUTE format('GRANT SELECT,INSERT ON cpl_catalog_versions,cpl_directory_versions,cpl_company_setting_versions,cpl_company_mutations TO %I',name);
 END LOOP;
 FOR name IN SELECT role_name FROM cpl_runtime_roles WHERE purpose='worker' AND automation_enabled LOOP
  EXECUTE format('GRANT SELECT ON cpl_catalog_items,cpl_catalog_versions,cpl_directory_current,cpl_organization_settings TO %I',name);
 END LOOP;
END; $$;
