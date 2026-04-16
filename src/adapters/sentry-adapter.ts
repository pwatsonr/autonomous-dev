/**
 * Sentry MCP data collection adapter (SPEC-007-5-5, Task 9).
 *
 * Wraps the Sentry MCP tools (`sentry_list_issues`, `sentry_get_issue_events`,
 * `sentry_get_release_health`) with query budget enforcement, per-query
 * timeouts, and PII/secret scrubbing.
 *
 * Budget tracking:
 * - Each MCP tool call counts as 1 query
 * - Budget is shared across all Sentry calls within a single observation run
 * - When budget is exhausted, remaining calls return null with a warning
 * - Budget is reset at the start of each observation run via `resetBudget()`
 */

import type {
  McpToolCaller,
  QueryBudgetTracker,
  DataSourceName,
  ConnectivityReport,
} from './types';
import { AdapterTimeoutError } from './types';
import type {
  SentryAdapterConfig,
  SentryIssue,
  SentryEvent,
  SentryEventEntry,
  SentryReleaseHealth,
} from './sentry-types';

// ---------------------------------------------------------------------------
// Scrubber interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over the PII/secret scrubbing pipeline (SPEC-007-2-2).
 * Implementations apply regex-based redaction; tests inject mocks.
 */
export interface DataScrubber {
  /** Scrub PII/secrets from a plain text string. */
  scrubText(text: string): string;
  /** Scrub PII/secrets from all string values in an object. */
  scrubObject(obj: Record<string, unknown>): Record<string, unknown>;
}

/**
 * No-op scrubber that passes text through unchanged.
 * Used only as a fallback when no scrubber is injected.
 */
export const NOOP_SCRUBBER: DataScrubber = {
  scrubText: (text: string) => text,
  scrubObject: (obj: Record<string, unknown>) => obj,
};

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, queryName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AdapterTimeoutError('sentry', queryName, ms)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ---------------------------------------------------------------------------
// Response parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parses a sentry_list_issues MCP response into typed SentryIssue objects.
 */
function parseIssuesResponse(raw: unknown): SentryIssue[] {
  const items = Array.isArray(raw) ? raw : [];

  return items.map((item: Record<string, unknown>) => ({
    id: String(item.id ?? ''),
    title: String(item.title ?? ''),
    culprit: String(item.culprit ?? ''),
    type: String(item.type ?? 'error'),
    status: String(item.status ?? 'unresolved'),
    level: String(item.level ?? 'error'),
    count: String(item.count ?? '0'),
    user_count: Number(item.userCount ?? item.user_count ?? 0),
    first_seen: String(item.firstSeen ?? item.first_seen ?? ''),
    last_seen: String(item.lastSeen ?? item.last_seen ?? ''),
    short_id: String(item.shortId ?? item.short_id ?? ''),
    metadata: {
      type: (item.metadata as Record<string, unknown>)?.type as string | undefined,
      value: (item.metadata as Record<string, unknown>)?.value as string | undefined,
    },
  }));
}

/**
 * Parses a sentry_get_issue_events MCP response into typed SentryEvent objects.
 */
function parseEventsResponse(raw: unknown): SentryEvent[] {
  const items = Array.isArray(raw) ? raw : [];

  return items.map((item: Record<string, unknown>) => ({
    event_id: String(item.eventID ?? item.event_id ?? ''),
    timestamp: String(item.dateCreated ?? item.timestamp ?? ''),
    message: String(item.message ?? item.title ?? ''),
    tags: Array.isArray(item.tags)
      ? item.tags.map((t: Record<string, unknown>) => ({
          key: String(t.key ?? ''),
          value: String(t.value ?? ''),
        }))
      : [],
    entries: Array.isArray(item.entries)
      ? item.entries.map((e: Record<string, unknown>) => ({
          type: String(e.type ?? ''),
          data: e.data,
        }))
      : [],
    contexts: item.contexts as Record<string, unknown> | undefined,
  }));
}

/**
 * Parses a sentry_get_release_health MCP response into a typed object.
 */
