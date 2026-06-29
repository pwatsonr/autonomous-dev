/**
 * Timeout and dispatcher tests for SPEC-REQ-000050 (TASK-002 / TASK-004).
 *
 * Covers:
 *   - `resolveReviewerTimeoutMs` unit tests (RR-01..RR-08)
 *   - Dispatcher behaviour tests (DI-01..DI-10) using an injected SpawnFn
 *     and a recording telemetry hook.
 *
 * All tests inject mocks — NO real `claude` subprocess spawn.
 */

import {
  createClaudeDispatcher,
  resolveReviewerTimeoutMs,
  ReviewerTimeoutError,
  ReviewerParseError,
  type SpawnFn,
} from '../../intake/reviewers/invoke-reviewer';
import { ReviewerRunner } from '../../intake/reviewers/runner';
import type {
  ChangeSetContext,
  ReviewerEntry,
  ScheduledExecution,
} from '../../intake/reviewers/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<ReviewerEntry>): ReviewerEntry {
  return {
    name: 'doc-reviewer',
    type: 'built-in',
    blocking: true,
    threshold: 80,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<ChangeSetContext>): ChangeSetContext {
  return {
    repoPath: '/tmp/repo',
    changedFiles: [],
    requestId: 'REQ-timeout-test',
    gate: 'spec_review',
    requestType: 'refactor',
    isFrontendChange: false,
    ...overrides,
  };
}

function mockSpawn(code: number, stdout: string, stderr = ''): SpawnFn {
  return jest.fn().mockResolvedValue({ code, stdout, stderr });
}

// ---------------------------------------------------------------------------
// resolveReviewerTimeoutMs — pure unit tests (RR-01..RR-08)
// ---------------------------------------------------------------------------

