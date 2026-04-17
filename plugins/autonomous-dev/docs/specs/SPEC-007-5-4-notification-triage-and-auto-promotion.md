# SPEC-007-5-4: Notification-Based Triage and Auto-Promotion Engine

## Metadata
- **Parent Plan**: PLAN-007-5
- **Tasks Covered**: Task 7, Task 8
- **Estimated effort**: 16 hours

## Description

Implement the Phase 3 notification-based triage system (Slack/Discord webhooks for posting observation summaries and receiving triage commands) and the auto-promotion engine that automatically promotes high-confidence P0/P1 observations with a human override window.

Task 7 integrates the observation pipeline with external notification channels so the PM Lead can triage observations directly from Slack/Discord without opening the observation files. The file-based system remains the source of truth; the notification channel is a convenience layer.

Task 8 adds auto-promotion logic with six mandatory safeguards. When all safeguards pass, an observation is automatically promoted (PRD generated), the PM Lead is notified immediately, and an override window begins. If the PM Lead overrides within the window, the PRD is cancelled and the observation returns to pending.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/triage/notification.ts` | Create | Webhook posting and channel health checking for Slack/Discord |
| `src/triage/notification-formatter.ts` | Create | Format observation data into Slack/Discord message payloads |
| `src/triage/notification-receiver.ts` | Create | Parse incoming triage commands and write back to files |
| `src/governance/auto-promote.ts` | Create | Auto-promotion evaluator with six safeguards and override management |
| `src/governance/override-scheduler.ts` | Create | Schedule and execute override window checks |
| `tests/triage/notification.test.ts` | Create | Unit tests for notification posting and health checks |
| `tests/governance/auto-promote.test.ts` | Create | Unit tests for auto-promotion logic and override handling |

## Implementation Details

### Task 7: Notification-Based Triage (`src/triage/notification.ts`)

**Configuration** (additions to `intelligence.yaml`):

```yaml
notifications:
  enabled: false
  channel: "slack"                    # "slack" | "discord"
  webhook_url: "${NOTIFICATION_WEBHOOK_URL}"
  notify_on:
    - "P0"                            # Severity levels that trigger notifications
    - "P1"
  health_check_timeout_ms: 5000       # Timeout for channel health check
  retry_attempts: 2                   # Retries on transient failure
  retry_delay_ms: 1000                # Delay between retries
```

**Core notification types**:

```typescript
export interface NotificationConfig {
  enabled: boolean;
  channel: 'slack' | 'discord';
  webhook_url: string;
  notify_on: string[];               // Severity levels: ["P0", "P1"]
  health_check_timeout_ms: number;
  retry_attempts: number;
  retry_delay_ms: number;
}

export interface NotificationPayload {
  observation_id: string;
  service: string;
  severity: string;
  title: string;
  error_rate: string;
  baseline: string;
  confidence: number;
  recommended_action: string;
  commands: string[];                // Formatted command strings
}

export interface ChannelHealth {
  reachable: boolean;
  latency_ms: number;
  error?: string;
}
```

**Webhook posting**:

```typescript
import fetch from 'node-fetch';

/**
 * Post an observation summary to the configured notification channel.
 * Falls back silently to file-only triage if the channel is unreachable.
 */
