ALTER TABLE configuration_releases
  ADD COLUMN IF NOT EXISTS validated_identity_checksum TEXT;

CREATE SEQUENCE IF NOT EXISTS bea_work_item_reference_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS orchestration_policy_versions (
  id UUID PRIMARY KEY,
  policy_key TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'validated', 'published', 'active', 'superseded', 'archived'
  )),
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  production_ready BOOLEAN NOT NULL DEFAULT FALSE,
  service_context_key TEXT NOT NULL,
  disclosure TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (policy_key, policy_version)
);

CREATE INDEX IF NOT EXISTS orchestration_policy_versions_status_idx
  ON orchestration_policy_versions(status, policy_key);

CREATE TABLE IF NOT EXISTS work_routing_blueprints (
  id UUID PRIMARY KEY,
  blueprint_key TEXT NOT NULL,
  blueprint_version INTEGER NOT NULL CHECK (blueprint_version > 0),
  trigger_event_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  work_item_kind TEXT NOT NULL,
  queue_key TEXT NOT NULL,
  assignment_strategy TEXT NOT NULL,
  assigned_role_key TEXT NOT NULL,
  due_offset_ms BIGINT NOT NULL,
  priority TEXT NOT NULL,
  completion_event_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  cancellation_event_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  title TEXT NOT NULL,
  required_action TEXT NOT NULL,
  deep_link_template TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_status TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (blueprint_key, blueprint_version)
);

CREATE INDEX IF NOT EXISTS work_routing_blueprints_kind_idx
  ON work_routing_blueprints(work_item_kind, blueprint_version);

