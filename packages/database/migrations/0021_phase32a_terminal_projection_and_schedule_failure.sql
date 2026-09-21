-- Phase 3.2A additive terminal projection and schedule-failure identity.
-- Does not modify migrations 0015–0020.

ALTER TABLE operational_work_items
  ADD COLUMN IF NOT EXISTS scheduled_action_id UUID REFERENCES scheduled_automation_actions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS failure_source_type TEXT
    CHECK (failure_source_type IS NULL OR failure_source_type IN ('job', 'projection', 'schedule')),
  ADD COLUMN IF NOT EXISTS failure_source_id UUID;

CREATE INDEX IF NOT EXISTS operational_work_items_schedule_idx
  ON operational_work_items(scheduled_action_id, status);

CREATE INDEX IF NOT EXISTS operational_work_items_failure_source_idx
  ON operational_work_items(failure_source_type, failure_source_id);

CREATE INDEX IF NOT EXISTS automation_events_projection_dead_letter_idx
  ON automation_events ((payload->>'sourceEventId'))
  WHERE event_type = 'automation.projection_dead_lettered';
