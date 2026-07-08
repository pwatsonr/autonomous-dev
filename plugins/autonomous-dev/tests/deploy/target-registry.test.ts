/**
 * Tests for the DeployTarget model, DeployTargetRegistry, TargetProvider
 * aggregation, resolve() matching, and config-target loading (issues #658 +
 * #659, invariant #674).
 *
 * Structure:
 *   1. matchesSelector() pure matching logic
 *   2. InMemoryDeployTargetRegistry — register / list / get
 *   3. TargetProvider aggregation — dynamic targets, live change reflected
 *   4. resolve() — by tag / capability / kind / env / id
 *   5. loadConfigTargets() — config dimension loading
 *   6. Singleton helpers — getDeployTargetRegistry / setDeployTargetRegistry
 *
 * @module tests/deploy/target-registry.test
 */

import {
  InMemoryDeployTargetRegistry,
  matchesSelector,
  getDeployTargetRegistry,
  setDeployTargetRegistry,
  resetDeployTargetRegistry,
} from '../../intake/deploy/target-registry';
import type {
  DeployTarget,
  TargetSelector,
} from '../../intake/deploy/target-types';
import type { TargetProvider } from '../../intake/deploy/target-registry';
import { loadConfigTargets } from '../../intake/deploy/environment';
import type { DeployConfig } from '../../intake/deploy/types-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    id: 'target-1',
    name: 'Target One',
    kind: 'local-pr',
    provider: 'local',
    capabilities: [],
    tags: {},
    source: 'config',
    ...overrides,
  };
}

function makeProvider(id: string, targets: DeployTarget[]): TargetProvider {
  return {
    id,
    listTargets: async () => targets,
  };
}

// ---------------------------------------------------------------------------
// 1. matchesSelector — pure logic
// ---------------------------------------------------------------------------

