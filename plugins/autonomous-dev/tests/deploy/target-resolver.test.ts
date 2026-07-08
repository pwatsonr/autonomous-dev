/**
 * Tests for `resolveTarget` (issue #660, target-resolver.ts).
 *
 * Coverage:
 *   1. Priority 1 — explicit id: found, not found (lists available ids)
 *   2. Priority 2 — selector: unique match, ambiguous (>1 match), no match
 *   3. Priority 3 — config-default: found, not found
 *   4. Priority 4 — fallback: exactly one target, zero targets, many targets
 *   5. Registry injection (production singleton isolation)
 *   6. Error classes carry actionable metadata (available / matches lists)
 *   7. Dynamic: resolveTarget reflects live provider state on each call
 *
 * @module tests/deploy/target-resolver.test
 */

import {
  resolveTarget,
  UnknownTargetError,
  AmbiguousTargetError,
  NoMatchingTargetError,
  NoDefaultTargetError,
} from '../../intake/deploy/target-resolver';
import {
  InMemoryDeployTargetRegistry,
  resetDeployTargetRegistry,
  setDeployTargetRegistry,
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

// ---------------------------------------------------------------------------
// Reset the global singleton between tests.
// ---------------------------------------------------------------------------

afterEach(() => {
  resetDeployTargetRegistry();
});

// ---------------------------------------------------------------------------
// 1. Priority 1 — explicit id
// ---------------------------------------------------------------------------

describe('resolveTarget — explicit id (priority 1)', () => {
  it('returns the target when the id exists', async () => {
    const t = makeTarget({ id: 'prod-node', name: 'Prod Node' });
    const registry = makeRegistry(t);

    const result = await resolveTarget({ targetId: 'prod-node', registry });

    expect(result.target.id).toBe('prod-node');
    expect(result.source).toBe('explicit-id');
  });

  it('throws UnknownTargetError when the id does not exist', async () => {
    const t = makeTarget({ id: 'other-node' });
    const registry = makeRegistry(t);

    await expect(resolveTarget({ targetId: 'ghost-node', registry })).rejects.toThrow(
      UnknownTargetError,
    );
  });

  it('UnknownTargetError lists available ids', async () => {
    const registry = makeRegistry(
      makeTarget({ id: 'node-a' }),
      makeTarget({ id: 'node-b' }),
    );

    let err: UnknownTargetError | undefined;
    try {
      await resolveTarget({ targetId: 'missing', registry });
    } catch (e) {
      err = e as UnknownTargetError;
    }

    expect(err).toBeInstanceOf(UnknownTargetError);
    expect(err!.available).toContain('node-a');
    expect(err!.available).toContain('node-b');
    expect(err!.requested).toBe('missing');
  });

  it('explicit id takes priority over selector', async () => {
    const byId = makeTarget({ id: 'by-id', kind: 'swarm-node' });
    const bySelector = makeTarget({ id: 'by-selector', kind: 'swarm-node' });
    const registry = makeRegistry(byId, bySelector);

    // Without targetId the selector would be ambiguous; with targetId it resolves
    const result = await resolveTarget({
      targetId: 'by-id',
      selector: { kind: 'swarm-node' },
      registry,
    });

    expect(result.target.id).toBe('by-id');
    expect(result.source).toBe('explicit-id');
  });

  it('treats empty string targetId as absent (falls through)', async () => {
    const t = makeTarget({ id: 'only-target' });
    const registry = makeRegistry(t);

    // Empty string should be treated as "not set" → fallback to single target
    const result = await resolveTarget({ targetId: '', registry });

    expect(result.target.id).toBe('only-target');
    expect(result.source).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// 2. Priority 2 — selector
// ---------------------------------------------------------------------------

describe('resolveTarget — selector (priority 2)', () => {
  it('returns the unique match for a selector', async () => {
    const gpu = makeTarget({ id: 'gpu-node', capabilities: ['gpu'] });
    const plain = makeTarget({ id: 'plain-node', capabilities: [] });
    const registry = makeRegistry(gpu, plain);

    const result = await resolveTarget({
      selector: { capability: 'gpu' },
      registry,
    });

    expect(result.target.id).toBe('gpu-node');
    expect(result.source).toBe('explicit-selector');
  });

  it('throws AmbiguousTargetError when >1 targets match', async () => {
    const registry = makeRegistry(
      makeTarget({ id: 'a', kind: 'swarm-node' }),
      makeTarget({ id: 'b', kind: 'swarm-node' }),
    );

    await expect(
      resolveTarget({ selector: { kind: 'swarm-node' }, registry }),
    ).rejects.toThrow(AmbiguousTargetError);
  });

  it('AmbiguousTargetError lists matching ids', async () => {
    const registry = makeRegistry(
      makeTarget({ id: 'alpha', kind: 'k3s-cluster' }),
      makeTarget({ id: 'beta', kind: 'k3s-cluster' }),
    );

    let err: AmbiguousTargetError | undefined;
    try {
      await resolveTarget({ selector: { kind: 'k3s-cluster' }, registry });
    } catch (e) {
      err = e as AmbiguousTargetError;
    }

    expect(err).toBeInstanceOf(AmbiguousTargetError);
    expect(err!.matches).toContain('alpha');
    expect(err!.matches).toContain('beta');
  });

  it('throws NoMatchingTargetError when 0 targets match', async () => {
    const registry = makeRegistry(makeTarget({ id: 'local-only', kind: 'local-pr' }));

    await expect(
      resolveTarget({ selector: { kind: 'k3s-cluster' }, registry }),
    ).rejects.toThrow(NoMatchingTargetError);
  });

  it('NoMatchingTargetError lists available ids', async () => {
    const registry = makeRegistry(
      makeTarget({ id: 'node-1' }),
      makeTarget({ id: 'node-2' }),
    );

    let err: NoMatchingTargetError | undefined;
    try {
      await resolveTarget({ selector: { kind: 'proxmox-vm' }, registry });
    } catch (e) {
      err = e as NoMatchingTargetError;
    }

    expect(err).toBeInstanceOf(NoMatchingTargetError);
    expect(err!.available).toContain('node-1');
    expect(err!.available).toContain('node-2');
  });

  it('selector matches by tag key/value', async () => {
    const media = makeTarget({ id: 'media-box', tags: { role: 'media' } });
    const db = makeTarget({ id: 'db-box', tags: { role: 'db' } });
    const registry = makeRegistry(media, db);

    const result = await resolveTarget({
      selector: { tag: { key: 'role', value: 'media' } },
      registry,
    });

    expect(result.target.id).toBe('media-box');
    expect(result.source).toBe('explicit-selector');
  });

  it('selector matches by env', async () => {
    const prod = makeTarget({ id: 'prod-target', env: 'prod' });
    const dev = makeTarget({ id: 'dev-target', env: 'dev' });
    const registry = makeRegistry(prod, dev);

    const result = await resolveTarget({
      selector: { env: 'dev' },
      registry,
    });

    expect(result.target.id).toBe('dev-target');
    expect(result.source).toBe('explicit-selector');
  });
});

// ---------------------------------------------------------------------------
// 3. Priority 3 — config-default
// ---------------------------------------------------------------------------

describe('resolveTarget — config-default (priority 3)', () => {
  it('resolves the default target id when no explicit override is given', async () => {
    const main = makeTarget({ id: 'main-node' });
    const other = makeTarget({ id: 'other-node' });
    const registry = makeRegistry(main, other);

    const result = await resolveTarget({
      defaultTargetId: 'main-node',
      registry,
    });

    expect(result.target.id).toBe('main-node');
    expect(result.source).toBe('config-default');
  });

  it('throws UnknownTargetError when the default id is not in the registry', async () => {
    const registry = makeRegistry(makeTarget({ id: 'real-target' }));

    await expect(
      resolveTarget({ defaultTargetId: 'stale-default', registry }),
    ).rejects.toThrow(UnknownTargetError);
  });

  it('explicit targetId overrides defaultTargetId', async () => {
    const explicit = makeTarget({ id: 'explicit' });
    const def = makeTarget({ id: 'default' });
    const registry = makeRegistry(explicit, def);

    const result = await resolveTarget({
      targetId: 'explicit',
      defaultTargetId: 'default',
      registry,
    });

    expect(result.target.id).toBe('explicit');
    expect(result.source).toBe('explicit-id');
  });

  it('treats empty-string defaultTargetId as absent (falls through to fallback)', async () => {
    const t = makeTarget({ id: 'solo' });
    const registry = makeRegistry(t);

    const result = await resolveTarget({ defaultTargetId: '', registry });

    expect(result.target.id).toBe('solo');
    expect(result.source).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// 4. Priority 4 — automatic fallback
// ---------------------------------------------------------------------------

describe('resolveTarget — fallback (priority 4)', () => {
  it('selects the only registered target when nothing else is specified', async () => {
    const t = makeTarget({ id: 'the-only-target' });
    const registry = makeRegistry(t);

    const result = await resolveTarget({ registry });

    expect(result.target.id).toBe('the-only-target');
    expect(result.source).toBe('fallback');
  });

  it('throws NoDefaultTargetError when no targets are registered', async () => {
    const registry = new InMemoryDeployTargetRegistry();

    await expect(resolveTarget({ registry })).rejects.toThrow(NoDefaultTargetError);
  });

  it('throws NoDefaultTargetError when multiple targets are registered and no hint given', async () => {
    const registry = makeRegistry(
      makeTarget({ id: 'a' }),
      makeTarget({ id: 'b' }),
    );

    await expect(resolveTarget({ registry })).rejects.toThrow(NoDefaultTargetError);
  });

  it('NoDefaultTargetError lists available ids when there are multiple targets', async () => {
    const registry = makeRegistry(
      makeTarget({ id: 'x' }),
      makeTarget({ id: 'y' }),
    );

    let err: NoDefaultTargetError | undefined;
    try {
      await resolveTarget({ registry });
    } catch (e) {
      err = e as NoDefaultTargetError;
    }

    expect(err).toBeInstanceOf(NoDefaultTargetError);
    expect(err!.available).toContain('x');
    expect(err!.available).toContain('y');
  });

  it('NoDefaultTargetError with empty registry has empty available list', async () => {
    const registry = new InMemoryDeployTargetRegistry();

    let err: NoDefaultTargetError | undefined;
    try {
      await resolveTarget({ registry });
    } catch (e) {
      err = e as NoDefaultTargetError;
    }

    expect(err).toBeInstanceOf(NoDefaultTargetError);
    expect(err!.available).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Registry injection (production singleton isolation)
// ---------------------------------------------------------------------------

describe('resolveTarget — registry injection', () => {
  it('uses the injected registry, not the singleton', async () => {
    // Populate the singleton with a different target
    const singleton = new InMemoryDeployTargetRegistry();
    singleton.register(makeTarget({ id: 'singleton-target' }));
    setDeployTargetRegistry(singleton);

    // Injected registry has a different target
    const injected = makeRegistry(makeTarget({ id: 'injected-target' }));

    const result = await resolveTarget({ targetId: 'injected-target', registry: injected });

    expect(result.target.id).toBe('injected-target');
  });

  it('falls back to the singleton when no registry is injected', async () => {
    const singletonReg = new InMemoryDeployTargetRegistry();
    singletonReg.register(makeTarget({ id: 'from-singleton' }));
    setDeployTargetRegistry(singletonReg);

    const result = await resolveTarget({ targetId: 'from-singleton' });

    expect(result.target.id).toBe('from-singleton');
  });
});

// ---------------------------------------------------------------------------
// 6. Dynamic: resolveTarget reflects live provider state
// ---------------------------------------------------------------------------

describe('resolveTarget — dynamic / live provider (#674)', () => {
  it('reflects newly-added targets from a provider on subsequent calls', async () => {
    const mutableTargets: DeployTarget[] = [makeTarget({ id: 'node-1' })];
    const provider: TargetProvider = {
      id: 'live',
      listTargets: async () => [...mutableTargets],
    };
    const registry = new InMemoryDeployTargetRegistry();
    registry.registerProvider(provider);

    // First call — only node-1 exists
    const first = await resolveTarget({ targetId: 'node-1', registry });
    expect(first.target.id).toBe('node-1');

    // A new node is discovered dynamically
    mutableTargets.push(makeTarget({ id: 'node-2', capabilities: ['gpu'] }));

    // Second call — node-2 is now available without re-registering anything
    const second = await resolveTarget({
      selector: { capability: 'gpu' },
      registry,
    });
    expect(second.target.id).toBe('node-2');
    expect(second.source).toBe('explicit-selector');
  });

  it('removing a target from a provider makes it unavailable on the next call', async () => {
    const mutableTargets: DeployTarget[] = [
      makeTarget({ id: 'node-a' }),
      makeTarget({ id: 'node-b' }),
    ];
    const provider: TargetProvider = {
      id: 'live',
      listTargets: async () => [...mutableTargets],
    };
    const registry = new InMemoryDeployTargetRegistry();
    registry.registerProvider(provider);

    // Initial state: two targets
    expect(await registry.list()).toHaveLength(2);

    // node-a is decommissioned
    mutableTargets.splice(0, 1);

    // Now node-a is gone from the registry view
    await expect(resolveTarget({ targetId: 'node-a', registry })).rejects.toThrow(
      UnknownTargetError,
    );

    // node-b is still available and is now the only target → fallback works
    const result = await resolveTarget({ registry });
    expect(result.target.id).toBe('node-b');
    expect(result.source).toBe('fallback');
  });
});
