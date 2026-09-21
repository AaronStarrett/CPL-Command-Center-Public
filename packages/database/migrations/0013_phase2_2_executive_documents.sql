ALTER TABLE ai_model_cache DROP CONSTRAINT IF EXISTS ai_model_cache_capability_source_check;
ALTER TABLE ai_model_cache ADD CONSTRAINT ai_model_cache_capability_source_check
  CHECK (capability_source IN ('provider', 'configured', 'demo_fixture', 'unknown', 'registry', 'probe'));

CREATE TABLE IF NOT EXISTS ai_model_capability_evidence (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('openai')),
  model_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'candidate', 'unsupported')),
  verification_method TEXT NOT NULL CHECK (verification_method IN ('registry', 'provider_probe', 'administrator')),
  verified_at TIMESTAMPTZ NOT NULL,
  provider_request_id TEXT,
  safe_failure_code TEXT,
  registry_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE(provider, model_id, capability)
);
CREATE INDEX IF NOT EXISTS ai_model_capability_evidence_model_idx
  ON ai_model_capability_evidence(provider, model_id);

ALTER TABLE generated_artifacts
  ADD COLUMN IF NOT EXISTS parent_artifact_id UUID REFERENCES generated_artifacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS presentation_run_id UUID REFERENCES ai_presentation_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'draft_human_review_required';

ALTER TABLE generated_artifacts DROP CONSTRAINT IF EXISTS generated_artifacts_review_status_check;
ALTER TABLE generated_artifacts ADD CONSTRAINT generated_artifacts_review_status_check
  CHECK (review_status IN (
    'draft_human_review_required',
    'reviewed',
    'client_deliverable'
  ));

CREATE TABLE IF NOT EXISTS executive_document_specifications (
  id UUID PRIMARY KEY,
  artifact_id UUID REFERENCES generated_artifacts(id) ON DELETE SET NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  presentation_run_id UUID REFERENCES ai_presentation_runs(id) ON DELETE SET NULL,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template TEXT NOT NULL CHECK (template IN (
    'executive_briefing',
    'lead_review_brief',
    'research_brief',
    'decision_memo'
  )),
  title TEXT NOT NULL,
  specification JSONB NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid', 'rendering', 'rendered', 'failed')),
  document_version INTEGER NOT NULL DEFAULT 1 CHECK (document_version > 0),
  parent_specification_id UUID REFERENCES executive_document_specifications(id) ON DELETE SET NULL,
  review_status TEXT NOT NULL DEFAULT 'draft_human_review_required'
    CHECK (review_status IN ('draft_human_review_required', 'reviewed', 'client_deliverable')),
  related_record_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  citation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS executive_document_specifications_conversation_idx
  ON executive_document_specifications(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executive_document_specifications_artifact_idx
  ON executive_document_specifications(artifact_id);
