/**
 * Improvement lifecycle types (SPEC-005-3-1, SPEC-005-3-2, SPEC-005-3-3, SPEC-005-3-4).
 *
 * Defines schemas for weakness reports, analysis orchestration I/O,
 * dimension breakdowns, domain gap entries, proposals, constraint
 * violations, version bump classification, meta-review results,
 * and rate limit tracking.
 */

import type {
  AggregateMetrics,
  InvocationMetric,
  AlertRecord,
  TrendResult,
  DomainStats,
} from '../metrics/types';
import type { QualityDimension } from '../types';

// ---------------------------------------------------------------------------
// Weakness Report types (SPEC-005-3-1)
// ---------------------------------------------------------------------------

/** Overall health assessment of an agent. */
export type OverallAssessment = 'healthy' | 'needs_improvement' | 'critical';

/** Recommended next action after analysis. */
export type Recommendation = 'no_action' | 'propose_modification' | 'propose_specialist';

/** Severity of an identified weakness. */
export type WeaknessSeverity = 'low' | 'medium' | 'high';

/** A single identified weakness in agent performance. */
export interface Weakness {
  dimension: string;
  severity: WeaknessSeverity;
  evidence: string;
  affected_domains: string[];
  suggested_focus: string;
}

/** Snapshot of key metrics at the time of analysis. */
export interface MetricsSummary {
  invocation_count: number;
  approval_rate: number;
  avg_quality_score: number;
  trend_direction: string;
  active_alerts: number;
}

/** The complete weakness analysis report for an agent. */
export interface WeaknessReport {
  report_id: string;
  agent_name: string;
  agent_version: string;
  analysis_date: string;
  overall_assessment: OverallAssessment;
  weaknesses: Weakness[];
  strengths: string[];
  recommendation: Recommendation;
  metrics_summary: MetricsSummary;
}

// ---------------------------------------------------------------------------
// Trigger types (SPEC-005-3-1)
// ---------------------------------------------------------------------------

/** Result of an observation threshold check. */
export interface TriggerDecision {
  triggered: boolean;
  reason: string;
  agentName: string;
  invocationCount: number;
  threshold: number;
}

// ---------------------------------------------------------------------------
// Proposal types (SPEC-005-3-3)
// ---------------------------------------------------------------------------

/** Lifecycle status of a modification proposal. */
export type ProposalStatus =
  | 'pending_meta_review'
  | 'meta_approved'
  | 'meta_rejected'
  | 'validating'
  | 'validated_positive'
  | 'validated_negative'
  | 'pending_human_review'
  | 'promoted'
  | 'rejected';

/** Semver version bump classification. */
export type VersionBump = 'major' | 'minor' | 'patch';

/** A complete agent modification proposal. */
export interface AgentProposal {
  proposal_id: string;
  agent_name: string;
  current_version: string;
  proposed_version: string;
  version_bump: VersionBump;
  weakness_report_id: string;
  current_definition: string;
  proposed_definition: string;
  diff: string;
  rationale: string;
  status: ProposalStatus;
  created_at: string;
  meta_review_id?: string;
  evaluation_id?: string;
}

/** Result of a proposal generation attempt. */
export interface ProposalResult {
  success: boolean;
  proposal?: AgentProposal;
  constraintViolations?: ConstraintViolation[];
  error?: string;
}

/** A single constraint violation detected in a proposal. */
export interface ConstraintViolation {
  field: string;
  rule: string;
  current_value: string;
  proposed_value: string;
}

// ---------------------------------------------------------------------------
// Version classification types (SPEC-005-3-3)
// ---------------------------------------------------------------------------

/** Detailed result of version bump classification. */
export interface VersionClassification {
  bump: VersionBump;
  reason: string;
  bodyChangePercent: number;
  frontmatterChanges: string[];
}

// ---------------------------------------------------------------------------
// DimensionBreakdown (SPEC-005-3-2)
// ---------------------------------------------------------------------------

/** Per-dimension performance breakdown computed from recent invocations. */
export interface DimensionBreakdown {
  dimension: string;
  avg_score: number;
  median_score: number;
  stddev: number;
  trend_slope: number;
  /** Domains where this dimension scores lowest. */
  worst_domains: string[];
}

