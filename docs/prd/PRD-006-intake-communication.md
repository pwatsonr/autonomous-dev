# PRD-006: Intake & Communication Layer

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **Title**   | Intake & Communication Layer               |
| **PRD ID**  | PRD-006                                    |
| **Version** | 1.0                                        |
| **Date**    | 2026-04-08                                 |
| **Author**  | Patrick Watson                             |
| **Status**  | Draft                                      |
| **Plugin**  | autonomous-dev                             |

---

## 1. Problem Statement

The autonomous-dev system needs a well-defined boundary between humans and the pipeline. Today there is no mechanism for product requests to enter the system, no way for the system to communicate status or escalate blockers, and no protocol for humans to intervene in a running pipeline. Without this layer, the pipeline is a closed loop that cannot receive work or report on it.

Intake channels must span the environments where our users already work -- Claude Code itself, Discord, and Slack -- so adoption requires zero context-switching. The communication must be bidirectional: humans push requests in and pull status out, but the system also pushes notifications, asks clarifying questions, and escalates review gates. Every interaction must be authenticated, authorized, and safe from prompt injection.

### Why iMessage Is Excluded

The architectural review evaluated iMessage as an intake channel. It is excluded for the following reasons:

- **No public API.** Apple does not provide a sanctioned messaging API for third-party automation.
- **Fragile workarounds.** Existing approaches (AppleScript bridges, Shortcuts automations) break across macOS versions and cannot be tested in CI.
- **Platform lock-in.** iMessage is unavailable on Linux and Windows, which are target deployment environments for the pipeline daemon.
- **Security surface.** Unofficial bridges require full disk access and bypass sandboxing, creating unacceptable risk for a system that executes arbitrary code.

Discord, Slack, and the native Claude App provide stable, documented APIs and cover the same user base.

---

## 2. Goals

| ID   | Goal                                                                                           |
|------|------------------------------------------------------------------------------------------------|
| G-01 | Provide a unified intake interface that accepts product requests from Claude App, Discord, and Slack with a consistent command vocabulary. |
| G-02 | Parse natural-language requests into structured intake records, detecting ambiguity and duplicates before pipeline entry. |
| G-03 | Manage a priority-based request queue with depth limits, visibility, and starvation prevention. |
| G-04 | Deliver proactive, channel-appropriate status notifications at every phase transition and on escalation. |
| G-05 | Enable bidirectional mid-pipeline communication so humans can provide feedback, answer questions, and supply context. |
| G-06 | Enforce role-based authorization per channel and per repository.                                |
| G-07 | Protect the pipeline from prompt injection, abuse, and denial-of-service via intake validation and rate limiting. |

## 3. Non-Goals

| ID    | Non-Goal                                                                                     |
|-------|----------------------------------------------------------------------------------------------|
| NG-01 | Building a web dashboard or GUI. Status is consumed through existing chat interfaces and CLI. |
| NG-02 | Supporting email as an intake channel. Email parsing is unbounded in format and out of scope for Phase 1-3. |
| NG-03 | Replacing Jira or Linear. The intake layer feeds the autonomous pipeline; it is not a project management tool. |
| NG-04 | Supporting iMessage (see rationale above).                                                    |
| NG-05 | Multi-tenant SaaS deployment. This system runs on a single operator's infrastructure.         |
| NG-06 | Voice-based intake (Alexa, Siri, etc.).                                                       |

---

## 4. User Stories

### Submitting Requests

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-01 | As a product manager, I want to type `/autonomous-dev:submit "Build a user auth system with OAuth2 and MFA"` in Claude Code so that the pipeline starts working on it without me opening another tool. | P0       |
| US-02 | As a team lead, I want to submit a request in our Discord server via `/submit Build a rate-limiting middleware` so that the pipeline picks it up from the channel my team already uses. | P1       |
| US-03 | As a developer, I want to submit a request in Slack via `/submit Add pagination to the /users endpoint` so that I don't leave my Slack workspace. | P2       |
| US-04 | As a requester, I want the system to ask me clarifying questions when my request is too vague, so that the generated PRD is accurate and complete. | P0       |
| US-05 | As a requester, I want the system to warn me if a similar request is already in the pipeline, so that I avoid duplicate work. | P1       |

