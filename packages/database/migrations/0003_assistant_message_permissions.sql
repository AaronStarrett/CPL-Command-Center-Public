ALTER TABLE assistant_messages
  ADD COLUMN IF NOT EXISTS required_permissions JSONB NOT NULL
  DEFAULT '[]'::jsonb;
