/**
 * Types for the auto-detection scanner (SPEC-021-1-03, TDD-021 §9).
 *
 * The scanner is "best effort": it surfaces signals from a repo and the
 * operator promotes them. These types describe its output shape.
 *
 * @module intake/standards/auto-detection-types
 */

import type { Rule } from './types';

/** Source signal that produced a `DetectedRule`. */
export type SignalKind =
  /** package.json / requirements.txt / pyproject.toml dependency entry. */
  | 'framework-dep'
  /** ESLint rule listed in `.eslintrc.json`. */
  | 'linter-config'
  /** Any `.prettierrc*` file present. */
  | 'formatter-config'
  /** `tsconfig.json` strict-mode flag(s). */
  | 'tsconfig-strict'
  /** Jest `testMatch` (config file or `package.json#jest`). */
  | 'test-runner-pattern'
  /** Tool name appears in README.md. */
  | 'readme-mention';

/** A single rule synthesized by the scanner with provenance. */
export interface DetectedRule {
  /** Synthesized rule. `id` always starts with `auto:`. */
  rule: Rule;
  /** Confidence in [0.0, 1.0] per the rubric in TDD-021 §9. */
  confidence: number;
  /** Repo-relative file paths that support the detection. */
  evidence: string[];
  /** Which signal handler produced this entry. */
  signal: SignalKind;
}

/** Aggregate output of `AutoDetectionScanner.scan()`. */
export interface ScanResult {
  detected: DetectedRule[];
  /** Soft warnings (e.g., missing optional file, malformed package.json). */
  warnings: string[];
}
