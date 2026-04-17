# TDD-008: Intake & Communication Layer

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Intake & Communication Layer                       |
| **TDD ID**   | TDD-008                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-08                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-006: Intake & Communication Layer            |
| **Plugin**   | autonomous-dev                                     |

---

## 1. Overview

This document defines the technical design for the Intake & Communication Layer of the `autonomous-dev` plugin. The layer is the boundary between human operators and the autonomous pipeline. It is responsible for accepting work requests from three channels (Claude App native, Discord, Slack), parsing them into structured records, managing a priority queue, delivering status notifications, enabling bidirectional mid-pipeline communication, and enforcing authorization and rate limiting.

The design follows a channel-adapter pattern: each intake channel implements a shared `IntakeAdapter` interface and delegates all state, queue, and authorization logic to a shared core. This allows adding future channels without modifying business logic.

### Key Design Principles

1. **Adapter isolation.** Channel-specific code (Discord API calls, Slack Block Kit rendering) lives in adapter modules. The core never imports channel libraries.
2. **Single source of truth.** All state lives in SQLite with WAL mode. Adapters are stateless and interchangeable.
3. **Structured event boundary.** The adapter-to-core interface uses typed event objects, never raw strings. This is the primary defense against prompt injection at the system boundary (NFR-07).
4. **Fail-safe defaults.** Rate limits, queue caps, and injection sanitization are on by default. Operators opt out, not in.

---

## 2. Architecture

### 2.1 Channel Integration Diagram

```
                    +-----------------+
                    |  Claude App CLI  |
                    |  (slash command) |
                    +--------+--------+
                             |
                    +--------v--------+
                    | ClaudeAdapter   |
                    | (IntakeAdapter) |
                    +--------+--------+
                             |
+------------------+         |         +------------------+
|  Discord Server  |         |         |  Slack Workspace |
|  (slash commands |         |         |  (slash commands |
|   embeds, btns)  |         |         |   block kit)     |
+--------+---------+         |         +---------+--------+
         |                   |                   |
+--------v--------+          |          +--------v--------+
| DiscordAdapter  |          |          | SlackAdapter    |
| (IntakeAdapter) |          |          | (IntakeAdapter) |
+--------+--------+          |          +--------+--------+
         |                   |                   |
         +-------------------+-------------------+
                             |
                    +--------v--------+
                    | IntakeRouter    |
                    | (command parse, |
                    |  dispatch)      |
                    +--------+--------+
                             |
          +------------------+------------------+
          |                  |                  |
+---------v------+  +--------v-------+  +------v-----------+
| RequestParser  |  | AuthzEngine    |  | RateLimiter      |
| & Enrichment   |  | (RBAC, repo    |  | (per-user,       |
| (NLP, sanitize |  |  scoped)       |  |  per-role)       |
|  dedup)        |  +--------+-------+  +------+-----------+
+---------+------+           |                 |
          |                  |                 |
          +------------------+-----------------+
                             |
                    +--------v--------+
                    | RequestQueue    |
                    | (priority FIFO, |
                    |  starvation     |
                    |  prevention)    |
                    +--------+--------+
                             |
                    +--------v--------+
                    | NotificationEngine
                    | (proactive push,|
                    |  digest, route) |
                    +--------+--------+
                             |
                    +--------v--------+
                    | ConversationMgr |
                    | (bidir comms,   |
                    |  clarifications,|
                    |  timeouts)      |
                    +--------+--------+
                             |
                    +--------v--------+
                    |  Pipeline Core  |
                    |  (TDD-001)      |
                    +-----------------+
                             |
                    +--------v--------+
                    |   SQLite DB     |
                    |   (WAL mode)    |
                    +-----------------+
```

### 2.2 Module Dependency Graph

```
intake/
  adapters/
    claude_adapter.ts        # Claude App native channel
    discord_adapter.ts       # Discord bot channel
    slack_adapter.ts         # Slack bot channel
    adapter_interface.ts     # IntakeAdapter interface definition
  core/
    intake_router.ts         # Command parsing and dispatch
    request_parser.ts        # NLP parsing and enrichment
    sanitizer.ts             # Prompt injection defense
    duplicate_detector.ts    # Semantic similarity dedup
  queue/
    request_queue.ts         # Priority queue manager
    starvation_monitor.ts    # Aging promotion
  authz/
    authz_engine.ts          # RBAC + repo-scoped permissions
    audit_logger.ts          # Authorization audit trail
  notifications/
    notification_engine.ts   # Push notifications, routing
    formatters/
      cli_formatter.ts       # ANSI plain text
      discord_formatter.ts   # Rich embeds
      slack_formatter.ts     # Block Kit
    digest_scheduler.ts      # Daily digest
  conversation/
    conversation_manager.ts  # Bidirectional communication
    timeout_handler.ts       # Response timeout + escalation
  rate_limit/
    rate_limiter.ts          # Token bucket per user
  db/
    schema.sql               # SQLite DDL
    migrations/              # Versioned migrations
    repository.ts            # Data access layer
```

---

## 3. Detailed Design

### 3.1 IntakeAdapter Interface

All channel adapters implement this interface. The core never depends on channel-specific types.

```typescript
interface IntakeAdapter {
  /** Unique channel identifier */
  readonly channelType: ChannelType; // 'claude_app' | 'discord' | 'slack'

  /**
   * Start listening for commands on this channel.
   * Returns a disposable handle for shutdown.
   */
  start(): Promise<AdapterHandle>;

  /**
   * Send a message to a user or channel on this platform.
   * The message is pre-formatted by the NotificationEngine using
   * the appropriate formatter for this channel type.
   */
  sendMessage(target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt>;

  /**
   * Send a structured prompt (clarifying question, approval request)
   * and return a promise that resolves when the user responds or
   * the timeout expires.
   */
  promptUser(target: MessageTarget, prompt: StructuredPrompt): Promise<UserResponse | TimeoutExpired>;

  /**
   * Gracefully shut down: finish processing the current command,
   * flush pending sends, then close connections.
   */
  shutdown(): Promise<void>;
}

type ChannelType = 'claude_app' | 'discord' | 'slack';

interface AdapterHandle {
  dispose(): Promise<void>;
}

interface MessageTarget {
  channelType: ChannelType;
  userId?: string;            // Internal user ID
  platformChannelId?: string; // Discord channel ID or Slack channel ID
  threadId?: string;          // Thread for conversation context
  isDM?: boolean;
}

interface FormattedMessage {
  channelType: ChannelType;
  payload: unknown;           // Channel-specific (Embed | Block[] | string)
  fallbackText: string;       // Plain text fallback for mobile/degraded clients
}

interface StructuredPrompt {
  promptType: 'clarifying_question' | 'approval_request' | 'escalation';
  requestId: string;
  content: string;
  options?: PromptOption[];   // For button-style responses
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
```

When an adapter receives a command, it constructs an `IncomingCommand` event and passes it to the `IntakeRouter`:

```typescript
interface IncomingCommand {
  commandName: string;        // 'submit' | 'status' | 'list' | etc.
  args: string[];             // Positional arguments
  flags: Record<string, string | boolean>; // Named flags (--all, --force)
  rawText: string;            // Original text (for audit log)
  source: CommandSource;
}

interface CommandSource {
  channelType: ChannelType;
  userId: string;             // Platform-specific user ID
  platformChannelId?: string;
  threadId?: string;
  timestamp: Date;
}
```

### 3.2 Claude App Native Adapter (Phase 1)

The Claude App adapter registers commands using the Claude Code plugin slash command system. Each lifecycle command is registered as a sub-command under the `autonomous-dev` namespace.

**Slash command registration:**

```typescript
// claude_adapter.ts
const COMMANDS = [
  {
    name: 'autonomous-dev:submit',
    description: 'Submit a new request to the autonomous development pipeline',
    args: [
      { name: 'description', type: 'string', required: true,
        description: 'Natural-language description of the feature or task' }
    ],
    flags: [
      { name: 'priority', type: 'string', default: 'normal',
        description: 'Priority level: high, normal, or low' },
      { name: 'repo', type: 'string',
        description: 'Target repository (defaults to current working directory repo)' },
      { name: 'deadline', type: 'string',
        description: 'ISO-8601 date deadline' },
      { name: 'force', type: 'boolean', default: false,
        description: 'Skip duplicate detection confirmation' },
    ]
  },
  {
    name: 'autonomous-dev:status',
    description: 'View the current state and progress of a request',
    args: [
      { name: 'request-id', type: 'string', required: true }
    ]
  },
  {
    name: 'autonomous-dev:list',
    description: 'List all active requests with their states and priorities',
    flags: [
      { name: 'priority', type: 'string', description: 'Filter by priority' },
      { name: 'status', type: 'string', description: 'Filter by status' },
    ]
  },
  {
    name: 'autonomous-dev:cancel',
    description: 'Cancel a request and clean up all associated artifacts',
    args: [{ name: 'request-id', type: 'string', required: true }]
  },
  {
    name: 'autonomous-dev:pause',
    description: 'Pause a request at the next phase boundary',
    args: [{ name: 'request-id', type: 'string', required: true }]
  },
  {
    name: 'autonomous-dev:resume',
    description: 'Resume a paused request',
    args: [{ name: 'request-id', type: 'string', required: true }]
  },
  {
    name: 'autonomous-dev:priority',
    description: 'Change a request priority',
    args: [
      { name: 'request-id', type: 'string', required: true },
      { name: 'level', type: 'string', required: true,
        description: 'high, normal, or low' }
    ]
  },
  {
    name: 'autonomous-dev:logs',
    description: 'View activity log for a request',
    args: [{ name: 'request-id', type: 'string', required: true }],
    flags: [{ name: 'all', type: 'boolean', default: false }]
  },
  {
    name: 'autonomous-dev:feedback',
    description: 'Send feedback or context to an active request',
    args: [
      { name: 'request-id', type: 'string', required: true },
      { name: 'message', type: 'string', required: true }
    ]
  },
  {
    name: 'autonomous-dev:kill',
    description: 'Emergency stop all running requests (admin only)',
    flags: []
  },
];
```

**Argument parsing:**

The Claude adapter receives arguments as a single string from the Claude Code slash command system. The parser handles:

1. Quoted strings: `"Build a user auth system with OAuth2"` is a single argument.
2. Named flags: `--priority high`, `--repo my-app`, `--force`.
3. Boolean flags: `--all`, `--force` (presence = true).
4. Request ID validation: `REQ-NNNNNN` format check via regex `/^REQ-\d{6}$/`.

```typescript
function parseCommandArgs(raw: string): ParsedArgs {
  const tokens = tokenize(raw); // Handles quoted strings
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].startsWith('--')) {
      const flagName = tokens[i].slice(2);
      const nextToken = tokens[i + 1];
      if (nextToken && !nextToken.startsWith('--')) {
        flags[flagName] = nextToken;
        i += 2;
      } else {
        flags[flagName] = true;
        i += 1;
      }
    } else {
      args.push(tokens[i]);
      i += 1;
    }
  }
  return { args, flags };
}
```

**User identity resolution:**

In the Claude App, user identity is derived from the OS user running the Claude Code process. The adapter reads `$USER` (or `os.userInfo().username`) and maps it to an internal identity via the `UserIdentity` table. If no mapping exists and the user is the first to interact with the system, they are auto-provisioned as `admin`. Subsequent unmapped users are provisioned as `viewer` and must be promoted by an admin.

