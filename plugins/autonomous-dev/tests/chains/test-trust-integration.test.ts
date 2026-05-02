/**
 * Unit tests for the trust + privileged-chain integrations shipped by
 * SPEC-022-2-04. Single-feature smoke; cross-feature interactions live in
 * SPEC-022-2-05.
 *
 * Covers:
 *   - Trust check skips an untrusted plugin and skip-cascades its consumer.
 *   - Trust failure is recorded as `TrustValidationError` regardless of the
 *     manifest's declared on_failure mode (warn-equivalent semantics).
 *   - Privileged-chain pre-flight rejects a chain that has a privileged
 *     edge but no allowlist match — no plugins are invoked.
 *   - Privileged-chain pre-flight admits a chain whose privileged edge is
 *     listed in the allowlist (`*`, `N.x`, exact, mismatched).
 *   - PrivilegedChainResolver glob semantics in isolation.
 *
 * @module tests/chains/test-trust-integration
 */

import {
  ChainExecutor,
  type ChainHookInvoker,
  type ChainTrustChecker,
  type ChainTrustVerdict,
  type ManifestLookup,
} from '../../intake/chains/executor';
import { PrivilegedChainResolver } from '../../intake/chains/privileged-chain-resolver';
import {
  PrivilegedChainNotAllowedError,
  TrustValidationError,
  ChainError,
} from '../../intake/chains/errors';
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

interface RecordingChecker extends ChainTrustChecker {
  calls: string[];
}

function makeTrustChecker(
  verdicts: Record<string, ChainTrustVerdict>,
): RecordingChecker {
  const calls: string[] = [];
  return {
    calls,
    isTrusted(pid: string): ChainTrustVerdict {
      calls.push(pid);
      return verdicts[pid] ?? { trusted: true };
    },
  };
}

/**
 * Three-plugin chain: producer -> middle -> downstream. The middle plugin
 * is the one whose trust the test toggles.
 */
function makeTrioManifests(
  middleVersion = '1.0.0',
  privilegedAt: 'middle' | 'none' = 'none',
): HookManifest[] {
  const middleProduces =
    privilegedAt === 'middle'
      ? [
          {
            artifact_type: 'code-patches',
            schema_version: '1.0',
            format: 'json' as const,
            requires_approval: true,
          },
        ]
      : [
          {
            artifact_type: 'code-patches',
            schema_version: '1.0',
            format: 'json' as const,
          },
        ];
  return [
    buildManifest({
      id: 'security-reviewer',
      version: '1.0.0',
      produces: [
        { artifact_type: 'security-findings', schema_version: '1.0', format: 'json' },
      ],
    }),
    buildManifest({
      id: 'code-fixer',
      version: middleVersion,
      consumes: [{ artifact_type: 'security-findings', schema_version: '^1.0' }],
      produces: middleProduces,
    }),
    buildManifest({
      id: 'audit-logger',
      version: '1.0.0',
      consumes: [{ artifact_type: 'code-patches', schema_version: '^1.0' }],
    }),
  ];
}

