/**
 * FeedbackHandler: records user feedback on an active request.
 *
 * Validates state (must be `active`).  Records the message via
 * `ConversationManager.receiveFeedback` (implemented as a direct
 * conversation_messages insert).  Emits `feedback_received` event.
 *
 * Implements SPEC-008-1-06 FeedbackHandler specification.
 *
 * @module feedback_handler
 */

import * as crypto from 'crypto';

import type {
  AuthzContext,
  CommandHandler,
  CommandResult,
  IncomingCommand,
} from '../adapters/adapter_interface';
import type { Repository } from '../db/repository';
import type { IntakeEventEmitter } from '../core/intake_router';
import { validateStateTransition } from './state_machine';

// ---------------------------------------------------------------------------
// FeedbackHandler
// ---------------------------------------------------------------------------

export class FeedbackHandler implements CommandHandler {
  constructor(
    private readonly db: Repository,
    private readonly emitter: IntakeEventEmitter,
  ) {}

  isQueryCommand(): boolean {
    return false;
  }

  buildAuthzContext(command: IncomingCommand): AuthzContext {
    const requestId = command.args[0];
    if (requestId) {
      const request = this.db.getRequest(requestId);
      return {
        requestId,
        targetRepo: request?.target_repo ?? undefined,
      };
    }
    return {};
  }

  async execute(command: IncomingCommand, userId: string): Promise<CommandResult> {
    const requestId = command.args[0];
    const message = command.args.slice(1).join(' ').trim();

    if (!requestId) {
      return {
        success: false,
        error: 'Missing required argument: request-id',
        errorCode: 'VALIDATION_ERROR',
      };
    }

    if (!message) {
      return {
        success: false,
        error: 'Missing required argument: feedback message',
        errorCode: 'VALIDATION_ERROR',
      };
    }

    const request = this.db.getRequest(requestId);
    if (!request) {
      return {
        success: false,
        error: `Request '${requestId}' not found.`,
        errorCode: 'NOT_FOUND',
      };
    }

    // Validate state transition
    validateStateTransition(request.status, 'feedback');

    // Record feedback as a conversation message
    const messageId = this.db.insertConversationMessage({
      message_id: crypto.randomUUID(),
      request_id: requestId,
      direction: 'inbound',
      channel: 'feedback',
      content: message,
      message_type: 'feedback',
      responded: 0,
      timeout_at: null,
      thread_id: null,
    });

    this.db.insertActivityLog({
      request_id: requestId,
      event: 'feedback_received',
      phase: request.current_phase,
      details: JSON.stringify({ userId, messageId, messageLength: message.length }),
    });

    this.emitter.emit('feedback_received', {
      requestId,
      userId,
      messageId,
    });

    return {
      success: true,
      data: {
        requestId,
        messageId,
        recorded: true,
      },
    };
  }
}
