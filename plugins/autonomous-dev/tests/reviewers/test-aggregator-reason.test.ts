/**
 * Aggregator reason-string tests (SPEC-REQ-000050 TASK-005).
 *
 * Covers AG-01..AG-06: verifies that the ScoreAggregator emits refined reason
 * strings for single-reviewer chains that time out or produce unparseable
 * output, while leaving multi-reviewer and passing chains unchanged.
 */

import { ScoreAggregator } from '../../intake/reviewers/aggregator';
import type { ReviewerEntry, ReviewerResult } from '../../intake/reviewers/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBuiltInEntry(
  name = 'doc-reviewer',
  blocking = true,
): ReviewerEntry {
  return { name, type: 'built-in', blocking, threshold: 80 };
}

function makeErrorResult(
  name: string,
  error_message: string,
  blocking = true,
): ReviewerResult {
  return {
    reviewer_name: name,
    reviewer_type: 'built-in',
    blocking,
    threshold: 80,
    score: null,
    verdict: 'ERROR',
    duration_ms: 100,
    error_message,
  };
}

function makeApproveResult(
  name: string,
  score = 85,
  blocking = true,
): ReviewerResult {
  return {
    reviewer_name: name,
    reviewer_type: 'built-in',
    blocking,
    threshold: 80,
    score,
    verdict: 'APPROVE',
    duration_ms: 100,
  };
}

const meta = { gate: 'spec_review', request_id: 'REQ-agg-test' };
const aggregator = new ScoreAggregator();

// ---------------------------------------------------------------------------
// AG-01..AG-06
// ---------------------------------------------------------------------------

describe('ScoreAggregator — refined reason strings (SPEC-REQ-000050)', () => {
  it('AG-01: single blocking built-in times out → reason includes "timed out"', () => {
    const chain: ReviewerEntry[] = [makeBuiltInEntry('doc-reviewer')];
    const results: ReviewerResult[] = [
      makeErrorResult(
        'doc-reviewer',
        "reviewer 'doc-reviewer' timed out after 1200000ms",
      ),
    ];
    const verdict = aggregator.aggregate(results, chain, meta);
    expect(verdict.outcome).toBe('REQUEST_CHANGES');
    expect(verdict.reason).toMatch(/built-in reviewer doc-reviewer timed out:/);
    expect(verdict.reason).toContain('1200000ms');
  });

  it('AG-02: single blocking built-in parse error → reason includes "errored"', () => {
    const chain: ReviewerEntry[] = [makeBuiltInEntry('doc-reviewer')];
    const results: ReviewerResult[] = [
      makeErrorResult(
        'doc-reviewer',
        "reviewer 'doc-reviewer' produced unparseable output: empty stdout",
      ),
    ];
    const verdict = aggregator.aggregate(results, chain, meta);
    expect(verdict.outcome).toBe('REQUEST_CHANGES');
    expect(verdict.reason).toMatch(/sole blocking reviewer doc-reviewer errored:/);
  });

  it('AG-03: multi-reviewer chain, both ERROR → original "no built-in reviewer completed" string', () => {
    const chain: ReviewerEntry[] = [
      makeBuiltInEntry('reviewer-a'),
      makeBuiltInEntry('reviewer-b'),
    ];
    const results: ReviewerResult[] = [
      makeErrorResult('reviewer-a', 'boom'),
      makeErrorResult('reviewer-b', 'boom'),
    ];
    const verdict = aggregator.aggregate(results, chain, meta);
    expect(verdict.outcome).toBe('REQUEST_CHANGES');
    expect(verdict.reason).toBe('no built-in reviewer completed');
  });

  it('AG-04: multi-reviewer chain, one ERROR and one APPROVE → falls through to Rule 2', () => {
    const chain: ReviewerEntry[] = [
      makeBuiltInEntry('reviewer-a'),
      makeBuiltInEntry('reviewer-b'),
    ];
    // reviewer-a errored, reviewer-b approved (so builtInCompleted = 1 → Rule 1 skipped)
    const results: ReviewerResult[] = [
      makeErrorResult('reviewer-a', 'boom'),
      makeApproveResult('reviewer-b', 90),
    ];
    const verdict = aggregator.aggregate(results, chain, meta);
    // Rule 2 (blocking threshold): reviewer-a errored → REQUEST_CHANGES
    expect(verdict.outcome).toBe('REQUEST_CHANGES');
    // The reason comes from Rule 2 (existing format), not the refined Rule 1 string.
    expect(verdict.reason).toMatch(/blocking reviewer reviewer-a errored:/);
  });

  it('AG-05: outcome is always REQUEST_CHANGES on error paths (AG-01..AG-04)', () => {
    const timeout_chain: ReviewerEntry[] = [makeBuiltInEntry('doc-reviewer')];
    const timeout_results: ReviewerResult[] = [
      makeErrorResult('doc-reviewer', "reviewer 'doc-reviewer' timed out after 1200000ms"),
    ];
    expect(aggregator.aggregate(timeout_results, timeout_chain, meta).outcome).toBe('REQUEST_CHANGES');

    const parse_chain: ReviewerEntry[] = [makeBuiltInEntry('doc-reviewer')];
    const parse_results: ReviewerResult[] = [
      makeErrorResult('doc-reviewer', "reviewer 'doc-reviewer' produced unparseable output: x"),
    ];
    expect(aggregator.aggregate(parse_results, parse_chain, meta).outcome).toBe('REQUEST_CHANGES');

    const multi_chain: ReviewerEntry[] = [
      makeBuiltInEntry('a'),
      makeBuiltInEntry('b'),
    ];
    const multi_results: ReviewerResult[] = [
      makeErrorResult('a', 'boom'),
      makeErrorResult('b', 'boom'),
    ];
    expect(aggregator.aggregate(multi_results, multi_chain, meta).outcome).toBe('REQUEST_CHANGES');
  });

  it('AG-06: single reviewer, blocking APPROVE → APPROVE (no regression)', () => {
    const chain: ReviewerEntry[] = [makeBuiltInEntry('doc-reviewer')];
    const results: ReviewerResult[] = [makeApproveResult('doc-reviewer', 85)];
    const verdict = aggregator.aggregate(results, chain, meta);
    expect(verdict.outcome).toBe('APPROVE');
  });
});
