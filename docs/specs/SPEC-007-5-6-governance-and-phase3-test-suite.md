# SPEC-007-5-6: Governance and Phase 3 Test Suite

## Metadata
- **Parent Plan**: PLAN-007-5
- **Tasks Covered**: Task 10
- **Estimated effort**: 14 hours

## Description

Build the comprehensive test suite covering all governance components (cooldown, oscillation, effectiveness) and Phase 3 features (notification triage, auto-promotion, Sentry integration). This includes unit tests with time-window arithmetic and boundary conditions, integration tests verifying governance checks within the runner lifecycle, and end-to-end tests that exercise the full feedback loop from error detection through effectiveness verification.

The test suite follows the testing strategy from TDD sections 8.1, 8.2, and 8.4, with specific scenarios called out in PLAN-007-5 Task 10.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `tests/governance/cooldown.test.ts` | Create | Cooldown enforcement unit tests (boundary conditions, time windows) |
| `tests/governance/oscillation.test.ts` | Create | Oscillation detection unit tests (counting, thresholds) |
| `tests/governance/effectiveness.test.ts` | Create | Effectiveness evaluation unit tests (metric comparison, classification) |
| `tests/governance/effectiveness-writeback.test.ts` | Create | Writeback idempotency and file integrity tests |
| `tests/governance/auto-promote.test.ts` | Create | Auto-promotion safeguard tests (all 6 conditions individually) |
| `tests/governance/override-scheduler.test.ts` | Create | Override window and cancellation tests |
| `tests/triage/notification.test.ts` | Create | Webhook posting, health checks, message formatting tests |
| `tests/triage/notification-receiver.test.ts` | Create | Command parsing and triage writeback tests |
| `tests/adapters/sentry-adapter.test.ts` | Create | Sentry MCP mock response tests, budget enforcement |
| `tests/reports/weekly-digest.test.ts` | Create | Digest aggregation math and rendering tests |
| `tests/integration/governance-lifecycle.test.ts` | Create | Governance checks within the runner lifecycle |
| `tests/integration/digest-generation.test.ts` | Create | Digest generation with a week of mock data |
| `tests/e2e/full-feedback-loop.test.ts` | Create | Error -> observation -> promote -> PRD -> deploy -> effectiveness |
| `tests/e2e/oscillation-loop.test.ts` | Create | Recurring error -> 3 observations -> oscillation warning |
| `tests/e2e/auto-promote-override.test.ts` | Create | Auto-promote -> override within window -> PRD cancelled |
| `tests/helpers/mock-mcp.ts` | Create | Shared mock MCP server responses for Prometheus, Grafana, OpenSearch, Sentry |
| `tests/helpers/mock-observations.ts` | Create | Factory functions for creating test observation files |
| `tests/helpers/mock-deployments.ts` | Create | Factory functions for creating test deployment metadata |
| `tests/helpers/test-clock.ts` | Create | Controllable time source for deterministic time-window tests |

## Implementation Details

### Test Infrastructure

**Controllable clock** (`tests/helpers/test-clock.ts`):

```typescript
/**
 * Provides a deterministic clock for tests involving time windows.
 * All governance functions accept an optional `now` parameter;
 * tests pass `clock.now()` instead of relying on `new Date()`.
 */
export class TestClock {
  private current: Date;

  constructor(initial: string | Date = '2026-04-08T14:30:00Z') {
    this.current = typeof initial === 'string' ? new Date(initial) : initial;
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 24 * 60 * 60 * 1000);
  }

  advanceHours(hours: number): void {
    this.current = new Date(this.current.getTime() + hours * 60 * 60 * 1000);
  }

  set(date: string | Date): void {
    this.current = typeof date === 'string' ? new Date(date) : date;
  }
}
```

**Mock observation factory** (`tests/helpers/mock-observations.ts`):

```typescript
/**
 * Create a mock observation file on disk with the given frontmatter overrides.
 * Returns the file path.
 */
export async function createMockObservation(
  rootDir: string,
  overrides: Partial<ObservationFrontmatter> = {}
): Promise<{ filePath: string; id: string }> {
  const id = overrides.id ?? generateMockObservationId();
  const defaults: ObservationFrontmatter = {
    id,
    timestamp: '2026-04-08T14:30:00Z',
    service: 'api-gateway',
    repo: 'org/api-gateway',
    type: 'error',
    severity: 'P1',
    confidence: 0.87,
    triage_status: 'pending',
    triage_decision: null,
    triage_by: null,
    triage_at: null,
    triage_reason: null,
    defer_until: null,
    cooldown_active: false,
    linked_prd: null,
    linked_deployment: null,
    effectiveness: null,
    effectiveness_detail: null,
    observation_run_id: 'RUN-20260408-143000',
    tokens_consumed: 35000,
    fingerprint: 'abc123def456',
    occurrence_count: 1,
    data_sources: {
      prometheus: 'available',
      grafana: 'available',
      opensearch: 'available',
      sentry: 'not_configured',
    },
    related_observations: [],
    oscillation_warning: false,
    ...overrides,
  };

  const content = buildMockObservationFile(defaults);
  const filePath = writeToObservationDir(rootDir, id, content);
  return { filePath, id };
}

/**
 * Create N mock observations for the same service+error class,
 * spread across the given number of days.
 */
export async function createObservationSeries(
  rootDir: string,
  service: string,
  errorClass: string,
  count: number,
  spreadDays: number,
  baseDate: string = '2026-04-08T14:30:00Z'
): Promise<Array<{ filePath: string; id: string }>> {
  const results = [];
  const base = new Date(baseDate);
  const intervalMs = (spreadDays * 24 * 60 * 60 * 1000) / count;

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(base.getTime() - (count - 1 - i) * intervalMs);
    const result = await createMockObservation(rootDir, {
      service,
      fingerprint: `${errorClass}-fingerprint`,
      error_class: errorClass,
      timestamp: timestamp.toISOString(),
    });
    results.push(result);
  }

  return results;
}
```

