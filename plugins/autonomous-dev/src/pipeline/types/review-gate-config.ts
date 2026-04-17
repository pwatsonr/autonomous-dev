import { DocumentType } from './document-type';

export interface ReviewGateConfig {
  /** Number of reviewer agents on the panel */
  panelSize: number;
  /** Maximum review-revision iterations before escalation */
  maxIterations: number;
  /** Minimum aggregate score to pass the gate (0-100) */
  approvalThreshold: number;
  /** Score delta below which quality regression is flagged */
  regressionMargin: number;
}

/**
 * Default review gate configuration per document type.
 * Values from TDD Section 3.1.3.
 */
export const DEFAULT_REVIEW_GATE_CONFIGS: Record<DocumentType, ReviewGateConfig> = {
  [DocumentType.PRD]: { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.TDD]: { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.PLAN]: { panelSize: 1, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.SPEC]: { panelSize: 1, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.CODE]: { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
};
