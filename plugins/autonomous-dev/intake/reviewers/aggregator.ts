/**
 * Score aggregator (SPEC-020-2-03, Task 6).
 *
 * Pure logic component (no I/O). Consumes the runner's
 * ReviewerResult[] plus the original ReviewerEntry[] chain and emits
 * a single GateVerdict.
 *
 * Aggregation rules (TDD-019 §11.2), applied in this order:
 *   1. Built-in-min: at least one built-in result must be non-error.
 *      If the chain has zero built-ins by design, this rule is a no-op
 *      (operator opted out).
 *   2. Blocking threshold: any blocking reviewer that errored OR scored
 *      below threshold OR returned REQUEST_CHANGES fails the gate.
 *   3. Advisory warning: a non-blocking reviewer that errored OR is
 *      below threshold OR returned REQUEST_CHANGES yields a warning
 *      string but does NOT fail the gate.
 *
 * The aggregator NEVER throws — pathological inputs (empty results,
 * mismatched chain) still produce a sensible GateVerdict (with `reason`
 * describing the issue).
 *
 * @module intake/reviewers/aggregator
 */

import type {
  GateVerdict,
  ReviewerEntry,
  ReviewerResult,
} from './types';

export interface AggregateMetadata {
  gate: string;
  request_id: string;
}

export class ScoreAggregator {
  /**
   * Roll a per-reviewer result list into a single gate verdict.
   *
   * Returns a fresh GateVerdict; does not mutate inputs. The
   * `per_reviewer` field is the same `results` array reference (read
   * by callers as a pass-through).
   */
  aggregate(
    results: ReviewerResult[],
    chain: ReviewerEntry[],
    metadata: AggregateMetadata,
  ): GateVerdict {
    const warnings: string[] = [];
    const builtInCompleted = results.filter(
      (r) => r.reviewer_type === 'built-in' && r.verdict !== 'ERROR',
    ).length;

    // Rule 1: built-in-min (TDD-019 §11.2).
    // Only enforce when the chain itself contains at least one built-in
    // entry — operator-customized chains with zero built-ins skip the rule.
    const chainHasBuiltIns = chain.some((e) => e.type === 'built-in');
    if (chainHasBuiltIns && builtInCompleted === 0) {
      return {
        gate: metadata.gate,
        request_id: metadata.request_id,
        outcome: 'REQUEST_CHANGES',
        reason: 'no built-in reviewer completed',
        per_reviewer: results,
        warnings,
        built_in_count_completed: 0,
      };
    }

    // Rule 2: blocking threshold. Walk results in chain order so the
    // failure reason references the earliest-declared offender.
    let failureReason: string | undefined;
    for (const r of results) {
      if (!r.blocking) continue;
      if (r.verdict === 'ERROR') {
        failureReason = `blocking reviewer ${r.reviewer_name} errored: ${r.error_message ?? 'unknown error'}`;
        break;
      }
      // Below-threshold or explicit REQUEST_CHANGES → block.
      const score = r.score ?? -1; // null cannot occur here (verdict !== 'ERROR'); -1 is defensive.
      if (r.verdict === 'REQUEST_CHANGES' || score < r.threshold) {
        failureReason = `blocking reviewer ${r.reviewer_name} below threshold (${score} < ${r.threshold})`;
        break;
      }
    }

    // Rule 3: advisory warnings. Always collected (independent of
    // failureReason) because they belong in the verdict file even when
    // the gate fails.
    for (const r of results) {
      if (r.blocking) continue;
      if (r.verdict === 'ERROR') {
        warnings.push(
          `advisory reviewer ${r.reviewer_name} errored: ${r.error_message ?? 'unknown error'}`,
        );
        continue;
      }
      const score = r.score ?? -1;
      if (r.verdict === 'REQUEST_CHANGES' || score < r.threshold) {
        warnings.push(
          `advisory reviewer ${r.reviewer_name} below threshold (${score} < ${r.threshold})`,
        );
      }
    }

    if (failureReason !== undefined) {
      return {
        gate: metadata.gate,
        request_id: metadata.request_id,
        outcome: 'REQUEST_CHANGES',
        reason: failureReason,
        per_reviewer: results,
        warnings,
        built_in_count_completed: builtInCompleted,
      };
    }

    // All blocking reviewers passed. Compose the success message,
    // taking care to handle the chain-has-zero-built-ins case so the
    // success string still makes sense.
    const reason = chainHasBuiltIns
      ? `all blocking reviewers passed (${builtInCompleted} built-ins completed)`
      : `all blocking reviewers passed (no built-ins in chain)`;

    return {
      gate: metadata.gate,
      request_id: metadata.request_id,
      outcome: 'APPROVE',
      reason,
      per_reviewer: results,
      warnings,
      built_in_count_completed: builtInCompleted,
    };
  }
}