### Monitoring & Status

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-06 | As a requester, I want to run `/status REQ-042` to see the current phase, progress percentage, and any blockers, so that I know where my request stands. | P0       |
| US-07 | As a team lead, I want to run `/list` to see all active requests with their states and priorities, so that I have a portfolio view. | P0       |
| US-08 | As a requester, I want to receive a notification when my request transitions between pipeline phases (e.g., PRD approved, TDD in review), so that I stay informed without polling. | P0       |
| US-09 | As an operator, I want to configure notification verbosity per request (silent, summary, verbose, debug), so that high-priority requests get detailed updates while routine ones stay quiet. | P1       |
| US-10 | As a team lead, I want a daily digest summarizing all active requests, their states, and any blockers, delivered to a designated channel at a configured time. | P1       |

### Lifecycle Management

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-11 | As a requester, I want to cancel my request via `/cancel REQ-042`, and have the system clean up any branches, worktrees, and draft PRs it created. | P0       |
| US-12 | As a requester, I want to pause my request via `/pause REQ-042` so that the pipeline finishes the current phase and then stops, preserving all progress. | P0       |
| US-13 | As a requester, I want to resume a paused request via `/resume REQ-042` so that it picks up exactly where it left off. | P0       |
| US-14 | As a requester, I want to change the priority of my request via `/priority REQ-042 high` so that urgent work jumps the queue. | P1       |
| US-15 | As an operator, I want a kill switch (`/kill`) that immediately stops ALL running requests in case of a runaway pipeline or security incident. | P0       |

### Authorization & Security

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-16 | As an operator, I want to configure which users can submit requests, which can approve at review gates, and which have read-only access, so that access is controlled. | P0       |
| US-17 | As an operator, I want per-repository authorization so that user X can submit requests targeting repo A but not repo B. | P1       |
| US-18 | As an operator, I want rate limiting per user (e.g., max 5 requests per hour) so that one user cannot flood the queue and starve others. | P1       |

### Bidirectional Communication

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-19 | As a requester, I want to send additional context or feedback to my in-progress request so that the pipeline can incorporate new information mid-flight. | P1       |
| US-20 | As a requester, I want the system to notify me when it needs my input (e.g., a clarifying question or a review approval), with a configurable timeout after which it either pauses or takes a default action. | P0       |

---

## 5. Functional Requirements

### 5.1 Intake Channels

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-01  | The system SHALL accept requests via the Claude App native interface using the command `/autonomous-dev:submit [description]`.                                                                                       | P0       |
| FR-02  | The system SHALL accept requests via a Discord bot using slash commands registered in a configured Discord server.                                                                                                    | P1       |
| FR-03  | The system SHALL accept requests via a Slack bot using slash commands registered in a configured Slack workspace.                                                                                                     | P2       |
| FR-04  | All three channels SHALL expose a consistent command vocabulary: `/submit`, `/status`, `/list`, `/cancel`, `/pause`, `/resume`, `/priority`, `/logs`, `/kill`.                                                       | P0       |
| FR-05  | Each channel SHALL authenticate the requester using the channel's native identity (Claude Code user, Discord user ID, Slack user ID) and map it to an internal identity.                                              | P0       |
| FR-06  | Channel adapters SHALL be implemented behind a common `IntakeAdapter` interface so that new channels can be added without modifying core logic.                                                                       | P1       |

