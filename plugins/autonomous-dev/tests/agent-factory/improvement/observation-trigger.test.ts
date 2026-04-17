/**
 * Unit tests for Observation Trigger (SPEC-005-3-1, Task 1).
 *
 * Tests cover:
 *   - Trigger fires at threshold
 *   - Trigger does not fire below threshold
 *   - Trigger skips FROZEN agents
 *   - Trigger skips UNDER_REVIEW agents
 *   - Trigger skips VALIDATING agents
 *   - Trigger respects per-agent overrides
 *   - Force trigger bypasses threshold
 *   - Force trigger respects FROZEN guard
 *   - MetricsEngine emits 'analysis_triggered' event
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ObservationTrigger } from '../../../src/agent-factory/improvement/observation-trigger';
import { ObservationTracker } from '../../../src/agent-factory/metrics/observation';
import { AuditLogger } from '../../../src/agent-factory/audit';
import type { AgentFactoryConfig } from '../../../src/agent-factory/config';
import type { IAgentRegistry, AgentState, AgentRecord, RankedAgent, RegistryLoadResult } from '../../../src/agent-factory/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/** Create a minimal config for tests. */
function makeConfig(overrides?: Partial<AgentFactoryConfig>): AgentFactoryConfig {
  return {
    registry: { agentsDir: 'agents/', maxAgents: 50 },
    observation: { defaultThreshold: 10, perAgentOverrides: {} },
    domainMatching: { similarityThreshold: 0.6, maxResults: 5 },
    rateLimits: { modificationsPerAgentPerWeek: 1, agentCreationsPerWeek: 1 },
    anomalyThresholds: {
      approvalRateDrop: 0.70,
      qualityDeclinePoints: 0.5,
      qualityDeclineWindow: 10,
      escalationRate: 0.30,
      tokenBudgetMultiplier: 2.0,
    },
    modelRegistry: [],
    paths: {},
    ...overrides,
  };
}

/** Create a mock registry that tracks agent states. */
function makeMockRegistry(states: Record<string, AgentState>): IAgentRegistry {
  return {
    load: async () => ({ loaded: 0, rejected: 0, errors: [], duration_ms: 0 }),
    reload: async () => ({ loaded: 0, rejected: 0, errors: [], duration_ms: 0 }),
    list: () => [],
    get: () => undefined,
    getForTask: () => [],
    freeze: () => {},
    unfreeze: () => {},
    getState: (name: string) => states[name],
    setState: (name: string, state: AgentState) => { states[name] = state; },
  };
}