export async function postObservationNotification(
  observation: NotificationPayload,
  config: NotificationConfig,
  logger: AuditLogger
): Promise<{ posted: boolean; error?: string }> {
  if (!config.enabled) {
    return { posted: false, error: 'Notifications disabled' };
  }

  // Check if severity qualifies
  if (!config.notify_on.includes(observation.severity)) {
    return { posted: false, error: `Severity ${observation.severity} not in notify_on` };
  }

  // Health check
  const health = await checkChannelHealth(config);
  if (!health.reachable) {
    logger.warn(`Notification channel unreachable: ${health.error}. Falling back to file-only triage.`);
    return { posted: false, error: `Channel unreachable: ${health.error}` };
  }

  // Format message
  const message = formatMessage(observation, config.channel);

  // Post with retries
  for (let attempt = 0; attempt <= config.retry_attempts; attempt++) {
    try {
      const response = await fetch(config.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(config.health_check_timeout_ms),
      });

      if (response.ok) {
        logger.info(`Notification posted for ${observation.observation_id}`);
        return { posted: true };
      }

      // Rate limited
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') ?? '5', 10);
        logger.warn(`Rate limited, waiting ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }

      logger.warn(`Notification failed (${response.status}): ${await response.text()}`);
    } catch (err) {
      if (attempt < config.retry_attempts) {
        await sleep(config.retry_delay_ms);
        continue;
      }
      return { posted: false, error: `Failed after ${config.retry_attempts + 1} attempts: ${err}` };
    }
  }

  return { posted: false, error: 'Exhausted retry attempts' };
}

/**
 * Check whether the notification channel is reachable.
 * Sends a lightweight probe (empty payload) or uses the webhook's health endpoint.
 */
export async function checkChannelHealth(
  config: NotificationConfig
): Promise<ChannelHealth> {
  const start = Date.now();
  try {
    const response = await fetch(config.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Slack accepts empty JSON and returns ok; Discord returns 400 but proves reachability
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(config.health_check_timeout_ms),
    });

    const latency = Date.now() - start;

    // Slack returns 200 or 400 (bad payload); Discord returns 400.
    // Any response proves the channel is reachable.
    if (response.status < 500) {
      return { reachable: true, latency_ms: latency };
    }

    return {
      reachable: false,
      latency_ms: latency,
      error: `Server error: ${response.status}`,
    };
  } catch (err: any) {
    return {
      reachable: false,
      latency_ms: Date.now() - start,
      error: err.message ?? String(err),
    };
  }
}
```

**Message formatting** (`src/triage/notification-formatter.ts`):

```typescript
/**
 * Format an observation into a Slack Block Kit or Discord embed payload.
 * Matches TDD section 3.10.3 notification format.
 */
export function formatMessage(
  obs: NotificationPayload,
  channel: 'slack' | 'discord'
): object {
  if (channel === 'slack') {
    return formatSlackMessage(obs);
  }
  return formatDiscordMessage(obs);
}

function formatSlackMessage(obs: NotificationPayload): object {
  const severityEmoji = getSeverityEmoji(obs.severity);
  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${severityEmoji} New ${obs.severity} Observation: ${obs.service}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*${obs.title}*`,
            `Error rate: ${obs.error_rate} (baseline: ${obs.baseline})`,
            `Confidence: ${obs.confidence}`,
            '',
            `Recommended: ${obs.recommended_action}`,
          ].join('\n'),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            'Reply with:',
            ...obs.commands.map(cmd => `  \`${cmd}\``),
          ].join('\n'),
        },
      },
    ],
  };
}

function formatDiscordMessage(obs: NotificationPayload): object {
  const severityEmoji = getSeverityEmoji(obs.severity);
  return {
    embeds: [
      {
        title: `${severityEmoji} New ${obs.severity} Observation: ${obs.service}`,
        description: [
          `**${obs.title}**`,
          `Error rate: ${obs.error_rate} (baseline: ${obs.baseline})`,
          `Confidence: ${obs.confidence}`,
          '',
          `Recommended: ${obs.recommended_action}`,
          '',
          'Reply with:',
          ...obs.commands.map(cmd => `  \`${cmd}\``),
        ].join('\n'),
        color: getSeverityColor(obs.severity),
      },
    ],
  };
}

function getSeverityEmoji(severity: string): string {
  switch (severity) {
    case 'P0': return ':rotating_light:';
    case 'P1': return ':warning:';
    case 'P2': return ':large_yellow_circle:';
    case 'P3': return ':information_source:';
    default: return ':grey_question:';
  }
}

function getSeverityColor(severity: string): number {
  switch (severity) {
    case 'P0': return 0xFF0000; // Red
    case 'P1': return 0xFF8C00; // Orange
    case 'P2': return 0xFFD700; // Yellow
    case 'P3': return 0x4169E1; // Blue
    default: return 0x808080;   // Grey
  }
}

