/**
 * Human Escalation Gateway for the review gate system.
 *
 * Assembles escalation packages with full context (version diffs, score trends,
 * unresolved/recurred findings, parent document, traceability) and computes a
 * recommended action for the human operator.
 *
 * Based on SPEC-004-3-3 section 1.
 */

import { DocumentType, GateReviewResult, MergedFinding } from './types';
import { IterationState } from './iteration-controller';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EscalationTrigger =
  | 'max_iterations_exhausted'
  | 'critical_reject_finding'
  | 'stagnation_persisted'
  | 'trust_level_requirement'
  | 'backward_cascade_depth_exceeded';

export interface DocumentVersion {
  version: string;
  content: string;
  created_at: string;
}

export interface VersionDiff {
  from_version: string;
  to_version: string;
  diff: string; // unified diff format
}

export interface DocumentSummary {
  document_id: string;
  document_type: DocumentType;
  title: string;
  summary: string; // first 500 words or executive summary section
}

export interface TraceLink {
  parent_document_id: string;
  parent_section_id: string;
  child_section_id: string;
}

export interface EscalationPackage {
  document_id: string;
  document_type: DocumentType;
  escalation_reason: string;
  escalation_trigger: EscalationTrigger;
  current_version: DocumentVersion;
  version_history: DocumentVersion[];
  review_history: GateReviewResult[];
  diffs: VersionDiff[];
  score_trend: number[];
  unresolved_findings: MergedFinding[];
  recurred_findings: MergedFinding[];
  parent_document: DocumentSummary | null;
  traceability_context: TraceLink[];
  recommended_action: 'approve_override' | 'manual_revision' | 'reject_and_restart';
  recommended_action_rationale: string;
}

// ---------------------------------------------------------------------------
// Recommended action computation
// ---------------------------------------------------------------------------

/**
 * Determines the recommended human action based on review history and findings.
 *
 * - approve_override: latest score within 3 points of threshold AND no critical findings
 * - reject_and_restart: critical findings OR stagnation OR declining scores
 * - manual_revision: default fallback
 */
