CREATE SEQUENCE IF NOT EXISTS bea_project_reference_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS bea_inspection_reference_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS bea_report_reference_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS bea_exception_reference_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS report_templates (
  id UUID PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS report_templates_key_uidx ON report_templates(key);

CREATE TABLE IF NOT EXISTS report_template_versions (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES report_templates(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  renderer_key TEXT NOT NULL,
  disclosure TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (template_id, version_number)
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  client_name TEXT NOT NULL,
  site_name TEXT NOT NULL,
  site_city TEXT,
  site_region TEXT,
  service_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'awarded', 'initializing', 'ready', 'scheduling', 'fieldwork',
    'reporting', 'delivered', 'closeout', 'closed', 'cancelled'
  )),
  accepted_scope_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_reference_uidx ON projects(reference);
CREATE INDEX IF NOT EXISTS projects_status_idx ON projects(status);
CREATE INDEX IF NOT EXISTS projects_lead_id_idx ON projects(lead_id);
CREATE INDEX IF NOT EXISTS projects_company_id_idx ON projects(company_id);

CREATE TABLE IF NOT EXISTS inspections (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'scheduled', 'ready', 'in_progress', 'completed', 'submitted',
    'validating', 'needs_correction', 'validated', 'reporting', 'complete', 'cancelled'
  )),
  inspector_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  service_key TEXT NOT NULL,
  report_template_id UUID NOT NULL REFERENCES report_templates(id),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS inspections_reference_uidx ON inspections(reference);
CREATE INDEX IF NOT EXISTS inspections_project_id_idx ON inspections(project_id);
CREATE INDEX IF NOT EXISTS inspections_status_idx ON inspections(status);
CREATE INDEX IF NOT EXISTS inspections_inspector_user_id_idx ON inspections(inspector_user_id);

