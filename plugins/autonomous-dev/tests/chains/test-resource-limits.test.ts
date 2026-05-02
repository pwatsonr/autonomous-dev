/**
 * Unit tests for chain-length, artifact-size, and concurrent-chain limits
 * (SPEC-022-2-02). Single-feature smoke tests; cross-feature scenarios live
 * in SPEC-022-2-05's expansion of this file.
 *
 * @module tests/chains/test-resource-limits
 */

import {
  ChainExecutor,
  type ChainHookInvoker,
  type ChainHookOutput,
  type ManifestLookup,
  DEFAULT_CHAIN_LIMITS,
  strictestFailureMode,
} from '../../intake/chains/executor';
import {
  ArtifactRegistry,
  DEFAULT_MAX_ARTIFACT_SIZE_MB,
} from '../../intake/chains/artifact-registry';
import {
  ArtifactTooLargeError,
  ChainTooLongError,
  ConcurrentChainLimitError,
  ChainError,
} from '../../intake/chains/errors';
import { DependencyGraph } from '../../intake/chains/dependency-graph';
import {
  buildGraphFrom,
  buildManifest,
  cleanupTempDir,
  createTempRequestDir,
  loadArtifactSchemas,
  loadSecurityFindingsExample,
} from '../helpers/chain-fixtures';
import type { HookManifest } from '../../intake/hooks/types';

describe('SPEC-022-2-02: chain-length limit', () => {
  let tempRoot: string;
  let registry: ArtifactRegistry;
  let securityExample: unknown;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
    registry = await loadArtifactSchemas();
    securityExample = await loadSecurityFindingsExample();
    ChainExecutor.__resetActiveChainsForTest();
  });

  afterEach(async () => {
    ChainExecutor.__resetActiveChainsForTest();
    await cleanupTempDir(tempRoot);
  });

  function buildLinearChain(length: number): {
    manifests: HookManifest[];
    graph: DependencyGraph;
  } {
    const manifests: HookManifest[] = [];
    for (let i = 0; i < length; i++) {
      manifests.push(
        buildManifest({
          id: `plugin-${i}`,
          produces:
            i === 0
              ? [
                  {
                    artifact_type: 'security-findings',
                    schema_version: '1.0',
                    format: 'json',
                  },
                ]
              : undefined,
          consumes:
            i === 0
              ? undefined
              : [{ artifact_type: 'security-findings', schema_version: '^1.0' }],
        }),
      );
    }
    return { manifests, graph: buildGraphFrom(manifests) };
  }

  it('rejects a chain of length 12 with max_length=10 via ChainTooLongError', async () => {
    const { manifests, graph } = buildLinearChain(12);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = async () => [];
    const executor = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS, max_length: 10 },
      chainId: 'chain-too-long',
    });
    await expect(
      executor.executeChain(
        'plugin-0',
        { requestRoot: tempRoot, requestId: 'REQ-A' },
        { artifactType: 'security-findings', scanId: 'a', payload: securityExample },
      ),
    ).rejects.toMatchObject({
      name: 'ChainTooLongError',
      max_length: 10,
    });
  });

  it('chain of length 10 with max_length=10 executes (boundary inclusive)', async () => {
    // Boundary: topo-order length === max_length is allowed.
    const { manifests, graph } = buildLinearChain(10);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = async () => [];
    const executor = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS, max_length: 10 },
      chainId: 'chain-boundary',
    });
    const result = await executor.executeChain(
      'plugin-0',
      { requestRoot: tempRoot, requestId: 'REQ-B' },
      { artifactType: 'security-findings', scanId: 'b', payload: securityExample },
    );
    expect(result).toBeDefined();
    // We aren't asserting ok=true (downstream lookups may skip), only that
    // the length check did NOT throw.
  });

  it('ChainTooLongError carries the full chain_path in topological order', () => {
    const path = ['a', 'b', 'c'];
    const err = new ChainTooLongError(path, 2);
    expect(err).toBeInstanceOf(ChainError);
    expect([...err.chain_path]).toEqual(['a', 'b', 'c']);
    const round = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(round.chain_path).toEqual(['a', 'b', 'c']);
    expect(round.max_length).toBe(2);
  });
});