**Mock MCP server** (`tests/helpers/mock-mcp.ts`):

```typescript
/**
 * Mock MCP client that returns predefined responses.
 * Tracks call counts for budget enforcement tests.
 */
export class MockMcpClient {
  private responses: Map<string, any[]> = new Map();
  private callCounts: Map<string, number> = new Map();

  addResponse(server: string, tool: string, response: any): void {
    const key = `${server}:${tool}`;
    const existing = this.responses.get(key) ?? [];
    existing.push(response);
    this.responses.set(key, existing);
  }

  async callTool(server: string, tool: string, params: any, options?: any): Promise<any> {
    const key = `${server}:${tool}`;
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);

    const responses = this.responses.get(key);
    if (!responses || responses.length === 0) {
      throw new Error(`No mock response for ${key}`);
    }

    // Return responses in order; cycle if more calls than responses
    return responses[(count - 1) % responses.length];
  }

  getCallCount(server: string, tool: string): number {
    return this.callCounts.get(`${server}:${tool}`) ?? 0;
  }

  reset(): void {
    this.callCounts.clear();
  }
}

/**
 * Mock Prometheus client for effectiveness tests.
 */
export class MockPrometheusClient {
  private responses: Map<string, number | null> = new Map();

  setResponse(query: string, windowKey: string, value: number | null): void {
    this.responses.set(`${query}:${windowKey}`, value);
  }

  async queryRangeAverage(
    query: string,
    start: Date,
    end: Date,
    stepSeconds: number
  ): Promise<number | null> {
    // Match on query + whether this is a pre or post window
    for (const [key, value] of this.responses) {
      if (key.startsWith(query)) {
        return value;
      }
    }
    return null;
  }
}
```

### Unit Test Specifications

#### Cooldown Tests (`tests/governance/cooldown.test.ts`)

```typescript
describe('checkCooldown', () => {
  const config: GovernanceConfig = {
    cooldown_days: 7,
    oscillation_window_days: 30,
    oscillation_threshold: 3,
    effectiveness_comparison_days: 7,
    effectiveness_improvement_threshold: 10,
  };

  test('active when deploy is within cooldown window', () => {
    // Deploy 3 days ago, cooldown = 7 days
    const clock = new TestClock('2026-04-08T14:30:00Z');
    const deploy = mockDeployment('2026-04-05T10:00:00Z');
    const result = checkCooldown('api-gateway', 'ConnectionPoolExhausted', config,
      () => deploy, clock.now());
    expect(result.active).toBe(true);
    expect(result.linked_deployment).toBe(deploy.id);
    expect(result.reason).toContain('cooldown until');
  });

  test('inactive when deploy is beyond cooldown window', () => {
    // Deploy 8 days ago, cooldown = 7 days
    const clock = new TestClock('2026-04-08T14:30:00Z');
    const deploy = mockDeployment('2026-03-31T10:00:00Z');
    const result = checkCooldown('api-gateway', 'ConnectionPoolExhausted', config,
      () => deploy, clock.now());
    expect(result.active).toBe(false);
  });

  test('exact boundary: deploy exactly cooldown_days ago at midnight', () => {
    // Deploy exactly 7 days ago at midnight, now is midnight
    // cooldown_end = deploy + 7d = now
    // Strict < comparison: now < cooldown_end is false -> inactive
    const clock = new TestClock('2026-04-08T00:00:00Z');
    const deploy = mockDeployment('2026-04-01T00:00:00Z');
    const result = checkCooldown('api-gateway', 'ConnectionPoolExhausted', config,
      () => deploy, clock.now());
    expect(result.active).toBe(false);
  });

  test('inactive when no deployment found', () => {
    const result = checkCooldown('api-gateway', 'ConnectionPoolExhausted', config,
      () => null);
    expect(result.active).toBe(false);
  });

  test('uses most recent of multiple deployments', () => {
    // Two deploys: 3 days ago and 10 days ago
    // findRecentFixDeployment returns the most recent
    const recentDeploy = mockDeployment('2026-04-05T10:00:00Z');
    const clock = new TestClock('2026-04-08T14:30:00Z');
    const result = checkCooldown('api-gateway', 'ConnectionPoolExhausted', config,
      () => recentDeploy, clock.now());
    expect(result.active).toBe(true);
  });
});
```

