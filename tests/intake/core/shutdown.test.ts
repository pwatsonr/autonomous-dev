/**
 * Tests for graceful shutdown framework.
 *
 * Covers spec test cases 7-10:
 *   7. Shutdown sequence
 *   8. Shutdown re-entry
 *   9. Shutdown adapter failure
 *  10. Shutdown WAL checkpoint
 */

import { setupGracefulShutdown } from '../../../intake/core/shutdown';
import { TypedEventBus } from '../../../intake/events/event_bus';
import type { IntakeAdapter, ChannelType } from '../../../intake/adapters/adapter_interface';
import type { Repository } from '../../../intake/db/repository';
import type { StarvationMonitor } from '../../../intake/queue/starvation_monitor';
import type { DigestScheduler } from '../../../intake/core/shutdown';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockAdapter(
  channelType: ChannelType = 'discord',
  shutdownFn?: () => Promise<void>,
): IntakeAdapter {
  return {
    channelType,
    start: jest.fn().mockResolvedValue({ dispose: jest.fn() }),
    sendMessage: jest.fn().mockResolvedValue({ success: true }),
    promptUser: jest.fn().mockResolvedValue({ responderId: 'u1', content: 'ok', timestamp: new Date() }),
    shutdown: jest.fn(shutdownFn ?? (() => Promise.resolve())),
  };
}

function createMockStarvationMonitor(): StarvationMonitor {
  return {
    stop: jest.fn(),
    start: jest.fn(),
    promote: jest.fn().mockResolvedValue([]),
  } as unknown as StarvationMonitor;
}

function createMockDb(): Repository {
  return {
    checkpoint: jest.fn(),
  } as unknown as Repository;
}

function createMockDigestScheduler(): DigestScheduler {
  return {
    stop: jest.fn(),
  };
}

