/**
 * Ephemeral-aware reply helpers for the Discord channel.
 *
 * Centralizes:
 * - Ephemeral preference resolution (`shouldBeEphemeral`).
 * - Plain-text ephemeral replies (`replyEphemeral`).
 * - Error formatting + ephemeral delivery (`replyError`), including the
 *   per-error-type surface message table from SPEC-011-3-04.
 *
 * `replyError` always sends an ephemeral message regardless of the user
 * preference -- internal errors NEVER leak `err.message` (only a correlation
 * ID is shown to the user).
 *
 * @module discord/replies
 */

import type { RepliableInteraction } from 'discord.js';
import { redactToken } from './main_internals';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User-level preference for ephemeral message delivery. */
export type EphemeralPref = 'always' | 'errors-only' | 'never';

/**
 * Tagged error types whose `.message` is safe to surface verbatim to a user.
 * Anything not in this list is treated as `Internal error` and only the
 * correlation ID is shown.
 */
class TaggedError extends Error {
  constructor(
    message: string,
    public readonly code: 'config' | 'validation' | 'router',
  ) {
    super(message);
  }
}

/**
 * Configuration error.  Thrown when the operator has a bad config; the
 * surface message instructs the user to contact their operator.
 */
export class ConfigurationError extends TaggedError {
  constructor(message: string) {
    super(message, 'config');
    this.name = 'ConfigurationError';
  }
}

/**
 * Validation error.  Thrown when the user supplied bad input.  The message
 * is already user-facing and is surfaced verbatim.
 */
export class ValidationError extends TaggedError {
  constructor(message: string) {
    super(message, 'validation');
    this.name = 'ValidationError';
  }
}

/**
 * Router error wrapping a downstream failure.  Surface message tells the
 * user "Could not process request" plus the wrapped message.
 */
export class IntakeRouterError extends TaggedError {
  constructor(message: string) {
    super(message, 'router');
    this.name = 'IntakeRouterError';
  }
}

// ---------------------------------------------------------------------------
// Ephemeral preference resolution
// ---------------------------------------------------------------------------

/**
 * Determine whether a reply should be ephemeral based on user preference and
 * whether the reply is an error message.
 *
 * Errors are ALWAYS ephemeral regardless of the user's preference -- this
 * is a privacy-preserving default per SPEC-011-3-04 acceptance criteria.
 */
export function shouldBeEphemeral(pref: EphemeralPref, isError: boolean): boolean {
  if (isError) return true;
  switch (pref) {
    case 'always':
      return true;
    case 'errors-only':
      return false;
    case 'never':
      return false;
  }
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

/**
 * Reply ephemerally to an interaction.  Picks the right discord.js method
 * (reply / editReply / followUp) based on whether the interaction has
 * already been deferred or replied to.
 */
export async function replyEphemeral(
  interaction: RepliableInteraction,
  content: string,
): Promise<void> {
  const safe = redactToken(content);
  if ((interaction as { replied?: boolean }).replied) {
    await interaction.followUp({ content: safe, ephemeral: true });
    return;
  }
  if ((interaction as { deferred?: boolean }).deferred) {
    await interaction.editReply({ content: safe });
    return;
  }
  await interaction.reply({ content: safe, ephemeral: true });
}

/**
 * Format and send an error reply.  Surface message follows the table in
 * SPEC-011-3-04:
 *
 * | Error type            | Surface message                                                                  |
 * |-----------------------|----------------------------------------------------------------------------------|
 * | ConfigurationError    | `Configuration error: ${err.message}. Contact your operator.`                    |
 * | ValidationError       | `${err.message}` (already user-facing)                                           |
 * | IntakeRouterError     | `Could not process request: ${err.message}`                                      |
 * | Any other Error       | `Internal error (id: ${correlationId}). Check logs.` (do not leak err.message)   |
 * | Non-Error thrown      | `Internal error (id: ${correlationId}).`                                         |
 *
 * Always ephemeral.
 */
export async function replyError(
  interaction: RepliableInteraction,
  err: unknown,
): Promise<void> {
  const correlationId = (interaction as { id?: string }).id ?? 'unknown';
  const content = formatError(err, correlationId);
  await replyEphemeral(interaction, content);
}

/**
 * Pure formatter for the error message table.  Exposed for unit testing
 * without needing a full mock interaction.
 */
export function formatError(err: unknown, correlationId: string): string {
  if (err instanceof ConfigurationError) {
    return `Configuration error: ${err.message}. Contact your operator.`;
  }
  if (err instanceof ValidationError) {
    return err.message;
  }
  if (err instanceof IntakeRouterError) {
    return `Could not process request: ${err.message}`;
  }
  if (err instanceof Error) {
    // Internal errors NEVER leak err.message to the user.
    return `Internal error (id: ${correlationId}). Check logs.`;
  }
  return `Internal error (id: ${correlationId}).`;
}
