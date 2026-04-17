/** Governance configuration slice from intelligence.yaml */
export interface GovernanceConfig {
  cooldown_days: number;           // Default: 7
  oscillation_window_days: number; // Default: 30
  oscillation_threshold: number;   // Default: 3
  effectiveness_comparison_days: number; // Default: 7
  effectiveness_improvement_threshold: number; // Default: 10 (percent)
}

/** Return value of check_cooldown */
export interface CooldownResult {
  active: boolean;
  reason?: string;              // Human-readable explanation
  linked_deployment?: string;   // Deployment ID that triggered the cooldown
  cooldown_end?: string;        // ISO 8601 date when cooldown expires
  deploy_date?: string;         // ISO 8601 date of the linked deployment
}

/** Return value of check_oscillation */
export interface OscillationResult {
  oscillating: boolean;
  count?: number;                     // Number of observations in the window
  window_days?: number;               // Window size from config
  observation_ids?: string[];         // IDs of observations in the window
  observation_summaries?: ObservationSummary[]; // For Markdown rendering
  recommendation?: 'systemic_investigation';
}

/** Minimal observation info for oscillation rendering */
export interface ObservationSummary {
  id: string;
  triage_status: string;
  effectiveness?: string | null;
  is_current: boolean;   // True for the observation being evaluated
}

/** Reference to a deployment linked to a promoted observation */
export interface FixDeployment {
  id: string;              // Deployment ID from TDD-003 pipeline
  deployed_at: string;     // ISO 8601
  observation_id: string;  // The promoted observation that triggered the fix
  service: string;
  error_class: string;
}

// ---------------------------------------------------------------------------
// Effectiveness types (SPEC-007-5-2)
// ---------------------------------------------------------------------------

/** Classification of fix effectiveness */
export type EffectivenessStatus = 'improved' | 'unchanged' | 'degraded' | 'pending';

/**
 * Direction in which "improvement" is measured.
 *
 * - `decrease`: error_rate, latency -- lower is better
 * - `increase`: throughput -- higher is better
 */
export type MetricDirection = 'decrease' | 'increase';

/** Detailed effectiveness measurement written back into observation YAML. */
export interface EffectivenessDetail {
  pre_fix_avg: number;
  post_fix_avg: number;
  improvement_pct: number;       // Positive = improved in the expected direction
  measured_window: string;       // "YYYY-MM-DD to YYYY-MM-DD" of the post-fix window
}

/** Full return value of evaluateEffectiveness. */
export interface EffectivenessResult {
  status: EffectivenessStatus;
  detail?: EffectivenessDetail;
  reason?: string;               // Human-readable explanation for pending/error cases
}

/** Minimal deployment info needed for effectiveness evaluation. */
export interface DeploymentInfo {
  id: string;
  deployed_at: string;           // ISO 8601
}

/** Interface for Prometheus query abstraction. */
export interface PrometheusClient {
  queryRangeAverage(
    query: string,
    start: Date,
    end: Date,
    stepSeconds: number,
  ): Promise<number | null>;
}

/** Observation frontmatter fields relevant to effectiveness evaluation. */
export interface EffectivenessCandidate {
  id: string;
  file_path: string;             // Absolute path to the observation report
  linked_deployment: string | null;
  effectiveness: EffectivenessStatus | null;
  target_metric: string;         // PromQL query template for the metric to measure
  metric_direction: MetricDirection;
  service: string;
}
