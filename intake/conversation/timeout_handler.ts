/**
 * TimeoutHandler -- Configurable timeout actions for human response timeouts.
 *
 * Executes one of three configurable timeout actions when a human does not
 * respond to a structured prompt within the allowed window:
 *
 * - **pause**: Sets the request status to `paused`, emits `request_paused`,
 *   and notifies the requester.
 * - **default**: Emits a `human_response` event with `TIMEOUT_DEFAULT` content,
 *   allowing the pipeline to proceed with a conservative assumption.
 * - **escalate**: Notifies a configured escalation target with the full
 *   conversation history. Falls back to `pause` if no target is configured.
 *
 * After executing the action, always throws `TimeoutError` so callers know the
 * prompt was not answered.
 *
 * Implements SPEC-008-5-03, Task 8.
 *
 * @module timeout_handler
 */

import type { Repository, RequestEntity } from '../db/repository';
import type {
  ChannelType,
  IntakeAdapter,
  FormattedMessage,
  MessageTarget,
  NotificationConfig,
} from '../adapters/adapter_interface';
import type { NotificationFormatter } from '../notifications/formatters/cli_formatter';
import type { TypedEventBus } from '../events/event_bus';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Logger interface for structured logging within the timeout handler.
 */
export interface TimeoutHandlerLogger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default no-op logger used when no logger is provided.
 */
const nullLogger: TimeoutHandlerLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
};

// ---------------------------------------------------------------------------
// Timeout configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for timeout behavior.
 */
export interface TimeoutConfig {
  /** The action to take when a human response times out. */
  human_response_action: 'pause' | 'default' | 'escalate';
  /** How long to wait (in seconds) before timing out. */
  timeout_seconds: number;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown after a timeout action has been executed.
 *
 * Signals to the caller that the prompt was not answered and the configured
 * timeout action has already been taken (pause, default, or escalate).
 */
export class TimeoutError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly messageId: string,
  ) {
    super(`Human response timeout for request ${requestId}`);
    this.name = 'TimeoutError';
  }
}

/**
 * Thrown when the maximum clarification round limit is reached.
 */
export class ClarificationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClarificationLimitError';
  }
}

// ---------------------------------------------------------------------------
// TimeoutHandler
// ---------------------------------------------------------------------------

/**
 * Handles human response timeouts by executing a configurable action and
 * then throwing `TimeoutError`.
 *
 * The handler coordinates between the database (state updates), the event
 * bus (event emission), and adapters (user/escalation notifications).
 */
export class TimeoutHandler {
  private logger: TimeoutHandlerLogger;