### 5.2 Request Parsing & Enrichment

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-07  | The system SHALL parse natural-language request descriptions into a structured intake record containing: `title`, `description`, `priority` (high/normal/low, default: normal), and `target_repo`.                    | P0       |
| FR-08  | The system SHALL support optional fields: `deadline`, `related_tickets` (Jira/GitHub issue URLs), `technical_constraints`, and `acceptance_criteria`.                                                                 | P1       |
| FR-09  | The system SHALL perform ambiguity detection on the parsed request. If the request lacks a clear deliverable, target repo, or is fewer than 15 words with no technical specificity, the system SHALL ask up to 3 clarifying questions before creating the pipeline entry. | P0       |
| FR-10  | The system SHALL perform duplicate detection by comparing the new request's title and description against all active and recently completed (last 30 days) requests using semantic similarity (cosine similarity > 0.85 threshold). If a potential duplicate is found, the system SHALL warn the requester and require explicit confirmation before proceeding. | P1       |
| FR-11  | The system SHALL sanitize request descriptions to prevent prompt injection. Sanitization SHALL include: stripping system-prompt-style directives (e.g., "ignore previous instructions"), escaping template delimiters, and flagging requests that contain known injection patterns for human review before pipeline entry. | P0       |
| FR-12  | The system SHALL assign a unique request ID in the format `REQ-NNNNNN` (zero-padded, monotonically increasing) to each accepted request.                                                                            | P0       |

### 5.3 Request Queue Management

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-13  | The system SHALL maintain three priority queues: `high`, `normal`, and `low`. Requests SHALL be dequeued in priority order, and FIFO within the same priority level.                                                  | P0       |
| FR-14  | The system SHALL expose queue depth and estimated wait time per priority level via the `/list` command.                                                                                                               | P0       |
| FR-15  | The system SHALL enforce a configurable maximum queue depth (default: 50 requests). When the queue is full, new submissions SHALL be rejected with a clear message indicating the queue is at capacity.                | P1       |
| FR-16  | The system SHALL implement starvation prevention: if a low-priority request has been queued for longer than a configurable threshold (default: 48 hours), it SHALL be automatically promoted to the next higher priority level. The same rule applies to normal-priority requests. | P1       |
| FR-17  | The system SHALL persist the queue to durable storage (local SQLite database) so that queue state survives daemon restarts.                                                                                           | P0       |

### 5.4 Status Communication

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-18  | The system SHALL send proactive notifications when a request transitions between pipeline phases: Queued, PRD Generation, PRD Review, TDD Generation, TDD Review, Planning, Spec, Execution, Code Review, Merged, and Done. | P0       |
| FR-19  | The system SHALL support four verbosity levels per request: `silent` (no notifications), `summary` (phase transitions only), `verbose` (phase transitions + sub-step progress), `debug` (everything including agent reasoning traces). Default: `summary`. | P1       |
| FR-20  | The system SHALL format notifications appropriately for each channel: Discord rich embeds with color-coded status, Slack Block Kit messages with sections and actions, and plain text with ANSI color codes for CLI.   | P1       |
| FR-21  | The system SHALL support notification routing: a request's notifications can be directed to a specific channel, thread, or DM independent of the submission channel. Configured at submission time or via `/status` update. | P1       |
| FR-22  | The system SHALL generate and deliver a daily digest at a configurable time (default: 09:00 local) to a configurable channel. The digest SHALL include: count of active requests by state, count of blocked requests with blocker descriptions, requests completed in the last 24 hours, and current queue depth. | P1       |
| FR-23  | The system SHALL include a direct link to the relevant PR, branch, or artifact in every phase-transition notification where applicable.                                                                               | P1       |

### 5.5 Bidirectional Communication

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-24  | The system SHALL allow the requester to send feedback or additional context to an active request by replying in the request's notification thread (Discord/Slack) or via `/feedback REQ-NNNNNN [message]`.             | P1       |
| FR-25  | When the system needs human input (clarifying question, review approval, escalation), it SHALL send a structured prompt to the requester or designated reviewer and wait for a response.                               | P0       |
| FR-26  | The system SHALL enforce a configurable response timeout (default: 4 hours) for human input requests. When the timeout expires, the system SHALL take one of three configurable actions: `pause` (pause the request and notify), `default` (proceed with a conservative default and note the assumption), or `escalate` (notify the next person in the escalation chain). Default action: `pause`. | P0       |
| FR-27  | The system SHALL maintain a conversation history per request, preserving all human-system exchanges so that context is not lost across interactions.                                                                   | P1       |
| FR-28  | Clarifying question exchanges SHALL be limited to a maximum of 5 rounds. If ambiguity is not resolved after 5 rounds, the system SHALL escalate to a human operator with the full conversation history.                | P1       |

