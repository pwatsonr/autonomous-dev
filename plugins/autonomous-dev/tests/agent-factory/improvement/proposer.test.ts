/**
 * Unit tests for proposal generator and constraint enforcement
 * (SPEC-005-3-3, Tasks 5-6).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ProposalGenerator,
  LLMInvoker,
  enforceConstraints,
  extractDefinitionFromResponse,
  buildImprovementPrompt,
  computeUnifiedDiff,
} from '../../../src/agent-factory/improvement/proposer';
import { ParsedAgent, IAgentRegistry, AgentRecord, AgentState, RankedAgent, RegistryLoadResult } from '../../../src/agent-factory/types';
import { AuditLogger } from '../../../src/agent-factory/audit';
import { WeaknessReport, ConstraintViolation } from '../../../src/agent-factory/improvement/types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function validAgentMd(): string {
  return [
    '---',
    'name: code-executor',
    'version: 1.0.0',
    'role: executor',
    'model: claude-sonnet-4-20250514',
    'temperature: 0.3',
    'turn_limit: 25',
    'tools: [Read, Glob, Grep, Bash, Edit, Write]',
    'expertise: [TypeScript, testing]',
    'description: Executes code changes based on specs',
    'evaluation_rubric:',
    '  - name: correctness',
    '    weight: 0.4',
    '    description: Passes tests',
    '  - name: quality',
    '    weight: 0.3',
    '    description: Clean code',
    '  - name: coverage',
    '    weight: 0.3',
    '    description: Adequate test coverage',
    'version_history:',
    '  - version: 1.0.0',
    '    date: 2026-01-01',
    '    change: Initial release',
    '---',
    '# System Prompt',
    '',
    'You are a code executor agent.',
    'You write clean, tested code.',
  ].join('\n');
}

function proposedAgentMd(): string {
  return [
    '---',
    'name: code-executor',
    'version: 1.0.1',
    'role: executor',
    'model: claude-sonnet-4-20250514',
    'temperature: 0.3',
    'turn_limit: 25',
    'tools: [Read, Glob, Grep, Bash, Edit, Write]',
    'expertise: [TypeScript, testing]',
    'description: Executes code changes based on specs',
    'evaluation_rubric:',
    '  - name: correctness',
    '    weight: 0.4',
    '    description: Passes tests',
    '  - name: quality',
    '    weight: 0.3',
    '    description: Clean code',
    '  - name: coverage',
    '    weight: 0.3',
    '    description: Adequate test coverage',
    'version_history:',
    '  - version: 1.0.0',
    '    date: 2026-01-01',
    '    change: Initial release',
    '  - version: 1.0.1',
    '    date: 2026-04-08',
    '    change: Improved test coverage guidance',
    '---',
    '# System Prompt',
    '',
    'You are a code executor agent.',
    'You write clean, tested code.',
    'Always ensure comprehensive test coverage for all changes.',
  ].join('\n');
}

function baseAgent(overrides?: Partial<ParsedAgent>): ParsedAgent {
  const base: ParsedAgent = {
    name: 'code-executor',
    version: '1.0.0',
    role: 'executor',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.3,
    turn_limit: 25,
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    expertise: ['TypeScript', 'testing'],
    evaluation_rubric: [
      { name: 'correctness', weight: 0.4, description: 'Passes tests' },
      { name: 'quality', weight: 0.3, description: 'Clean code' },
      { name: 'coverage', weight: 0.3, description: 'Adequate test coverage' },
    ],
    version_history: [
      { version: '1.0.0', date: '2026-01-01', change: 'Initial release' },
    ],
    risk_tier: 'medium',
    frozen: false,
    description: 'Executes code changes based on specs',
    system_prompt: '# System Prompt\n\nYou are a code executor agent.\nYou write clean, tested code.',
  };
  return { ...base, ...overrides };
}

function sampleWeaknessReport(): WeaknessReport {
  return {
    report_id: 'report-001',
    agent_name: 'code-executor',
    agent_version: '1.0.0',
    analysis_date: '2026-04-08T10:00:00.000Z',
    overall_assessment: 'needs_improvement',
    weaknesses: [
      {
        dimension: 'coverage',
        severity: 'medium',
        evidence: 'Average test-coverage score is 2.8/5.0.',
        affected_domains: ['python'],
        suggested_focus: 'Emphasize test generation for non-TypeScript domains',
      },
    ],
    strengths: ['correctness score stable at 4.2'],
    recommendation: 'propose_modification',
    metrics_summary: {
      invocation_count: 25,
      approval_rate: 0.80,
      avg_quality_score: 3.6,
      trend_direction: 'declining',
      active_alerts: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

class MockRegistry implements IAgentRegistry {
  private agents: Map<string, AgentRecord> = new Map();

  constructor(records?: AgentRecord[]) {
    if (records) {
      for (const r of records) {
        this.agents.set(r.agent.name, r);
      }
    }
  }

  async load(_agentsDir: string): Promise<RegistryLoadResult> {
    return { loaded: this.agents.size, rejected: 0, errors: [], duration_ms: 0 };
  }
  async reload(_agentsDir: string): Promise<RegistryLoadResult> {
    return this.load(_agentsDir);
  }
  list(): AgentRecord[] {
    return [...this.agents.values()];
  }
  get(name: string): AgentRecord | undefined {
    return this.agents.get(name);
  }
  getForTask(_taskDescription: string, _taskDomain?: string): RankedAgent[] {
    return [];
  }
  freeze(name: string): void {
    const r = this.agents.get(name);
    if (r) r.state = 'FROZEN';
  }
  unfreeze(name: string): void {
    const r = this.agents.get(name);
    if (r) r.state = 'ACTIVE';
  }
  getState(name: string): AgentState | undefined {
    return this.agents.get(name)?.state;
  }
  setState(name: string, state: AgentState): void {
    const r = this.agents.get(name);
    if (r) r.state = state;
  }
}

class MockLLM implements LLMInvoker {
  public lastPrompt: string = '';
  public lastModel: string = '';
  public response: string;
  public shouldFail: boolean = false;
  public failMessage: string = 'LLM error';

  constructor(response?: string) {
    this.response = response ?? `Here is the improved agent:\n\n\`\`\`markdown\n${proposedAgentMd()}\n\`\`\`\n\nThis should address the test coverage weakness.`;
  }

  async invoke(prompt: string, model: string): Promise<string> {
    this.lastPrompt = prompt;
    this.lastModel = model;
    if (this.shouldFail) {
      throw new Error(this.failMessage);
    }
    return this.response;
  }
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proposer-test-'));
}

function createTestSetup(llmResponse?: string): {
  registry: MockRegistry;
  llm: MockLLM;
  auditLogger: AuditLogger;
  agentsDir: string;
  auditLogPath: string;
  generator: ProposalGenerator;
} {
  const tmpDir = createTempDir();
  const agentsDir = path.join(tmpDir, 'agents');
  const auditLogPath = path.join(tmpDir, 'data', 'agent-audit.log');

  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'code-executor.md'), validAgentMd());

  const record: AgentRecord = {
    agent: baseAgent(),
    state: 'ACTIVE',
    loadedAt: new Date(),
    diskHash: 'abc123',
    filePath: path.join(agentsDir, 'code-executor.md'),
  };

  const registry = new MockRegistry([record]);
  const llm = new MockLLM(llmResponse);
  const auditLogger = new AuditLogger(auditLogPath);

  const generator = new ProposalGenerator(registry, llm, auditLogger, {
    agentsDir,
  });

  return { registry, llm, auditLogger, agentsDir, auditLogPath, generator };
}

function cleanupTempDir(dirPath: string): void {
  try {
    fs.rmSync(path.dirname(dirPath), { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// Constraint enforcement tests
// ---------------------------------------------------------------------------

function test_tools_field_change_rejected(): void {
  const current = baseAgent();
  const proposed = baseAgent({
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'Bash'],
  });

  const violations = enforceConstraints(current, proposed);
  assert(violations.length >= 1, `expected at least 1 violation, got ${violations.length}`);
  const toolViolation = violations.find(v => v.rule === 'IMMUTABLE_TOOLS');
  assert(toolViolation !== undefined, 'expected IMMUTABLE_TOOLS violation');
  assert(toolViolation!.field === 'tools', `expected field=tools, got ${toolViolation!.field}`);
  console.log('PASS: test_tools_field_change_rejected');
}

function test_role_field_change_rejected(): void {
  const current = baseAgent();
  const proposed = baseAgent({ role: 'author' });

  const violations = enforceConstraints(current, proposed);
  const roleViolation = violations.find(v => v.rule === 'IMMUTABLE_ROLE');
  assert(roleViolation !== undefined, 'expected IMMUTABLE_ROLE violation');
  assert(roleViolation!.field === 'role', `expected field=role`);
  assert(roleViolation!.current_value === 'executor', `current_value mismatch`);
  assert(roleViolation!.proposed_value === 'author', `proposed_value mismatch`);
  console.log('PASS: test_role_field_change_rejected');
}

function test_new_expertise_tag_rejected(): void {
  const current = baseAgent();
  const proposed = baseAgent({ expertise: ['TypeScript', 'testing', 'python'] });

  const violations = enforceConstraints(current, proposed);
  const expertiseViolation = violations.find(v => v.rule === 'NO_NEW_EXPERTISE');
  assert(expertiseViolation !== undefined, 'expected NO_NEW_EXPERTISE violation');
  assert(expertiseViolation!.field === 'expertise', `expected field=expertise`);
  console.log('PASS: test_new_expertise_tag_rejected');
}

function test_expertise_refinement_allowed(): void {
  const current = baseAgent({ expertise: ['TypeScript', 'testing'] });
  const proposed = baseAgent({ expertise: ['typescript', 'Testing'] });

  const violations = enforceConstraints(current, proposed);
  const expertiseViolation = violations.find(v => v.rule === 'NO_NEW_EXPERTISE');
  assert(expertiseViolation === undefined, 'expected no NO_NEW_EXPERTISE violation for case changes');
  console.log('PASS: test_expertise_refinement_allowed');
}

function test_rubric_dimension_removal_rejected(): void {
  const current = baseAgent();
  const proposed = baseAgent({
    evaluation_rubric: [
      { name: 'correctness', weight: 0.5, description: 'Passes tests' },
      { name: 'quality', weight: 0.5, description: 'Clean code' },
      // 'coverage' dimension removed
    ],
  });

  const violations = enforceConstraints(current, proposed);
  const rubricViolation = violations.find(v => v.rule === 'NO_RUBRIC_REMOVAL');
  assert(rubricViolation !== undefined, 'expected NO_RUBRIC_REMOVAL violation');
  assert(rubricViolation!.field === 'evaluation_rubric', `expected field=evaluation_rubric`);
  console.log('PASS: test_rubric_dimension_removal_rejected');
}

function test_rubric_dimension_addition_allowed(): void {
  const current = baseAgent();
  const proposed = baseAgent({
    evaluation_rubric: [
      ...current.evaluation_rubric,
      { name: 'performance', weight: 0.1, description: 'Runtime efficiency' },
    ],
  });

  const violations = enforceConstraints(current, proposed);
  const rubricViolation = violations.find(v => v.rule === 'NO_RUBRIC_REMOVAL');
  assert(rubricViolation === undefined, 'expected no NO_RUBRIC_REMOVAL violation for additions');
  console.log('PASS: test_rubric_dimension_addition_allowed');
}

function test_rubric_weight_change_allowed(): void {
  const current = baseAgent();
  const proposed = baseAgent({
    evaluation_rubric: [
      { name: 'correctness', weight: 0.5, description: 'Passes tests' },
      { name: 'quality', weight: 0.2, description: 'Clean code' },
      { name: 'coverage', weight: 0.3, description: 'Adequate test coverage' },
    ],
  });

  const violations = enforceConstraints(current, proposed);
  // Weight changes should not produce any of our 4 constraint violations
  const rubricViolation = violations.find(v => v.rule === 'NO_RUBRIC_REMOVAL');
  assert(rubricViolation === undefined, 'expected no NO_RUBRIC_REMOVAL violation for weight changes');
  console.log('PASS: test_rubric_weight_change_allowed');
}

function test_multiple_violations_all_reported(): void {
  const current = baseAgent();
  const proposed = baseAgent({
    tools: ['Read', 'Glob', 'Bash'],
    expertise: ['TypeScript', 'testing', 'python'],
  });

  const violations = enforceConstraints(current, proposed);
  assert(violations.length >= 2, `expected at least 2 violations, got ${violations.length}`);
  const rules = violations.map(v => v.rule);
  assert(rules.includes('IMMUTABLE_TOOLS'), 'expected IMMUTABLE_TOOLS');
  assert(rules.includes('NO_NEW_EXPERTISE'), 'expected NO_NEW_EXPERTISE');
  console.log('PASS: test_multiple_violations_all_reported');
}

function test_no_violations_when_identical(): void {
  const current = baseAgent();
  const proposed = baseAgent();

  const violations = enforceConstraints(current, proposed);
  assert(violations.length === 0, `expected 0 violations, got ${violations.length}`);
  console.log('PASS: test_no_violations_when_identical');
}

// ---------------------------------------------------------------------------
// Response extraction tests
// ---------------------------------------------------------------------------

function test_extraction_from_markdown_code_block(): void {
  const response = 'Here is the improved agent:\n\n```markdown\n---\nname: test\n---\nBody\n```\n\nDone.';
  const extracted = extractDefinitionFromResponse(response);
  assert(extracted !== null, 'expected non-null extraction');
  assert(extracted!.startsWith('---'), `expected to start with ---, got: ${extracted!.substring(0, 10)}`);
  assert(extracted!.includes('name: test'), 'expected to include name field');
  console.log('PASS: test_extraction_from_markdown_code_block');
}

function test_extraction_from_plain_code_block(): void {
  const response = 'Improved:\n\n```\n---\nname: test\n---\nBody content\n```';
  const extracted = extractDefinitionFromResponse(response);
  assert(extracted !== null, 'expected non-null extraction');
  assert(extracted!.includes('name: test'), 'expected to include name field');
  console.log('PASS: test_extraction_from_plain_code_block');
}

function test_extraction_from_md_code_block(): void {
  const response = '```md\n---\nname: agent\n---\nPrompt\n```';
  const extracted = extractDefinitionFromResponse(response);
  assert(extracted !== null, 'expected non-null extraction');
  assert(extracted!.includes('name: agent'), 'expected content');
  console.log('PASS: test_extraction_from_md_code_block');
}

function test_extraction_failure_no_code_block(): void {
  const response = 'Here is some text without any code blocks.';
  const extracted = extractDefinitionFromResponse(response);
  assert(extracted === null, 'expected null for no code block');
  console.log('PASS: test_extraction_failure_no_code_block');
}

// ---------------------------------------------------------------------------
// Improvement prompt tests
// ---------------------------------------------------------------------------

function test_prompt_includes_weakness_report(): void {
  const agent = baseAgent();
  const report = sampleWeaknessReport();
  const content = validAgentMd();

  const prompt = buildImprovementPrompt(agent, content, report);
  assert(prompt.includes('coverage'), 'prompt should mention weakness dimension');
  assert(prompt.includes('2.8/5.0'), 'prompt should include evidence');
  assert(prompt.includes('python'), 'prompt should include affected domains');
  assert(prompt.includes('needs_improvement'), 'prompt should include assessment');
  console.log('PASS: test_prompt_includes_weakness_report');
}

function test_prompt_includes_current_definition(): void {
  const agent = baseAgent();
  const report = sampleWeaknessReport();
  const content = validAgentMd();

  const prompt = buildImprovementPrompt(agent, content, report);
  assert(prompt.includes('name: code-executor'), 'prompt should include current definition');
  assert(prompt.includes('tools: [Read, Glob'), 'prompt should include tools');
  console.log('PASS: test_prompt_includes_current_definition');
}

function test_prompt_includes_constraints(): void {
  const agent = baseAgent();
  const report = sampleWeaknessReport();
  const content = validAgentMd();

  const prompt = buildImprovementPrompt(agent, content, report);
  assert(prompt.includes('Do NOT change the `tools` field'), 'prompt should include tools constraint');
  assert(prompt.includes('Do NOT change the `role` field'), 'prompt should include role constraint');
  assert(prompt.includes('Do NOT add new expertise tags'), 'prompt should include expertise constraint');
  assert(prompt.includes('Do NOT remove any `evaluation_rubric` dimensions'), 'prompt should include rubric constraint');
  console.log('PASS: test_prompt_includes_constraints');
}

function test_prompt_includes_agent_identity(): void {
  const agent = baseAgent();
  const report = sampleWeaknessReport();
  const content = validAgentMd();

  const prompt = buildImprovementPrompt(agent, content, report);
  assert(prompt.includes("'code-executor'"), 'prompt should include agent name');
  assert(prompt.includes('v1.0.0'), 'prompt should include version');
  assert(prompt.includes('role: executor'), 'prompt should include role');
  console.log('PASS: test_prompt_includes_agent_identity');
}

// ---------------------------------------------------------------------------
// Unified diff tests
// ---------------------------------------------------------------------------

function test_diff_contains_file_headers(): void {
  const diff = computeUnifiedDiff('line1\nline2', 'line1\nline3', 'test-agent');
  assert(diff.includes('--- a/test-agent.md'), 'diff should have --- header');
  assert(diff.includes('+++ b/test-agent.md'), 'diff should have +++ header');
  console.log('PASS: test_diff_contains_file_headers');
}

function test_diff_shows_changes(): void {
  const diff = computeUnifiedDiff('line1\nline2\nline3', 'line1\nmodified\nline3', 'agent');
  assert(diff.includes('-line2'), 'diff should show removed line');
  assert(diff.includes('+modified'), 'diff should show added line');
  console.log('PASS: test_diff_shows_changes');
}

function test_diff_identical_content(): void {
  const content = 'line1\nline2\nline3';
  const diff = computeUnifiedDiff(content, content, 'agent');
  // Should just have headers but no hunks
  assert(!diff.includes('-line'), 'identical content should have no removed lines');
  assert(!diff.includes('+line'), 'identical content should have no added lines');
  console.log('PASS: test_diff_identical_content');
}

// ---------------------------------------------------------------------------
// Full proposal generation tests (async)
// ---------------------------------------------------------------------------

async function test_generate_proposal_success(): Promise<void> {
  const { generator, agentsDir } = createTestSetup();
  const report = sampleWeaknessReport();

  const result = await generator.generateProposal('code-executor', report);
  assert(result.success === true, `expected success, got error: ${result.error}`);
  assert(result.proposal !== undefined, 'proposal should be defined');

  const proposal = result.proposal!;
  assert(proposal.agent_name === 'code-executor', `agent_name mismatch: ${proposal.agent_name}`);
  assert(proposal.current_version === '1.0.0', `current_version mismatch: ${proposal.current_version}`);
  assert(proposal.weakness_report_id === 'report-001', `weakness_report_id mismatch`);
  assert(proposal.status === 'pending_meta_review', `status mismatch: ${proposal.status}`);
  assert(proposal.diff.length > 0, 'diff should not be empty');
  assert(proposal.proposal_id.length > 0, 'proposal_id should be set');
  assert(proposal.created_at.length > 0, 'created_at should be set');

  cleanupTempDir(agentsDir);
  console.log('PASS: test_generate_proposal_success');
}

async function test_proposal_links_to_weakness_report(): Promise<void> {
  const { generator, agentsDir } = createTestSetup();
  const report = sampleWeaknessReport();

  const result = await generator.generateProposal('code-executor', report);
  assert(result.success === true, `expected success`);
  assert(result.proposal!.weakness_report_id === report.report_id,
    `weakness_report_id should match: ${result.proposal!.weakness_report_id} !== ${report.report_id}`);

  cleanupTempDir(agentsDir);
  console.log('PASS: test_proposal_links_to_weakness_report');
}

async function test_proposal_status_pending_meta_review(): Promise<void> {
  const { generator, agentsDir } = createTestSetup();
  const report = sampleWeaknessReport();

  const result = await generator.generateProposal('code-executor', report);
  assert(result.success === true, 'expected success');
  assert(result.proposal!.status === 'pending_meta_review',
    `expected pending_meta_review, got ${result.proposal!.status}`);

  cleanupTempDir(agentsDir);
  console.log('PASS: test_proposal_status_pending_meta_review');
}

async function test_proposal_version_incremented(): Promise<void> {
  const { generator, agentsDir } = createTestSetup();
  const report = sampleWeaknessReport();

  const result = await generator.generateProposal('code-executor', report);
  assert(result.success === true, 'expected success');
  // The proposed version should be > current version
  const proposed = result.proposal!.proposed_version;
  assert(proposed !== '1.0.0', `proposed version should differ from 1.0.0, got ${proposed}`);
  assert(/^\d+\.\d+\.\d+$/.test(proposed), `proposed version should be semver, got ${proposed}`);

  cleanupTempDir(agentsDir);
  console.log('PASS: test_proposal_version_incremented');
}

async function test_proposal_includes_diff(): Promise<void> {
  const { generator, agentsDir } = createTestSetup();
  const report = sampleWeaknessReport();

  const result = await generator.generateProposal('code-executor', report);
  assert(result.success === true, 'expected success');
  assert(result.proposal!.diff.includes('---'), 'diff should include --- header');
  assert(result.proposal!.diff.includes('+++'), 'diff should include +++ header');

  cleanupTempDir(agentsDir);
  console.log('PASS: test_proposal_includes_diff');
}

async function test_proposal_extraction_failure(): Promise<void> {
  const llmResponse = 'Here is some text without any code blocks at all.';
  const { generator, agentsDir } = createTestSetup(
    llmResponse,
  );
  const report = sampleWeaknessReport();

  const result = await generator.generateProposal('code-executor', report);
  assert(result.success === false, 'expected failure');
  assert(result.error !== undefined, 'error should be defined');
  assert(result.error!.includes('no code block'), `error should mention code block: ${result.error}`);

  cleanupTempDir(agentsDir);
  console.log('PASS: test_proposal_extraction_failure');
}

async function test_agent_not_found(): Promise<void> {
  const { generator, agentsDir } = createTestSetup();
  const report = sampleWeaknessReport();
  report.agent_name = 'nonexistent-agent';

  const result = await generator.generateProposal('nonexistent-agent', report);
  assert(result.success === false, 'expected failure');
  assert(result.error !== undefined, 'error should be defined');
  assert(result.error!.includes('not found'), `error should mention not found: ${result.error}`);

  cleanupTempDir(agentsDir);
  console.log('PASS: test_agent_not_found');
}

async function test_llm_invocation_failure(): Promise<void> {
  const { generator, llm, agentsDir } = createTestSetup();
  llm.shouldFail = true;
  llm.failMessage = 'API timeout';
  const report = sampleWeaknessReport();

  const result = await generator.generateProposal('code-executor', report);
  assert(result.success === false, 'expected failure');
  assert(result.error !== undefined, 'error should be defined');
  assert(result.error!.includes('API timeout'), `error should include failure message: ${result.error}`);

  cleanupTempDir(agentsDir);
  console.log('PASS: test_llm_invocation_failure');
}

async function test_constraint_violation_rejects_before_meta_review(): Promise<void> {
  // LLM returns a proposal that changes the tools field
  const violatingMd = [
    '---',
    'name: code-executor',
    'version: 1.0.1',
    'role: executor',
    'model: claude-sonnet-4-20250514',
    'temperature: 0.3',
    'turn_limit: 25',
    'tools: [Read, Glob, Grep, Bash, Edit, Write, WebSearch]',
    'expertise: [TypeScript, testing]',
    'description: Executes code changes based on specs',
    'evaluation_rubric:',
    '  - name: correctness',
    '    weight: 0.4',
    '    description: Passes tests',
    '  - name: quality',
    '    weight: 0.3',
    '    description: Clean code',
    '  - name: coverage',
    '    weight: 0.3',
    '    description: Adequate test coverage',
    'version_history:',
    '  - version: 1.0.0',
    '    date: 2026-01-01',
    '    change: Initial release',
    '---',
    '# System Prompt',
    '',
    'You are a code executor agent.',
  ].join('\n');

  const llmResponse = `Here is the improved agent:\n\n\`\`\`markdown\n${violatingMd}\n\`\`\``;
  const { generator, agentsDir } = createTestSetup(llmResponse);
  const report = sampleWeaknessReport();

  const result = await generator.generateProposal('code-executor', report);
  assert(result.success === false, 'expected failure due to constraint violation');
  assert(result.constraintViolations !== undefined, 'constraintViolations should be defined');
  assert(result.constraintViolations!.length > 0, 'should have at least one violation');
  const toolViolation = result.constraintViolations!.find(v => v.rule === 'IMMUTABLE_TOOLS');
  assert(toolViolation !== undefined, 'expected IMMUTABLE_TOOLS violation');

  cleanupTempDir(agentsDir);
  console.log('PASS: test_constraint_violation_rejects_before_meta_review');
}

async function test_violation_logged_to_audit(): Promise<void> {
  // LLM returns a proposal that changes tools
  const violatingMd = [
    '---',
    'name: code-executor',
    'version: 1.0.1',
    'role: executor',
    'model: claude-sonnet-4-20250514',
    'temperature: 0.3',
    'turn_limit: 25',
    'tools: [Read, Bash]',
    'expertise: [TypeScript, testing]',
    'description: Executes code changes based on specs',
    'evaluation_rubric:',
    '  - name: correctness',
    '    weight: 0.4',
    '    description: Passes tests',
    '  - name: quality',
    '    weight: 0.3',
    '    description: Clean code',
    '  - name: coverage',
    '    weight: 0.3',
    '    description: Adequate test coverage',
    'version_history:',
    '  - version: 1.0.0',
    '    date: 2026-01-01',
    '    change: Initial release',
    '---',
    '# Prompt',
  ].join('\n');

  const llmResponse = `\`\`\`markdown\n${violatingMd}\n\`\`\``;
  const { generator, auditLogger, auditLogPath, agentsDir } = createTestSetup(llmResponse);
  const report = sampleWeaknessReport();

  await generator.generateProposal('code-executor', report);
  auditLogger.close();

  // Check audit log file
  const auditDir = path.dirname(auditLogPath);
  if (fs.existsSync(auditLogPath)) {
    const logContent = fs.readFileSync(auditLogPath, 'utf-8');
    assert(logContent.includes('proposal_rejected_constraint_violation'),
      'audit log should contain constraint violation event');
    assert(logContent.includes('IMMUTABLE_TOOLS'),
      'audit log should contain the violation rule');
  } else {
    throw new Error(`Audit log file not found at ${auditLogPath}`);
  }

  cleanupTempDir(agentsDir);
  console.log('PASS: test_violation_logged_to_audit');
}

async function test_constraint_check_is_hard_coded(): Promise<void> {
  // Verify that enforceConstraints runs without any LLM invocation
  // by calling it directly (it's a pure function)
  const current = baseAgent();
  const proposed = baseAgent({ tools: ['Read'] });

  // This is a synchronous, pure function call - no LLM involved
  const violations = enforceConstraints(current, proposed);
  assert(violations.length > 0, 'should detect violations without LLM');
  assert(violations[0].rule === 'IMMUTABLE_TOOLS', 'should be IMMUTABLE_TOOLS');
  console.log('PASS: test_constraint_check_is_hard_coded');
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

const syncTests = [
  // Constraint enforcement
  test_tools_field_change_rejected,
  test_role_field_change_rejected,
  test_new_expertise_tag_rejected,
  test_expertise_refinement_allowed,
  test_rubric_dimension_removal_rejected,
  test_rubric_dimension_addition_allowed,
  test_rubric_weight_change_allowed,
  test_multiple_violations_all_reported,
  test_no_violations_when_identical,

  // Response extraction
  test_extraction_from_markdown_code_block,
  test_extraction_from_plain_code_block,
  test_extraction_from_md_code_block,
  test_extraction_failure_no_code_block,

  // Improvement prompt
  test_prompt_includes_weakness_report,
  test_prompt_includes_current_definition,
  test_prompt_includes_constraints,
  test_prompt_includes_agent_identity,

  // Unified diff
  test_diff_contains_file_headers,
  test_diff_shows_changes,
  test_diff_identical_content,

  // Hard-coded enforcement verification
  test_constraint_check_is_hard_coded,
];

const asyncTests = [
  test_generate_proposal_success,
  test_proposal_links_to_weakness_report,
  test_proposal_status_pending_meta_review,
  test_proposal_version_incremented,
  test_proposal_includes_diff,
  test_proposal_extraction_failure,
  test_agent_not_found,
  test_llm_invocation_failure,
  test_constraint_violation_rejects_before_meta_review,
  test_violation_logged_to_audit,
];

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const total = syncTests.length + asyncTests.length;

  // Run sync tests
  for (const test of syncTests) {
    try {
      test();
      passed++;
    } catch (err) {
      console.log(`FAIL: ${test.name} -- ${err}`);
      failed++;
    }
  }

  // Run async tests
  for (const test of asyncTests) {
    try {
      await test();
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