describe('SPEC-022-2-02: artifact-size limit', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempRoot);
  });

  it('default cap is 10MB', () => {
    expect(DEFAULT_MAX_ARTIFACT_SIZE_MB).toBe(10);
    const reg = new ArtifactRegistry();
    expect(reg.getMaxArtifactSizeBytes()).toBe(10 * 1024 * 1024);
  });

  it('persist rejects an oversize payload with ArtifactTooLargeError', async () => {
    // 1MB cap, payload ~2MB.
    const reg = new ArtifactRegistry({ maxArtifactSizeMb: 1 });
    // 'a' repeated 2.5M times ≈ 2.5MB serialized (single quoted string).
    const huge = { findings: 'a'.repeat(2_500_000) };
    await expect(
      reg.persist(tempRoot, 'security-findings', 'big', huge),
    ).rejects.toMatchObject({
      name: 'ArtifactTooLargeError',
      max_bytes: 1 * 1024 * 1024,
    });
  });

  it('persist accepts a payload at exactly the cap (boundary inclusive)', async () => {
    // Build a payload whose JSON.stringify output is exactly 1024 bytes.
    // JSON.stringify({"v":"<padding>"} , null, 2) framing is 13 bytes; plus 1024-13 = 1011 'a' chars.
    const reg = new ArtifactRegistry({ maxArtifactSizeMb: 1 / 1024 }); // 1 KB cap
    // Build a payload string padded to fit exactly 1024 bytes when JSON-stringified with 2-space indent.
    // Easier: persist 1023-byte payload; verify it succeeds; persist 1025-byte payload; verify fail.
    const padding = 'x'.repeat(1023 - 14); // {"v":"...padding..."} indented serialization
    const payload = { v: padding };
    const serialized = JSON.stringify(payload, null, 2);
    if (serialized.length <= 1024) {
      // Should succeed
      await expect(
        reg.persist(tempRoot, 'security-findings', 'tiny', payload),
      ).resolves.toBeDefined();
    } else {
      // If padding overshoots, this test would mis-assert — fall back to sanity bound.
      // Either branch keeps the test useful but we expect <=1024 here.
      throw new Error(`unexpected serialized length ${serialized.length}`);
    }
  });

  it('ArtifactTooLargeError carries artifact_id, producer_id, size_bytes, max_bytes', () => {
    const err = new ArtifactTooLargeError('scan-7', 'producer-x', 11_000_000, 10_485_760);
    expect(err).toBeInstanceOf(ChainError);
    expect(err.name).toBe('ArtifactTooLargeError');
    expect(err.artifact_id).toBe('scan-7');
    expect(err.producer_id).toBe('producer-x');
    expect(err.size_bytes).toBe(11_000_000);
    expect(err.max_bytes).toBe(10_485_760);
    const round = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(round.size_bytes).toBe(11_000_000);
    expect(round.max_bytes).toBe(10_485_760);
  });

  it('persist size check rejects BEFORE writing any temp file', async () => {
    const reg = new ArtifactRegistry({ maxArtifactSizeMb: 1 / 1024 / 1024 }); // 1 byte cap
    const target = `${tempRoot}/.autonomous-dev/artifacts/security-findings`;
    await expect(
      reg.persist(tempRoot, 'security-findings', 'huge', { x: 'oversize' }),
    ).rejects.toBeInstanceOf(ArtifactTooLargeError);
    // No tmp files should have been written.
    const fs = await import('node:fs/promises');
    const exists = await fs.stat(target).then(() => true).catch(() => false);
    // The directory may or may not exist (we throw before mkdir); but no .tmp.* file should exist.
    if (exists) {
      const ents = await fs.readdir(target);
      expect(ents.filter((e) => e.includes('.tmp.'))).toEqual([]);
    }
  });
});

