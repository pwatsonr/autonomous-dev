/**
 * End-to-end tests for the human-gated `agent improve` command (issue #529).
 *
 * `commandImprove` wires the EXISTING self-improvement modules into one
 * operator command: analyze -> propose (enforceConstraints) -> meta-review ->
 * PARK at the human-approval gate. The non-negotiable invariant under test:
 * no agent self-modification is ever committed without a separate, explicit
 * human approval step (`agent accept` / `agent promote`).
 *
 * Conventions match the rest of tests/agent-factory/:
 *   - a faked IMetricsEngine seeded with a degraded aggregate (mirrors
 *     analyzer.test.ts),
 *   - a real WeaknessReportStore / ProposalStore / AuditLogger /
 *     ObservationTracker,
 *   - a real PerformanceAnalyzer with a mocked performance-analyst runtime
 *     (createRuntime injection), a real ProposalGenerator with a mocked
 *     LLMInvoker, and the REAL MetaReviewOrchestrator with a mocked
 *     agent-meta-reviewer runtime — so the 6-point checklist gate genuinely
 *     runs (no invented meta-review mechanism),
 *   - a temp git repo + real Promoter for the approval path (mirrors
 *     promoter.test.ts), proving the parked proposal promotes ONLY via the
 *     separate human gate and that nothing was committed by `improve` itself.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { commandImprove } from '../../../src/agent-factory/cli';
import { PerformanceAnalyzer } from '../../../src/agent-factory/improvement/analyzer';
import { ProposalGenerator } from '../../../src/agent-factory/improvement/proposer';
import type { LLMInvoker } from '../../../src/agent-factory/improvement/proposer';
import { ProposalStore } from '../../../src/agent-factory/improvement/proposal-store';
import { WeaknessReportStore } from '../../../src/agent-factory/improvement/types';
import { MetaReviewOrchestrator } from '../../../src/agent-factory/improvement/meta-reviewer';
import { Promoter } from '../../../src/agent-factory/promotion/promoter';
import { AuditLogger } from '../../../src/agent-factory/audit';
import { ObservationTracker } from '../../../src/agent-factory/metrics/observation';
import type { AgentFactoryConfig } from '../../../src/agent-factory/config';
import type { AgentProposal, MetaReviewResult } from '../../../src/agent-factory/improvement/types';
import type {
  ParsedAgent,
  IAgentRegistry,
  AgentRecord,
  AgentState,
  RankedAgent,
  RegistryLoadResult,
  RuntimeResult,
  RuntimeContext,
} from '../../../src/agent-factory/types';
import type {
  IMetricsEngine,
  InvocationMetric,
  AggregateMetrics,
  AlertRecord,
  QueryOptions,
  AlertQueryOptions,
} from '../../../src/agent-factory/metrics/types';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Temp-dir + git helpers (mirror promoter.test.ts)
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'improve-test-'));
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function initGitRepo(repoRoot: string): void {
  const run = (cmd: string) => execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
  run('git init -q');
  run('git config user.email "test@example.com"');
  run('git config user.name "Improve Test"');
  run('git config commit.gpgsign false');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture repo\n', 'utf-8');
  run('git add README.md');
  run('git commit -q -m "chore: baseline"');
}

function gitHead(repoRoot: string): string {
  return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

// ---------------------------------------------------------------------------
// Agent .md fixtures
// ---------------------------------------------------------------------------

function agentMd(version: string, extraLine?: string): string {
  return [
    '---',
    'name: code-executor',
    `version: ${version}`,
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
    ...(extraLine ? [extraLine] : []),
  ].join('\n');
}

/**
 * A proposed .md that ONLY changes the system-prompt body + version_history
 * (passes enforceConstraints: tools/role/expertise/rubric unchanged).
 */
