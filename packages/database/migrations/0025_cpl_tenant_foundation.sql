-- Additive control plane only. Legacy operational tables are intentionally untouched.
-- Runtime must stay gated until those tables are explicitly mapped and isolated.
CREATE TABLE cpl_identities (
  id UUID PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (issuer, subject)
);
CREATE TABLE cpl_sessions (
  id UUID PRIMARY KEY,
  identity_id UUID NOT NULL REFERENCES cpl_identities(id),
  token_hash TEXT NOT NULL UNIQUE,
  authenticated_at TIMESTAMPTZ NOT NULL,
  mfa_verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > authenticated_at)
);
CREATE TABLE cpl_platform_administrators (
  identity_id UUID PRIMARY KEY REFERENCES cpl_identities(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  provisioned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Deliberately no platform administrator seed or public self-enrollment operation.
CREATE TABLE cpl_organizations (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleting')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE cpl_memberships (
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  identity_id UUID NOT NULL REFERENCES cpl_identities(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'reviewer', 'member', 'field-user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, identity_id)
);
CREATE TABLE cpl_module_entitlements (
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  module_key TEXT NOT NULL CHECK (module_key IN (
    'intake-job-tracker', 'field-report-assembler', 'proposal-builder', 'invoice-ready-closeout',
    'scope-change-detector', 'missing-information-coordinator', 'award-to-project-launcher',
    'pre-visit-readiness', 'recurring-service', 'ai-receptionist'
  )),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (organization_id, module_key)
);
CREATE TABLE cpl_organization_settings (
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  setting_key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_identity_id UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, setting_key),
  FOREIGN KEY (organization_id, updated_by_identity_id)
    REFERENCES cpl_memberships(organization_id, identity_id)
);
CREATE TABLE cpl_invitations (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  token_hash TEXT NOT NULL UNIQUE,
  recipient_issuer TEXT NOT NULL,
  recipient_subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'reviewer', 'member', 'field-user')),
  invited_by_identity_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, invited_by_identity_id)
    REFERENCES cpl_memberships(organization_id, identity_id)
);
CREATE TABLE cpl_service_grants (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  module_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issued_by_identity_id UUID NOT NULL,
  issued_membership_version INTEGER NOT NULL CHECK (issued_membership_version > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, issued_by_identity_id)
    REFERENCES cpl_memberships(organization_id, identity_id),
  FOREIGN KEY (organization_id, module_key)
    REFERENCES cpl_module_entitlements(organization_id, module_key)
);
CREATE TABLE cpl_tenant_audit_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  actor_identity_id UUID NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id, actor_identity_id)
    REFERENCES cpl_memberships(organization_id, identity_id)
);
CREATE INDEX cpl_sessions_identity_idx ON cpl_sessions(identity_id, expires_at);
CREATE INDEX cpl_memberships_identity_idx ON cpl_memberships(identity_id, status);
CREATE INDEX cpl_tenant_audit_org_idx ON cpl_tenant_audit_events(organization_id, created_at);

-- App connections must be NOSUPERUSER NOBYPASSRLS. FORCE also protects table owners,
-- but PostgreSQL superusers and BYPASSRLS connections remain explicitly unsuitable.
ALTER TABLE cpl_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_organization_scope ON cpl_organizations
  USING (id::text = current_setting('cpl.organization_id', true))
  WITH CHECK (id::text = current_setting('cpl.organization_id', true));
ALTER TABLE cpl_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_membership_scope ON cpl_memberships
  USING (organization_id::text = current_setting('cpl.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('cpl.organization_id', true));
CREATE POLICY cpl_membership_self_read ON cpl_memberships FOR SELECT
  USING (identity_id::text = current_setting('cpl.identity_id', true));
ALTER TABLE cpl_module_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_module_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_entitlement_scope ON cpl_module_entitlements
  USING (organization_id::text = current_setting('cpl.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('cpl.organization_id', true));
ALTER TABLE cpl_organization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_organization_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_setting_scope ON cpl_organization_settings
  USING (organization_id::text = current_setting('cpl.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('cpl.organization_id', true));
ALTER TABLE cpl_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_invitation_scope ON cpl_invitations
  USING (organization_id::text = current_setting('cpl.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('cpl.organization_id', true));
ALTER TABLE cpl_service_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_service_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_service_grant_scope ON cpl_service_grants
  USING (organization_id::text = current_setting('cpl.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('cpl.organization_id', true));
ALTER TABLE cpl_tenant_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_tenant_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_audit_scope ON cpl_tenant_audit_events
  USING (organization_id::text = current_setting('cpl.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('cpl.organization_id', true));

CREATE TABLE cpl_platform_audit_events (
  id UUID PRIMARY KEY,
  actor_identity_id UUID NOT NULL REFERENCES cpl_identities(id),
  organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
  action TEXT NOT NULL,
  resource_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE cpl_platform_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_platform_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY cpl_platform_audit_scope ON cpl_platform_audit_events
  USING (organization_id::text = current_setting('cpl.organization_id', true))
  WITH CHECK (organization_id::text = current_setting('cpl.organization_id', true));
