import { DocumentType } from '../types/document-type';

export type CascadeStatus =
  | 'initiated'
  | 'parent_revised'
  | 'children_re_evaluated'
  | 'resolved'
  | 'escalated';

export interface AffectedDocument {
  documentId: string;
  type: DocumentType;
  previousStatus: string;
  newStatus: string;
}

export interface BackwardCascadeEvent {
  /** Cascade event ID: CASCADE-{PIPE_SEQ}-{SEQ} */
  id: string;
  /** Pipeline this cascade belongs to */
  pipelineId: string;
  /** What triggered the cascade */
  triggeredBy: {
    /** The review that found the defect */
    reviewId: string;
    /** The specific finding in the review */
    findingDescription: string;
    /** The reviewer agent */
    reviewerAgent: string;
  };
  /** The document containing the defect */
  targetDocument: {
    documentId: string;
    type: DocumentType;
    /** Section IDs in the target that are affected */
    affectedSections: string[];
  };
  /** Documents affected by the cascade */
  affectedDocuments: AffectedDocument[];
  /** Current status of the cascade */
  status: CascadeStatus;
  /** Current cascade depth (1 = direct parent, 2 = grandparent, etc.) */
  cascadeDepth: number;
  /** Maximum cascade depth allowed */
  maxDepth: number;
  /** ISO 8601 timestamps for each status transition */
  timestamps: {
    initiated: string;
    parentRevised?: string;
    childrenReEvaluated?: string;
    resolved?: string;
    escalated?: string;
  };
}

/**
 * Generates a cascade event ID.
 * Format: CASCADE-{PIPE_SEQ}-{SEQ}
 * Where PIPE_SEQ is extracted from the pipeline ID and SEQ is incremented.
 */
export function generateCascadeId(pipelineId: string, sequence: number): string {
  const pipeSeq = pipelineId.split('-').pop()!;
  return `CASCADE-${pipeSeq}-${String(sequence).padStart(3, '0')}`;
}
