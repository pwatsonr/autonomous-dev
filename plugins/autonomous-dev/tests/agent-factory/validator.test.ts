import { validateAgent, validateAgentWithContext, VALIDATION_RULES, TOOL_ALLOWLIST } from '../../src/agent-factory/validator';
import { ParsedAgent, AgentRole, ValidationContext } from '../../src/agent-factory/types';

/**
 * Unit tests for agent definition schema validator (SPEC-005-1-1, Task 2).
 */

// ---------------------------------------------------------------------------
// Helper: build a complete, valid ParsedAgent
// ---------------------------------------------------------------------------
function validAgent(overrides?: Partial<ParsedAgent>): ParsedAgent {
  const base: ParsedAgent = {
    name: 'code-executor',
    version: '1.2.0',
    role: 'executor',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.3,
    turn_limit: 25,
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    expertise: ['TypeScript', 'testing'],
    evaluation_rubric: [
      { name: 'correctness', weight: 0.6, description: 'Passes tests' },
      { name: 'style', weight: 0.4, description: 'Follows conventions' },
    ],
    version_history: [
      { version: '1.0.0', date: '2026-01-01', change: 'Initial' },
      { version: '1.2.0', date: '2026-04-01', change: 'Added Write' },
    ],
    risk_tier: 'medium',
    frozen: false,
    description: 'Executes code',
    system_prompt: '# You are a code executor.',
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// RULE_001: Name uniqueness
// ---------------------------------------------------------------------------

function test_rule_001_name_uniqueness_pass(): void {
  const agent = validAgent({ name: 'code-executor' });
  const result = validateAgent(agent, new Set(['prd-author']));

  assertNoRuleError(result.errors, 'RULE_001');
  console.log('PASS: test_rule_001_name_uniqueness_pass');
}

function test_rule_001_name_uniqueness_fail(): void {
  const agent = validAgent({ name: 'code-executor' });
  const result = validateAgent(agent, new Set(['code-executor']));

  assertRuleError(result.errors, 'RULE_001', 'name');
  console.log('PASS: test_rule_001_name_uniqueness_fail');
}

// ---------------------------------------------------------------------------
// RULE_002: Name/filename match
// ---------------------------------------------------------------------------

function test_rule_002_name_filename_match_pass(): void {
  const agent = validAgent({ name: 'prd-author' });
  const ctx: ValidationContext = {
    existingNames: new Set(),
    filename: 'prd-author.md',
  };
  const result = validateAgentWithContext(agent, ctx);

  assertNoRuleError(result.errors, 'RULE_002');
  console.log('PASS: test_rule_002_name_filename_match_pass');
}

function test_rule_002_name_filename_match_fail(): void {
  const agent = validAgent({ name: 'prd-author' });
  const ctx: ValidationContext = {
    existingNames: new Set(),
    filename: 'prd_author.md',
  };
  const result = validateAgentWithContext(agent, ctx);

  assertRuleError(result.errors, 'RULE_002', 'name');
  console.log('PASS: test_rule_002_name_filename_match_fail');
}

function test_rule_002_skipped_without_filename(): void {
  const agent = validAgent({ name: 'prd-author' });
  const result = validateAgent(agent);

  assertNoRuleError(result.errors, 'RULE_002');
  console.log('PASS: test_rule_002_skipped_without_filename');
}

// ---------------------------------------------------------------------------
// RULE_003: Valid semver
// ---------------------------------------------------------------------------

function test_rule_003_valid_semver(): void {
  const agent = validAgent({ version: '1.2.3' });
  const result = validateAgent(agent);

  assertNoRuleError(result.errors, 'RULE_003');
  console.log('PASS: test_rule_003_valid_semver');
}

function test_rule_003_invalid_semver_two_parts(): void {
  const agent = validAgent({ version: '1.2' });
  const result = validateAgent(agent);

  assertRuleError(result.errors, 'RULE_003', 'version');
  console.log('PASS: test_rule_003_invalid_semver_two_parts');
}

function test_rule_003_invalid_semver_v_prefix(): void {
  const agent = validAgent({ version: 'v1.2.3' });
  const result = validateAgent(agent);

  assertRuleError(result.errors, 'RULE_003', 'version');
  console.log('PASS: test_rule_003_invalid_semver_v_prefix');
}

function test_rule_003_invalid_semver_alpha(): void {
  const agent = validAgent({ version: 'abc' });
  const result = validateAgent(agent);

  assertRuleError(result.errors, 'RULE_003', 'version');
  console.log('PASS: test_rule_003_invalid_semver_alpha');
}

// ---------------------------------------------------------------------------
// RULE_004: Valid role
// ---------------------------------------------------------------------------

function test_rule_004_valid_role_author(): void {
  const agent = validAgent({ role: 'author', tools: ['Read', 'Glob'] });
  const result = validateAgent(agent);
  assertNoRuleError(result.errors, 'RULE_004');
  console.log('PASS: test_rule_004_valid_role_author');
}

function test_rule_004_valid_role_executor(): void {
  const agent = validAgent({ role: 'executor' });
  const result = validateAgent(agent);
  assertNoRuleError(result.errors, 'RULE_004');
  console.log('PASS: test_rule_004_valid_role_executor');
}

function test_rule_004_valid_role_reviewer(): void {
  const agent = validAgent({ role: 'reviewer', tools: ['Read', 'Glob'] });
  const result = validateAgent(agent);
  assertNoRuleError(result.errors, 'RULE_004');
  console.log('PASS: test_rule_004_valid_role_reviewer');
}

function test_rule_004_valid_role_meta(): void {
  const agent = validAgent({ role: 'meta', tools: ['Read', 'Glob'] });
  const result = validateAgent(agent);
  assertNoRuleError(result.errors, 'RULE_004');
  console.log('PASS: test_rule_004_valid_role_meta');
}

function test_rule_004_invalid_role(): void {
  const agent = validAgent({ role: 'admin' as AgentRole });
  const result = validateAgent(agent);

  assertRuleError(result.errors, 'RULE_004', 'role');
  console.log('PASS: test_rule_004_invalid_role');
}

// ---------------------------------------------------------------------------
// RULE_005: Tool allowlist
// ---------------------------------------------------------------------------

function test_rule_005_tool_allowlist_author_pass(): void {
  const agent = validAgent({ role: 'author', tools: ['Read', 'Glob'] });
  const result = validateAgent(agent);

  assertNoRuleError(result.errors, 'RULE_005');
  console.log('PASS: test_rule_005_tool_allowlist_author_pass');
}

function test_rule_005_tool_allowlist_author_fail(): void {
  const agent = validAgent({ role: 'author', tools: ['Read', 'Bash'] });
  const result = validateAgent(agent);

  const err = result.errors.find((e) => e.rule.startsWith('RULE_005'));
  assert(err !== undefined, 'expected RULE_005 error');
  assert(err!.message.includes('Bash'), `error message should mention Bash: ${err!.message}`);
  console.log('PASS: test_rule_005_tool_allowlist_author_fail');
}

function test_rule_005_tool_allowlist_executor_pass(): void {
  const agent = validAgent({
    role: 'executor',
    tools: ['Read', 'Bash', 'Edit', 'Write'],
  });
  const result = validateAgent(agent);

  assertNoRuleError(result.errors, 'RULE_005');
  console.log('PASS: test_rule_005_tool_allowlist_executor_pass');
}

function test_rule_005_tool_allowlist_reviewer_fail(): void {
  const agent = validAgent({
    role: 'reviewer',
    tools: ['Read', 'Edit'],
  });
  const result = validateAgent(agent);

  const err = result.errors.find((e) => e.rule.startsWith('RULE_005'));
  assert(err !== undefined, 'expected RULE_005 error');
  assert(err!.message.includes('Edit'), `error message should mention Edit: ${err!.message}`);
  console.log('PASS: test_rule_005_tool_allowlist_reviewer_fail');
}

function test_rule_005_tool_allowlist_meta_fail(): void {
  const agent = validAgent({
    role: 'meta',
    tools: ['Read', 'Glob', 'Grep', 'Write'],
  });
  const result = validateAgent(agent);

  const err = result.errors.find((e) => e.rule.startsWith('RULE_005'));
  assert(err !== undefined, 'expected RULE_005 error for Write');
  assert(err!.message.includes('Write'), `error message should mention Write: ${err!.message}`);
  console.log('PASS: test_rule_005_tool_allowlist_meta_fail');
}

function test_rule_005_all_author_tools_allowed(): void {
  const agent = validAgent({
    role: 'author',
    tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  });
  const result = validateAgent(agent);

  assertNoRuleError(result.errors, 'RULE_005');
  console.log('PASS: test_rule_005_all_author_tools_allowed');
}

function test_rule_005_all_executor_tools_allowed(): void {
  const agent = validAgent({
    role: 'executor',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch'],
  });
  const result = validateAgent(agent);

  assertNoRuleError(result.errors, 'RULE_005');
  console.log('PASS: test_rule_005_all_executor_tools_allowed');
}

// ---------------------------------------------------------------------------
// RULE_006: Rubric minimum dimensions
// ---------------------------------------------------------------------------

function test_rule_006_rubric_minimum_pass(): void {
  const agent = validAgent({
    evaluation_rubric: [
      { name: 'a', weight: 0.5, description: 'd1' },
      { name: 'b', weight: 0.5, description: 'd2' },
    ],
  });
  const result = validateAgent(agent);

  assertNoRuleError(result.errors, 'RULE_006');
  console.log('PASS: test_rule_006_rubric_minimum_pass');
}

function test_rule_006_rubric_minimum_fail(): void {
  const agent = validAgent({
    evaluation_rubric: [{ name: 'only-one', weight: 1.0, description: 'd' }],
  });
  const result = validateAgent(agent);

  assertRuleError(result.errors, 'RULE_006', 'evaluation_rubric');
  console.log('PASS: test_rule_006_rubric_minimum_fail');
}

function test_rule_006_rubric_empty_fail(): void {
  const agent = validAgent({ evaluation_rubric: [] });
  const result = validateAgent(agent);

  assertRuleError(result.errors, 'RULE_006', 'evaluation_rubric');
  const err = result.errors.find((e) => e.rule.startsWith('RULE_006'));
  assert(err!.message.includes('found 0'), `message should say found 0: ${err!.message}`);
  console.log('PASS: test_rule_006_rubric_empty_fail');
}

// ---------------------------------------------------------------------------
// RULE_007: Version history consistency
// ---------------------------------------------------------------------------

function test_rule_007_version_history_consistency_pass(): void {
  const agent = validAgent({
    version: '1.2.0',
    version_history: [
      { version: '1.0.0', date: '2026-01-01', change: 'Init' },
      { version: '1.2.0', date: '2026-04-01', change: 'Latest' },
    ],
  });
  const result = validateAgent(agent);

  assertNoRuleError(result.errors, 'RULE_007');
  console.log('PASS: test_rule_007_version_history_consistency_pass');
}

function test_rule_007_version_history_consistency_fail(): void {
  const agent = validAgent({
    version: '1.2.0',
    version_history: [
      { version: '1.0.0', date: '2026-01-01', change: 'Init' },
      { version: '1.1.0', date: '2026-03-01', change: 'Not latest' },
    ],
  });
  const result = validateAgent(agent);

  assertRuleError(result.errors, 'RULE_007', 'version_history');
  console.log('PASS: test_rule_007_version_history_consistency_fail');
}

function test_rule_007_empty_version_history_no_error(): void {
  const agent = validAgent({ version_history: [] });
  const result = validateAgent(agent);

  assertNoRuleError(result.errors, 'RULE_007');
  console.log('PASS: test_rule_007_empty_version_history_no_error');
}

// ---------------------------------------------------------------------------
// RULE_008: Turn limit range
// ---------------------------------------------------------------------------

function test_rule_008_turn_limit_min_pass(): void {
  const agent = validAgent({ turn_limit: 1 });
  const result = validateAgent(agent);
  assertNoRuleError(result.errors, 'RULE_008');
  console.log('PASS: test_rule_008_turn_limit_min_pass');
}

function test_rule_008_turn_limit_max_pass(): void {
  const agent = validAgent({ turn_limit: 100 });
  const result = validateAgent(agent);
  assertNoRuleError(result.errors, 'RULE_008');
  console.log('PASS: test_rule_008_turn_limit_max_pass');
}

function test_rule_008_turn_limit_zero_fail(): void {
  const agent = validAgent({ turn_limit: 0 });
  const result = validateAgent(agent);
  assertRuleError(result.errors, 'RULE_008', 'turn_limit');
  console.log('PASS: test_rule_008_turn_limit_zero_fail');
}

function test_rule_008_turn_limit_over_max_fail(): void {
  const agent = validAgent({ turn_limit: 101 });
  const result = validateAgent(agent);
  assertRuleError(result.errors, 'RULE_008', 'turn_limit');
  console.log('PASS: test_rule_008_turn_limit_over_max_fail');
}

// ---------------------------------------------------------------------------
// RULE_009: Model registry
// ---------------------------------------------------------------------------

function test_rule_009_model_registry_pass(): void {
  const agent = validAgent({ model: 'claude-sonnet-4-20250514' });
  const ctx: ValidationContext = {
    existingNames: new Set(),
    modelRegistry: new Set(['claude-sonnet-4-20250514']),
  };
  const result = validateAgentWithContext(agent, ctx);

  assertNoRuleError(result.errors, 'RULE_009');
  console.log('PASS: test_rule_009_model_registry_pass');
}

function test_rule_009_model_registry_fail(): void {
  const agent = validAgent({ model: 'gpt-unknown' });
  const ctx: ValidationContext = {
    existingNames: new Set(),
    modelRegistry: new Set(['claude-sonnet-4-20250514']),
  };
  const result = validateAgentWithContext(agent, ctx);

  assertRuleError(result.errors, 'RULE_009', 'model');
  console.log('PASS: test_rule_009_model_registry_fail');
}

function test_rule_009_uses_default_registry(): void {
  // Default registry includes claude-sonnet-4-20250514
  const agent = validAgent({ model: 'claude-sonnet-4-20250514' });
  const result = validateAgent(agent);

  assertNoRuleError(result.errors, 'RULE_009');
  console.log('PASS: test_rule_009_uses_default_registry');
}

// ---------------------------------------------------------------------------
// RULE_010: Temperature range
// ---------------------------------------------------------------------------

function test_rule_010_temperature_zero_pass(): void {
  const agent = validAgent({ temperature: 0.0 });
  const result = validateAgent(agent);
  assertNoRuleError(result.errors, 'RULE_010');
  console.log('PASS: test_rule_010_temperature_zero_pass');
}

function test_rule_010_temperature_one_pass(): void {
  const agent = validAgent({ temperature: 1.0 });
  const result = validateAgent(agent);
  assertNoRuleError(result.errors, 'RULE_010');
  console.log('PASS: test_rule_010_temperature_one_pass');
}

function test_rule_010_temperature_negative_fail(): void {
  const agent = validAgent({ temperature: -0.1 });
  const result = validateAgent(agent);
  assertRuleError(result.errors, 'RULE_010', 'temperature');
  console.log('PASS: test_rule_010_temperature_negative_fail');
}

function test_rule_010_temperature_over_one_fail(): void {
  const agent = validAgent({ temperature: 1.1 });
  const result = validateAgent(agent);
  assertRuleError(result.errors, 'RULE_010', 'temperature');
  console.log('PASS: test_rule_010_temperature_over_one_fail');
}

// ---------------------------------------------------------------------------
// Cross-cutting: validator returns ALL errors (no short-circuit)
// ---------------------------------------------------------------------------

function test_validator_returns_all_errors(): void {
  const agent = validAgent({
    version: 'bad',        // RULE_003
    role: 'author',
    tools: ['Read', 'Bash'], // RULE_005
    turn_limit: 200,       // RULE_008
  });
  const result = validateAgent(agent);

  assert(result.valid === false, 'expected valid=false');

  const ruleIds = result.errors.map((e) => e.rule);
  assert(
    ruleIds.some((r) => r.startsWith('RULE_003')),
    `expected RULE_003 error, got: ${ruleIds.join(', ')}`,
  );
  assert(
    ruleIds.some((r) => r.startsWith('RULE_005')),
    `expected RULE_005 error, got: ${ruleIds.join(', ')}`,
  );
  assert(
    ruleIds.some((r) => r.startsWith('RULE_008')),
    `expected RULE_008 error, got: ${ruleIds.join(', ')}`,
  );
  console.log('PASS: test_validator_returns_all_errors');
}

// ---------------------------------------------------------------------------
// Introspection: VALIDATION_RULES count and TOOL_ALLOWLIST shape
// ---------------------------------------------------------------------------

function test_validation_rules_count(): void {
  assert(VALIDATION_RULES.length === 10, `expected 10 rules, got ${VALIDATION_RULES.length}`);
  console.log('PASS: test_validation_rules_count');
}

function test_tool_allowlist_shape(): void {
  const roles: AgentRole[] = ['author', 'executor', 'reviewer', 'meta'];
  for (const role of roles) {
    assert(Array.isArray(TOOL_ALLOWLIST[role]), `TOOL_ALLOWLIST['${role}'] should be array`);
    assert(TOOL_ALLOWLIST[role].length > 0, `TOOL_ALLOWLIST['${role}'] should not be empty`);
  }
  // Executor has the most tools
  assert(
    TOOL_ALLOWLIST['executor'].length >= TOOL_ALLOWLIST['author'].length,
    'executor should have >= author tools',
  );
  // Reviewer and meta are the most restricted
  assert(
    TOOL_ALLOWLIST['reviewer'].length <= TOOL_ALLOWLIST['author'].length,
    'reviewer should have <= author tools',
  );
  console.log('PASS: test_tool_allowlist_shape');
}

function test_valid_agent_passes_all_rules(): void {
  const agent = validAgent();
  const result = validateAgent(agent);

  assert(result.valid === true, `expected valid=true, got valid=${result.valid}; errors: ${JSON.stringify(result.errors)}`);
  assert(result.errors.length === 0, `expected 0 errors, got ${result.errors.length}`);
  console.log('PASS: test_valid_agent_passes_all_rules');
}

function test_each_error_has_required_fields(): void {
  const agent = validAgent({ version: 'bad', turn_limit: 0 });
  const result = validateAgent(agent);

  for (const err of result.errors) {
    assert(typeof err.rule === 'string' && err.rule.length > 0, `error must have rule id`);
    assert(typeof err.field === 'string' && err.field.length > 0, `error must have field name`);
    assert(typeof err.message === 'string' && err.message.length > 0, `error must have message`);
    assert(err.severity === 'error' || err.severity === 'warning', `severity must be error or warning`);
  }
  console.log('PASS: test_each_error_has_required_fields');
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertRuleError(
  errors: { rule: string; field: string }[],
  rulePrefix: string,
  expectedField?: string,
): void {
  const match = errors.find((e) => e.rule.startsWith(rulePrefix));
  assert(match !== undefined, `expected error starting with '${rulePrefix}'`);
  if (expectedField) {
    assert(
      match!.field === expectedField,
      `expected field '${expectedField}', got '${match!.field}'`,
    );
  }
}

function assertNoRuleError(
  errors: { rule: string }[],
  rulePrefix: string,
): void {
  const match = errors.find((e) => e.rule.startsWith(rulePrefix));
  assert(match === undefined, `expected no error starting with '${rulePrefix}', but found: ${JSON.stringify(match)}`);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  // RULE_001
  test_rule_001_name_uniqueness_pass,
  test_rule_001_name_uniqueness_fail,
  // RULE_002
  test_rule_002_name_filename_match_pass,
  test_rule_002_name_filename_match_fail,
  test_rule_002_skipped_without_filename,
  // RULE_003
  test_rule_003_valid_semver,
  test_rule_003_invalid_semver_two_parts,
  test_rule_003_invalid_semver_v_prefix,
  test_rule_003_invalid_semver_alpha,
  // RULE_004
  test_rule_004_valid_role_author,
  test_rule_004_valid_role_executor,
  test_rule_004_valid_role_reviewer,
  test_rule_004_valid_role_meta,
  test_rule_004_invalid_role,
  // RULE_005
  test_rule_005_tool_allowlist_author_pass,
  test_rule_005_tool_allowlist_author_fail,
  test_rule_005_tool_allowlist_executor_pass,
  test_rule_005_tool_allowlist_reviewer_fail,
  test_rule_005_tool_allowlist_meta_fail,
  test_rule_005_all_author_tools_allowed,
  test_rule_005_all_executor_tools_allowed,
  // RULE_006
  test_rule_006_rubric_minimum_pass,
  test_rule_006_rubric_minimum_fail,
  test_rule_006_rubric_empty_fail,
  // RULE_007
  test_rule_007_version_history_consistency_pass,
  test_rule_007_version_history_consistency_fail,
  test_rule_007_empty_version_history_no_error,
  // RULE_008
  test_rule_008_turn_limit_min_pass,
  test_rule_008_turn_limit_max_pass,
  test_rule_008_turn_limit_zero_fail,
  test_rule_008_turn_limit_over_max_fail,
  // RULE_009
  test_rule_009_model_registry_pass,
  test_rule_009_model_registry_fail,
  test_rule_009_uses_default_registry,
  // RULE_010
  test_rule_010_temperature_zero_pass,
  test_rule_010_temperature_one_pass,
  test_rule_010_temperature_negative_fail,
  test_rule_010_temperature_over_one_fail,
  // Cross-cutting
  test_validator_returns_all_errors,
  test_validation_rules_count,
  test_tool_allowlist_shape,
  test_valid_agent_passes_all_rules,
  test_each_error_has_required_fields,
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
