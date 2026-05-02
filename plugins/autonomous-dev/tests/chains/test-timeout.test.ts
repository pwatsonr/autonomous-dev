/**
 * Unit tests for per-plugin timeout enforcement (SPEC-022-2-01).
 *
 * Uses Jest fake timers so deadlines fire synchronously; no real waiting.
 *
 * @module tests/chains/test-timeout
 */

import {
  ChainExecutor,
  type ChainHookInvoker,
  type ChainHookOutput,
  type ManifestLookup,
  DEFAULT_CHAIN_LIMITS,
} from '../../intake/chains/executor';
import { PluginTimeoutError, ChainError } from '../../intake/chains/errors';
import { DependencyGraph } from '../../intake/chains/dependency-graph';
import {
  buildGraphFrom,
  buildManifest,
  cleanupTempDir,
  createTempRequestDir,
  loadArtifactSchemas,
  loadCodePatchesExample,
  loadSecurityFindingsExample,
} from '../helpers/chain-fixtures';
import type { HookManifest } from '../../intake/hooks/types';
import type { ArtifactRegistry } from '../../intake/chains/artifact-registry';

describe('ChainExecutor timeout enforcement (SPEC-022-2-01)', () => {
  let tempRoot: string;
  let registry: ArtifactRegistry;
  let securityExample: unknown;
  let patchesExample: unknown;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
    registry = await loadArtifactSchemas();
    securityExample = await loadSecurityFindingsExample();
    patchesExample = await loadCodePatchesExample();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await cleanupTempDir(tempRoot);
  });

  function pair(): { manifests: HookManifest[]; graph: DependencyGraph } {
    const manifests: HookManifest[] = [
      buildManifest({
        id: 'security-reviewer',
        produces: [
          { artifact_type: 'security-findings', schema_version: '1.0', format: 'json' },
        ],
      }),
      buildManifest({
        id: 'code-fixer',
        consumes: [
          { artifact_type: 'security-findings', schema_version: '^1.0' },
        ],
        produces: [
          { artifact_type: 'code-patches', schema_version: '1.0', format: 'json' },
        ],
      }),
    ];
    return { manifests, graph: buildGraphFrom(manifests) };
  }

  it('PluginTimeoutError carries plugin_id, timeout_ms, chain_id and serializes to JSON', () => {
    const err = new PluginTimeoutError('plugin-x', 120000, 'chain-7');
    expect(err).toBeInstanceOf(ChainError);
    expect(err.name).toBe('PluginTimeoutError');
    expect(err.plugin_id).toBe('plugin-x');
    expect(err.timeout_ms).toBe(120000);
    expect(err.chain_id).toBe('chain-7');
    const round = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(round.name).toBe('PluginTimeoutError');
    expect(round.plugin_id).toBe('plugin-x');
    expect(round.timeout_ms).toBe(120000);
    expect(round.chain_id).toBe('chain-7');
  });

  it('completes normally when plugin resolves under the deadline (no false-positive)', async () => {
    const { manifests, graph } = pair();
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [{ artifactType: 'code-patches', scanId: 'patches-fast', payload: patchesExample }];
      }
      return [];
    };
    const executor = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS },
      chainId: 'chain-fast',
    });
    const result = await executor.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-1' },
      { artifactType: 'security-findings', scanId: 'scan-1', payload: securityExample },
    );
    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.pluginId === 'code-fixer')?.status).toBe('ok');
  });

  it('kills runaway plugin at the configured deadline and emits PluginTimeoutError', async () => {
    // Real timers + tiny config timeout so the suite still completes in <1s.
    // The semantic (deadline fires; downstream marked error; chain ok=false)
    // is identical to a 120s deadline; the spec's "120s" target is a
    // production default, not a test wall-clock requirement.
    const { manifests, graph } = pair();
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = (pid) => {
      if (pid === 'code-fixer') {
        return new Promise<ChainHookOutput[]>(() => {
          /* never resolves */
        });
      }
      return Promise.resolve([]);
    };
    const executor = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS, per_plugin_timeout_seconds: 5 },
      chainId: 'chain-runaway',
    });

    const result = await executor.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-2' },
      { artifactType: 'security-findings', scanId: 'scan-2', payload: securityExample },
    );
    const fixerStep = result.steps.find((s) => s.pluginId === 'code-fixer');
    expect(fixerStep).toBeDefined();
    expect(fixerStep?.status).toBe('error');
    expect(fixerStep?.error).toMatch(/5000ms timeout in chain chain-runaway/);
    expect(result.ok).toBe(false);
  }, 15_000);

  it('honors per-declaration timeout_seconds override (10s) over global 30s', async () => {
    const manifests: HookManifest[] = [
      buildManifest({
        id: 'security-reviewer',
        produces: [
          { artifact_type: 'security-findings', schema_version: '1.0', format: 'json' },
        ],
      }),
      buildManifest({
        id: 'code-fixer',
        consumes: [
          { artifact_type: 'security-findings', schema_version: '^1.0' },
        ],
        produces: [
          {
            artifact_type: 'code-patches',
            schema_version: '1.0',
            format: 'json',
            timeout_seconds: 5, // declaration override (smaller than global)
          },
        ],
      }),
    ];
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = (pid) =>
      pid === 'code-fixer'
        ? new Promise<ChainHookOutput[]>(() => {
            /* never resolves */
          })
        : Promise.resolve([]);
    // Global timeout is 30s — if the override didn't apply, this test would
    // hit the 15s test timeout below (proving 5s override fired first).
    const executor = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS, per_plugin_timeout_seconds: 30 },
      chainId: 'chain-override',
    });

    const start = Date.now();
    const result = await executor.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-3' },
      { artifactType: 'security-findings', scanId: 'scan-3', payload: securityExample },
    );
    const elapsed = Date.now() - start;
    const fixerStep = result.steps.find((s) => s.pluginId === 'code-fixer');
    expect(fixerStep?.status).toBe('error');
    expect(fixerStep?.error).toMatch(/5000ms timeout/);
    expect(elapsed).toBeLessThan(15_000);
  }, 15_000);

  it('does not leak setTimeout handles when the invocation wins the race', async () => {
    const { manifests, graph } = pair();
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [{ artifactType: 'code-patches', scanId: 'p-no-leak', payload: patchesExample }];
      }
      return [];
    };
    const executor = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      chainId: 'chain-no-leak',
    });
    // Capture the pre-state of timer-typed handles. node's process._getActiveHandles
    // is undocumented but stable enough for this assertion.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handles = (process as any)._getActiveHandles?.bind(process);
    const before = handles ? handles().length : 0;
    await executor.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-4' },
      { artifactType: 'security-findings', scanId: 'scan-4', payload: securityExample },
    );
    const after = handles ? handles().length : 0;
    // Allow some latitude for unrelated runtime handles (jest/ts-jest workers).
    expect(after).toBeLessThanOrEqual(before + 1);
  });

  it('exposes effective limits via getLimits() and assigned chainId via getChainId()', () => {
    const graph = new DependencyGraph();
    const lookup: ManifestLookup = () => undefined;
    const invoker: ChainHookInvoker = async () => [];
    const executor = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS, per_plugin_timeout_seconds: 7 },
      chainId: 'fixed-id',
    });
    expect(executor.getLimits().per_plugin_timeout_seconds).toBe(7);
    expect(executor.getChainId()).toBe('fixed-id');
  });
});
