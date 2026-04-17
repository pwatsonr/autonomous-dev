/**
 * NotificationEngine -- Verbosity Filtering, Routing & Delivery Retry.
 *
 * Subscribes to pipeline phase-transition events, resolves notification
 * targets, selects the appropriate formatter per channel, and delivers
 * with exponential-backoff retry. Includes verbosity filtering
 * (silent/summary/verbose/debug) and cross-channel notification routing
 * with per-request route configuration.
 *
 * Implements SPEC-008-5-01 (Tasks 1-4).
 *
 * @module notification_engine
 */

import * as crypto from 'crypto';

import type { Repository, RequestEntity } from '../db/repository';
import type {
  ChannelType,
  IntakeAdapter,
  FormattedMessage,
  MessageTarget,
  NotificationConfig,
  NotificationRoute,
  VerbosityLevel,
} from '../adapters/adapter_interface';
import type {
  PhaseTransitionEvent,
  NotificationFormatter,
} from './formatters/cli_formatter';
import type { ArtifactLinks } from '../events/event_types';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Logger interface for structured logging within the notification engine.
 */
export interface NotificationLogger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default no-op logger used when no logger is provided.
 */
const nullLogger: NotificationLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// NotificationEngine
// ---------------------------------------------------------------------------

/**
 * Core notification engine that handles phase-transition events,
 * applies verbosity filtering, resolves notification targets,
 * formats messages per channel, and delivers with retry.
 *
 * Implements SPEC-008-5-01.
 */
export class NotificationEngine {
  private logger: NotificationLogger;

  constructor(
    private db: Repository,
    private adapters: Map<ChannelType, IntakeAdapter>,
    private formatters: Map<ChannelType, NotificationFormatter>,
    logger: NotificationLogger = nullLogger,
  ) {
    this.logger = logger;
  }

  // =========================================================================
  // Task 1: Event handlers
  // =========================================================================

  /**
   * Handle a pipeline phase transition event.
   *
   * Fetches the request, checks verbosity, resolves targets, formats
   * per channel, and delivers with retry.
   */
  async onPhaseTransition(event: PhaseTransitionEvent): Promise<void> {
    const request = this.db.getRequest(event.requestId);
    if (!request) {
      this.logger.warn('Notification for unknown request', { requestId: event.requestId });
      return;
    }

    const config = this.parseNotificationConfig(request.notification_config);

    // Check verbosity filter
    const enrichedEvent = { ...event, type: 'phase_transition' as const };
    if (!this.shouldNotify(config.verbosity ?? 'summary', enrichedEvent)) {
      return;
    }

    // Resolve targets with phase filtering
    const targets = this.resolveTargets(request, config, enrichedEvent);

    // Format and deliver per target
    for (const target of targets) {
      const formatter = this.formatters.get(target.channelType);
      if (!formatter) {
        this.logger.warn('No formatter for channel type', { channelType: target.channelType });
        continue;
      }

      const adapter = this.adapters.get(target.channelType);
      if (!adapter) {
        this.logger.warn('Adapter unavailable for channel type', { channelType: target.channelType });
        continue;
      }

      const message = formatter.formatPhaseTransition(request, event);
      await this.deliverWithRetry(adapter, target, message, event.requestId);
    }

    // Log notification
    await this.db.insertActivityLog({
      request_id: event.requestId,
      event: 'notification_sent',
      phase: event.toPhase,
      details: JSON.stringify({ targets: targets.map(t => t.channelType) }),
    });
  }

  /**
   * Handle a blocker detected event.
   *
   * Notifies relevant channels that a blocker has been detected
   * for a request.
   */
  async onBlockerDetected(requestId: string, description: string): Promise<void> {
    const request = this.db.getRequest(requestId);
    if (!request) {
      this.logger.warn('Notification for unknown request', { requestId });
      return;
    }

    const config = this.parseNotificationConfig(request.notification_config);

    const enrichedEvent = { type: 'blocker_detected' as const, description };
    if (!this.shouldNotify(config.verbosity ?? 'summary', enrichedEvent)) {
      return;
    }

    const targets = this.resolveTargets(request, config, enrichedEvent);

    for (const target of targets) {
      const formatter = this.formatters.get(target.channelType);
      if (!formatter) {
        this.logger.warn('No formatter for channel type', { channelType: target.channelType });
        continue;
      }

      const adapter = this.adapters.get(target.channelType);
      if (!adapter) {
        this.logger.warn('Adapter unavailable for channel type', { channelType: target.channelType });
        continue;
      }

      // Use formatPhaseTransition with a synthetic event for blocker notifications
      const syntheticEvent: PhaseTransitionEvent = {
        requestId,
        fromPhase: request.current_phase,
        toPhase: request.current_phase,
        timestamp: new Date(),
        metadata: { blocker: description },
      };
      const message = formatter.formatPhaseTransition(request, syntheticEvent);
      await this.deliverWithRetry(adapter, target, message, requestId);
    }

    await this.db.insertActivityLog({
      request_id: requestId,
      event: 'blocker_detected',
      phase: request.current_phase,
      details: JSON.stringify({ description, targets: targets.map(t => t.channelType) }),
    });
  }

