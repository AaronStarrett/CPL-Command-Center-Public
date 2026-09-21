ALTER TABLE ingestion_staging_runs
  ADD COLUMN IF NOT EXISTS raw_source_text TEXT,
  ADD COLUMN IF NOT EXISTS raw_source_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS raw_source_byte_length BIGINT,
  ADD COLUMN IF NOT EXISTS inspection_id UUID REFERENCES inspections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS last_error JSONB,
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE ingestion_staging_runs
  DROP CONSTRAINT IF EXISTS ingestion_staging_runs_raw_source_integrity_chk;
ALTER TABLE ingestion_staging_runs
  ADD CONSTRAINT ingestion_staging_runs_raw_source_integrity_chk
  CHECK (
    (
      raw_source_text IS NULL
      AND raw_source_sha256 IS NULL
      AND raw_source_byte_length IS NULL
    )
    OR (
      raw_source_text IS NOT NULL
      AND raw_source_sha256 IS NOT NULL
      AND char_length(raw_source_sha256) = 64
      AND raw_source_byte_length IS NOT NULL
      AND raw_source_byte_length >= 0
    )
  );

CREATE INDEX IF NOT EXISTS ingestion_staging_runs_inspection_idx
  ON ingestion_staging_runs(inspection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_staging_runs_raw_hash_idx
  ON ingestion_staging_runs(raw_source_sha256, created_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_staging_runs_status_idx
  ON ingestion_staging_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_staging_runs_reconcile_idx
  ON ingestion_staging_runs(inspection_id, source_idempotency_key);
