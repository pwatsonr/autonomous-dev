import { PreReviewValidator } from '../../src/review-gate/pre-review-validator';
import type {
  DocumentForValidation,
  DocumentStoreInterface,
  DocumentType,
  ValidationError,
} from '../../src/review-gate/types';
import { DocumentType as PipelineDocumentType } from '../../src/pipeline/types/document-type';
import { getSectionMappings } from '../../src/review-gate/section-mappings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wraps the pipeline getSectionMappings to accept review-gate DocumentType strings.
 * The section-mappings module uses pipeline DocumentType enum; this adapter bridges them.
 */
function sectionMappingsAdapter(documentType: DocumentType) {
  // Map review-gate DocumentType strings to pipeline enum values
  const mapping: Record<string, PipelineDocumentType> = {
    PRD: PipelineDocumentType.PRD,
    TDD: PipelineDocumentType.TDD,
    Plan: PipelineDocumentType.PLAN,
    Spec: PipelineDocumentType.SPEC,
    Code: PipelineDocumentType.CODE,
  };

  const pipelineType = mapping[documentType];
  if (!pipelineType) {
    throw new Error(`No section mappings registered for document type: ${documentType}`);
  }
  return getSectionMappings(pipelineType);
}

/**
 * Creates a mock DocumentStoreInterface.
 */
function createMockStore(
  documents: Record<string, string[]> = {}
): DocumentStoreInterface {
  return {
    async documentExists(documentId: string): Promise<boolean> {
      return documentId in documents;
    },
    async getSectionIds(documentId: string): Promise<string[]> {
      return documents[documentId] ?? [];
    },
  };
}

/**
 * Creates a valid PRD document for testing.
 */
function makeValidPrdDocument(overrides: Partial<DocumentForValidation> = {}): DocumentForValidation {
  return {
    id: 'prd-001',
    content: 'A '.repeat(300), // 600 words (above 500 threshold)
    frontmatter: {
      title: 'Test PRD',
      status: 'draft',
      author: 'test-author',
      version: '1.0.0',
      created_at: '2025-01-01T00:00:00Z',
    },
    sections: [
      { id: 'problem_statement', title: 'Problem Statement', content: 'The problem...' },
      { id: 'goals', title: 'Goals', content: 'Goals...' },
      { id: 'user_stories', title: 'User Stories', content: 'Stories...' },
      { id: 'functional_requirements', title: 'Functional Requirements', content: 'FR...' },
      { id: 'non_functional_requirements', title: 'Non-Functional Requirements', content: 'NFR...' },
      { id: 'success_metrics', title: 'Success Metrics', content: 'Metrics...' },
      { id: 'risks_and_mitigations', title: 'Risks and Mitigations', content: 'Risks...' },
    ],
    word_count: 600,
    ...overrides,
  };
}

/**
 * Creates a valid TDD document for testing.
 */
