# PRD-008: Unified Request Submission Packaging

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **Title**   | Unified Request Submission Packaging        |
| **PRD ID**  | PRD-008                                    |
| **Version** | 1.0                                        |
| **Date**    | 2026-04-17                                 |
| **Author**  | Patrick Watson                             |
| **Status**  | Draft                                      |
| **Plugin**  | autonomous-dev                             |

---

## 1. Problem Statement

PRD-006 designed a comprehensive intake layer with four channels (Claude App, CLI, Discord, Slack), 10 unified commands, and sophisticated request processing. The TypeScript implementation is ~90% complete with router, handlers, adapters, and extensive test coverage. However, the system remains unshippable due to eight critical gaps preventing any user from submitting a request via any channel.

The core architectural gap: the intake layer writes to SQLite (`intake/db/repository.ts`), but the bash daemon expects filesystem state (`<repo>/.autonomous-dev/requests/<REQ-id>/state.json`). Submitted requests never reach the daemon. Additionally, the CLI channel is entirely missing from the bash dispatcher (`plugins/autonomous-dev/bin/autonomous-dev.sh`), Claude App slash commands are defined in TypeScript but not discoverable by Claude Code, and Discord/Slack adapters have no service entry points despite complete implementation.

This PRD operationalizes PRD-006 by bridging these gaps, making request submission fully functional across all channels, and establishing the intake → daemon handoff that enables the autonomous pipeline to process real work.

### The Eight Blocking Gaps

1. **CLI channel missing entirely** — The bash dispatcher routes only `install-daemon`, `daemon *`, `kill-switch`, `circuit-breaker`, `config *`. No `autonomous-dev request submit/status/list/cancel/pause/resume/priority/logs/feedback/kill` exists.

2. **Claude App commands not discoverable** — The 10 `autonomous-dev:*` commands exist in `intake/adapters/claude_adapter.ts` COMMANDS array with runtime registration, but Claude Code discovers commands through `commands/*.md` files. Only `observe.md` exists.

3. **Discord bot has no service entry point** — Complete adapter (`intake/adapters/discord/discord_adapter.ts`, 3000+ lines) exists but nothing starts it. Missing main.ts, bot token configuration, process lifecycle.

4. **Slack app has no service entry point** — Complete adapter (`intake/adapters/slack/slack_adapter.ts`, 2500+ lines) plus HTTP receiver (`slack_server.ts`) and Socket Mode support exist but no startup mechanism.

5. **Package.json dependencies incomplete** — Code references `discord.js` and `better-sqlite3` but they're not declared. TypeScript build would fail.

6. **THE CRITICAL GAP — intake → daemon handoff not implemented** — SQLite repository writes never produce `state.json` files that the daemon consumes. The bridge is missing.

7. **No request-source metadata** — Audit and debugging require knowing which channel a request originated from.

8. **No e2e test for submit → state.json → daemon pickup** — Individual adapter tests exist but the full pipeline remains unverified.

## 2. Goals

| ID   | Goal                                                                                           |
|------|------------------------------------------------------------------------------------------------|
| G-01 | Implement CLI request management commands (`autonomous-dev request submit/status/list/cancel/pause/resume/priority/logs/feedback/kill`) with argument validation and help text. |
| G-02 | Create Claude Code discoverable command stubs (`commands/*.md`) that proxy to the TypeScript router for all 10 slash commands. |
| G-03 | Provide service entry points for Discord and Slack adapters with bot token configuration, graceful shutdown, and process lifecycle management. |
| G-04 | Bridge the intake → daemon gap by writing `state.json` files on successful request enqueue, maintaining SQLite as the canonical index. |
| G-05 | Add request source metadata (`cli | claude-app | discord | slack`) to state schema for audit trails and channel-specific debugging. |
| G-06 | Complete package.json dependencies (`discord.js`, `better-sqlite3` with pinned versions) to enable successful TypeScript builds. |
| G-07 | Implement comprehensive e2e testing covering submit → state.json → daemon pickup flow across all channels. |
| G-08 | Update autonomous-dev-assist plugin with channel-specific setup skills and intake command coverage. |
| G-09 | Provide per-channel configuration gates so operators can disable problematic channels without losing the entire intake system. |
| G-10 | Ensure zero regression on existing pipeline phases — intake changes affect only the entry boundary, not PRD → TDD → Plan → Spec → Code → Review → Deploy flow. |

## 3. Non-Goals

| ID    | Non-Goal                                                                                     |
|-------|----------------------------------------------------------------------------------------------|
| NG-01 | Rewriting the TypeScript intake layer. The 90% complete implementation remains unchanged. |
| NG-02 | Adding a fifth intake channel. Web portal is PRD-009 scope.                                |
| NG-03 | Changing the daemon state model or state.json schema beyond adding source metadata.       |
| NG-04 | Adding email, iMessage, or voice-based intake channels.                                    |
| NG-05 | Multi-tenant support. Single operator deployment remains the target.                       |
| NG-06 | GUI or web dashboard for request management. CLI and chat interfaces suffice (portal is PRD-009 scope). |