### 5.6 Authorization & Access Control

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-29  | The system SHALL enforce role-based access control with four roles: `admin` (full system control including `/kill`, configuration changes, and all request operations), `operator` (manage all requests, approve reviews, view logs), `contributor` (submit requests, manage own requests, view all request statuses), `viewer` (read-only access to request statuses and logs). | P0       |
| FR-30  | The system SHALL support per-repository authorization: each user's role can be scoped to specific repositories. A user may be a `contributor` for `repo-a` and a `viewer` for `repo-b`.                               | P1       |
| FR-31  | Only the request author, users with `operator` role, and users with `admin` role SHALL be permitted to cancel, pause, or resume a request.                                                                           | P0       |
| FR-32  | Review gate approvals SHALL be restricted to users explicitly configured as reviewers for that gate, or users with `operator` or `admin` roles.                                                                       | P0       |
| FR-33  | Authorization configuration SHALL be stored in a YAML file (`intake-auth.yaml`) at the plugin configuration root, supporting hot-reload without daemon restart.                                                       | P1       |
| FR-34  | The system SHALL log all authorization decisions (grants and denials) to an audit log for security review.                                                                                                            | P1       |

### 5.7 Request Lifecycle Commands

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-35  | `/submit [description]` SHALL create a new request, run it through parsing and enrichment (FR-07 through FR-12), assign a request ID, enqueue it, and return the request ID and queue position to the requester.      | P0       |
| FR-36  | `/status [request-id]` SHALL return: request title, current pipeline phase, phase progress (percentage or step N of M), time in current phase, overall elapsed time, current blocker (if any), and links to generated artifacts (PRD PR, TDD PR, code PR). | P0       |
| FR-37  | `/list` SHALL return all active requests in a table format showing: request ID, title (truncated to 50 chars), priority, current phase, requester, and age. Sorted by priority descending, then age descending.       | P0       |
| FR-38  | `/cancel [request-id]` SHALL stop all pipeline activity for the request, delete associated worktrees, close draft PRs, delete feature branches (with confirmation prompt before destructive operations), and mark the request as cancelled. | P0       |
| FR-39  | `/pause [request-id]` SHALL allow the current pipeline phase to complete, then halt the pipeline. The request state SHALL be persisted so that `/resume` can pick up at the next phase boundary.                       | P0       |
| FR-40  | `/resume [request-id]` SHALL restart a paused request from the phase boundary where it was paused. If the request was paused mid-clarification, it SHALL re-prompt for the pending question.                          | P0       |
| FR-41  | `/priority [request-id] [high|normal|low]` SHALL update the request's priority and reposition it in the queue. The requester SHALL be notified of the new queue position.                                             | P1       |
| FR-42  | `/logs [request-id]` SHALL return the last 50 activity log entries for the request, including timestamps, phase, and event descriptions. An optional `--all` flag SHALL return the complete log.                       | P1       |
| FR-43  | `/kill` SHALL immediately terminate ALL running pipeline processes, pause all active requests, and send a notification to all admins. This command SHALL require `admin` role and a confirmation prompt ("Type CONFIRM to kill all requests"). | P0       |

### 5.8 Rate Limiting & Abuse Prevention

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-44  | The system SHALL enforce per-user rate limits on request submission. Default: 10 requests per rolling 1-hour window. Configurable per role (admins may have higher limits).                                            | P1       |
| FR-45  | The system SHALL enforce per-user rate limits on status/list queries. Default: 60 queries per rolling 1-minute window. Exceeding the limit SHALL return a 429-equivalent response with retry-after information.         | P1       |
| FR-46  | The system SHALL reject requests whose descriptions exceed 10,000 characters with a clear error message.                                                                                                              | P1       |

### 5.9 Offline & Resilience

