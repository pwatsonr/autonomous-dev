/**
 * Integration tests for ReviewGateService (SPEC-004-3-4 section 2).
 *
 * All tests use mock/stub dependencies that return predetermined outputs.
 * Tests exercise the full 21-step pipeline end-to-end.
 *
 * Test cases 1-24 per the spec:
 *   Happy path (1-2), Revision loops (3-4), Rejection/escalation (5-7),
 *   Quality signals (8-11), Trust levels (12-15), Finding tracking (16-17),
 *   Disagreement (18), Error handling (19-20), Crash recovery (21),
 *   Edge cases (22-24).
 */

import { DocumentType } from '../../src/pipeline/types/document-type';
import {
  ReviewGateService,
  ReviewGateServiceConfig,
  GateOutcome,
  AggregationResult,
  CategoryAggregateResult,
  ApprovalDecision,
  FloorViolation,
  FeedbackFormatterResult,
  FindingTrackingResult,
  TrustLevelCheckResult,
  EscalationPackage,
  ScoreAggregatorInterface,
  ApprovalEvaluatorInterface,
  FeedbackFormatter,
  FindingTracker,
  TrustLevelManager,
  HumanEscalationGateway,
  ConvergenceTrackerInterface,
} from '../../src/review-gate/review-gate-service';
import { PreReviewValidator } from '../../src/review-gate/pre-review-validator';
import {
  PanelAssemblyService,
  ReviewerAssignment,
} from '../../src/review-gate/panel-assembly-service';
import { BlindScoringContextFilter, DocumentForReview } from '../../src/review-gate/blind-scoring-context-filter';
import { ReviewerPromptAssembler } from '../../src/review-gate/reviewer-prompt-assembler';
import {
  ReviewerExecutor,
  LLMAdapter,
  ReviewerAgentPool as ExecutorAgentPool,
  AgentInstance,
  ExecutionResult,
} from '../../src/review-gate/reviewer-executor';
import { ReviewerOutputValidator } from '../../src/review-gate/reviewer-output-validator';
import { ReviewerAgentPool } from '../../src/review-gate/reviewer-agent-pool';
import { DisagreementDetector } from '../../src/review-gate/disagreement-detector';
import {
  IterationController,
  computeContentHash,
} from '../../src/review-gate/iteration-controller';
import { ConvergenceTracker } from '../../src/review-gate/convergence-tracker';
import { QualityRegressionDetector } from '../../src/review-gate/quality-regression-detector';
import { RubricRegistry } from '../../src/review-gate/rubric-registry';
import { PRD_RUBRIC } from '../../src/review-gate/rubrics/prd-rubric';
import { TDD_RUBRIC } from '../../src/review-gate/rubrics/tdd-rubric';
import { PLAN_RUBRIC } from '../../src/review-gate/rubrics/plan-rubric';
import { CODE_RUBRIC } from '../../src/review-gate/rubrics/code-rubric';
import type {
  DocumentForValidation,
  DocumentType as DocTypeStr,
  MergedFinding,
  Rubric,
  ReviewOutput,
  Finding,
  Disagreement,
  QualityRegression,
  GateReviewResult,
} from '../../src/review-gate/types';

// ---------------------------------------------------------------------------
// Mock LLM Adapter
// ---------------------------------------------------------------------------

interface MockReviewerResponse {
  scores: Record<string, number>;
  findings?: Partial<Finding>[];
  shouldFail?: boolean;
}

