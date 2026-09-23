-- Additive tenant intake. Existing global business records are deliberately untouched.
CREATE TABLE cpl_customers (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  created_by_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_contacts (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  customer_id UUID,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  email TEXT,
  phone TEXT NOT NULL DEFAULT '',
  created_by_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,customer_id) REFERENCES cpl_customers(organization_id,id),
  FOREIGN KEY (organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_sites (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  customer_id UUID,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  address TEXT NOT NULL DEFAULT '',
  created_by_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,customer_id) REFERENCES cpl_customers(organization_id,id),
  FOREIGN KEY (organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
ALTER TABLE cpl_workflow_leads
  ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('website_form','email','phone','manual','referral','in_person','crm_import')),
  ADD COLUMN customer_id UUID,
  ADD COLUMN customer_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN contact_id UUID,
  ADD COLUMN contact_phone TEXT NOT NULL DEFAULT '',
  ADD COLUMN site_id UUID,
  ADD COLUMN site_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN site_address TEXT NOT NULL DEFAULT '',
  ADD COLUMN requested_service TEXT NOT NULL DEFAULT '',
  ADD COLUMN received_at TIMESTAMPTZ,
  ADD COLUMN requested_deadline_at TIMESTAMPTZ,
  ADD COLUMN requested_visit_at TIMESTAMPTZ,
  ADD COLUMN assigned_member_identity_id UUID,
  ADD COLUMN next_action TEXT NOT NULL DEFAULT '',
  ADD COLUMN notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','needs_info','ready_for_proposal','disqualified')),
  ADD COLUMN disqualification_reason TEXT,
  ADD CONSTRAINT cpl_lead_customer_fk FOREIGN KEY (organization_id,customer_id) REFERENCES cpl_customers(organization_id,id),
  ADD CONSTRAINT cpl_lead_contact_fk FOREIGN KEY (organization_id,contact_id) REFERENCES cpl_contacts(organization_id,id),
  ADD CONSTRAINT cpl_lead_site_fk FOREIGN KEY (organization_id,site_id) REFERENCES cpl_sites(organization_id,id),
  ADD CONSTRAINT cpl_lead_assignee_fk FOREIGN KEY (organization_id,assigned_member_identity_id) REFERENCES cpl_memberships(organization_id,identity_id),
  ADD CONSTRAINT cpl_lead_disqualification_reason CHECK (status<>'disqualified' OR (disqualification_reason IS NOT NULL AND length(btrim(disqualification_reason))>0));
UPDATE cpl_workflow_leads SET received_at=created_at;
ALTER TABLE cpl_workflow_leads ALTER COLUMN received_at SET NOT NULL;
ALTER TABLE cpl_workflow_leads ALTER COLUMN received_at SET DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE cpl_lead_evidence (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  lead_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('initial_capture','source_reference','note')),
  label TEXT NOT NULL,
  reference TEXT,
  note TEXT,
  capture_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id,lead_id) REFERENCES cpl_workflow_leads(organization_id,id),
  FOREIGN KEY (organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE UNIQUE INDEX cpl_lead_initial_capture_idx ON cpl_lead_evidence(organization_id,lead_id) WHERE kind='initial_capture';
CREATE INDEX cpl_lead_evidence_scope_idx ON cpl_lead_evidence(organization_id,lead_id,created_at);
INSERT INTO cpl_lead_evidence(id,organization_id,lead_id,kind,label,note,capture_json,actor_identity_id)
SELECT id,organization_id,id,'initial_capture','Preserved record at structured-intake upgrade',details,to_jsonb(cpl_workflow_leads),created_by_identity_id FROM cpl_workflow_leads;
CREATE TABLE cpl_lead_review_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  lead_id UUID NOT NULL,
  lead_version INTEGER NOT NULL CHECK (lead_version>0),
  disposition TEXT NOT NULL CHECK (disposition IN ('unreviewed','distinct','duplicate')),
  reason TEXT,
  related_lead_id UUID,
  match_fingerprint TEXT NOT NULL,
  candidate_ids JSONB NOT NULL,
  actor_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (disposition='unreviewed' OR (reason IS NOT NULL AND length(btrim(reason))>0)),
  CHECK (disposition<>'duplicate' OR related_lead_id IS NOT NULL),
  CHECK (related_lead_id IS NULL OR related_lead_id<>lead_id),
  FOREIGN KEY (organization_id,lead_id) REFERENCES cpl_workflow_leads(organization_id,id),
  FOREIGN KEY (organization_id,related_lead_id) REFERENCES cpl_workflow_leads(organization_id,id),
  FOREIGN KEY (organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE INDEX cpl_lead_review_scope_idx ON cpl_lead_review_events(organization_id,lead_id,lead_version DESC);
CREATE FUNCTION cpl_intake_immutable_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'CPL_INTAKE_RECORD_IMMUTABLE' USING ERRCODE='42501'; END;
$$;
REVOKE ALL ON FUNCTION cpl_intake_immutable_record() FROM PUBLIC;
CREATE TRIGGER cpl_lead_evidence_immutable BEFORE UPDATE OR DELETE ON cpl_lead_evidence FOR EACH ROW EXECUTE FUNCTION cpl_intake_immutable_record();
CREATE TRIGGER cpl_lead_review_immutable BEFORE UPDATE OR DELETE ON cpl_lead_review_events FOR EACH ROW EXECUTE FUNCTION cpl_intake_immutable_record();
CREATE TRIGGER cpl_customer_immutable BEFORE UPDATE OR DELETE ON cpl_customers FOR EACH ROW EXECUTE FUNCTION cpl_intake_immutable_record();
CREATE TRIGGER cpl_contact_immutable BEFORE UPDATE OR DELETE ON cpl_contacts FOR EACH ROW EXECUTE FUNCTION cpl_intake_immutable_record();
CREATE TRIGGER cpl_site_immutable BEFORE UPDATE OR DELETE ON cpl_sites FOR EACH ROW EXECUTE FUNCTION cpl_intake_immutable_record();
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['cpl_customers','cpl_contacts','cpl_sites','cpl_lead_evidence','cpl_lead_review_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (organization_id::text=current_setting(''cpl.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''cpl.organization_id'',true))',table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
  END LOOP;
END;
$$;
ALTER TABLE cpl_workflow_mutations DROP CONSTRAINT cpl_workflow_mutations_mutation_kind_check;
ALTER TABLE cpl_workflow_mutations ADD CONSTRAINT cpl_workflow_mutations_mutation_kind_check CHECK (mutation_kind IN ('lead.create','proposal.create','lead.evidence','directory.customer','directory.contact','directory.site'));
-- Existing role names are operator-registered, never browser inputs. Fresh roles
-- receive the same grants through configureHostedRuntimeRole after migration.
DO $$
DECLARE role_name NAME;
BEGIN
  FOR role_name IN SELECT r.role_name FROM cpl_runtime_roles r JOIN pg_roles p ON p.rolname=r.role_name WHERE r.purpose='web' LOOP
    EXECUTE format('GRANT SELECT,INSERT ON cpl_customers,cpl_contacts,cpl_sites,cpl_lead_evidence,cpl_lead_review_events TO %I',role_name);
  END LOOP;
END;
$$;
