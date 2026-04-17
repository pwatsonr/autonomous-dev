/**
 * State machine validation for request lifecycle transitions.
 *
 * Implements SPEC-008-1-06 (Task 13).  Every state-mutating handler calls
 * {@link validateStateTransition} before modifying request state.
 *
 * @module state_machine
 */

import type { RequestStatus } from '../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Valid transitions table
// ---------------------------------------------------------------------------

/**
 * For each request status, the set of actions that are permitted.
 *
 * Terminal states (`cancelled`, `done`) have no valid actions.
 */
export const STATE_TRANSITIONS: Record<RequestStatus, string[]> = {
  queued: ['cancel', 'priority'],
  active: ['cancel', 'pause', 'feedback'],
  paused: ['cancel', 'resume'],
  failed: ['resume', 'cancel'],
  cancelled: [],
  done: [],
};

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

/**
 * Thrown when a handler attempts an action that is invalid for the
 * request's current state.
 */
export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
    // Restore prototype chain (required for `instanceof` to work with TS targets < ES2015)
    Object.setPrototypeOf(this, InvalidStateError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Validation function
// ---------------------------------------------------------------------------

/**
 * Validate that `action` is allowed for a request in `currentStatus`.
 *
 * @throws {InvalidStateError} if the transition is not valid.
 */
export function validateStateTransition(
  currentStatus: RequestStatus,
  action: string,
): void {
  const allowed = STATE_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(action)) {
    throw new InvalidStateError(
      `Cannot ${action} a request in '${currentStatus}' state. ` +
        `Allowed actions: ${allowed?.join(', ') ?? 'none'}.`,
    );
  }
}
