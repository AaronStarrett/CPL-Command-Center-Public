CREATE SEQUENCE IF NOT EXISTS bea_lead_reference_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'referral', 'in_person')),
  source_details TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  opportunity_name TEXT NOT NULL,
  request_summary TEXT NOT NULL,
  requested_service TEXT,
  site_name TEXT,
  site_address_line1 TEXT,
  site_address_line2 TEXT,
  site_city TEXT,
  site_region TEXT,
  site_postal_code TEXT,
  site_country TEXT,
  desired_deadline_at TIMESTAMPTZ,
  requested_visit_at TIMESTAMPTZ,
  reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'needs_info', 'ready_for_proposal', 'disqualified')),
  disqualification_reason TEXT,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (
    (status <> 'disqualified')
    OR (disqualification_reason IS NOT NULL AND length(btrim(disqualification_reason)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS leads_reference_uidx ON leads(reference);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status);
CREATE INDEX IF NOT EXISTS leads_source_type_idx ON leads(source_type);
CREATE INDEX IF NOT EXISTS leads_reviewer_user_id_idx ON leads(reviewer_user_id);
CREATE INDEX IF NOT EXISTS leads_received_at_idx ON leads(received_at DESC);
CREATE INDEX IF NOT EXISTS leads_opportunity_name_idx ON leads(opportunity_name);
CREATE INDEX IF NOT EXISTS leads_created_by_user_id_idx ON leads(created_by_user_id);
CREATE INDEX IF NOT EXISTS leads_status_received_idx ON leads(status, received_at DESC);

CREATE TABLE IF NOT EXISTS lead_parties (
  id UUID PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN (
    'requester',
    'client_company',
    'primary_contact',
    'property_owner',
    'general_contractor',
    'approval_authority',
    'billing_contact'
  )),
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  unmatched_company_name TEXT,
  unmatched_contact_name TEXT,
  unmatched_email TEXT,
  unmatched_phone TEXT,
  notes TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (lead_id, role)
);

CREATE INDEX IF NOT EXISTS lead_parties_lead_id_idx ON lead_parties(lead_id);
CREATE INDEX IF NOT EXISTS lead_parties_company_id_idx ON lead_parties(company_id);
CREATE INDEX IF NOT EXISTS lead_parties_contact_id_idx ON lead_parties(contact_id);
CREATE INDEX IF NOT EXISTS lead_parties_role_idx ON lead_parties(role);

CREATE TABLE IF NOT EXISTS lead_status_events (
  id UUID PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('new', 'needs_info', 'ready_for_proposal', 'disqualified')),
  to_status TEXT NOT NULL CHECK (to_status IN ('new', 'needs_info', 'ready_for_proposal', 'disqualified')),
  reason TEXT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  correlation_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS lead_status_events_lead_id_idx ON lead_status_events(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_status_events_actor_user_id_idx ON lead_status_events(actor_user_id);
CREATE INDEX IF NOT EXISTS lead_status_events_correlation_id_idx ON lead_status_events(correlation_id);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_lead_id_idx ON tasks(lead_id);

ALTER TABLE activities ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS activities_lead_id_idx ON activities(lead_id);

ALTER TABLE workspace_artifacts DROP CONSTRAINT IF EXISTS workspace_artifacts_type_check;
ALTER TABLE workspace_artifacts ADD CONSTRAINT workspace_artifacts_type_check CHECK (type IN (
  'command-center-summary',
  'search-results',
  'company-list',
  'company-detail',
  'contact-list',
  'contact-detail',
  'task-list',
  'task-detail',
  'lead-list',
  'lead-detail',
  'activity-timeline',
  'notification-list',
  'integration-health-summary',
  'integration-detail',
  'workflow-run-list',
  'workflow-run-detail',
  'audit-summary',
  'action-preview',
  'action-result',
  'help',
  'empty',
  'error'
));
