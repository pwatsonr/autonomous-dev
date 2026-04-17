import { DocumentType } from './document-type';
import { ReviewGateConfig } from './review-gate-config';

export interface PipelineConfig {
  pipeline: {
    /** Maximum depth of the pipeline tree (hardcoded to 4, not configurable) */
    maxDepth: 4;
    /** Root directory for pipeline storage */
    rootDir: string;
  };
  decomposition: {
    /** Maximum children per decomposition */
    maxChildrenPerDecomposition: number;
    /** Maximum total nodes in a pipeline */
    maxTotalNodes: number;
    /** Explosion threshold percentage of maxTotalNodes */
    explosionThresholdPercent: number;
    /** Whether smoke test is required for decomposition */
    smokeTestRequired: boolean;
  };
  versioning: {
    /** Maximum versions per document */
    maxVersionsPerDocument: number;
  };
  reviewGates: {
    /** Default config applied when no per-type override exists */
    defaults: ReviewGateConfig;
    /** Per-type overrides (merged on top of defaults) */
    overrides: Partial<Record<DocumentType, Partial<ReviewGateConfig>>>;
  };
  backwardCascade: {
    /** Maximum cascade depth before human escalation */
    maxDepth: number;
    /** Whether to auto-approve unaffected children after cascade */
    autoApproveUnaffected: boolean;
  };
  storage: {
    /** Maximum documents per pipeline */
    maxDocumentsPerPipeline: number;
    /** Maximum versions per document */
    maxVersionsPerDocument: number;
    /** Maximum total pipeline size in bytes */
    maxTotalSizeBytes: number;
    /** Maximum single document size in bytes */
    maxDocumentSizeBytes: number;
  };
  traceability: {
    /** Whether gap detection runs at review gates */
    gapDetectionAtGates: boolean;
    /** Whether orphan detection runs at review gates */
    orphanDetectionAtGates: boolean;
  };
}

/**
 * Default configuration values.
 * Every field has a default so config.yaml is entirely optional.
 */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  pipeline: {
    maxDepth: 4,
    rootDir: '.autonomous-dev/pipelines',
  },
  decomposition: {
    maxChildrenPerDecomposition: 10,
    maxTotalNodes: 100,
    explosionThresholdPercent: 75,
    smokeTestRequired: true,
  },
  versioning: {
    maxVersionsPerDocument: 20,
  },
  reviewGates: {
    defaults: {
      panelSize: 1,
      maxIterations: 3,
      approvalThreshold: 85,
      regressionMargin: 5,
    },
    overrides: {},
  },
  backwardCascade: {
    maxDepth: 2,
    autoApproveUnaffected: true,
  },
  storage: {
    maxDocumentsPerPipeline: 100,
    maxVersionsPerDocument: 20,
    maxTotalSizeBytes: 500 * 1024 * 1024, // 500 MB
    maxDocumentSizeBytes: 1 * 1024 * 1024, // 1 MB
  },
  traceability: {
    gapDetectionAtGates: true,
    orphanDetectionAtGates: true,
  },
};