export function computeRecommendedAction(
  reviewHistory: GateReviewResult[],
  currentFindings: MergedFinding[],
  threshold: number
): { action: 'approve_override' | 'manual_revision' | 'reject_and_restart'; rationale: string } {
  const latestReview = reviewHistory[reviewHistory.length - 1];
  const latestScore = latestReview.aggregate_score;
  const hasCriticalFindings = currentFindings.some((f) => f.severity === 'critical');
  const scoreTrend = reviewHistory.map((r) => r.aggregate_score);
  const isScoreDeclining =
    scoreTrend.length >= 2 &&
    scoreTrend[scoreTrend.length - 1] < scoreTrend[scoreTrend.length - 2];
  const isStagnating = latestReview.stagnation_warning;

  // approve_override: within 3 points of threshold AND no critical findings
  if (latestScore >= threshold - 3 && !hasCriticalFindings) {
    return {
      action: 'approve_override',
      rationale: `Latest score (${latestScore.toFixed(2)}) is within 3 points of the threshold (${threshold}). No critical findings. The remaining gap may be rubric noise. Consider approving with notes.`,
    };
  }

  // reject_and_restart: critical findings OR stagnation OR declining scores
  if (hasCriticalFindings || isStagnating || isScoreDeclining) {
    const reasons: string[] = [];
    if (hasCriticalFindings) reasons.push('critical findings present');
    if (isStagnating) reasons.push('stagnation detected');
    if (isScoreDeclining) reasons.push('scores declining across iterations');
    return {
      action: 'reject_and_restart',
      rationale: `Recommend rejection: ${reasons.join(', ')}. The document may need fundamental revision or parent document correction.`,
    };
  }

  // manual_revision: default
  return {
    action: 'manual_revision',
    rationale: `Specific findings remain unresolved but the document is fundamentally sound (score: ${latestScore.toFixed(2)}). Human guidance on the unresolved findings may help the author converge.`,
  };
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

/**
 * Computes a simple unified-style diff between two strings.
 * Uses line-by-line comparison with context lines.
 */
function computeUnifiedDiff(
  fromContent: string,
  toContent: string,
  fromLabel: string,
  toLabel: string
): string {
  const fromLines = fromContent.split('\n');
  const toLines = toContent.split('\n');

  const lines: string[] = [];
  lines.push(`--- ${fromLabel}`);
  lines.push(`+++ ${toLabel}`);

  const maxLen = Math.max(fromLines.length, toLines.length);
  let inHunk = false;
  let hunkStart = -1;
  const hunkLines: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    const fromLine = i < fromLines.length ? fromLines[i] : undefined;
    const toLine = i < toLines.length ? toLines[i] : undefined;

    if (fromLine === toLine) {
      if (inHunk) {
        hunkLines.push(` ${fromLine}`);
      }
    } else {
      if (!inHunk) {
        inHunk = true;
        hunkStart = i + 1;
        hunkLines.length = 0;
      }
      if (fromLine !== undefined && toLine !== undefined) {
        hunkLines.push(`-${fromLine}`);
        hunkLines.push(`+${toLine}`);
      } else if (fromLine !== undefined) {
        hunkLines.push(`-${fromLine}`);
      } else if (toLine !== undefined) {
        hunkLines.push(`+${toLine}`);
      }
    }
  }

  if (hunkLines.length > 0) {
    lines.push(`@@ -${hunkStart} +${hunkStart} @@`);
    lines.push(...hunkLines);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HumanEscalationGateway
// ---------------------------------------------------------------------------

export class HumanEscalationGateway {
  /**
   * Assembles a complete escalation package for human review.
   *
   * Includes version diffs, score trends, filtered findings, parent document
   * context, traceability links, and a computed recommended action.
   */
  async assemblePackage(
    iterationState: IterationState,
    reviewHistory: GateReviewResult[],
    currentFindings: MergedFinding[],
    escalationTrigger: EscalationTrigger,
    documentVersions: DocumentVersion[],
    parentDocument: DocumentSummary | null,
    traceLinks: TraceLink[]
  ): Promise<EscalationPackage> {
    // Current version is the last in the list
    const currentVersion = documentVersions[documentVersions.length - 1];

    // Escalation reason derived from trigger
    const escalationReason = this.buildEscalationReason(
      escalationTrigger,
      iterationState,
      currentFindings,
      reviewHistory
    );

    // Version diffs: consecutive pairs
    const diffs = this.computeVersionDiffs(documentVersions);

    // Score trend: aggregate_score from each review in chronological order
    const scoreTrend = reviewHistory.map((r) => r.aggregate_score);

    // Filter findings
    const unresolvedFindings = currentFindings.filter(
      (f) => f.resolution_status === 'open'
    );
    const recurredFindings = currentFindings.filter(
      (f) => f.resolution_status === 'recurred'
    );

    // Recommended action
    const threshold = reviewHistory.length > 0 ? reviewHistory[0].threshold : 85;
    const { action, rationale } = computeRecommendedAction(
      reviewHistory,
      currentFindings,
      threshold
    );

    return {
      document_id: iterationState.document_id,
      document_type: this.inferDocumentType(iterationState),
      escalation_reason: escalationReason,
      escalation_trigger: escalationTrigger,
      current_version: currentVersion,
      version_history: documentVersions,
      review_history: reviewHistory,
      diffs,
      score_trend: scoreTrend,
      unresolved_findings: unresolvedFindings,
      recurred_findings: recurredFindings,
      parent_document: parentDocument,
      traceability_context: traceLinks,
      recommended_action: action,
      recommended_action_rationale: rationale,
    };
  }

  /**
   * Builds a human-readable escalation reason based on the trigger type.
   */
  private buildEscalationReason(
    trigger: EscalationTrigger,
    state: IterationState,
    findings: MergedFinding[],
    reviewHistory: GateReviewResult[]
  ): string {
    switch (trigger) {
      case 'max_iterations_exhausted':
        return `Document did not achieve approval after ${state.max_iterations} review iterations.`;

      case 'critical_reject_finding': {
        const criticalFinding = findings.find(
          (f) => f.severity === 'critical' && f.critical_sub === 'reject'
        );
        const description = criticalFinding?.description ?? 'Unknown critical finding';
        return `A critical finding requiring human intervention was identified: ${description}`;
      }

      case 'stagnation_persisted': {
        const trend = reviewHistory.map((r) => r.aggregate_score).join(', ');
        const recurredCount = findings.filter(
          (f) => f.resolution_status === 'recurred'
        ).length;
        return `Review loop stagnated for 2+ consecutive iterations. Score trend: ${trend}. Recurring findings: ${recurredCount}.`;
      }

      case 'trust_level_requirement':
        return `Trust level requires human approval for documents of this type.`;

      case 'backward_cascade_depth_exceeded':
        return 'Backward cascade depth exceeded maximum. Escalating before further cascade.';
    }
  }

  /**
   * Computes unified diffs between consecutive document versions.
   */
  private computeVersionDiffs(versions: DocumentVersion[]): VersionDiff[] {
    const diffs: VersionDiff[] = [];
    for (let i = 0; i < versions.length - 1; i++) {
      const from = versions[i];
      const to = versions[i + 1];
      diffs.push({
        from_version: from.version,
        to_version: to.version,
        diff: computeUnifiedDiff(from.content, to.content, from.version, to.version),
      });
    }
    return diffs;
  }

  /**
   * Infers the document type from the iteration state.
   * Falls back to 'Spec' if not determinable.
   */
  private inferDocumentType(state: IterationState): DocumentType {
    // The document_id typically encodes the type (e.g. "PRD-001")
    const id = state.document_id.toUpperCase();
    if (id.startsWith('PRD')) return 'PRD';
    if (id.startsWith('TDD')) return 'TDD';
    if (id.startsWith('PLAN')) return 'Plan';
    if (id.startsWith('CODE')) return 'Code';
    return 'Spec';
  }
}
