import { DocumentType } from '../pipeline/types/document-type';

/**
 * Maps a document section to one or more rubric categories.
 */
export interface SectionMapping {
  section_id: string;
  category_ids: string[];
}

/**
 * Section-to-category mappings for a specific document type.
 */
export interface DocumentSectionMappings {
  document_type: DocumentType;
  mappings: SectionMapping[];
  /** Below this word count, fall back to document-level scoring. Default: 500. */
  word_count_threshold: number;
}

// ---------------------------------------------------------------------------
// PRD Section Mappings (TDD section 3.3.1)
// ---------------------------------------------------------------------------
const PRD_SECTION_MAPPINGS: DocumentSectionMappings = {
  document_type: DocumentType.PRD,
  word_count_threshold: 500,
  mappings: [
    { section_id: 'problem_statement', category_ids: ['problem_clarity'] },
    { section_id: 'goals', category_ids: ['goals_measurability', 'internal_consistency'] },
    { section_id: 'user_stories', category_ids: ['user_story_coverage', 'internal_consistency'] },
    {
      section_id: 'functional_requirements',
      category_ids: ['requirements_completeness', 'requirements_testability', 'internal_consistency'],
    },
    {
      section_id: 'non_functional_requirements',
      category_ids: ['requirements_completeness', 'requirements_testability'],
    },
    { section_id: 'success_metrics', category_ids: ['goals_measurability'] },
    { section_id: 'risks_and_mitigations', category_ids: ['risk_identification'] },
  ],
};

// ---------------------------------------------------------------------------
// TDD Section Mappings
// ---------------------------------------------------------------------------
const TDD_SECTION_MAPPINGS: DocumentSectionMappings = {
  document_type: DocumentType.TDD,
  word_count_threshold: 500,
  mappings: [
    { section_id: 'overview', category_ids: ['prd_alignment'] },
    { section_id: 'architecture', category_ids: ['architecture_soundness', 'prd_alignment'] },
    {
      section_id: 'detailed_design',
      category_ids: ['architecture_soundness', 'data_model_integrity', 'api_contract_completeness'],
    },
    { section_id: 'data_models', category_ids: ['data_model_integrity'] },
    { section_id: 'api_contracts', category_ids: ['api_contract_completeness'] },
    { section_id: 'integrations', category_ids: ['integration_robustness'] },
    { section_id: 'security', category_ids: ['security_depth'] },
    { section_id: 'trade_offs', category_ids: ['tradeoff_rigor'] },
  ],
};

// ---------------------------------------------------------------------------
// Plan Section Mappings
// ---------------------------------------------------------------------------
const PLAN_SECTION_MAPPINGS: DocumentSectionMappings = {
  document_type: DocumentType.PLAN,
  word_count_threshold: 500,
  mappings: [
    { section_id: 'tasks', category_ids: ['work_unit_granularity', 'tdd_alignment'] },
    { section_id: 'dependencies', category_ids: ['dependency_accuracy'] },
    { section_id: 'testing_strategy', category_ids: ['test_strategy_coverage'] },
    { section_id: 'effort_estimates', category_ids: ['effort_estimation'] },
    { section_id: 'risks', category_ids: ['risk_awareness'] },
    { section_id: 'tdd_traceability', category_ids: ['tdd_alignment'] },
  ],
};

// ---------------------------------------------------------------------------
// Spec Section Mappings
// ---------------------------------------------------------------------------
const SPEC_SECTION_MAPPINGS: DocumentSectionMappings = {
  document_type: DocumentType.SPEC,
  word_count_threshold: 500,
  mappings: [
    { section_id: 'acceptance_criteria', category_ids: ['acceptance_criteria_precision', 'plan_alignment'] },
    { section_id: 'files_to_create_modify', category_ids: ['file_path_accuracy'] },
    { section_id: 'test_cases', category_ids: ['test_case_coverage'] },
    { section_id: 'implementation_details', category_ids: ['code_pattern_clarity'] },
    { section_id: 'plan_traceability', category_ids: ['plan_alignment'] },
    { section_id: 'dependencies', category_ids: ['dependency_completeness'] },
  ],
};

// ---------------------------------------------------------------------------
// Code Section Mappings
// ---------------------------------------------------------------------------
const CODE_SECTION_MAPPINGS: DocumentSectionMappings = {
  document_type: DocumentType.CODE,
  word_count_threshold: 500,
  mappings: [
    { section_id: 'implementation', category_ids: ['spec_compliance', 'code_quality', 'maintainability'] },
    { section_id: 'tests', category_ids: ['test_coverage'] },
    { section_id: 'documentation', category_ids: ['documentation_completeness'] },
    { section_id: 'performance_paths', category_ids: ['performance'] },
    { section_id: 'security_paths', category_ids: ['security'] },
    { section_id: 'spec_traceability', category_ids: ['spec_compliance'] },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
const MAPPINGS_REGISTRY: Record<string, DocumentSectionMappings> = {
  [DocumentType.PRD]: PRD_SECTION_MAPPINGS,
  [DocumentType.TDD]: TDD_SECTION_MAPPINGS,
  [DocumentType.PLAN]: PLAN_SECTION_MAPPINGS,
  [DocumentType.SPEC]: SPEC_SECTION_MAPPINGS,
  [DocumentType.CODE]: CODE_SECTION_MAPPINGS,
};

/**
 * Returns section-to-category mappings for the given document type.
 * @throws Error if no mappings are registered for the type.
 */
export function getSectionMappings(documentType: DocumentType): DocumentSectionMappings {
  const mappings = MAPPINGS_REGISTRY[documentType];
  if (!mappings) {
    throw new Error(`No section mappings registered for document type: ${documentType}`);
  }
  return mappings;
}

/**
 * Returns the category IDs that the given section maps to.
 * Returns an empty array if the section is not found.
 */
export function getCategoryForSection(documentType: DocumentType, sectionId: string): string[] {
  const docMappings = getSectionMappings(documentType);
  const mapping = docMappings.mappings.find((m) => m.section_id === sectionId);
  return mapping ? [...mapping.category_ids] : [];
}

/**
 * Returns the section IDs that map to the given category (inverse lookup).
 * Returns an empty array if the category is not found in any mapping.
 */
export function getSectionsForCategory(documentType: DocumentType, categoryId: string): string[] {
  const docMappings = getSectionMappings(documentType);
  const sections: string[] = [];
  for (const mapping of docMappings.mappings) {
    if (mapping.category_ids.includes(categoryId)) {
      sections.push(mapping.section_id);
    }
  }
  return sections;
}

/**
 * Returns true if the document should use document-level scoring
 * (word count below threshold or no mappings exist).
 */
export function shouldUseDocumentLevelScoring(documentType: DocumentType, wordCount: number): boolean {
  const mappings = MAPPINGS_REGISTRY[documentType];
  if (!mappings) {
    return true;
  }
  return wordCount < mappings.word_count_threshold;
}
