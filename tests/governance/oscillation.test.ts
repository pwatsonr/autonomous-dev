import { checkOscillation, buildOscillationWarningMarkdown } from '../../src/governance/oscillation';
import { GovernanceConfig, ObservationSummary, OscillationResult } from '../../src/governance/types';

/**
 * Unit tests for checkOscillation and buildOscillationWarningMarkdown
 * (SPEC-007-5-1, Task 2).
 */

// ---------------------------------------------------------------------------
// Helper: default governance config
// ---------------------------------------------------------------------------
function defaultConfig(overrides?: Partial<GovernanceConfig>): GovernanceConfig {
  return {
    cooldown_days: 7,
    oscillation_window_days: 30,
    oscillation_threshold: 3,
    effectiveness_comparison_days: 7,
    effectiveness_improvement_threshold: 10,
    ...overrides,
  };
}

function makeSummary(id: string, triageStatus: string, effectiveness?: string | null, isCurrent?: boolean): ObservationSummary {
  return {
    id,
    triage_status: triageStatus,
    effectiveness: effectiveness ?? null,
    is_current: isCurrent ?? false,
  };
}

// ---------------------------------------------------------------------------
// TC-5-1-07: Oscillation triggered (3 in 25 days, threshold=3, window=30)
// ---------------------------------------------------------------------------
function test_oscillation_triggered(): void {
  const now = new Date('2026-04-08T12:00:00Z');
  const observations: ObservationSummary[] = [
    makeSummary('obs-001', 'promoted', 'degraded'),
    makeSummary('obs-002', 'promoted', 'unchanged'),
    makeSummary('obs-003', 'pending', null, true),
  ];
  const finder = (_s: string, _e: string, _d: Date) => observations;

  const result = checkOscillation('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.oscillating === true, `expected oscillating=true, got ${result.oscillating}`);
  assert(result.count === 3, `expected count=3, got ${result.count}`);
  assert(result.recommendation === 'systemic_investigation', `expected systemic_investigation, got ${result.recommendation}`);
  assert(result.window_days === 30, `expected window_days=30, got ${result.window_days}`);
  assert(result.observation_ids!.length === 3, `expected 3 IDs, got ${result.observation_ids!.length}`);
  assert(result.observation_summaries!.length === 3, `expected 3 summaries`);
  console.log('PASS: TC-5-1-07 oscillation triggered');
}

// ---------------------------------------------------------------------------
// TC-5-1-08: Oscillation not triggered (2 in 25 days, threshold=3)
// ---------------------------------------------------------------------------
function test_oscillation_not_triggered(): void {
  const now = new Date('2026-04-08T12:00:00Z');
  const observations: ObservationSummary[] = [
    makeSummary('obs-001', 'promoted', 'degraded'),
    makeSummary('obs-002', 'pending', null, true),
  ];
  const finder = (_s: string, _e: string, _d: Date) => observations;

  const result = checkOscillation('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.oscillating === false, `expected oscillating=false, got ${result.oscillating}`);
  assert(result.count === undefined, 'expected no count when not oscillating');
  assert(result.recommendation === undefined, 'expected no recommendation when not oscillating');
  console.log('PASS: TC-5-1-08 oscillation not triggered');
}

// ---------------------------------------------------------------------------
// TC-5-1-09: Oscillation exact threshold (3 observations, threshold=3, >=)
// ---------------------------------------------------------------------------
function test_oscillation_exact_threshold(): void {
  const now = new Date('2026-04-08T12:00:00Z');
  const observations: ObservationSummary[] = [
    makeSummary('obs-001', 'dismissed'),
    makeSummary('obs-002', 'promoted', 'improved'),
    makeSummary('obs-003', 'pending', null, true),
  ];
  const finder = (_s: string, _e: string, _d: Date) => observations;

  const result = checkOscillation('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.oscillating === true, `exact threshold: expected oscillating=true, got ${result.oscillating}`);
  assert(result.count === 3, `expected count=3, got ${result.count}`);
  console.log('PASS: TC-5-1-09 oscillation exact threshold (>= comparison)');
}

// ---------------------------------------------------------------------------
// TC-5-1-10: Observations outside window
// 4 total but only 2 within window_days=30 (finder respects afterDate)
// ---------------------------------------------------------------------------
function test_oscillation_observations_outside_window(): void {
  const now = new Date('2026-04-08T12:00:00Z');
  // The finder dependency is responsible for filtering by afterDate.
  // We simulate 2 observations remaining after the filter.
  const observations: ObservationSummary[] = [
    makeSummary('obs-003', 'promoted', 'degraded'),
    makeSummary('obs-004', 'pending', null, true),
  ];
  const finder = (_s: string, _e: string, afterDate: Date) => {
    // Verify the window start is computed correctly (30 days back)
    const expectedWindowStart = new Date(now);
    expectedWindowStart.setDate(expectedWindowStart.getDate() - 30);
    assert(
      afterDate.getTime() === expectedWindowStart.getTime(),
      `window start mismatch: expected ${expectedWindowStart.toISOString()}, got ${afterDate.toISOString()}`
    );
    return observations;
  };

  const result = checkOscillation('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.oscillating === false, `expected oscillating=false when only 2 in window, got ${result.oscillating}`);
  console.log('PASS: TC-5-1-10 observations outside window not counted');
}

// ---------------------------------------------------------------------------
// TC-5-1-11: Oscillation Markdown format
// ---------------------------------------------------------------------------
function test_oscillation_markdown_format(): void {
  const result: OscillationResult = {
    oscillating: true,
    count: 4,
    window_days: 30,
    observation_ids: ['obs-001', 'obs-002', 'obs-003', 'obs-004'],
    observation_summaries: [
      makeSummary('obs-001', 'promoted', 'degraded'),
      makeSummary('obs-002', 'promoted', 'unchanged'),
      makeSummary('obs-003', 'dismissed'),
      makeSummary('obs-004', 'pending', null, true),
    ],
    recommendation: 'systemic_investigation',
  };

  const md = buildOscillationWarningMarkdown(result);

  assert(md.includes('## Oscillation Warning'), 'should contain heading');
  assert(md.includes('4 observations'), 'should mention count of 4');
  assert(md.includes('last 30 days'), 'should mention window');
  assert(md.includes('systemic issue'), 'should mention systemic issue');
  assert(md.includes('**Previous observations:**'), 'should contain observations heading');
  // 4 bullet points
  const bullets = md.split('\n').filter(line => line.startsWith('- '));
  assert(bullets.length === 4, `expected 4 bullet points, got ${bullets.length}`);
  assert(md.includes('**Recommendation:**'), 'should contain recommendation');
  assert(md.includes('architectural investigation PRD'), 'should recommend architectural investigation');
  console.log('PASS: TC-5-1-11 oscillation Markdown format');
}

// ---------------------------------------------------------------------------
// TC-5-1-12: Observation status rendering — promoted + improved
// ---------------------------------------------------------------------------
function test_observation_status_promoted_improved(): void {
  const result: OscillationResult = {
    oscillating: true,
    count: 3,
    window_days: 30,
    observation_ids: ['obs-001', 'obs-002', 'obs-003'],
    observation_summaries: [
      makeSummary('obs-001', 'promoted', 'improved'),
      makeSummary('obs-002', 'promoted', 'degraded'),
      makeSummary('obs-003', 'pending', null, true),
    ],
    recommendation: 'systemic_investigation',
  };

  const md = buildOscillationWarningMarkdown(result);

  assert(md.includes('obs-001 (promoted, fix deployed, effective)'), `should show "promoted, fix deployed, effective" for improved`);
  assert(md.includes('obs-002 (promoted, fix deployed, not effective)'), `should show "promoted, fix deployed, not effective" for degraded`);
  console.log('PASS: TC-5-1-12 observation status rendering (promoted + improved/degraded)');
}

// ---------------------------------------------------------------------------
// TC-5-1-13: Observation status rendering — current observation
// ---------------------------------------------------------------------------
function test_observation_status_current(): void {
  const result: OscillationResult = {
    oscillating: true,
    count: 3,
    window_days: 30,
    observation_ids: ['obs-001', 'obs-002', 'obs-003'],
    observation_summaries: [
      makeSummary('obs-001', 'promoted', 'unchanged'),
      makeSummary('obs-002', 'dismissed'),
      makeSummary('obs-003', 'pending', null, true),
    ],
    recommendation: 'systemic_investigation',
  };

  const md = buildOscillationWarningMarkdown(result);

  assert(md.includes('obs-003 (this observation)'), `should show "this observation" for current`);
  assert(md.includes('obs-001 (promoted, fix deployed, partially effective)'), `should show partially effective for unchanged`);
  assert(md.includes('obs-002 (dismissed)'), `should show "dismissed" for dismissed`);
  console.log('PASS: TC-5-1-13 observation status rendering (current observation)');
}

// ---------------------------------------------------------------------------
// Edge: promoted with pending effectiveness = "fix in progress"
// ---------------------------------------------------------------------------
function test_observation_status_promoted_pending(): void {
  const result: OscillationResult = {
    oscillating: true,
    count: 3,
    window_days: 30,
    observation_ids: ['obs-001', 'obs-002', 'obs-003'],
    observation_summaries: [
      makeSummary('obs-001', 'promoted', 'pending'),
      makeSummary('obs-002', 'promoted', null),
      makeSummary('obs-003', 'pending', null, true),
    ],
    recommendation: 'systemic_investigation',
  };

  const md = buildOscillationWarningMarkdown(result);

  assert(md.includes('obs-001 (promoted, fix in progress)'), `should show "promoted, fix in progress" for pending effectiveness`);
  assert(md.includes('obs-002 (promoted, fix deployed)'), `should show "promoted, fix deployed" when effectiveness is null`);
  console.log('PASS: observation status rendering (promoted + pending/null effectiveness)');
}

// ---------------------------------------------------------------------------
// Edge: buildOscillationWarningMarkdown returns empty when not oscillating
// ---------------------------------------------------------------------------
function test_markdown_empty_when_not_oscillating(): void {
  const result: OscillationResult = { oscillating: false };

  const md = buildOscillationWarningMarkdown(result);

  assert(md === '', `expected empty string, got "${md}"`);
  console.log('PASS: markdown returns empty when not oscillating');
}

// ---------------------------------------------------------------------------
// Edge: window_days calculation passes correct afterDate to finder
// ---------------------------------------------------------------------------
function test_window_start_calculation(): void {
  const now = new Date('2026-04-08T00:00:00Z');
  let capturedAfterDate: Date | null = null;
  const finder = (_s: string, _e: string, afterDate: Date) => {
    capturedAfterDate = afterDate;
    return [];
  };

  checkOscillation('svc', 'err', defaultConfig({ oscillation_window_days: 30 }), finder, now);

  assert(capturedAfterDate !== null, 'finder should have been called');
  const expected = new Date('2026-03-09T00:00:00Z');
  assert(
    capturedAfterDate!.getTime() === expected.getTime(),
    `window start should be 2026-03-09, got ${capturedAfterDate!.toISOString()}`
  );
  console.log('PASS: window start calculation is correct');
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test_oscillation_triggered,
  test_oscillation_not_triggered,
  test_oscillation_exact_threshold,
  test_oscillation_observations_outside_window,
  test_oscillation_markdown_format,
  test_observation_status_promoted_improved,
  test_observation_status_current,
  test_observation_status_promoted_pending,
  test_markdown_empty_when_not_oscillating,
  test_window_start_calculation,
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    test();
    passed++;
  } catch (err) {
    console.log(`FAIL: ${test.name} -- ${err}`);
    failed++;
  }
}

console.log(`\nResults: ${passed}/${tests.length} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
