/**
 * Parser unit tests for `parseReviewerOutput` (SPEC-REQ-000050 TASK-002).
 *
 * Covers all 20 parser test cases (PARSE-01 through PARSE-20) specified in
 * SPEC-REQ-000050 §"Parser tests". Tests live under tests/reviewers/ to align
 * with the existing convention established by test-invoke-reviewer.test.ts and
 * sibling files.
 *
 * All tests are pure — no subprocess spawn, no I/O.
 */

import {
  parseReviewerOutput,
  type ParsedVerdict,
  type ParseFailure,
} from '../../intake/reviewers/invoke-reviewer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isParsedVerdict(r: ParsedVerdict | ParseFailure): r is ParsedVerdict {
  return r.kind !== 'parse-failure';
}

function isParseFailure(r: ParsedVerdict | ParseFailure): r is ParseFailure {
  return r.kind === 'parse-failure';
}

// ---------------------------------------------------------------------------
// PARSE-01..PARSE-11: happy-path and precedence tests
// ---------------------------------------------------------------------------

describe('parseReviewerOutput — happy paths', () => {
  it('PARSE-01: bare verdict JSON with chain-of-thought prefix', () => {
    const stdout = 'Some prose.\nSome more.\n{"score":85,"verdict":"APPROVE"}\n';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('verdict-json');
    if (result.kind === 'verdict-json') {
      expect(result.score).toBe(85);
      expect(result.verdict).toBe('APPROVE');
    }
  });

  it('PARSE-02: bare verdict JSON with findings', () => {
    const findings = [{ severity: 'blocking', file: 'a.ts', line: 3, message: 'x' }];
    const stdout = JSON.stringify({ score: 50, verdict: 'REQUEST_CHANGES', findings });
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('verdict-json');
    if (result.kind === 'verdict-json') {
      expect(result.score).toBe(50);
      expect(result.verdict).toBe('REQUEST_CHANGES');
      expect(result.findings).toEqual(findings);
    }
  });

  it('PARSE-03: phase-result envelope, status pass', () => {
    const stdout = '{"status":"pass","phase":"spec_review","feedback":"LGTM","findings":[]}';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('phase-result-envelope');
    if (result.kind === 'phase-result-envelope') {
      expect(result.status).toBe('pass');
      expect(result.phase).toBe('spec_review');
      expect(result.feedback).toBe('LGTM');
      expect(result.findings).toEqual([]);
    }
  });

  it('PARSE-04: phase-result envelope, status fail', () => {
    const stdout = JSON.stringify({
      status: 'fail',
      phase: 'spec_review',
      feedback: 'Missing API contracts',
      findings: [{ severity: 'blocking', message: 'no contracts' }],
    });
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('phase-result-envelope');
    if (result.kind === 'phase-result-envelope') {
      expect(result.status).toBe('fail');
      expect(result.phase).toBe('spec_review');
      expect(result.feedback).toBe('Missing API contracts');
    }
  });

  it('PARSE-05: verdict marker only — APPROVE', () => {
    const stdout = 'Review:\nLooks fine.\n\nVERDICT: APPROVE\n';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('verdict-marker');
    if (result.kind === 'verdict-marker') {
      expect(result.verdict).toBe('APPROVE');
    }
  });

  it('PARSE-06: verdict marker only — REQUEST_CHANGES', () => {
    const stdout = 'VERDICT: REQUEST_CHANGES';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('verdict-marker');
    if (result.kind === 'verdict-marker') {
      expect(result.verdict).toBe('REQUEST_CHANGES');
    }
  });

  it('PARSE-07: verdict marker BLOCK normalises to REQUEST_CHANGES', () => {
    const stdout = 'VERDICT: BLOCK';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('verdict-marker');
    if (result.kind === 'verdict-marker') {
      expect(result.verdict).toBe('REQUEST_CHANGES');
    }
  });

  it('PARSE-08: markdown-fenced verdict JSON', () => {
    const stdout = 'Some prose\n\n```json\n{"score":90,"verdict":"APPROVE"}\n```\n';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('verdict-json');
    if (result.kind === 'verdict-json') {
      expect(result.score).toBe(90);
      expect(result.verdict).toBe('APPROVE');
    }
  });

  it('PARSE-09: markdown-fenced phase-result envelope', () => {
    const stdout = '```\n{"status":"pass","phase":"code_review"}\n```';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('phase-result-envelope');
    if (result.kind === 'phase-result-envelope') {
      expect(result.status).toBe('pass');
      expect(result.phase).toBe('code_review');
    }
  });
});

