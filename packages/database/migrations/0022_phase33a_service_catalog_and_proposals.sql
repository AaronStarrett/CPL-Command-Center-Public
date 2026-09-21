CREATE SEQUENCE IF NOT EXISTS bea_proposal_reference_seq START WITH 1 INCREMENT BY 1;

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS proposal_id UUID;

ALTER TABLE operational_work_items
  ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;

ALTER TABLE operational_work_items
  ADD COLUMN IF NOT EXISTS proposal_id UUID;

ALTER TABLE operational_work_items
  ADD COLUMN IF NOT EXISTS proposal_version_id UUID;

ALTER TABLE operational_work_items
  ADD COLUMN IF NOT EXISTS catalog_version_id UUID;

ALTER TABLE operational_work_items
  ADD COLUMN IF NOT EXISTS pricing_override_id UUID;

ALTER TABLE operational_work_items DROP CONSTRAINT IF EXISTS operational_work_items_work_item_kind_check;
ALTER TABLE operational_work_items
  ADD CONSTRAINT operational_work_items_work_item_kind_check CHECK (work_item_kind IN (
    'inspection_readiness', 'inspection_submission', 'inspection_correction',
    'report_technical_review', 'report_revision', 'report_delivery_authorization',
    'delivery_reconciliation', 'automation_failure', 'sla_escalation',
    'proposal_preparation', 'proposal_information', 'proposal_review',
    'proposal_revision', 'proposal_pricing_override', 'proposal_delivery_preparation'
  ));

