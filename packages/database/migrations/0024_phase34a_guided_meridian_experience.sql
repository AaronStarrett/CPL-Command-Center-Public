CREATE TABLE IF NOT EXISTS guided_demo_runs (
  id UUID PRIMARY KEY,
  scenario_key TEXT NOT NULL,
  scenario_version TEXT NOT NULL,
  status TEXT NOT NULL,
  machine_state TEXT NOT NULL,
  paused_from_state TEXT,
  current_stage_key TEXT,
  current_gate_key TEXT,
  speed_mode TEXT NOT NULL DEFAULT 'normal',
  record_bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_activity TEXT,
  current_activity_index INTEGER NOT NULL DEFAULT 0,
  current_blocker TEXT,
  failure_armed BOOLEAN NOT NULL DEFAULT FALSE,
  presentation_mode BOOLEAN NOT NULL DEFAULT FALSE,
  started_by_user_id UUID,
  optimistic_version INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT guided_demo_runs_scenario_key_check
    CHECK (scenario_key = 'meridian-commerce-center'),
  CONSTRAINT guided_demo_runs_scenario_version_check
    CHECK (char_length(scenario_version) BETWEEN 1 AND 64),
  CONSTRAINT guided_demo_runs_status_check
    CHECK (status IN ('not_started','running','paused','waiting_for_human','failed','completed','archived')),
  CONSTRAINT guided_demo_runs_speed_mode_check
    CHECK (speed_mode IN ('normal','fast')),
  CONSTRAINT guided_demo_runs_activity_index_check
    CHECK (current_activity_index >= 0),
  CONSTRAINT guided_demo_runs_optimistic_version_check
    CHECK (optimistic_version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS guided_demo_runs_one_active_scenario_uidx
  ON guided_demo_runs (scenario_key)
  WHERE archived_at IS NULL AND status <> 'archived';

CREATE INDEX IF NOT EXISTS guided_demo_runs_status_idx
  ON guided_demo_runs (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS guided_demo_stage_states (
  id UUID PRIMARY KEY,
  demo_run_id UUID NOT NULL REFERENCES guided_demo_runs(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  stage_order INTEGER NOT NULL,
  status TEXT NOT NULL,
  backing_type TEXT NOT NULL,
  owner_role_key TEXT NOT NULL,
  current_activity TEXT,
  input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_records JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT guided_demo_stage_states_order_check
    CHECK (stage_order >= 1 AND stage_order <= 12),
  CONSTRAINT guided_demo_stage_states_status_check
    CHECK (status IN ('waiting','queued','processing','completed','human_decision_required','failed','guided_demonstration_only')),
  CONSTRAINT guided_demo_stage_states_backing_check
    CHECK (backing_type IN ('runtime_backed','guided_demonstration','local_test_no_write'))
);

CREATE UNIQUE INDEX IF NOT EXISTS guided_demo_stage_states_run_stage_uidx
  ON guided_demo_stage_states (demo_run_id, stage_key);

CREATE INDEX IF NOT EXISTS guided_demo_stage_states_run_order_idx
  ON guided_demo_stage_states (demo_run_id, stage_order);

CREATE TABLE IF NOT EXISTS guided_demo_events (
  id UUID PRIMARY KEY,
  demo_run_id UUID NOT NULL REFERENCES guided_demo_runs(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  stage_key TEXT,
  event_kind TEXT NOT NULL,
  plain_language_message TEXT NOT NULL,
  actor_user_id UUID,
  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT guided_demo_events_sequence_check
    CHECK (sequence_number >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS guided_demo_events_run_sequence_uidx
  ON guided_demo_events (demo_run_id, sequence_number);

CREATE INDEX IF NOT EXISTS guided_demo_events_run_created_idx
  ON guided_demo_events (demo_run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS guided_demo_decisions (
  id UUID PRIMARY KEY,
  demo_run_id UUID NOT NULL REFERENCES guided_demo_runs(id) ON DELETE CASCADE,
  decision_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS guided_demo_decisions_run_idempotency_uidx
  ON guided_demo_decisions (demo_run_id, idempotency_key);
