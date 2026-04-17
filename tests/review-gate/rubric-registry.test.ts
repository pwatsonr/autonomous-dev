import {
  RubricRegistry,
  rubricRegistry,
  RubricNotFoundError,
  RubricValidationError,
} from '../../src/review-gate/rubric-registry';
import type { DocumentType, Rubric, RubricCategory, CalibrationExamples } from '../../src/review-gate/types';
import { PRD_RUBRIC } from '../../src/review-gate/rubrics/prd-rubric';
import { TDD_RUBRIC } from '../../src/review-gate/rubrics/tdd-rubric';
import { PLAN_RUBRIC } from '../../src/review-gate/rubrics/plan-rubric';
import { SPEC_RUBRIC } from '../../src/review-gate/rubrics/spec-rubric';
import { CODE_RUBRIC } from '../../src/review-gate/rubrics/code-rubric';

// ---------------------------------------------------------------------------
// Helper: build a valid rubric for testing
// ---------------------------------------------------------------------------

function makeCalibration(prefix: string = 'test'): CalibrationExamples {
  return {
    score_0: `${prefix}: score 0 example`,
    score_50: `${prefix}: score 50 example`,
    score_100: `${prefix}: score 100 example`,
  };
}

function makeCategory(overrides: Partial<RubricCategory> = {}): RubricCategory {
  return {
    id: 'test_cat',
    name: 'Test Category',
    weight: 100,
    description: 'A test category.',
    min_threshold: 60,
    calibration: makeCalibration(),
    ...overrides,
  };
}