describe('matchesSelector', () => {
  const t = makeTarget({
    id: 'host-01',
    kind: 'swarm-node',
    env: 'prod',
    capabilities: ['gpu', 'high-memory'],
    tags: { role: 'media', rack: '2' },
  });

  it('empty selector matches any target', () => {
    expect(matchesSelector(t, {})).toBe(true);
  });

  it('id match — exact', () => {
    expect(matchesSelector(t, { id: 'host-01' })).toBe(true);
    expect(matchesSelector(t, { id: 'host-02' })).toBe(false);
  });

  it('kind match — exact', () => {
    expect(matchesSelector(t, { kind: 'swarm-node' })).toBe(true);
    expect(matchesSelector(t, { kind: 'k3s-cluster' })).toBe(false);
  });

  it('env match — exact', () => {
    expect(matchesSelector(t, { env: 'prod' })).toBe(true);
    expect(matchesSelector(t, { env: 'staging' })).toBe(false);
  });

  it('tag match — key=value', () => {
    expect(matchesSelector(t, { tag: { key: 'role', value: 'media' } })).toBe(true);
    expect(matchesSelector(t, { tag: { key: 'role', value: 'db' } })).toBe(false);
    expect(matchesSelector(t, { tag: { key: 'missing', value: 'x' } })).toBe(false);
  });

  it('capability match — includes', () => {
    expect(matchesSelector(t, { capability: 'gpu' })).toBe(true);
    expect(matchesSelector(t, { capability: 'high-memory' })).toBe(true);
    expect(matchesSelector(t, { capability: 'blue-green' })).toBe(false);
  });

  it('multiple fields — ANDed', () => {
    expect(matchesSelector(t, { kind: 'swarm-node', env: 'prod' })).toBe(true);
    expect(matchesSelector(t, { kind: 'swarm-node', env: 'staging' })).toBe(false);
    expect(matchesSelector(t, { kind: 'swarm-node', capability: 'gpu', env: 'prod' })).toBe(true);
    expect(matchesSelector(t, { kind: 'swarm-node', capability: 'gpu', env: 'dev' })).toBe(false);
  });

  it('target without env does not match an env selector', () => {
    const noEnv = makeTarget({ id: 'no-env', kind: 'static-site' });
    expect(matchesSelector(noEnv, { env: 'prod' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. InMemoryDeployTargetRegistry — register / list / get
// ---------------------------------------------------------------------------

describe('InMemoryDeployTargetRegistry register / list / get', () => {
  let registry: InMemoryDeployTargetRegistry;

  beforeEach(() => {
    registry = new InMemoryDeployTargetRegistry();
  });

  it('list() returns empty array when nothing registered', async () => {
    expect(await registry.list()).toEqual([]);
  });

  it('register() followed by list() returns the target', async () => {
    const t = makeTarget({ id: 'alpha' });
    registry.register(t);
    const all = await registry.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('alpha');
  });

  it('registering a second target by different id adds it', async () => {
    registry.register(makeTarget({ id: 'a' }));
    registry.register(makeTarget({ id: 'b' }));
    const all = await registry.list();
    expect(all.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('registering with an existing id overwrites (idempotent)', async () => {
    registry.register(makeTarget({ id: 'dup', name: 'First' }));
    registry.register(makeTarget({ id: 'dup', name: 'Second' }));
    const all = await registry.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Second');
  });

  it('get() returns the target by id', async () => {
    registry.register(makeTarget({ id: 'find-me' }));
    const found = await registry.get('find-me');
    expect(found).toBeDefined();
    expect(found!.id).toBe('find-me');
  });

  it('get() returns undefined for an unregistered id', async () => {
    expect(await registry.get('ghost')).toBeUndefined();
  });

  it('clear() removes all statics and providers', async () => {
    registry.register(makeTarget({ id: 'x' }));
    registry.registerProvider(makeProvider('p', [makeTarget({ id: 'y' })]));
    registry.clear();
    expect(await registry.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. TargetProvider aggregation — dynamic targets
// ---------------------------------------------------------------------------

describe('InMemoryDeployTargetRegistry provider aggregation', () => {
  let registry: InMemoryDeployTargetRegistry;

  beforeEach(() => {
    registry = new InMemoryDeployTargetRegistry();
  });

  it('provider targets appear in list() after registerProvider()', async () => {
    const dynamicTarget = makeTarget({ id: 'dynamic-1', source: 'discovery' });
    registry.registerProvider(makeProvider('p1', [dynamicTarget]));
    const all = await registry.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('dynamic-1');
    expect(all[0].source).toBe('discovery');
  });

  it('static targets appear before provider targets (statics first)', async () => {
    registry.register(makeTarget({ id: 'static-a' }));
    registry.registerProvider(makeProvider('p1', [makeTarget({ id: 'dynamic-b' })]));
    const ids = (await registry.list()).map((t) => t.id);
    expect(ids[0]).toBe('static-a');
    expect(ids[1]).toBe('dynamic-b');
  });

  it('list() re-queries the provider on every call (live updates reflected)', async () => {
    // Simulates a homelab provider whose node list changes between calls.
    const mutableTargets: DeployTarget[] = [makeTarget({ id: 'node-1' })];
    const provider: TargetProvider = {
      id: 'live-provider',
      listTargets: async () => [...mutableTargets],
    };
    registry.registerProvider(provider);

    // First call: one target.
    expect(await registry.list()).toHaveLength(1);

    // Node is added (discovery found a new node).
    mutableTargets.push(makeTarget({ id: 'node-2', name: 'Node Two' }));

    // Second call: two targets, reflecting the live change.
    const second = await registry.list();
    expect(second).toHaveLength(2);
    expect(second.map((t) => t.id).sort()).toEqual(['node-1', 'node-2']);
  });

  it('a failing provider is skipped; other providers still contribute', async () => {
    const failingProvider: TargetProvider = {
      id: 'failing',
      listTargets: async () => {
        throw new Error('unreachable host');
      },
    };
    const goodProvider = makeProvider('good', [makeTarget({ id: 'healthy-1' })]);
    registry.registerProvider(failingProvider);
    registry.registerProvider(goodProvider);

    // Should not throw; failing provider's entries are absent.
    const all = await registry.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('healthy-1');
  });

  it('re-registering a provider with the same id replaces it', async () => {
    registry.registerProvider(makeProvider('p', [makeTarget({ id: 'old' })]));
    registry.registerProvider(makeProvider('p', [makeTarget({ id: 'new' })]));
    const all = await registry.list();
    expect(all.map((t) => t.id)).toEqual(['new']);
  });

  it('multiple providers are queried concurrently and all contribute', async () => {
    registry.registerProvider(makeProvider('p1', [makeTarget({ id: 't1' })]));
    registry.registerProvider(makeProvider('p2', [makeTarget({ id: 't2' })]));
    registry.registerProvider(makeProvider('p3', [makeTarget({ id: 't3' })]));
    const ids = (await registry.list()).map((t) => t.id).sort();
    expect(ids).toEqual(['t1', 't2', 't3']);
  });
});

// ---------------------------------------------------------------------------
// 4. resolve() — selector matching
// ---------------------------------------------------------------------------

describe('InMemoryDeployTargetRegistry resolve()', () => {
  let registry: InMemoryDeployTargetRegistry;

  beforeEach(() => {
    registry = new InMemoryDeployTargetRegistry();
    registry.register(
      makeTarget({
        id: 'swarm-01',
        kind: 'swarm-node',
        env: 'prod',
        capabilities: ['gpu'],
        tags: { role: 'media', location: 'rack-2' },
      }),
    );
    registry.register(
      makeTarget({
        id: 'swarm-02',
        kind: 'swarm-node',
        env: 'staging',
        capabilities: ['high-memory'],
        tags: { role: 'encode', location: 'rack-2' },
      }),
    );
    registry.register(
      makeTarget({
        id: 'k3s-01',
        kind: 'k3s-cluster',
        env: 'prod',
        capabilities: ['rolling-update'],
        tags: { role: 'web', location: 'rack-1' },
      }),
    );
  });

  it('empty selector returns all targets', async () => {
    expect(await registry.resolve({})).toHaveLength(3);
  });

  it('resolve by kind', async () => {
    const r = await registry.resolve({ kind: 'swarm-node' });
    expect(r.map((t) => t.id).sort()).toEqual(['swarm-01', 'swarm-02']);
  });

  it('resolve by env', async () => {
    const r = await registry.resolve({ env: 'prod' });
    expect(r.map((t) => t.id).sort()).toEqual(['k3s-01', 'swarm-01']);
  });

  it('resolve by capability', async () => {
    const r = await registry.resolve({ capability: 'gpu' });
    expect(r.map((t) => t.id)).toEqual(['swarm-01']);
  });

  it('resolve by tag', async () => {
    const r = await registry.resolve({ tag: { key: 'role', value: 'media' } });
    expect(r.map((t) => t.id)).toEqual(['swarm-01']);
  });

  it('resolve by id', async () => {
    const r = await registry.resolve({ id: 'k3s-01' });
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('k3s-01');
  });

  it('resolve with no match returns empty array', async () => {
    expect(await registry.resolve({ kind: 'proxmox-vm' })).toEqual([]);
  });

  it('resolve combines kind + env (AND)', async () => {
    const r = await registry.resolve({ kind: 'swarm-node', env: 'prod' });
    expect(r.map((t) => t.id)).toEqual(['swarm-01']);
  });

  it('resolve includes provider targets', async () => {
    const dynamicTarget = makeTarget({
      id: 'dynamic-gpu',
      kind: 'proxmox-vm',
      capabilities: ['gpu'],
      source: 'discovery',
      tags: {},
    });
    registry.registerProvider(makeProvider('homelab', [dynamicTarget]));
    const r = await registry.resolve({ capability: 'gpu' });
    expect(r.map((t) => t.id).sort()).toEqual(['dynamic-gpu', 'swarm-01']);
  });
});

// ---------------------------------------------------------------------------
// 5. loadConfigTargets()
// ---------------------------------------------------------------------------

describe('loadConfigTargets', () => {
  it('returns empty array when config is null', () => {
    const r = new InMemoryDeployTargetRegistry();
    const loaded = loadConfigTargets(null, r);
    expect(loaded).toEqual([]);
  });

  it('returns empty array when config has no targets key (v1 doc)', () => {
    const cfg: DeployConfig = {
      version: '1.0',
      environments: {
        dev: { backend: 'local', approval: 'none', cost_cap_usd: 0 },
      },
    };
    const r = new InMemoryDeployTargetRegistry();
    expect(loadConfigTargets(cfg, r)).toEqual([]);
  });

  it('returns empty array when targets is an empty array', () => {
    const cfg: DeployConfig = {
      version: '2.0',
      environments: {
        dev: { backend: 'local', approval: 'none', cost_cap_usd: 0 },
      },
      targets: [],
    };
    const r = new InMemoryDeployTargetRegistry();
    expect(loadConfigTargets(cfg, r)).toEqual([]);
  });

  it('registers all targets from config and stamps source as "config"', async () => {
    const t1: DeployTarget = makeTarget({
      id: 'cloud-prod',
      name: 'Cloud Prod',
      kind: 'cloud-run-service',
      provider: 'gcp',
      source: 'discovery', // will be overwritten to 'config'
    });
    const t2: DeployTarget = makeTarget({
      id: 'local-dev',
      name: 'Local Dev',
      kind: 'local-pr',
      provider: 'local',
      source: 'discovery',
    });
    const cfg: DeployConfig = {
      version: '2.0',
      environments: {
        dev: { backend: 'local', approval: 'none', cost_cap_usd: 0 },
      },
      targets: [t1, t2],
    };

    const r = new InMemoryDeployTargetRegistry();
    const loaded = loadConfigTargets(cfg, r);

    expect(loaded).toHaveLength(2);
    // Returned targets have source: 'config'
    expect(loaded[0].source).toBe('config');
    expect(loaded[1].source).toBe('config');

    // Registry can retrieve them
    const all = await r.list();
    expect(all.map((x) => x.id).sort()).toEqual(['cloud-prod', 'local-dev']);
    // source is stamped
    all.forEach((x) => expect(x.source).toBe('config'));
  });

  it('does not mutate the original target object', () => {
    const t: DeployTarget = makeTarget({ id: 't', source: 'discovery' });
    const cfg: DeployConfig = {
      version: '2.0',
      environments: { dev: { backend: 'local', approval: 'none', cost_cap_usd: 0 } },
      targets: [t],
    };
    const r = new InMemoryDeployTargetRegistry();
    loadConfigTargets(cfg, r);
    // Original target's source must not have been mutated
    expect(t.source).toBe('discovery');
  });
});

// ---------------------------------------------------------------------------
// 6. Singleton helpers
// ---------------------------------------------------------------------------

describe('getDeployTargetRegistry / setDeployTargetRegistry / resetDeployTargetRegistry', () => {
  afterEach(() => {
    resetDeployTargetRegistry();
  });

  it('getDeployTargetRegistry returns an InMemoryDeployTargetRegistry by default', async () => {
    const reg = getDeployTargetRegistry();
    expect(reg).toBeDefined();
    expect(typeof reg.list).toBe('function');
    expect(typeof reg.register).toBe('function');
    expect(typeof reg.registerProvider).toBe('function');
    expect(typeof reg.resolve).toBe('function');
    expect(typeof reg.get).toBe('function');
  });

  it('setDeployTargetRegistry replaces the singleton', async () => {
    const custom = new InMemoryDeployTargetRegistry();
    custom.register(makeTarget({ id: 'injected' }));
    setDeployTargetRegistry(custom);

    const reg = getDeployTargetRegistry();
    const all = await reg.list();
    expect(all.map((t) => t.id)).toContain('injected');
  });

  it('resetDeployTargetRegistry restores a fresh empty registry', async () => {
    const custom = new InMemoryDeployTargetRegistry();
    custom.register(makeTarget({ id: 'should-be-gone' }));
    setDeployTargetRegistry(custom);

    resetDeployTargetRegistry();

    const reg = getDeployTargetRegistry();
    expect(await reg.list()).toEqual([]);
  });

  it('singleton is isolated between reset calls', async () => {
    const reg1 = getDeployTargetRegistry();
    reg1.register(makeTarget({ id: 'r1-target' }));

    resetDeployTargetRegistry();

    const reg2 = getDeployTargetRegistry();
    // reg2 is a fresh instance — r1-target must not be visible
    expect(await reg2.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. DeployTarget model — open string fields (invariant #674 compliance)
// ---------------------------------------------------------------------------

describe('DeployTarget model — open strings (invariant #674)', () => {
  it('accepts arbitrary kind strings without a schema change', () => {
    const kinds = ['swarm-node', 'k3s-cluster', 'proxmox-vm', 'unraid', 'cloud-run-service'];
    for (const kind of kinds) {
      const t = makeTarget({ id: `t-${kind}`, kind });
      expect(t.kind).toBe(kind);
    }
  });

  it('accepts arbitrary capability tokens', () => {
    const caps = ['gpu', 'high-memory', 'production-tier', 'blue-green', 'rolling-update'];
    const t = makeTarget({ id: 'cap-test', capabilities: caps });
    expect(t.capabilities).toEqual(caps);
  });

  it('accepts arbitrary source labels from plugins', () => {
    const t = makeTarget({ id: 'src-test', source: 'homelab-docker-v2' });
    expect(t.source).toBe('homelab-docker-v2');
  });

  it('tags are arbitrary key/value strings', () => {
    const tags = { gpu: 'true', 'memory-gb': '64', rack: '3', 'custom-label': 'value' };
    const t = makeTarget({ id: 'tag-test', tags });
    expect(t.tags).toEqual(tags);
  });

  it('connectionRef is untyped and accepts any shape', () => {
    const ref = { host: '10.0.0.1', port: 2376, tls: true };
    const t = makeTarget({ id: 'conn-test', connectionRef: ref });
    expect(t.connectionRef).toEqual(ref);
  });
});