/**
 * Build the triage command strings for an observation.
 */
export function buildTriageCommands(observationId: string): string[] {
  return [
    `/promote ${observationId} <reason>`,
    `/dismiss ${observationId} <reason>`,
    `/defer ${observationId} <date> <reason>`,
    `/investigate ${observationId}`,
  ];
}
```

**Notification receiver** (`src/triage/notification-receiver.ts`):

```typescript
/**
 * Parse an incoming triage command from the notification channel.
 * Commands are received as plain-text messages.
 *
 * Supported formats:
 *   /promote OBS-20260408-143022-a7f3 Connection pool issue confirmed
 *   /dismiss OBS-20260408-143022-a7f3 False positive, not actionable
 *   /defer OBS-20260408-143022-a7f3 2026-04-15 Wait for next sprint
 *   /investigate OBS-20260408-143022-a7f3
 */
export function parseTriageCommand(input: string): TriageCommand | null {
  const patterns = [
    /^\/promote\s+(OBS-\d{8}-\d{6}-[a-f0-9]{4})\s+(.+)$/i,
    /^\/dismiss\s+(OBS-\d{8}-\d{6}-[a-f0-9]{4})\s+(.+)$/i,
    /^\/defer\s+(OBS-\d{8}-\d{6}-[a-f0-9]{4})\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/i,
    /^\/investigate\s+(OBS-\d{8}-\d{6}-[a-f0-9]{4})$/i,
  ];

  for (const pattern of patterns) {
    const match = input.trim().match(pattern);
    if (!match) continue;

    if (input.startsWith('/promote')) {
      return { action: 'promote', observation_id: match[1], reason: match[2] };
    }
    if (input.startsWith('/dismiss')) {
      return { action: 'dismiss', observation_id: match[1], reason: match[2] };
    }
    if (input.startsWith('/defer')) {
      return {
        action: 'defer',
        observation_id: match[1],
        defer_until: match[2],
        reason: match[3],
      };
    }
    if (input.startsWith('/investigate')) {
      return { action: 'investigate', observation_id: match[1] };
    }
  }

  return null;
}

export interface TriageCommand {
  action: 'promote' | 'dismiss' | 'defer' | 'investigate';
  observation_id: string;
  reason?: string;
  defer_until?: string;
}

/**
 * Apply a triage command to the observation file.
 * Delegates to the existing triage processor from SPEC-007-4-2,
 * ensuring the file remains the source of truth.
 */
export async function applyTriageCommand(
  command: TriageCommand,
  actor: string,
  rootDir: string,
  logger: AuditLogger
): Promise<{ applied: boolean; error?: string }> {
  // Find the observation file by ID
  const filePath = findObservationFileById(rootDir, command.observation_id);
  if (!filePath) {
    return { applied: false, error: `Observation ${command.observation_id} not found` };
  }

  // Delegate to the triage processor (SPEC-007-4-2)
  return await processTriageDecision(filePath, {
    decision: command.action,
    actor,
    reason: command.reason,
    defer_until: command.defer_until,
    source: 'notification',
  });
}
```

### Task 8: Auto-Promotion Engine (`src/governance/auto-promote.ts`)

```typescript
import { checkOscillation } from './oscillation';
import { checkChannelHealth } from '../triage/notification';
import { GovernanceConfig, OscillationResult } from './types';

export interface AutoPromoteConfig {
  enabled: boolean;
  override_hours: number;          // Default: 2
}

export interface AutoPromoteResult {
  promoted: boolean;
  reason: string;
  safeguard_failed?: string;       // Which safeguard blocked promotion
}

export interface AutoPromoteCandidate {
  id: string;
  service: string;
  error_class: string;
  severity: string;
  confidence: number;
  cooldown_active: boolean;
  file_path: string;
}

