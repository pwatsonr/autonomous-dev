/**
 * Shared helpers for chain-engine test suites (SPEC-022-1-05).
 *
 * Every helper that touches disk creates state under `os.tmpdir()` and
 * exposes a cleanup function — no test reaches into `~/.claude/plugins/`
 * or `~/.autonomous-dev/`.
 *
 * @module tests/helpers/chain-fixtures
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ArtifactRegistry } from '../../intake/chains/artifact-registry';
import { DependencyGraph } from '../../intake/chains/dependency-graph';
import {
  ChainExecutor,
  type ChainHookInvoker,
  type ManifestLookup,
} from '../../intake/chains/executor';
import type {
  HookManifest,
  ProducesDeclaration,
  ConsumesDeclaration,
} from '../../intake/hooks/types';

/** Create a fresh temp dir under os.tmpdir() with the prefix `ad-chain-`. */
export async function createTempRequestDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ad-chain-'));
}

/** Recursively remove the temp dir; idempotent. */
export async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export interface BuildManifestOpts {
  id: string;
  produces?: ProducesDeclaration[];
  consumes?: ConsumesDeclaration[];
  version?: string;
  name?: string;
}

/** Construct a v2 HookManifest with sane defaults; no hooks declared. */
export function buildManifest(opts: BuildManifestOpts): HookManifest {
  return {
    id: opts.id,
    name: opts.name ?? opts.id,
    version: opts.version ?? '1.0.0',
    hooks: [],
    produces: opts.produces,
    consumes: opts.consumes,
  };
}

/** Instantiate a DependencyGraph and addPlugin each manifest. */
export function buildGraphFrom(manifests: HookManifest[]): DependencyGraph {
  const g = new DependencyGraph();
  for (const m of manifests) g.addPlugin(m);
  return g;
}

export interface BuildExecutorOpts {
  invoker?: ChainHookInvoker;
  logger?: { info: (s: string) => void };
}

/**
 * Wire up a ChainExecutor with a manifestLookup keyed by manifest array
 * and an injectable invoker (defaulting to a noop that returns []).
 */
export function buildExecutor(
  graph: DependencyGraph,
  artifacts: ArtifactRegistry,
  manifests: HookManifest[],
  opts: BuildExecutorOpts = {},
): ChainExecutor {
  const lookup: ManifestLookup = (id) => manifests.find((m) => m.id === id);
  const invoker: ChainHookInvoker =
    opts.invoker ?? (async () => []);
  return new ChainExecutor(graph, artifacts, lookup, invoker, opts.logger);
}

/**
 * Boot an ArtifactRegistry against the repo's `schemas/artifacts/` dir.
 *
 * The repo root is two levels above this helper file:
 *   tests/helpers/chain-fixtures.ts → plugins/autonomous-dev/
 */
export async function loadArtifactSchemas(): Promise<ArtifactRegistry> {
  const reg = new ArtifactRegistry();
  const schemaRoot = path.resolve(__dirname, '..', '..', 'schemas', 'artifacts');
  await reg.loadSchemas(schemaRoot);
  return reg;
}

/** Read the canonical security-findings example fixture from disk. */
export async function loadSecurityFindingsExample(): Promise<unknown> {
  const p = path.resolve(
    __dirname,
    '..',
    'fixtures',
    'artifacts',
    'security-findings.example.json',
  );
  return JSON.parse(await fs.readFile(p, 'utf-8'));
}

/** Read the canonical code-patches example fixture from disk. */
export async function loadCodePatchesExample(): Promise<unknown> {
  const p = path.resolve(
    __dirname,
    '..',
    'fixtures',
    'artifacts',
    'code-patches.example.json',
  );
  return JSON.parse(await fs.readFile(p, 'utf-8'));
}
