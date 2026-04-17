import { CoverageChecker } from '../../../src/review-gate/smoke-test/coverage-checker';
import { ParentDocument, ChildDocument } from '../../../src/review-gate/smoke-test/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParent(id: string, sectionIds: string[]): ParentDocument {
  return {
    id,
    sections: sectionIds.map((sid) => ({
      id: sid,
      title: `Section ${sid}`,
      content: `Content for ${sid}`,
    })),
  };
}

function makeChild(
  id: string,
  sectionIds: string[],
  tracesFrom: { document_id: string; section_ids: string[] }[]
): ChildDocument {
  return {
    id,
    sections: sectionIds.map((sid) => ({
      id: sid,
      title: `Child section ${sid}`,
      content: `Content for ${sid}`,
    })),
    traces_from: tracesFrom,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoverageChecker', () => {
  const checker = new CoverageChecker();

  // -----------------------------------------------------------------------
  // Test 1: 100% coverage
  // -----------------------------------------------------------------------
  test('100% coverage: 3 parent sections, each referenced by at least one child', () => {
    const parent = makeParent('p1', ['s1', 's2', 's3']);
    const children = [
      makeChild('c1', ['cs1'], [{ document_id: 'p1', section_ids: ['s1'] }]),
      makeChild('c2', ['cs2'], [{ document_id: 'p1', section_ids: ['s2'] }]),
      makeChild('c3', ['cs3'], [{ document_id: 'p1', section_ids: ['s3'] }]),
    ];

    const result = checker.check(parent, children);

    expect(result.coverage_percentage).toBe(100);
    expect(result.pass).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.parent_sections).toHaveLength(3);
    for (const section of result.parent_sections) {
      expect(section.coverage_type).toBe('full');
      expect(section.covered_by.length).toBeGreaterThanOrEqual(1);
    }
  });

  // -----------------------------------------------------------------------
  // Test 2: Partial coverage gap
  // -----------------------------------------------------------------------
  test('Partial coverage gap: 4 sections, 3 covered, 1 not', () => {
    const parent = makeParent('p1', ['s1', 's2', 's3', 's4']);
    const children = [
      makeChild('c1', ['cs1'], [{ document_id: 'p1', section_ids: ['s1', 's2'] }]),
      makeChild('c2', ['cs2'], [{ document_id: 'p1', section_ids: ['s3'] }]),
    ];

    const result = checker.check(parent, children);

    expect(result.coverage_percentage).toBe(75);
    expect(result.pass).toBe(false);
    expect(result.gaps).toContain('s4');
    expect(result.gaps).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Test 3: Zero coverage
  // -----------------------------------------------------------------------
  test('Zero coverage: no children reference any parent section', () => {
    const parent = makeParent('p1', ['s1', 's2', 's3']);
    const children = [
      makeChild('c1', ['cs1'], []),
      makeChild('c2', ['cs2'], []),
    ];

    const result = checker.check(parent, children);

    expect(result.coverage_percentage).toBe(0);
    expect(result.pass).toBe(false);
    expect(result.gaps).toEqual(['s1', 's2', 's3']);
  });

  // -----------------------------------------------------------------------
  // Test 4: Multiple children covering same section
  // -----------------------------------------------------------------------
  test('Multiple children covering same section: covered_by lists both', () => {
    const parent = makeParent('p1', ['s1']);
    const children = [
      makeChild('c1', ['cs1'], [{ document_id: 'p1', section_ids: ['s1'] }]),
      makeChild('c2', ['cs2'], [{ document_id: 'p1', section_ids: ['s1'] }]),
    ];

    const result = checker.check(parent, children);

    expect(result.coverage_percentage).toBe(100);
    expect(result.pass).toBe(true);
    const section = result.parent_sections.find((s) => s.section_id === 's1');
    expect(section).toBeDefined();
    expect(section!.covered_by).toEqual(expect.arrayContaining(['c1', 'c2']));
    expect(section!.covered_by).toHaveLength(2);
    expect(section!.coverage_type).toBe('full');
  });

  // -----------------------------------------------------------------------
  // Test 5: Parent with 0 sections
  // -----------------------------------------------------------------------
  test('Parent with 0 sections: passes with 100% coverage', () => {
    const parent = makeParent('p1', []);
    const children = [makeChild('c1', ['cs1'], [])];

    const result = checker.check(parent, children);

    expect(result.coverage_percentage).toBe(100);
    expect(result.pass).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.parent_sections).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Test 6: Child traces to nonexistent parent section
  // -----------------------------------------------------------------------
  test('Child traces to nonexistent parent section: warning logged, not counted', () => {
    const parent = makeParent('p1', ['s1', 's2']);
    const children = [
      makeChild('c1', ['cs1'], [
        { document_id: 'p1', section_ids: ['s1', 'nonexistent'] },
      ]),
      makeChild('c2', ['cs2'], [{ document_id: 'p1', section_ids: ['s2'] }]),
    ];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = checker.check(parent, children);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('nonexistent')
    );
    expect(result.coverage_percentage).toBe(100);
    expect(result.pass).toBe(true);
    // The nonexistent section is not in parent_sections at all
    expect(result.parent_sections).toHaveLength(2);

    warnSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Test 7: Single child covers all sections
  // -----------------------------------------------------------------------
  test('Single child covers all 5 parent sections', () => {
    const parent = makeParent('p1', ['s1', 's2', 's3', 's4', 's5']);
    const children = [
      makeChild('c1', ['cs1'], [
        { document_id: 'p1', section_ids: ['s1', 's2', 's3', 's4', 's5'] },
      ]),
    ];

    const result = checker.check(parent, children);

    expect(result.coverage_percentage).toBe(100);
    expect(result.pass).toBe(true);
    expect(result.gaps).toEqual([]);
    for (const section of result.parent_sections) {
      expect(section.covered_by).toEqual(['c1']);
      expect(section.coverage_type).toBe('full');
    }
  });

  // -----------------------------------------------------------------------
  // SPEC-004-4-4 Test 10: Full coverage matrix -- 5 parent sections, 3 children
  // -----------------------------------------------------------------------
  test('Full coverage matrix: 5 parent sections, 3 children, all sections covered', () => {
    const parent = makeParent('p1', ['s1', 's2', 's3', 's4', 's5']);
    const children = [
      makeChild('c1', ['cs1'], [
        { document_id: 'p1', section_ids: ['s1', 's2'] },
      ]),
      makeChild('c2', ['cs2'], [
        { document_id: 'p1', section_ids: ['s3', 's4'] },
      ]),
      makeChild('c3', ['cs3'], [
        { document_id: 'p1', section_ids: ['s5'] },
      ]),
    ];

    const result = checker.check(parent, children);

    expect(result.coverage_percentage).toBe(100);
    expect(result.pass).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.parent_sections).toHaveLength(5);

    // Verify the coverage matrix is complete
    const s1 = result.parent_sections.find((s) => s.section_id === 's1');
    expect(s1!.covered_by).toEqual(['c1']);
    const s3 = result.parent_sections.find((s) => s.section_id === 's3');
    expect(s3!.covered_by).toEqual(['c2']);
    const s5 = result.parent_sections.find((s) => s.section_id === 's5');
    expect(s5!.covered_by).toEqual(['c3']);
  });
});