function proposedAgentMd_valid(): string {
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

/**
 * A proposed .md that ESCALATES tools (adds WebSearch) — must be rejected by
 * the mechanical enforceConstraints gate BEFORE meta-review.
 */
function proposedAgentMd_toolEscalation(): string {
  return [
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
    '  - version: 1.0.1',
    '    date: 2026-04-08',
    '    change: Added web search',
    '---',
    '# System Prompt',
    '',
    'You are a code executor agent.',
    'Search the web for additional context when needed.',
  ].join('\n');
}

function baseAgent(version = '1.0.0'): ParsedAgent {
  return {
    name: 'code-executor',
    version,
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
    version_history: [{ version: '1.0.0', date: '2026-01-01', change: 'Initial release' }],
    risk_tier: 'medium',
    frozen: false,
    description: 'Executes code changes based on specs',
    system_prompt: '# System Prompt\n\nYou are a code executor agent.\nYou write clean, tested code.',
  };
}

function metaReviewerAgent(): ParsedAgent {
  return {
    ...baseAgent(),
    name: 'agent-meta-reviewer',
    role: 'meta',
    tools: ['Read', 'Glob', 'Grep'],
    expertise: ['security-review', 'agent-safety'],
    description: 'Reviews agent modification proposals for safety',
  };
}

function analystAgent(): ParsedAgent {
  return {
    ...baseAgent(),
    name: 'performance-analyst',
    role: 'reviewer',
    tools: ['Read', 'Glob', 'Grep'],
    expertise: ['metrics-analysis'],
    description: 'Analyzes agent performance metrics',
  };
}

function makeAgentRecord(agent: ParsedAgent, state: AgentState, filePath: string): AgentRecord {
  return { agent, state, loadedAt: new Date(), diskHash: 'abc123', filePath };
}

// ---------------------------------------------------------------------------
// Disk-backed mock registry (reload re-reads version: from disk, like
// promoter.test.ts) so the post-commit version check in promote() works.
// ---------------------------------------------------------------------------

class DiskBackedRegistry implements IAgentRegistry {
  private agents: Map<string, AgentRecord> = new Map();
  public reloadCount = 0;

  constructor(records: AgentRecord[]) {
    for (const r of records) this.agents.set(r.agent.name, r);
  }

  async load(agentsDir: string): Promise<RegistryLoadResult> {
    return this.reload(agentsDir);
  }
  async reload(agentsDir: string): Promise<RegistryLoadResult> {
    this.reloadCount++;
    for (const [name, record] of this.agents) {
      const file = path.join(agentsDir, `${name}.md`);
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf-8');
        const m = content.match(/^version:\s*(.+)$/m);
        if (m) record.agent = { ...record.agent, version: m[1].trim() };
      }
    }
    return { loaded: this.agents.size, rejected: 0, errors: [], duration_ms: 0 };
  }
  list(): AgentRecord[] {
    return [...this.agents.values()];
  }
  get(name: string): AgentRecord | undefined {
    return this.agents.get(name);
  }
  getForTask(_t: string, _d?: string): RankedAgent[] {
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
  shadow(name: string): void {
    const r = this.agents.get(name);
    if (r) r.state = 'SHADOWED';
  }
  unshadow(name: string): void {
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
  transition(name: string, state: AgentState): void {
    const r = this.agents.get(name);
    if (r) r.state = state;
  }
}

// ---------------------------------------------------------------------------
// Faked metrics engine (degraded aggregate) — mirrors analyzer.test.ts
// ---------------------------------------------------------------------------

function makeAggregate(overrides?: Partial<AggregateMetrics>): AggregateMetrics {
  return {
    agent_name: 'code-executor',
    window_days: 30,
    invocation_count: 25,
    approval_rate: 0.8,
    avg_quality_score: 3.6,
    median_quality_score: 3.7,
    stddev_quality_score: 0.5,
    avg_review_iterations: 1.2,
    avg_wall_clock_ms: 5000,
    avg_turns: 8,
    total_tokens: 120000,
    trend: { direction: 'declining', slope: -0.05, confidence: 0.7, sample_size: 25, low_confidence: false },
    domain_breakdown: {
      typescript: { invocation_count: 15, approval_rate: 0.9, avg_quality_score: 4.1 },
      python: { invocation_count: 10, approval_rate: 0.6, avg_quality_score: 2.8 },
    },
    ...overrides,
  };
}

function makeInvocation(overrides?: Partial<InvocationMetric>): InvocationMetric {
  return {
    invocation_id: 'inv-1',
    agent_name: 'code-executor',
    agent_version: '1.0.0',
    pipeline_run_id: null,
    input_hash: 'deadbeef',
    input_domain: 'python',
    input_tokens: 1000,
    output_hash: 'cafebabe',
    output_tokens: 2000,
    output_quality_score: 2.8,
    quality_dimensions: [
      { dimension: 'correctness', score: 4.2, weight: 0.4 },
      { dimension: 'coverage', score: 2.5, weight: 0.3 },
    ],
    review_iteration_count: 1,
    review_outcome: 'approved',
    reviewer_agent: 'code-reviewer',
    wall_clock_ms: 5000,
    turn_count: 8,
    tool_calls: [],
    timestamp: '2026-04-08T10:00:00.000Z',
    environment: 'production',
    ...overrides,
  };
}

class FakeMetricsEngine implements IMetricsEngine {
  constructor(
    private aggregate: AggregateMetrics | null,
    private invocations: InvocationMetric[] = [],
    private alerts: AlertRecord[] = [],
  ) {}
  record(_m: InvocationMetric): void {}
  getInvocations(_a: string, opts?: QueryOptions): InvocationMetric[] {
    const limit = opts?.limit;
    return limit !== undefined ? this.invocations.slice(0, limit) : [...this.invocations];
  }
  getAggregate(_a: string): AggregateMetrics | null {
    return this.aggregate;
  }
  getAlerts(_o?: AlertQueryOptions): AlertRecord[] {
    return [...this.alerts];
  }
  evaluateAnomalies(_a: string): AlertRecord[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mock runtimes (mirror MockRuntime in analyzer.test.ts / meta-reviewer.test.ts)
// ---------------------------------------------------------------------------

class MockRuntime {
  public lastInput = '';
  public invokeCount = 0;
  constructor(private output: string, private success = true) {}
  async invoke(input: string, _ctx: RuntimeContext): Promise<RuntimeResult> {
    this.lastInput = input;
    this.invokeCount++;
    return {
      success: this.success,
      output: this.output,
      toolCallsBlocked: 0,
      toolCallsAllowed: 0,
      duration_ms: 10,
    };
  }
}

class MockLLM implements LLMInvoker {
  constructor(private response: string) {}
  async invoke(_prompt: string, _model: string): Promise<string> {
    return '```markdown\n' + this.response + '\n```';
  }
}

// ---------------------------------------------------------------------------
// Analyst + meta-reviewer JSON response builders
// ---------------------------------------------------------------------------

function analystJson(body: {
  overall_assessment: 'healthy' | 'needs_improvement' | 'critical';
  recommendation: 'no_action' | 'propose_modification' | 'propose_specialist';
}): string {
  return JSON.stringify({
    overall_assessment: body.overall_assessment,
    weaknesses:
      body.recommendation === 'no_action'
        ? []
        : [
            {
              dimension: 'coverage',
              severity: 'medium',
              evidence: 'Average test-coverage score is 2.8/5.0 in python.',
              affected_domains: ['python'],
              suggested_focus: 'Emphasize test generation for non-TypeScript domains',
            },
          ],
    strengths: ['correctness stable at 4.2'],
    recommendation: body.recommendation,
  });
}

const degradedModificationResponse = analystJson({
  overall_assessment: 'needs_improvement',
  recommendation: 'propose_modification',
});
const healthyResponse = analystJson({ overall_assessment: 'healthy', recommendation: 'no_action' });

function metaApprovedJson(): string {
  return JSON.stringify({
    verdict: 'approved',
    findings: [],
    checklist_results: [1, 2, 3, 4, 5, 6].map((item) => ({ item, name: `Item ${item}`, passed: true })),
  });
}

function metaBlockedJson(): string {
  // verdict rejected with a blocker finding on item 4 (prompt-injection vector).
  return JSON.stringify({
    verdict: 'rejected',
    findings: [
      {
        checklist_item: 4,
        severity: 'blocker',
        description: 'New prompt text is manipulable by adversarial input',
        evidence: 'system prompt now interpolates untrusted task text verbatim',
      },
    ],
    checklist_results: [1, 2, 3, 4, 5, 6].map((item) => ({
      item,
      name: `Item ${item}`,
      passed: item !== 4,
    })),
  });
}

function makeConfig(): AgentFactoryConfig {
  return { observation: { defaultThreshold: 10, perAgentOverrides: {} } } as unknown as AgentFactoryConfig;
}

// ---------------------------------------------------------------------------
// Harness: a fully-wired improvement subsystem over a temp git project.
// ---------------------------------------------------------------------------

interface Harness {
  ctx: {
    performanceAnalyzer: PerformanceAnalyzer;
    proposalGenerator: ProposalGenerator;
    proposalStore: ProposalStore;
    auditLogger: AuditLogger;
    invokeMetaReview: (p: AgentProposal) => Promise<MetaReviewResult>;
  };
  registry: DiskBackedRegistry;
  proposalStore: ProposalStore;
  promoter: Promoter;
  reportStore: WeaknessReportStore;
  auditLogger: AuditLogger;
  observationTracker: ObservationTracker;
  tmpDir: string;
  projectRoot: string;
  agentsDir: string;
  agentFilePath: string;
}

function createHarness(opts: {
  analystResponse: string;
  llmProposedMd: string;
  metaResponse: string;
  targetState?: AgentState;
}): Harness {
  const tmpDir = makeTempDir();
  const projectRoot = path.join(tmpDir, 'repo');
  const agentsDir = path.join(projectRoot, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  initGitRepo(projectRoot);

  const agentFilePath = path.join(agentsDir, 'code-executor.md');
  fs.writeFileSync(agentFilePath, agentMd('1.0.0'), 'utf-8');

  const registry = new DiskBackedRegistry([
    makeAgentRecord(baseAgent('1.0.0'), opts.targetState ?? 'ACTIVE', agentFilePath),
    makeAgentRecord(analystAgent(), 'ACTIVE', path.join(agentsDir, 'performance-analyst.md')),
    makeAgentRecord(metaReviewerAgent(), 'FROZEN', path.join(agentsDir, 'agent-meta-reviewer.md')),
  ]);

  const reportStore = new WeaknessReportStore(path.join(tmpDir, 'weakness-reports.jsonl'), silentLogger);
  const proposalStore = new ProposalStore(
    path.join(tmpDir, 'proposals.jsonl'),
    path.join(tmpDir, 'agent-metrics.db'),
    { warn: () => {} },
  );
  const auditLogger = new AuditLogger(path.join(tmpDir, 'data', 'agent-audit.log'));
  const observationTracker = new ObservationTracker({
    config: makeConfig(),
    statePath: path.join(tmpDir, 'observation-state.json'),
    logger: silentLogger,
  });

  const analystRuntime = new MockRuntime(opts.analystResponse);
  const metaRuntime = new MockRuntime(opts.metaResponse);

  const performanceAnalyzer = new PerformanceAnalyzer({
    registry,
    metricsEngine: new FakeMetricsEngine(makeAggregate(), [makeInvocation()], []),
    observationTracker,
    auditLogger,
    reportStore,
    domainGapsPath: path.join(tmpDir, 'domain-gaps.jsonl'),
    logger: silentLogger,
    createRuntime: () => analystRuntime as never,
  });

  const proposalGenerator = new ProposalGenerator(
    registry,
    new MockLLM(opts.llmProposedMd),
    auditLogger,
    { agentsDir },
  );

  // The REAL meta-review gate — drives the agent-meta-reviewer 6-point
  // checklist via a mocked runtime. This is the existing mechanism, not an
  // invented one.
  const metaOrchestrator = new MetaReviewOrchestrator({
    registry,
    auditLogger,
    logger: silentLogger,
    createRuntime: () => metaRuntime as never,
  });
  const invokeMetaReview = (p: AgentProposal) => metaOrchestrator.review(p);

  const promoter = new Promoter({
    registry,
    proposalStore,
    auditLogger,
    observationTracker,
    agentsDir,
    projectRoot,
    loadWeaknessReport: (id) => reportStore.getById(id),
  });

  return {
    ctx: { performanceAnalyzer, proposalGenerator, proposalStore, auditLogger, invokeMetaReview },
    registry,
    proposalStore,
    promoter,
    reportStore,
    auditLogger,
    observationTracker,
    tmpDir,
    projectRoot,
    agentsDir,
    agentFilePath,
  };
}

function teardown(h: Harness): void {
  h.auditLogger.close();
  h.proposalStore.close();
  h.reportStore.close();
  cleanupDir(h.tmpDir);
}

// ---------------------------------------------------------------------------
// 1) Happy path: degraded agent -> improve -> parked at human gate, NOT promoted
// ---------------------------------------------------------------------------

async function test_improve_happy_path_parks_without_promoting(): Promise<void> {
  const h = createHarness({
    analystResponse: degradedModificationResponse,
    llmProposedMd: proposedAgentMd_valid(),
    metaResponse: metaApprovedJson(),
  });
  try {
    const headBefore = gitHead(h.projectRoot);
    const originalOnDisk = fs.readFileSync(h.agentFilePath, 'utf-8');

    const out = await commandImprove(h.registry, 'code-executor', h.ctx);

    // Surfaces both gates + park status + diff + EXACT next-step commands.
    assert(out.includes('Both gates PASSED'), `should report both gates passed:\n${out}`);
    assert(out.includes('meta_approved'), 'should report the parked status');
    assert(out.includes('Unified diff:'), 'should include the unified diff section');
    assert(out.includes('version_history') || out.includes('comprehensive test coverage') || out.includes('@@'),
      'diff body should be present');
    assert(out.includes('agent accept'), 'should include the accept next-step command');
    assert(out.includes('agent reject'), 'should include the reject next-step command');

    // A proposal was created and parked at meta_approved (promotable via the
    // separate human gate — NOT terminal).
    const proposals = h.proposalStore.getByAgent('code-executor');
    assert(proposals.length === 1, `expected exactly 1 proposal, got ${proposals.length}`);
    assert(proposals[0].status === 'meta_approved', `expected meta_approved, got ${proposals[0].status}`);
    assert(out.includes(proposals[0].proposal_id), 'next-step commands name the proposal id');

    // SAFETY: the agent file on disk is UNCHANGED and NO git commit was made.
    assert(fs.readFileSync(h.agentFilePath, 'utf-8') === originalOnDisk, 'agent .md must be unchanged by improve');
    assert(gitHead(h.projectRoot) === headBefore, 'improve must NOT create a git commit');

    // The agent is parked UNDER_REVIEW (analyzer transition) awaiting the human.
    assert(h.registry.getState('code-executor') === 'UNDER_REVIEW', 'agent should be UNDER_REVIEW');
    console.log('PASS: test_improve_happy_path_parks_without_promoting');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// 2) recommendation=no_action -> no proposal created
// ---------------------------------------------------------------------------

async function test_improve_no_action_creates_no_proposal(): Promise<void> {
  const h = createHarness({
    analystResponse: healthyResponse,
    llmProposedMd: proposedAgentMd_valid(),
    metaResponse: metaApprovedJson(),
  });
  try {
    const out = await commandImprove(h.registry, 'code-executor', h.ctx);

    assert(out.includes('no_action') || out.includes('healthy'), `should report no_action:\n${out}`);
    assert(out.includes('Nothing parked'), 'should state nothing was parked');
    assert(h.proposalStore.getByAgent('code-executor').length === 0, 'no proposal should be created');
    // Healthy path leaves the agent ACTIVE (analyzer does not move to UNDER_REVIEW).
    assert(h.registry.getState('code-executor') === 'ACTIVE', 'agent stays ACTIVE on no_action');
    console.log('PASS: test_improve_no_action_creates_no_proposal');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// 3) enforceConstraints rejection (tool escalation) -> not parked, surfaced
// ---------------------------------------------------------------------------

async function test_improve_constraint_violation_not_parked(): Promise<void> {
  const h = createHarness({
    analystResponse: degradedModificationResponse,
    llmProposedMd: proposedAgentMd_toolEscalation(),
    metaResponse: metaApprovedJson(), // irrelevant: must never reach meta-review
  });
  try {
    const out = await commandImprove(h.registry, 'code-executor', h.ctx);

    assert(out.includes('BLOCKED by constraint enforcement'), `should report constraint block:\n${out}`);
    assert(out.includes('NOT parked'), 'should state the proposal was not parked');
    assert(out.includes('IMMUTABLE_TOOLS'), 'should surface the specific constraint rule');
    // No proposal persisted at all (constraint gate rejects before append).
    assert(h.proposalStore.getByAgent('code-executor').length === 0, 'no proposal should be persisted');
    console.log('PASS: test_improve_constraint_violation_not_parked');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// 4) ADVERSARIAL: meta-reviewer BLOCKs -> meta_rejected, NOT promotable, no file change
// ---------------------------------------------------------------------------

async function test_improve_meta_blocked_is_not_promotable(): Promise<void> {
  const h = createHarness({
    analystResponse: degradedModificationResponse,
    llmProposedMd: proposedAgentMd_valid(), // passes constraints; meta-review BLOCKs it
    metaResponse: metaBlockedJson(),
  });
  try {
    const headBefore = gitHead(h.projectRoot);
    const originalOnDisk = fs.readFileSync(h.agentFilePath, 'utf-8');

    const out = await commandImprove(h.registry, 'code-executor', h.ctx);

    assert(out.includes('BLOCKED by meta-review'), `should report meta-review block:\n${out}`);
    assert(out.includes('meta_rejected'), 'should report meta_rejected status');
    assert(out.includes('checklist 4'), 'should surface the blocking finding');

    const proposals = h.proposalStore.getByAgent('code-executor');
    assert(proposals.length === 1, 'a proposal record exists (rejected)');
    const blocked = proposals[0];
    assert(blocked.status === 'meta_rejected', `expected meta_rejected, got ${blocked.status}`);

    // SAFETY: nothing on disk changed, no commit made.
    assert(fs.readFileSync(h.agentFilePath, 'utf-8') === originalOnDisk, 'agent .md unchanged on meta block');
    assert(gitHead(h.projectRoot) === headBefore, 'no commit on meta block');

    // KEY REGRESSION: a blocked proposal is NOT promotable. The Promoter must
    // refuse it (meta_rejected is a terminal, non-promotable state) and make
    // no file/commit change.
    const promoteResult = await h.promoter.promote('code-executor', blocked.proposal_id);
    assert(promoteResult.success === false, 'blocked proposal must NOT promote');
    assert(fs.readFileSync(h.agentFilePath, 'utf-8') === originalOnDisk, 'agent .md still unchanged after refused promote');
    assert(gitHead(h.projectRoot) === headBefore, 'still no commit after refused promote');
    assert(h.proposalStore.getById(blocked.proposal_id)!.status === 'meta_rejected', 'status remains meta_rejected');
    console.log('PASS: test_improve_meta_blocked_is_not_promotable');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// 5) Approval path: after improve parks, the existing promote path promotes it
// ---------------------------------------------------------------------------

async function test_improve_then_human_promote_succeeds(): Promise<void> {
  const h = createHarness({
    analystResponse: degradedModificationResponse,
    llmProposedMd: proposedAgentMd_valid(),
    metaResponse: metaApprovedJson(),
  });
  try {
    // Park the proposal at the human gate.
    await commandImprove(h.registry, 'code-executor', h.ctx);
    const parked = h.proposalStore.getByAgent('code-executor')[0];
    assert(parked.status === 'meta_approved', 'precondition: parked at meta_approved');
    assert(h.registry.getState('code-executor') === 'UNDER_REVIEW', 'precondition: UNDER_REVIEW');

    const headBefore = gitHead(h.projectRoot);
    // The promoted version is whatever the version-classifier assigned to the
    // proposal — assert against that, not a hardcoded string.
    const expectedVersion = parked.proposed_version;

    // The SEPARATE human gate: the existing Promoter promotes the parked proposal.
    const result = await h.promoter.promote('code-executor', parked.proposal_id);

    assert(result.success === true, `human-approved promotion should succeed, got error: ${result.error}`);
    assert(result.newVersion === expectedVersion, `expected v${expectedVersion}, got ${result.newVersion}`);

    // Now (and only now) the file is updated and a commit was made. The
    // Promoter writes the proposal's proposed_definition verbatim.
    const onDisk = fs.readFileSync(h.agentFilePath, 'utf-8');
    assert(onDisk === parked.proposed_definition, 'agent .md should equal the proposed definition');
    assert(onDisk.includes('comprehensive test coverage'), 'agent .md should contain the proposed body');
    assert(gitHead(h.projectRoot) !== headBefore, 'a commit should be made by the human-approved promotion');

    assert(h.proposalStore.getById(parked.proposal_id)!.status === 'promoted', 'proposal should reach promoted');
    assert(h.registry.getState('code-executor') === 'ACTIVE', 'agent should end ACTIVE');
    console.log('PASS: test_improve_then_human_promote_succeeds');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// 6) Guard: FROZEN agent cannot be improved
// ---------------------------------------------------------------------------

async function test_improve_frozen_guard(): Promise<void> {
  const h = createHarness({
    analystResponse: degradedModificationResponse,
    llmProposedMd: proposedAgentMd_valid(),
    metaResponse: metaApprovedJson(),
    targetState: 'FROZEN',
  });
  try {
    const out = await commandImprove(h.registry, 'code-executor', h.ctx);
    assert(out.startsWith('Error:'), `expected an error, got:\n${out}`);
    assert(out.includes('FROZEN'), 'error should mention FROZEN');
    assert(h.proposalStore.getByAgent('code-executor').length === 0, 'no proposal for a frozen agent');
    console.log('PASS: test_improve_frozen_guard');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// 7) Guard: missing dependencies returns a clear error (no throw)
// ---------------------------------------------------------------------------

async function test_improve_missing_deps_guard(): Promise<void> {
  // Minimal registry, empty ctx — exercises the dependency guard.
  const tmpDir = makeTempDir();
  try {
    const agentFilePath = path.join(tmpDir, 'code-executor.md');
    fs.writeFileSync(agentFilePath, agentMd('1.0.0'), 'utf-8');
    const registry = new DiskBackedRegistry([
      makeAgentRecord(baseAgent('1.0.0'), 'ACTIVE', agentFilePath),
    ]);
    const out = await commandImprove(registry, 'code-executor', {});
    assert(out.startsWith('Error:'), `expected an error, got:\n${out}`);
    assert(out.includes('Improvement subsystem not available'), 'should report the subsystem guard');
    console.log('PASS: test_improve_missing_deps_guard');
  } finally {
    cleanupDir(tmpDir);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('agent improve (human-gated self-improvement, #529)', () => {
  it('happy path: parks at human gate without promoting', async () => await test_improve_happy_path_parks_without_promoting());
  it('no_action: creates no proposal', async () => await test_improve_no_action_creates_no_proposal());
  it('enforceConstraints rejection: not parked, surfaced', async () => await test_improve_constraint_violation_not_parked());
  it('adversarial: meta-review BLOCK -> meta_rejected, not promotable', async () => await test_improve_meta_blocked_is_not_promotable());
  it('approval path: existing promote promotes the parked proposal', async () => await test_improve_then_human_promote_succeeds());
  it('guard: FROZEN agent cannot be improved', async () => await test_improve_frozen_guard());
  it('guard: missing deps returns a clear error', async () => await test_improve_missing_deps_guard());
});