## 4. User Stories

### Submitting Requests

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-01 | As a developer, I want to run `autonomous-dev request submit "Build OAuth2 middleware"` so that I can submit requests without leaving my terminal. | P0       |
| US-02 | As a product manager, I want to type `/autonomous-dev:submit "Add pagination to users API"` in Claude Code so that I can submit requests within my coding session. | P0       |
| US-03 | As a team lead, I want to type `/submit Build rate-limiting middleware` in our Discord server so that my team sees the request and can track its progress collaboratively. | P1       |
| US-04 | As a developer, I want to type `/submit Add pagination to /users endpoint` in Slack so that I don't context-switch between tools. | P2       |
| US-05 | As a submitter, I want all channels to return the same request ID format (`REQ-NNNNNN`) and provide consistent status updates regardless of submission method. | P0       |

### Managing Requests

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-06 | As a requester, I want to run `autonomous-dev request status REQ-000042` or `/autonomous-dev:status REQ-000042` to see current phase, progress, and blockers across any channel. | P0       |
| US-07 | As a team lead, I want to run `autonomous-dev request list` or `/autonomous-dev:list` to see all active requests with states and priorities. | P0       |
| US-08 | As a requester, I want to cancel my request via `autonomous-dev request cancel REQ-000042` and have the system clean up branches, worktrees, and draft PRs. | P0       |
| US-09 | As a requester, I want to pause and resume requests (`pause REQ-000042`, `resume REQ-000042`) so I can temporarily stop work without losing progress. | P1       |
| US-10 | As a requester, I want to change request priority (`priority REQ-000042 high`) so urgent work can jump the queue. | P1       |

### Operating the System

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-11 | As an operator, I want to view request logs (`logs REQ-000042`) to debug pipeline failures or understand decision history. | P0       |
| US-12 | As an operator, I want to engage emergency kill switches (`kill` command) to stop all processing when incidents occur. | P0       |
| US-13 | As an operator, I want to configure which channels are enabled (Discord on/off, Slack on/off, CLI always on) so I can disable broken channels without losing the whole system. | P1       |
| US-14 | As an operator, I want startup and shutdown logs that show which channels initialized successfully and which failed, so I can diagnose configuration issues. | P1       |

## 5. Functional Requirements

### 5.1 CLI Dispatcher Additions

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-801 | The bash dispatcher SHALL add a `request` subcommand with subcommands: `submit`, `status`, `list`, `cancel`, `pause`, `resume`, `priority`, `logs`, `feedback`, `kill`.                                             | P0       |
| FR-802 | `autonomous-dev request submit "description" [--priority high|normal|low] [--repo owner/name] [--deadline ISO-8601]` SHALL validate arguments and invoke the TypeScript router via Node.js subprocess. The subprocess SHALL be invoked with an argument array (`execFile` with argv list), never via shell string interpolation, to prevent command injection. The request description SHALL be passed as a single argv entry with no intermediate shell parsing. | P0       |
| FR-803 | All CLI request commands SHALL format output with ANSI color codes for status by default and SHALL suppress colors when (a) the `NO_COLOR` environment variable is set (per no-color.org), (b) stdout is not a TTY, or (c) `--no-color` is passed. Exit codes: 0 success, 1 user error, 2 system error.           | P1       |
| FR-804 | The CLI dispatcher SHALL provide `autonomous-dev request --help` with command descriptions and argument examples matching PRD-006 command vocabulary.                                                              | P1       |
| FR-805 | CLI commands SHALL validate request ID format (`REQ-\d{6}`) and priority values (`high|normal|low`) at the bash level before invoking TypeScript to fail fast on malformed input.                                | P1       |

### 5.2 Claude App Command Stubs

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-806 | The system SHALL create 10 command definition files in `commands/`: `autonomous-dev-submit.md`, `autonomous-dev-status.md`, `autonomous-dev-list.md`, `autonomous-dev-cancel.md`, `autonomous-dev-pause.md`, `autonomous-dev-resume.md`, `autonomous-dev-priority.md`, `autonomous-dev-logs.md`, `autonomous-dev-feedback.md`, `autonomous-dev-kill.md`. | P0       |
| FR-807 | Each command stub SHALL proxy to the TypeScript router by invoking a Node.js subprocess that calls `intake/adapters/claude_command_bridge.ts` with the raw user arguments.                                       | P0       |
| FR-808 | Command stubs SHALL preserve argument validation, help text, and error formatting from the TypeScript implementation while integrating with Claude Code's command discovery system.                              | P1       |
| FR-809 | The command bridge SHALL handle TypeScript compilation and execution errors gracefully, displaying installation guidance when the intake layer is not built or dependencies are missing.                         | P1       |

