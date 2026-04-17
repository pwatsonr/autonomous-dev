/**
 * Core type definitions for the review gate system.
 *
 * Defines all interfaces and type unions used by the review gate pipeline,
 * including review outputs, findings, scores, gate records, and rubric
 * persistence models.
 *
 * Based on TDD-004 sections 3.2.1, 3.6.3, 3.7.1, 4.1, 4.2.
 */

// ---------------------------------------------------------------------------
// Type unions
// ---------------------------------------------------------------------------

/** The five document types in the pipeline. */
export type DocumentType = 'PRD' | 'TDD' | 'Plan' | 'Spec' | 'Code';

/** Valid DocumentType values for runtime validation. */
export const DOCUMENT_TYPES: readonly DocumentType[] = [
  'PRD',
  'TDD',
  'Plan',
  'Spec',
  'Code',
] as const;

/** Trust level governing how much human approval is required. */
export type TrustLevel =
  | 'full_auto'
  | 'approve_roots'
  | 'approve_phase_1'
  | 'approve_all'
  | 'human_only';

/** Valid TrustLevel values for runtime validation. */
export const TRUST_LEVELS: readonly TrustLevel[] = [
  'full_auto',
  'approve_roots',
  'approve_phase_1',
  'approve_all',
  'human_only',
] as const;

/** Severity level of a review finding. */
export type FindingSeverity = 'critical' | 'major' | 'minor' | 'suggestion';

/** Valid FindingSeverity values for runtime validation. */
export const FINDING_SEVERITIES: readonly FindingSeverity[] = [
  'critical',
  'major',
  'minor',
  'suggestion',
] as const;

/** Sub-classification for critical findings. */
export type CriticalSub = 'blocking' | 'reject';

/** Valid CriticalSub values for runtime validation. */
export const CRITICAL_SUBS: readonly CriticalSub[] = [
  'blocking',
  'reject',
] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Returns true if `value` is a valid DocumentType. */
export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

/** Returns true if `value` is a valid TrustLevel. */
export function isTrustLevel(value: unknown): value is TrustLevel {
  return typeof value === 'string' && (TRUST_LEVELS as readonly string[]).includes(value);
}

/** Returns true if `value` is a valid FindingSeverity. */
export function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(value);
}

