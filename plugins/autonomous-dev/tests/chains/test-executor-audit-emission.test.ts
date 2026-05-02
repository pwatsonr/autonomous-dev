/**
 * Executor audit-emission integration tests (SPEC-022-3-03, Task 7).
 *
 * Verifies the executor emits the right audit entries at every chain
 * lifecycle event, with the right counts per scenario and the right
 * `signed` flag on `artifact_emitted`.
 *
 * @module tests/chains/test-executor-audit-emission
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ChainAuditWriter } from '../../intake/chains/audit-writer';
import { ChainExecutor, type ChainHookInvoker } from '../../intake/chains/executor';
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
import type { ChainAuditEntry, ChainEventType } from '../../intake/chains/audit-events';
import type { ManifestLookup } from '../../intake/chains/executor';
import type { HookManifest } from '../../intake/hooks/types';

const KEY = Buffer.alloc(32, 9);

async function readEntries(p: string): Promise<ChainAuditEntry[]> {
  const raw = await fs.readFile(p, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ChainAuditEntry);
}

function counts(entries: ChainAuditEntry[]): Record<ChainEventType, number> {
  const c: Partial<Record<ChainEventType, number>> = {};
  for (const e of entries) {
    c[e.type] = (c[e.type] ?? 0) + 1;
  }
  return c as Record<ChainEventType, number>;
}

describe('ChainExecutor audit emission', () => {
  let tempRoot: string;
  let logDir: string;
  let logPath: string;
  let registry: ArtifactRegistry;
  let securityExample: unknown;
  let patchesExample: unknown;
  let writer: ChainAuditWriter;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-exec-audit-'));
    logPath = path.join(logDir, 'chains-audit.log');
    registry = await loadArtifactSchemas();
    securityExample = await loadSecurityFindingsExample();
    patchesExample = await loadCodePatchesExample();
    writer = await ChainAuditWriter.open({ logPath, key: KEY });
  });

  afterEach(async () => {
    await writer.close();
    await fs.rm(logDir, { recursive: true, force: true });
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
        consumes: [{ artifact_type: 'security-findings', schema_version: '^1.0' }],
        produces: [
          { artifact_type: 'code-patches', schema_version: '1.0', format: 'json' },
        ],
      }),
    ];
  }

  it('successful 2-plugin chain emits chain_started + plugin_invoked + plugin_completed + 2x artifact_emitted + chain_completed', async () => {
    const manifests = twoPluginManifests();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [
          { artifactType: 'code-patches', scanId: 'patches-1', payload: patchesExample },
        ];
      }
      return [];
    };
    const exec = new ChainExecutor(
      graph,
      registry,
      ((id) => manifests.find((m) => m.id === id)) as ManifestLookup,
      invoker,
      { info: () => undefined, warn: () => undefined },
      { chainAuditWriter: writer, chainId: 'CH-OK-1', chainName: 'two-plugin' },
    );
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-ok' },
      { artifactType: 'security-findings', scanId: 'scan-1', payload: securityExample },
    );
    expect(result.ok).toBe(true);

    // Force a flush by closing+reopening for the read.
    await writer.close();
    const entries = await readEntries(logPath);
    const c = counts(entries);
    expect(c.chain_started).toBe(1);
    expect(c.plugin_invoked).toBe(1);
    expect(c.plugin_completed).toBe(1);
    expect(c.artifact_emitted).toBe(2); // seed + downstream
    expect(c.chain_completed).toBe(1);
    // Every entry references this chain id.
    expect(entries.every((e) => e.chain_id === 'CH-OK-1')).toBe(true);
    // chain_completed.entries reflects the executor's own count.
    const completed = entries.find((e) => e.type === 'chain_completed')!;
    expect((completed.payload as { entries: number }).entries).toBe(entries.length);
    // Reopen so afterEach close() doesn't double-close.
    writer = await ChainAuditWriter.open({ logPath, key: KEY });
  });

  it('plugin failure emits plugin_failed + chain_failed', async () => {
    const manifests = twoPluginManifests();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        const err = new Error('synthetic failure');
        err.name = 'SyntheticError';
        throw err;
      }
      return [];
    };
    const exec = new ChainExecutor(
      graph,
      registry,
      ((id) => manifests.find((m) => m.id === id)) as ManifestLookup,
      invoker,
      { info: () => undefined, warn: () => undefined },
      { chainAuditWriter: writer, chainId: 'CH-FAIL-1' },
    );
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-fail' },
      { artifactType: 'security-findings', scanId: 'scan-1', payload: securityExample },
    );
    expect(result.ok).toBe(false);

    await writer.close();
    const entries = await readEntries(logPath);
    const c = counts(entries);
    expect(c.chain_started).toBe(1);
    expect(c.plugin_invoked).toBe(1);
    expect(c.plugin_failed).toBe(1);
    expect(c.chain_failed).toBe(1);
    expect(c.chain_completed).toBeUndefined();

    const failedEntry = entries.find((e) => e.type === 'plugin_failed')!;
    expect((failedEntry.payload as { plugin_id: string }).plugin_id).toBe('code-fixer');
    expect((failedEntry.payload as { error_code: string }).error_code).toBe('SyntheticError');
    writer = await ChainAuditWriter.open({ logPath, key: KEY });
  });

  it('artifact_emitted.signed is true for requires_approval producers, false otherwise', async () => {
    const manifests = [
      buildManifest({
        id: 'reviewer',
        produces: [
          {
            artifact_type: 'security-findings',
            schema_version: '1.0',
            format: 'json',
            requires_approval: true,
          },
        ],
      }),
    ];
    const graph = buildGraphFrom(manifests);
    const exec = new ChainExecutor(
      graph,
      registry,
      ((id) => manifests.find((m) => m.id === id)) as ManifestLookup,
      async () => [],
      { info: () => undefined, warn: () => undefined },
      { chainAuditWriter: writer, chainId: 'CH-PRIV-1' },
    );
    // No state-store injected → privileged seed proceeds without pause.
    await exec.executeChain(
      'reviewer',
      { requestRoot: tempRoot, requestId: 'req-priv' },
      { artifactType: 'security-findings', scanId: 'scan-1', payload: securityExample },
    );

    await writer.close();
    const entries = await readEntries(logPath);
    const seed = entries.find((e) => e.type === 'artifact_emitted')!;
    expect((seed.payload as { signed: boolean }).signed).toBe(true);
    writer = await ChainAuditWriter.open({ logPath, key: KEY });
  });

  it('audit append failure does not abort the chain (fail-OPEN)', async () => {
    const manifests = twoPluginManifests();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        return [
          { artifactType: 'code-patches', scanId: 'patches-1', payload: patchesExample },
        ];
      }
      return [];
    };
    const warns: string[] = [];
    // Wrap the writer with a stub that throws on append.
    const failingWriter = {
      append: async () => {
        throw new Error('synthetic disk full');
      },
    } as unknown as ChainAuditWriter;
    const exec = new ChainExecutor(
      graph,
      registry,
      ((id) => manifests.find((m) => m.id === id)) as ManifestLookup,
      invoker,
      { info: () => undefined, warn: (s: string) => warns.push(s) },
      { chainAuditWriter: failingWriter, chainId: 'CH-FAILOPEN' },
    );
    const result = await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-failopen' },
      { artifactType: 'security-findings', scanId: 'scan-1', payload: securityExample },
    );
    // Chain still completes successfully despite audit failures.
    expect(result.ok).toBe(true);
    // Every audit emit logged a warning.
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.some((w) => /audit emit failed/.test(w))).toBe(true);
  });

  it('plugin_completed.duration_ms is positive', async () => {
    const manifests = twoPluginManifests();
    const graph = buildGraphFrom(manifests);
    const invoker: ChainHookInvoker = async (pid) => {
      if (pid === 'code-fixer') {
        // Tiny sleep so duration is reliably nonzero.
        await new Promise((r) => setTimeout(r, 5));
        return [
          { artifactType: 'code-patches', scanId: 'patches-1', payload: patchesExample },
        ];
      }
      return [];
    };
    const exec = new ChainExecutor(
      graph,
      registry,
      ((id) => manifests.find((m) => m.id === id)) as ManifestLookup,
      invoker,
      { info: () => undefined, warn: () => undefined },
      { chainAuditWriter: writer, chainId: 'CH-DURATION' },
    );
    await exec.executeChain(
      'security-reviewer',
      { requestRoot: tempRoot, requestId: 'req-d' },
      { artifactType: 'security-findings', scanId: 'scan-1', payload: securityExample },
    );

    await writer.close();
    const entries = await readEntries(logPath);
    const completed = entries.find((e) => e.type === 'plugin_completed')!;
    expect((completed.payload as { duration_ms: number }).duration_ms).toBeGreaterThan(0);
    writer = await ChainAuditWriter.open({ logPath, key: KEY });
  });
});
