/**
 * FindingTracker: tracks findings across iterations to detect resolution,
 * recurrence, and persistence.
 *
 * Based on SPEC-004-3-2, Task 5.
 *
 * Matching key: (section_id, category_id) pair.
 */

import type { MergedFinding } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of tracking findings across iterations. */
export interface FindingTrackingResult {
  /** Current findings with resolution_status and prior_finding_id populated. */
  tracked_findings: MergedFinding[];
  /** Findings from previous iteration now resolved (not in current). */
  resolved_findings: MergedFinding[];
  /** Findings that recurred -- previously resolved, now reappeared. Subset of tracked_findings. */
  recurred_findings: MergedFinding[];
  /** Findings with no prior match at all (new). Subset of tracked_findings. */
  new_findings: MergedFinding[];
  /** Findings that match a previous-iteration finding (persisted). Subset of tracked_findings. */
  persistent_findings: MergedFinding[];
}

// ---------------------------------------------------------------------------
// FindingTracker
// ---------------------------------------------------------------------------

export class FindingTracker {
  /**
   * Tracks findings across iterations, populating resolution_status and
   * prior_finding_id on each current finding.
   *
   * @param currentFindings - Merged findings from the current iteration.
   * @param previousIterationFindings - Merged findings from the immediately
   *   prior iteration. Pass null for the first iteration.
   * @param allPreviousFindings - All findings from all previous iterations
   *   (used for recurrence detection). Defaults to empty.
   * @returns A FindingTrackingResult with categorized findings.
   */
  trackFindings(
    currentFindings: MergedFinding[],
    previousIterationFindings: MergedFinding[] | null,
    allPreviousFindings: MergedFinding[] = [],
  ): FindingTrackingResult {
    // Iteration 1: no previous findings
    if (previousIterationFindings === null) {
      const tracked = currentFindings.map((f) => ({
        ...f,
        resolution_status: 'open' as const,
        prior_finding_id: null,
      }));
      return {
        tracked_findings: tracked,
        resolved_findings: [],
        recurred_findings: [],
        new_findings: tracked,
        persistent_findings: [],
      };
    }

    const tracked: MergedFinding[] = [];
    const recurred: MergedFinding[] = [];
    const newFindings: MergedFinding[] = [];
    const persistent: MergedFinding[] = [];

    // Track which previous-iteration findings were matched
    const matchedPreviousIds = new Set<string>();

    for (const current of currentFindings) {
      const key = matchKey(current);

      // Step 2a: Search previousIterationFindings for a match
      const prevMatch = previousIterationFindings.find(
        (prev) => matchKey(prev) === key,
      );

      if (prevMatch) {
        // Finding persists from previous iteration
        const trackedFinding: MergedFinding = {
          ...current,
          resolution_status: 'open',
          prior_finding_id: prevMatch.id,
        };
        tracked.push(trackedFinding);
        persistent.push(trackedFinding);
        matchedPreviousIds.add(prevMatch.id);
        continue;
      }

      // Step 2c: Search allPreviousFindings for a previously resolved match
      const resolvedMatch = allPreviousFindings.find(
        (prev) =>
          matchKey(prev) === key &&
          prev.resolution_status === 'resolved',
      );

      if (resolvedMatch) {
        // Finding recurred
        const trackedFinding: MergedFinding = {
          ...current,
          resolution_status: 'recurred',
          prior_finding_id: resolvedMatch.id,
        };
        tracked.push(trackedFinding);
        recurred.push(trackedFinding);
        continue;
      }

      // New finding, no prior match
      const trackedFinding: MergedFinding = {
        ...current,
        resolution_status: 'open',
        prior_finding_id: null,
      };
      tracked.push(trackedFinding);
      newFindings.push(trackedFinding);
    }

    // Step 3: Identify resolved findings (in previous iteration but not matched)
    const resolved: MergedFinding[] = previousIterationFindings
      .filter((prev) => !matchedPreviousIds.has(prev.id))
      .map((prev) => ({
        ...prev,
        resolution_status: 'resolved' as const,
      }));

    return {
      tracked_findings: tracked,
      resolved_findings: resolved,
      recurred_findings: recurred,
      new_findings: newFindings,
      persistent_findings: persistent,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes the matching key for a finding: (section_id, category_id).
 */
function matchKey(finding: MergedFinding): string {
  return `${finding.section_id}::${finding.category_id}`;
}