#### Oscillation Tests (`tests/governance/oscillation.test.ts`)

```typescript
describe('checkOscillation', () => {
  const config: GovernanceConfig = {
    cooldown_days: 7,
    oscillation_window_days: 30,
    oscillation_threshold: 3,
    effectiveness_comparison_days: 7,
    effectiveness_improvement_threshold: 10,
  };

  test('oscillating when count >= threshold', () => {
    const observations = createMockSummaries(3); // 3 observations
    const result = checkOscillation('api-gateway', 'ConnectionPoolExhausted', config,
      () => observations);
    expect(result.oscillating).toBe(true);
    expect(result.count).toBe(3);
    expect(result.recommendation).toBe('systemic_investigation');
  });

  test('not oscillating when count < threshold', () => {
    const observations = createMockSummaries(2); // 2 observations
    const result = checkOscillation('api-gateway', 'ConnectionPoolExhausted', config,
      () => observations);
    expect(result.oscillating).toBe(false);
  });

  test('only counts observations within the window', () => {
    // findObservations is called with the window start date
    // The mock should only return observations after that date
    const clock = new TestClock('2026-04-08T14:30:00Z');
    const windowStart = new Date('2026-03-09T14:30:00Z'); // 30 days before
    const finder = jest.fn().mockReturnValue(createMockSummaries(2));
    checkOscillation('api-gateway', 'ConnectionPoolExhausted', config,
      finder, clock.now());
    expect(finder).toHaveBeenCalledWith('api-gateway', 'ConnectionPoolExhausted', windowStart);
  });

  test('exact threshold: count == threshold is oscillating', () => {
    const observations = createMockSummaries(3); // threshold is 3
    const result = checkOscillation('api-gateway', 'ConnectionPoolExhausted', config,
      () => observations);
    expect(result.oscillating).toBe(true);
  });
});

describe('buildOscillationWarningMarkdown', () => {
  test('produces correct Markdown format', () => {
    const result: OscillationResult = {
      oscillating: true,
      count: 4,
      window_days: 30,
      observation_ids: ['OBS-1', 'OBS-2', 'OBS-3', 'OBS-4'],
      observation_summaries: [
        { id: 'OBS-20260310-100000-a1b2', triage_status: 'promoted', effectiveness: 'degraded', is_current: false },
        { id: 'OBS-20260318-100000-c3d4', triage_status: 'promoted', effectiveness: 'unchanged', is_current: false },
        { id: 'OBS-20260325-100000-e5f6', triage_status: 'promoted', effectiveness: 'pending', is_current: false },
        { id: 'OBS-20260408-143022-a7f3', triage_status: 'pending', effectiveness: null, is_current: true },
      ],
      recommendation: 'systemic_investigation',
    };

    const md = buildOscillationWarningMarkdown(result);
    expect(md).toContain('## Oscillation Warning');
    expect(md).toContain('4 observations in the last 30 days');
    expect(md).toContain('promoted, fix deployed, not effective');
    expect(md).toContain('promoted, fix deployed, partially effective');
    expect(md).toContain('promoted, fix in progress');
    expect(md).toContain('this observation');
    expect(md).toContain('architectural investigation PRD');
  });

  test('returns empty string when not oscillating', () => {
    const md = buildOscillationWarningMarkdown({ oscillating: false });
    expect(md).toBe('');
  });
});
```

#### Effectiveness Tests (`tests/governance/effectiveness.test.ts`)

