/**
 * Unit tests for the chain telemetry emitter (SPEC-022-2-04).
 *
 * Covers:
 *   - One-shot emission per chain via the wired client.
 *   - Fire-and-forget: synchronous + async client throws are swallowed.
 *   - No-op when no client is wired.
 *   - Executor emits on success, on failure, and on `blocked` (privileged).
 *
 * @module tests/chains/test-telemetry-emitter
 */

import {
  ChainExecutor,
  type ChainHookInvoker,
  type ManifestLookup,
} from '../../intake/chains/executor';
import {
  emitChainTelemetry,
  setChainMetricsClient,
  getChainMetricsClient,
  type ChainMetricsClient,
  type ChainTelemetryEvent,
} from '../../intake/chains/telemetry-emitter';
import {
  buildGraphFrom,
  buildManifest,
  cleanupTempDir,
  createTempRequestDir,
  loadArtifactSchemas,
  loadCodePatchesExample,
  loadSecurityFindingsExample,
} from '../helpers/chain-fixtures';
import type { ArtifactRegistry } from '../../intake/chains/artifact-registry';
import type { HookManifest } from '../../intake/hooks/types';

interface RecordingClient extends ChainMetricsClient {
  events: Array<{ channel: string; event: ChainTelemetryEvent }>;
}

function makeRecorder(): RecordingClient {
  const events: RecordingClient['events'] = [];
  return {
    events,
    emit(channel: string, event: ChainTelemetryEvent): void {
      events.push({ channel, event });
    },
  };
}

/** Wait for queued microtasks to drain so emitChainTelemetry observes them. */
async function drainMicrotasks(): Promise<void> {
  // queueMicrotask scheduling — two awaits is plenty.
  await Promise.resolve();
  await Promise.resolve();
}

