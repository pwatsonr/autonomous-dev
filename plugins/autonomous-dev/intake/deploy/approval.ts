/**
 * Per-environment approval state machine (SPEC-023-2-03).
 *
 * Cross-reference: TDD-023 §11.
 *
 * Public API:
 *   - requestApproval         create the initial state file (idempotent)
 *   - recordApproval          append an `approve` entry
 *   - recordRejection         append a `reject` entry
 *   - checkApprovalStatus     pure read; recomputes decision
 *   - loadApprovalState       low-level read with HMAC chain verification
 *
 * State persistence + two-phase commit live in `approval-store.ts`.
 *
 * Decision logic (recomputed on every load — never trusted from disk):
 *   any reject entry      -> rejected
 *   requirement === none  -> approved
 *   single                -> approved iff >=1 approve entry
 *   two-person            -> approved iff >=2 approve entries with distinct emails
 *   admin                 -> approved iff >=1 approve entry with role === 'admin'
 *   else                  -> pending
 *
 * @module intake/deploy/approval
 */

import { createHmac } from 'node:crypto';

import { canonicalJSON } from '../chains/canonical-json';
import {
  AdminRequiredError,
  ApprovalChainError,
  DuplicateApproverError,
  DeployError,
} from './errors';
import { loadDeployKey } from './record-signer';
import {
  approvalPathFor,
  readApprovalFile,
  writeApprovalFile,
} from './approval-store';
import type {
  ApprovalDecision,
  ApprovalEntry,
  ApprovalState,
  ApproverRole,
} from './approval-types';
import type { ApprovalLevel } from './types-config';

/** Test seam: replace `Date.now()`-derived ISO clock for deterministic suites. */
let clockOverride: (() => string) | null = null;
export function __setApprovalClockForTest(fn: (() => string) | null): void {
  clockOverride = fn;
}
function nowIso(): string {
  if (clockOverride) return clockOverride();
  return new Date().toISOString();
}

function genesisHmac(deployId: string): string {
  return `INIT:${deployId}`;
}

/** Compute the HMAC over (prev_chain_head + canonical(entry_without_hmac)). */
function computeEntryHmac(
  key: Buffer,
  prevChainHead: string,
  entry: Omit<ApprovalEntry, 'hmac'>,
): string {
  const body = canonicalJSON(entry as unknown as Record<string, unknown>);
  return createHmac('sha256', key).update(prevChainHead).update(body).digest('hex');
}

/**
 * Re-verify and recompute a state's HMAC chain + decision. Throws
 * `ApprovalChainError` on any tampering.
 */
function verifyChain(state: ApprovalState, key: Buffer): void {
  let prev = genesisHmac(state.deployId);
  for (let i = 0; i < state.entries.length; i++) {
    const entry = state.entries[i];
    const { hmac, ...rest } = entry;
    const expected = computeEntryHmac(key, prev, rest);
    if (expected !== hmac) {
      throw new ApprovalChainError(state.deployId, i, 'hmac mismatch');
    }
    prev = hmac;
  }
  if (state.chainHeadHmac !== prev) {
    throw new ApprovalChainError(
      state.deployId,
      state.entries.length,
      'chainHeadHmac does not match recomputed tail',
    );
  }
}

/** Recompute the aggregate decision from the entries log. */
function deriveDecision(
  requirement: ApprovalLevel,
  entries: readonly ApprovalEntry[],
): ApprovalDecision {
  if (entries.some((e) => e.decision === 'reject')) return 'rejected';
  const approves = entries.filter((e) => e.decision === 'approve');
  switch (requirement) {
    case 'none':
      return 'approved';
    case 'single':
      return approves.length >= 1 ? 'approved' : 'pending';
    case 'two-person': {
      const distinct = new Set(approves.map((e) => e.approver));
      return distinct.size >= 2 ? 'approved' : 'pending';
    }
    case 'admin':
      return approves.some((e) => e.role === 'admin') ? 'approved' : 'pending';
    default:
      return 'pending';
  }
}

function cloneAndDerive(state: ApprovalState): ApprovalState {
  const decision = deriveDecision(state.requirement, state.entries);
  const resolvedAt =
    decision !== 'pending' ? state.resolvedAt ?? state.entries.at(-1)?.recordedAt ?? nowIso() : null;
  return { ...state, decision, resolvedAt };
}

/**
 * Read the approval state from disk and verify the HMAC chain. Throws
 * `ApprovalChainError` on tamper detection.
 */
export async function loadApprovalState(
  deployId: string,
  requestDir: string,
  opts?: { hmacKey?: Buffer },
): Promise<ApprovalState | null> {
  const raw = await readApprovalFile(requestDir, deployId);
  if (!raw) return null;
  const key = opts?.hmacKey ?? loadDeployKey();
  verifyChain(raw, key);
  return cloneAndDerive(raw);
}

