import {
  type DocumentType,
  type TrustLevel,
  type FindingSeverity,
  type CriticalSub,
  type Finding,
  type CalibrationExamples,
  type RubricCategory,
  type Rubric,
  type SectionScore,
  type CategoryScore,
  type ReviewOutput,
  type CategoryAggregate,
  type MergedFinding,
  type Disagreement,
  type QualityRegression,
  type GateReviewResult,
  type ReviewGateRecord,
  type PersistedRubric,
  isDocumentType,
  isTrustLevel,
  isFindingSeverity,
  isCriticalSub,
  DOCUMENT_TYPES,
  TRUST_LEVELS,
  FINDING_SEVERITIES,
  CRITICAL_SUBS,
} from '../../src/review-gate/types';

describe('Type Guards', () => {
  // --- DocumentType ---

  test('isDocumentType accepts all valid values', () => {
    for (const dt of DOCUMENT_TYPES) {
      expect(isDocumentType(dt)).toBe(true);
    }
  });

  test('isDocumentType rejects invalid values', () => {
    expect(isDocumentType('Invalid')).toBe(false);
    expect(isDocumentType('')).toBe(false);
    expect(isDocumentType(null)).toBe(false);
    expect(isDocumentType(undefined)).toBe(false);
    expect(isDocumentType(42)).toBe(false);
    expect(isDocumentType('prd')).toBe(false); // case-sensitive
    expect(isDocumentType('PLAN')).toBe(false); // spec uses "Plan" not "PLAN"
  });

  // --- TrustLevel ---

  test('isTrustLevel accepts all valid values', () => {
    for (const tl of TRUST_LEVELS) {
      expect(isTrustLevel(tl)).toBe(true);
    }
  });

  test('isTrustLevel rejects invalid values', () => {
    expect(isTrustLevel('auto')).toBe(false);
    expect(isTrustLevel('')).toBe(false);
    expect(isTrustLevel(null)).toBe(false);
    expect(isTrustLevel(123)).toBe(false);
  });

  // --- FindingSeverity ---

  test('isFindingSeverity accepts all valid values', () => {
    for (const fs of FINDING_SEVERITIES) {
      expect(isFindingSeverity(fs)).toBe(true);
    }
  });

  test('isFindingSeverity rejects invalid values', () => {
    expect(isFindingSeverity('high')).toBe(false);
    expect(isFindingSeverity('Critical')).toBe(false); // case-sensitive
    expect(isFindingSeverity('')).toBe(false);
    expect(isFindingSeverity(null)).toBe(false);
  });

  // --- CriticalSub ---

  test('isCriticalSub accepts all valid values', () => {
    for (const cs of CRITICAL_SUBS) {
      expect(isCriticalSub(cs)).toBe(true);
    }
  });

  test('isCriticalSub rejects invalid values', () => {
    expect(isCriticalSub('block')).toBe(false);
    expect(isCriticalSub('')).toBe(false);
    expect(isCriticalSub(null)).toBe(false);
  });
});

describe('Finding construction', () => {
  test('Finding object can be created with all required fields', () => {
    const finding: Finding = {
      id: 'f-001',
      section_id: 'sec-1',
      category_id: 'problem_clarity',
      severity: 'major',
      critical_sub: null,
      upstream_defect: false,
      description: 'Problem statement is vague',
      evidence: 'Section 1.1 says "make it better"',
      suggested_resolution: 'Add quantified metrics and user research data',
    };

    expect(finding.id).toBe('f-001');
    expect(finding.severity).toBe('major');
    expect(finding.critical_sub).toBeNull();
    expect(finding.upstream_defect).toBe(false);
  });

  test('Finding with critical severity and critical_sub', () => {
    const finding: Finding = {
      id: 'f-002',
      section_id: 'sec-2',
      category_id: 'requirements_completeness',
      severity: 'critical',
      critical_sub: 'blocking',
      upstream_defect: true,
      description: 'Requirements section is empty',
      evidence: 'Section 3 has no content',
      suggested_resolution: 'Populate all requirements',
    };

    expect(finding.severity).toBe('critical');
    expect(finding.critical_sub).toBe('blocking');
    expect(finding.upstream_defect).toBe(true);
  });

  test('Finding severity is constrained to FindingSeverity type', () => {
    // Runtime check: the type guard should reject invalid severities
    expect(isFindingSeverity('critical')).toBe(true);
    expect(isFindingSeverity('major')).toBe(true);
    expect(isFindingSeverity('minor')).toBe(true);
    expect(isFindingSeverity('suggestion')).toBe(true);
    expect(isFindingSeverity('invalid')).toBe(false);
  });
});

