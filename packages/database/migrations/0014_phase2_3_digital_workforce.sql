ALTER TABLE workspace_artifacts DROP CONSTRAINT IF EXISTS workspace_artifacts_type_check;
ALTER TABLE workspace_artifacts ADD CONSTRAINT workspace_artifacts_type_check CHECK (type IN (
  'command-center-summary',
  'search-results',
  'company-list',
  'company-detail',
  'contact-list',
  'contact-detail',
  'task-list',
  'task-detail',
  'lead-list',
  'lead-detail',
  'activity-timeline',
  'notification-list',
  'integration-health-summary',
  'integration-detail',
  'workflow-run-list',
  'workflow-run-detail',
  'audit-summary',
  'action-preview',
  'action-result',
  'help',
  'empty',
  'error',
  'digital-workforce-organization',
  'digital-workforce-department',
  'digital-workforce-team',
  'digital-workforce-agent-list',
  'digital-workforce-agent-detail',
  'digital-workforce-agent-draft',
  'digital-workforce-run-list',
  'digital-workforce-run-trace',
  'digital-workforce-handoff-list',
  'digital-workforce-handoff-detail',
  'digital-workforce-approval',
  'digital-workforce-error',
  'digital-workforce-artifacts'
));

CREATE TABLE IF NOT EXISTS digital_workforce_departments (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  display_order INTEGER NOT NULL DEFAULT 0,
  parent_department_id UUID REFERENCES digital_workforce_departments(id) ON DELETE SET NULL,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS digital_workforce_departments_slug_uidx
  ON digital_workforce_departments (slug);
CREATE INDEX IF NOT EXISTS digital_workforce_departments_status_idx
  ON digital_workforce_departments (status, display_order);

CREATE TABLE IF NOT EXISTS digital_workforce_teams (
  id UUID PRIMARY KEY,
  department_id UUID NOT NULL REFERENCES digital_workforce_departments(id),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  team_lead_agent_id UUID,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS digital_workforce_teams_slug_uidx
  ON digital_workforce_teams (slug);
CREATE INDEX IF NOT EXISTS digital_workforce_teams_department_idx
  ON digital_workforce_teams (department_id, display_order);

CREATE TABLE IF NOT EXISTS digital_workforce_agents (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 80),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  role_title TEXT NOT NULL CHECK (char_length(role_title) BETWEEN 1 AND 160),
  short_description TEXT NOT NULL DEFAULT '' CHECK (char_length(short_description) <= 2000),
  department_id UUID NOT NULL REFERENCES digital_workforce_departments(id),
  team_id UUID NOT NULL REFERENCES digital_workforce_teams(id),
  supported_human_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  current_published_version_id UUID,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  avatar TEXT NOT NULL CHECK (avatar IN (
    'executive',
    'manager',
    'specialist-research',
    'specialist-document',
    'specialist-lead',
    'specialist-operations',
    'specialist-schedule',
    'specialist-knowledge',
    'specialist-proposal'
  )),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS digital_workforce_agents_slug_uidx
  ON digital_workforce_agents (slug);
CREATE INDEX IF NOT EXISTS digital_workforce_agents_status_idx
  ON digital_workforce_agents (status, department_id, team_id);

CREATE TABLE IF NOT EXISTS digital_workforce_agent_versions (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES digital_workforce_agents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'published', 'superseded', 'retired')),
  persona TEXT NOT NULL CHECK (char_length(persona) BETWEEN 1 AND 8000),
  role_definition TEXT NOT NULL CHECK (char_length(role_definition) BETWEEN 1 AND 4000),
  goals JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  department_id UUID NOT NULL REFERENCES digital_workforce_departments(id),
  team_id UUID NOT NULL REFERENCES digital_workforce_teams(id),
  supervisor_agent_id UUID REFERENCES digital_workforce_agents(id) ON DELETE SET NULL,
  preferred_handoff_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  available_to_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_assignment JSONB NOT NULL,
  tool_grants JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  knowledge_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  memory_policy TEXT NOT NULL CHECK (memory_policy IN (
    'none', 'run-only', 'conversation-linked', 'summarized-result-history'
  )),
  approval_policy TEXT NOT NULL CHECK (approval_policy IN (
    'read-only-no-approval',
    'confirmation-required',
    'owner-approval-required',
    'designated-role-approval-required',
    'always-blocked'
  )),
  designated_approver_role_id TEXT,
  escalation_instructions TEXT NOT NULL DEFAULT '' CHECK (char_length(escalation_instructions) <= 2000),
  runtime_policy JSONB NOT NULL,
  configuration_hash TEXT NOT NULL CHECK (char_length(configuration_hash) = 64),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  published_by_user_id UUID REFERENCES users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS digital_workforce_agent_versions_number_uidx
  ON digital_workforce_agent_versions (agent_id, version_number);
CREATE INDEX IF NOT EXISTS digital_workforce_agent_versions_lifecycle_idx
  ON digital_workforce_agent_versions (agent_id, lifecycle, version_number DESC);

ALTER TABLE digital_workforce_agents
  DROP CONSTRAINT IF EXISTS digital_workforce_agents_published_version_fk;
ALTER TABLE digital_workforce_agents
  ADD CONSTRAINT digital_workforce_agents_published_version_fk
  FOREIGN KEY (current_published_version_id)
  REFERENCES digital_workforce_agent_versions(id)
  ON DELETE SET NULL;
ALTER TABLE digital_workforce_teams
  DROP CONSTRAINT IF EXISTS digital_workforce_teams_lead_fk;
ALTER TABLE digital_workforce_teams
  ADD CONSTRAINT digital_workforce_teams_lead_fk
  FOREIGN KEY (team_lead_agent_id)
  REFERENCES digital_workforce_agents(id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS digital_workforce_runs (
  id UUID PRIMARY KEY,
  initiating_user_id UUID NOT NULL REFERENCES users(id),
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  initiating_message_id UUID REFERENCES assistant_messages(id) ON DELETE SET NULL,
  root_agent_id UUID NOT NULL REFERENCES digital_workforce_agents(id),
  root_agent_version_id UUID NOT NULL REFERENCES digital_workforce_agent_versions(id),
  goal TEXT NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 2000),
  normalized_request TEXT NOT NULL CHECK (char_length(normalized_request) BETWEEN 1 AND 2000),
  execution_plan JSONB,
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'validating', 'queued', 'planning', 'running',
    'waiting_for_handoff', 'waiting_for_approval', 'synthesizing',
    'completed', 'partially_completed', 'failed', 'cancelled', 'expired', 'budget_exceeded'
  )),
  current_step_key TEXT,
  idempotency_key TEXT NOT NULL,
  source_record_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_presentation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  estimated_cost_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  actual_cost_usd NUMERIC(18, 6),
  provider_call_count INTEGER NOT NULL DEFAULT 0 CHECK (provider_call_count >= 0),
  web_search_count INTEGER NOT NULL DEFAULT 0 CHECK (web_search_count >= 0),
  pdf_generation_count INTEGER NOT NULL DEFAULT 0 CHECK (pdf_generation_count >= 0),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  claim_owner TEXT,
  cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_by_user_id UUID REFERENCES users(id),
  cancellation_reason TEXT,
  safe_error TEXT,
  executive_summary TEXT,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS digital_workforce_runs_idempotency_uidx
  ON digital_workforce_runs (idempotency_key);
