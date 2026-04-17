/**
 * Unit tests for Sentry MCP data collection adapter (SPEC-007-5-5, Task 9).
 *
 * Test case IDs correspond to the spec's test matrix:
 *   TC-5-5-01 through TC-5-5-18.
 */

import { SentryAdapter } from '../../src/adapters/sentry-adapter';
import type { DataScrubber } from '../../src/adapters/sentry-adapter';
import { NOOP_SCRUBBER } from '../../src/adapters/sentry-adapter';
import {
  enrichWithSentry,
  buildSentryQuery,
  extractStackTrace,
} from '../../src/adapters/sentry-enrichment';
import type {
  McpToolCaller,
  ConnectivityReport,
} from '../../src/adapters/types';
import {
  DefaultQueryBudgetTracker,
  AdapterTimeoutError,
} from '../../src/adapters/types';
import type {
  SentryAdapterConfig,
  SentryEvent,
  SentryIssue,
} from '../../src/adapters/sentry-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a default Sentry adapter config. */
function buildConfig(
  overrides: Partial<SentryAdapterConfig> = {},
): SentryAdapterConfig {
  return {
    enabled: true,
    project_slug: 'test-project',
    organization_slug: 'test-org',
    query_budget: 10,
    query_timeout_ms: 30_000,
    ...overrides,
  };
}

/** Builds a mock MCP tool caller that records calls and returns a value. */
function buildMockMcp(response: unknown = []): {
  mcp: McpToolCaller;
  calls: Array<{ toolName: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ toolName: string; params: Record<string, unknown> }> = [];
  const mcp: McpToolCaller = {
    callTool: async (toolName, params) => {
      calls.push({ toolName, params });
      return response;
    },
  };
  return { mcp, calls };
}

/** Builds a mock MCP that returns different responses per tool name. */
function buildRoutingMcp(
  responses: Record<string, unknown>,
): { mcp: McpToolCaller; calls: Array<{ toolName: string; params: Record<string, unknown> }> } {
  const calls: Array<{ toolName: string; params: Record<string, unknown> }> = [];
  const mcp: McpToolCaller = {
    callTool: async (toolName, params) => {
      calls.push({ toolName, params });
      return responses[toolName] ?? [];
    },
  };
  return { mcp, calls };
}

/** Builds a default query budget tracker. */
function buildBudget(
  overrides: Partial<Record<string, { max_queries_per_service: number; timeout_seconds: number }>> = {},
): DefaultQueryBudgetTracker {
  return new DefaultQueryBudgetTracker({
    prometheus: { max_queries_per_service: 20, timeout_seconds: 30 },
    grafana: { max_queries_per_service: 10, timeout_seconds: 30 },
    opensearch: { max_queries_per_service: 15, timeout_seconds: 60 },
    sentry: { max_queries_per_service: 10, timeout_seconds: 30 },
    ...overrides,
  });
}

/** Builds a ConnectivityReport with the given Sentry status. */
function buildConnectivity(
  sentryStatus: 'available' | 'degraded' | 'unreachable' = 'available',
): ConnectivityReport {
  return {
    results: [
      { source: 'prometheus', status: 'available', response_time_ms: 50 },
      { source: 'grafana', status: 'available', response_time_ms: 30 },
      { source: 'opensearch', status: 'available', response_time_ms: 40 },
      { source: 'sentry', status: sentryStatus, response_time_ms: 20 },
    ],
    all_unreachable: false,
    timestamp: new Date().toISOString(),
  };
}

/** Builds a mock Sentry issues list response. */
function buildMockIssuesResponse(count: number = 3): unknown[] {
  const issues = [];
  for (let i = 1; i <= count; i++) {
    issues.push({
      id: `issue-${i}`,
      title: `Error in handler ${i}`,
      culprit: `app/handlers/handler${i}.py`,
      type: 'error',
      status: 'unresolved',
      level: 'error',
      count: String(i * 100),
      userCount: i * 10,
      firstSeen: '2026-04-01T10:00:00.000Z',
      lastSeen: '2026-04-08T09:30:00.000Z',
      shortId: `PROJ-${i}`,
      metadata: {
        type: `Error${i}`,
        value: `Something went wrong #${i}`,
      },
    });
  }
  return issues;
}

