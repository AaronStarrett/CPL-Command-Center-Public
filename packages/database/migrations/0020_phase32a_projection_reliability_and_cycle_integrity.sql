-- Phase 3.2A additive projection reliability and exact-cycle integrity.
-- Does not modify migrations 0015–0019.

ALTER TABLE automation_events
  DROP CONSTRAINT IF EXISTS automation_events_processing_status_check;

ALTER TABLE automation_events
  ADD COLUMN IF NOT EXISTS projection_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (projection_attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS projection_first_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS projection_last_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS projection_next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS projection_error_code TEXT,
  ADD COLUMN IF NOT EXISTS projection_error_message TEXT,
  ADD COLUMN IF NOT EXISTS projection_retryable BOOLEAN,
  ADD COLUMN IF NOT EXISTS projection_dead_lettered_at TIMESTAMPTZ;

ALTER TABLE automation_events
  ADD CONSTRAINT automation_events_processing_status_check
  CHECK (processing_status IN ('pending', 'processed', 'ignored', 'failed', 'dead_lettered'));

CREATE INDEX IF NOT EXISTS automation_events_projection_retry_idx
  ON automation_events (processing_status, projection_next_retry_at)
  WHERE processing_status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS event_projection_failures (
  id UUID PRIMARY KEY,
  source_event_id UUID NOT NULL REFERENCES automation_events(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  correlation_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  error_code TEXT NOT NULL,
  error_message TEXT NOT NULL,
  retryable BOOLEAN NOT NULL,
  terminal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_event_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS event_projection_failures_event_idx
  ON event_projection_failures(source_event_id, created_at);

CREATE INDEX IF NOT EXISTS event_projection_failures_terminal_idx
  ON event_projection_failures(terminal, created_at)
  WHERE terminal = TRUE;

ALTER TABLE operational_work_items
  ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES automation_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivery_id UUID REFERENCES report_deliveries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requested_revision_version_id UUID REFERENCES report_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS operational_work_items_job_idx
  ON operational_work_items(job_id, status);
CREATE INDEX IF NOT EXISTS operational_work_items_delivery_idx
  ON operational_work_items(delivery_id, status);
CREATE INDEX IF NOT EXISTS operational_work_items_cycle_idx
  ON operational_work_items(work_item_kind, cycle_identity, status);

ALTER TABLE scheduled_automation_actions
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5
    CHECK (max_attempts > 0);

CREATE INDEX IF NOT EXISTS scheduled_automation_actions_retry_idx
  ON scheduled_automation_actions(status, next_run_at)
  WHERE status IN ('pending', 'due', 'failed');