/**
 * Evaluate whether an observation qualifies for auto-promotion.
 * Implements the six safeguards from TDD section 3.12.3:
 *
 * 1. auto_promote.enabled is true in config
 * 2. severity is P0 or P1
 * 3. confidence >= 0.9
 * 4. cooldown is not active
 * 5. oscillation is not detected
 * 6. notification channel is reachable
 *
 * All six must pass. If any fails, returns { promoted: false }
 * with the specific safeguard that blocked.
 */
export async function evaluateAutoPromote(
  observation: AutoPromoteCandidate,
  autoPromoteConfig: AutoPromoteConfig,
  governanceConfig: GovernanceConfig,
  notificationConfig: any,
  findObservations: (service: string, errorClass: string, after: Date) => any[],
  logger: AuditLogger
): Promise<AutoPromoteResult> {
  // Safeguard 1: Auto-promote must be enabled
  if (!autoPromoteConfig.enabled) {
    return {
      promoted: false,
      reason: 'Auto-promote is disabled',
      safeguard_failed: 'enabled',
    };
  }

  // Safeguard 2: Only P0 or P1
  if (observation.severity !== 'P0' && observation.severity !== 'P1') {
    return {
      promoted: false,
      reason: `Severity ${observation.severity} is not P0 or P1`,
      safeguard_failed: 'severity',
    };
  }

  // Safeguard 3: Confidence >= 0.9
  if (observation.confidence < 0.9) {
    return {
      promoted: false,
      reason: `Confidence ${observation.confidence} is below 0.9 threshold`,
      safeguard_failed: 'confidence',
    };
  }

  // Safeguard 4: Cooldown must not be active
  if (observation.cooldown_active) {
    return {
      promoted: false,
      reason: 'Cooldown is active for this service + error class',
      safeguard_failed: 'cooldown',
    };
  }

  // Safeguard 5: Oscillation must not be detected
  const oscillation = checkOscillation(
    observation.service,
    observation.error_class,
    governanceConfig,
    findObservations
  );
  if (oscillation.oscillating) {
    return {
      promoted: false,
      reason: `Oscillation detected: ${oscillation.count} observations in ${oscillation.window_days} days`,
      safeguard_failed: 'oscillation',
    };
  }

  // Safeguard 6: Notification channel must be reachable
  const health = await checkChannelHealth(notificationConfig);
  if (!health.reachable) {
    return {
      promoted: false,
      reason: `Notification channel unreachable: ${health.error}`,
      safeguard_failed: 'notification_channel',
    };
  }

  // All safeguards passed -- auto-promote
  logger.info(`Auto-promoting observation ${observation.id} (all 6 safeguards passed)`);
  return {
    promoted: true,
    reason: 'All safeguards passed',
  };
}

/**
 * Execute the auto-promotion: generate PRD, notify PM Lead, schedule override check.
 */
export async function executeAutoPromotion(
  observation: AutoPromoteCandidate,
  autoPromoteConfig: AutoPromoteConfig,
  rootDir: string,
  notificationConfig: any,
  logger: AuditLogger
): Promise<AutoPromotionExecution> {
  // 1. Generate PRD (delegates to promotion pipeline from SPEC-007-4-3)
  const prdResult = await generatePrdFromObservation(observation.file_path, rootDir);

  // 2. Update observation file: triage_decision=promote, auto_promoted=true
  await updateObservationTriage(observation.file_path, {
    triage_decision: 'promote',
    triage_status: 'promoted',
    triage_by: 'auto-promote-engine',
    triage_at: new Date().toISOString(),
    triage_reason: 'Auto-promoted: P0/P1 with confidence >= 0.9',
    linked_prd: prdResult.prdId,
  });

  // 3. Write auto_promoted flag to triage audit log
  await appendToTriageAuditLog(rootDir, {
    observation_id: observation.id,
    action: 'promote',
    actor: 'auto-promote-engine',
    timestamp: new Date().toISOString(),
    reason: 'Auto-promoted: all 6 safeguards passed',
    generated_prd: prdResult.prdId,
    auto_promoted: true,
  });

  // 4. Notify PM Lead with override instructions
  const overrideDeadline = new Date();
  overrideDeadline.setHours(overrideDeadline.getHours() + autoPromoteConfig.override_hours);

  await postAutoPromoteNotification(observation, prdResult.prdId, overrideDeadline, notificationConfig);

  // 5. Schedule override check
  await scheduleOverrideCheck(
    observation.id,
    prdResult.prdId,
    overrideDeadline,
    rootDir,
    logger
  );

  return {
    prd_id: prdResult.prdId,
    override_deadline: overrideDeadline.toISOString(),
    notification_sent: true,
  };
}