```typescript
describe('evaluateEffectiveness', () => {
  test('improved: error rate decreased significantly', async () => {
    // pre=12.3%, post=0.6%, direction=decrease, threshold=10%
    const prometheus = new MockPrometheusClient();
    prometheus.setQueryResponse('pre', 12.3);
    prometheus.setQueryResponse('post', 0.6);

    const result = await evaluateEffectiveness(
      mockCandidate({ metric_direction: 'decrease' }),
      defaultConfig(),
      () => mockDeployment('2026-03-20T00:00:00Z'),
      prometheus,
      new Date('2026-04-08T14:30:00Z')
    );

    expect(result.status).toBe('improved');
    expect(result.detail!.improvement_pct).toBeCloseTo(95.1, 1);
  });

  test('unchanged: error rate barely changed', async () => {
    // pre=5.0%, post=5.1%, direction=decrease, threshold=10%
    const prometheus = new MockPrometheusClient();
    prometheus.setQueryResponse('pre', 5.0);
    prometheus.setQueryResponse('post', 5.1);

    const result = await evaluateEffectiveness(
      mockCandidate({ metric_direction: 'decrease' }),
      defaultConfig(),
      () => mockDeployment('2026-03-20T00:00:00Z'),
      prometheus,
      new Date('2026-04-08T14:30:00Z')
    );

    expect(result.status).toBe('unchanged');
    expect(result.detail!.improvement_pct).toBeCloseTo(-2.0, 1);
  });

  test('degraded: error rate increased after fix', async () => {
    // pre=0.5%, post=3.0%, direction=decrease, threshold=10%
    const prometheus = new MockPrometheusClient();
    prometheus.setQueryResponse('pre', 0.5);
    prometheus.setQueryResponse('post', 3.0);

    const result = await evaluateEffectiveness(
      mockCandidate({ metric_direction: 'decrease' }),
      defaultConfig(),
      () => mockDeployment('2026-03-20T00:00:00Z'),
      prometheus,
      new Date('2026-04-08T14:30:00Z')
    );

    expect(result.status).toBe('degraded');
    expect(result.detail!.improvement_pct).toBeCloseTo(-500.0, 0);
  });

  test('pending: post-fix window not yet elapsed', async () => {
    // Deploy 5 days ago, cooldown=7, comparison=7
    // Post window ends at day 14. Now is day 5.
    const result = await evaluateEffectiveness(
      mockCandidate(),
      defaultConfig(),
      () => mockDeployment('2026-04-03T00:00:00Z'),
      new MockPrometheusClient(),
      new Date('2026-04-08T14:30:00Z')
    );

    expect(result.status).toBe('pending');
    expect(result.reason).toContain('not yet elapsed');
  });

  test('pending: no linked deployment', async () => {
    const result = await evaluateEffectiveness(
      mockCandidate({ linked_deployment: null }),
      defaultConfig(),
      () => null,
      new MockPrometheusClient()
    );

    expect(result.status).toBe('pending');
    expect(result.reason).toContain('No linked deployment');
  });

  test('at-threshold: improvement == threshold returns improved', async () => {
    // improvement_pct = 10.0, threshold = 10
    const prometheus = new MockPrometheusClient();
    prometheus.setQueryResponse('pre', 10.0);
    prometheus.setQueryResponse('post', 9.0); // 10% decrease

    const result = await evaluateEffectiveness(
      mockCandidate({ metric_direction: 'decrease' }),
      defaultConfig(),
      () => mockDeployment('2026-03-20T00:00:00Z'),
      prometheus,
      new Date('2026-04-08T14:30:00Z')
    );

    expect(result.status).toBe('improved');
    expect(result.detail!.improvement_pct).toBe(10.0);
  });
});

describe('computeImprovement', () => {
  test('decrease metric: lower is better', () => {
    expect(computeImprovement('decrease', 12.3, 0.6)).toBeCloseTo(95.1, 1);
  });

  test('increase metric: higher is better', () => {
    expect(computeImprovement('increase', 500, 650)).toBeCloseTo(30.0, 1);
  });

  test('zero pre-avg, zero post', () => {
    expect(computeImprovement('decrease', 0, 0)).toBe(0);
  });

  test('zero pre-avg, nonzero post, decrease', () => {
    expect(computeImprovement('decrease', 0, 5.0)).toBe(-100);
  });

  test('zero pre-avg, nonzero post, increase', () => {
    expect(computeImprovement('increase', 0, 5.0)).toBe(100);
  });
});
```

#### Auto-Promote Tests (`tests/governance/auto-promote.test.ts`)

```typescript
describe('evaluateAutoPromote', () => {
  const baseCandidate: AutoPromoteCandidate = {
    id: 'OBS-20260408-143022-a7f3',
    service: 'api-gateway',
    error_class: 'ConnectionPoolExhausted',
    severity: 'P0',
    confidence: 0.95,
    cooldown_active: false,
    file_path: '/mock/path.md',
  };

  test('all safeguards pass -> promoted', async () => {
    const result = await evaluateAutoPromote(
      baseCandidate,
      { enabled: true, override_hours: 2 },
      defaultGovernanceConfig(),
      mockNotificationConfig(),
      () => [], // no oscillation
      mockLogger()
    );
    expect(result.promoted).toBe(true);
    expect(result.reason).toBe('All safeguards passed');
  });

  test('safeguard 1: disabled', async () => {
    const result = await evaluateAutoPromote(
      baseCandidate,
      { enabled: false, override_hours: 2 },
      defaultGovernanceConfig(), mockNotificationConfig(), () => [], mockLogger()
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('enabled');
  });

  test('safeguard 2: severity P2', async () => {
    const result = await evaluateAutoPromote(
      { ...baseCandidate, severity: 'P2' },
      { enabled: true, override_hours: 2 },
      defaultGovernanceConfig(), mockNotificationConfig(), () => [], mockLogger()
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('severity');
  });

  test('safeguard 3: confidence too low', async () => {
    const result = await evaluateAutoPromote(
      { ...baseCandidate, confidence: 0.85 },
      { enabled: true, override_hours: 2 },
      defaultGovernanceConfig(), mockNotificationConfig(), () => [], mockLogger()
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('confidence');
  });

  test('safeguard 4: cooldown active', async () => {
    const result = await evaluateAutoPromote(
      { ...baseCandidate, cooldown_active: true },
      { enabled: true, override_hours: 2 },
      defaultGovernanceConfig(), mockNotificationConfig(), () => [], mockLogger()
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('cooldown');
  });

  test('safeguard 5: oscillation detected', async () => {
    const result = await evaluateAutoPromote(
      baseCandidate,
      { enabled: true, override_hours: 2 },
      defaultGovernanceConfig(), mockNotificationConfig(),
      () => createMockSummaries(3), // triggers oscillation
      mockLogger()
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('oscillation');
  });

  test('safeguard 6: notification channel unreachable', async () => {
    const result = await evaluateAutoPromote(
      baseCandidate,
      { enabled: true, override_hours: 2 },
      defaultGovernanceConfig(),
      { ...mockNotificationConfig(), webhook_url: 'http://unreachable' },
      () => [], mockLogger()
    );
    expect(result.promoted).toBe(false);
    expect(result.safeguard_failed).toBe('notification_channel');
  });

  test('confidence exactly 0.9 -> promoted', async () => {
    const result = await evaluateAutoPromote(
      { ...baseCandidate, confidence: 0.9 },
      { enabled: true, override_hours: 2 },
      defaultGovernanceConfig(), mockNotificationConfig(), () => [], mockLogger()
    );
    expect(result.promoted).toBe(true);
  });
});
```