**CLI notification formatting:**

Status notifications are formatted with ANSI escape codes for terminal rendering:

```
┌─────────────────────────────────────────────┐
│  REQ-000042  Build user auth with OAuth2    │
├─────────────────────────────────────────────┤
│  Phase:    TDD Generation (3/8)             │
│  Progress: ████████░░░░░░░░ 50%             │
│  Priority: high                             │
│  Age:      2h 14m                           │
│  Blocker:  None                             │
│  Artifacts:                                 │
│    PRD PR: https://github.com/.../pull/87   │
│    TDD PR: (in progress)                    │
└─────────────────────────────────────────────┘
```

### 3.3 Discord Bot Adapter (Phase 2)

#### 3.3.1 Bot Registration & Permissions

The Discord bot requires the following OAuth2 scopes and permissions:

- **Scopes:** `bot`, `applications.commands`
- **Bot permissions:** `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Embed Links`, `Read Message History`, `Use Slash Commands`, `Add Reactions`
- **Privileged intents:** None required (the bot does not read message content; it only processes slash command interactions).

#### 3.3.2 Slash Command Definitions

Discord slash commands are registered globally or per-guild (configurable). All commands use the `/ad` prefix to stay concise in Discord's command palette.

```json
[
  {
    "name": "ad",
    "description": "Autonomous Dev pipeline commands",
    "type": 1,
    "options": [
      {
        "name": "submit",
        "description": "Submit a new request to the pipeline",
        "type": 1,
        "options": [
          {
            "name": "description",
            "description": "What do you want built? Describe the feature or task.",
            "type": 3,
            "required": true,
            "max_length": 10000
          },
          {
            "name": "priority",
            "description": "Request priority",
            "type": 3,
            "required": false,
            "choices": [
              { "name": "High", "value": "high" },
              { "name": "Normal", "value": "normal" },
              { "name": "Low", "value": "low" }
            ]
          },
          {
            "name": "repo",
            "description": "Target repository (owner/name)",
            "type": 3,
            "required": false
          },
          {
            "name": "deadline",
            "description": "Deadline (YYYY-MM-DD)",
            "type": 3,
            "required": false
          }
        ]
      },
      {
        "name": "status",
        "description": "View current state and progress of a request",
        "type": 1,
        "options": [
          {
            "name": "request-id",
            "description": "Request ID (e.g., REQ-000042)",
            "type": 3,
            "required": true,
            "min_length": 10,
            "max_length": 10
          }
        ]
      },
      {
        "name": "list",
        "description": "List all active requests",
        "type": 1,
        "options": [
          {
            "name": "priority",
            "description": "Filter by priority",
            "type": 3,
            "required": false,
            "choices": [
              { "name": "High", "value": "high" },
              { "name": "Normal", "value": "normal" },
              { "name": "Low", "value": "low" }
            ]
          }
        ]
      },
      {
        "name": "cancel",
        "description": "Cancel a request and clean up artifacts",
        "type": 1,
        "options": [
          {
            "name": "request-id",
            "description": "Request ID (e.g., REQ-000042)",
            "type": 3,
            "required": true
          }
        ]
      },
      {
        "name": "pause",
        "description": "Pause a request at the next phase boundary",
        "type": 1,
        "options": [
          {
            "name": "request-id",
            "description": "Request ID (e.g., REQ-000042)",
            "type": 3,
            "required": true
          }
        ]
      },
      {
        "name": "resume",
        "description": "Resume a paused request",
        "type": 1,
        "options": [
          {
            "name": "request-id",
            "description": "Request ID (e.g., REQ-000042)",
            "type": 3,
            "required": true
          }
        ]
      },
      {
        "name": "priority",
        "description": "Change request priority",
        "type": 1,
        "options": [
          {
            "name": "request-id",
            "description": "Request ID",
            "type": 3,
            "required": true
          },
          {
            "name": "level",
            "description": "New priority level",
            "type": 3,
            "required": true,
            "choices": [
              { "name": "High", "value": "high" },
              { "name": "Normal", "value": "normal" },
              { "name": "Low", "value": "low" }
            ]
          }
        ]
      },
      {
        "name": "logs",
        "description": "View activity log for a request",
        "type": 1,
        "options": [
          {
            "name": "request-id",
            "description": "Request ID",
            "type": 3,
            "required": true
          },
          {
            "name": "all",
            "description": "Show complete log (not just last 50 entries)",
            "type": 5,
            "required": false
          }
        ]
      },
      {
        "name": "feedback",
        "description": "Send feedback or context to an active request",
        "type": 1,
        "options": [
          {
            "name": "request-id",
            "description": "Request ID",
            "type": 3,
            "required": true
          },
          {
            "name": "message",
            "description": "Your feedback message",
            "type": 3,
            "required": true,
            "max_length": 4000
          }
        ]
      },
      {
        "name": "kill",
        "description": "Emergency stop ALL running requests (admin only)",
        "type": 1
      }
    ]
  }
]
```

#### 3.3.3 Interaction Flow

Discord interactions follow a request-response model with a 3-second acknowledgment deadline:

1. **Slash command received** via the Discord gateway websocket.
2. **Immediately defer** the interaction response (`InteractionResponseType.DeferredChannelMessageWithSource`) to avoid the 3-second timeout. This shows a "thinking..." indicator.
3. **Construct** `IncomingCommand` and pass to `IntakeRouter`.
4. **Route** through `AuthzEngine` and `RateLimiter`.
5. **Execute** the command handler.
6. **Edit** the deferred response with the formatted result (rich embed).

For commands that require follow-up interaction (e.g., `/ad submit` triggering clarifying questions), the bot creates a **thread** on the acknowledgment message and continues the conversation there.

#### 3.3.4 Rich Embed Formatting

Status notifications use Discord embeds with color-coded status:

```typescript
// discord_formatter.ts
const PHASE_COLORS: Record<string, number> = {
  queued:         0x95a5a6,  // Gray
  prd_generation: 0x3498db,  // Blue
  prd_review:     0xe67e22,  // Orange
  tdd_generation: 0x3498db,  // Blue
  tdd_review:     0xe67e22,  // Orange
  planning:       0x9b59b6,  // Purple
  spec:           0x9b59b6,  // Purple
  execution:      0x2ecc71,  // Green
  code_review:    0xe67e22,  // Orange
  merged:         0x27ae60,  // Dark green
  done:           0x2ecc71,  // Green
  paused:         0xf39c12,  // Yellow
  cancelled:      0xe74c3c,  // Red
  failed:         0xe74c3c,  // Red
};

function formatStatusEmbed(request: RequestEntity): DiscordEmbed {
  return {
    title: `${request.request_id}: ${truncate(request.title, 50)}`,
    color: PHASE_COLORS[request.current_phase] ?? 0x95a5a6,
    fields: [
      { name: 'Phase', value: formatPhase(request.current_phase), inline: true },
      { name: 'Priority', value: request.priority, inline: true },
      { name: 'Progress', value: formatProgress(request), inline: true },
      { name: 'Age', value: formatDuration(request.created_at), inline: true },
      { name: 'Blocker', value: request.blocker ?? 'None', inline: true },
    ],
    footer: { text: `Requested by ${request.requester_display_name}` },
    timestamp: request.updated_at.toISOString(),
  };
}
```

#### 3.3.5 Button Components

The `/ad kill` command and cancel confirmations use Discord button components:

```typescript
function buildKillConfirmation(): ActionRow {
  return {
    type: 1, // ACTION_ROW
    components: [
      {
        type: 2,         // BUTTON
        style: 4,        // DANGER
        label: 'CONFIRM KILL ALL',
        custom_id: 'kill_confirm',
      },
      {
        type: 2,
        style: 2,        // SECONDARY
        label: 'Cancel',
        custom_id: 'kill_cancel',
      },
    ],
  };
}
```

Button interactions are routed through a `ComponentInteractionHandler` that validates the button's `custom_id` and the user's authorization before executing the action.

#### 3.3.6 Modals

For complex submissions where the user wants to specify multiple fields, the Discord adapter supports a modal form:

```typescript
function buildSubmitModal(): ModalSubmitData {
  return {
    title: 'Submit Pipeline Request',
    custom_id: 'submit_modal',
    components: [
      {
        type: 1, // ACTION_ROW
        components: [{
          type: 4,  // TEXT_INPUT
          custom_id: 'description',
          label: 'Description',
          style: 2, // PARAGRAPH
          placeholder: 'Describe the feature or task...',
          required: true,
          max_length: 10000,
        }],
      },
      {
        type: 1,
        components: [{
          type: 4,
          custom_id: 'repo',
          label: 'Target Repository',
          style: 1, // SHORT
          placeholder: 'owner/repo-name',
          required: false,
        }],
      },
      {
        type: 1,
        components: [{
          type: 4,
          custom_id: 'acceptance_criteria',
          label: 'Acceptance Criteria',
          style: 2,
          placeholder: 'Optional: How will you know this is done?',
          required: false,
          max_length: 2000,
        }],
      },
    ],
  };
}
```

### 3.4 Slack Bot Adapter (Phase 3)

#### 3.4.1 App Manifest

The Slack app is configured via a manifest YAML that defines all slash commands, event subscriptions, bot scopes, and interactivity endpoints.

```yaml
# slack-app-manifest.yaml
display_information:
  name: Autonomous Dev
  description: Autonomous development pipeline intake and status
  background_color: "#2c3e50"

features:
  bot_user:
    display_name: autonomous-dev
    always_online: true
  slash_commands:
    - command: /ad-submit
      url: https://${SLACK_HOST}/slack/commands
      description: Submit a new request to the pipeline
      usage_hint: "[description] --priority high --repo owner/name"
      should_escape: true
    - command: /ad-status
      url: https://${SLACK_HOST}/slack/commands
      description: View request status
      usage_hint: "REQ-000042"
      should_escape: false
    - command: /ad-list
      url: https://${SLACK_HOST}/slack/commands
      description: List all active requests
      usage_hint: "[--priority high|normal|low]"
      should_escape: false
    - command: /ad-cancel
      url: https://${SLACK_HOST}/slack/commands
      description: Cancel a request
      usage_hint: "REQ-000042"
      should_escape: false
    - command: /ad-pause
      url: https://${SLACK_HOST}/slack/commands
      description: Pause a request
      usage_hint: "REQ-000042"
      should_escape: false
    - command: /ad-resume
      url: https://${SLACK_HOST}/slack/commands
      description: Resume a paused request
      usage_hint: "REQ-000042"
      should_escape: false
    - command: /ad-priority
      url: https://${SLACK_HOST}/slack/commands
      description: Change request priority
      usage_hint: "REQ-000042 high|normal|low"
      should_escape: false
    - command: /ad-logs
      url: https://${SLACK_HOST}/slack/commands
      description: View request activity log
      usage_hint: "REQ-000042 [--all]"
      should_escape: false
    - command: /ad-feedback
      url: https://${SLACK_HOST}/slack/commands
      description: Send feedback to an active request
      usage_hint: "REQ-000042 [message]"
      should_escape: true
    - command: /ad-kill
      url: https://${SLACK_HOST}/slack/commands
      description: Emergency stop all requests (admin only)
      should_escape: false

oauth_config:
  scopes:
    bot:
      - commands
      - chat:write
      - chat:write.public
      - im:write
      - users:read
      - channels:read
      - groups:read

settings:
  interactivity:
    is_enabled: true
    request_url: https://${SLACK_HOST}/slack/interactions
  event_subscriptions:
    request_url: https://${SLACK_HOST}/slack/events
    bot_events:
      - message.channels
      - message.groups
      - message.im
  org_deploy_enabled: false
  socket_mode_enabled: false
```

