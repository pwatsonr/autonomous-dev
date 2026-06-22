/**
 * Unit tests for the review-gate orchestrator (SPEC-020-2-04, Task 8).
 *
 * Locks the contract from intake/reviewers/review-gate-orchestrator.ts:
 *   - All-pass chain → APPROVE with per-reviewer results in order.
 *   - Blocking reviewer below threshold → REQUEST_CHANGES.
 *   - Blocking reviewer throws → ERROR recorded; gate outcome is REQUEST_CHANGES.
 *   - Non-blocking reviewer throws → ERROR recorded; advisory warning; gate APPROVE.
 *   - Empty chain → APPROVE with "no reviewers configured for <gate>" note.
 *   - Returned results length and ordering matches chain length and order.
 *   - Gate/requestType are echoed in the GateDecision.
 *
 * All tests use a temp repo directory with a single-reviewer override so
 * they do not depend on the bundled defaults having a specific shape.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runReviewGate, type GateDecision } from '../../intake/reviewers/review-gate-orchestrator';
import type { ChangeSetContext, ReviewerEntry } from '../../intake/reviewers/types';
import type { InvokeReviewerFn } from '../../intake/reviewers/runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function trackedTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Write a minimal reviewer-chains.json override under `<repoPath>/.autonomous-dev/`
 * containing exactly `entries` for `feature.code_review`.
 */
function writeChainOverride(repoPath: string, entries: ReviewerEntry[]): void {
  const dir = path.join(repoPath, '.autonomous-dev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'reviewer-chains.json'),
    JSON.stringify({
      version: 1,
      request_types: {
        feature: {
          code_review: entries,
        },
      },
    }),
    'utf8',
  );
}

/** Minimal ChangeSetContext. */
function ctx(repoPath: string): ChangeSetContext {
  return {
    repoPath,
    changedFiles: ['src/foo.ts'],
    requestId: 'REQ-orch-test',
    gate: 'code_review',
    requestType: 'feature',
    isFrontendChange: false,
  };
}

/**
 * Build a ReviewerEntry for tests; defaults to a blocking built-in.
 */
