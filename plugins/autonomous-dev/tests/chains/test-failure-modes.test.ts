/**
 * Unit tests for per-declaration on_failure semantics (SPEC-022-2-02).
 *
 * Single-feature smoke; exhaustive cross-feature matrix lives in SPEC-022-2-05.
 *
 * @module tests/chains/test-failure-modes
 */

import {
  ChainExecutor,
  type ChainHookInvoker,
  type ChainHookOutput,
  type ManifestLookup,
  DEFAULT_CHAIN_LIMITS,
} from '../../intake/chains/executor';
import {
  buildGraphFrom,
  buildManifest,
  cleanupTempDir,
  createTempRequestDir,
  loadArtifactSchemas,
  loadCodePatchesExample,
  loadSecurityFindingsExample,
} from '../helpers/chain-fixtures';
import type {
  HookManifest,
  ChainFailureMode,
  ProducesDeclaration,
  ConsumesDeclaration,
} from '../../intake/hooks/types';
import type { ArtifactRegistry } from '../../intake/chains/artifact-registry';
import type { DependencyGraph } from '../../intake/chains/dependency-graph';

interface Trio {
  manifests: HookManifest[];
  graph: DependencyGraph;
}

/** Build the canonical security-reviewer → code-fixer → audit-logger trio,
 *  with the producer's `on_failure` mode threaded through. */
function buildTrio(
  produceFailureMode: ChainFailureMode | undefined,
  consumeFailureMode: ChainFailureMode | undefined = undefined,
): Trio {
  const producesEntry: ProducesDeclaration = {
    artifact_type: 'security-findings',
    schema_version: '1.0',
    format: 'json',
  };
  if (produceFailureMode) {
    producesEntry.on_failure = produceFailureMode;
  }
  const consumesEntry: ConsumesDeclaration = {
    artifact_type: 'security-findings',
    schema_version: '^1.0',
  };
  if (consumeFailureMode) {
    consumesEntry.on_failure = consumeFailureMode;
  }
  const manifests: HookManifest[] = [
    buildManifest({
      id: 'security-reviewer',
      produces: [producesEntry],
    }),
    buildManifest({
      id: 'code-fixer',
      consumes: [consumesEntry],
      produces: [
        { artifact_type: 'code-patches', schema_version: '1.0', format: 'json' },
      ],
    }),
    // A pure consumer of code-patches (downstream of code-fixer).
    buildManifest({
      id: 'audit-logger',
      consumes: [{ artifact_type: 'code-patches', schema_version: '^1.0' }],
    }),
  ];
  return { manifests, graph: buildGraphFrom(manifests) };
}

