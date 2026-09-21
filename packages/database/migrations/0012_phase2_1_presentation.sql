ALTER TABLE generated_artifacts DROP CONSTRAINT IF EXISTS generated_artifacts_kind_check;
ALTER TABLE generated_artifacts ADD CONSTRAINT generated_artifacts_kind_check CHECK (kind IN (
  'research_report',
  'source_board',
  'chart',
  'graph',
  'table',
  'metric_summary',
  'timeline',
  'comparison',
  'pdf',
  'image',
  'data_file',
  'text_document',
  'analysis_result',
  'web_search_result',
  'code_interpreter_output',
  'research_presentation'
));

CREATE TABLE IF NOT EXISTS ai_presentation_runs (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  response_run_id UUID REFERENCES ai_response_runs(id) ON DELETE SET NULL,
  realtime_session_id UUID REFERENCES ai_realtime_sessions(id) ON DELETE SET NULL,
  initiating_user_message_id UUID REFERENCES assistant_messages(id) ON DELETE SET NULL,
  assistant_message_id UUID REFERENCES assistant_messages(id) ON DELETE SET NULL,
  visual_artifact_id UUID REFERENCES workspace_artifacts(id) ON DELETE SET NULL,
  acting_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_response_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'idle',
    'listening',
    'thinking',
    'researching',
    'preparing',
    'ready',
    'narrating',
    'interrupted',
    'insufficient_evidence',
    'failed',
    'provider_disconnected'
  )),
  query TEXT NOT NULL,
  packet JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_context JSONB,
  auto_follow BOOLEAN NOT NULL DEFAULT TRUE,
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  live_web_search BOOLEAN NOT NULL DEFAULT FALSE,
  required_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  usage_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS ai_presentation_runs_conversation_started_idx
  ON ai_presentation_runs(conversation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ai_presentation_runs_actor_started_idx
  ON ai_presentation_runs(acting_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ai_presentation_runs_response_run_idx
  ON ai_presentation_runs(response_run_id);