function makeRubric(overrides: Partial<Rubric> = {}, categories?: RubricCategory[]): Rubric {
  return {
    document_type: 'PRD',
    version: '1.0.0',
    approval_threshold: 85,
    total_weight: 100,
    categories: categories ?? [makeCategory()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RubricRegistry', () => {
  let registry: RubricRegistry;

  beforeEach(() => {
    registry = new RubricRegistry();
  });

  // --- Test 1: Retrieve PRD rubric ---
  test('getRubric("PRD") returns 7 categories, threshold 85, weights sum to 100', () => {
    const rubric = registry.getRubric('PRD');
    expect(rubric.categories).toHaveLength(7);
    expect(rubric.approval_threshold).toBe(85);
    const weightSum = rubric.categories.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(weightSum - 100)).toBeLessThanOrEqual(0.01);
  });

  // --- Test 2: Retrieve TDD rubric ---
  test('getRubric("TDD") returns 7 categories, threshold 85, weights sum to 100', () => {
    const rubric = registry.getRubric('TDD');
    expect(rubric.categories).toHaveLength(7);
    expect(rubric.approval_threshold).toBe(85);
    const weightSum = rubric.categories.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(weightSum - 100)).toBeLessThanOrEqual(0.01);
  });

  // --- Test 3: Retrieve Plan rubric ---
  test('getRubric("Plan") returns 6 categories, threshold 80, weights sum to 100', () => {
    const rubric = registry.getRubric('Plan');
    expect(rubric.categories).toHaveLength(6);
    expect(rubric.approval_threshold).toBe(80);
    const weightSum = rubric.categories.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(weightSum - 100)).toBeLessThanOrEqual(0.01);
  });

  // --- Test 4: Retrieve Spec rubric ---
  test('getRubric("Spec") returns 6 categories, threshold 80, weights sum to 100', () => {
    const rubric = registry.getRubric('Spec');
    expect(rubric.categories).toHaveLength(6);
    expect(rubric.approval_threshold).toBe(80);
    const weightSum = rubric.categories.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(weightSum - 100)).toBeLessThanOrEqual(0.01);
  });

  // --- Test 5: Retrieve Code rubric ---
  test('getRubric("Code") returns 7 categories, threshold 85, weights sum to 100', () => {
    const rubric = registry.getRubric('Code');
    expect(rubric.categories).toHaveLength(7);
    expect(rubric.approval_threshold).toBe(85);
    const weightSum = rubric.categories.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(weightSum - 100)).toBeLessThanOrEqual(0.01);
  });

  // --- Test 6: Reject invalid document type ---
  test('getRubric throws RubricNotFoundError for invalid document type', () => {
    expect(() => registry.getRubric('Invalid' as DocumentType)).toThrow(RubricNotFoundError);
    expect(() => registry.getRubric('Invalid' as DocumentType)).toThrow(
      'No rubric registered for document type: Invalid'
    );
  });

  // --- Test 7: Reject weights not summing to 100 ---
  test('validateRubric rejects rubric with weights summing to 99', () => {
    const rubric = makeRubric({}, [
      makeCategory({ id: 'a', weight: 49 }),
      makeCategory({ id: 'b', weight: 50 }),
    ]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('weight') || e.includes('sum'))).toBe(true);
  });

  // --- Test 8: Accept weights summing to 100.005 (within tolerance) ---
  test('validateRubric accepts rubric with weights summing to 100.005', () => {
    const rubric = makeRubric({}, [
      makeCategory({ id: 'a', weight: 50.005 }),
      makeCategory({ id: 'b', weight: 50 }),
    ]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // --- Test 9: Reject weights summing to 100.02 (outside tolerance) ---
  test('validateRubric rejects rubric with weights summing to 100.02', () => {
    const rubric = makeRubric({}, [
      makeCategory({ id: 'a', weight: 50.02 }),
      makeCategory({ id: 'b', weight: 50 }),
    ]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('weight') || e.includes('sum'))).toBe(true);
  });

  // --- Test 10: Reject missing category name ---
  test('validateRubric rejects rubric with empty category name', () => {
    const rubric = makeRubric({}, [makeCategory({ name: '' })]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  // --- Test 11: Reject missing calibration ---
  test('validateRubric rejects rubric with empty calibration.score_0', () => {
    const rubric = makeRubric({}, [
      makeCategory({
        calibration: { score_0: '', score_50: 'x', score_100: 'x' },
      }),
    ]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('calibration.score_0'))).toBe(true);
  });

  // --- Test 12: Reject duplicate category IDs ---
  test('validateRubric rejects rubric with duplicate category IDs', () => {
    const rubric = makeRubric({}, [
      makeCategory({ id: 'dup', weight: 50 }),
      makeCategory({ id: 'dup', weight: 50 }),
    ]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });

  // --- Test 13: Override rubric ---
  test('registerRubric overrides existing rubric for same document type', () => {
    const customCategories: RubricCategory[] = [
      makeCategory({ id: 'custom_a', weight: 60, name: 'Custom A' }),
      makeCategory({ id: 'custom_b', weight: 40, name: 'Custom B' }),
    ];
    const customRubric = makeRubric(
      { document_type: 'PRD', version: '2.0.0', approval_threshold: 90 },
      customCategories
    );

    registry.registerRubric(customRubric);
    const retrieved = registry.getRubric('PRD');

    expect(retrieved.version).toBe('2.0.0');
    expect(retrieved.approval_threshold).toBe(90);
    expect(retrieved.categories).toHaveLength(2);
    expect(retrieved.categories[0].id).toBe('custom_a');
    expect(retrieved.categories[1].id).toBe('custom_b');
  });

  // --- Test 14: Returned rubric is frozen ---
  test('getRubric returns a frozen object that cannot be mutated', () => {
    const rubric = registry.getRubric('PRD');

    // Attempting to mutate a property on a frozen object should throw in strict mode
    // or silently fail. We test both scenarios.
    expect(() => {
      (rubric as any).approval_threshold = 999;
    }).toThrow();

    expect(() => {
      (rubric.categories[0] as any).weight = 999;
    }).toThrow();

    // Verify the original is unchanged
    const rubric2 = registry.getRubric('PRD');
    expect(rubric2.approval_threshold).toBe(85);
    expect(rubric2.categories[0].weight).toBe(15);
  });

  // --- Test 15: All hardcoded rubrics pass validation ---
  test('all 5 hardcoded rubrics pass validateRubric', () => {
    const types: DocumentType[] = ['PRD', 'TDD', 'Plan', 'Spec', 'Code'];
    for (const type of types) {
      const rubric = registry.getRubric(type);
      // Need to unfreeze for validation since we pass the rubric object
      const unfrozen = JSON.parse(JSON.stringify(rubric)) as Rubric;
      const result = registry.validateRubric(unfrozen);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  // --- Additional validation edge cases ---

  test('validateRubric rejects empty categories array', () => {
    const rubric = makeRubric({ categories: [] });
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('non-empty'))).toBe(true);
  });

  test('validateRubric rejects invalid document_type', () => {
    const rubric = makeRubric({ document_type: 'INVALID' as DocumentType });
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('document_type'))).toBe(true);
  });

  test('validateRubric rejects empty version', () => {
    const rubric = makeRubric({ version: '' });
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('version'))).toBe(true);
  });

  test('validateRubric rejects approval_threshold out of range', () => {
    const rubric = makeRubric({ approval_threshold: 101 });
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('approval_threshold'))).toBe(true);
  });

  test('validateRubric rejects negative approval_threshold', () => {
    const rubric = makeRubric({ approval_threshold: -1 });
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('approval_threshold'))).toBe(true);
  });

  test('validateRubric rejects empty category id', () => {
    const rubric = makeRubric({}, [makeCategory({ id: '' })]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('id'))).toBe(true);
  });

  test('validateRubric rejects empty category description', () => {
    const rubric = makeRubric({}, [makeCategory({ description: '' })]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('description'))).toBe(true);
  });

  test('validateRubric rejects weight <= 0', () => {
    const rubric = makeRubric({}, [makeCategory({ weight: 0 })]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('weight'))).toBe(true);
  });

  test('validateRubric rejects min_threshold out of range', () => {
    const rubric = makeRubric({}, [makeCategory({ min_threshold: 101 })]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('min_threshold'))).toBe(true);
  });

  test('validateRubric accepts min_threshold of null', () => {
    const rubric = makeRubric({}, [makeCategory({ min_threshold: null })]);
    const result = registry.validateRubric(rubric);
    expect(result.valid).toBe(true);
  });

  test('registerRubric throws RubricValidationError for invalid rubric', () => {
    const badRubric = makeRubric({ version: '' });
    expect(() => registry.registerRubric(badRubric)).toThrow(RubricValidationError);
  });

  test('listDocumentTypes returns all 5 types', () => {
    const types = registry.listDocumentTypes();
    expect(types).toHaveLength(5);
    expect(types).toContain('PRD');
    expect(types).toContain('TDD');
    expect(types).toContain('Plan');
    expect(types).toContain('Spec');
    expect(types).toContain('Code');
  });

  test('singleton rubricRegistry is an instance of RubricRegistry', () => {
    expect(rubricRegistry).toBeInstanceOf(RubricRegistry);
  });

  test('constructor accepts overrides map', () => {
    const customCategories: RubricCategory[] = [
      makeCategory({ id: 'override_cat', weight: 100, name: 'Override' }),
    ];
    const override = makeRubric(
      { document_type: 'PRD', version: '3.0.0' },
      customCategories
    );
    const overrides = new Map<DocumentType, Rubric>([['PRD', override]]);
    const customRegistry = new RubricRegistry(overrides);

    const retrieved = customRegistry.getRubric('PRD');
    expect(retrieved.version).toBe('3.0.0');
    expect(retrieved.categories).toHaveLength(1);
    expect(retrieved.categories[0].id).toBe('override_cat');

    // Other types still use defaults
    const tdd = customRegistry.getRubric('TDD');
    expect(tdd.categories).toHaveLength(7);
  });
});

