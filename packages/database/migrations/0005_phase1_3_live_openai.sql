ALTER TABLE ai_provider_connection_tests
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER
    CHECK (latency_ms IS NULL OR latency_ms >= 0);