#### Override Tests (`tests/governance/override-scheduler.test.ts`)

```typescript
describe('processPendingOverrides', () => {
  test('override within window cancels PRD', async () => {
    // Setup: auto-promoted observation, PM Lead changed triage within 2h
    const rootDir = await setupTestDir();
    const obs = await createMockObservation(rootDir, {
      triage_decision: 'dismiss',    // PM overrode
      triage_by: 'pm-lead',
    });
    await scheduleMockOverride(rootDir, obs.id, 'PRD-OBS-001',
      new Date('2026-04-08T14:30:00Z') // deadline already passed
    );

    const result = await processPendingOverrides(rootDir, mockLogger());

    expect(result.overridden).toBe(1);
    // PRD should be in cancelled/ directory
    expect(await fileExists(`${rootDir}/.autonomous-dev/prd/cancelled/PRD-OBS-001.md`)).toBe(true);
    expect(await fileExists(`${rootDir}/.autonomous-dev/prd/PRD-OBS-001.md`)).toBe(false);
  });

  test('no override within window confirms PRD', async () => {
    // Setup: auto-promoted observation, nobody changed triage
    const rootDir = await setupTestDir();
    const obs = await createMockObservation(rootDir, {
      triage_decision: 'promote',
      triage_by: 'auto-promote-engine',
    });
    await scheduleMockOverride(rootDir, obs.id, 'PRD-OBS-002',
      new Date('2026-04-08T14:30:00Z')
    );

    const result = await processPendingOverrides(rootDir, mockLogger());

    expect(result.confirmed).toBe(1);
    // PRD should still be in place
    expect(await fileExists(`${rootDir}/.autonomous-dev/prd/PRD-OBS-002.md`)).toBe(true);
  });

  test('override check still pending if deadline not reached', async () => {
    const rootDir = await setupTestDir();
    await scheduleMockOverride(rootDir, 'OBS-test', 'PRD-OBS-003',
      new Date('2026-04-09T14:30:00Z') // future deadline
    );

    const result = await processPendingOverrides(rootDir, mockLogger());

    expect(result.still_pending).toBe(1);
  });
});
```

### Integration Tests

#### Governance Lifecycle Integration (`tests/integration/governance-lifecycle.test.ts`)

```typescript
describe('governance in runner lifecycle', () => {
  test('cooldown flags observation correctly in runner pipeline', async () => {
    const rootDir = await setupTestDir();
    // Create a promoted observation with a linked deployment from 3 days ago
    await createMockObservation(rootDir, {
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      triage_decision: 'promote',
      linked_deployment: 'DEPLOY-001',
    });
    await createMockDeployment(rootDir, 'DEPLOY-001', '2026-04-05T10:00:00Z');

    // Run governance checks for a new candidate with same service+error
    const flags = await applyGovernanceChecks(
      'api-gateway', 'ConnectionPoolExhausted',
      defaultGovernanceConfig(), rootDir,
      (id) => readMockDeployment(rootDir, id),
      mockLogger()
    );

    expect(flags.cooldown_active).toBe(true);
  });

  test('effectiveness evaluation runs at step 2 of runner', async () => {
    const rootDir = await setupTestDir();
    // Create a promoted+deployed observation with elapsed post-fix window
    await createMockObservation(rootDir, {
      triage_decision: 'promote',
      linked_deployment: 'DEPLOY-002',
      effectiveness: null,
      target_metric: 'error_rate',
      metric_direction: 'decrease',
    });
    await createMockDeployment(rootDir, 'DEPLOY-002', '2026-03-20T00:00:00Z');

    // Mock Prometheus to return pre=12.3, post=0.6
    const prometheus = new MockPrometheusClient();
    prometheus.setQueryResponse('pre', 12.3);
    prometheus.setQueryResponse('post', 0.6);

    const summary = await runEffectivenessEvaluations(
      rootDir, defaultGovernanceConfig(),
      (id) => readMockDeployment(rootDir, id),
      prometheus, mockLogger()
    );

    expect(summary.evaluated).toBe(1);
    expect(summary.improved).toBe(1);
    // Verify file was updated
    const fm = await readFrontmatter(rootDir);
    expect(fm.effectiveness).toBe('improved');
  });

  test('oscillation + cooldown can both apply', async () => {
    const rootDir = await setupTestDir();
    // Create 3 prior observations + a deployment
    await createObservationSeries(rootDir, 'api-gateway', 'ConnPool', 3, 25);
    await createMockDeployment(rootDir, 'DEPLOY-003', '2026-04-05T00:00:00Z');
    // Link one observation to the deployment
    await updateMockObservation(rootDir, 0, {
      triage_decision: 'promote',
      linked_deployment: 'DEPLOY-003',
    });

    const flags = await applyGovernanceChecks(
      'api-gateway', 'ConnPool',
      defaultGovernanceConfig(), rootDir,
      (id) => readMockDeployment(rootDir, id),
      mockLogger()
    );

    expect(flags.cooldown_active).toBe(true);
    expect(flags.oscillation_warning).toBe(true);
  });
});
```

