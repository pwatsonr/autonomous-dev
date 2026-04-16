/**
 * ListHandler: queries active requests with optional filters.
 *
 * Supports `--priority` and `--status` flags for filtering.  Returns a
 * sorted array of requests along with the total queue depth.
 *
 * Implements SPEC-008-1-06 ListHandler specification.
 *
 * @module list_handler
 */

import type {
  AuthzContext,
  CommandHandler,
  CommandResult,
  IncomingCommand,
  Priority,
  RequestStatus,
} from '../adapters/adapter_interface';
import type { Repository, RequestEntity } from '../db/repository';

// ---------------------------------------------------------------------------
// ListHandler
// ---------------------------------------------------------------------------

export class ListHandler implements CommandHandler {
  constructor(private readonly db: Repository) {}

  isQueryCommand(): boolean {
    return true;
  }

  buildAuthzContext(_command: IncomingCommand): AuthzContext {
    // Viewer-allowed; no request-scoped context needed.
    return {};
  }

  async execute(command: IncomingCommand, _userId: string): Promise<CommandResult> {
    const priorityFilter =
      typeof command.flags['--priority'] === 'string'
        ? command.flags['--priority']
        : typeof command.flags['priority'] === 'string'
          ? command.flags['priority']
          : undefined;

    const statusFilter =
      typeof command.flags['--status'] === 'string'
        ? command.flags['--status']
        : typeof command.flags['status'] === 'string'
          ? command.flags['status']
          : undefined;

    // Query active requests (non-terminal states by default)
    const activeStatuses: RequestStatus[] = ['queued', 'active', 'paused', 'failed'];
    const filterStatuses: RequestStatus[] = statusFilter
      ? [statusFilter as RequestStatus]
      : activeStatuses;

    // Use countRequestsByState for queue depth
    const stateCounts = this.db.countRequestsByState();
    const queueDepth = stateCounts.queued;

    // Build results by querying for each status
    const results: Array<{
      requestId: string;
      title: string;
      priority: Priority;
      status: RequestStatus;
      createdAt: string;
      targetRepo: string | null;
    }> = [];

    // We need to query requests matching the filters.
    // The Repository doesn't have a generic list method, so we use
    // a transaction to collect requests from the DB directly.
    // For now, we'll use the underlying db to query.
    for (const status of filterStatuses) {
      const rows = (this.db as unknown as { db: DatabaseLike }).db
        .prepare(
          `SELECT request_id, title, priority, status, created_at, target_repo
           FROM requests
           WHERE status = ?
           ${priorityFilter ? 'AND priority = ?' : ''}
           ORDER BY
             CASE priority
               WHEN 'high'   THEN 0
               WHEN 'normal' THEN 1
               WHEN 'low'    THEN 2
             END ASC,
             created_at ASC`,
        )
        .all(
          ...(priorityFilter ? [status, priorityFilter] : [status]),
        ) as Array<{
        request_id: string;
        title: string;
        priority: Priority;
        status: RequestStatus;
        created_at: string;
        target_repo: string | null;
      }>;

      for (const row of rows) {
        results.push({
          requestId: row.request_id,
          title: row.title,
          priority: row.priority,
          status: row.status,
          createdAt: row.created_at,
          targetRepo: row.target_repo,
        });
      }
    }

    // Sort results: priority order then created_at
    const priorityOrder: Record<string, number> = { high: 0, normal: 1, low: 2 };
    results.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 1;
      const pb = priorityOrder[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.createdAt.localeCompare(b.createdAt);
    });

    return {
      success: true,
      data: {
        requests: results,
        totalCount: results.length,
        queueDepth,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Internal type for raw DB access
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
interface DatabaseLike {
  prepare(sql: string): { all(...args: any[]): any[] };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
