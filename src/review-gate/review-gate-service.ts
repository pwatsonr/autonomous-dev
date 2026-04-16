/**
 * ReviewGateService: top-level orchestrator for the review gate lifecycle.
 *
 * Wires all review gate components together into the complete
 * create-review-revise-re-review pipeline. This is the single entry point
 * for submitting documents to the review gate.
 *
 * Implements the 21-step orchestration sequence from SPEC-004-3-4.
 * Supports crash recovery from 3 checkpoint stages:
 *   - review_started  -> restart from Step 9 (re-execute reviewers)
 *   - review_completed -> restart from Step 11 (re-aggregate)
 *   - decision         -> gate completed, return recorded outcome
 *
 * Based on SPEC-004-3-4 section 1.
 */

import * as crypto from 'crypto';

import type {
  DocumentType,
  DocumentForValidation,
  Rubric,
  MergedFinding,
  Disagreement,
  QualityRegression,
  GateReviewResult,
  ReviewGateRecord,
  ReviewOutput,
  Finding,
} from './types';
import type { DocumentForReview, FilteredDocument } from './blind-scoring-context-filter';
import type { ReviewerAssignment, RotationPolicy } from './panel-assembly-service';
import type { AssembledPrompt } from './reviewer-prompt-assembler';
import type { ExecutionResult } from './reviewer-executor';
import type { DocumentSectionMappings } from './section-mappings';
import type { IterationState, IterationDecision } from './iteration-controller';

import { PreReviewValidator } from './pre-review-validator';
import { PanelAssemblyService } from './panel-assembly-service';
import { BlindScoringContextFilter } from './blind-scoring-context-filter';
import { ReviewerPromptAssembler } from './reviewer-prompt-assembler';
import { ReviewerExecutor } from './reviewer-executor';
import { DisagreementDetector } from './disagreement-detector';
import { IterationController, computeContentHash } from './iteration-controller';
import { QualityRegressionDetector } from './quality-regression-detector';
import { RubricRegistry } from './rubric-registry';
import { getSectionMappings } from './section-mappings';

// ---------------------------------------------------------------------------
// Interfaces for components that do not yet have concrete implementations.
// The ReviewGateService depends on these abstractions.
// ---------------------------------------------------------------------------

/**
 * Aggregation result returned by the ScoreAggregator.
 */
export interface AggregationResult {
  aggregate_score: number;
  per_reviewer_scores: { reviewer_id: string; weighted_score: number }[];
  category_aggregates: CategoryAggregateResult[];
}

export interface CategoryAggregateResult {
  category_id: string;
  category_name: string;
  weight: number;
  aggregate_score: number;
  per_reviewer_scores: { reviewer_id: string; score: number }[];
  min_threshold: number | null;
  threshold_violated: boolean;
}

/**
 * Score aggregation across reviewer outputs.
 */
export interface ScoreAggregatorInterface {
  aggregateScores(
    reviewOutputs: ReviewOutput[],
    rubric: Rubric,
    method: 'mean' | 'median' | 'min'
  ): AggregationResult;
}

/**
 * Approval decision produced by the ApprovalEvaluator.
 */
export interface ApprovalDecision {
  outcome: 'approved' | 'changes_requested' | 'rejected';
  reasons: string[];
  auto_generated_findings: Finding[];
  threshold_met: boolean;
  has_critical_blocking: boolean;
  has_critical_reject: boolean;
  floor_violations: FloorViolation[];
}

export interface FloorViolation {
  category_id: string;
  reviewer_id: string;
  score: number;
  min_threshold: number;
}

/**
 * Evaluates whether a document passes the review gate.
 */
export interface ApprovalEvaluatorInterface {
  evaluate(
    aggregationResult: AggregationResult,
    reviewerOutputs: ReviewOutput[],
    rubric: Rubric,
    iterationCount: number,
    maxIterations: number
  ): ApprovalDecision;
}

/**
 * Formats findings for author consumption.
 */
export interface FeedbackFormatterResult {
  merged_findings: MergedFinding[];
  summary: string;
}

