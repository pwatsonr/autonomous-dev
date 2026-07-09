/**
 * Tests for `deploy targets list` and `deploy run --target ... [--dry-run]`
 * (issue #661, intake/cli/deploy_targets_command.ts).
 *
 * Coverage:
 *   1. `deploy targets list` — human table, --json, empty registry, live update
 *   2. `parseTargetArg` — id, kind/env/capability/tag selectors, fallback
 *   3. `renderDryRunPlan` — output fields present
 *   4. `runDeployService --dry-run` — resolves target, prints plan, no mutation
 *   5. `runDeployService` without --dry-run — handoff message
 *   6. `runDeployService` error paths — unknown id, ambiguous, no-default
 *   7. Commander registration — `deploy targets list` and `deploy run` under
 *      the `deploy` group
 *   8. Invariant #674 — list always reflects live topology
 *
 * No process.exit() is called; streams are injected.
 *
 * @module tests/deploy/deploy-targets-command.test
 */

import { Command } from 'commander';

import {
  renderTargetsTable,
  runDeployTargetsList,
  parseTargetArg,
  renderDryRunPlan,
  runDeployService,
  registerDeployTargetsCommand,
} from '../../intake/cli/deploy_targets_command';
import {
  InMemoryDeployTargetRegistry,
  resetDeployTargetRegistry,
} from '../../intake/deploy/target-registry';
import type { DeployTarget } from '../../intake/deploy/target-types';
import type { TargetProvider } from '../../intake/deploy/target-registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    id: 'target-x',
    name: 'Target X',
    kind: 'local-pr',
    provider: 'local',
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

/** Capture stdout/stderr into string buffers. */
function makeStreams(): {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  out: () => string;
  err: () => string;
} {
  let outBuf = '';
  let errBuf = '';
  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        outBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        return true;
      },
    } as NodeJS.WritableStream,
    stderr: {
      write(chunk: string | Uint8Array) {
        errBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        return true;
      },
    } as NodeJS.WritableStream,
    out: () => outBuf,
    err: () => errBuf,
  };
}

afterEach(() => {
  resetDeployTargetRegistry();
});

// ---------------------------------------------------------------------------
// 1. deploy targets list
// ---------------------------------------------------------------------------

describe('renderTargetsTable', () => {
  it('returns a no-targets message for an empty list', () => {
    expect(renderTargetsTable([])).toMatch(/no targets registered/);
  });

  it('includes headers in the table', () => {
    const t = makeTarget({ id: 'node-1' });
    const out = renderTargetsTable([t]);
    expect(out).toMatch(/ID/);
    expect(out).toMatch(/NAME/);
    expect(out).toMatch(/KIND/);
    expect(out).toMatch(/SOURCE/);
  });

  it('includes target data in the table', () => {
    const t = makeTarget({
      id: 'gpu-host',
      name: 'GPU Host',
      kind: 'swarm-node',
      env: 'prod',
      capabilities: ['gpu', 'high-memory'],
      tags: { rack: '2' },
      source: 'discovery',
    });
    const out = renderTargetsTable([t]);
    expect(out).toContain('gpu-host');
    expect(out).toContain('GPU Host');
    expect(out).toContain('swarm-node');
    expect(out).toContain('prod');
    expect(out).toContain('gpu,high-memory');
    expect(out).toContain('rack=2');
    expect(out).toContain('discovery');
  });

  it('renders multiple targets, config targets before discovery', () => {
    const config = makeTarget({ id: 'cfg-target', source: 'config' });
    const dynamic = makeTarget({ id: 'dyn-target', source: 'discovery' });
    const out = renderTargetsTable([config, dynamic]);
    const cfgPos = out.indexOf('cfg-target');
    const dynPos = out.indexOf('dyn-target');
    expect(cfgPos).toBeLessThan(dynPos);
  });
});

