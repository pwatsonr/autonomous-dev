/**
 * KillHandler: emergency stop -- pauses ALL active requests.
 *
 * Requires `admin` role.  First call returns a confirmation prompt
 * (`{ confirmationRequired: true, message: 'Type CONFIRM to proceed' }`).
 * On confirmation (`args[0] === 'CONFIRM'`), pauses all active requests
 * and emits `kill_all` event.
 *
 * Implements SPEC-008-1-06 KillHandler specification.
 *
 * @module kill_handler
 */

import type {
  AuthzContext,
  CommandHandler,
  CommandResult,
  IncomingCommand,
} from '../adapters/adapter_interface';
import type { Repository } from '../db/repository';
import type { IntakeEventEmitter } from '../core/intake_router';

// ---------------------------------------------------------------------------
// Internal type for raw DB access
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
interface DatabaseLike {
  prepare(sql: string): { all(...args: any[]): any[]; run(...args: any[]): any };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// KillHandler
// ---------------------------------------------------------------------------

export class KillHandler implements CommandHandler {
  constructor(
    private readonly db: Repository,
    private readonly emitter: IntakeEventEmitter,
  ) {}

  isQueryCommand(): boolean {
    return false;
  }

  buildAuthzContext(_command: IncomingCommand): AuthzContext {
    // Admin-only, no request scope.
    return {};
  }

  async execute(command: IncomingCommand, userId: string): Promise<CommandResult> {
    // Check for confirmation
    const confirmation = command.args[0];
    if (confirmation !== 'CONFIRM') {
      return {
        success: true,
        data: {
          confirmationRequired: true,
          message: 'Type CONFIRM to proceed',
        },
      };
    }

    // Pause all active requests
    const rawDb = (this.db as unknown as { db: DatabaseLike }).db;

    const activeRequests = rawDb
      .prepare("SELECT request_id, current_phase FROM requests WHERE status = 'active'")
      .all() as Array<{ request_id: string; current_phase: string }>;

    for (const req of activeRequests) {
      this.db.updateRequest(req.request_id, {
        status: 'paused',
        paused_at_phase: req.current_phase,
      });

      this.db.insertActivityLog({
        request_id: req.request_id,
        event: 'kill_all_paused',
        phase: req.current_phase,
        details: JSON.stringify({ killedBy: userId }),
      });
    }

    this.emitter.emit('kill_all', {
      userId,
      pausedCount: activeRequests.length,
      requestIds: activeRequests.map((r) => r.request_id),
    });

    return {
      success: true,
      data: {
        killed: true,
        pausedCount: activeRequests.length,
        requestIds: activeRequests.map((r) => r.request_id),
      },
    };
  }
}