  /**
   * Handle a request completed event.
   *
   * Notifies relevant channels that a request has completed
   * with artifact links.
   */
  async onRequestCompleted(requestId: string, artifacts: ArtifactLinks): Promise<void> {
    const request = this.db.getRequest(requestId);
    if (!request) {
      this.logger.warn('Notification for unknown request', { requestId });
      return;
    }

    const config = this.parseNotificationConfig(request.notification_config);

    const enrichedEvent = { type: 'request_completed' as const, artifacts };
    if (!this.shouldNotify(config.verbosity ?? 'summary', enrichedEvent)) {
      return;
    }

    const targets = this.resolveTargets(request, config, enrichedEvent);

    for (const target of targets) {
      const formatter = this.formatters.get(target.channelType);
      if (!formatter) {
        this.logger.warn('No formatter for channel type', { channelType: target.channelType });
        continue;
      }

      const adapter = this.adapters.get(target.channelType);
      if (!adapter) {
        this.logger.warn('Adapter unavailable for channel type', { channelType: target.channelType });
        continue;
      }

      const syntheticEvent: PhaseTransitionEvent = {
        requestId,
        fromPhase: request.current_phase,
        toPhase: 'done',
        timestamp: new Date(),
        metadata: {
          artifactUrl: artifacts.codePr ?? artifacts.prdPr ?? artifacts.tddPr,
        },
      };
      const message = formatter.formatPhaseTransition(request, syntheticEvent);
      await this.deliverWithRetry(adapter, target, message, requestId);
    }

    await this.db.insertActivityLog({
      request_id: requestId,
      event: 'request_completed',
      phase: 'done',
      details: JSON.stringify({ artifacts, targets: targets.map(t => t.channelType) }),
    });
  }

  /**
   * Handle a request failed event.
   *
   * Notifies relevant channels that a request has failed.
   */
  async onRequestFailed(requestId: string, error: string): Promise<void> {
    const request = this.db.getRequest(requestId);
    if (!request) {
      this.logger.warn('Notification for unknown request', { requestId });
      return;
    }

    const config = this.parseNotificationConfig(request.notification_config);

    const enrichedEvent = { type: 'request_failed' as const, error };
    if (!this.shouldNotify(config.verbosity ?? 'summary', enrichedEvent)) {
      return;
    }

    const targets = this.resolveTargets(request, config, enrichedEvent);

    for (const target of targets) {
      const formatter = this.formatters.get(target.channelType);
      if (!formatter) {
        this.logger.warn('No formatter for channel type', { channelType: target.channelType });
        continue;
      }

      const adapter = this.adapters.get(target.channelType);
      if (!adapter) {
        this.logger.warn('Adapter unavailable for channel type', { channelType: target.channelType });
        continue;
      }

      const syntheticEvent: PhaseTransitionEvent = {
        requestId,
        fromPhase: request.current_phase,
        toPhase: 'failed',
        timestamp: new Date(),
        metadata: { blocker: error },
      };
      const message = formatter.formatPhaseTransition(request, syntheticEvent);
      await this.deliverWithRetry(adapter, target, message, requestId);
    }

    await this.db.insertActivityLog({
      request_id: requestId,
      event: 'request_failed',
      phase: 'failed',
      details: JSON.stringify({ error, targets: targets.map(t => t.channelType) }),
    });
  }

  // =========================================================================
  // Task 2: Verbosity filtering
  // =========================================================================

  /**
   * Determine whether a notification should be sent based on the
   * verbosity level and the event type.
   *
   * - `silent`:  never notify
   * - `summary`: only phase transitions, completion, failure, blockers
   * - `verbose`: everything (including sub-steps)
   * - `debug`:   everything (including agent reasoning)
   *
   * Default: `summary`
   */
  shouldNotify(verbosity: VerbosityLevel, event: { type?: string }): boolean {
    switch (verbosity) {
      case 'silent':
        return false;
      case 'summary':
        return this.isPhaseTransition(event);
      case 'verbose':
        return true;
      case 'debug':
        return true;
      default:
        return this.isPhaseTransition(event);
    }
  }

  /**
   * Check whether an event represents a major lifecycle event
   * (phase transition, completion, failure, or blocker).
   */
  private isPhaseTransition(event: { type?: string }): boolean {
    return (
      event.type === 'phase_transition' ||
      event.type === 'request_completed' ||
      event.type === 'request_failed' ||
      event.type === 'blocker_detected'
    );
  }

