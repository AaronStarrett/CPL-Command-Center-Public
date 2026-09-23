-- Operational execution extends immutable awarded projects; no legacy business rows change.
CREATE TABLE cpl_project_operations (
  organization_id UUID NOT NULL, project_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','on_hold','completed','cancelled')),
  owner_identity_id UUID, snapshot JSONB NOT NULL,
  updated_by_identity_id UUID NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(organization_id,project_id),
  FOREIGN KEY(organization_id,project_id) REFERENCES cpl_commercial_projects(organization_id,id),
  FOREIGN KEY(organization_id,owner_identity_id) REFERENCES cpl_memberships(organization_id,identity_id),
  FOREIGN KEY(organization_id,updated_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_project_team (
  organization_id UUID NOT NULL, project_id UUID NOT NULL, identity_id UUID NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY(organization_id,project_id,identity_id),
  FOREIGN KEY(organization_id,project_id) REFERENCES cpl_commercial_projects(organization_id,id),
  FOREIGN KEY(organization_id,identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_project_visits (
  id UUID PRIMARY KEY, organization_id UUID NOT NULL, project_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  status TEXT NOT NULL CHECK(status IN ('draft','scheduled','in_progress','completed','cancelled')),
  responsible_identity_id UUID, planned_start_at TIMESTAMPTZ, planned_end_at TIMESTAMPTZ,
  snapshot JSONB NOT NULL, created_by_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id,id), UNIQUE(organization_id,project_id,id),
  CHECK((planned_start_at IS NULL AND planned_end_at IS NULL) OR (planned_start_at IS NOT NULL AND planned_end_at IS NOT NULL AND planned_end_at>planned_start_at)),
  CHECK(status NOT IN ('scheduled','in_progress','completed') OR (responsible_identity_id IS NOT NULL AND planned_start_at IS NOT NULL)),
  FOREIGN KEY(organization_id,project_id) REFERENCES cpl_commercial_projects(organization_id,id),
  FOREIGN KEY(organization_id,responsible_identity_id) REFERENCES cpl_memberships(organization_id,identity_id),
  FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE INDEX cpl_project_visit_agenda_idx ON cpl_project_visits(organization_id,planned_start_at,planned_end_at);
CREATE INDEX cpl_project_visit_assignment_idx ON cpl_project_visits(organization_id,responsible_identity_id,planned_start_at) WHERE status IN ('scheduled','in_progress');
CREATE TABLE cpl_project_tasks (
  id UUID PRIMARY KEY, organization_id UUID NOT NULL, project_id UUID NOT NULL, visit_id UUID NOT NULL,
  snapshot JSONB NOT NULL, sort_order INTEGER NOT NULL CHECK(sort_order>=0), removed BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,project_id,visit_id) REFERENCES cpl_project_visits(organization_id,project_id,id)
);
CREATE TABLE cpl_execution_events (
  id UUID PRIMARY KEY, organization_id UUID NOT NULL, project_id UUID NOT NULL, visit_id UUID,
  action TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), before_snapshot JSONB, after_snapshot JSONB NOT NULL,
  actor_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(organization_id,project_id) REFERENCES cpl_commercial_projects(organization_id,id),
  FOREIGN KEY(organization_id,project_id,visit_id) REFERENCES cpl_project_visits(organization_id,project_id,id),
  FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE INDEX cpl_execution_events_project_idx ON cpl_execution_events(organization_id,project_id,created_at,id);
CREATE TABLE cpl_execution_mutations (
  organization_id UUID NOT NULL, mutation_kind TEXT NOT NULL CHECK(mutation_kind IN ('project.save','visit.create','visit.save')),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), resource_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(organization_id,mutation_kind,idempotency_key),
  FOREIGN KEY(organization_id) REFERENCES cpl_organizations(id)
);
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['cpl_project_operations','cpl_project_team','cpl_project_visits','cpl_project_tasks','cpl_execution_events','cpl_execution_mutations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (organization_id::text=current_setting(''cpl.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''cpl.organization_id'',true))',name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['cpl_execution_events','cpl_execution_mutations'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record()',name);
  END LOOP;
END; $$;
DO $$ DECLARE role_name NAME; BEGIN
  FOR role_name IN SELECT r.role_name FROM cpl_runtime_roles r JOIN pg_roles p ON p.rolname=r.role_name WHERE r.purpose='web' LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON cpl_project_operations,cpl_project_team,cpl_project_visits,cpl_project_tasks TO %I',role_name);
    EXECUTE format('GRANT SELECT,INSERT ON cpl_execution_events,cpl_execution_mutations TO %I',role_name);
  END LOOP;
END; $$;
