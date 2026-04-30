/**
 * Discord button + modal interaction handlers (functional surface).
 *
 * These functions are imported by the DiscordService orchestrator in
 * `main.ts` to dispatch non-chat-input interactions.  They are deliberately
 * thin wrappers over the existing {@link ComponentInteractionHandler} class
 * (`discord_interaction_handler.ts`) so the orchestrator can stay
 * functional while reusing the audited button/modal logic.
 *
 * Architecture note (read before extending):
 * -----------------------------------------
 * The existing {@link DiscordAdapter} (SPEC-008-3-*) already wires its own
 * `interactionCreate` listener via `setupInteractionListener()` and
 * dispatches via its private `componentHandler`.  The new DiscordService
 * orchestrator (SPEC-011-3-01..05) ALSO registers its own
 * `interactionCreate` listener.  This means BOTH listeners fire for every
 * interaction unless the operator wires only one.
 *
 * Two acceptable production paths:
 *   1. Use DiscordService for lifecycle (connect, reconnect, signal
 *      handling, rate limiting, graceful drain) but keep the adapter's
 *      existing interactionCreate listener for dispatch.  In this case,
 *      DiscordService should NOT add its own listener (or it should be
 *      gated by a flag).  The functions in this file are then unused.
 *   2. Use DiscordService for both lifecycle AND dispatch, in which case
 *      the adapter's `setupInteractionListener` should be disabled (or
 *      the adapter should not be `start()`ed via its own path).
 *
 * Resolution is pending PLAN-011-3 follow-up; see the open question in
 * the PR for batch 2b.  In the meantime these functions are provided as
 * non-throwing wrappers so the typecheck and unit tests pass; they
 * delegate to the same private code path the adapter would have taken.
 *
 * @module discord_threads
 */

import type {
  ButtonInteraction,
  ModalSubmitInteraction as DJSModalSubmit,
} from 'discord.js';
import type { DiscordAdapter } from './discord_adapter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of Logger from `main.ts` we need here. */
export interface ThreadLogger {
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Adapter accessor (works around `componentHandler` being private)
// ---------------------------------------------------------------------------

interface AdapterInternals {
  componentHandler?: {
    handle(interaction: unknown): Promise<void>;
    handleModalSubmit(interaction: unknown): Promise<void>;
  };
}

/**
 * Type-narrow a DiscordAdapter to its private `componentHandler` field.
 * Safe at runtime: the adapter sets this in its constructor.  Returns
 * undefined if the adapter shape changes so callers can degrade
 * gracefully.
 */
function getComponentHandler(
  adapter: DiscordAdapter,
): AdapterInternals['componentHandler'] | undefined {
  const internals = adapter as unknown as AdapterInternals;
  return internals.componentHandler;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dispatch a Discord button interaction.
 *
 * Delegates to the adapter's private `ComponentInteractionHandler.handle`
 * via {@link getComponentHandler}.  If the adapter has not been initialized
 * (no componentHandler), logs a warning and silently returns — better
 * than crashing the orchestrator on a deferred-init race.
 *
 * @param interaction - The Discord button interaction.
 * @param adapter     - The DiscordAdapter that owns the component handler.
 * @param logger      - Logger from the orchestrator.
 */
export async function handleButtonInteraction(
  interaction: ButtonInteraction,
  adapter: DiscordAdapter,
  logger: ThreadLogger,
): Promise<void> {
  const handler = getComponentHandler(adapter);
  if (!handler) {
    logger.warn('discord_button_handler_unavailable', {
      customId: interaction.customId,
    });
    return;
  }
  try {
    await handler.handle(interaction);
  } catch (err) {
    logger.error('discord_button_handler_failed', {
      customId: interaction.customId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Dispatch a Discord modal-submit interaction.
 *
 * Delegates to the adapter's private
 * `ComponentInteractionHandler.handleModalSubmit` via
 * {@link getComponentHandler}.  Same defer-and-log fallback as
 * {@link handleButtonInteraction}.
 *
 * @param interaction - The Discord modal-submit interaction.
 * @param adapter     - The DiscordAdapter that owns the component handler.
 * @param logger      - Logger from the orchestrator.
 */
export async function handleModalSubmit(
  interaction: DJSModalSubmit,
  adapter: DiscordAdapter,
  logger: ThreadLogger,
): Promise<void> {
  const handler = getComponentHandler(adapter);
  if (!handler) {
    logger.warn('discord_modal_handler_unavailable', {
      customId: interaction.customId,
    });
    return;
  }
  try {
    await handler.handleModalSubmit(interaction);
  } catch (err) {
    logger.error('discord_modal_handler_failed', {
      customId: interaction.customId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