### 5.3 Discord Bot Service

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-810 | The system SHALL provide `intake/adapters/discord/main.ts` that initializes the Discord client, registers slash commands, and connects the interaction handler to the intake router.                             | P1       |
| FR-811 | Discord service SHALL read configuration from `intake.discord.token`, `intake.discord.application_id`, and `intake.discord.guild_id` with validation and clear error messages for missing or invalid tokens.    | P1       |
| FR-812 | Discord service SHALL implement graceful shutdown: on SIGTERM/SIGINT, complete in-flight interactions within 5 seconds, then disconnect from Discord Gateway and exit cleanly.                                  | P1       |
| FR-813 | Discord service SHALL log structured events (startup, command registration, user interactions, errors, shutdown) with request IDs and user identifiers for audit trails.                                        | P1       |
| FR-814 | Discord service SHALL implement connection recovery: if the gateway connection drops, retry with exponential backoff (1s, 2s, 4s, 8s, max 60s) up to 10 attempts before failing.                                | P2       |

### 5.4 Slack App Service

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-815 | The system SHALL provide `intake/adapters/slack/main.ts` that initializes either HTTP receiver mode or Socket Mode based on configuration and connects slash command handlers to the intake router.              | P2       |
| FR-816 | Slack service SHALL read configuration from `intake.slack.token`, `intake.slack.signing_secret`, `intake.slack.socket_mode`, and `intake.slack.port` with validation for token format and port availability.     | P2       |
| FR-817 | Slack HTTP mode SHALL bind to the configured port, verify request signatures using the signing secret, and respond to Slack interactions within 3 seconds to avoid timeout.                                      | P2       |
| FR-818 | Slack service SHALL implement graceful shutdown: drain active HTTP requests, close Socket Mode connections, and exit within 10 seconds of receiving shutdown signals.                                             | P2       |
| FR-819 | Slack service SHALL implement request signature verification to prevent webhook forgery and replay attacks, logging failed verification attempts with source IP for security monitoring.                         | P2       |

