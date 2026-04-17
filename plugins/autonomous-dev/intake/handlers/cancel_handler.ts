/**
 * CancelHandler: cancels a request with confirmation flow.
 *
 * First call returns `{ confirmationRequired: true }`.  Second call with
 * `args[1] === 'CONFIRM'` performs the cancellation.  Validates state
 * (must be `queued`, `active`, or `paused`).
 *
 * Implements SPEC-008-1-06 CancelHandler specification.
 *
 * @module cancel_handler
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
// CancelHandler
// ---------------------------------------------------------------------------

export class CancelHandler implements CommandHandler {
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
    validateStateTransition(request.status, 'cancel');

    // Check for confirmation
    const confirmation = command.args[1];
    if (confirmation !== 'CONFIRM') {
      return {
        success: true,
        data: {
          confirmationRequired: true,
          message: `Are you sure you want to cancel request '${requestId}'? Call again with CONFIRM to proceed.`,
          requestId,
          currentStatus: request.status,
        },
      };
    }

    // Perform cancellation
    this.db.updateRequest(requestId, { status: 'cancelled' });

    this.db.insertActivityLog({
      request_id: requestId,
      event: 'request_cancelled',
      phase: request.current_phase,
      details: JSON.stringify({ cancelledBy: userId, previousStatus: request.status }),
    });

    this.emitter.emit('request_cancelled', {
      requestId,
      userId,
      previousStatus: request.status,
    });

    return {
      success: true,
      data: {
        requestId,
        status: 'cancelled',
        previousStatus: request.status,
      },
    };
  }
}
