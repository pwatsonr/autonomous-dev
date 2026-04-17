import { DocumentType, getDepth, getChildType, getParentType } from '../types/document-type';
import {
  DocumentTypeDefinition,
  DecompositionStrategy,
  ReviewGateDefaults,
} from '../types/document-type-definition';
import { QualityRubric } from '../types/quality-rubric';

/**
 * Default rubric for PRD documents.
 * Categories: completeness, clarity, feasibility, alignment.
 */
const PRD_RUBRIC: QualityRubric = {
  documentType: 'PRD',
  version: '1.0.0',
  aggregationMethod: 'mean',
  categories: [
    {
      id: 'completeness',
      name: 'Completeness',
      description: 'All required sections are present and filled out with sufficient detail.',
      weight: 0.3,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Major sections missing or empty.' },
        { min: 50, max: 69, description: 'Some sections incomplete or lacking detail.' },
        { min: 70, max: 84, description: 'All sections present with adequate detail.' },
        { min: 85, max: 100, description: 'Comprehensive coverage with thorough detail.' },
      ],
    },
    {
      id: 'clarity',
      name: 'Clarity',
      description: 'Requirements are unambiguous and clearly stated.',
      weight: 0.3,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Requirements are vague or contradictory.' },
        { min: 50, max: 69, description: 'Some ambiguity in key requirements.' },
        { min: 70, max: 84, description: 'Requirements are clear and testable.' },
        { min: 85, max: 100, description: 'Crystal clear with measurable acceptance criteria.' },
      ],
    },
    {
      id: 'feasibility',
      name: 'Feasibility',
      description: 'Requirements are technically achievable within stated constraints.',
      weight: 0.2,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 49, description: 'Requirements are unrealistic or contradictory.' },
        { min: 50, max: 69, description: 'Some requirements may be difficult to achieve.' },
        { min: 70, max: 84, description: 'Requirements are achievable with known approaches.' },
        { min: 85, max: 100, description: 'Clear path to implementation with proven patterns.' },
      ],
    },
    {
      id: 'alignment',
      name: 'Alignment',
      description: 'Requirements align with project goals and user needs.',
      weight: 0.2,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 49, description: 'Disconnected from project goals or user needs.' },
        { min: 50, max: 69, description: 'Partial alignment with some gaps.' },
        { min: 70, max: 84, description: 'Well-aligned with clear traceability.' },
        { min: 85, max: 100, description: 'Strongly aligned with strategic vision.' },
      ],
    },
  ],
};

/**
 * Default rubric for TDD documents.
 * Categories: completeness, technical_depth, testability, consistency.
 */
const TDD_RUBRIC: QualityRubric = {
  documentType: 'TDD',
  version: '1.0.0',
  aggregationMethod: 'mean',
  categories: [
    {
      id: 'completeness',
      name: 'Completeness',
      description: 'All architectural decisions, interfaces, and data models are documented.',
      weight: 0.25,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Major architectural areas undocumented.' },
        { min: 50, max: 69, description: 'Key interfaces or models missing.' },
        { min: 70, max: 84, description: 'All major components documented.' },
        { min: 85, max: 100, description: 'Exhaustive coverage of all technical decisions.' },
      ],
    },
    {
      id: 'technical_depth',
      name: 'Technical Depth',
      description: 'Sufficient technical detail for implementation without ambiguity.',
      weight: 0.3,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Surface-level descriptions only.' },
        { min: 50, max: 69, description: 'Some areas lack implementation detail.' },
        { min: 70, max: 84, description: 'Sufficient detail for experienced developers.' },
        { min: 85, max: 100, description: 'Implementation-ready with concrete examples.' },
      ],
    },
    {
      id: 'testability',
      name: 'Testability',
      description: 'Design enables thorough testing at all levels.',
      weight: 0.2,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 49, description: 'Design is difficult to test.' },
        { min: 50, max: 69, description: 'Some components hard to test in isolation.' },
        { min: 70, max: 84, description: 'Clear test boundaries and strategies.' },
        { min: 85, max: 100, description: 'Comprehensive test plan with isolation patterns.' },
      ],
    },
    {
      id: 'consistency',
      name: 'Consistency',
      description: 'Technical decisions are consistent with each other and the PRD.',
      weight: 0.25,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 49, description: 'Contradictory decisions or PRD misalignment.' },
        { min: 50, max: 69, description: 'Minor inconsistencies between sections.' },
        { min: 70, max: 84, description: 'Consistent design with PRD traceability.' },
        { min: 85, max: 100, description: 'Fully coherent with explicit PRD mapping.' },
      ],
    },
  ],
};

/**
 * Default rubric for PLAN documents.
 * Categories: completeness, decomposition, dependency_clarity, estimation.
 */