CREATE TABLE IF NOT EXISTS service_catalogs (
  id UUID PRIMARY KEY,
  catalog_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  service_context_key TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  production_ready BOOLEAN NOT NULL DEFAULT FALSE,
  disclosure TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS service_catalog_versions (
  id UUID PRIMARY KEY,
  catalog_id UUID NOT NULL REFERENCES service_catalogs(id) ON DELETE CASCADE,
  catalog_key TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'validation_failed', 'validated', 'published', 'active', 'superseded', 'archived'
  )),
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  production_ready BOOLEAN NOT NULL DEFAULT FALSE,
  service_context_key TEXT NOT NULL,
  currency TEXT NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  disclosure TEXT NOT NULL,
  checksum TEXT,
  validated_identity_checksum TEXT,
  package_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  validated_at TIMESTAMPTZ,
  validated_by_user_id UUID REFERENCES users(id),
  published_at TIMESTAMPTZ,
  published_by_user_id UUID REFERENCES users(id),
  activated_at TIMESTAMPTZ,
  activated_by_user_id UUID REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  parent_version_id UUID REFERENCES service_catalog_versions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (catalog_id, version_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS service_catalog_versions_active_context_uidx
  ON service_catalog_versions (service_context_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS service_catalog_versions_status_idx
  ON service_catalog_versions(status, catalog_key, version_number);

CREATE TABLE IF NOT EXISTS service_catalog_items (
  id UUID PRIMARY KEY,
  catalog_version_id UUID NOT NULL REFERENCES service_catalog_versions(id) ON DELETE CASCADE,
  service_key TEXT NOT NULL,
  service_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  scope_template TEXT NOT NULL,
  default_deliverables JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
  unit_of_measure TEXT NOT NULL,
  pricing_model TEXT NOT NULL CHECK (pricing_model IN (
    'fixed_fee', 'unit_rate', 'hourly', 'daily', 'allowance', 'reimbursable', 'no_charge'
  )),
  default_rate_minor BIGINT NOT NULL CHECK (default_rate_minor >= 0),
  minimum_quantity_scaled BIGINT NOT NULL CHECK (minimum_quantity_scaled >= 0),
  maximum_quantity_scaled BIGINT NOT NULL CHECK (maximum_quantity_scaled >= minimum_quantity_scaled),
  eligibility_notes TEXT NOT NULL DEFAULT '',
  required_lead_information JSONB NOT NULL DEFAULT '[]'::jsonb,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (catalog_version_id, service_key)
);

CREATE INDEX IF NOT EXISTS service_catalog_items_version_idx
  ON service_catalog_items(catalog_version_id, display_order);

CREATE TABLE IF NOT EXISTS commercial_policy_versions (
  id UUID PRIMARY KEY,
  catalog_version_id UUID NOT NULL REFERENCES service_catalog_versions(id) ON DELETE CASCADE,
  policy_kind TEXT NOT NULL CHECK (policy_kind IN (
    'terms', 'approval', 'proposal_template', 'delivery'
  )),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  checksum TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (catalog_version_id, policy_kind)
);

CREATE TABLE IF NOT EXISTS proposals (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  lead_id UUID NOT NULL REFERENCES leads(id),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'needs_information', 'ready_for_review', 'in_review', 'revision_required',
    'approved', 'ready_for_delivery', 'cancelled', 'superseded'
  )),
  current_version_number INTEGER NOT NULL DEFAULT 0 CHECK (current_version_number >= 0),
  assigned_preparer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  catalog_version_id UUID NOT NULL REFERENCES service_catalog_versions(id),
  commercial_policy_version_id UUID REFERENCES commercial_policy_versions(id) ON DELETE SET NULL,
  opportunity_name TEXT NOT NULL,
  currency TEXT NOT NULL,
  subtotal_minor BIGINT NOT NULL DEFAULT 0,
  total_minor BIGINT NOT NULL DEFAULT 0,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  scope_text TEXT NOT NULL DEFAULT '',
  deliverables JSONB NOT NULL DEFAULT '[]'::jsonb,
  assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
  schedule_text TEXT,
  lead_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS proposals_active_lead_uidx
  ON proposals (lead_id)
  WHERE status NOT IN ('cancelled', 'superseded');

CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals(status, updated_at);
CREATE INDEX IF NOT EXISTS proposals_preparer_idx ON proposals(assigned_preparer_user_id, status);
CREATE INDEX IF NOT EXISTS proposals_reviewer_idx ON proposals(assigned_reviewer_user_id, status);
CREATE INDEX IF NOT EXISTS proposals_catalog_idx ON proposals(catalog_version_id);

CREATE TABLE IF NOT EXISTS proposal_versions (
  id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL CHECK (status IN (
    'mutable_draft', 'frozen_review', 'revision_required', 'approved', 'superseded'
  )),
  lead_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  party_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  catalog_version_id UUID NOT NULL REFERENCES service_catalog_versions(id),
  line_item_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope_text TEXT NOT NULL DEFAULT '',
  deliverables JSONB NOT NULL DEFAULT '[]'::jsonb,
  assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
  schedule_text TEXT,
  terms_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_minor BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  review_decision TEXT,
  approval_evidence JSONB,
  document_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  rendered_checksum TEXT,
  file_name TEXT,
  superseded_at TIMESTAMPTZ,
  frozen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (proposal_id, version_number)
);

CREATE INDEX IF NOT EXISTS proposal_versions_proposal_idx
  ON proposal_versions(proposal_id, version_number);

CREATE TABLE IF NOT EXISTS proposal_line_items (
  id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  proposal_version_id UUID REFERENCES proposal_versions(id) ON DELETE CASCADE,
  line_key TEXT NOT NULL,
  service_key TEXT NOT NULL,
  service_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  pricing_model TEXT NOT NULL,
  unit_of_measure TEXT NOT NULL,
  currency TEXT NOT NULL,
  catalog_unit_amount_minor BIGINT NOT NULL,
  unit_amount_minor BIGINT NOT NULL,
  quantity_scaled BIGINT NOT NULL CHECK (quantity_scaled >= 0),
  line_subtotal_minor BIGINT NOT NULL,
  calculation_method TEXT NOT NULL,
  scope_text TEXT NOT NULL DEFAULT '',
  deliverables JSONB NOT NULL DEFAULT '[]'::jsonb,
  assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
  override_id UUID,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS proposal_line_items_draft_uidx
  ON proposal_line_items (proposal_id, line_key)
  WHERE proposal_version_id IS NULL;

CREATE INDEX IF NOT EXISTS proposal_line_items_proposal_idx
  ON proposal_line_items(proposal_id, display_order);

CREATE TABLE IF NOT EXISTS proposal_reviews (
  id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  proposal_version_id UUID NOT NULL REFERENCES proposal_versions(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'request_revision')),
  comments TEXT NOT NULL DEFAULT '',
  requested_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_user_id UUID NOT NULL REFERENCES users(id),
  checksum TEXT,
  total_minor BIGINT,
  currency TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS proposal_reviews_version_idx
  ON proposal_reviews(proposal_version_id, created_at);

CREATE TABLE IF NOT EXISTS proposal_pricing_overrides (
  id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  proposal_version_id UUID REFERENCES proposal_versions(id) ON DELETE SET NULL,
  line_key TEXT NOT NULL,
  original_amount_minor BIGINT NOT NULL,
  proposed_amount_minor BIGINT NOT NULL,
  difference_minor BIGINT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'rejected')),
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  approved_by_user_id UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS proposal_pricing_overrides_proposal_idx
  ON proposal_pricing_overrides(proposal_id, status);

CREATE TABLE IF NOT EXISTS proposal_delivery_manifests (
  id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  proposal_version_id UUID NOT NULL REFERENCES proposal_versions(id) ON DELETE CASCADE,
  sender_mailbox TEXT NOT NULL,
  to_recipient TEXT NOT NULL,
  cc_recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  proposal_reference TEXT NOT NULL,
  proposal_version_number INTEGER NOT NULL,
  attachment_file_name TEXT NOT NULL,
  attachment_checksum TEXT NOT NULL,
  intended_authorization TEXT NOT NULL,
  connector_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  connector_readiness TEXT NOT NULL,
  live_writes BOOLEAN NOT NULL DEFAULT FALSE CHECK (live_writes = FALSE),
  disclosure TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  policy_key TEXT NOT NULL DEFAULT 'synthetic-proposal-delivery',
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS proposal_delivery_manifests_version_policy_uidx
  ON proposal_delivery_manifests (proposal_version_id, policy_key);

CREATE TABLE IF NOT EXISTS proposal_status_events (
  id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  proposal_version_id UUID REFERENCES proposal_versions(id) ON DELETE SET NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS proposal_status_events_proposal_idx
  ON proposal_status_events(proposal_id, created_at);

ALTER TABLE activities
  ADD CONSTRAINT activities_proposal_id_fkey
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE SET NULL;

ALTER TABLE operational_work_items
  ADD CONSTRAINT operational_work_items_proposal_id_fkey
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE SET NULL;

ALTER TABLE operational_work_items
  ADD CONSTRAINT operational_work_items_proposal_version_id_fkey
  FOREIGN KEY (proposal_version_id) REFERENCES proposal_versions(id) ON DELETE SET NULL;

ALTER TABLE operational_work_items
  ADD CONSTRAINT operational_work_items_catalog_version_id_fkey
  FOREIGN KEY (catalog_version_id) REFERENCES service_catalog_versions(id) ON DELETE SET NULL;

ALTER TABLE operational_work_items
  ADD CONSTRAINT operational_work_items_pricing_override_id_fkey
  FOREIGN KEY (pricing_override_id) REFERENCES proposal_pricing_overrides(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS operational_work_items_lead_idx
  ON operational_work_items(lead_id, status);
CREATE INDEX IF NOT EXISTS operational_work_items_proposal_idx
  ON operational_work_items(proposal_id, status);
CREATE INDEX IF NOT EXISTS activities_proposal_idx ON activities(proposal_id);
