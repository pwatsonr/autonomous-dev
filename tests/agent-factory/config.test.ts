/**
 * Unit tests for Agent Factory configuration loader (SPEC-005-1-4, Task 11).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadConfig,
  loadConfigWithValidation,
  getDefaultConfig,
} from '../../src/agent-factory/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/** Create a temporary YAML config file and return its path. */
function writeTempConfig(content: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-factory-config-'));
  const tmpFile = path.join(tmpDir, 'agent-factory.yaml');
  fs.writeFileSync(tmpFile, content, 'utf-8');
  return tmpFile;
}

/** Clean up a temporary file. */
function cleanupTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function test_load_valid_config(): void {
  const yaml = `# Test config
registry:
  agents-dir: "custom-agents/"
  max-agents: 25

observation:
  default-threshold: 15
  per-agent-overrides: {}

domain-matching:
  similarity-threshold: 0.8
  max-results: 10

rate-limits:
  modifications-per-agent-per-week: 2
  agent-creations-per-week: 3

anomaly-thresholds:
  approval-rate-drop: 0.60
  quality-decline-points: 0.3
  quality-decline-window: 20
  escalation-rate: 0.25
  token-budget-multiplier: 3.0

model-registry:
  - "claude-sonnet-4-20250514"
  - "claude-opus-4-20250514"

paths:
  audit-log: "custom/audit.log"
  metrics-jsonl: "custom/metrics.jsonl"
`;

  const tmpFile = writeTempConfig(yaml);
  try {
    const config = loadConfig(tmpFile);

    assert(config.registry.agentsDir === 'custom-agents/', `agentsDir mismatch: ${config.registry.agentsDir}`);
    assert(config.registry.maxAgents === 25, `maxAgents mismatch: ${config.registry.maxAgents}`);
    assert(config.observation.defaultThreshold === 15, `defaultThreshold mismatch: ${config.observation.defaultThreshold}`);
    assert(config.domainMatching.similarityThreshold === 0.8, `similarityThreshold mismatch: ${config.domainMatching.similarityThreshold}`);
    assert(config.domainMatching.maxResults === 10, `maxResults mismatch: ${config.domainMatching.maxResults}`);
    assert(config.rateLimits.modificationsPerAgentPerWeek === 2, `modificationsPerAgentPerWeek mismatch`);
    assert(config.rateLimits.agentCreationsPerWeek === 3, `agentCreationsPerWeek mismatch`);
    assert(config.anomalyThresholds.approvalRateDrop === 0.60, `approvalRateDrop mismatch`);
    assert(config.anomalyThresholds.qualityDeclinePoints === 0.3, `qualityDeclinePoints mismatch`);
    assert(config.anomalyThresholds.qualityDeclineWindow === 20, `qualityDeclineWindow mismatch`);
    assert(config.anomalyThresholds.escalationRate === 0.25, `escalationRate mismatch`);
    assert(config.anomalyThresholds.tokenBudgetMultiplier === 3.0, `tokenBudgetMultiplier mismatch`);
    assert(config.modelRegistry.length === 2, `modelRegistry length mismatch`);
    assert(config.modelRegistry[0] === 'claude-sonnet-4-20250514', `modelRegistry[0] mismatch`);
    assert(config.paths['audit-log'] === 'custom/audit.log', `audit-log path mismatch`);
    assert(config.paths['metrics-jsonl'] === 'custom/metrics.jsonl', `metrics-jsonl path mismatch`);

    console.log('PASS: test_load_valid_config');
  } finally {
    cleanupTempFile(tmpFile);
  }
}

function test_load_config_with_defaults(): void {
  // Only registry section provided
  const yaml = `registry:
  agents-dir: "my-agents/"
  max-agents: 10
`;

  const tmpFile = writeTempConfig(yaml);
  try {
    const config = loadConfig(tmpFile);

    // Provided values
    assert(config.registry.agentsDir === 'my-agents/', `agentsDir mismatch: ${config.registry.agentsDir}`);
    assert(config.registry.maxAgents === 10, `maxAgents mismatch: ${config.registry.maxAgents}`);

    // Default values for other sections
    assert(config.observation.defaultThreshold === 10, `defaultThreshold should default to 10`);
    assert(config.domainMatching.similarityThreshold === 0.6, `similarityThreshold should default to 0.6`);
    assert(config.rateLimits.modificationsPerAgentPerWeek === 1, `modificationsPerAgentPerWeek should default to 1`);
    assert(config.anomalyThresholds.approvalRateDrop === 0.70, `approvalRateDrop should default to 0.70`);
    assert(config.modelRegistry.length >= 1, `modelRegistry should have defaults`);
    assert(config.paths['audit-log'] === 'data/agent-audit.log', `audit-log path should default`);

    console.log('PASS: test_load_config_with_defaults');
  } finally {
    cleanupTempFile(tmpFile);
  }
}

