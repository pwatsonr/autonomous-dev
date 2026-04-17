import type {
  DocumentType,
  DocumentForValidation,
  PreReviewValidationResult,
  ValidationError,
  ValidationWarning,
  DocumentStoreInterface,
} from './types';
import type { DocumentSectionMappings } from './section-mappings';

// ---------------------------------------------------------------------------
// Frontmatter schema: required fields by document type
// ---------------------------------------------------------------------------

/**
 * Required frontmatter fields and their expected types for each document type.
 */
const FRONTMATTER_SCHEMAS: Record<
  string,
  { field: string; expected_type: string }[]
> = {
  PRD: [
    { field: 'title', expected_type: 'string' },
    { field: 'status', expected_type: 'string' },
    { field: 'author', expected_type: 'string' },
    { field: 'version', expected_type: 'string' },
    { field: 'created_at', expected_type: 'string' },
  ],
  TDD: [
    { field: 'title', expected_type: 'string' },
    { field: 'status', expected_type: 'string' },
    { field: 'author', expected_type: 'string' },
    { field: 'version', expected_type: 'string' },
    { field: 'created_at', expected_type: 'string' },
    { field: 'traces_from', expected_type: 'object' },
  ],
  Plan: [
    { field: 'title', expected_type: 'string' },
    { field: 'status', expected_type: 'string' },
    { field: 'author', expected_type: 'string' },
    { field: 'version', expected_type: 'string' },
    { field: 'created_at', expected_type: 'string' },
    { field: 'traces_from', expected_type: 'object' },
  ],
  Spec: [
    { field: 'title', expected_type: 'string' },
    { field: 'status', expected_type: 'string' },
    { field: 'author', expected_type: 'string' },
    { field: 'version', expected_type: 'string' },
    { field: 'created_at', expected_type: 'string' },
    { field: 'traces_from', expected_type: 'object' },
  ],
  Code: [
    { field: 'title', expected_type: 'string' },
    { field: 'status', expected_type: 'string' },
    { field: 'author', expected_type: 'string' },
    { field: 'version', expected_type: 'string' },
    { field: 'created_at', expected_type: 'string' },
    { field: 'traces_from', expected_type: 'object' },
  ],
};

// ---------------------------------------------------------------------------
// Type for the getSectionMappings function signature
// ---------------------------------------------------------------------------

type GetSectionMappingsFn = (documentType: DocumentType) => DocumentSectionMappings;

// ---------------------------------------------------------------------------
// PreReviewValidator
// ---------------------------------------------------------------------------

/**
 * Runs structural validation before any reviewer agent is invoked.
 *
 * Validates:
 * 1. Required sections present (per document type's section mappings)
 * 2. Frontmatter schema (required fields present, correct types)
 * 3. traces_from reference resolution (parent documents and sections exist)
 * 4. Scoring mode determination (per-section vs document-level)
 *
 * Returns a structured result with errors, warnings, and the determined scoring mode.
 */
export class PreReviewValidator {
  constructor(
    private sectionMappings: GetSectionMappingsFn,
    private documentStore: DocumentStoreInterface
  ) {}

  /**
   * Validate a document prior to review.
   *
   * Checks are executed in order:
   *  1. Required sections present
   *  2. Frontmatter schema validation
   *  3. traces_from reference resolution
   *  4. Scoring mode determination
   */
  async validate(
    document: DocumentForValidation,
    documentType: DocumentType
  ): Promise<PreReviewValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // ------------------------------------------------------------------
    // Check 1: Required sections present
    // ------------------------------------------------------------------
    let hasSectionMappings = true;
    let mappings: DocumentSectionMappings | null = null;

    try {
      mappings = this.sectionMappings(documentType);
    } catch {
      hasSectionMappings = false;
    }

    if (!hasSectionMappings || !mappings) {
      // No section mapping defined for this document type
      warnings.push({
        code: 'NO_SECTION_MAPPING',
        message: `No section mapping defined for document type '${documentType}'. Skipping section validation.`,
      });
    } else {
      // Check for required sections
      const requiredSectionIds = mappings.mappings.map((m) => m.section_id);

      if (requiredSectionIds.length > 0) {
        const documentSectionIds = new Set(document.sections.map((s) => s.id));

        for (const sectionId of requiredSectionIds) {
          if (!documentSectionIds.has(sectionId)) {
            errors.push({
              code: 'MISSING_SECTION',
              message: `Required section '${sectionId}' is missing.`,
              section_id: sectionId,
            });
          }
        }
      }
      // If 0 required sections (all optional), skip validation entirely -- valid: true
    }

    // ------------------------------------------------------------------
    // Check 2: Frontmatter schema validation
    // ------------------------------------------------------------------
    const schema = FRONTMATTER_SCHEMAS[documentType];
    if (schema) {
      for (const { field, expected_type } of schema) {
        const value = document.frontmatter[field];

        if (value === undefined || value === null) {
          errors.push({
            code: 'MISSING_FRONTMATTER',
            message: `Required frontmatter field '${field}' is missing.`,
            field,
          });
        } else {
          // Type check
          const actualType = typeof value;
          // For 'object' expected type, accept arrays and objects
          if (expected_type === 'object') {
            if (actualType !== 'object') {
              errors.push({
                code: 'INVALID_FRONTMATTER_TYPE',
                message: `Frontmatter field '${field}' must be of type '${expected_type}', got '${actualType}'.`,
                field,
              });
            }
          } else if (actualType !== expected_type) {
            errors.push({
              code: 'INVALID_FRONTMATTER_TYPE',
              message: `Frontmatter field '${field}' must be of type '${expected_type}', got '${actualType}'.`,
              field,
            });
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Check 3: traces_from reference resolution
    // ------------------------------------------------------------------
    if (document.traces_from && document.traces_from.length > 0) {
      for (const trace of document.traces_from) {
        const exists = await this.documentStore.documentExists(trace.document_id);
        if (!exists) {
          errors.push({
            code: 'UNRESOLVABLE_TRACE',
            message: `traces_from references document '${trace.document_id}' which does not exist.`,
          });
          // Skip section checks for non-existent document
          continue;
        }

        // Check sections within the parent document
        const parentSectionIds = await this.documentStore.getSectionIds(trace.document_id);
        const parentSectionSet = new Set(parentSectionIds);

        for (const sectionId of trace.section_ids) {
          if (!parentSectionSet.has(sectionId)) {
            errors.push({
              code: 'UNRESOLVABLE_TRACE_SECTION',
              message: `traces_from references section '${sectionId}' in document '${trace.document_id}' which does not exist.`,
              section_id: sectionId,
            });
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Check 4: Scoring mode determination
    // ------------------------------------------------------------------
    let scoring_mode: 'per_section' | 'document_level';

    if (document.word_count < 500) {
      scoring_mode = 'document_level';
      warnings.push({
        code: 'SHORT_DOCUMENT',
        message: `Document is under 500 words (${document.word_count}). Using document-level scoring.`,
      });
    } else if (!hasSectionMappings || !mappings) {
      scoring_mode = 'document_level';
    } else {
      scoring_mode = 'per_section';
    }

    // ------------------------------------------------------------------
    // Result assembly
    // ------------------------------------------------------------------
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      scoring_mode,
    };
  }
}