describe('resolveReviewerTimeoutMs', () => {
  it('RR-01: returns entry.timeout_ms when present', () => {
    expect(resolveReviewerTimeoutMs({ timeout_ms: 500000 }, undefined)).toBe(500000);
  });

  it('RR-02: returns parsed env value when entry absent', () => {
    expect(resolveReviewerTimeoutMs({}, '500000')).toBe(500000);
  });

  it('RR-03: returns 900_000 default when both absent', () => {
    expect(resolveReviewerTimeoutMs({}, undefined)).toBe(900000);
  });

  it('RR-04: clamps to 30_000 when value is below', () => {
    expect(resolveReviewerTimeoutMs({ timeout_ms: 10 }, undefined)).toBe(30000);
  });

  it('RR-05: clamps to 3_600_000 when value is above', () => {
    expect(resolveReviewerTimeoutMs({ timeout_ms: 99_999_999 }, undefined)).toBe(3600000);
  });

  it('RR-06: ignores garbage env value', () => {
    expect(resolveReviewerTimeoutMs({}, 'abc')).toBe(900000);
  });

  it('RR-07: ignores empty string env value', () => {
    expect(resolveReviewerTimeoutMs({}, '')).toBe(900000);
  });

  it('RR-08: clamps negative entry.timeout_ms to 30_000', () => {
    expect(resolveReviewerTimeoutMs({ timeout_ms: -5 }, undefined)).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher behaviour — DI-01..DI-10
// ---------------------------------------------------------------------------

describe('createClaudeDispatcher — timeout and parse paths (SPEC-REQ-000050)', () => {
  it('DI-01: exit code 124 → ReviewerTimeoutError + telemetry', async () => {
    const telemetryEvents: Array<Record<string, unknown>> = [];
    const spawnMock = mockSpawn(124, '', 'timeout');
    const dispatch = createClaudeDispatcher({
      spawn: spawnMock,
      telemetry: (ev) => telemetryEvents.push(ev),
    });
    const entry = makeEntry({ name: 'doc-reviewer', timeout_ms: 60000 });
    const context = makeContext();

    // First call: assert it rejects with ReviewerTimeoutError.
    await expect(dispatch(entry, context)).rejects.toBeInstanceOf(ReviewerTimeoutError);

    // Second call: capture and inspect the error fields.
    let caughtErr: ReviewerTimeoutError | undefined;
    try {
      await dispatch(entry, context);
    } catch (e) {
      caughtErr = e as ReviewerTimeoutError;
    }
    expect(caughtErr).toBeInstanceOf(ReviewerTimeoutError);
    expect(caughtErr!.timeout_ms).toBe(60000);
    expect(caughtErr!.message).toMatch(/timed out after 60000ms/);

    // Telemetry: one reviewer.timeout event per call (called twice above).
    const timeoutEvents = telemetryEvents.filter((e) => e.event === 'reviewer.timeout');
    expect(timeoutEvents.length).toBeGreaterThanOrEqual(1);
    const ev = timeoutEvents[0];
    expect(ev.reviewer).toBe('doc-reviewer');
    expect(ev.timeout_ms).toBe(60000);
  });

  it('DI-02: exit code 0, garbage stdout → ReviewerParseError + telemetry', async () => {
    const telemetryEvents: Array<Record<string, unknown>> = [];
    const dispatch = createClaudeDispatcher({
      spawn: mockSpawn(0, 'this is garbage'),
      telemetry: (ev) => telemetryEvents.push(ev),
    });

    let err: ReviewerParseError | undefined;
    try {
      await dispatch(makeEntry(), makeContext());
    } catch (e) {
      err = e as ReviewerParseError;
    }
    expect(err).toBeInstanceOf(ReviewerParseError);
    expect(err!.raw_output).toBe('this is garbage');
    expect(err!.message).toMatch(/unparseable output/);

    const parseEvents = telemetryEvents.filter((e) => e.event === 'reviewer.parse_failure');
    expect(parseEvents.length).toBe(1);
  });

  it('DI-03: envelope status:pass → APPROVE, score=threshold', async () => {
    const dispatch = createClaudeDispatcher({
      spawn: mockSpawn(0, '{"status":"pass","phase":"spec_review"}'),
    });
    const result = await dispatch(makeEntry({ threshold: 80 }), makeContext());
    expect(result.verdict).toBe('APPROVE');
    expect(result.score).toBe(80);
  });

  it('DI-04: envelope status:fail → REQUEST_CHANGES, score=0', async () => {
    const dispatch = createClaudeDispatcher({
      spawn: mockSpawn(0, '{"status":"fail","phase":"spec_review","feedback":"x"}'),
    });
    const result = await dispatch(makeEntry({ threshold: 80 }), makeContext());
    expect(result.verdict).toBe('REQUEST_CHANGES');
    expect(result.score).toBe(0);
  });

  it('DI-05: marker-only APPROVE → APPROVE, score=threshold', async () => {
    const dispatch = createClaudeDispatcher({
      spawn: mockSpawn(0, 'VERDICT: APPROVE'),
    });
    const result = await dispatch(makeEntry({ threshold: 75 }), makeContext());
    expect(result.verdict).toBe('APPROVE');
    expect(result.score).toBe(75);
  });

  it('DI-06: bare verdict JSON (regression guard — existing happy path)', async () => {
    const dispatch = createClaudeDispatcher({
      spawn: mockSpawn(0, '{"score":92,"verdict":"APPROVE"}'),
    });
    const result = await dispatch(makeEntry(), makeContext());
    expect(result.verdict).toBe('APPROVE');
    expect(result.score).toBe(92);
  });

  it('DI-07: generic non-zero, non-124 exit → generic Error, message contains code', async () => {
    const dispatch = createClaudeDispatcher({
      spawn: mockSpawn(1, '', 'ENOENT'),
    });

    let caughtErr: Error | undefined;
    try {
      await dispatch(makeEntry(), makeContext());
    } catch (e) {
      caughtErr = e as Error;
    }

    expect(caughtErr).toBeDefined();
    expect(caughtErr).toBeInstanceOf(Error);
    expect(caughtErr).not.toBeInstanceOf(ReviewerTimeoutError);
    expect(caughtErr).not.toBeInstanceOf(ReviewerParseError);
    expect(caughtErr!.message).toMatch(/exited with code 1/);
  });

  it('DI-08: runner maps ReviewerParseError → raw_output on result', async () => {
    const mockInvoke = jest.fn().mockImplementation(async () => {
      throw new ReviewerParseError('doc-reviewer', 'empty stdout', 'RAW');
    });
    const runner = new ReviewerRunner(mockInvoke);
    const entry = makeEntry({ name: 'doc-reviewer' });
    const exec: ScheduledExecution = {
      groups: [[{ entry, context: makeContext() }]],
    };
    const results = await runner.run(exec);
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.verdict).toBe('ERROR');
    expect(r.raw_output).toBe('RAW');
    expect(r.error_message).toMatch(/unparseable output/);
  });

  it('DI-09: runner maps ReviewerTimeoutError → error_message only (no raw_output)', async () => {
    const mockInvoke = jest.fn().mockImplementation(async () => {
      throw new ReviewerTimeoutError('doc-reviewer', 60000);
    });
    const runner = new ReviewerRunner(mockInvoke);
    const entry = makeEntry({ name: 'doc-reviewer' });
    const exec: ScheduledExecution = {
      groups: [[{ entry, context: makeContext() }]],
    };
    const results = await runner.run(exec);
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.verdict).toBe('ERROR');
    expect(r.error_message).toBe("reviewer 'doc-reviewer' timed out after 60000ms");
    expect(r.raw_output).toBeUndefined();
  });

  it('DI-10: duration_ms is populated on error paths', async () => {
    // Use a mock invoke that throws ReviewerTimeoutError directly.
    const mockInvoke = jest.fn().mockImplementation(async () => {
      throw new ReviewerTimeoutError('doc-reviewer', 60000);
    });
    const runner = new ReviewerRunner(mockInvoke);
    const entry = makeEntry({ name: 'doc-reviewer', timeout_ms: 60000 });
    const exec: ScheduledExecution = {
      groups: [[{ entry, context: makeContext() }]],
    };
    const results = await runner.run(exec);
    expect(results).toHaveLength(1);
    expect(results[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(results[0].duration_ms)).toBe(true);
  });
});
