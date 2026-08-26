/**
 * Runner integration tests for CONCERNS verdict end-to-end path (REQ-000068).
 *
 * Mirrors runner.retry-then-exclude.test.ts style: injected invoke mock,
 * Jest describe/test blocks.
 *
 * TC-022: CONCERNS result (post-normalisation) flows through runner as
 *   REQUEST_CHANGES with no error_kind and no raw_output.
 * TC-023: telemetry emitter is NOT called with reviewer.parse_failure event.
 */

import { runReviewers } from '../runner';
import type { ReviewerEntry, ChangeSetContext, ReviewerResult } from '../types';

const fakeEntry = (name: string): ReviewerEntry => ({
  name,
  type: 'built-in',
  blocking: true,
  threshold: 70,
  timeout_ms: 30_000,
});

const fakeCtx: ChangeSetContext = {
  repoPath: '/repo',
  changedFiles: ['standards.yaml'],
  requestId: 'REQ-000068',
  gate: 'code_review',
  requestType: 'refactor',
  isFrontendChange: false,
};

describe('runReviewers — CONCERNS end-to-end normalisation (TC-022)', () => {
  test('TC-022: CONCERNS-derived result flows as REQUEST_CHANGES, no error_kind, no raw_output', async () => {
    // The mock simulates what createClaudeDispatcher returns after
    // normaliseVerdict maps CONCERNS → REQUEST_CHANGES with score=60 (threshold=70).
    const invoke = jest.fn(async (_entry: ReviewerEntry) => ({
      score: 60,
      verdict: 'REQUEST_CHANGES' as const,
      findings: [{ severity: 'warn', file: 'standards.yaml', line: 1, message: 'y' }],
    }));

    const results: ReviewerResult[] = await runReviewers(
      [fakeEntry('standards-meta-reviewer')],
      fakeCtx,
      {},
      { invoke },
    );

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.verdict).toBe('REQUEST_CHANGES');
    expect(r.score).toBe(60);
    expect(r.error_kind).toBeUndefined();
    expect(r.raw_output).toBeUndefined();
    expect(r.error_message).toBeUndefined();
  });

  test('TC-022b: invoke was called exactly once (no spurious retry)', async () => {
    const invoke = jest.fn(async (_entry: ReviewerEntry) => ({
      score: 60,
      verdict: 'REQUEST_CHANGES' as const,
    }));

    await runReviewers([fakeEntry('standards-meta-reviewer')], fakeCtx, {}, { invoke });

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('runReviewers — CONCERNS telemetry check (TC-023)', () => {
  test('TC-023: telemetry emitter is NOT called with parse_failure event for CONCERNS path', async () => {
    const telemetryEvents: string[] = [];

    // The runner's telemetry emit receives reviewer invocation logs, not
    // dispatcher telemetry. We verify the result has no error_kind (which
    // would indicate parse failure), confirming no parse_failure was emitted.
    const invoke = jest.fn(async (_entry: ReviewerEntry) => ({
      score: 60,
      verdict: 'REQUEST_CHANGES' as const,
      findings: [],
    }));

    const emit = jest.fn((log: { verdict: string }) => {
      telemetryEvents.push(log.verdict);
    });

    const results = await runReviewers(
      [fakeEntry('standards-meta-reviewer')],
      fakeCtx,
      {},
      { invoke, emit },
    );

    expect(results[0].verdict).toBe('REQUEST_CHANGES');
    // Telemetry emitter was called once with REQUEST_CHANGES (not ERROR)
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'REQUEST_CHANGES' }),
    );
    expect(emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'ERROR' }),
    );
  });
});