**Note on Slack slash command naming:** Slack does not support subcommand grouping like Discord. Each lifecycle command is registered as a separate top-level slash command with the `ad-` prefix. This is a platform limitation.

#### 3.4.2 Request Verification

All incoming Slack requests are verified using the `signing_secret`:

```typescript
function verifySlackRequest(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string
): boolean {
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    return false; // Replay attack prevention
  }
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', signingSecret)
    .update(baseString)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(`v0=${hmac}`),
    Buffer.from(signature)
  );
}
```

#### 3.4.3 Block Kit Formatting

Status responses use Slack Block Kit for rich layout:

```typescript
function formatStatusBlocks(request: RequestEntity): SlackBlock[] {
  const statusEmoji = STATUS_EMOJI[request.current_phase] ?? ':white_circle:';
  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${request.request_id}: ${truncate(request.title, 50)}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Phase:*\n${statusEmoji} ${formatPhase(request.current_phase)}` },
        { type: 'mrkdwn', text: `*Priority:*\n${request.priority}` },
        { type: 'mrkdwn', text: `*Progress:*\n${formatProgress(request)}` },
        { type: 'mrkdwn', text: `*Age:*\n${formatDuration(request.created_at)}` },
      ],
    },
    ...(request.blocker ? [{
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: `:warning: *Blocker:* ${request.blocker}` },
    }] : []),
    ...(request.artifact_links.length > 0 ? [{
      type: 'section' as const,
      text: {
        type: 'mrkdwn' as const,
        text: request.artifact_links
          .map(l => `<${l.url}|${l.label}>`)
          .join(' | '),
      },
    }] : []),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Requested by <@${request.slack_user_id}> | Updated ${formatRelativeTime(request.updated_at)}`,
        },
      ],
    },
  ];
}

const STATUS_EMOJI: Record<string, string> = {
  queued:         ':white_circle:',
  prd_generation: ':large_blue_circle:',
  prd_review:     ':orange_circle:',
  tdd_generation: ':large_blue_circle:',
  tdd_review:     ':orange_circle:',
  planning:       ':purple_circle:',
  spec:           ':purple_circle:',
  execution:      ':green_circle:',
  code_review:    ':orange_circle:',
  merged:         ':white_check_mark:',
  done:           ':heavy_check_mark:',
  paused:         ':double_vertical_bar:',
  cancelled:      ':x:',
  failed:         ':red_circle:',
};
```

#### 3.4.4 Interactive Messages

The `/ad-kill` confirmation and duplicate detection warning use Slack interactive buttons:

```typescript
function buildKillConfirmationBlocks(): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':rotating_light: *Emergency Kill Switch* :rotating_light:\nThis will immediately stop ALL running pipeline processes and pause all active requests.',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'CONFIRM KILL ALL' },
          style: 'danger',
          action_id: 'kill_confirm',
          confirm: {
            title: { type: 'plain_text', text: 'Are you absolutely sure?' },
            text: { type: 'mrkdwn', text: 'This will halt all pipeline activity.' },
            confirm: { type: 'plain_text', text: 'Kill All' },
            deny: { type: 'plain_text', text: 'Go Back' },
          },
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'kill_cancel',
        },
      ],
    },
  ];
}
```

#### 3.4.5 Slack Interaction Handler

Slack interactive payloads (button clicks, modal submissions) arrive at the `/slack/interactions` endpoint. The handler:

1. Verifies request signature.
2. Parses the `payload` JSON from the form-encoded body.
3. Routes by `payload.type`: `block_actions` for button clicks, `view_submission` for modals, `shortcut` for global shortcuts.
4. Extracts `action_id` or `callback_id` and dispatches to the appropriate command handler.
5. Responds within 3 seconds. If processing takes longer, acknowledges immediately and posts a follow-up via `response_url`.

### 3.5 Request Parsing and Enrichment

#### 3.5.1 NLP Parsing Pipeline

When a `/submit` command is received, the raw description text passes through a multi-stage pipeline:

```
Raw Text
  │
  ├──> [1] Sanitizer (prompt injection defense)
  │
  ├──> [2] NLP Parser (extract structured fields)
  │
  ├──> [3] Ambiguity Detector (flag vague requests)
  │
  ├──> [4] Duplicate Detector (semantic similarity check)
  │
  └──> [5] Record Builder (construct RequestEntity)
```

**Stage 1: Sanitizer** (Section 3.8 below)

**Stage 2: NLP Parser**