interface AutoPromotionExecution {
  prd_id: string;
  override_deadline: string;
  notification_sent: boolean;
}
```

**Override scheduler** (`src/governance/override-scheduler.ts`):

```typescript
/**
 * Schedule an override check for an auto-promoted observation.
 *
 * The check runs at the end of the override window. It reads
 * the observation file to determine if the PM Lead overrode
 * the auto-promotion during the window.
 *
 * Override is detected by:
 * - triage_decision changed from 'promote' to something else
 * - triage_by changed from 'auto-promote-engine' to a human
 * - A specific 'override' action in the triage audit log
 */
export async function scheduleOverrideCheck(
  observationId: string,
  prdId: string,
  deadline: Date,
  rootDir: string,
  logger: AuditLogger
): Promise<void> {
  // Write a pending override check file
  const checkFile = `${rootDir}/.autonomous-dev/governance/pending-overrides/${observationId}.json`;
  await fs.mkdir(path.dirname(checkFile), { recursive: true });

  await fs.writeFile(checkFile, JSON.stringify({
    observation_id: observationId,
    prd_id: prdId,
    override_deadline: deadline.toISOString(),
    created_at: new Date().toISOString(),
    status: 'pending',
  }, null, 2), 'utf-8');

  logger.info(
    `Override check scheduled for ${observationId}: ` +
    `deadline ${deadline.toISOString()}`
  );
}

/**
 * Process all pending override checks.
 * Called at the start of each observation run.
 *
 * For each check past its deadline:
 * - Read the observation file
 * - If triage_decision is still 'promote' and triage_by is 'auto-promote-engine':
 *     auto-promotion stands, mark check as 'confirmed'
 * - If triage_decision has changed or triage_by is a human:
 *     PM Lead overrode, cancel the PRD, mark check as 'overridden'
 */
export async function processPendingOverrides(
  rootDir: string,
  logger: AuditLogger
): Promise<OverrideProcessingResult> {
  const pendingDir = `${rootDir}/.autonomous-dev/governance/pending-overrides`;
  const result: OverrideProcessingResult = {
    confirmed: 0,
    overridden: 0,
    still_pending: 0,
  };

  const files = await safeReadDir(pendingDir);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const checkPath = path.join(pendingDir, file);
    const check = JSON.parse(await fs.readFile(checkPath, 'utf-8'));

    if (check.status !== 'pending') continue;

    const deadline = new Date(check.override_deadline);
    const now = new Date();

    if (now < deadline) {
      result.still_pending++;
      continue;
    }

    // Deadline passed -- check if overridden
    const obsFile = findObservationFileById(rootDir, check.observation_id);
    if (!obsFile) {
      logger.error(`Override check: observation ${check.observation_id} not found`);
      continue;
    }

    const frontmatter = parseFrontmatterFromFile(obsFile);
    if (!frontmatter) {
      logger.error(`Override check: failed to parse ${obsFile}`);
      continue;
    }

    const wasOverridden = (
      frontmatter.triage_decision !== 'promote' ||
      (frontmatter.triage_by !== 'auto-promote-engine' && frontmatter.triage_by !== null)
    );

    if (wasOverridden) {
      // Cancel the PRD
      await cancelPrd(rootDir, check.prd_id, logger);
      check.status = 'overridden';
      result.overridden++;
      logger.info(
        `Auto-promotion overridden: ${check.observation_id}. ` +
        `PRD ${check.prd_id} cancelled.`
      );
    } else {
      check.status = 'confirmed';
      result.confirmed++;
      logger.info(
        `Auto-promotion confirmed: ${check.observation_id}. ` +
        `PRD ${check.prd_id} stands.`
      );
    }

    await fs.writeFile(checkPath, JSON.stringify(check, null, 2), 'utf-8');
  }

  return result;
}