### 5.5 Shared Intake Router Contract

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-820 | All channel adapters SHALL use the same `IntakeRouter.route()` interface. Commands the router MUST support: `submit`, `status`, `list`, `cancel`, `pause`, `resume`, `priority`, `logs`, `feedback`, `kill`, and the gate-action commands `approve`, `request-changes`, `reject` (for use by PRD-009's portal and future approval clients). | P0       |
| FR-821 | The router SHALL accept `source` metadata in `IncomingCommand` to identify the originating channel for audit logging and channel-specific rate limiting (see §10.1 for the canonical enum).                       | P0       |
| FR-822 | The router SHALL return standardized `CommandResult` objects with success/error status, message text, and structured data that each adapter can format for its channel's UI conventions. Channel-specific rich content (Discord embeds, Slack blocks) SHALL be constructed by the adapter from the structured data, not carried through the router payload. | P0       |
| FR-823 | The router SHALL implement adapter-agnostic authorization checks using user identities resolved by each channel's identity resolver before applying business logic.                                                | P1       |
| FR-823a | The router SHALL reject any `IncomingCommand` whose declared `source` does not match the adapter's registered channel identity (server-side assertion, not client-trusted).                                       | P0       |

### 5.6 Intake → State.json Handoff

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-824 | **Request ID validation (pre-write).** Before constructing any state.json path, the submit handler SHALL validate the generated request ID against `^REQ-\d{6}$`. The target path SHALL be built via a path resolver that asserts the resolved absolute path stays within `<repo>/.autonomous-dev/requests/`. Any deviation (path traversal, symlink escape) SHALL cause the submission to fail before any filesystem write. | P0       |
| FR-824a | **Write ordering and atomicity.** The handoff SHALL follow a two-phase commit: (1) write `state.json.tmp.<pid>.<random>` inside the target request directory with the serialized state, (2) open a SQLite transaction and insert the request row, (3) on SQLite commit, atomically `rename()` the temp file to `state.json`, (4) on SQLite rollback, `unlink()` the temp file. If the rename fails (disk full, permission denied), the SQLite transaction SHALL be rolled back. This supersedes Open Question 4 from v0.9 drafts. | P0       |
| FR-825 | The state.json file SHALL include all fields required by the daemon: `id`, `status`, `priority`, `created_at`, `title`, `description`, `target_repo`, plus `source` and `adapter_metadata` (see §10).             | P0       |
| FR-826 | State transitions (pause, resume, priority change, cancel) SHALL update SQLite and state.json using the same two-phase pattern: compute the new state, write a temp file, commit SQLite, atomic rename. If SQLite commit fails, the temp file SHALL be removed and the existing state.json SHALL remain unchanged. | P0       |
| FR-827 | The handoff mechanism SHALL handle filesystem errors (disk full, permission denied) gracefully by rolling back SQLite changes and returning clear error messages to the submitter. Errors SHALL NOT leak filesystem paths to untrusted channels (Discord/Slack); only the request ID and a generic error class. | P1       |
| FR-828 | State file writes SHALL use JSON schema validation against the existing `state_v1` schema (see `tests/fixtures/state_v1_intake.json`) to ensure daemon compatibility and prevent malformed files that would cause `select_request()` failures. | P1       |

### 5.7 Source Metadata

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-829 | Request records SHALL include `source: 'cli' | 'claude-app' | 'discord' | 'slack' | 'production-intelligence' | 'portal'` in both SQLite schema and state.json schema for audit trails and debugging. | P0       |
| FR-830 | Each channel adapter SHALL populate channel-specific metadata: Discord channel ID and guild ID, Slack channel ID and team ID, Claude Code session ID, CLI process PID and working directory.                     | P1       |
| FR-831 | Audit logs SHALL record source channel and channel-specific metadata for every request lifecycle event (submit, pause, resume, cancel, priority change) to enable cross-channel request debugging.               | P1       |

### 5.8 Authorization per Channel

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-832 | CLI requests SHALL inherit authorization from the local user account and repository ownership, with no additional authentication required beyond git repo access.                                                | P0       |
| FR-833 | Claude App requests SHALL use Claude Code's built-in authentication and authorization without additional identity verification.                                                                                    | P0       |
| FR-834 | Discord requests SHALL validate user permissions within the configured guild and respect role-based access controls defined in the intake configuration.                                                         | P1       |
| FR-835 | Slack requests SHALL validate workspace membership and enforce user authorization based on Slack user IDs mapped in the intake configuration.                                                                    | P2       |

### 5.9 Rate Limits per Channel

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-836 | CLI requests SHALL have no rate limiting (local user controls their own submission rate; governance cost caps provide the upper bound).                                                                            | P0       |
| FR-837 | Claude App requests SHALL implement per-session rate limiting (5 requests per hour per Claude Code session) to prevent abuse via command palette automation.                                                     | P1       |
| FR-838 | Discord requests SHALL implement per-user rate limiting (3 requests per hour per Discord user ID) and per-guild rate limiting (20 requests per hour per guild) to prevent spam.                                 | P1       |
| FR-839 | Slack requests SHALL implement per-user rate limiting (5 requests per hour per Slack user ID) and per-workspace rate limiting (50 requests per hour per workspace) to accommodate team usage patterns.          | P2       |

## 6. Non-Functional Requirements

### 6.1 Latency Targets

| Metric | Target | Notes |
|--------|---------|-------|
| CLI submit acknowledgment | p50 < 1s, p95 < 3s | Local filesystem write dominates latency |
| Claude App submit acknowledgment | p50 < 2s, p95 < 5s | TypeScript subprocess startup overhead |
| Discord interaction response | p50 < 1s, p95 < 3s | Must respond before Discord 3s timeout |
| Slack interaction response | p50 < 1s, p95 < 2.5s | Must respond before Slack 3s timeout |
| State.json write after SQLite | p50 < 100ms, p95 < 500ms | Atomic file operation on local disk |

### 6.2 Availability

| Service | Target | Failure Mode Handling |
|---------|--------|--------------------|
| CLI availability | 99.9% | Always available unless daemon is down |
| Claude App commands | 99% | Graceful fallback to error message if TypeScript layer unavailable |
| Discord bot uptime | 95% | Retry connection drops; queue messages during outages |
| Slack bot uptime | 95% | HTTP mode more reliable than Socket Mode; prefer HTTP |

### 6.3 Security

| Requirement | Implementation |
|-------------|----------------|
| Bot token rotation | Support configuration reload without service restart |
| Signing secret verification | Cryptographic verification of webhook signatures |
| Prompt injection sanitization | Apply existing sanitization rules from `intake/core/sanitizer.ts` |
| Audit logging | Structured logs with user identity, action, timestamp, result |

### 6.4 Observability

| Component | Logging Requirements |
|-----------|---------------------|
| Request submission | Log: channel, user identity, request ID, success/failure |
| State.json handoff | Log: write success/failure, file path, request ID |
| Channel startup/shutdown | Log: configuration loaded, connections established, errors |
| Rate limit enforcement | Log: rate limit hits, user ID, channel type |

## 7. Architecture

```
┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   CLI Channel   │  │ Claude App       │  │ Discord Bot     │  │ Slack App       │
│                 │  │ Channel          │  │ Channel         │  │ Channel         │
│ bash dispatcher │  │                  │  │                 │  │                 │
│ + Node.js       │  │ .md stubs +      │  │ discord.js +    │  │ @slack/web-api  │
│ subprocess      │  │ TypeScript bridge│  │ slash commands  │  │ + HTTP receiver │
└─────────┬───────┘  └─────────┬────────┘  └────────┬────────┘  └────────┬────────┘
          │                    │                    │                    │
          └────────────────────┼────────────────────┼────────────────────┘
                               │                    │
                     ┌─────────▼────────────────────▼────────────────────┐
                     │              IntakeRouter.route()                 │
                     │  resolve-user -> authorize -> rate-limit -> exec  │
                     └─────────┬───────────────────────────────┬─────────┘
                               │                               │
                     ┌─────────▼─────────┐           ┌─────────▼─────────┐
                     │    SQLite         │           │    state.json     │
                     │    Repository     │           │    Filesystem     │
                     │  (canonical idx)  │           │  (daemon input)   │
                     └───────────────────┘           └─────────┬─────────┘
                                                               │
                                                     ┌─────────▼─────────┐
                                                     │  Daemon Supervisor │
                                                     │  supervisor-loop   │
                                                     │  select_request()  │
                                                     └────────────────────┘
```

### Components

- **CLI Channel**: `bin/autonomous-dev.sh` + `request` subcommands + Node.js TypeScript bridge
- **Claude App Channel**: `commands/*.md` stub files + `claude_command_bridge.ts`
- **Discord Channel**: `intake/adapters/discord/main.ts` + bot token configuration
- **Slack Channel**: `intake/adapters/slack/main.ts` + HTTP/Socket Mode configuration
- **IntakeRouter**: Existing `intake/core/intake_router.ts` (unchanged)
- **SQLite Repository**: Existing `intake/db/repository.ts` + source metadata column
- **State.json Bridge**: New filesystem write logic in submit/status handlers
- **Daemon Supervisor**: Existing `bin/supervisor-loop.sh` (unchanged; consumes state.json via `select_request()` lines 640-722)

## 8. Configuration Additions

### 8.1 New Config Keys

```json
{
  "intake": {
    "channels": {
      "cli": {
        "enabled": true
      },
      "claude_app": {
        "enabled": true
      },
      "discord": {
        "enabled": false,
        "token_env": "DISCORD_BOT_TOKEN",
        "application_id_env": "DISCORD_APPLICATION_ID",
        "guild_id_env": "DISCORD_GUILD_ID"
      },
      "slack": {
        "enabled": false,
        "token_env": "SLACK_BOT_TOKEN",
        "signing_secret_env": "SLACK_SIGNING_SECRET",
        "socket_mode": false,
        "port": 3000
      }
    },
    "rate_limits": {
      "claude_app": { "per_session_per_hour": 5 },
      "discord": { "per_user_per_hour": 3, "per_guild_per_hour": 20 },
      "slack": { "per_user_per_hour": 5, "per_workspace_per_hour": 50 }
    }
  }
}
```

### 8.2 Secret Handling

All bot tokens and signing secrets SHALL be referenced via environment variables, not stored in plaintext configuration files. The config loader SHALL validate environment variable references and provide clear error messages for missing secrets. Secrets SHALL NOT appear in `autonomous-dev config show` output (redact to last-4 characters).

## 9. Dependency Additions

### 9.1 Package.json Additions

```json
{
  "dependencies": {
    "discord.js": "^14.14.0",
    "better-sqlite3": "^9.4.0",
    "@slack/web-api": "^7.0.0",
    "@slack/socket-mode": "^2.0.0",
    "express": "^4.21.0"
  }
}
```

### 9.2 Runtime Requirements

- **Node.js**: Minimum version 18.0.0 for ESM support and crypto.webcrypto API
- **SQLite**: System SQLite library required for better-sqlite3 native compilation
- **TypeScript**: Development dependency; production uses compiled JavaScript
- **Runtime target**: Node.js is the primary target for the intake server. Bun compatibility is documented but not required for PRD-008.

## 10. Data Model

### 10.1 Request Source Enum

```typescript
export type RequestSource =
  | 'cli'
  | 'claude-app'
  | 'discord'
  | 'slack'
  | 'production-intelligence'
  | 'portal';
```

**Source tagging policy:**
- `cli`, `claude-app`, `discord`, `slack` — the submitting channel of a new request (via the `submit` command).
- `production-intelligence` — observations converted to PRDs via the PRD-005 pipeline.
- `portal` — intake router calls *originated by PRD-009's web portal*. These are almost always gate-action commands (`approve`, `request-changes`, `reject`) rather than `submit`, but a portal-initiated `submit` is allowed for operators who prefer form-based entry. This reconciles with PRD-009 NG-05: the portal does not write to state.json directly; it calls the intake router, which writes state.json on its behalf. The `source` value records the ultimate caller for audit attribution.
- The `source` value SHALL be populated server-side at the adapter layer (CLI process, Claude App bridge, Discord/Slack adapter, portal handler). Adapters SHALL reject any client-provided `source` value that does not match the adapter's channel identity (see FR-823a).

### 10.2 State.json Schema Additions

```json
{
  "id": "REQ-000042",
  "status": "intake",
  "priority": 1,
  "created_at": "2026-04-17T10:30:00Z",
  "title": "Build OAuth2 middleware",
  "description": "Add OAuth2 authentication...",
  "target_repo": "/path/to/repo",
  "source": "discord",
  "adapter_metadata": {
    "discord_guild_id": "123456789",
    "discord_channel_id": "987654321",
    "discord_user_id": "456789123"
  }
}
```

### 10.3 SQLite Schema Additions

```sql
ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'cli';
ALTER TABLE requests ADD COLUMN adapter_metadata TEXT; -- JSON blob
CREATE INDEX idx_requests_source ON requests(source);
```

## 11. Assist Plugin Updates

### 11.1 New Skills

| Skill Name | Coverage |
|------------|----------|
| `discord-bot-setup` | Discord developer portal setup, bot creation, token generation, guild permissions, slash command registration, Ed25519 interaction signature verification troubleshooting |
| `slack-app-setup` | Slack app creation, OAuth scopes, signing secret rotation, Socket Mode vs HTTP receiver decision, bot token installation, app manifest deployment |
| `cli-request-submit` | All 11 CLI subcommands, argument validation rules, priority/deadline semantics, exit codes, `NO_COLOR` and piping behavior, interactive vs scripted usage |
| `claude-app-commands` | The 10 `/autonomous-dev:*` slash commands (submit/status/list/cancel/pause/resume/priority/logs/feedback/kill), the command-bridge subprocess model (FR-807), discovery troubleshooting when commands don't appear, bridge-not-built errors |
| `intake-handoff-debug` | State.json/SQLite divergence detection and repair, orphaned temp files from FR-824a failures, how `select_request()` consumes state.json (cross-reference `supervisor-loop.sh` lines 640–722), how to reconstruct state.json from SQLite if lost |

### 11.2 New Evaluation Suites

| Suite Name | Case Count | Focus Areas |
|------------|------------|-------------|
| `discord-intake` | 15 cases | Bot setup (5), config/secrets (3), runtime/connection (4), rate-limit/authz (3) |
| `slack-intake` | 15 cases | App manifest & OAuth (5), signature verification (3), Socket Mode vs HTTP (4), rate-limit/authz (3) |
| `cli-intake` | 20 cases | Happy path per subcommand (11), arg validation (4), bridge errors (3), NO_COLOR/TTY handling (2) |
| `intake-handoff` | 10 cases | Chaos scenarios from §12.4, dual-write failure modes, state.json/SQLite drift diagnosis |

### 11.3 Existing Skill Updates

- **setup-wizard** — Coordinate with PRD-009 on the unified phase sequence (see §13.4). Net additions for PRD-008 scope: Phase 7 "Submit your first request" now executes real CLI `autonomous-dev request submit` and verifies `.autonomous-dev/requests/<id>/state.json` exists; Phase 8 "Enable chat channels (optional)" walks through Discord/Slack env var setup and toggles `intake.channels.<name>.enabled`.
- **help** — Add Q&A for: the 11 CLI subcommands, the 10 `/autonomous-dev:*` commands, how to choose a channel, the `source` enum and what each value means, how rate limits compose across channels.
- **troubleshoot** — Add scenarios: Discord bot appears offline (token invalid, intent not granted), Slack signature verification failing (clock skew, wrong secret), Socket Mode socket closed (token scopes), CLI `autonomous-dev request submit` hangs (bridge not built: `npm install` never ran), state.json exists but daemon doesn't pick it up (schema mismatch; run validator), SQLite commit succeeded but state.json missing (temp file left — cleanup procedure).
- **config-guide** — Document every new key: `intake.channels.{cli,claude_app,discord,slack}.enabled`, `intake.channels.discord.{token_env,application_id_env,guild_id_env}`, `intake.channels.slack.{token_env,signing_secret_env,socket_mode,port}`, `intake.rate_limits.*`. Include env-var references for all secrets and a redaction example of `autonomous-dev config show` output.

### 11.4 Migration note for existing operators

Operators who ran the previous `setup-wizard` before PRD-008 shipped have a daemon but no working intake. After upgrade, they SHOULD re-run `/autonomous-dev-assist:setup-wizard` so Phase 7 verifies a real submit end-to-end. The wizard SHALL detect prior-configured state (daemon running, config present) and skip re-configuration, jumping to the new phases.

## 12. Testing Strategy

### 12.1 Unit Testing

Existing unit test coverage SHALL remain intact. New unit tests required for:
- CLI argument parsing and validation
- Claude App command bridge error handling
- Discord/Slack service initialization and shutdown
- State.json write atomicity and schema validation
- State.json → SQLite consistency on every mutation handler

### 12.2 Integration Testing

Existing integration test suites SHALL remain intact. New integration tests required for:
- Each channel adapter integrated with IntakeRouter
- SQLite + state.json write consistency under concurrent mutation
- Rate limiting enforcement across channels
- Authorization mapping from channel identities to internal permissions

### 12.3 End-to-End Testing

| Test Scenario | Verification |
|---------------|--------------|
| CLI submit → state.json → daemon pickup | Full pipeline from bash command to daemon `select_request()` |
| Claude App submit → TypeScript bridge → SQLite + state.json | Command stub execution through to file write |
| Discord interaction → router → state file | Mocked Discord gateway through to filesystem |
| Slack command → signature verification → success | HTTP request verification through to success response |

### 12.4 Chaos Testing

| Scenario | Expected Behavior |
|----------|-------------------|
| Kill bot mid-interaction | State.json still written if SQLite commit succeeded; user gets error message |
| SQLite lock conflict | Graceful backoff and retry; user notified of delay |
| Filesystem permission denied | SQLite rollback; clear error message to user |
| Discord gateway disconnect | Auto-reconnection; queued interactions processed after recovery |
| Daemon reading state.json while intake writing | Write-then-rename ensures atomic visibility; no torn reads |

### 12.5 Migration Testing

Existing state.json files from the fixture set (`tests/fixtures/state_v1_*.json`) SHALL continue to validate without schema-level changes beyond the new optional `source` and `adapter_metadata` fields.

### 12.6 Load Testing

Queue fairness at depth 50 (per PRD-006 FR-303): submit 100 requests across 4 channels under rate-limit headroom (disable limits or use elevated test limits), verify no channel is starved, verify FIFO-with-priority ordering holds, target error rate <1%.

### 12.7 Rate-Limit Boundary Testing

Separate from load testing: send exactly `N+1` requests per channel where `N` is the rate limit, verify the `N+1`th request is rejected with a standardized rate-limit error and not silently dropped. Cover per-user and per-guild/per-workspace limits from §5.9.

### 12.8 Assist Eval Regression Gate

Before every release of this plugin, the `autonomous-dev-assist` eval suites SHALL run and pass at ≥80% overall and ≥60% per case (matching the existing harness thresholds in `plugins/autonomous-dev-assist/evals/eval-config.yaml`). The new suites from §11.2 SHALL be included. A release is blocked if any suite regresses more than 5 percentage points from the previous tagged release.

## 13. Migration & Rollout

### 13.1 Rollout Phases

| Phase | Scope | Acceptance Criteria |
|-------|-------|-------------------|
| Phase 1: CLI | CLI dispatcher + TypeScript bridge + state.json bridge | End-to-end CLI submit working; chaos test passes |
| Phase 2: Claude App | Command stubs + bridge | All 10 commands discoverable in Claude Code and functional |
| Phase 3: Discord | Bot service + configuration + identity mapping | Discord slash commands working in test guild |
| Phase 4: Slack | App service + verification + identity mapping | Slack slash commands working in test workspace |

Each phase SHALL ship behind its channel's `enabled: true/false` config flag so operators can disable the channel if issues arise.

### 13.2 Rollback Plan

If any phase introduces regressions:
1. Flip `intake.channels.<channel>.enabled = false` in the operator's config
2. Existing channels continue operating normally
3. Fix issues in isolation without affecting other channels
4. Re-enable after verification

### 13.3 PRD-006 Revision

Upon PRD-008 approval, PRD-006 will be updated with a revision note: "Phase 1 now includes Claude App + CLI. Phases 2-3 (Discord, Slack) implementation shipped via PRD-008."

### 13.4 Setup-Wizard Phase Coordination with PRD-009

PRD-008 and PRD-009 both modify the `setup-wizard` skill in `autonomous-dev-assist`. To avoid conflicting edits, the combined phase sequence SHALL be:

| Phase | Topic | Owning PRD |
|-------|-------|-----------|
| 1 | Prerequisites | existing |
| 2 | Plugin installation | existing |
| 3 | Configuration | existing |
| 4 | Trust level | existing |
| 5 | Cost budget | existing |
| 6 | Daemon install + start | existing |
| 7 | Submit first request (CLI) | PRD-008 |
| 8 | Enable chat channels (Discord/Slack) | PRD-008 |
| 9 | Notifications | existing (was Phase 8) |
| 10 | Production intelligence | existing (was Phase 9) |
| 11 | Web portal install (optional) | PRD-009 |
| 12 | Verification & summary | existing (was Phase 10) |

Both PRDs' assist sections reference this table as the canonical sequence.

## 14. Security Considerations

### 14.1 Token Management

- Bot tokens and signing secrets SHALL be stored in environment variables, never in configuration files
- Token rotation SHALL be supported via configuration reload without service restart
- Failed authentication attempts SHALL be logged with source IP for security monitoring
- Secrets SHALL be redacted in `autonomous-dev config show` output (last-4 display)

### 14.2 Input Validation

- All channel adapters SHALL apply the existing prompt injection sanitizer from `intake/core/sanitizer.ts`
- Request ID validation SHALL prevent path traversal attacks on state.json file paths
- Slack signature verification SHALL prevent webhook forgery and replay attacks
- Discord interaction signature verification SHALL use Discord's Ed25519 public-key validation

### 14.3 Authorization Boundaries

- Each channel SHALL enforce its own identity resolution and authorization mapping
- Cross-channel authorization escalation SHALL be prevented by isolating channel-specific permissions
- Emergency kill switches SHALL be available to any authorized user regardless of channel

## 15. Observability

### 15.1 Per-Channel Metrics

- Submissions per minute per channel
- Error rates per channel (4xx user errors, 5xx system errors)
- Response latency distribution (p50, p95, p99) per channel
- Rate limit enforcement events per channel

### 15.2 Log Schema

```json
{
  "timestamp": "2026-04-17T10:30:00Z",
  "level": "info",
  "component": "discord-adapter",
  "event": "request-submitted",
  "request_id": "REQ-000042",
  "user_id": "discord:456789123",
  "channel": "discord",
  "guild_id": "123456789",
  "success": true,
  "latency_ms": 150
}
```

### 15.3 Alerting Integration

The notification engine SHALL integrate with the autonomous-dev monitoring system to alert operators when:
- Any channel goes offline for >5 minutes
- Error rates exceed 10% for >1 minute
- State.json write failures exceed 1% for >1 minute
- Rate limit enforcement triggers indicate potential abuse

## 16. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Discord bot token leaked** | High | Token rotation capability; audit logging; scope limitations |
| **Slack workspace compromise** | High | Signature verification; minimal OAuth scopes; workspace isolation |
| **State.json write races with daemon read** | Medium | Atomic write-then-rename; JSON schema validation |
| **TypeScript bridge failures break all channels** | Medium | Channel-specific error isolation; fallback error responses |
| **SQLite database corruption** | Medium | Regular backups; corruption detection; rebuild from audit logs |
| **Duplicate detection fires for legitimate re-submits** | Medium | Threshold tunable per-channel; operator can override with `--force` flag |
| **Channel adapter resource leaks** | Low | Graceful shutdown procedures; connection pooling; health checks |
| **State.json and SQLite drift** | Medium | Every mutation updates both in a transactional manner; periodic reconciliation check |

## 17. Success Metrics

| Metric | Target | Timeframe |
|--------|--------|-----------|
| p95 submit acknowledgment latency | <3 seconds across all channels | Week 1 |
| End-to-end submit → intake phase completion | <30 seconds median | Week 2 |
| Zero data-loss incidents | 0 requests lost in intake → daemon handoff | First 30 days |
| Multi-channel availability | 3 channels operational (CLI + Claude App + 1 chat) | Week 2 |
| CLI adoption rate | >20% of submissions via CLI, measured on weeks with ≥20 total submissions (else metric is deferred) | Week 4 onward |
| Cross-channel consistency | Identical behavior for same commands across channels | Week 1 |
| Assist eval regression | All suites ≥80% pass rate post-release, no suite down >5pp vs. previous release | Every release |

## 18. Open Questions

1. **Discord guild permission model**: Should the bot auto-register slash commands in all guilds it joins, or require explicit guild configuration per autonomous-dev deployment?

2. **Slack app distribution**: Should we provide a public Slack app manifest for teams to install, or require each deployment to create its own Slack app?

3. **CLI authentication for shared systems**: When multiple users share a development machine, should CLI commands respect git config user identity, or use system account?

4. **Channel-specific configuration inheritance**: Should Discord/Slack channels inherit global rate limits and authorization settings, or maintain completely separate configuration spaces?

**Resolved during PRD review:**
- ~~Write ordering of state.json vs. SQLite~~ — Resolved in FR-824a: temp file write → SQLite transaction → atomic rename on commit; unlink temp on rollback.

## 19. References

- [PRD-001: System Core & Daemon Engine](./PRD-001-system-core.md) — Request ID format, state.json schema, daemon supervision
- [PRD-002: Document Pipeline](./PRD-002-document-pipeline.md) — Pipeline phase definitions and status transitions
- [PRD-006: Intake & Communication Layer](./PRD-006-intake-communication.md) — Command vocabulary, authorization model, communication protocols. PRD-008 is the implementation vehicle for PRD-006 Phases 1-3 plus adds CLI as a first-class channel.
- [PRD-007: Escalation & Trust Framework](./PRD-007-escalation-trust.md) — Trust level integration, escalation routing
- [PRD-009: Web Control Plane](./PRD-009-web-control-plane.md) — The web portal as a fifth surface; reads state.json files written by this PRD's handoff mechanism.