The parser uses Claude (via the pipeline's model access) to extract structured fields from natural language. The prompt is a function call with a strict output schema:

```typescript
interface ParsedRequest {
  title: string;              // Short title (max 100 chars)
  description: string;        // Cleaned, expanded description
  priority: 'high' | 'normal' | 'low';
  target_repo: string | null;
  deadline: string | null;    // ISO-8601 or null
  related_tickets: string[];  // URLs extracted from text
  technical_constraints: string | null;
  acceptance_criteria: string | null;
  confidence: number;         // 0.0-1.0, parser confidence
}
```

The parser prompt is a system message with the schema definition. The user's description is passed as a separate user message. This separation prevents the user text from being interpreted as instructions (defense-in-depth alongside the sanitizer).

The parser extracts `target_repo` by looking for:
1. Explicit `--repo` flag (highest priority).
2. GitHub/GitLab URLs in the description.
3. Repository names matching a known-repos list from configuration.
4. Falls back to `null` (triggers a clarifying question).

**Stage 3: Ambiguity Detector**

A request is flagged as ambiguous if ANY of the following conditions are true:

```typescript
function detectAmbiguity(parsed: ParsedRequest, raw: string): AmbiguityResult {
  const issues: string[] = [];

  // Condition 1: No clear deliverable
  if (parsed.confidence < 0.6) {
    issues.push('The request does not describe a clear deliverable.');
  }

  // Condition 2: No target repo identified
  if (!parsed.target_repo) {
    issues.push('No target repository was identified.');
  }

  // Condition 3: Too short and non-technical
  const wordCount = raw.split(/\s+/).length;
  const hasTechnicalTerms = TECHNICAL_TERM_REGEX.test(raw);
  if (wordCount < 15 && !hasTechnicalTerms) {
    issues.push('The request is too brief to generate a meaningful PRD.');
  }

  return {
    isAmbiguous: issues.length > 0,
    issues,
    suggestedQuestions: generateClarifyingQuestions(issues, parsed),
  };
}
```

Clarifying questions are generated by Claude using a constrained prompt that produces at most 3 focused questions. The system tracks the conversation round count and enforces the 5-round maximum (FR-28).

**Stage 4: Duplicate Detector** (Section 3.6 below)

**Stage 5: Record Builder**

Assembles the final `RequestEntity`, assigns the `REQ-NNNNNN` ID, and inserts into the database.

### 3.6 Duplicate Detection Algorithm

The duplicate detector compares a new request against all active and recently completed requests (within the configurable lookback window, default 30 days).

#### 3.6.1 Embedding Strategy

The system uses a local sentence-transformer model (`all-MiniLM-L6-v2`, 384-dimensional embeddings) running via the `@xenova/transformers` library (ONNX runtime, no GPU required). This avoids Claude API costs for a high-frequency operation and keeps the system functional when offline.

**Decision rationale:** The PRD's OQ-7 asks whether to use a local model or the Claude API. We choose local for three reasons: (1) duplicate detection runs on every submit, making API costs add up; (2) sentence-transformers are purpose-built for semantic similarity and outperform general LLMs on this task; (3) the system should function when the network is degraded.

#### 3.6.2 Algorithm

```typescript
async function detectDuplicate(
  newRequest: ParsedRequest,
  db: Repository,
  config: DuplicateDetectionConfig
): Promise<DuplicateResult> {
  if (!config.enabled) {
    return { isDuplicate: false, candidates: [] };
  }

  // 1. Build the query text from the new request's title + description
  const queryText = `${newRequest.title} ${newRequest.description}`;

  // 2. Generate embedding for the new request
  const queryEmbedding = await embedder.encode(queryText);

  // 3. Retrieve all candidate embeddings from DB
  //    (active requests + completed within lookback window)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.lookback_days);
  const candidates = await db.getRequestEmbeddings(cutoff);

  // 4. Compute cosine similarity against each candidate
  const scored = candidates.map(candidate => ({
    requestId: candidate.request_id,
    title: candidate.title,
    similarity: cosineSimilarity(queryEmbedding, candidate.embedding),
    status: candidate.status,
  }));

  // 5. Filter by threshold and sort descending
  const matches = scored
    .filter(s => s.similarity >= config.similarity_threshold)
    .sort((a, b) => b.similarity - a.similarity);

  return {
    isDuplicate: matches.length > 0,
    candidates: matches.slice(0, 5), // Return top 5 matches
  };
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

#### 3.6.3 Performance Considerations

- **Embedding cache:** Every request's embedding is stored in the `request_embeddings` table at creation time. Duplicate detection is a scan of pre-computed embeddings, not a re-encode of all requests.
- **Scaling:** With a 50-request queue cap and 30-day lookback, the candidate set is bounded. Even at maximum throughput (50 active + ~1500 completed in 30 days at 50/day), the brute-force scan completes in under 10ms.
- **Threshold tuning:** The default threshold of 0.85 is deliberately conservative (high precision, lower recall). Operators can lower it to catch more duplicates at the cost of more false positives. The system always warns rather than blocks (FR-10).

### 3.7 Request Queue

#### 3.7.1 Data Model

The queue is a logical construct over the `requests` table, not a separate data structure. Queue ordering is determined by:

```sql
SELECT * FROM requests
WHERE status = 'queued'
ORDER BY
  CASE priority
    WHEN 'high'   THEN 0
    WHEN 'normal'  THEN 1
    WHEN 'low'     THEN 2
  END ASC,
  created_at ASC;
```

This gives strict priority ordering with FIFO within each level.

#### 3.7.2 Starvation Prevention

A background timer runs every 15 minutes and promotes starving requests:

```typescript
async function promoteStarvedRequests(
  db: Repository,
  thresholdHours: number
): Promise<PromotionResult[]> {
  const now = new Date();
  const threshold = new Date(now.getTime() - thresholdHours * 60 * 60 * 1000);

  // Promote low -> normal
  const lowPromotions = await db.query(`
    UPDATE requests
    SET priority = 'normal',
        updated_at = ?,
        promotion_count = promotion_count + 1,
        last_promoted_at = ?
    WHERE status = 'queued'
      AND priority = 'low'
      AND COALESCE(last_promoted_at, created_at) < ?
    RETURNING request_id, 'low' as from_priority, 'normal' as to_priority
  `, [now, now, threshold]);

  // Promote normal -> high
  const normalPromotions = await db.query(`
    UPDATE requests
    SET priority = 'high',
        updated_at = ?,
        promotion_count = promotion_count + 1,
        last_promoted_at = ?
    WHERE status = 'queued'
      AND priority = 'normal'
      AND COALESCE(last_promoted_at, created_at) < ?
    RETURNING request_id, 'normal' as from_priority, 'high' as to_priority
  `, [now, now, threshold]);

  return [...lowPromotions, ...normalPromotions];
}
```

Key design decisions:
- **Promotion is relative to `last_promoted_at`**, not `created_at`. A low-priority request promoted to normal at T+48h must wait another 48h before promoting to high. This prevents a low request from jumping to high in a single cycle.
- **`promotion_count`** tracks how many times a request has been promoted. This is reported in `/status` output for transparency.
- The starvation threshold applies independently per priority level (FR-16).

#### 3.7.3 Queue Depth Enforcement

```typescript
async function enqueue(
  request: RequestEntity,
  db: Repository,
  config: QueueConfig
): Promise<EnqueueResult> {
  const currentDepth = await db.getQueuedRequestCount();
  if (currentDepth >= config.max_depth) {
    return {
      success: false,
      error: `Queue is at capacity (${config.max_depth} requests). ` +
             `Please wait for existing requests to complete or cancel a lower-priority request.`,
      currentDepth,
    };
  }

  await db.insertRequest(request);

  const position = await db.getQueuePosition(request.request_id);
  return {
    success: true,
    requestId: request.request_id,
    position,
    estimatedWait: estimateWaitTime(position, db),
  };
}
```

#### 3.7.4 Estimated Wait Time

Wait time estimation uses a rolling average of the last 20 completed requests' total pipeline duration, divided by the number of concurrent pipeline slots:

```typescript
async function estimateWaitTime(
  position: number,
  db: Repository
): Promise<string> {
  const avgDuration = await db.getAveragePipelineDuration(20);
  const concurrentSlots = await db.getMaxConcurrentSlots();

  if (!avgDuration || !concurrentSlots) {
    return 'Unable to estimate (insufficient history)';
  }

  const waitMs = (position / concurrentSlots) * avgDuration;
  return formatDuration(waitMs);
}
```

### 3.8 Prompt Injection Sanitization

The sanitizer is a multi-layer defense that runs before any user text enters the parsing pipeline.

#### 3.8.1 Rule-Based Filter

Rules are loaded from an externalized YAML file (`injection-rules.yaml`) that can be updated without redeploying (NFR-06):

```yaml
# injection-rules.yaml
version: 1
rules:
  - id: system_prompt_override
    pattern: '(?i)(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?|context)'
    severity: critical
    action: block
    message: "Request contains a suspected prompt injection pattern."

  - id: role_assumption
    pattern: '(?i)(you\s+are\s+now|act\s+as|pretend\s+to\s+be|assume\s+the\s+role)\s+'
    severity: high
    action: flag
    message: "Request contains a role assumption directive."

  - id: system_message_injection
    pattern: '(?i)<\s*system\s*>|<<\s*SYS\s*>>|\[INST\]|\[SYSTEM\]'
    severity: critical
    action: block
    message: "Request contains system message delimiters."

  - id: template_delimiter
    pattern: '\{\{.*\}\}|\$\{.*\}|<%.*%>'
    severity: medium
    action: escape
    message: "Request contains template delimiters that will be escaped."

  - id: output_manipulation
    pattern: '(?i)(begin\s+your\s+response|start\s+with|always\s+respond|your\s+output\s+must)'
    severity: medium
    action: flag
    message: "Request contains output manipulation directives."

  - id: instruction_injection
    pattern: '(?i)(important\s*:|note\s*:|instruction\s*:|rule\s*:)\s*(do\s+not|never|always|you\s+must)'
    severity: high
    action: flag
    message: "Request contains embedded instructions."

  - id: data_exfiltration
    pattern: '(?i)(repeat|print|show|reveal|output)\s+(the\s+)?(system\s+prompt|instructions|configuration|api\s+key|secret|token)'
    severity: critical
    action: block
    message: "Request attempts to extract system information."
```

#### 3.8.2 Processing Pipeline

```typescript
interface SanitizationResult {
  sanitizedText: string;
  blocked: boolean;
  flaggedForReview: boolean;
  appliedRules: AppliedRule[];
}

async function sanitize(
  rawText: string,
  rules: InjectionRule[]
): Promise<SanitizationResult> {
  const appliedRules: AppliedRule[] = [];
  let text = rawText;
  let blocked = false;
  let flaggedForReview = false;

  for (const rule of rules) {
    const regex = new RegExp(rule.pattern, 'g');
    const matches = text.match(regex);
    if (!matches) continue;

    appliedRules.push({
      ruleId: rule.id,
      severity: rule.severity,
      action: rule.action,
      matchCount: matches.length,
    });

    switch (rule.action) {
      case 'block':
        blocked = true;
        break;
      case 'flag':
        flaggedForReview = true;
        break;
      case 'escape':
        text = text.replace(regex, (match) =>
          match.replace(/[{}$<>%]/g, (c) => `\\${c}`)
        );
        break;
    }
  }

  return { sanitizedText: text, blocked, flaggedForReview, appliedRules };
}
```

#### 3.8.3 Structural Defense

Beyond regex rules, the core defense is the **structured event boundary** (NFR-07). User text never appears in a system prompt or instruction position. The flow is:

1. Raw text enters as a data field in `IncomingCommand.args[0]`.
2. The sanitizer processes it as a string value, never as an instruction.
3. The NLP parser receives the sanitized text as a `user` message, with the extraction schema in a separate `system` message.
4. The resulting `ParsedRequest` is a schema-validated typed object.
5. The pipeline core receives a `RequestEntity` -- a database row with typed columns, never a concatenated string.

At no point is user text interpolated into a prompt template or command string.

### 3.9 Status Notification Engine

#### 3.9.1 Event-Driven Architecture

The notification engine subscribes to pipeline phase-transition events emitted by the pipeline core:

```typescript
interface PhaseTransitionEvent {
  requestId: string;
  fromPhase: PipelinePhase;
  toPhase: PipelinePhase;
  timestamp: Date;
  metadata: {
    progress?: { current: number; total: number };
    artifactUrl?: string;
    blocker?: string;
    agentReasoning?: string; // Only populated for debug verbosity
  };
}

class NotificationEngine {
  constructor(
    private db: Repository,
    private adapters: Map<ChannelType, IntakeAdapter>,
    private formatters: Map<ChannelType, NotificationFormatter>,
  ) {}

  async onPhaseTransition(event: PhaseTransitionEvent): Promise<void> {
    const request = await this.db.getRequest(event.requestId);
    const config = request.notification_config;

    // Check verbosity filter
    if (!this.shouldNotify(config.verbosity, event)) {
      return;
    }

    // Determine target channel(s)
    const targets = this.resolveTargets(request, config);

    // Format for each target channel
    for (const target of targets) {
      const formatter = this.formatters.get(target.channelType);
      const message = formatter.formatPhaseTransition(request, event);
      const adapter = this.adapters.get(target.channelType);

      await this.deliverWithRetry(adapter, target, message);
    }

    // Log the notification
    await this.db.insertActivityLog({
      requestId: event.requestId,
      event: 'notification_sent',
      phase: event.toPhase,
      details: { targets: targets.map(t => t.channelType) },
    });
  }

  private shouldNotify(
    verbosity: VerbosityLevel,
    event: PhaseTransitionEvent
  ): boolean {
    switch (verbosity) {
      case 'silent':  return false;
      case 'summary': return isPhaseTransition(event);
      case 'verbose': return true; // phase transitions + sub-steps
      case 'debug':   return true; // everything
    }
  }

  private async deliverWithRetry(
    adapter: IntakeAdapter,
    target: MessageTarget,
    message: FormattedMessage,
    maxRetries = 3
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const receipt = await adapter.sendMessage(target, message);
      if (receipt.success) return;
      if (!receipt.retryable) {
        await this.db.insertActivityLog({
          requestId: message.requestId,
          event: 'notification_failed',
          details: { error: receipt.error, attempt },
        });
        return;
      }
      // Exponential backoff: 1s, 2s, 4s
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
}
```

#### 3.9.2 Notification Routing

A request's notifications can be routed independently of its submission channel. The `notification_config` on the request entity controls this:

```typescript
interface NotificationConfig {
  verbosity: 'silent' | 'summary' | 'verbose' | 'debug';
  routes: NotificationRoute[];
}

interface NotificationRoute {
  channelType: ChannelType;
  platformChannelId?: string; // Specific channel or DM
  threadId?: string;          // Existing thread to continue
  events?: PipelinePhase[];   // Filter: only notify for these phases (null = all)
}
```

This design supports cross-channel notification: a request submitted in Slack can push status updates to a Discord channel.

#### 3.9.3 Daily Digest

The digest scheduler runs as a cron-like timer inside the daemon:

```typescript
class DigestScheduler {
  private timer: NodeJS.Timeout | null = null;

  start(config: DigestConfig): void {
    // Calculate ms until next scheduled time
    const nextRun = this.calculateNextRun(config.daily_digest_time);
    this.timer = setTimeout(async () => {
      await this.generateAndSendDigest(config);
      // Reschedule for next day
      this.start(config);
    }, nextRun);
  }

  async generateAndSendDigest(config: DigestConfig): Promise<void> {
    const digest = await this.buildDigest();
    const target: MessageTarget = {
      channelType: config.channel_type,
      platformChannelId: config.daily_digest_channel,
    };
    const formatter = this.formatters.get(config.channel_type);
    const message = formatter.formatDigest(digest);
    await this.adapter.sendMessage(target, message);
  }

  private async buildDigest(): Promise<DigestData> {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    return {
      generatedAt: now,
      activeByState: await this.db.countRequestsByState(),
      blockedRequests: await this.db.getBlockedRequests(),
      completedLast24h: await this.db.getCompletedSince(yesterday),
      queueDepth: await this.db.getQueuedRequestCount(),
      queueDepthByPriority: await this.db.getQueuedCountByPriority(),
    };
  }
}
```

### 3.10 Bidirectional Communication

#### 3.10.1 Conversation Manager

The `ConversationManager` tracks all human-system exchanges per request and handles the timeout/escalation flow:

```typescript
class ConversationManager {
  constructor(
    private db: Repository,
    private adapters: Map<ChannelType, IntakeAdapter>,
    private timeoutHandler: TimeoutHandler,
  ) {}

  /**
   * Send a structured prompt to the requester and wait for a response.
   * Returns the response or triggers timeout action.
   */
  async promptAndWait(
    requestId: string,
    prompt: StructuredPrompt
  ): Promise<UserResponse> {
    const request = await this.db.getRequest(requestId);

    // Record outbound message
    const messageId = await this.db.insertConversationMessage({
      request_id: requestId,
      direction: 'outbound',
      channel: request.source_channel,
      content: prompt.content,
      message_type: prompt.promptType,
      responded: false,
      timeout_at: new Date(Date.now() + prompt.timeoutSeconds * 1000),
    });

    // Send via the appropriate adapter
    const target = this.resolveTarget(request);
    const adapter = this.adapters.get(target.channelType);
    const response = await adapter.promptUser(target, prompt);

    if ('kind' in response && response.kind === 'timeout') {
      return this.timeoutHandler.handle(requestId, messageId);
    }

    // Record inbound response
    await this.db.insertConversationMessage({
      request_id: requestId,
      direction: 'inbound',
      channel: request.source_channel,
      content: response.content,
      message_type: 'feedback',
      responded: true,
      timeout_at: null,
    });

    // Mark the outbound message as responded
    await this.db.markMessageResponded(messageId);

    return response;
  }

  /**
   * Accept unsolicited feedback from the requester and inject it
   * into the pipeline's context for the active request.
   */
  async receiveFeedback(
    requestId: string,
    userId: string,
    message: string
  ): Promise<void> {
    await this.db.insertConversationMessage({
      request_id: requestId,
      direction: 'inbound',
      channel: 'feedback',
      content: message,
      message_type: 'feedback',
      responded: true,
      timeout_at: null,
    });

    // Emit event so the pipeline agent picks up the new context
    await this.emitEvent({
      type: 'feedback_received',
      requestId,
      userId,
      content: message,
      timestamp: new Date(),
    });
  }
}
```

#### 3.10.2 Timeout Handler

```typescript
class TimeoutHandler {
  async handle(requestId: string, messageId: string): Promise<never> {
    const config = await this.db.getTimeoutConfig();
    const request = await this.db.getRequest(requestId);

    await this.db.insertActivityLog({
      requestId,
      event: 'human_response_timeout',
      details: { messageId, action: config.human_response_action },
    });

    switch (config.human_response_action) {
      case 'pause':
        await this.pipeline.pauseRequest(requestId);
        await this.notify(request, 'Your request has been paused because a response was not received within the timeout window. Use `/resume` when ready.');
        break;

      case 'default':
        await this.pipeline.proceedWithDefault(requestId);
        await this.notify(request, 'No response received within the timeout window. Proceeding with a conservative default. The assumption has been noted in the request log.');
        break;

      case 'escalate':
        const escalateTo = await this.db.getEscalationTarget(requestId);
        await this.notify(escalateTo, `Request ${requestId} requires input. The original requester did not respond within the timeout window. Full conversation history is attached.`);
        break;
    }

    throw new TimeoutError(requestId, messageId);
  }
}
```

#### 3.10.3 Thread-Based Conversations

On Discord and Slack, all clarifying exchanges happen in a **dedicated thread** created when the first clarifying question is sent. This keeps the main channel clean (R-08).

- **Discord:** `channel.threads.create()` on the acknowledgment message. Subsequent messages use `thread.send()`.
- **Slack:** `chat.postMessage` with `thread_ts` set to the original acknowledgment message's `ts`. The bot also calls `conversations.join` on the thread to receive replies.

Thread IDs are stored in `ConversationMessage.thread_id` and in the request's `notification_config.routes[].threadId` so future notifications for this request continue in the same thread.

### 3.11 Authorization Model

#### 3.11.1 Role Hierarchy

```
admin > operator > contributor > viewer
```

Each higher role inherits all permissions of lower roles:

| Permission             | viewer | contributor | operator | admin |
|------------------------|--------|-------------|----------|-------|
| `/status`              | yes    | yes         | yes      | yes   |
| `/list`                | yes    | yes         | yes      | yes   |
| `/logs`                | yes    | yes         | yes      | yes   |
| `/submit`              | no     | yes         | yes      | yes   |
| `/feedback` (own)      | no     | yes         | yes      | yes   |
| `/cancel` (own)        | no     | yes         | yes      | yes   |
| `/pause` (own)         | no     | yes         | yes      | yes   |
| `/resume` (own)        | no     | yes         | yes      | yes   |
| `/priority` (own)      | no     | yes         | yes      | yes   |
| `/cancel` (any)        | no     | no          | yes      | yes   |
| `/pause` (any)         | no     | no          | yes      | yes   |
| `/resume` (any)        | no     | no          | yes      | yes   |
| `/priority` (any)      | no     | no          | yes      | yes   |
| `/feedback` (any)      | no     | no          | yes      | yes   |
| Review gate approval   | no     | no          | yes*     | yes   |
| `/kill`                | no     | no          | no       | yes   |
| Config changes         | no     | no          | no       | yes   |

\* Operators can approve review gates. Contributors can only approve if explicitly listed as a reviewer.

#### 3.11.2 Configuration File

```yaml
# intake-auth.yaml
version: 1

users:
  - internal_id: pwatson
    identities:
      discord_id: "123456789012345678"
      slack_id: "U0123ABCDEF"
      claude_user: "pwatson"
    role: admin
    repo_permissions: {}  # Admin has access to all repos

  - internal_id: jdoe
    identities:
      discord_id: "987654321098765432"
      slack_id: "U9876ZYXWVU"
      claude_user: "jdoe"
    role: contributor
    repo_permissions:
      "myorg/api-service": operator      # Elevated for this repo
      "myorg/frontend": contributor       # Default role applies
      "myorg/infrastructure": viewer      # Restricted for this repo

  - internal_id: readonly-bot
    identities:
      discord_id: "111222333444555666"
    role: viewer
    repo_permissions: {}

# Reviewers for review gates (can approve even without operator role)
review_gates:
  prd_review:
    reviewers: [pwatson, jdoe]
  tdd_review:
    reviewers: [pwatson]
  code_review:
    reviewers: [pwatson, jdoe]

# Rate limit overrides per role
rate_limit_overrides:
  admin:
    submissions_per_hour: 50
    queries_per_minute: 300
  operator:
    submissions_per_hour: 20
    queries_per_minute: 120
```

#### 3.11.3 AuthzEngine Implementation

```typescript
class AuthzEngine {
  private config: AuthzConfig;
  private lastModified: number = 0;

  constructor(private configPath: string) {
    this.config = this.loadConfig();
    this.watchForChanges();
  }

  /**
   * Check whether a user is authorized to perform an action.
   * Returns a decision with reason for audit logging.
   */
  async authorize(
    userId: string,
    action: AuthzAction,
    context: AuthzContext
  ): Promise<AuthzDecision> {
    const user = this.resolveUser(userId);
    if (!user) {
      return this.deny(userId, action, 'User not found in authorization config');
    }

    // Determine effective role (base role with optional repo override)
    const effectiveRole = context.targetRepo
      ? (user.repo_permissions[context.targetRepo] ?? user.role)
      : user.role;

    // Check permission
    const requiredRole = this.getRequiredRole(action, context);
    const hasPermission = ROLE_HIERARCHY[effectiveRole] >= ROLE_HIERARCHY[requiredRole];

    // Special case: author can manage own requests
    if (!hasPermission && context.requestId) {
      const request = await this.db.getRequest(context.requestId);
      if (request.requester_id === userId && AUTHOR_ALLOWED_ACTIONS.has(action)) {
        return this.grant(userId, action, 'Author of request');
      }
    }

    // Special case: review gate approval
    if (action === 'approve_review' && context.gate) {
      const isDesignatedReviewer = this.config.review_gates[context.gate]
        ?.reviewers.includes(user.internal_id);
      if (isDesignatedReviewer) {
        return this.grant(userId, action, 'Designated reviewer for gate');
      }
    }

    if (hasPermission) {
      return this.grant(userId, action, `Role: ${effectiveRole}`);
    }
    return this.deny(userId, action, `Insufficient role: ${effectiveRole}, required: ${requiredRole}`);
  }

  /**
   * Hot-reload: watch the config file and reload on change.
   */
  private watchForChanges(): void {
    fs.watchFile(this.configPath, { interval: 5000 }, (stats) => {
      if (stats.mtimeMs > this.lastModified) {
        this.config = this.loadConfig();
        this.lastModified = stats.mtimeMs;
        logger.info('Authorization config reloaded', { path: this.configPath });
      }
    });
  }
}

const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 0,
  contributor: 1,
  operator: 2,
  admin: 3,
};

const AUTHOR_ALLOWED_ACTIONS = new Set([
  'cancel', 'pause', 'resume', 'priority', 'feedback',
]);

interface AuthzDecision {
  granted: boolean;
  userId: string;
  action: AuthzAction;
  reason: string;
  timestamp: Date;
}

type AuthzAction =
  | 'submit' | 'status' | 'list' | 'cancel' | 'pause'
  | 'resume' | 'priority' | 'logs' | 'feedback' | 'kill'
  | 'approve_review' | 'config_change';

interface AuthzContext {
  requestId?: string;
  targetRepo?: string;
  gate?: string;
}
```

#### 3.11.4 Audit Logging

Every authorization decision is logged:

```typescript
interface AuditLogEntry {
  timestamp: Date;
  user_id: string;
  action: AuthzAction;
  resource: string;           // Request ID, repo, or system
  decision: 'grant' | 'deny';
  reason: string;
  source_channel: ChannelType;
  source_ip?: string;         // For Slack webhook requests
}
```

Audit logs are written to both the SQLite database (for querying) and structured JSON log output (for external log aggregation, NFR-08).

### 3.12 Rate Limiting

#### 3.12.1 Algorithm: Sliding Window Counter

The rate limiter uses a sliding window counter algorithm backed by SQLite. This provides accurate rate limiting without the memory overhead of a token bucket per user.

```typescript
class RateLimiter {
  /**
   * Check if the user is within their rate limit for the given action type.
   */
  async checkLimit(
    userId: string,
    actionType: 'submission' | 'query',
    config: RateLimitConfig,
    roleOverrides?: RateLimitOverrides
  ): Promise<RateLimitResult> {
    const limit = this.resolveLimit(actionType, config, roleOverrides);
    const windowMs = actionType === 'submission'
      ? 60 * 60 * 1000       // 1 hour
      : 60 * 1000;            // 1 minute

    const windowStart = new Date(Date.now() - windowMs);
    const count = await this.db.countActions(userId, actionType, windowStart);

    if (count >= limit) {
      const oldestInWindow = await this.db.getOldestActionInWindow(
        userId, actionType, windowStart
      );
      const retryAfterMs = oldestInWindow
        ? oldestInWindow.getTime() + windowMs - Date.now()
        : windowMs;

      return {
        allowed: false,
        remaining: 0,
        limit,
        retryAfterMs,
        message: `Rate limit exceeded. You can ${actionType === 'submission' ? 'submit' : 'query'} again in ${formatDuration(retryAfterMs)}.`,
      };
    }

    // Record the action
    await this.db.recordAction(userId, actionType, new Date());

    return {
      allowed: true,
      remaining: limit - count - 1,
      limit,
      retryAfterMs: 0,
    };
  }

  private resolveLimit(
    actionType: string,
    config: RateLimitConfig,
    overrides?: RateLimitOverrides
  ): number {
    if (overrides) {
      if (actionType === 'submission' && overrides.submissions_per_hour) {
        return overrides.submissions_per_hour;
      }
      if (actionType === 'query' && overrides.queries_per_minute) {
        return overrides.queries_per_minute;
      }
    }
    return actionType === 'submission'
      ? config.submissions_per_hour
      : config.queries_per_minute;
  }
}
```

#### 3.12.2 Description Length Enforcement

Enforced at the adapter level before any processing:

```typescript
function validateDescriptionLength(text: string, maxLength: number): void {
  if (text.length > maxLength) {
    throw new ValidationError(
      `Request description exceeds maximum length of ${maxLength} characters ` +
      `(received ${text.length} characters). Please shorten your description.`
    );
  }
}
```

### 3.13 Offline Resilience

#### 3.13.1 Bot Startup Recovery

On startup, the Discord and Slack adapters run a recovery check:

```typescript
async function startupRecovery(db: Repository, adapter: IntakeAdapter): Promise<void> {
  // Find all requests waiting for human input
  const pendingPrompts = await db.query(`
    SELECT cm.*, r.request_id, r.source_channel, r.notification_config
    FROM conversation_messages cm
    JOIN requests r ON cm.request_id = r.request_id
    WHERE cm.direction = 'outbound'
      AND cm.responded = false
      AND cm.timeout_at > ?
    ORDER BY cm.created_at ASC
  `, [new Date()]);

  for (const prompt of pendingPrompts) {
    // Re-send the pending prompt
    const target = resolveTarget(prompt);
    await adapter.sendMessage(target, {
      channelType: adapter.channelType,
      payload: formatResendNotice(prompt),
      fallbackText: `[Resent] ${prompt.content}`,
    });

    logger.info('Re-sent pending prompt after startup', {
      requestId: prompt.request_id,
      messageId: prompt.message_id,
    });
  }
}
```

#### 3.13.2 Exponential Backoff with Jitter

All external API calls (Discord REST, Slack Web API) use a shared retry utility:

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const baseMs = options.baseMs ?? 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
      if (!isRetryable(error)) throw error;

      // Respect platform rate-limit headers
      const retryAfter = extractRetryAfter(error);
      const backoff = retryAfter
        ? retryAfter * 1000
        : Math.min(baseMs * Math.pow(2, attempt), maxBackoffMs);

      // Add jitter: +/- 25%
      const jitter = backoff * (0.75 + Math.random() * 0.5);
      await sleep(jitter);
    }
  }
  throw new Error('Unreachable');
}

function isRetryable(error: unknown): boolean {
  if (error instanceof DiscordAPIError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof SlackAPIError) {
    return error.code === 'slack_webapi_platform_error' &&
           ['ratelimited', 'service_unavailable'].includes(error.data?.error);
  }
  return false;
}
```

#### 3.13.3 Graceful Shutdown

On `SIGTERM`, adapters finish the current command, persist state, and exit:

```typescript
function setupGracefulShutdown(adapters: IntakeAdapter[]): void {
  let shuttingDown = false;

  process.on('SIGTERM', async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('SIGTERM received, beginning graceful shutdown');

    // Signal all adapters to stop accepting new commands
    await Promise.all(adapters.map(a => a.shutdown()));

    // Flush database WAL
    await db.checkpoint();

    logger.info('Graceful shutdown complete');
    process.exit(0);
  });
}
```

### 3.14 Command Handler Architecture

All lifecycle commands are routed through a central `IntakeRouter` that handles the command dispatch pattern:

```typescript
class IntakeRouter {
  private handlers: Map<string, CommandHandler> = new Map();

  constructor(
    private authz: AuthzEngine,
    private rateLimiter: RateLimiter,
    private db: Repository,
  ) {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.handlers.set('submit',   new SubmitHandler(this.db));
    this.handlers.set('status',   new StatusHandler(this.db));
    this.handlers.set('list',     new ListHandler(this.db));
    this.handlers.set('cancel',   new CancelHandler(this.db));
    this.handlers.set('pause',    new PauseHandler(this.db));
    this.handlers.set('resume',   new ResumeHandler(this.db));
    this.handlers.set('priority', new PriorityHandler(this.db));
    this.handlers.set('logs',     new LogsHandler(this.db));
    this.handlers.set('feedback', new FeedbackHandler(this.db));
    this.handlers.set('kill',     new KillHandler(this.db));
  }

  async route(command: IncomingCommand): Promise<CommandResult> {
    const handler = this.handlers.get(command.commandName);
    if (!handler) {
      return { success: false, error: `Unknown command: ${command.commandName}` };
    }

    // 1. Resolve internal user identity
    const userId = await this.resolveUserId(command.source);

    // 2. Authorization check
    const authzContext = handler.buildAuthzContext(command);
    const decision = await this.authz.authorize(userId, command.commandName, authzContext);
    await this.db.insertAuditLog(decision);

    if (!decision.granted) {
      return {
        success: false,
        error: `Permission denied: ${decision.reason}`,
        errorCode: 'AUTHZ_DENIED',
      };
    }

    // 3. Rate limit check
    const actionType = handler.isQueryCommand() ? 'query' : 'submission';
    const rateResult = await this.rateLimiter.checkLimit(userId, actionType);
    if (!rateResult.allowed) {
      return {
        success: false,
        error: rateResult.message,
        errorCode: 'RATE_LIMITED',
        retryAfterMs: rateResult.retryAfterMs,
      };
    }

    // 4. Execute the handler
    try {
      return await handler.execute(command, userId);
    } catch (error) {
      logger.error('Command handler failed', {
        command: command.commandName,
        userId,
        error: error.message,
      });
      return {
        success: false,
        error: 'An internal error occurred. The error has been logged.',
        errorCode: 'INTERNAL_ERROR',
      };
    }
  }
}

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
```

**Handler summaries:**

| Handler | Key Behavior |
|---------|-------------|
| `SubmitHandler` | Validates description length, runs sanitizer, NLP parser, ambiguity detector, duplicate detector, enqueues, returns request ID and queue position. |
| `StatusHandler` | Fetches request, formats status with phase, progress, blocker, artifact links. |
| `ListHandler` | Queries all active requests, formats as sorted table, includes queue depth and estimated wait. |
| `CancelHandler` | Validates ownership/role, prompts for confirmation (destructive), signals pipeline to clean up branches/PRs, marks as cancelled. |
| `PauseHandler` | Validates ownership/role, signals pipeline to finish current phase then halt, sets status to paused. |
| `ResumeHandler` | Validates request is paused, re-enqueues at the recorded phase boundary, restores status. |
| `PriorityHandler` | Validates ownership/role, updates priority, recalculates queue position, notifies of new position. |
| `LogsHandler` | Fetches activity log entries (last 50 or all), formats with timestamps and phase context. |
| `FeedbackHandler` | Validates request is active, passes message to `ConversationManager.receiveFeedback`. |
| `KillHandler` | Requires admin role, requires typed confirmation ("CONFIRM"), signals pipeline to halt all processes, pauses all active requests, notifies all admins. |

---

## 4. Data Models

### 4.1 Full Request Entity Schema (SQLite DDL)

```sql
-- schema.sql

-- Enable WAL mode for concurrent reads
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Monotonically increasing request ID counter
CREATE TABLE IF NOT EXISTS id_counter (
  counter_name TEXT PRIMARY KEY,
  current_value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO id_counter (counter_name, current_value) VALUES ('request_id', 0);

-- Core request table
CREATE TABLE IF NOT EXISTS requests (
  request_id        TEXT PRIMARY KEY,         -- REQ-NNNNNN
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,            -- Sanitized
  raw_input         TEXT NOT NULL,            -- Original unsanitized input (audit)
  priority          TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('high', 'normal', 'low')),
  target_repo       TEXT,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'active', 'paused', 'cancelled', 'done', 'failed')),
  current_phase     TEXT NOT NULL DEFAULT 'queued',
  phase_progress    TEXT,                     -- JSON: {"current": N, "total": M}
  requester_id      TEXT NOT NULL,            -- Internal user identity
  source_channel    TEXT NOT NULL
                    CHECK (source_channel IN ('claude_app', 'discord', 'slack')),
  notification_config TEXT NOT NULL DEFAULT '{}',  -- JSON: NotificationConfig
  deadline          TEXT,                     -- ISO-8601 datetime or null
  related_tickets   TEXT DEFAULT '[]',        -- JSON array of URLs
  technical_constraints TEXT,
  acceptance_criteria TEXT,
  blocker           TEXT,                     -- Current blocker description
  promotion_count   INTEGER NOT NULL DEFAULT 0,
  last_promoted_at  TEXT,                     -- ISO-8601 datetime
  paused_at_phase   TEXT,                     -- Phase boundary where paused
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_priority_created ON requests(priority, created_at);
CREATE INDEX idx_requests_requester ON requests(requester_id);
CREATE INDEX idx_requests_updated ON requests(updated_at);

-- Request embeddings for duplicate detection
CREATE TABLE IF NOT EXISTS request_embeddings (
  request_id TEXT PRIMARY KEY REFERENCES requests(request_id),
  embedding  BLOB NOT NULL,                   -- Float32Array serialized
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Conversation messages (bidirectional communication)
CREATE TABLE IF NOT EXISTS conversation_messages (
  message_id   TEXT PRIMARY KEY,              -- UUID
  request_id   TEXT NOT NULL REFERENCES requests(request_id),
  direction    TEXT NOT NULL
               CHECK (direction IN ('inbound', 'outbound')),
  channel      TEXT NOT NULL
               CHECK (channel IN ('claude_app', 'discord', 'slack', 'feedback')),
  content      TEXT NOT NULL,
  message_type TEXT NOT NULL
               CHECK (message_type IN (
                 'clarifying_question', 'feedback', 'escalation',
                 'status_update', 'approval_request'
               )),
  responded    INTEGER NOT NULL DEFAULT 0,    -- Boolean
  timeout_at   TEXT,                          -- ISO-8601 datetime or null
  thread_id    TEXT,                          -- Platform thread ID for threading
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_messages_request ON conversation_messages(request_id);
CREATE INDEX idx_messages_pending ON conversation_messages(responded, timeout_at)
  WHERE responded = 0 AND timeout_at IS NOT NULL;

-- User identity mapping
CREATE TABLE IF NOT EXISTS user_identities (
  internal_id        TEXT PRIMARY KEY,
  role               TEXT NOT NULL DEFAULT 'viewer'
                     CHECK (role IN ('admin', 'operator', 'contributor', 'viewer')),
  discord_id         TEXT UNIQUE,
  slack_id           TEXT UNIQUE,
  claude_user        TEXT UNIQUE,
  repo_permissions   TEXT NOT NULL DEFAULT '{}',   -- JSON: { repo: role }
  rate_limit_override TEXT,                         -- JSON or null
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_users_discord ON user_identities(discord_id) WHERE discord_id IS NOT NULL;
CREATE INDEX idx_users_slack ON user_identities(slack_id) WHERE slack_id IS NOT NULL;
CREATE INDEX idx_users_claude ON user_identities(claude_user) WHERE claude_user IS NOT NULL;

-- Activity log (request-level events)
CREATE TABLE IF NOT EXISTS activity_log (
  log_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT NOT NULL REFERENCES requests(request_id),
  event       TEXT NOT NULL,
  phase       TEXT,
  details     TEXT NOT NULL DEFAULT '{}',     -- JSON
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_activity_request ON activity_log(request_id, created_at);
CREATE INDEX idx_activity_created ON activity_log(created_at);

-- Authorization audit log
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
CREATE INDEX idx_authz_denials ON authz_audit_log(decision, created_at)
  WHERE decision = 'deny';

-- Rate limit tracking
CREATE TABLE IF NOT EXISTS rate_limit_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('submission', 'query')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_rate_limit_user_type ON rate_limit_actions(user_id, action_type, created_at);

-- Notification delivery tracking (for at-least-once delivery)
CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   TEXT NOT NULL REFERENCES requests(request_id),
  channel_type TEXT NOT NULL,
  target       TEXT NOT NULL,                 -- JSON: MessageTarget
  payload_hash TEXT NOT NULL,                 -- SHA-256 of payload (dedup)
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at TEXT
);

CREATE INDEX idx_deliveries_pending ON notification_deliveries(status)
  WHERE status = 'pending';
```

### 4.2 Request ID Generation

```typescript
async function generateRequestId(db: Repository): Promise<string> {
  // Atomic increment in SQLite
  const result = await db.query(`
    UPDATE id_counter
    SET current_value = current_value + 1
    WHERE counter_name = 'request_id'
    RETURNING current_value
  `);
  const seq = result[0].current_value;
  return `REQ-${String(seq).padStart(6, '0')}`;
}
```

---

## 5. API Contracts

### 5.1 Discord API Interactions

| Interaction | Discord API Endpoint | Method | Notes |
|-------------|---------------------|--------|-------|
| Register slash commands | `/applications/{app_id}/guilds/{guild_id}/commands` | PUT (bulk overwrite) | Registered on bot startup. Uses guild commands for instant updates (global commands take up to 1 hour to propagate). |
| Acknowledge interaction | Interaction callback URL | POST `{ type: 5 }` | Deferred response (type 5) within 3 seconds. |
| Edit deferred response | `/webhooks/{app_id}/{token}/messages/@original` | PATCH | Final response with embed payload. |
| Create thread | `/channels/{channel_id}/messages/{message_id}/threads` | POST | For clarifying conversations. |
| Send thread message | `/channels/{thread_id}/messages` | POST | Subsequent clarifying questions and responses. |
| Send DM | `/users/@me/channels` then `/channels/{dm_id}/messages` | POST + POST | For private notifications. |
| Get guild member | `/guilds/{guild_id}/members/{user_id}` | GET | Resolve user identity. |

**Rate limit awareness:** Discord enforces per-route rate limits. The adapter reads `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-RateLimit-Bucket` headers from every response and pauses when `Remaining` reaches 0. Global rate limits (50 requests/second) are handled by the retry utility.

### 5.2 Slack API Interactions

| Interaction | Slack Web API Method | Notes |
|-------------|---------------------|-------|
| Acknowledge slash command | Return HTTP 200 within 3 seconds | Slack requires immediate acknowledgment. |
| Respond to slash command | `response_url` (POST) | Delayed response for commands that take longer than 3 seconds. |
| Post message | `chat.postMessage` | For proactive notifications. |
| Post ephemeral | `chat.postEphemeral` | For error messages visible only to the user. |
| Post threaded reply | `chat.postMessage` with `thread_ts` | For clarifying conversations in threads. |
| Update message | `chat.update` | For updating status embeds in place. |
| Open modal | `views.open` with `trigger_id` | For complex submission forms. |
| Get user info | `users.info` | Resolve display name for notification context. |
| Verify request | Signing secret HMAC | All incoming requests verified (Section 3.4.2). |

**Rate limit awareness:** Slack returns HTTP 429 with a `Retry-After` header. The adapter extracts this value and passes it to the retry utility. Slack's tier limits (e.g., Tier 3: ~50 requests/minute for `chat.postMessage`) are respected by the notification batcher.

### 5.3 Internal Event Contract

The intake layer communicates with the pipeline core via a typed event bus. The events emitted by the intake layer:

```typescript
type IntakeEvent =
  | { type: 'request_submitted'; requestId: string; request: RequestEntity }
  | { type: 'request_cancelled'; requestId: string; cleanupRequested: boolean }
  | { type: 'request_paused'; requestId: string }
  | { type: 'request_resumed'; requestId: string; resumeAtPhase: string }
  | { type: 'priority_changed'; requestId: string; oldPriority: Priority; newPriority: Priority }
  | { type: 'feedback_received'; requestId: string; userId: string; content: string }
  | { type: 'kill_all'; initiatedBy: string; timestamp: Date }
  | { type: 'human_response'; requestId: string; messageId: string; response: UserResponse };
```

The events consumed from the pipeline core:

```typescript
type PipelineEvent =
  | PhaseTransitionEvent     // Defined in Section 3.9.1
  | { type: 'blocker_detected'; requestId: string; description: string }
  | { type: 'human_input_needed'; requestId: string; prompt: StructuredPrompt }
  | { type: 'request_completed'; requestId: string; artifacts: ArtifactLinks }
  | { type: 'request_failed'; requestId: string; error: string };
```

---

## 6. Error Handling

### 6.1 Error Categories

| Category | Examples | User-Facing Behavior | Internal Behavior |
|----------|----------|---------------------|-------------------|
| **Validation** | Invalid request ID format, description too long, invalid priority value | Clear error message with expected format | Log at `warn` level |
| **Authorization** | Insufficient role, repo not permitted | "Permission denied" with required role hint | Log decision to audit log |
| **Rate limit** | Submissions or queries exceeded | Retry-after time provided | Log at `info` level |
| **Transient** | Discord/Slack API 5xx, network timeout | "Temporary issue, retrying..." (auto-retry) | Exponential backoff, log at `warn` |
| **Platform** | Discord/Slack API 4xx (not auth) | Descriptive error from platform | Log at `error`, do not retry |
| **Internal** | Database error, parser crash, OOM | "An internal error occurred" (generic) | Log at `error` with full stack trace |
| **Injection** | Blocked by sanitizer | "Request flagged for security review" | Log at `warn`, flag for human review |

### 6.2 Error Response Format

All command handlers return errors in a consistent structure:

```typescript
interface ErrorResponse {
  success: false;
  error: string;              // Human-readable message
  errorCode: string;          // Machine-readable code
  retryAfterMs?: number;      // For rate limit errors
  details?: Record<string, unknown>; // Additional context (never includes internals)
}
```

Error codes:

| Code | Meaning |
|------|---------|
| `VALIDATION_ERROR` | Input failed validation |
| `AUTHZ_DENIED` | Authorization check failed |
| `RATE_LIMITED` | Rate limit exceeded |
| `NOT_FOUND` | Request ID not found |
| `INVALID_STATE` | Operation not valid for current request state (e.g., resume on active request) |
| `QUEUE_FULL` | Queue at capacity |
| `DUPLICATE_DETECTED` | Potential duplicate found (not an error, requires confirmation) |
| `INJECTION_BLOCKED` | Prompt injection detected |
| `INJECTION_FLAGGED` | Request flagged for review |
| `INTERNAL_ERROR` | Unhandled internal error |
| `PLATFORM_ERROR` | Discord/Slack API error |

### 6.3 State Machine Validation

Commands are validated against the request's current state:

```
           ┌──────────────────────────────────────────────┐
           │                                              │
           v                                              │
        queued ──> active ──> done                        │
           │          │                                   │
           │          ├──> paused ──> resumed ──> active   │
           │          │                                   │
           │          ├──> cancelled                       │
           │          │                                   │
           │          └──> failed                          │
           │                                              │
           └──> cancelled                                  │
                                                          │
```

| Current State | Allowed Actions |
|--------------|-----------------|
| `queued` | cancel, priority |
| `active` | cancel, pause, feedback |
| `paused` | cancel, resume |
| `cancelled` | (none, terminal) |
| `done` | (none, terminal) |
| `failed` | resume (retry from failed phase), cancel |

Attempting an invalid state transition returns `INVALID_STATE`:

```typescript
function validateStateTransition(
  currentStatus: RequestStatus,
  action: string
): void {
  const allowed = STATE_TRANSITIONS[currentStatus];
  if (!allowed?.includes(action)) {
    throw new InvalidStateError(
      `Cannot ${action} a request in '${currentStatus}' state. ` +
      `Allowed actions: ${allowed?.join(', ') ?? 'none'}.`
    );
  }
}
```

---

## 7. Security

### 7.1 Prompt Injection Defense (Defense in Depth)

The system implements four layers of defense:

| Layer | Component | Mechanism | Section |
|-------|-----------|-----------|---------|
| L1 | Sanitizer | Regex-based rule matching, block/flag/escape | 3.8.1 |
| L2 | Structured boundary | User text is data, never instruction | 3.8.3 |
| L3 | NLP parser isolation | Extraction prompt in system msg, user text in user msg | 3.5.1 |
| L4 | Schema validation | `ParsedRequest` is a typed object; pipeline core receives a `RequestEntity`, not a string | 3.5.1 |

**Red team testing:** Before launch, 50 known injection payloads (OWASP LLM Top 10 patterns) will be run through the sanitizer. The test suite will be maintained alongside `injection-rules.yaml`.

### 7.2 Secrets Management

- Discord bot token, Slack bot token, and Slack signing secret are loaded from environment variables, never stored in config files.
- The `intake-config.yaml` uses `${ENV_VAR}` syntax for secret references, which are resolved at runtime.
- Raw user input is stored in `raw_input` for audit purposes but is never re-processed or re-injected into prompts. It is marked as audit-only in the data access layer.

### 7.3 Input Validation Summary

| Field | Validation |
|-------|-----------|
| `description` | Max 10,000 chars, sanitized, UTF-8 valid |
| `request-id` | Regex `/^REQ-\d{6}$/` |
| `priority` | Enum: `high`, `normal`, `low` |
| `repo` | Regex `/^[\w.-]+\/[\w.-]+$/` (owner/name format) |
| `deadline` | ISO-8601 date parse, must be in the future |
| `feedback message` | Max 4,000 chars (Discord limit), sanitized |

### 7.4 Transport Security

- **Slack:** All webhook endpoints must be served over HTTPS. Request signature verification prevents spoofing (Section 3.4.2).
- **Discord:** The gateway websocket connection uses TLS. Interaction verification uses Ed25519 signatures (handled by the Discord library).
- **Claude App:** Local process, no network transport. Auth is OS-user-level.

---

## 8. Testing Strategy

### 8.1 Unit Tests

| Component | Key Test Cases | Coverage Target |
|-----------|---------------|-----------------|
| `parseCommandArgs` | Quoted strings, flags, edge cases (empty, special chars) | 100% |
| `sanitize` | All rule types (block, flag, escape), no false positives on clean input | 100% of rules |
| `detectAmbiguity` | Short/vague input flagged, clear input passes, boundary cases (exactly 15 words) | 95% |
| `cosineSimilarity` | Identical vectors = 1.0, orthogonal = 0.0, known similar pairs > threshold | 100% |
| `promoteStarvedRequests` | Promotion at threshold, no promotion before threshold, double-promotion guard | 100% |
| `AuthzEngine.authorize` | All role/action combinations, repo overrides, author special case, reviewer gate | 100% of permission matrix |
| `RateLimiter.checkLimit` | Under limit, at limit, over limit, window sliding, role overrides | 100% |
| `validateStateTransition` | All valid transitions, all invalid transitions | 100% |

### 8.2 Integration Tests

| Test Scenario | Setup | Assertions |
|--------------|-------|------------|
| **Submit flow** | Mock NLP parser, real SQLite, real sanitizer | Request created, ID assigned, queue position returned, embedding stored |
| **Duplicate detection** | Pre-seed DB with known requests and embeddings | Similar request flagged, dissimilar request passes, threshold boundary tested |
| **Authorization chain** | Load test auth config, real AuthzEngine | Each role can do only permitted actions, repo overrides work, audit log populated |
| **Starvation promotion** | Insert old low-priority requests, run promotion | Requests promoted at correct time, not promoted before threshold |
| **Notification delivery** | Mock adapters, real NotificationEngine | Correct formatter called per channel, retry on failure, at-least-once verified |
| **Conversation timeout** | Mock adapter with delayed response | Timeout action triggered (pause/default/escalate per config) |
| **Full lifecycle** | Submit -> status -> pause -> resume -> cancel | Each state transition correct, cleanup signals emitted, audit trail complete |

### 8.3 Adapter Tests (per channel)

| Channel | Test Approach |
|---------|--------------|
| **Claude App** | Direct function calls to the adapter. Test arg parsing, output formatting. No network mocking needed. |
| **Discord** | Mock the Discord.js REST client and gateway. Verify slash command registration payload, interaction acknowledgment timing, embed formatting, thread creation. |
| **Slack** | Mock the Slack Web API client. Verify request signature verification, Block Kit payload structure, modal submission handling, `response_url` follow-up. |

### 8.4 Security Tests

| Test | Method |
|------|--------|
| Prompt injection corpus | Run 50+ known injection patterns through sanitizer, assert all blocked or flagged |
| Authorization boundary | For each role, attempt every command, assert correct grant/deny |
| Rate limit enforcement | Rapid-fire submissions, assert 429 after limit, assert retry-after is accurate |
| Replay attack (Slack) | Send request with stale timestamp, assert rejection |
| State transition abuse | Attempt cancel on done request, resume on active, etc., assert INVALID_STATE |

### 8.5 Load Tests

| Scenario | Target |
|----------|--------|
| 100 concurrent status queries | Response time < 2s (p95), no database lock contention (WAL mode) |
| Queue at max depth (50), submit attempt | Clean rejection message, no partial state |
| 1000 notification deliveries in 1 minute | No platform rate limit violations (batching effective) |

---

## 9. Trade-offs & Alternatives

### 9.1 Local Embedding Model vs. Claude API for Duplicate Detection

| | Local (all-MiniLM-L6-v2) | Claude API |
|-|--------------------------|------------|
| **Latency** | ~10ms per embedding | ~500ms per API call |
| **Cost** | Zero (ONNX runtime, CPU) | $0.003-0.015 per request at scale |
| **Accuracy** | Good for similarity, not for nuanced understanding | Excellent, can understand intent differences |
| **Offline** | Works without network | Fails when API unreachable |
| **Bundle size** | ~50MB model file | Zero |

**Decision:** Local model. The accuracy difference is minimal for similarity comparison (which is the model's training objective), and the operational advantages (cost, latency, offline) are significant.

**Escape hatch:** If false positive rate exceeds 10% in the first 30 days, add a second-pass Claude API call to verify flagged duplicates before presenting to the user.

### 9.2 Slack Slash Commands vs. Socket Mode

| | Slash Commands (HTTP) | Socket Mode (WebSocket) |
|-|----------------------|------------------------|
| **Deployment** | Requires public HTTPS endpoint | No public endpoint needed |
| **Latency** | Direct HTTP, low latency | WebSocket relay, slightly higher |
| **Reliability** | Standard HTTP, well-understood | Slack-managed socket, reconnection logic needed |
| **Firewall** | Inbound port required | Outbound only |

**Decision:** Slash commands over HTTP. The system runs on homelab infrastructure where exposing an HTTPS endpoint (via Cloudflare Tunnel or similar) is straightforward, and HTTP-based slash commands are the standard Slack integration pattern. Socket Mode is available as a fallback configuration for environments where inbound ports are not an option.

### 9.3 SQLite vs. PostgreSQL

| | SQLite | PostgreSQL |
|-|--------|-----------|
| **Deployment** | Zero-config, single file | Separate process, config |
| **Concurrency** | WAL mode handles concurrent reads well; single writer | Full MVCC, multiple writers |
| **Scalability** | Sufficient for single-operator (NFR-02: 100 concurrent requests) | Overkill for this use case |
| **Backup** | File copy | pg_dump |

**Decision:** SQLite. The system is explicitly single-tenant (NG-05) and the concurrency requirements (100 active requests, NFR-02) are well within SQLite WAL mode's capabilities. Migrating to PostgreSQL later is straightforward since the schema uses standard SQL.

### 9.4 Per-Command Slash Commands (Slack) vs. Single Command with Subcommands

Slack does not support subcommand grouping in slash commands. Two options:

| | Individual commands (`/ad-submit`, `/ad-status`, ...) | Single command (`/ad submit ...`) |
|-|------------------------------------------------------|----------------------------------|
| **Discoverability** | Each command appears in the command palette with its own description | Single command, user must know subcommands |
| **Registration** | 10 separate commands in manifest | 1 command, custom arg parsing |
| **Slack UX** | Typing `/ad-` shows all commands with autocomplete | Typing `/ad` shows one command, then free text |

**Decision:** Individual commands. Discoverability and per-command usage hints in the Slack command palette outweigh the cost of registering multiple commands.

### 9.5 Thread-Based vs. Channel-Based Clarifying Conversations

| | Threads | Inline channel messages |
|-|---------|----------------------|
| **Channel noise** | Low: conversation is collapsed into thread | High: every exchange is a top-level message |
| **Context** | Grouped: all messages in one thread | Scattered: must scroll or search |
| **Notification** | Thread followers notified | Everyone in channel notified |

**Decision:** Threads. All clarifying conversations happen in a dedicated thread (Section 3.10.3). This is a clear win on all dimensions.

---

## 10. Implementation Plan

### Phase 1: Claude App Native (Weeks 1-3)

**Week 1: Core Infrastructure**
- SQLite schema creation and migration framework
- `Repository` data access layer (CRUD for all tables)
- `IntakeRouter` with command registration and dispatch
- `AuthzEngine` with YAML config loading and hot-reload
- `RateLimiter` with sliding window counter
- Request ID generation

**Week 2: Request Pipeline**
- `ClaudeAdapter` with all slash command registrations
- Argument parser with quoted string and flag support
- `Sanitizer` with externalized rule set
- NLP parser integration (Claude API call for structured extraction)
- Ambiguity detector with clarifying question generation
- `RequestQueue` with priority ordering and depth enforcement

**Week 3: Communication & Lifecycle**
- `NotificationEngine` with CLI formatter (ANSI)
- `ConversationManager` with timeout handling
- All lifecycle command handlers (submit, status, list, cancel, pause, resume, priority, logs, feedback, kill)
- Starvation prevention background timer
- Audit logging
- Graceful shutdown
- Unit and integration test suite

**Phase 1 exit criteria:** Full submit-to-done lifecycle through Claude App with status updates, clarifying questions, pause/resume/cancel, rate limiting, and authorization.

### Phase 2: Discord Bot (Weeks 4-6)

**Week 4: Discord Foundation**
- Discord bot setup (OAuth2 app, gateway connection)
- Slash command registration (guild-scoped)
- `DiscordAdapter` implementing `IntakeAdapter`
- Interaction deferral and response editing
- Discord user identity mapping to internal IDs
- Extract `IntakeAdapter` interface from Phase 1 Claude adapter (refactor)

**Week 5: Rich Discord Experience**
- Discord embed formatter (color-coded status, fields)
- Thread creation for clarifying conversations
- Button components for confirmations (kill, cancel, duplicate)
- Modal for complex submissions
- Notification routing to specific channels/DMs
- Duplicate detection (local embedding model integration)

**Week 6: Discord Polish**
- Daily digest delivery to Discord
- Starvation prevention (already implemented, verify with Discord notifications)
- Bot startup recovery (re-send pending prompts)
- Exponential backoff with jitter for Discord API
- Graceful shutdown for Discord gateway
- Discord-specific integration tests
- Mobile rendering validation (iOS + Android Discord clients)

**Phase 2 exit criteria:** Full command parity with Phase 1 over Discord. Rich embeds, threaded conversations, daily digests.

### Phase 3: Slack Bot (Weeks 7-9)

**Week 7: Slack Foundation**
- Slack app creation (manifest deployment)
- Request signature verification
- `SlackAdapter` implementing `IntakeAdapter`
- Slash command handling (10 individual commands)
- Slack user identity mapping to internal IDs
- 3-second acknowledgment + `response_url` follow-up pattern

**Week 8: Rich Slack Experience**
- Block Kit formatter (sections, fields, context, actions)
- Thread-based clarifying conversations (`thread_ts`)
- Interactive buttons for confirmations
- Notification routing to specific channels/DMs
- Daily digest delivery to Slack

**Week 9: Slack Polish & Cross-Channel**
- Cross-channel notification (submit in Slack, notify in Discord)
- Modal forms for complex submissions
- Bot startup recovery for Slack
- Exponential backoff for Slack Web API
- Graceful shutdown for Slack
- Mobile rendering validation (iOS + Android Slack clients)
- Slack-specific integration tests
- End-to-end cross-channel test suite

**Phase 3 exit criteria:** Full command parity across all three channels. Cross-channel notifications work. Mobile rendering validated.

---

## 11. Open Questions

| ID | Question | PRD Ref | Impact | Recommendation |
|----|----------|---------|--------|----------------|
| TQ-1 | Should file attachments (mockups, specs) be supported on submit? | OQ-1 | If yes, adapter design needs multipart handling; storage needs blob management. | Defer to Phase 4. Accept URL references in `related_tickets` for now. |
| TQ-2 | How to handle requests targeting unknown repos? | OQ-2 | Affects submit handler validation. | Reject with "repo not configured" error. Admin must add repo to a known-repos list. Auto-clone is too risky. |
| TQ-3 | Daily digest format: single message or threaded? | OQ-3 | Affects formatter implementation. | Single message with summary. If it exceeds platform limits (Discord: 6000 chars, Slack: 3000 chars per block), paginate into multiple messages. |
| TQ-4 | Escalation chain depth? | OQ-4 | Affects `TimeoutHandler` complexity. | Single-level escalation for Phase 1. The `intake-auth.yaml` can define an `escalation_target` per user. Multi-level chains are Phase 4. |
| TQ-5 | `/kill` artifact rollback? | OQ-5 | Affects `KillHandler` implementation. | Kill stops processes and pauses requests but does NOT roll back artifacts. Rollback is manual or via `/cancel` per request. This is safer -- accidental kill should not destroy work. |
| TQ-6 | Multi-repo requests? | OQ-6 | Affects request schema and pipeline dispatch. | Force user to split into separate requests for Phase 1. Add `target_repos: string[]` (plural) in Phase 4 with dependency linking. |
| TQ-7 | Embedding model selection finalized? | OQ-7 | Affects bundle size and accuracy. | `all-MiniLM-L6-v2` via `@xenova/transformers`. If accuracy is insufficient, add Claude API second-pass verification. |
| TQ-8 | Completed request retention? | OQ-8 | Affects database growth and duplicate detection window. | Keep indefinitely in SQLite. Add a `VACUUM` maintenance task. Completed requests are small rows; 10,000 requests is under 10MB. |
| TQ-9 | Request watchers? | OQ-9 | Adds a watchers table and notification fan-out. | Defer to Phase 4. The notification routing system already supports multiple routes per request, so adding watchers is a config addition, not an architecture change. |
| TQ-10 | Claude App user identity on shared machines? | OQ-10 | Affects `ClaudeAdapter` identity resolution. | Use OS username (`$USER`). Document that shared machine users should use distinct OS accounts. If this is insufficient, add an explicit `--as <identity>` flag (requires admin role to impersonate). |
| TQ-11 | Should the Slack adapter support Socket Mode as a fallback? | (new) | Affects Slack adapter design. | Yes, implement as a config toggle (`slack.socket_mode: true`). The command handling logic is identical; only the transport layer differs. |
| TQ-12 | How are embeddings stored in SQLite BLOB? | (new) | Affects duplicate detector performance. | Store as raw `Float32Array` buffer (1536 bytes for 384-dim). Deserialize with `new Float32Array(buffer)`. Faster than JSON serialization. |

---

## 12. Revision History

| Version | Date       | Author          | Changes         |
|---------|------------|-----------------|-----------------|
| 1.0     | 2026-04-08 | Patrick Watson  | Initial draft   |