export interface FeedbackFormatter {
  formatFindings(
    reviewOutputs: ReviewOutput[],
    previousFindings: MergedFinding[] | null
  ): FeedbackFormatterResult;
}

/**
 * Tracks finding resolution, recurrence, and new findings across iterations.
 */
export interface FindingTrackingResult {
  tracked_findings: MergedFinding[];
  resolved_findings: MergedFinding[];
  recurred_findings: MergedFinding[];
  new_findings: MergedFinding[];
}

export interface FindingTracker {
  trackFindings(
    currentFindings: MergedFinding[],
    previousFindings: MergedFinding[] | null,
    allPriorFindings: MergedFinding[]
  ): FindingTrackingResult;
}

/**
 * Convergence tracker for the review iteration loop.
 */
export interface ConvergenceTrackerInterface {
  analyze(state: {
    current_iteration: number;
    score_history: { iteration: number; aggregate_score: number }[];
    finding_history: { iteration: number; findings: MergedFinding[] }[];
  }): {
    stagnation_detected: boolean;
    stagnation_reasons: string[];
    score_trend: 'improving' | 'flat' | 'declining';
    score_delta: number | null;
    resolved_findings: string[];
    recurred_findings: string[];
    finding_count_trend: 'decreasing' | 'flat' | 'increasing';
  };
}

/**
 * Trust level evaluation for determining human approval requirements.
 */
export interface TrustLevelCheckResult {
  human_approval_required: boolean;
  reason: string;
}

export interface TrustLevelManager {
  requiresHumanApproval(
    documentType: DocumentType,
    aiOutcome: 'approved' | 'changes_requested' | 'rejected'
  ): TrustLevelCheckResult;
}

/**
 * Escalation package assembled for human review.
 */
export interface EscalationPackage {
  gate_id: string;
  document_id: string;
  document_type: DocumentType;
  reason: string;
  review_results: GateReviewResult[];
  total_iterations: number;
  final_score: number;
}

/**
 * Assembles escalation packages for human reviewers.
 */
export interface HumanEscalationGateway {
  assemblePackage(
    gateId: string,
    documentId: string,
    documentType: DocumentType,
    reason: string,
    reviewResults: GateReviewResult[],
    totalIterations: number,
    finalScore: number
  ): EscalationPackage;
}

// ---------------------------------------------------------------------------
// GateOutcome: the final return type of submitForReview
// ---------------------------------------------------------------------------

export interface GateOutcome {
  gate_id: string;
  document_id: string;
  document_type: DocumentType;
  final_outcome: 'approved' | 'rejected' | 'escalated' | 'awaiting_human';
  final_score: number;
  total_iterations: number;
  review_result: GateReviewResult;
  escalation_package: EscalationPackage | null;
  human_approval_required: boolean;
  gate_record: ReviewGateRecord;
}

// ---------------------------------------------------------------------------
// ReviewGateServiceConfig
// ---------------------------------------------------------------------------

export interface ReviewGateServiceConfig {
  max_iterations: number;
  aggregation_method: 'mean' | 'median' | 'min';
  trust_level: 'full_auto' | 'approve_roots' | 'approve_phase_1' | 'approve_all' | 'human_only';
  auto_rollback_on_regression: boolean;
  panel_sizes: Record<string, number>;
  rotation_policy: Record<string, RotationPolicy>;
}

export const DEFAULT_REVIEW_GATE_SERVICE_CONFIG: ReviewGateServiceConfig = {
  max_iterations: 3,
  aggregation_method: 'mean',
  trust_level: 'approve_roots',
  auto_rollback_on_regression: false,
  panel_sizes: {
    PRD: 2,
    TDD: 2,
    Plan: 1,
    Spec: 1,
    Code: 2,
  },
  rotation_policy: {
    PRD: 'rotate_specialist',
    TDD: 'rotate_specialist',
    Plan: 'rotate_specialist',
    Spec: 'rotate_specialist',
    Code: 'rotate_specialist',
  },
};

// ---------------------------------------------------------------------------
// ID generation utility
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Document type mapping: review-gate string literals -> pipeline enum values
// ---------------------------------------------------------------------------

