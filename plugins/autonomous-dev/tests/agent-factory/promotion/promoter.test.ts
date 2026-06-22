/**
 * Unit tests for the human-approved Promoter workflow (SPEC-005-4-4, Task 9).
 *
 * Exercises the real Promoter against a throwaway git repository created in a
 * temp dir. The agents/ directory lives at <projectRoot>/agents so the
 * Promoter's `git add agents/<name>.md` (a path relative to projectRoot)
 * resolves correctly.
 *
 * Dependencies follow the suite's conventions:
 *   - a real ProposalStore (JSONL primary; SQLite falls back under Bun),
 *   - a real AuditLogger and ObservationTracker,
 *   - a MockRegistry whose reload() re-reads the agent .md from disk (so the
 *     post-commit version check in promote() observes the new version, exactly
 *     as a real registry reload would).
 *
 * Cases:
 *   - happy path: writes the new agent .md, makes a git commit, advances the
 *     proposal to `promoted`, and reloads the registry;
 *   - guard: only a `validated_positive` (or `meta_approved`) proposal in a
 *     valid agent state promotes — others are rejected;
 *   - rollback: a simulated git failure restores the original file and leaves
 *     the proposal status untouched.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { Promoter } from '../../../src/agent-factory/promotion/promoter';
import type { PromoterDependencies } from '../../../src/agent-factory/promotion/promoter';
import { ProposalStore } from '../../../src/agent-factory/improvement/proposal-store';
import { AuditLogger } from '../../../src/agent-factory/audit';
import { ObservationTracker } from '../../../src/agent-factory/metrics/observation';
import type { AgentFactoryConfig } from '../../../src/agent-factory/config';
import type { AgentProposal, ProposalStatus } from '../../../src/agent-factory/improvement/types';
import type {
  ParsedAgent,
  IAgentRegistry,
  AgentRecord,
  AgentState,
  RankedAgent,
  RegistryLoadResult,
} from '../../../src/agent-factory/types';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Temp-dir + git helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'promoter-test-'));
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Initialize a throwaway git repo with a committed baseline so HEAD exists. */
function initGitRepo(repoRoot: string): void {
  const run = (cmd: string) => execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
  run('git init -q');
  run('git config user.email "test@example.com"');
  run('git config user.name "Promoter Test"');
  run('git config commit.gpgsign false');
  // Seed a baseline commit so `git rev-parse HEAD` works and there is history.
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture repo\n', 'utf-8');
  run('git add README.md');
  run('git commit -q -m "chore: baseline"');
}

