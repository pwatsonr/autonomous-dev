/**
 * Precision report helper for the auto-detection scanner (SPEC-021-1-05).
 *
 * Iterates the repo fixtures under `tests/fixtures/standards/repos/<name>/`,
 * runs `AutoDetectionScanner` against each, and classifies every detected
 * rule against the repo's `expected-detections.json`:
 *
 *   - true positive  (TP): id is in `expected[]`
 *   - false positive (FP): id is in `notExpected[]`
 *   - ignored:            id is in neither list (out-of-scope detection,
 *                         neither rewarded nor penalised)
 *
 * Per-signal precision = TP_signal / (TP_signal + FP_signal). When a signal
 * has no observations the precision is reported as `1.0` (no false positives,
 * vacuously precise) so the threshold check does not penalise an unused
 * signal. When the corpus shrinks below the SPEC-021-1-05 ≥0.80 floor on
 * any signal with observations, the test fails.
 *
 * @module tests/standards/precision-report
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { AutoDetectionScanner } from '../../intake/standards/auto-detection';
import type { SignalKind } from '../../intake/standards/auto-detection-types';

/** All `SignalKind` values the scanner can emit. Kept in sync with the type. */
export const ALL_SIGNALS: ReadonlyArray<SignalKind> = [
  'framework-dep',
  'linter-config',
  'formatter-config',
  'tsconfig-strict',
  'test-runner-pattern',
  'readme-mention',
];

export interface PrecisionReport {
  /** Per-signal precision in `[0, 1]`. */
  precision: Record<SignalKind, number>;
  /** Per-signal raw counts, useful for forensic inspection. */
  counts: Record<SignalKind, { tp: number; fp: number; ignored: number }>;
  /** Per-repo classifications, kept for the JSON artifact. */
  perRepo: Array<{
    repo: string;
    tp: string[];
    fp: string[];
    ignored: string[];
  }>;
}

interface ExpectedDetections {
  expected: string[];
  notExpected: string[];
}

/**
 * Default location of the repo fixture corpus. Resolved at module load.
 */
export const REPOS_ROOT = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'standards',
  'repos',
);

/** Compute the per-signal precision report across every repo fixture. */
export async function computePrecisionReport(
  reposRoot: string = REPOS_ROOT,
): Promise<PrecisionReport> {
  const counts: Record<SignalKind, { tp: number; fp: number; ignored: number }> =
    {} as Record<SignalKind, { tp: number; fp: number; ignored: number }>;
  for (const sig of ALL_SIGNALS) counts[sig] = { tp: 0, fp: 0, ignored: 0 };

  const perRepo: PrecisionReport['perRepo'] = [];

  const entries = (await fs.readdir(reposRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(); // deterministic ordering

  for (const repoName of entries) {
    const repoPath = path.join(reposRoot, repoName);
    const expectedPath = path.join(repoPath, 'expected-detections.json');

    let expectations: ExpectedDetections;
    try {
      expectations = JSON.parse(
        await fs.readFile(expectedPath, 'utf8'),
      ) as ExpectedDetections;
    } catch {
      // Skip directories without an expectations file; they aren't fixtures.
      continue;
    }
    const expectedSet = new Set(expectations.expected);
    const notExpectedSet = new Set(expectations.notExpected);

    const scanner = new AutoDetectionScanner(repoPath);
    const result = await scanner.scan();

    const tp: string[] = [];
    const fp: string[] = [];
    const ignored: string[] = [];

    for (const d of result.detected) {
      if (expectedSet.has(d.rule.id)) {
        counts[d.signal].tp += 1;
        tp.push(d.rule.id);
      } else if (notExpectedSet.has(d.rule.id)) {
        counts[d.signal].fp += 1;
        fp.push(d.rule.id);
      } else {
        counts[d.signal].ignored += 1;
        ignored.push(d.rule.id);
      }
    }

    perRepo.push({ repo: repoName, tp, fp, ignored });
  }

  const precision: Record<SignalKind, number> = {} as Record<SignalKind, number>;
  for (const sig of ALL_SIGNALS) {
    const c = counts[sig];
    const observed = c.tp + c.fp;
    precision[sig] = observed === 0 ? 1.0 : c.tp / observed;
  }

  return { precision, counts, perRepo };
}
