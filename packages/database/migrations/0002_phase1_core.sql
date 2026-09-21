CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT,
  status TEXT NOT NULL DEFAULT 'prospect' CHECK (status IN ('active', 'inactive', 'prospect')),
  website TEXT,
  phone TEXT,
  notes TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS companies_name_idx ON companies(name);
CREATE INDEX IF NOT EXISTS companies_status_idx ON companies(status);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  job_title TEXT,
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON contacts(company_id);
CREATE INDEX IF NOT EXISTS contacts_name_idx ON contacts(last_name, first_name);
CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts(email);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee_user_id UUID NOT NULL REFERENCES users(id),
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((status = 'completed' AND completed_at IS NOT NULL) OR (status = 'open' AND completed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS tasks_assignee_status_idx ON tasks(assignee_user_id, status);
CREATE INDEX IF NOT EXISTS tasks_due_at_idx ON tasks(due_at);
CREATE INDEX IF NOT EXISTS tasks_company_id_idx ON tasks(company_id);
CREATE INDEX IF NOT EXISTS tasks_contact_id_idx ON tasks(contact_id);

CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  correlation_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS activities_created_at_idx ON activities(created_at DESC);
CREATE INDEX IF NOT EXISTS activities_company_id_idx ON activities(company_id);
CREATE INDEX IF NOT EXISTS activities_contact_id_idx ON activities(contact_id);
CREATE INDEX IF NOT EXISTS activities_task_id_idx ON activities(task_id);
CREATE INDEX IF NOT EXISTS activities_correlation_id_idx ON activities(correlation_id);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_type TEXT,
  source_id UUID,
  source_href TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'simulated' CHECK (provider = 'simulated'),
  model TEXT NOT NULL DEFAULT 'deterministic-demo-router' CHECK (model = 'deterministic-demo-router'),
  router_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS conversations_owner_updated_idx ON conversations(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('assistant', 'system', 'user')),
  content TEXT NOT NULL,
  provider TEXT CHECK (provider IS NULL OR provider = 'simulated'),
  model TEXT CHECK (model IS NULL OR model = 'deterministic-demo-router'),
  router_version TEXT,
  execution_ms INTEGER CHECK (execution_ms IS NULL OR execution_ms >= 0),
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS assistant_messages_conversation_created_idx
  ON assistant_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS assistant_messages_correlation_id_idx ON assistant_messages(correlation_id);

CREATE TABLE IF NOT EXISTS workspace_artifacts (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'command-center-summary',
    'search-results',
    'company-list',
    'company-detail',
    'contact-list',
    'contact-detail',
    'task-list',
    'task-detail',
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
  )),
  title TEXT NOT NULL,
  subtitle TEXT,
  state TEXT NOT NULL CHECK (state IN ('ready', 'loading', 'empty', 'failed')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  links JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS workspace_artifacts_conversation_created_idx
  ON workspace_artifacts(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_artifacts_requester_idx ON workspace_artifacts(requested_by_user_id);

CREATE TABLE IF NOT EXISTS suggested_actions (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type = 'task.create'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'executed', 'denied', 'failed')),
  payload JSONB NOT NULL,
  required_permission TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS suggested_actions_conversation_created_idx
  ON suggested_actions(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS suggested_actions_requester_status_idx
  ON suggested_actions(requested_by_user_id, status);

CREATE TABLE IF NOT EXISTS action_approvals (
  id UUID PRIMARY KEY,
  suggested_action_id UUID NOT NULL UNIQUE REFERENCES suggested_actions(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS action_approvals_actor_idx ON action_approvals(actor_user_id);

CREATE TABLE IF NOT EXISTS action_executions (
  id UUID PRIMARY KEY,
  suggested_action_id UUID NOT NULL UNIQUE REFERENCES suggested_actions(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS action_executions_actor_created_idx
  ON action_executions(actor_user_id, created_at DESC);
