ALTER TABLE ai_response_runs
  ADD COLUMN IF NOT EXISTS route_decision JSONB;

ALTER TABLE ai_response_runs
  ADD CONSTRAINT ai_response_runs_route_decision_object
  CHECK (route_decision IS NULL OR jsonb_typeof(route_decision) = 'object');

ALTER TABLE ai_model_cache
  ADD COLUMN IF NOT EXISTS validation JSONB NOT NULL DEFAULT
  '{"registryVersion":"2026-08-phase1.3.3-v1","validatedAt":null,"validationMethod":"unknown","evidence":{}}'::jsonb;

ALTER TABLE ai_model_cache
  ADD CONSTRAINT ai_model_cache_validation_object CHECK (jsonb_typeof(validation) = 'object');

CREATE TABLE IF NOT EXISTS ai_user_voice_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  speak_responses BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS ai_user_voice_preferences_updated_idx
  ON ai_user_voice_preferences(updated_at DESC);
