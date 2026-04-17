import {
  ContradictionDetector,
  HeuristicContradictionStrategy,
  extractEntities,
} from '../../../src/review-gate/smoke-test/contradiction-detector';
import {
  ChildDocument,
  Contradiction,
  ContradictionDetectionStrategy,
} from '../../../src/review-gate/smoke-test/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChild(
  id: string,
  contentParts: string[]
): ChildDocument {
  return {
    id,
    sections: contentParts.map((content, i) => ({
      id: `${id}-s${i}`,
      title: `Section ${i}`,
      content,
    })),
    traces_from: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContradictionDetector', () => {
  const detector = new ContradictionDetector();

  // -----------------------------------------------------------------------
  // Test 15: No contradictions
  // -----------------------------------------------------------------------
  test('No contradictions: two children with no shared entities', async () => {
    const childA = makeChild('cA', ['The frontend uses React for rendering.']);
    const childB = makeChild('cB', ['The logging pipeline uses Fluentd for collection.']);

    const result = await detector.detect([childA, childB]);

    expect(result.pass).toBe(true);
    expect(result.contradictions).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Test 16: Clear technology conflict
  // -----------------------------------------------------------------------
  test('Clear technology conflict: PostgreSQL vs MongoDB for database', async () => {
    const childA = makeChild('cA', [
      'We will use PostgreSQL for the database layer.',
    ]);
    const childB = makeChild('cB', [
      'We will use MongoDB for the database layer.',
    ]);

    const result = await detector.detect([childA, childB]);

    expect(result.pass).toBe(false);
    const highConfidence = result.contradictions.filter((c) => c.confidence >= 0.7);
    expect(highConfidence.length).toBeGreaterThanOrEqual(1);
    expect(highConfidence[0].child_a_id).toBe('cA');
    expect(highConfidence[0].child_b_id).toBe('cB');
    expect(highConfidence[0].confidence).toBeGreaterThanOrEqual(0.7);
  });

  // -----------------------------------------------------------------------
  // Test 17: Same technology, no conflict
  // -----------------------------------------------------------------------
  test('Same technology, no conflict: both mention PostgreSQL', async () => {
    const childA = makeChild('cA', [
      'We will use PostgreSQL for the user database.',
    ]);
    const childB = makeChild('cB', [
      'We will use PostgreSQL for the order database.',
    ]);

    const result = await detector.detect([childA, childB]);

    // No technology conflict since both use the same tech for the same category
    const highConfidence = result.contradictions.filter((c) => c.confidence >= 0.7);
    expect(highConfidence).toHaveLength(0);
    expect(result.pass).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 18: Numeric value conflict
  // -----------------------------------------------------------------------
  test('Numeric value conflict: timeout 30s vs timeout 60s', async () => {
    const childA = makeChild('cA', [
      'Redis timeout: 30s for all cache operations.',
    ]);
    const childB = makeChild('cB', [
      'Redis timeout: 60s for all cache operations.',
    ]);

    const result = await detector.detect([childA, childB]);

    const numericConflicts = result.contradictions.filter(
      (c) => c.confidence >= 0.7
    );
    expect(numericConflicts.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Test 19: Low confidence match (does not block)
  // -----------------------------------------------------------------------
  test('Low confidence match: reported but does not block', async () => {
    // Create a mock strategy that returns a low-confidence contradiction
    const mockStrategy: ContradictionDetectionStrategy = {
      async detect(childA: ChildDocument, childB: ChildDocument): Promise<Contradiction[]> {
        return [
          {
            child_a_id: childA.id,
            child_b_id: childB.id,
            entity: 'ambiguous-tech',
            statement_a: 'May use technology X',
            statement_b: 'Could use technology Y',
            confidence: 0.5,
          },
        ];
      },
    };

    const detectorWithMock = new ContradictionDetector(mockStrategy);
    const childA = makeChild('cA', ['Content A']);
    const childB = makeChild('cB', ['Content B']);

    const result = await detectorWithMock.detect([childA, childB]);

    // Low confidence is reported but does not block
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0].confidence).toBe(0.5);
    expect(result.pass).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 20: Three children, one pair conflicts
  // -----------------------------------------------------------------------
  test('Three children, only A and B conflict', async () => {
    const childA = makeChild('cA', [
      'We will use PostgreSQL for the database.',
    ]);
    const childB = makeChild('cB', [
      'We will use MongoDB for the database.',
    ]);
    const childC = makeChild('cC', [
      'The notification service uses email templates.',
    ]);

    const result = await detector.detect([childA, childB, childC]);

    expect(result.pass).toBe(false);
    const highConfidence = result.contradictions.filter((c) => c.confidence >= 0.7);
    expect(highConfidence.length).toBeGreaterThanOrEqual(1);

    // Verify the contradiction is between A and B, not involving C
    for (const contradiction of highConfidence) {
      expect(contradiction.child_a_id).toBe('cA');
      expect(contradiction.child_b_id).toBe('cB');
    }
  });

  // -----------------------------------------------------------------------
  // Test 21: No shared entities at all
  // -----------------------------------------------------------------------
  test('No shared entities at all: children discuss completely different topics', async () => {
    const childA = makeChild('cA', [
      'The payment processing handles credit card validation.',
    ]);
    const childB = makeChild('cB', [
      'The inventory tracking manages warehouse stock levels.',
    ]);

    const result = await detector.detect([childA, childB]);

    expect(result.contradictions).toEqual([]);
    expect(result.pass).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 22: Entity extraction -- technology names
  // -----------------------------------------------------------------------
  test('Entity extraction: "We will use Redis for caching" extracts Redis', () => {
    const entities = extractEntities('We will use Redis for caching.');

    expect(entities.has('Redis')).toBe(true);
    expect(entities.get('Redis')!.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Test 23: Entity extraction -- use pattern
  // -----------------------------------------------------------------------
  test('Entity extraction: "The system adopts GraphQL for API layer" extracts GraphQL', () => {
    const entities = extractEntities(
      'The system adopts GraphQL for API layer.'
    );

    expect(entities.has('GraphQL')).toBe(true);
    expect(entities.get('GraphQL')!.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Test 24: Pluggable strategy interface
  // -----------------------------------------------------------------------
  test('Pluggable strategy: mock strategy returns a hardcoded contradiction', async () => {
    const mockContradiction: Contradiction = {
      child_a_id: 'cA',
      child_b_id: 'cB',
      entity: 'test-entity',
      statement_a: 'Statement from A',
      statement_b: 'Statement from B',
      confidence: 0.95,
    };

    const mockStrategy: ContradictionDetectionStrategy = {
      async detect(): Promise<Contradiction[]> {
        return [mockContradiction];
      },
    };

    const detectorWithMock = new ContradictionDetector(mockStrategy);
    const childA = makeChild('cA', ['Content A']);
    const childB = makeChild('cB', ['Content B']);

    const result = await detectorWithMock.detect([childA, childB]);

    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]).toEqual(mockContradiction);
    expect(result.pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // SPEC-004-4-4 Test 14: Entity extraction accuracy
  // -----------------------------------------------------------------------
  test('Entity extraction: extracts PostgreSQL, MongoDB, Redis from sample text', () => {
    const text =
      'We use PostgreSQL for the primary database. ' +
      'MongoDB handles document storage. ' +
      'Redis provides the caching layer.';

    const entities = extractEntities(text);

    expect(entities.has('PostgreSQL')).toBe(true);
    expect(entities.has('MongoDB')).toBe(true);
    expect(entities.has('Redis')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // SPEC-004-4-4 Test 15: No false positives on similar tech
  // -----------------------------------------------------------------------
  test('No false positives: two children both using PostgreSQL do not conflict', async () => {
    const childA = makeChild('cA', [
      'We use PostgreSQL for the user database with JSONB columns.',
    ]);
    const childB = makeChild('cB', [
      'We use PostgreSQL for the order database with JSONB columns.',
    ]);

    const result = await detector.detect([childA, childB]);

    const highConfidence = result.contradictions.filter((c) => c.confidence >= 0.7);
    expect(highConfidence).toHaveLength(0);
    expect(result.pass).toBe(true);
  });
});
