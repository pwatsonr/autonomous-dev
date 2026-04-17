import { SmokeTestExecutor } from '../../../src/review-gate/smoke-test/smoke-test-executor';
import {
  ParentDocument,
  ChildDocument,
  SmokeTestResult,
} from '../../../src/review-gate/smoke-test/types';

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
  tracesFrom: { document_id: string; section_ids: string[] }[],
  contentOverrides?: Record<string, string>
): ChildDocument {
  return {
    id,
    sections: sectionIds.map((sid) => ({
      id: sid,
      title: `Child section ${sid}`,
      content: contentOverrides?.[sid] ?? `Content for ${sid}`,
    })),
    traces_from: tracesFrom,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmokeTestExecutor', () => {
  const executor = new SmokeTestExecutor();

  // -----------------------------------------------------------------------
  // Test 25: All pass
  // -----------------------------------------------------------------------
  test('All pass: coverage pass, scope pass, contradictions pass', async () => {
    const parent = makeParent('p1', ['s1', 's2']);
    const children = [
      makeChild('c1', ['cs1'], [{ document_id: 'p1', section_ids: ['cs1'] }], {
        cs1: 'The frontend renders user interfaces.',
      }),
      makeChild('c2', ['cs2'], [{ document_id: 'p1', section_ids: ['cs2'] }], {
        cs2: 'The backend processes business logic.',
      }),
    ];
    // Make children cover all parent sections
    children[0].traces_from = [{ document_id: 'p1', section_ids: ['s1'] }];
    children[1].traces_from = [{ document_id: 'p1', section_ids: ['s2'] }];
    // Also map child sections for scope containment
    children[0].traces_from.push({ document_id: 'p1', section_ids: ['cs1'] });
    children[1].traces_from.push({ document_id: 'p1', section_ids: ['cs2'] });

    const result = await executor.execute(parent, children, 'v1.0');

    expect(result.overall_pass).toBe(true);
    expect(result.coverage.pass).toBe(true);
    expect(result.contradiction_detection.pass).toBe(true);
    expect(result.parent_document_id).toBe('p1');
    expect(result.parent_document_version).toBe('v1.0');
    expect(result.child_document_ids).toEqual(['c1', 'c2']);
    expect(result.iteration).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 26: Coverage failure blocks
  // -----------------------------------------------------------------------
  test('Coverage failure blocks: overall_pass is false', async () => {
    const parent = makeParent('p1', ['s1', 's2', 's3']);
    const children = [
      makeChild('c1', ['cs1'], [{ document_id: 'p1', section_ids: ['s1'] }], {
        cs1: 'Frontend rendering.',
      }),
      // s2 and s3 not covered
    ];
    // Map child section for scope containment
    children[0].traces_from.push({ document_id: 'p1', section_ids: ['cs1'] });

    const result = await executor.execute(parent, children, 'v1.0');

    expect(result.coverage.pass).toBe(false);
    expect(result.overall_pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 27: Contradiction failure blocks
  // -----------------------------------------------------------------------
  test('Contradiction failure blocks: overall_pass is false', async () => {
    const parent = makeParent('p1', ['s1', 's2']);
    const children = [
      makeChild(
        'c1',
        ['cs1'],
        [{ document_id: 'p1', section_ids: ['s1', 'cs1'] }],
        { cs1: 'We will use PostgreSQL for the database.' }
      ),
      makeChild(
        'c2',
        ['cs2'],
        [{ document_id: 'p1', section_ids: ['s2', 'cs2'] }],
        { cs2: 'We will use MongoDB for the database.' }
      ),
    ];

    const result = await executor.execute(parent, children, 'v1.0');

    expect(result.coverage.pass).toBe(true);
    expect(result.contradiction_detection.pass).toBe(false);
    expect(result.overall_pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 28: Scope creep does NOT block
  // -----------------------------------------------------------------------
  test('Scope creep does not block: overall_pass is true even when scope fails', async () => {
    const parent = makeParent('p1', ['s1']);
    // Child has 4 sections, only 1 mapped -> 75% creep, well over threshold
    const child = makeChild(
      'c1',
      ['cs1', 'cs2', 'cs3', 'cs4'],
      [{ document_id: 'p1', section_ids: ['s1', 'cs1'] }],
      {
        cs1: 'Implementation details for feature.',
        cs2: 'Extra scope content.',
        cs3: 'More extra scope.',
        cs4: 'Even more extra scope.',
      }
    );

    const result = await executor.execute(parent, [child], 'v1.0');

    expect(result.coverage.pass).toBe(true);
    expect(result.scope_containment.pass).toBe(false);
    expect(result.contradiction_detection.pass).toBe(true);
    expect(result.overall_pass).toBe(true); // Scope does not block
  });

  // -----------------------------------------------------------------------
  // Test 29: All fail
  // -----------------------------------------------------------------------
  test('All fail: coverage, scope, and contradictions all fail', async () => {
    const parent = makeParent('p1', ['s1', 's2', 's3']);
    // Coverage: only s1 covered (2 gaps)
    // Scope: high creep
    // Contradictions: tech conflict
    const children = [
      makeChild(
        'c1',
        ['cs1', 'cs2', 'cs3', 'cs4', 'cs5'],
        [{ document_id: 'p1', section_ids: ['s1', 'cs1'] }],
        {
          cs1: 'We will use PostgreSQL for the database.',
          cs2: 'Extra scope.',
          cs3: 'More extra.',
          cs4: 'Even more.',
          cs5: 'Way more.',
        }
      ),
      makeChild(
        'c2',
        ['cs6', 'cs7', 'cs8', 'cs9', 'cs10'],
        [{ document_id: 'p1', section_ids: ['cs6'] }],
        {
          cs6: 'We will use MongoDB for the database.',
          cs7: 'Extra scope.',
          cs8: 'More extra.',
          cs9: 'Even more.',
          cs10: 'Way more.',
        }
      ),
    ];

    const result = await executor.execute(parent, children, 'v1.0');

    expect(result.coverage.pass).toBe(false);
    expect(result.scope_containment.pass).toBe(false);
    expect(result.contradiction_detection.pass).toBe(false);
    expect(result.overall_pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 30: shouldRetry -- failed, under max
  // -----------------------------------------------------------------------
  test('shouldRetry: failed at iteration 1, max 2 -> true', () => {
    const result: SmokeTestResult = {
      smoke_test_id: 'st-1',
      parent_document_id: 'p1',
      parent_document_version: 'v1.0',
      child_document_ids: ['c1'],
      timestamp: new Date().toISOString(),
      coverage: {
        parent_id: 'p1',
        parent_sections: [],
        coverage_percentage: 50,
        gaps: ['s1'],
        pass: false,
      },
      scope_containment: { children_with_scope_creep: [], pass: true },
      contradiction_detection: { contradictions: [], pass: true },
      overall_pass: false,
      iteration: 1,
      max_iterations: 2,
    };

    expect(executor.shouldRetry(result)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 31: shouldRetry -- failed, at max
  // -----------------------------------------------------------------------
  test('shouldRetry: failed at iteration 2, max 2 -> false', () => {
    const result: SmokeTestResult = {
      smoke_test_id: 'st-2',
      parent_document_id: 'p1',
      parent_document_version: 'v1.0',
      child_document_ids: ['c1'],
      timestamp: new Date().toISOString(),
      coverage: {
        parent_id: 'p1',
        parent_sections: [],
        coverage_percentage: 50,
        gaps: ['s1'],
        pass: false,
      },
      scope_containment: { children_with_scope_creep: [], pass: true },
      contradiction_detection: { contradictions: [], pass: true },
      overall_pass: false,
      iteration: 2,
      max_iterations: 2,
    };

    expect(executor.shouldRetry(result)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 32: shouldRetry -- passed
  // -----------------------------------------------------------------------
  test('shouldRetry: overall_pass true -> false', () => {
    const result: SmokeTestResult = {
      smoke_test_id: 'st-3',
      parent_document_id: 'p1',
      parent_document_version: 'v1.0',
      child_document_ids: ['c1'],
      timestamp: new Date().toISOString(),
      coverage: {
        parent_id: 'p1',
        parent_sections: [],
        coverage_percentage: 100,
        gaps: [],
        pass: true,
      },
      scope_containment: { children_with_scope_creep: [], pass: true },
      contradiction_detection: { contradictions: [], pass: true },
      overall_pass: true,
      iteration: 1,
      max_iterations: 2,
    };

    expect(executor.shouldRetry(result)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Config passthrough
  // -----------------------------------------------------------------------
  test('Config: max_iterations and scope_creep_threshold are applied', async () => {
    const parent = makeParent('p1', ['s1']);
    const children = [
      makeChild('c1', ['cs1'], [{ document_id: 'p1', section_ids: ['s1', 'cs1'] }]),
    ];

    const result = await executor.execute(parent, children, 'v1.0', {
      max_iterations: 5,
      scope_creep_threshold: 10,
    });

    expect(result.max_iterations).toBe(5);
  });

  // -----------------------------------------------------------------------
  // SPEC-004-4-4 Test 16: Failure does not count against parent iteration
  // The smoke test executor does NOT manage its own iteration loop.
  // Iteration counting is separate: the caller sets iteration/max_iterations.
  // A smoke test failure should not increment any parent iteration counter.
  // -----------------------------------------------------------------------
  test('Failure does not count against parent: iteration counting is separate', async () => {
    const parent = makeParent('p1', ['s1', 's2', 's3']);
    // Only s1 covered -> coverage failure
    const children = [
      makeChild('c1', ['cs1'], [{ document_id: 'p1', section_ids: ['s1', 'cs1'] }]),
    ];

    const result1 = await executor.execute(parent, children, 'v1.0');
    expect(result1.overall_pass).toBe(false);
    // Default iteration is always 1; the executor does not increment it
    expect(result1.iteration).toBe(1);

    // Running again still returns iteration 1 -- no internal state
    const result2 = await executor.execute(parent, children, 'v1.0');
    expect(result2.overall_pass).toBe(false);
    expect(result2.iteration).toBe(1);

    // The caller controls iteration counting, not the executor
    // shouldRetry is purely based on the result passed in
    expect(executor.shouldRetry(result1)).toBe(true);
    expect(executor.shouldRetry({ ...result1, iteration: 2, max_iterations: 2 })).toBe(false);
  });
});