const PLAN_RUBRIC: QualityRubric = {
  documentType: 'PLAN',
  version: '1.0.0',
  aggregationMethod: 'mean',
  categories: [
    {
      id: 'completeness',
      name: 'Completeness',
      description: 'All tasks from the TDD are represented in the plan.',
      weight: 0.25,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Significant TDD items missing from plan.' },
        { min: 50, max: 69, description: 'Some TDD items not represented.' },
        { min: 70, max: 84, description: 'All major TDD items have corresponding tasks.' },
        { min: 85, max: 100, description: 'Complete bidirectional TDD-to-task mapping.' },
      ],
    },
    {
      id: 'decomposition',
      name: 'Decomposition',
      description: 'Tasks are appropriately sized and decomposed.',
      weight: 0.25,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 49, description: 'Tasks are too large or too granular.' },
        { min: 50, max: 69, description: 'Some tasks need further decomposition.' },
        { min: 70, max: 84, description: 'Tasks are well-sized for single implementation.' },
        { min: 85, max: 100, description: 'Optimal decomposition with clear boundaries.' },
      ],
    },
    {
      id: 'dependency_clarity',
      name: 'Dependency Clarity',
      description: 'Task dependencies and ordering are explicit and correct.',
      weight: 0.3,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Dependencies unclear or circular.' },
        { min: 50, max: 69, description: 'Some implicit dependencies not stated.' },
        { min: 70, max: 84, description: 'Dependencies explicit with clear ordering.' },
        { min: 85, max: 100, description: 'Dependency graph is complete and verified.' },
      ],
    },
    {
      id: 'estimation',
      name: 'Estimation',
      description: 'Effort estimates are realistic and account for complexity.',
      weight: 0.2,
      minimumScore: 50,
      scoringGuide: [
        { min: 0, max: 49, description: 'Estimates are missing or wildly unrealistic.' },
        { min: 50, max: 69, description: 'Estimates present but may be optimistic.' },
        { min: 70, max: 84, description: 'Realistic estimates with complexity factors.' },
        { min: 85, max: 100, description: 'Data-backed estimates with contingency.' },
      ],
    },
  ],
};

/**
 * Default rubric for SPEC documents.
 * Categories: completeness, precision, testability, traceability.
 */
const SPEC_RUBRIC: QualityRubric = {
  documentType: 'SPEC',
  version: '1.0.0',
  aggregationMethod: 'mean',
  categories: [
    {
      id: 'completeness',
      name: 'Completeness',
      description: 'All plan tasks are fully specified with implementation details.',
      weight: 0.25,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Major implementation details missing.' },
        { min: 50, max: 69, description: 'Some tasks lack full specification.' },
        { min: 70, max: 84, description: 'All tasks specified with adequate detail.' },
        { min: 85, max: 100, description: 'Exhaustive specification ready for coding.' },
      ],
    },
    {
      id: 'precision',
      name: 'Precision',
      description: 'Specifications are exact enough for direct code translation.',
      weight: 0.3,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Specifications require significant interpretation.' },
        { min: 50, max: 69, description: 'Some areas open to interpretation.' },
        { min: 70, max: 84, description: 'Clear enough for implementation.' },
        { min: 85, max: 100, description: 'Pseudo-code-level precision throughout.' },
      ],
    },
    {
      id: 'testability',
      name: 'Testability',
      description: 'Test cases and acceptance criteria are defined for each task.',
      weight: 0.25,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'No test cases or acceptance criteria.' },
        { min: 50, max: 69, description: 'Some tasks missing test definitions.' },
        { min: 70, max: 84, description: 'Test cases defined for all major tasks.' },
        { min: 85, max: 100, description: 'Comprehensive test matrix with edge cases.' },
      ],
    },
    {
      id: 'traceability',
      name: 'Traceability',
      description: 'Each spec item traces back to a plan task and TDD section.',
      weight: 0.2,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 49, description: 'No traceability to parent documents.' },
        { min: 50, max: 69, description: 'Partial traceability with gaps.' },
        { min: 70, max: 84, description: 'Clear traceability to plan and TDD.' },
        { min: 85, max: 100, description: 'Full bidirectional traceability matrix.' },
      ],
    },
  ],
};

/**
 * Default rubric for CODE artifacts.
 * Categories: correctness, test_coverage, code_quality, spec_compliance.
 */
