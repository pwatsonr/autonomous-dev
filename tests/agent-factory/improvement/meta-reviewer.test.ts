/**
 * Unit tests for meta-review orchestration and self-review bypass
 * (SPEC-005-3-4, Tasks 8-9).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MetaReviewOrchestrator,
  buildReviewPrompt,
  parseMetaReviewOutput,
} from '../../../src/agent-factory/improvement/meta-reviewer';
import {
  AgentProposal,
  MetaReviewResult,
  MetaReviewFinding,
} from '../../../src/agent-factory/improvement/types';
import {
  ParsedAgent,
  IAgentRegistry,
  AgentRecord,
  AgentState,
  RankedAgent,
  RegistryLoadResult,
  RuntimeResult,
  RuntimeContext,
} from '../../../src/agent-factory/types';
import { AuditLogger } from '../../../src/agent-factory/audit';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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
    system_prompt: '# System Prompt\n\nYou are a code executor agent.',
  };
  return { ...base, ...overrides };
}

function metaReviewerAgent(): ParsedAgent {
  return baseAgent({
    name: 'agent-meta-reviewer',
    role: 'meta',
    tools: ['Read', 'Glob', 'Grep'],
    expertise: ['security-review', 'agent-safety'],
    description: 'Reviews agent modification proposals for safety',
  });
}

function makeAgentRecord(agent: ParsedAgent, state: AgentState = 'ACTIVE'): AgentRecord {
  return {
    agent,
    state,
    loadedAt: new Date(),
    diskHash: 'abc123',
    filePath: `/agents/${agent.name}.md`,
  };
}

function sampleProposal(overrides?: Partial<AgentProposal>): AgentProposal {
  return {
    proposal_id: 'prop-001',
    agent_name: 'code-executor',
    current_version: '1.0.0',
    proposed_version: '1.0.1',
    version_bump: 'patch',
    weakness_report_id: 'report-001',
    current_definition: '---\nname: code-executor\nversion: 1.0.0\nrole: executor\ntools: [Read, Bash]\n---\nOriginal prompt.',
    proposed_definition: '---\nname: code-executor\nversion: 1.0.1\nrole: executor\ntools: [Read, Bash]\n---\nImproved prompt.',
    diff: '--- a/code-executor.md\n+++ b/code-executor.md\n@@ -1,3 +1,3 @@\n-Original prompt.\n+Improved prompt.',
    rationale: 'Improve test coverage guidance',
    status: 'pending_meta_review',
    created_at: '2026-04-08T10:00:00.000Z',
    ...overrides,
  };
}

function approvedMetaReviewResponse(): string {
  return JSON.stringify({
    verdict: 'approved',
    findings: [],
    checklist_results: [
      { item: 1, name: 'Tool access escalation', passed: true },
      { item: 2, name: 'Role change', passed: true },
      { item: 3, name: 'Scope creep', passed: true },
      { item: 4, name: 'Prompt injection vectors', passed: true },
      { item: 5, name: 'Schema compliance', passed: true },
      { item: 6, name: 'Proportionality', passed: true },
    ],
  });
}

function rejectedWithBlockerResponse(): string {
  return JSON.stringify({
    verdict: 'rejected',
    findings: [
      {
        checklist_item: 1,
        severity: 'blocker',
        description: 'Proposal implies access to WebSearch tool not in allowlist',
        evidence: 'system prompt mentions "search the web for information"',
      },
    ],
    checklist_results: [
      { item: 1, name: 'Tool access escalation', passed: false },
      { item: 2, name: 'Role change', passed: true },
      { item: 3, name: 'Scope creep', passed: true },
      { item: 4, name: 'Prompt injection vectors', passed: true },
      { item: 5, name: 'Schema compliance', passed: true },
      { item: 6, name: 'Proportionality', passed: true },
    ],
  });
}

function approvedWithBlockerResponse(): string {
  // Agent says approved but has a blocker finding -- should be overridden
  return JSON.stringify({
    verdict: 'approved',
    findings: [
      {
        checklist_item: 2,
        severity: 'blocker',
        description: 'Role capability shift detected',
        evidence: 'Prompt implies reviewer-like behavior',
      },
    ],
    checklist_results: [
      { item: 1, name: 'Tool access escalation', passed: true },
      { item: 2, name: 'Role change', passed: false },
      { item: 3, name: 'Scope creep', passed: true },
      { item: 4, name: 'Prompt injection vectors', passed: true },
      { item: 5, name: 'Schema compliance', passed: true },
      { item: 6, name: 'Proportionality', passed: true },
    ],
  });
}

function warningOnlyResponse(): string {
  return JSON.stringify({
    verdict: 'approved',
    findings: [
      {
        checklist_item: 3,
        severity: 'warning',
        description: 'Minor scope creep: added mention of documentation',
        evidence: 'New prompt includes "ensure documentation is updated"',
      },
    ],
    checklist_results: [
      { item: 1, name: 'Tool access escalation', passed: true },
      { item: 2, name: 'Role change', passed: true },
      { item: 3, name: 'Scope creep', passed: true },
      { item: 4, name: 'Prompt injection vectors', passed: true },
      { item: 5, name: 'Schema compliance', passed: true },
      { item: 6, name: 'Proportionality', passed: true },
    ],
  });
}

function schemaComplianceFailureResponse(): string {
  return JSON.stringify({
    verdict: 'rejected',
    findings: [
      {
        checklist_item: 5,
        severity: 'blocker',
        description: 'Schema validation failed: invalid semver in version field',
        evidence: 'version field is "1.0" instead of valid semver "1.0.0"',
      },
    ],
    checklist_results: [
      { item: 1, name: 'Tool access escalation', passed: true },
      { item: 2, name: 'Role change', passed: true },
      { item: 3, name: 'Scope creep', passed: true },
      { item: 4, name: 'Prompt injection vectors', passed: true },
      { item: 5, name: 'Schema compliance', passed: false },
      { item: 6, name: 'Proportionality', passed: true },
    ],
  });
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

interface MockRuntimeOptions {
  output: string;
  success?: boolean;
}

class MockRuntime {
  public lastInput: string = '';
  private output: string;
  private success: boolean;

  constructor(opts: MockRuntimeOptions) {
    this.output = opts.output;
    this.success = opts.success ?? true;
  }

  async invoke(input: string, _context: RuntimeContext): Promise<RuntimeResult> {
    this.lastInput = input;
    return {
      success: this.success,
      output: this.output,
      toolCallsBlocked: 0,
      toolCallsAllowed: 0,
      duration_ms: 10,
    };
  }
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meta-reviewer-test-'));
}

function createTestSetup(
  runtimeOutput: string,
  runtimeSuccess: boolean = true,
  includeMetaReviewer: boolean = true,
): {
  registry: MockRegistry;
  auditLogger: AuditLogger;
  auditLogPath: string;
  tmpDir: string;
  orchestrator: MetaReviewOrchestrator;
  mockRuntime: MockRuntime;
} {
  const tmpDir = createTempDir();
  const auditLogPath = path.join(tmpDir, 'data', 'agent-audit.log');

  const records: AgentRecord[] = [
    makeAgentRecord(baseAgent()),
  ];

  if (includeMetaReviewer) {
    records.push(makeAgentRecord(metaReviewerAgent(), 'FROZEN'));
  }

  const registry = new MockRegistry(records);
  const auditLogger = new AuditLogger(auditLogPath);
  const mockRuntime = new MockRuntime({ output: runtimeOutput, success: runtimeSuccess });

  const orchestrator = new MetaReviewOrchestrator({
    registry,
    auditLogger,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    createRuntime: (_agent: AgentRecord) => mockRuntime as any,
  });

  return { registry, auditLogger, auditLogPath, tmpDir, orchestrator, mockRuntime };
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

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Meta-Review Tests
// ---------------------------------------------------------------------------

async function test_meta_review_all_pass(): Promise<void> {
  const { orchestrator, auditLogger, tmpDir } = createTestSetup(approvedMetaReviewResponse());
  const proposal = sampleProposal();

  const result = await orchestrator.review(proposal);

  assert(result.verdict === 'approved', `expected approved, got ${result.verdict}`);
  assert(result.checklist_results.length === 6, `expected 6 checklist results, got ${result.checklist_results.length}`);
  assert(result.checklist_results.every(cr => cr.passed), 'all checklist items should pass');
  assert(result.findings.length === 0, `expected 0 findings, got ${result.findings.length}`);
  assert(result.bypassed === false, 'should not be bypassed');

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_meta_review_all_pass');
}

async function test_meta_review_blocker_finding_rejects(): Promise<void> {
  const { orchestrator, auditLogger, tmpDir } = createTestSetup(rejectedWithBlockerResponse());
  const proposal = sampleProposal();

  const result = await orchestrator.review(proposal);

  assert(result.verdict === 'rejected', `expected rejected, got ${result.verdict}`);
  assert(result.findings.length >= 1, 'should have at least 1 finding');
  const blockerFinding = result.findings.find(f => f.severity === 'blocker');
  assert(blockerFinding !== undefined, 'should have a blocker finding');
  assert(blockerFinding!.checklist_item === 1, `expected checklist_item 1, got ${blockerFinding!.checklist_item}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_meta_review_blocker_finding_rejects');
}

async function test_meta_review_warning_does_not_reject(): Promise<void> {
  const { orchestrator, auditLogger, tmpDir } = createTestSetup(warningOnlyResponse());
  const proposal = sampleProposal();

  const result = await orchestrator.review(proposal);

  assert(result.verdict === 'approved', `expected approved, got ${result.verdict}`);
  assert(result.findings.length === 1, `expected 1 finding, got ${result.findings.length}`);
  assert(result.findings[0].severity === 'warning', `expected warning severity, got ${result.findings[0].severity}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_meta_review_warning_does_not_reject');
}

async function test_hard_override_blocker_always_rejects(): Promise<void> {
  const { orchestrator, auditLogger, tmpDir } = createTestSetup(approvedWithBlockerResponse());
  const proposal = sampleProposal();

  const result = await orchestrator.review(proposal);

  // Agent said "approved" but has a blocker finding -- must be overridden to "rejected"
  assert(result.verdict === 'rejected', `expected rejected (overridden), got ${result.verdict}`);
  const blockerFinding = result.findings.find(f => f.severity === 'blocker');
  assert(blockerFinding !== undefined, 'should have a blocker finding');

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_hard_override_blocker_always_rejects');
}

async function test_meta_review_updates_proposal_status_approved(): Promise<void> {
  const { orchestrator, auditLogger, tmpDir } = createTestSetup(approvedMetaReviewResponse());
  const proposal = sampleProposal();

  await orchestrator.review(proposal);

  assert(proposal.status === 'meta_approved', `expected meta_approved, got ${proposal.status}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_meta_review_updates_proposal_status_approved');
}

async function test_meta_review_updates_proposal_status_rejected(): Promise<void> {
  const { orchestrator, auditLogger, tmpDir } = createTestSetup(rejectedWithBlockerResponse());
  const proposal = sampleProposal();

  await orchestrator.review(proposal);

  assert(proposal.status === 'meta_rejected', `expected meta_rejected, got ${proposal.status}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_meta_review_updates_proposal_status_rejected');
}

async function test_meta_review_audit_log(): Promise<void> {
  const { orchestrator, auditLogger, auditLogPath, tmpDir } = createTestSetup(approvedMetaReviewResponse());
  const proposal = sampleProposal();

  await orchestrator.review(proposal);
  auditLogger.close();

  const logContent = readAuditLog(auditLogPath);
  assert(logContent.includes('meta_review_completed'), 'audit log should contain meta_review_completed');
  assert(logContent.includes(proposal.proposal_id), 'audit log should contain proposal_id');

  cleanupTmpDir(tmpDir);
  console.log('PASS: test_meta_review_audit_log');
}

async function test_meta_review_parse_failure(): Promise<void> {
  const { orchestrator, auditLogger, auditLogPath, tmpDir } = createTestSetup('this is not valid JSON at all');
  const proposal = sampleProposal();

  let threw = false;
  try {
    await orchestrator.review(proposal);
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && err.message.includes('parse'),
      `expected parse error, got: ${err}`,
    );
  }

  assert(threw, 'should have thrown an error on parse failure');
  assert(proposal.status === 'pending_meta_review', `proposal status should remain pending_meta_review, got ${proposal.status}`);

  auditLogger.close();
  const logContent = readAuditLog(auditLogPath);
  assert(logContent.includes('meta_review_parse_failed'), 'audit log should contain parse failure event');

  cleanupTmpDir(tmpDir);
  console.log('PASS: test_meta_review_parse_failure');
}

async function test_schema_compliance_check(): Promise<void> {
  const { orchestrator, auditLogger, tmpDir } = createTestSetup(schemaComplianceFailureResponse());
  const proposal = sampleProposal();

  const result = await orchestrator.review(proposal);

  assert(result.verdict === 'rejected', `expected rejected, got ${result.verdict}`);
  const item5 = result.checklist_results.find(cr => cr.item === 5);
  assert(item5 !== undefined, 'should have checklist item 5');
  assert(item5!.passed === false, 'checklist item 5 should fail');
  const schemaFinding = result.findings.find(f => f.checklist_item === 5);
  assert(schemaFinding !== undefined, 'should have a finding for checklist item 5');
  assert(schemaFinding!.severity === 'blocker', `expected blocker severity, got ${schemaFinding!.severity}`);

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_schema_compliance_check');
}

async function test_meta_reviewer_not_found_throws(): Promise<void> {
  // Create setup without meta-reviewer agent
  const tmpDir = createTempDir();
  const auditLogPath = path.join(tmpDir, 'data', 'agent-audit.log');
  const registry = new MockRegistry([makeAgentRecord(baseAgent())]);
  const auditLogger = new AuditLogger(auditLogPath);

  const orchestrator = new MetaReviewOrchestrator({
    registry,
    auditLogger,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const proposal = sampleProposal();

  let threw = false;
  try {
    await orchestrator.review(proposal);
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && err.message.includes('not found'),
      `expected not found error, got: ${err}`,
    );
  }

  assert(threw, 'should have thrown when meta-reviewer not found');

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_meta_reviewer_not_found_throws');
}

// ---------------------------------------------------------------------------
// Self-Review Bypass Tests
// ---------------------------------------------------------------------------

async function test_self_review_bypass_detected(): Promise<void> {
  const { orchestrator, auditLogger, tmpDir, mockRuntime } = createTestSetup(approvedMetaReviewResponse());
  const proposal = sampleProposal({ agent_name: 'agent-meta-reviewer' });

  const result = await orchestrator.review(proposal);

  assert(result.bypassed === true, 'should be bypassed');
  assert(result.bypass_reason !== undefined, 'bypass_reason should be set');
  assert(result.bypass_reason!.includes('Self-referential'), 'bypass_reason should mention self-referential');
  // The mock runtime should NOT have been invoked
  assert(mockRuntime.lastInput === '', 'meta-reviewer should NOT have been invoked');

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_self_review_bypass_detected');
}

async function test_self_review_status_pending_human(): Promise<void> {
  const { orchestrator, auditLogger, tmpDir } = createTestSetup(approvedMetaReviewResponse());
  const proposal = sampleProposal({ agent_name: 'agent-meta-reviewer' });

  await orchestrator.review(proposal);

  assert(
    proposal.status === 'pending_human_review',
    `expected pending_human_review, got ${proposal.status}`,
  );

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_self_review_status_pending_human');
}

async function test_self_review_bypass_logged(): Promise<void> {
  const { orchestrator, auditLogger, auditLogPath, tmpDir } = createTestSetup(approvedMetaReviewResponse());
  const proposal = sampleProposal({ agent_name: 'agent-meta-reviewer' });

  await orchestrator.review(proposal);
  auditLogger.close();

  const logContent = readAuditLog(auditLogPath);
  assert(
    logContent.includes('meta_review_bypassed_self_referential'),
    'audit log should contain meta_review_bypassed_self_referential',
  );

  cleanupTmpDir(tmpDir);
  console.log('PASS: test_self_review_bypass_logged');
}

async function test_non_self_proposal_not_bypassed(): Promise<void> {
  const { orchestrator, auditLogger, tmpDir } = createTestSetup(approvedMetaReviewResponse());
  const proposal = sampleProposal({ agent_name: 'code-executor' });

  const result = await orchestrator.review(proposal);

  assert(result.bypassed === false, 'should not be bypassed for non-self proposal');

  auditLogger.close();
  cleanupTmpDir(tmpDir);
  console.log('PASS: test_non_self_proposal_not_bypassed');
}

// ---------------------------------------------------------------------------
// Prompt builder tests
// ---------------------------------------------------------------------------

function test_review_prompt_includes_proposal_details(): void {
  const proposal = sampleProposal();
  const prompt = buildReviewPrompt(proposal);

  assert(prompt.includes('code-executor'), 'prompt should include agent name');
  assert(prompt.includes('1.0.0'), 'prompt should include current version');
  assert(prompt.includes('1.0.1'), 'prompt should include proposed version');
  assert(prompt.includes('patch'), 'prompt should include version bump');
  assert(prompt.includes('prop-001'), 'prompt should include proposal ID');
  assert(prompt.includes('report-001'), 'prompt should include weakness report ID');
  console.log('PASS: test_review_prompt_includes_proposal_details');
}

function test_review_prompt_includes_diff(): void {
  const proposal = sampleProposal();
  const prompt = buildReviewPrompt(proposal);

  assert(prompt.includes('```diff'), 'prompt should include diff block');
  assert(prompt.includes(proposal.diff), 'prompt should include the diff');
  console.log('PASS: test_review_prompt_includes_diff');
}

function test_review_prompt_includes_both_definitions(): void {
  const proposal = sampleProposal();
  const prompt = buildReviewPrompt(proposal);

  assert(prompt.includes('Current Definition'), 'prompt should include current definition section');
  assert(prompt.includes('Proposed Definition'), 'prompt should include proposed definition section');
  assert(prompt.includes(proposal.current_definition), 'prompt should include current definition');
  assert(prompt.includes(proposal.proposed_definition), 'prompt should include proposed definition');
  console.log('PASS: test_review_prompt_includes_both_definitions');
}

function test_review_prompt_includes_6_point_checklist(): void {
  const proposal = sampleProposal();
  const prompt = buildReviewPrompt(proposal);

  assert(prompt.includes('Tool access escalation'), 'prompt should include checklist item 1');
  assert(prompt.includes('Role change'), 'prompt should include checklist item 2');
  assert(prompt.includes('Scope creep'), 'prompt should include checklist item 3');
  assert(prompt.includes('Prompt injection vectors'), 'prompt should include checklist item 4');
  assert(prompt.includes('Schema compliance'), 'prompt should include checklist item 5');
  assert(prompt.includes('Proportionality'), 'prompt should include checklist item 6');
  console.log('PASS: test_review_prompt_includes_6_point_checklist');
}

// ---------------------------------------------------------------------------
// Output parser tests
// ---------------------------------------------------------------------------

function test_parse_approved_output(): void {
  const output = approvedMetaReviewResponse();
  const parsed = parseMetaReviewOutput(output);

  assert(parsed !== null, 'should parse successfully');
  assert(parsed!.verdict === 'approved', `expected approved, got ${parsed!.verdict}`);
  assert(parsed!.findings.length === 0, 'should have no findings');
  assert(parsed!.checklist_results.length === 6, `expected 6 checklist results, got ${parsed!.checklist_results.length}`);
  console.log('PASS: test_parse_approved_output');
}

function test_parse_rejected_output(): void {
  const output = rejectedWithBlockerResponse();
  const parsed = parseMetaReviewOutput(output);

  assert(parsed !== null, 'should parse successfully');
  assert(parsed!.verdict === 'rejected', `expected rejected, got ${parsed!.verdict}`);
  assert(parsed!.findings.length === 1, `expected 1 finding, got ${parsed!.findings.length}`);
  assert(parsed!.findings[0].severity === 'blocker', 'finding should be blocker');
  console.log('PASS: test_parse_rejected_output');
}

function test_parse_json_in_code_block(): void {
  const jsonStr = approvedMetaReviewResponse();
  const output = `Here is my analysis:\n\n\`\`\`json\n${jsonStr}\n\`\`\`\n\nDone.`;
  const parsed = parseMetaReviewOutput(output);

  assert(parsed !== null, 'should parse JSON from code block');
  assert(parsed!.verdict === 'approved', `expected approved, got ${parsed!.verdict}`);
  console.log('PASS: test_parse_json_in_code_block');
}

function test_parse_invalid_output_returns_null(): void {
  const output = 'This is not JSON at all.';
  const parsed = parseMetaReviewOutput(output);

  assert(parsed === null, 'should return null for unparseable output');
  console.log('PASS: test_parse_invalid_output_returns_null');
}

function test_parse_missing_verdict_returns_null(): void {
  const output = JSON.stringify({ findings: [], checklist_results: [] });
  const parsed = parseMetaReviewOutput(output);

  assert(parsed === null, 'should return null when verdict is missing');
  console.log('PASS: test_parse_missing_verdict_returns_null');
}

function test_parse_invalid_verdict_returns_null(): void {
  const output = JSON.stringify({ verdict: 'maybe', findings: [], checklist_results: [] });
  const parsed = parseMetaReviewOutput(output);

  assert(parsed === null, 'should return null for invalid verdict');
  console.log('PASS: test_parse_invalid_verdict_returns_null');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const syncTests = [
  test_review_prompt_includes_proposal_details,
  test_review_prompt_includes_diff,
  test_review_prompt_includes_both_definitions,
  test_review_prompt_includes_6_point_checklist,
  test_parse_approved_output,
  test_parse_rejected_output,
  test_parse_json_in_code_block,
  test_parse_invalid_output_returns_null,
  test_parse_missing_verdict_returns_null,
  test_parse_invalid_verdict_returns_null,
];

const asyncTests = [
  test_meta_review_all_pass,
  test_meta_review_blocker_finding_rejects,
  test_meta_review_warning_does_not_reject,
  test_hard_override_blocker_always_rejects,
  test_meta_review_updates_proposal_status_approved,
  test_meta_review_updates_proposal_status_rejected,
  test_meta_review_audit_log,
  test_meta_review_parse_failure,
  test_schema_compliance_check,
  test_meta_reviewer_not_found_throws,
  test_self_review_bypass_detected,
  test_self_review_status_pending_human,
  test_self_review_bypass_logged,
  test_non_self_proposal_not_bypassed,
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
