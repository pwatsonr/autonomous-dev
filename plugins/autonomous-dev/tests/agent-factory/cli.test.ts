/**
 * Unit tests for Agent Factory CLI commands (SPEC-005-1-4, Task 10).
 */

import {
  commandList,
  commandInspect,
  commandFreeze,
  commandUnfreeze,
  commandShadow,
  commandUnshadow,
  formatReloadResult,
} from '../../src/agent-factory/cli';

import type {
  IAgentRegistry,
  AgentRecord,
  AgentState,
  RankedAgent,
  RegistryLoadResult,
  ParsedAgent,
} from '../../src/agent-factory/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function makeAgent(overrides: Partial<ParsedAgent> = {}): ParsedAgent {
  return {
    name: 'test-agent',
    version: '1.0.0',
    role: 'executor',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.3,
    turn_limit: 25,
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    expertise: ['implementation', 'typescript'],
    evaluation_rubric: [
      { name: 'correctness', weight: 0.6, description: 'Code passes tests' },
      { name: 'quality', weight: 0.4, description: 'Clean code' },
    ],
    version_history: [
      { version: '1.0.0', date: '2026-01-01', change: 'Initial release' },
    ],
    description: 'Test agent description',
    system_prompt: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<AgentRecord> = {}, agentOverrides: Partial<ParsedAgent> = {}): AgentRecord {
  return {
    agent: makeAgent(agentOverrides),
    state: 'ACTIVE' as AgentState,
    loadedAt: new Date('2026-04-08T12:00:00Z'),
    diskHash: 'abc123def456',
    filePath: '/path/to/agents/test-agent.md',
    ...overrides,
  };
}

/**
 * Minimal mock registry for testing CLI commands.
 */
class MockRegistry implements IAgentRegistry {
  private agents: Map<string, AgentRecord> = new Map();
  public freezeCalls: string[] = [];
  public unfreezeCalls: string[] = [];
  public shadowCalls: string[] = [];
  public unshadowCalls: string[] = [];
  public reloadCalls: string[] = [];

  constructor(records: AgentRecord[] = []) {
    for (const r of records) {
      this.agents.set(r.agent.name, r);
    }
  }

  async load(_agentsDir: string): Promise<RegistryLoadResult> {
    return { loaded: this.agents.size, rejected: 0, errors: [], duration_ms: 10 };
  }

  async reload(agentsDir: string): Promise<RegistryLoadResult> {
    this.reloadCalls.push(agentsDir);
    return { loaded: this.agents.size, rejected: 0, errors: [], duration_ms: 15 };
  }