| ID     | Requirement                                                                                                                                                                                                         | Priority |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-47  | If the Discord or Slack bot is offline when a command is issued, the platform will not deliver the message. The system SHALL document this limitation and recommend that critical submissions be made via the Claude App native interface, which does not depend on an external bot process. | P1       |
| FR-48  | On bot startup, the system SHALL check for any requests in a `waiting_for_human` state and re-send the pending prompt to the appropriate channel.                                                                     | P1       |
| FR-49  | The system SHALL implement exponential backoff with jitter for Discord and Slack API calls to handle rate limiting and transient failures. Maximum retry attempts: 5. Maximum backoff: 60 seconds.                     | P1       |

---

## 6. Non-Functional Requirements

| ID     | Requirement                                                                                                                                     | Priority |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| NFR-01 | Intake command response time SHALL be under 2 seconds (time from command receipt to acknowledgment response) for the 95th percentile.           | P0       |
| NFR-02 | The queue management subsystem SHALL handle at least 100 concurrent active requests without degradation.                                         | P1       |
| NFR-03 | All request data, conversation history, and queue state SHALL be persisted in a local SQLite database with WAL mode enabled for concurrent read access. | P0       |
| NFR-04 | The intake layer SHALL be stateless per channel adapter: all state lives in the shared database, so any adapter instance can serve any request.   | P1       |
| NFR-05 | Notification delivery SHALL be at-least-once. The system SHALL retry failed notification deliveries up to 3 times with exponential backoff.       | P1       |
| NFR-06 | The prompt injection sanitization layer SHALL be updatable without redeploying the full system (externalized rule set in a YAML file).            | P1       |
| NFR-07 | All communication between the intake layer and the pipeline core SHALL use structured events (not string concatenation) to prevent injection at the boundary. | P0       |
| NFR-08 | The system SHALL produce structured logs (JSON) for all intake, authorization, queue, and notification events, suitable for ingestion by a log aggregator. | P1       |
| NFR-09 | The Discord and Slack bots SHALL support graceful shutdown: on SIGTERM, finish processing the current command, persist state, then exit.           | P1       |
| NFR-10 | Mobile UX: All Discord and Slack notifications SHALL render correctly on mobile clients. Rich embeds SHALL degrade gracefully to plain text on clients that do not support them. Notification payloads SHALL not exceed platform-specific size limits (Discord: 6000 chars per embed, Slack: 3000 chars per block). | P1       |

---

## 7. Success Metrics

| Metric                                  | Target                              | Measurement Method                                         |
|-----------------------------------------|-------------------------------------|------------------------------------------------------------|
| Request submission success rate         | >= 99% (excluding auth denials)     | Count of successful submissions / total submission attempts |
| Median time from submission to pipeline start | < 30 seconds for high priority | Timestamp difference: submission time vs. first phase start |
| Ambiguity detection true positive rate  | >= 80%                              | Manual audit of 50 flagged vs. 50 unflagged requests       |
| Duplicate detection precision           | >= 90%                              | Manual review of flagged duplicates over 30-day window      |
| Notification delivery success rate      | >= 99.5%                            | Delivered notifications / attempted notifications           |
| Human response turnaround time          | Median < 1 hour                     | Timestamp difference: prompt sent vs. response received     |
| Prompt injection blocked rate           | 100% of known patterns              | Red team exercise with 50 injection payloads                |
| Command acknowledgment latency (p95)    | < 2 seconds                         | Instrumented timing on adapter response                     |
| Queue starvation incidents              | 0 per month                         | Count of requests that waited > 2x the starvation threshold |
| Daily digest delivery reliability       | 100%                                | Count of missed digests over 30-day window                  |

---

## 8. Risks & Mitigations