  constructor(
    private db: Repository,
    private adapters: Map<ChannelType, IntakeAdapter>,
    private formatters: Map<ChannelType, NotificationFormatter>,
    private eventBus: TypedEventBus,
    logger: TimeoutHandlerLogger = nullLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Execute the configured timeout action, then throw `TimeoutError`.
   *
   * @param requestId - The request whose prompt timed out.
   * @param messageId - The outbound message that was not responded to.
   * @throws {TimeoutError} Always thrown after the action executes.
   */
  async handle(requestId: string, messageId: string): Promise<never> {
    const request = await this.db.getRequest(requestId);
    if (!request) {
      throw new TimeoutError(requestId, messageId);
    }

    const config = await this.getTimeoutConfig();

    // Log the timeout event
    await this.db.insertActivityLog({
      request_id: requestId,
      event: 'human_response_timeout',
      phase: request.current_phase ?? null,
      details: JSON.stringify({ messageId, action: config.human_response_action }),
    });

    switch (config.human_response_action) {
      case 'pause':
        await this.handlePause(request);
        break;
      case 'default':
        await this.handleDefault(request);
        break;
      case 'escalate':
        await this.handleEscalate(request, requestId);
        break;
    }

    throw new TimeoutError(requestId, messageId);
  }

  // -------------------------------------------------------------------------
  // Timeout action handlers
  // -------------------------------------------------------------------------

  /**
   * Pause the request: update status, emit event, notify requester.
   */
  private async handlePause(request: RequestEntity): Promise<void> {
    await this.db.updateRequest(request.request_id, {
      status: 'paused',
      paused_at_phase: request.current_phase,
    });

    await this.eventBus.emit('intake', {
      type: 'request_paused',
      requestId: request.request_id,
    });

    await this.notifyRequester(
      request,
      'Your request has been paused because a response was not received within the timeout window. ' +
        'Use `/resume` when ready.',
    );
  }

  /**
   * Proceed with a conservative default: emit a synthetic human_response
   * event and notify the requester.
   */
  private async handleDefault(request: RequestEntity): Promise<void> {
    await this.eventBus.emit('intake', {
      type: 'human_response',
      requestId: request.request_id,
      messageId: '',
      response: {
        responderId: 'system',
        content: 'TIMEOUT_DEFAULT',
        timestamp: new Date(),
      },
    });

    await this.notifyRequester(
      request,
      'No response received within the timeout window. Proceeding with a conservative default. ' +
        'The assumption has been noted in the request log.',
    );
  }

  /**
   * Escalate to a configured target. Falls back to pause if no escalation
   * target is available.
   */
  private async handleEscalate(
    request: RequestEntity,
    requestId: string,
  ): Promise<void> {
    const escalationTarget = await this.db.getEscalationTarget(requestId);

    if (!escalationTarget) {
      // Fallback to pause if no escalation target configured
      this.logger.warn('No escalation target configured, falling back to pause', {
        requestId,
      });
      await this.handlePause(request);
      return;
    }

    // Get full conversation history for context
    const conversationHistory = await this.db.getConversationMessages(requestId);
    const historyText = conversationHistory
      .map((m) => `[${m.direction}] ${m.content}`)
      .join('\n');

    await this.notifyTarget(
      escalationTarget,
      request,
      `Request ${requestId} requires input. The original requester did not respond within the timeout window.\n\n` +
        `*Conversation History:*\n${historyText}`,
    );
  }

  // -------------------------------------------------------------------------
  // Notification helpers
  // -------------------------------------------------------------------------

  /**
   * Notify the request's original requester with a message.
   */
  private async notifyRequester(
    request: RequestEntity,
    message: string,
  ): Promise<void> {
    const target = this.resolveRequesterTarget(request);
    const adapter = this.adapters.get(target.channelType);
    if (!adapter) return;

    const formatter = this.formatters.get(target.channelType);
    if (!formatter) return;

    const formatted: FormattedMessage = {
      channelType: target.channelType,
      payload: message,
      fallbackText: message,
    };

    await adapter.sendMessage(target, formatted);
  }

  /**
   * Notify an escalation target with a message.
   */
  async notifyTarget(
    target: MessageTarget,
    _request: RequestEntity,
    message: string,
  ): Promise<void> {
    const adapter = this.adapters.get(target.channelType);
    if (!adapter) return;

    const formatted: FormattedMessage = {
      channelType: target.channelType,
      payload: message,
      fallbackText: message,
    };

    await adapter.sendMessage(target, formatted);
  }

  // -------------------------------------------------------------------------
  // Target resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the requester's notification target from the request entity.
   */
  private resolveRequesterTarget(request: RequestEntity): MessageTarget {
    const config: NotificationConfig = JSON.parse(request.notification_config);
    if (config.routes && config.routes.length > 0) {
      const primaryRoute = config.routes[0];
      return {
        channelType: primaryRoute.channelType as ChannelType,
        platformChannelId: primaryRoute.platformChannelId,
        threadId: primaryRoute.threadId,
      };
    }
    return {
      channelType: request.source_channel as ChannelType,
      userId: request.requester_id,
    };
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Load timeout configuration.
   *
   * Uses an in-memory override if set (via `setTimeoutConfig`), otherwise
   * returns sensible defaults. Production implementations may read from
   * `intake-config.yaml`.
   */
  async getTimeoutConfig(): Promise<TimeoutConfig> {
    if (this._overrideConfig) {
      return this._overrideConfig;
    }

    // Default configuration
    return {
      human_response_action: 'pause',
      timeout_seconds: 3600, // 1 hour
    };
  }

  /**
   * Set the timeout configuration for testing or dynamic reconfiguration.
   *
   * @internal Exposed primarily for unit tests.
   */
  setTimeoutConfig(config: TimeoutConfig): void {
    this._overrideConfig = config;
  }

  private _overrideConfig: TimeoutConfig | null = null;
}