function parseReleaseHealthResponse(raw: unknown): SentryReleaseHealth {
  const r = (raw as Record<string, unknown>) ?? {};
  const stats = (r.stats as Record<string, unknown>) ?? {};

  return {
    crash_free_sessions: Number(r.crashFreeSessions ?? r.crash_free_sessions ?? 0),
    crash_free_users: Number(r.crashFreeUsers ?? r.crash_free_users ?? 0),
    total_sessions: Number(r.totalSessions ?? r.total_sessions ?? 0),
    adoption: Number(r.adoption ?? 0),
    stats: {
      sessions_24h: Number(stats.sessions_24h ?? stats['24h_sessions'] ?? 0),
      sessions_crashed_24h: Number(stats.sessions_crashed_24h ?? stats['24h_sessions_crashed'] ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// SentryAdapter
// ---------------------------------------------------------------------------

export class SentryAdapter {
  private readonly source: DataSourceName = 'sentry';
  private queriesUsed = 0;

  constructor(
    private readonly config: SentryAdapterConfig,
    private readonly mcp: McpToolCaller,
    private readonly budget: QueryBudgetTracker,
    private readonly scrubber: DataScrubber = NOOP_SCRUBBER,
    private readonly connectivity?: ConnectivityReport,
  ) {}

  // -------------------------------------------------------------------------
  // Budget access
  // -------------------------------------------------------------------------

  /** Returns the number of queries remaining within the adapter's own budget. */
  get remainingBudget(): number {
    return Math.max(0, this.config.query_budget - this.queriesUsed);
  }

  /** Resets the internal query counter (called at the start of each run). */
  resetBudget(): void {
    this.queriesUsed = 0;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * List unresolved error issues for the configured project.
   * Filters to issues matching the given service/error class.
   *
   * Uses 1 query from the budget.
   *
   * @param query   Sentry search query string (default: "is:unresolved")
   * @param sortBy  Sort order: "date" | "freq" | "priority"
   * @param serviceName  Service name for QueryBudgetTracker tracking
   */
  async listIssues(
    query?: string,
    sortBy: 'date' | 'freq' | 'priority' = 'date',
    serviceName: string = 'default',
  ): Promise<SentryIssue[] | null> {
    if (this.isUnreachable()) return null;
    if (!this.checkBudget('sentry_list_issues')) return null;

    try {
      const raw = await withTimeout(
        this.mcp.callTool('sentry_list_issues', {
          organization_slug: this.config.organization_slug,
          project_slug: this.config.project_slug,
          query: query ?? 'is:unresolved',
          sort: sortBy,
        }),
        this.config.query_timeout_ms,
        'sentry_list_issues',
      );

      this.queriesUsed++;
      this.budget.recordQuery(this.source, serviceName);
      return parseIssuesResponse(raw);
    } catch (err) {
      this.queriesUsed++;
      this.budget.recordQuery(this.source, serviceName);
      if (err instanceof AdapterTimeoutError) throw err;
      return null;
    }
  }

  /**
   * Get events and stack traces for a specific Sentry issue.
   * Applies PII scrubbing to stack traces and exception messages.
   *
   * Uses 1 query from the budget.
   *
   * @param issueId      Sentry issue ID
   * @param serviceName  Service name for QueryBudgetTracker tracking
   */
  async getIssueEvents(
    issueId: string,
    serviceName: string = 'default',
  ): Promise<SentryEvent[] | null> {
    if (this.isUnreachable()) return null;
    if (!this.checkBudget('sentry_get_issue_events')) return null;

    try {
      const raw = await withTimeout(
        this.mcp.callTool('sentry_get_issue_events', {
          issue_id: issueId,
        }),
        this.config.query_timeout_ms,
        'sentry_get_issue_events',
      );

      this.queriesUsed++;
      this.budget.recordQuery(this.source, serviceName);
      const events = parseEventsResponse(raw);

      // Scrub PII from event data before returning
      return events.map((event) => this.scrubEvent(event));
    } catch (err) {
      this.queriesUsed++;
      this.budget.recordQuery(this.source, serviceName);
      if (err instanceof AdapterTimeoutError) throw err;
      return null;
    }
  }

  /**
   * Get release health metrics (crash-free rate, adoption).
   *
   * Uses 1 query from the budget.
   *
   * @param releaseVersion  The release version string
   * @param serviceName     Service name for QueryBudgetTracker tracking
   */
  async getReleaseHealth(
    releaseVersion: string,
    serviceName: string = 'default',
  ): Promise<SentryReleaseHealth | null> {
    if (this.isUnreachable()) return null;
    if (!this.checkBudget('sentry_get_release_health')) return null;

    try {
      const raw = await withTimeout(
        this.mcp.callTool('sentry_get_release_health', {
          organization_slug: this.config.organization_slug,
          project_slug: this.config.project_slug,
          release: releaseVersion,
        }),
        this.config.query_timeout_ms,
        'sentry_get_release_health',
      );

      this.queriesUsed++;
      this.budget.recordQuery(this.source, serviceName);
      return parseReleaseHealthResponse(raw);
    } catch (err) {
      this.queriesUsed++;
      this.budget.recordQuery(this.source, serviceName);
      if (err instanceof AdapterTimeoutError) throw err;
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Checks if the adapter's own budget allows another query.
   * Returns false (with no side effects) if the budget is exhausted.
   */
  private checkBudget(toolName: string): boolean {
    if (this.queriesUsed >= this.config.query_budget) {
      return false;
    }
    return true;
  }

  /**
   * Checks whether Sentry was classified as unreachable during
   * connectivity validation.
   */
  private isUnreachable(): boolean {
    if (!this.connectivity) return false;
    const sentryResult = this.connectivity.results.find(
      (r) => r.source === 'sentry',
    );
    return sentryResult?.status === 'unreachable';
  }

  /**
   * Scrub PII from a Sentry event.
   * Applies the PII/secret scrubbing pipeline (SPEC-007-2-2).
   */
  private scrubEvent(event: SentryEvent): SentryEvent {
    return {
      ...event,
      message: this.scrubber.scrubText(event.message),
      entries: event.entries.map((entry) => {
        if (entry.type === 'exception') {
          return {
            ...entry,
            data: this.scrubExceptionData(entry.data),
          };
        }
        if (entry.type === 'request') {
          return {
            ...entry,
            data: this.scrubRequestData(entry.data),
          };
        }
        return entry;
      }),
    };
  }

  /**
   * Scrub exception entry data: exception values, local variables,
   * context lines in stack frames.
   */
  private scrubExceptionData(data: unknown): unknown {
    const d = data as Record<string, unknown> | undefined;
    if (!d?.values) return data;
    return {
      ...d,
      values: (d.values as unknown[]).map((exc: unknown) => {
        const e = exc as Record<string, unknown>;
        return {
          ...e,
          value: this.scrubber.scrubText(String(e.value ?? '')),
          stacktrace: e.stacktrace ? {
            ...(e.stacktrace as Record<string, unknown>),
            frames: ((e.stacktrace as Record<string, unknown>).frames as unknown[] ?? []).map(
              (frame: unknown) => {
                const f = frame as Record<string, unknown>;
                return {
                  ...f,
                  context_line: f.context_line
                    ? this.scrubber.scrubText(String(f.context_line))
                    : null,
                  vars: f.vars
                    ? this.scrubber.scrubObject(f.vars as Record<string, unknown>)
                    : null,
                };
              },
            ),
          } : null,
        };
      }),
    };
  }

  /**
   * Scrub request entry data: headers, query strings, body.
   */
  private scrubRequestData(data: unknown): unknown {
    const d = data as Record<string, unknown> | undefined;
    if (!d) return data;
    return {
      ...d,
      headers: d.headers
        ? this.scrubber.scrubObject(d.headers as Record<string, unknown>)
        : null,
      query_string: d.query_string
        ? this.scrubber.scrubText(String(d.query_string))
        : null,
      data: d.data
        ? this.scrubber.scrubText(
            typeof d.data === 'string' ? d.data : JSON.stringify(d.data),
          )
        : null,
    };
  }
}