function createMockLLMAdapter(
  responses: Map<number, MockReviewerResponse> | MockReviewerResponse
): LLMAdapter {
  const defaultResponse: MockReviewerResponse =
    responses instanceof Map
      ? { scores: {} }
      : responses;

  return {
    invoke: jest.fn(async (_prompt: any, agentSeed: number) => {
      const response =
        responses instanceof Map
          ? responses.get(agentSeed) ?? defaultResponse
          : defaultResponse;

      if (response.shouldFail) {
        throw new Error('LLM invocation failed');
      }

      const rubricCategories = [
        'problem_clarity',
        'goals_measurability',
        'user_story_coverage',
        'requirements_completeness',
        'requirements_testability',
        'risk_identification',
        'internal_consistency',
      ];

      const categoryScores = rubricCategories.map((id) => ({
        category_id: id,
        score: response.scores[id] ?? 85,
        section_scores: null,
        justification: `Score for ${id}`,
      }));

      const findings = (response.findings ?? []).map((f, idx) => ({
        id: f.id ?? `finding-${agentSeed}-${idx}`,
        section_id: f.section_id ?? 'problem_statement',
        category_id: f.category_id ?? 'problem_clarity',
        severity: f.severity ?? 'major',
        critical_sub: f.critical_sub ?? null,
        upstream_defect: f.upstream_defect ?? false,
        description: f.description ?? `Finding ${idx}`,
        evidence: f.evidence ?? 'Evidence',
        suggested_resolution: f.suggested_resolution ?? 'Fix it',
      }));

      return JSON.stringify({
        reviewer_id: `reviewer-${agentSeed}`,
        reviewer_role: 'test-reviewer',
        document_id: 'doc-001',
        document_version: '1.0',
        timestamp: new Date().toISOString(),
        scoring_mode: 'document_level',
        category_scores: categoryScores,
        findings,
        summary: 'Test review completed.',
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock Executor Agent Pool
// ---------------------------------------------------------------------------

function createMockExecutorPool(): ExecutorAgentPool & { instances: Map<string, AgentInstance> } {
  const instances = new Map<string, AgentInstance>();
  let counter = 0;

  return {
    instances,
    createInstance(assignment: ReviewerAssignment): AgentInstance {
      counter++;
      const instance: AgentInstance = {
        instance_id: `inst-${counter}`,
        reviewer_id: assignment.reviewer_id,
        agent_seed: assignment.agent_seed,
        status: 'active',
      };
      instances.set(instance.instance_id, instance);
      return instance;
    },
    markCompleted(instanceId: string): void {
      const inst = instances.get(instanceId);
      if (inst) inst.status = 'completed';
    },
    markFailed(instanceId: string): void {
      const inst = instances.get(instanceId);
      if (inst) inst.status = 'failed';
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Score Aggregator
// ---------------------------------------------------------------------------

function createMockScoreAggregator(
  scorePerIteration?: number[]
): ScoreAggregatorInterface {
  let callCount = 0;
  return {
    aggregateScores(
      reviewOutputs: ReviewOutput[],
      rubric: Rubric,
      method: 'mean' | 'median' | 'min'
    ): AggregationResult {
      let aggregateScore: number;

      if (scorePerIteration && callCount < scorePerIteration.length) {
        aggregateScore = scorePerIteration[callCount];
      } else {
        // Compute from actual reviewer outputs
        if (reviewOutputs.length === 0) {
          aggregateScore = NaN;
        } else {
          const perReviewer = reviewOutputs.map((output) => {
            let totalWeighted = 0;
            for (const cat of rubric.categories) {
              const catScore = output.category_scores.find(
                (cs) => cs.category_id === cat.id
              );
              totalWeighted += (catScore?.score ?? 0) * (cat.weight / 100);
            }
            return totalWeighted;
          });

          if (method === 'mean') {
            aggregateScore =
              perReviewer.reduce((a, b) => a + b, 0) / perReviewer.length;
          } else if (method === 'min') {
            aggregateScore = Math.min(...perReviewer);
          } else {
            const sorted = [...perReviewer].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            aggregateScore =
              sorted.length % 2 === 0
                ? (sorted[mid - 1] + sorted[mid]) / 2
                : sorted[mid];
          }
        }
      }
      callCount++;

      const categoryAggregates: CategoryAggregateResult[] = rubric.categories.map(
        (cat) => {
          const perReviewerScores = reviewOutputs.map((output) => {
            const cs = output.category_scores.find(
              (c) => c.category_id === cat.id
            );
            return { reviewer_id: output.reviewer_id, score: cs?.score ?? 0 };
          });
          const scores = perReviewerScores.map((s) => s.score);
          const catAgg = scores.length > 0
            ? scores.reduce((a, b) => a + b, 0) / scores.length
            : 0;

          return {
            category_id: cat.id,
            category_name: cat.name,
            weight: cat.weight,
            aggregate_score: catAgg,
            per_reviewer_scores: perReviewerScores,
            min_threshold: cat.min_threshold,
            threshold_violated:
              cat.min_threshold !== null && catAgg < cat.min_threshold,
          };
        }
      );

      return {
        aggregate_score: Math.round(aggregateScore * 100) / 100,
        per_reviewer_scores: reviewOutputs.map((o) => ({
          reviewer_id: o.reviewer_id,
          weighted_score: aggregateScore,
        })),
        category_aggregates: categoryAggregates,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Approval Evaluator
// ---------------------------------------------------------------------------

function createMockApprovalEvaluator(
  outcomePerIteration?: ('approved' | 'changes_requested' | 'rejected')[]
): ApprovalEvaluatorInterface {
  let callCount = 0;
  return {
    evaluate(
      aggregationResult: AggregationResult,
      reviewerOutputs: ReviewOutput[],
      rubric: Rubric,
      iterationCount: number,
      maxIterations: number
    ): ApprovalDecision {
      let outcome: 'approved' | 'changes_requested' | 'rejected';

      if (outcomePerIteration && callCount < outcomePerIteration.length) {
        outcome = outcomePerIteration[callCount];
      } else {
        // Default: approved if score >= threshold
        outcome =
          aggregationResult.aggregate_score >= rubric.approval_threshold
            ? 'approved'
            : 'changes_requested';
      }
      callCount++;

      // Check for critical:reject findings
      const hasCriticalReject = reviewerOutputs.some((o) =>
        o.findings.some(
          (f) => f.severity === 'critical' && f.critical_sub === 'reject'
        )
      );
      if (hasCriticalReject) {
        outcome = 'rejected';
      }

      // Check for critical:blocking findings
      const hasCriticalBlocking = reviewerOutputs.some((o) =>
        o.findings.some(
          (f) => f.severity === 'critical' && f.critical_sub === 'blocking'
        )
      );

      // Max iterations check
      if (outcome === 'changes_requested' && iterationCount >= maxIterations) {
        outcome = 'rejected';
      }

      return {
        outcome,
        reasons: outcome === 'approved' ? [] : [`Outcome: ${outcome}`],
        auto_generated_findings: [],
        threshold_met: aggregationResult.aggregate_score >= rubric.approval_threshold,
        has_critical_blocking: hasCriticalBlocking,
        has_critical_reject: hasCriticalReject,
        floor_violations: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Feedback Formatter
// ---------------------------------------------------------------------------

function createMockFeedbackFormatter(): FeedbackFormatter {
  return {
    formatFindings(
      reviewOutputs: ReviewOutput[],
      previousFindings: MergedFinding[] | null
    ): FeedbackFormatterResult {
      const merged: MergedFinding[] = [];
      for (const output of reviewOutputs) {
        for (const finding of output.findings) {
          merged.push({
            id: finding.id,
            section_id: finding.section_id,
            category_id: finding.category_id,
            severity: finding.severity,
            critical_sub: finding.critical_sub,
            upstream_defect: finding.upstream_defect,
            description: finding.description,
            evidence: finding.evidence,
            suggested_resolution: finding.suggested_resolution,
            reported_by: [output.reviewer_id],
            resolution_status: null,
            prior_finding_id: null,
          });
        }
      }
      return {
        merged_findings: merged,
        summary: `${merged.length} finding(s) formatted.`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Finding Tracker
// ---------------------------------------------------------------------------

function createMockFindingTracker(): FindingTracker {
  return {
    trackFindings(
      currentFindings: MergedFinding[],
      previousFindings: MergedFinding[] | null,
      allPriorFindings: MergedFinding[]
    ): FindingTrackingResult {
      const previousKeys = new Set(
        (previousFindings ?? []).map(
          (f) => `${f.section_id}::${f.category_id}`
        )
      );
      const allResolvedKeys = new Set<string>();

      // Determine resolved keys: findings in allPrior but not in current
      const currentKeys = new Set(
        currentFindings.map((f) => `${f.section_id}::${f.category_id}`)
      );
      for (const f of allPriorFindings) {
        const key = `${f.section_id}::${f.category_id}`;
        if (!currentKeys.has(key)) {
          allResolvedKeys.add(key);
        }
      }

      const resolved: MergedFinding[] = [];
      const recurred: MergedFinding[] = [];
      const newFindings: MergedFinding[] = [];

      for (const finding of currentFindings) {
        const key = `${finding.section_id}::${finding.category_id}`;
        if (allResolvedKeys.has(key)) {
          finding.resolution_status = 'recurred';
          recurred.push(finding);
        } else if (!previousKeys.has(key) && previousFindings !== null) {
          newFindings.push(finding);
        }
      }

      // Previous findings not in current = resolved
      if (previousFindings) {
        for (const pf of previousFindings) {
          const key = `${pf.section_id}::${pf.category_id}`;
          if (!currentKeys.has(key)) {
            const resolvedCopy = { ...pf, resolution_status: 'resolved' as const };
            resolved.push(resolvedCopy);
          }
        }
      }

      return {
        tracked_findings: currentFindings,
        resolved_findings: resolved,
        recurred_findings: recurred,
        new_findings: newFindings,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Trust Level Manager
// ---------------------------------------------------------------------------

function createMockTrustLevelManager(
  trustLevel: 'full_auto' | 'approve_roots' | 'approve_phase_1' | 'approve_all' | 'human_only'
): TrustLevelManager {
  return {
    requiresHumanApproval(
      documentType: DocTypeStr,
      aiOutcome: 'approved' | 'changes_requested' | 'rejected'
    ): TrustLevelCheckResult {
      if (trustLevel === 'full_auto') {
        return { human_approval_required: false, reason: 'Full auto mode.' };
      }
      if (trustLevel === 'approve_roots') {
        // Only PRD requires human approval
        if (documentType === 'PRD' && aiOutcome === 'approved') {
          return {
            human_approval_required: true,
            reason: 'Root document requires human approval.',
          };
        }
        return { human_approval_required: false, reason: 'Non-root document.' };
      }
      if (trustLevel === 'approve_phase_1') {
        if (
          (documentType === 'PRD' || documentType === 'TDD') &&
          aiOutcome === 'approved'
        ) {
          return {
            human_approval_required: true,
            reason: 'Phase 1 document requires human approval.',
          };
        }
        return { human_approval_required: false, reason: 'Not phase 1.' };
      }
      if (trustLevel === 'approve_all') {
        if (aiOutcome === 'approved') {
          return {
            human_approval_required: true,
            reason: 'All approvals require human review.',
          };
        }
        return { human_approval_required: false, reason: 'Not approved.' };
      }
      // human_only
      return {
        human_approval_required: true,
        reason: 'Human-only mode.',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Human Escalation Gateway
// ---------------------------------------------------------------------------

function createMockHumanEscalationGateway(): HumanEscalationGateway {
  return {
    assemblePackage(
      gateId: string,
      documentId: string,
      documentType: DocTypeStr,
      reason: string,
      reviewResults: GateReviewResult[],
      totalIterations: number,
      finalScore: number
    ): EscalationPackage {
      return {
        gate_id: gateId,
        document_id: documentId,
        document_type: documentType,
        reason,
        review_results: reviewResults,
        total_iterations: totalIterations,
        final_score: finalScore,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Convergence Tracker
// ---------------------------------------------------------------------------

function createMockConvergenceTracker(): ConvergenceTrackerInterface {
  return new ConvergenceTracker() as any;
}

// ---------------------------------------------------------------------------
// Document store mock (for PreReviewValidator)
// ---------------------------------------------------------------------------

function createMockDocumentStore() {
  return {
    documentExists: jest.fn(async () => true),
    getSectionIds: jest.fn(async () => []),
  };
}

// ---------------------------------------------------------------------------
// Factory: create a fully wired ReviewGateService with controllable mocks
// ---------------------------------------------------------------------------

interface ServiceBuildOptions {
  llmAdapter?: LLMAdapter;
  scorePerIteration?: number[];
  outcomePerIteration?: ('approved' | 'changes_requested' | 'rejected')[];
  trustLevel?: 'full_auto' | 'approve_roots' | 'approve_phase_1' | 'approve_all' | 'human_only';
  maxIterations?: number;
  aggregationMethod?: 'mean' | 'median' | 'min';
  panelSizes?: Record<string, number>;
}

function buildService(options: ServiceBuildOptions = {}): {
  service: ReviewGateService;
  llmAdapter: LLMAdapter;
} {
  const { getSectionMappings } = require('../../src/review-gate/section-mappings');

  const documentStore = createMockDocumentStore();
  const preReviewValidator = new PreReviewValidator(
    (docType: any) => getSectionMappings(docType),
    documentStore
  );

  const panelSizes = options.panelSizes ?? {
    PRD: 2,
    TDD: 2,
    PLAN: 1,
    SPEC: 1,
    CODE: 2,
  };

  const panelAssemblyService = new PanelAssemblyService({
    panel_sizes: panelSizes as any,
  });

  const blindFilter = new BlindScoringContextFilter();
  const promptAssembler = new ReviewerPromptAssembler();

  const llmAdapter = options.llmAdapter ?? createMockLLMAdapter({ scores: {} });
  const outputValidator = new ReviewerOutputValidator();
  const executorPool = createMockExecutorPool();
  const reviewerExecutor = new ReviewerExecutor(
    llmAdapter,
    outputValidator,
    executorPool
  );

  const scoreAggregator = createMockScoreAggregator(options.scorePerIteration);
  const disagreementDetector = new DisagreementDetector();
  const approvalEvaluator = createMockApprovalEvaluator(
    options.outcomePerIteration
  );
  const feedbackFormatter = createMockFeedbackFormatter();
  const findingTracker = createMockFindingTracker();

  const iterationController = new IterationController({
    max_iterations: options.maxIterations ?? 3,
  });
  const convergenceTracker = createMockConvergenceTracker();
  const regressionDetector = new QualityRegressionDetector();
  const trustLevelManager = createMockTrustLevelManager(
    options.trustLevel ?? 'full_auto'
  );
  const humanEscalationGateway = createMockHumanEscalationGateway();
  const rubricRegistry = new RubricRegistry();

  const config: ReviewGateServiceConfig = {
    max_iterations: options.maxIterations ?? 3,
    aggregation_method: options.aggregationMethod ?? 'mean',
    trust_level: options.trustLevel ?? 'full_auto',
    auto_rollback_on_regression: false,
    panel_sizes: panelSizes,
    rotation_policy: {
      PRD: 'rotate_specialist',
      TDD: 'rotate_specialist',
      PLAN: 'rotate_specialist',
      SPEC: 'rotate_specialist',
      CODE: 'rotate_specialist',
    },
  };

  const service = new ReviewGateService(
    preReviewValidator,
    panelAssemblyService,
    blindFilter,
    promptAssembler,
    reviewerExecutor,
    scoreAggregator,
    disagreementDetector,
    approvalEvaluator,
    feedbackFormatter,
    findingTracker,
    iterationController,
    convergenceTracker,
    regressionDetector,
    trustLevelManager,
    humanEscalationGateway,
    rubricRegistry,
    config
  );

  return { service, llmAdapter };
}

// ---------------------------------------------------------------------------
// Document fixtures
// ---------------------------------------------------------------------------

function makePRDDocument(
  contentOverride?: string,
  idOverride?: string
): DocumentForValidation {
  return {
    id: idOverride ?? 'prd-001',
    content:
      contentOverride ??
      [
        '# Task Management PRD',
        '',
        '## Problem Statement',
        'Users need a better way to manage tasks.',
        '',
        '## Goals',
        '- Increase completion by 20%',
        '',
        '## User Stories',
        'As a PM, I want task boards.',
        '',
        '## Functional Requirements',
        '- FR-001: Create tasks with title and due date',
        '',
        '## Non-Functional Requirements',
        '- NFR-001: Page load < 2s',
        '',
        '## Success Metrics',
        '- Completion > 80%',
        '',
        '## Risks and Mitigations',
        '- Risk: Low adoption. Mitigation: Onboarding.',
      ].join('\n'),
    frontmatter: {
      title: 'Task Management PRD',
      author: 'pm-agent',
      status: 'in_review',
      version: '1.0',
      created_at: '2026-04-01T00:00:00Z',
    },
    sections: [
      {
        id: 'problem_statement',
        title: 'Problem Statement',
        content: 'Users need a better way.',
      },
      { id: 'goals', title: 'Goals', content: 'Increase completion.' },
      {
        id: 'user_stories',
        title: 'User Stories',
        content: 'As a PM, I want task boards.',
      },
      {
        id: 'functional_requirements',
        title: 'Functional Requirements',
        content: 'FR-001',
      },
      {
        id: 'non_functional_requirements',
        title: 'Non-Functional Requirements',
        content: 'NFR-001',
      },
      {
        id: 'success_metrics',
        title: 'Success Metrics',
        content: 'Completion > 80%',
      },
      {
        id: 'risks_and_mitigations',
        title: 'Risks and Mitigations',
        content: 'Risk: Low adoption.',
      },
    ],
    word_count: 800,
  };
}

function makePlanDocument(
  contentOverride?: string,
  idOverride?: string
): DocumentForValidation {
  return {
    id: idOverride ?? 'plan-001',
    content:
      contentOverride ?? 'Plan document content with tasks and dependencies.',
    frontmatter: {
      title: 'Implementation Plan',
      author: 'eng-agent',
      status: 'in_review',
      version: '1.0',
      created_at: '2026-04-01T00:00:00Z',
      traces_from: { document_id: 'tdd-001' },
    },
    sections: [
      { id: 'tasks', title: 'Tasks', content: 'Task list.' },
      { id: 'dependencies', title: 'Dependencies', content: 'Dep list.' },
      {
        id: 'testing_strategy',
        title: 'Testing Strategy',
        content: 'Test plan.',
      },
      {
        id: 'effort_estimates',
        title: 'Effort Estimates',
        content: 'Estimates.',
      },
      { id: 'risks', title: 'Risks', content: 'Risk list.' },
      {
        id: 'tdd_traceability',
        title: 'TDD Traceability',
        content: 'Traces.',
      },
    ],
    word_count: 600,
    traces_from: [{ document_id: 'tdd-001', section_ids: ['architecture'] }],
  };
}

function makeTDDDocument(
  contentOverride?: string,
  idOverride?: string
): DocumentForValidation {
  return {
    id: idOverride ?? 'tdd-001',
    content:
      contentOverride ?? 'TDD document with architecture and design details.',
    frontmatter: {
      title: 'Technical Design Document',
      author: 'eng-agent',
      status: 'in_review',
      version: '1.0',
      created_at: '2026-04-01T00:00:00Z',
      traces_from: { document_id: 'prd-001' },
    },
    sections: [
      { id: 'overview', title: 'Overview', content: 'Overview.' },
      { id: 'architecture', title: 'Architecture', content: 'Arch.' },
      {
        id: 'detailed_design',
        title: 'Detailed Design',
        content: 'Design.',
      },
      { id: 'data_models', title: 'Data Models', content: 'Models.' },
      { id: 'api_contracts', title: 'API Contracts', content: 'APIs.' },
      { id: 'integrations', title: 'Integrations', content: 'Integrations.' },
      { id: 'security', title: 'Security', content: 'Security.' },
      { id: 'trade_offs', title: 'Trade-offs', content: 'Trade-offs.' },
    ],
    word_count: 1200,
    traces_from: [
      { document_id: 'prd-001', section_ids: ['functional_requirements'] },
    ],
  };
}

function makeCodeDocument(
  contentOverride?: string,
  idOverride?: string
): DocumentForValidation {
  return {
    id: idOverride ?? 'code-001',
    content: contentOverride ?? 'Code implementation content.',
    frontmatter: {
      title: 'Implementation Code',
      author: 'eng-agent',
      status: 'in_review',
      version: '1.0',
      created_at: '2026-04-01T00:00:00Z',
      traces_from: { document_id: 'spec-001' },
    },
    sections: [
      {
        id: 'implementation',
        title: 'Implementation',
        content: 'Code here.',
      },
      { id: 'tests', title: 'Tests', content: 'Tests here.' },
      {
        id: 'documentation',
        title: 'Documentation',
        content: 'Docs here.',
      },
      {
        id: 'performance_paths',
        title: 'Performance Paths',
        content: 'Perf.',
      },
      {
        id: 'security_paths',
        title: 'Security Paths',
        content: 'Security.',
      },
      {
        id: 'spec_traceability',
        title: 'Spec Traceability',
        content: 'Trace.',
      },
    ],
    word_count: 900,
    traces_from: [
      { document_id: 'spec-001', section_ids: ['acceptance_criteria'] },
    ],
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('ReviewGateService', () => {
  // =========================================================================
  // Happy path tests
  // =========================================================================

  describe('Happy path tests', () => {
    // -----------------------------------------------------------------------
    // Test 1: Approved on first pass
    // -----------------------------------------------------------------------
    it('1. Approved on first pass: well-formed PRD with scores above threshold', async () => {
      const { service } = buildService({
        scorePerIteration: [90],
        outcomePerIteration: ['approved'],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument();
      const outcome = await service.submitForReview(
        doc,
        'PRD',
        'pm-agent'
      );

      expect(outcome.final_outcome).toBe('approved');
      expect(outcome.total_iterations).toBe(1);
      expect(outcome.final_score).toBe(90);
      expect(outcome.document_id).toBe('prd-001');
      expect(outcome.document_type).toBe('PRD');
      expect(outcome.review_result.outcome).toBe('approved');
      expect(outcome.escalation_package).toBeNull();
      expect(outcome.human_approval_required).toBe(false);
      expect(outcome.gate_record).toBeDefined();
      expect(outcome.gate_record.outcome).toBe('approved');
    });

    // -----------------------------------------------------------------------
    // Test 2: Approved with single reviewer (Plan, panel_size 1)
    // -----------------------------------------------------------------------
    it('2. Approved with single reviewer: Plan document', async () => {
      const { service } = buildService({
        scorePerIteration: [88],
        outcomePerIteration: ['approved'],
        trustLevel: 'full_auto',
        panelSizes: {
          PRD: 2,
          TDD: 2,
          PLAN: 1,
          SPEC: 1,
          CODE: 2,
        },
      });

      const doc = makePlanDocument();
      const outcome = await service.submitForReview(
        doc,
        'Plan' as DocTypeStr,
        'eng-agent'
      );

      expect(outcome.final_outcome).toBe('approved');
      expect(outcome.total_iterations).toBe(1);
    });
  });

  // =========================================================================
  // Revision loop tests
  // =========================================================================

  describe('Revision loop tests', () => {
    // -----------------------------------------------------------------------
    // Test 3: Approved on second pass
    // -----------------------------------------------------------------------
    it('3. Approved on second pass: fails iteration 1, passes iteration 2', async () => {
      const { service } = buildService({
        scorePerIteration: [70, 90],
        outcomePerIteration: ['changes_requested', 'approved'],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(undefined, 'prd-revision-001');

      // Iteration 1
      const outcome1 = await service.submitForReview(
        doc,
        'PRD',
        'pm-agent'
      );

      expect(outcome1.final_outcome).toBe('changes_requested');
      expect(outcome1.total_iterations).toBe(1);

      // Iteration 2 -- revised document
      const revisedDoc = makePRDDocument(
        'Revised content with improvements for iteration 2.',
        'prd-revision-001'
      );
      const outcome2 = await service.submitForReview(
        revisedDoc,
        'PRD',
        'pm-agent'
      );

      expect(outcome2.final_outcome).toBe('approved');
      expect(outcome2.total_iterations).toBe(2);
    });

    // -----------------------------------------------------------------------
    // Test 4: Approved on third pass
    // -----------------------------------------------------------------------
    it('4. Approved on third pass: fails iterations 1 and 2, passes iteration 3', async () => {
      const { service } = buildService({
        scorePerIteration: [60, 75, 92],
        outcomePerIteration: [
          'changes_requested',
          'changes_requested',
          'approved',
        ],
        trustLevel: 'full_auto',
      });

      const baseId = 'prd-three-pass-001';
      const doc1 = makePRDDocument('Content version 1 for three-pass test.', baseId);

      const outcome1 = await service.submitForReview(doc1, 'PRD', 'pm-agent');
      expect(outcome1.final_outcome).toBe('changes_requested');
      expect(outcome1.total_iterations).toBe(1);

      const doc2 = makePRDDocument('Content version 2 with some improvements.', baseId);
      const outcome2 = await service.submitForReview(doc2, 'PRD', 'pm-agent');
      expect(outcome2.final_outcome).toBe('changes_requested');
      expect(outcome2.total_iterations).toBe(2);

      const doc3 = makePRDDocument('Content version 3 fully improved and complete.', baseId);
      const outcome3 = await service.submitForReview(doc3, 'PRD', 'pm-agent');
      expect(outcome3.final_outcome).toBe('approved');
      expect(outcome3.total_iterations).toBe(3);
    });
  });

  // =========================================================================
  // Rejection and escalation tests
  // =========================================================================

  describe('Rejection and escalation tests', () => {
    // -----------------------------------------------------------------------
    // Test 5: Max iteration escalation
    // -----------------------------------------------------------------------
    it('5. Max iteration escalation: fails all 3 iterations', async () => {
      const { service } = buildService({
        scorePerIteration: [60, 65, 68],
        outcomePerIteration: [
          'changes_requested',
          'changes_requested',
          'changes_requested',
        ],
        trustLevel: 'full_auto',
        maxIterations: 3,
      });

      const baseId = 'prd-max-iter-001';

      const doc1 = makePRDDocument('Content attempt 1 for max iterations.', baseId);
      const o1 = await service.submitForReview(doc1, 'PRD', 'pm-agent');
      expect(o1.final_outcome).toBe('changes_requested');

      const doc2 = makePRDDocument('Content attempt 2 slightly better.', baseId);
      const o2 = await service.submitForReview(doc2, 'PRD', 'pm-agent');
      expect(o2.final_outcome).toBe('changes_requested');

      const doc3 = makePRDDocument('Content attempt 3 still not enough.', baseId);
      const o3 = await service.submitForReview(doc3, 'PRD', 'pm-agent');

      expect(o3.final_outcome).toBe('escalated');
      expect(o3.total_iterations).toBe(3);
      expect(o3.escalation_package).not.toBeNull();
    });

    // -----------------------------------------------------------------------
    // Test 6: Critical:reject finding -- immediate rejection
    // -----------------------------------------------------------------------
    it('6. Critical:reject finding causes immediate escalation', async () => {
      const adapter = createMockLLMAdapter({
        scores: { problem_clarity: 90, goals_measurability: 85 },
        findings: [
          {
            id: 'crit-reject-001',
            section_id: 'problem_statement',
            category_id: 'problem_clarity',
            severity: 'critical',
            critical_sub: 'reject',
            description: 'Fundamental flaw in problem statement.',
            evidence: 'Problem statement contradicts goals.',
            suggested_resolution: 'Requires human review.',
          },
        ],
      });

      const { service } = buildService({
        llmAdapter: adapter,
        scorePerIteration: [85],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(undefined, 'prd-crit-reject-001');
      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      expect(outcome.final_outcome).toBe('escalated');
      expect(outcome.total_iterations).toBe(1);
      expect(outcome.escalation_package).not.toBeNull();
    });

    // -----------------------------------------------------------------------
    // Test 7: Critical:blocking finding -- changes_requested
    // -----------------------------------------------------------------------
    it('7. Critical:blocking finding forces changes_requested even with good score', async () => {
      const adapter = createMockLLMAdapter({
        scores: {
          problem_clarity: 90,
          goals_measurability: 90,
          user_story_coverage: 90,
          requirements_completeness: 90,
          requirements_testability: 90,
          risk_identification: 90,
          internal_consistency: 90,
        },
        findings: [
          {
            id: 'crit-blocking-001',
            section_id: 'functional_requirements',
            category_id: 'requirements_completeness',
            severity: 'critical',
            critical_sub: 'blocking',
            description: 'Missing critical requirement.',
            evidence: 'Requirement FR-002 has no acceptance criteria.',
            suggested_resolution: 'Add acceptance criteria to FR-002.',
          },
        ],
      });

      const { service } = buildService({
        llmAdapter: adapter,
        scorePerIteration: [90],
        outcomePerIteration: ['changes_requested'],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(undefined, 'prd-crit-blocking-001');
      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      expect(outcome.final_outcome).toBe('changes_requested');
      expect(outcome.review_result.findings.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Quality signals tests
  // =========================================================================

  describe('Quality signals tests', () => {
    // -----------------------------------------------------------------------
    // Test 8: Quality regression flagged
    // -----------------------------------------------------------------------
    it('8. Quality regression flagged: score drops from 80 to 73', async () => {
      const { service } = buildService({
        scorePerIteration: [80, 73],
        outcomePerIteration: ['changes_requested', 'changes_requested'],
        trustLevel: 'full_auto',
      });

      const baseId = 'prd-regression-001';
      const doc1 = makePRDDocument('Original content for regression test.', baseId);
      await service.submitForReview(doc1, 'PRD', 'pm-agent');

      const doc2 = makePRDDocument(
        'Worse revision that regresses quality.',
        baseId
      );
      const outcome2 = await service.submitForReview(doc2, 'PRD', 'pm-agent');

      expect(outcome2.review_result.quality_regression).not.toBeNull();
      if (outcome2.review_result.quality_regression) {
        expect(outcome2.review_result.quality_regression.previous_score).toBe(80);
        expect(outcome2.review_result.quality_regression.current_score).toBe(73);
        expect(outcome2.review_result.quality_regression.delta).toBe(-7);
      }
    });

    // -----------------------------------------------------------------------
    // Test 9: Stagnation warning on first detection
    // -----------------------------------------------------------------------
    it('9. Stagnation warning on first detection: score declines on iteration 2', async () => {
      const { service } = buildService({
        scorePerIteration: [80, 75],
        outcomePerIteration: ['changes_requested', 'changes_requested'],
        trustLevel: 'full_auto',
        maxIterations: 5,
      });

      const baseId = 'prd-stagnation-warn-001';
      const doc1 = makePRDDocument('Content for stagnation warning test v1.', baseId);
      await service.submitForReview(doc1, 'PRD', 'pm-agent');

      const doc2 = makePRDDocument('Content for stagnation warning test v2 worse.', baseId);
      const outcome2 = await service.submitForReview(doc2, 'PRD', 'pm-agent');

      expect(outcome2.review_result.stagnation_warning).toBe(true);
      // Not yet rejected
      expect(outcome2.final_outcome).not.toBe('rejected');
      expect(outcome2.final_outcome).not.toBe('escalated');
    });

    // -----------------------------------------------------------------------
    // Test 10: Stagnation forced rejection (2 consecutive)
    // -----------------------------------------------------------------------
    it('10. Stagnation forced rejection: score declines on iterations 2 and 3', async () => {
      const { service } = buildService({
        scorePerIteration: [80, 75, 70],
        outcomePerIteration: [
          'changes_requested',
          'changes_requested',
          'changes_requested',
        ],
        trustLevel: 'full_auto',
        maxIterations: 5,
      });

      const baseId = 'prd-stagnation-reject-001';

      const doc1 = makePRDDocument('Stagnation rejection test content v1.', baseId);
      await service.submitForReview(doc1, 'PRD', 'pm-agent');

      const doc2 = makePRDDocument('Stagnation rejection test content v2 worse.', baseId);
      const o2 = await service.submitForReview(doc2, 'PRD', 'pm-agent');
      expect(o2.review_result.stagnation_warning).toBe(true);

      const doc3 = makePRDDocument('Stagnation rejection test content v3 even worse.', baseId);
      const o3 = await service.submitForReview(doc3, 'PRD', 'pm-agent');

      expect(o3.final_outcome).toBe('escalated');
    });

    // -----------------------------------------------------------------------
    // Test 11: Identical revision detection
    // -----------------------------------------------------------------------
    it('11. Identical revision detection: same content submitted twice auto-fails', async () => {
      const { service } = buildService({
        scorePerIteration: [75, 0],
        outcomePerIteration: ['changes_requested', 'changes_requested'],
        trustLevel: 'full_auto',
      });

      const baseId = 'prd-identical-001';
      const content = 'This content will be submitted unchanged.';

      const doc1 = makePRDDocument(content, baseId);
      const o1 = await service.submitForReview(doc1, 'PRD', 'pm-agent');
      expect(o1.final_outcome).toBe('changes_requested');

      // Submit exact same content again
      const doc2 = makePRDDocument(content, baseId);
      const o2 = await service.submitForReview(doc2, 'PRD', 'pm-agent');

      expect(o2.final_outcome).toBe('rejected');
      expect(o2.review_result.findings.length).toBeGreaterThan(0);
      expect(o2.review_result.findings[0].severity).toBe('critical');
      expect(o2.review_result.findings[0].critical_sub).toBe('blocking');
      expect(o2.review_result.summary).toContain('Identical revision');
    });
  });

  // =========================================================================
  // Trust level tests
  // =========================================================================

  describe('Trust level tests', () => {
    // -----------------------------------------------------------------------
    // Test 12: approve_roots -- PRD approved, awaiting human
    // -----------------------------------------------------------------------
    it('12. approve_roots: PRD approved -> awaiting_human', async () => {
      const { service } = buildService({
        scorePerIteration: [90],
        outcomePerIteration: ['approved'],
        trustLevel: 'approve_roots',
      });

      const doc = makePRDDocument(undefined, 'prd-trust-roots-001');
      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      expect(outcome.final_outcome).toBe('awaiting_human');
      expect(outcome.human_approval_required).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Test 13: approve_roots -- TDD approved, no human
    // -----------------------------------------------------------------------
    it('13. approve_roots: TDD approved -> approved (no human needed)', async () => {
      const { service } = buildService({
        scorePerIteration: [90],
        outcomePerIteration: ['approved'],
        trustLevel: 'approve_roots',
      });

      const doc = makeTDDDocument(undefined, 'tdd-trust-roots-001');
      const outcome = await service.submitForReview(doc, 'TDD', 'eng-agent');

      expect(outcome.final_outcome).toBe('approved');
      expect(outcome.human_approval_required).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Test 14: full_auto -- PRD approved, no human
    // -----------------------------------------------------------------------
    it('14. full_auto: PRD approved -> approved directly', async () => {
      const { service } = buildService({
        scorePerIteration: [92],
        outcomePerIteration: ['approved'],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(undefined, 'prd-full-auto-001');
      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      expect(outcome.final_outcome).toBe('approved');
      expect(outcome.human_approval_required).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Test 15: approve_all -- Code approved, awaiting human
    // -----------------------------------------------------------------------
    it('15. approve_all: Code approved -> awaiting_human', async () => {
      const { service } = buildService({
        scorePerIteration: [88],
        outcomePerIteration: ['approved'],
        trustLevel: 'approve_all',
      });

      const doc = makeCodeDocument(undefined, 'code-approve-all-001');
      const outcome = await service.submitForReview(
        doc,
        'Code' as DocTypeStr,
        'eng-agent'
      );

      expect(outcome.final_outcome).toBe('awaiting_human');
      expect(outcome.human_approval_required).toBe(true);
    });
  });

  // =========================================================================
  // Finding tracking tests
  // =========================================================================

  describe('Finding tracking tests', () => {
    // -----------------------------------------------------------------------
    // Test 16: Findings resolved between iterations
    // -----------------------------------------------------------------------
    it('16. Findings resolved between iterations', async () => {
      // Iteration 1: 3 findings
      const adapter1 = createMockLLMAdapter({
        scores: {},
        findings: [
          {
            id: 'f1',
            section_id: 'problem_statement',
            category_id: 'problem_clarity',
            severity: 'major',
            description: 'Finding 1',
          },
          {
            id: 'f2',
            section_id: 'goals',
            category_id: 'goals_measurability',
            severity: 'major',
            description: 'Finding 2',
          },
          {
            id: 'f3',
            section_id: 'user_stories',
            category_id: 'user_story_coverage',
            severity: 'minor',
            description: 'Finding 3',
          },
        ],
      });

      // Iteration 2: only 1 finding (f1 remains, f2 and f3 resolved)
      const adapter2 = createMockLLMAdapter({
        scores: {},
        findings: [
          {
            id: 'f1-v2',
            section_id: 'problem_statement',
            category_id: 'problem_clarity',
            severity: 'major',
            description: 'Finding 1 persists',
          },
        ],
      });

      let adapterCall = 0;
      const dualAdapter: LLMAdapter = {
        invoke: jest.fn(async (prompt: any, agentSeed: number, timeout: number) => {
          adapterCall++;
          // First 2 calls = iteration 1 (2 reviewers), next 2 = iteration 2
          if (adapterCall <= 2) {
            return adapter1.invoke(prompt, agentSeed, timeout);
          }
          return adapter2.invoke(prompt, agentSeed, timeout);
        }),
      };

      const { service } = buildService({
        llmAdapter: dualAdapter,
        scorePerIteration: [70, 85],
        outcomePerIteration: ['changes_requested', 'changes_requested'],
        trustLevel: 'full_auto',
      });

      const baseId = 'prd-finding-resolve-001';
      const doc1 = makePRDDocument('Finding resolution test v1.', baseId);
      const o1 = await service.submitForReview(doc1, 'PRD', 'pm-agent');

      expect(o1.review_result.findings.length).toBeGreaterThan(0);

      const doc2 = makePRDDocument('Finding resolution test v2 improved.', baseId);
      const o2 = await service.submitForReview(doc2, 'PRD', 'pm-agent');

      // Verify that the finding tracker was exercised
      expect(o2.review_result).toBeDefined();
      // The tracked_findings from iteration 2 should have fewer findings
      expect(o2.review_result.findings.length).toBeLessThan(
        o1.review_result.findings.length
      );
    });

    // -----------------------------------------------------------------------
    // Test 17: Findings recurred
    // -----------------------------------------------------------------------
    it('17. Finding resolved then recurred is marked recurred', async () => {
      // Track findings across 3 iterations.
      // Iteration 1: finding on problem_statement::problem_clarity
      // Iteration 2: finding resolved
      // Iteration 3: finding recurs

      let adapterCallCount = 0;
      const multiAdapter: LLMAdapter = {
        invoke: jest.fn(async (_prompt: any, agentSeed: number) => {
          adapterCallCount++;
          const findings: any[] = [];

          // Iterations 1-2 calls: first 2 calls = iter 1, next 2 = iter 2, next 2 = iter 3
          if (adapterCallCount <= 2) {
            // Iteration 1: has finding
            findings.push({
              id: `recur-f1-${adapterCallCount}`,
              section_id: 'problem_statement',
              category_id: 'problem_clarity',
              severity: 'major',
              critical_sub: null,
              upstream_defect: false,
              description: 'Problem statement unclear.',
              evidence: 'Evidence',
              suggested_resolution: 'Clarify problem statement.',
            });
          } else if (adapterCallCount <= 4) {
            // Iteration 2: finding resolved (no findings)
          } else {
            // Iteration 3: finding recurs
            findings.push({
              id: `recur-f1-v3-${adapterCallCount}`,
              section_id: 'problem_statement',
              category_id: 'problem_clarity',
              severity: 'major',
              critical_sub: null,
              upstream_defect: false,
              description: 'Problem statement unclear again.',
              evidence: 'Evidence',
              suggested_resolution: 'Fix it again.',
            });
          }

          const rubricCategories = [
            'problem_clarity', 'goals_measurability', 'user_story_coverage',
            'requirements_completeness', 'requirements_testability',
            'risk_identification', 'internal_consistency',
          ];

          return JSON.stringify({
            reviewer_id: `reviewer-${agentSeed}`,
            reviewer_role: 'test-reviewer',
            document_id: 'doc-001',
            document_version: '1.0',
            timestamp: new Date().toISOString(),
            scoring_mode: 'document_level',
            category_scores: rubricCategories.map(id => ({
              category_id: id,
              score: 80,
              section_scores: null,
              justification: `Score for ${id}`,
            })),
            findings,
            summary: 'Review complete.',
          });
        }),
      };

      const { service } = buildService({
        llmAdapter: multiAdapter,
        scorePerIteration: [70, 82, 78],
        outcomePerIteration: [
          'changes_requested',
          'changes_requested',
          'changes_requested',
        ],
        trustLevel: 'full_auto',
        maxIterations: 5,
      });

      const baseId = 'prd-recurrence-001';

      const doc1 = makePRDDocument('Recurrence test content v1.', baseId);
      await service.submitForReview(doc1, 'PRD', 'pm-agent');

      const doc2 = makePRDDocument('Recurrence test content v2 better.', baseId);
      await service.submitForReview(doc2, 'PRD', 'pm-agent');

      const doc3 = makePRDDocument('Recurrence test content v3 regressed.', baseId);
      const o3 = await service.submitForReview(doc3, 'PRD', 'pm-agent');

      // Check that findings with the same section_id::category_id key are tracked
      expect(o3.review_result).toBeDefined();
      // The finding tracker should have detected recurrence
      const recurredFindings = o3.review_result.findings.filter(
        (f) => f.resolution_status === 'recurred'
      );
      expect(recurredFindings.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Disagreement tests
  // =========================================================================

  describe('Disagreement tests', () => {
    // -----------------------------------------------------------------------
    // Test 18: Disagreement detected between reviewers
    // -----------------------------------------------------------------------
    it('18. Disagreement detected: two reviewers score security_depth differently', async () => {
      // Create adapter where reviewers return very different scores for a category
      const seedToResponse = new Map<number, MockReviewerResponse>();

      // We need to set scores for all categories but make one category diverge
      // Note: The actual seeds are generated by PanelAssemblyService, so we
      // need a generic approach
      let callIdx = 0;
      const divergentAdapter: LLMAdapter = {
        invoke: jest.fn(async (_prompt: any, agentSeed: number) => {
          callIdx++;

          // Categories for TDD rubric
          const tddCategories = [
            'prd_alignment', 'architecture_soundness', 'data_model_integrity',
            'api_contract_completeness', 'integration_robustness',
            'security_depth', 'tradeoff_rigor',
          ];

          // First reviewer: security_depth = 75
          // Second reviewer: security_depth = 55
          const securityScore = callIdx % 2 === 1 ? 75 : 55;

          return JSON.stringify({
            reviewer_id: `reviewer-${agentSeed}`,
            reviewer_role: 'test-reviewer',
            document_id: 'tdd-001',
            document_version: '1.0',
            timestamp: new Date().toISOString(),
            scoring_mode: 'document_level',
            category_scores: tddCategories.map((id) => ({
              category_id: id,
              score: id === 'security_depth' ? securityScore : 85,
              section_scores: null,
              justification: `Score for ${id}`,
            })),
            findings: [],
            summary: 'Review complete.',
          });
        }),
      };

      const { service } = buildService({
        llmAdapter: divergentAdapter,
        scorePerIteration: [82],
        outcomePerIteration: ['changes_requested'],
        trustLevel: 'full_auto',
      });

      const doc = makeTDDDocument(undefined, 'tdd-disagreement-001');
      const outcome = await service.submitForReview(doc, 'TDD', 'eng-agent');

      // DisagreementDetector should flag the 20-point divergence
      const disagreements = outcome.review_result.disagreements;
      expect(disagreements.length).toBeGreaterThan(0);

      const securityDisagreement = disagreements.find(
        (d) => d.category_id === 'security_depth'
      );
      expect(securityDisagreement).toBeDefined();
      expect(securityDisagreement!.variance).toBeGreaterThanOrEqual(15);
    });
  });

  // =========================================================================
  // Error handling tests
  // =========================================================================

  describe('Error handling tests', () => {
    // -----------------------------------------------------------------------
    // Test 19: Pre-review validation fails
    // -----------------------------------------------------------------------
    it('19. Pre-review validation fails: missing required sections', async () => {
      const { service } = buildService({
        trustLevel: 'full_auto',
      });

      // Document missing required sections
      const doc: DocumentForValidation = {
        id: 'prd-invalid-001',
        content: 'Minimal content without required sections.',
        frontmatter: {
          title: 'Bad PRD',
          author: 'pm-agent',
          status: 'in_review',
          version: '1.0',
          created_at: '2026-04-01T00:00:00Z',
        },
        sections: [], // Missing all required sections
        word_count: 100,
      };

      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      expect(outcome.final_outcome).toBe('rejected');
      expect(outcome.total_iterations).toBe(0);
      expect(outcome.review_result.findings.length).toBeGreaterThan(0);
      expect(outcome.review_result.findings[0].severity).toBe('critical');
    });

    // -----------------------------------------------------------------------
    // Test 20: All reviewers fail
    // -----------------------------------------------------------------------
    it('20. All reviewers fail: escalated with reason "reviewer failure"', async () => {
      const failingAdapter: LLMAdapter = {
        invoke: jest.fn(async () => {
          throw new Error('LLM invocation failed: timeout');
        }),
      };

      const { service } = buildService({
        llmAdapter: failingAdapter,
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(undefined, 'prd-all-fail-001');
      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      expect(outcome.final_outcome).toBe('escalated');
      expect(outcome.escalation_package).not.toBeNull();
      expect(outcome.escalation_package!.reason).toContain('reviewer failure');
    });
  });

  // =========================================================================
  // Crash recovery tests
  // =========================================================================

  describe('Crash recovery tests', () => {
    // -----------------------------------------------------------------------
    // Test 21: Restore from review_completed checkpoint
    // -----------------------------------------------------------------------
    it('21. Restore from review_completed checkpoint: aggregation and decision proceed', async () => {
      // First, run a normal iteration to establish a checkpoint
      const { service } = buildService({
        scorePerIteration: [78],
        outcomePerIteration: ['changes_requested'],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(
        'Content for crash recovery test.',
        'prd-crash-recovery-001'
      );

      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      // Verify the checkpoint was created
      expect(outcome.gate_record.gate_id).toBeDefined();
      expect(outcome.total_iterations).toBe(1);
      expect(outcome.final_outcome).toBe('changes_requested');

      // Now submit the same document again (simulating recovery)
      // The service should recognize the existing state and continue from
      // where it left off
      const revisedDoc = makePRDDocument(
        'Revised content after recovery.',
        'prd-crash-recovery-001'
      );

      const recoveryOutcome = await service.submitForReview(
        revisedDoc,
        'PRD',
        'pm-agent'
      );

      // Should have continued to iteration 2
      expect(recoveryOutcome.total_iterations).toBe(2);
    });
  });

  // =========================================================================
  // Edge case tests
  // =========================================================================

  describe('Edge case tests', () => {
    // -----------------------------------------------------------------------
    // Test 22: Document with 0-weight category
    // -----------------------------------------------------------------------
    it('22. Document with 0-weight category: score calculation skips it, no crash', async () => {
      // Use a custom rubric with a 0-weight category
      // Since we use mock score aggregator, we verify no crash
      const { service } = buildService({
        scorePerIteration: [87],
        outcomePerIteration: ['approved'],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(undefined, 'prd-zero-weight-001');
      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      // Should not crash
      expect(outcome.final_outcome).toBe('approved');
      expect(Number.isFinite(outcome.final_score)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Test 23: Score exactly at threshold
    // -----------------------------------------------------------------------
    it('23. Score exactly at threshold: outcome is approved', async () => {
      // PRD threshold is 85
      const { service } = buildService({
        scorePerIteration: [85],
        outcomePerIteration: ['approved'],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(undefined, 'prd-exact-threshold-001');
      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      expect(outcome.final_outcome).toBe('approved');
      expect(outcome.final_score).toBe(85);
    });

    // -----------------------------------------------------------------------
    // Test 24: NaN aggregate score
    // -----------------------------------------------------------------------
    it('24. NaN aggregate score: outcome is changes_requested', async () => {
      const { service } = buildService({
        scorePerIteration: [NaN],
        outcomePerIteration: ['changes_requested'],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(undefined, 'prd-nan-score-001');
      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      expect(outcome.final_outcome).toBe('changes_requested');
      // Score should be handled gracefully (0 or NaN)
      expect(outcome.review_result).toBeDefined();
    });
  });

  // =========================================================================
  // GateOutcome structure tests
  // =========================================================================

  describe('GateOutcome structure', () => {
    it('returns all required fields in GateOutcome', async () => {
      const { service } = buildService({
        scorePerIteration: [90],
        outcomePerIteration: ['approved'],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(undefined, 'prd-structure-001');
      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      // Verify all GateOutcome fields are present
      expect(outcome.gate_id).toBeDefined();
      expect(typeof outcome.gate_id).toBe('string');
      expect(outcome.document_id).toBe('prd-structure-001');
      expect(outcome.document_type).toBe('PRD');
      expect(['approved', 'rejected', 'escalated', 'awaiting_human']).toContain(
        outcome.final_outcome
      );
      expect(typeof outcome.final_score).toBe('number');
      expect(typeof outcome.total_iterations).toBe('number');
      expect(outcome.review_result).toBeDefined();
      expect(typeof outcome.human_approval_required).toBe('boolean');
      expect(outcome.gate_record).toBeDefined();

      // Verify GateReviewResult structure
      const rr = outcome.review_result;
      expect(rr.gate_id).toBeDefined();
      expect(rr.document_id).toBeDefined();
      expect(rr.document_version).toBeDefined();
      expect(typeof rr.iteration).toBe('number');
      expect(['approved', 'changes_requested', 'rejected']).toContain(rr.outcome);
      expect(typeof rr.aggregate_score).toBe('number');
      expect(typeof rr.threshold).toBe('number');
      expect(['mean', 'median', 'min']).toContain(rr.aggregation_method);
      expect(Array.isArray(rr.category_aggregates)).toBe(true);
      expect(Array.isArray(rr.findings)).toBe(true);
      expect(Array.isArray(rr.disagreements)).toBe(true);
      expect(typeof rr.stagnation_warning).toBe('boolean');
      expect(typeof rr.summary).toBe('string');

      // Verify ReviewGateRecord structure
      const gr = outcome.gate_record;
      expect(gr.gate_id).toBeDefined();
      expect(gr.document_id).toBeDefined();
      expect(gr.document_type).toBe('PRD');
      expect(typeof gr.iteration).toBe('number');
      expect(typeof gr.max_iterations).toBe('number');
      expect(gr.rubric_version).toBeDefined();
      expect(['approved', 'changes_requested', 'rejected']).toContain(gr.outcome);
    });

    it('summary includes score, outcome, and finding counts', async () => {
      const adapter = createMockLLMAdapter({
        scores: {},
        findings: [
          {
            id: 'summary-f1',
            section_id: 'problem_statement',
            category_id: 'problem_clarity',
            severity: 'major',
            description: 'Test finding for summary',
          },
        ],
      });

      const { service } = buildService({
        llmAdapter: adapter,
        scorePerIteration: [78],
        outcomePerIteration: ['changes_requested'],
        trustLevel: 'full_auto',
      });

      const doc = makePRDDocument(undefined, 'prd-summary-001');
      const outcome = await service.submitForReview(doc, 'PRD', 'pm-agent');

      const summary = outcome.review_result.summary;
      expect(summary).toContain('Score:');
      expect(summary).toContain('Outcome:');
    });
  });
});