function makeValidTddDocument(overrides: Partial<DocumentForValidation> = {}): DocumentForValidation {
  return {
    id: 'tdd-001',
    content: 'A '.repeat(300),
    frontmatter: {
      title: 'Test TDD',
      status: 'draft',
      author: 'test-author',
      version: '1.0.0',
      created_at: '2025-01-01T00:00:00Z',
      traces_from: [{ document_id: 'prd-001', section_ids: ['goals'] }],
    },
    sections: [
      { id: 'overview', title: 'Overview', content: 'Overview...' },
      { id: 'architecture', title: 'Architecture', content: 'Arch...' },
      { id: 'detailed_design', title: 'Detailed Design', content: 'DD...' },
      { id: 'data_models', title: 'Data Models', content: 'DM...' },
      { id: 'api_contracts', title: 'API Contracts', content: 'APIs...' },
      { id: 'integrations', title: 'Integrations', content: 'Int...' },
      { id: 'security', title: 'Security', content: 'Sec...' },
      { id: 'trade_offs', title: 'Trade-offs', content: 'TO...' },
    ],
    traces_from: [{ document_id: 'prd-001', section_ids: ['goals'] }],
    word_count: 600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PreReviewValidator', () => {
  const mockStore = createMockStore({
    'prd-001': ['problem_statement', 'goals', 'user_stories'],
  });
  const validator = new PreReviewValidator(sectionMappingsAdapter, mockStore);

  // -----------------------------------------------------------------------
  // Test 1: Valid PRD document
  // -----------------------------------------------------------------------
  test('Valid PRD document returns valid: true, no errors, scoring_mode per_section', async () => {
    const doc = makeValidPrdDocument();
    const result = await validator.validate(doc, 'PRD');

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.scoring_mode).toBe('per_section');
  });

  // -----------------------------------------------------------------------
  // Test 2: Missing required section
  // -----------------------------------------------------------------------
  test('PRD document missing risks_and_mitigations returns MISSING_SECTION error', async () => {
    const doc = makeValidPrdDocument({
      sections: [
        { id: 'problem_statement', title: 'Problem Statement', content: '...' },
        { id: 'goals', title: 'Goals', content: '...' },
        { id: 'user_stories', title: 'User Stories', content: '...' },
        { id: 'functional_requirements', title: 'Functional Requirements', content: '...' },
        { id: 'non_functional_requirements', title: 'Non-Functional Requirements', content: '...' },
        { id: 'success_metrics', title: 'Success Metrics', content: '...' },
        // risks_and_mitigations is missing
      ],
    });

    const result = await validator.validate(doc, 'PRD');

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('MISSING_SECTION');
    expect(result.errors[0].section_id).toBe('risks_and_mitigations');
    expect(result.errors[0].message).toContain('risks_and_mitigations');
  });

  // -----------------------------------------------------------------------
  // Test 3: Multiple missing sections
  // -----------------------------------------------------------------------
  test('PRD document missing 3 sections returns 3 MISSING_SECTION errors', async () => {
    const doc = makeValidPrdDocument({
      sections: [
        { id: 'problem_statement', title: 'Problem Statement', content: '...' },
        { id: 'goals', title: 'Goals', content: '...' },
        { id: 'user_stories', title: 'User Stories', content: '...' },
        { id: 'functional_requirements', title: 'Functional Requirements', content: '...' },
        // missing: non_functional_requirements, success_metrics, risks_and_mitigations
      ],
    });

    const result = await validator.validate(doc, 'PRD');

    expect(result.valid).toBe(false);
    const missingSectionErrors = result.errors.filter((e) => e.code === 'MISSING_SECTION');
    expect(missingSectionErrors).toHaveLength(3);
    expect(missingSectionErrors.map((e) => e.section_id)).toEqual(
      expect.arrayContaining([
        'non_functional_requirements',
        'success_metrics',
        'risks_and_mitigations',
      ])
    );
  });

  // -----------------------------------------------------------------------
  // Test 4: Missing frontmatter field
  // -----------------------------------------------------------------------
  test('TDD document missing traces_from in frontmatter returns MISSING_FRONTMATTER error', async () => {
    const doc = makeValidTddDocument({
      frontmatter: {
        title: 'Test TDD',
        status: 'draft',
        author: 'test-author',
        version: '1.0.0',
        created_at: '2025-01-01T00:00:00Z',
        // traces_from is missing
      },
    });

    const result = await validator.validate(doc, 'TDD');

    expect(result.valid).toBe(false);
    const fmErrors = result.errors.filter((e) => e.code === 'MISSING_FRONTMATTER');
    expect(fmErrors.length).toBeGreaterThanOrEqual(1);
    expect(fmErrors.some((e) => e.field === 'traces_from')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 5: Wrong frontmatter type
  // -----------------------------------------------------------------------
  test('Document with version: 123 (number instead of string) returns INVALID_FRONTMATTER_TYPE error', async () => {
    const doc = makeValidPrdDocument({
      frontmatter: {
        title: 'Test PRD',
        status: 'draft',
        author: 'test-author',
        version: 123, // number instead of string
        created_at: '2025-01-01T00:00:00Z',
      },
    });

    const result = await validator.validate(doc, 'PRD');

    expect(result.valid).toBe(false);
    const typeErrors = result.errors.filter((e) => e.code === 'INVALID_FRONTMATTER_TYPE');
    expect(typeErrors.length).toBeGreaterThanOrEqual(1);
    expect(typeErrors[0].field).toBe('version');
    expect(typeErrors[0].message).toContain('string');
    expect(typeErrors[0].message).toContain('number');
  });

  // -----------------------------------------------------------------------
  // Test 6: Unresolvable parent document
  // -----------------------------------------------------------------------
  test('traces_from referencing non-existent document returns UNRESOLVABLE_TRACE error', async () => {
    const doc = makeValidTddDocument({
      traces_from: [{ document_id: 'doc-999', section_ids: ['some_section'] }],
    });

    const result = await validator.validate(doc, 'TDD');

    const traceErrors = result.errors.filter((e) => e.code === 'UNRESOLVABLE_TRACE');
    expect(traceErrors.length).toBeGreaterThanOrEqual(1);
    expect(traceErrors[0].message).toContain('doc-999');
  });

  // -----------------------------------------------------------------------
  // Test 7: Unresolvable parent section
  // -----------------------------------------------------------------------
  test('traces_from referencing non-existent section returns UNRESOLVABLE_TRACE_SECTION error', async () => {
    const doc = makeValidTddDocument({
      traces_from: [{ document_id: 'prd-001', section_ids: ['section-xyz'] }],
    });

    const result = await validator.validate(doc, 'TDD');

    const sectionErrors = result.errors.filter((e) => e.code === 'UNRESOLVABLE_TRACE_SECTION');
    expect(sectionErrors.length).toBeGreaterThanOrEqual(1);
    expect(sectionErrors[0].message).toContain('section-xyz');
    expect(sectionErrors[0].message).toContain('prd-001');
    expect(sectionErrors[0].section_id).toBe('section-xyz');
  });

  // -----------------------------------------------------------------------
  // Test 8: Short document (499 words)
  // -----------------------------------------------------------------------
  test('Document with 499 words returns valid: true (if sections pass), scoring_mode document_level, SHORT_DOCUMENT warning', async () => {
    const doc = makeValidPrdDocument({ word_count: 499 });
    const result = await validator.validate(doc, 'PRD');

    expect(result.valid).toBe(true);
    expect(result.scoring_mode).toBe('document_level');
    expect(result.warnings.some((w) => w.code === 'SHORT_DOCUMENT')).toBe(true);
    expect(result.warnings.find((w) => w.code === 'SHORT_DOCUMENT')!.message).toContain('499');
  });

  // -----------------------------------------------------------------------
  // Test 9: Document at exactly 500 words
  // -----------------------------------------------------------------------
  test('Document at exactly 500 words returns scoring_mode per_section', async () => {
    const doc = makeValidPrdDocument({ word_count: 500 });
    const result = await validator.validate(doc, 'PRD');

    expect(result.valid).toBe(true);
    expect(result.scoring_mode).toBe('per_section');
    expect(result.warnings.some((w) => w.code === 'SHORT_DOCUMENT')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 10: Document type with no section mapping
  // -----------------------------------------------------------------------
  test('Custom document type with no mappings returns valid: true, NO_SECTION_MAPPING warning, scoring_mode document_level', async () => {
    // Use a section-mappings function that throws for unknown types
    const throwingMappings = (_type: DocumentType) => {
      throw new Error(`No section mappings registered for document type: ${_type}`);
    };

    const customValidator = new PreReviewValidator(throwingMappings, mockStore);
    const doc = makeValidPrdDocument();

    const result = await customValidator.validate(doc, 'PRD');

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === 'NO_SECTION_MAPPING')).toBe(true);
    expect(result.scoring_mode).toBe('document_level');
  });

  // -----------------------------------------------------------------------
  // Test 11: All errors are structured
  // -----------------------------------------------------------------------
  test('Every error has code and message; section errors include section_id; frontmatter errors include field', async () => {
    // Document with missing section, missing frontmatter, and unresolvable trace
    const doc: DocumentForValidation = {
      id: 'tdd-bad',
      content: 'short',
      frontmatter: {
        title: 'Test',
        status: 'draft',
        author: 'test',
        version: '1.0',
        created_at: '2025-01-01',
        // traces_from missing
      },
      sections: [
        // Missing multiple sections
        { id: 'overview', title: 'Overview', content: '...' },
      ],
      traces_from: [{ document_id: 'doc-999', section_ids: [] }],
      word_count: 600,
    };

    const result = await validator.validate(doc, 'TDD');

    expect(result.valid).toBe(false);

    // Every error has code and message
    for (const error of result.errors) {
      expect(error.code).toBeDefined();
      expect(typeof error.code).toBe('string');
      expect(error.code.length).toBeGreaterThan(0);
      expect(error.message).toBeDefined();
      expect(typeof error.message).toBe('string');
      expect(error.message.length).toBeGreaterThan(0);
    }

    // Section-related errors include section_id
    const sectionErrors = result.errors.filter((e) => e.code === 'MISSING_SECTION');
    expect(sectionErrors.length).toBeGreaterThan(0);
    for (const err of sectionErrors) {
      expect(err.section_id).toBeDefined();
      expect(typeof err.section_id).toBe('string');
    }

    // Frontmatter errors include field
    const fmErrors = result.errors.filter(
      (e) => e.code === 'MISSING_FRONTMATTER' || e.code === 'INVALID_FRONTMATTER_TYPE'
    );
    expect(fmErrors.length).toBeGreaterThan(0);
    for (const err of fmErrors) {
      expect(err.field).toBeDefined();
      expect(typeof err.field).toBe('string');
    }
  });

  // -----------------------------------------------------------------------
  // Test 12: PRD has no traces_from requirement
  // -----------------------------------------------------------------------
  test('PRD frontmatter does not require traces_from; missing traces_from on PRD produces no error', async () => {
    const doc = makeValidPrdDocument({
      frontmatter: {
        title: 'Test PRD',
        status: 'draft',
        author: 'test-author',
        version: '1.0.0',
        created_at: '2025-01-01T00:00:00Z',
        // No traces_from -- should be fine for PRD
      },
    });

    const result = await validator.validate(doc, 'PRD');

    expect(result.valid).toBe(true);
    const traceErrors = result.errors.filter(
      (e) => e.code === 'MISSING_FRONTMATTER' && e.field === 'traces_from'
    );
    expect(traceErrors).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 13: Multiple validation failures combine
  // -----------------------------------------------------------------------
  test('Document with missing section AND missing frontmatter AND unresolvable trace returns all 3 errors', async () => {
    const doc: DocumentForValidation = {
      id: 'tdd-bad',
      content: 'content',
      frontmatter: {
        title: 'Test TDD',
        status: 'draft',
        author: 'test',
        version: '1.0',
        created_at: '2025-01-01',
        // traces_from missing in frontmatter
      },
      sections: [
        { id: 'overview', title: 'Overview', content: '...' },
        { id: 'architecture', title: 'Architecture', content: '...' },
        { id: 'detailed_design', title: 'Detailed Design', content: '...' },
        { id: 'data_models', title: 'Data Models', content: '...' },
        { id: 'api_contracts', title: 'API Contracts', content: '...' },
        { id: 'integrations', title: 'Integrations', content: '...' },
        { id: 'security', title: 'Security', content: '...' },
        // trade_offs is missing
      ],
      traces_from: [{ document_id: 'nonexistent-doc', section_ids: [] }],
      word_count: 600,
    };

    const result = await validator.validate(doc, 'TDD');

    expect(result.valid).toBe(false);

    // Should have at least one of each error type
    const missingSectionErrors = result.errors.filter((e) => e.code === 'MISSING_SECTION');
    const missingFmErrors = result.errors.filter((e) => e.code === 'MISSING_FRONTMATTER');
    const unresolvedTraceErrors = result.errors.filter((e) => e.code === 'UNRESOLVABLE_TRACE');

    expect(missingSectionErrors.length).toBeGreaterThanOrEqual(1);
    expect(missingFmErrors.length).toBeGreaterThanOrEqual(1);
    expect(unresolvedTraceErrors.length).toBeGreaterThanOrEqual(1);

    // Total errors should be at least 3
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
