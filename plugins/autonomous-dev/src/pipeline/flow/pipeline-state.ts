import { DocumentType } from '../types/document-type';
import { DocumentStatus, Priority } from '../types/frontmatter';

export type PipelineStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export interface DocumentState {
  /** Document ID */
  documentId: string;
  /** Document type */
  type: DocumentType;
  /** Current lifecycle status */
  status: DocumentStatus;
  /** Current version string */
  version: string;
  /** Current review iteration (1-based, 0 if never reviewed) */
  reviewIteration: number;
  /** Last review aggregate score (null if never reviewed) */
  lastReviewScore: number | null;
  /** Agent currently assigned to this document (null if unassigned) */
  assignedAgent: string | null;
  /** Parent document ID */
  parentId: string | null;
  /** Child document IDs */
  children: string[];
  /** Document IDs that block this document */
  blockedBy: string[];
  /** Document IDs that this document blocks */
  blocking: string[];
}

export interface PipelineState {
  /** Pipeline ID */
  pipelineId: string;
  /** Pipeline title */
  title: string;
  /** Current status */
  status: PipelineStatus;
  /** Priority */
  priority: Priority;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last update timestamp */
  updatedAt: string;
  /** ISO 8601 timestamp when paused (null if not paused) */
  pausedAt: string | null;
  /** Per-document states keyed by document ID */
  documentStates: Record<string, DocumentState>;
  /** Active backward cascade event IDs */
  activeCascades: string[];
  /** Pipeline metrics */
  metrics: PipelineMetrics;
}

export interface PipelineMetrics {
  totalDocuments: number;
  documentsByStatus: Record<string, number>;
  totalVersions: number;
  totalReviews: number;
}

/**
 * Creates an initial empty PipelineState.
 */
export function createInitialPipelineState(
  pipelineId: string,
  title: string,
  priority: Priority = 'normal',
): PipelineState {
  const now = new Date().toISOString();
  return {
    pipelineId,
    title,
    status: 'ACTIVE',
    priority,
    createdAt: now,
    updatedAt: now,
    pausedAt: null,
    documentStates: {},
    activeCascades: [],
    metrics: {
      totalDocuments: 0,
      documentsByStatus: {},
      totalVersions: 0,
      totalReviews: 0,
    },
  };
}
