/**
 * Unit tests for modification rate limiter (SPEC-005-3-4, Task 10).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ModificationRateLimiter,
  getWeekStartUTC,
  getWeekEndUTC,
  getNextMondayUTC,
} from '../../../src/agent-factory/improvement/rate-limiter';
import { AgentFactoryConfig } from '../../../src/agent-factory/config';
import { AuditLogger } from '../../../src/agent-factory/audit';
import { RateLimitState } from '../../../src/agent-factory/improvement/types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function defaultConfig(overrides?: Partial<AgentFactoryConfig['rateLimits']>): AgentFactoryConfig {
  return {
    registry: { agentsDir: 'agents/', maxAgents: 50 },
    observation: { defaultThreshold: 10, perAgentOverrides: {} },
    domainMatching: { similarityThreshold: 0.6, maxResults: 5 },
    rateLimits: {
      modificationsPerAgentPerWeek: 1,
      agentCreationsPerWeek: 1,
      ...overrides,
    },
    anomalyThresholds: {
      approvalRateDrop: 0.70,
      qualityDeclinePoints: 0.5,
      qualityDeclineWindow: 10,
      escalationRate: 0.30,
      tokenBudgetMultiplier: 2.0,
    },
    modelRegistry: ['claude-sonnet-4-20250514'],
    paths: {},
  };
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rate-limiter-test-'));
}

function createTestSetup(
  configOverrides?: Partial<AgentFactoryConfig['rateLimits']>,
  preloadState?: RateLimitState,
): {
  config: AgentFactoryConfig;
  auditLogger: AuditLogger;
  auditLogPath: string;
  rateLimitsPath: string;
  tmpDir: string;
  limiter: ModificationRateLimiter;
} {
  const tmpDir = createTempDir();
  const auditLogPath = path.join(tmpDir, 'data', 'agent-audit.log');
  const rateLimitsPath = path.join(tmpDir, 'data', 'rate-limits.json');

  const config = defaultConfig(configOverrides);
  const auditLogger = new AuditLogger(auditLogPath);

  // Optionally preload state
  if (preloadState) {
    const dataDir = path.dirname(rateLimitsPath);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(rateLimitsPath, JSON.stringify(preloadState, null, 2), 'utf-8');
  }

  const limiter = new ModificationRateLimiter(config, auditLogger, {
    rateLimitsPath,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  return { config, auditLogger, auditLogPath, rateLimitsPath, tmpDir, limiter };
}

function cleanupTmpDir(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function readAuditLog(auditLogPath: string): string {
  if (fs.existsSync(auditLogPath)) {
    return fs.readFileSync(auditLogPath, 'utf-8');
  }
  return '';
}

/**
 * Get a timestamp for the current calendar week (this Monday).
 */
function thisWeekTimestamp(): string {
  const now = new Date();
  const weekStart = getWeekStartUTC(now);
  // Set to Tuesday at noon to be safely within the week
  const ts = new Date(weekStart);
  ts.setUTCDate(ts.getUTCDate() + 1);
  ts.setUTCHours(12, 0, 0, 0);
  return ts.toISOString();
}

/**
 * Get a timestamp for last Monday (previous week).
 */