function createMockLogger() {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  return {
    logger: {
      info: (message: string, context?: Record<string, unknown>) => {
        logs.push({ level: 'info', message, context });
      },
      error: (message: string, context?: Record<string, unknown>) => {
        logs.push({ level: 'error', message, context });
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        logs.push({ level: 'warn', message, context });
      },
    },
    logs,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setupGracefulShutdown', () => {
  // Prevent process.exit and signal handlers from interfering with tests.
  // We inject a no-op exitFn and call the returned shutdown function directly.

  // --------------------------------------------------------------------------
  // Test Case 7: Shutdown sequence
  // --------------------------------------------------------------------------
  test('shutdown stops monitor, signals adapters, removes listeners, checkpoints WAL, then exits', async () => {
    const adapter1 = createMockAdapter('discord');
    const adapter2 = createMockAdapter('slack');
    const starvationMonitor = createMockStarvationMonitor();
    const digestScheduler = createMockDigestScheduler();
    const db = createMockDb();
    const eventBus = new TypedEventBus();
    const { logger } = createMockLogger();

    // Add a listener so we can verify removeAllListeners was called.
    let listenerCalled = false;
    eventBus.subscribe('intake', () => { listenerCalled = true; });

    const exitCalls: number[] = [];
    const exitFn = (code: number) => { exitCalls.push(code); };

    const shutdown = setupGracefulShutdown(
      [adapter1, adapter2],
      eventBus,
      db,
      starvationMonitor,
      logger,
      digestScheduler,
      exitFn,
    );

    await shutdown();

    // 1. Starvation monitor stopped.
    expect(starvationMonitor.stop).toHaveBeenCalledTimes(1);

    // 1b. Digest scheduler stopped.
    expect(digestScheduler.stop).toHaveBeenCalledTimes(1);

    // 2. Both adapters shut down.
    expect(adapter1.shutdown).toHaveBeenCalledTimes(1);
    expect(adapter2.shutdown).toHaveBeenCalledTimes(1);

    // 3. Event listeners removed (emitting should not invoke handler).
    await eventBus.emit('intake', { type: 'request_paused', requestId: 'REQ-1' });
    expect(listenerCalled).toBe(false);

    // 4. WAL checkpoint called.
    expect(db.checkpoint).toHaveBeenCalledTimes(1);

    // 5. Exit called with 0.
    expect(exitCalls).toEqual([0]);
  });

  // --------------------------------------------------------------------------
  // Test Case 8: Shutdown re-entry
  // --------------------------------------------------------------------------
  test('calling shutdown twice only executes shutdown once', async () => {
    const adapter = createMockAdapter();
    const starvationMonitor = createMockStarvationMonitor();
    const db = createMockDb();
    const eventBus = new TypedEventBus();

    const exitCalls: number[] = [];
    const exitFn = (code: number) => { exitCalls.push(code); };

    const shutdown = setupGracefulShutdown(
      [adapter],
      eventBus,
      db,
      starvationMonitor,
      undefined,
      undefined,
      exitFn,
    );

    // Call shutdown twice concurrently.
    await Promise.all([shutdown(), shutdown()]);

    // Adapter shutdown should have been called exactly once.
    expect(adapter.shutdown).toHaveBeenCalledTimes(1);
    expect(db.checkpoint).toHaveBeenCalledTimes(1);
    expect(exitCalls).toEqual([0]);
  });

  // --------------------------------------------------------------------------
  // Test Case 9: Shutdown adapter failure
  // --------------------------------------------------------------------------
  test('one adapter failing shutdown does not prevent other adapters from shutting down', async () => {
    const failingAdapter = createMockAdapter('discord', () =>
      Promise.reject(new Error('Adapter crash')),
    );
    const healthyAdapter = createMockAdapter('slack');
    const starvationMonitor = createMockStarvationMonitor();
    const db = createMockDb();
    const eventBus = new TypedEventBus();
    const { logger, logs } = createMockLogger();

    const exitCalls: number[] = [];
    const exitFn = (code: number) => { exitCalls.push(code); };

    const shutdown = setupGracefulShutdown(
      [failingAdapter, healthyAdapter],
      eventBus,
      db,
      starvationMonitor,
      logger,
      undefined,
      exitFn,
    );

    await shutdown();

    // Both adapters' shutdown was called.
    expect(failingAdapter.shutdown).toHaveBeenCalledTimes(1);
    expect(healthyAdapter.shutdown).toHaveBeenCalledTimes(1);

    // The failure was logged.
    const errorLogs = logs.filter((l) => l.level === 'error');
    expect(errorLogs.some((l) => l.message === 'Adapter shutdown failed')).toBe(true);

    // WAL checkpoint still ran.
    expect(db.checkpoint).toHaveBeenCalledTimes(1);

    // Exit still called.
    expect(exitCalls).toEqual([0]);
  });

  // --------------------------------------------------------------------------
  // Test Case 10: Shutdown WAL checkpoint
  // --------------------------------------------------------------------------
  test('WAL checkpoint is called after adapter shutdown completes', async () => {
    const callOrder: string[] = [];

    const adapter = createMockAdapter('discord', async () => {
      callOrder.push('adapter.shutdown');
    });
    const starvationMonitor = createMockStarvationMonitor();
    const db = createMockDb();
    (db.checkpoint as jest.Mock).mockImplementation(() => {
      callOrder.push('db.checkpoint');
    });
    const eventBus = new TypedEventBus();

    const exitCalls: number[] = [];
    const exitFn = (code: number) => { exitCalls.push(code); };

    const shutdown = setupGracefulShutdown(
      [adapter],
      eventBus,
      db,
      starvationMonitor,
      undefined,
      undefined,
      exitFn,
    );

    await shutdown();

    // Verify order: adapter shutdown happens before checkpoint.
    expect(callOrder).toEqual(['adapter.shutdown', 'db.checkpoint']);
  });

  test('shutdown works without optional digest scheduler', async () => {
    const adapter = createMockAdapter();
    const starvationMonitor = createMockStarvationMonitor();
    const db = createMockDb();
    const eventBus = new TypedEventBus();

    const exitCalls: number[] = [];
    const exitFn = (code: number) => { exitCalls.push(code); };

    const shutdown = setupGracefulShutdown(
      [adapter],
      eventBus,
      db,
      starvationMonitor,
      undefined,
      undefined, // no digest scheduler
      exitFn,
    );

    // Should not throw.
    await shutdown();

    expect(adapter.shutdown).toHaveBeenCalledTimes(1);
    expect(db.checkpoint).toHaveBeenCalledTimes(1);
    expect(exitCalls).toEqual([0]);
  });

  test('shutdown with empty adapter list still checkpoints and exits', async () => {
    const starvationMonitor = createMockStarvationMonitor();
    const db = createMockDb();
    const eventBus = new TypedEventBus();

    const exitCalls: number[] = [];
    const exitFn = (code: number) => { exitCalls.push(code); };

    const shutdown = setupGracefulShutdown(
      [],
      eventBus,
      db,
      starvationMonitor,
      undefined,
      undefined,
      exitFn,
    );

    await shutdown();

    expect(db.checkpoint).toHaveBeenCalledTimes(1);
    expect(exitCalls).toEqual([0]);
  });
});