/**
 * Cancel an auto-promoted PRD by marking it as cancelled.
 * Moves the file to a cancelled/ subdirectory and updates
 * the observation's linked_prd to null.
 */
async function cancelPrd(
  rootDir: string,
  prdId: string,
  logger: AuditLogger
): Promise<void> {
  const prdDir = path.join(rootDir, '.autonomous-dev', 'prd');
  const prdFile = path.join(prdDir, `${prdId}.md`);
  const cancelledDir = path.join(prdDir, 'cancelled');

  await fs.mkdir(cancelledDir, { recursive: true });

  if (await fileExists(prdFile)) {
    const cancelledPath = path.join(cancelledDir, `${prdId}.md`);
    await fs.rename(prdFile, cancelledPath);
    logger.info(`PRD ${prdId} moved to cancelled/`);
  }
}

interface OverrideProcessingResult {
  confirmed: number;
  overridden: number;
  still_pending: number;
}
```

**Auto-promote notification payload**:

```typescript
async function postAutoPromoteNotification(
  observation: AutoPromoteCandidate,
  prdId: string,
  overrideDeadline: Date,
  notificationConfig: any
): Promise<void> {
  const message = {
    text: [
      `:robot_face: **Auto-Promoted**: ${observation.id}`,
      `Service: ${observation.service}`,
      `Severity: ${observation.severity} | Confidence: ${observation.confidence}`,
      `Generated PRD: ${prdId}`,
      '',
      `:clock2: Override window: ${autoPromoteConfig.override_hours}h ` +
        `(until ${overrideDeadline.toISOString()})`,
      '',
      'To override (cancel the PRD):',
      `  \`/dismiss ${observation.id} <reason>\``,
      '',
      'If no override, the PRD will proceed to the development pipeline.',
    ].join('\n'),
  };

  await postToWebhook(notificationConfig.webhook_url, message);
}
```

## Acceptance Criteria

1. [ ] When configured with a webhook URL and `notifications.enabled: true`, the system posts a formatted observation summary for observations matching `notify_on` severity levels.
2. [ ] Notification payload matches the TDD section 3.10.3 format: severity emoji, service, title, error rate, baseline, confidence, recommended action, and reply commands.
3. [ ] Slack messages use Block Kit format; Discord messages use embed format with severity-appropriate colors.
4. [ ] `checkChannelHealth` returns `{ reachable: true }` for any HTTP response < 500 (including 400 bad payload).
5. [ ] If the notification channel is unreachable, the system falls back to file-only triage with a warning logged.
6. [ ] Triage commands (`/promote`, `/dismiss`, `/defer`, `/investigate`) are parsed correctly from notification channel input.
7. [ ] Triage decisions from the notification channel are written back to observation files (file is source of truth).
8. [ ] `evaluateAutoPromote` checks all six safeguards in order: enabled, P0/P1 severity, confidence >= 0.9, no cooldown, no oscillation, channel reachable.
9. [ ] If any safeguard fails, auto-promotion is blocked and the specific failed safeguard is identified in the result.
10. [ ] On successful auto-promotion: PRD is generated, observation is updated with `triage_decision: promote` and `auto_promoted: true` in the audit log, PM Lead is notified.
11. [ ] Override window of `config.auto_promote.override_hours` (default 2h) begins at auto-promotion time.
12. [ ] If PM Lead overrides within the window (changes triage_decision from promote), the PRD is cancelled (moved to `cancelled/` directory) and the observation returns to previous state.
13. [ ] If no override occurs within the window, the auto-promotion is confirmed and the PRD proceeds to the pipeline.
14. [ ] Pending override checks are persisted to disk and processed at the start of each observation run.
15. [ ] Rate limiting (HTTP 429) is handled with `retry-after` header parsing.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-5-4-01 | Slack message format | P1 observation for api-gateway | Block Kit payload with :warning: emoji, service name, error rate, commands |
| TC-5-4-02 | Discord message format | P0 observation | Embed with red color (0xFF0000), :rotating_light: emoji |
| TC-5-4-03 | Notification not sent (disabled) | `notifications.enabled: false` | `{ posted: false, error: 'Notifications disabled' }` |
| TC-5-4-04 | Notification not sent (wrong severity) | P3 observation, `notify_on: ["P0", "P1"]` | `{ posted: false }`, severity filter message |
| TC-5-4-05 | Channel health -- reachable | Webhook returns 400 (bad payload) | `{ reachable: true }` |
| TC-5-4-06 | Channel health -- unreachable | Webhook times out | `{ reachable: false, error: 'timeout' }` |
| TC-5-4-07 | Channel health -- server error | Webhook returns 500 | `{ reachable: false }` |
| TC-5-4-08 | Retry on transient failure | First attempt fails, second succeeds | `{ posted: true }` after 1 retry |
| TC-5-4-09 | Rate limit handling | Webhook returns 429 with `retry-after: 3` | Waits 3s, retries, succeeds |
| TC-5-4-10 | Parse /promote command | `/promote OBS-20260408-143022-a7f3 Pool issue confirmed` | `{ action: 'promote', id: 'OBS-...', reason: 'Pool issue confirmed' }` |
| TC-5-4-11 | Parse /dismiss command | `/dismiss OBS-20260408-143022-a7f3 False positive` | `{ action: 'dismiss', id: 'OBS-...', reason: 'False positive' }` |
| TC-5-4-12 | Parse /defer command | `/defer OBS-20260408-143022-a7f3 2026-04-15 Wait for sprint` | `{ action: 'defer', id: 'OBS-...', defer_until: '2026-04-15', reason: 'Wait...' }` |
| TC-5-4-13 | Parse /investigate command | `/investigate OBS-20260408-143022-a7f3` | `{ action: 'investigate', id: 'OBS-...' }` |
| TC-5-4-14 | Parse invalid command | `/unknown OBS-20260408-143022-a7f3` | Returns `null` |
| TC-5-4-15 | Triage writeback from notification | `/promote` command received | Observation file updated with `triage_decision: promote` |
| TC-5-4-16 | Auto-promote all safeguards pass | P0, confidence=0.95, no cooldown, no oscillation, channel reachable, enabled | `{ promoted: true }` |
| TC-5-4-17 | Auto-promote blocked: disabled | `auto_promote.enabled: false` | `{ promoted: false, safeguard_failed: 'enabled' }` |
| TC-5-4-18 | Auto-promote blocked: severity | P2 observation | `{ promoted: false, safeguard_failed: 'severity' }` |
| TC-5-4-19 | Auto-promote blocked: confidence | P0, confidence=0.85 | `{ promoted: false, safeguard_failed: 'confidence' }` |
| TC-5-4-20 | Auto-promote blocked: cooldown | P0, confidence=0.95, cooldown active | `{ promoted: false, safeguard_failed: 'cooldown' }` |
| TC-5-4-21 | Auto-promote blocked: oscillation | P0, confidence=0.95, 3 prior observations in window | `{ promoted: false, safeguard_failed: 'oscillation' }` |
| TC-5-4-22 | Auto-promote blocked: channel unreachable | P0, confidence=0.95, channel down | `{ promoted: false, safeguard_failed: 'notification_channel' }` |
| TC-5-4-23 | Override within window | PM Lead changes triage_decision within 2h | PRD moved to `cancelled/`, observation triage_status reset |
| TC-5-4-24 | Override after window | PM Lead changes triage_decision after 2h | PRD stands, override check already confirmed |
| TC-5-4-25 | No override | Nobody changes triage within window | PRD confirmed, override check marked 'confirmed' |
| TC-5-4-26 | Pending override persistence | Override scheduled, runner restarts | Pending override file on disk, processed on next run |
| TC-5-4-27 | Auto-promote audit log | Successful auto-promotion | Triage audit log entry with `auto_promoted: true` |