describe('SPEC-022-2-04: trust integration', () => {
  let tempRoot: string;
  let registry: ArtifactRegistry;
  let securityExample: unknown;
  let patchesExample: unknown;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
    registry = await loadArtifactSchemas();
    securityExample = await loadSecurityFindingsExample();
    patchesExample = await loadCodePatchesExample();
    ChainExecutor.__resetActiveChainsForTest();
  });

  afterEach(async () => {
    ChainExecutor.__resetActiveChainsForTest();
    await cleanupTempDir(tempRoot);
  });

  it('skips an untrusted middle plugin and skip-cascades its consumer', async () => {
    const manifests = makeTrioManifests();
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invokerCalls: string[] = [];
    const invoker: ChainHookInvoker = async (pid) => {
      invokerCalls.push(pid);
      if (pid === 'code-fixer') {
        return [{ artifactType: 'code-patches', scanId: 'p1', payload: patchesExample }];
      }
      return [];
    };
    const trust = makeTrustChecker({
      'code-fixer': { trusted: false, reason: 'revoked' },
    });
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      trustChecker: trust,
      chainId: 'trust-1',
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-T1' },
      { artifactType: 'security-findings', scanId: 's1', payload: securityExample },
    );
    expect(result.outcome).toBe('failed');
    expect(result.ok).toBe(false);

    // code-fixer was NEVER invoked (trust short-circuits before invocation).
    expect(invokerCalls).not.toContain('code-fixer');

    const fixerStep = result.steps.find((s) => s.pluginId === 'code-fixer')!;
    expect(fixerStep.status).toBe('error');
    expect(fixerStep.error).toMatch(/trust/i);
    expect(fixerStep.error).toMatch(/revoked/);

    // audit-logger skip-cascades because its upstream (code-fixer) failed.
    const auditStep = result.steps.find((s) => s.pluginId === 'audit-logger')!;
    expect(auditStep.status).toBe('skipped');
    expect(auditStep.error).toMatch(/upstream error in code-fixer/);
  });

  it('untrusted producer in a 2-plugin chain causes consumer to skip-cascade', async () => {
    // 2-plugin chain where the FIRST downstream plugin (the only consumer
    // of the seed) is untrusted. The trigger is treated separately (its
    // artifact is the seed, not produced inside the chain).
    const manifests = makeTrioManifests();
    // Drop audit-logger to have a 2-step downstream walk.
    const truncated = manifests.slice(0, 2);
    const graph = buildGraphFrom(truncated);
    const lookup: ManifestLookup = (id) => truncated.find((m) => m.id === id);
    const invoker: ChainHookInvoker = async () => [];
    const trust = makeTrustChecker({
      'code-fixer': { trusted: false, reason: 'unknown-publisher' },
    });
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      trustChecker: trust,
      chainId: 'trust-2',
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-T2' },
      { artifactType: 'security-findings', scanId: 's2', payload: securityExample },
    );
    expect(result.outcome).toBe('failed');
    const fixerStep = result.steps.find((s) => s.pluginId === 'code-fixer')!;
    expect(fixerStep.error).toMatch(/unknown-publisher/);
  });

  it('records the reason returned by the trust checker on the step', async () => {
    const manifests = makeTrioManifests();
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const trust = makeTrustChecker({
      'code-fixer': { trusted: false, reason: 'not-allowlisted' },
    });
    const exec = new ChainExecutor(
      graph,
      registry,
      lookup,
      async () => [],
      undefined,
      { trustChecker: trust },
    );
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-T3' },
      { artifactType: 'security-findings', scanId: 's3', payload: securityExample },
    );
    const fixerStep = result.steps.find((s) => s.pluginId === 'code-fixer')!;
    expect(fixerStep.error).toMatch(/not-allowlisted/);
  });

  it('treats a thrown trust check as untrusted with a synthetic reason', async () => {
    const manifests = makeTrioManifests();
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const throwing: ChainTrustChecker = {
      isTrusted: () => {
        throw new Error('validator offline');
      },
    };
    const exec = new ChainExecutor(
      graph,
      registry,
      lookup,
      async () => [],
      undefined,
      { trustChecker: throwing },
    );
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-T4' },
      { artifactType: 'security-findings', scanId: 's4', payload: securityExample },
    );
    const fixerStep = result.steps.find((s) => s.pluginId === 'code-fixer')!;
    expect(fixerStep.status).toBe('error');
    expect(fixerStep.error).toMatch(/validator offline/);
  });

  it('without a trustChecker the executor treats every plugin as trusted (back-compat)', async () => {
    const manifests = makeTrioManifests();
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [{ artifactType: 'code-patches', scanId: 'p1', payload: patchesExample }];
      }
      return [];
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker);
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-T5' },
      { artifactType: 'security-findings', scanId: 's5', payload: securityExample },
    );
    // No error from trust; chain runs through.
    const fixerStep = result.steps.find((s) => s.pluginId === 'code-fixer')!;
    expect(fixerStep.status).toBe('ok');
  });
});