// ---------------------------------------------------------------------------
// AnalysisInput (SPEC-005-3-2)
// ---------------------------------------------------------------------------

/** Structured input data collected for the performance-analyst agent. */
export interface AnalysisInput {
  agent: {
    name: string;
    version: string;
    role: string;
    expertise: string[];
    evaluation_rubric: QualityDimension[];
  };
  metrics: {
    aggregate: AggregateMetrics;
    recent_invocations: InvocationMetric[];
    per_dimension_scores: DimensionBreakdown[];
    domain_breakdown: Record<string, DomainStats>;
    active_alerts: AlertRecord[];
    trend: TrendResult;
  };
}

// ---------------------------------------------------------------------------
// AnalysisResult (SPEC-005-3-2)
// ---------------------------------------------------------------------------

/** The next action determined by the decision engine. */
export type NextAction =
  | 'no_action'
  | 'propose_modification'
  | 'log_domain_gap'
  | 'error';

/** Result of a performance analysis pass. */
export interface AnalysisResult {
  success: boolean;
  report?: WeaknessReport;
  nextAction: NextAction;
  error?: string;
}

// ---------------------------------------------------------------------------
// DomainGapEntry (SPEC-005-3-2)
// ---------------------------------------------------------------------------

/** A domain gap record written to `data/domain-gaps.jsonl`. */
export interface DomainGapEntry {
  gap_id: string;
  task_domain: string;
  description: string;
  /** ISO 8601 timestamp. */
  detected_at: string;
  source_agent: string;
  status: 'specialist_recommended';
  closest_agent: string;
  analysis_report_id: string;
}

// ---------------------------------------------------------------------------
// Meta-review types (SPEC-005-3-4)
// ---------------------------------------------------------------------------

/** Verdict of a meta-review: approved or rejected. */
export type MetaReviewVerdict = 'approved' | 'rejected';

/** Severity of a meta-review finding. */
export type FindingSeverity = 'info' | 'warning' | 'blocker';

/** A finding from the meta-reviewer's 6-point security checklist. */
export interface MetaReviewFinding {
  checklist_item: number;         // 1-6
  severity: FindingSeverity;
  description: string;
  evidence: string;               // specific text from the proposal that triggered the finding
}

/** Result of evaluating a single checklist item. */
export interface ChecklistResult {
  item: number;
  name: string;
  passed: boolean;
  finding?: MetaReviewFinding;
}

/** Complete result of a meta-review of a proposal. */
export interface MetaReviewResult {
  review_id: string;              // UUID v4
  proposal_id: string;
  verdict: MetaReviewVerdict;
  findings: MetaReviewFinding[];
  checklist_results: ChecklistResult[];
  reviewed_at: string;            // ISO 8601
  bypassed: boolean;              // true if self-review bypass
  bypass_reason?: string;
}

// ---------------------------------------------------------------------------
// Rate limit types (SPEC-005-3-4)
// ---------------------------------------------------------------------------

/** Result of a modification rate limit check. */
export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  nextAllowedAt?: string;         // ISO 8601, when rate limit resets
  currentCount: number;
  maxPerWeek: number;
}

/** A single modification record for rate limit tracking. */
export interface ModificationRecord {
  timestamp: string;              // ISO 8601
  proposal_id: string;
}

/** Persisted rate limit state (data/rate-limits.json). */
export interface RateLimitState {
  modifications: Record<string, ModificationRecord[]>;
}

// ---------------------------------------------------------------------------
// Validation / A/B evaluation types (SPEC-005-4-1, SPEC-005-4-2)
// ---------------------------------------------------------------------------

/** A historical input selected for A/B validation. */
export interface SelectedInput {
  input_id: string;
  original_invocation_id: string;
  input_content: string;
  input_hash: string;
  input_domain: string;
  original_quality_score: number;
  selection_reason: string;
}

/** Result of running a single agent version on an input. */
export interface RunResult {
  output: string;
  output_hash: string;
  input_tokens: number;
  output_tokens: number;
  wall_clock_ms: number;
  turn_count: number;
  tool_calls: import('../metrics/types').ToolCallRecord[];
  error?: string;
}