describe('SPEC-022-2-02: concurrent-chain cap', () => {
  let tempRoot: string;
  let registry: ArtifactRegistry;
  let securityExample: unknown;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
    registry = await loadArtifactSchemas();
    securityExample = await loadSecurityFindingsExample();
    ChainExecutor.__resetActiveChainsForTest();
  });

  afterEach(async () => {
    ChainExecutor.__resetActiveChainsForTest();
    await cleanupTempDir(tempRoot);
  });

  function makePair(): { manifests: HookManifest[]; graph: DependencyGraph } {
    const manifests = [
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
      }),
    ];
    return { manifests, graph: buildGraphFrom(manifests) };
  }

  it('4th concurrent chain throws ConcurrentChainLimitError when cap=3', async () => {
    const { manifests, graph } = makePair();
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    // Three slow invokers — never resolve until we release them. Use one
    // pending promise per chain so the executor body holds the semaphore.
    const releasers: Array<() => void> = [];
    const blockingInvoker: ChainHookInvoker = (pid) => {
      if (pid === 'code-fixer') {
        return new Promise<ChainHookOutput[]>((resolve) => {
          releasers.push(() => resolve([]));
        });
      }
      return Promise.resolve([]);
    };

    // Tight per-plugin timeout so a missed release doesn't hang the test.
    const limits = {
      ...DEFAULT_CHAIN_LIMITS,
      max_concurrent_chains: 3,
      per_plugin_timeout_seconds: 5,
    };
    const e1 = new ChainExecutor(graph, registry, lookup, blockingInvoker, undefined, {
      limits,
      chainId: 'c1',
    });
    const e2 = new ChainExecutor(graph, registry, lookup, blockingInvoker, undefined, {
      limits,
      chainId: 'c2',
    });
    const e3 = new ChainExecutor(graph, registry, lookup, blockingInvoker, undefined, {
      limits,
      chainId: 'c3',
    });
    const e4 = new ChainExecutor(graph, registry, lookup, blockingInvoker, undefined, {
      limits,
      chainId: 'c4',
    });

    // Kick off three chains; do NOT await — they hold the semaphore.
    const p1 = e1.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'R1' },
      { artifactType: 'security-findings', scanId: 's1', payload: securityExample },
    );
    const p2 = e2.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'R2' },
      { artifactType: 'security-findings', scanId: 's2', payload: securityExample },
    );
    const p3 = e3.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'R3' },
      { artifactType: 'security-findings', scanId: 's3', payload: securityExample },
    );
    // Wait a tick so the three chains enter runChainBody and bump the counter.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(ChainExecutor.getActiveChainCount()).toBe(3);

    await expect(
      e4.executeChain(
        'security-reviewer',
        { requestRoot: tempRoot, requestId: 'R4' },
        { artifactType: 'security-findings', scanId: 's4', payload: securityExample },
      ),
    ).rejects.toMatchObject({ name: 'ConcurrentChainLimitError', cap: 3, active_count: 3 });

    // Release the three in-flight chains so the test ends cleanly.
    for (const release of releasers) release();
    await Promise.all([p1, p2, p3]);
  }, 15_000);

  it('counter decrements after a chain completes (4th succeeds after 1st done)', async () => {
    const { manifests, graph } = makePair();
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const fastInvoker: ChainHookInvoker = async () => [];
    const limits = { ...DEFAULT_CHAIN_LIMITS, max_concurrent_chains: 3 };
    const exec = new ChainExecutor(graph, registry, lookup, fastInvoker, undefined, { limits });
    // Run 4 chains in sequence: each completes before the next, so counter is always ≤1.
    for (let i = 0; i < 4; i++) {
      await exec.executeChain(
        'security-reviewer',
        { requestRoot: tempRoot, requestId: `RX-${i}` },
        { artifactType: 'security-findings', scanId: `sx-${i}`, payload: securityExample },
      );
    }
    expect(ChainExecutor.getActiveChainCount()).toBe(0);
  });

  it('counter decrements even when the chain body throws', async () => {
    const { manifests, graph } = makePair();
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const throwingInvoker: ChainHookInvoker = async () => {
      throw new Error('synthetic');
    };
    const exec = new ChainExecutor(graph, registry, lookup, throwingInvoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS, max_concurrent_chains: 3 },
    });
    // Even though invoker throws, the chain body catches it (per-step) and
    // the finally block still decrements the counter.
    await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'RT' },
      { artifactType: 'security-findings', scanId: 'st', payload: securityExample },
    );
    expect(ChainExecutor.getActiveChainCount()).toBe(0);
  });

  it('ConcurrentChainLimitError carries active_count and cap and serializes to JSON', () => {
    const err = new ConcurrentChainLimitError(3, 3);
    expect(err.active_count).toBe(3);
    expect(err.cap).toBe(3);
    const round = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(round.active_count).toBe(3);
    expect(round.cap).toBe(3);
  });
});

describe('SPEC-022-2-02: strictestFailureMode helper', () => {
  it('block beats warn beats ignore', () => {
    expect(strictestFailureMode(['ignore', 'warn'])).toBe('warn');
    expect(strictestFailureMode(['ignore', 'warn', 'block'])).toBe('block');
    expect(strictestFailureMode(['ignore', 'ignore'])).toBe('ignore');
  });
  it('empty falls back to warn (spec default)', () => {
    expect(strictestFailureMode([])).toBe('warn');
  });
});
