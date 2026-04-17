import { PRD_RUBRIC } from '../../../../src/pipeline/registry/rubrics/prd-rubric';
import { TDD_RUBRIC } from '../../../../src/pipeline/registry/rubrics/tdd-rubric';
import { PLAN_RUBRIC } from '../../../../src/pipeline/registry/rubrics/plan-rubric';
import { SPEC_RUBRIC } from '../../../../src/pipeline/registry/rubrics/spec-rubric';
import { CODE_RUBRIC } from '../../../../src/pipeline/registry/rubrics/code-rubric';
import type { QualityRubric } from '../../../../src/pipeline/types/quality-rubric';

const ALL_RUBRICS: QualityRubric[] = [PRD_RUBRIC, TDD_RUBRIC, PLAN_RUBRIC, SPEC_RUBRIC, CODE_RUBRIC];

describe('Per-Type Rubric Definitions', () => {
  // --- Category count checks ---

  test('PRD rubric has 7 categories', () => {
    expect(PRD_RUBRIC.categories).toHaveLength(7);
  });

  test('TDD rubric has 7 categories', () => {
    expect(TDD_RUBRIC.categories).toHaveLength(7);
  });

  test('Plan rubric has 6 categories', () => {
    expect(PLAN_RUBRIC.categories).toHaveLength(6);
  });

  test('Spec rubric has 6 categories', () => {
    expect(SPEC_RUBRIC.categories).toHaveLength(6);
  });

  test('Code rubric has 7 categories', () => {
    expect(CODE_RUBRIC.categories).toHaveLength(7);
  });

  // --- Weight sum checks ---

  test('PRD rubric weights sum to 1.0', () => {
    const sum = PRD_RUBRIC.categories.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
  });

  test('TDD rubric weights sum to 1.0', () => {
    const sum = TDD_RUBRIC.categories.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
  });

  test('Plan rubric weights sum to 1.0', () => {
    const sum = PLAN_RUBRIC.categories.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
  });

  test('Spec rubric weights sum to 1.0', () => {
    const sum = SPEC_RUBRIC.categories.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
  });

  test('Code rubric weights sum to 1.0', () => {
    const sum = CODE_RUBRIC.categories.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
  });

  // --- Scoring guide checks ---

  test('All rubric categories have non-empty scoring guides', () => {
    for (const rubric of ALL_RUBRICS) {
      for (const category of rubric.categories) {
        expect(category.scoringGuide.length).toBeGreaterThan(0);
      }
    }
  });

  test('All scoring guides cover the full 0-100 range', () => {
    for (const rubric of ALL_RUBRICS) {
      for (const category of rubric.categories) {
        const guide = category.scoringGuide;

        // Sort by min to ensure ordered evaluation
        const sorted = [...guide].sort((a, b) => a.min - b.min);

        // First entry must start at 0
        expect(sorted[0].min).toBe(0);

        // Last entry must end at 100
        expect(sorted[sorted.length - 1].max).toBe(100);

        // No gaps between ranges
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].min).toBe(sorted[i - 1].max + 1);
        }
      }
    }
  });

  // --- Minimum score checks ---

  test('All minimumScore values are between 0 and 100', () => {
    for (const rubric of ALL_RUBRICS) {
      for (const category of rubric.categories) {
        expect(category.minimumScore).toBeGreaterThanOrEqual(0);
        expect(category.minimumScore).toBeLessThanOrEqual(100);
      }
    }
  });

  // --- Aggregation method check ---

  test('PRD rubric uses mean aggregation', () => {
    expect(PRD_RUBRIC.aggregationMethod).toBe('mean');
  });

  // --- Self-consistency validation ---

  test('Self-consistency: all rubrics have unique category IDs and weights summing to 1.0', () => {
    for (const rubric of ALL_RUBRICS) {
      const sum = rubric.categories.reduce((s, c) => s + c.weight, 0);
      expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);

      const ids = rubric.categories.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicate IDs
    }
  });

  // --- Structural completeness ---

  test('All categories have required fields: id, name, description, weight, minimumScore, scoringGuide', () => {
    for (const rubric of ALL_RUBRICS) {
      for (const category of rubric.categories) {
        expect(typeof category.id).toBe('string');
        expect(category.id.length).toBeGreaterThan(0);
        expect(typeof category.name).toBe('string');
        expect(category.name.length).toBeGreaterThan(0);
        expect(typeof category.description).toBe('string');
        expect(category.description.length).toBeGreaterThan(0);
        expect(typeof category.weight).toBe('number');
        expect(category.weight).toBeGreaterThan(0);
        expect(category.weight).toBeLessThanOrEqual(1);
        expect(typeof category.minimumScore).toBe('number');
        expect(Array.isArray(category.scoringGuide)).toBe(true);
      }
    }
  });
});