| ID   | Risk                                                                                                                     | Likelihood | Impact | Mitigation                                                                                                                                                      |
|------|--------------------------------------------------------------------------------------------------------------------------|------------|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-01 | **Prompt injection via intake.** A malicious request description could embed instructions that hijack PRD generation.     | High       | High   | Multi-layer defense: input sanitization (FR-11), structured event boundary (NFR-07), PRD generation agent operates on a schema-validated intake record not raw text, and red-team testing before launch. |
| R-02 | **Queue flooding / denial of service.** A single user or bot submits hundreds of requests, starving legitimate work.      | Medium     | High   | Per-user rate limiting (FR-44), queue depth cap (FR-15), and the `/kill` emergency stop (FR-43).                                                                 |
| R-03 | **Bot downtime causes missed requests.** If the Discord/Slack bot crashes, commands sent during downtime are lost.        | Medium     | Medium | Document the limitation (FR-47), recommend Claude App for critical submissions, implement health checks and auto-restart via process supervisor (systemd/launchd). |
| R-04 | **Stale clarifying conversations.** A human starts answering clarifying questions but abandons the conversation.           | High       | Medium | Response timeout with configurable action (FR-26), conversation round limit (FR-28), and escalation chain.                                                       |
| R-05 | **Discord/Slack API rate limits.** High notification volume triggers platform rate limits, delaying status updates.        | Medium     | Low    | Exponential backoff (FR-49), notification batching for verbose/debug modes, and respecting platform rate limit headers.                                           |
| R-06 | **Authorization configuration drift.** The `intake-auth.yaml` file becomes stale as team membership changes.              | Medium     | Medium | Hot-reload support (FR-33), audit logging (FR-34), and a monthly authorization review reminder in the daily digest.                                               |
| R-07 | **Semantic similarity false positives in duplicate detection.** Unrelated requests flagged as duplicates due to similar vocabulary. | Medium | Low    | Require explicit confirmation rather than auto-rejecting (FR-10), tunable similarity threshold, and option to bypass with `--force` flag.                         |
| R-08 | **Long conversation threads in Slack/Discord.** Extended clarifying exchanges clutter channels and confuse other users.    | Medium     | Low    | All clarifying conversations happen in a dedicated thread (not the main channel). Thread is auto-archived after request enters the pipeline.                      |
| R-09 | **Mobile notification rendering.** Rich embeds and Block Kit messages may not render well on mobile clients.               | Low        | Low    | Test on iOS and Android clients for both Discord and Slack. Use fallback text fields in all rich formatting (NFR-10).                                             |

---

## 9. Phasing

### Phase 1: Claude App Native (Weeks 1-3)

**Scope:** Core intake and communication through Claude Code only. No external bots.

| Deliverable                                             | Requirements Covered                     |
|---------------------------------------------------------|------------------------------------------|
| `/autonomous-dev:submit` command implementation         | FR-01, FR-07, FR-08, FR-12, FR-35        |
| Request parsing and structured intake record creation   | FR-07, FR-08, FR-09                      |
| Ambiguity detection with clarifying questions           | FR-09, FR-28                             |
| Prompt injection sanitization                           | FR-11                                    |
| SQLite-backed request queue with priority ordering      | FR-13, FR-14, FR-15, FR-17              |
| All lifecycle commands via Claude App                   | FR-35 through FR-43                      |
| CLI-formatted status notifications (plain text + ANSI)  | FR-18, FR-20                             |
| Role-based access control (YAML config)                 | FR-29, FR-30, FR-31, FR-32, FR-33       |
| Response timeout handling                               | FR-26                                    |
| Audit logging                                           | FR-34                                    |
| Rate limiting                                           | FR-44, FR-45, FR-46                      |

**Exit Criteria:** A user can submit a request in Claude Code, watch it flow through the pipeline with status updates, answer clarifying questions, pause/resume/cancel, and see the final result -- all without leaving the terminal.

### Phase 2: Discord Bot (Weeks 4-6)

**Scope:** Discord slash command integration, rich embed formatting, threaded conversations.

| Deliverable                                             | Requirements Covered                     |
|---------------------------------------------------------|------------------------------------------|
| Discord bot registration and slash command setup        | FR-02, FR-04                             |
| Discord user identity mapping                           | FR-05                                    |
| `IntakeAdapter` interface extraction and refactor       | FR-06                                    |
| Discord rich embed notification formatting              | FR-20                                    |
| Threaded clarifying conversations in Discord            | FR-24, FR-25, FR-27                      |
| Notification routing to specific Discord channels/DMs   | FR-21                                    |
| Daily digest delivery to Discord                        | FR-22                                    |
| Duplicate detection (semantic similarity)               | FR-10                                    |
| Starvation prevention                                   | FR-16                                    |
| Bot offline documentation and resilience                | FR-47, FR-48, FR-49                      |

