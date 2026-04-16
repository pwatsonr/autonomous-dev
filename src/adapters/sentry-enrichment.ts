/**
 * Sentry enrichment logic (SPEC-007-5-5, Task 9).
 *
 * Enriches observation candidates with Sentry data: issue snapshots,
 * scrubbed stack traces, and release health metrics.
 *
 * Strategy:
 * 1. List issues matching the service and error class (1 query)
 * 2. For the top N issues (by event count), fetch events/stack traces (N queries)
 * 3. If a release version is known, fetch release health (1 query)
 *
 * Total budget usage: 1 + N + 1 = N + 2 (where N <= 5 by default).
 * With a budget of 10, this leaves room for 3 additional queries
 * or multiple enrichment rounds.
 */

import type { SentryAdapter } from './sentry-adapter';
import type {
  SentryEnrichment,
  SentryIssueSnapshot,
  ScrubbledStackTrace,
  SentryStackFrame,
  SentryEvent,
} from './sentry-types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enrich an observation candidate with Sentry data.
 *
 * @param adapter         Configured SentryAdapter instance
 * @param service         Service name to query for
 * @param errorClass      Error class/type to match
 * @param releaseVersion  Optional release version for health metrics
 * @param maxIssues       Maximum issues to fetch events for (default 5)
 * @param serviceName     Service name for budget tracking
 */
export async function enrichWithSentry(
  adapter: SentryAdapter,
  service: string,
  errorClass: string,
  releaseVersion?: string,
  maxIssues: number = 5,
  serviceName?: string,
): Promise<SentryEnrichment> {
  const budgetServiceName = serviceName ?? service;

  const enrichment: SentryEnrichment = {
    issues: [],
    stack_traces: [],
    release_health: null,
    user_count_total: 0,
    queries_used: 0,
  };

  // Step 1: List issues matching the service and error class
  const query = buildSentryQuery(service, errorClass);
  const issues = await adapter.listIssues(query, 'freq', budgetServiceName);
  enrichment.queries_used++;

  if (!issues || issues.length === 0) {
    return enrichment;
  }

  // Step 2: Snapshot top issues and fetch stack traces
  const topIssues = issues.slice(0, maxIssues);
  for (const issue of topIssues) {
    enrichment.issues.push({
      sentry_id: issue.id,
      short_id: issue.short_id,
      title: issue.title,
      error_type: issue.metadata.type ?? 'Unknown',
      event_count: parseInt(issue.count, 10),
      user_count: issue.user_count,
      first_seen: issue.first_seen,
      last_seen: issue.last_seen,
    });
    enrichment.user_count_total += issue.user_count;

    // Fetch events for stack traces (if budget allows)
    if (adapter.remainingBudget > 0) {
      const events = await adapter.getIssueEvents(issue.id, budgetServiceName);
      enrichment.queries_used++;

      if (events && events.length > 0) {
        const stackTrace = extractStackTrace(events[0], issue.id);
        if (stackTrace) {
          enrichment.stack_traces.push(stackTrace);
        }
      }
    }
  }

  // Step 3: Release health (if version known and budget allows)
  if (releaseVersion && adapter.remainingBudget > 0) {
    enrichment.release_health = await adapter.getReleaseHealth(
      releaseVersion,
      budgetServiceName,
    );
    enrichment.queries_used++;
  }

  return enrichment;
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

/**
 * Build a Sentry search query for a service + error class.
 * Uses Sentry's search syntax to combine tags and free text.
 */
export function buildSentryQuery(service: string, errorClass: string): string {
  return `is:unresolved ${errorClass} tags[service]:${service}`;
}

// ---------------------------------------------------------------------------
// Stack trace extraction
// ---------------------------------------------------------------------------

/**
 * Extract and normalize a stack trace from a Sentry event.
 * Returns only in-app frames (filters out library code).
 */
export function extractStackTrace(
  event: SentryEvent,
  issueId: string,
): ScrubbledStackTrace | null {
  for (const entry of event.entries ?? []) {
    if (entry.type !== 'exception') continue;

    const data = entry.data as Record<string, unknown> | undefined;
    const values = data?.values as unknown[] | undefined;
    const exception = values?.[0] as Record<string, unknown> | undefined;
    if (!exception) continue;

    const stacktrace = exception.stacktrace as Record<string, unknown> | undefined;
    const rawFrames = stacktrace?.frames as unknown[] | undefined;
    if (!rawFrames) continue;

    const inAppFrames: SentryStackFrame[] = rawFrames
      .filter((f: unknown) => {
        const frame = f as Record<string, unknown>;
        return frame.in_app !== false;
      })
      .map((f: unknown) => {
        const frame = f as Record<string, unknown>;
        return {
          filename: String(frame.filename ?? 'unknown'),
          function: String(frame.function ?? 'unknown'),
          line_number: frame.lineno != null ? Number(frame.lineno) : null,
          column_number: frame.colno != null ? Number(frame.colno) : null,
          module: frame.module != null ? String(frame.module) : null,
          context_line: frame.context_line != null ? String(frame.context_line) : null,
          in_app: frame.in_app !== false,
        };
      });

    if (inAppFrames.length === 0) continue;

    return {
      issue_id: issueId,
      frames: inAppFrames,
      exception_type: String(exception.type ?? 'Unknown'),
      exception_value: String(exception.value ?? ''),
    };
  }

  return null;
}