const CODE_RUBRIC: QualityRubric = {
  documentType: 'CODE',
  version: '1.0.0',
  aggregationMethod: 'mean',
  categories: [
    {
      id: 'correctness',
      name: 'Correctness',
      description: 'Code produces correct results for all specified inputs.',
      weight: 0.3,
      minimumScore: 80,
      scoringGuide: [
        { min: 0, max: 49, description: 'Fundamental logic errors present.' },
        { min: 50, max: 69, description: 'Works for happy path but edge cases fail.' },
        { min: 70, max: 84, description: 'Correct for all specified scenarios.' },
        { min: 85, max: 100, description: 'Provably correct with defensive handling.' },
      ],
    },
    {
      id: 'test_coverage',
      name: 'Test Coverage',
      description: 'Tests cover all specified behaviors and edge cases.',
      weight: 0.25,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Minimal or no tests.' },
        { min: 50, max: 69, description: 'Happy path covered, edge cases missing.' },
        { min: 70, max: 84, description: 'Good coverage of specified behaviors.' },
        { min: 85, max: 100, description: 'Comprehensive with edge cases and error paths.' },
      ],
    },
    {
      id: 'code_quality',
      name: 'Code Quality',
      description: 'Code follows project standards, is readable, and maintainable.',
      weight: 0.2,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 49, description: 'Unreadable or violates project standards.' },
        { min: 50, max: 69, description: 'Mostly readable with some style issues.' },
        { min: 70, max: 84, description: 'Clean, well-structured, follows standards.' },
        { min: 85, max: 100, description: 'Exemplary code with clear abstractions.' },
      ],
    },
    {
      id: 'spec_compliance',
      name: 'Spec Compliance',
      description: 'Implementation matches the specification exactly.',
      weight: 0.25,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Significant deviations from spec.' },
        { min: 50, max: 69, description: 'Some spec items not implemented correctly.' },
        { min: 70, max: 84, description: 'All spec items implemented correctly.' },
        { min: 85, max: 100, description: 'Exact spec compliance with no deviations.' },
      ],
    },
  ],
};

/** Review gate defaults per document type (from TDD Section 3.1.3) */
const REVIEW_CONFIGS: Record<DocumentType, { panelSize: number; maxIterations: number; approvalThreshold: number; regressionMargin: number }> = {
  [DocumentType.PRD]: { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.TDD]: { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.PLAN]: { panelSize: 1, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.SPEC]: { panelSize: 1, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.CODE]: { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
};

/** Decomposition strategies per document type */
const DECOMPOSITION_STRATEGIES: Record<DocumentType, DecompositionStrategy | null> = {
  [DocumentType.PRD]: 'domain',
  [DocumentType.TDD]: 'phase',
  [DocumentType.PLAN]: 'task',
  [DocumentType.SPEC]: 'direct',
  [DocumentType.CODE]: null,
};

/** Human-readable labels per document type */
const LABELS: Record<DocumentType, string> = {
  [DocumentType.PRD]: 'Product Requirements Document',
  [DocumentType.TDD]: 'Technical Design Document',
  [DocumentType.PLAN]: 'Implementation Plan',
  [DocumentType.SPEC]: 'Implementation Specification',
  [DocumentType.CODE]: 'Code',
};

/** Template IDs per document type */
const TEMPLATE_IDS: Record<DocumentType, string> = {
  [DocumentType.PRD]: 'template-prd',
  [DocumentType.TDD]: 'template-tdd',
  [DocumentType.PLAN]: 'template-plan',
  [DocumentType.SPEC]: 'template-spec',
  [DocumentType.CODE]: 'template-code',
};

/** Rubrics per document type */
const RUBRICS: Record<DocumentType, QualityRubric> = {
  [DocumentType.PRD]: PRD_RUBRIC,
  [DocumentType.TDD]: TDD_RUBRIC,
  [DocumentType.PLAN]: PLAN_RUBRIC,
  [DocumentType.SPEC]: SPEC_RUBRIC,
  [DocumentType.CODE]: CODE_RUBRIC,
};

export class DocumentTypeRegistry {
  private definitions: Map<DocumentType, DocumentTypeDefinition>;

  constructor() {
    this.definitions = new Map();
    this.registerAll();
  }

  /**
   * Returns the definition for the given document type.
   * @throws Error if type is not registered.
   */
  getDefinition(type: DocumentType): DocumentTypeDefinition {
    const def = this.definitions.get(type);
    if (!def) {
      throw new Error(`No definition registered for document type: ${type}`);
    }
    return def;
  }

  /**
   * Returns all five registered definitions.
   */
  getAllDefinitions(): DocumentTypeDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Internal: registers all five document type definitions.
   * Called by constructor.
   */
  private registerAll(): void {
    const types = [
      DocumentType.PRD,
      DocumentType.TDD,
      DocumentType.PLAN,
      DocumentType.SPEC,
      DocumentType.CODE,
    ];

    for (const type of types) {
      const definition: DocumentTypeDefinition = {
        type,
        label: LABELS[type],
        depth: getDepth(type),
        childType: getChildType(type),
        parentType: getParentType(type),
        templateId: TEMPLATE_IDS[type],
        rubric: RUBRICS[type],
        reviewConfig: REVIEW_CONFIGS[type],
        decompositionStrategy: DECOMPOSITION_STRATEGIES[type],
      };
      this.definitions.set(type, definition);
    }
  }
}

/** Singleton instance for global access */
export const documentTypeRegistry = new DocumentTypeRegistry();
