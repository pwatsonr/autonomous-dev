import { z } from 'zod';

// --- Schedule ---

export const ScheduleConfigSchema = z.object({
  type: z.enum(['cron', 'interval']),
  expression: z.string().min(1, 'schedule.expression must not be empty'),
});

export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

// --- Service ---

export const CriticalitySchema = z.enum(['critical', 'high', 'medium', 'low']);

export type Criticality = z.infer<typeof CriticalitySchema>;

export const ServiceConfigSchema = z.object({
  name: z.string().min(1),
  repo: z.string().min(1),
  prometheus_job: z.string().min(1),
  grafana_dashboard_uid: z.string().min(1),
  opensearch_index: z.string().min(1),
  sentry_project: z.string().optional(),
  criticality: CriticalitySchema,
});

export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

// --- Thresholds ---

export const ThresholdConfigSchema = z.object({
  error_rate_percent: z.number().nonnegative(),
  sustained_duration_minutes: z.number().positive(),
  p99_latency_ms: z.number().positive(),
  availability_percent: z.number().min(0).max(100),
});

export type ThresholdConfig = z.infer<typeof ThresholdConfigSchema>;

// --- Query Budgets ---

export const QueryBudgetEntrySchema = z.object({
  max_queries_per_service: z.number().positive().int(),
  timeout_seconds: z.number().positive(),
});

export type QueryBudgetEntry = z.infer<typeof QueryBudgetEntrySchema>;

export const QueryBudgetConfigSchema = z.object({
  prometheus: QueryBudgetEntrySchema,
  grafana: QueryBudgetEntrySchema,
  opensearch: QueryBudgetEntrySchema,
  sentry: QueryBudgetEntrySchema,
});

export type QueryBudgetConfig = z.infer<typeof QueryBudgetConfigSchema>;

// --- Anomaly Detection ---

export const AnomalyDetectionConfigSchema = z.object({
  method: z.enum(['zscore', 'iqr']),
  sensitivity: z.number().positive(),
  consecutive_runs_required: z.number().positive().int(),
});

export type AnomalyDetectionConfig = z.infer<typeof AnomalyDetectionConfigSchema>;

// --- Trend Analysis ---

export const TrendAnalysisConfigSchema = z.object({
  windows: z.array(z.string().min(1)).min(1),
  min_slope_threshold: z.number().nonnegative(),
});

export type TrendAnalysisConfig = z.infer<typeof TrendAnalysisConfigSchema>;

// --- False Positive Filters ---

export const FalsePositiveFiltersSchema = z.object({
  maintenance_windows: z.array(z.string()).default([]),
  excluded_error_patterns: z.array(z.string()).default([]),
  load_test_markers: z.array(z.string()).default([]),
});

export type FalsePositiveFilters = z.infer<typeof FalsePositiveFiltersSchema>;

// --- Governance ---

export const GovernanceConfigSchema = z.object({
  cooldown_days: z.number().nonnegative().int(),
  oscillation_window_days: z.number().positive().int(),
  oscillation_threshold: z.number().positive().int(),
  effectiveness_comparison_days: z.number().positive().int(),
  effectiveness_improvement_threshold: z.number().nonnegative(),
});

export type GovernanceConfig = z.infer<typeof GovernanceConfigSchema>;

// --- Retention ---

export const RetentionConfigSchema = z.object({
  observation_days: z.number().positive().int(),
  archive_days: z.number().positive().int(),
});

export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;

// --- Auto Promote ---

export const AutoPromoteConfigSchema = z.object({
  enabled: z.boolean(),
  override_hours: z.number().nonnegative(),
});

export type AutoPromoteConfig = z.infer<typeof AutoPromoteConfigSchema>;

// --- Notifications ---

export const NotificationsConfigSchema = z.object({
  enabled: z.boolean(),
  webhook_url: z.string().nullable().default(null),
  severity_filter: z.array(z.string()).default(['P0', 'P1']),
});

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;

// --- Top-level Intelligence Config ---

export const IntelligenceConfigSchema = z.object({
  schedule: ScheduleConfigSchema,
  services: z.array(ServiceConfigSchema).min(1, 'At least one service must be defined'),
  default_thresholds: ThresholdConfigSchema,
  per_service_overrides: z.record(z.string(), ThresholdConfigSchema.partial()).default({}),
  query_budgets: QueryBudgetConfigSchema,
  anomaly_detection: AnomalyDetectionConfigSchema,
  trend_analysis: TrendAnalysisConfigSchema,
  false_positive_filters: FalsePositiveFiltersSchema.default({}),
  governance: GovernanceConfigSchema,
  retention: RetentionConfigSchema,
  custom_pii_patterns: z.array(z.string()).default([]),
  custom_secret_patterns: z.array(z.string()).default([]),
  auto_promote: AutoPromoteConfigSchema,
  notifications: NotificationsConfigSchema,
});

export type IntelligenceConfig = z.infer<typeof IntelligenceConfigSchema>;
