/**
 * TASK-002 — Label constants and taxonomy helpers for the self-improvement loop.
 *
 * All label strings are typed as const literals so TypeScript can discriminate
 * on them at the call site. `DETECTED_LABELS` is the set the scan passes to
 * `gh issue list --label`.
 *
 * @module intake/triggers/self_improve/labels
 */

/** Label filed by the pipeline when it records a failure issue. */
export const LABEL_PIPELINE_FAILED = 'autodev:pipeline-failed' as const;

/** Label filed by the reviewer chain when it raises a finding. */
export const LABEL_REVIEWER_FINDING = 'autodev:reviewer-finding' as const;

/** Label a human (or operator) adds to trigger an automatic fix. */
export const LABEL_AUTO_FIX = 'autodev/auto-fix' as const;

/** Label added to a PR opened by the self-improvement loop. */
export const LABEL_SELF_FIX_PR = 'autodev:self-fix' as const;

/** Label added to an issue when a fix request is in-flight. */
export const LABEL_IN_PROGRESS = 'autodev:in-progress' as const;

/** Matches `autodev/priority:(P0|P1|P2|P3)`. */
export const PRIORITY_LABEL_RE = /^autodev\/priority:(P0|P1|P2|P3)$/;

/** Matches `autodev/type:(bug|refactor)`. */
export const TYPE_LABEL_RE = /^autodev\/type:(bug|refactor)$/;

/**
 * All labels that make an issue eligible for self-improvement detection.
 * Used as the `--label` filter when listing open issues.
 */
export const DETECTED_LABELS = [
  LABEL_PIPELINE_FAILED,
  LABEL_REVIEWER_FINDING,
  LABEL_AUTO_FIX,
] as const;

/** Issue priority derived from `autodev/priority:*` labels. */
export type PriorityTag = 'P0' | 'P1' | 'P2' | 'P3';

/** Issue type derived from `autodev/type:*` labels. */
export type TypeTag = 'bug' | 'refactor';

const PRIORITY_ORDER: PriorityTag[] = ['P0', 'P1', 'P2', 'P3'];

/**
 * Parse the highest-severity priority from a list of label strings.
 *
 * When multiple `autodev/priority:*` labels are present the highest severity
 * (P0 > P1 > P2 > P3) is returned. Unknown labels are silently ignored.
 * Returns `null` when no matching label is found.
 *
 * @param labels - The full set of label names on the issue.
 * @returns The highest priority tag found, or `null`.
 */
export function parsePriorityLabel(labels: readonly string[]): PriorityTag | null {
  const found: PriorityTag[] = [];
  for (const label of labels) {
    const m = PRIORITY_LABEL_RE.exec(label);
    if (m) found.push(m[1] as PriorityTag);
  }
  if (found.length === 0) return null;
  // Return the element with the lowest index in PRIORITY_ORDER (highest severity).
  return found.reduce((best, cur) =>
    PRIORITY_ORDER.indexOf(cur) < PRIORITY_ORDER.indexOf(best) ? cur : best,
  );
}

/**
 * Parse the issue type from a list of label strings.
 *
 * Returns the type from the FIRST matching `autodev/type:*` label (input
 * order). Returns `null` when no matching label is found.
 *
 * @param labels - The full set of label names on the issue.
 * @returns The first type tag found, or `null`.
 */
export function parseTypeLabel(labels: readonly string[]): TypeTag | null {
  for (const label of labels) {
    const m = TYPE_LABEL_RE.exec(label);
    if (m) return m[1] as TypeTag;
  }
  return null;
}