  // =========================================================================
  // Task 3: Notification routing
  // =========================================================================

  /**
   * Resolve notification targets from the request's notification config.
   *
   * If explicit routes are configured, use them (with optional phase
   * filtering). Otherwise, fall back to the request's source channel.
   *
   * Cross-channel routing: A request submitted via Slack can have routes
   * targeting Discord and Claude App channels. Each route specifies the
   * `channelType`, `platformChannelId`, and optional `threadId`.
   *
   * Phase filtering: Each route can optionally specify `events: string[]`
   * to only receive notifications for specific phases. If `events` is
   * null/undefined, all notifications are sent.
   */
  resolveTargets(
    request: RequestEntity,
    config: NotificationConfig,
    event?: { type?: string; toPhase?: string },
  ): MessageTarget[] {
    const allRoutes: NotificationRoute[] =
      config.routes && config.routes.length > 0
        ? config.routes
        : [{
            channelType: request.source_channel as ChannelType,
            platformChannelId: (config as NotificationConfigWithDefaults).sourcePlatformChannelId,
            threadId: (config as NotificationConfigWithDefaults).sourceThreadId,
          }];

    return allRoutes
      .filter(route => {
        if (!route.events || route.events.length === 0) return true;
        return route.events.includes(event?.toPhase ?? event?.type ?? '');
      })
      .map(route => ({
        channelType: route.channelType as ChannelType,
        platformChannelId: route.platformChannelId,
        threadId: route.threadId,
      }));
  }

  // =========================================================================
  // Task 4: Delivery with retry
  // =========================================================================

  /**
   * Deliver a message with exponential backoff retry.
   *
   * Backoff schedule: 1s, 2s, 4s (exponential, 3 retries max).
   *
   * Non-retryable failures are logged and abandoned immediately.
   *
   * Deduplication: SHA-256 hash of the serialized FormattedMessage.
   * If a delivery with the same request_id and payload_hash already
   * succeeded, skip.
   */
  async deliverWithRetry(
    adapter: IntakeAdapter,
    target: MessageTarget,
    message: FormattedMessage,
    requestId: string,
    maxRetries: number = 3,
  ): Promise<void> {
    // Deduplication check
    const payloadHash = this.computePayloadHash(message);
    const existing = this.db.findDuplicateDelivery(requestId, payloadHash);
    if (existing && existing.status === 'delivered') {
      this.logger.debug('Duplicate notification skipped', { requestId, payloadHash });
      return;
    }

    // Record delivery attempt
    const deliveryId = this.db.insertDelivery({
      request_id: requestId,
      channel_type: target.channelType,
      target: JSON.stringify(target),
      payload_hash: payloadHash,
      status: 'pending',
      attempts: 0,
      last_error: null,
      delivered_at: null,
    });

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const receipt = await adapter.sendMessage(target, message);

        if (receipt.success) {
          this.db.updateDeliveryStatus(deliveryId, 'delivered');
          return;
        }

        if (!receipt.retryable) {
          this.db.updateDeliveryStatus(deliveryId, 'failed', receipt.error);
          this.db.insertActivityLog({
            request_id: requestId,
            event: 'notification_failed',
            phase: null,
            details: JSON.stringify({ error: receipt.error, attempt }),
          });
          return;
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (attempt === maxRetries) {
          this.db.updateDeliveryStatus(deliveryId, 'failed', errorMessage);
          this.db.insertActivityLog({
            request_id: requestId,
            event: 'notification_failed',
            phase: null,
            details: JSON.stringify({ error: errorMessage, attempt }),
          });
          return;
        }
      }

      // Exponential backoff: 1s, 2s, 4s
      const backoffMs = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }

  /**
   * Compute a SHA-256 hash of the serialized FormattedMessage for
   * deduplication purposes.
   */
  computePayloadHash(message: FormattedMessage): string {
    const content = JSON.stringify(message);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Parse the notification_config JSON string from a request entity.
   * Returns a default config if parsing fails.
   */
  private parseNotificationConfig(configJson: string): NotificationConfig {
    try {
      const parsed = JSON.parse(configJson);
      return {
        verbosity: parsed.verbosity ?? 'summary',
        routes: parsed.routes ?? [],
        ...parsed,
      };
    } catch {
      return { verbosity: 'summary', routes: [] };
    }
  }
}

// ---------------------------------------------------------------------------
// Extended config type for default routing
// ---------------------------------------------------------------------------

/**
 * Extended notification config that includes optional source channel
 * identifiers for default routing when no explicit routes are configured.
 */
interface NotificationConfigWithDefaults extends NotificationConfig {
  sourcePlatformChannelId?: string;
  sourceThreadId?: string;
}