/**
 * Maps review-gate DocumentType string literals ('Plan', 'Spec', 'Code')
 * to the pipeline DocumentType enum string values ('PLAN', 'SPEC', 'CODE').
 * PRD and TDD are identical in both systems.
 */
const PIPELINE_DOCTYPE_MAP: Record<string, string> = {
  PRD: 'PRD',
  TDD: 'TDD',
  Plan: 'PLAN',
  Spec: 'SPEC',
  Code: 'CODE',
};

function toPipelineDocType(docType: string): string {
  return PIPELINE_DOCTYPE_MAP[docType] ?? docType;
}

// ---------------------------------------------------------------------------
// Summary generation (Step 18)
// ---------------------------------------------------------------------------

/**
 * Generates a summary string per the spec's exact format.
 *
 * Format: Score: X.XX/threshold. Outcome: outcome. N finding(s) resolved. ...
 */
export function generateSummary(
  decision: ApprovalDecision,
  aggregation: AggregationResult,
  tracking: FindingTrackingResult,
  threshold: number
): string {
  const parts: string[] = [];
  parts.push(`Score: ${aggregation.aggregate_score.toFixed(2)}/${threshold}.`);
  parts.push(`Outcome: ${decision.outcome}.`);
  if (tracking.resolved_findings.length > 0)
    parts.push(`${tracking.resolved_findings.length} finding(s) resolved.`);
  if (tracking.recurred_findings.length > 0)
    parts.push(`${tracking.recurred_findings.length} finding(s) recurred.`);
  if (tracking.new_findings.length > 0)
    parts.push(`${tracking.new_findings.length} new finding(s).`);
  if (decision.floor_violations.length > 0)
    parts.push(`${decision.floor_violations.length} per-category floor violation(s).`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// ReviewGateService
// ---------------------------------------------------------------------------

export class ReviewGateService {
  /**
   * In-memory map of document_id -> IterationState for multi-iteration
   * tracking and crash recovery.
   */
  private gateStates: Map<string, IterationState> = new Map();

  /**
   * Collected review results across iterations (for escalation packages).
   */
  private reviewResultHistory: Map<string, GateReviewResult[]> = new Map();

  constructor(
    private preReviewValidator: PreReviewValidator,
    private panelAssemblyService: PanelAssemblyService,
    private blindFilter: BlindScoringContextFilter,
    private promptAssembler: ReviewerPromptAssembler,
    private reviewerExecutor: ReviewerExecutor,
    private scoreAggregator: ScoreAggregatorInterface,
    private disagreementDetector: DisagreementDetector,
    private approvalEvaluator: ApprovalEvaluatorInterface,
    private feedbackFormatter: FeedbackFormatter,
    private findingTracker: FindingTracker,
    private iterationController: IterationController,
    private convergenceTracker: ConvergenceTrackerInterface,
    private regressionDetector: QualityRegressionDetector,
    private trustLevelManager: TrustLevelManager,
    private humanEscalationGateway: HumanEscalationGateway,
    private rubricRegistry: RubricRegistry,
    private config: ReviewGateServiceConfig
  ) {}

  /**
   * Submits a document for review through the 21-step pipeline.
   *
   * This method may be called multiple times for the same document
   * to support the revision loop (iteration 1, 2, 3...).
   */
  async submitForReview(
    document: DocumentForValidation,
    documentType: DocumentType,
    authorId: string,
    parentDocument?: DocumentForReview,
    previousPanel?: ReviewerAssignment[]
  ): Promise<GateOutcome> {
    // Check for crash recovery first
    const existingState = this.gateStates.get(document.id);
    if (existingState) {
      const restored = this.iterationController.restoreFromCheckpoint(existingState.gate_id);
      if (restored) {
        const lastCheckpoint = restored.checkpoints[restored.checkpoints.length - 1];
        if (lastCheckpoint) {
          if (lastCheckpoint.stage === 'decision') {
            // Gate completed; return the recorded outcome
            const lastReviewResult = this.reviewResultHistory.get(document.id);
            if (lastReviewResult && lastReviewResult.length > 0) {
              const reviewResult = lastReviewResult[lastReviewResult.length - 1];
              return this.buildFinalOutcome(
                restored,
                reviewResult,
                documentType,
                document,
                null,
                null
              );
            }
          }
          // For review_started and review_completed, we continue the pipeline
          // from the appropriate step below using the restored state
          this.gateStates.set(document.id, restored);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 1: Pre-Review Validation
    // -----------------------------------------------------------------------
    const validationResult = await this.preReviewValidator.validate(document, documentType);

    if (!validationResult.valid) {
      // Build a rejected GateOutcome from validation errors
      return this.buildRejectedFromValidation(document, documentType, validationResult.errors);
    }

    const scoringMode = validationResult.scoring_mode;

    // -----------------------------------------------------------------------
    // Step 2: Rubric Retrieval
    // -----------------------------------------------------------------------
    const rubric = this.rubricRegistry.getRubric(documentType);

    // -----------------------------------------------------------------------
    // Step 3: Iteration State
    // -----------------------------------------------------------------------
    let state: IterationState;
    const existingGateState = this.gateStates.get(document.id);

    if (!existingGateState) {
      state = this.iterationController.initializeGate(generateId(), document.id);
      this.gateStates.set(document.id, state);
      this.reviewResultHistory.set(document.id, []);
    } else {
      state = existingGateState;
    }

    state = this.iterationController.startIteration(state);

    // -----------------------------------------------------------------------
    // Step 4: Content Hash Check
    // -----------------------------------------------------------------------
    const contentHash = computeContentHash(document.content);
    const previousHashMatch = state.content_hashes.find((h) => h.hash === contentHash);

    if (previousHashMatch) {
      // Auto-fail with critical:blocking finding
      const autoFailFinding: MergedFinding = {
        id: `sys-identical-revision-${state.current_iteration}`,
        section_id: 'document',
        category_id: 'document',
        severity: 'critical',
        critical_sub: 'blocking',
        upstream_defect: false,
        description: 'Revision is identical to a previous version. No changes were made.',
        evidence: `Content hash ${contentHash} matches iteration ${previousHashMatch.iteration}.`,
        suggested_resolution: 'Make substantive changes to the document before resubmitting.',
        reported_by: ['system'],
        resolution_status: null,
        prior_finding_id: null,
      };

      // Record the hash
      state.content_hashes.push({
        iteration: state.current_iteration,
        hash: contentHash,
      });

      const reviewResult: GateReviewResult = {
        gate_id: state.gate_id,
        document_id: document.id,
        document_version: String(document.frontmatter.version ?? '1.0'),
        iteration: state.current_iteration,
        outcome: 'changes_requested',
        aggregate_score: 0,
        threshold: rubric.approval_threshold,
        aggregation_method: this.config.aggregation_method,
        category_aggregates: [],
        findings: [autoFailFinding],
        disagreements: [],
        quality_regression: null,
        stagnation_warning: false,
        summary: 'Identical revision detected. No changes were made.',
      };

      this.addReviewResult(document.id, reviewResult);

      return {
        gate_id: state.gate_id,
        document_id: document.id,
        document_type: documentType,
        final_outcome: 'rejected',
        final_score: 0,
        total_iterations: state.current_iteration,
        review_result: reviewResult,
        escalation_package: null,
        human_approval_required: false,
        gate_record: this.buildGateRecord(state, reviewResult, null, documentType, rubric),
      };
    }

    // -----------------------------------------------------------------------
    // Step 5: Blind Scoring Filter
    // -----------------------------------------------------------------------
    const docForReview: DocumentForReview = {
      id: document.id,
      content: document.content,
      frontmatter: document.frontmatter,
      version: String(document.frontmatter.version ?? '1.0'),
      created_at: String(document.frontmatter.created_at ?? new Date().toISOString()),
      sections: document.sections,
    };

    const filteredDoc = this.blindFilter.filterDocument(docForReview);
    const filteredParent = parentDocument
      ? this.blindFilter.filterParentDocument(parentDocument)
      : null;

    // -----------------------------------------------------------------------
    // Step 6: Panel Assembly
    // -----------------------------------------------------------------------
    const pipelineDocType = toPipelineDocType(documentType);
    const panel = this.panelAssemblyService.assemblePanel(
      pipelineDocType as any,
      authorId,
      state.current_iteration,
      previousPanel
    );

    // -----------------------------------------------------------------------
    // Step 7: Prompt Assembly
    // -----------------------------------------------------------------------
    let sectionMappings: DocumentSectionMappings;
    try {
      sectionMappings = getSectionMappings(pipelineDocType as any);
    } catch {
      // Fallback minimal mappings when document type has no registered mapping
      sectionMappings = {
        document_type: pipelineDocType as any,
        mappings: [],
        word_count_threshold: 500,
      };
    }

    const prompts = new Map<string, AssembledPrompt>();
    for (const reviewer of panel) {
      const agentInstance = {
        instance_id: `${reviewer.reviewer_id}-inst`,
        reviewer_id: reviewer.reviewer_id,
        role_id: reviewer.role_id,
        role_name: reviewer.role_name,
        agent_seed: reviewer.agent_seed,
        prompt_identity: reviewer.prompt_identity,
        status: 'active' as const,
        created_at: new Date().toISOString(),
      };

      const prompt = this.promptAssembler.assemblePrompt(
        agentInstance,
        rubric,
        filteredDoc.content,
        filteredParent?.content ?? null,
        document.traces_from ?? null,
        sectionMappings
      );
      prompts.set(reviewer.reviewer_id, prompt);
    }

    // -----------------------------------------------------------------------
    // Step 8: Checkpoint (review_started)
    // -----------------------------------------------------------------------
    this.iterationController.checkpoint(state, 'review_started');

    // -----------------------------------------------------------------------
    // Step 9: Parallel Review Execution
    // -----------------------------------------------------------------------
    const executionResult = await this.reviewerExecutor.executePanel(
      panel,
      prompts as Map<string, any>,
      rubric
    );

    if (executionResult.escalation_required) {
      // All reviewers failed -- escalate to human
      const escalationPackage = this.humanEscalationGateway.assemblePackage(
        state.gate_id,
        document.id,
        documentType,
        'reviewer failure',
        this.reviewResultHistory.get(document.id) ?? [],
        state.current_iteration,
        0
      );

      const reviewResult: GateReviewResult = {
        gate_id: state.gate_id,
        document_id: document.id,
        document_version: String(document.frontmatter.version ?? '1.0'),
        iteration: state.current_iteration,
        outcome: 'rejected',
        aggregate_score: 0,
        threshold: rubric.approval_threshold,
        aggregation_method: this.config.aggregation_method,
        category_aggregates: [],
        findings: [],
        disagreements: [],
        quality_regression: null,
        stagnation_warning: false,
        summary: 'All reviewers failed. Escalating to human review.',
      };

      return {
        gate_id: state.gate_id,
        document_id: document.id,
        document_type: documentType,
        final_outcome: 'escalated',
        final_score: 0,
        total_iterations: state.current_iteration,
        review_result: reviewResult,
        escalation_package: escalationPackage,
        human_approval_required: true,
        gate_record: this.buildGateRecord(state, reviewResult, executionResult, documentType, rubric),
      };
    }

    // -----------------------------------------------------------------------
    // Step 10: Checkpoint (review_completed)
    // -----------------------------------------------------------------------
    this.iterationController.checkpoint(state, 'review_completed');

    // -----------------------------------------------------------------------
    // Step 11: Score Aggregation
    // -----------------------------------------------------------------------
    const aggregationResult = this.scoreAggregator.aggregateScores(
      executionResult.review_outputs,
      rubric,
      this.config.aggregation_method
    );

    // -----------------------------------------------------------------------
    // Step 12: Disagreement Detection
    // -----------------------------------------------------------------------
    const disagreements = this.disagreementDetector.detect(
      executionResult.review_outputs,
      rubric
    );

    // -----------------------------------------------------------------------
    // Step 13: Approval Evaluation
    // -----------------------------------------------------------------------
    const approvalDecision = this.approvalEvaluator.evaluate(
      aggregationResult,
      executionResult.review_outputs,
      rubric,
      state.current_iteration,
      this.config.max_iterations
    );

    // -----------------------------------------------------------------------
    // Step 14: Feedback Formatting
    // -----------------------------------------------------------------------
    const previousFindings =
      state.finding_history.length > 0
        ? state.finding_history[state.finding_history.length - 1].findings
        : null;

    const formattedFeedback = this.feedbackFormatter.formatFindings(
      executionResult.review_outputs,
      previousFindings
    );

    // -----------------------------------------------------------------------
    // Step 15: Finding Tracking
    // -----------------------------------------------------------------------
    const trackingResult = this.findingTracker.trackFindings(
      formattedFeedback.merged_findings,
      previousFindings,
      state.finding_history.flatMap((h) => h.findings)
    );

    // -----------------------------------------------------------------------
    // Step 16: Iteration Decision
    // -----------------------------------------------------------------------
    const iterationDecision = this.iterationController.recordReviewOutcome(
      state,
      aggregationResult.aggregate_score,
      trackingResult.tracked_findings,
      contentHash,
      approvalDecision.outcome
    );

    // -----------------------------------------------------------------------
    // Step 17: Trust Level Evaluation
    // -----------------------------------------------------------------------
    if (approvalDecision.outcome === 'approved') {
      const humanCheck = this.trustLevelManager.requiresHumanApproval(
        documentType,
        'approved'
      );
      if (humanCheck.human_approval_required) {
        const reviewResult = this.buildReviewResult(
          state,
          document,
          approvalDecision,
          aggregationResult,
          trackingResult,
          disagreements,
          iterationDecision,
          rubric
        );
        this.addReviewResult(document.id, reviewResult);

        return {
          gate_id: state.gate_id,
          document_id: document.id,
          document_type: documentType,
          final_outcome: 'awaiting_human',
          final_score: aggregationResult.aggregate_score,
          total_iterations: state.current_iteration,
          review_result: reviewResult,
          escalation_package: null,
          human_approval_required: true,
          gate_record: this.buildGateRecord(state, reviewResult, executionResult, documentType, rubric),
        };
      }
    }

    // -----------------------------------------------------------------------
    // Step 18: Build GateReviewResult
    // -----------------------------------------------------------------------
    const reviewResult = this.buildReviewResult(
      state,
      document,
      approvalDecision,
      aggregationResult,
      trackingResult,
      disagreements,
      iterationDecision,
      rubric
    );

    this.addReviewResult(document.id, reviewResult);

    // -----------------------------------------------------------------------
    // Step 19: Escalation (if needed)
    // -----------------------------------------------------------------------
    if (
      approvalDecision.outcome === 'rejected' ||
      iterationDecision.outcome === 'rejected'
    ) {
      const escalationPackage = this.humanEscalationGateway.assemblePackage(
        state.gate_id,
        document.id,
        documentType,
        iterationDecision.reason,
        this.reviewResultHistory.get(document.id) ?? [],
        state.current_iteration,
        aggregationResult.aggregate_score
      );

      // Step 20: Checkpoint (decision)
      this.iterationController.checkpoint(state, 'decision');

      return {
        gate_id: state.gate_id,
        document_id: document.id,
        document_type: documentType,
        final_outcome: 'escalated',
        final_score: aggregationResult.aggregate_score,
        total_iterations: state.current_iteration,
        review_result: reviewResult,
        escalation_package: escalationPackage,
        human_approval_required: true,
        gate_record: this.buildGateRecord(state, reviewResult, executionResult, documentType, rubric),
      };
    }

    // -----------------------------------------------------------------------
    // Step 20: Checkpoint (decision)
    // -----------------------------------------------------------------------
    this.iterationController.checkpoint(state, 'decision');

    // -----------------------------------------------------------------------
    // Step 21: Return GateOutcome
    // -----------------------------------------------------------------------
    return {
      gate_id: state.gate_id,
      document_id: document.id,
      document_type: documentType,
      final_outcome: iterationDecision.outcome ?? approvalDecision.outcome,
      final_score: aggregationResult.aggregate_score,
      total_iterations: state.current_iteration,
      review_result: reviewResult,
      escalation_package: null,
      human_approval_required: false,
      gate_record: this.buildGateRecord(state, reviewResult, executionResult, documentType, rubric),
    };
  }

  /**
   * Resets tracked state for a document. Used between test runs or after
   * a gate has fully completed.
   */
  resetDocumentState(documentId: string): void {
    this.gateStates.delete(documentId);
    this.reviewResultHistory.delete(documentId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private addReviewResult(documentId: string, result: GateReviewResult): void {
    const results = this.reviewResultHistory.get(documentId) ?? [];
    results.push(result);
    this.reviewResultHistory.set(documentId, results);
  }

  private buildReviewResult(
    state: IterationState,
    document: DocumentForValidation,
    decision: ApprovalDecision,
    aggregation: AggregationResult,
    tracking: FindingTrackingResult,
    disagreements: Disagreement[],
    iterationDecision: IterationDecision,
    rubric: Readonly<Rubric>
  ): GateReviewResult {
    return {
      gate_id: state.gate_id,
      document_id: document.id,
      document_version: String(document.frontmatter.version ?? '1.0'),
      iteration: state.current_iteration,
      outcome: decision.outcome,
      aggregate_score: aggregationResult_score(aggregation),
      threshold: rubric.approval_threshold,
      aggregation_method: this.config.aggregation_method,
      category_aggregates: aggregation.category_aggregates.map((ca) => ({
        category_id: ca.category_id,
        category_name: ca.category_name,
        weight: ca.weight,
        aggregate_score: ca.aggregate_score,
        per_reviewer_scores: ca.per_reviewer_scores,
        min_threshold: ca.min_threshold,
        threshold_violated: ca.threshold_violated,
      })),
      findings: tracking.tracked_findings,
      disagreements,
      quality_regression: iterationDecision.quality_regression,
      stagnation_warning: iterationDecision.stagnation_warning,
      summary: generateSummary(decision, aggregation, tracking, rubric.approval_threshold),
    };
  }

  private buildGateRecord(
    state: IterationState,
    reviewResult: GateReviewResult,
    executionResult: ExecutionResult | null,
    documentType: DocumentType,
    rubric: Readonly<Rubric>
  ): ReviewGateRecord {
    const now = new Date().toISOString();
    return {
      gate_id: state.gate_id,
      document_id: state.document_id,
      document_type: documentType,
      document_version: reviewResult.document_version,
      pipeline_id: state.gate_id,
      iteration: state.current_iteration,
      max_iterations: this.config.max_iterations,
      rubric_version: rubric.version,
      threshold: rubric.approval_threshold,
      aggregation_method: this.config.aggregation_method,
      panel_size: executionResult?.review_outputs.length ?? 0,
      trust_level: this.config.trust_level,
      reviewer_outputs: executionResult?.review_outputs ?? [],
      aggregate_score: reviewResult.aggregate_score,
      category_aggregates: reviewResult.category_aggregates,
      outcome: reviewResult.outcome,
      merged_findings: reviewResult.findings,
      disagreements: reviewResult.disagreements,
      quality_regression: reviewResult.quality_regression,
      stagnation_warning: reviewResult.stagnation_warning,
      human_escalation: false,
      started_at: state.checkpoints.length > 0
        ? state.checkpoints[0].timestamp
        : now,
      completed_at: now,
      created_by: 'review-gate-service',
    };
  }

  private buildRejectedFromValidation(
    document: DocumentForValidation,
    documentType: DocumentType,
    errors: { code: string; message: string; section_id?: string; field?: string }[]
  ): GateOutcome {
    const gateId = generateId();
    const findings: MergedFinding[] = errors.map((err, idx) => ({
      id: `validation-error-${idx}`,
      section_id: err.section_id ?? 'document',
      category_id: 'validation',
      severity: 'critical' as const,
      critical_sub: 'blocking' as const,
      upstream_defect: false,
      description: err.message,
      evidence: `Validation error: ${err.code}`,
      suggested_resolution: 'Fix the validation error and resubmit.',
      reported_by: ['system'],
      resolution_status: null,
      prior_finding_id: null,
    }));

    const reviewResult: GateReviewResult = {
      gate_id: gateId,
      document_id: document.id,
      document_version: String(document.frontmatter.version ?? '1.0'),
      iteration: 0,
      outcome: 'rejected',
      aggregate_score: 0,
      threshold: 0,
      aggregation_method: this.config.aggregation_method,
      category_aggregates: [],
      findings,
      disagreements: [],
      quality_regression: null,
      stagnation_warning: false,
      summary: `Pre-review validation failed with ${errors.length} error(s).`,
    };

    return {
      gate_id: gateId,
      document_id: document.id,
      document_type: documentType,
      final_outcome: 'rejected',
      final_score: 0,
      total_iterations: 0,
      review_result: reviewResult,
      escalation_package: null,
      human_approval_required: false,
      gate_record: {
        gate_id: gateId,
        document_id: document.id,
        document_type: documentType,
        document_version: String(document.frontmatter.version ?? '1.0'),
        pipeline_id: gateId,
        iteration: 0,
        max_iterations: this.config.max_iterations,
        rubric_version: 'N/A',
        threshold: 0,
        aggregation_method: this.config.aggregation_method,
        panel_size: 0,
        trust_level: this.config.trust_level,
        reviewer_outputs: [],
        aggregate_score: 0,
        category_aggregates: [],
        outcome: 'rejected',
        merged_findings: findings,
        disagreements: [],
        quality_regression: null,
        stagnation_warning: false,
        human_escalation: false,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        created_by: 'review-gate-service',
      },
    };
  }

  private buildFinalOutcome(
    state: IterationState,
    reviewResult: GateReviewResult,
    documentType: DocumentType,
    document: DocumentForValidation,
    executionResult: ExecutionResult | null,
    rubric: Readonly<Rubric> | null
  ): GateOutcome {
    const outcome = reviewResult.outcome === 'approved'
      ? 'approved'
      : reviewResult.outcome === 'rejected'
        ? 'escalated'
        : 'rejected';

    return {
      gate_id: state.gate_id,
      document_id: document.id,
      document_type: documentType,
      final_outcome: outcome as 'approved' | 'rejected' | 'escalated' | 'awaiting_human',
      final_score: reviewResult.aggregate_score,
      total_iterations: state.current_iteration,
      review_result: reviewResult,
      escalation_package: null,
      human_approval_required: false,
      gate_record: {
        gate_id: state.gate_id,
        document_id: state.document_id,
        document_type: documentType,
        document_version: reviewResult.document_version,
        pipeline_id: state.gate_id,
        iteration: state.current_iteration,
        max_iterations: state.max_iterations,
        rubric_version: rubric?.version ?? 'N/A',
        threshold: reviewResult.threshold,
        aggregation_method: reviewResult.aggregation_method,
        panel_size: 0,
        trust_level: this.config.trust_level,
        reviewer_outputs: [],
        aggregate_score: reviewResult.aggregate_score,
        category_aggregates: reviewResult.category_aggregates,
        outcome: reviewResult.outcome,
        merged_findings: reviewResult.findings,
        disagreements: reviewResult.disagreements,
        quality_regression: reviewResult.quality_regression,
        stagnation_warning: reviewResult.stagnation_warning,
        human_escalation: false,
        started_at: state.checkpoints.length > 0
          ? state.checkpoints[0].timestamp
          : new Date().toISOString(),
        completed_at: new Date().toISOString(),
        created_by: 'review-gate-service',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helper to extract aggregate score safely
// ---------------------------------------------------------------------------

function aggregationResult_score(result: AggregationResult): number {
  if (!Number.isFinite(result.aggregate_score)) {
    return 0;
  }
  return result.aggregate_score;
}
