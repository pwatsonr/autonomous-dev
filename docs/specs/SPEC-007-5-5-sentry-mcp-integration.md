# SPEC-007-5-5: Sentry MCP Integration

## Metadata
- **Parent Plan**: PLAN-007-5
- **Tasks Covered**: Task 9
- **Estimated effort**: 6 hours

## Description

Wire the Sentry MCP tools (`sentry_list_issues`, `sentry_get_issue_events`, `sentry_get_release_health`) into the data collection pipeline, enriching error observations with user impact counts, stack trace details, and release health metrics. This is a Phase 3 capability that augments the existing Prometheus/Grafana/OpenSearch data sources.

Sentry data passes through the same PII/secret scrubbing pipeline as all other production data before reaching the LLM context or persisting to disk. A dedicated query budget (10 queries, 30s timeout per query) is enforced to prevent Sentry from monopolizing the observation run's resources.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/adapters/sentry-adapter.ts` | Create | Sentry MCP tool wrapper with query budget enforcement |
| `src/adapters/sentry-types.ts` | Create | TypeScript interfaces for Sentry API responses |
| `src/adapters/sentry-enrichment.ts` | Create | Logic to enrich observation candidates with Sentry data |
| `src/runner/observation-runner.ts` | Modify | Wire Sentry adapter into step 3a.v of the runner lifecycle |
| `tests/adapters/sentry-adapter.test.ts` | Create | Unit tests with mock MCP responses |

## Implementation Details

### Sentry Types (`src/adapters/sentry-types.ts`)

```typescript
/** Configuration for the Sentry adapter */
export interface SentryAdapterConfig {
  enabled: boolean;
  project_slug: string;            // Sentry project identifier
  organization_slug: string;       // Sentry organization
  query_budget: number;            // Max queries per observation run (default: 10)
  query_timeout_ms: number;        // Per-query timeout (default: 30000)
}

/** A Sentry issue (from sentry_list_issues) */
export interface SentryIssue {
  id: string;
  title: string;
  culprit: string;                 // File/function where the error originates
  type: string;                    // "error" | "default"
  status: string;                  // "unresolved" | "resolved" | "ignored"
  level: string;                   // "error" | "warning" | "fatal"
  count: string;                   // Total event count (string from API)
  user_count: number;              // Unique affected users
  first_seen: string;              // ISO 8601
  last_seen: string;               // ISO 8601
  short_id: string;                // Human-readable short ID (e.g., "PROJ-123")
  metadata: {
    type?: string;                 // Exception type (e.g., "ConnectionPoolExhaustedError")
    value?: string;                // Exception message
  };
}

/** A Sentry event (from sentry_get_issue_events) */
export interface SentryEvent {
  event_id: string;
  timestamp: string;
  message: string;
  tags: Array<{ key: string; value: string }>;
  entries: SentryEventEntry[];
  contexts?: Record<string, any>;
}

/** An entry in a Sentry event (stack trace, breadcrumbs, etc.) */
export interface SentryEventEntry {
  type: string;                    // "exception" | "breadcrumbs" | "request"
  data: any;
}

/** Stack frame extracted from a Sentry exception entry */
export interface SentryStackFrame {
  filename: string;
  function: string;
  line_number: number | null;
  column_number: number | null;
  module: string | null;
  context_line: string | null;     // Source code at the error line
  in_app: boolean;                 // True if from application code (not library)
}

/** Release health metrics (from sentry_get_release_health) */
export interface SentryReleaseHealth {
  crash_free_sessions: number;     // Percentage (0-100)
  crash_free_users: number;        // Percentage (0-100)
  total_sessions: number;
  adoption: number;                // Percentage of users on this release
  stats: {
    sessions_24h: number;
    sessions_crashed_24h: number;
  };
}

/** Enrichment data extracted from Sentry for an observation */
export interface SentryEnrichment {
  issues: SentryIssueSnapshot[];
  stack_traces: ScrubbledStackTrace[];
  release_health: SentryReleaseHealth | null;
  user_count_total: number;
  queries_used: number;
}

/** Snapshot of a Sentry issue for inclusion in observation reports */
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

/** Stack trace after PII scrubbing */
export interface ScrubbledStackTrace {
  issue_id: string;
  frames: SentryStackFrame[];       // Already scrubbed
  exception_type: string;
  exception_value: string;          // Already scrubbed
}
```

