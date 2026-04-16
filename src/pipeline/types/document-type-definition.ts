import { DocumentType } from './document-type';
import { QualityRubric } from './quality-rubric';

export type DecompositionStrategy = 'domain' | 'phase' | 'task' | 'direct';

export interface ReviewGateDefaults {
  panelSize: number;
  maxIterations: number;
  approvalThreshold: number;
  regressionMargin: number;
}

export interface DocumentTypeDefinition {
  /** The document type enum value */
  type: DocumentType;
  /** Human-readable label */
  label: string;
  /** Depth in the pipeline (0 = PRD, 4 = CODE) */
  depth: number;
  /** The type of children produced by decomposition, null for CODE */
  childType: DocumentType | null;
  /** The type of the parent, null for PRD */
  parentType: DocumentType | null;
  /** Template ID for rendering blank documents */
  templateId: string;
  /** Quality rubric for review scoring */
  rubric: QualityRubric;
  /** Default review gate configuration */
  reviewConfig: ReviewGateDefaults;
  /** Strategy used when decomposing this type into children */
  decompositionStrategy: DecompositionStrategy | null;
}
