/**
 * Graceful shutdown framework for the intake layer.
 *
 * Registers SIGTERM and SIGINT handlers that execute an ordered shutdown
 * sequence: stop background timers, signal adapters to stop accepting
 * commands, remove event bus listeners, checkpoint the WAL, then exit.
 *
 * Implements SPEC-008-1-07, Task 15.
 *
 * @module shutdown
 */

import type { IntakeAdapter } from '../adapters/adapter_interface';
import type { TypedEventBus } from '../events/event_bus';
import type { Repository } from '../db/repository';
import type { StarvationMonitor } from '../queue/starvation_monitor';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Logger interface for shutdown logging.
 */
export interface ShutdownLogger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default no-op logger used when no logger is provided.
 */
const nullLogger: ShutdownLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
};

// ---------------------------------------------------------------------------
// DigestScheduler interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the digest scheduler.
 *
 * The digest scheduler is optional; when present, its `stop()` method
 * is called during shutdown to halt periodic digest emission.
 */
export interface DigestScheduler {
  stop(): void;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Set up graceful shutdown handlers for SIGTERM and SIGINT.
 *
 * Shutdown order:
 * 1. Stop background timers (starvation monitor, digest scheduler).
 * 2. Signal all adapters to stop accepting new commands and wait for
 *    in-flight commands to complete (via `Promise.allSettled`).
 * 3. Remove all event bus listeners.
 * 4. Checkpoint the WAL to flush pending writes.
 * 5. Log completion and exit.
 *
 * Re-entry guard: if a second signal arrives while shutdown is in progress,
 * it is ignored.
 *
 * @param adapters          - All active intake adapters.
 * @param eventBus          - The typed event bus instance.
 * @param db                - The repository (for WAL checkpoint).
 * @param starvationMonitor - The starvation monitor (to stop periodic checks).
 * @param logger            - Optional logger for shutdown progress.
 * @param digestScheduler   - Optional digest scheduler (to stop periodic digests).
 * @param exitFn            - Optional exit function (defaults to `process.exit`).
 *                            Injected for testability.
 */
export function setupGracefulShutdown(
  adapters: IntakeAdapter[],
  eventBus: TypedEventBus,
  db: Repository,
  starvationMonitor: StarvationMonitor,
  logger: ShutdownLogger = nullLogger,
  digestScheduler?: DigestScheduler,
  exitFn: (code: number) => void = (code) => process.exit(code),
): () => Promise<void> {
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    // Re-entry guard: prevent double-shutdown from concurrent signals.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutdown signal received, beginning graceful shutdown');

    // 1. Stop background timers
    try {
      starvationMonitor.stop();
    } catch (err: unknown) {
      logger.error('Error stopping starvation monitor', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (digestScheduler) {
      try {
        digestScheduler.stop();
      } catch (err: unknown) {
        logger.error('Error stopping digest scheduler', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Signal all adapters to stop accepting new commands.
    //    Use Promise.allSettled so one adapter failing does not prevent
    //    others from completing.
    const adapterResults = await Promise.allSettled(
      adapters.map((a) => a.shutdown()),
    );

    for (const result of adapterResults) {
      if (result.status === 'rejected') {
        logger.error('Adapter shutdown failed', {
          error: result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        });
      }
    }

    // 3. Remove all event bus listeners.
    eventBus.removeAllListeners();

    // 4. Checkpoint the WAL.
    try {
      db.checkpoint();
    } catch (err: unknown) {
      logger.error('WAL checkpoint failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('Graceful shutdown complete');

    // 5. Exit.
    exitFn(0);
  };

  // Register signal handlers.
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Return the shutdown function for direct invocation in tests.
  return shutdown;
}
