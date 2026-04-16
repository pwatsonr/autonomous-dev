/**
 * StatusHandler: fetches full status for a request by ID.
 *
 * Returns the complete status object including phase, progress, blocker,
 * artifact links, and age.  Returns `NOT_FOUND` for missing requests.
 *
 * Implements SPEC-008-1-06 StatusHandler specification.
 *
 * @module status_handler
 */

import type {
  AuthzContext,
  CommandHandler,
  CommandResult,
  IncomingCommand,
} from '../adapters/adapter_interface';
import type { Repository } from '../db/repository';

// ---------------------------------------------------------------------------
// StatusHandler
// ---------------------------------------------------------------------------

export class StatusHandler implements CommandHandler {
  constructor(private readonly db: Repository) {}

  isQueryCommand(): boolean {
    return true;
  }

  buildAuthzContext(_command: IncomingCommand): AuthzContext {
    // Viewer-allowed; no request-scoped context needed for authz.
    return {};
  }

  async execute(command: IncomingCommand, _userId: string): Promise<CommandResult> {
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

    const now = Date.now();
    const createdAt = new Date(request.created_at).getTime();
    const ageMs = now - createdAt;

    return {
      success: true,
      data: {
        requestId: request.request_id,
        title: request.title,
        description: request.description,
        priority: request.priority,
        status: request.status,
        currentPhase: request.current_phase,
        phaseProgress: request.phase_progress,
        blocker: request.blocker,
        targetRepo: request.target_repo,
        requesterId: request.requester_id,
        sourceChannel: request.source_channel,
        deadline: request.deadline,
        pausedAtPhase: request.paused_at_phase,
        createdAt: request.created_at,
        updatedAt: request.updated_at,
        ageMs,
      },
    };
  }
}
