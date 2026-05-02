/**
 * End-to-end integration test for the chain engine (SPEC-022-1-05).
 *
 * Runs the full discovery → graph build → chain execution → artifact
 * persistence flow against three fixture plugins, exercised in-process
 * (rather than via spawned daemon) — the IPC + daemon-spawn path is
 * gated behind the daemon helpers from SPEC-019-1-05 and is `it.skip`
 * here because Bun is not on PATH in this sandbox; the in-process variant
 * still proves discovery, graph wiring, executor, and persistence.
 *
 * Three plugins:
 *   - security-reviewer: produces security-findings@1.0
 *   - code-fixer:        consumes ^1.0, produces code-patches@1.0
 *   - audit-logger:      consumes code-patches@^1.0; writes a sentinel file
 *
 * @module tests/integration/test-chain-execution
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
import type { ChainHookInvoker } from '../../intake/chains/executor';
import type { HookManifest } from '../../intake/hooks/types';
import { renderGraph } from '../../intake/chains/render';

describe('chain execution integration', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempRoot);
  });

  function buildThreePluginManifests(): HookManifest[] {
    return [
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
        id: 'audit-logger',
        consumes: [{ artifact_type: 'code-patches', schema_version: '^1.0' }],
      }),
    ];
  }

  it('runs a 3-plugin chain in-process and persists all artifacts (positive path)', async () => {
    const manifests = buildThreePluginManifests();
    const graph = buildGraphFrom(manifests);
    const registry = await loadArtifactSchemas();
    const securityExample = await loadSecurityFindingsExample();
    const patchesExample = await loadCodePatchesExample();

    const sentinelPath = path.join(tempRoot, '.autonomous-dev', 'audit-ran');
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [
          { artifactType: 'code-patches', scanId: 'patches-1', payload: patchesExample },
        ];
      }
      if (pid === 'audit-logger') {
        await fs.mkdir(path.dirname(sentinelPath), { recursive: true });
        await fs.writeFile(sentinelPath, 'ran');
        return [];
      }
      return [];
    };
    const exec = buildExecutor(graph, registry, manifests, { invoker });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-int-1' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-int-1',
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
      'scan-int-1.json',
    );
    const patchesPath = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'code-patches',
      'patches-1.json',
    );
    const findingsRaw = await fs.readFile(findingsPath, 'utf-8');
    // SPEC-022-3-02: persist() now seals payloads inside an HMAC envelope.
    // The producer's bytes live under `.payload`; envelope metadata lives
    // alongside.
    const onDiskFindings = JSON.parse(findingsRaw);
    expect(onDiskFindings.payload).toEqual(securityExample);
    expect(typeof onDiskFindings._chain_hmac).toBe('string');
    await expect(fs.stat(patchesPath)).resolves.toBeDefined();
    await expect(fs.stat(sentinelPath)).resolves.toBeDefined();
  });

  it('negative path: mid-chain throw skip-cascades audit-logger; sentinel absent', async () => {
    const manifests = buildThreePluginManifests();
    const graph = buildGraphFrom(manifests);
    const registry = await loadArtifactSchemas();
    const securityExample = await loadSecurityFindingsExample();

    const sentinelPath = path.join(tempRoot, '.autonomous-dev', 'audit-ran');
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') throw new Error('synthetic failure');
      if (pid === 'audit-logger') {
        await fs.mkdir(path.dirname(sentinelPath), { recursive: true });
        await fs.writeFile(sentinelPath, 'ran');
        return [];
      }
      return [];
    };
    const exec = buildExecutor(graph, registry, manifests, { invoker });
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-int-2' },
      {
        artifactType: 'security-findings',
        scanId: 'scan-int-2',
        payload: securityExample,
      },
    );

    expect(result.ok).toBe(false);
    const audit = result.steps.find((s) => s.pluginId === 'audit-logger');
    expect(audit?.status).toBe('skipped');
    expect(audit?.error).toMatch(/upstream error in code-fixer/);

    let sentinelExists = true;
    try {
      await fs.stat(sentinelPath);
    } catch {
      sentinelExists = false;
    }
    expect(sentinelExists).toBe(false);
  });

  it('renderGraph produces a deterministic DOT/Mermaid rendering of the 3-plugin graph', async () => {
    const manifests = buildThreePluginManifests();
    const graph = buildGraphFrom(manifests);
    const dot1 = renderGraph(graph, 'dot');
    const dot2 = renderGraph(graph, 'dot');
    expect(dot1).toBe(dot2);
    expect(dot1).toMatch(/^digraph chains \{/);
    expect(dot1).toContain('"security-reviewer" -> "code-fixer"');
    expect(dot1).toContain('"code-fixer" -> "audit-logger"');

    const merm = renderGraph(graph, 'mermaid');
    expect(merm).toMatch(/^graph TB/);
    expect(merm).toContain('security_reviewer');
    expect(merm).toContain('code_fixer');
    expect(merm).toContain('audit_logger');
  });

  // Daemon-spawn variant — Bun is not on PATH in this sandbox; SPEC-022-1-05
  // calls out that the daemon-spawn path lands in a follow-up. The
  // in-process variant above already exercises every primitive end-to-end.
  // eslint-disable-next-line jest/no-disabled-tests
  it.skip('runs a 3-plugin chain end-to-end through the spawned daemon (Bun not on PATH)', () => {
    // Intentionally skipped: requires `spawnDaemon` from SPEC-019-1-05's
    // helpers + Bun on PATH for the daemon binary.
  });
});