describe('SPEC-022-2-02: on_failure resolution', () => {
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

  it('default (no on_failure) — failed producer warns; downstream consumers skip', async () => {
    // code-fixer throws; audit-logger is reachable from code-fixer through
    // code-patches; but code-fixer's manifest declares on_failure NOT set,
    // and code-patches has no consumer with a tighter mode. Default = warn.
    // Per the executor: when code-fixer throws, the resolveFailureMode call
    // looks at code-fixer's `produces[].on_failure` (none), falls back to
    // audit-logger's `consumes[].on_failure` for code-patches (none), then
    // defaults to 'warn'. audit-logger should be marked skipped.
    const { manifests, graph } = buildTrio(undefined);
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = (pid) => {
      if (pid === 'code-fixer') {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve<ChainHookOutput[]>([]);
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS },
      chainId: 'cf-default',
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-D' },
      { artifactType: 'security-findings', scanId: 'sd', payload: securityExample },
    );
    const fixerStep = result.steps.find((s) => s.pluginId === 'code-fixer');
    const auditStep = result.steps.find((s) => s.pluginId === 'audit-logger');
    expect(fixerStep?.status).toBe('error');
    expect(auditStep?.status).toBe('skipped');
    expect(auditStep?.error).toMatch(/upstream error in code-fixer/);
    expect(result.ok).toBe(false);
  });

  it("on_failure: 'block' — chain halts; downstream not invoked", async () => {
    // code-fixer's manifest declares produces.on_failure: 'block'. When it
    // throws, the executor sets chainBlocked=true. NB: in this trio
    // audit-logger is the next downstream and it should be marked skipped
    // with `chain blocked by code-fixer`.
    //
    // To prove block ALSO halts plugins NOT in code-fixer's adjacency, we
    // would need a 3rd-arm plugin; the trio is sufficient for the smoke.
    const { manifests, graph } = buildTrio(undefined);
    // Override: code-fixer.produces has block mode (on the code-patches
    // declaration; the resolver picks the strictest).
    manifests[1].produces = [
      {
        artifact_type: 'code-patches',
        schema_version: '1.0',
        format: 'json',
        on_failure: 'block',
      },
    ];
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = (pid) => {
      if (pid === 'code-fixer') return Promise.reject(new Error('boom'));
      return Promise.resolve<ChainHookOutput[]>([]);
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS },
      chainId: 'cf-block',
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-Z' },
      { artifactType: 'security-findings', scanId: 'sz', payload: securityExample },
    );
    const fixerStep = result.steps.find((s) => s.pluginId === 'code-fixer');
    const auditStep = result.steps.find((s) => s.pluginId === 'audit-logger');
    expect(fixerStep?.status).toBe('error');
    expect(auditStep?.status).toBe('skipped');
    expect(auditStep?.error).toMatch(/chain blocked by code-fixer/);
    expect(result.ok).toBe(false);
  });

  it("on_failure: 'ignore' — downstream runs anyway (even though upstream failed)", async () => {
    // code-fixer fails with on_failure='ignore'; audit-logger should be
    // INVOKED even though its sole input (code-patches) is missing. It will
    // then skip itself with "no upstream producer" (consumer-side).
    const { manifests, graph } = buildTrio(undefined);
    manifests[1].produces = [
      {
        artifact_type: 'code-patches',
        schema_version: '1.0',
        format: 'json',
        on_failure: 'ignore',
      },
    ];
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    let auditInvoked = false;
    const invoker: ChainHookInvoker = (pid) => {
      if (pid === 'code-fixer') return Promise.reject(new Error('boom'));
      if (pid === 'audit-logger') {
        auditInvoked = true;
        return Promise.resolve<ChainHookOutput[]>([]);
      }
      return Promise.resolve<ChainHookOutput[]>([]);
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS },
      chainId: 'cf-ignore',
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-I' },
      { artifactType: 'security-findings', scanId: 'si', payload: securityExample },
    );
    const fixerStep = result.steps.find((s) => s.pluginId === 'code-fixer');
    const auditStep = result.steps.find((s) => s.pluginId === 'audit-logger');
    expect(fixerStep?.status).toBe('error');
    // ignore mode: audit-logger reaches the consumes-validation, finds the
    // upstream artifact missing, and skips itself with the consumer-side
    // "no upstream producer" reason. The actual hook is NOT invoked.
    expect(auditStep?.status).toBe('skipped');
    expect(auditStep?.error).toMatch(/no upstream producer/);
    expect(auditInvoked).toBe(false);
  });

  it("falls back to consumer's consumes.on_failure when producer omits it", async () => {
    // Producer omits on_failure; code-fixer's CONSUMES has on_failure='block'.
    // When security-reviewer fails (via failed schema validation), the
    // resolver falls back to code-fixer's consumes.on_failure='block'.
    // We simulate the producer-side failure by feeding an INVALID seed
    // artifact, which fails validation and aborts the chain immediately —
    // so this asserts the fall-back path differently: through a downstream
    // plugin failure.
    //
    // Cleaner test: code-fixer has no produces.on_failure, and audit-logger's
    // consumes.on_failure='block'. When code-fixer throws, resolver falls
    // back to audit-logger's consume mode.
    const { manifests, graph } = buildTrio(undefined);
    // Add audit-logger.consumes.on_failure='block' for code-patches.
    manifests[2].consumes = [
      {
        artifact_type: 'code-patches',
        schema_version: '^1.0',
        on_failure: 'block',
      },
    ];
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = (pid) => {
      if (pid === 'code-fixer') return Promise.reject(new Error('boom'));
      return Promise.resolve<ChainHookOutput[]>([]);
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS },
      chainId: 'cf-fallback',
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-F' },
      { artifactType: 'security-findings', scanId: 'sf', payload: securityExample },
    );
    const auditStep = result.steps.find((s) => s.pluginId === 'audit-logger');
    expect(auditStep?.status).toBe('skipped');
    expect(auditStep?.error).toMatch(/chain blocked by code-fixer/);
  });

  it("on_failure: 'warn' is the explicit default-equivalent (no behavior change)", async () => {
    const { manifests, graph } = buildTrio(undefined);
    manifests[1].produces = [
      {
        artifact_type: 'code-patches',
        schema_version: '1.0',
        format: 'json',
        on_failure: 'warn',
      },
    ];
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = (pid) => {
      if (pid === 'code-fixer') return Promise.reject(new Error('boom'));
      return Promise.resolve<ChainHookOutput[]>([]);
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS },
      chainId: 'cf-warn',
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-W' },
      { artifactType: 'security-findings', scanId: 'sw', payload: securityExample },
    );
    const auditStep = result.steps.find((s) => s.pluginId === 'audit-logger');
    expect(auditStep?.status).toBe('skipped');
    expect(auditStep?.error).toMatch(/upstream error in code-fixer/);
  });

  it('successful chain still works when on_failure declarations exist (no false positives)', async () => {
    // Sanity check: declarations don't affect happy-path behavior.
    const { manifests, graph } = buildTrio(undefined);
    manifests[1].produces = [
      {
        artifact_type: 'code-patches',
        schema_version: '1.0',
        format: 'json',
        on_failure: 'block',
      },
    ];
    const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [
          { artifactType: 'code-patches', scanId: 'p-ok', payload: patchesExample },
        ];
      }
      return [];
    };
    const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
      limits: { ...DEFAULT_CHAIN_LIMITS },
      chainId: 'cf-happy',
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'REQ-H' },
      { artifactType: 'security-findings', scanId: 'sh', payload: securityExample },
    );
    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.pluginId === 'code-fixer')?.status).toBe('ok');
  });
});