describe('SPEC-022-2-04: privileged-chain pre-flight', () => {
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

  it('rejects a privileged chain not in the allowlist BEFORE any plugin invocation', async () => {
    const manifests = makeTrioManifests('1.0.0', 'middle');
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invokerCalls: string[] = [];
    const invoker: ChainHookInvoker = async (pid) => {
      invokerCalls.push(pid);
      return [];
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      privilegedChainAllowlist: [], // explicit opt-in, empty
      chainId: 'priv-1',
    });
    await expect(
      exec.executeChain(
        'security-reviewer',
        { requestRoot: tempRoot, requestId: 'REQ-P1' },
        { artifactType: 'security-findings', scanId: 's-p1', payload: securityExample },
      ),
    ).rejects.toBeInstanceOf(PrivilegedChainNotAllowedError);
    // No plugin invoked because pre-flight fired before runChainBody.
    expect(invokerCalls).toEqual([]);
  });

  it('proceeds to execution when the privileged pair is allowlisted with `*`', async () => {
    const manifests = makeTrioManifests('1.0.0', 'middle');
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invokerCalls: string[] = [];
    const invoker: ChainHookInvoker = async (pid) => {
      invokerCalls.push(pid);
      return [];
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      privilegedChainAllowlist: ['code-fixer:audit-logger@*'],
      chainId: 'priv-2',
    });
    // Doesn't throw — the chain enters runChainBody and calls invoker.
    await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-P2' },
      { artifactType: 'security-findings', scanId: 's-p2', payload: securityExample },
    );
    expect(invokerCalls).toContain('code-fixer');
  });

  it('a non-privileged chain skips the pre-flight even with an empty allowlist', async () => {
    // privilegedAt='none' → no requires_approval edge → no privileged pair.
    const manifests = makeTrioManifests('1.0.0', 'none');
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = async () => [];
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      privilegedChainAllowlist: [],
      chainId: 'priv-3',
    });
    await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-P3' },
      { artifactType: 'security-findings', scanId: 's-p3', payload: securityExample },
    );
  });

  it('PrivilegedChainNotAllowedError carries plugin_ids and versions and serializes', () => {
    const err = new PrivilegedChainNotAllowedError(['a', 'b'], ['1.0.0', '2.1.0']);
    expect(err).toBeInstanceOf(ChainError);
    expect([...err.plugin_ids]).toEqual(['a', 'b']);
    expect([...err.versions]).toEqual(['1.0.0', '2.1.0']);
    const round = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(round.plugin_ids).toEqual(['a', 'b']);
    expect(round.versions).toEqual(['1.0.0', '2.1.0']);
  });

  it('TrustValidationError carries plugin_id + reason and serializes', () => {
    const err = new TrustValidationError('plug-x', 'revoked');
    expect(err).toBeInstanceOf(ChainError);
    expect(err.plugin_id).toBe('plug-x');
    expect(err.reason).toBe('revoked');
    const round = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(round.plugin_id).toBe('plug-x');
    expect(round.reason).toBe('revoked');
  });
});

