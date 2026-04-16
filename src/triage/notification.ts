/**
 * Notification-based triage: webhook posting and channel health checking
 * (SPEC-007-5-4, Task 7).
 *
 * Posts observation summaries to Slack/Discord webhooks so the PM Lead
 * can triage observations directly from the notification channel.
 * The file-based system remains the source of truth; the notification
 * channel is a convenience layer.
 *
 * Falls back silently to file-only triage when the channel is unreachable.
 */

import { formatMessage } from './notification-formatter';
import type { AuditLogger } from '../runner/audit-logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Webhook posting
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Channel health check
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Webhook post helper (used by auto-promote notification)
// ---------------------------------------------------------------------------

/**
 * Low-level webhook post. Used by auto-promote notification to send
 * arbitrary message payloads to the configured webhook.
 */
export async function postToWebhook(
  webhookUrl: string,
  message: object,
  timeoutMs: number = 5000
): Promise<void> {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
