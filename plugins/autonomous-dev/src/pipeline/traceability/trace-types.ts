import { DocumentType } from '../types/document-type';

export type TraceLinkType = 'implements' | 'addresses' | 'tests' | 'derived_from';
export type TraceLinkStatus = 'active' | 'stale' | 'orphaned';
export type GapSeverity = 'critical' | 'warning';

export interface TraceLink {
  /** Source document ID */
  sourceId: string;
  /** Source document type */
  sourceType: DocumentType;
  /** Source section ID (the requirement/section being traced) */
  sourceSectionId: string;
  /** Target document ID */
  targetId: string;
  /** Target document type */
  targetType: DocumentType;
  /** Link type */
  linkType: TraceLinkType;
  /** Link status */
  status: TraceLinkStatus;
}

export interface TraceChainEntry {
  /** Document ID at this level */
  documentId: string;
  /** Document type at this level */
  type: DocumentType;
  /** Section ID being traced at this level */
  sectionId: string;
  /** Status of the document */
  status: string;
}

export interface TraceChain {
  /** The originating requirement (PRD section) */
  requirementId: string;
  /** Entry at each pipeline level: PRD -> TDD -> Plan -> Spec -> Code */
  entries: {
    prd: TraceChainEntry | null;
    tdd: TraceChainEntry | null;
    plan: TraceChainEntry | null;
    spec: TraceChainEntry | null;
    code: TraceChainEntry | null;
  };
  /** Whether the chain is complete (has entries at every level that has been reached) */
  complete: boolean;
  /** Gaps in the chain */
  gaps: TraceGap[];
}

export interface TraceGap {
  /** Requirement/section ID with missing coverage */
  sourceId: string;
  /** Source document type */
  sourceType: DocumentType;
  /** Source section ID */
  sourceSectionId: string;
  /** Pipeline level where coverage is missing */
  missingAtLevel: DocumentType;
  /** Severity: critical if no downstream trace at a reached level */
  severity: GapSeverity;
  /** Human-readable description */
  description: string;
}

export interface TraceabilityMatrix {
  /** All trace links in the pipeline */
  links: TraceLink[];
  /** Forward chains from PRD requirements through to code */
  chains: TraceChain[];
  /** Detected gaps */
  gaps: TraceGap[];
  /** Orphaned document IDs */
  orphans: string[];
  /** ISO 8601 timestamp of last regeneration */
  regeneratedAt: string;
}