#### Digest Integration (`tests/integration/digest-generation.test.ts`)

```typescript
describe('weekly digest generation', () => {
  test('generates digest with correct aggregation from mock data', async () => {
    const rootDir = await setupTestDir();

    // Create 14 observations matching TDD Appendix A scenario
    // P0:1, P1:3, P2:7, P3:3
    // promote:4, dismiss:5, defer:2, investigate:1, pending:2
    await seedAppendixAData(rootDir);

    const result = await generateWeeklyDigest(rootDir, '2026-W15');

    expect(result.summary.total_observations).toBe(14);
    expect(result.summary.by_severity).toEqual({ P0: 1, P1: 3, P2: 7, P3: 3 });
    expect(result.summary.triage_decisions.promote).toBe(4);
    expect(result.summary.signal_to_noise_ratio).toBeCloseTo(35.7, 1);
    expect(result.summary.signal_to_noise_display).toContain('(4+1) / 14');

    // Verify file exists
    expect(await fileExists(result.filePath)).toBe(true);
    const content = await fs.readFile(result.filePath, 'utf-8');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Observations by Service');
    expect(content).toContain('## Effectiveness Tracking');
    expect(content).toContain('## Recurring Patterns');
    expect(content).toContain('## Recommendations');
  });
});
```

### End-to-End Tests

#### Full Feedback Loop (`tests/e2e/full-feedback-loop.test.ts`)

```typescript
describe('E2E: full feedback loop', () => {
  test('error -> observation -> promote -> PRD -> deploy -> effectiveness verified', async () => {
    const rootDir = await setupTestDir();
    const clock = new TestClock('2026-04-01T10:00:00Z');
    const mockMcp = setupMockMcpServers();

    // Step 1: Inject mock error data into MCP responses
    mockMcp.prometheus.setErrorRate('api-gateway', 12.3);
    mockMcp.opensearch.setErrorLogs('api-gateway', [
      { message: 'ConnectionPoolExhaustedError: pool drained', timestamp: clock.now().toISOString() },
    ]);

    // Step 2: Run observation -- should detect the error
    clock.set('2026-04-01T14:00:00Z');
    await runObservationCycle(rootDir, mockMcp, clock);
    const observations = await listObservations(rootDir);
    expect(observations).toHaveLength(1);
    expect(observations[0].severity).toBe('P1');
    expect(observations[0].triage_status).toBe('pending');

    // Step 3: PM Lead promotes the observation
    await processTriageDecision(observations[0].filePath, {
      decision: 'promote',
      actor: 'pm-lead',
      reason: 'Connection pool issue confirmed',
    });

    // Step 4: Runner generates PRD
    clock.advanceHours(1);
    await runTriageProcessing(rootDir);
    const prd = await findLinkedPrd(rootDir, observations[0].id);
    expect(prd).not.toBeNull();

    // Step 5: Simulate deployment
    clock.advanceDays(2);
    await simulateDeployment(rootDir, observations[0].id, prd.id, clock);

    // Step 6: Fix the error in mock data
    mockMcp.prometheus.setErrorRate('api-gateway', 0.6);

    // Step 7: Advance past cooldown + comparison window
    clock.advanceDays(14);
    // Now: April 17. Deploy: April 3. Cooldown: 7 days (April 10).
    // Post window: April 10-17. Should be evaluable.

    // Step 8: Run effectiveness evaluation
    await runObservationCycle(rootDir, mockMcp, clock);

    // Step 9: Verify effectiveness
    const updatedObs = await readObservation(rootDir, observations[0].id);
    expect(updatedObs.effectiveness).toBe('improved');
    expect(updatedObs.effectiveness_detail.improvement_pct).toBeCloseTo(95.1, 1);
  });
});
```

