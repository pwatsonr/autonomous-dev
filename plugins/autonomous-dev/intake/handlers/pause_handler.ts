/**
 * PauseHandler: pauses an active request.
 *
 * Validates state (must be `active`).  Sets status to `paused` and
 * records `paused_at_phase`.  Emits `request_paused` event.
 *
 * Implements SPEC-008-1-06 PauseHandler specification.
 *
 * @module pause_handler
 */

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
// PauseHandler
// ---------------------------------------------------------------------------

export class PauseHandler implements CommandHandler {
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

    if (!requestId) {
      return {
        success: false,
        error: 'Missing required argument: request-id',
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
    validateStateTransition(request.status, 'pause');

    // Pause the request
    this.db.updateRequest(requestId, {
      status: 'paused',
      paused_at_phase: request.current_phase,
    });

    this.db.insertActivityLog({
      request_id: requestId,
      event: 'request_paused',
      phase: request.current_phase,
      details: JSON.stringify({ pausedBy: userId, pausedAtPhase: request.current_phase }),
    });

    this.emitter.emit('request_paused', {
      requestId,
      userId,
      pausedAtPhase: request.current_phase,
    });

    return {
      success: true,
      data: {
        requestId,
        status: 'paused',
        pausedAtPhase: request.current_phase,
      },
    };
  }
}