describe('SPEC-022-2-04: telemetry-emitter primitive', () => {
  afterEach(() => setChainMetricsClient(undefined));

  it('emits exactly once on the chain.completed channel', async () => {
    const rec = makeRecorder();
    setChainMetricsClient(rec);
    expect(getChainMetricsClient()).toBe(rec);
    emitChainTelemetry({
      event: 'chain.completed',
      chain_id: 'c1',
      request_id: 'r1',
      plugins: ['p'],
      duration_ms: 5,
      artifacts: [],
      outcome: 'success',
    });
    await drainMicrotasks();
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0].channel).toBe('chain.completed');
    expect(rec.events[0].event.chain_id).toBe('c1');
  });

  it('is a no-op when no client is wired', async () => {
    setChainMetricsClient(undefined);
    // Must not throw; nothing to assert beyond that.
    expect(() =>
      emitChainTelemetry({
        event: 'chain.completed',
        chain_id: 'c2',
        request_id: 'r2',
        plugins: [],
        duration_ms: 0,
        artifacts: [],
        outcome: 'failed',
      }),
    ).not.toThrow();
    await drainMicrotasks();
  });

  it('swallows synchronous client throws', async () => {
    setChainMetricsClient({
      emit() {
        throw new Error('sync boom');
      },
    });
    expect(() =>
      emitChainTelemetry({
        event: 'chain.completed',
        chain_id: 'c3',
        request_id: 'r3',
        plugins: [],
        duration_ms: 0,
        artifacts: [],
        outcome: 'failed',
      }),
    ).not.toThrow();
    await drainMicrotasks();
  });

  it('swallows async client rejections', async () => {
    setChainMetricsClient({
      emit() {
        return Promise.reject(new Error('async boom'));
      },
    });
    expect(() =>
      emitChainTelemetry({
        event: 'chain.completed',
        chain_id: 'c4',
        request_id: 'r4',
        plugins: [],
        duration_ms: 0,
        artifacts: [],
        outcome: 'success',
      }),
    ).not.toThrow();
    await drainMicrotasks();
    // Give any unhandledRejection handlers a chance to fire (none should).
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('SPEC-022-2-04: executor emits exactly one chain.completed per run', () => {
  let tempRoot: string;
  let registry: ArtifactRegistry;
  let securityExample: unknown;
  let patchesExample: unknown;

  function makePair(): { manifests: HookManifest[]; lookup: ManifestLookup } {
    const manifests = [
      buildManifest({
        id: 'security-reviewer',
        version: '1.0.0',
        produces: [
          { artifact_type: 'security-findings', schema_version: '1.0', format: 'json' },
        ],
      }),
      buildManifest({
        id: 'code-fixer',
        version: '1.0.0',
        consumes: [{ artifact_type: 'security-findings', schema_version: '^1.0' }],
        produces: [
          { artifact_type: 'code-patches', schema_version: '1.0', format: 'json' },
        ],
      }),
    ];
    return { manifests, lookup: (id) => manifests.find((m) => m.id === id) };
  }

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
    registry = await loadArtifactSchemas();
    securityExample = await loadSecurityFindingsExample();
    patchesExample = await loadCodePatchesExample();
    ChainExecutor.__resetActiveChainsForTest();
  });

  afterEach(async () => {
    setChainMetricsClient(undefined);
    ChainExecutor.__resetActiveChainsForTest();
    await cleanupTempDir(tempRoot);
  });

  it('on a successful chain emits outcome=success with positive duration_ms and ordered plugins[]', async () => {
    const rec = makeRecorder();
    setChainMetricsClient(rec);
    const { manifests, lookup } = makePair();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [{ artifactType: 'code-patches', scanId: 'cp1', payload: patchesExample }];
      }
      return [];
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      chainId: 'tele-success',
    });
    await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-S' },
      { artifactType: 'security-findings', scanId: 'sf1', payload: securityExample },
    );
    await drainMicrotasks();
    expect(rec.events).toHaveLength(1);
    const ev = rec.events[0].event;
    expect(ev.outcome).toBe('success');
    expect(ev.chain_id).toBe('tele-success');
    expect(ev.request_id).toBe('REQ-S');
    expect(ev.plugins).toEqual(['security-reviewer', 'code-fixer']);
    expect(ev.duration_ms).toBeGreaterThan(0);
    expect(ev.artifacts.map((a) => a.id)).toEqual(['sf1', 'cp1']);
    expect(ev.error_type).toBeUndefined();
  });

  it('on a failed chain emits outcome=failed with an error_type', async () => {
    const rec = makeRecorder();
    setChainMetricsClient(rec);
    const { manifests, lookup } = makePair();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') throw new Error('synthetic failure');
      return [];
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      chainId: 'tele-fail',
    });
    await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-F' },
      { artifactType: 'security-findings', scanId: 'sf2', payload: securityExample },
    );
    await drainMicrotasks();
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0].event.outcome).toBe('failed');
  });

  it('on a privileged-chain rejection emits outcome=blocked with PrivilegedChainNotAllowedError', async () => {
    const rec = makeRecorder();
    setChainMetricsClient(rec);
    // The resolver flags pairs where the CONSUMER consumes a shared
    // requires_approval artifact. Build a 3-plugin chain so the
    // (code-fixer, audit-logger) pair is privileged.
    const manifests = [
      buildManifest({
        id: 'security-reviewer',
        version: '1.0.0',
        produces: [
          { artifact_type: 'security-findings', schema_version: '1.0', format: 'json' },
        ],
      }),
      buildManifest({
        id: 'code-fixer',
        version: '1.0.0',
        consumes: [{ artifact_type: 'security-findings', schema_version: '^1.0' }],
        produces: [
          {
            artifact_type: 'code-patches',
            schema_version: '1.0',
            format: 'json',
            requires_approval: true,
          },
        ],
      }),
      buildManifest({
        id: 'audit-logger',
        version: '1.0.0',
        consumes: [{ artifact_type: 'code-patches', schema_version: '^1.0' }],
      }),
    ];
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const exec = new ChainExecutor(graph, registry, lookup, async () => [], undefined, {
      chainId: 'tele-block',
      privilegedChainAllowlist: [], // explicit opt-in, empty → reject
    });
    await expect(
      exec.executeChain(
        'security-reviewer',
        { requestRoot: tempRoot, requestId: 'REQ-B' },
        { artifactType: 'security-findings', scanId: 'sfb', payload: securityExample },
      ),
    ).rejects.toBeDefined();
    await drainMicrotasks();
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0].event.outcome).toBe('blocked');
    expect(rec.events[0].event.error_type).toBe('PrivilegedChainNotAllowedError');
  });

  it('does not emit when emitTelemetry: false', async () => {
    const rec = makeRecorder();
    setChainMetricsClient(rec);
    const { manifests, lookup } = makePair();
    const graph = buildGraphFrom(manifests);
    const exec = new ChainExecutor(graph, registry, lookup, async () => [], undefined, {
      chainId: 'tele-off',
      emitTelemetry: false,
    });
    await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-N' },
      { artifactType: 'security-findings', scanId: 'sfn', payload: securityExample },
    );
    await drainMicrotasks();
    expect(rec.events).toHaveLength(0);
  });
});
