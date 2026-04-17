/**
 * PriorityHandler: changes the priority of a queued request.
 *
 * Validates state (must be `queued`).  Validates the priority level enum.
 * Updates priority, recalculates queue position, and emits
 * `priority_changed` event.
 *
 * Implements SPEC-008-1-06 PriorityHandler specification.
 *
 * @module priority_handler
 */

import type {
  AuthzContext,
  CommandHandler,
  CommandResult,
  IncomingCommand,
  Priority,
} from '../adapters/adapter_interface';
import type { Repository } from '../db/repository';
import type { IntakeEventEmitter } from '../core/intake_router';
import { validateStateTransition } from './state_machine';

// ---------------------------------------------------------------------------
// Valid priority values
// ---------------------------------------------------------------------------

const VALID_PRIORITIES: Set<string> = new Set(['high', 'normal', 'low']);

// ---------------------------------------------------------------------------
// PriorityHandler
// ---------------------------------------------------------------------------

export class PriorityHandler implements CommandHandler {
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
    const level = command.args[1];

    if (!requestId) {
      return {
        success: false,
        error: 'Missing required argument: request-id',
        errorCode: 'VALIDATION_ERROR',
      };
    }

    if (!level) {
      return {
        success: false,
        error: 'Missing required argument: priority level (high, normal, low)',
        errorCode: 'VALIDATION_ERROR',
      };
    }

    if (!VALID_PRIORITIES.has(level)) {
      return {
        success: false,
        error: `Invalid priority level '${level}'. Must be one of: high, normal, low.`,
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
    validateStateTransition(request.status, 'priority');

    const previousPriority = request.priority;

    // Update priority
    this.db.updateRequest(requestId, { priority: level as Priority });

    // Recalculate queue position
    const newPosition = this.db.getQueuePosition(requestId);

    this.db.insertActivityLog({
      request_id: requestId,
      event: 'priority_changed',
      phase: request.current_phase,
      details: JSON.stringify({
        changedBy: userId,
        previousPriority,
        newPriority: level,
        newPosition,
      }),
    });

    this.emitter.emit('priority_changed', {
      requestId,
      userId,
      previousPriority,
      newPriority: level,
      newPosition,
    });

    return {
      success: true,
      data: {
        requestId,
        priority: level,
        previousPriority,
        position: newPosition,
      },
    };
  }
}