### Sentry Adapter (`src/adapters/sentry-adapter.ts`)

```typescript
import {
  SentryAdapterConfig,
  SentryIssue,
  SentryEvent,
  SentryReleaseHealth,
  SentryEnrichment,
} from './sentry-types';

/**
 * Adapter for Sentry MCP tools with query budget enforcement.
 *
 * Budget tracking:
 * - Each MCP tool call counts as 1 query
 * - Budget is shared across all Sentry calls within a single observation run
 * - When budget is exhausted, remaining calls return null with a warning
 */
export class SentryAdapter {
  private queriesUsed = 0;
  private config: SentryAdapterConfig;
  private mcpClient: McpClient;
  private scrubber: DataSafetyPipeline;
  private logger: AuditLogger;

  constructor(
    config: SentryAdapterConfig,
    mcpClient: McpClient,
    scrubber: DataSafetyPipeline,
    logger: AuditLogger
  ) {
    this.config = config;
    this.mcpClient = mcpClient;
    this.scrubber = scrubber;
    this.logger = logger;
  }

  get remainingBudget(): number {
    return Math.max(0, this.config.query_budget - this.queriesUsed);
  }

  /**
   * List unresolved error issues for the configured project.
   * Filters to issues matching the given service/error class.
   *
   * Uses 1 query from the budget.
   */
  async listIssues(
    query?: string,
    sortBy: 'date' | 'freq' | 'priority' = 'date'
  ): Promise<SentryIssue[] | null> {
    if (!this.checkBudget('sentry_list_issues')) return null;

    try {
      const result = await this.mcpClient.callTool('sentry', 'sentry_list_issues', {
        organization_slug: this.config.organization_slug,
        project_slug: this.config.project_slug,
        query: query ?? 'is:unresolved',
        sort: sortBy,
      }, { timeout: this.config.query_timeout_ms });

      this.queriesUsed++;
      return this.parseIssuesResponse(result);
    } catch (err) {
      this.queriesUsed++;
      this.logger.warn(`sentry_list_issues failed: ${err}`);
      return null;
    }
  }

  /**
   * Get events and stack traces for a specific Sentry issue.
   * Applies PII scrubbing to stack traces and exception messages.
   *
   * Uses 1 query from the budget.
   */
  async getIssueEvents(issueId: string): Promise<SentryEvent[] | null> {
    if (!this.checkBudget('sentry_get_issue_events')) return null;

    try {
      const result = await this.mcpClient.callTool('sentry', 'sentry_get_issue_events', {
        issue_id: issueId,
      }, { timeout: this.config.query_timeout_ms });

      this.queriesUsed++;
      const events = this.parseEventsResponse(result);

      // Scrub PII from event data before returning
      return events.map(event => this.scrubEvent(event));
    } catch (err) {
      this.queriesUsed++;
      this.logger.warn(`sentry_get_issue_events failed for ${issueId}: ${err}`);
      return null;
    }
  }

  /**
   * Get release health metrics (crash-free rate, adoption).
   *
   * Uses 1 query from the budget.
   */
  async getReleaseHealth(releaseVersion: string): Promise<SentryReleaseHealth | null> {
    if (!this.checkBudget('sentry_get_release_health')) return null;

    try {
      const result = await this.mcpClient.callTool('sentry', 'sentry_get_release_health', {
        organization_slug: this.config.organization_slug,
        project_slug: this.config.project_slug,
        release: releaseVersion,
      }, { timeout: this.config.query_timeout_ms });

      this.queriesUsed++;
      return this.parseReleaseHealthResponse(result);
    } catch (err) {
      this.queriesUsed++;
      this.logger.warn(`sentry_get_release_health failed for ${releaseVersion}: ${err}`);
      return null;
    }
  }

  /**
   * Check if budget allows another query. Logs a warning and returns
   * false if the budget is exhausted.
   */
  private checkBudget(toolName: string): boolean {
    if (this.queriesUsed >= this.config.query_budget) {
      this.logger.warn(
        `Sentry query budget exhausted (${this.config.query_budget}). ` +
        `Skipping ${toolName}.`
      );
      return false;
    }
    return true;
  }

  /**
   * Scrub PII from a Sentry event.
   * Applies the PII/secret scrubbing pipeline from SPEC-007-2-2.
   */
  private scrubEvent(event: SentryEvent): SentryEvent {
    return {
      ...event,
      message: this.scrubber.scrubText(event.message),
      entries: event.entries.map(entry => {
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
  private scrubExceptionData(data: any): any {
    if (!data?.values) return data;
    return {
      ...data,
      values: data.values.map((exc: any) => ({
        ...exc,
        value: this.scrubber.scrubText(exc.value ?? ''),
        stacktrace: exc.stacktrace ? {
          ...exc.stacktrace,
          frames: (exc.stacktrace.frames ?? []).map((frame: any) => ({
            ...frame,
            context_line: frame.context_line
              ? this.scrubber.scrubText(frame.context_line)
              : null,
            vars: frame.vars
              ? this.scrubber.scrubObject(frame.vars)
              : null,
          })),
        } : null,
      })),
    };
  }

  /**
   * Scrub request entry data: headers, query strings, body.
   */
  private scrubRequestData(data: any): any {
    if (!data) return data;
    return {
      ...data,
      headers: data.headers
        ? this.scrubber.scrubObject(data.headers)
        : null,
      query_string: data.query_string
        ? this.scrubber.scrubText(data.query_string)
        : null,
      data: data.data
        ? this.scrubber.scrubText(
            typeof data.data === 'string' ? data.data : JSON.stringify(data.data)
          )
        : null,
    };
  }

  /** Reset query counter (called at the start of each observation run) */
  resetBudget(): void {
    this.queriesUsed = 0;
  }
}
```

