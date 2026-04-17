/**
 * ResumeHandler: resumes a paused or failed request.
 *
 * Validates state (must be `paused` or `failed`).
 * - From `paused`: sets status back to `active`.
 * - From `failed`: sets status back to `queued`.
 * Emits `request_resumed` event.
 *
 * Implements SPEC-008-1-06 ResumeHandler specification.
 *
 * @module resume_handler
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
// ResumeHandler
// ---------------------------------------------------------------------------

export class ResumeHandler implements CommandHandler {
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
    validateStateTransition(request.status, 'resume');

    // Determine target status based on current state
    const newStatus = request.status === 'paused' ? 'active' : 'queued';

    this.db.updateRequest(requestId, {
      status: newStatus as 'active' | 'queued',
      // Clear paused_at_phase when resuming from paused
      ...(request.status === 'paused' ? { paused_at_phase: null } : {}),
    });

    this.db.insertActivityLog({
      request_id: requestId,
      event: 'request_resumed',
      phase: request.current_phase,
      details: JSON.stringify({
        resumedBy: userId,
        previousStatus: request.status,
        newStatus,
      }),
    });

    this.emitter.emit('request_resumed', {
      requestId,
      userId,
      previousStatus: request.status,
      newStatus,
    });

    return {
      success: true,
      data: {
        requestId,
        status: newStatus,
        previousStatus: request.status,
      },
    };
  }
}
