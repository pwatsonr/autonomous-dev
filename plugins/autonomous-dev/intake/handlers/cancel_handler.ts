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

    // Perform cancellation — sync BOTH the db row and the on-disk state.json
    // (#551) so the daemon's select_request stops re-selecting this request.
    const { cancelRequest } = await import('../core/handoff_manager');
    const { syncTransition } = await import('./state_sync');
    await syncTransition(
      () => cancelRequest(requestId),
      () => this.db.updateRequest(requestId, { status: 'cancelled' }),
    );

    // BR-1/BR-3/BR-4: finalize cancel by writing the tombstone and clearing
    // the pending gate-decision file. Best-effort; MUST NOT throw.
    try {
      if (request.target_repo) {
        const pathModule = await import('path');
        const { buildRequestPath } = await import('../core/path_security');
        const { finalizeCancellation } = await import('./cancel_finalizer');
        let requestPath: string | null = null;
        try {
          requestPath = buildRequestPath(request.target_repo, requestId);
        } catch (err) {
          console.warn(JSON.stringify({
            event: 'cancel.finalize.skipped',
            requestId,
            reason: `path resolution failed: ${(err as Error).message}`,
          }));
        }
        if (requestPath) {
          const finalize = await finalizeCancellation({
            requestPath,
            repoBasename: pathModule.basename(request.target_repo),
            requestId,
          });
          for (const w of finalize.warnings) {
            console.warn(JSON.stringify({ event: 'cancel.finalize.warn', requestId, msg: w }));
          }
        }
      } else {
        console.warn(JSON.stringify({
          event: 'cancel.finalize.skipped',
          requestId,
          reason: 'target_repo missing',
        }));
      }
    } catch (err) {
      // Truly-defensive outer catch — finalization is best-effort. Never fail
      // the cancel because of a finalizer error.
      console.warn(JSON.stringify({
        event: 'cancel.finalize.error',
        requestId,
        msg: (err as Error).message,
      }));
    }

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