function gitHead(repoRoot: string): string {
  return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function gitLogSubjects(repoRoot: string): string[] {
  return execSync('git log --format=%s', { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' })
    .trim()
    .split('\n')
    .filter((l) => l !== '');
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
    ...(extraLine ? [extraLine] : []),
  ].join('\n');
}

function baseAgent(version: string): ParsedAgent {
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
    system_prompt: '# System Prompt\n\nYou are a code executor agent.',
  };
}

// ---------------------------------------------------------------------------
// Mock registry whose reload() re-reads the agent .md version from disk.
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

  /**
   * Re-read each known agent's `version:` from its on-disk .md so the
   * Promoter's post-commit version assertion sees the promoted version.
   */
  async reload(agentsDir: string): Promise<RegistryLoadResult> {
    this.reloadCount++;
    for (const [name, record] of this.agents) {
      const file = path.join(agentsDir, `${name}.md`);
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf-8');
        const m = content.match(/^version:\s*(.+)$/m);
        if (m) {
          record.agent = { ...record.agent, version: m[1].trim() };
        }
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
// Proposal fixture
// ---------------------------------------------------------------------------

function makeProposal(overrides?: Partial<AgentProposal>): AgentProposal {
  return {
    proposal_id: 'prop-promote-1',
    agent_name: 'code-executor',
    current_version: '1.0.0',
    proposed_version: '1.0.1',
    version_bump: 'patch',
    weakness_report_id: 'report-001',
    current_definition: agentMd('1.0.0'),
    proposed_definition: agentMd('1.0.1', 'Always ensure comprehensive test coverage.'),
    diff: '--- a/code-executor.md\n+++ b/code-executor.md\n@@ -1 +1 @@\n-old\n+new',
    rationale: 'Improve test coverage guidance',
    status: 'validated_positive',
    created_at: '2026-04-08T10:00:00.000Z',
    ...overrides,
  };
}

function makeConfig(): AgentFactoryConfig {
  return {
    observation: { defaultThreshold: 10, perAgentOverrides: {} },
  } as unknown as AgentFactoryConfig;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  promoter: Promoter;
  registry: DiskBackedRegistry;
  proposalStore: ProposalStore;
  auditLogger: AuditLogger;
  observationTracker: ObservationTracker;
  tmpDir: string;
  projectRoot: string;
  agentsDir: string;
  agentFilePath: string;
}

/**
 * Build a fully-wired Promoter over a temp project.
 *
 * @param opts.gitInit       When false, skip `git init` so git operations fail
 *                           (used to exercise the rollback path).
 * @param opts.proposal      Proposal to seed into the store.
 * @param opts.agentState    Initial registry state for the target agent.
 * @param opts.seedAgentFile When false, do not write the initial agent .md
 *                           (so rollback has no original to restore).
 */
function createHarness(opts: {
  gitInit?: boolean;
  proposal: AgentProposal;
  agentState?: AgentState;
  seedAgentFile?: boolean;
}): Harness {
  const tmpDir = makeTempDir();
  const projectRoot = path.join(tmpDir, 'repo');
  const agentsDir = path.join(projectRoot, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  if (opts.gitInit !== false) {
    initGitRepo(projectRoot);
  }

  const agentFilePath = path.join(agentsDir, 'code-executor.md');
  if (opts.seedAgentFile !== false) {
    fs.writeFileSync(agentFilePath, agentMd('1.0.0'), 'utf-8');
  }

  const proposalStore = new ProposalStore(
    path.join(tmpDir, 'proposals.jsonl'),
    path.join(tmpDir, 'agent-metrics.db'),
    { warn: () => {} },
  );
  proposalStore.append(opts.proposal);

  const registry = new DiskBackedRegistry([
    {
      agent: baseAgent('1.0.0'),
      state: opts.agentState ?? 'VALIDATING',
      loadedAt: new Date(),
      diskHash: 'abc123',
      filePath: agentFilePath,
    },
  ]);

  const auditLogger = new AuditLogger(path.join(tmpDir, 'data', 'agent-audit.log'));
  const observationTracker = new ObservationTracker({
    config: makeConfig(),
    statePath: path.join(tmpDir, 'observation-state.json'),
    logger: silentLogger,
  });

  const deps: PromoterDependencies = {
    registry,
    proposalStore,
    auditLogger,
    observationTracker,
    agentsDir,
    projectRoot,
  };

  return {
    promoter: new Promoter(deps),
    registry,
    proposalStore,
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
  cleanupDir(h.tmpDir);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

async function test_promote_happy_path(): Promise<void> {
  const h = createHarness({ proposal: makeProposal(), agentState: 'VALIDATING' });
  try {
    const headBefore = gitHead(h.projectRoot);

    const result = await h.promoter.promote('code-executor', 'prop-promote-1');

    assert(result.success === true, `expected success, got error: ${result.error}`);
    assert(result.agentName === 'code-executor', 'agentName on result');
    assert(result.previousVersion === '1.0.0', `previousVersion, got ${result.previousVersion}`);
    assert(result.newVersion === '1.0.1', `newVersion, got ${result.newVersion}`);
    assert(result.commitHash.length > 0, 'commitHash should be set');

    // 1) New agent definition written to disk.
    const onDisk = fs.readFileSync(h.agentFilePath, 'utf-8');
    assert(onDisk.includes('version: 1.0.1'), 'agent .md should contain the new version');
    assert(
      onDisk.includes('comprehensive test coverage'),
      'agent .md should contain the proposed body',
    );

    // 2) A git commit was made (HEAD advanced; file is committed/clean).
    const headAfter = gitHead(h.projectRoot);
    assert(headAfter !== headBefore, 'HEAD should advance after promotion commit');
    assert(headAfter === result.commitHash, 'result.commitHash should match repo HEAD');
    const status = execSync('git status --porcelain', {
      cwd: h.projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    assert(status === '', `working tree should be clean after commit, got: ${status}`);
    // Conventional commit subject (patch -> fix(agents):).
    const subjects = gitLogSubjects(h.projectRoot);
    assert(
      subjects[0].startsWith('fix(agents):'),
      `commit subject should be a fix(agents) message, got: ${subjects[0]}`,
    );
    assert(
      subjects[0].includes('v1.0.0 -> v1.0.1'),
      'commit subject should reference the version bump',
    );

    // 3) Proposal advanced to `promoted`.
    const stored = h.proposalStore.getById('prop-promote-1');
    assert(stored!.status === 'promoted', `proposal should be promoted, got ${stored!.status}`);

    // 4) Registry reloaded (and now reports the new version) + state ACTIVE.
    assert(h.registry.reloadCount >= 1, 'registry.reload should be called during promotion');
    assert(
      h.registry.get('code-executor')!.agent.version === '1.0.1',
      'registry should report the promoted version',
    );
    assert(h.registry.getState('code-executor') === 'ACTIVE', 'agent state should end ACTIVE');

    // 5) Observation counter reset for the new version.
    assert(
      h.observationTracker.getState('code-executor').last_promotion_version === '1.0.1',
      'observation tracker should be reset to the new version',
    );

    // 6) Audit log records the promotion.
    h.auditLogger.close();
    const auditPath = path.join(h.tmpDir, 'data', 'agent-audit.log');
    const audit = fs.readFileSync(auditPath, 'utf-8');
    assert(audit.includes('agent_promoted'), 'audit log should contain agent_promoted');
    console.log('PASS: test_promote_happy_path');
  } finally {
    teardown(h);
  }
}

async function test_promote_with_message_uses_custom_subject(): Promise<void> {
  // promoteWithMessage is the AutoPromoter entry point; verify the custom
  // commit subject is used and the proposal still advances to promoted.
  const h = createHarness({ proposal: makeProposal(), agentState: 'VALIDATING' });
  try {
    const customMsg = 'feat(agents): auto-promote code-executor after A/B win';
    const result = await h.promoter.promoteWithMessage(
      'code-executor',
      'prop-promote-1',
      customMsg,
    );

    assert(result.success === true, `expected success, got error: ${result.error}`);
    const subjects = gitLogSubjects(h.projectRoot);
    assert(
      subjects[0] === customMsg,
      `commit subject should be the custom message, got: ${subjects[0]}`,
    );
    assert(
      h.proposalStore.getById('prop-promote-1')!.status === 'promoted',
      'proposal should be promoted',
    );
    console.log('PASS: test_promote_with_message_uses_custom_subject');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// Guards: only validated_positive (or meta_approved) + valid state promotes.
// ---------------------------------------------------------------------------

async function test_guard_rejects_wrong_status(): Promise<void> {
  // A proposal that is not validated_positive / meta_approved must be rejected
  // before any file write or commit.
  const rejectedStatuses: ProposalStatus[] = [
    'pending_meta_review',
    'meta_rejected',
    'validating',
    'validated_negative',
    'rejected',
  ];

  for (const status of rejectedStatuses) {
    const h = createHarness({
      proposal: makeProposal({ status }),
      agentState: 'VALIDATING',
    });
    try {
      const headBefore = gitHead(h.projectRoot);
      const result = await h.promoter.promote('code-executor', 'prop-promote-1');

      assert(result.success === false, `status ${status} should NOT promote`);
      assert(
        (result.error ?? '').includes('validated_positive or meta_approved'),
        `error should explain the status guard for ${status}, got: ${result.error}`,
      );
      // No commit, file untouched, proposal status unchanged.
      assert(gitHead(h.projectRoot) === headBefore, `no commit should occur for status ${status}`);
      assert(
        fs.readFileSync(h.agentFilePath, 'utf-8').includes('version: 1.0.0'),
        'agent file unchanged',
      );
      assert(
        h.proposalStore.getById('prop-promote-1')!.status === status,
        `proposal status should remain ${status}`,
      );
    } finally {
      teardown(h);
    }
  }
  console.log('PASS: test_guard_rejects_wrong_status');
}

async function test_guard_rejects_wrong_agent_state(): Promise<void> {
  // validated_positive but the agent is in a state outside VALIDATING/UNDER_REVIEW.
  const h = createHarness({ proposal: makeProposal(), agentState: 'ACTIVE' });
  try {
    const result = await h.promoter.promote('code-executor', 'prop-promote-1');
    assert(result.success === false, 'should reject when agent state is invalid for promotion');
    assert(
      (result.error ?? '').includes('VALIDATING or UNDER_REVIEW'),
      `error should explain the state guard, got: ${result.error}`,
    );
    assert(
      h.proposalStore.getById('prop-promote-1')!.status === 'validated_positive',
      'proposal status unchanged',
    );
    console.log('PASS: test_guard_rejects_wrong_agent_state');
  } finally {
    teardown(h);
  }
}

async function test_guard_rejects_unknown_proposal(): Promise<void> {
  const h = createHarness({ proposal: makeProposal(), agentState: 'VALIDATING' });
  try {
    const result = await h.promoter.promote('code-executor', 'no-such-proposal');
    assert(result.success === false, 'should reject unknown proposal id');
    assert(
      (result.error ?? '').includes('not found'),
      `error should mention not found, got: ${result.error}`,
    );
    console.log('PASS: test_guard_rejects_unknown_proposal');
  } finally {
    teardown(h);
  }
}

async function test_guard_rejects_mismatched_agent(): Promise<void> {
  // Proposal belongs to a different agent than the one being promoted.
  const h = createHarness({
    proposal: makeProposal({ agent_name: 'prd-author' }),
    agentState: 'VALIDATING',
  });
  try {
    const result = await h.promoter.promote('code-executor', 'prop-promote-1');
    assert(result.success === false, 'should reject when proposal agent mismatches');
    assert(
      (result.error ?? '').includes('does not belong to this agent'),
      `error should explain ownership mismatch, got: ${result.error}`,
    );
    console.log('PASS: test_guard_rejects_mismatched_agent');
  } finally {
    teardown(h);
  }
}

async function test_meta_approved_status_is_promotable(): Promise<void> {
  // The self-review-bypass path: meta_approved + UNDER_REVIEW passes the
  // prerequisite gate and promote() reports success, writing the file,
  // committing to git, AND advancing the proposal to `promoted`.
  //
  // #539 fix: VALID_TRANSITIONS now has the `meta_approved -> promoted` edge
  // (previously only `meta_approved -> validating`), so the bypass promotion
  // no longer leaves the proposal stale at meta_approved while the agent file
  // is committed.
  const h = createHarness({
    proposal: makeProposal({ status: 'meta_approved' }),
    agentState: 'UNDER_REVIEW',
  });
  try {
    const headBefore = gitHead(h.projectRoot);
    const result = await h.promoter.promote('code-executor', 'prop-promote-1');

    // Promotion reports success and the side effects (file + commit) land.
    assert(
      result.success === true,
      `meta_approved + UNDER_REVIEW should report success, got error: ${result.error}`,
    );
    assert(
      gitHead(h.projectRoot) !== headBefore,
      'a commit should be made on the meta_approved path',
    );
    assert(
      fs.readFileSync(h.agentFilePath, 'utf-8').includes('version: 1.0.1'),
      'agent file should be updated',
    );
    assert(h.registry.getState('code-executor') === 'ACTIVE', 'agent state advances to ACTIVE');

    // #539: the proposal now reaches `promoted` (the bypass edge exists).
    const stored = h.proposalStore.getById('prop-promote-1')!;
    assert(
      stored.status === 'promoted',
      `proposal should reach promoted via the meta_approved bypass edge (#539), got ${stored.status}`,
    );
    console.log('PASS: test_meta_approved_status_is_promotable');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// Rollback on git failure
// ---------------------------------------------------------------------------

async function test_rollback_restores_file_on_git_failure(): Promise<void> {
  // No git repo at projectRoot -> `git add` throws -> Promoter must roll the
  // file back to its original content and report failure without advancing
  // the proposal.
  const h = createHarness({
    proposal: makeProposal(),
    agentState: 'VALIDATING',
    gitInit: false,
  });
  try {
    const originalContent = fs.readFileSync(h.agentFilePath, 'utf-8');
    assert(originalContent.includes('version: 1.0.0'), 'precondition: original is v1.0.0');

    const result = await h.promoter.promote('code-executor', 'prop-promote-1');

    assert(result.success === false, 'expected failure when git commit fails');
    assert(
      (result.error ?? '').toLowerCase().includes('git commit failed'),
      `error should mention git failure, got: ${result.error}`,
    );

    // File restored to original (the v1.0.1 write was rolled back).
    const afterContent = fs.readFileSync(h.agentFilePath, 'utf-8');
    assert(
      afterContent === originalContent,
      'agent file should be rolled back to original content',
    );
    assert(
      !afterContent.includes('version: 1.0.1'),
      'rolled-back file must not contain the proposed version',
    );

    // Proposal status untouched.
    assert(
      h.proposalStore.getById('prop-promote-1')!.status === 'validated_positive',
      'proposal should remain validated_positive after rollback',
    );

    // Rollback event is logged.
    h.auditLogger.close();
    console.log('PASS: test_rollback_restores_file_on_git_failure');
  } finally {
    teardown(h);
  }
}

async function test_rollback_deletes_new_file_on_git_failure(): Promise<void> {
  // Same git failure, but there was NO pre-existing agent file. Rollback must
  // delete the file the Promoter created (originalContent === null path).
  const h = createHarness({
    proposal: makeProposal(),
    agentState: 'VALIDATING',
    gitInit: false,
    seedAgentFile: false,
  });
  try {
    assert(!fs.existsSync(h.agentFilePath), 'precondition: no agent file yet');

    const result = await h.promoter.promote('code-executor', 'prop-promote-1');

    assert(result.success === false, 'expected failure when git commit fails');
    assert(
      !fs.existsSync(h.agentFilePath),
      'newly-written agent file should be deleted on rollback',
    );
    assert(
      h.proposalStore.getById('prop-promote-1')!.status === 'validated_positive',
      'proposal status unchanged after rollback',
    );
    console.log('PASS: test_rollback_deletes_new_file_on_git_failure');
  } finally {
    teardown(h);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('promoter', () => {
  it('test_promote_happy_path', async () => await test_promote_happy_path());
  it('test_promote_with_message_uses_custom_subject', async () =>
    await test_promote_with_message_uses_custom_subject());
  it('test_guard_rejects_wrong_status', async () => await test_guard_rejects_wrong_status());
  it('test_guard_rejects_wrong_agent_state', async () =>
    await test_guard_rejects_wrong_agent_state());
  it('test_guard_rejects_unknown_proposal', async () =>
    await test_guard_rejects_unknown_proposal());
  it('test_guard_rejects_mismatched_agent', async () =>
    await test_guard_rejects_mismatched_agent());
  it('test_meta_approved_status_is_promotable', async () =>
    await test_meta_approved_status_is_promotable());
  it('test_rollback_restores_file_on_git_failure', async () =>
    await test_rollback_restores_file_on_git_failure());
  it('test_rollback_deletes_new_file_on_git_failure', async () =>
    await test_rollback_deletes_new_file_on_git_failure());
});