/** Builds a mock Sentry event with an exception entry and stack trace. */
function buildMockEventResponse(options: {
  message?: string;
  exceptionType?: string;
  exceptionValue?: string;
  frames?: Array<Record<string, unknown>>;
  requestData?: Record<string, unknown>;
} = {}): unknown[] {
  const defaultFrames = [
    {
      filename: 'app/handlers/api.py',
      function: 'handle_request',
      lineno: 42,
      colno: 8,
      module: 'app.handlers.api',
      context_line: '    result = db.query(user_id)',
      in_app: true,
    },
    {
      filename: 'app/db/pool.py',
      function: 'get_connection',
      lineno: 15,
      colno: 4,
      module: 'app.db.pool',
      context_line: '    raise ConnectionPoolExhaustedError()',
      in_app: true,
    },
    {
      filename: 'lib/sqlalchemy/pool.py',
      function: 'checkout',
      lineno: 891,
      colno: 12,
      module: 'sqlalchemy.pool',
      context_line: '    return self._pool.get()',
      in_app: false,
    },
    {
      filename: 'lib/sqlalchemy/queue.py',
      function: 'get',
      lineno: 204,
      colno: 8,
      module: 'sqlalchemy.queue',
      context_line: '    raise Empty',
      in_app: false,
    },
  ];

  const entries: unknown[] = [
    {
      type: 'exception',
      data: {
        values: [
          {
            type: options.exceptionType ?? 'ConnectionPoolExhaustedError',
            value: options.exceptionValue ?? 'Connection pool exhausted, max connections reached',
            stacktrace: {
              frames: options.frames ?? defaultFrames,
            },
          },
        ],
      },
    },
  ];

  if (options.requestData) {
    entries.push({
      type: 'request',
      data: options.requestData,
    });
  }

  return [
    {
      eventID: 'event-001',
      dateCreated: '2026-04-08T09:30:00.000Z',
      message: options.message ?? 'ConnectionPoolExhaustedError: Connection pool exhausted',
      tags: [
        { key: 'service', value: 'api-gateway' },
        { key: 'environment', value: 'production' },
      ],
      entries,
      contexts: { os: { name: 'Linux' } },
    },
  ];
}

/** Builds a mock Sentry release health response. */
function buildMockReleaseHealthResponse(): Record<string, unknown> {
  return {
    crashFreeSessions: 99.5,
    crashFreeUsers: 99.8,
    totalSessions: 50000,
    adoption: 85.2,
    stats: {
      sessions_24h: 12000,
      sessions_crashed_24h: 60,
    },
  };
}

