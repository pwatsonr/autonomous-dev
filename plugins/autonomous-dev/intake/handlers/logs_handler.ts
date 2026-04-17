/**
 * LogsHandler: fetches activity log entries for a request.
 *
 * Default: last 50 entries.  `--all` flag: no limit.
 * Returns a formatted log array.
 *
 * Implements SPEC-008-1-06 LogsHandler specification.
 *
 * @module logs_handler
 */

import type {
  AuthzContext,
  CommandHandler,
  CommandResult,
  IncomingCommand,
} from '../adapters/adapter_interface';
import type { Repository } from '../db/repository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of log entries returned. */
const DEFAULT_LOG_LIMIT = 50;

// ---------------------------------------------------------------------------
// LogsHandler
// ---------------------------------------------------------------------------

export class LogsHandler implements CommandHandler {
  constructor(private readonly db: Repository) {}

  isQueryCommand(): boolean {
    return true;
  }

  buildAuthzContext(_command: IncomingCommand): AuthzContext {
    // Viewer-allowed; no request-scoped context needed.
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

    // Check that the request exists
    const request = this.db.getRequest(requestId);
    if (!request) {
      return {
        success: false,
        error: `Request '${requestId}' not found.`,
        errorCode: 'NOT_FOUND',
      };
    }

    // Determine limit
    const showAll = command.flags['--all'] === true || command.flags['all'] === true;
    const limit = showAll ? undefined : DEFAULT_LOG_LIMIT;

    const entries = this.db.getActivityLog(requestId, limit);

    return {
      success: true,
      data: {
        requestId,
        entries: entries.map((entry) => ({
          logId: entry.log_id,
          event: entry.event,
          phase: entry.phase,
          details: entry.details,
          createdAt: entry.created_at,
        })),
        totalReturned: entries.length,
        limited: !showAll,
      },
    };
  }
}
