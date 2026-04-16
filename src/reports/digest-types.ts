/**
 * TypeScript interfaces for weekly digest data aggregation
 * (SPEC-007-5-3, Task 6).
 *
 * These types model the aggregated data that flows through the digest
 * pipeline: from raw observation collection through metric computation
 * to the final rendered Markdown report.
 */

// ---------------------------------------------------------------------------
// Summary metrics
// ---------------------------------------------------------------------------

export interface DigestSummary {
  total_observations: number;
  by_severity: Record<string, number>;       // { P0: 1, P1: 3, P2: 7, P3: 3 }
  by_type: Record<string, number>;           // { error: 8, anomaly: 4, trend: 2 }
  triage_decisions: Record<string, number>;  // { promote: 4, dismiss: 5, ... }
  signal_to_noise_ratio: number | null;      // null if <5 observations
  signal_to_noise_display: string;           // "(4+1) / 14 = 35.7%" or "N/A (<5 observations)"
  avg_triage_latency_p0p1_hours: number | null;
  avg_triage_latency_p2p3_hours: number | null;
  avg_tokens_per_run: number;
}

// ---------------------------------------------------------------------------
// Per-service breakdown
// ---------------------------------------------------------------------------

export interface ServiceBreakdown {
  service: string;
  total_observations: number;
  p0_p1_count: number;
  promoted: number;
  dismissed: number;
}

// ---------------------------------------------------------------------------
// Effectiveness tracking
// ---------------------------------------------------------------------------

export interface EffectivenessEntry {
  observation_id: string;
  prd_id: string;
  deployed_date: string;
  pre_fix_summary: string;    // "8.2% err"
  post_fix_summary: string;   // "0.5% err"
  result: string;             // "improved (93.9%)"
}

// ---------------------------------------------------------------------------
// Recurring patterns
// ---------------------------------------------------------------------------

export interface RecurringPattern {
  pattern: string;            // Error class or description
  service: string;
  occurrences_30d: number;
  status: string;             // "OSCILLATING" or "Monitoring"
}

// ---------------------------------------------------------------------------
// Digest result
// ---------------------------------------------------------------------------

export interface DigestResult {
  filePath: string;
  weekId: string;
  summary: DigestSummary;
}

// ---------------------------------------------------------------------------
// Internal: observation frontmatter fields used for digest aggregation
// ---------------------------------------------------------------------------

export interface ObservationForDigest {
  id: string;
  timestamp: string;               // ISO 8601
  service: string;
  type: string;                    // "error" | "anomaly" | "trend" | "adoption"
  severity: string;                // "P0" | "P1" | "P2" | "P3"
  triage_decision: string | null;  // "promote" | "dismiss" | "defer" | "investigate" | null
  triage_at: string | null;        // ISO 8601 or null
  observation_run_id: string;
  tokens_consumed: number;
  linked_prd: string | null;
  linked_deployment: string | null;
  effectiveness: string | null;
  effectiveness_detail: string | null;
  oscillation_warning: boolean;
  cooldown_active: boolean;
  error_class?: string;            // Extracted from body or frontmatter extensions
}

// ---------------------------------------------------------------------------
// Internal: digest data bundle passed to the renderer
// ---------------------------------------------------------------------------

export interface DigestData {
  summary: DigestSummary;
  byService: ServiceBreakdown[];
  effectiveness: EffectivenessEntry[];
  recurring: RecurringPattern[];
  recommendations: string[];
}
