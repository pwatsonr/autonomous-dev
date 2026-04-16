/**
 * Type definitions for review gate metrics records and pipeline aggregates.
 *
 * Defines all interfaces used by the MetricsCollector and PipelineAggregator,
 * including per-gate metrics, per-reviewer metrics, score distributions,
 * and cross-gate aggregate statistics.
 *
 * Based on SPEC-004-4-2 sections 1-4.
 */

import { DocumentType } from '../types';

// ---------------------------------------------------------------------------
// Per-reviewer metrics
// ---------------------------------------------------------------------------

/** Metrics for a single reviewer within a gate execution. */
export interface ReviewerMetric {
  /** Unique reviewer identifier. */
  reviewer_id: string;
  /** Role of the reviewer (e.g. 'architect', 'domain_expert'). */
  reviewer_role: string;
  /** Weighted score computed from the reviewer's category scores. */
  weighted_score: number;
  /** Delta between reviewer's weighted score and the gate aggregate score. */
  score_vs_aggregate_delta: number;
  /** Total number of findings from this reviewer. */
  finding_count: number;
  /** Number of critical findings from this reviewer. */
  critical_finding_count: number;
  /** True if the reviewer's score deviates > 1.5 standard deviations from panel mean. */
  is_outlier: boolean;
}

// ---------------------------------------------------------------------------
// Per-gate metrics record
// ---------------------------------------------------------------------------

/** Complete metrics record for a single review gate execution. */
export interface ReviewMetricsRecord {
  /** Unique gate identifier. */
  gate_id: string;
  /** Document being reviewed. */
  document_id: string;
  /** Document type. */
  document_type: DocumentType;
  /** Pipeline run identifier. */
  pipeline_id: string;
  /** ISO 8601 timestamp of when metrics were recorded. */
  timestamp: string;

  // Gate-level metrics
  /** Gate outcome. */
  outcome: 'approved' | 'changes_requested' | 'rejected';
  /** Weighted aggregate score (0-100). */
  aggregate_score: number;
  /** Number of iterations completed. */
  iteration_count: number;
  /** Time taken for the review in milliseconds. */
  review_duration_ms: number;
  /** Number of reviewers on the panel. */
  reviewer_count: number;
  /** Number of disagreements detected between reviewers. */
  disagreement_count: number;
  /** Whether score stagnation was detected. */
  stagnation_detected: boolean;
  /** Whether quality regression was detected. */
  quality_regression_detected: boolean;
  /** Whether human escalation was triggered. */
  human_escalation: boolean;

  /** Per-category aggregate scores, keyed by category_id. */
  category_scores: Record<string, number>;

  /** Finding counts broken down by severity. */
  finding_counts: {
    critical: number;
    major: number;
    minor: number;
    suggestion: number;
  };

  /** Per-reviewer metrics. */
  reviewer_metrics: ReviewerMetric[];
}

// ---------------------------------------------------------------------------
// Score distribution
// ---------------------------------------------------------------------------

/** Statistical distribution of scores for a single category. */
export interface ScoreDistribution {
  /** Category identifier. */
  category_id: string;
  /** Minimum score observed. */
  min: number;
  /** Maximum score observed. */
  max: number;
  /** Arithmetic mean of scores. */
  mean: number;
  /** Median score. */
  median: number;
  /** 25th percentile score. */
  p25: number;
  /** 75th percentile score. */
  p75: number;
  /** Number of samples. */
  sample_count: number;
}

// ---------------------------------------------------------------------------
// Per-document-type aggregates
// ---------------------------------------------------------------------------

/** Aggregated statistics for a single document type over a time window. */
export interface DocumentTypeAggregates {
  /** Document type. */
  document_type: DocumentType;
  /** Total number of gate executions. */
  total_gates: number;
  /** Percentage of gates approved on first iteration (0-100). */
  first_pass_rate: number;
  /** Mean number of iterations to reach approval. */
  mean_iterations_to_approval: number;
  /** Percentage of gates that triggered human escalation (0-100). */
  escalation_rate: number;
  /** Mean aggregate score across all gates. */
  mean_aggregate_score: number;
  /** Percentage of gates where stagnation was detected (0-100). */
  stagnation_rate: number;
  /** Smoke test pass rate (0-100). Defaults to 0 if no data. */
  smoke_test_pass_rate: number;
  /** Backward cascade rate (0-100). Defaults to 0 if no data. */
  backward_cascade_rate: number;
  /** Score distributions per category. */
  category_score_distributions: Record<string, ScoreDistribution>;
}

// ---------------------------------------------------------------------------
// Overall aggregates
// ---------------------------------------------------------------------------

/** Overall aggregate statistics across all document types. */
export interface OverallAggregates {
  /** Total number of gate executions. */
  total_gates: number;
  /** Total number of approved gates. */
  total_approved: number;
  /** Total number of rejected gates. */
  total_rejected: number;
  /** Total number of escalated gates. */
  total_escalated: number;
  /** Mean review duration in milliseconds. */
  mean_review_duration_ms: number;
  /** Mean number of iterations across all gates. */
  mean_iterations: number;
}

// ---------------------------------------------------------------------------
// Pipeline aggregates
// ---------------------------------------------------------------------------

/** Cross-gate aggregate statistics over a time window. */
export interface PipelineAggregates {
  /** ISO 8601 timestamp of when aggregates were computed. */
  computed_at: string;
  /** ISO 8601 start of the time window. */
  window_start: string;
  /** ISO 8601 end of the time window. */
  window_end: string;
  /** Aggregates broken down by document type. */
  by_document_type: Partial<Record<DocumentType, DocumentTypeAggregates>>;
  /** Overall aggregates across all types. */
  overall: OverallAggregates;
}

// ---------------------------------------------------------------------------
// Metrics filter
// ---------------------------------------------------------------------------

/** Filter criteria for querying metrics records. */
export interface MetricsFilter {
  /** Filter by document type. */
  document_type?: DocumentType;
  /** Filter by pipeline ID. */
  pipeline_id?: string;
  /** Include records from this timestamp (inclusive). ISO 8601. */
  from_timestamp?: string;
  /** Include records up to this timestamp (inclusive). ISO 8601. */
  to_timestamp?: string;
  /** Filter by gate outcome. */
  outcome?: string;
  /** Filter by reviewer ID (matches any reviewer in reviewer_metrics). */
  reviewer_id?: string;
}
