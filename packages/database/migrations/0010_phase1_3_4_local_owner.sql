ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

CREATE TABLE IF NOT EXISTS auth_identities (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('local-owner', 'microsoft-entra')),
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (provider, subject),
  UNIQUE (provider, user_id)
);

CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities(user_id);

CREATE TABLE IF NOT EXISTS local_owner_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  recovery_code_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT local_owner_username_canonical CHECK (username = lower(username)),
  CONSTRAINT local_owner_password_hash_bounded CHECK (char_length(password_hash) BETWEEN 64 AND 512),
  CONSTRAINT local_owner_recovery_hash_shape CHECK (recovery_code_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS local_owner_credentials_locked_until_idx
  ON local_owner_credentials(locked_until);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bea_system_seed_versions (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