describe('runDeployTargetsList', () => {
  it('prints human table to stdout', async () => {
    const registry = makeRegistry(makeTarget({ id: 'my-target', name: 'My Target' }));
    const streams = makeStreams();
    const code = await runDeployTargetsList({}, { registry }, streams);
    expect(code).toBe(0);
    expect(streams.out()).toContain('my-target');
  });

  it('--json emits valid JSON with a targets array', async () => {
    const registry = makeRegistry(
      makeTarget({ id: 't1', kind: 'swarm-node' }),
      makeTarget({ id: 't2', kind: 'k3s-cluster' }),
    );
    const streams = makeStreams();
    const code = await runDeployTargetsList({ json: true }, { registry }, streams);
    expect(code).toBe(0);
    const parsed = JSON.parse(streams.out()) as { targets: DeployTarget[] };
    expect(parsed.targets).toHaveLength(2);
    expect(parsed.targets.map((t) => t.id)).toContain('t1');
    expect(parsed.targets.map((t) => t.id)).toContain('t2');
  });

  it('prints no-targets message for an empty registry', async () => {
    const registry = new InMemoryDeployTargetRegistry();
    const streams = makeStreams();
    const code = await runDeployTargetsList({}, { registry }, streams);
    expect(code).toBe(0);
    expect(streams.out()).toMatch(/no targets registered/);
  });

  it('--json with empty registry emits empty targets array', async () => {
    const registry = new InMemoryDeployTargetRegistry();
    const streams = makeStreams();
    await runDeployTargetsList({ json: true }, { registry }, streams);
    const parsed = JSON.parse(streams.out()) as { targets: DeployTarget[] };
    expect(parsed.targets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. parseTargetArg
// ---------------------------------------------------------------------------

describe('parseTargetArg', () => {
  it('no `=` → raw id', () => {
    expect(parseTargetArg('my-node')).toEqual({ targetId: 'my-node' });
  });

  it('kind=<k> → selector', () => {
    expect(parseTargetArg('kind=swarm-node')).toEqual({ selector: { kind: 'swarm-node' } });
  });

  it('env=<e> → selector', () => {
    expect(parseTargetArg('env=prod')).toEqual({ selector: { env: 'prod' } });
  });

  it('capability=<c> → selector', () => {
    expect(parseTargetArg('capability=gpu')).toEqual({ selector: { capability: 'gpu' } });
  });

  it('tag.<key>=<val> → selector with tag', () => {
    expect(parseTargetArg('tag.role=media')).toEqual({
      selector: { tag: { key: 'role', value: 'media' } },
    });
  });

  it('unrecognised key=val → falls back to plain id', () => {
    // Unknown selector key; treated as literal id
    const result = parseTargetArg('mystery=value');
    expect(result).toEqual({ targetId: 'mystery=value' });
  });

  it('value may contain `=`', () => {
    // kind=foo=bar — everything after the first `=` is the value
    const result = parseTargetArg('kind=foo=bar');
    expect(result).toEqual({ selector: { kind: 'foo=bar' } });
  });
});

// ---------------------------------------------------------------------------
// 3. renderDryRunPlan
// ---------------------------------------------------------------------------

describe('renderDryRunPlan', () => {
  const target = makeTarget({
    id: 'prod-host',
    name: 'Prod Host',
    kind: 'swarm-node',
    provider: 'docker-swarm',
    env: 'prod',
    capabilities: ['gpu'],
    tags: { rack: '3' },
    source: 'discovery',
  });

  it('includes the service name', () => {
    const out = renderDryRunPlan('my-service', target, 'explicit-id');
    expect(out).toContain('my-service');
  });

  it('includes the target id and name', () => {
    const out = renderDryRunPlan('svc', target, 'explicit-id');
    expect(out).toContain('prod-host');
    expect(out).toContain('Prod Host');
  });

  it('includes kind, provider, env', () => {
    const out = renderDryRunPlan('svc', target, 'explicit-id');
    expect(out).toContain('swarm-node');
    expect(out).toContain('docker-swarm');
    expect(out).toContain('prod');
  });

  it('includes capabilities and tags', () => {
    const out = renderDryRunPlan('svc', target, 'explicit-id');
    expect(out).toContain('gpu');
    expect(out).toContain('rack=3');
  });

  it('includes the resolution source', () => {
    const out = renderDryRunPlan('svc', target, 'config-default');
    expect(out).toContain('config-default');
  });

  it('lists the stages that would execute', () => {
    const out = renderDryRunPlan('svc', target, 'explicit-id');
    expect(out).toContain('Safety gate');
    expect(out).toContain('Build artifact');
    expect(out).toContain('Deploy artifact');
    expect(out).toContain('health check');
  });

  it('ends with dry-run complete marker', () => {
    const out = renderDryRunPlan('svc', target, 'explicit-id');
    expect(out).toContain('Dry-run complete');
    expect(out).toContain('No changes were made');
  });

  it('shows (none) for empty capabilities', () => {
    const noCapTarget = makeTarget({ id: 'plain', capabilities: [], tags: {} });
    const out = renderDryRunPlan('svc', noCapTarget, 'fallback');
    expect(out).toMatch(/Capabilities:\s+\(none\)/);
    expect(out).toMatch(/Tags:\s+\(none\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. runDeployService --dry-run
// ---------------------------------------------------------------------------

describe('runDeployService --dry-run', () => {
  it('prints the dry-run plan to stdout and returns 0', async () => {
    const registry = makeRegistry(makeTarget({ id: 'prod-node', name: 'Prod Node' }));
    const streams = makeStreams();

    const code = await runDeployService(
      { service: 'api', targetRaw: 'prod-node', dryRun: true, registry },
      streams,
    );

    expect(code).toBe(0);
    expect(streams.out()).toContain('Dry-run');
    expect(streams.out()).toContain('prod-node');
    expect(streams.out()).toContain('api');
    expect(streams.err()).toBe('');
  });

  it('resolves via selector in dry-run mode', async () => {
    const registry = makeRegistry(makeTarget({ id: 'gpu-box', capabilities: ['gpu'] }));
    const streams = makeStreams();

    const code = await runDeployService(
      { service: 'ml-train', targetRaw: 'capability=gpu', dryRun: true, registry },
      streams,
    );

    expect(code).toBe(0);
    expect(streams.out()).toContain('gpu-box');
    expect(streams.out()).toContain('ml-train');
    expect(streams.out()).toContain('Dry-run complete');
  });

  it('resolves via kind selector in dry-run mode', async () => {
    const registry = makeRegistry(makeTarget({ id: 'k3s-01', kind: 'k3s-cluster' }));
    const streams = makeStreams();

    const code = await runDeployService(
      { service: 'web', targetRaw: 'kind=k3s-cluster', dryRun: true, registry },
      streams,
    );

    expect(code).toBe(0);
    expect(streams.out()).toContain('k3s-01');
  });

  it('resolves via env selector in dry-run mode', async () => {
    const registry = makeRegistry(makeTarget({ id: 'staging-node', env: 'staging' }));
    const streams = makeStreams();

    const code = await runDeployService(
      { service: 'auth', targetRaw: 'env=staging', dryRun: true, registry },
      streams,
    );

    expect(code).toBe(0);
    expect(streams.out()).toContain('staging-node');
  });

  it('resolves via tag selector in dry-run mode', async () => {
    const registry = makeRegistry(makeTarget({ id: 'media-node', tags: { role: 'media' } }));
    const streams = makeStreams();

    const code = await runDeployService(
      { service: 'transcoder', targetRaw: 'tag.role=media', dryRun: true, registry },
      streams,
    );

    expect(code).toBe(0);
    expect(streams.out()).toContain('media-node');
  });

  it('dry-run writes nothing to stderr on success', async () => {
    const registry = makeRegistry(makeTarget({ id: 'clean' }));
    const streams = makeStreams();

    await runDeployService({ service: 'svc', targetRaw: 'clean', dryRun: true, registry }, streams);

    expect(streams.err()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 5. runDeployService without --dry-run (#662: --confirm required)
// ---------------------------------------------------------------------------

describe('runDeployService without --dry-run', () => {
  it('without --confirm: writes error to stderr and returns 1', async () => {
    const registry = makeRegistry(makeTarget({ id: 'live-node', name: 'Live Node' }));
    const streams = makeStreams();

    const code = await runDeployService(
      { service: 'api', targetRaw: 'live-node', dryRun: false, registry },
      streams,
    );

    expect(code).toBe(1);
    expect(streams.err()).toContain('--confirm');
    expect(streams.err()).toContain('refusing to execute');
  });

  it('with --confirm: runs the pipeline and returns 0 on success', async () => {
    const registry = makeRegistry(makeTarget({ id: 'live-node', name: 'Live Node' }));
    const streams = makeStreams();

    const mockBackend = {
      id: 'mock-backend',
      supports: () => true,
      deploy: jest.fn().mockResolvedValue({ success: true, message: 'ok', details: {} }),
    };

    const code = await runDeployService(
      {
        service: 'api',
        targetRaw: 'live-node',
        dryRun: false,
        confirm: true,
        registry,
        _backendOverride: mockBackend,
      },
      streams,
    );

    expect(code).toBe(0);
    expect(streams.out()).toContain('live-node');
    expect(streams.out()).toContain('api');
    expect(streams.out()).toContain('SUCCESS');
  });

  it('with --confirm: returns 1 when pipeline fails', async () => {
    const registry = makeRegistry(makeTarget({ id: 'bad-node', name: 'Bad Node' }));
    const streams = makeStreams();

    const failingBackend = {
      id: 'failing-backend',
      supports: () => true,
      deploy: jest
        .fn()
        .mockResolvedValue({ success: false, message: 'deploy failed', details: {} }),
    };

    const code = await runDeployService(
      {
        service: 'api',
        targetRaw: 'bad-node',
        dryRun: false,
        confirm: true,
        registry,
        _backendOverride: failingBackend,
      },
      streams,
    );

    expect(code).toBe(1);
    expect(streams.err()).toContain('Deploy failed');
  });

  it('with --dry-run and --confirm: --dry-run takes precedence (no mutation)', async () => {
    const registry = makeRegistry(makeTarget({ id: 'safe-node' }));
    const streams = makeStreams();

    const mutatingBackend = {
      id: 'mutating-backend',
      supports: () => true,
      deploy: jest.fn().mockResolvedValue({ success: true, details: {} }),
    };

    const code = await runDeployService(
      {
        service: 'svc',
        targetRaw: 'safe-node',
        dryRun: true,
        confirm: true,
        registry,
        _backendOverride: mutatingBackend,
      },
      streams,
    );

    expect(code).toBe(0);
    expect(mutatingBackend.deploy).not.toHaveBeenCalled();
    expect(streams.out()).toContain('dry-run');
  });
});

// ---------------------------------------------------------------------------
// 6. runDeployService error paths
// ---------------------------------------------------------------------------

describe('runDeployService error paths', () => {
  it('unknown target id → writes error to stderr, returns 1', async () => {
    const registry = makeRegistry(makeTarget({ id: 'real' }));
    const streams = makeStreams();

    const code = await runDeployService(
      { service: 'svc', targetRaw: 'ghost', dryRun: true, registry },
      streams,
    );

    expect(code).toBe(1);
    expect(streams.err()).toContain('ghost');
    expect(streams.err()).toContain('real');
  });

  it('ambiguous selector → writes error to stderr, returns 1', async () => {
    const registry = makeRegistry(
      makeTarget({ id: 'a', kind: 'swarm-node' }),
      makeTarget({ id: 'b', kind: 'swarm-node' }),
    );
    const streams = makeStreams();

    const code = await runDeployService(
      { service: 'svc', targetRaw: 'kind=swarm-node', dryRun: true, registry },
      streams,
    );

    expect(code).toBe(1);
    expect(streams.err()).toContain('Ambiguous');
    expect(streams.err()).toMatch(/a|b/);
  });

  it('no matching selector → writes error to stderr, returns 1', async () => {
    const registry = makeRegistry(makeTarget({ id: 'local', kind: 'local-pr' }));
    const streams = makeStreams();

    const code = await runDeployService(
      { service: 'svc', targetRaw: 'kind=k3s-cluster', dryRun: true, registry },
      streams,
    );

    expect(code).toBe(1);
    expect(streams.err()).toContain('No targets matched');
  });

  it('no --target and multiple targets → writes error to stderr, returns 1', async () => {
    const registry = makeRegistry(makeTarget({ id: 'x' }), makeTarget({ id: 'y' }));
    const streams = makeStreams();

    const code = await runDeployService({ service: 'svc', dryRun: true, registry }, streams);

    expect(code).toBe(1);
    expect(streams.err()).toBeTruthy();
  });

  it('no --target and no targets registered → writes error to stderr, returns 1', async () => {
    const registry = new InMemoryDeployTargetRegistry();
    const streams = makeStreams();

    const code = await runDeployService({ service: 'svc', dryRun: true, registry }, streams);

    expect(code).toBe(1);
    expect(streams.err()).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 7. Commander registration
// ---------------------------------------------------------------------------

describe('registerDeployTargetsCommand — commander integration', () => {
  function makeProgram(): Command {
    return new Command('autonomous-dev').exitOverride();
  }

  it('registers `deploy targets list` subcommand', () => {
    const program = makeProgram();
    registerDeployTargetsCommand(program);

    const deployCmd = program.commands.find((c) => c.name() === 'deploy');
    expect(deployCmd).toBeDefined();
    const targetsCmd = deployCmd!.commands.find((c) => c.name() === 'targets');
    expect(targetsCmd).toBeDefined();
    const listCmd = targetsCmd!.commands.find((c) => c.name() === 'list');
    expect(listCmd).toBeDefined();
  });

  it('registers `deploy run` subcommand', () => {
    const program = makeProgram();
    registerDeployTargetsCommand(program);

    const deployCmd = program.commands.find((c) => c.name() === 'deploy');
    const runCmd = deployCmd!.commands.find((c) => c.name() === 'run');
    expect(runCmd).toBeDefined();
  });

  it('`deploy targets list` executes without error on an empty registry', async () => {
    const program = makeProgram();
    const registry = new InMemoryDeployTargetRegistry();
    const streams = makeStreams();
    registerDeployTargetsCommand(program, { registry }, streams);

    await program.parseAsync(['node', 'cli', 'deploy', 'targets', 'list']);
    expect(streams.out()).toMatch(/no targets registered/);
  });

  it('`deploy targets list --json` emits JSON', async () => {
    const program = makeProgram();
    const registry = makeRegistry(makeTarget({ id: 'abc', name: 'ABC' }));
    const streams = makeStreams();
    registerDeployTargetsCommand(program, { registry }, streams);

    await program.parseAsync(['node', 'cli', 'deploy', 'targets', 'list', '--json']);
    const parsed = JSON.parse(streams.out()) as { targets: DeployTarget[] };
    expect(parsed.targets).toHaveLength(1);
    expect(parsed.targets[0].id).toBe('abc');
  });

  it('`deploy run --dry-run --target <id>` executes dry-run', async () => {
    const program = makeProgram();
    const registry = makeRegistry(makeTarget({ id: 'tgt', name: 'Tgt' }));
    const streams = makeStreams();
    registerDeployTargetsCommand(program, { registry }, streams);

    await program.parseAsync([
      'node',
      'cli',
      'deploy',
      'run',
      'my-svc',
      '--target',
      'tgt',
      '--dry-run',
    ]);
    expect(streams.out()).toContain('Dry-run');
    expect(streams.out()).toContain('tgt');
    expect(streams.out()).toContain('my-svc');
  });

  it('attaches to the existing deploy group when one already exists', () => {
    const program = makeProgram();
    // Pre-create the deploy group (as deploy_plan_command does)
    program.command('deploy').description('Deployment operations').exitOverride();

    registerDeployTargetsCommand(program);

    // Should not create a second 'deploy' group
    const deployCmds = program.commands.filter((c) => c.name() === 'deploy');
    expect(deployCmds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Invariant #674 — list always reflects live topology
// ---------------------------------------------------------------------------

describe('deploy targets list — dynamic / live (#674)', () => {
  it('reflects newly-discovered targets on subsequent list calls', async () => {
    const mutableTargets: DeployTarget[] = [makeTarget({ id: 'node-a' })];
    const provider: TargetProvider = {
      id: 'live-provider',
      listTargets: async () => [...mutableTargets],
    };
    const registry = new InMemoryDeployTargetRegistry();
    registry.registerProvider(provider);

    const streams1 = makeStreams();
    await runDeployTargetsList({}, { registry }, streams1);
    expect(streams1.out()).toContain('node-a');
    expect(streams1.out()).not.toContain('node-b');

    // A new node is discovered
    mutableTargets.push(makeTarget({ id: 'node-b' }));

    const streams2 = makeStreams();
    await runDeployTargetsList({}, { registry }, streams2);
    expect(streams2.out()).toContain('node-a');
    expect(streams2.out()).toContain('node-b');
  });

  it('removed targets disappear from subsequent list calls', async () => {
    const mutableTargets: DeployTarget[] = [
      makeTarget({ id: 'node-1' }),
      makeTarget({ id: 'node-2' }),
    ];
    const provider: TargetProvider = {
      id: 'live',
      listTargets: async () => [...mutableTargets],
    };
    const registry = new InMemoryDeployTargetRegistry();
    registry.registerProvider(provider);

    const streams1 = makeStreams();
    await runDeployTargetsList({ json: true }, { registry }, streams1);
    expect(JSON.parse(streams1.out()).targets).toHaveLength(2);

    // node-1 decommissioned
    mutableTargets.splice(0, 1);

    const streams2 = makeStreams();
    await runDeployTargetsList({ json: true }, { registry }, streams2);
    const targets = JSON.parse(streams2.out()).targets as DeployTarget[];
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe('node-2');
  });

  it('config targets and dynamic provider targets appear together', async () => {
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(makeTarget({ id: 'cfg-node', source: 'config' }));
    registry.registerProvider({
      id: 'dynamic',
      listTargets: async () => [makeTarget({ id: 'dyn-node', source: 'discovery' })],
    });

    const streams = makeStreams();
    await runDeployTargetsList({ json: true }, { registry }, streams);
    const parsed = JSON.parse(streams.out()) as { targets: DeployTarget[] };
    const ids = parsed.targets.map((t) => t.id);
    expect(ids).toContain('cfg-node');
    expect(ids).toContain('dyn-node');
  });
});