#### Oscillation Loop (`tests/e2e/oscillation-loop.test.ts`)

```typescript
describe('E2E: oscillation detection over multiple runs', () => {
  test('3 observations trigger oscillation warning', async () => {
    const rootDir = await setupTestDir();
    const clock = new TestClock('2026-03-10T10:00:00Z');
    const mockMcp = setupMockMcpServers();

    // Persistent error that is never fixed
    mockMcp.prometheus.setErrorRate('api-gateway', 8.0);

    // Run 1: first observation
    await runObservationCycle(rootDir, mockMcp, clock);
    let obs = await listObservations(rootDir);
    expect(obs).toHaveLength(1);
    expect(obs[0].oscillation_warning).toBe(false);

    // Advance 10 days, run 2: second observation
    clock.advanceDays(10);
    await runObservationCycle(rootDir, mockMcp, clock);
    obs = await listObservations(rootDir);
    expect(obs).toHaveLength(2);
    expect(obs[1].oscillation_warning).toBe(false);

    // Advance 10 days, run 3: third observation -> oscillation
    clock.advanceDays(10);
    await runObservationCycle(rootDir, mockMcp, clock);
    obs = await listObservations(rootDir);
    expect(obs).toHaveLength(3);
    expect(obs[2].oscillation_warning).toBe(true);

    // Verify the Markdown contains the oscillation warning
    const content = await fs.readFile(obs[2].filePath, 'utf-8');
    expect(content).toContain('## Oscillation Warning');
    expect(content).toContain('3 observations in the last 30 days');
    expect(content).toContain('architectural investigation PRD');
  });
});
```

#### Auto-Promote Override (`tests/e2e/auto-promote-override.test.ts`)

```typescript
describe('E2E: auto-promote with override', () => {
  test('high-confidence P0 auto-promoted, PM overrides, PRD cancelled', async () => {
    const rootDir = await setupTestDir();
    const clock = new TestClock('2026-04-08T10:00:00Z');
    const mockMcp = setupMockMcpServers();
    const mockWebhook = new MockWebhookServer();

    // Setup: high error rate, high confidence scenario
    mockMcp.prometheus.setErrorRate('api-gateway', 25.0);

    // Config: auto-promote enabled
    const config = {
      ...defaultConfig(),
      auto_promote: { enabled: true, override_hours: 2 },
      notifications: { enabled: true, webhook_url: mockWebhook.url, notify_on: ['P0', 'P1'] },
    };

    // Step 1: Run observation -- should auto-promote
    await runObservationCycle(rootDir, mockMcp, clock, config);
    const obs = await listObservations(rootDir);
    expect(obs).toHaveLength(1);
    expect(obs[0].triage_status).toBe('promoted');
    expect(obs[0].triage_by).toBe('auto-promote-engine');

    // Verify PRD was generated
    const prd = await findLinkedPrd(rootDir, obs[0].id);
    expect(prd).not.toBeNull();

    // Verify notification was sent
    expect(mockWebhook.messages).toHaveLength(1);
    expect(mockWebhook.messages[0]).toContain('Auto-Promoted');

    // Verify override check is pending
    const overrides = await listPendingOverrides(rootDir);
    expect(overrides).toHaveLength(1);

    // Step 2: PM Lead overrides within the window
    clock.advanceHours(1);
    await processTriageDecision(obs[0].filePath, {
      decision: 'dismiss',
      actor: 'pm-lead',
      reason: 'False positive, metric spike was a deploy artifact',
    });

    // Step 3: Process pending overrides (simulates next runner start)
    clock.advanceHours(2); // Past the 2h window
    await processPendingOverrides(rootDir, mockLogger());

    // Step 4: Verify PRD was cancelled
    expect(await fileExists(`${rootDir}/.autonomous-dev/prd/${prd.id}.md`)).toBe(false);
    expect(await fileExists(`${rootDir}/.autonomous-dev/prd/cancelled/${prd.id}.md`)).toBe(true);

    // Verify observation status
    const updatedObs = await readObservation(rootDir, obs[0].id);
    expect(updatedObs.triage_decision).toBe('dismiss');
    expect(updatedObs.triage_by).toBe('pm-lead');
  });

  test('auto-promote confirmed when no override within window', async () => {
    const rootDir = await setupTestDir();
    const clock = new TestClock('2026-04-08T10:00:00Z');
    const mockMcp = setupMockMcpServers();
    const mockWebhook = new MockWebhookServer();

    mockMcp.prometheus.setErrorRate('api-gateway', 25.0);
    const config = {
      ...defaultConfig(),
      auto_promote: { enabled: true, override_hours: 2 },
      notifications: { enabled: true, webhook_url: mockWebhook.url, notify_on: ['P0', 'P1'] },
    };

    await runObservationCycle(rootDir, mockMcp, clock, config);
    const obs = await listObservations(rootDir);

    // Advance past override window without any human action
    clock.advanceHours(3);
    const result = await processPendingOverrides(rootDir, mockLogger());
    expect(result.confirmed).toBe(1);

    // PRD should still exist
    const prd = await findLinkedPrd(rootDir, obs[0].id);
    expect(await fileExists(`${rootDir}/.autonomous-dev/prd/${prd.id}.md`)).toBe(true);
  });
});
```