/** Returns true if `value` is a valid CriticalSub. */
export function isCriticalSub(value: unknown): value is CriticalSub {
  return typeof value === 'string' && (CRITICAL_SUBS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Calibration & Rubric
// ---------------------------------------------------------------------------

/** Calibration examples anchoring 0, 50, and 100 scores for a category. */
export interface CalibrationExamples {
  score_0: string;
  score_50: string;
  score_100: string;
}

/** A single scoring category within a rubric. */
export interface RubricCategory {
  /** Unique category identifier, e.g. 'problem_clarity'. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Weight as a percentage, e.g. 15 means 15%. */
  weight: number;
  /** Description of what this category measures. */
  description: string;
  /** Minimum acceptable score for this category (0-100), or null if none. */
  min_threshold: number | null;
  /** Calibration examples anchoring 0, 50, and 100 scores. */
  calibration: CalibrationExamples;
}

/** A complete rubric definition for a document type. */
export interface Rubric {
  /** The document type this rubric applies to. */
  document_type: DocumentType;
  /** Semantic version of this rubric. */
  version: string;
  /** Minimum aggregate score to pass the gate (0-100). */
  approval_threshold: number;
  /** Scoring categories. Weights must sum to 100. */
  categories: RubricCategory[];
  /** Invariant: must always equal 100. Enforced at runtime. */
  total_weight: 100;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Score for an individual section within a category. */
export interface SectionScore {
  /** Section identifier. */
  section_id: string;
  /** Score from 0-100 (integer). */
  score: number;
}

/** Score for a single rubric category from one reviewer. */
export interface CategoryScore {
  /** Matches a RubricCategory.id. */
  category_id: string;
  /** Score from 0-100 (integer). */
  score: number;
  /** Per-section breakdown, or null for document-level scoring. */
  section_scores: SectionScore[] | null;
  /** Reviewer's justification for the score. */
  justification: string;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** A single finding from a reviewer. */
export interface Finding {
  /** Unique finding identifier. */
  id: string;
  /** Section where the finding was located. */
  section_id: string;
  /** Category the finding belongs to. */
  category_id: string;
  /** Severity level. */
  severity: FindingSeverity;
  /** Sub-classification for critical findings, null for non-critical. */
  critical_sub: CriticalSub | null;
  /** Whether this finding is caused by an upstream document defect. */
  upstream_defect: boolean;
  /** Description of the issue found. */
  description: string;
  /** Evidence supporting the finding. */
  evidence: string;
  /** Suggested resolution. */
  suggested_resolution: string;
}

// ---------------------------------------------------------------------------
// Review output
// ---------------------------------------------------------------------------

/** Complete output from a single reviewer. */
export interface ReviewOutput {
  /** Unique reviewer identifier. */
  reviewer_id: string;
  /** Role of the reviewer (e.g. 'architect', 'domain_expert'). */
  reviewer_role: string;
  /** Document being reviewed. */
  document_id: string;
  /** Version of the document being reviewed. */
  document_version: string;
  /** ISO 8601 timestamp of the review. */
  timestamp: string;
  /** Whether scoring is per-section or document-level. */
  scoring_mode: 'per_section' | 'document_level';
  /** Scores for each rubric category. */
  category_scores: CategoryScore[];
  /** Findings from this reviewer. */
  findings: Finding[];
  /** Summary of the review. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Aggregated scores for a single category across all reviewers. */
export interface CategoryAggregate {
  /** Matches a RubricCategory.id. */
  category_id: string;
  /** Human-readable category name. */
  category_name: string;
  /** Category weight (percentage). */
  weight: number;
  /** Aggregated score across all reviewers. */
  aggregate_score: number;
  /** Individual scores from each reviewer. */
  per_reviewer_scores: { reviewer_id: string; score: number }[];
  /** Minimum acceptable threshold, or null if none. */
  min_threshold: number | null;
  /** Whether the aggregate score violates the minimum threshold. */
  threshold_violated: boolean;
}

/** A finding merged across multiple reviewers. */
export interface MergedFinding {
  /** Unique finding identifier. */
  id: string;
  /** Section where the finding was located. */
  section_id: string;
  /** Category the finding belongs to. */
  category_id: string;
  /** Severity level. */
  severity: FindingSeverity;
  /** Sub-classification for critical findings. */
  critical_sub: CriticalSub | null;
  /** Whether this finding is caused by an upstream document defect. */
  upstream_defect: boolean;
  /** Description of the issue found. */
  description: string;
  /** Evidence supporting the finding. */
  evidence: string;
  /** Suggested resolution. */
  suggested_resolution: string;
  /** IDs of reviewers who reported this finding. */
  reported_by: string[];
  /** Resolution status across iterations. */
  resolution_status: 'open' | 'resolved' | 'recurred' | null;
  /** ID of the finding from a prior iteration, if this is a recurrence. */
  prior_finding_id: string | null;
}

/** A disagreement between reviewers on a category score. */
export interface Disagreement {
  /** Category where disagreement was detected. */
  category_id: string;
  /** Variance (spread) of reviewer scores. */
  variance: number;
  /** Individual scores from each reviewer. */
  reviewer_scores: { reviewer_id: string; score: number }[];
  /** Human-readable note about the disagreement. */
  note: string;
}

/** Quality regression detected between iterations. */
export interface QualityRegression {
  /** Score from the previous iteration. */
  previous_score: number;
  /** Score from the current iteration. */
  current_score: number;
  /** Difference (current - previous). */
  delta: number;
  /** Whether a rollback is recommended. */
  rollback_recommended: boolean;
}

// ---------------------------------------------------------------------------
// Gate result
// ---------------------------------------------------------------------------

/** Result of a review gate evaluation. */
export interface GateReviewResult {
  /** Unique gate identifier. */
  gate_id: string;
  /** Document being reviewed. */
  document_id: string;
  /** Version of the document. */
  document_version: string;
  /** Current iteration number. */
  iteration: number;
  /** Gate outcome. */
  outcome: 'approved' | 'changes_requested' | 'rejected';
  /** Weighted aggregate score (0-100). */
  aggregate_score: number;
  /** Approval threshold used. */
  threshold: number;
  /** Method used to aggregate reviewer scores. */
  aggregation_method: 'mean' | 'median' | 'min';
  /** Per-category aggregated scores. */
  category_aggregates: CategoryAggregate[];
  /** Merged findings across all reviewers. */
  findings: MergedFinding[];
  /** Disagreements between reviewers. */
  disagreements: Disagreement[];
  /** Quality regression from prior iteration, or null if first iteration. */
  quality_regression: QualityRegression | null;
  /** Whether score improvement has stagnated. */
  stagnation_warning: boolean;
  /** Summary of the gate result. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Gate record (persistence)
// ---------------------------------------------------------------------------

/** Complete persisted record of a review gate execution. */
export interface ReviewGateRecord {
  /** Unique gate identifier. */
  gate_id: string;
  /** Document being reviewed. */
  document_id: string;
  /** Document type. */
  document_type: DocumentType;
  /** Version of the document. */
  document_version: string;
  /** Pipeline run identifier. */
  pipeline_id: string;
  /** Current iteration number. */
  iteration: number;
  /** Maximum iterations allowed. */
  max_iterations: number;
  /** Version of the rubric used. */
  rubric_version: string;
  /** Approval threshold used. */
  threshold: number;
  /** Method used to aggregate reviewer scores. */
  aggregation_method: 'mean' | 'median' | 'min';
  /** Number of reviewers on the panel. */
  panel_size: number;
  /** Trust level governing approval flow. */
  trust_level: TrustLevel;
  /** Raw outputs from each reviewer. */
  reviewer_outputs: ReviewOutput[];
  /** Weighted aggregate score (0-100). */
  aggregate_score: number;
  /** Per-category aggregated scores. */
  category_aggregates: CategoryAggregate[];
  /** Gate outcome. */
  outcome: 'approved' | 'changes_requested' | 'rejected';
  /** Merged findings across all reviewers. */
  merged_findings: MergedFinding[];
  /** Disagreements between reviewers. */
  disagreements: Disagreement[];
  /** Quality regression from prior iteration, or null. */
  quality_regression: QualityRegression | null;
  /** Whether score improvement has stagnated. */
  stagnation_warning: boolean;
  /** Whether human escalation was triggered. */
  human_escalation: boolean;
  /** ISO 8601 timestamp when the gate started. */
  started_at: string;
  /** ISO 8601 timestamp when the gate completed. */
  completed_at: string;
  /** Identifier of the entity that created this record. */
  created_by: string;
}

// ---------------------------------------------------------------------------
// Persisted rubric (storage model)
// ---------------------------------------------------------------------------

/** Persisted rubric category with section mapping metadata. */
export interface PersistedRubricCategory {
  id: string;
  name: string;
  weight: number;
  description: string;
  min_threshold: number | null;
  section_mapping: string[];
  calibration: CalibrationExamples;
}

/** Rubric as stored in persistence, with metadata. */
export interface PersistedRubric {
  document_type: DocumentType;
  version: string;
  approval_threshold: number;
  categories: PersistedRubricCategory[];
  metadata: {
    created_at: string;
    updated_at: string;
    updated_by: string;
  };
}

// ---------------------------------------------------------------------------
// Pre-review validation (used by PreReviewValidator)
// ---------------------------------------------------------------------------

/** A document prepared for pre-review structural validation. */
export interface DocumentForValidation {
  /** Document identifier. */
  id: string;
  /** Raw content of the document. */
  content: string;
  /** Parsed frontmatter key-value pairs. */
  frontmatter: Record<string, unknown>;
  /** Parsed sections of the document. */
  sections: { id: string; title: string; content: string }[];
  /** Optional traceability references to parent documents. */
  traces_from?: { document_id: string; section_ids: string[] }[];
  /** Word count of the document content. */
  word_count: number;
}

/** Result of pre-review structural validation. */
export interface PreReviewValidationResult {
  /** Whether the document passed all structural checks. */
  valid: boolean;
  /** Validation errors (each makes valid = false). */
  errors: ValidationError[];
  /** Validation warnings (informational, do not affect valid). */
  warnings: ValidationWarning[];
  /** Determined scoring mode based on word count and mapping availability. */
  scoring_mode: 'per_section' | 'document_level';
}

/** A structured validation error. */
export interface ValidationError {
  /** Error code, e.g. 'MISSING_SECTION'. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Section ID, when the error is section-related. */
  section_id?: string;
  /** Frontmatter field name, when the error is frontmatter-related. */
  field?: string;
}

/** A structured validation warning. */
export interface ValidationWarning {
  /** Warning code, e.g. 'SHORT_DOCUMENT'. */
  code: string;
  /** Human-readable warning message. */
  message: string;
}

/** Adapter interface for resolving traces_from references. */
export interface DocumentStoreInterface {
  /** Returns true if the document with the given ID exists. */
  documentExists(documentId: string): Promise<boolean>;
  /** Returns section IDs for the given document. */
  getSectionIds(documentId: string): Promise<string[]>;
}
