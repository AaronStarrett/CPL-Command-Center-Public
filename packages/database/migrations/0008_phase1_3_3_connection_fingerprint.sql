ALTER TABLE ai_provider_connection_tests
  ADD COLUMN IF NOT EXISTS credential_fingerprint TEXT;

ALTER TABLE ai_provider_connection_tests
  ADD CONSTRAINT ai_provider_connection_tests_credential_fingerprint_check
  CHECK (
    credential_fingerprint IS NULL OR
    credential_fingerprint ~ '^sha256:[a-f0-9]{12}$'
  );