describe('Interface structural checks', () => {
  test('ReviewOutput can be constructed with all fields', () => {
    const output: ReviewOutput = {
      reviewer_id: 'r-001',
      reviewer_role: 'architect',
      document_id: 'doc-001',
      document_version: '1.0.0',
      timestamp: '2026-04-08T12:00:00Z',
      scoring_mode: 'per_section',
      category_scores: [
        {
          category_id: 'problem_clarity',
          score: 85,
          section_scores: [{ section_id: 'sec-1', score: 85 }],
          justification: 'Well-defined problem statement.',
        },
      ],
      findings: [],
      summary: 'Good document overall.',
    };

    expect(output.reviewer_id).toBe('r-001');
    expect(output.scoring_mode).toBe('per_section');
    expect(output.category_scores).toHaveLength(1);
    expect(output.category_scores[0].score).toBe(85);
  });

  test('GateReviewResult can be constructed with all fields', () => {
    const result: GateReviewResult = {
      gate_id: 'gate-001',
      document_id: 'doc-001',
      document_version: '1.0.0',
      iteration: 1,
      outcome: 'approved',
      aggregate_score: 90,
      threshold: 85,
      aggregation_method: 'mean',
      category_aggregates: [],
      findings: [],
      disagreements: [],
      quality_regression: null,
      stagnation_warning: false,
      summary: 'Document approved.',
    };

    expect(result.outcome).toBe('approved');
    expect(result.aggregate_score).toBe(90);
    expect(result.quality_regression).toBeNull();
  });

  test('ReviewGateRecord can be constructed with all fields', () => {
    const record: ReviewGateRecord = {
      gate_id: 'gate-001',
      document_id: 'doc-001',
      document_type: 'PRD',
      document_version: '1.0.0',
      pipeline_id: 'pipe-001',
      iteration: 1,
      max_iterations: 3,
      rubric_version: '1.0.0',
      threshold: 85,
      aggregation_method: 'mean',
      panel_size: 2,
      trust_level: 'full_auto',
      reviewer_outputs: [],
      aggregate_score: 90,
      category_aggregates: [],
      outcome: 'approved',
      merged_findings: [],
      disagreements: [],
      quality_regression: null,
      stagnation_warning: false,
      human_escalation: false,
      started_at: '2026-04-08T12:00:00Z',
      completed_at: '2026-04-08T12:05:00Z',
      created_by: 'system',
    };

    expect(record.document_type).toBe('PRD');
    expect(record.trust_level).toBe('full_auto');
    expect(record.human_escalation).toBe(false);
  });

  test('PersistedRubric can be constructed with all fields', () => {
    const persisted: PersistedRubric = {
      document_type: 'PRD',
      version: '1.0.0',
      approval_threshold: 85,
      categories: [
        {
          id: 'problem_clarity',
          name: 'Problem Clarity',
          weight: 15,
          description: 'Problem statement quality.',
          min_threshold: 60,
          section_mapping: ['sec-1', 'sec-2'],
          calibration: {
            score_0: 'No problem statement.',
            score_50: 'Vague problem.',
            score_100: 'Precise problem.',
          },
        },
      ],
      metadata: {
        created_at: '2026-04-08T12:00:00Z',
        updated_at: '2026-04-08T12:00:00Z',
        updated_by: 'system',
      },
    };

    expect(persisted.document_type).toBe('PRD');
    expect(persisted.categories[0].section_mapping).toEqual(['sec-1', 'sec-2']);
    expect(persisted.metadata.updated_by).toBe('system');
  });
});