  list(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  get(name: string): AgentRecord | undefined {
    return this.agents.get(name);
  }

  getForTask(_taskDescription: string, _taskDomain?: string): RankedAgent[] {
    return [];
  }

  freeze(name: string): void {
    const record = this.agents.get(name);
    if (!record) throw new Error(`Cannot freeze: agent '${name}' not found in registry`);
    if (record.state === 'FROZEN') throw new Error(`Cannot freeze: agent '${name}' is already FROZEN`);
    record.state = 'FROZEN';
    this.freezeCalls.push(name);
  }

  unfreeze(name: string): void {
    const record = this.agents.get(name);
    if (!record) throw new Error(`Cannot unfreeze: agent '${name}' not found in registry`);
    if (record.state !== 'FROZEN') throw new Error(`Cannot unfreeze: agent '${name}' is not FROZEN (current state: ${record.state})`);
    record.state = 'ACTIVE';
    this.unfreezeCalls.push(name);
  }

  shadow(name: string): void {
    const record = this.agents.get(name);
    if (!record) throw new Error(`Cannot shadow: agent '${name}' not found in registry`);
    if (record.state === 'SHADOWED') throw new Error(`Cannot shadow: agent '${name}' is already SHADOWED`);
    if (record.state !== 'ACTIVE') throw new Error(`Cannot shadow: agent '${name}' is not ACTIVE (current state: ${record.state})`);
    record.state = 'SHADOWED';
    this.shadowCalls.push(name);
  }

  unshadow(name: string): void {
    const record = this.agents.get(name);
    if (!record) throw new Error(`Cannot unshadow: agent '${name}' not found in registry`);
    if (record.state !== 'SHADOWED') throw new Error(`Cannot unshadow: agent '${name}' is not SHADOWED (current state: ${record.state})`);
    record.state = 'ACTIVE';
    this.unshadowCalls.push(name);
  }

  getState(name: string): AgentState | undefined {
    return this.agents.get(name)?.state;
  }

  setState(name: string, state: AgentState): void {
    const record = this.agents.get(name);
    if (!record) throw new Error(`Agent '${name}' not found`);
    record.state = state;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function test_list_command_output_format(): void {
  const registry = new MockRegistry([
    makeRecord(
      { state: 'ACTIVE' },
      { name: 'prd-author', version: '1.0.0', role: 'author', expertise: ['product-requirements', 'user-stories'] },
    ),
    makeRecord(
      { state: 'ACTIVE' },
      { name: 'code-executor', version: '1.0.0', role: 'executor', expertise: ['implementation', 'typescript'] },
    ),
    makeRecord(
      { state: 'FROZEN' },
      { name: 'agent-meta-reviewer', version: '1.0.0', role: 'meta', expertise: ['agent-safety', 'prompt-review'] },
    ),
  ]);

  const output = commandList(registry);

  // Verify header
  assert(output.includes('NAME'), 'output should include NAME column header');
  assert(output.includes('VERSION'), 'output should include VERSION column header');
  assert(output.includes('ROLE'), 'output should include ROLE column header');
  assert(output.includes('STATE'), 'output should include STATE column header');
  assert(output.includes('EXPERTISE'), 'output should include EXPERTISE column header');

  // Verify agent rows
  assert(output.includes('prd-author'), 'output should include prd-author');
  assert(output.includes('code-executor'), 'output should include code-executor');
  assert(output.includes('agent-meta-reviewer'), 'output should include agent-meta-reviewer');
  assert(output.includes('ACTIVE'), 'output should include ACTIVE state');
  assert(output.includes('FROZEN'), 'output should include FROZEN state');
  assert(output.includes('product-requirements'), 'output should include expertise tags');

  console.log('PASS: test_list_command_output_format');
}

function test_list_empty_registry(): void {
  const registry = new MockRegistry([]);
  const output = commandList(registry);
  assert(output === 'No agents registered.', `unexpected output: ${output}`);
  console.log('PASS: test_list_empty_registry');
}

function test_inspect_command_shows_full_config(): void {
  const registry = new MockRegistry([
    makeRecord(
      {
        state: 'ACTIVE',
        diskHash: 'sha256abcdef1234567890',
        loadedAt: new Date('2026-04-08T12:00:00Z'),
        filePath: '/agents/code-executor.md',
      },
      {
        name: 'code-executor',
        version: '1.0.0',
        role: 'executor',
        model: 'claude-sonnet-4-20250514',
        temperature: 0.3,
        turn_limit: 50,
        tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
        expertise: ['implementation', 'typescript'],
        description: 'Implements code from specs',
      },
    ),
  ]);

  const output = commandInspect(registry, 'code-executor');

  assert(output.includes('code-executor'), 'output should include agent name');
  assert(output.includes('1.0.0'), 'output should include version');
  assert(output.includes('executor'), 'output should include role');
  assert(output.includes('claude-sonnet-4-20250514'), 'output should include model');
  assert(output.includes('0.3'), 'output should include temperature');
  assert(output.includes('50'), 'output should include turn_limit');
  assert(output.includes('sha256abcdef1234567890'), 'output should include SHA-256 hash');
  assert(output.includes('2026-04-08'), 'output should include loadedAt timestamp');
  assert(output.includes('ACTIVE'), 'output should include state');
  assert(output.includes('/agents/code-executor.md'), 'output should include file path');
  assert(output.includes('correctness'), 'output should include rubric dimensions');

  console.log('PASS: test_inspect_command_shows_full_config');
}

function test_inspect_unknown_agent_shows_error(): void {
  const registry = new MockRegistry([]);
  const output = commandInspect(registry, 'nonexistent');
  assert(
    output.includes("Agent 'nonexistent' not found"),
    `expected error message, got: ${output}`,
  );
  console.log('PASS: test_inspect_unknown_agent_shows_error');
}

function test_reload_command_displays_results(): void {
  const result: RegistryLoadResult = {
    loaded: 5,
    rejected: 1,
    errors: [{ file: '/agents/bad.md', reason: 'parse: invalid YAML' }],
    duration_ms: 42,
  };

  const output = formatReloadResult(result);

  assert(output.includes('Loaded:   5'), 'output should include loaded count');
  assert(output.includes('Rejected: 1'), 'output should include rejected count');
  assert(output.includes('42ms'), 'output should include duration');
  assert(output.includes('/agents/bad.md'), 'output should include error file');
  assert(output.includes('parse: invalid YAML'), 'output should include error reason');

  console.log('PASS: test_reload_command_displays_results');
}

function test_freeze_command(): void {
  const registry = new MockRegistry([
    makeRecord({ state: 'ACTIVE' }, { name: 'code-executor' }),
  ]);

  const output = commandFreeze(registry, 'code-executor');
  assert(output.includes('frozen'), `expected freeze confirmation, got: ${output}`);
  assert(output.includes('code-executor'), 'output should include agent name');
  assert(registry.freezeCalls.includes('code-executor'), 'freeze should have been called');

  console.log('PASS: test_freeze_command');
}

function test_unfreeze_command(): void {
  const registry = new MockRegistry([
    makeRecord({ state: 'FROZEN' }, { name: 'agent-meta-reviewer' }),
  ]);

  const output = commandUnfreeze(registry, 'agent-meta-reviewer');
  assert(output.includes('unfrozen'), `expected unfreeze confirmation, got: ${output}`);
  assert(output.includes('agent-meta-reviewer'), 'output should include agent name');
  assert(registry.unfreezeCalls.includes('agent-meta-reviewer'), 'unfreeze should have been called');

  console.log('PASS: test_unfreeze_command');
}

function test_freeze_nonexistent_agent(): void {
  const registry = new MockRegistry([]);
  const output = commandFreeze(registry, 'nonexistent');
  assert(output.startsWith('Error:'), `expected error, got: ${output}`);
  console.log('PASS: test_freeze_nonexistent_agent');
}

function test_unfreeze_non_frozen_agent(): void {
  const registry = new MockRegistry([
    makeRecord({ state: 'ACTIVE' }, { name: 'code-executor' }),
  ]);
  const output = commandUnfreeze(registry, 'code-executor');
  assert(output.startsWith('Error:'), `expected error, got: ${output}`);
  console.log('PASS: test_unfreeze_non_frozen_agent');
}

function test_shadow_command(): void {
  const registry = new MockRegistry([
    makeRecord({ state: 'ACTIVE' }, { name: 'code-executor' }),
  ]);

  const output = commandShadow(registry, 'code-executor');
  assert(output.includes('shadowed'), `expected shadow confirmation, got: ${output}`);
  assert(output.includes('code-executor'), 'output should include agent name');
  assert(output.includes('SHADOWED'), 'output should include SHADOWED state');
  assert(registry.shadowCalls.includes('code-executor'), 'shadow should have been called');

  console.log('PASS: test_shadow_command');
}

function test_unshadow_command(): void {
  const registry = new MockRegistry([
    makeRecord({ state: 'SHADOWED' }, { name: 'code-executor' }),
  ]);

  const output = commandUnshadow(registry, 'code-executor');
  assert(output.includes('unshadowed'), `expected unshadow confirmation, got: ${output}`);
  assert(output.includes('code-executor'), 'output should include agent name');
  assert(output.includes('ACTIVE'), 'output should include ACTIVE state');
  assert(registry.unshadowCalls.includes('code-executor'), 'unshadow should have been called');

  console.log('PASS: test_unshadow_command');
}

function test_shadow_nonexistent_agent(): void {
  const registry = new MockRegistry([]);
  const output = commandShadow(registry, 'nonexistent');
  assert(output.startsWith('Error:'), `expected error, got: ${output}`);
  console.log('PASS: test_shadow_nonexistent_agent');
}

function test_shadow_already_shadowed_agent(): void {
  const registry = new MockRegistry([
    makeRecord({ state: 'SHADOWED' }, { name: 'code-executor' }),
  ]);
  const output = commandShadow(registry, 'code-executor');
  assert(output.startsWith('Error:'), `expected error, got: ${output}`);
  assert(output.includes('already SHADOWED'), `expected idempotency error, got: ${output}`);
  console.log('PASS: test_shadow_already_shadowed_agent');
}

function test_shadow_frozen_agent_rejected(): void {
  const registry = new MockRegistry([
    makeRecord({ state: 'FROZEN' }, { name: 'code-executor' }),
  ]);
  const output = commandShadow(registry, 'code-executor');
  assert(output.startsWith('Error:'), `expected error, got: ${output}`);
  assert(output.includes('not ACTIVE'), `expected guard error, got: ${output}`);
  console.log('PASS: test_shadow_frozen_agent_rejected');
}

function test_unshadow_non_shadowed_agent(): void {
  const registry = new MockRegistry([
    makeRecord({ state: 'ACTIVE' }, { name: 'code-executor' }),
  ]);
  const output = commandUnshadow(registry, 'code-executor');
  assert(output.startsWith('Error:'), `expected error, got: ${output}`);
  console.log('PASS: test_unshadow_non_shadowed_agent');
}

function test_inspect_system_prompt_truncated(): void {
  const longPrompt = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n');
  const registry = new MockRegistry([
    makeRecord({}, { name: 'verbose-agent', system_prompt: longPrompt }),
  ]);

  const output = commandInspect(registry, 'verbose-agent');
  assert(output.includes('Line 1'), 'should include first line');
  assert(output.includes('Line 5'), 'should include fifth line');
  assert(output.includes('...'), 'should include truncation indicator');
  assert(!output.includes('Line 10'), 'should not include line 10');

  console.log('PASS: test_inspect_system_prompt_truncated');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
describe('cli', () => {
  it('test_list_command_output_format', test_list_command_output_format);
  it('test_list_empty_registry', test_list_empty_registry);
  it('test_inspect_command_shows_full_config', test_inspect_command_shows_full_config);
  it('test_inspect_unknown_agent_shows_error', test_inspect_unknown_agent_shows_error);
  it('test_reload_command_displays_results', test_reload_command_displays_results);
  it('test_freeze_command', test_freeze_command);
  it('test_unfreeze_command', test_unfreeze_command);
  it('test_freeze_nonexistent_agent', test_freeze_nonexistent_agent);
  it('test_unfreeze_non_frozen_agent', test_unfreeze_non_frozen_agent);
  it('test_shadow_command', test_shadow_command);
  it('test_unshadow_command', test_unshadow_command);
  it('test_shadow_nonexistent_agent', test_shadow_nonexistent_agent);
  it('test_shadow_already_shadowed_agent', test_shadow_already_shadowed_agent);
  it('test_shadow_frozen_agent_rejected', test_shadow_frozen_agent_rejected);
  it('test_unshadow_non_shadowed_agent', test_unshadow_non_shadowed_agent);
  it('test_inspect_system_prompt_truncated', test_inspect_system_prompt_truncated);
});
