ALTER TABLE connector_readiness DROP CONSTRAINT IF EXISTS connector_readiness_readiness_status_check;
ALTER TABLE connector_readiness
  ADD CONSTRAINT connector_readiness_readiness_status_check
  CHECK (
    readiness_status IN (
      'not_connected', 'authenticating', 'connected_unverified', 'configuration_required',
      'ready_for_dry_run', 'dry_run_validated', 'activation_blocked', 'authenticated',
      'ready_for_activation', 'healthy', 'degraded', 'error', 'auth_expired', 'disabled'
    )
  );

CREATE TABLE IF NOT EXISTS configuration_releases (
  id UUID PRIMARY KEY,
  family_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'validation_failed', 'validated', 'published', 'active', 'superseded', 'archived'
  )),
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  production_ready BOOLEAN NOT NULL DEFAULT FALSE,
  service_context_key TEXT NOT NULL,
  description TEXT NOT NULL,
  disclosure TEXT NOT NULL,
  parent_release_id UUID REFERENCES configuration_releases(id) ON DELETE SET NULL,
  checksum TEXT,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  validated_at TIMESTAMPTZ,
  validated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  published_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ,
  activated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  archived_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (family_key, version_number)
);

CREATE INDEX IF NOT EXISTS configuration_releases_status_idx
  ON configuration_releases(status, service_context_key);
CREATE INDEX IF NOT EXISTS configuration_releases_family_idx
  ON configuration_releases(family_key, version_number DESC);
CREATE UNIQUE INDEX IF NOT EXISTS configuration_releases_active_context_uidx
  ON configuration_releases(service_context_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS configuration_artifacts (
  id UUID PRIMARY KEY,
  release_id UUID NOT NULL REFERENCES configuration_releases(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'inspection_schema', 'mapping_profile', 'validation_rule_set', 'report_template',
    'review_policy', 'delivery_policy', 'storage_policy', 'sla_policy', 'workflow_blueprint'
  )),
  artifact_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (release_id, artifact_kind)
);

CREATE INDEX IF NOT EXISTS configuration_artifacts_release_idx
  ON configuration_artifacts(release_id, artifact_kind);

CREATE TABLE IF NOT EXISTS configuration_validation_runs (
  id UUID PRIMARY KEY,
  release_id UUID NOT NULL REFERENCES configuration_releases(id) ON DELETE CASCADE,
  passed BOOLEAN NOT NULL,
  blocking JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS configuration_validation_runs_release_idx
  ON configuration_validation_runs(release_id, created_at DESC);

CREATE TABLE IF NOT EXISTS configuration_readiness_items (
  id UUID PRIMARY KEY,
  gap_key TEXT NOT NULL UNIQUE,
  area TEXT NOT NULL,
  description TEXT NOT NULL,
  current_synthetic_behavior TEXT NOT NULL,
  why_confirmation_required TEXT NOT NULL,
  blocking_stage TEXT NOT NULL,
  responsible_person TEXT NOT NULL,
  target_meeting TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'unknown', 'assumed_for_demo', 'awaiting_bea_confirmation',
    'confirmed', 'configured', 'tested', 'approved'
  )),
  resolution TEXT,
  configuration_artifact_kind TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS configuration_readiness_items_status_idx
  ON configuration_readiness_items(status, blocking_stage);

CREATE TABLE IF NOT EXISTS configuration_intake_items (
  id UUID PRIMARY KEY,
  question_key TEXT NOT NULL UNIQUE,
  section_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'unknown', 'assumed_for_demo', 'awaiting_bea_confirmation',
    'confirmed', 'configured', 'tested', 'approved'
  )),
  answer TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS configuration_intake_items_section_idx
  ON configuration_intake_items(section_key, question_key);

CREATE TABLE IF NOT EXISTS ingestion_staging_runs (
  id UUID PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_system_label TEXT,
  source_schema_version TEXT,
  source_timestamp TIMESTAMPTZ,
  source_identity TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  raw_representation JSONB NOT NULL,
  mapping_profile_key TEXT,
  configuration_release_id UUID REFERENCES configuration_releases(id) ON DELETE SET NULL,
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL CHECK (status IN (
    'received', 'quarantined', 'mapped', 'validated', 'committed', 'duplicate', 'failed'
  )),
  mapping_report JSONB,
  validation_preview JSONB,
  committed_submission_id UUID REFERENCES inspection_submissions(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  classification_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ingestion_staging_runs_hash_idx
  ON ingestion_staging_runs(payload_sha256, created_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_staging_runs_release_idx
  ON ingestion_staging_runs(configuration_release_id, created_at DESC);

ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS configuration_release_id UUID REFERENCES configuration_releases(id) ON DELETE SET NULL;
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS inspection_type TEXT;
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS readiness_checklist JSONB;

CREATE INDEX IF NOT EXISTS inspections_configuration_release_idx
  ON inspections(configuration_release_id);

ALTER TABLE inspection_submissions
  ADD COLUMN IF NOT EXISTS configuration_release_id UUID REFERENCES configuration_releases(id) ON DELETE SET NULL;
ALTER TABLE inspection_submissions
  ADD COLUMN IF NOT EXISTS source_lineage JSONB;

CREATE INDEX IF NOT EXISTS inspection_submissions_configuration_release_idx
  ON inspection_submissions(configuration_release_id);

ALTER TABLE inspection_reports
  ADD COLUMN IF NOT EXISTS configuration_release_id UUID REFERENCES configuration_releases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS inspection_reports_configuration_release_idx
  ON inspection_reports(configuration_release_id);

ALTER TABLE report_versions
  ADD COLUMN IF NOT EXISTS configuration_release_id UUID REFERENCES configuration_releases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS report_versions_configuration_release_idx
  ON report_versions(configuration_release_id);

ALTER TABLE sla_clocks
  ADD COLUMN IF NOT EXISTS sla_policy_key TEXT;
ALTER TABLE sla_clocks
  ADD COLUMN IF NOT EXISTS sla_policy_version INTEGER;
