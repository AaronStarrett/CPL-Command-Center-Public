-- Forward-only administration. No identity, owner, customer or synthetic seed.
ALTER TABLE cpl_invitations ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version>0);
-- Historical grants have no captured authority proof. They remain historical and
-- require explicit reissue; migration cannot infer a past membership version.
ALTER TABLE cpl_invitations ADD COLUMN inviter_membership_version INTEGER NOT NULL DEFAULT 0 CHECK(inviter_membership_version>=0);
ALTER TABLE cpl_invitations ADD COLUMN redeemed_by_identity_id UUID REFERENCES cpl_identities(id);
ALTER TABLE cpl_invitations ADD COLUMN redeemed_membership_version INTEGER CHECK(redeemed_membership_version>0);
ALTER TABLE cpl_invitations ADD COLUMN replaces_id UUID;
ALTER TABLE cpl_invitations ADD CONSTRAINT cpl_invitation_replaces_same_company FOREIGN KEY(organization_id,replaces_id) REFERENCES cpl_invitations(organization_id,id);
CREATE INDEX cpl_invitations_company_page ON cpl_invitations(organization_id,created_at DESC,id DESC);
CREATE INDEX cpl_memberships_company_page ON cpl_memberships(organization_id,created_at DESC,identity_id DESC);
ALTER TABLE cpl_tenant_audit_events ADD COLUMN resource_type TEXT;
ALTER TABLE cpl_tenant_audit_events ADD COLUMN resource_version INTEGER CHECK(resource_version>0);
ALTER TABLE cpl_tenant_audit_events ADD COLUMN safe_summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(safe_summary)='object');
CREATE TABLE cpl_administration_mutations (
 organization_id UUID NOT NULL REFERENCES cpl_organizations(id), actor_identity_id UUID NOT NULL,
 action TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,actor_identity_id,action,idempotency_key),
 FOREIGN KEY(organization_id,actor_identity_id) REFERENCES cpl_memberships(organization_id,identity_id)
);
ALTER TABLE cpl_administration_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_administration_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON cpl_administration_mutations USING(organization_id::text=current_setting('cpl.organization_id',true)) WITH CHECK(organization_id::text=current_setting('cpl.organization_id',true));
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON cpl_administration_mutations FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record();
CREATE TABLE cpl_platform_provision_requests (
 actor_identity_id UUID NOT NULL REFERENCES cpl_identities(id), idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), organization_id UUID NOT NULL REFERENCES cpl_organizations(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(actor_identity_id,idempotency_key)
);
ALTER TABLE cpl_platform_provision_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_platform_provision_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY actor_scope ON cpl_platform_provision_requests USING(actor_identity_id::text=current_setting('cpl.identity_id',true)) WITH CHECK(actor_identity_id::text=current_setting('cpl.identity_id',true));
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON cpl_platform_provision_requests FOR EACH ROW EXECUTE FUNCTION cpl_commercial_immutable_record();
REVOKE ALL ON cpl_administration_mutations,cpl_platform_provision_requests FROM PUBLIC;
DO $$ DECLARE role_name NAME; BEGIN
 FOR role_name IN SELECT r.role_name FROM cpl_runtime_roles r JOIN pg_roles p ON p.rolname=r.role_name WHERE r.purpose='web' LOOP
  EXECUTE format('GRANT SELECT,INSERT ON cpl_administration_mutations,cpl_platform_provision_requests TO %I',role_name);
 END LOOP;
END; $$;
