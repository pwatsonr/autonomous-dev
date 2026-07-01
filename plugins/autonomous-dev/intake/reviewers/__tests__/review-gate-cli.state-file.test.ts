/**
 * Tests for review-gate-cli --state-file flag (REQ-000056 TC-042).
 *
 * Verifies that the CLI correctly reads self-heal fields from state.json and
 * threads them into runReviewers opts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSelfHealState } from '../../../bin/review-gate-cli';

// Helper to create a temp state.json
function writeTempState(obj: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-test-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

describe('loadSelfHealState — --state-file parsing (TC-042)', () => {
  test('Test 1: excluded_reviewers=["X"] → excludedReviewers===["X"]', () => {
    const stateFile = writeTempState({
      current_phase_metadata: {
        self_heal: {
          excluded_reviewers: ['X'],
        },
      },
    });

    const result = loadSelfHealState(stateFile);
    expect(result.excludedReviewers).toEqual(['X']);
  });

  test('Test 2: reviewer_timeout_overrides:{Y:9999} → reviewerTimeoutOverrides.Y===9999', () => {
    const stateFile = writeTempState({
      current_phase_metadata: {
        self_heal: {
          reviewer_timeout_overrides: { Y: 9999 },
        },
      },
    });

    const result = loadSelfHealState(stateFile);
    expect(result.reviewerTimeoutOverrides['Y']).toBe(9999);
  });

  test('Test 3: review_chain_disabled:true → reviewChainDisabled===true', () => {
    const stateFile = writeTempState({
      current_phase_metadata: {
        self_heal: {
          review_chain_disabled: true,
        },
      },
    });

    const result = loadSelfHealState(stateFile);
    expect(result.reviewChainDisabled).toBe(true);
  });

  test('Test 4: no --state-file (empty string) → safe defaults', () => {
    const result = loadSelfHealState('');
    expect(result.excludedReviewers).toEqual([]);
    expect(result.reviewerTimeoutOverrides).toEqual({});
    expect(result.reviewChainDisabled).toBe(false);
  });

  test('Test 5: missing self_heal subtree → safe defaults', () => {
    const stateFile = writeTempState({
      current_phase_metadata: {},
    });

    const result = loadSelfHealState(stateFile);
    expect(result.excludedReviewers).toEqual([]);
    expect(result.reviewerTimeoutOverrides).toEqual({});
    expect(result.reviewChainDisabled).toBe(false);
  });

  test('Test 6: missing file → safe defaults (no throw)', () => {
    const result = loadSelfHealState('/nonexistent/path/state.json');
    expect(result.excludedReviewers).toEqual([]);
    expect(result.reviewChainDisabled).toBe(false);
  });

  test('Test 7: malformed JSON → safe defaults (no throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-test-'));
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, 'NOT JSON {{{');

    const result = loadSelfHealState(file);
    expect(result.excludedReviewers).toEqual([]);
    expect(result.reviewChainDisabled).toBe(false);
  });
});