/** Pair of run results for both agent versions on the same input. */
export interface RunPair {
  input: SelectedInput;
  version_a: RunResult;             // current agent
  version_b: RunResult;             // proposed agent
}

/** Randomized output pair with no version information exposed. */
export interface RandomizedPair {
  input: SelectedInput;
  output_1: string;                 // could be version_a or version_b
  output_2: string;                 // the other one
  mapping_id: string;               // UUID for the mapping record
}

/** Mapping between randomized labels and actual versions. */
export interface RandomizationMapping {
  mapping_id: string;
  output_1_is: 'version_a' | 'version_b';
  output_2_is: 'version_a' | 'version_b';
}

// ---------------------------------------------------------------------------
// Blind scoring types (SPEC-005-4-2)
// ---------------------------------------------------------------------------

/** Per-dimension scores for a single output. */
export interface DimensionScores {
  scores: Record<string, number>;   // dimension_name -> score (1.0-5.0)
  overall: number;                  // weighted mean of dimension scores
}

/** Median scores across all scoring rounds. */
export interface MedianScores {
  output_1: DimensionScores;
  output_2: DimensionScores;
}

/** A single scoring round from one reviewer invocation. */
export interface ScoringRound {
  round_number: number;             // 1, 2, 3
  reviewer_invocation_id: string;
  output_1_scores: DimensionScores;
  output_2_scores: DimensionScores;
  output_1_overall: number;
  output_2_overall: number;
  free_text_comparison: string;
}

/** Complete scoring result for a single input pair. */
export interface ScoringResult {
  input_id: string;
  rounds: ScoringRound[];           // up to 3 rounds
  median_scores: MedianScores;
  scoring_variance: number;         // variance across rounds
  error?: string;
}

// ---------------------------------------------------------------------------
// Comparator types (SPEC-005-4-2)
// ---------------------------------------------------------------------------

/** De-randomized comparison result mapping scores to actual versions. */
export interface ComparisonResult {
  input_id: string;
  version_a_scores: DimensionScores;    // current agent
  version_b_scores: DimensionScores;    // proposed agent
  per_dimension_delta: Record<string, number>;  // proposed - current per dimension
  overall_delta: number;                 // mean of dimension deltas
  outcome: 'proposed_wins' | 'current_wins' | 'tie';
  scoring_variance: number;
}

// ---------------------------------------------------------------------------
// Decision engine and orchestrator types (SPEC-005-4-3)
// ---------------------------------------------------------------------------

/** Aggregate verdict of A/B validation. */
export type ABVerdict = 'positive' | 'negative' | 'inconclusive';

/** Per-dimension summary within the aggregate decision. */
export interface DimensionSummary {
  mean_delta: number;
  improved: boolean;                    // mean_delta > 0
  dimension_name: string;
}

/** Aggregate decision result from all per-input comparisons. */
export interface ABAggregate {
  verdict: ABVerdict;
  proposed_wins: number;
  current_wins: number;
  ties: number;
  total_inputs: number;
  mean_delta: number;
  per_dimension_summary: Record<string, DimensionSummary>;
  recommendation: string;               // human-readable summary
}

/** A single A/B input record within an evaluation result. */
export interface ABInput {
  input_id: string;
  selection_reason: string;
  version_a_scores: DimensionScores;
  version_b_scores: DimensionScores;
  per_dimension_delta: Record<string, number>;
  overall_delta: number;
  outcome: 'proposed_wins' | 'current_wins' | 'tie';
}

/** Token consumption breakdown for the validation run. */
export interface TokenConsumption {
  input_selection_tokens: number;
  version_a_run_tokens: number;
  version_b_run_tokens: number;
  scoring_tokens: number;
  total_tokens: number;
  budget: number;
  utilization_percent: number;
}

/** Complete A/B evaluation result stored per validation run. */
export interface ABEvaluationResult {
  evaluation_id: string;                // UUID v4
  proposal_id: string;
  agent_name: string;
  started_at: string;
  completed_at: string;
  inputs: ABInput[];
  aggregate: ABAggregate;
  token_consumption: TokenConsumption;
  aborted: boolean;
  abort_reason?: string;
}
