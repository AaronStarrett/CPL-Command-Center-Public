-- Forward-only hosted slice. No customer records or identities are seeded.
ALTER TABLE cpl_identities ADD COLUMN email TEXT;
ALTER TABLE cpl_identities ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cpl_identities ADD COLUMN hosted_domain TEXT;
ALTER TABLE cpl_sessions ADD COLUMN csrf_token_hash TEXT;
ALTER TABLE cpl_sessions ADD COLUMN absolute_expires_at TIMESTAMPTZ;
ALTER TABLE cpl_sessions ADD COLUMN mfa_verified_at TIMESTAMPTZ;
ALTER TABLE cpl_sessions ADD COLUMN selected_organization_id UUID REFERENCES cpl_organizations(id);
CREATE TABLE cpl_oauth_flows (
  browser_binding_hash TEXT NOT NULL,
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX cpl_oauth_expiry_idx ON cpl_oauth_flows(expires_at);
CREATE TABLE cpl_webauthn_credentials (
  id TEXT PRIMARY KEY,
  identity_id UUID NOT NULL REFERENCES cpl_identities(id),
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL CHECK (counter >= 0),
  transports_json JSONB NOT NULL,
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice','multiDevice')),
  backed_up BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX cpl_webauthn_identity_idx ON cpl_webauthn_credentials(identity_id);
CREATE TABLE cpl_webauthn_challenges (
  ceremony_token_hash TEXT PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES cpl_sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('registration','authentication')),
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX cpl_webauthn_challenge_expiry_idx ON cpl_webauthn_challenges(expires_at);
CREATE TABLE cpl_platform_owner_binding (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  identity_id UUID NOT NULL UNIQUE REFERENCES cpl_identities(id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE cpl_auth_rate_limits (
  key_hash TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count > 0),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX cpl_auth_rate_expiry_idx ON cpl_auth_rate_limits(expires_at);
CREATE TABLE cpl_auth_audit_events (
  id UUID PRIMARY KEY,
  identity_id UUID NOT NULL REFERENCES cpl_identities(id),
  session_id UUID REFERENCES cpl_sessions(id),
  action TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX cpl_auth_audit_identity_idx ON cpl_auth_audit_events(identity_id,occurred_at);

-- Written only by the migration/operator role. Runtime cannot register or elevate itself.
CREATE TABLE cpl_runtime_roles (
  role_name NAME PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('web','worker'))
);
CREATE TABLE cpl_workflow_leads (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  title TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT,
  details TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_proposal_drafts (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  lead_id UUID NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status='draft'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  prepared_version INTEGER,
  prepared_sha256 TEXT,
  created_by_identity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,lead_id) REFERENCES cpl_workflow_leads(organization_id,id),
  FOREIGN KEY (organization_id,created_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE TABLE cpl_workflow_mutations (
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('lead.create','proposal.create')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id,mutation_kind,idempotency_key)
);
CREATE TABLE cpl_workflow_jobs (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  proposal_id UUID NOT NULL,
  proposal_version INTEGER NOT NULL CHECK (proposal_version > 0),
  kind TEXT NOT NULL DEFAULT 'proposal.prepare' CHECK (kind='proposal.prepare'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 3),
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token UUID,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  issued_by_identity_id UUID NOT NULL,
  issued_membership_version INTEGER NOT NULL CHECK (issued_membership_version > 0),
  last_error_code TEXT,
  result_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,proposal_id,proposal_version,kind),
  FOREIGN KEY (organization_id,proposal_id) REFERENCES cpl_proposal_drafts(organization_id,id),
  FOREIGN KEY (organization_id,issued_by_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
CREATE INDEX cpl_workflow_job_claim_idx ON cpl_workflow_jobs(status,available_at,lease_expires_at);
CREATE INDEX cpl_workflow_lead_org_idx ON cpl_workflow_leads(organization_id,created_at);
CREATE INDEX cpl_proposal_draft_org_idx ON cpl_proposal_drafts(organization_id,created_at);

ALTER TABLE cpl_workflow_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_workflow_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_workflow_lead_scope ON cpl_workflow_leads
  USING (organization_id::text=current_setting('cpl.organization_id',true))
  WITH CHECK (organization_id::text=current_setting('cpl.organization_id',true));
ALTER TABLE cpl_proposal_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_proposal_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_proposal_draft_scope ON cpl_proposal_drafts
  USING (organization_id::text=current_setting('cpl.organization_id',true))
  WITH CHECK (organization_id::text=current_setting('cpl.organization_id',true));
ALTER TABLE cpl_workflow_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_workflow_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_workflow_mutation_scope ON cpl_workflow_mutations
  USING (organization_id::text=current_setting('cpl.organization_id',true))
  WITH CHECK (organization_id::text=current_setting('cpl.organization_id',true));
ALTER TABLE cpl_workflow_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_workflow_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_workflow_job_scope ON cpl_workflow_jobs
  USING (organization_id::text=current_setting('cpl.organization_id',true))
  WITH CHECK (organization_id::text=current_setting('cpl.organization_id',true));
-- A distinct operator-configured scheduler login can dequeue durable jobs across
-- organizations. The web login is never registered as worker and cannot edit this registry.
CREATE POLICY cpl_workflow_job_dispatch_read ON cpl_workflow_jobs FOR SELECT
  USING (EXISTS (SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker'));
CREATE POLICY cpl_workflow_job_dispatch_update ON cpl_workflow_jobs FOR UPDATE
  USING (EXISTS (SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker'))
  WITH CHECK (EXISTS (SELECT 1 FROM cpl_runtime_roles WHERE role_name=current_user AND purpose='worker'));
