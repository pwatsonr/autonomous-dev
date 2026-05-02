/**
 * Unit tests for the reviewer runner (SPEC-020-2-05, Task 10).
 *
 * Locks the contract from intake/reviewers/runner.ts:
 *   - Concurrency within a group (Promise.all parallelism).
 *   - Sequential across groups.
 *   - Error capture: thrown invocations become verdict:'ERROR'.
 *   - Error isolation in a group: a sibling success is not lost.
 *   - All-error path: runner returns N error results, never throws.
 *   - Result ordering matches the flattened chain order.
 *   - Telemetry hook fires once per invocation, with the locked payload
 *     shape, for both success and error outcomes.
 */

import { ReviewerRunner } from '../../intake/reviewers/runner';
import type {
  ChangeSetContext,
  ReviewerEntry,
  ReviewerInvocation,
  ScheduledExecution,
} from '../../intake/reviewers/types';

function entry(name: string, blocking = true): ReviewerEntry {
  return { name, type: 'built-in', blocking, threshold: 80 };
}

function context(): ChangeSetContext {
  return {
    repoPath: '/tmp/repo',
    changedFiles: [],
    requestId: 'REQ-test',
    gate: 'code_review',
    requestType: 'feature',
    isFrontendChange: false,
  };
}

function inv(name: string): ReviewerInvocation {
  return { entry: entry(name), context: context() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ReviewerRunner', () => {
  describe('concurrency', () => {
    it('runs invocations in the same group in parallel (wall time ~ max, not sum)', async () => {
      const invokeMock = jest.fn().mockImplementation(async () => {
        await sleep(200);
        return { score: 90, verdict: 'APPROVE' as const };
      });
      const runner = new ReviewerRunner(invokeMock);
      const exec: ScheduledExecution = {
        groups: [[inv('a'), inv('b')]],
      };
      const start = Date.now();
      const results = await runner.run(exec);
      const elapsed = Date.now() - start;
      expect(results).toHaveLength(2);
      // Sequential would be ~400ms; parallel should be < 350ms.
      expect(elapsed).toBeLessThan(350);
    });

    it('runs groups strictly sequentially (group N+1 waits for group N)', async () => {
      const invokeMock = jest.fn().mockImplementation(async () => {
        await sleep(100);
        return { score: 90, verdict: 'APPROVE' as const };
      });
      const runner = new ReviewerRunner(invokeMock);
      const exec: ScheduledExecution = {
        groups: [[inv('a')], [inv('b')], [inv('c')]],
      };
      const start = Date.now();
      await runner.run(exec);
      const elapsed = Date.now() - start;
      // 3 groups × 100ms each = at least ~270ms (allow 30ms slop).
      expect(elapsed).toBeGreaterThanOrEqual(270);
    });
  });

  describe('error handling', () => {
    it('captures a thrown error as verdict:ERROR with score:null and error_message', async () => {
      const invokeMock = jest.fn().mockImplementation(async () => {
        throw new Error('boom');
      });
      const runner = new ReviewerRunner(invokeMock);
      const exec: ScheduledExecution = { groups: [[inv('a')]] };
      const results = await runner.run(exec);
      expect(results).toHaveLength(1);
      expect(results[0].verdict).toBe('ERROR');
      expect(results[0].score).toBeNull();
      expect(results[0].error_message).toBe('boom');
    });

    it('does not strand sibling reviewers when one in the group throws', async () => {
      const invokeMock = jest.fn().mockImplementation(async (e: ReviewerEntry) => {
        if (e.name === 'a') throw new Error('fail-a');
        return { score: 95, verdict: 'APPROVE' as const };
      });
      const runner = new ReviewerRunner(invokeMock);
      const exec: ScheduledExecution = { groups: [[inv('a'), inv('b')]] };
      const results = await runner.run(exec);
      expect(results).toHaveLength(2);
      const a = results.find((r) => r.reviewer_name === 'a')!;
      const b = results.find((r) => r.reviewer_name === 'b')!;
      expect(a.verdict).toBe('ERROR');
      expect(b.verdict).toBe('APPROVE');
      expect(b.score).toBe(95);
    });

    it('all-error path: returns N error results in original order, never throws', async () => {
      const invokeMock = jest.fn().mockImplementation(async (e: ReviewerEntry) => {
        throw new Error(`fail-${e.name}`);
      });
      const runner = new ReviewerRunner(invokeMock);
      const exec: ScheduledExecution = { groups: [[inv('a')], [inv('b'), inv('c')]] };
      const results = await runner.run(exec);
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.reviewer_name)).toEqual(['a', 'b', 'c']);
      expect(results.every((r) => r.verdict === 'ERROR')).toBe(true);
    });
  });

  describe('result ordering', () => {
    it('returns results in flattened chain order across multiple groups', async () => {
      const invokeMock = jest
        .fn()
        .mockImplementation(async () => ({ score: 85, verdict: 'APPROVE' as const }));
      const runner = new ReviewerRunner(invokeMock);
      const exec: ScheduledExecution = {
        groups: [[inv('a')], [inv('b'), inv('c')], [inv('d')]],
      };
      const results = await runner.run(exec);
      expect(results.map((r) => r.reviewer_name)).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('telemetry hook', () => {
    it('fires once per invocation with the locked payload shape', async () => {
      const calls: Array<Record<string, unknown>> = [];
      const emit = jest.fn().mockImplementation((log: Record<string, unknown>) => {
        calls.push(log);
      });
      const invokeMock = jest
        .fn()
        .mockImplementation(async () => ({ score: 90, verdict: 'APPROVE' as const }));
      const runner = new ReviewerRunner(invokeMock, emit);
      const exec: ScheduledExecution = { groups: [[inv('a')], [inv('b'), inv('c')]] };
      await runner.run(exec);
      expect(emit).toHaveBeenCalledTimes(3);
      for (const log of calls) {
        // Six fields, no extras.
        expect(Object.keys(log).sort()).toEqual([
          'duration_ms',
          'gate',
          'request_id',
          'reviewer',
          'score',
          'verdict',
        ]);
        expect(log.gate).toBe('code_review');
        expect(log.request_id).toBe('REQ-test');
        expect(log.verdict).toBe('APPROVE');
        expect(log.score).toBe(90);
        expect(typeof log.duration_ms).toBe('number');
      }
    });

    it('also fires for ERROR verdicts (with score:null)', async () => {
      const calls: Array<Record<string, unknown>> = [];
      const emit = jest.fn().mockImplementation((log: Record<string, unknown>) => {
        calls.push(log);
      });
      const invokeMock = jest.fn().mockImplementation(async () => {
        throw new Error('boom');
      });
      const runner = new ReviewerRunner(invokeMock, emit);
      const exec: ScheduledExecution = { groups: [[inv('a')]] };
      await runner.run(exec);
      expect(calls).toHaveLength(1);
      expect(calls[0].verdict).toBe('ERROR');
      expect(calls[0].score).toBeNull();
    });

    it('a throwing telemetry emitter does not affect the runner result', async () => {
      const emit = jest.fn().mockImplementation(() => {
        throw new Error('telemetry pipeline down');
      });
      const invokeMock = jest
        .fn()
        .mockImplementation(async () => ({ score: 90, verdict: 'APPROVE' as const }));
      const runner = new ReviewerRunner(invokeMock, emit);
      const exec: ScheduledExecution = { groups: [[inv('a')]] };
      const results = await runner.run(exec);
      expect(results).toHaveLength(1);
      expect(results[0].verdict).toBe('APPROVE');
    });
  });
});
