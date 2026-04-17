/**
 * Unit tests for connectivity validation (SPEC-007-1-2, Task 4).
 *
 * Test case IDs correspond to the spec's acceptance criteria:
 *   TC-1-2-01 through TC-1-2-07.
 */

import {
  probeSource,
  checkConnectivity,
  getEligibleSources,
  getDegradedSources,
  getUnreachableSources,
} from '../../src/adapters/connectivity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// TC-1-2-01: Probe available source
// ---------------------------------------------------------------------------

describe('probeSource', () => {
  test('TC-1-2-01: classifies a fast response as available', async () => {
    const probeCall = async () => {
      await delay(50);
      return { status: 'success' };
    };

    const result = await probeSource('prometheus', probeCall);

    expect(result.source).toBe('prometheus');
    expect(result.status).toBe('available');
    expect(result.response_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.response_time_ms).toBeLessThan(5000);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // TC-1-2-02: Probe degraded source
  // -------------------------------------------------------------------------

  test('TC-1-2-02: classifies a slow response (>5s) as degraded', async () => {
    // Use a short hard timeout so the test doesn't actually wait 30s.
    const probeCall = async () => {
      await delay(100);
      return { status: 'success' };
    };

    // Override the degraded threshold by supplying a short hard timeout and
    // a probe that takes longer than the degraded threshold.
    // We simulate "elapsed > 5000ms" by mocking Date.now.
    const originalNow = Date.now;
    let callCount = 0;
    Date.now = () => {
      callCount++;
      // First call (start): return 0.
      // Second call (after probe): return 7000 to simulate 7s elapsed.
      return callCount === 1 ? 0 : 7000;
    };

    try {
      const result = await probeSource('grafana', probeCall);

      expect(result.source).toBe('grafana');
      expect(result.status).toBe('degraded');
      expect(result.response_time_ms).toBe(7000);
      expect(result.error).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });

  // -------------------------------------------------------------------------
  // TC-1-2-03: Probe unreachable source (timeout)
  // -------------------------------------------------------------------------

  test('TC-1-2-03: classifies a timed-out probe as unreachable', async () => {
    const probeCall = () => new Promise<void>(() => {
      // Never resolves -- simulates a hanging connection.
    });

    // Use a very short timeout to keep the test fast.
    const result = await probeSource('opensearch', probeCall, 50);

    expect(result.source).toBe('opensearch');
    expect(result.status).toBe('unreachable');
    expect(result.response_time_ms).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error).toContain('timed out');
  });

  // -------------------------------------------------------------------------
  // TC-1-2-04: Probe error response
  // -------------------------------------------------------------------------

  test('TC-1-2-04: classifies an error response as unreachable', async () => {
    const probeCall = async () => {
      throw new Error('HTTP 500 Internal Server Error');
    };

    const result = await probeSource('sentry', probeCall);

    expect(result.source).toBe('sentry');
    expect(result.status).toBe('unreachable');
    expect(result.response_time_ms).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error).toContain('HTTP 500');
  });
});

// ---------------------------------------------------------------------------
// TC-1-2-05: Not configured source
// ---------------------------------------------------------------------------

describe('checkConnectivity', () => {
  test('TC-1-2-05: marks sources not in mcpCalls as not_configured', async () => {
    // Only prometheus is configured; sentry is missing.
    const mcpCalls: Record<string, () => Promise<unknown>> = {
      prometheus: async () => ({ status: 'ok' }),
    };

    const report = await checkConnectivity(mcpCalls, ['prometheus', 'sentry'], 100);

    const sentryResult = report.results.find((r) => r.source === 'sentry')!;
    expect(sentryResult).toBeDefined();
    expect(sentryResult.status).toBe('not_configured');
    expect(sentryResult.response_time_ms).toBeNull();
  });

  // -------------------------------------------------------------------------
  // TC-1-2-06: All unreachable aborts run
  // -------------------------------------------------------------------------

  test('TC-1-2-06: sets all_unreachable when every configured source is unreachable', async () => {
    const mcpCalls: Record<string, () => Promise<unknown>> = {
      prometheus: async () => { throw new Error('connection refused'); },
      grafana: async () => { throw new Error('connection refused'); },
      opensearch: async () => { throw new Error('connection refused'); },
    };

    const report = await checkConnectivity(
      mcpCalls,
      ['prometheus', 'grafana', 'opensearch'],
      100,
    );

    expect(report.all_unreachable).toBe(true);
    expect(report.results).toHaveLength(3);
    for (const r of report.results) {
      expect(r.status).toBe('unreachable');
    }
  });

  test('TC-1-2-06 (variant): all_unreachable is false when no sources are configured', async () => {
    // Edge case: if there are zero configured sources, all_unreachable should
    // still be false because there's nothing to be unreachable.
    const report = await checkConnectivity({}, [], 100);
    expect(report.all_unreachable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-1-2-07: Partial availability
  // -------------------------------------------------------------------------

  test('TC-1-2-07: mixed availability -- run proceeds, Grafana excluded, OpenSearch flagged', async () => {
    // Prometheus: available (fast).
    // Grafana: unreachable (throws).
    // OpenSearch: degraded (slow response simulated via Date.now mock).

    const originalNow = Date.now;
    let promCallCount = 0;
    let osCallCount = 0;

    const mcpCalls: Record<string, () => Promise<unknown>> = {
      prometheus: async () => {
        return { status: 'ok' };
      },
      grafana: async () => {
        throw new Error('connection refused');
      },
      opensearch: async () => {
        return { status: 'ok' };
      },
    };

    // To simulate degraded timing for opensearch we mock Date.now.
    // We track calls per-probe; opensearch should appear degraded.
    let callIdx = 0;
    const timeSequence = [
      // prometheus: start=0, end=100 => 100ms (available)
      0, 100,
      // grafana: start=200 (error path, no second call for elapsed)
      200,
      // opensearch: start=300, end=6300 => 6000ms (degraded)
      300, 6300,
    ];
    Date.now = () => timeSequence[callIdx++] ?? 9999;

    try {
      const report = await checkConnectivity(
        mcpCalls,
        ['prometheus', 'grafana', 'opensearch'],
        60_000, // large timeout so nothing times out
      );

      expect(report.all_unreachable).toBe(false);

      const prom = report.results.find((r) => r.source === 'prometheus')!;
      const graf = report.results.find((r) => r.source === 'grafana')!;
      const os = report.results.find((r) => r.source === 'opensearch')!;

      expect(prom.status).toBe('available');
      expect(graf.status).toBe('unreachable');
      expect(os.status).toBe('degraded');

      // Eligible sources should be prometheus + opensearch.
      const eligible = getEligibleSources(report);
      expect(eligible).toHaveLength(2);
      expect(eligible.map((e) => e.source).sort()).toEqual(['opensearch', 'prometheus']);

      // Degraded list should contain only opensearch.
      const degraded = getDegradedSources(report);
      expect(degraded).toHaveLength(1);
      expect(degraded[0].source).toBe('opensearch');

      // Unreachable list should contain only grafana.
      const unreachable = getUnreachableSources(report);
      expect(unreachable).toHaveLength(1);
      expect(unreachable[0].source).toBe('grafana');
    } finally {
      Date.now = originalNow;
    }
  });

  // -------------------------------------------------------------------------
  // Timestamp verification
  // -------------------------------------------------------------------------

  test('report includes a valid ISO 8601 timestamp', async () => {
    const report = await checkConnectivity({}, ['prometheus'], 100);
    expect(report.timestamp).toBeDefined();
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
  });

  // -------------------------------------------------------------------------
  // not_configured sources do not affect all_unreachable
  // -------------------------------------------------------------------------

  test('not_configured sources are ignored when computing all_unreachable', async () => {
    // One configured source is available; two others are not configured.
    const mcpCalls: Record<string, () => Promise<unknown>> = {
      prometheus: async () => ({ status: 'ok' }),
    };

    const report = await checkConnectivity(
      mcpCalls,
      ['prometheus', 'grafana', 'sentry'],
      100,
    );

    expect(report.all_unreachable).toBe(false);
    const promResult = report.results.find((r) => r.source === 'prometheus')!;
    expect(promResult.status).toBe('available');
  });
});