describe('parseReviewerOutput — precedence rules', () => {
  it('PARSE-10: BOTH verdict JSON and marker present → JSON wins', () => {
    const stdout = 'VERDICT: REQUEST_CHANGES\n{"score":85,"verdict":"APPROVE"}';
    const result = parseReviewerOutput(stdout);
    // The JSON strategy runs first and wins.
    expect(result.kind).toBe('verdict-json');
    if (result.kind === 'verdict-json') {
      expect(result.score).toBe(85);
      expect(result.verdict).toBe('APPROVE');
    }
  });

  it('PARSE-11: BOTH envelope and marker present → envelope wins', () => {
    const stdout = 'VERDICT: APPROVE\n{"status":"fail","phase":"spec_review"}';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('phase-result-envelope');
    if (result.kind === 'phase-result-envelope') {
      expect(result.status).toBe('fail');
      expect(result.phase).toBe('spec_review');
    }
  });
});

// ---------------------------------------------------------------------------
// PARSE-12..PARSE-20: error paths and edge cases
// ---------------------------------------------------------------------------

describe('parseReviewerOutput — error paths', () => {
  it('PARSE-12: empty stdout → parse failure', () => {
    const result = parseReviewerOutput('');
    expect(result.kind).toBe('parse-failure');
    if (result.kind === 'parse-failure') {
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.raw_output).toBe('');
    }
  });

  it('PARSE-13: pure prose, no JSON, no marker → parse failure', () => {
    const stdout = 'This change looks fine to me.';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('parse-failure');
    if (result.kind === 'parse-failure') {
      expect(result.raw_output).toBe('This change looks fine to me.');
    }
  });
});

describe('parseReviewerOutput — truncation', () => {
  it('PARSE-14: truncation applied when stdout > 8192 chars', () => {
    const stdout = 'a'.repeat(9000);
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('parse-failure');
    if (result.kind === 'parse-failure') {
      const suffix = ' … [truncated]';
      expect(result.raw_output.endsWith(suffix)).toBe(true);
      expect(result.raw_output.length).toBe(8192 + suffix.length);
    }
  });

  it('PARSE-15: truncation NOT applied when stdout ≤ 8192 chars', () => {
    const stdout = 'a'.repeat(8192);
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('parse-failure');
    if (result.kind === 'parse-failure') {
      expect(result.raw_output).toBe('a'.repeat(8192));
      expect(result.raw_output.endsWith('[truncated]')).toBe(false);
    }
  });
});

describe('parseReviewerOutput — edge cases', () => {
  it('PARSE-17: marker line whitespace tolerance', () => {
    const stdout = '   VERDICT: APPROVE   ';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('verdict-marker');
    if (result.kind === 'verdict-marker') {
      expect(result.verdict).toBe('APPROVE');
    }
  });

  it('PARSE-18: marker text mid-sentence NOT on its own line → parse failure', () => {
    // The regex requires the VERDICT: token to be on its own line
    // with only optional leading/trailing whitespace.
    const stdout = 'We considered this VERDICT: APPROVE in the meeting.';
    const result = parseReviewerOutput(stdout);
    // No valid anchored marker, no valid JSON object, no envelope → parse failure.
    expect(result.kind).toBe('parse-failure');
  });

  it('PARSE-19: JSON with verdict but no score → NOT verdict-json; falls through to parse failure', () => {
    const stdout = '{"verdict":"APPROVE"}';
    const result = parseReviewerOutput(stdout);
    // Missing `score` → strategy 1 fails. No envelope shape, no marker.
    expect(result.kind).not.toBe('verdict-json');
    expect(result.kind).toBe('parse-failure');
  });

  it('PARSE-20: returned ParseFailure JSON-encodes safely', () => {
    const stdout = ' line\nVERDICT: oops';
    const result = parseReviewerOutput(stdout);
    // Must be serialisable without throwing.
    const serialised = JSON.stringify(result);
    expect(() => JSON.stringify(result)).not.toThrow();
    const roundTripped = JSON.parse(serialised) as Record<string, unknown>;
    expect(roundTripped.kind).toBe(result.kind);
  });
});
