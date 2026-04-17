# SPEC-009-5-4: Notification Types and Delivery Adapters

## Metadata
- **Parent Plan**: PLAN-009-5
- **Tasks Covered**: Task 7 (Define notification type system), Task 8 (CLI adapter), Task 9 (Discord adapter), Task 10 (Slack adapter), Task 11 (File drop adapter)
- **Estimated effort**: 14 hours

## Description

Define the notification type system and implement all four delivery adapters (CLI, Discord, Slack, file_drop). Each adapter formats notification payloads for its target platform and implements both single and batch delivery. Adapters produce formatted payloads only -- they do not make network calls (the platform layer handles transport). This separation allows testing without external dependencies.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/notifications/types.ts` | Create | Notification types and DeliveryAdapter interface |
| `src/notifications/adapters/cli-adapter.ts` | Create | Console text output adapter |
| `src/notifications/adapters/discord-adapter.ts` | Create | Discord embed JSON formatter |
| `src/notifications/adapters/slack-adapter.ts` | Create | Slack Block Kit JSON formatter |
| `src/notifications/adapters/file-drop-adapter.ts` | Create | Raw JSON file writer |

## Implementation Details

### types.ts

```typescript
export type NotificationEventType =
  | "escalation"
  | "gate_approval_needed"
  | "pipeline_completed"
  | "pipeline_failed"
  | "trust_level_changed"
  | "kill_switch_activated"
  | "systemic_issue";

export type NotificationUrgency = "immediate" | "soon" | "informational";

export type DeliveryMethod = "cli" | "discord" | "slack" | "file_drop";

export interface NotificationPayload {
  notification_id: string;           // UUID v4
  event_type: NotificationEventType;
  urgency: NotificationUrgency;
  timestamp: string;                 // ISO 8601
  request_id: string;
  repository: string;
  title: string;                     // Short summary (< 100 chars)
  body: string;                      // Detailed content
  metadata?: Record<string, unknown>;
}

export interface DeliveryAdapter {
  readonly method: DeliveryMethod;

  // Deliver a single notification. Returns formatted output.
  deliver(payload: NotificationPayload): DeliveryResult;

  // Deliver a batch of notifications. Returns formatted output.
  deliverBatch(payloads: NotificationPayload[]): DeliveryResult;
}

export interface DeliveryResult {
  success: boolean;
  method: DeliveryMethod;
  formattedOutput: string | object;  // String for CLI, object for JSON-based adapters
  error?: string;
}

export interface BatchingConfig {
  flushIntervalMinutes: number;      // Default: 60
  maxBufferSize: number;             // Default: 50
  exemptTypes: NotificationEventType[];  // Default: ["escalation", "error"]
}

export interface DndConfig {
  enabled: boolean;
  startTime: string;                 // HH:MM format (24h)
  endTime: string;                   // HH:MM format (24h)
  timezone: string;                  // IANA timezone (e.g., "America/New_York")
}

export interface FatigueConfig {
  enabled: boolean;
  thresholdPerHour: number;          // Default: 20
  cooldownMinutes: number;           // Default: 30
}

export interface CrossRequestConfig {
  enabled: boolean;
  windowMinutes: number;             // Default: 60
  threshold: number;                 // Default: 3
}
```

### CLI Adapter (`cli-adapter.ts`)

Formats notifications as human-readable console text with ANSI color codes:

```typescript
export class CliDeliveryAdapter implements DeliveryAdapter {
  readonly method = "cli" as const;

  deliver(payload: NotificationPayload): DeliveryResult;
  deliverBatch(payloads: NotificationPayload[]): DeliveryResult;
}
```

Output format for single delivery:
```
[IMMEDIATE] [escalation] repo-name
  Pipeline code_review gate requires human approval
  Request: req-abc | 2026-04-08T10:30:00Z
  Details: Code review has failed after 3 retries...