function entry(name: string, opts: Partial<ReviewerEntry> = {}): ReviewerEntry {
  return {
    name,
    type: 'built-in',
    blocking: true,
    threshold: 80,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runReviewGate orchestrator', () => {
  describe('all-pass chain', () => {
    it('returns APPROVE when all blocking reviewers score above threshold', async () => {
      const repo = trackedTmp('orch-all-pass-');
      const chain: ReviewerEntry[] = [entry('reviewer-a'), entry('reviewer-b')];
      writeChainOverride(repo, chain);

      const invoke: InvokeReviewerFn = jest.fn().mockResolvedValue({
        score: 90,
        verdict: 'APPROVE' as const,
      });

      const decision: GateDecision = await runReviewGate({
        repoPath: repo,
        requestType: 'feature',
        gate: 'code_review',
        context: ctx(repo),
        invoke,
      });

      expect(decision.outcome).toBe('APPROVE');
      expect(decision.results).toHaveLength(2);
      expect(decision.results[0].reviewer_name).toBe('reviewer-a');
      expect(decision.results[1].reviewer_name).toBe('reviewer-b');
      expect(decision.results.every((r) => r.verdict === 'APPROVE')).toBe(true);
    });

    it('echoes gate and requestType in the decision', async () => {
      const repo = trackedTmp('orch-echo-');
      writeChainOverride(repo, [entry('reviewer-x')]);

      const invoke: InvokeReviewerFn = jest.fn().mockResolvedValue({
        score: 90,
        verdict: 'APPROVE' as const,
      });

      const decision = await runReviewGate({
        repoPath: repo,
        requestType: 'feature',
        gate: 'code_review',
        context: ctx(repo),
        invoke,
      });

      expect(decision.gate).toBe('code_review');
      expect(decision.requestType).toBe('feature');
      expect(decision.request_id).toBe('REQ-orch-test');
    });
  });

  describe('blocking reviewer failure', () => {
    it('returns REQUEST_CHANGES when a blocking reviewer is below threshold', async () => {
      const repo = trackedTmp('orch-block-threshold-');
      const chain: ReviewerEntry[] = [entry('code-reviewer', { blocking: true, threshold: 80 })];
      writeChainOverride(repo, chain);

      // Score 50 < threshold 80 → should fail.
      const invoke: InvokeReviewerFn = jest.fn().mockResolvedValue({
        score: 50,
        verdict: 'APPROVE' as const,
      });

      const decision = await runReviewGate({
        repoPath: repo,
        requestType: 'feature',
        gate: 'code_review',
        context: ctx(repo),
        invoke,
      });

      expect(decision.outcome).toBe('REQUEST_CHANGES');
      expect(decision.results).toHaveLength(1);
      expect(decision.results[0].verdict).toBe('APPROVE');
    });

    it('returns REQUEST_CHANGES when a blocking reviewer returns REQUEST_CHANGES', async () => {
      const repo = trackedTmp('orch-block-rc-');
      writeChainOverride(repo, [entry('reviewer-rc', { blocking: true, threshold: 80 })]);

      const invoke: InvokeReviewerFn = jest.fn().mockResolvedValue({
        score: 85,
        verdict: 'REQUEST_CHANGES' as const,
      });

      const decision = await runReviewGate({
        repoPath: repo,
        requestType: 'feature',
        gate: 'code_review',
        context: ctx(repo),
        invoke,
      });

      expect(decision.outcome).toBe('REQUEST_CHANGES');
    });
  });

  describe('reviewer throws (ERROR verdict)', () => {
    it('records ERROR for a blocking reviewer that throws; outcome is REQUEST_CHANGES', async () => {
      const repo = trackedTmp('orch-throw-blocking-');
      writeChainOverride(repo, [entry('flaky-reviewer', { blocking: true })]);

      const invoke: InvokeReviewerFn = jest.fn().mockRejectedValue(new Error('claude unavailable'));

      const decision = await runReviewGate({
        repoPath: repo,
        requestType: 'feature',
        gate: 'code_review',
        context: ctx(repo),
        invoke,
      });

      expect(decision.outcome).toBe('REQUEST_CHANGES');
      expect(decision.results).toHaveLength(1);
      expect(decision.results[0].verdict).toBe('ERROR');
      expect(decision.results[0].score).toBeNull();
      expect(decision.results[0].error_message).toContain('claude unavailable');
    });

    it('records ERROR for a non-blocking reviewer that throws; outcome is still APPROVE', async () => {
      const repo = trackedTmp('orch-throw-advisory-');
      const chain: ReviewerEntry[] = [
        entry('strong-reviewer', { blocking: true, threshold: 80 }),
        entry('advisory-reviewer', { blocking: false, threshold: 75 }),
      ];
      writeChainOverride(repo, chain);

      const invoke: InvokeReviewerFn = jest.fn().mockImplementation(async (e: ReviewerEntry) => {
        if (e.name === 'advisory-reviewer') throw new Error('advisory down');
        return { score: 90, verdict: 'APPROVE' as const };
      });

      const decision = await runReviewGate({
        repoPath: repo,
        requestType: 'feature',
        gate: 'code_review',
        context: ctx(repo),
        invoke,
      });

      expect(decision.outcome).toBe('APPROVE');
      expect(decision.results).toHaveLength(2);
      const advisory = decision.results.find((r) => r.reviewer_name === 'advisory-reviewer');
      expect(advisory).toBeDefined();
      expect(advisory!.verdict).toBe('ERROR');
      expect(decision.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('empty chain', () => {
    it('returns APPROVE with "no reviewers configured for <gate>" when chain is empty', async () => {
      const repo = trackedTmp('orch-empty-');
      // Write a chain config with no entry for the "noop_gate".
      const dir = path.join(repo, '.autonomous-dev');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'reviewer-chains.json'),
        JSON.stringify({
          version: 1,
          request_types: {
            feature: {
              // code_review is omitted — chain resolves to [].
            },
          },
        }),
        'utf8',
      );

      const invoke: InvokeReviewerFn = jest.fn();

      const decision = await runReviewGate({
        repoPath: repo,
        requestType: 'feature',
        gate: 'code_review',
        context: ctx(repo),
        invoke,
      });

      expect(decision.outcome).toBe('APPROVE');
      expect(decision.reason).toContain('no reviewers configured for');
      expect(decision.reason).toContain('code_review');
      expect(decision.results).toHaveLength(0);
      // invoke should never be called for an empty chain.
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe('result ordering', () => {
    it('preserves chain declaration order in the results array', async () => {
      const repo = trackedTmp('orch-order-');
      const chain: ReviewerEntry[] = [
        entry('first', { type: 'built-in' }),
        entry('second', { type: 'built-in' }),
        entry('third', { type: 'built-in' }),
      ];
      writeChainOverride(repo, chain);

      const invoke: InvokeReviewerFn = jest.fn().mockResolvedValue({
        score: 90,
        verdict: 'APPROVE' as const,
      });

      const decision = await runReviewGate({
        repoPath: repo,
        requestType: 'feature',
        gate: 'code_review',
        context: ctx(repo),
        invoke,
      });

      expect(decision.results.map((r) => r.reviewer_name)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('telemetry hook', () => {
    it('calls emit once per reviewer', async () => {
      const repo = trackedTmp('orch-telemetry-');
      const chain: ReviewerEntry[] = [entry('r1'), entry('r2')];
      writeChainOverride(repo, chain);

      const invoke: InvokeReviewerFn = jest.fn().mockResolvedValue({
        score: 90,
        verdict: 'APPROVE' as const,
      });
      const emit = jest.fn();

      await runReviewGate({
        repoPath: repo,
        requestType: 'feature',
        gate: 'code_review',
        context: ctx(repo),
        invoke,
        emit,
      });

      expect(emit).toHaveBeenCalledTimes(2);
    });
  });
});
