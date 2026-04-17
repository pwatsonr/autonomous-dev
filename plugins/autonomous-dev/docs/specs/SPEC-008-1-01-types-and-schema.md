# SPEC-008-1-01: TypeScript Interfaces, SQLite Schema & Migration Framework

## Metadata
- **Parent Plan**: PLAN-008-1
- **Tasks Covered**: Task 1, Task 2
- **Estimated effort**: 7 hours

## Description

Define all shared TypeScript interfaces that form the adapter-to-core contract, and implement the full SQLite database schema with a migration framework. These are the two foundational artifacts upon which every other component depends -- types define the compile-time contracts, and the schema defines the runtime data model.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/adapter_interface.ts` | Create |
| `intake/db/schema.sql` | Create |
| `intake/db/migrations/001_initial.sql` | Create |
| `intake/db/migrator.ts` | Create |

## Implementation Details

### Task 1: TypeScript Interfaces and Shared Types

All types from TDD sections 3.1, 3.5.1, 5.3, and 6.2 must be exported from a single module with JSDoc documentation.

**Types to define:**

```typescript
// Channel and adapter primitives
type ChannelType = 'claude_app' | 'discord' | 'slack';

interface IntakeAdapter {
  readonly channelType: ChannelType;
  start(): Promise<AdapterHandle>;
  sendMessage(target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt>;
  promptUser(target: MessageTarget, prompt: StructuredPrompt): Promise<UserResponse | TimeoutExpired>;
  shutdown(): Promise<void>;
}

interface AdapterHandle {
  dispose(): Promise<void>;
}

// Messaging types
interface MessageTarget {
  channelType: ChannelType;
  userId?: string;
  platformChannelId?: string;
  threadId?: string;
  isDM?: boolean;
}

interface FormattedMessage {
  channelType: ChannelType;
  payload: unknown;         // Channel-specific (Embed | Block[] | string)
  fallbackText: string;
}

interface StructuredPrompt {
  promptType: 'clarifying_question' | 'approval_request' | 'escalation';
  requestId: string;
  content: string;
  options?: PromptOption[];
  timeoutSeconds: number;
}

interface PromptOption {
  label: string;
  value: string;
  style?: 'primary' | 'secondary' | 'danger';
}

interface UserResponse {
  responderId: string;
  content: string;
  selectedOption?: string;
  timestamp: Date;
}

interface TimeoutExpired {
  kind: 'timeout';
  requestId: string;
  promptedAt: Date;
  expiredAt: Date;
}

interface DeliveryReceipt {
  success: boolean;
  platformMessageId?: string;
  error?: string;
  retryable?: boolean;
}

// Command dispatch types
interface IncomingCommand {
  commandName: string;
  args: string[];
  flags: Record<string, string | boolean>;
  rawText: string;
  source: CommandSource;
}

interface CommandSource {
  channelType: ChannelType;
  userId: string;
  platformChannelId?: string;
  threadId?: string;
  timestamp: Date;
}

// NLP / parsing types
interface ParsedRequest {
  title: string;
  description: string;
  priority: 'high' | 'normal' | 'low';
  target_repo: string | null;
  deadline: string | null;
  related_tickets: string[];
  technical_constraints: string | null;
  acceptance_criteria: string | null;
  confidence: number;
}

// Error types
interface ErrorResponse {
  success: false;
  error: string;
  errorCode: string;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHZ_DENIED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'QUEUE_FULL'
  | 'DUPLICATE_DETECTED'
  | 'INJECTION_BLOCKED'
  | 'INJECTION_FLAGGED'
  | 'INTERNAL_ERROR'
  | 'PLATFORM_ERROR';

// Command handler types
interface CommandHandler {
  execute(command: IncomingCommand, userId: string): Promise<CommandResult>;
  buildAuthzContext(command: IncomingCommand): AuthzContext;
  isQueryCommand(): boolean;
}

interface CommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
  retryAfterMs?: number;
}

// Notification types
type VerbosityLevel = 'silent' | 'summary' | 'verbose' | 'debug';

interface NotificationConfig {
  verbosity: VerbosityLevel;
  routes: NotificationRoute[];
}

interface NotificationRoute {
  channelType: ChannelType;
  platformChannelId?: string;
  threadId?: string;
  events?: string[];
}

// Authz types
type AuthzAction =
  | 'submit' | 'status' | 'list' | 'cancel' | 'pause'
  | 'resume' | 'priority' | 'logs' | 'feedback' | 'kill'
  | 'approve_review' | 'config_change';

interface AuthzContext {
  requestId?: string;
  targetRepo?: string;
  gate?: string;
}

interface AuthzDecision {
  granted: boolean;
  userId: string;
  action: AuthzAction;
  reason: string;
  timestamp: Date;
}

type Priority = 'high' | 'normal' | 'low';
type RequestStatus = 'queued' | 'active' | 'paused' | 'cancelled' | 'done' | 'failed';
```

### Task 2: SQLite Schema and Migration Framework

**`schema.sql`** contains the full DDL from TDD section 4.1 as reference documentation.

**`001_initial.sql`** contains the executable DDL applied by the migrator:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS id_counter (
  counter_name TEXT PRIMARY KEY,
  current_value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO id_counter (counter_name, current_value) VALUES ('request_id', 0);

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
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_priority_created ON requests(priority, created_at);
CREATE INDEX idx_requests_requester ON requests(requester_id);
CREATE INDEX idx_requests_updated ON requests(updated_at);

CREATE TABLE IF NOT EXISTS request_embeddings (
  request_id TEXT PRIMARY KEY REFERENCES requests(request_id),
  embedding  BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

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

CREATE TABLE IF NOT EXISTS rate_limit_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('submission', 'query')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_rate_limit_user_type ON rate_limit_actions(user_id, action_type, created_at);

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
```

**`migrator.ts`** implementation:

- Maintains a `_migrations` table: `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`.
- On startup, scans `intake/db/migrations/` for `*.sql` files sorted by filename.
- For each file not yet in `_migrations`, wraps execution in a transaction: run SQL, then `INSERT INTO _migrations (name) VALUES (?)`.
- Idempotent: running twice produces no change.
- Returns a list of newly applied migrations for logging.

## Acceptance Criteria

1. All types listed above are exported from `adapter_interface.ts` with JSDoc on every interface and type.
2. `001_initial.sql` applied by the migrator creates all 8 tables (`id_counter`, `requests`, `request_embeddings`, `conversation_messages`, `user_identities`, `activity_log`, `authz_audit_log`, `rate_limit_actions`, `notification_deliveries`) with correct constraints and indexes.
3. WAL mode is enabled via `PRAGMA journal_mode = WAL`.
4. Foreign keys are enforced via `PRAGMA foreign_keys = ON`.
5. The migrator is idempotent: running it twice on the same database produces no errors and no duplicate `_migrations` rows.
6. The migrator returns the list of newly applied migrations.

## Test Cases

1. **Type compilation**: Import all types from `adapter_interface.ts` in a test file; verify the file compiles with `tsc --noEmit`.
2. **Schema creation on empty DB**: Run migrator on a fresh in-memory SQLite database; assert all 8 tables exist via `SELECT name FROM sqlite_master WHERE type='table'`.
3. **WAL mode active**: After migration, run `PRAGMA journal_mode`; assert result is `wal`.
4. **Foreign keys enforced**: Insert a `conversation_messages` row referencing a nonexistent `request_id`; assert foreign key violation error.
5. **Idempotent migration**: Run migrator twice; assert `_migrations` table has exactly 1 row for `001_initial.sql`.
6. **Index verification**: Query `sqlite_master` for index names; assert all 12 indexes exist (`idx_requests_status`, `idx_requests_priority_created`, `idx_requests_requester`, `idx_requests_updated`, `idx_messages_request`, `idx_messages_pending`, `idx_users_discord`, `idx_users_slack`, `idx_users_claude`, `idx_activity_request`, `idx_activity_created`, `idx_authz_user`, `idx_authz_denials`, `idx_rate_limit_user_type`, `idx_deliveries_pending`).
7. **CHECK constraint validation**: Insert a request with `priority = 'urgent'`; assert CHECK constraint error. Insert with `status = 'running'`; assert CHECK constraint error.
