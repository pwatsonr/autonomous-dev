/**
 * TypeScript interfaces for Sentry API responses (SPEC-007-5-5, Task 9).
 *
 * These types model the data returned by Sentry MCP tools and the
 * enrichment structures attached to observation candidates.
 */

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

/** Configuration for the Sentry adapter. */
export interface SentryAdapterConfig {
  enabled: boolean;
  /** Sentry project identifier. */
  project_slug: string;
  /** Sentry organization. */
  organization_slug: string;
  /** Max queries per observation run (default: 10). */
  query_budget: number;
  /** Per-query timeout in milliseconds (default: 30000). */
  query_timeout_ms: number;
}

/** Default Sentry adapter configuration values. */
export const DEFAULT_SENTRY_CONFIG: Omit<SentryAdapterConfig, 'project_slug' | 'organization_slug'> = {
  enabled: true,
  query_budget: 10,
  query_timeout_ms: 30_000,
};

// ---------------------------------------------------------------------------
// Sentry API response types
// ---------------------------------------------------------------------------

/** A Sentry issue (from sentry_list_issues). */
export interface SentryIssue {
  id: string;
  title: string;
  /** File/function where the error originates. */
  culprit: string;
  /** "error" | "default". */
  type: string;
  /** "unresolved" | "resolved" | "ignored". */
  status: string;
  /** "error" | "warning" | "fatal". */
  level: string;
  /** Total event count (string from API). */
  count: string;
  /** Unique affected users. */
  user_count: number;
  /** ISO 8601. */
  first_seen: string;
  /** ISO 8601. */
  last_seen: string;
  /** Human-readable short ID (e.g., "PROJ-123"). */
  short_id: string;
  metadata: {
    /** Exception type (e.g., "ConnectionPoolExhaustedError"). */
    type?: string;
    /** Exception message. */
    value?: string;
  };
}

/** A Sentry event (from sentry_get_issue_events). */
export interface SentryEvent {
  event_id: string;
  timestamp: string;
  message: string;
  tags: Array<{ key: string; value: string }>;
  entries: SentryEventEntry[];
  contexts?: Record<string, unknown>;
}

/** An entry in a Sentry event (stack trace, breadcrumbs, etc.). */
export interface SentryEventEntry {
  /** "exception" | "breadcrumbs" | "request". */
  type: string;
  data: unknown;
}

/** Stack frame extracted from a Sentry exception entry. */
export interface SentryStackFrame {
  filename: string;
  function: string;
  line_number: number | null;
  column_number: number | null;
  module: string | null;
  /** Source code at the error line. */
  context_line: string | null;
  /** True if from application code (not library). */
  in_app: boolean;
}

/** Release health metrics (from sentry_get_release_health). */
export interface SentryReleaseHealth {
  /** Percentage (0-100). */
  crash_free_sessions: number;
  /** Percentage (0-100). */
  crash_free_users: number;
  total_sessions: number;
  /** Percentage of users on this release. */
  adoption: number;
  stats: {
    sessions_24h: number;
    sessions_crashed_24h: number;
  };
}

// ---------------------------------------------------------------------------
// Enrichment types
// ---------------------------------------------------------------------------

/** Enrichment data extracted from Sentry for an observation. */
export interface SentryEnrichment {
  issues: SentryIssueSnapshot[];
  stack_traces: ScrubbledStackTrace[];
  release_health: SentryReleaseHealth | null;
  user_count_total: number;
  queries_used: number;
}

/** Snapshot of a Sentry issue for inclusion in observation reports. */
export interface SentryIssueSnapshot {
  sentry_id: string;
  short_id: string;
  title: string;
  error_type: string;
  event_count: number;
  user_count: number;
  first_seen: string;
  last_seen: string;
}

/** Stack trace after PII scrubbing. */
export interface ScrubbledStackTrace {
  issue_id: string;
  /** Already scrubbed frames. */
  frames: SentryStackFrame[];
  exception_type: string;
  /** Already scrubbed. */
  exception_value: string;
}
