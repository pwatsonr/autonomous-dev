import { ScopeContainmentChecker } from '../../../src/review-gate/smoke-test/scope-containment-checker';
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

/**
 * Helper to generate N child section IDs.
 * The first `mapped` IDs are included in traces_from, the rest are unmapped.
 */
function makeChildWithCreep(
  id: string,
  totalSections: number,
  mappedSections: number,
  parentId: string
): ChildDocument {
  const sectionIds = Array.from({ length: totalSections }, (_, i) => `${id}-s${i}`);
  const mappedIds = sectionIds.slice(0, mappedSections);

  return {
    id,
    sections: sectionIds.map((sid) => ({
      id: sid,
      title: `Section ${sid}`,
      content: `Content for ${sid}`,
    })),
    traces_from: mappedIds.length > 0
      ? [{ document_id: parentId, section_ids: mappedIds }]
      : [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScopeContainmentChecker', () => {
  const checker = new ScopeContainmentChecker();

  // -----------------------------------------------------------------------
  // Test 8: No scope creep
  // -----------------------------------------------------------------------
  test('No scope creep: all child sections trace to parent sections', () => {
    const parent = makeParent('p1', ['s1', 's2']);
    const children = [
      makeChild('c1', ['cs1', 'cs2'], [
        { document_id: 'p1', section_ids: ['cs1', 'cs2'] },
      ]),
    ];

    const result = checker.check(parent, children);

    expect(result.children_with_scope_creep).toHaveLength(0);
    expect(result.pass).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 9: Below threshold (10 sections, 1 unmapped = 10%)
  // -----------------------------------------------------------------------
  test('Below threshold: 10 sections, 1 unmapped, creep_percentage 10', () => {
    const parent = makeParent('p1', ['ps1']);
    const child = makeChildWithCreep('c1', 10, 9, 'p1');

    const result = checker.check(parent, [child]);

    expect(result.children_with_scope_creep).toHaveLength(1);
    expect(result.children_with_scope_creep[0].child_id).toBe('c1');
    expect(result.children_with_scope_creep[0].creep_percentage).toBe(10);
    expect(result.children_with_scope_creep[0].unmapped_sections).toHaveLength(1);
    expect(result.pass).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 10: At threshold (10 sections, 2 unmapped = 20%)
  // -----------------------------------------------------------------------
  test('At threshold: 10 sections, 2 unmapped, creep_percentage 20 -- passes (inclusive <=)', () => {
    const parent = makeParent('p1', ['ps1']);
    const child = makeChildWithCreep('c1', 10, 8, 'p1');

    const result = checker.check(parent, [child]);

    expect(result.children_with_scope_creep).toHaveLength(1);
    expect(result.children_with_scope_creep[0].creep_percentage).toBe(20);
    expect(result.pass).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 11: Above threshold (10 sections, 3 unmapped = 30%)
  // -----------------------------------------------------------------------
  test('Above threshold: 10 sections, 3 unmapped, creep_percentage 30 -- fails', () => {
    const parent = makeParent('p1', ['ps1']);
    const child = makeChildWithCreep('c1', 10, 7, 'p1');

    const result = checker.check(parent, [child]);

    expect(result.children_with_scope_creep).toHaveLength(1);
    expect(result.children_with_scope_creep[0].creep_percentage).toBe(30);
    expect(result.pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 12: Multiple children, one exceeds threshold
  // -----------------------------------------------------------------------
  test('Multiple children, one exceeds: child A 0%, child B 25% -- fails', () => {
    const parent = makeParent('p1', ['ps1']);
    const childA = makeChildWithCreep('cA', 10, 10, 'p1');
    const childB = makeChildWithCreep('cB', 4, 3, 'p1');

    const result = checker.check(parent, [childA, childB]);

    // Child A has 0% creep, should not appear in children_with_scope_creep
    // Child B has 25% creep, should appear
    expect(result.children_with_scope_creep).toHaveLength(1);
    expect(result.children_with_scope_creep[0].child_id).toBe('cB');
    expect(result.children_with_scope_creep[0].creep_percentage).toBe(25);
    expect(result.pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 13: Custom threshold (10%)
  // -----------------------------------------------------------------------
  test('Custom threshold: 10%, child with 15% creep fails', () => {
    const parent = makeParent('p1', ['ps1']);
    // 20 sections, 3 unmapped = 15%
    const child = makeChildWithCreep('c1', 20, 17, 'p1');

    const result = checker.check(parent, [child], {
      creep_threshold_percentage: 10,
    });

    expect(result.children_with_scope_creep).toHaveLength(1);
    expect(result.children_with_scope_creep[0].creep_percentage).toBe(15);
    expect(result.pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 14: Child with 0 sections
  // -----------------------------------------------------------------------
  test('Child with 0 sections: not flagged, creep_percentage effectively 0', () => {
    const parent = makeParent('p1', ['ps1']);
    const child: ChildDocument = {
      id: 'c1',
      sections: [],
      traces_from: [],
    };

    const result = checker.check(parent, [child]);

    expect(result.children_with_scope_creep).toHaveLength(0);
    expect(result.pass).toBe(true);
  });

  // -----------------------------------------------------------------------
  // SPEC-004-4-4 Test 13: Just above threshold (21% creep) -- fails
  // 100 sections, 79 mapped, 21 unmapped = 21%
  // -----------------------------------------------------------------------
  test('Just above threshold: 100 sections, 21 unmapped, creep_percentage 21 -- fails', () => {
    const parent = makeParent('p1', ['ps1']);
    const child = makeChildWithCreep('c1', 100, 79, 'p1');

    const result = checker.check(parent, [child]);

    expect(result.children_with_scope_creep).toHaveLength(1);
    expect(result.children_with_scope_creep[0].creep_percentage).toBe(21);
    expect(result.pass).toBe(false);
  });
});
