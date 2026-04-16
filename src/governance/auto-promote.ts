/**
 * Auto-promotion evaluator with six safeguards and override management
 * (SPEC-007-5-4, Task 8).
 *
 * Automatically promotes high-confidence P0/P1 observations with a
 * human override window. Implements six mandatory safeguards from
 * TDD section 3.12.3.
 *
 * Safeguards (all must pass):
 *   1. auto_promote.enabled is true in config
 *   2. severity is P0 or P1
 *   3. confidence >= 0.9
 *   4. cooldown is not active
 *   5. oscillation is not detected
 *   6. notification channel is reachable
 */

import { checkOscillation } from './oscillation';
import { checkChannelHealth, postToWebhook } from '../triage/notification';
import { updateFrontmatter } from '../triage/frontmatter-io';
import { scheduleOverrideCheck } from './override-scheduler';
import type { GovernanceConfig } from './types';
import type { ObservationSummary } from './types';
import type { NotificationConfig } from '../triage/notification';
import type { AuditLogger } from '../runner/audit-logger';

import * as fs from 'fs/promises';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface AutoPromotionExecution {
  prd_id: string;
  override_deadline: string;
  notification_sent: boolean;
}

// ---------------------------------------------------------------------------
// Auto-promote evaluator
// ---------------------------------------------------------------------------

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
  notificationConfig: NotificationConfig,
  findObservations: (service: string, errorClass: string, after: Date) => ObservationSummary[],
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

// ---------------------------------------------------------------------------
// Auto-promotion execution
// ---------------------------------------------------------------------------

/**
 * Execute the auto-promotion: generate PRD, notify PM Lead, schedule override check.
 */
export async function executeAutoPromotion(
  observation: AutoPromoteCandidate,
  autoPromoteConfig: AutoPromoteConfig,
  rootDir: string,
  notificationConfig: NotificationConfig,
  logger: AuditLogger,
  generatePrdFromObservation?: (filePath: string, rootDir: string) => Promise<{ prdId: string }>
): Promise<AutoPromotionExecution> {
  // 1. Generate PRD (delegates to promotion pipeline from SPEC-007-4-3)
  const prdResult = generatePrdFromObservation
    ? await generatePrdFromObservation(observation.file_path, rootDir)
    : { prdId: `PRD-OBS-${observation.id.replace('OBS-', '')}` };

  // 2. Update observation file: triage_decision=promote, auto_promoted=true
  await updateFrontmatter(observation.file_path, {
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

  await postAutoPromoteNotification(
    observation,
    prdResult.prdId,
    overrideDeadline,
    autoPromoteConfig,
    notificationConfig
  );

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

// ---------------------------------------------------------------------------
// Auto-promote notification
// ---------------------------------------------------------------------------

/**
 * Post an auto-promote notification to the PM Lead with override instructions.
 */
async function postAutoPromoteNotification(
  observation: AutoPromoteCandidate,
  prdId: string,
  overrideDeadline: Date,
  autoPromoteConfig: AutoPromoteConfig,
  notificationConfig: NotificationConfig
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

// ---------------------------------------------------------------------------
// Triage audit log helper
// ---------------------------------------------------------------------------

interface TriageAuditLogEntry {
  observation_id: string;
  action: string;
  actor: string;
  timestamp: string;
  reason: string;
  generated_prd: string | null;
  auto_promoted: boolean;
}

/**
 * Append an entry to the triage audit log (JSONL format).
 */
async function appendToTriageAuditLog(
  rootDir: string,
  entry: TriageAuditLogEntry
): Promise<void> {
  const logPath = path.join(
    rootDir,
    '.autonomous-dev',
    'logs',
    'intelligence',
    'triage-audit.log'
  );
  const logDir = path.dirname(logPath);
  await fs.mkdir(logDir, { recursive: true });
  const json = JSON.stringify(entry);
  await fs.appendFile(logPath, json + '\n', 'utf-8');
}