CREATE TABLE IF NOT EXISTS inspection_assignments (
  id UUID PRIMARY KEY,
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  assignment_role TEXT NOT NULL CHECK (assignment_role IN ('inspector', 'reviewer')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (inspection_id, assignment_role, user_id)
);

CREATE TABLE IF NOT EXISTS inspection_submissions (
  id UUID PRIMARY KEY,
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  source_channel TEXT NOT NULL CHECK (source_channel IN (
    'direct_entry', 'webhook', 'file_import', 'sharepoint', 'onedrive', 'email', 'field_system'
  )),
  source_idempotency_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  raw_payload JSONB NOT NULL,
  schema_version TEXT NOT NULL,
  mapping_version TEXT NOT NULL,
  normalized_payload JSONB NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (inspection_id, source_idempotency_key),
  UNIQUE (inspection_id, payload_sha256)
);

CREATE INDEX IF NOT EXISTS inspection_submissions_inspection_id_idx ON inspection_submissions(inspection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inspection_findings (
  id UUID PRIMARY KEY,
  submission_id UUID NOT NULL REFERENCES inspection_submissions(id) ON DELETE CASCADE,
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  section_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'minor', 'major', 'critical')),
  location TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS inspection_findings_submission_id_idx ON inspection_findings(submission_id);

CREATE TABLE IF NOT EXISTS inspection_evidence (
  id UUID PRIMARY KEY,
  submission_id UUID NOT NULL REFERENCES inspection_submissions(id) ON DELETE CASCADE,
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  finding_id UUID REFERENCES inspection_findings(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'document', 'signature')),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  storage_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS inspection_evidence_submission_id_idx ON inspection_evidence(submission_id);
CREATE INDEX IF NOT EXISTS inspection_evidence_sha256_idx ON inspection_evidence(sha256);

CREATE TABLE IF NOT EXISTS inspection_validation_results (
  id UUID PRIMARY KEY,
  submission_id UUID NOT NULL REFERENCES inspection_submissions(id) ON DELETE CASCADE,
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  passed BOOLEAN NOT NULL,
  rule_set_key TEXT NOT NULL,
  rule_set_version TEXT NOT NULL,
  blocking JSONB NOT NULL DEFAULT '[]'::jsonb,
  optional_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS inspection_validation_results_inspection_id_idx ON inspection_validation_results(inspection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inspection_reports (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL,
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES report_templates(id),
  current_template_version_id UUID NOT NULL REFERENCES report_template_versions(id),
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_data', 'assembling', 'draft_ready', 'in_review', 'revision_required',
    'approved', 'rendering_final', 'ready_for_delivery', 'delivering', 'delivered',
    'delivery_failed', 'cancelled'
  )),
  current_version_number INTEGER NOT NULL DEFAULT 0 CHECK (current_version_number >= 0),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (inspection_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS inspection_reports_reference_uidx ON inspection_reports(reference);
CREATE INDEX IF NOT EXISTS inspection_reports_status_idx ON inspection_reports(status);

CREATE TABLE IF NOT EXISTS report_versions (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES inspection_reports(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'in_review', 'revision_required', 'approved', 'final', 'superseded'
  )),
  input_snapshot JSONB NOT NULL,
  template_version_id UUID NOT NULL REFERENCES report_template_versions(id),
  submission_id UUID NOT NULL REFERENCES inspection_submissions(id),
  rendered_checksum TEXT,
  rendered_storage_ref TEXT,
  rendered_mime_type TEXT,
  rendered_content TEXT,
  reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN (
    'approve', 'request_revision', 'return_to_inspector'
  )),
  review_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (report_id, version_number)
);

CREATE INDEX IF NOT EXISTS report_versions_report_id_idx ON report_versions(report_id, version_number DESC);

CREATE TABLE IF NOT EXISTS report_review_comments (
  id UUID PRIMARY KEY,
  report_version_id UUID NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
  author_user_id UUID NOT NULL REFERENCES users(id),
  section_key TEXT,
  finding_id UUID REFERENCES inspection_findings(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS report_deliveries (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES inspection_reports(id) ON DELETE CASCADE,
  report_version_id UUID NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'attempting', 'delivered', 'failed', 'cancelled')),
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT NOT NULL,
  artifact_checksum TEXT,
  external_message_id TEXT,
  attempted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS report_deliveries_report_id_idx ON report_deliveries(report_id, created_at DESC);

CREATE TABLE IF NOT EXISTS exception_cases (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'validation', 'delivery', 'connector', 'mapping', 'template', 'state', 'duplicate'
  )),
  status TEXT NOT NULL CHECK (status IN ('open', 'assigned', 'in_progress', 'resolved', 'cancelled')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  inspection_id UUID REFERENCES inspections(id) ON DELETE SET NULL,
  report_id UUID REFERENCES inspection_reports(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  delivery_id UUID REFERENCES report_deliveries(id) ON DELETE SET NULL,
  job_id UUID,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sla_attribution TEXT NOT NULL CHECK (sla_attribution IN (
    'system_processing', 'human_waiting', 'connector_waiting', 'exception', 'customer_caused'
  )),
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS exception_cases_reference_uidx ON exception_cases(reference);
CREATE INDEX IF NOT EXISTS exception_cases_status_idx ON exception_cases(status);
CREATE INDEX IF NOT EXISTS exception_cases_inspection_id_idx ON exception_cases(inspection_id);

CREATE TABLE IF NOT EXISTS sla_clocks (
  id UUID PRIMARY KEY,
  report_id UUID REFERENCES inspection_reports(id) ON DELETE SET NULL,
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  clock_kind TEXT NOT NULL CHECK (clock_kind IN ('calendar', 'business_hours')),
  target_minutes INTEGER NOT NULL CHECK (target_minutes > 0),
  started_at TIMESTAMPTZ NOT NULL,
  paused_at TIMESTAMPTZ,
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN (
    'customer_caused', 'internal_exception', 'awaiting_human'
  )),
  stopped_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'stopped', 'breached')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (inspection_id)
);

CREATE TABLE IF NOT EXISTS sla_stage_intervals (
  id UUID PRIMARY KEY,
  clock_id UUID NOT NULL REFERENCES sla_clocks(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_ms BIGINT,
  attribution TEXT NOT NULL CHECK (attribution IN (
    'system_processing', 'human_waiting', 'connector_waiting', 'exception', 'customer_caused'
  ))
);

CREATE INDEX IF NOT EXISTS sla_stage_intervals_clock_id_idx ON sla_stage_intervals(clock_id, started_at);

CREATE TABLE IF NOT EXISTS automation_events (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'worker', 'connector')),
  actor_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processing_status TEXT NOT NULL CHECK (processing_status IN ('pending', 'processed', 'ignored'))
);

