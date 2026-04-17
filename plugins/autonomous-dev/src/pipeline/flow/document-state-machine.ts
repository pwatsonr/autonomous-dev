import { DocumentStatus } from '../types/frontmatter';

/**
 * Valid state transitions per TDD Section 2.3:
 *
 * draft              -> in-review           (submit for review)
 * in-review          -> approved            (review passed)
 * in-review          -> revision-requested  (review: changes needed)
 * in-review          -> rejected            (review: fundamentally flawed)
 * revision-requested -> in-review           (revision submitted / resubmit)
 * approved           -> stale               (backward cascade invalidation)
 * stale              -> approved            (re-approved after cascade)
 * stale              -> revision-requested  (needs revision after cascade)
 * any                -> cancelled           (cancellation)
 *
 * Terminal states (no outgoing transitions except cancelled):
 *   approved (can go to stale via cascade)
 *   rejected
 *   cancelled
 *
 * Invalid transitions (examples):
 *   approved  -> draft        (cannot un-approve to draft)
 *   rejected  -> in-review    (cannot resubmit after rejection)
 *   draft     -> approved     (cannot skip review)
 */

const VALID_TRANSITIONS: Map<DocumentStatus, Set<DocumentStatus>> = new Map([
  ['draft', new Set<DocumentStatus>(['in-review', 'cancelled'])],
  ['in-review', new Set<DocumentStatus>(['approved', 'revision-requested', 'rejected', 'cancelled'])],
  ['revision-requested', new Set<DocumentStatus>(['in-review', 'cancelled'])],
  ['approved', new Set<DocumentStatus>(['stale', 'cancelled'])],
  ['rejected', new Set<DocumentStatus>(['cancelled'])],
  ['stale', new Set<DocumentStatus>(['approved', 'revision-requested', 'cancelled'])],
  ['cancelled', new Set<DocumentStatus>([])], // Terminal
]);

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: DocumentStatus,
    public readonly to: DocumentStatus,
  ) {
    super(`Invalid state transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Validates and returns the target state if the transition is valid.
 *
 * @param currentStatus Current document status
 * @param targetStatus Desired target status
 * @returns The target status (unchanged)
 * @throws InvalidTransitionError if the transition is not valid
 */
export function validateTransition(
  currentStatus: DocumentStatus,
  targetStatus: DocumentStatus,
): DocumentStatus {
  const validTargets = VALID_TRANSITIONS.get(currentStatus);
  if (!validTargets || !validTargets.has(targetStatus)) {
    throw new InvalidTransitionError(currentStatus, targetStatus);
  }
  return targetStatus;
}

/**
 * Returns all valid target states from the given current state.
 */
export function getValidTransitions(currentStatus: DocumentStatus): DocumentStatus[] {
  return Array.from(VALID_TRANSITIONS.get(currentStatus) ?? []);
}

/**
 * Returns true if the given status is a terminal state
 * (no outgoing transitions to non-cancelled states).
 */
export function isTerminalState(status: DocumentStatus): boolean {
  return status === 'rejected' || status === 'cancelled';
}