function test_load_missing_config_file(): void {
  const config = loadConfig('/nonexistent/path/agent-factory.yaml');

  // Should return all defaults, no error thrown
  const defaults = getDefaultConfig();
  assert(config.registry.agentsDir === defaults.registry.agentsDir, 'agentsDir should match default');
  assert(config.registry.maxAgents === defaults.registry.maxAgents, 'maxAgents should match default');
  assert(config.observation.defaultThreshold === defaults.observation.defaultThreshold, 'defaultThreshold should match default');
  assert(config.domainMatching.similarityThreshold === defaults.domainMatching.similarityThreshold, 'similarityThreshold should match default');
  assert(config.modelRegistry.length === defaults.modelRegistry.length, 'modelRegistry should match default');

  console.log('PASS: test_load_missing_config_file');
}

function test_model_registry_populated(): void {
  const config = getDefaultConfig();
  assert(config.modelRegistry.length >= 1, `modelRegistry should have at least 1 entry, got ${config.modelRegistry.length}`);
  assert(
    config.modelRegistry.some((m) => m.includes('claude')),
    'modelRegistry should contain a Claude model',
  );
  console.log('PASS: test_model_registry_populated');
}

function test_paths_are_relative(): void {
  const yaml = `paths:
  audit-log: "/data/agent-audit.log"
  metrics-jsonl: "data/metrics.jsonl"
`;

  const tmpFile = writeTempConfig(yaml);
  try {
    const { config, warnings } = loadConfigWithValidation(tmpFile);

    // The absolute path should be loaded
    assert(config.paths['audit-log'] === '/data/agent-audit.log', 'absolute path should be loaded');

    // But should produce a validation warning
    assert(warnings.length > 0, 'should have validation warnings for absolute paths');
    assert(
      warnings.some((w) => w.field === 'paths.audit-log'),
      `should warn about audit-log path, got fields: ${warnings.map((w) => w.field).join(', ')}`,
    );
    assert(
      warnings.some((w) => w.message.includes('absolute')),
      'warning should mention absolute path',
    );

    console.log('PASS: test_paths_are_relative');
  } finally {
    cleanupTempFile(tmpFile);
  }
}

function test_per_agent_overrides(): void {
  // The lightweight YAML parser handles {} for empty objects.
  // For populated overrides we need to test that the loader handles
  // nested key-value within observation section. Our parser handles
  // flat nested keys, but per-agent-overrides with actual values
  // would require deeper nesting. The current YAML subset handles
  // the empty {} case from the spec.
  const defaults = getDefaultConfig();
  assert(
    typeof defaults.observation.perAgentOverrides === 'object',
    'perAgentOverrides should be an object',
  );
  assert(
    Object.keys(defaults.observation.perAgentOverrides).length === 0,
    'default perAgentOverrides should be empty',
  );
  console.log('PASS: test_per_agent_overrides');
}

function test_default_config_values_match_spec(): void {
  const config = getDefaultConfig();

  assert(config.registry.agentsDir === 'agents/', 'agentsDir default');
  assert(config.registry.maxAgents === 50, 'maxAgents default');
  assert(config.observation.defaultThreshold === 10, 'defaultThreshold default');
  assert(config.domainMatching.similarityThreshold === 0.6, 'similarityThreshold default');
  assert(config.domainMatching.maxResults === 5, 'maxResults default');
  assert(config.rateLimits.modificationsPerAgentPerWeek === 1, 'modificationsPerAgentPerWeek default');
  assert(config.rateLimits.agentCreationsPerWeek === 1, 'agentCreationsPerWeek default');
  assert(config.anomalyThresholds.approvalRateDrop === 0.70, 'approvalRateDrop default');
  assert(config.anomalyThresholds.qualityDeclinePoints === 0.5, 'qualityDeclinePoints default');
  assert(config.anomalyThresholds.qualityDeclineWindow === 10, 'qualityDeclineWindow default');
  assert(config.anomalyThresholds.escalationRate === 0.30, 'escalationRate default');
  assert(config.anomalyThresholds.tokenBudgetMultiplier === 2.0, 'tokenBudgetMultiplier default');
  assert(config.modelRegistry.includes('claude-sonnet-4-20250514'), 'modelRegistry should include sonnet');
  assert(config.modelRegistry.includes('claude-opus-4-20250514'), 'modelRegistry should include opus');
  assert(config.paths['audit-log'] === 'data/agent-audit.log', 'audit-log path default');
  assert(config.paths['metrics-jsonl'] === 'data/metrics/agent-invocations.jsonl', 'metrics-jsonl path default');
  assert(config.paths['metrics-db'] === 'data/agent-metrics.db', 'metrics-db path default');

  console.log('PASS: test_default_config_values_match_spec');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test_load_valid_config,
  test_load_config_with_defaults,
  test_load_missing_config_file,
  test_model_registry_populated,
  test_paths_are_relative,
  test_per_agent_overrides,
  test_default_config_values_match_spec,
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