## Acceptance Criteria

1. [ ] All cooldown unit tests pass: active within window, expired, exact boundary, no deployment, multiple deployments.
2. [ ] All oscillation unit tests pass: at threshold, below threshold, outside window, Markdown format.
3. [ ] All effectiveness unit tests pass: improved, unchanged, degraded, pending (4 reasons), zero pre-average, at-threshold.
4. [ ] All auto-promote unit tests pass: each of the 6 safeguards tested individually, confidence boundary at exactly 0.9.
5. [ ] Override tests pass: override within window cancels PRD, no override confirms PRD, pending override before deadline.
6. [ ] Notification tests pass: Slack/Discord formatting, health check behavior, retry logic, rate limiting.
7. [ ] Sentry adapter tests pass: mock responses, budget enforcement, PII scrubbing.
8. [ ] Weekly digest tests pass: aggregation math matches TDD Appendix A scenario exactly.
9. [ ] Governance lifecycle integration test: cooldown and oscillation flags propagate through the runner pipeline.
10. [ ] Digest integration test: digest generated with correct structure from a week of mock data.
11. [ ] E2E full loop: error injection -> observation -> promote -> PRD -> deploy -> effectiveness = improved.
12. [ ] E2E oscillation loop: recurring error -> 3 observations -> oscillation warning on third.
13. [ ] E2E auto-promote override: high-confidence P0 -> auto-promoted -> PM override within window -> PRD cancelled.
14. [ ] E2E auto-promote confirmed: no override -> PRD stands after window closes.
15. [ ] All tests use the controllable `TestClock` for deterministic time-window behavior (no flaky tests from wall-clock timing).
16. [ ] Test helpers (mock observations, deployments, MCP servers) are shared and reusable.

## Test Cases

| ID | Test | Type | Input | Expected |
|----|------|------|-------|----------|
| TC-5-6-01 | Cooldown active | Unit | Deploy 3d ago, cooldown=7d | active=true |
| TC-5-6-02 | Cooldown expired | Unit | Deploy 8d ago, cooldown=7d | active=false |
| TC-5-6-03 | Cooldown exact boundary | Unit | Deploy exactly 7d ago | active=false |
| TC-5-6-04 | Oscillation triggered | Unit | 3 observations, threshold=3 | oscillating=true |
| TC-5-6-05 | Oscillation below threshold | Unit | 2 observations, threshold=3 | oscillating=false |
| TC-5-6-06 | Effectiveness improved | Unit | pre=12.3%, post=0.6% | improved, 95.1% |
| TC-5-6-07 | Effectiveness unchanged | Unit | pre=5%, post=5.1% | unchanged |
| TC-5-6-08 | Effectiveness degraded | Unit | pre=0.5%, post=3% | degraded |
| TC-5-6-09 | Auto-promote all pass | Unit | P0, 0.95 confidence, all clear | promoted=true |
| TC-5-6-10 | Auto-promote: confidence < 0.9 | Unit | P0, confidence=0.85 | promoted=false, safeguard=confidence |
| TC-5-6-11 | Auto-promote: severity P2 | Unit | P2, confidence=0.95 | promoted=false, safeguard=severity |
| TC-5-6-12 | Auto-promote: cooldown active | Unit | P0, cooldown=true | promoted=false, safeguard=cooldown |
| TC-5-6-13 | Override within window | Unit | PM changes triage, deadline passed | PRD cancelled |
| TC-5-6-14 | Override after window | Unit | PRD already confirmed | No effect |
| TC-5-6-15 | Digest signal-to-noise | Integration | 14 obs, 4 promoted, 1 investigating | 35.7% |
| TC-5-6-16 | Digest small sample | Integration | 3 obs total | SNR = "N/A" |
| TC-5-6-17 | Full feedback loop E2E | E2E | Error -> fix -> effectiveness | effectiveness=improved |
| TC-5-6-18 | Oscillation loop E2E | E2E | 3 recurring errors in 30d | Warning on third |
| TC-5-6-19 | Auto-promote override E2E | E2E | P0 auto-promoted, PM overrides | PRD cancelled |
| TC-5-6-20 | Auto-promote confirmed E2E | E2E | P0 auto-promoted, no override | PRD confirmed |
| TC-5-6-21 | Sentry budget enforcement | Unit | 11 queries with budget=10 | 11th returns null |
| TC-5-6-22 | Sentry PII scrubbing | Unit | Event with email in exception | Email redacted |
| TC-5-6-23 | Notification rate limit | Unit | 429 response with retry-after | Waits and retries |
| TC-5-6-24 | Notification fallback | Unit | Channel unreachable | File-only triage, warning logged |
