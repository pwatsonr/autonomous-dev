import {
  BlindScoringContextFilter,
  DocumentForReview,
  FilteredDocument,
} from '../../src/review-gate/blind-scoring-context-filter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDocument(overrides: Partial<DocumentForReview> = {}): DocumentForReview {
  return {
    id: 'doc-001',
    content: 'This is the main document content. It discusses requirements.',
    frontmatter: {
      title: 'Test PRD',
      author: 'test-user',
      status: 'draft',
    },
    version: '1.0',
    created_at: '2026-03-15T00:00:00.000Z',
    sections: [
      {
        id: 'problem_statement',
        title: 'Problem Statement',
        content: 'The problem is clearly defined here.',
      },
      {
        id: 'goals',
        title: 'Goals',
        content: 'The goals are measurable and time-bound.',
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BlindScoringContextFilter', () => {
  let filter: BlindScoringContextFilter;

  beforeEach(() => {
    filter = new BlindScoringContextFilter();
  });

  // Test 1: Version normalized to "1.0"
  it('normalizes version to "1.0"', () => {
    const doc = makeDocument({ version: '2.3' });
    const result = filter.filterDocument(doc);

    expect(result.version).toBe('1.0');
    expect(result.fields_stripped).toContain('version');
  });

  // Test 2: updated_at removed
  it('removes updated_at from output', () => {
    const doc = makeDocument({
      updated_at: '2026-04-01T00:00:00.000Z',
      frontmatter: {
        title: 'Test PRD',
        author: 'test-user',
        updated_at: '2026-04-01',
      },
    });
    const result = filter.filterDocument(doc);

    expect(result.fields_stripped).toContain('updated_at');
    expect((result as any).updated_at).toBeUndefined();
    expect(result.frontmatter).not.toHaveProperty('updated_at');
  });

  // Test 3: change_history removed
  it('removes change_history', () => {
    const doc = makeDocument({
      change_history: ['v1->v2: Updated requirements', 'v2->v3: Added metrics'],
    });
    const result = filter.filterDocument(doc);

    expect(result.fields_stripped).toContain('change_history');
    expect((result as any).change_history).toBeUndefined();
  });

  // Test 4: created_at retained
  it('retains created_at', () => {
    const doc = makeDocument({ created_at: '2026-03-15T00:00:00.000Z' });
    const result = filter.filterDocument(doc);

    expect(result.created_at).toBe('2026-03-15T00:00:00.000Z');
  });

  // Test 5: Content retained
  it('retains document content (minus stripped patterns)', () => {
    const content = 'This is important content about the product requirements.';
    const doc = makeDocument({ content });
    const result = filter.filterDocument(doc);

    expect(result.content).toContain('This is important content about the product requirements.');
  });

  // Test 6: Frontmatter fields retained
  it('retains non-prohibited frontmatter fields', () => {
    const doc = makeDocument({
      frontmatter: {
        title: 'My PRD',
        author: 'alice',
        status: 'in_review',
        custom_field: 'custom_value',
      },
    });
    const result = filter.filterDocument(doc);

    expect(result.frontmatter.title).toBe('My PRD');
    expect(result.frontmatter.author).toBe('alice');
    expect(result.frontmatter.status).toBe('in_review');
    expect(result.frontmatter.custom_field).toBe('custom_value');
  });

  // Test 7: Revision notes section removed
  it('removes "## Revision Notes" section from content', () => {
    const content = [
      '# Document',
      '',
      'Main content here.',
      '',
      '## Revision Notes',
      '',
      'This section was revised in v2.',
      'Added more detail per feedback.',
      '',
      '## Next Section',
      '',
      'This section should be preserved.',
    ].join('\n');

    const doc = makeDocument({ content });
    const result = filter.filterDocument(doc);

    expect(result.content).not.toContain('Revision Notes');
    expect(result.content).not.toContain('This section was revised in v2.');
    expect(result.content).toContain('Next Section');
    expect(result.content).toContain('This section should be preserved.');
  });

  // Test 8: Change Log section removed
  it('removes "## Change Log" section from content', () => {
    const content = [
      '# Document',
      '',
      'Main content.',
      '',
      '## Change Log',
      '',
      '- v1: Initial draft',
      '- v2: Added requirements',
      '',
      '## Requirements',
      '',
      'The requirements are...',
    ].join('\n');

    const doc = makeDocument({ content });
    const result = filter.filterDocument(doc);

    expect(result.content).not.toContain('Change Log');
    expect(result.content).not.toContain('v1: Initial draft');
    expect(result.content).toContain('Requirements');
    expect(result.content).toContain('The requirements are...');
  });

  // Test 9: Feedback reference stripped
  it('strips "Per reviewer feedback" style sentences', () => {
    const content =
      'The API uses REST architecture. Per reviewer feedback, the API endpoint was changed to use POST. The endpoint accepts JSON.';

    const doc = makeDocument({ content });
    const result = filter.filterDocument(doc);

    expect(result.content).not.toContain(
      'Per reviewer feedback, the API endpoint was changed to use POST.',
    );
    expect(result.content).toContain('The API uses REST architecture.');
    expect(result.content).toContain('The endpoint accepts JSON.');
  });

  // Test 10: Multiple feedback references stripped
  it('strips multiple different feedback reference patterns', () => {
    const content = [
      'The system uses microservices.',
      'Per reviewer feedback, authentication was added.',
      'The data model is normalized.',
      'As suggested by the review, caching was implemented.',
      'Updated based on review feedback, the error handling was improved.',
    ].join(' ');

    const doc = makeDocument({ content });
    const result = filter.filterDocument(doc);

    expect(result.content).not.toContain('Per reviewer feedback');
    expect(result.content).not.toContain('As suggested by the review');
    expect(result.content).not.toContain('Updated based on review feedback');
    expect(result.content).toContain('The system uses microservices.');
    expect(result.content).toContain('The data model is normalized.');
  });

  // Test 11: Normal content not stripped
  it('does not strip normal content that mentions "reviewed"', () => {
    const content = 'The product analyst reviewed the market data. The team reviewed the architecture.';

    const doc = makeDocument({ content });
    const result = filter.filterDocument(doc);

    expect(result.content).toContain('The product analyst reviewed the market data.');
    expect(result.content).toContain('The team reviewed the architecture.');
  });

  // Test 12: Iteration count removed from frontmatter
  it('removes iteration count from frontmatter', () => {
    const doc = makeDocument({
      frontmatter: {
        title: 'Test PRD',
        iteration: 3,
        author: 'test-user',
      },
    });
    const result = filter.filterDocument(doc);

    expect(result.frontmatter).not.toHaveProperty('iteration');
    expect(result.fields_stripped).toContain('iteration');
  });

  // Test 13: Previous scores removed
  it('removes previous_scores from frontmatter', () => {
    const doc = makeDocument({
      frontmatter: {
        title: 'Test PRD',
        previous_scores: [72, 78],
        author: 'test-user',
      },
    });
    const result = filter.filterDocument(doc);

    expect(result.frontmatter).not.toHaveProperty('previous_scores');
    expect(result.fields_stripped).toContain('previous_scores');
  });

  // Test 14: fields_stripped audit
  it('includes all stripped fields in the audit list', () => {
    const doc = makeDocument({
      version: '3.1',
      updated_at: '2026-04-01T00:00:00.000Z',
      change_history: ['v1->v2', 'v2->v3'],
      frontmatter: {
        title: 'Test PRD',
        iteration: 2,
        previous_scores: [65],
        previous_findings: ['finding-1'],
      },
    });
    const result = filter.filterDocument(doc);

    expect(result.fields_stripped).toContain('version');
    expect(result.fields_stripped).toContain('updated_at');
    expect(result.fields_stripped).toContain('change_history');
    expect(result.fields_stripped).toContain('iteration');
    expect(result.fields_stripped).toContain('previous_scores');
    expect(result.fields_stripped).toContain('previous_findings');
  });

  // Test 15: No prohibited fields -- minimal stripping
  it('only strips version when no other prohibited fields are present', () => {
    const doc = makeDocument({ version: '2.0' });
    const result = filter.filterDocument(doc);

    expect(result.fields_stripped).toEqual(['version']);
  });

  // Test 16: Case-insensitive section detection
  it('detects revision sections case-insensitively', () => {
    const content = [
      '# Document',
      '',
      'Main content.',
      '',
      '## revision history',
      '',
      'This was revised several times.',
      '',
      '## Other Section',
      '',
      'Preserved content.',
    ].join('\n');

    const doc = makeDocument({ content });
    const result = filter.filterDocument(doc);

    expect(result.content).not.toContain('revision history');
    expect(result.content).not.toContain('This was revised several times.');
    expect(result.content).toContain('Other Section');
    expect(result.content).toContain('Preserved content.');
  });

  // Additional: filterParentDocument applies same rules
  it('applies the same filtering rules to parent documents', () => {
    const doc = makeDocument({
      version: '2.0',
      updated_at: '2026-04-01T00:00:00.000Z',
      change_history: ['v1->v2'],
    });
    const result = filter.filterParentDocument(doc);

    expect(result.version).toBe('1.0');
    expect((result as any).updated_at).toBeUndefined();
    expect((result as any).change_history).toBeUndefined();
    expect(result.fields_stripped).toContain('version');
    expect(result.fields_stripped).toContain('updated_at');
    expect(result.fields_stripped).toContain('change_history');
  });

  // Additional: Sections filtering -- revision sections removed from sections array
  it('removes revision-titled sections from the sections array', () => {
    const doc = makeDocument({
      sections: [
        { id: 'problem', title: 'Problem Statement', content: 'The problem...' },
        { id: 'revisions', title: 'Revision Notes', content: 'Revised in v2...' },
        { id: 'goals', title: 'Goals', content: 'The goals...' },
      ],
    });
    const result = filter.filterDocument(doc);

    expect(result.sections).toHaveLength(2);
    expect(result.sections.map((s) => s.id)).toEqual(['problem', 'goals']);
  });

  // Additional: iteration_count frontmatter key
  it('removes iteration_count from frontmatter', () => {
    const doc = makeDocument({
      frontmatter: {
        title: 'Test',
        iteration_count: 5,
      },
    });
    const result = filter.filterDocument(doc);

    expect(result.frontmatter).not.toHaveProperty('iteration_count');
    expect(result.fields_stripped).toContain('iteration_count');
  });

  // Additional: document with version "1.0" does not add to fields_stripped
  it('does not add "version" to fields_stripped when version is already "1.0"', () => {
    const doc = makeDocument({ version: '1.0' });
    const result = filter.filterDocument(doc);

    expect(result.version).toBe('1.0');
    expect(result.fields_stripped).not.toContain('version');
  });
});
