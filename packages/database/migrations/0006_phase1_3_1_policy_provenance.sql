ALTER TABLE ai_response_runs
  ADD COLUMN IF NOT EXISTS policy_provenance JSONB NOT NULL DEFAULT '{"personaPromptVersion":"bea-role-assistant-v1","executiveProfileVersion":null,"brandPolicyVersion":"bea-artifact-brand-v1","artifactTemplateVersion":"bea-artifact-template-v1"}'::jsonb;

ALTER TABLE ai_realtime_sessions
  ADD COLUMN IF NOT EXISTS policy_provenance JSONB NOT NULL DEFAULT '{"personaPromptVersion":"bea-role-assistant-v1","executiveProfileVersion":null,"brandPolicyVersion":"bea-artifact-brand-v1","artifactTemplateVersion":"bea-artifact-template-v1"}'::jsonb;

ALTER TABLE generated_artifacts
  ADD COLUMN IF NOT EXISTS policy_provenance JSONB NOT NULL DEFAULT '{"personaPromptVersion":"bea-role-assistant-v1","executiveProfileVersion":null,"brandPolicyVersion":"bea-artifact-brand-v1","artifactTemplateVersion":"bea-artifact-template-v1"}'::jsonb;

ALTER TABLE ai_response_runs
  ADD CONSTRAINT ai_response_runs_policy_provenance_object CHECK (jsonb_typeof(policy_provenance) = 'object');

ALTER TABLE ai_realtime_sessions
  ADD CONSTRAINT ai_realtime_sessions_policy_provenance_object CHECK (jsonb_typeof(policy_provenance) = 'object');

ALTER TABLE generated_artifacts
  ADD CONSTRAINT generated_artifacts_policy_provenance_object CHECK (jsonb_typeof(policy_provenance) = 'object');
