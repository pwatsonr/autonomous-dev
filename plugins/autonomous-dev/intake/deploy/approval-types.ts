/**
 * Types for the deploy approval state machine (SPEC-023-2-03).
 *
 * Cross-reference: TDD-023 §11.
 *
 * @module intake/deploy/approval-types
 */

import type { ApprovalLevel } from './types-config';

/** Aggregate decision derived from the entries log. */
export type ApprovalDecision = 'pending' | 'approved' | 'rejected';

/** Per-approver decision recorded in the entries log. */
export type ApprovalEntryDecision = 'approve' | 'reject';

/** Role surface (mirrors PLAN-019-3 trust framework). */
export type ApproverRole = 'operator' | 'admin';

/** A single approver action; HMAC-chained over the prior chain head. */
export interface ApprovalEntry {
  /** Verified email per PLAN-019-3. */
  approver: string;
  /** Role at time of decision. */
  role: ApproverRole;
  /** Decision the approver made. */
  decision: ApprovalEntryDecision;
  /** Reason text (REQUIRED on reject; optional on approve). */
  reason?: string;
  /** ISO-8601 UTC timestamp. */
  recordedAt: string;
  /** HMAC-SHA256(prev_chain_head + canonical(this_entry_minus_hmac)) hex. */
  hmac: string;
}

/** Persisted approval state for a single deploy request. */
export interface ApprovalState {
  deployId: string;
  envName: string;
  requirement: ApprovalLevel;
  /** Derived from entries on every load — never trusted from disk. */
  decision: ApprovalDecision;
  /** Append-only log; tail is the current chain head. */
  entries: ApprovalEntry[];
  requestedAt: string;
  resolvedAt: string | null;
  /** Last entry's HMAC, or genesis (`INIT:<deployId>`) when empty. */
  chainHeadHmac: string;
}
