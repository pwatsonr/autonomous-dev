import { checkCooldown } from '../../src/governance/cooldown';
import { GovernanceConfig, FixDeployment } from '../../src/governance/types';

/**
 * Unit tests for checkCooldown (SPEC-007-5-1, Task 1).
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

function makeDeployment(daysAgo: number, now: Date, overrides?: Partial<FixDeployment>): FixDeployment {
  const deployDate = new Date(now);
  deployDate.setDate(deployDate.getDate() - daysAgo);
  return {
    id: 'deploy-001',
    deployed_at: deployDate.toISOString(),
    observation_id: 'obs-001',
    service: 'api-gateway',
    error_class: 'timeout',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TC-5-1-01: Cooldown active within window
// ---------------------------------------------------------------------------
function test_cooldown_active_within_window(): void {
  const now = new Date('2026-04-08T12:00:00Z');
  const deployment = makeDeployment(3, now);
  const finder = () => deployment;

  const result = checkCooldown('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.active === true, `expected active=true, got ${result.active}`);
  assert(result.reason !== undefined, 'expected reason to be set');
  assert(result.reason!.includes('Fix deployed on'), `reason should mention deployment: ${result.reason}`);
  assert(result.reason!.includes('cooldown until'), `reason should mention cooldown end: ${result.reason}`);
  assert(result.linked_deployment === 'deploy-001', `expected deploy-001, got ${result.linked_deployment}`);
  assert(result.cooldown_end !== undefined, 'expected cooldown_end to be set');
  assert(result.deploy_date !== undefined, 'expected deploy_date to be set');
  console.log('PASS: TC-5-1-01 cooldown active within window');
}

// ---------------------------------------------------------------------------
// TC-5-1-02: Cooldown expired
// ---------------------------------------------------------------------------
function test_cooldown_expired(): void {
  const now = new Date('2026-04-08T12:00:00Z');
  const deployment = makeDeployment(8, now);
  const finder = () => deployment;

  const result = checkCooldown('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.active === false, `expected active=false, got ${result.active}`);
  assert(result.reason === undefined, 'expected no reason when inactive');
  assert(result.linked_deployment === undefined, 'expected no linked_deployment when inactive');
  console.log('PASS: TC-5-1-02 cooldown expired');
}

// ---------------------------------------------------------------------------
// TC-5-1-03: Cooldown exact boundary (day 7)
// Deploy exactly 7 days ago at midnight, cooldown_days=7
// cooldown_end = deploy + 7d = now, strict < means NOT active
// ---------------------------------------------------------------------------
function test_cooldown_exact_boundary(): void {
  const now = new Date('2026-04-08T00:00:00Z');
  // Deploy exactly 7 days before now at midnight
  const deployDate = new Date('2026-04-01T00:00:00Z');
  const deployment: FixDeployment = {
    id: 'deploy-boundary',
    deployed_at: deployDate.toISOString(),
    observation_id: 'obs-boundary',
    service: 'api-gateway',
    error_class: 'timeout',
  };
  const finder = () => deployment;

  const result = checkCooldown('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.active === false, `exact boundary: expected active=false, got ${result.active}`);
  console.log('PASS: TC-5-1-03 cooldown exact boundary (day 7, strict < comparison)');
}

// ---------------------------------------------------------------------------
// TC-5-1-04: No deployment found
// ---------------------------------------------------------------------------
function test_no_deployment_found(): void {
  const now = new Date('2026-04-08T12:00:00Z');
  const finder = () => null;

  const result = checkCooldown('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.active === false, `expected active=false, got ${result.active}`);
  console.log('PASS: TC-5-1-04 no deployment found');
}

// ---------------------------------------------------------------------------
// TC-5-1-05: Multiple deployments — finder returns most recent (day -3)
// ---------------------------------------------------------------------------
function test_multiple_deployments_uses_most_recent(): void {
  const now = new Date('2026-04-08T12:00:00Z');
  // The finder dependency is responsible for returning the most recent deployment.
  // We simulate that by returning the day-3 deployment.
  const recentDeployment = makeDeployment(3, now, { id: 'deploy-recent' });
  const finder = () => recentDeployment;

  const result = checkCooldown('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.active === true, `expected active=true for most recent deploy, got ${result.active}`);
  assert(result.linked_deployment === 'deploy-recent', `expected deploy-recent, got ${result.linked_deployment}`);
  console.log('PASS: TC-5-1-05 multiple deployments uses most recent');
}

// ---------------------------------------------------------------------------
// TC-5-1-06: Deployment metadata unreadable
// When the finder cannot read deployment metadata, it returns null.
// ---------------------------------------------------------------------------
function test_deployment_metadata_unreadable(): void {
  const now = new Date('2026-04-08T12:00:00Z');
  const finder = () => null; // metadata unreadable -> null

  const result = checkCooldown('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.active === false, `expected active=false when metadata unreadable, got ${result.active}`);
  console.log('PASS: TC-5-1-06 deployment metadata unreadable returns active=false');
}

// ---------------------------------------------------------------------------
// Edge: cooldown_days = 0 means cooldown is never active
// ---------------------------------------------------------------------------
function test_cooldown_days_zero(): void {
  const now = new Date('2026-04-08T12:00:00Z');
  // Deploy just now — but with cooldown_days=0 the end is deploy time itself
  const deployment: FixDeployment = {
    id: 'deploy-zero',
    deployed_at: now.toISOString(),
    observation_id: 'obs-zero',
    service: 'api-gateway',
    error_class: 'timeout',
  };
  const finder = () => deployment;

  const result = checkCooldown('api-gateway', 'timeout', defaultConfig({ cooldown_days: 0 }), finder, now);

  assert(result.active === false, `cooldown_days=0: expected active=false, got ${result.active}`);
  console.log('PASS: cooldown_days=0 is never active');
}

// ---------------------------------------------------------------------------
// Edge: cooldown active 1 ms before expiry
// ---------------------------------------------------------------------------
function test_cooldown_active_just_before_expiry(): void {
  const deployDate = new Date('2026-04-01T00:00:00Z');
  // cooldown_end = 2026-04-08T00:00:00Z, check at 1ms before
  const now = new Date('2026-04-07T23:59:59.999Z');
  const deployment: FixDeployment = {
    id: 'deploy-edge',
    deployed_at: deployDate.toISOString(),
    observation_id: 'obs-edge',
    service: 'api-gateway',
    error_class: 'timeout',
  };
  const finder = () => deployment;

  const result = checkCooldown('api-gateway', 'timeout', defaultConfig(), finder, now);

  assert(result.active === true, `1ms before expiry: expected active=true, got ${result.active}`);
  console.log('PASS: cooldown active 1ms before expiry');
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
  test_cooldown_active_within_window,
  test_cooldown_expired,
  test_cooldown_exact_boundary,
  test_no_deployment_found,
  test_multiple_deployments_uses_most_recent,
  test_deployment_metadata_unreadable,
  test_cooldown_days_zero,
  test_cooldown_active_just_before_expiry,
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
