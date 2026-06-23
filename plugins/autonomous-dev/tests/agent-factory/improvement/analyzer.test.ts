/**
 * Unit tests for the PerformanceAnalyzer orchestration + decision logic
 * (SPEC-005-3-2, Tasks 3 and 4).
 *
 * Exercises the real PerformanceAnalyzer end-to-end against:
 *   - a faked IMetricsEngine (seeded aggregate / invocations / alerts),
 *   - a real WeaknessReportStore (JSONL primary; #527),
 *   - a real AuditLogger and a real ObservationTracker,
 *   - a mocked performance-analyst runtime injected via `createRuntime`
 *     (mirrors how meta-reviewer.test.ts injects a MockRuntime — no real
 *     model is invoked).
 *
 * Decision-routing is verified through the public `analyze()` result and via
 * the exported `decideNextAction` helper, covering healthy (no_action),
 * degraded + propose_modification (propose_modification), and
 * propose_specialist (log_domain_gap).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  PerformanceAnalyzer,
  decideNextAction,
  computeDimensionBreakdowns,
} from '../../../src/agent-factory/improvement/analyzer';
import { WeaknessReportStore } from '../../../src/agent-factory/improvement/types';
import type { WeaknessReport } from '../../../src/agent-factory/improvement/types';
import { AuditLogger } from '../../../src/agent-factory/audit';
import { ObservationTracker } from '../../../src/agent-factory/metrics/observation';
import type { AgentFactoryConfig } from '../../../src/agent-factory/config';
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

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-test-'));
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Agent fixtures
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
    version_history: [{ version: '1.0.0', date: '2026-01-01', change: 'Initial release' }],
    risk_tier: 'medium',
    frozen: false,
    description: 'Executes code changes based on specs',
    system_prompt: '# System Prompt\n\nYou are a code executor agent.',
  };
  return { ...base, ...overrides };
}

function analystAgent(): ParsedAgent {
  return baseAgent({
    name: 'performance-analyst',
    role: 'reviewer',
    tools: ['Read', 'Glob', 'Grep'],
    expertise: ['metrics-analysis'],
    description: 'Analyzes agent performance metrics',
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

// ---------------------------------------------------------------------------
// Mock registry (mirrors proposer.test.ts / meta-reviewer.test.ts)
// ---------------------------------------------------------------------------

class MockRegistry implements IAgentRegistry {
  private agents: Map<string, AgentRecord> = new Map();

  constructor(records?: AgentRecord[]) {
    if (records) {
      for (const r of records) this.agents.set(r.agent.name, r);
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
  isManaged(name: string): boolean {
    const r = this.agents.get(name);
    return r ? r.agent.managed !== false : true;
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
  transition(name: string, targetState: AgentState): void {
    const r = this.agents.get(name);
    if (r) r.state = targetState;
  }
}

// ---------------------------------------------------------------------------
// Fake metrics engine — seeded with a configurable aggregate + invocations.
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
    trend: {
      direction: 'declining',
      slope: -0.05,
      confidence: 0.7,
      sample_size: 25,
      low_confidence: false,
    },
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

interface FakeMetricsOptions {
  aggregate: AggregateMetrics | null;
  invocations?: InvocationMetric[];
  alerts?: AlertRecord[];
}

class FakeMetricsEngine implements IMetricsEngine {
  private aggregate: AggregateMetrics | null;
  private invocations: InvocationMetric[];
  private alerts: AlertRecord[];

  constructor(opts: FakeMetricsOptions) {
    this.aggregate = opts.aggregate;
    this.invocations = opts.invocations ?? [];
    this.alerts = opts.alerts ?? [];
  }

  record(_metric: InvocationMetric): void {
    /* not used by the analyzer */
  }
  getInvocations(_agentName: string, opts?: QueryOptions): InvocationMetric[] {
    const limit = opts?.limit;
    return limit !== undefined ? this.invocations.slice(0, limit) : [...this.invocations];
  }
  getAggregate(_agentName: string): AggregateMetrics | null {
    return this.aggregate;
  }
  getAlerts(_opts?: AlertQueryOptions): AlertRecord[] {
    return [...this.alerts];
  }
  evaluateAnomalies(_agentName: string): AlertRecord[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mock analyst runtime (mirrors MockRuntime in meta-reviewer.test.ts).
// The analyzer calls runtime.invoke(prompt, ctx) and parses the JSON output.
// ---------------------------------------------------------------------------

interface MockRuntimeOptions {
  output: string;
  success?: boolean;
}

class MockRuntime {
  public lastInput: string = '';
  public invokeCount = 0;
  private output: string;
  private success: boolean;

  constructor(opts: MockRuntimeOptions) {
    this.output = opts.output;
    this.success = opts.success ?? true;
  }

  async invoke(input: string, _context: RuntimeContext): Promise<RuntimeResult> {
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

// ---------------------------------------------------------------------------
// Analyst response builders (JSON the parser expects).
// ---------------------------------------------------------------------------

function analystJson(body: {
  overall_assessment: 'healthy' | 'needs_improvement' | 'critical';
  recommendation: 'no_action' | 'propose_modification' | 'propose_specialist';
  weaknesses?: WeaknessReport['weaknesses'];
  strengths?: string[];
}): string {
  return JSON.stringify({
    overall_assessment: body.overall_assessment,
    weaknesses: body.weaknesses ?? [],
    strengths: body.strengths ?? ['correctness stable at 4.2'],
    recommendation: body.recommendation,
  });
}

const degradedModificationResponse = analystJson({
  overall_assessment: 'needs_improvement',
  recommendation: 'propose_modification',
  weaknesses: [
    {
      dimension: 'coverage',
      severity: 'medium',
      evidence: 'Average test-coverage score is 2.8/5.0 in python.',
      affected_domains: ['python'],
      suggested_focus: 'Emphasize test generation for non-TypeScript domains',
    },
  ],
});

const healthyResponse = analystJson({
  overall_assessment: 'healthy',
  recommendation: 'no_action',
  weaknesses: [],
  strengths: ['correctness stable at 4.2', 'approval rate strong'],
});

const specialistResponse = analystJson({
  overall_assessment: 'needs_improvement',
  recommendation: 'propose_specialist',
  weaknesses: [
    {
      dimension: 'domain-knowledge',
      severity: 'high',
      evidence: 'python scores consistently below 3.0; outside core expertise.',
      affected_domains: ['python', 'rust'],
      suggested_focus: 'A python specialist agent is warranted',
    },
  ],
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  analyzer: PerformanceAnalyzer;
  registry: MockRegistry;
  reportStore: WeaknessReportStore;
  auditLogger: AuditLogger;
  observationTracker: ObservationTracker;
  runtime: MockRuntime;
  tmpDir: string;
}

function makeConfig(): AgentFactoryConfig {
  // Minimal config satisfying ObservationTracker's needs. Cast through unknown
  // so the test does not depend on unrelated config sections.
  return {
    observation: { defaultThreshold: 10, perAgentOverrides: {} },
  } as unknown as AgentFactoryConfig;
}

function createHarness(opts: {
  runtimeOutput: string;
  runtimeSuccess?: boolean;
  metrics: FakeMetricsOptions;
  includeAnalyst?: boolean;
  analystState?: AgentState;
  targetState?: AgentState;
}): Harness {
  const tmpDir = makeTempDir();

  const records: AgentRecord[] = [makeAgentRecord(baseAgent(), opts.targetState ?? 'ACTIVE')];
  if (opts.includeAnalyst !== false) {
    records.push(makeAgentRecord(analystAgent(), opts.analystState ?? 'ACTIVE'));
  }
  const registry = new MockRegistry(records);

  const reportStore = new WeaknessReportStore(
    path.join(tmpDir, 'weakness-reports.jsonl'),
    silentLogger,
  );
  const auditLogger = new AuditLogger(path.join(tmpDir, 'data', 'agent-audit.log'));
  const observationTracker = new ObservationTracker({
    config: makeConfig(),
    statePath: path.join(tmpDir, 'observation-state.json'),
    logger: silentLogger,
  });
  const runtime = new MockRuntime({ output: opts.runtimeOutput, success: opts.runtimeSuccess });

  const analyzer = new PerformanceAnalyzer({
    registry,
    metricsEngine: new FakeMetricsEngine(opts.metrics),
    observationTracker,
    auditLogger,
    reportStore,
    domainGapsPath: path.join(tmpDir, 'domain-gaps.jsonl'),
    logger: silentLogger,
    createRuntime: () => runtime as never,
  });

  return { analyzer, registry, reportStore, auditLogger, observationTracker, runtime, tmpDir };
}

function teardown(h: Harness): void {
  h.auditLogger.close();
  h.reportStore.close();
  cleanupDir(h.tmpDir);
}

// ---------------------------------------------------------------------------
// decideNextAction unit tests (pure function — no I/O)
// ---------------------------------------------------------------------------

function reportWith(
  overall: WeaknessReport['overall_assessment'],
  recommendation: WeaknessReport['recommendation'],
): WeaknessReport {
  return {
    report_id: 'r',
    agent_name: 'code-executor',
    agent_version: '1.0.0',
    analysis_date: '2026-04-08T10:00:00.000Z',
    overall_assessment: overall,
    weaknesses: [],
    strengths: [],
    recommendation,
    metrics_summary: {
      invocation_count: 0,
      approval_rate: 0,
      avg_quality_score: 0,
      trend_direction: 'stable',
      active_alerts: 0,
    },
  };
}

function test_decide_next_action_routing(): void {
  // healthy always -> no_action regardless of recommendation
  assert(decideNextAction(reportWith('healthy', 'no_action')) === 'no_action', 'healthy/no_action');
  assert(
    decideNextAction(reportWith('healthy', 'propose_modification')) === 'no_action',
    'healthy overrides modification',
  );
  assert(
    decideNextAction(reportWith('healthy', 'propose_specialist')) === 'no_action',
    'healthy overrides specialist',
  );

  // propose_specialist -> log_domain_gap (when not healthy)
  assert(
    decideNextAction(reportWith('needs_improvement', 'propose_specialist')) === 'log_domain_gap',
    'needs_improvement/specialist',
  );
  assert(
    decideNextAction(reportWith('critical', 'propose_specialist')) === 'log_domain_gap',
    'critical/specialist',
  );

  // propose_modification + (needs_improvement | critical) -> propose_modification
  assert(
    decideNextAction(reportWith('needs_improvement', 'propose_modification')) ===
      'propose_modification',
    'needs_improvement/modification',
  );
  assert(
    decideNextAction(reportWith('critical', 'propose_modification')) === 'propose_modification',
    'critical/modification',
  );

  // unexpected combo (not healthy but no_action recommendation) -> no_action default
  assert(
    decideNextAction(reportWith('needs_improvement', 'no_action')) === 'no_action',
    'needs_improvement/no_action default',
  );
  console.log('PASS: test_decide_next_action_routing');
}

function test_compute_dimension_breakdowns(): void {
  // Sanity-check the exported helper the analyzer relies on.
  const empty = computeDimensionBreakdowns([]);
  assert(empty.length === 0, 'empty invocations -> empty breakdown');

  const invs: InvocationMetric[] = [
    makeInvocation({
      input_domain: 'python',
      quality_dimensions: [{ dimension: 'coverage', score: 2.0, weight: 0.3 }],
    }),
    makeInvocation({
      input_domain: 'typescript',
      quality_dimensions: [{ dimension: 'coverage', score: 4.0, weight: 0.3 }],
    }),
  ];
  const breakdown = computeDimensionBreakdowns(invs);
  const coverage = breakdown.find((b) => b.dimension === 'coverage');
  assert(coverage !== undefined, 'coverage dimension computed');
  assert(
    Math.abs(coverage!.avg_score - 3.0) < 1e-9,
    `coverage avg should be 3.0, got ${coverage!.avg_score}`,
  );
  // python (2.0) is below the avg (3.0) -> a worst domain; typescript is not.
  assert(coverage!.worst_domains.includes('python'), 'python should be a worst domain');
  assert(
    !coverage!.worst_domains.includes('typescript'),
    'typescript should not be a worst domain',
  );
  console.log('PASS: test_compute_dimension_breakdowns');
}

// ---------------------------------------------------------------------------
// analyze() — degraded, propose_modification
// ---------------------------------------------------------------------------

async function test_analyze_degraded_proposes_modification(): Promise<void> {
  const h = createHarness({
    runtimeOutput: degradedModificationResponse,
    metrics: {
      aggregate: makeAggregate(),
      invocations: [makeInvocation()],
      alerts: [],
    },
  });
  try {
    const result = await h.analyzer.analyze('code-executor');

    assert(result.success === true, `expected success, got error: ${result.error}`);
    assert(
      result.nextAction === 'propose_modification',
      `expected propose_modification, got ${result.nextAction}`,
    );
    assert(result.report !== undefined, 'report should be present');

    // Well-formed WeaknessReport.
    const report = result.report!;
    assert(report.report_id.length > 0, 'report_id should be set');
    assert(report.agent_name === 'code-executor', 'agent_name matches target');
    assert(report.agent_version === '1.0.0', 'agent_version carried from registry record');
    assert(report.overall_assessment === 'needs_improvement', 'overall_assessment parsed');
    assert(report.recommendation === 'propose_modification', 'recommendation parsed');
    assert(report.weaknesses.length === 1, 'weakness parsed');
    assert(report.weaknesses[0].dimension === 'coverage', 'weakness dimension parsed');
    // metrics_summary is rebuilt from the (faked) aggregate.
    assert(
      report.metrics_summary.invocation_count === 25,
      'metrics_summary.invocation_count from aggregate',
    );
    assert(
      report.metrics_summary.trend_direction === 'declining',
      'metrics_summary.trend_direction from aggregate',
    );

    // Persisted to the real WeaknessReportStore (JSONL).
    const stored = h.reportStore.getReports('code-executor');
    assert(stored.length === 1, `expected 1 persisted report, got ${stored.length}`);
    assert(stored[0].report_id === report.report_id, 'persisted report id matches returned report');

    // Side effect: target transitioned to UNDER_REVIEW.
    assert(
      h.registry.getState('code-executor') === 'UNDER_REVIEW',
      'target should be UNDER_REVIEW',
    );

    // Runtime was actually invoked with a prompt mentioning the agent.
    assert(h.runtime.invokeCount === 1, 'analyst runtime should be invoked once');
    assert(h.runtime.lastInput.includes('code-executor'), 'prompt should name the agent');
    console.log('PASS: test_analyze_degraded_proposes_modification');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// analyze() — healthy, no_action
// ---------------------------------------------------------------------------

async function test_analyze_healthy_no_action(): Promise<void> {
  const h = createHarness({
    runtimeOutput: healthyResponse,
    metrics: {
      aggregate: makeAggregate({
        approval_rate: 0.97,
        avg_quality_score: 4.5,
        trend: {
          direction: 'improving',
          slope: 0.04,
          confidence: 0.8,
          sample_size: 30,
          low_confidence: false,
        },
      }),
      invocations: [makeInvocation({ output_quality_score: 4.6, input_domain: 'typescript' })],
      alerts: [],
    },
  });
  try {
    // Seed the observation tracker so we can assert it gets reset to 0.
    h.observationTracker.recordInvocation('code-executor', '1.0.0');
    h.observationTracker.recordInvocation('code-executor', '1.0.0');
    assert(
      h.observationTracker.getState('code-executor').invocations_since_promotion === 2,
      'precondition: counter at 2',
    );

    const result = await h.analyzer.analyze('code-executor');

    assert(result.success === true, `expected success, got error: ${result.error}`);
    assert(result.nextAction === 'no_action', `expected no_action, got ${result.nextAction}`);
    assert(result.report!.overall_assessment === 'healthy', 'assessment healthy');

    // Persisted even when healthy.
    assert(
      h.reportStore.getReports('code-executor').length === 1,
      'healthy report still persisted',
    );

    // Side effect: observation counter reset to 0; state unchanged (ACTIVE).
    assert(
      h.observationTracker.getState('code-executor').invocations_since_promotion === 0,
      'observation counter should reset on no_action',
    );
    assert(h.registry.getState('code-executor') === 'ACTIVE', 'state stays ACTIVE on no_action');
    console.log('PASS: test_analyze_healthy_no_action');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// analyze() — propose_specialist, log_domain_gap
// ---------------------------------------------------------------------------

async function test_analyze_specialist_logs_domain_gap(): Promise<void> {
  const domainGapsPath = path.join(makeTempDir(), 'domain-gaps.jsonl');
  const h = createHarness({
    runtimeOutput: specialistResponse,
    metrics: {
      aggregate: makeAggregate(),
      invocations: [makeInvocation()],
      alerts: [],
    },
  });
  // Override domain-gaps path to a deterministic location we can read.
  // (createHarness already routes domain gaps into its tmpDir; reuse that.)
  try {
    const result = await h.analyzer.analyze('code-executor');

    assert(result.success === true, `expected success, got error: ${result.error}`);
    assert(
      result.nextAction === 'log_domain_gap',
      `expected log_domain_gap, got ${result.nextAction}`,
    );

    // The domain-gaps JSONL inside the harness tmpDir should have one entry.
    const gapsFile = path.join(h.tmpDir, 'domain-gaps.jsonl');
    assert(fs.existsSync(gapsFile), 'domain-gaps.jsonl should be written');
    const lines = fs
      .readFileSync(gapsFile, 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    assert(lines.length === 1, `expected 1 domain-gap line, got ${lines.length}`);
    const gap = JSON.parse(lines[0]);
    assert(gap.source_agent === 'code-executor', 'domain gap source_agent');
    assert(gap.status === 'specialist_recommended', 'domain gap status');
    assert(
      typeof gap.task_domain === 'string' && gap.task_domain.includes('python'),
      'domain gap names affected domain',
    );

    // State is NOT moved to UNDER_REVIEW for a specialist recommendation.
    assert(
      h.registry.getState('code-executor') === 'ACTIVE',
      'state stays ACTIVE on specialist path',
    );
    // Report still persisted.
    assert(h.reportStore.getReports('code-executor').length === 1, 'specialist report persisted');
    console.log('PASS: test_analyze_specialist_logs_domain_gap');
  } finally {
    cleanupDir(path.dirname(domainGapsPath));
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// analyze() — error / edge paths (never throws; returns success:false)
// ---------------------------------------------------------------------------

async function test_analyze_target_not_found(): Promise<void> {
  const h = createHarness({
    runtimeOutput: healthyResponse,
    metrics: { aggregate: makeAggregate() },
  });
  try {
    const result = await h.analyzer.analyze('no-such-agent');
    assert(result.success === false, 'expected failure for missing target');
    assert(result.nextAction === 'error', `expected error action, got ${result.nextAction}`);
    assert(
      (result.error ?? '').includes('not found'),
      `error should mention not found: ${result.error}`,
    );
    assert(h.reportStore.getReports().length === 0, 'no report persisted on error');
    console.log('PASS: test_analyze_target_not_found');
  } finally {
    teardown(h);
  }
}

async function test_analyze_analyst_missing(): Promise<void> {
  const h = createHarness({
    runtimeOutput: healthyResponse,
    metrics: { aggregate: makeAggregate() },
    includeAnalyst: false,
  });
  try {
    const result = await h.analyzer.analyze('code-executor');
    assert(result.success === false, 'expected failure when performance-analyst absent');
    assert(
      (result.error ?? '').includes('performance-analyst'),
      `error should mention analyst: ${result.error}`,
    );
    console.log('PASS: test_analyze_analyst_missing');
  } finally {
    teardown(h);
  }
}

async function test_analyze_no_aggregate(): Promise<void> {
  const h = createHarness({
    runtimeOutput: healthyResponse,
    metrics: { aggregate: null },
  });
  try {
    const result = await h.analyzer.analyze('code-executor');
    assert(result.success === false, 'expected failure when no aggregate metrics');
    assert(
      (result.error ?? '').includes('No aggregate metrics'),
      `error should mention aggregate: ${result.error}`,
    );
    // Analyst should not have been invoked (we bail before formatting a prompt).
    assert(h.runtime.invokeCount === 0, 'analyst should not be invoked without aggregate');
    console.log('PASS: test_analyze_no_aggregate');
  } finally {
    teardown(h);
  }
}

async function test_analyze_unparseable_output(): Promise<void> {
  const h = createHarness({
    runtimeOutput: 'I could not produce structured output.',
    metrics: { aggregate: makeAggregate(), invocations: [makeInvocation()] },
  });
  try {
    const result = await h.analyzer.analyze('code-executor');
    assert(result.success === false, 'expected failure on unparseable analyst output');
    assert(
      (result.error ?? '').toLowerCase().includes('parse'),
      `error should mention parse: ${result.error}`,
    );
    assert(h.reportStore.getReports().length === 0, 'no report persisted when parse fails');
    console.log('PASS: test_analyze_unparseable_output');
  } finally {
    teardown(h);
  }
}

async function test_analyze_runtime_failure(): Promise<void> {
  const h = createHarness({
    runtimeOutput: healthyResponse,
    runtimeSuccess: false,
    metrics: { aggregate: makeAggregate(), invocations: [makeInvocation()] },
  });
  try {
    const result = await h.analyzer.analyze('code-executor');
    assert(result.success === false, 'expected failure when runtime invocation fails');
    assert(
      (result.error ?? '').includes('invocation failed'),
      `error should mention invocation failure: ${result.error}`,
    );
    console.log('PASS: test_analyze_runtime_failure');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('performance analyzer', () => {
  it('test_decide_next_action_routing', test_decide_next_action_routing);
  it('test_compute_dimension_breakdowns', test_compute_dimension_breakdowns);
  it('test_analyze_degraded_proposes_modification', async () =>
    await test_analyze_degraded_proposes_modification());
  it('test_analyze_healthy_no_action', async () => await test_analyze_healthy_no_action());
  it('test_analyze_specialist_logs_domain_gap', async () =>
    await test_analyze_specialist_logs_domain_gap());
  it('test_analyze_target_not_found', async () => await test_analyze_target_not_found());
  it('test_analyze_analyst_missing', async () => await test_analyze_analyst_missing());
  it('test_analyze_no_aggregate', async () => await test_analyze_no_aggregate());
  it('test_analyze_unparseable_output', async () => await test_analyze_unparseable_output());
  it('test_analyze_runtime_failure', async () => await test_analyze_runtime_failure());
});
