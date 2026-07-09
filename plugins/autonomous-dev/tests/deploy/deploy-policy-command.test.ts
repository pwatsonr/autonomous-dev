/**
 * Tests for `deploy policy check` CLI command — issues #668 + #669.
 *
 * Coverage:
 *   1. `renderPolicyDecision` — human output (allowed, denied, approvals)
 *   2. `runPolicyCheck` — allowed result, denied result, JSON mode,
 *                          target-not-found error, maintenance-window with injected now
 *   3. Commander registration — `deploy policy check` is registered
 *
 * @module tests/deploy/deploy-policy-command.test
 */

import { Command } from 'commander';
import { Writable } from 'stream';

import {
  renderPolicyDecision,
  runPolicyCheck,
  registerDeployPolicyCommand,
} from '../../intake/cli/deploy_policy_command';
import {
  InMemoryDeployTargetRegistry,
  resetDeployTargetRegistry,
} from '../../intake/deploy/target-registry';
import { resetRuleTypeRegistry } from '../../intake/deploy/policy-engine';
import { resetActivePolicy } from '../../intake/deploy/policy-config';
import { EMPTY_POLICY } from '../../intake/deploy/policy-types';
import type { DeployTarget } from '../../intake/deploy/target-types';
import type { PolicyDocument } from '../../intake/deploy/policy-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    id: 'node-01',
    name: 'Node 01',
    kind: 'swarm-node',
    provider: 'docker-local',
    capabilities: [],
    tags: {},
    source: 'config',
    ...overrides,
  };
}

function makeRegistry(...targets: DeployTarget[]): InMemoryDeployTargetRegistry {
  const r = new InMemoryDeployTargetRegistry();
  for (const t of targets) r.register(t);
  return r;
}

function captureStreams(): {
  stdout: Writable & { data: string };
  stderr: Writable & { data: string };
} {
  const makeCapture = () => {
    const chunks: Buffer[] = [];
    const w = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    }) as Writable & { data: string };
    Object.defineProperty(w, 'data', { get: () => Buffer.concat(chunks).toString('utf8') });
    return w;
  };
  return { stdout: makeCapture(), stderr: makeCapture() };
}

const allowAllPolicy: PolicyDocument = EMPTY_POLICY;

const denyProdPolicy: PolicyDocument = {
  version: '1.0',
  rules: [
    {
      id: 'no-prod',
      type: 'placement',
      effect: 'deny',
      params: { forbid: { env: 'prod' } },
    },
  ],
};

