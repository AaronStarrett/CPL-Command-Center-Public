ALTER TABLE ai_realtime_sessions
  ADD COLUMN IF NOT EXISTS route_decision JSONB;

ALTER TABLE ai_realtime_sessions
  ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ai_realtime_sessions_conversation_authorized_idx
  ON ai_realtime_sessions(conversation_id, authorized_at DESC);

ALTER TABLE ai_realtime_sessions
  ADD CONSTRAINT ai_realtime_sessions_route_decision_object
  CHECK (route_decision IS NULL OR jsonb_typeof(route_decision) = 'object');
