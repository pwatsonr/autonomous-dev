/**
 * Typed event bus for the intake layer.
 *
 * Wraps Node.js `EventEmitter` with channel-typed subscribe/emit methods.
 * Handlers can be async; errors in handlers are caught and logged to prevent
 * crashing the bus. Each `subscribe` call returns an unsubscribe function
 * (disposable pattern).
 *
 * The bus is intended as a singleton per intake layer instance.
 *
 * Implements SPEC-008-1-07, Task 14 (event bus portion).
 *
 * @module event_bus
 */

import { EventEmitter } from 'events';
import type { EventMap } from './event_types';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Logger interface for structured logging within the event bus.
 */
export interface EventBusLogger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default no-op logger used when no logger is provided.
 */
const nullLogger: EventBusLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
};

// ---------------------------------------------------------------------------
// TypedEventBus
// ---------------------------------------------------------------------------

/**
 * A typed event bus that routes events through named channels.
 *
 * Type safety is enforced at compile time: subscribing to `'intake'` yields
 * `IntakeEvent` in the handler, and emitting on `'pipeline'` requires a
 * `PipelineEvent` payload.
 *
 * Error isolation: if a handler throws (sync or async), the error is caught
 * and logged. The bus continues to operate and other handlers for the same
 * event are still invoked.
 */
export class TypedEventBus {
  private emitter = new EventEmitter();
  private logger: EventBusLogger;

  constructor(logger: EventBusLogger = nullLogger) {
    this.logger = logger;
  }

  /**
   * Subscribe a handler to a typed channel.
   *
   * @param channel - The channel name (`'intake'` or `'pipeline'`).
   * @param handler - A sync or async handler function.
   * @returns An unsubscribe function. Call it to remove this handler.
   */
  subscribe<K extends keyof EventMap>(
    channel: K,
    handler: (event: EventMap[K]) => void | Promise<void>,
  ): () => void {
    // Wrap the handler to catch and log errors (both sync and async).
    const wrappedHandler = (event: EventMap[K]): void => {
      try {
        const result = handler(event);
        // If the handler returns a promise, catch rejections.
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err: unknown) => {
            this.logger.error('Async event handler error', {
              channel: channel as string,
              eventType: (event as { type?: string }).type,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err: unknown) {
        this.logger.error('Sync event handler error', {
          channel: channel as string,
          eventType: (event as { type?: string }).type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // Tag the wrapper so we can map back for unsubscribe.
    (wrappedHandler as { _original?: unknown })._original = handler;

    this.emitter.on(channel, wrappedHandler);

    // Return disposable unsubscribe function.
    return () => {
      this.emitter.off(channel, wrappedHandler);
    };
  }

  /**
   * Emit an event on a typed channel.
   *
   * All subscribed handlers for the channel are invoked synchronously
   * (though individual handlers may be async -- their errors are caught).
   *
   * @param channel - The channel name.
   * @param event   - The event payload (must match the channel's type).
   */
  async emit<K extends keyof EventMap>(
    channel: K,
    event: EventMap[K],
  ): Promise<void> {
    this.emitter.emit(channel, event);
  }

  /**
   * Remove all listeners from all channels.
   *
   * Used during graceful shutdown to prevent stale event processing.
   */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