**Exit Criteria:** Full command parity with Phase 1 over Discord. A team can operate entirely from a Discord server with rich status embeds, threaded conversations, and daily digests.

### Phase 3: Slack Bot (Weeks 7-9)

**Scope:** Slack slash command integration, Block Kit formatting, workspace configuration.

| Deliverable                                             | Requirements Covered                     |
|---------------------------------------------------------|------------------------------------------|
| Slack bot registration and slash command setup           | FR-03, FR-04                             |
| Slack user identity mapping                              | FR-05                                    |
| Slack Block Kit notification formatting                  | FR-20                                    |
| Threaded clarifying conversations in Slack               | FR-24, FR-25, FR-27                      |
| Notification routing to specific Slack channels/DMs      | FR-21                                    |
| Daily digest delivery to Slack                           | FR-22                                    |
| Mobile rendering validation (iOS + Android)              | NFR-10                                   |
| Cross-channel notification (submit in Slack, notify in Discord) | FR-21                              |

**Exit Criteria:** Full command parity with Phase 1 and Phase 2 over Slack. A user can submit in any channel and receive notifications in any other channel.

---

## 10. Data Model (Reference)

The following entities are introduced by this layer. Final schema will be defined in the TDD.

### Request

| Field                | Type         | Description                                        |
|----------------------|--------------|----------------------------------------------------|
| `request_id`         | string       | Unique ID, format `REQ-NNNNNN`                     |
| `title`              | string       | Parsed short title                                 |
| `description`        | text         | Full request description (sanitized)               |
| `raw_input`          | text         | Original unsanitized input (for audit)             |
| `priority`           | enum         | `high`, `normal`, `low`                            |
| `target_repo`        | string       | Repository identifier                              |
| `status`             | enum         | `queued`, `active`, `paused`, `cancelled`, `done`  |
| `current_phase`      | string       | Current pipeline phase                             |
| `requester_id`       | string       | Internal user identity                             |
| `source_channel`     | enum         | `claude_app`, `discord`, `slack`                   |
| `notification_config`| json         | Channel, verbosity, routing preferences            |
| `deadline`           | datetime     | Optional deadline                                  |
| `related_tickets`    | string[]     | Optional linked ticket URLs                        |
| `technical_constraints` | text      | Optional constraints                               |
| `acceptance_criteria`| text         | Optional acceptance criteria                       |
| `created_at`         | datetime     | Submission timestamp                               |
| `updated_at`         | datetime     | Last state change timestamp                        |

### ConversationMessage

| Field                | Type         | Description                                        |
|----------------------|--------------|----------------------------------------------------|
| `message_id`         | string       | Unique message ID                                  |
| `request_id`         | string       | Associated request                                 |
| `direction`          | enum         | `inbound` (human to system), `outbound` (system to human) |
| `channel`            | enum         | `claude_app`, `discord`, `slack`                   |
| `content`            | text         | Message content                                    |
| `message_type`       | enum         | `clarifying_question`, `feedback`, `escalation`, `status_update`, `approval_request` |
| `responded`          | boolean      | Whether the message has been answered               |
| `timeout_at`         | datetime     | When the response timeout expires                  |
| `created_at`         | datetime     | Timestamp                                          |

### UserIdentity

| Field                | Type         | Description                                        |
|----------------------|--------------|----------------------------------------------------|
| `internal_id`        | string       | Internal user identifier                           |
| `role`               | enum         | `admin`, `operator`, `contributor`, `viewer`       |
| `discord_id`         | string       | Discord user ID (nullable)                         |
| `slack_id`           | string       | Slack user ID (nullable)                           |
| `claude_user`        | string       | Claude Code user identifier (nullable)             |
| `repo_permissions`   | json         | Map of repo -> role override                       |
| `rate_limit_override`| json         | Custom rate limits (nullable)                      |

---

