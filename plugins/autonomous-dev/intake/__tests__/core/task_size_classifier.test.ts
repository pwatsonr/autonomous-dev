/**
 * Unit tests for the deterministic task-size classifier (#526).
 *
 * Conservative, asymmetric rules: trivial-docs is hard to reach; a false
 * trivial-classification (light pipeline on real work) is worse than a false
 * standard-classification, so adversarial doc-shaped-but-technical inputs must
 * land on `standard`.
 *
 * @module __tests__/core/task_size_classifier.test
 */

import {
  classifyTaskSize,
  isValidTaskSize,
  ALL_TASK_SIZES,
  type TaskSize,
} from '../../core/task_size_classifier';

describe('classifyTaskSize', () => {
  // -- trivial-docs (auto-classified) --------------------------------------
  describe('trivial-docs', () => {
    const trivial = [
      'append a line to the README',
      'fix typo in CONTRIBUTING.md',
      'update the changelog for the release',
      'fix wording in the docs intro paragraph',
      'add a license header comment to the file',
    ];
    it.each(trivial)('classifies %j as trivial-docs', (desc) => {
      const r = classifyTaskSize({ description: desc });
      expect(r.size).toBe('trivial-docs');
      expect(r.matchedSignals.length).toBeGreaterThan(0);
    });

    it('includes matched docs signals and word count in the result', () => {
      const r = classifyTaskSize({ description: 'append a line to the README' });
      expect(r.size).toBe('trivial-docs');
      expect(r.matchedSignals).toEqual(
        expect.arrayContaining([expect.stringContaining('docs-keyword:')]),
      );
      expect(r.reason).toContain('trivial docs edit');
    });
  });

  // -- standard (default + 70-word + technical) ----------------------------
  describe('standard (conservative default)', () => {
    it('classifies an endpoint/api request as standard', () => {
      const r = classifyTaskSize({
        description: 'add a new /health endpoint to the api',
      });
      expect(r.size).toBe('standard');
    });

    it('classifies a 70-word blurb as standard via word-count disqualifier', () => {
      const blurb = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ');
      const r = classifyTaskSize({ description: blurb });
      expect(r.size).toBe('standard');
      expect(r.matchedSignals).toEqual(
        expect.arrayContaining([expect.stringContaining('word-count>60')]),
      );
    });

    it('classifies a plain non-docs short request as standard', () => {
      const r = classifyTaskSize({ description: 'make the button blue' });
      expect(r.size).toBe('standard');
      expect(r.matchedSignals).toEqual([]);
    });

    it('classifies a docs request with a code keyword as standard', () => {
      // "test" is a code keyword -> disqualifies even with a docs keyword.
      const r = classifyTaskSize({ description: 'update the readme test section' });
      expect(r.size).toBe('standard');
    });
  });

  // -- ADVERSARIAL: must NOT be trivial ------------------------------------
  describe('adversarial — must NOT be trivial-docs', () => {
    const adversarial: Array<[string, string]> = [
      ['update the README and add the /health endpoint', 'technical-surface'],
      ['fix the typo in the auth/JWT validation', 'technical-surface'],
      ['rename userId everywhere across the codebase', 'breadth'],
      ['update docs and add a regression test', 'test-demanding'],
      ['append to changelog and run a database migration', 'technical-surface'],
      ['fix wording then deploy and rollback if needed', 'technical-surface'],
      // Mixed docs + real implementation — a feature wearing a docs hat. The
      // implementation verb / code-artifact noun must keep it off the light
      // path (found by adversarial probing of the first cut).
      ['update docs and implement the new login flow', 'code-keyword'],
      ['update the README then build the payment processing module', 'code-keyword'],
      ['add a section to CONTRIBUTING.md and create the user signup form', 'code-keyword'],
      ['add docs and wire up the websocket reconnect handler', 'code-keyword'],
    ];
    it.each(adversarial)('%j is NOT trivial-docs', (desc) => {
      const r = classifyTaskSize({ description: desc });
      expect(r.size).not.toBe('trivial-docs');
      expect(r.size).toBe('standard');
    });

    it('two distinct source-file paths disqualify even a docsy short request', () => {
      const r = classifyTaskSize({
        description: 'update docs in src/a/foo.ts and src/b/bar.ts',
      });
      expect(r.size).toBe('standard');
      expect(r.matchedSignals).toEqual(
        expect.arrayContaining([expect.stringContaining('distinct-source-paths:')]),
      );
    });

    it('multiple .md files do NOT disqualify (markdown is a docs signal, not source breadth)', () => {
      const r = classifyTaskSize({
        description: 'append a note to README.md and CHANGELOG.md',
      });
      expect(r.size).toBe('trivial-docs');
    });
  });

  // -- override precedence --------------------------------------------------
  describe('override precedence', () => {
    it('--size hint short-circuits and returns verbatim', () => {
      for (const size of ALL_TASK_SIZES) {
        const r = classifyTaskSize({
          description: 'add a new /health endpoint to the api', // would be standard
          sizeHint: size,
        });
        expect(r.size).toBe(size);
        expect(r.matchedSignals).toEqual(['explicit-size-hint']);
      }
    });

    it('--size large forces large even on a trivial-docs description', () => {
      const r = classifyTaskSize({
        description: 'append a line to the README',
        sizeHint: 'large',
      });
      expect(r.size).toBe('large');
    });

    it('an INVALID sizeHint is ignored and normal classification applies', () => {
      const r = classifyTaskSize({
        description: 'append a line to the README',
        sizeHint: 'gigantic',
      });
      expect(r.size).toBe('trivial-docs');
    });
  });

  // -- type guard -----------------------------------------------------------
  describe('isValidTaskSize', () => {
    it('accepts every canonical size and rejects others', () => {
      for (const s of ALL_TASK_SIZES) expect(isValidTaskSize(s)).toBe(true);
      expect(isValidTaskSize('gigantic')).toBe(false);
      expect(isValidTaskSize('')).toBe(false);
      expect(isValidTaskSize('TRIVIAL-DOCS')).toBe(false);
    });
  });

  // -- determinism ----------------------------------------------------------
  it('is deterministic — same input yields identical result', () => {
    const input = { description: 'fix typo in CONTRIBUTING.md' };
    const a = classifyTaskSize(input);
    const b = classifyTaskSize(input);
    expect(a).toEqual(b);
  });
});