### Sentry Enrichment (`src/adapters/sentry-enrichment.ts`)

```typescript
import { SentryAdapter } from './sentry-adapter';
import {
  SentryEnrichment,
  SentryIssueSnapshot,
  ScrubbledStackTrace,
  SentryStackFrame,
} from './sentry-types';

/**
 * Enrich an observation candidate with Sentry data.
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
export async function enrichWithSentry(
  adapter: SentryAdapter,
  service: string,
  errorClass: string,
  releaseVersion?: string,
  maxIssues: number = 5
): Promise<SentryEnrichment> {
  const enrichment: SentryEnrichment = {
    issues: [],
    stack_traces: [],
    release_health: null,
    user_count_total: 0,
    queries_used: 0,
  };

  // Step 1: List issues
  const query = buildSentryQuery(service, errorClass);
  const issues = await adapter.listIssues(query, 'freq');
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
      const events = await adapter.getIssueEvents(issue.id);
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
    enrichment.release_health = await adapter.getReleaseHealth(releaseVersion);
    enrichment.queries_used++;
  }

  return enrichment;
}

/**
 * Build a Sentry search query for a service + error class.
 */
function buildSentryQuery(service: string, errorClass: string): string {
  // Sentry search syntax: combine tags and free text
  return `is:unresolved ${errorClass} tags[service]:${service}`;
}

/**
 * Extract and normalize a stack trace from a Sentry event.
 * Returns only in-app frames (filters out library code).
 */
function extractStackTrace(
  event: any,
  issueId: string
): ScrubbledStackTrace | null {
  for (const entry of event.entries ?? []) {
    if (entry.type !== 'exception') continue;

    const exception = entry.data?.values?.[0];
    if (!exception?.stacktrace?.frames) continue;

    const inAppFrames: SentryStackFrame[] = exception.stacktrace.frames
      .filter((f: any) => f.in_app !== false)
      .map((f: any) => ({
        filename: f.filename ?? 'unknown',
        function: f.function ?? 'unknown',
        line_number: f.lineno ?? null,
        column_number: f.colno ?? null,
        module: f.module ?? null,
        context_line: f.context_line ?? null,
        in_app: f.in_app ?? true,
      }));

    if (inAppFrames.length === 0) continue;

    return {
      issue_id: issueId,
      frames: inAppFrames,
      exception_type: exception.type ?? 'Unknown',
      exception_value: exception.value ?? '',
    };
  }

  return null;
}
```

**Runner integration** (modification to `src/runner/observation-runner.ts`):

```typescript
// In step 3a, add Sentry queries after existing data sources:

// Step 3a.v: Query Sentry for error issues (Phase 3)
if (sentryAdapter && dataSourceStatus.sentry === 'available') {
  const sentryData = await enrichWithSentry(
    sentryAdapter,
    serviceConfig.name,
    candidate.error_class,
    serviceConfig.release_version
  );
  candidate.sentryEnrichment = sentryData;
  logger.info(
    `Sentry enrichment for ${serviceConfig.name}: ` +
    `${sentryData.issues.length} issues, ${sentryData.user_count_total} users, ` +
    `${sentryData.queries_used} queries used`
  );
}
```

