-- Tenant-scoped, versioned field evidence. Originals and historical revisions
-- are retained; this migration grants no evidence deletion capability.
CREATE TABLE cpl_field_templates (
 organization_id UUID NOT NULL, id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0), snapshot JSONB NOT NULL,
 created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id,version),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_field_records (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, visit_id UUID NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), template_id UUID NOT NULL, template_version INTEGER NOT NULL,
 answers JSONB NOT NULL DEFAULT '[]', updated_by_identity_id UUID NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,project_id,visit_id),
 FOREIGN KEY(organization_id,project_id,visit_id) REFERENCES cpl_project_visits(organization_id,project_id,id),
 FOREIGN KEY(organization_id,template_id,template_version) REFERENCES cpl_field_templates(organization_id,id,version),
 FOREIGN KEY(organization_id,updated_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_field_checklist_revisions (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, visit_id UUID NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 answers JSONB NOT NULL, created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,project_id,visit_id,revision),
 FOREIGN KEY(organization_id,project_id,visit_id) REFERENCES cpl_field_records(organization_id,project_id,visit_id),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_field_observations (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, visit_id UUID NOT NULL, id UUID NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), snapshot JSONB NOT NULL, created_by_identity_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,project_id,visit_id,id),
 FOREIGN KEY(organization_id,project_id,visit_id) REFERENCES cpl_field_records(organization_id,project_id,visit_id),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_field_observation_revisions (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, visit_id UUID NOT NULL, observation_id UUID NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), snapshot JSONB NOT NULL, created_by_identity_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,observation_id,revision),
 FOREIGN KEY(organization_id,project_id,visit_id,observation_id) REFERENCES cpl_field_observations(organization_id,project_id,visit_id,id),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_field_photos (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, visit_id UUID NOT NULL, id UUID NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), metadata_revision INTEGER NOT NULL CHECK(metadata_revision>0),
 state TEXT NOT NULL CHECK(state IN ('reserved','original_ready','processing','ready','failed')),
 upload JSONB NOT NULL, original_metadata JSONB, upright JSONB,
 original_object_id UUID NOT NULL UNIQUE, thumbnail_object_id UUID NOT NULL UNIQUE, report_object_id UUID NOT NULL UNIQUE,
 thumbnail JSONB, report JSONB, failure_code TEXT CHECK(failure_code IN ('CPL_PHOTO_ORIGINAL_UNAVAILABLE','CPL_PHOTO_PROCESSING_FAILED','CPL_PHOTO_STORAGE_UNAVAILABLE')),
 processing_token UUID, processing_expires_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,project_id,visit_id,id),
 CHECK((state='processing')=(processing_token IS NOT NULL AND processing_expires_at IS NOT NULL)),
 CHECK(state<>'ready' OR (original_metadata IS NOT NULL AND upright IS NOT NULL AND thumbnail IS NOT NULL AND report IS NOT NULL)),
 FOREIGN KEY(organization_id,project_id,visit_id) REFERENCES cpl_field_records(organization_id,project_id,visit_id),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_field_photo_revisions (
 organization_id UUID NOT NULL, project_id UUID NOT NULL, visit_id UUID NOT NULL, photo_id UUID NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), observation_id UUID, snapshot JSONB NOT NULL,
 created_by_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,photo_id,revision),
 FOREIGN KEY(organization_id,project_id,visit_id,photo_id) REFERENCES cpl_field_photos(organization_id,project_id,visit_id,id),
 FOREIGN KEY(organization_id,project_id,visit_id,observation_id) REFERENCES cpl_field_observations(organization_id,project_id,visit_id,id),
 FOREIGN KEY(organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_field_events (
 id UUID PRIMARY KEY, organization_id UUID NOT NULL, project_id UUID NOT NULL, visit_id UUID NOT NULL,
 action TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), resource_id UUID, note TEXT NOT NULL DEFAULT '',
 actor_identity_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(organization_id,project_id,visit_id) REFERENCES cpl_field_records(organization_id,project_id,visit_id),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_field_mutations (
 organization_id UUID NOT NULL, mutation_kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), resource_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,mutation_kind,idempotency_key), FOREIGN KEY(organization_id) REFERENCES cpl_organizations(id)
);
CREATE FUNCTION cpl_field_immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='cpl_field_records' THEN
  IF (NEW.organization_id,NEW.project_id,NEW.visit_id,NEW.template_id,NEW.template_version) IS DISTINCT FROM (OLD.organization_id,OLD.project_id,OLD.visit_id,OLD.template_id,OLD.template_version) THEN RAISE EXCEPTION 'CPL_FIELD_IMMUTABLE_IDENTITY'; END IF;
 ELSIF TG_TABLE_NAME='cpl_field_photos' THEN
  IF (NEW.organization_id,NEW.project_id,NEW.visit_id,NEW.id,NEW.upload,NEW.original_object_id,NEW.thumbnail_object_id,NEW.report_object_id,NEW.created_at,NEW.created_by_identity_id) IS DISTINCT FROM (OLD.organization_id,OLD.project_id,OLD.visit_id,OLD.id,OLD.upload,OLD.original_object_id,OLD.thumbnail_object_id,OLD.report_object_id,OLD.created_at,OLD.created_by_identity_id)
   OR (OLD.original_metadata IS NOT NULL AND (NEW.original_metadata,NEW.upright) IS DISTINCT FROM (OLD.original_metadata,OLD.upright))
   OR (OLD.thumbnail IS NOT NULL AND (NEW.thumbnail,NEW.report) IS DISTINCT FROM (OLD.thumbnail,OLD.report)) THEN RAISE EXCEPTION 'CPL_FIELD_IMMUTABLE_EVIDENCE'; END IF;
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER immutable_field_template BEFORE UPDATE ON cpl_field_records FOR EACH ROW EXECUTE FUNCTION cpl_field_immutable_identity();
CREATE TRIGGER immutable_photo_evidence BEFORE UPDATE ON cpl_field_photos FOR EACH ROW EXECUTE FUNCTION cpl_field_immutable_identity();
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['cpl_field_templates','cpl_field_records','cpl_field_checklist_revisions','cpl_field_observations','cpl_field_observation_revisions','cpl_field_photos','cpl_field_photo_revisions','cpl_field_events','cpl_field_mutations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (organization_id::text=current_setting(''cpl.organization_id'',true)) WITH CHECK (organization_id::text=current_setting(''cpl.organization_id'',true))',name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['cpl_field_templates','cpl_field_checklist_revisions','cpl_field_observation_revisions','cpl_field_photo_revisions','cpl_field_events','cpl_field_mutations'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record()',name);
 END LOOP;
END; $$;
DO $$ DECLARE role_name NAME; BEGIN
 FOR role_name IN SELECT r.role_name FROM cpl_runtime_roles r JOIN pg_roles p ON p.rolname=r.role_name WHERE r.purpose='web' LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON cpl_field_records,cpl_field_observations,cpl_field_photos TO %I',role_name);
  EXECUTE format('GRANT SELECT,INSERT ON cpl_field_templates,cpl_field_checklist_revisions,cpl_field_observation_revisions,cpl_field_photo_revisions,cpl_field_events,cpl_field_mutations TO %I',role_name);
 END LOOP;
END; $$;
