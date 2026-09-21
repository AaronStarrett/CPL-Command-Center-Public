ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_provider_check;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_model_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_provider_v2_check CHECK (char_length(provider) BETWEEN 1 AND 64),
  ADD CONSTRAINT conversations_model_v2_check CHECK (char_length(model) BETWEEN 1 AND 255);

ALTER TABLE assistant_messages DROP CONSTRAINT IF EXISTS assistant_messages_provider_check;
ALTER TABLE assistant_messages DROP CONSTRAINT IF EXISTS assistant_messages_model_check;
ALTER TABLE assistant_messages
  ADD CONSTRAINT assistant_messages_provider_v2_check
    CHECK (provider IS NULL OR char_length(provider) BETWEEN 1 AND 64),
  ADD CONSTRAINT assistant_messages_model_v2_check
    CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 255),
  ADD COLUMN IF NOT EXISTS provider_response_id TEXT,
  ADD COLUMN IF NOT EXISTS response_status TEXT NOT NULL DEFAULT 'completed'
    CHECK (response_status IN ('streaming', 'completed', 'cancelled', 'failed', 'incomplete')),
  ADD COLUMN IF NOT EXISTS incomplete_reason TEXT;

CREATE INDEX IF NOT EXISTS assistant_messages_provider_response_idx
  ON assistant_messages(provider_response_id);

ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS last_successful_test_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_failed_test_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_test_evidence_id UUID,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ai_provider_connection_tests (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('demo', 'openai')),
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  authenticated BOOLEAN NOT NULL DEFAULT FALSE,
  safe_failure_code TEXT,
  safe_message TEXT NOT NULL,
  model_count INTEGER CHECK (model_count IS NULL OR model_count >= 0),
  correlation_id TEXT NOT NULL,
  tested_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS ai_provider_connection_tests_provider_tested_idx
  ON ai_provider_connection_tests(provider, tested_at DESC);

CREATE TABLE IF NOT EXISTS ai_response_runs (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('demo', 'openai')),
  model TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 255),
  provider_response_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'cancelled', 'failed', 'incomplete')),
  correlation_id TEXT NOT NULL,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS ai_response_runs_owner_started_idx
  ON ai_response_runs(requested_by_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ai_response_runs_conversation_started_idx
  ON ai_response_runs(conversation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ai_response_runs_provider_response_idx
  ON ai_response_runs(provider, provider_response_id);

CREATE TABLE IF NOT EXISTS ai_message_citations (
  id UUID PRIMARY KEY,
  response_run_id UUID NOT NULL REFERENCES ai_response_runs(id) ON DELETE CASCADE,
  assistant_message_id UUID REFERENCES assistant_messages(id) ON DELETE SET NULL,
  provider_item_id TEXT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  start_index INTEGER,
  end_index INTEGER,
  retrieved_at TIMESTAMPTZ NOT NULL,
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((start_index IS NULL AND end_index IS NULL) OR
         (start_index IS NOT NULL AND end_index IS NOT NULL AND start_index >= 0 AND end_index >= start_index))
);
CREATE INDEX IF NOT EXISTS ai_message_citations_run_idx ON ai_message_citations(response_run_id);

CREATE TABLE IF NOT EXISTS ai_tool_calls (
  id UUID PRIMARY KEY,
  response_run_id UUID NOT NULL REFERENCES ai_response_runs(id) ON DELETE CASCADE,
  provider_call_id TEXT,
  name TEXT NOT NULL,
  arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'validated', 'rejected', 'completed', 'failed')),
  required_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  effect TEXT NOT NULL CHECK (effect IN ('read', 'preview')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS ai_tool_calls_run_idx ON ai_tool_calls(response_run_id);

CREATE TABLE IF NOT EXISTS ai_realtime_sessions (
  id UUID PRIMARY KEY,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('demo', 'openai')),
  provider_session_id TEXT,
  model TEXT NOT NULL,
  voice TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('authorized', 'connected', 'completed', 'failed', 'cancelled')),
  correlation_id TEXT NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS ai_realtime_sessions_owner_authorized_idx
  ON ai_realtime_sessions(requested_by_user_id, authorized_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage_records (
  id UUID PRIMARY KEY,
  response_run_id UUID REFERENCES ai_response_runs(id) ON DELETE SET NULL,
  realtime_session_id UUID REFERENCES ai_realtime_sessions(id) ON DELETE SET NULL,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('demo', 'openai')),
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  audio_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (audio_input_tokens >= 0),
  audio_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (audio_output_tokens >= 0),
  realtime_duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (realtime_duration_seconds >= 0),
  estimated_cost_usd NUMERIC(18,6),
  cost_status TEXT NOT NULL DEFAULT 'unavailable'
    CHECK (cost_status IN ('unavailable', 'estimated', 'provider_reported')),
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS ai_usage_records_owner_recorded_idx
  ON ai_usage_records(requested_by_user_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS ai_model_cache (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('demo', 'openai')),
  model_id TEXT NOT NULL,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  owned_by TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  capability_source TEXT NOT NULL CHECK (capability_source IN ('provider', 'configured', 'demo_fixture', 'unknown')),
  fetched_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE(provider, model_id)
);
CREATE INDEX IF NOT EXISTS ai_model_cache_provider_expires_idx ON ai_model_cache(provider, expires_at);

CREATE TABLE IF NOT EXISTS generated_artifacts (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  response_run_id UUID REFERENCES ai_response_runs(id) ON DELETE SET NULL,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('research_report','source_board','chart','graph','table','metric_summary','timeline','comparison','pdf','image','data_file','text_document','analysis_result','web_search_result','code_interpreter_output')),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing','generating','ready','partial','failed','expired','archived')),
  artifact_version INTEGER NOT NULL DEFAULT 1 CHECK (artifact_version > 0),
  provider TEXT NOT NULL CHECK (provider IN ('demo', 'openai', 'application')),
  provider_item_id TEXT,
  provider_container_id TEXT,
  provider_file_id TEXT,
  filename TEXT,
  media_type TEXT,
  storage_reference TEXT,
  specification JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  citation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  render_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  generation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS generated_artifacts_owner_created_idx
  ON generated_artifacts(requested_by_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS generated_artifacts_conversation_created_idx
  ON generated_artifacts(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS generated_artifacts_owner_storage_idx
  ON generated_artifacts(requested_by_user_id, storage_reference)
  WHERE storage_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_rate_limit_windows (
  subject_key TEXT NOT NULL,
  route_key TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(subject_key, route_key, window_started_at)
);
CREATE INDEX IF NOT EXISTS api_rate_limit_windows_updated_idx ON api_rate_limit_windows(updated_at);
