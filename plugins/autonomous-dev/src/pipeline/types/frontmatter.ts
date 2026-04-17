import { DocumentType } from './document-type';

export type DocumentStatus =
  | 'draft'
  | 'in-review'
  | 'approved'
  | 'revision-requested'
  | 'rejected'
  | 'cancelled'
  | 'stale';

export type ExecutionMode = 'parallel' | 'sequential';
export type DependencyType = 'blocks' | 'informs';
export type Priority = 'critical' | 'high' | 'normal' | 'low';

export type VersionReason =
  | 'INITIAL'
  | 'REVIEW_REVISION'
  | 'BACKWARD_CASCADE'
  | 'ROLLBACK';

export interface DocumentFrontmatter {
  /** Document ID, e.g. "PRD-001" or "TDD-001-01" */
  id: string;
  /** Title of the document */
  title: string;
  /** Pipeline this document belongs to */
  pipeline_id: string;
  /** Document type */
  type: DocumentType;
  /** Current status */
  status: DocumentStatus;
  /** Current version string, e.g. "1.0" */
  version: string;
  /** ISO 8601 creation timestamp */
  created_at: string;
  /** ISO 8601 last-update timestamp */
  updated_at: string;
  /** Agent ID that authored or last revised this document */
  author_agent: string;
  /** Parent document ID (null for root PRDs) */
  parent_id: string | null;
  /** Array of section IDs in the parent that this document addresses */
  traces_from: string[];
  /** Array of child document IDs produced by decomposition */
  traces_to: string[];
  /** Depth in pipeline (0 = PRD, 4 = CODE) */
  depth: number;
  /** 0-based index among siblings */
  sibling_index: number;
  /** Total number of siblings in this decomposition */
  sibling_count: number;
  /** IDs of sibling documents this one depends on */
  depends_on: string[];
  /** Type of each dependency (parallel array with depends_on) */
  dependency_type: DependencyType[];
  /** Whether this document can execute in parallel or must be sequential */
  execution_mode: ExecutionMode;
  /** Pipeline priority */
  priority: Priority;
}

/** All valid DocumentStatus values */
export const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  'draft',
  'in-review',
  'approved',
  'revision-requested',
  'rejected',
  'cancelled',
  'stale',
] as const;

/** All valid ExecutionMode values */
export const EXECUTION_MODES: readonly ExecutionMode[] = [
  'parallel',
  'sequential',
] as const;

/** All valid DependencyType values */
export const DEPENDENCY_TYPES: readonly DependencyType[] = [
  'blocks',
  'informs',
] as const;

/** All valid Priority values */
export const PRIORITIES: readonly Priority[] = [
  'critical',
  'high',
  'normal',
  'low',
] as const;

/** Required fields that must always be present */
export const REQUIRED_FIELDS: readonly (keyof DocumentFrontmatter)[] = [
  'id',
  'title',
  'pipeline_id',
  'type',
  'status',
  'version',
  'created_at',
  'updated_at',
  'author_agent',
  'depth',
  'sibling_index',
  'sibling_count',
  'execution_mode',
  'priority',
] as const;

/** All known fields in the schema */
export const ALL_KNOWN_FIELDS: readonly string[] = [
  'id',
  'title',
  'pipeline_id',
  'type',
  'status',
  'version',
  'created_at',
  'updated_at',
  'author_agent',
  'parent_id',
  'traces_from',
  'traces_to',
  'depth',
  'sibling_index',
  'sibling_count',
  'depends_on',
  'dependency_type',
  'execution_mode',
  'priority',
] as const;
