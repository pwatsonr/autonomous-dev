import { parseAgentString } from '../../src/agent-factory/parser';

/**
 * Unit tests for agent definition parser (SPEC-005-1-1, Task 1).
 */

// ---------------------------------------------------------------------------
// Helper: build a well-formed agent .md file content
// ---------------------------------------------------------------------------
function validAgentMd(bodyOverride?: string): string {
  const fm = [
    '---',
    'name: code-executor',
    'version: 1.2.0',
    'role: executor',
    'model: claude-sonnet-4-20250514',
    'temperature: 0.3',
    'turn_limit: 25',
    'tools: [Read, Glob, Grep, Bash, Edit, Write]',
    'expertise: [TypeScript, testing]',
    'description: Executes code changes based on specs',
    'risk_tier: medium',
    'frozen: false',
    'evaluation_rubric:',
    '  - name: correctness',
    '    weight: 0.6',
    '    description: Code passes all tests',
    '  - name: style',
    '    weight: 0.4',
    '    description: Code follows project conventions',
    'version_history:',
    '  - version: 1.0.0',
    '    date: 2026-01-01',
    '    change: Initial release',
    '  - version: 1.2.0',
    '    date: 2026-04-01',
    '    change: Added Write tool access',
    '---',
  ].join('\n');

  const body = bodyOverride !== undefined ? bodyOverride : '# System Prompt\n\nYou are a code executor agent.';
  return fm + '\n' + body;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function test_parse_valid_agent_file(): void {
  const content = validAgentMd();
  const result = parseAgentString(content);

  assert(result.success === true, `expected success=true, got ${result.success}`);
  assert(result.agent !== undefined, 'agent should be defined');

  const a = result.agent!;
  assert(a.name === 'code-executor', `name mismatch: ${a.name}`);
  assert(a.version === '1.2.0', `version mismatch: ${a.version}`);
  assert(a.role === 'executor', `role mismatch: ${a.role}`);
  assert(a.model === 'claude-sonnet-4-20250514', `model mismatch: ${a.model}`);
  assert(a.temperature === 0.3, `temperature mismatch: ${a.temperature}`);
  assert(a.turn_limit === 25, `turn_limit mismatch: ${a.turn_limit}`);
  assert(Array.isArray(a.tools), 'tools should be array');
  assert(a.tools.length === 6, `tools length mismatch: ${a.tools.length}`);
  assert(a.tools[0] === 'Read', `tools[0] mismatch: ${a.tools[0]}`);
  assert(a.tools[3] === 'Bash', `tools[3] mismatch: ${a.tools[3]}`);
  assert(Array.isArray(a.expertise), 'expertise should be array');
  assert(a.expertise.length === 2, `expertise length mismatch: ${a.expertise.length}`);
  assert(a.description === 'Executes code changes based on specs', `description mismatch`);
  assert(a.risk_tier === 'medium', `risk_tier mismatch: ${a.risk_tier}`);
  assert(a.frozen === false, `frozen mismatch: ${a.frozen}`);

  // evaluation_rubric
  assert(a.evaluation_rubric.length === 2, `rubric length mismatch: ${a.evaluation_rubric.length}`);
  assert(a.evaluation_rubric[0].name === 'correctness', `rubric[0].name mismatch`);
  assert(a.evaluation_rubric[0].weight === 0.6, `rubric[0].weight mismatch: ${a.evaluation_rubric[0].weight}`);
  assert(a.evaluation_rubric[1].name === 'style', `rubric[1].name mismatch`);

  // version_history
  assert(a.version_history.length === 2, `version_history length mismatch: ${a.version_history.length}`);
  assert(a.version_history[0].version === '1.0.0', `history[0].version mismatch`);
  assert(a.version_history[1].version === '1.2.0', `history[1].version mismatch`);
  assert(a.version_history[1].change === 'Added Write tool access', `history[1].change mismatch`);

  // system_prompt = body
  assert(a.system_prompt.startsWith('# System Prompt'), `system_prompt mismatch: ${a.system_prompt.substring(0, 30)}`);

  console.log('PASS: test_parse_valid_agent_file');
}

function test_parse_missing_frontmatter_delimiters(): void {
  const content = '# Just a heading\n\nNo frontmatter here.';
  const result = parseAgentString(content);

  assert(result.success === false, 'expected success=false');
  assert(result.errors.length > 0, 'expected at least one error');
  assert(
    result.errors[0].message.includes('No YAML frontmatter found'),
    `error message mismatch: ${result.errors[0].message}`,
  );
  console.log('PASS: test_parse_missing_frontmatter_delimiters');
}

function test_parse_malformed_yaml(): void {
  // Unclosed quote in YAML (empty key triggered by ": value")
  const content = '---\n: no key here\n---\n';
  const result = parseAgentString(content);

  assert(result.success === false, 'expected success=false');
  assert(result.errors.length > 0, 'expected at least one error');
  assert(
    result.errors[0].line !== undefined,
    'error should include a line number',
  );
  console.log('PASS: test_parse_malformed_yaml');
}

function test_parse_empty_body(): void {
  const content = [
    '---',
    'name: test-agent',
    'version: 1.0.0',
    '---',
  ].join('\n');
  const result = parseAgentString(content);

  assert(result.success === true, `expected success=true, got ${result.success}`);
  assert(result.agent!.system_prompt === '', `system_prompt should be empty, got "${result.agent!.system_prompt}"`);
  console.log('PASS: test_parse_empty_body');
}

function test_parse_extra_delimiters_in_body(): void {
  const body = '# Heading\n\n---\n\nSome content after horizontal rule.\n\n---\n\nMore content.';
  const content = validAgentMd(body);
  const result = parseAgentString(content);

  assert(result.success === true, 'expected success=true');
  assert(
    result.agent!.system_prompt.includes('---'),
    'body should contain --- as content',
  );
  assert(
    result.agent!.system_prompt.includes('Some content after horizontal rule'),
    'body should contain text after ---',
  );
  console.log('PASS: test_parse_extra_delimiters_in_body');
}

function test_parse_missing_optional_fields(): void {
  const content = [
    '---',
    'name: minimal-agent',
    'version: 1.0.0',
    'role: reviewer',
    'model: claude-sonnet-4-20250514',
    'temperature: 0.0',
    'turn_limit: 10',
    'tools: [Read, Glob]',
    'expertise: [testing]',
    'description: A minimal agent',
    'evaluation_rubric:',
    '  - name: accuracy',
    '    weight: 0.5',
    '    description: Review accuracy',
    '  - name: coverage',
    '    weight: 0.5',
    '    description: Review coverage',
    'version_history:',
    '  - version: 1.0.0',
    '    date: 2026-01-01',
    '    change: Initial release',
    '---',
    '# Prompt',
  ].join('\n');

  const result = parseAgentString(content);

  assert(result.success === true, 'expected success=true');
  assert(result.agent!.risk_tier === undefined, `risk_tier should be undefined, got ${result.agent!.risk_tier}`);
  assert(result.agent!.frozen === undefined, `frozen should be undefined, got ${result.agent!.frozen}`);
  console.log('PASS: test_parse_missing_optional_fields');
}

function test_parse_type_coercion(): void {
  // turn_limit as string "50" in YAML — our parser already coerces integers
  // from YAML, but let's verify the mapping step handles it.
  const content = [
    '---',
    'name: coerce-agent',
    'version: 1.0.0',
    'role: author',
    'model: claude-sonnet-4-20250514',
    'temperature: 0.7',
    'turn_limit: 50',
    'tools: [Read]',
    'expertise: []',
    'description: Tests type coercion',
    'evaluation_rubric:',
    '  - name: a',
    '    weight: 0.5',
    '    description: d1',
    '  - name: b',
    '    weight: 0.5',
    '    description: d2',
    'version_history:',
    '  - version: 1.0.0',
    '    date: 2026-01-01',
    '    change: Initial',
    '---',
    '',
  ].join('\n');

  const result = parseAgentString(content);
  assert(result.success === true, 'expected success=true');
  assert(typeof result.agent!.turn_limit === 'number', `turn_limit should be number, got ${typeof result.agent!.turn_limit}`);
  assert(result.agent!.turn_limit === 50, `turn_limit should be 50, got ${result.agent!.turn_limit}`);
  assert(typeof result.agent!.temperature === 'number', `temperature should be number, got ${typeof result.agent!.temperature}`);
  assert(result.agent!.temperature === 0.7, `temperature should be 0.7, got ${result.agent!.temperature}`);
  console.log('PASS: test_parse_type_coercion');
}

function test_parse_single_opening_delimiter_only(): void {
  const content = '---\nname: broken\n';
  const result = parseAgentString(content);

  assert(result.success === false, 'expected success=false');
  assert(result.errors.length > 0, 'expected errors');
  console.log('PASS: test_parse_single_opening_delimiter_only');
}

function test_parse_preserves_full_body_with_newlines(): void {
  const body = 'Line 1\n\nLine 3\n\n\nLine 6';
  const content = '---\nname: agent\nversion: 1.0.0\n---\n' + body;
  const result = parseAgentString(content);

  assert(result.success === true, 'expected success=true');
  assert(result.agent!.system_prompt === body, `body mismatch: "${result.agent!.system_prompt}"`);
  console.log('PASS: test_parse_preserves_full_body_with_newlines');
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
  test_parse_valid_agent_file,
  test_parse_missing_frontmatter_delimiters,
  test_parse_malformed_yaml,
  test_parse_empty_body,
  test_parse_extra_delimiters_in_body,
  test_parse_missing_optional_fields,
  test_parse_type_coercion,
  test_parse_single_opening_delimiter_only,
  test_parse_preserves_full_body_with_newlines,
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