/** Create a temp directory for test state files. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obs-trigger-test-'));
}

/** Clean up a temp directory. */
function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Silent logger to keep test output clean. */
const silentLogger = {
  info: () => {},
  warn: () => {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function test_trigger_fires_at_threshold(): void {
  const tmpDir = makeTempDir();
  try {
    const config = makeConfig({ observation: { defaultThreshold: 10, perAgentOverrides: {} } });
    const registry = makeMockRegistry({ 'test-agent': 'ACTIVE' });
    const tracker = new ObservationTracker({
      config,
      statePath: path.join(tmpDir, 'state.json'),
      logger: silentLogger,
    });
    const auditLogger = new AuditLogger(path.join(tmpDir, 'audit.log'));
    const trigger = new ObservationTrigger(tracker, registry, config, auditLogger);

    // Record 9 invocations (below threshold)
    let decision;
    for (let i = 0; i < 9; i++) {
      decision = trigger.check('test-agent', '1.0.0');
      assert(!decision.triggered, `should not trigger at invocation ${i + 1}`);
    }

    // 10th invocation should trigger
    decision = trigger.check('test-agent', '1.0.0');
    assert(decision.triggered === true, 'should trigger at threshold');
    assert(decision.reason === 'threshold reached', `reason should be "threshold reached", got "${decision.reason}"`);
    assert(decision.agentName === 'test-agent', 'agentName should match');
    assert(decision.invocationCount === 10, `invocationCount should be 10, got ${decision.invocationCount}`);
    assert(decision.threshold === 10, `threshold should be 10, got ${decision.threshold}`);

    auditLogger.close();
    console.log('PASS: test_trigger_fires_at_threshold');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_trigger_does_not_fire_below_threshold(): void {
  const tmpDir = makeTempDir();
  try {
    const config = makeConfig({ observation: { defaultThreshold: 10, perAgentOverrides: {} } });
    const registry = makeMockRegistry({ 'test-agent': 'ACTIVE' });
    const tracker = new ObservationTracker({
      config,
      statePath: path.join(tmpDir, 'state.json'),
      logger: silentLogger,
    });
    const auditLogger = new AuditLogger(path.join(tmpDir, 'audit.log'));
    const trigger = new ObservationTrigger(tracker, registry, config, auditLogger);

    // Record 8 invocations (below threshold of 10)
    let decision;
    for (let i = 0; i < 8; i++) {
      decision = trigger.check('test-agent', '1.0.0');
    }

    assert(decision!.triggered === false, 'should not trigger below threshold');
    assert(decision!.reason === 'threshold not reached', `reason should be "threshold not reached", got "${decision!.reason}"`);

    auditLogger.close();
    console.log('PASS: test_trigger_does_not_fire_below_threshold');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_trigger_skips_frozen_agent(): void {
  const tmpDir = makeTempDir();
  try {
    const config = makeConfig({ observation: { defaultThreshold: 5, perAgentOverrides: {} } });
    const registry = makeMockRegistry({ 'frozen-agent': 'FROZEN' });
    const tracker = new ObservationTracker({
      config,
      statePath: path.join(tmpDir, 'state.json'),
      logger: silentLogger,
    });
    const auditLogger = new AuditLogger(path.join(tmpDir, 'audit.log'));
    const trigger = new ObservationTrigger(tracker, registry, config, auditLogger);

    // Record enough invocations to meet threshold
    let decision;
    for (let i = 0; i < 5; i++) {
      decision = trigger.check('frozen-agent', '1.0.0');
    }

    assert(decision!.triggered === false, 'should not trigger for FROZEN agent');
    assert(decision!.reason === 'agent is FROZEN', `reason should be "agent is FROZEN", got "${decision!.reason}"`);

    auditLogger.close();
    console.log('PASS: test_trigger_skips_frozen_agent');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_trigger_skips_under_review_agent(): void {
  const tmpDir = makeTempDir();
  try {
    const config = makeConfig({ observation: { defaultThreshold: 5, perAgentOverrides: {} } });
    const registry = makeMockRegistry({ 'review-agent': 'UNDER_REVIEW' });
    const tracker = new ObservationTracker({
      config,
      statePath: path.join(tmpDir, 'state.json'),
      logger: silentLogger,
    });
    const auditLogger = new AuditLogger(path.join(tmpDir, 'audit.log'));
    const trigger = new ObservationTrigger(tracker, registry, config, auditLogger);

    // Record enough invocations to meet threshold
    let decision;
    for (let i = 0; i < 5; i++) {
      decision = trigger.check('review-agent', '1.0.0');
    }

    assert(decision!.triggered === false, 'should not trigger for UNDER_REVIEW agent');
    assert(decision!.reason === 'analysis already in progress', `reason should be "analysis already in progress", got "${decision!.reason}"`);

    auditLogger.close();
    console.log('PASS: test_trigger_skips_under_review_agent');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_trigger_skips_validating_agent(): void {
  const tmpDir = makeTempDir();
  try {
    const config = makeConfig({ observation: { defaultThreshold: 5, perAgentOverrides: {} } });
    const registry = makeMockRegistry({ 'validating-agent': 'VALIDATING' });
    const tracker = new ObservationTracker({
      config,
      statePath: path.join(tmpDir, 'state.json'),
      logger: silentLogger,
    });
    const auditLogger = new AuditLogger(path.join(tmpDir, 'audit.log'));
    const trigger = new ObservationTrigger(tracker, registry, config, auditLogger);

    // Record enough invocations to meet threshold
    let decision;
    for (let i = 0; i < 5; i++) {
      decision = trigger.check('validating-agent', '1.0.0');
    }

    assert(decision!.triggered === false, 'should not trigger for VALIDATING agent');
    assert(decision!.reason === 'analysis already in progress', `reason should be "analysis already in progress", got "${decision!.reason}"`);

    auditLogger.close();
    console.log('PASS: test_trigger_skips_validating_agent');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_trigger_respects_per_agent_override(): void {
  const tmpDir = makeTempDir();
  try {
    const config = makeConfig({
      observation: {
        defaultThreshold: 10,
        perAgentOverrides: { 'code-executor': 20 },
      },
    });
    const registry = makeMockRegistry({ 'code-executor': 'ACTIVE' });
    const tracker = new ObservationTracker({
      config,
      statePath: path.join(tmpDir, 'state.json'),
      logger: silentLogger,
    });
    const auditLogger = new AuditLogger(path.join(tmpDir, 'audit.log'));
    const trigger = new ObservationTrigger(tracker, registry, config, auditLogger);

    // Record 15 invocations (above default 10, below override 20)
    let decision;
    for (let i = 0; i < 15; i++) {
      decision = trigger.check('code-executor', '1.0.0');
    }

    assert(decision!.triggered === false, 'should not trigger at 15 when override is 20');
    assert(decision!.threshold === 20, `threshold should be 20, got ${decision!.threshold}`);

    auditLogger.close();
    console.log('PASS: test_trigger_respects_per_agent_override');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_force_trigger_bypasses_threshold(): void {
  const tmpDir = makeTempDir();
  try {
    const config = makeConfig({ observation: { defaultThreshold: 100, perAgentOverrides: {} } });
    const registry = makeMockRegistry({ 'force-agent': 'ACTIVE' });
    const tracker = new ObservationTracker({
      config,
      statePath: path.join(tmpDir, 'state.json'),
      logger: silentLogger,
    });
    const auditLogger = new AuditLogger(path.join(tmpDir, 'audit.log'));
    const trigger = new ObservationTrigger(tracker, registry, config, auditLogger);

    // Record only 3 invocations (well below threshold of 100)
    trigger.check('force-agent', '1.0.0');
    trigger.check('force-agent', '1.0.0');
    trigger.check('force-agent', '1.0.0');

    // Force trigger should bypass threshold
    const decision = trigger.forceCheck('force-agent');
    assert(decision.triggered === true, 'force trigger should fire regardless of threshold');
    assert(decision.reason === 'forced by operator', `reason should be "forced by operator", got "${decision.reason}"`);

    auditLogger.close();
    console.log('PASS: test_force_trigger_bypasses_threshold');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_force_trigger_respects_frozen(): void {
  const tmpDir = makeTempDir();
  try {
    const config = makeConfig({ observation: { defaultThreshold: 10, perAgentOverrides: {} } });
    const registry = makeMockRegistry({ 'frozen-force': 'FROZEN' });
    const tracker = new ObservationTracker({
      config,
      statePath: path.join(tmpDir, 'state.json'),
      logger: silentLogger,
    });
    const auditLogger = new AuditLogger(path.join(tmpDir, 'audit.log'));
    const trigger = new ObservationTrigger(tracker, registry, config, auditLogger);

    const decision = trigger.forceCheck('frozen-force');
    assert(decision.triggered === false, 'force trigger should not fire for FROZEN agent');
    assert(
      decision.reason === 'agent is FROZEN (cannot force frozen agents)',
      `reason should mention FROZEN, got "${decision.reason}"`,
    );

    auditLogger.close();
    console.log('PASS: test_force_trigger_respects_frozen');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_trigger_skips_canary_agent(): void {
  const tmpDir = makeTempDir();
  try {
    const config = makeConfig({ observation: { defaultThreshold: 5, perAgentOverrides: {} } });
    const registry = makeMockRegistry({ 'canary-agent': 'CANARY' });
    const tracker = new ObservationTracker({
      config,
      statePath: path.join(tmpDir, 'state.json'),
      logger: silentLogger,
    });
    const auditLogger = new AuditLogger(path.join(tmpDir, 'audit.log'));
    const trigger = new ObservationTrigger(tracker, registry, config, auditLogger);

    // Record enough invocations to meet threshold
    let decision;
    for (let i = 0; i < 5; i++) {
      decision = trigger.check('canary-agent', '1.0.0');
    }

    assert(decision!.triggered === false, 'should not trigger for CANARY agent');
    assert(decision!.reason === 'analysis already in progress', `reason should be "analysis already in progress", got "${decision!.reason}"`);

    auditLogger.close();
    console.log('PASS: test_trigger_skips_canary_agent');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_trigger_writes_audit_log_on_fire(): void {
  const tmpDir = makeTempDir();
  try {
    const config = makeConfig({ observation: { defaultThreshold: 3, perAgentOverrides: {} } });
    const registry = makeMockRegistry({ 'audit-agent': 'ACTIVE' });
    const tracker = new ObservationTracker({
      config,
      statePath: path.join(tmpDir, 'state.json'),
      logger: silentLogger,
    });
    const auditLogPath = path.join(tmpDir, 'audit.log');
    const auditLogger = new AuditLogger(auditLogPath);
    const trigger = new ObservationTrigger(tracker, registry, config, auditLogger);

    // Fire the trigger
    for (let i = 0; i < 3; i++) {
      trigger.check('audit-agent', '1.0.0');
    }

    auditLogger.close();

    // Verify audit log entry was written
    const logContent = fs.readFileSync(auditLogPath, 'utf-8');
    assert(logContent.includes('"event_type":"domain_gap_detected"'), 'audit log should contain domain_gap_detected event');
    assert(logContent.includes('"trigger":"observation_threshold_reached"'), 'audit log should reference observation_threshold_reached');
    assert(logContent.includes('"audit-agent"'), 'audit log should reference agent name');

    console.log('PASS: test_trigger_writes_audit_log_on_fire');
  } finally {
    cleanupDir(tmpDir);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test_trigger_fires_at_threshold,
  test_trigger_does_not_fire_below_threshold,
  test_trigger_skips_frozen_agent,
  test_trigger_skips_under_review_agent,
  test_trigger_skips_validating_agent,
  test_trigger_respects_per_agent_override,
  test_force_trigger_bypasses_threshold,
  test_force_trigger_respects_frozen,
  test_trigger_skips_canary_agent,
  test_trigger_writes_audit_log_on_fire,
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
