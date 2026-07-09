/**
 * Parser unit tests for parseReviewerOutput and normaliseVerdict.
 * REQ-000068: verifies CONCERNS verdict acceptance and normalisation.
 *
 * TC-001 – TC-011: parseReviewerOutput strategy table (including regression fixture for #618).
 * TC-012 – TC-021: normaliseVerdict direct-invoke tests.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseReviewerOutput, normaliseVerdict } from '../invoke-reviewer';
import type { ReviewerEntry } from '../types';

const loadFixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeEntry = (threshold: number): ReviewerEntry => ({
  name: 'test-reviewer',
  type: 'built-in',
  blocking: true,
  threshold,
  timeout_ms: 30_000,
});

// ---------------------------------------------------------------------------
// parseReviewerOutput — strategy table
// ---------------------------------------------------------------------------

describe('parseReviewerOutput — verdict-json strategy', () => {
  test('TC-001: verdict-json APPROVE', () => {
    const stdout = 'analysis...\n{"score":92,"verdict":"APPROVE","findings":[]}';
    const result = parseReviewerOutput(stdout);
    expect(result).toEqual({
      kind: 'verdict-json',
      score: 92,
      verdict: 'APPROVE',
      findings: [],
    });
  });

  test('TC-002: verdict-json CONCERNS (headline behavioural addition — REQ-000068)', () => {
    const stdout =
      'analysis...\n{"score":74,"verdict":"CONCERNS","findings":[{"severity":"medium","file":"a","line":1,"message":"m"}]}';
    const result = parseReviewerOutput(stdout);
    expect(result).toEqual({
      kind: 'verdict-json',
      score: 74,
      verdict: 'CONCERNS',
      findings: [{ severity: 'medium', file: 'a', line: 1, message: 'm' }],
    });
  });

  test('TC-003: verdict-json REQUEST_CHANGES', () => {
    const stdout =
      'analysis...\n{"score":10,"verdict":"REQUEST_CHANGES","findings":[{"severity":"blocking","file":"a","line":1,"message":"m"}]}';
    const result = parseReviewerOutput(stdout);
    expect(result).toEqual({
      kind: 'verdict-json',
      score: 10,
      verdict: 'REQUEST_CHANGES',
      findings: [{ severity: 'blocking', file: 'a', line: 1, message: 'm' }],
    });
  });

  test('TC-004: #618 repro fixture — parses as verdict-json CONCERNS', () => {
    const stdout = loadFixture('req-000068-parse-failure.txt');
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('verdict-json');
    expect(result.kind).not.toBe('parse-failure');
    if (result.kind === 'verdict-json') {
      expect(result.verdict).toBe('CONCERNS');
    }
  });
});

describe('parseReviewerOutput — phase-result envelope strategy', () => {
  test('TC-005: envelope pass (unchanged behaviour)', () => {
    const stdout = '{"status":"pass","phase":"spec_review","findings":[]}';
    const result = parseReviewerOutput(stdout);
    expect(result).toEqual({
      kind: 'phase-result-envelope',
      status: 'pass',
      phase: 'spec_review',
      feedback: undefined,
      findings: [],
    });
  });

  test('TC-006: envelope fail (unchanged behaviour)', () => {
    const stdout = '{"status":"fail","phase":"spec_review"}';
    const result = parseReviewerOutput(stdout);
    expect(result).toEqual({
      kind: 'phase-result-envelope',
      status: 'fail',
      phase: 'spec_review',
      feedback: undefined,
      findings: undefined,
    });
  });
});

describe('parseReviewerOutput — verdict marker strategy', () => {
  test('TC-007: verdict-marker only (unchanged behaviour)', () => {
    const stdout = 'some prose\nVERDICT: APPROVE\nmore prose';
    const result = parseReviewerOutput(stdout);
    expect(result).toEqual({ kind: 'verdict-marker', verdict: 'APPROVE' });
  });

  test('TC-008: both verdict-json AND VERDICT: marker → JSON wins (precedence)', () => {
    const stdout =
      'VERDICT: REQUEST_CHANGES\nprose...\n{"score":90,"verdict":"APPROVE","findings":[]}';
    const result = parseReviewerOutput(stdout);
    expect(result).toEqual({
      kind: 'verdict-json',
      score: 90,
      verdict: 'APPROVE',
      findings: [],
    });
  });
});

describe('parseReviewerOutput — parse failure cases', () => {
  test('TC-009: no tail, no envelope, no marker → parse failure', () => {
    const stdout = '# Review\n\nThis is a markdown-only review with no JSON and no marker.\n';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('parse-failure');
    if (result.kind === 'parse-failure') {
      expect(result.reason).toBe('no verdict marker, no JSON object, no envelope');
      expect(result.raw_output.length).toBeLessThanOrEqual(8192);
    }
  });

  test('TC-010: lowercase "concerns" is rejected (case-sensitivity)', () => {
    const stdout = '{"score":50,"verdict":"concerns","findings":[]}';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('parse-failure');
  });

  test('TC-011: verdict: "CONCERNS" but score missing → parse failure', () => {
    const stdout = '{"verdict":"CONCERNS","findings":[]}';
    const result = parseReviewerOutput(stdout);
    expect(result.kind).toBe('parse-failure');
  });
});

// ---------------------------------------------------------------------------
// normaliseVerdict — direct-invoke tests
// ---------------------------------------------------------------------------

describe('normaliseVerdict — CONCERNS mapping (ADR-618-03)', () => {
  const concernsParsed = {
    kind: 'verdict-json' as const,
    score: 74,
    verdict: 'CONCERNS' as const,
    findings: [] as object,
  };

  test('TC-012: CONCERNS, threshold=80 → score=60, REQUEST_CHANGES', () => {
    expect(normaliseVerdict(concernsParsed, makeEntry(80))).toEqual({
      score: 60,
      verdict: 'REQUEST_CHANGES',
      findings: [],
    });
  });

  test('TC-013: CONCERNS, threshold=61 → score=60', () => {
    expect(normaliseVerdict(concernsParsed, makeEntry(61))).toEqual({
      score: 60,
      verdict: 'REQUEST_CHANGES',
      findings: [],
    });
  });

  test('TC-014: CONCERNS, threshold=40 → score=39', () => {
    expect(normaliseVerdict(concernsParsed, makeEntry(40))).toEqual({
      score: 39,
      verdict: 'REQUEST_CHANGES',
      findings: [],
    });
  });

  test('TC-015: CONCERNS, threshold=100 → score=60 (cap)', () => {
    expect(normaliseVerdict(concernsParsed, makeEntry(100))).toEqual({
      score: 60,
      verdict: 'REQUEST_CHANGES',
      findings: [],
    });
  });
});

describe('normaliseVerdict — passthrough cases (unchanged behaviour)', () => {
  test('TC-016: APPROVE passthrough', () => {
    const parsed = {
      kind: 'verdict-json' as const,
      score: 92,
      verdict: 'APPROVE' as const,
      findings: [] as object,
    };
    expect(normaliseVerdict(parsed, makeEntry(70))).toEqual({
      score: 92,
      verdict: 'APPROVE',
      findings: [],
    });
  });

  test('TC-017: REQUEST_CHANGES passthrough', () => {
    const parsed = {
      kind: 'verdict-json' as const,
      score: 10,
      verdict: 'REQUEST_CHANGES' as const,
      findings: [] as object,
    };
    expect(normaliseVerdict(parsed, makeEntry(70))).toEqual({
      score: 10,
      verdict: 'REQUEST_CHANGES',
      findings: [],
    });
  });

  test('TC-018: envelope pass unchanged', () => {
    const parsed = {
      kind: 'phase-result-envelope' as const,
      status: 'pass' as const,
      phase: 'spec_review',
      findings: [] as unknown,
    };
    expect(normaliseVerdict(parsed, makeEntry(70))).toEqual({
      score: 70,
      verdict: 'APPROVE',
      findings: [],
    });
  });

  test('TC-019: envelope fail unchanged', () => {
    const parsed = {
      kind: 'phase-result-envelope' as const,
      status: 'fail' as const,
      phase: 'spec_review',
    };
    expect(normaliseVerdict(parsed, makeEntry(70))).toEqual({
      score: 0,
      verdict: 'REQUEST_CHANGES',
      findings: undefined,
    });
  });

  test('TC-020: marker APPROVE unchanged', () => {
    const parsed = {
      kind: 'verdict-marker' as const,
      verdict: 'APPROVE' as const,
    };
    expect(normaliseVerdict(parsed, makeEntry(70))).toEqual({
      score: 70,
      verdict: 'APPROVE',
    });
  });

  test('TC-021: marker REQUEST_CHANGES unchanged', () => {
    const parsed = {
      kind: 'verdict-marker' as const,
      verdict: 'REQUEST_CHANGES' as const,
    };
    expect(normaliseVerdict(parsed, makeEntry(70))).toEqual({
      score: 0,
      verdict: 'REQUEST_CHANGES',
    });
  });
});