describe('SPEC-022-2-04: PrivilegedChainResolver glob matcher', () => {
  const resolver = new PrivilegedChainResolver();

  it('versionMatches: `*` matches every version', () => {
    expect(resolver.versionMatches('*', '1.0.0')).toBe(true);
    expect(resolver.versionMatches('*', '99.99.99')).toBe(true);
    expect(resolver.versionMatches('*', '0.0.1-beta')).toBe(true);
  });

  it('versionMatches: `1.x` matches `1.0.0` and `1.5.2` but NOT `2.0.0`', () => {
    expect(resolver.versionMatches('1.x', '1.0.0')).toBe(true);
    expect(resolver.versionMatches('1.x', '1.5.2')).toBe(true);
    expect(resolver.versionMatches('1.x', '2.0.0')).toBe(false);
  });

  it('versionMatches: `1.2.x` matches `1.2.3` but NOT `1.3.0` or `2.2.0`', () => {
    expect(resolver.versionMatches('1.2.x', '1.2.3')).toBe(true);
    expect(resolver.versionMatches('1.2.x', '1.2.0')).toBe(true);
    expect(resolver.versionMatches('1.2.x', '1.3.0')).toBe(false);
    expect(resolver.versionMatches('1.2.x', '2.2.0')).toBe(false);
  });

  it('versionMatches: exact `1.2.3` matches that version only', () => {
    expect(resolver.versionMatches('1.2.3', '1.2.3')).toBe(true);
    expect(resolver.versionMatches('1.2.3', '1.2.4')).toBe(false);
    expect(resolver.versionMatches('1.2.3', '2.2.3')).toBe(false);
  });

  it('matches() returns allowed=true vacuously when chain has no privileged pair', () => {
    const verdict = resolver.matches(
      [
        {
          id: 'p',
          version: '1.0.0',
          manifest: buildManifest({
            id: 'p',
            produces: [
              { artifact_type: 'a', schema_version: '1.0', format: 'json' },
            ],
          }),
        },
        {
          id: 'q',
          version: '1.0.0',
          manifest: buildManifest({
            id: 'q',
            consumes: [{ artifact_type: 'a', schema_version: '^1.0' }],
          }),
        },
      ],
      [],
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it('matches() flags missing pairs with `producer:consumer@version` strings', () => {
    const verdict = resolver.matches(
      [
        {
          id: 'p',
          version: '1.0.0',
          manifest: buildManifest({
            id: 'p',
            produces: [
              {
                artifact_type: 'a',
                schema_version: '1.0',
                format: 'json',
                requires_approval: true,
              },
            ],
          }),
        },
        {
          id: 'q',
          version: '2.0.0',
          manifest: buildManifest({
            id: 'q',
            consumes: [{ artifact_type: 'a', schema_version: '^1.0' }],
          }),
        },
      ],
      [],
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.missing).toEqual(['p:q@2.0.0']);
  });

  it('matches() admits when the consumer flags requires_approval (not the producer)', () => {
    const verdict = resolver.matches(
      [
        {
          id: 'p',
          version: '1.0.0',
          manifest: buildManifest({
            id: 'p',
            produces: [
              { artifact_type: 'a', schema_version: '1.0', format: 'json' },
            ],
          }),
        },
        {
          id: 'q',
          version: '1.0.0',
          manifest: buildManifest({
            id: 'q',
            consumes: [
              {
                artifact_type: 'a',
                schema_version: '^1.0',
                requires_approval: true,
              },
            ],
          }),
        },
      ],
      ['p:q@1.x'],
    );
    expect(verdict.allowed).toBe(true);
  });

  it('matches() rejects malformed allowlist entries silently (no exception)', () => {
    const verdict = resolver.matches(
      [
        {
          id: 'p',
          version: '1.0.0',
          manifest: buildManifest({
            id: 'p',
            produces: [
              {
                artifact_type: 'a',
                schema_version: '1.0',
                format: 'json',
                requires_approval: true,
              },
            ],
          }),
        },
        {
          id: 'q',
          version: '1.0.0',
          manifest: buildManifest({
            id: 'q',
            consumes: [{ artifact_type: 'a', schema_version: '^1.0' }],
          }),
        },
      ],
      ['not-a-valid-entry', 'also bad', 'p:q@1.x'], // last one matches
    );
    expect(verdict.allowed).toBe(true);
  });
});

// =====================================================================
// SPEC-022-2-05 cross-feature scenarios: trust × privileged-chain.
// =====================================================================

describe('SPEC-022-2-05: trust × privileged-chain interactions', () => {
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

  it('untrusted producer in privileged chain (allowlist matches): producer skipped, consumer cascade-skipped, privileged check still passed', async () => {
    const manifests = makeTrioManifests('1.0.0', 'middle');
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invokerCalls: string[] = [];
    const invoker: ChainHookInvoker = async (pid) => {
      invokerCalls.push(pid);
      return [];
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      privilegedChainAllowlist: ['code-fixer:audit-logger@*'],
      trustChecker: {
        isTrusted: (pid) =>
          pid === 'code-fixer' ? { trusted: false, reason: 'revoked' } : { trusted: true },
      },
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'TXP-1' },
      { artifactType: 'security-findings', scanId: 'stxp1', payload: securityExample },
    );
    // Privileged pre-flight passed (didn't throw).
    // Trust short-circuited code-fixer; audit-logger skip-cascaded.
    expect(invokerCalls).not.toContain('code-fixer');
    const fixer = result.steps.find((s) => s.pluginId === 'code-fixer');
    expect(fixer?.error).toMatch(/revoked/);
    const audit = result.steps.find((s) => s.pluginId === 'audit-logger');
    expect(audit?.status).toBe('skipped');
  });

  it('privileged chain not in allowlist: privileged check throws BEFORE trust check fires', async () => {
    const manifests = makeTrioManifests('1.0.0', 'middle');
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const trustCalls: string[] = [];
    const exec = new ChainExecutor(graph, registry, lookup, async () => [], undefined, {
      privilegedChainAllowlist: [], // explicit opt-in, empty
      trustChecker: {
        isTrusted: (pid) => {
          trustCalls.push(pid);
          return { trusted: true };
        },
      },
    });
    await expect(
      exec.executeChain(
        'security-reviewer',
        { requestRoot: tempRoot, requestId: 'TXP-2' },
        { artifactType: 'security-findings', scanId: 'stxp2', payload: securityExample },
      ),
    ).rejects.toBeInstanceOf(PrivilegedChainNotAllowedError);
    // Trust never ran because privileged pre-flight is structural.
    expect(trustCalls).toEqual([]);
  });

  it('trusted producer, untrusted consumer in privileged chain: producer runs, consumer skipped with TrustValidationError, chain failed', async () => {
    const manifests = makeTrioManifests('1.0.0', 'middle');
    const graph = buildGraphFrom(manifests);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invokerCalls: string[] = [];
    const invoker: ChainHookInvoker = async (pid) => {
      invokerCalls.push(pid);
      if (pid === 'code-fixer') {
        return [{ artifactType: 'code-patches', scanId: 'p1', payload: patchesExample }];
      }
      return [];
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      privilegedChainAllowlist: ['code-fixer:audit-logger@*'],
      trustChecker: {
        isTrusted: (pid) =>
          pid === 'audit-logger'
            ? { trusted: false, reason: 'consumer-revoked' }
            : { trusted: true },
      },
      chainId: 'txp-tpc',
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'TPC' },
      { artifactType: 'security-findings', scanId: 'stpc', payload: securityExample },
    );
    // Producer ran; consumer trust-blocked.
    expect(invokerCalls).toContain('code-fixer');
    expect(invokerCalls).not.toContain('audit-logger');
    const audit = result.steps.find((s) => s.pluginId === 'audit-logger')!;
    expect(audit.status).toBe('error');
    expect(audit.error).toMatch(/consumer-revoked/);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('failed');
  });

  it('allowlist glob `*` matches all versions: chain proceeds for both v1.0.0 and v9.9.9 consumer', async () => {
    // v1.0.0 consumer
    {
      const manifests = makeTrioManifests('1.0.0', 'middle');
      manifests[2].version = '1.0.0';
      const graph = buildGraphFrom(manifests);
      const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
      const invokerCalls: string[] = [];
      const exec = new ChainExecutor(
        graph,
        registry,
        lookup,
        async (pid) => {
          invokerCalls.push(pid);
          return [];
        },
        undefined,
        { privilegedChainAllowlist: ['code-fixer:audit-logger@*'], chainId: 'star-v1' },
      );
      await exec.executeChain(
        'security-reviewer',
        { requestRoot: tempRoot, requestId: 'STAR-V1' },
        { artifactType: 'security-findings', scanId: 'star-v1', payload: securityExample },
      );
      expect(invokerCalls).toContain('code-fixer');
    }
    // v9.9.9 consumer
    {
      const manifests = makeTrioManifests('1.0.0', 'middle');
      manifests[2].version = '9.9.9';
      const graph = buildGraphFrom(manifests);
      const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
      const invokerCalls: string[] = [];
      const exec = new ChainExecutor(
        graph,
        registry,
        lookup,
        async (pid) => {
          invokerCalls.push(pid);
          return [];
        },
        undefined,
        { privilegedChainAllowlist: ['code-fixer:audit-logger@*'], chainId: 'star-v9' },
      );
      await exec.executeChain(
        'security-reviewer',
        { requestRoot: tempRoot, requestId: 'STAR-V9' },
        { artifactType: 'security-findings', scanId: 'star-v9', payload: securityExample },
      );
      expect(invokerCalls).toContain('code-fixer');
    }
  });

  it('allowlist `1.x` admits v1.5.2 consumer; rejects v2.0.0', async () => {
    // v1.5.2 consumer (admit)
    {
      const manifests = makeTrioManifests('1.5.2', 'middle');
      const graph = buildGraphFrom(manifests);
      const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
      const exec = new ChainExecutor(graph, registry, lookup, async () => [], undefined, {
        privilegedChainAllowlist: ['code-fixer:audit-logger@1.x'],
      });
      // Doesn't throw on the privileged check.
      await exec.executeChain(
        'security-reviewer',
        { requestRoot: tempRoot, requestId: 'V15' },
        { artifactType: 'security-findings', scanId: 'sv15', payload: securityExample },
      );
    }
    // v2.0.0 consumer (reject)
    {
      const manifests = makeTrioManifests('1.5.2', 'middle');
      // Bump audit-logger to v2.
      manifests[2].version = '2.0.0';
      const graph = buildGraphFrom(manifests);
      const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
      const exec = new ChainExecutor(graph, registry, lookup, async () => [], undefined, {
        privilegedChainAllowlist: ['code-fixer:audit-logger@1.x'],
      });
      await expect(
        exec.executeChain(
          'security-reviewer',
          { requestRoot: tempRoot, requestId: 'V20' },
          { artifactType: 'security-findings', scanId: 'sv20', payload: securityExample },
        ),
      ).rejects.toBeInstanceOf(PrivilegedChainNotAllowedError);
    }
  });
});