## Acceptance Criteria

1. [ ] `SentryAdapter.listIssues` retrieves unresolved error issues for a project via the `sentry_list_issues` MCP tool.
2. [ ] `SentryAdapter.getIssueEvents` retrieves events and stack traces for a specific issue via `sentry_get_issue_events`.
3. [ ] `SentryAdapter.getReleaseHealth` retrieves crash-free rate, adoption, and session stats via `sentry_get_release_health`.
4. [ ] All Sentry data passes through the PII/secret scrubbing pipeline before being used or persisted. Specifically: exception values, context lines, local variables, request headers, query strings, and request bodies are scrubbed.
5. [ ] Query budget of 10 queries (configurable) is enforced. When exhausted, subsequent calls return `null` with a warning logged.
6. [ ] Per-query timeout of 30s (configurable) is enforced via MCP call options.
7. [ ] Sentry enrichment data (user counts, stack traces, release health) is attached to observation candidates for inclusion in report generation.
8. [ ] Stack trace extraction filters to in-app frames only, excluding library/framework frames.
9. [ ] If Sentry MCP server is `not_configured` or `unreachable`, the observation run proceeds without Sentry data (graceful degradation).
10. [ ] Budget is reset at the start of each observation run.
11. [ ] `enrichWithSentry` stays within the query budget even for services with many Sentry issues (caps at `maxIssues`, default 5).

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-5-5-01 | List issues returns parsed results | Mock MCP returns 3 issues | 3 `SentryIssue` objects with correct fields |
| TC-5-5-02 | List issues with empty result | Mock MCP returns 0 issues | Empty array, 1 query used |
| TC-5-5-03 | Get issue events with stack trace | Mock MCP returns event with exception entry | `SentryEvent` with scrubbed exception values and stack frames |
| TC-5-5-04 | Get release health | Mock MCP returns release health | `SentryReleaseHealth` with crash_free_sessions, adoption |
| TC-5-5-05 | Budget enforcement -- at limit | 10 queries already used, 11th call attempted | Returns `null`, warning logged, query count stays at 10 |
| TC-5-5-06 | Budget enforcement -- across calls | 3 listIssues + 5 getIssueEvents + 1 getReleaseHealth = 9 | 9 queries used, 1 remaining |
| TC-5-5-07 | Budget reset | After 10 queries, reset called | `remainingBudget` returns 10 |
| TC-5-5-08 | PII scrubbing -- exception value | Exception message contains "user john@example.com" | Scrubbed to "user [REDACTED:email]" |
| TC-5-5-09 | PII scrubbing -- context line | Stack frame context_line contains "apiKey=sk-proj-abc123" | Scrubbed to "apiKey=[SECRET_REDACTED]" |
| TC-5-5-10 | PII scrubbing -- request headers | Request entry has `Authorization: Bearer token123` | Scrubbed to `Authorization: [SECRET_REDACTED]` |
| TC-5-5-11 | PII scrubbing -- local variables | Stack frame vars contain `{email: "user@test.com"}` | Scrubbed to `{email: "[REDACTED:email]"}` |
| TC-5-5-12 | Query timeout | MCP call takes >30s | Error caught, returns null, query counted |
| TC-5-5-13 | Graceful degradation | Sentry MCP unreachable | Observation run proceeds, data_sources.sentry = "unreachable" |
| TC-5-5-14 | Stack trace filtering | 10 frames, 4 in-app | Only 4 frames in the extracted stack trace |
| TC-5-5-15 | Enrichment budget math | 1 listIssues + 5 getIssueEvents + 1 getReleaseHealth | 7 queries used, 3 remaining |
| TC-5-5-16 | Enrichment with capped issues | 20 Sentry issues, maxIssues=5 | Only top 5 by frequency enriched |
| TC-5-5-17 | Enrichment without release version | No release version provided | Release health query skipped, budget saved |
| TC-5-5-18 | Sentry search query format | service="api-gateway", errorClass="ConnectionPoolExhausted" | Query: `is:unresolved ConnectionPoolExhausted tags[service]:api-gateway` |
