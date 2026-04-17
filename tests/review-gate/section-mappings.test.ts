import { DocumentType } from '../../src/pipeline/types/document-type';
import {
  getSectionMappings,
  getCategoryForSection,
  getSectionsForCategory,
  shouldUseDocumentLevelScoring,
} from '../../src/review-gate/section-mappings';

describe('Section Mappings', () => {
  // -----------------------------------------------------------------------
  // Test 1: PRD mappings completeness
  // -----------------------------------------------------------------------
  test('PRD mappings have all 7 sections mapped and all 7 categories are reachable', () => {
    const prd = getSectionMappings(DocumentType.PRD);
    expect(prd.mappings).toHaveLength(7);

    // Collect all unique category IDs
    const allCategories = new Set<string>();
    for (const mapping of prd.mappings) {
      for (const catId of mapping.category_ids) {
        allCategories.add(catId);
      }
    }

    // 7 distinct categories: problem_clarity, goals_measurability, internal_consistency,
    // user_story_coverage, requirements_completeness, requirements_testability, risk_identification
    expect(allCategories.size).toBe(7);
    expect(allCategories).toContain('problem_clarity');
    expect(allCategories).toContain('goals_measurability');
    expect(allCategories).toContain('internal_consistency');
    expect(allCategories).toContain('user_story_coverage');
    expect(allCategories).toContain('requirements_completeness');
    expect(allCategories).toContain('requirements_testability');
    expect(allCategories).toContain('risk_identification');
  });

  // -----------------------------------------------------------------------
  // Test 2: Internal consistency spans 3 sections
  // -----------------------------------------------------------------------
  test('getSectionsForCategory("PRD", "internal_consistency") returns 3 sections', () => {
    const sections = getSectionsForCategory(DocumentType.PRD, 'internal_consistency');
    expect(sections).toHaveLength(3);
    expect(sections).toContain('goals');
    expect(sections).toContain('user_stories');
    expect(sections).toContain('functional_requirements');
  });

  // -----------------------------------------------------------------------
  // Test 3: Inverse lookup for functional_requirements
  // -----------------------------------------------------------------------
  test('getCategoryForSection("PRD", "functional_requirements") returns 3 categories', () => {
    const categories = getCategoryForSection(DocumentType.PRD, 'functional_requirements');
    expect(categories).toHaveLength(3);
    expect(categories).toContain('requirements_completeness');
    expect(categories).toContain('requirements_testability');
    expect(categories).toContain('internal_consistency');
  });

  // -----------------------------------------------------------------------
  // Test 4: Document-level fallback at 499 words
  // -----------------------------------------------------------------------
  test('shouldUseDocumentLevelScoring("PRD", 499) returns true', () => {
    expect(shouldUseDocumentLevelScoring(DocumentType.PRD, 499)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 5: Per-section mode at 500 words
  // -----------------------------------------------------------------------
  test('shouldUseDocumentLevelScoring("PRD", 500) returns false', () => {
    expect(shouldUseDocumentLevelScoring(DocumentType.PRD, 500)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 6: All 5 document types have mappings
  // -----------------------------------------------------------------------
  test('All 5 document types have mappings without throwing', () => {
    for (const type of Object.values(DocumentType)) {
      expect(() => getSectionMappings(type)).not.toThrow();
      const mappings = getSectionMappings(type);
      expect(mappings.mappings.length).toBeGreaterThan(0);
      expect(mappings.document_type).toBe(type);
      expect(mappings.word_count_threshold).toBe(500);
    }
  });

  // -----------------------------------------------------------------------
  // Additional: TDD section mappings correctness
  // -----------------------------------------------------------------------
  test('TDD has 8 sections mapped', () => {
    const tdd = getSectionMappings(DocumentType.TDD);
    expect(tdd.mappings).toHaveLength(8);
  });

  test('Plan has 6 sections mapped', () => {
    const plan = getSectionMappings(DocumentType.PLAN);
    expect(plan.mappings).toHaveLength(6);
  });

  test('Spec has 6 sections mapped', () => {
    const spec = getSectionMappings(DocumentType.SPEC);
    expect(spec.mappings).toHaveLength(6);
  });

  test('Code has 6 sections mapped', () => {
    const code = getSectionMappings(DocumentType.CODE);
    expect(code.mappings).toHaveLength(6);
  });

  test('getCategoryForSection returns empty array for unknown section', () => {
    const categories = getCategoryForSection(DocumentType.PRD, 'nonexistent_section');
    expect(categories).toEqual([]);
  });

  test('getSectionsForCategory returns empty array for unknown category', () => {
    const sections = getSectionsForCategory(DocumentType.PRD, 'nonexistent_category');
    expect(sections).toEqual([]);
  });
});
