/**
 * TASK-004 — Data-driven classifier for actionable self-improvement issues.
 *
 * Three classes (A1/A2/A3) are evaluated in catalog order; the first row
 * whose predicates all match wins. Pure — no I/O.
 *
 * @module intake/triggers/self_improve/actionable
 */

import {
  LABEL_PIPELINE_FAILED,
  LABEL_REVIEWER_FINDING,
  LABEL_AUTO_FIX,
} from './labels';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Discriminator for which catalog row matched. */
export type ActionableClassId = 'A1' | 'A2' | 'A3';

/**
 * A snapshot of a GitHub issue, as returned by `gh_issues.listOpen`.
 * `eventsCache` is populated lazily when event data has already been fetched.
 */
export interface IssueSnapshot {
  repoId: string;
  number: number;
  htmlUrl: string;
  title: string;
  body: string;
  labels: string[];
  authorLogin: string;
  updatedAt: string;
  fingerprint: string | null;
  reviewerBlockFp: string | null;
  eventsCache?: IssueEventsSnapshot;
}

/** Reduced view of issue events used by evidence checks. */
export interface IssueEventsSnapshot {
  /** Maps label name → login of the actor who most recently added that label. */
  labeledBy: Record<string, string>;
}

/** One row in the ACTIONABLE_CATALOG. */
export interface ClassifierRow {
  id: ActionableClassId;
  requiredLabels: readonly string[];
  authorPredicate?: (i: IssueSnapshot, botLogin: string) => boolean;
  bodyMarkerRe?: RegExp;
  /** When true, the issue's last-labeler event MUST be a human (checked in evidence, not here). */
  requiresHumanLabeler?: boolean;
  defaultType: 'bug' | 'refactor';
}

/** Result of `classify`. */
export interface ClassifyResult {
  matched: ClassifierRow | null;
}

// ---------------------------------------------------------------------------
// Catalog rows
// ---------------------------------------------------------------------------

/**
 * A1 — Pipeline-failed issue opened by the bot (or with a fingerprint marker).
 *
 * Match conditions:
 * - Has label `autodev:pipeline-failed`.
 * - Body contains `<!-- autodev-failure: <hex>+ -->` marker (fingerprint).
 * - Author is the bot (`authorLogin === botLogin`) OR `fingerprint !== null`.
 */
const ROW_A1: ClassifierRow = {
  id: 'A1',
  requiredLabels: [LABEL_PIPELINE_FAILED],
  bodyMarkerRe: /<!--\s*autodev-failure:\s*([A-Za-z0-9]{8,})\s*-->/,
  authorPredicate: (issue, botLogin) =>
    (botLogin !== '' && issue.authorLogin === botLogin) || issue.fingerprint !== null,
  defaultType: 'bug',
};

/**
 * A2 — Reviewer-finding issue with a block fingerprint marker.
 *
 * Match conditions:
 * - Has label `autodev:reviewer-finding`.
 * - Body contains `<!-- autodev-reviewer: <id> -->` marker.
 */
const ROW_A2: ClassifierRow = {
  id: 'A2',
  requiredLabels: [LABEL_REVIEWER_FINDING],
  bodyMarkerRe: /<!--\s*autodev-reviewer:\s*([A-Za-z0-9_.-]+)\s*-->/,
  defaultType: 'bug',
};

/**
 * A3 — Human-labeled auto-fix request.
 *
 * Match conditions:
 * - Has label `autodev/auto-fix`.
 * - Human-labeler check is deferred to evidence (requiresHumanLabeler).
 */
const ROW_A3: ClassifierRow = {
  id: 'A3',
  requiredLabels: [LABEL_AUTO_FIX],
  requiresHumanLabeler: true,
  defaultType: 'bug',
};

/** Ordered catalog — evaluated top-to-bottom; first match wins. */
export const ACTIONABLE_CATALOG: readonly ClassifierRow[] = [ROW_A1, ROW_A2, ROW_A3];

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a GitHub issue against the ACTIONABLE_CATALOG.
 *
 * Iterates rows in declaration order. Returns the first row where:
 * - All `requiredLabels` appear in `issue.labels`.
 * - (If defined) `authorPredicate(issue, botLogin) === true`.
 * - (If defined) `bodyMarkerRe.test(issue.body) === true`.
 *
 * Pure — no I/O. Does not mutate any input.
 *
 * @param issue - The issue snapshot to classify.
 * @param cfg - Classification config (currently only `botLogin` is used).
 * @returns A `ClassifyResult` with `matched` set to the first matching row,
 *   or `null` if no row matches.
 */
export function classify(
  issue: IssueSnapshot,
  cfg: { botLogin: string },
): ClassifyResult {
  for (const row of ACTIONABLE_CATALOG) {
    // 1. Required labels
    if (!row.requiredLabels.every((l) => issue.labels.includes(l))) continue;

    // 2. Author predicate (if defined)
    if (row.authorPredicate !== undefined) {
      if (!row.authorPredicate(issue, cfg.botLogin)) continue;
    }

    // 3. Body marker regex (if defined)
    if (row.bodyMarkerRe !== undefined) {
      if (!row.bodyMarkerRe.test(issue.body)) continue;
    }

    return { matched: row };
  }
  return { matched: null };
}