## 11. Configuration Reference

All configuration lives in `intake-config.yaml` at the plugin configuration root.

```yaml
# intake-config.yaml
queue:
  max_depth: 50
  starvation_threshold_hours: 48

rate_limits:
  submissions_per_hour: 10
  queries_per_minute: 60
  max_description_length: 10000

timeouts:
  human_response_hours: 4
  human_response_action: pause  # pause | default | escalate
  clarification_max_rounds: 5

notifications:
  default_verbosity: summary  # silent | summary | verbose | debug
  daily_digest_time: "09:00"
  daily_digest_channel: null  # channel ID, set per deployment

discord:
  bot_token: "${DISCORD_BOT_TOKEN}"
  guild_id: null
  command_channel_ids: []  # restrict commands to specific channels, empty = all

slack:
  bot_token: "${SLACK_BOT_TOKEN}"
  signing_secret: "${SLACK_SIGNING_SECRET}"
  command_channel_ids: []

duplicate_detection:
  enabled: true
  similarity_threshold: 0.85
  lookback_days: 30

injection_rules_file: "injection-rules.yaml"
```

---

## 12. Open Questions

| ID   | Question                                                                                                                                                        | Owner   | Status |
|------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|---------|--------|
| OQ-1 | Should the system support submitting requests with file attachments (e.g., mockups, specs)? If so, where are they stored and how are they referenced in the pipeline? | PM      | Open   |
| OQ-2 | How should the system handle requests that target repositories the pipeline has never seen before? Auto-clone and index, or reject until an admin configures it?  | Eng     | Open   |
| OQ-3 | Should the daily digest be a single message or a threaded breakdown per request? Large teams with many active requests could hit message size limits.             | PM      | Open   |
| OQ-4 | What is the escalation chain for unanswered clarifying questions? Should it go requester -> team lead -> admin, or is a single-level escalation sufficient?       | PM      | Open   |
| OQ-5 | Should the `/kill` command also roll back in-progress git operations (reset branches, close PRs), or should it only stop processes and leave artifacts in place?  | Eng     | Open   |
| OQ-6 | How do we handle multi-repo requests (e.g., "Build a feature that spans the API repo and the frontend repo")? Single request with multiple targets, or force the user to split? | PM | Open |
| OQ-7 | Should the duplicate detection model be a local embedding model (e.g., sentence-transformers) or should it use the Claude API for similarity assessment?          | Eng     | Open   |
| OQ-8 | What is the retention policy for completed requests? Keep indefinitely, archive after N days, or purge?                                                          | Ops     | Open   |
| OQ-9 | Should the system support "watching" a request (receiving notifications for a request you did not submit)?                                                        | PM      | Open   |
| OQ-10| For the Claude App native channel, how is the user identity determined when multiple users share a machine? Should it rely on OS user, or require explicit login? | Eng     | Open   |

---

## 13. Appendix: Command Quick Reference

| Command                              | Description                                         | Min. Role     |
|--------------------------------------|-----------------------------------------------------|---------------|
| `/submit [description]`              | Create a new pipeline request                       | contributor   |
| `/status [request-id]`               | View current state and progress of a request        | viewer        |
| `/list`                              | View all active requests                            | viewer        |
| `/cancel [request-id]`               | Cancel a request and clean up artifacts              | author / operator |
| `/pause [request-id]`                | Pause a request at the next phase boundary           | author / operator |
| `/resume [request-id]`               | Resume a paused request                              | author / operator |
| `/priority [request-id] [level]`     | Change request priority (high/normal/low)            | author / operator |
| `/logs [request-id]`                 | View activity log for a request                      | viewer        |
| `/logs [request-id] --all`           | View complete activity log                           | viewer        |
| `/feedback [request-id] [message]`   | Send feedback to an active request                   | author / operator |
| `/kill`                              | Emergency stop all requests (requires confirmation)  | admin         |

---

## 14. Revision History

| Version | Date       | Author          | Changes         |
|---------|------------|-----------------|-----------------|
| 1.0     | 2026-04-08 | Patrick Watson  | Initial draft   |