function lastWeekTimestamp(): string {
  const now = new Date();
  const weekStart = getWeekStartUTC(now);
  const lastMonday = new Date(weekStart);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  lastMonday.setUTCHours(12, 0, 0, 0);
  return lastMonday.toISOString();
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
// Rate Limiter Tests
// ---------------------------------------------------------------------------

function test_first_modification_allowed(): void {
  const { limiter, auditLogger, tmpDir } = createTestSetup();

  const result = limiter.checkLimit('code-executor');

  assert(result.allowed === true, `expected allowed=true, got ${result.allowed}`);
  assert(result.currentCount === 0, `expected currentCount=0, got ${result.currentCount}`);
  assert(result.maxPerWeek === 1, `expected maxPerWeek=1, got ${result.maxPerWeek}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_first_modification_allowed');
}

function test_second_modification_blocked(): void {
  const state: RateLimitState = {
    modifications: {
      'code-executor': [
        { timestamp: thisWeekTimestamp(), proposal_id: 'prop-001' },
      ],
    },
  };
  const { limiter, auditLogger, tmpDir } = createTestSetup(undefined, state);

  const result = limiter.checkLimit('code-executor');

  assert(result.allowed === false, `expected allowed=false, got ${result.allowed}`);
  assert(result.currentCount === 1, `expected currentCount=1, got ${result.currentCount}`);
  assert(result.nextAllowedAt !== undefined, 'nextAllowedAt should be set');
  // Next allowed should be a Monday
  const nextDate = new Date(result.nextAllowedAt!);
  assert(nextDate.getUTCDay() === 1, `nextAllowedAt should be Monday, got day ${nextDate.getUTCDay()}`);
  assert(nextDate.getUTCHours() === 0, `nextAllowedAt should be 00:00, got hour ${nextDate.getUTCHours()}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_second_modification_blocked');
}

function test_modification_allowed_next_week(): void {
  const state: RateLimitState = {
    modifications: {
      'code-executor': [
        { timestamp: lastWeekTimestamp(), proposal_id: 'prop-old' },
      ],
    },
  };
  const { limiter, auditLogger, tmpDir } = createTestSetup(undefined, state);

  const result = limiter.checkLimit('code-executor');

  assert(result.allowed === true, `expected allowed=true, got ${result.allowed}`);
  assert(result.currentCount === 0, `expected currentCount=0 (old record not counted), got ${result.currentCount}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_modification_allowed_next_week');
}

function test_calendar_week_boundary_monday(): void {
  // Simulate: modification on Sunday 23:59, check on Monday 00:01
  // The Sunday record should be in the previous week and not counted
  const now = new Date();
  const thisMonday = getWeekStartUTC(now);

  // Last Sunday at 23:59 UTC (end of previous week)
  const lastSunday = new Date(thisMonday);
  lastSunday.setUTCDate(lastSunday.getUTCDate() - 1);
  lastSunday.setUTCHours(23, 59, 0, 0);

  const state: RateLimitState = {
    modifications: {
      'code-executor': [
        { timestamp: lastSunday.toISOString(), proposal_id: 'prop-sunday' },
      ],
    },
  };
  const { limiter, auditLogger, tmpDir } = createTestSetup(undefined, state);

  const result = limiter.checkLimit('code-executor');

  assert(result.allowed === true, `expected allowed=true (new week), got ${result.allowed}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_calendar_week_boundary_monday');
}

function test_configurable_limit(): void {
  const state: RateLimitState = {
    modifications: {
      'code-executor': [
        { timestamp: thisWeekTimestamp(), proposal_id: 'prop-001' },
        { timestamp: thisWeekTimestamp(), proposal_id: 'prop-002' },
      ],
    },
  };
  const { limiter, auditLogger, tmpDir } = createTestSetup(
    { modificationsPerAgentPerWeek: 3 },
    state,
  );

  const result = limiter.checkLimit('code-executor');

  assert(result.allowed === true, `expected allowed=true (2 < 3), got ${result.allowed}`);
  assert(result.currentCount === 2, `expected currentCount=2, got ${result.currentCount}`);
  assert(result.maxPerWeek === 3, `expected maxPerWeek=3, got ${result.maxPerWeek}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_configurable_limit');
}

function test_rate_limit_logged(): void {
  const state: RateLimitState = {
    modifications: {
      'code-executor': [
        { timestamp: thisWeekTimestamp(), proposal_id: 'prop-001' },
      ],
    },
  };
  const { limiter, auditLogger, auditLogPath, tmpDir } = createTestSetup(undefined, state);

  limiter.checkLimit('code-executor');
  auditLogger.close();

  const logContent = readAuditLog(auditLogPath);
  assert(logContent.includes('modification_rate_limited'), 'audit log should contain modification_rate_limited');

  cleanupTmpDir(tmpDir);
  console.log('PASS: test_rate_limit_logged');
}

function test_deferred_not_rejected(): void {
  const state: RateLimitState = {
    modifications: {
      'code-executor': [
        { timestamp: thisWeekTimestamp(), proposal_id: 'prop-001' },
      ],
    },
  };
  const { limiter, auditLogger, tmpDir } = createTestSetup(undefined, state);

  const result = limiter.checkLimit('code-executor');

  // Rate limit should return allowed=false but NOT change proposal status
  // (the result is a check, not an action on the proposal)
  assert(result.allowed === false, 'expected rate limited');
  assert(result.reason !== undefined, 'reason should be set');
  assert(result.reason!.includes('Rate limit exceeded'), `reason should mention rate limit: ${result.reason}`);
  // The result does not have a "rejected" status -- it's "deferred"

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_deferred_not_rejected');
}

function test_rate_limit_per_agent(): void {
  const state: RateLimitState = {
    modifications: {
      'code-executor': [
        { timestamp: thisWeekTimestamp(), proposal_id: 'prop-001' },
      ],
    },
  };
  const { limiter, auditLogger, tmpDir } = createTestSetup(undefined, state);

  // Check a different agent
  const result = limiter.checkLimit('prd-author');

  assert(result.allowed === true, `expected allowed=true for different agent, got ${result.allowed}`);
  assert(result.currentCount === 0, `expected currentCount=0, got ${result.currentCount}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_rate_limit_per_agent');
}

function test_rate_limit_persistence(): void {
  const tmpDir = createTempDir();
  const auditLogPath = path.join(tmpDir, 'data', 'agent-audit.log');
  const rateLimitsPath = path.join(tmpDir, 'data', 'rate-limits.json');
  const config = defaultConfig();
  const auditLogger = new AuditLogger(auditLogPath);

  // Create first limiter instance and record a modification
  const limiter1 = new ModificationRateLimiter(config, auditLogger, {
    rateLimitsPath,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  limiter1.recordModification('code-executor', 'prop-001');

  // Create a NEW limiter instance (simulating restart)
  const limiter2 = new ModificationRateLimiter(config, auditLogger, {
    rateLimitsPath,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = limiter2.checkLimit('code-executor');

  assert(result.allowed === false, `expected allowed=false (persisted record), got ${result.allowed}`);
  assert(result.currentCount === 1, `expected currentCount=1, got ${result.currentCount}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_rate_limit_persistence');
}

function test_record_modification(): void {
  const { limiter, rateLimitsPath, auditLogger, tmpDir } = createTestSetup();

  limiter.recordModification('code-executor', 'prop-123');

  // Check that the file was written
  assert(fs.existsSync(rateLimitsPath), 'rate-limits.json should exist');
  const content = fs.readFileSync(rateLimitsPath, 'utf-8');
  const state = JSON.parse(content) as RateLimitState;

  assert(state.modifications['code-executor'] !== undefined, 'should have code-executor entry');
  assert(state.modifications['code-executor'].length === 1, 'should have 1 record');
  assert(state.modifications['code-executor'][0].proposal_id === 'prop-123', 'proposal_id should match');

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_record_modification');
}

function test_empty_state_file_handled(): void {
  const tmpDir = createTempDir();
  const dataDir = path.join(tmpDir, 'data');
  const rateLimitsPath = path.join(dataDir, 'rate-limits.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(rateLimitsPath, '', 'utf-8');

  const config = defaultConfig();
  const auditLogger = new AuditLogger(path.join(dataDir, 'agent-audit.log'));
  const limiter = new ModificationRateLimiter(config, auditLogger, {
    rateLimitsPath,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = limiter.checkLimit('code-executor');
  assert(result.allowed === true, 'should allow when state file is empty/corrupt');

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_empty_state_file_handled');
}

// ---------------------------------------------------------------------------
// Calendar week utility tests
// ---------------------------------------------------------------------------

function test_week_start_is_monday(): void {
  // Test various days of the week
  // 2026-04-08 is a Wednesday
  const wed = new Date('2026-04-08T14:30:00Z');
  const start = getWeekStartUTC(wed);
  assert(start.getUTCDay() === 1, `week start should be Monday, got day ${start.getUTCDay()}`);
  assert(start.getUTCDate() === 6, `expected April 6, got ${start.getUTCDate()}`);
  assert(start.getUTCHours() === 0, 'should be 00:00:00');
  assert(start.getUTCMinutes() === 0, 'should be 00:00');
  console.log('PASS: test_week_start_is_monday');
}

function test_week_start_on_monday_itself(): void {
  const mon = new Date('2026-04-06T10:00:00Z');
  const start = getWeekStartUTC(mon);
  assert(start.getUTCDay() === 1, 'should be Monday');
  assert(start.getUTCDate() === 6, `expected April 6, got ${start.getUTCDate()}`);
  console.log('PASS: test_week_start_on_monday_itself');
}

function test_week_start_on_sunday(): void {
  const sun = new Date('2026-04-12T23:59:00Z');
  const start = getWeekStartUTC(sun);
  assert(start.getUTCDay() === 1, 'should be Monday');
  assert(start.getUTCDate() === 6, `expected April 6, got ${start.getUTCDate()}`);
  console.log('PASS: test_week_start_on_sunday');
}

function test_week_end_is_sunday(): void {
  const wed = new Date('2026-04-08T14:30:00Z');
  const end = getWeekEndUTC(wed);
  assert(end.getUTCDay() === 0, `week end should be Sunday, got day ${end.getUTCDay()}`);
  assert(end.getUTCDate() === 12, `expected April 12, got ${end.getUTCDate()}`);
  assert(end.getUTCHours() === 23, 'should be 23:59:59');
  assert(end.getUTCMinutes() === 59, 'should be 23:59');
  assert(end.getUTCSeconds() === 59, 'should be 23:59:59');
  console.log('PASS: test_week_end_is_sunday');
}

function test_next_monday(): void {
  const wed = new Date('2026-04-08T14:30:00Z');
  const next = getNextMondayUTC(wed);
  assert(next.getUTCDay() === 1, `next should be Monday, got day ${next.getUTCDay()}`);
  assert(next.getUTCDate() === 13, `expected April 13, got ${next.getUTCDate()}`);
  assert(next.getUTCHours() === 0, 'should be 00:00:00');
  console.log('PASS: test_next_monday');
}

function test_next_monday_from_sunday(): void {
  const sun = new Date('2026-04-12T23:59:00Z');
  const next = getNextMondayUTC(sun);
  assert(next.getUTCDay() === 1, 'should be Monday');
  assert(next.getUTCDate() === 13, `expected April 13, got ${next.getUTCDate()}`);
  console.log('PASS: test_next_monday_from_sunday');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const syncTests = [
  // Rate limiter
  test_first_modification_allowed,
  test_second_modification_blocked,
  test_modification_allowed_next_week,
  test_calendar_week_boundary_monday,
  test_configurable_limit,
  test_rate_limit_logged,
  test_deferred_not_rejected,
  test_rate_limit_per_agent,
  test_rate_limit_persistence,
  test_record_modification,
  test_empty_state_file_handled,

  // Calendar week utilities
  test_week_start_is_monday,
  test_week_start_on_monday_itself,
  test_week_start_on_sunday,
  test_week_end_is_sunday,
  test_next_monday,
  test_next_monday_from_sunday,
];

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const total = syncTests.length;

  for (const test of syncTests) {
    try {
      test();
      passed++;
    } catch (err) {
      console.log(`FAIL: ${test.name} -- ${err}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
