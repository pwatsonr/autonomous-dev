import { GateReviewResult, MergedFinding } from '../../src/review-gate/types';
import { IterationState } from '../../src/review-gate/iteration-controller';
import {
  HumanEscalationGateway,
  EscalationTrigger,
  DocumentVersion,
  DocumentSummary,
  TraceLink,
  computeRecommendedAction,
} from '../../src/review-gate/human-escalation-gateway';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIterationState(overrides: Partial<IterationState> = {}): IterationState {
  return {
    gate_id: 'gate-001',
    document_id: 'PRD-001',
    current_iteration: 3,
    max_iterations: 3,
    score_history: [],
    finding_history: [],
    content_hashes: [],
    outcome_history: [],
    stagnation_count: 0,
    checkpoints: [],
    ...overrides,
  };
}

function makeGateReviewResult(overrides: Partial<GateReviewResult> = {}): GateReviewResult {
  return {
    gate_id: 'gate-001',
    document_id: 'PRD-001',
    document_version: 'v1',
    iteration: 1,
    outcome: 'changes_requested',
    aggregate_score: 75,
    threshold: 85,
    aggregation_method: 'mean',
    category_aggregates: [],
    findings: [],
    disagreements: [],
    quality_regression: null,
    stagnation_warning: false,
    summary: 'Review complete.',
    ...overrides,
  };
}

function makeMergedFinding(overrides: Partial<MergedFinding> = {}): MergedFinding {
  return {
    id: 'f-001',
    section_id: 'section-1',
    category_id: 'completeness',
    severity: 'major',
    critical_sub: null,
    upstream_defect: false,
    description: 'Test finding',
    evidence: 'Evidence here',
    suggested_resolution: 'Fix it',
    reported_by: ['r1'],
    resolution_status: 'open',
    prior_finding_id: null,
    ...overrides,
  };
}