```

Color coding:
- `immediate` urgency: red text (`\x1b[31m`)
- `soon` urgency: yellow text (`\x1b[33m`)
- `informational` urgency: default (no color)

Batch output: grouped by request ID, then by event type. Each group has a header line.

### Discord Adapter (`discord-adapter.ts`)

Produces Discord embed JSON:

```typescript
export class DiscordDeliveryAdapter implements DeliveryAdapter {
  readonly method = "discord" as const;
  // ...
}
```

Single delivery output:
```json
{
  "embeds": [{
    "title": "Pipeline code_review gate requires human approval",
    "description": "Code review has failed after 3 retries...",
    "color": 16711680,
    "fields": [
      { "name": "Repository", "value": "repo-name", "inline": true },
      { "name": "Request", "value": "req-abc", "inline": true },
      { "name": "Urgency", "value": "immediate", "inline": true }
    ],
    "timestamp": "2026-04-08T10:30:00.000Z"
  }]
}
```

Color mapping: `immediate` = 16711680 (red), `soon` = 16776960 (yellow), `informational` = 3447003 (blue).

Batch: single embed with multiple fields, grouped sections.

### Slack Adapter (`slack-adapter.ts`)

Produces Slack Block Kit JSON:

```typescript
export class SlackDeliveryAdapter implements DeliveryAdapter {
  readonly method = "slack" as const;
  // ...
}
```

Single delivery output:
```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "Pipeline code_review gate requires human approval" }
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "Code review has failed after 3 retries..." }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "*Repository:* repo-name | *Request:* req-abc | *Urgency:* :red_circle: immediate" }
      ]
    }
  ]
}
```

Urgency emoji: `immediate` = `:red_circle:`, `soon` = `:large_yellow_circle:`, `informational` = `:blue_circle:`.

Batch: single message with dividers between grouped notifications.

### File Drop Adapter (`file-drop-adapter.ts`)

Writes raw JSON to a configured directory:

```typescript
export class FileDropDeliveryAdapter implements DeliveryAdapter {
  readonly method = "file_drop" as const;

  constructor(private outputDir: string) {}
  // ...
}
```

Single: writes `{outputDir}/{notification_id}.json`.
Batch: writes `{outputDir}/batch-{timestamp}.json` containing an array of payloads.
Write is atomic (temp + rename).

## Acceptance Criteria

1. All 7 `NotificationEventType` values enumerated.
2. `DeliveryAdapter` interface defines `deliver()` and `deliverBatch()`.
3. CLI adapter produces human-readable colored text.
4. CLI batch output grouped by request ID and event type.
5. Discord adapter produces valid Discord embed JSON with correct color codes.
6. Discord batch produces consolidated embed.
7. Slack adapter produces valid Block Kit JSON with mrkdwn formatting.
8. Slack batch produces single message with dividers.
9. File drop adapter writes JSON atomically.
10. File drop batch writes array of payloads.
11. All adapters implement both `deliver()` and `deliverBatch()`.
12. All adapters return `DeliveryResult` with `success`, `method`, and `formattedOutput`.

## Test Cases

### CLI Adapter

1. **Single: immediate urgency red** -- Verify output contains ANSI red escape code.
2. **Single: informational no color** -- Verify output has no color codes.
3. **Single: contains title and body** -- Output includes payload title and body.
4. **Batch: grouped by request** -- 5 notifications for 2 requests; output grouped into 2 sections.

### Discord Adapter

5. **Single: valid embed JSON** -- Output parses as valid JSON with `embeds` array.
6. **Single: immediate color 16711680** -- Embed color matches red.
7. **Single: fields include repo and request** -- Embed fields contain expected values.
8. **Batch: consolidated embed** -- 3 notifications produce 1 embed with multiple field groups.

### Slack Adapter

9. **Single: valid Block Kit JSON** -- Output parses as valid JSON with `blocks` array.
10. **Single: header block present** -- First block is header type with title.
11. **Single: urgency emoji** -- Context block contains `:red_circle:` for immediate.
12. **Batch: dividers between groups** -- Batch output includes divider blocks between notification groups.

### File Drop Adapter

13. **Single: file written** -- File exists at `{outputDir}/{notification_id}.json` after deliver.
14. **Single: valid JSON content** -- File contents parse as the original payload.
15. **Batch: array of payloads** -- Batch file contains JSON array with all payloads.
16. **Atomic write** -- Verify temp+rename pattern (mock fs).
