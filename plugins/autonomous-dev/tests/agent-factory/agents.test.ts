/**
 * Unit tests for foundation agent definitions (SPEC-005-1-4, Task 9).
 *
 * Validates that all 6 agent .md files pass schema validation
 * and meet the spec requirements.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseAgentString } from '../../src/agent-factory/parser';
import { validateAgent, TOOL_ALLOWLIST } from '../../src/agent-factory/validator';
import type { ParsedAgent, AgentRole } from '../../src/agent-factory/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.resolve(__dirname, '../../agents');

function readAgentFile(filename: string): string {
  return fs.readFileSync(path.join(AGENTS_DIR, filename), 'utf-8');
}

function parseAndValidateAgent(filename: string): {
  agent: ParsedAgent;
  validationValid: boolean;
  validationErrors: string[];
} {
  const content = readAgentFile(filename);
  const parseResult = parseAgentString(content);
  if (!parseResult.success || !parseResult.agent) {
    throw new Error(`Parse failed for ${filename}: ${parseResult.errors.map((e) => e.message).join('; ')}`);
  }

  const ctx = { existingNames: new Set<string>(), filename };
  const validationResult = validateAgent(parseResult.agent, ctx.existingNames);

  return {
    agent: parseResult.agent,
    validationValid: validationResult.valid,
    validationErrors: validationResult.errors.map((e) => `${e.rule}: ${e.message}`),
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function test_prd_author_passes_validation(): void {
  const { agent, validationValid, validationErrors } = parseAndValidateAgent('prd-author.md');
  assert(validationValid, `prd-author validation failed: ${validationErrors.join('; ')}`);
  assert(agent.name === 'prd-author', `name mismatch: ${agent.name}`);
  assert(agent.role === 'author', `role mismatch: ${agent.role}`);
  assert(agent.temperature === 0.7, `temperature mismatch: ${agent.temperature}`);
  assert(agent.turn_limit === 30, `turn_limit mismatch: ${agent.turn_limit}`);
  console.log('PASS: test_prd_author_passes_validation');
}

function test_tdd_author_passes_validation(): void {
  const { agent, validationValid, validationErrors } = parseAndValidateAgent('tdd-author.md');
  assert(validationValid, `tdd-author validation failed: ${validationErrors.join('; ')}`);
  assert(agent.name === 'tdd-author', `name mismatch: ${agent.name}`);
  assert(agent.role === 'author', `role mismatch: ${agent.role}`);
  assert(agent.temperature === 0.5, `temperature mismatch: ${agent.temperature}`);
  assert(agent.turn_limit === 40, `turn_limit mismatch: ${agent.turn_limit}`);
  console.log('PASS: test_tdd_author_passes_validation');
}

function test_code_executor_passes_validation(): void {
  const { agent, validationValid, validationErrors } = parseAndValidateAgent('code-executor.md');
  assert(validationValid, `code-executor validation failed: ${validationErrors.join('; ')}`);
  assert(agent.name === 'code-executor', `name mismatch: ${agent.name}`);
  assert(agent.role === 'executor', `role mismatch: ${agent.role}`);
  assert(agent.temperature === 0.3, `temperature mismatch: ${agent.temperature}`);
  assert(agent.turn_limit === 50, `turn_limit mismatch: ${agent.turn_limit}`);
  console.log('PASS: test_code_executor_passes_validation');
}

function test_quality_reviewer_passes_validation(): void {
  const { agent, validationValid, validationErrors } = parseAndValidateAgent('quality-reviewer.md');
  assert(validationValid, `quality-reviewer validation failed: ${validationErrors.join('; ')}`);
  assert(agent.name === 'quality-reviewer', `name mismatch: ${agent.name}`);
  assert(agent.role === 'reviewer', `role mismatch: ${agent.role}`);
  assert(agent.temperature === 0.2, `temperature mismatch: ${agent.temperature}`);
  assert(agent.turn_limit === 20, `turn_limit mismatch: ${agent.turn_limit}`);
  console.log('PASS: test_quality_reviewer_passes_validation');
}

function test_doc_reviewer_passes_validation(): void {
  const { agent, validationValid, validationErrors } = parseAndValidateAgent('doc-reviewer.md');
  assert(validationValid, `doc-reviewer validation failed: ${validationErrors.join('; ')}`);
  assert(agent.name === 'doc-reviewer', `name mismatch: ${agent.name}`);
  assert(agent.role === 'reviewer', `role mismatch: ${agent.role}`);
  assert(agent.temperature === 0.2, `temperature mismatch: ${agent.temperature}`);
  assert(agent.turn_limit === 20, `turn_limit mismatch: ${agent.turn_limit}`);
  console.log('PASS: test_doc_reviewer_passes_validation');
}

function test_agent_meta_reviewer_passes_validation(): void {
  const { agent, validationValid, validationErrors } = parseAndValidateAgent('agent-meta-reviewer.md');
  assert(validationValid, `agent-meta-reviewer validation failed: ${validationErrors.join('; ')}`);
  assert(agent.name === 'agent-meta-reviewer', `name mismatch: ${agent.name}`);
  assert(agent.role === 'meta', `role mismatch: ${agent.role}`);
  assert(agent.temperature === 0.1, `temperature mismatch: ${agent.temperature}`);
  assert(agent.turn_limit === 15, `turn_limit mismatch: ${agent.turn_limit}`);
  assert(agent.frozen === true, `frozen should be true, got ${agent.frozen}`);
  console.log('PASS: test_agent_meta_reviewer_passes_validation');
}

function test_all_agents_have_minimum_2_rubric_dimensions(): void {
  const files = [
    'prd-author.md',
    'tdd-author.md',
    'code-executor.md',
    'quality-reviewer.md',
    'doc-reviewer.md',
    'agent-meta-reviewer.md',
  ];

  for (const file of files) {
    const { agent } = parseAndValidateAgent(file);
    assert(
      agent.evaluation_rubric.length >= 2,
      `${file}: expected >= 2 rubric dimensions, got ${agent.evaluation_rubric.length}`,
    );
  }
  console.log('PASS: test_all_agents_have_minimum_2_rubric_dimensions');
}

function test_all_agents_respect_tool_allowlist(): void {
  const files = [
    'prd-author.md',
    'tdd-author.md',
    'code-executor.md',
    'quality-reviewer.md',
    'doc-reviewer.md',
    'agent-meta-reviewer.md',
  ];

  for (const file of files) {
    const { agent } = parseAndValidateAgent(file);
    const allowed = new Set(TOOL_ALLOWLIST[agent.role as AgentRole]);
    const disallowed = agent.tools.filter((t) => !allowed.has(t));
    assert(
      disallowed.length === 0,
      `${file}: tools [${disallowed.join(', ')}] not in allowlist for role '${agent.role}'`,
    );
  }
  console.log('PASS: test_all_agents_respect_tool_allowlist');
}

function test_all_system_prompts_are_substantive(): void {
  const files = [
    'prd-author.md',
    'tdd-author.md',
    'code-executor.md',
    'quality-reviewer.md',
    'doc-reviewer.md',
    'agent-meta-reviewer.md',
  ];

  for (const file of files) {
    const { agent } = parseAndValidateAgent(file);
    const wordCount = agent.system_prompt.split(/\s+/).filter((w) => w.length > 0).length;
    assert(
      wordCount >= 200,
      `${file}: system_prompt has ${wordCount} words, expected >= 200`,
    );
  }
  console.log('PASS: test_all_system_prompts_are_substantive');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test_prd_author_passes_validation,
  test_tdd_author_passes_validation,
  test_code_executor_passes_validation,
  test_quality_reviewer_passes_validation,
  test_doc_reviewer_passes_validation,
  test_agent_meta_reviewer_passes_validation,
  test_all_agents_have_minimum_2_rubric_dimensions,
  test_all_agents_respect_tool_allowlist,
  test_all_system_prompts_are_substantive,
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
