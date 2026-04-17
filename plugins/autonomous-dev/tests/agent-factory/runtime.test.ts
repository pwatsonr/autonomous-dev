import { AgentRuntime, ToolAccessEnforcer, PathFilter } from '../../src/agent-factory/runtime';
import { AuditLogger } from '../../src/agent-factory/audit';
import { AgentRecord, ParsedAgent, AgentState } from '../../src/agent-factory/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Unit tests for agent runtime (SPEC-005-1-3, Tasks 6 and 7).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-test-'));
}

function makeAgent(overrides?: Partial<ParsedAgent>): AgentRecord {
  const agent: ParsedAgent = {
    name: overrides?.name ?? 'test-executor',
    version: '1.0.0',
    role: overrides?.role ?? 'executor',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.3,
    turn_limit: 25,
    tools: overrides?.tools ?? ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    expertise: overrides?.expertise ?? ['TypeScript'],
    evaluation_rubric: [
      { name: 'correctness', weight: 1.0, description: 'Correct' },
    ],
    version_history: [
      { version: '1.0.0', date: '2026-01-01', change: 'Initial' },
    ],
    risk_tier: 'medium',
    frozen: false,
    description: overrides?.description ?? 'Test executor agent',
    system_prompt: '# Test',
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

function cleanup(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// ToolAccessEnforcer Tests
// ---------------------------------------------------------------------------

function test_authorized_tool_allowed(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent({ tools: ['Read', 'Glob'] });
  const enforcer = new ToolAccessEnforcer(auditLogger);

  const result = enforcer.execute({
    agent: agent.agent,
    toolName: 'Read',
    toolArgs: {},
    workingDirectory: '/project',
  });

  assert(result.allowed === true, 'Authorized tool should be allowed');
  auditLogger.close();
  cleanup(tmpDir);

  console.log('PASS: test_authorized_tool_allowed');
}

function test_unauthorized_tool_blocked(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent({ tools: ['Read', 'Glob'] });
  const enforcer = new ToolAccessEnforcer(auditLogger);

  const result = enforcer.execute({
    agent: agent.agent,
    toolName: 'Bash',
    toolArgs: {},
    workingDirectory: '/project',
  });

  assert(result.allowed === false, 'Unauthorized tool should be blocked');
  assert(result.reason === 'Tool not authorized', 'Reason should be "Tool not authorized"');

  // Check audit log
  auditLogger.close();
  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const event = JSON.parse(content);
  assert(event.event_type === 'tool_call_blocked', 'Audit event should be tool_call_blocked');
  assert(event.agent_name === agent.agent.name, 'Audit event should have agent name');
  assert(event.details.tool === 'Bash', 'Audit event should log the blocked tool');

  cleanup(tmpDir);
  console.log('PASS: test_unauthorized_tool_blocked');
}

function test_reviewer_cannot_edit(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent({
    name: 'test-reviewer',
    role: 'reviewer',
    tools: ['Read', 'Glob', 'Grep'],
  });
  const enforcer = new ToolAccessEnforcer(auditLogger);

  const result = enforcer.execute({
    agent: agent.agent,
    toolName: 'Edit',
    toolArgs: {},
    workingDirectory: '/project',
  });

  assert(result.allowed === false, 'Reviewer should not be able to Edit');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_reviewer_cannot_edit');
}

function test_executor_can_edit(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent({
    role: 'executor',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
  });
  const enforcer = new ToolAccessEnforcer(auditLogger);

  const result = enforcer.execute({
    agent: agent.agent,
    toolName: 'Edit',
    toolArgs: {},
    workingDirectory: '/project',
  });

  assert(result.allowed === true, 'Executor should be able to Edit');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_executor_can_edit');
}

// ---------------------------------------------------------------------------
// PathFilter Tests
// ---------------------------------------------------------------------------

function test_block_agents_directory(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent();
  const filter = new PathFilter(auditLogger);

  const result = filter.execute({
    agent: agent.agent,
    toolName: 'Edit',
    toolArgs: { file_path: '/project/agents/prd-author.md' },
    workingDirectory: '/project',
  });

  assert(result.allowed === false, 'Access to agents/ should be blocked');
  assert(result.reason!.includes('protected path'), 'Reason should mention protected path');

  // Check audit log
  auditLogger.close();
  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const event = JSON.parse(content);
  assert(event.event_type === 'path_access_blocked', 'Audit event should be path_access_blocked');
  assert(event.details.normalizedPath !== undefined, 'Should include normalized path');

  cleanup(tmpDir);
  console.log('PASS: test_block_agents_directory');
}

function test_block_agent_data_files(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent();
  const filter = new PathFilter(auditLogger);

  const result = filter.execute({
    agent: agent.agent,
    toolName: 'Write',
    toolArgs: { file_path: '/project/data/agent-metrics.db' },
    workingDirectory: '/project',
  });

  assert(result.allowed === false, 'Access to data/agent-* should be blocked');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_block_agent_data_files');
}

function test_block_metrics_directory(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent();
  const filter = new PathFilter(auditLogger);

  const result = filter.execute({
    agent: agent.agent,
    toolName: 'Bash',
    toolArgs: { command: 'cat /project/data/metrics/agent-invocations.jsonl' },
    workingDirectory: '/project',
  });

  assert(result.allowed === false, 'Access to data/metrics/ should be blocked');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_block_metrics_directory');
}

function test_allow_src_directory(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent();
  const filter = new PathFilter(auditLogger);

  const result = filter.execute({
    agent: agent.agent,
    toolName: 'Edit',
    toolArgs: { file_path: '/project/src/foo.ts' },
    workingDirectory: '/project',
  });

  assert(result.allowed === true, 'Access to src/ should be allowed');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_allow_src_directory');
}

function test_block_path_traversal(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent();
  const filter = new PathFilter(auditLogger);

  // From src/ directory, trying to access ../agents/prd-author.md
  const result = filter.execute({
    agent: agent.agent,
    toolName: 'Edit',
    toolArgs: { file_path: '../agents/prd-author.md' },
    workingDirectory: '/project/src',
  });

  assert(result.allowed === false, 'Path traversal to agents/ should be blocked');

  // Check audit log has normalized path
  auditLogger.close();
  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const event = JSON.parse(content);
  assert(event.event_type === 'path_access_blocked', 'Should log path_access_blocked');

  cleanup(tmpDir);
  console.log('PASS: test_block_path_traversal');
}

function test_block_bash_cd_to_agents(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent();
  const filter = new PathFilter(auditLogger);

  const result = filter.execute({
    agent: agent.agent,
    toolName: 'Bash',
    toolArgs: { command: 'cd agents && cat prd-author.md' },
    workingDirectory: '/project',
  });

  assert(result.allowed === false, 'Bash cd to agents/ should be blocked');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_block_bash_cd_to_agents');
}

function test_allow_non_file_bash_commands(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent();
  const filter = new PathFilter(auditLogger);

  const result = filter.execute({
    agent: agent.agent,
    toolName: 'Bash',
    toolArgs: { command: 'echo hello' },
    workingDirectory: '/project',
  });

  assert(result.allowed === true, 'Non-file bash commands should be allowed');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_allow_non_file_bash_commands');
}

// ---------------------------------------------------------------------------
// AgentRuntime Tests
// ---------------------------------------------------------------------------

function test_runtime_check_tool_call_allowed(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent({ tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'] });
  const runtime = new AgentRuntime(agent, auditLogger, [
    new ToolAccessEnforcer(auditLogger),
    new PathFilter(auditLogger),
  ]);

  const result = runtime.checkToolCall('Read', { file_path: 'src/foo.ts' }, '/project');
  assert(result.allowed === true, 'Authorized tool on allowed path should succeed');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_runtime_check_tool_call_allowed');
}

function test_runtime_check_tool_call_tool_blocked(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent({
    name: 'test-reviewer',
    role: 'reviewer',
    tools: ['Read', 'Glob', 'Grep'],
  });
  const runtime = new AgentRuntime(agent, auditLogger, [
    new ToolAccessEnforcer(auditLogger),
    new PathFilter(auditLogger),
  ]);

  const result = runtime.checkToolCall('Edit', { file_path: 'src/foo.ts' }, '/project');
  assert(result.allowed === false, 'Unauthorized tool should be blocked by runtime');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_runtime_check_tool_call_tool_blocked');
}

function test_runtime_check_tool_call_path_blocked(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent({ tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'] });
  const runtime = new AgentRuntime(agent, auditLogger, [
    new ToolAccessEnforcer(auditLogger),
    new PathFilter(auditLogger),
  ]);

  const result = runtime.checkToolCall('Write', { file_path: '/project/agents/foo.md' }, '/project');
  assert(result.allowed === false, 'Write to agents/ should be blocked by runtime');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_runtime_check_tool_call_path_blocked');
}

function test_runtime_intercept_log(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent({ tools: ['Read'] });
  const runtime = new AgentRuntime(agent, auditLogger, [
    new ToolAccessEnforcer(auditLogger),
  ]);

  runtime.checkToolCall('Read', {}, '/project');
  runtime.checkToolCall('Bash', {}, '/project');

  const log = runtime.getInterceptLog();
  assert(log.length === 2, `Expected 2 interceptions, got ${log.length}`);
  assert(log[0].allowed === true, 'First call (Read) should be allowed');
  assert(log[1].allowed === false, 'Second call (Bash) should be blocked');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_runtime_intercept_log');
}

function test_runtime_invoke(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent();
  const runtime = new AgentRuntime(agent, auditLogger, []);

  // Run async test synchronously via .then
  runtime.invoke('test input', { workingDirectory: '/project' }).then((result) => {
    assert(result.success === true, 'Invoke should succeed');
    assert(result.duration_ms >= 0, 'Duration should be non-negative');
  });

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_runtime_invoke');
}

// ---------------------------------------------------------------------------
// Security Integration Tests
// ---------------------------------------------------------------------------

function test_tool_enforcement_end_to_end(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  // Reviewer agent attempts Edit
  const agent = makeAgent({
    name: 'code-reviewer',
    role: 'reviewer',
    tools: ['Read', 'Glob', 'Grep'],
  });
  const runtime = new AgentRuntime(agent, auditLogger, [
    new ToolAccessEnforcer(auditLogger),
    new PathFilter(auditLogger),
  ]);

  const result = runtime.checkToolCall('Edit', { file_path: 'src/foo.ts' }, '/project');
  assert(result.allowed === false, 'Reviewer Edit should be blocked');

  auditLogger.close();
  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const event = JSON.parse(content);
  assert(event.event_type === 'tool_call_blocked', 'Should log tool_call_blocked');
  assert(event.agent_name === 'code-reviewer', 'Should log correct agent name');

  cleanup(tmpDir);
  console.log('PASS: test_tool_enforcement_end_to_end');
}

function test_path_enforcement_end_to_end(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  // Executor agent attempts Write to agents/foo.md
  const agent = makeAgent({
    name: 'code-executor',
    role: 'executor',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
  });
  const runtime = new AgentRuntime(agent, auditLogger, [
    new ToolAccessEnforcer(auditLogger),
    new PathFilter(auditLogger),
  ]);

  const result = runtime.checkToolCall(
    'Write',
    { file_path: '/project/agents/foo.md' },
    '/project',
  );
  assert(result.allowed === false, 'Write to agents/ should be blocked');

  auditLogger.close();
  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const event = JSON.parse(content);
  assert(event.event_type === 'path_access_blocked', 'Should log path_access_blocked');

  cleanup(tmpDir);
  console.log('PASS: test_path_enforcement_end_to_end');
}

function test_path_traversal_end_to_end(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent({
    name: 'code-executor',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
  });
  const runtime = new AgentRuntime(agent, auditLogger, [
    new ToolAccessEnforcer(auditLogger),
    new PathFilter(auditLogger),
  ]);

  // Bash command with path traversal
  const result = runtime.checkToolCall(
    'Bash',
    { command: 'cat ../agents/meta-reviewer.md' },
    '/project/src',
  );
  assert(result.allowed === false, 'Path traversal to agents/ should be blocked');

  auditLogger.close();
  const content = fs.readFileSync(logPath, 'utf-8').trim();
  const event = JSON.parse(content);
  assert(event.event_type === 'path_access_blocked', 'Should log path_access_blocked');

  cleanup(tmpDir);
  console.log('PASS: test_path_traversal_end_to_end');
}

// ---------------------------------------------------------------------------
// Non-file tool passes path filter
// ---------------------------------------------------------------------------

function test_non_file_tool_passes_path_filter(): void {
  const tmpDir = makeTmpDir();
  const logPath = path.join(tmpDir, 'audit.log');
  const auditLogger = new AuditLogger(logPath);

  const agent = makeAgent({ tools: ['Read', 'Glob', 'Grep'] });
  const filter = new PathFilter(auditLogger);

  const result = filter.execute({
    agent: agent.agent,
    toolName: 'Grep',
    toolArgs: { pattern: 'agents' },
    workingDirectory: '/project',
  });

  assert(result.allowed === true, 'Non-file tools should pass path filter');

  auditLogger.close();
  cleanup(tmpDir);
  console.log('PASS: test_non_file_tool_passes_path_filter');
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests = [
  // ToolAccessEnforcer
  test_authorized_tool_allowed,
  test_unauthorized_tool_blocked,
  test_reviewer_cannot_edit,
  test_executor_can_edit,
  // PathFilter
  test_block_agents_directory,
  test_block_agent_data_files,
  test_block_metrics_directory,
  test_allow_src_directory,
  test_block_path_traversal,
  test_block_bash_cd_to_agents,
  test_allow_non_file_bash_commands,
  // AgentRuntime
  test_runtime_check_tool_call_allowed,
  test_runtime_check_tool_call_tool_blocked,
  test_runtime_check_tool_call_path_blocked,
  test_runtime_intercept_log,
  test_runtime_invoke,
  // Security Integration
  test_tool_enforcement_end_to_end,
  test_path_enforcement_end_to_end,
  test_path_traversal_end_to_end,
  // Non-file tool
  test_non_file_tool_passes_path_filter,
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