/** Request initial approval state for a deploy. Idempotent. */
export async function requestApproval(args: {
  deployId: string;
  envName: string;
  requirement: ApprovalLevel;
  requestDir: string;
  hmacKey?: Buffer;
}): Promise<ApprovalState> {
  const existing = await loadApprovalState(args.deployId, args.requestDir, {
    hmacKey: args.hmacKey,
  });
  if (existing) return existing;

  const fresh: ApprovalState = {
    deployId: args.deployId,
    envName: args.envName,
    requirement: args.requirement,
    decision: 'pending',
    entries: [],
    requestedAt: nowIso(),
    resolvedAt: null,
    chainHeadHmac: genesisHmac(args.deployId),
  };
  const derived = cloneAndDerive(fresh);
  await writeApprovalFile(args.requestDir, derived);
  return derived;
}

/** Record an `approve` entry. Throws on duplicate or admin-required violations. */
export async function recordApproval(args: {
  deployId: string;
  approver: string;
  role: ApproverRole;
  requestDir: string;
  envName?: string;
  requirement?: ApprovalLevel;
  hmacKey?: Buffer;
}): Promise<ApprovalState> {
  return appendEntry({
    ...args,
    decision: 'approve',
  });
}

/** Record a `reject` entry. Reason must be non-empty (>=1 char). */
export async function recordRejection(args: {
  deployId: string;
  approver: string;
  role: ApproverRole;
  reason: string;
  requestDir: string;
  envName?: string;
  requirement?: ApprovalLevel;
  hmacKey?: Buffer;
}): Promise<ApprovalState> {
  if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
    throw new DeployError('rejection reason must be a non-empty string');
  }
  return appendEntry({
    ...args,
    decision: 'reject',
  });
}

/** Pure read; mirrors `loadApprovalState` but documented as read-only. */
export async function checkApprovalStatus(
  deployId: string,
  requestDir: string,
  opts?: { hmacKey?: Buffer },
): Promise<ApprovalState | null> {
  return loadApprovalState(deployId, requestDir, opts);
}

// ---------------------------------------------------------------------------
// Internal: append-with-validation (shared by recordApproval / recordRejection)
// ---------------------------------------------------------------------------

interface AppendArgs {
  deployId: string;
  approver: string;
  role: ApproverRole;
  decision: 'approve' | 'reject';
  reason?: string;
  requestDir: string;
  envName?: string;
  requirement?: ApprovalLevel;
  hmacKey?: Buffer;
}

async function appendEntry(args: AppendArgs): Promise<ApprovalState> {
  const key = args.hmacKey ?? loadDeployKey();
  let state = await loadApprovalState(args.deployId, args.requestDir, { hmacKey: key });
  if (!state) {
    if (!args.envName || !args.requirement) {
      throw new DeployError(
        `approval state not found for deploy ${args.deployId}; call requestApproval first`,
      );
    }
    state = await requestApproval({
      deployId: args.deployId,
      envName: args.envName,
      requirement: args.requirement,
      requestDir: args.requestDir,
      hmacKey: key,
    });
  }

  // Once decision is terminal (approved/rejected), reject further mutations
  // EXCEPT: a reject is always permitted to short-circuit a pending approval.
  if (state.decision === 'rejected') {
    return state;
  }

  // Admin-required gate (only on approve).
  if (
    args.decision === 'approve' &&
    state.requirement === 'admin' &&
    args.role !== 'admin'
  ) {
    throw new AdminRequiredError(args.deployId, args.approver);
  }

  // Duplicate-approver guard for approve actions.
  if (
    args.decision === 'approve' &&
    state.entries.some(
      (e) => e.decision === 'approve' && e.approver === args.approver,
    )
  ) {
    throw new DuplicateApproverError(args.deployId, args.approver);
  }

  const draft: Omit<ApprovalEntry, 'hmac'> = {
    approver: args.approver,
    role: args.role,
    decision: args.decision,
    ...(args.reason ? { reason: args.reason } : {}),
    recordedAt: nowIso(),
  };
  const hmac = computeEntryHmac(key, state.chainHeadHmac, draft);
  const fullEntry: ApprovalEntry = { ...draft, hmac };

  const next: ApprovalState = {
    ...state,
    entries: [...state.entries, fullEntry],
    chainHeadHmac: hmac,
  };
  const derived = cloneAndDerive(next);
  await writeApprovalFile(args.requestDir, derived);
  return derived;
}

/** Path helper re-exported for CLI convenience. */
export { approvalPathFor };
