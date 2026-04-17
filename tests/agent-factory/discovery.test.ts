import { discoverAgents, computeSimilarity } from '../../src/agent-factory/discovery';
import { AuditLogger } from '../../src/agent-factory/audit';
import { AgentRecord, ParsedAgent, AgentState } from '../../src/agent-factory/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Unit tests for agent discovery (SPEC-005-1-3, Task 5).
 */

// ---------------------------------------------------------------------------
// Helper: build an AgentRecord from overrides
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<ParsedAgent> & { name: string }): AgentRecord {
  const agent: ParsedAgent = {
    name: overrides.name,
    version: overrides.version ?? '1.0.0',
    role: overrides.role ?? 'executor',
    model: overrides.model ?? 'claude-sonnet-4-20250514',
    temperature: overrides.temperature ?? 0.3,
    turn_limit: overrides.turn_limit ?? 25,
    tools: overrides.tools ?? ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    expertise: overrides.expertise ?? [],
    evaluation_rubric: overrides.evaluation_rubric ?? [
      { name: 'correctness', weight: 1.0, description: 'Correct' },
    ],
    version_history: overrides.version_history ?? [
      { version: '1.0.0', date: '2026-01-01', change: 'Initial' },
    ],
    risk_tier: overrides.risk_tier ?? 'medium',
    frozen: overrides.frozen ?? false,
    description: overrides.description ?? 'A test agent',
    system_prompt: overrides.system_prompt ?? '# Test agent',
  };

  return {
    agent,
    state: 'ACTIVE' as AgentState,
    loadedAt: new Date(),
    diskHash: 'abc123',
    filePath: `/agents/${agent.name}.md`,
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Test: exact match single tag
// ---------------------------------------------------------------------------

function test_exact_match_single_tag(): void {
  const agents = [
    makeAgent({ name: 'ts-agent', expertise: ['typescript', 'nodejs'] }),
    makeAgent({ name: 'py-agent', expertise: ['python'] }),
  ];

  const results = discoverAgents('typescript', agents, { similarityThreshold: 0.0 });

  assert(results.length >= 1, 'Should return at least one result');
  assert(results[0].agent.agent.name === 'ts-agent', 'First result should be ts-agent');
  assert(results[0].matchType === 'exact', 'Match type should be exact');
  assert(results[0].score > 0, 'Score should be positive');

  console.log('PASS: test_exact_match_single_tag');
}

// ---------------------------------------------------------------------------
// Test: exact match multiple tags
// ---------------------------------------------------------------------------

function test_exact_match_multiple_tags(): void {
  const agents = [
    makeAgent({ name: 'full-match', expertise: ['typescript', 'testing'] }),
    makeAgent({ name: 'partial-match', expertise: ['typescript'] }),
  ];

  const results = discoverAgents('typescript testing', agents, { similarityThreshold: 0.0 });

  assert(results.length >= 2, 'Should return at least two results');
  assert(results[0].agent.agent.name === 'full-match', 'Full match should rank first');
  assert(results[0].score === 1.0, `Full match score should be 1.0, got ${results[0].score}`);
  assert(results[1].score === 0.5, `Partial match score should be 0.5, got ${results[1].score}`);

  console.log('PASS: test_exact_match_multiple_tags');
}

// ---------------------------------------------------------------------------
// Test: exact match case insensitive
// ---------------------------------------------------------------------------

function test_exact_match_case_insensitive(): void {
  const agents = [
    makeAgent({ name: 'ts-agent', expertise: ['typescript'] }),
  ];

  const results = discoverAgents('TypeScript', agents, { similarityThreshold: 0.0 });

  assert(results.length === 1, 'Should return one result');
  assert(results[0].agent.agent.name === 'ts-agent', 'Should match ts-agent');
  assert(results[0].matchType === 'exact', 'Match type should be exact');

  console.log('PASS: test_exact_match_case_insensitive');
}

// ---------------------------------------------------------------------------
// Test: semantic fallback no exact match
// ---------------------------------------------------------------------------

function test_semantic_fallback_no_exact_match(): void {
  const agents = [
    makeAgent({
      name: 'security-agent',
      expertise: ['security', 'penetration-testing', 'vulnerability-scanning'],
      description: 'Web application security testing and vulnerability assessment',
    }),
    makeAgent({
      name: 'ui-agent',
      expertise: ['react', 'css', 'html'],
      description: 'Frontend UI component development',
    }),
  ];

  // Query that won't exactly match any expertise tag but is semantically close
  const results = discoverAgents(
    'web application security vulnerability assessment',
    agents,
    { similarityThreshold: 0.1 },  // Low threshold to ensure semantic results
  );

  assert(results.length >= 1, 'Should return at least one semantic result');
  // The security agent should rank higher due to overlapping terms
  if (results.length >= 1) {
    assert(
      results[0].agent.agent.name === 'security-agent',
      `Security agent should rank first, got ${results[0].agent.agent.name}`,
    );
  }

  console.log('PASS: test_semantic_fallback_no_exact_match');
}

// ---------------------------------------------------------------------------
// Test: domain gap no match above threshold
// ---------------------------------------------------------------------------

function test_domain_gap_no_match_above_threshold(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-discovery-'));
  const logPath = path.join(tmpDir, 'test-audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agents = [
    makeAgent({
      name: 'ts-agent',
      expertise: ['typescript', 'nodejs'],
      description: 'TypeScript and Node.js development',
    }),
  ];

  const results = discoverAgents(
    'quantum computing entanglement simulation',
    agents,
    { similarityThreshold: 0.6 },
    auditLogger,
  );

  assert(results.length === 0, 'Should return empty array for domain gap');

  // Check audit log for domain_gap_detected event
  auditLogger.close();
  const logContent = fs.readFileSync(logPath, 'utf-8').trim();
  assert(logContent.length > 0, 'Audit log should contain an event');

  const event = JSON.parse(logContent);
  assert(event.event_type === 'domain_gap_detected', 'Event type should be domain_gap_detected');

  // Cleanup
  fs.unlinkSync(logPath);
  fs.rmdirSync(tmpDir);

  console.log('PASS: test_domain_gap_no_match_above_threshold');
}

// ---------------------------------------------------------------------------
// Test: max results limit
// ---------------------------------------------------------------------------

function test_max_results_limit(): void {
  const agents: AgentRecord[] = [];
  for (let i = 0; i < 10; i++) {
    agents.push(makeAgent({
      name: `agent-${i}`,
      expertise: ['typescript'],
    }));
  }

  const results = discoverAgents('typescript', agents, {
    maxResults: 3,
    similarityThreshold: 0.0,
  });

  assert(results.length === 3, `Should return exactly 3 results, got ${results.length}`);

  console.log('PASS: test_max_results_limit');
}

// ---------------------------------------------------------------------------
// Test: similarity threshold respected
// ---------------------------------------------------------------------------

function test_similarity_threshold_respected(): void {
  // Create agents with varying relevance
  const agents = [
    makeAgent({
      name: 'relevant-agent',
      expertise: ['typescript', 'testing', 'nodejs', 'javascript'],
      description: 'TypeScript testing framework for Node.js JavaScript applications',
    }),
    makeAgent({
      name: 'irrelevant-agent',
      expertise: ['cooking', 'recipes'],
      description: 'Cooking recipes and meal preparation',
    }),
  ];

  const results = discoverAgents(
    'typescript testing nodejs javascript',
    agents,
    { similarityThreshold: 0.3 },
  );

  // The relevant agent should be included, irrelevant should not
  const names = results.map((r) => r.agent.agent.name);
  assert(names.includes('relevant-agent'), 'Relevant agent should be included');
  assert(!names.includes('irrelevant-agent'), 'Irrelevant agent should not be included');

  console.log('PASS: test_similarity_threshold_respected');
}

// ---------------------------------------------------------------------------
// Test: only active agents considered
// ---------------------------------------------------------------------------

function test_only_active_agents(): void {
  const activeAgent = makeAgent({ name: 'active-agent', expertise: ['typescript'] });
  const frozenAgent = makeAgent({ name: 'frozen-agent', expertise: ['typescript'] });
  frozenAgent.state = 'FROZEN';

  const results = discoverAgents('typescript', [activeAgent, frozenAgent], {
    similarityThreshold: 0.0,
  });

  assert(results.length === 1, `Should return one result, got ${results.length}`);
  assert(results[0].agent.agent.name === 'active-agent', 'Should only return active agent');

  console.log('PASS: test_only_active_agents');
}

// ---------------------------------------------------------------------------
// Test: computeSimilarity
// ---------------------------------------------------------------------------

function test_compute_similarity_identical(): void {
  const score = computeSimilarity('typescript testing', 'typescript testing');
  assert(score > 0.9, `Identical texts should have high similarity, got ${score}`);

  console.log('PASS: test_compute_similarity_identical');
}

function test_compute_similarity_different(): void {
  const score = computeSimilarity('typescript testing', 'cooking recipes gardening');
  assert(score < 0.3, `Different texts should have low similarity, got ${score}`);

  console.log('PASS: test_compute_similarity_different');
}

function test_compute_similarity_empty(): void {
  const score = computeSimilarity('', '');
  assert(score === 0, `Empty texts should have zero similarity, got ${score}`);

  console.log('PASS: test_compute_similarity_empty');
}

// ---------------------------------------------------------------------------
// Test: matched tags included in result
// ---------------------------------------------------------------------------

function test_matched_tags_included(): void {
  const agents = [
    makeAgent({ name: 'ts-agent', expertise: ['TypeScript', 'NodeJS'] }),
  ];

  const results = discoverAgents('typescript', agents, { similarityThreshold: 0.0 });

  assert(results.length === 1, 'Should return one result');
  assert(results[0].matchedTags !== undefined, 'matchedTags should be defined');
  assert(results[0].matchedTags!.includes('TypeScript'), 'matchedTags should include TypeScript');

  console.log('PASS: test_matched_tags_included');
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests = [
  test_exact_match_single_tag,
  test_exact_match_multiple_tags,
  test_exact_match_case_insensitive,
  test_semantic_fallback_no_exact_match,
  test_domain_gap_no_match_above_threshold,
  test_max_results_limit,
  test_similarity_threshold_respected,
  test_only_active_agents,
  test_compute_similarity_identical,
  test_compute_similarity_different,
  test_compute_similarity_empty,
  test_matched_tags_included,
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
