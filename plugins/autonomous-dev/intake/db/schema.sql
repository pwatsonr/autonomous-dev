-- ==========================================================================
-- Intake Layer: Full SQLite DDL Reference
-- ==========================================================================
-- This file is the canonical reference for the intake database schema.
-- It is NOT executed directly; migrations in migrations/ apply the DDL.
-- ==========================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Request ID counter (monotonic ID generation)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS id_counter (
  counter_name TEXT PRIMARY KEY,
  current_value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO id_counter (counter_name, current_value) VALUES ('request_id', 0);

-- ---------------------------------------------------------------------------
-- Requests: core work-item table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requests (
  request_id        TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  raw_input         TEXT NOT NULL,
  priority          TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('high', 'normal', 'low')),
  target_repo       TEXT,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'active', 'paused', 'cancelled', 'done', 'failed')),
  current_phase     TEXT NOT NULL DEFAULT 'queued',
  phase_progress    TEXT,
  requester_id      TEXT NOT NULL,
  source_channel    TEXT NOT NULL
                    CHECK (source_channel IN ('claude_app', 'discord', 'slack')),
  notification_config TEXT NOT NULL DEFAULT '{}',
  deadline          TEXT,
  related_tickets   TEXT DEFAULT '[]',
  technical_constraints TEXT,
  acceptance_criteria TEXT,
  blocker           TEXT,
  promotion_count   INTEGER NOT NULL DEFAULT 0,
  last_promoted_at  TEXT,
  paused_at_phase   TEXT,
  -- v2 (002_add_source_metadata.sql):
  source            TEXT NOT NULL DEFAULT 'cli'
                    CHECK (source IN (
                      'cli', 'claude-app', 'discord', 'slack',
                      'production-intelligence', 'portal'
                    )),
  adapter_metadata  TEXT NOT NULL DEFAULT '{}'
                    CHECK (json_valid(adapter_metadata)),
  -- end v2
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_priority_created ON requests(priority, created_at);
CREATE INDEX idx_requests_requester ON requests(requester_id);
CREATE INDEX idx_requests_updated ON requests(updated_at);
-- v2 indexes (002_add_source_metadata.sql):
CREATE INDEX idx_requests_source ON requests(source);
CREATE INDEX idx_requests_source_status ON requests(source, status, created_at);
-- end v2

-- ---------------------------------------------------------------------------
-- Request embeddings: vector storage for dedup / similarity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_embeddings (
  request_id TEXT PRIMARY KEY REFERENCES requests(request_id),
  embedding  BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Conversation messages: bidirectional message log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_messages (
  message_id   TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES requests(request_id),
  direction    TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel      TEXT NOT NULL CHECK (channel IN ('claude_app', 'discord', 'slack', 'feedback')),
  content      TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN (
    'clarifying_question', 'feedback', 'escalation', 'status_update', 'approval_request'
  )),
  responded    INTEGER NOT NULL DEFAULT 0,
  timeout_at   TEXT,
  thread_id    TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_messages_request ON conversation_messages(request_id);
CREATE INDEX idx_messages_pending ON conversation_messages(responded, timeout_at)
  WHERE responded = 0 AND timeout_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- User identities: cross-platform user mapping and RBAC
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_identities (
  internal_id        TEXT PRIMARY KEY,
  role               TEXT NOT NULL DEFAULT 'viewer'
                     CHECK (role IN ('admin', 'operator', 'contributor', 'viewer')),
  discord_id         TEXT UNIQUE,
  slack_id           TEXT UNIQUE,
  claude_user        TEXT UNIQUE,
  repo_permissions   TEXT NOT NULL DEFAULT '{}',
  rate_limit_override TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_users_discord ON user_identities(discord_id) WHERE discord_id IS NOT NULL;
CREATE INDEX idx_users_slack ON user_identities(slack_id) WHERE slack_id IS NOT NULL;
CREATE INDEX idx_users_claude ON user_identities(claude_user) WHERE claude_user IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Activity log: event stream for requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  log_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT NOT NULL REFERENCES requests(request_id),
  event       TEXT NOT NULL,
  phase       TEXT,
  details     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_activity_request ON activity_log(request_id, created_at);
CREATE INDEX idx_activity_created ON activity_log(created_at);

-- ---------------------------------------------------------------------------
-- Authz audit log: authorization decision history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS authz_audit_log (
  audit_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  action       TEXT NOT NULL,
  resource     TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('grant', 'deny')),
  reason       TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_authz_user ON authz_audit_log(user_id, created_at);
CREATE INDEX idx_authz_denials ON authz_audit_log(decision, created_at) WHERE decision = 'deny';

-- ---------------------------------------------------------------------------
-- Rate limit actions: sliding-window rate limiting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('submission', 'query')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_rate_limit_user_type ON rate_limit_actions(user_id, action_type, created_at);

-- ---------------------------------------------------------------------------
-- Notification deliveries: delivery tracking with retry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   TEXT NOT NULL REFERENCES requests(request_id),
  channel_type TEXT NOT NULL,
  target       TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at TEXT
);

CREATE INDEX idx_deliveries_pending ON notification_deliveries(status) WHERE status = 'pending';