describe('Hardcoded Rubric Content', () => {
  const registry = new RubricRegistry();

  // --- PRD rubric category IDs ---
  test('PRD rubric has the correct category IDs', () => {
    const rubric = registry.getRubric('PRD');
    const ids = rubric.categories.map((c) => c.id);
    expect(ids).toEqual([
      'problem_clarity',
      'goals_measurability',
      'user_story_coverage',
      'requirements_completeness',
      'requirements_testability',
      'risk_identification',
      'internal_consistency',
    ]);
  });

  // --- PRD category weights ---
  test('PRD rubric has correct weights', () => {
    const rubric = registry.getRubric('PRD');
    const weights: Record<string, number> = {};
    for (const c of rubric.categories) {
      weights[c.id] = c.weight;
    }
    expect(weights['problem_clarity']).toBe(15);
    expect(weights['goals_measurability']).toBe(15);
    expect(weights['user_story_coverage']).toBe(15);
    expect(weights['requirements_completeness']).toBe(20);
    expect(weights['requirements_testability']).toBe(15);
    expect(weights['risk_identification']).toBe(10);
    expect(weights['internal_consistency']).toBe(10);
  });

  // --- PRD min_thresholds ---
  test('PRD rubric has correct min_thresholds', () => {
    const rubric = registry.getRubric('PRD');
    const thresholds: Record<string, number | null> = {};
    for (const c of rubric.categories) {
      thresholds[c.id] = c.min_threshold;
    }
    expect(thresholds['problem_clarity']).toBe(60);
    expect(thresholds['goals_measurability']).toBe(60);
    expect(thresholds['user_story_coverage']).toBe(60);
    expect(thresholds['requirements_completeness']).toBe(70);
    expect(thresholds['requirements_testability']).toBe(60);
    expect(thresholds['risk_identification']).toBe(50);
    expect(thresholds['internal_consistency']).toBe(50);
  });

  // --- TDD rubric category IDs ---
  test('TDD rubric has the correct category IDs', () => {
    const rubric = registry.getRubric('TDD');
    const ids = rubric.categories.map((c) => c.id);
    expect(ids).toEqual([
      'architecture_soundness',
      'tradeoff_rigor',
      'data_model_integrity',
      'api_contract_completeness',
      'integration_robustness',
      'security_depth',
      'prd_alignment',
    ]);
  });

  // --- TDD category weights ---
  test('TDD rubric has correct weights', () => {
    const rubric = registry.getRubric('TDD');
    const weights: Record<string, number> = {};
    for (const c of rubric.categories) {
      weights[c.id] = c.weight;
    }
    expect(weights['architecture_soundness']).toBe(20);
    expect(weights['tradeoff_rigor']).toBe(15);
    expect(weights['data_model_integrity']).toBe(15);
    expect(weights['api_contract_completeness']).toBe(15);
    expect(weights['integration_robustness']).toBe(10);
    expect(weights['security_depth']).toBe(10);
    expect(weights['prd_alignment']).toBe(15);
  });

  // --- TDD min_thresholds ---
  test('TDD rubric has correct min_thresholds', () => {
    const rubric = registry.getRubric('TDD');
    const thresholds: Record<string, number | null> = {};
    for (const c of rubric.categories) {
      thresholds[c.id] = c.min_threshold;
    }
    expect(thresholds['architecture_soundness']).toBe(70);
    expect(thresholds['tradeoff_rigor']).toBe(60);
    expect(thresholds['data_model_integrity']).toBe(60);
    expect(thresholds['api_contract_completeness']).toBe(60);
    expect(thresholds['integration_robustness']).toBe(50);
    expect(thresholds['security_depth']).toBe(50);
    expect(thresholds['prd_alignment']).toBe(70);
  });

  // --- Plan rubric category IDs ---
  test('Plan rubric has the correct category IDs', () => {
    const rubric = registry.getRubric('Plan');
    const ids = rubric.categories.map((c) => c.id);
    expect(ids).toEqual([
      'work_unit_granularity',
      'dependency_accuracy',
      'test_strategy_coverage',
      'effort_estimation',
      'tdd_alignment',
      'risk_awareness',
    ]);
  });

  // --- Plan category weights ---
  test('Plan rubric has correct weights', () => {
    const rubric = registry.getRubric('Plan');
    const weights: Record<string, number> = {};
    for (const c of rubric.categories) {
      weights[c.id] = c.weight;
    }
    expect(weights['work_unit_granularity']).toBe(20);
    expect(weights['dependency_accuracy']).toBe(20);
    expect(weights['test_strategy_coverage']).toBe(15);
    expect(weights['effort_estimation']).toBe(15);
    expect(weights['tdd_alignment']).toBe(15);
    expect(weights['risk_awareness']).toBe(15);
  });

  // --- Plan min_thresholds ---
  test('Plan rubric has correct min_thresholds', () => {
    const rubric = registry.getRubric('Plan');
    const thresholds: Record<string, number | null> = {};
    for (const c of rubric.categories) {
      thresholds[c.id] = c.min_threshold;
    }
    expect(thresholds['work_unit_granularity']).toBe(60);
    expect(thresholds['dependency_accuracy']).toBe(70);
    expect(thresholds['test_strategy_coverage']).toBe(60);
    expect(thresholds['effort_estimation']).toBe(50);
    expect(thresholds['tdd_alignment']).toBe(70);
    expect(thresholds['risk_awareness']).toBe(50);
  });

  // --- Spec rubric category IDs ---
  test('Spec rubric has the correct category IDs', () => {
    const rubric = registry.getRubric('Spec');
    const ids = rubric.categories.map((c) => c.id);
    expect(ids).toEqual([
      'acceptance_criteria_precision',
      'file_path_accuracy',
      'test_case_coverage',
      'code_pattern_clarity',
      'plan_alignment',
      'dependency_completeness',
    ]);
  });

  // --- Spec category weights ---
  test('Spec rubric has correct weights', () => {
    const rubric = registry.getRubric('Spec');
    const weights: Record<string, number> = {};
    for (const c of rubric.categories) {
      weights[c.id] = c.weight;
    }
    expect(weights['acceptance_criteria_precision']).toBe(25);
    expect(weights['file_path_accuracy']).toBe(15);
    expect(weights['test_case_coverage']).toBe(20);
    expect(weights['code_pattern_clarity']).toBe(15);
    expect(weights['plan_alignment']).toBe(15);
    expect(weights['dependency_completeness']).toBe(10);
  });

  // --- Spec min_thresholds ---
  test('Spec rubric has correct min_thresholds', () => {
    const rubric = registry.getRubric('Spec');
    const thresholds: Record<string, number | null> = {};
    for (const c of rubric.categories) {
      thresholds[c.id] = c.min_threshold;
    }
    expect(thresholds['acceptance_criteria_precision']).toBe(70);
    expect(thresholds['file_path_accuracy']).toBe(60);
    expect(thresholds['test_case_coverage']).toBe(60);
    expect(thresholds['code_pattern_clarity']).toBe(50);
    expect(thresholds['plan_alignment']).toBe(70);
    expect(thresholds['dependency_completeness']).toBe(50);
  });

  // --- Code rubric category IDs ---
  test('Code rubric has the correct category IDs', () => {
    const rubric = registry.getRubric('Code');
    const ids = rubric.categories.map((c) => c.id);
    expect(ids).toEqual([
      'spec_compliance',
      'test_coverage',
      'code_quality',
      'documentation_completeness',
      'performance',
      'security',
      'maintainability',
    ]);
  });

  // --- Code category weights ---
  test('Code rubric has correct weights', () => {
    const rubric = registry.getRubric('Code');
    const weights: Record<string, number> = {};
    for (const c of rubric.categories) {
      weights[c.id] = c.weight;
    }
    expect(weights['spec_compliance']).toBe(25);
    expect(weights['test_coverage']).toBe(20);
    expect(weights['code_quality']).toBe(15);
    expect(weights['documentation_completeness']).toBe(10);
    expect(weights['performance']).toBe(10);
    expect(weights['security']).toBe(10);
    expect(weights['maintainability']).toBe(10);
  });

  // --- Code min_thresholds ---
  test('Code rubric has correct min_thresholds', () => {
    const rubric = registry.getRubric('Code');
    const thresholds: Record<string, number | null> = {};
    for (const c of rubric.categories) {
      thresholds[c.id] = c.min_threshold;
    }
    expect(thresholds['spec_compliance']).toBe(80);
    expect(thresholds['test_coverage']).toBe(70);
    expect(thresholds['code_quality']).toBe(60);
    expect(thresholds['documentation_completeness']).toBe(50);
    expect(thresholds['performance']).toBe(50);
    expect(thresholds['security']).toBe(60);
    expect(thresholds['maintainability']).toBe(50);
  });

  // --- All hardcoded rubrics have calibration examples ---
  test('every category in every hardcoded rubric has non-empty calibration examples', () => {
    const types: DocumentType[] = ['PRD', 'TDD', 'Plan', 'Spec', 'Code'];
    for (const type of types) {
      const rubric = registry.getRubric(type);
      for (const category of rubric.categories) {
        expect(category.calibration.score_0.length).toBeGreaterThan(0);
        expect(category.calibration.score_50.length).toBeGreaterThan(0);
        expect(category.calibration.score_100.length).toBeGreaterThan(0);
      }
    }
  });
});
