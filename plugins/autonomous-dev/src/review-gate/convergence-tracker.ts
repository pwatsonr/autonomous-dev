/**
 * Convergence tracking for the review iteration loop.
 *
 * Analyzes score trends and finding patterns across iterations to detect
 * stagnation. Stagnation occurs when ANY of the following are true:
 * - Aggregate score declines
 * - Previously resolved findings recur
 * - Total finding count does not decrease
 *
 * Based on SPEC-004-3-1 section 2.
 */

import { MergedFinding } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConvergenceAnalysis {
  stagnation_detected: boolean;
  stagnation_reasons: string[];
  score_trend: 'improving' | 'flat' | 'declining';
  score_delta: number | null;
  resolved_findings: string[];
  recurred_findings: string[];
  finding_count_trend: 'decreasing' | 'flat' | 'increasing';
}

export interface ScoreHistoryEntry {
  iteration: number;
  aggregate_score: number;
}

export interface FindingHistoryEntry {
  iteration: number;
  findings: MergedFinding[];
}

export interface ConvergenceState {
  current_iteration: number;
  score_history: ScoreHistoryEntry[];
  finding_history: FindingHistoryEntry[];
}

// ---------------------------------------------------------------------------
// ConvergenceTracker
// ---------------------------------------------------------------------------

export class ConvergenceTracker {
  /**
   * Analyzes convergence of the review loop.
   *
   * Only meaningful when current_iteration >= 2 (need at least 2 data points).
   * For iteration 1 (or when insufficient data), returns a neutral analysis
   * with stagnation_detected: false.
   */
  analyze(state: ConvergenceState): ConvergenceAnalysis {
    // Default result for iteration 1 or insufficient data
    if (state.current_iteration < 2 || state.score_history.length < 2) {
      return {
        stagnation_detected: false,
        stagnation_reasons: [],
        score_trend: 'flat',
        score_delta: null,
        resolved_findings: [],
        recurred_findings: [],
        finding_count_trend: 'flat',
      };
    }

    // 1. Score trend
    const currentScoreEntry = state.score_history.find(
      (h) => h.iteration === state.current_iteration
    );
    const previousScoreEntry = state.score_history.find(
      (h) => h.iteration === state.current_iteration - 1
    );

    const currentScore = currentScoreEntry?.aggregate_score ?? 0;
    const previousScore = previousScoreEntry?.aggregate_score ?? 0;
    const scoreDelta = currentScore - previousScore;

    let scoreTrend: 'improving' | 'flat' | 'declining';
    if (scoreDelta > 0) {
      scoreTrend = 'improving';
    } else if (scoreDelta < 0) {
      scoreTrend = 'declining';
    } else {
      scoreTrend = 'flat';
    }

    // 2. Finding resolution
    const currentFindingEntry = state.finding_history.find(
      (h) => h.iteration === state.current_iteration
    );
    const previousFindingEntry = state.finding_history.find(
      (h) => h.iteration === state.current_iteration - 1
    );

    const currentFindings = currentFindingEntry?.findings ?? [];
    const previousFindings = previousFindingEntry?.findings ?? [];

    const resolvedFindings = this.findResolvedFindings(previousFindings, currentFindings);

    // 3. Finding recurrence -- check against ALL previously resolved findings
    const allResolvedIds = this.getAllResolvedFindingKeys(state);
    const recurredFindings = this.findRecurredFindings(currentFindings, allResolvedIds);

    // 4. Finding count trend
    const currentCount = currentFindings.length;
    const previousCount = previousFindings.length;

    let findingCountTrend: 'decreasing' | 'flat' | 'increasing';
    if (currentCount < previousCount) {
      findingCountTrend = 'decreasing';
    } else if (currentCount === previousCount) {
      findingCountTrend = 'flat';
    } else {
      findingCountTrend = 'increasing';
    }

    // 5. Stagnation detection
    const stagnationReasons: string[] = [];

    if (scoreTrend === 'declining') {
      stagnationReasons.push(
        `Aggregate score declined from ${previousScore} to ${currentScore}.`
      );
    }

    if (recurredFindings.length > 0) {
      stagnationReasons.push(
        `${recurredFindings.length} previously resolved finding(s) have recurred.`
      );
    }

    if (findingCountTrend !== 'decreasing') {
      stagnationReasons.push(
        `Total finding count did not decrease (${previousCount} -> ${currentCount}).`
      );
    }

    return {
      stagnation_detected: stagnationReasons.length > 0,
      stagnation_reasons: stagnationReasons,
      score_trend: scoreTrend,
      score_delta: scoreDelta,
      resolved_findings: resolvedFindings,
      recurred_findings: recurredFindings,
      finding_count_trend: findingCountTrend,
    };
  }

  /**
   * Finds findings from the previous iteration that are not present in the
   * current iteration, using (section_id, category_id) as the match key.
   */
  private findResolvedFindings(
    previousFindings: MergedFinding[],
    currentFindings: MergedFinding[]
  ): string[] {
    const currentKeys = new Set(
      currentFindings.map((f) => `${f.section_id}::${f.category_id}`)
    );

    const resolved: string[] = [];
    for (const finding of previousFindings) {
      const key = `${finding.section_id}::${finding.category_id}`;
      if (!currentKeys.has(key)) {
        resolved.push(finding.id);
      }
    }

    return resolved;
  }

  /**
   * Builds a set of match keys for findings that were resolved in any
   * previous iteration (present in iteration N but absent in N+1).
   */
  private getAllResolvedFindingKeys(state: ConvergenceState): Set<string> {
    const resolvedKeys = new Set<string>();

    // Sort finding history by iteration
    const sorted = [...state.finding_history].sort(
      (a, b) => a.iteration - b.iteration
    );

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];

      const nextKeys = new Set(
        next.findings.map((f) => `${f.section_id}::${f.category_id}`)
      );

      for (const finding of current.findings) {
        const key = `${finding.section_id}::${finding.category_id}`;
        if (!nextKeys.has(key)) {
          resolvedKeys.add(key);
        }
      }
    }

    return resolvedKeys;
  }

  /**
   * Finds current findings whose (section_id, category_id) key matches
   * a previously resolved finding.
   */
  private findRecurredFindings(
    currentFindings: MergedFinding[],
    resolvedKeys: Set<string>
  ): string[] {
    const recurred: string[] = [];

    for (const finding of currentFindings) {
      const key = `${finding.section_id}::${finding.category_id}`;
      if (resolvedKeys.has(key)) {
        recurred.push(finding.id);
      }
    }

    return recurred;
  }
}