function makeDocumentVersion(version: string, content: string): DocumentVersion {
  return {
    version,
    content,
    created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HumanEscalationGateway', () => {
  const gateway = new HumanEscalationGateway();

  // -----------------------------------------------------------------------
  // Test 1: Max iterations escalation
  // -----------------------------------------------------------------------
  test('Max iterations exhausted: package has 3 review entries, score_trend of 3 values', async () => {
    const reviewHistory = [
      makeGateReviewResult({ iteration: 1, aggregate_score: 70 }),
      makeGateReviewResult({ iteration: 2, aggregate_score: 74 }),
      makeGateReviewResult({ iteration: 3, aggregate_score: 76 }),
    ];
    const state = makeIterationState({ max_iterations: 3, current_iteration: 3 });
    const versions = [
      makeDocumentVersion('v1', 'content v1'),
      makeDocumentVersion('v2', 'content v2'),
      makeDocumentVersion('v3', 'content v3'),
    ];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      [],
      'max_iterations_exhausted',
      versions,
      null,
      []
    );

    expect(pkg.escalation_trigger).toBe('max_iterations_exhausted');
    expect(pkg.review_history).toHaveLength(3);
    expect(pkg.score_trend).toEqual([70, 74, 76]);
    expect(pkg.escalation_reason).toContain('3');
    expect(pkg.escalation_reason).toContain('did not achieve approval');
  });

  // -----------------------------------------------------------------------
  // Test 2: Critical reject escalation
  // -----------------------------------------------------------------------
  test('Critical reject finding: package includes the finding', async () => {
    const criticalFinding = makeMergedFinding({
      id: 'crit-001',
      severity: 'critical',
      critical_sub: 'reject',
      description: 'Fundamentally flawed approach',
      resolution_status: 'open',
    });
    const reviewHistory = [
      makeGateReviewResult({ iteration: 1, aggregate_score: 60 }),
    ];
    const state = makeIterationState({ current_iteration: 1 });
    const versions = [makeDocumentVersion('v1', 'content v1')];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      [criticalFinding],
      'critical_reject_finding',
      versions,
      null,
      []
    );

    expect(pkg.escalation_trigger).toBe('critical_reject_finding');
    expect(pkg.escalation_reason).toContain('Fundamentally flawed approach');
    expect(pkg.unresolved_findings).toHaveLength(1);
    expect(pkg.unresolved_findings[0].id).toBe('crit-001');
  });

  // -----------------------------------------------------------------------
  // Test 3: Stagnation escalation
  // -----------------------------------------------------------------------
  test('Stagnation persisted: reason includes score trend and recurring finding count', async () => {
    const recurredFinding = makeMergedFinding({
      id: 'rec-001',
      resolution_status: 'recurred',
    });
    const reviewHistory = [
      makeGateReviewResult({ iteration: 1, aggregate_score: 72, stagnation_warning: true }),
      makeGateReviewResult({ iteration: 2, aggregate_score: 73, stagnation_warning: true }),
    ];
    const state = makeIterationState({ current_iteration: 2, stagnation_count: 2 });
    const versions = [
      makeDocumentVersion('v1', 'content v1'),
      makeDocumentVersion('v2', 'content v2'),
    ];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      [recurredFinding],
      'stagnation_persisted',
      versions,
      null,
      []
    );

    expect(pkg.escalation_trigger).toBe('stagnation_persisted');
    expect(pkg.escalation_reason).toContain('stagnated');
    expect(pkg.escalation_reason).toContain('72');
    expect(pkg.escalation_reason).toContain('73');
    expect(pkg.escalation_reason).toContain('1'); // recurring finding count
    expect(pkg.recurred_findings).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Test 4: Trust level escalation
  // -----------------------------------------------------------------------
  test('Trust level requirement: reason mentions trust level', async () => {
    const reviewHistory = [
      makeGateReviewResult({ iteration: 1, aggregate_score: 90, outcome: 'approved' }),
    ];
    const state = makeIterationState({ current_iteration: 1 });
    const versions = [makeDocumentVersion('v1', 'content v1')];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      [],
      'trust_level_requirement',
      versions,
      null,
      []
    );

    expect(pkg.escalation_trigger).toBe('trust_level_requirement');
    expect(pkg.escalation_reason).toContain('Trust level');
    expect(pkg.escalation_reason).toContain('human approval');
  });

  // -----------------------------------------------------------------------
  // Test 5: Recommended action -- approve_override
  // -----------------------------------------------------------------------
  test('Recommended action: approve_override when score 83, threshold 85, no critical', async () => {
    const reviewHistory = [
      makeGateReviewResult({ aggregate_score: 83, threshold: 85, stagnation_warning: false }),
    ];
    const state = makeIterationState({ current_iteration: 1 });
    const versions = [makeDocumentVersion('v1', 'content v1')];
    const findings: MergedFinding[] = [
      makeMergedFinding({ severity: 'minor', resolution_status: 'open' }),
    ];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      findings,
      'max_iterations_exhausted',
      versions,
      null,
      []
    );

    expect(pkg.recommended_action).toBe('approve_override');
    expect(pkg.recommended_action_rationale).toContain('within 3 points');
  });

  // -----------------------------------------------------------------------
  // Test 6: Recommended action -- approve_override rejected by critical
  // -----------------------------------------------------------------------
  test('Recommended action: reject_and_restart when score 83 but critical finding exists', async () => {
    const criticalFinding = makeMergedFinding({
      severity: 'critical',
      critical_sub: 'reject',
      resolution_status: 'open',
    });
    const reviewHistory = [
      makeGateReviewResult({ aggregate_score: 83, threshold: 85, stagnation_warning: false }),
    ];
    const state = makeIterationState({ current_iteration: 1 });
    const versions = [makeDocumentVersion('v1', 'content v1')];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      [criticalFinding],
      'max_iterations_exhausted',
      versions,
      null,
      []
    );

    expect(pkg.recommended_action).toBe('reject_and_restart');
    expect(pkg.recommended_action_rationale).toContain('critical findings');
  });

  // -----------------------------------------------------------------------
  // Test 7: Recommended action -- reject_and_restart (stagnation)
  // -----------------------------------------------------------------------
  test('Recommended action: reject_and_restart when stagnation detected', async () => {
    const reviewHistory = [
      makeGateReviewResult({ aggregate_score: 70, stagnation_warning: true, threshold: 85 }),
    ];
    const state = makeIterationState({ current_iteration: 1 });
    const versions = [makeDocumentVersion('v1', 'content v1')];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      [],
      'stagnation_persisted',
      versions,
      null,
      []
    );

    expect(pkg.recommended_action).toBe('reject_and_restart');
    expect(pkg.recommended_action_rationale).toContain('stagnation');
  });

  // -----------------------------------------------------------------------
  // Test 8: Recommended action -- reject_and_restart (declining scores)
  // -----------------------------------------------------------------------
  test('Recommended action: reject_and_restart when scores declining', async () => {
    const reviewHistory = [
      makeGateReviewResult({ aggregate_score: 78, threshold: 85, stagnation_warning: false }),
      makeGateReviewResult({ aggregate_score: 75, threshold: 85, stagnation_warning: false }),
    ];
    const state = makeIterationState({ current_iteration: 2 });
    const versions = [
      makeDocumentVersion('v1', 'content v1'),
      makeDocumentVersion('v2', 'content v2'),
    ];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      [],
      'max_iterations_exhausted',
      versions,
      null,
      []
    );

    expect(pkg.recommended_action).toBe('reject_and_restart');
    expect(pkg.recommended_action_rationale).toContain('declining');
  });

  // -----------------------------------------------------------------------
  // Test 9: Recommended action -- manual_revision (default)
  // -----------------------------------------------------------------------
  test('Recommended action: manual_revision when score 70, no stagnation, no critical', async () => {
    const reviewHistory = [
      makeGateReviewResult({ aggregate_score: 70, threshold: 85, stagnation_warning: false }),
    ];
    const state = makeIterationState({ current_iteration: 1 });
    const versions = [makeDocumentVersion('v1', 'content v1')];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      [],
      'max_iterations_exhausted',
      versions,
      null,
      []
    );

    expect(pkg.recommended_action).toBe('manual_revision');
    expect(pkg.recommended_action_rationale).toContain('fundamentally sound');
  });

  // -----------------------------------------------------------------------
  // Test 10: Version diffs present
  // -----------------------------------------------------------------------
  test('Version diffs: 3 versions produce 2 diffs (v1->v2, v2->v3)', async () => {
    const reviewHistory = [
      makeGateReviewResult({ aggregate_score: 90, threshold: 85 }),
    ];
    const state = makeIterationState({ current_iteration: 1 });
    const versions = [
      makeDocumentVersion('v1', 'Line 1\nLine 2'),
      makeDocumentVersion('v2', 'Line 1\nLine 2 modified'),
      makeDocumentVersion('v3', 'Line 1 changed\nLine 2 modified\nLine 3 added'),
    ];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      [],
      'trust_level_requirement',
      versions,
      null,
      []
    );

    expect(pkg.diffs).toHaveLength(2);
    expect(pkg.diffs[0].from_version).toBe('v1');
    expect(pkg.diffs[0].to_version).toBe('v2');
    expect(pkg.diffs[1].from_version).toBe('v2');
    expect(pkg.diffs[1].to_version).toBe('v3');
    expect(pkg.diffs[0].diff).toContain('---');
    expect(pkg.diffs[0].diff).toContain('+++');
  });

  // -----------------------------------------------------------------------
  // Test 11: Unresolved findings filtered
  // -----------------------------------------------------------------------
  test('Unresolved findings: 5 total, 3 unresolved', async () => {
    const findings = [
      makeMergedFinding({ id: 'f1', resolution_status: 'open' }),
      makeMergedFinding({ id: 'f2', resolution_status: 'resolved' }),
      makeMergedFinding({ id: 'f3', resolution_status: 'open' }),
      makeMergedFinding({ id: 'f4', resolution_status: 'recurred' }),
      makeMergedFinding({ id: 'f5', resolution_status: 'open' }),
    ];
    const reviewHistory = [
      makeGateReviewResult({ aggregate_score: 70, threshold: 85 }),
    ];
    const state = makeIterationState({ current_iteration: 1 });
    const versions = [makeDocumentVersion('v1', 'content')];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      findings,
      'max_iterations_exhausted',
      versions,
      null,
      []
    );

    expect(pkg.unresolved_findings).toHaveLength(3);
    expect(pkg.unresolved_findings.map((f) => f.id)).toEqual(['f1', 'f3', 'f5']);
  });

  // -----------------------------------------------------------------------
  // Test 12: Recurred findings filtered
  // -----------------------------------------------------------------------
  test('Recurred findings: 2 recurred findings', async () => {
    const findings = [
      makeMergedFinding({ id: 'f1', resolution_status: 'open' }),
      makeMergedFinding({ id: 'f2', resolution_status: 'recurred' }),
      makeMergedFinding({ id: 'f3', resolution_status: 'resolved' }),
      makeMergedFinding({ id: 'f4', resolution_status: 'recurred' }),
    ];
    const reviewHistory = [
      makeGateReviewResult({ aggregate_score: 70, threshold: 85 }),
    ];
    const state = makeIterationState({ current_iteration: 1 });
    const versions = [makeDocumentVersion('v1', 'content')];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      findings,
      'max_iterations_exhausted',
      versions,
      null,
      []
    );

    expect(pkg.recurred_findings).toHaveLength(2);
    expect(pkg.recurred_findings.map((f) => f.id)).toEqual(['f2', 'f4']);
  });

  // -----------------------------------------------------------------------
  // Test 13: Parent document summary included
  // -----------------------------------------------------------------------
  test('Parent document summary included in package', async () => {
    const parentDoc: DocumentSummary = {
      document_id: 'PRD-000',
      document_type: 'PRD',
      title: 'Parent PRD',
      summary: 'This is the parent document summary with executive overview.',
    };
    const traceLinks: TraceLink[] = [
      { parent_document_id: 'PRD-000', parent_section_id: 'goals', child_section_id: 'architecture' },
    ];
    const reviewHistory = [
      makeGateReviewResult({ aggregate_score: 90, threshold: 85 }),
    ];
    const state = makeIterationState({ current_iteration: 1 });
    const versions = [makeDocumentVersion('v1', 'content')];

    const pkg = await gateway.assemblePackage(
      state,
      reviewHistory,
      [],
      'trust_level_requirement',
      versions,
      parentDoc,
      traceLinks
    );

    expect(pkg.parent_document).not.toBeNull();
    expect(pkg.parent_document!.document_id).toBe('PRD-000');
    expect(pkg.parent_document!.title).toBe('Parent PRD');
    expect(pkg.parent_document!.summary).toContain('executive overview');
    expect(pkg.traceability_context).toHaveLength(1);
    expect(pkg.traceability_context[0].parent_document_id).toBe('PRD-000');
  });
});

// ---------------------------------------------------------------------------
// computeRecommendedAction unit tests
// ---------------------------------------------------------------------------

describe('computeRecommendedAction', () => {
  test('approve_override when within 3 points and no critical', () => {
    const reviews = [makeGateReviewResult({ aggregate_score: 83, stagnation_warning: false })];
    const findings: MergedFinding[] = [];
    const result = computeRecommendedAction(reviews, findings, 85);
    expect(result.action).toBe('approve_override');
  });

  test('reject_and_restart when critical findings override proximity', () => {
    const reviews = [makeGateReviewResult({ aggregate_score: 84, stagnation_warning: false })];
    const findings = [makeMergedFinding({ severity: 'critical' })];
    const result = computeRecommendedAction(reviews, findings, 85);
    expect(result.action).toBe('reject_and_restart');
  });

  test('manual_revision as default', () => {
    const reviews = [makeGateReviewResult({ aggregate_score: 70, stagnation_warning: false })];
    const findings: MergedFinding[] = [];
    const result = computeRecommendedAction(reviews, findings, 85);
    expect(result.action).toBe('manual_revision');
  });
});