CREATE TABLE IF NOT EXISTS operational_work_items (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  work_item_kind TEXT NOT NULL CHECK (work_item_kind IN (
    'inspection_readiness', 'inspection_submission', 'inspection_correction',
    'report_technical_review', 'report_revision', 'report_delivery_authorization',
    'delivery_reconciliation', 'automation_failure', 'sla_escalation'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'open', 'acknowledged', 'in_progress', 'blocked', 'completed', 'cancelled'
  )),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  queue_key TEXT NOT NULL,
  assigned_role_key TEXT,
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  inspection_id UUID REFERENCES inspections(id) ON DELETE SET NULL,
  submission_id UUID REFERENCES inspection_submissions(id) ON DELETE SET NULL,
  report_id UUID REFERENCES inspection_reports(id) ON DELETE SET NULL,
  report_version_id UUID REFERENCES report_versions(id) ON DELETE SET NULL,
  exception_id UUID REFERENCES exception_cases(id) ON DELETE SET NULL,
  delivery_authorization_id UUID REFERENCES delivery_authorizations(id) ON DELETE SET NULL,
  source_event_id UUID REFERENCES automation_events(id) ON DELETE SET NULL,
  source_aggregate_type TEXT NOT NULL,
  source_aggregate_id UUID NOT NULL,
  policy_key TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  configuration_release_id UUID REFERENCES configuration_releases(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  cycle_identity TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  required_action TEXT NOT NULL,
  deep_link TEXT NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  blocked_reason TEXT,
  completion_event_type TEXT,
  completion_event_id UUID,
  escalation_level TEXT NOT NULL DEFAULT 'none' CHECK (escalation_level IN (
    'none', 'watch', 'at_risk', 'breached', 'critical'
  )),
  last_reminder_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS operational_work_items_open_cycle_uidx
  ON operational_work_items (work_item_kind, cycle_identity)
  WHERE status IN ('open', 'acknowledged', 'in_progress', 'blocked');

CREATE INDEX IF NOT EXISTS operational_work_items_assignee_status_idx
  ON operational_work_items(assigned_user_id, status);
CREATE INDEX IF NOT EXISTS operational_work_items_claimed_status_idx
  ON operational_work_items(claimed_user_id, status);
CREATE INDEX IF NOT EXISTS operational_work_items_queue_status_idx
  ON operational_work_items(queue_key, status, due_at);
CREATE INDEX IF NOT EXISTS operational_work_items_role_status_idx
  ON operational_work_items(assigned_role_key, status);
CREATE INDEX IF NOT EXISTS operational_work_items_inspection_idx
  ON operational_work_items(inspection_id, status);
CREATE INDEX IF NOT EXISTS operational_work_items_report_idx
  ON operational_work_items(report_id, status);
CREATE INDEX IF NOT EXISTS operational_work_items_due_idx
  ON operational_work_items(due_at, status);
CREATE INDEX IF NOT EXISTS operational_work_items_escalation_idx
  ON operational_work_items(escalation_level, status);

CREATE TABLE IF NOT EXISTS work_item_assignments (
  id UUID PRIMARY KEY,
  work_item_id UUID NOT NULL REFERENCES operational_work_items(id) ON DELETE CASCADE,
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_role_key TEXT,
  claimed_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN (
    'created', 'claimed', 'released', 'reassigned', 'unassigned'
  )),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS work_item_assignments_work_item_idx
  ON work_item_assignments(work_item_id, created_at);

CREATE TABLE IF NOT EXISTS work_item_events (
  id UUID PRIMARY KEY,
  work_item_id UUID NOT NULL REFERENCES operational_work_items(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS work_item_events_work_item_idx
  ON work_item_events(work_item_id, created_at);

CREATE TABLE IF NOT EXISTS event_projection_receipts (
  id UUID PRIMARY KEY,
  source_event_id UUID NOT NULL REFERENCES automation_events(id) ON DELETE CASCADE,
  blueprint_key TEXT NOT NULL,
  blueprint_version INTEGER NOT NULL,
  cycle_identity TEXT NOT NULL,
  action_type TEXT NOT NULL,
  work_item_id UUID REFERENCES operational_work_items(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  result TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS event_projection_receipts_identity_uidx
  ON event_projection_receipts (
    source_event_id, blueprint_key, blueprint_version, cycle_identity, action_type
  );

CREATE INDEX IF NOT EXISTS event_projection_receipts_event_idx
  ON event_projection_receipts(source_event_id);

CREATE TABLE IF NOT EXISTS scheduled_automation_actions (
  id UUID PRIMARY KEY,
  schedule_key TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'work.reminder', 'work.escalation', 'work.reconcile', 'work.project-events'
  )),
  work_item_id UUID REFERENCES operational_work_items(id) ON DELETE CASCADE,
  aggregate_type TEXT,
  aggregate_id UUID,
  scheduled_for TIMESTAMPTZ NOT NULL,
  last_evaluated_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'due', 'running', 'succeeded', 'failed', 'cancelled', 'paused', 'disabled'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_result TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS scheduled_automation_actions_due_idx
  ON scheduled_automation_actions(status, scheduled_for);
CREATE INDEX IF NOT EXISTS scheduled_automation_actions_work_item_idx
  ON scheduled_automation_actions(work_item_id, action_type);

CREATE TABLE IF NOT EXISTS work_item_reminders (
  id UUID PRIMARY KEY,
  work_item_id UUID NOT NULL REFERENCES operational_work_items(id) ON DELETE CASCADE,
  threshold_key TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (work_item_id, threshold_key, policy_version)
);

CREATE TABLE IF NOT EXISTS work_item_escalations (
  id UUID PRIMARY KEY,
  work_item_id UUID NOT NULL REFERENCES operational_work_items(id) ON DELETE CASCADE,
  escalation_level TEXT NOT NULL CHECK (escalation_level IN (
    'watch', 'at_risk', 'breached', 'critical'
  )),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMPTZ,
  resolution_event_id UUID,
  policy_version INTEGER NOT NULL,
  owner_visible BOOLEAN NOT NULL DEFAULT FALSE,
  cycle_identity TEXT NOT NULL,
  UNIQUE (work_item_id, escalation_level, cycle_identity)
);

CREATE INDEX IF NOT EXISTS work_item_escalations_open_idx
  ON work_item_escalations(work_item_id, resolved_at);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id UUID PRIMARY KEY,
  work_item_id UUID REFERENCES operational_work_items(id) ON DELETE SET NULL,
  reminder_id UUID REFERENCES work_item_reminders(id) ON DELETE SET NULL,
  escalation_id UUID REFERENCES work_item_escalations(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email_dry_run', 'teams_dry_run')),
  recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  recipient_role_key TEXT,
  recipient_placeholder TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  deep_link TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'planned', 'queued', 'delivered_in_app', 'rendered_dry_run', 'suppressed', 'failed', 'cancelled'
  )),
  suppression_reason TEXT,
  adapter_result TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  policy_version INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  available_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notification_outbox_status_idx
  ON notification_outbox(status, available_at);
CREATE INDEX IF NOT EXISTS notification_outbox_work_item_idx
  ON notification_outbox(work_item_id, created_at);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id UUID PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'execute')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_missing INTEGER NOT NULL DEFAULT 0,
  completed_stale INTEGER NOT NULL DEFAULT 0,
  cancelled_superseded INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '[]'::jsonb,
  correlation_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_started_idx
  ON reconciliation_runs(started_at DESC);