CREATE INDEX IF NOT EXISTS digital_workforce_runs_status_idx
  ON digital_workforce_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS digital_workforce_runs_user_idx
  ON digital_workforce_runs (initiating_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS digital_workforce_runs_root_agent_idx
  ON digital_workforce_runs (root_agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS digital_workforce_run_steps (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES digital_workforce_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  step_type TEXT NOT NULL CHECK (step_type IN (
    'retrieve_records', 'analyze_records', 'public_research', 'prepare_handoff',
    'accept_handoff', 'generate_artifact', 'synthesize', 'prepare_action',
    'await_approval', 'complete'
  )),
  agent_id UUID NOT NULL REFERENCES digital_workforce_agents(id),
  agent_version_id UUID NOT NULL REFERENCES digital_workforce_agent_versions(id),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'blocked'
  )),
  idempotency_key TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  parallel_group TEXT,
  assigned_why TEXT NOT NULL DEFAULT '',
  provider TEXT,
  model TEXT,
  fallback_model_used TEXT,
  tool_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  authorized_record_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  citation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  safe_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS digital_workforce_run_steps_idempotency_uidx
  ON digital_workforce_run_steps (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS digital_workforce_run_steps_key_uidx
  ON digital_workforce_run_steps (run_id, step_key);
CREATE INDEX IF NOT EXISTS digital_workforce_run_steps_run_idx
  ON digital_workforce_run_steps (run_id, sequence);

CREATE TABLE IF NOT EXISTS digital_workforce_handoffs (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES digital_workforce_runs(id) ON DELETE CASCADE,
  parent_step_id UUID REFERENCES digital_workforce_run_steps(id) ON DELETE SET NULL,
  from_agent_id UUID NOT NULL REFERENCES digital_workforce_agents(id),
  from_agent_version_id UUID NOT NULL REFERENCES digital_workforce_agent_versions(id),
  to_agent_id UUID NOT NULL REFERENCES digital_workforce_agents(id),
  to_agent_version_id UUID NOT NULL REFERENCES digital_workforce_agent_versions(id),
  depth INTEGER NOT NULL DEFAULT 1 CHECK (depth > 0),
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'validated', 'accepted', 'running', 'returned', 'reviewed',
    'completed', 'rejected', 'failed', 'cancelled', 'expired'
  )),
  packet JSONB NOT NULL,
  returned_result JSONB,
  safe_failure TEXT,
  approval_required BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS digital_workforce_handoffs_run_idx
  ON digital_workforce_handoffs (run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS digital_workforce_handoffs_status_idx
  ON digital_workforce_handoffs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS digital_workforce_run_events (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES digital_workforce_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  agent_id UUID REFERENCES digital_workforce_agents(id) ON DELETE SET NULL,
  step_id UUID REFERENCES digital_workforce_run_steps(id) ON DELETE SET NULL,
  handoff_id UUID REFERENCES digital_workforce_handoffs(id) ON DELETE SET NULL,
  narration TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS digital_workforce_run_events_sequence_uidx
  ON digital_workforce_run_events (run_id, sequence);
CREATE INDEX IF NOT EXISTS digital_workforce_run_events_run_idx
  ON digital_workforce_run_events (run_id, created_at);
