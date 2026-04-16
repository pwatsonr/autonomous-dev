/**
 * ConversationManager -- Prompt-and-Wait Conversation Flow.
 *
 * Tracks all human-system exchanges per request. Sends structured prompts
 * via channel adapters, records inbound/outbound messages, enforces the
 * 5-round clarification limit, and accepts unsolicited feedback.
 *
 * Key behaviors:
 * - **promptAndWait**: Records an outbound message with `timeout_at`, sends
 *   the prompt through the correct adapter, and either records the inbound
 *   response or delegates to the `TimeoutHandler` on timeout.
 * - **receiveFeedback**: Records unsolicited feedback from a user, emits a
 *   `feedback_received` event, and logs the activity.
 * - **Target resolution**: Uses the request's `notification_config` routes
 *   to determine the correct adapter and thread for delivery. Falls back to
 *   the request's source channel if no routes are configured.
 *
 * Implements SPEC-008-5-03, Task 7.
 *
 * @module conversation_manager
 */

import type { Repository } from '../db/repository';
import type {
  ChannelType,
  IntakeAdapter,
  MessageTarget,
  NotificationConfig,
  StructuredPrompt,
  UserResponse,
} from '../adapters/adapter_interface';
import type { TypedEventBus } from '../events/event_bus';
import type { RequestEntity } from '../db/repository';
import { TimeoutHandler, ClarificationLimitError } from './timeout_handler';

// Re-export error classes for convenience
export { ClarificationLimitError } from './timeout_handler';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of clarification rounds allowed per request. */
const MAX_CLARIFICATION_ROUNDS = 5;

// ---------------------------------------------------------------------------
// ConversationManager
// ---------------------------------------------------------------------------

/**
 * Manages bidirectional conversation flow between the system and human users.
 *
 * Each conversation is scoped to a request ID and may span multiple rounds
 * of clarification. Messages are persisted in the `conversation_messages`
 * table for audit and context-injection purposes.
 */
export class ConversationManager {
  constructor(
    private db: Repository,
    private adapters: Map<ChannelType, IntakeAdapter>,
    private timeoutHandler: TimeoutHandler,
    private eventBus: TypedEventBus,
  ) {}

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Send a structured prompt to the user and wait for their response.
   *
   * Records the outbound message (with timeout), sends it via the appropriate
   * adapter, and either records the user's response or delegates to the
   * timeout handler.
   *
   * @param requestId - The request this prompt is associated with.
   * @param prompt    - The structured prompt to send.
   * @returns The user's response.
   * @throws {ClarificationLimitError} If 5 clarification rounds have already been sent.
   * @throws {TimeoutError} If the user does not respond within the timeout window.
   * @throws {Error} If the request is not found or no adapter is available.
   */
  async promptAndWait(
    requestId: string,
    prompt: StructuredPrompt,
  ): Promise<UserResponse> {
    const request = await this.db.getRequest(requestId);
    if (!request) throw new Error(`Request ${requestId} not found`);

    // Check clarification round limit
    const roundCount = await this.getClarificationRoundCount(requestId);
    if (roundCount >= MAX_CLARIFICATION_ROUNDS) {
      throw new ClarificationLimitError(
        `Maximum clarification rounds (${MAX_CLARIFICATION_ROUNDS}) reached for ${requestId}. ` +
          'Please submit a more detailed description.',
      );
    }

    // Record outbound message
    const timeoutAt = new Date(Date.now() + prompt.timeoutSeconds * 1000);
    const messageId = await this.db.insertConversationMessage({
      message_id: '',
      request_id: requestId,
      direction: 'outbound',
      channel: request.source_channel,
      content: prompt.content,
      message_type: prompt.promptType,
      responded: 0,
      timeout_at: timeoutAt.toISOString(),
      thread_id: this.getThreadId(request),
    });

    // Send via the appropriate adapter
    const target = this.resolveTarget(request);
    const adapter = this.adapters.get(target.channelType);
    if (!adapter) {
      throw new Error(`No adapter available for channel ${target.channelType}`);
    }

    const response = await adapter.promptUser(target, prompt);

    // Handle timeout
    if ('kind' in response && response.kind === 'timeout') {
      return this.timeoutHandler.handle(requestId, messageId);
    }

    // Cast to UserResponse (type narrowing confirmed it's not TimeoutExpired)
    const userResponse = response as UserResponse;

    // Record inbound response
    await this.db.insertConversationMessage({
      message_id: '',
      request_id: requestId,
      direction: 'inbound',
      channel: request.source_channel,
      content: userResponse.content,
      message_type: 'feedback',
      responded: 1,
      timeout_at: null,
      thread_id: this.getThreadId(request),
    });

    // Mark the outbound message as responded
    await this.db.markMessageResponded(messageId);

    return userResponse;
  }

  /**
   * Record unsolicited feedback from a user.
   *
   * Persists the feedback as an inbound conversation message, emits a
   * `feedback_received` event on the event bus for pipeline context
   * injection, and logs the activity.
   *
   * @param requestId - The request the feedback relates to.
   * @param userId    - The platform user ID of the person providing feedback.
   * @param message   - The feedback content.
   * @throws {Error} If the request is not found.
   */
  async receiveFeedback(
    requestId: string,
    userId: string,
    message: string,
  ): Promise<void> {
    const request = await this.db.getRequest(requestId);
    if (!request) throw new Error(`Request ${requestId} not found`);

    await this.db.insertConversationMessage({
      message_id: '',
      request_id: requestId,
      direction: 'inbound',
      channel: 'feedback',
      content: message,
      message_type: 'feedback',
      responded: 1,
      timeout_at: null,
      thread_id: null,
    });

    // Emit event for pipeline context injection
    await this.eventBus.emit('intake', {
      type: 'feedback_received',
      requestId,
      userId,
      content: message,
    });

    await this.db.insertActivityLog({
      request_id: requestId,
      event: 'feedback_received',
      phase: null,
      details: JSON.stringify({ userId, contentLength: message.length }),
    });
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Count the number of outbound clarifying_question messages for a request.
   */
  private async getClarificationRoundCount(requestId: string): Promise<number> {
    const messages = await this.db.getConversationMessages(requestId);
    return messages.filter(
      (m) => m.direction === 'outbound' && m.message_type === 'clarifying_question',
    ).length;
  }

  /**
   * Resolve the delivery target from the request's notification configuration.
   *
   * If routes are configured, uses the first route. Otherwise falls back to
   * the request's source channel and requester ID.
   */
  private resolveTarget(request: RequestEntity): MessageTarget {
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

  /**
   * Extract the thread ID from the request's notification configuration.
   */
  private getThreadId(request: RequestEntity): string | null {
    const config: NotificationConfig = JSON.parse(request.notification_config);
    return config.routes?.[0]?.threadId ?? null;
  }
}