/** Builds a PII-aware test scrubber. */
function buildTestScrubber(): DataScrubber {
  const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
  const secretRegex = /(sk-proj-[\w]+|Bearer\s+[\w]+|apiKey=[\w]+)/g;

  return {
    scrubText(text: string): string {
      return text
        .replace(emailRegex, '[REDACTED:email]')
        .replace(secretRegex, '[SECRET_REDACTED]');
    },
    scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          result[key] = this.scrubText(value);
        } else {
          result[key] = value;
        }
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// TC-5-5-01: List issues returns parsed results
// ---------------------------------------------------------------------------

describe('SentryAdapter', () => {
  describe('TC-5-5-01: listIssues returns parsed results', () => {
    test('returns 3 SentryIssue objects with correct fields from mock MCP', async () => {
      const { mcp, calls } = buildMockMcp(buildMockIssuesResponse(3));
      const budget = buildBudget();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget);

      const issues = await adapter.listIssues(undefined, 'date', 'api-gateway');

      expect(issues).not.toBeNull();
      expect(issues).toHaveLength(3);
      expect(issues![0].id).toBe('issue-1');
      expect(issues![0].title).toBe('Error in handler 1');
      expect(issues![0].short_id).toBe('PROJ-1');
      expect(issues![0].user_count).toBe(10);
      expect(issues![0].count).toBe('100');
      expect(issues![0].metadata.type).toBe('Error1');

      expect(calls).toHaveLength(1);
      expect(calls[0].toolName).toBe('sentry_list_issues');
      expect(calls[0].params.organization_slug).toBe('test-org');
      expect(calls[0].params.project_slug).toBe('test-project');
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-02: List issues with empty result
  // ---------------------------------------------------------------------------

  describe('TC-5-5-02: listIssues with empty result', () => {
    test('returns empty array and uses 1 query', async () => {
      const { mcp } = buildMockMcp([]);
      const budget = buildBudget();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget);

      const issues = await adapter.listIssues(undefined, 'date', 'api-gateway');

      expect(issues).toEqual([]);
      expect(adapter.remainingBudget).toBe(9);
      expect(budget.remaining('sentry', 'api-gateway')).toBe(9);
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-03: Get issue events with stack trace
  // ---------------------------------------------------------------------------

  describe('TC-5-5-03: getIssueEvents with stack trace', () => {
    test('returns SentryEvent with scrubbed exception values and stack frames', async () => {
      const { mcp } = buildMockMcp(buildMockEventResponse({
        message: 'Error from user john@example.com',
        exceptionValue: 'Connection from john@example.com failed',
      }));
      const budget = buildBudget();
      const scrubber = buildTestScrubber();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget, scrubber);

      const events = await adapter.getIssueEvents('issue-1', 'api-gateway');

      expect(events).not.toBeNull();
      expect(events).toHaveLength(1);
      expect(events![0].event_id).toBe('event-001');

      // Message should be scrubbed
      expect(events![0].message).toBe('Error from user [REDACTED:email]');

      // Exception value should be scrubbed
      const exceptionEntry = events![0].entries.find((e) => e.type === 'exception');
      expect(exceptionEntry).toBeDefined();
      const values = (exceptionEntry!.data as Record<string, unknown>).values as unknown[];
      const firstException = values[0] as Record<string, unknown>;
      expect(firstException.value).toBe('Connection from [REDACTED:email] failed');
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-04: Get release health
  // ---------------------------------------------------------------------------

  describe('TC-5-5-04: getReleaseHealth', () => {
    test('returns SentryReleaseHealth with crash_free_sessions and adoption', async () => {
      const { mcp, calls } = buildMockMcp(buildMockReleaseHealthResponse());
      const budget = buildBudget();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget);

      const health = await adapter.getReleaseHealth('v2.3.1', 'api-gateway');

      expect(health).not.toBeNull();
      expect(health!.crash_free_sessions).toBe(99.5);
      expect(health!.crash_free_users).toBe(99.8);
      expect(health!.total_sessions).toBe(50000);
      expect(health!.adoption).toBe(85.2);
      expect(health!.stats.sessions_24h).toBe(12000);
      expect(health!.stats.sessions_crashed_24h).toBe(60);

      expect(calls[0].toolName).toBe('sentry_get_release_health');
      expect(calls[0].params.release).toBe('v2.3.1');
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-05: Budget enforcement -- at limit
  // ---------------------------------------------------------------------------

  describe('TC-5-5-05: budget enforcement at limit', () => {
    test('returns null when 10 queries already used, 11th call attempted', async () => {
      const { mcp, calls } = buildMockMcp(buildMockIssuesResponse());
      const budget = buildBudget();
      const config = buildConfig({ query_budget: 10 });
      const adapter = new SentryAdapter(config, mcp, budget);

      // Use up all 10 queries
      for (let i = 0; i < 10; i++) {
        await adapter.listIssues(undefined, 'date', `svc-${i}`);
      }

      expect(adapter.remainingBudget).toBe(0);

      // 11th call should return null
      const result = await adapter.listIssues(undefined, 'date', 'api-gateway');
      expect(result).toBeNull();

      // MCP should have been called exactly 10 times (not 11)
      expect(calls).toHaveLength(10);
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-06: Budget enforcement -- across calls
  // ---------------------------------------------------------------------------

  describe('TC-5-5-06: budget enforcement across call types', () => {
    test('3 listIssues + 5 getIssueEvents + 1 getReleaseHealth = 9 queries used', async () => {
      const { mcp: issueMcp } = buildRoutingMcp({
        sentry_list_issues: buildMockIssuesResponse(),
        sentry_get_issue_events: buildMockEventResponse(),
        sentry_get_release_health: buildMockReleaseHealthResponse(),
      });
      const budget = buildBudget();
      const adapter = new SentryAdapter(buildConfig(), issueMcp, budget);

      // 3 listIssues
      for (let i = 0; i < 3; i++) {
        await adapter.listIssues(undefined, 'date', `svc-${i}`);
      }
      // 5 getIssueEvents
      for (let i = 0; i < 5; i++) {
        await adapter.getIssueEvents(`issue-${i}`, `svc-${i}`);
      }
      // 1 getReleaseHealth
      await adapter.getReleaseHealth('v1.0.0', 'svc-0');

      expect(adapter.remainingBudget).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-07: Budget reset
  // ---------------------------------------------------------------------------

  describe('TC-5-5-07: budget reset', () => {
    test('after 10 queries, reset called, remainingBudget returns 10', async () => {
      const { mcp } = buildMockMcp(buildMockIssuesResponse());
      const budget = buildBudget();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget);

      // Use all queries
      for (let i = 0; i < 10; i++) {
        await adapter.listIssues(undefined, 'date', `svc-${i}`);
      }
      expect(adapter.remainingBudget).toBe(0);

      // Reset
      adapter.resetBudget();
      expect(adapter.remainingBudget).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-08: PII scrubbing -- exception value
  // ---------------------------------------------------------------------------

  describe('TC-5-5-08: PII scrubbing -- exception value', () => {
    test('exception message containing email is scrubbed', async () => {
      const { mcp } = buildMockMcp(buildMockEventResponse({
        exceptionValue: 'Failed for user john@example.com',
      }));
      const budget = buildBudget();
      const scrubber = buildTestScrubber();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget, scrubber);

      const events = await adapter.getIssueEvents('issue-1', 'api-gateway');

      const exceptionEntry = events![0].entries.find((e) => e.type === 'exception');
      const values = (exceptionEntry!.data as Record<string, unknown>).values as unknown[];
      const exc = values[0] as Record<string, unknown>;
      expect(exc.value).toBe('Failed for user [REDACTED:email]');
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-09: PII scrubbing -- context line
  // ---------------------------------------------------------------------------

  describe('TC-5-5-09: PII scrubbing -- context line', () => {
    test('stack frame context_line containing secret is scrubbed', async () => {
      const frames = [
        {
          filename: 'app/config.py',
          function: 'load_config',
          lineno: 10,
          colno: 4,
          module: 'app.config',
          context_line: '    apiKey=sk-proj-abc123xyz',
          in_app: true,
        },
      ];
      const { mcp } = buildMockMcp(buildMockEventResponse({ frames }));
      const budget = buildBudget();
      const scrubber = buildTestScrubber();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget, scrubber);

      const events = await adapter.getIssueEvents('issue-1', 'api-gateway');

      const exceptionEntry = events![0].entries.find((e) => e.type === 'exception');
      const values = (exceptionEntry!.data as Record<string, unknown>).values as unknown[];
      const exc = values[0] as Record<string, unknown>;
      const stacktrace = exc.stacktrace as Record<string, unknown>;
      const scrubbedFrames = stacktrace.frames as Array<Record<string, unknown>>;
      expect(scrubbedFrames[0].context_line).toBe('    [SECRET_REDACTED]');
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-10: PII scrubbing -- request headers
  // ---------------------------------------------------------------------------

  describe('TC-5-5-10: PII scrubbing -- request headers', () => {
    test('request entry Authorization header is scrubbed', async () => {
      const { mcp } = buildMockMcp(buildMockEventResponse({
        requestData: {
          url: 'https://api.example.com/users',
          method: 'GET',
          headers: {
            Authorization: 'Bearer token123abc',
            'Content-Type': 'application/json',
          },
          query_string: 'email=user@test.com',
          data: null,
        },
      }));
      const budget = buildBudget();
      const scrubber = buildTestScrubber();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget, scrubber);

      const events = await adapter.getIssueEvents('issue-1', 'api-gateway');

      const requestEntry = events![0].entries.find((e) => e.type === 'request');
      expect(requestEntry).toBeDefined();
      const data = requestEntry!.data as Record<string, unknown>;
      const headers = data.headers as Record<string, unknown>;
      expect(headers.Authorization).toBe('[SECRET_REDACTED]');
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-11: PII scrubbing -- local variables
  // ---------------------------------------------------------------------------

  describe('TC-5-5-11: PII scrubbing -- local variables', () => {
    test('stack frame vars containing email are scrubbed', async () => {
      const frames = [
        {
          filename: 'app/handlers/api.py',
          function: 'handle_request',
          lineno: 42,
          colno: 8,
          module: 'app.handlers.api',
          context_line: '    result = db.query(user_id)',
          in_app: true,
          vars: { email: 'user@test.com', user_id: '12345' },
        },
      ];
      const { mcp } = buildMockMcp(buildMockEventResponse({ frames }));
      const budget = buildBudget();
      const scrubber = buildTestScrubber();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget, scrubber);

      const events = await adapter.getIssueEvents('issue-1', 'api-gateway');

      const exceptionEntry = events![0].entries.find((e) => e.type === 'exception');
      const values = (exceptionEntry!.data as Record<string, unknown>).values as unknown[];
      const exc = values[0] as Record<string, unknown>;
      const stacktrace = exc.stacktrace as Record<string, unknown>;
      const scrubbedFrames = stacktrace.frames as Array<Record<string, unknown>>;
      const vars = scrubbedFrames[0].vars as Record<string, unknown>;
      expect(vars.email).toBe('[REDACTED:email]');
      // Non-PII values should be unchanged
      expect(vars.user_id).toBe('12345');
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-12: Query timeout
  // ---------------------------------------------------------------------------

  describe('TC-5-5-12: query timeout', () => {
    test('MCP call exceeding timeout throws AdapterTimeoutError', async () => {
      const slowMcp: McpToolCaller = {
        callTool: () => new Promise((resolve) => {
          setTimeout(() => resolve({}), 5000);
        }),
      };
      const budget = buildBudget();
      const config = buildConfig({ query_timeout_ms: 50 });
      const adapter = new SentryAdapter(config, slowMcp, budget);

      await expect(
        adapter.listIssues(undefined, 'date', 'api-gateway'),
      ).rejects.toThrow(AdapterTimeoutError);
    });

    test('timeout error includes source and query name', async () => {
      const slowMcp: McpToolCaller = {
        callTool: () => new Promise((resolve) => {
          setTimeout(() => resolve({}), 5000);
        }),
      };
      const budget = buildBudget();
      const config = buildConfig({ query_timeout_ms: 50 });
      const adapter = new SentryAdapter(config, slowMcp, budget);

      try {
        await adapter.listIssues(undefined, 'date', 'api-gateway');
        fail('Expected AdapterTimeoutError');
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterTimeoutError);
        const timeoutErr = err as AdapterTimeoutError;
        expect(timeoutErr.source).toBe('sentry');
        expect(timeoutErr.queryName).toBe('sentry_list_issues');
      }
    });

    test('query is still counted after timeout', async () => {
      const slowMcp: McpToolCaller = {
        callTool: () => new Promise((resolve) => {
          setTimeout(() => resolve({}), 5000);
        }),
      };
      const budget = buildBudget();
      const config = buildConfig({ query_timeout_ms: 50 });
      const adapter = new SentryAdapter(config, slowMcp, budget);

      try {
        await adapter.listIssues(undefined, 'date', 'api-gateway');
      } catch {
        // Expected
      }

      expect(adapter.remainingBudget).toBe(9);
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-13: Graceful degradation -- unreachable
  // ---------------------------------------------------------------------------

  describe('TC-5-5-13: graceful degradation', () => {
    test('returns null when Sentry MCP is unreachable', async () => {
      const { mcp, calls } = buildMockMcp(buildMockIssuesResponse());
      const budget = buildBudget();
      const connectivity = buildConnectivity('unreachable');
      const adapter = new SentryAdapter(buildConfig(), mcp, budget, NOOP_SCRUBBER, connectivity);

      const issues = await adapter.listIssues(undefined, 'date', 'api-gateway');

      expect(issues).toBeNull();
      expect(calls).toHaveLength(0);
      // Budget should not be consumed
      expect(adapter.remainingBudget).toBe(10);
    });

    test('queries normally when Sentry MCP is available', async () => {
      const { mcp, calls } = buildMockMcp(buildMockIssuesResponse());
      const budget = buildBudget();
      const connectivity = buildConnectivity('available');
      const adapter = new SentryAdapter(buildConfig(), mcp, budget, NOOP_SCRUBBER, connectivity);

      const issues = await adapter.listIssues(undefined, 'date', 'api-gateway');

      expect(issues).not.toBeNull();
      expect(issues).toHaveLength(3);
      expect(calls).toHaveLength(1);
    });

    test('queries normally when Sentry MCP is degraded', async () => {
      const { mcp, calls } = buildMockMcp(buildMockIssuesResponse());
      const budget = buildBudget();
      const connectivity = buildConnectivity('degraded');
      const adapter = new SentryAdapter(buildConfig(), mcp, budget, NOOP_SCRUBBER, connectivity);

      const issues = await adapter.listIssues(undefined, 'date', 'api-gateway');

      expect(issues).not.toBeNull();
      expect(calls).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-14: Stack trace filtering
  // ---------------------------------------------------------------------------

  describe('TC-5-5-14: stack trace filtering', () => {
    test('10 frames, 4 in-app: only 4 frames in extracted stack trace', () => {
      const frames: Array<Record<string, unknown>> = [];
      // 4 in-app frames
      for (let i = 0; i < 4; i++) {
        frames.push({
          filename: `app/module${i}.py`,
          function: `fn${i}`,
          lineno: i * 10,
          colno: 4,
          module: `app.module${i}`,
          context_line: `    line ${i}`,
          in_app: true,
        });
      }
      // 6 library frames
      for (let i = 0; i < 6; i++) {
        frames.push({
          filename: `lib/external${i}.py`,
          function: `lib_fn${i}`,
          lineno: i * 10,
          colno: 4,
          module: `external.lib${i}`,
          context_line: `    lib line ${i}`,
          in_app: false,
        });
      }

      const event: SentryEvent = {
        event_id: 'evt-1',
        timestamp: '2026-04-08T10:00:00Z',
        message: 'Test error',
        tags: [],
        entries: [
          {
            type: 'exception',
            data: {
              values: [{
                type: 'TestError',
                value: 'test',
                stacktrace: { frames },
              }],
            },
          },
        ],
      };

      const result = extractStackTrace(event, 'issue-1');

      expect(result).not.toBeNull();
      expect(result!.frames).toHaveLength(4);
      expect(result!.frames.every((f) => f.in_app)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Enrichment tests
// ---------------------------------------------------------------------------

describe('enrichWithSentry', () => {
  // ---------------------------------------------------------------------------
  // TC-5-5-15: Enrichment budget math
  // ---------------------------------------------------------------------------

  describe('TC-5-5-15: enrichment budget math', () => {
    test('1 listIssues + 5 getIssueEvents + 1 getReleaseHealth = 7 queries used', async () => {
      const { mcp } = buildRoutingMcp({
        sentry_list_issues: buildMockIssuesResponse(5),
        sentry_get_issue_events: buildMockEventResponse(),
        sentry_get_release_health: buildMockReleaseHealthResponse(),
      });
      const budget = buildBudget();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget);

      const enrichment = await enrichWithSentry(
        adapter,
        'api-gateway',
        'ConnectionPoolExhaustedError',
        'v2.3.1',
        5,
        'api-gateway',
      );

      expect(enrichment.queries_used).toBe(7);
      expect(adapter.remainingBudget).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-16: Enrichment with capped issues
  // ---------------------------------------------------------------------------

  describe('TC-5-5-16: enrichment with capped issues', () => {
    test('20 Sentry issues, maxIssues=5: only top 5 by frequency enriched', async () => {
      const { mcp } = buildRoutingMcp({
        sentry_list_issues: buildMockIssuesResponse(20),
        sentry_get_issue_events: buildMockEventResponse(),
      });
      const budget = buildBudget();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget);

      const enrichment = await enrichWithSentry(
        adapter,
        'api-gateway',
        'Error',
        undefined,
        5,
        'api-gateway',
      );

      // Should have exactly 5 issue snapshots
      expect(enrichment.issues).toHaveLength(5);
      // Stack traces fetched for each of the 5
      expect(enrichment.stack_traces.length).toBeLessThanOrEqual(5);
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-17: Enrichment without release version
  // ---------------------------------------------------------------------------

  describe('TC-5-5-17: enrichment without release version', () => {
    test('release health query skipped when no version provided', async () => {
      const { mcp, calls } = buildRoutingMcp({
        sentry_list_issues: buildMockIssuesResponse(2),
        sentry_get_issue_events: buildMockEventResponse(),
      });
      const budget = buildBudget();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget);

      const enrichment = await enrichWithSentry(
        adapter,
        'api-gateway',
        'Error',
        undefined, // No release version
        5,
        'api-gateway',
      );

      expect(enrichment.release_health).toBeNull();

      // Should not have called sentry_get_release_health
      const releaseHealthCalls = calls.filter(
        (c) => c.toolName === 'sentry_get_release_health',
      );
      expect(releaseHealthCalls).toHaveLength(0);

      // 1 listIssues + 2 getIssueEvents = 3 queries
      expect(enrichment.queries_used).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // TC-5-5-18: Sentry search query format
  // ---------------------------------------------------------------------------

  describe('TC-5-5-18: sentry search query format', () => {
    test('builds correct query for service and error class', () => {
      const query = buildSentryQuery('api-gateway', 'ConnectionPoolExhausted');
      expect(query).toBe('is:unresolved ConnectionPoolExhausted tags[service]:api-gateway');
    });
  });

  // ---------------------------------------------------------------------------
  // Enrichment with empty issues
  // ---------------------------------------------------------------------------

  describe('enrichment with no matching issues', () => {
    test('returns empty enrichment when listIssues returns empty', async () => {
      const { mcp } = buildMockMcp([]);
      const budget = buildBudget();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget);

      const enrichment = await enrichWithSentry(
        adapter,
        'api-gateway',
        'NonexistentError',
        'v1.0.0',
        5,
        'api-gateway',
      );

      expect(enrichment.issues).toEqual([]);
      expect(enrichment.stack_traces).toEqual([]);
      expect(enrichment.release_health).toBeNull();
      expect(enrichment.user_count_total).toBe(0);
      expect(enrichment.queries_used).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Enrichment user_count_total aggregation
  // ---------------------------------------------------------------------------

  describe('enrichment user_count_total', () => {
    test('aggregates user counts from all enriched issues', async () => {
      const { mcp } = buildRoutingMcp({
        sentry_list_issues: buildMockIssuesResponse(3),
        sentry_get_issue_events: buildMockEventResponse(),
      });
      const budget = buildBudget();
      const adapter = new SentryAdapter(buildConfig(), mcp, budget);

      const enrichment = await enrichWithSentry(
        adapter,
        'api-gateway',
        'Error',
        undefined,
        3,
        'api-gateway',
      );

      // Issues have user_counts of 10, 20, 30
      expect(enrichment.user_count_total).toBe(60);
    });
  });
});