const approvalPolicy: PolicyDocument = {
  version: '1.0',
  rules: [
    {
      id: 'prod-gate',
      type: 'placement',
      effect: 'require-approval',
      params: { forbid: { env: 'prod' }, approvers: ['sre-team'] },
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. renderPolicyDecision
// ---------------------------------------------------------------------------

describe('renderPolicyDecision', () => {
  it('shows ALLOWED when decision is allowed', () => {
    const out = renderPolicyDecision(
      { allowed: true, requiredApprovals: [], violations: [], matchedRules: [] },
      'my-svc',
      'node-01',
    );
    expect(out).toMatch(/ALLOWED/);
    expect(out).toMatch(/my-svc/);
    expect(out).toMatch(/node-01/);
  });

  it('shows DENIED when decision is not allowed', () => {
    const out = renderPolicyDecision(
      {
        allowed: false,
        requiredApprovals: [],
        violations: [{ ruleId: 'deny-rule', type: 'placement', message: 'denied!' }],
        matchedRules: ['deny-rule'],
      },
      'svc',
      'target',
    );
    expect(out).toMatch(/DENIED/);
    expect(out).toMatch(/deny-rule/);
    expect(out).toMatch(/denied!/);
  });

  it('shows required approvals when present', () => {
    const out = renderPolicyDecision(
      {
        allowed: false,
        requiredApprovals: ['sre-team', 'platform'],
        violations: [],
        matchedRules: ['rule-1'],
      },
      'svc',
      'tgt',
    );
    expect(out).toMatch(/sre-team/);
    expect(out).toMatch(/platform/);
  });

  it('shows no-rules message when matchedRules is empty', () => {
    const out = renderPolicyDecision(
      { allowed: true, requiredApprovals: [], violations: [], matchedRules: [] },
      'svc',
      'tgt',
    );
    expect(out).toMatch(/none|empty|no rules/i);
  });
});

// ---------------------------------------------------------------------------
// 2. runPolicyCheck
// ---------------------------------------------------------------------------

describe('runPolicyCheck', () => {
  afterEach(() => {
    resetDeployTargetRegistry();
    resetRuleTypeRegistry();
    resetActivePolicy();
  });

  it('returns exit code 0 when policy allows the deploy', async () => {
    const target = makeTarget({ id: 'node-01', env: 'staging' });
    const registry = makeRegistry(target);
    const { stdout, stderr } = captureStreams();
    const code = await runPolicyCheck(
      { service: 'my-svc', targetRaw: 'node-01' },
      { registry, policy: allowAllPolicy },
      { stdout, stderr },
    );
    expect(code).toBe(0);
    expect(stdout.data).toMatch(/ALLOWED/);
  });

  it('returns exit code 1 when policy denies the deploy', async () => {
    const target = makeTarget({ id: 'prod-node', env: 'prod' });
    const registry = makeRegistry(target);
    const { stdout, stderr } = captureStreams();
    const code = await runPolicyCheck(
      { service: 'my-svc', targetRaw: 'prod-node' },
      { registry, policy: denyProdPolicy },
      { stdout, stderr },
    );
    expect(code).toBe(1);
    expect(stdout.data).toMatch(/DENIED/);
    expect(stdout.data).toMatch(/no-prod/);
  });

  it('returns exit code 1 when require-approval gates the deploy', async () => {
    const target = makeTarget({ id: 'prod-node', env: 'prod' });
    const registry = makeRegistry(target);
    const { stdout, stderr } = captureStreams();
    const code = await runPolicyCheck(
      { service: 'my-svc', targetRaw: 'prod-node' },
      { registry, policy: approvalPolicy },
      { stdout, stderr },
    );
    expect(code).toBe(1);
    expect(stdout.data).toMatch(/sre-team/);
  });

  it('returns exit code 0 when using selector syntax (env=staging)', async () => {
    const target = makeTarget({ id: 'staging-node', env: 'staging' });
    const registry = makeRegistry(target);
    const { stdout, stderr } = captureStreams();
    const code = await runPolicyCheck(
      { service: 'my-svc', targetRaw: 'env=staging' },
      { registry, policy: allowAllPolicy },
      { stdout, stderr },
    );
    expect(code).toBe(0);
  });

  it('returns exit code 1 and stderr message when target is not found', async () => {
    const registry = makeRegistry(); // empty
    const { stdout, stderr } = captureStreams();
    const code = await runPolicyCheck(
      { service: 'my-svc', targetRaw: 'nonexistent' },
      { registry, policy: allowAllPolicy },
      { stdout, stderr },
    );
    expect(code).toBe(1);
    expect(stderr.data).toMatch(/nonexistent/i);
  });

  it('emits JSON output with --json flag', async () => {
    const target = makeTarget({ id: 'node-01' });
    const registry = makeRegistry(target);
    const { stdout } = captureStreams();
    const code = await runPolicyCheck(
      { service: 'my-svc', targetRaw: 'node-01', json: true },
      { registry, policy: allowAllPolicy },
      { stdout, stderr: captureStreams().stderr },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.data);
    expect(parsed).toHaveProperty('service', 'my-svc');
    expect(parsed).toHaveProperty('targetId', 'node-01');
    expect(parsed).toHaveProperty('decision');
    expect(parsed.decision.allowed).toBe(true);
  });

  it('passes nowOverride to maintenance-window rule via context', async () => {
    const target = makeTarget({ id: 'node-01', env: 'prod' });
    const registry = makeRegistry(target);

    // A policy with a maintenance-window rule: allow 06:00–22:00 UTC
    const mwPolicy: PolicyDocument = {
      version: '1.0',
      rules: [
        {
          id: 'biz-hours',
          type: 'maintenance-window',
          effect: 'deny',
          params: { allow: { start: '06:00', end: '22:00' } },
        },
      ],
    };

    // 02:00 UTC — outside window → deny
    const d2 = new Date(0);
    d2.setUTCFullYear(2024, 0, 15);
    d2.setUTCHours(2, 0, 0, 0);

    const { stdout } = captureStreams();
    const code = await runPolicyCheck(
      { service: 'my-svc', targetRaw: 'node-01', nowOverride: d2.getTime() },
      { registry, policy: mwPolicy },
      { stdout, stderr: captureStreams().stderr },
    );
    expect(code).toBe(1);
    expect(stdout.data).toMatch(/DENIED/);
  });

  it('passes affectedTargets to blast-radius rule via context', async () => {
    const target = makeTarget({ id: 'node-01' });
    const registry = makeRegistry(target);
    const blastPolicy: PolicyDocument = {
      version: '1.0',
      rules: [
        {
          id: 'blast-cap',
          type: 'blast-radius',
          effect: 'deny',
          params: { maxTargets: 2 },
        },
      ],
    };

    const { stdout } = captureStreams();
    const code = await runPolicyCheck(
      { service: 'my-svc', targetRaw: 'node-01', affectedTargets: 5 },
      { registry, policy: blastPolicy },
      { stdout, stderr: captureStreams().stderr },
    );
    expect(code).toBe(1);
    expect(stdout.data).toMatch(/DENIED/);
  });
});

// ---------------------------------------------------------------------------
// 3. Commander registration
// ---------------------------------------------------------------------------

describe('registerDeployPolicyCommand', () => {
  afterEach(() => {
    resetDeployTargetRegistry();
    resetRuleTypeRegistry();
    resetActivePolicy();
  });

  it('registers deploy policy check command under deploy group', () => {
    const program = new Command().exitOverride();
    const registry = makeRegistry(makeTarget({ id: 'node-01' }));
    registerDeployPolicyCommand(program, { registry, policy: allowAllPolicy });

    const deployGroup = program.commands.find((c: Command) => c.name() === 'deploy');
    expect(deployGroup).toBeDefined();

    const policyGroup = deployGroup!.commands.find((c: Command) => c.name() === 'policy');
    expect(policyGroup).toBeDefined();

    const checkCmd = policyGroup!.commands.find((c: Command) => c.name() === 'check');
    expect(checkCmd).toBeDefined();
  });

  it('creates deploy group if not already present', () => {
    const program = new Command().exitOverride();
    registerDeployPolicyCommand(program);
    const deployGroup = program.commands.find((c: Command) => c.name() === 'deploy');
    expect(deployGroup).toBeDefined();
  });

  it('reuses existing deploy group when already present', () => {
    const program = new Command().exitOverride();
    program.command('deploy').description('existing deploy group');
    registerDeployPolicyCommand(program);
    const deployGroups = program.commands.filter((c: Command) => c.name() === 'deploy');
    expect(deployGroups).toHaveLength(1);
  });
});
