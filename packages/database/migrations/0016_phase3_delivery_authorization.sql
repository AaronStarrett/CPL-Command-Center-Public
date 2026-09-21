ALTER TABLE automation_jobs
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

ALTER TABLE sla_clocks
  ADD COLUMN IF NOT EXISTS paused_total_ms BIGINT NOT NULL DEFAULT 0;

ALTER TABLE exception_cases
  ADD COLUMN IF NOT EXISTS resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE exception_cases
  ADD COLUMN IF NOT EXISTS resolved_by_actor_type TEXT;

ALTER TABLE exception_cases DROP CONSTRAINT IF EXISTS exception_cases_resolved_by_actor_type_check;
ALTER TABLE exception_cases
  ADD CONSTRAINT exception_cases_resolved_by_actor_type_check
  CHECK (
    resolved_by_actor_type IS NULL
    OR resolved_by_actor_type IN ('user', 'system', 'worker', 'connector')
  );

CREATE TABLE IF NOT EXISTS delivery_authorizations (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES inspection_reports(id) ON DELETE CASCADE,
  report_version_id UUID NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
  artifact_checksum TEXT NOT NULL,
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  destination_kind TEXT NOT NULL CHECK (destination_kind IN ('local_test', 'client')),
  authorizing_user_id UUID NOT NULL REFERENCES users(id),
  authorized_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'revoked', 'superseded', 'expired')),
  consumed_at TIMESTAMPTZ,
  consumed_by_job_id UUID,
  reserved_token TEXT,
  reserved_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS delivery_authorizations_report_id_idx
  ON delivery_authorizations(report_id, authorized_at DESC);
CREATE INDEX IF NOT EXISTS delivery_authorizations_version_idx
  ON delivery_authorizations(report_version_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_authorizations_active_report_uidx
  ON delivery_authorizations(report_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS automation_jobs_lease_idx
  ON automation_jobs(status, available_at, lease_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS report_deliveries_confirmed_report_uidx
  ON report_deliveries(report_id)
  WHERE status = 'delivered';
