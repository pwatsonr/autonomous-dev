/**
 * Unit tests for ChainExecutor (SPEC-022-1-04 / SPEC-022-1-05).
 *
 * Covers seed validation, sequential execution in topological order,
 * downstream skip-cascade on error, parallel-branch independence,
 * timing, and on-disk persistence.
 *
 * @module tests/chains/test-executor
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  ChainExecutor,
  type ChainHookInvoker,
  type ChainHookOutput,
} from '../../intake/chains/executor';
import { ArtifactRegistry } from '../../intake/chains/artifact-registry';
import { DependencyGraph } from '../../intake/chains/dependency-graph';
import {
  buildExecutor,
  buildGraphFrom,
  buildManifest,
  cleanupTempDir,
  createTempRequestDir,
  loadArtifactSchemas,
  loadCodePatchesExample,
  loadSecurityFindingsExample,
} from '../helpers/chain-fixtures';
import type { HookManifest } from '../../intake/hooks/types';

describe('ChainExecutor', () => {
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
    await cleanupTempDir(tempRoot);
  });

  function twoPluginManifests(): HookManifest[] {
    return [
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
  }

  it('executeChain with valid seed + one downstream consumer: returns ok:true with 2 steps in topological order', async () => {
    const manifests = twoPluginManifests();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [
          {
            artifactType: 'code-patches',
            scanId: 'patches-1',
            payload: patchesExample,
          },
        ];
      }
      return [];
    };
    const exec = buildExecutor(graph, registry, manifests, { invoker });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-1',
        payload: securityExample,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].pluginId).toBe('security-reviewer');
    expect(result.steps[1].pluginId).toBe('code-fixer');
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true);
  });

  it('seed artifact failing schema validation: returns ok:false with 1 step (validation error); no downstream invocation', async () => {
    const manifests = twoPluginManifests();
    const graph = buildGraphFrom(manifests);
    const invokerMock = jest.fn<Promise<ChainHookOutput[]>, [string, unknown]>(
      async () => [],
    );
    const exec = buildExecutor(graph, registry, manifests, {
      invoker: invokerMock as unknown as ChainHookInvoker,
    });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-1',
        payload: { not: 'valid' },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe('error');
    expect(invokerMock).not.toHaveBeenCalled();
  });

  it('executeChain on 3-plugin chain (A→B→C): all three steps in order, each persisted artifact on disk', async () => {
    const manifests: HookManifest[] = [
      ...twoPluginManifests(),
      buildManifest({
        id: 'audit-logger',
        consumes: [{ artifact_type: 'code-patches', schema_version: '^1.0' }],
      }),
    ];
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [
          {
            artifactType: 'code-patches',
            scanId: 'patches-1',
            payload: patchesExample,
          },
        ];
      }
      return [];
    };
    const exec = buildExecutor(graph, registry, manifests, { invoker });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-1',
        payload: securityExample,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.pluginId)).toEqual([
      'security-reviewer',
      'code-fixer',
      'audit-logger',
    ]);
    const findingsPath = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
      'scan-1.json',
    );
    const patchesPath = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'code-patches',
      'patches-1.json',
    );
    await expect(fs.stat(findingsPath)).resolves.toBeDefined();
    await expect(fs.stat(patchesPath)).resolves.toBeDefined();
  });

  it('mid-chain plugin throws: that step status="error"; downstream reachable plugins status="skipped"', async () => {
    const manifests: HookManifest[] = [
      ...twoPluginManifests(),
      buildManifest({
        id: 'audit-logger',
        consumes: [{ artifact_type: 'code-patches', schema_version: '^1.0' }],
      }),
    ];
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        throw new Error('boom');
      }
      return [];
    };
    const exec = buildExecutor(graph, registry, manifests, { invoker });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-1',
        payload: securityExample,
      },
    );
    expect(result.ok).toBe(false);
    const fixer = result.steps.find((s) => s.pluginId === 'code-fixer');
    const audit = result.steps.find((s) => s.pluginId === 'audit-logger');
    expect(fixer?.status).toBe('error');
    expect(audit?.status).toBe('skipped');
    expect(audit?.error).toMatch(/upstream error in code-fixer/);
  });

  it('parallel-branch plugin (NOT downstream of failed plugin) still runs', async () => {
    // security-reviewer → code-fixer (fails)
    // security-reviewer → indep-consumer (parallel; should run)
    const manifests: HookManifest[] = [
      buildManifest({
        id: 'security-reviewer',
        produces: [
          { artifact_type: 'security-findings', schema_version: '1.0', format: 'json' },
        ],
      }),
      buildManifest({
        id: 'code-fixer',
        consumes: [{ artifact_type: 'security-findings', schema_version: '^1.0' }],
        produces: [
          { artifact_type: 'code-patches', schema_version: '1.0', format: 'json' },
        ],
      }),
      buildManifest({
        id: 'indep-consumer',
        consumes: [{ artifact_type: 'security-findings', schema_version: '^1.0' }],
      }),
    ];
    const graph = buildGraphFrom(manifests);
    let indepRan = false;
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') throw new Error('boom');
      if (pid === 'indep-consumer') {
        indepRan = true;
        return [];
      }
      return [];
    };
    const exec = buildExecutor(graph, registry, manifests, { invoker });
    await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-1',
        payload: securityExample,
      },
    );
    expect(indepRan).toBe(true);
  });

  it('downstream consumer with no upstream producer in this chain run: status="skipped"', async () => {
    const manifests: HookManifest[] = [
      buildManifest({
        id: 'security-reviewer',
        produces: [
          { artifact_type: 'security-findings', schema_version: '1.0', format: 'json' },
        ],
      }),
      // Wants code-patches; nothing in this run produces it. The id sorts
      // lex-after 'security-reviewer' so it appears AFTER the trigger in
      // the topological order (Kahn's lex tie-break for in-degree-0 nodes).
      buildManifest({
        id: 'zz-misfit',
        consumes: [{ artifact_type: 'code-patches', schema_version: '^1.0' }],
      }),
    ];
    const graph = buildGraphFrom(manifests);
    const exec = buildExecutor(graph, registry, manifests);
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-1',
        payload: securityExample,
      },
    );
    const misfit = result.steps.find((s) => s.pluginId === 'zz-misfit');
    expect(misfit?.status).toBe('skipped');
    expect(misfit?.error).toMatch(/no upstream producer in this chain run/);
  });

  it('produced payload failing its produced-schema validation: step status="error" with skip-cascade', async () => {
    const manifests: HookManifest[] = [
      ...twoPluginManifests(),
      buildManifest({
        id: 'audit-logger',
        consumes: [{ artifact_type: 'code-patches', schema_version: '^1.0' }],
      }),
    ];
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [
          {
            artifactType: 'code-patches',
            scanId: 'patches-1',
            payload: { invalid: 'shape' },
          },
        ];
      }
      return [];
    };
    const exec = buildExecutor(graph, registry, manifests, { invoker });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-1',
        payload: securityExample,
      },
    );
    expect(result.steps.find((s) => s.pluginId === 'code-fixer')?.status).toBe(
      'error',
    );
    expect(result.steps.find((s) => s.pluginId === 'audit-logger')?.status).toBe(
      'skipped',
    );
  });

  it('each successful step\'s durationMs > 0', async () => {
    const manifests = twoPluginManifests();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async () => [
      { artifactType: 'code-patches', scanId: 'p1', payload: patchesExample },
    ];
    const exec = buildExecutor(graph, registry, manifests, { invoker });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-1',
        payload: securityExample,
      },
    );
    for (const s of result.steps.filter((x) => x.status === 'ok')) {
      expect(s.durationMs).toBeGreaterThan(0);
    }
  });

  it('each persisted artifact exists at <requestRoot>/.autonomous-dev/artifacts/<type>/<scanId>.json', async () => {
    const manifests = twoPluginManifests();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [
          { artifactType: 'code-patches', scanId: 'p1', payload: patchesExample },
        ];
      }
      return [];
    };
    const exec = buildExecutor(graph, registry, manifests, { invoker });
    await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-1',
        payload: securityExample,
      },
    );
    await expect(
      fs.stat(
        path.join(
          tempRoot,
          '.autonomous-dev',
          'artifacts',
          'security-findings',
          'scan-1.json',
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(
        path.join(tempRoot, '.autonomous-dev', 'artifacts', 'code-patches', 'p1.json'),
      ),
    ).resolves.toBeDefined();
  });

  it('logger.info called once per step with prefix "chain:"', async () => {
    const manifests = twoPluginManifests();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async () => [
      { artifactType: 'code-patches', scanId: 'p1', payload: patchesExample },
    ];
    const lines: string[] = [];
    const logger = { info: (s: string) => lines.push(s) };
    const exec = buildExecutor(graph, registry, manifests, { invoker, logger });
    await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-1',
        payload: securityExample,
      },
    );
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((l) => l.startsWith('chain:'))).toBe(true);
  });
});

describe('ChainExecutor (smoke)', () => {
  it('constructs without crashing on an empty graph', () => {
    const g = new DependencyGraph();
    const r = new ArtifactRegistry();
    const exec = new ChainExecutor(
      g,
      r,
      () => undefined,
      async () => [],
    );
    expect(exec).toBeInstanceOf(ChainExecutor);
  });
});
