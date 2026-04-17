/**
 * Unit tests for the false positive filter chain (SPEC-007-3-1, Task 3).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-1-13 through TC-3-1-16.
 */

import {
  isFalsePositive,
  isWithinMaintenanceWindow,
  hasLoadTestMarker,
  filterCandidates,
} from '../../src/engine/false-positive-filter';
import type { CandidateObservation, FalsePositiveFilterConfig } from '../../src/engine/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCandidate(
  overrides: Partial<CandidateObservation> = {},
): CandidateObservation {
  return {
    type: 'error',
    error_type: 'error_rate',
    service: 'api-gateway',
    metric_value: 12.3,
    threshold_value: 5.0,
    sustained_minutes: 15,
    log_samples: [],
    data_sources_used: ['prometheus'],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
    ...overrides,
  };
}

function buildFilterConfig(
  overrides: Partial<FalsePositiveFilterConfig> = {},
): FalsePositiveFilterConfig {
  return {
    maintenance_windows: [],
    excluded_error_patterns: [],
    load_test_markers: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isWithinMaintenanceWindow
// ---------------------------------------------------------------------------

describe('isWithinMaintenanceWindow', () => {
  describe('one-time windows', () => {
    it('returns true when current time is within the window', () => {
      const window = {
        start: '2026-04-10T02:00:00Z',
        end: '2026-04-10T06:00:00Z',
      };
      const currentTime = new Date('2026-04-10T03:30:00Z');
      expect(isWithinMaintenanceWindow(currentTime, window)).toBe(true);
    });

    it('returns false when current time is before the window', () => {
      const window = {
        start: '2026-04-10T02:00:00Z',
        end: '2026-04-10T06:00:00Z',
      };
      const currentTime = new Date('2026-04-10T01:30:00Z');
      expect(isWithinMaintenanceWindow(currentTime, window)).toBe(false);
    });

    it('returns false when current time is after the window', () => {
      const window = {
        start: '2026-04-10T02:00:00Z',
        end: '2026-04-10T06:00:00Z',
      };
      const currentTime = new Date('2026-04-10T06:30:00Z');
      expect(isWithinMaintenanceWindow(currentTime, window)).toBe(false);
    });

    it('returns false at exactly the end time (exclusive end)', () => {
      const window = {
        start: '2026-04-10T02:00:00Z',
        end: '2026-04-10T06:00:00Z',
      };
      const currentTime = new Date('2026-04-10T06:00:00Z');
      expect(isWithinMaintenanceWindow(currentTime, window)).toBe(false);
    });

    it('returns true at exactly the start time (inclusive start)', () => {
      const window = {
        start: '2026-04-10T02:00:00Z',
        end: '2026-04-10T06:00:00Z',
      };
      const currentTime = new Date('2026-04-10T02:00:00Z');
      expect(isWithinMaintenanceWindow(currentTime, window)).toBe(true);
    });
  });

  describe('recurring windows', () => {
    it('returns true when current day and time match', () => {
      const window = {
        start: '02:00',
        end: '06:00',
        days: ['SAT'],
        timezone: 'UTC',
      };
      // 2026-04-11 is a Saturday
      const currentTime = new Date('2026-04-11T03:30:00Z');
      expect(isWithinMaintenanceWindow(currentTime, window)).toBe(true);
    });

    it('returns false when day does not match', () => {
      const window = {
        start: '02:00',
        end: '06:00',
        days: ['SAT'],
        timezone: 'UTC',
      };
      // 2026-04-10 is a Friday
      const currentTime = new Date('2026-04-10T03:30:00Z');
      expect(isWithinMaintenanceWindow(currentTime, window)).toBe(false);
    });

    it('returns false when time is outside window on matching day', () => {
      const window = {
        start: '02:00',
        end: '06:00',
        days: ['SAT'],
        timezone: 'UTC',
      };
      const currentTime = new Date('2026-04-11T08:00:00Z');
      expect(isWithinMaintenanceWindow(currentTime, window)).toBe(false);
    });

    it('supports multiple days', () => {
      const window = {
        start: '00:00',
        end: '06:00',
        days: ['SAT', 'SUN'],
        timezone: 'UTC',
      };
      // 2026-04-12 is a Sunday
      const currentTime = new Date('2026-04-12T03:00:00Z');
      expect(isWithinMaintenanceWindow(currentTime, window)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// hasLoadTestMarker
// ---------------------------------------------------------------------------

describe('hasLoadTestMarker', () => {
  it('detects header-based marker', () => {
    const metadata = { 'X-Load-Test': 'true' };
    const marker = { header: 'X-Load-Test', value: 'true' };
    expect(hasLoadTestMarker(metadata, marker)).toBe(true);
  });

  it('is case-insensitive for header names', () => {
    const metadata = { 'x-load-test': 'true' };
    const marker = { header: 'X-Load-Test', value: 'true' };
    expect(hasLoadTestMarker(metadata, marker)).toBe(true);
  });

  it('returns false when header value does not match', () => {
    const metadata = { 'X-Load-Test': 'false' };
    const marker = { header: 'X-Load-Test', value: 'true' };
    expect(hasLoadTestMarker(metadata, marker)).toBe(false);
  });

  it('detects tag-based marker in tags array', () => {
    const metadata = { tags: ['load-test', 'staging'] };
    const marker = { tag: 'load-test' };
    expect(hasLoadTestMarker(metadata, marker)).toBe(true);
  });

  it('detects tag-based marker as metadata key', () => {
    const metadata = { 'load-test': true };
    const marker = { tag: 'load-test' };
    expect(hasLoadTestMarker(metadata, marker)).toBe(true);
  });

  it('returns false when tag is not present', () => {
    const metadata = { tags: ['staging'] };
    const marker = { tag: 'load-test' };
    expect(hasLoadTestMarker(metadata, marker)).toBe(false);
  });

  it('returns false for empty metadata', () => {
    const metadata = {};
    const marker = { header: 'X-Load-Test', value: 'true' };
    expect(hasLoadTestMarker(metadata, marker)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFalsePositive
// ---------------------------------------------------------------------------

describe('isFalsePositive', () => {
  // TC-3-1-13: Maintenance window
  it('TC-3-1-13: filters candidate during maintenance window', () => {
    const candidate = buildCandidate();
    const config = buildFilterConfig({
      maintenance_windows: [
        {
          start: '2026-04-08T02:00:00Z',
          end: '2026-04-08T06:00:00Z',
        },
      ],
    });
    const currentTime = new Date('2026-04-08T03:30:00Z');

    const result = isFalsePositive(candidate, config, currentTime);
    expect(result.filtered).toBe(true);
    expect(result.reason).toContain('maintenance_window');
  });

  // TC-3-1-14: Excluded pattern
  it('TC-3-1-14: filters candidate matching excluded error pattern', () => {
    const candidate = buildCandidate({
      log_samples: ['HealthCheck endpoint /health timeout after 30s'],
    });
    const config = buildFilterConfig({
      excluded_error_patterns: ['HealthCheck.*timeout'],
    });
    const currentTime = new Date('2026-04-08T12:00:00Z');

    const result = isFalsePositive(candidate, config, currentTime);
    expect(result.filtered).toBe(true);
    expect(result.reason).toBe('excluded_pattern: HealthCheck.*timeout');
  });

  // TC-3-1-15: Load test marker
  it('TC-3-1-15: filters candidate with load test marker', () => {
    const candidate = buildCandidate({
      request_metadata: { 'X-Load-Test': 'true' },
    });
    const config = buildFilterConfig({
      load_test_markers: [{ header: 'X-Load-Test', value: 'true' }],
    });
    const currentTime = new Date('2026-04-08T12:00:00Z');

    const result = isFalsePositive(candidate, config, currentTime);
    expect(result.filtered).toBe(true);
    expect(result.reason).toBe('load_test_traffic');
  });

  // TC-3-1-16: Nothing matches
  it('TC-3-1-16: does not filter candidate when no filters match', () => {
    const candidate = buildCandidate({
      log_samples: ['Real error: database connection failed'],
    });
    const config = buildFilterConfig({
      maintenance_windows: [
        {
          start: '2026-04-08T02:00:00Z',
          end: '2026-04-08T04:00:00Z',
        },
      ],
      excluded_error_patterns: ['HealthCheck.*timeout'],
      load_test_markers: [{ header: 'X-Load-Test', value: 'true' }],
    });
    // Time is outside maintenance window
    const currentTime = new Date('2026-04-08T12:00:00Z');

    const result = isFalsePositive(candidate, config, currentTime);
    expect(result.filtered).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('checks maintenance window before excluded patterns', () => {
    const candidate = buildCandidate({
      log_samples: ['HealthCheck endpoint /health timeout after 30s'],
    });
    const config = buildFilterConfig({
      maintenance_windows: [
        {
          start: '2026-04-08T02:00:00Z',
          end: '2026-04-08T06:00:00Z',
        },
      ],
      excluded_error_patterns: ['HealthCheck.*timeout'],
    });
    const currentTime = new Date('2026-04-08T03:30:00Z');

    const result = isFalsePositive(candidate, config, currentTime);
    expect(result.filtered).toBe(true);
    // Should be maintenance_window, not excluded_pattern (order matters)
    expect(result.reason).toContain('maintenance_window');
  });

  it('does not filter when excluded pattern does not match any log sample', () => {
    const candidate = buildCandidate({
      log_samples: ['DatabaseError: connection refused'],
    });
    const config = buildFilterConfig({
      excluded_error_patterns: ['HealthCheck.*timeout'],
    });
    const currentTime = new Date('2026-04-08T12:00:00Z');

    const result = isFalsePositive(candidate, config, currentTime);
    expect(result.filtered).toBe(false);
  });

  it('does not filter when candidate has no request_metadata and load test markers are configured', () => {
    const candidate = buildCandidate({
      request_metadata: undefined,
    });
    const config = buildFilterConfig({
      load_test_markers: [{ header: 'X-Load-Test', value: 'true' }],
    });
    const currentTime = new Date('2026-04-08T12:00:00Z');

    const result = isFalsePositive(candidate, config, currentTime);
    expect(result.filtered).toBe(false);
  });

  it('handles empty filter config gracefully', () => {
    const candidate = buildCandidate();
    const config = buildFilterConfig();
    const currentTime = new Date('2026-04-08T12:00:00Z');

    const result = isFalsePositive(candidate, config, currentTime);
    expect(result.filtered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterCandidates (batch)
// ---------------------------------------------------------------------------

describe('filterCandidates', () => {
  it('splits candidates into passed and filtered', () => {
    const candidates = [
      buildCandidate({
        service: 'svc-a',
        log_samples: ['HealthCheck endpoint /health timeout'],
      }),
      buildCandidate({
        service: 'svc-b',
        log_samples: ['Real error: connection refused'],
      }),
      buildCandidate({
        service: 'svc-c',
        request_metadata: { 'X-Load-Test': 'true' },
      }),
    ];

    const config = buildFilterConfig({
      excluded_error_patterns: ['HealthCheck.*timeout'],
      load_test_markers: [{ header: 'X-Load-Test', value: 'true' }],
    });

    const result = filterCandidates(
      candidates,
      config,
      new Date('2026-04-08T12:00:00Z'),
    );

    expect(result.passed).toHaveLength(1);
    expect(result.passed[0].service).toBe('svc-b');
    expect(result.filtered).toHaveLength(2);
    expect(result.filtered_count).toBe(2);
  });

  it('returns all candidates as passed when no filters match', () => {
    const candidates = [
      buildCandidate({ service: 'svc-a' }),
      buildCandidate({ service: 'svc-b' }),
    ];

    const config = buildFilterConfig();
    const result = filterCandidates(candidates, config);

    expect(result.passed).toHaveLength(2);
    expect(result.filtered).toHaveLength(0);
    expect(result.filtered_count).toBe(0);
  });

  it('returns empty passed when all candidates are filtered', () => {
    const candidates = [
      buildCandidate({
        service: 'svc-a',
        log_samples: ['HealthCheck timeout'],
      }),
    ];

    const config = buildFilterConfig({
      excluded_error_patterns: ['HealthCheck'],
    });

    const result = filterCandidates(
      candidates,
      config,
      new Date('2026-04-08T12:00:00Z'),
    );

    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0].reason).toContain('excluded_pattern');
  });

  it('handles empty candidates array', () => {
    const config = buildFilterConfig();
    const result = filterCandidates([], config);

    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(0);
    expect(result.filtered_count).toBe(0);
  });

  it('preserves filtered reason detail', () => {
    const candidates = [
      buildCandidate({
        request_metadata: { 'X-Load-Test': 'true' },
      }),
    ];

    const config = buildFilterConfig({
      load_test_markers: [{ header: 'X-Load-Test', value: 'true' }],
    });

    const result = filterCandidates(
      candidates,
      config,
      new Date('2026-04-08T12:00:00Z'),
    );

    expect(result.filtered[0].reason).toBe('load_test_traffic');
  });
});