CREATE INDEX IF NOT EXISTS automation_events_aggregate_idx ON automation_events(aggregate_type, aggregate_id, occurred_at);
CREATE INDEX IF NOT EXISTS automation_events_correlation_idx ON automation_events(correlation_id);

CREATE TABLE IF NOT EXISTS automation_jobs (
  id UUID PRIMARY KEY,
  job_type TEXT NOT NULL,
  blueprint_key TEXT NOT NULL,
  blueprint_version INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_id UUID REFERENCES automation_events(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'claimed', 'succeeded', 'failed', 'dead_letter', 'cancelled'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMPTZ,
  claimed_by TEXT,
  finished_at TIMESTAMPTZ,
  last_error JSONB,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS automation_jobs_status_available_idx ON automation_jobs(status, available_at);
CREATE INDEX IF NOT EXISTS automation_jobs_aggregate_idx ON automation_jobs(aggregate_type, aggregate_id);

CREATE TABLE IF NOT EXISTS automation_blueprints (
  id UUID PRIMARY KEY,
  key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  blueprint_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused')),
  trigger_event_type TEXT NOT NULL,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (key, blueprint_version)
);

CREATE TABLE IF NOT EXISTS connector_readiness (
  id UUID PRIMARY KEY,
  integration_connection_id UUID REFERENCES integration_connections(id) ON DELETE SET NULL,
  provider_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  readiness_status TEXT NOT NULL CHECK (readiness_status IN (
    'not_connected', 'authenticating', 'connected_unverified', 'configuration_required',
    'ready_for_dry_run', 'ready_for_activation', 'healthy', 'degraded', 'error',
    'auth_expired', 'disabled'
  )),
  last_dry_run_at TIMESTAMPTZ,
  last_activation_at TIMESTAMPTZ,
  last_successful_sync_at TIMESTAMPTZ,
  last_error JSONB,
  subscription_status TEXT,
  subscription_expires_at TIMESTAMPTZ,
  required_action TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_readiness_provider_uidx ON connector_readiness(provider_type, display_name);

CREATE TABLE IF NOT EXISTS external_object_links (
  id UUID PRIMARY KEY,
  provider_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  bea_resource_type TEXT NOT NULL,
  bea_resource_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider_type, external_id, bea_resource_type)
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS inspection_id UUID REFERENCES inspections(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS report_id UUID REFERENCES inspection_reports(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS exception_id UUID REFERENCES exception_cases(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_inspection_id_idx ON tasks(inspection_id);
CREATE INDEX IF NOT EXISTS tasks_report_id_idx ON tasks(report_id);
CREATE INDEX IF NOT EXISTS tasks_exception_id_idx ON tasks(exception_id);

ALTER TABLE activities ADD COLUMN IF NOT EXISTS inspection_id UUID REFERENCES inspections(id) ON DELETE SET NULL;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS report_id UUID REFERENCES inspection_reports(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS activities_inspection_id_idx ON activities(inspection_id);
CREATE INDEX IF NOT EXISTS activities_report_id_idx ON activities(report_id);
