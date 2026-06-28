import {
  writeSignalsSidecar,
  loadSignalsSidecar,
  sidecarPath,
  sidecarFileName,
  signalsDir,
} from '../../src/ingest/signals-sidecar';
import type { SignalsSidecarIO } from '../../src/ingest/signals-sidecar';
import { signalsFromMemory } from '../../src/ingest/inference';
import type { RepoSignals } from '../../src/ingest/inference';
import { ingestRepo } from '../../src/ingest/orchestrator';
import type { RepoSource, RepoMeta } from '../../src/ingest/types';
import type { MemoryStoreIO } from '../../src/memory/store';

/**
 * Unit tests for the structured signals sidecar (ONBOARD Phase 1, #588).
 *
 * The sidecar decouples inference from the human-readable memory markdown: it is
 * written at EXTRACTION time and PREFERRED at INFERENCE time, with a fall-back to
 * `signalsFromMemory` when missing/corrupt. Injected fake IO — never touches
 * operator state.
 */

function fakeSignalsIO(): SignalsSidecarIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p: string) => files[p],
    writeFile: (p: string, data: string) => {
      files[p] = data;
    },
  };
}

function fakeMemoryIO(): MemoryStoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p: string) => files[p],
    writeFile: (p: string, data: string) => {
      files[p] = data;
    },
    listDir: () => [],
  };
}

/** Replica of the CLI `repoSignals` glue (#588): prefer the sidecar, else parse markdown. */
function repoSignals(
  repoId: string,
  docs: { topic: string; content: string }[],
  io: SignalsSidecarIO,
): RepoSignals {
  return loadSignalsSidecar(repoId, io) ?? signalsFromMemory(repoId, docs);
}

function test_round_trip(): void {
  const io = fakeSignalsIO();
  const signals: RepoSignals = {
    repoId: 'acme/payments-api',
    owners: ['@acme/payments'],
    deps: ['left-pad'],
    namePrefix: 'payments',
  };
  assert(loadSignalsSidecar('acme/payments-api', io) === undefined, 'missing sidecar reads undefined');
  writeSignalsSidecar('acme/payments-api', signals, io);
  const loaded = loadSignalsSidecar('acme/payments-api', io);
  assert(!!loaded, 'sidecar loads after write');
  assert(loaded!.repoId === 'acme/payments-api', 'repoId round-trips');
  assert(loaded!.owners.join(',') === '@acme/payments', 'owners round-trip');
  assert(loaded!.deps.join(',') === 'left-pad', 'deps round-trip');
  assert(loaded!.namePrefix === 'payments', 'namePrefix round-trips');
  assert(typeof io.files[sidecarPath('acme/payments-api', io)] === 'string', 'written to canonical path');
  console.log('PASS: test_round_trip');
}

function test_filename_is_flat_and_traversal_safe(): void {
  // The `/` in owner/name must not create a subdir, and no name may escape dir.
  assert(!sidecarFileName('acme/payments').includes('/'), 'slash collapsed (no subdir)');
  assert(sidecarFileName('acme/payments') === 'acme_payments.json', 'slash -> underscore');
  assert(!sidecarFileName('../../etc/passwd').includes('/'), 'no path separators survive');
  assert(!sidecarFileName('../../etc/passwd').startsWith('.'), 'leading dots neutralised');
  // The full path always stays under the signals dir.
  assert(sidecarPath('acme/payments').startsWith(signalsDir()), 'path stays under signals dir');
  assert(sidecarPath('../../etc/passwd').startsWith(signalsDir()), 'hostile id stays under signals dir');
  console.log('PASS: test_filename_is_flat_and_traversal_safe');
}

function test_corrupt_reads_undefined(): void {
  const io = fakeSignalsIO();
  io.files[sidecarPath('o/a', io)] = '{ broken json';
  assert(loadSignalsSidecar('o/a', io) === undefined, 'corrupt JSON => undefined (fallback)');
  console.log('PASS: test_corrupt_reads_undefined');
}

function test_invalid_shape_reads_undefined(): void {
  const io = fakeSignalsIO();
  // Valid JSON but not a RepoSignals envelope (owners is not a string[]).
  io.files[sidecarPath('o/b', io)] = JSON.stringify({ version: 1, signals: { repoId: 'o/b', owners: 'nope', deps: [] } });
  assert(loadSignalsSidecar('o/b', io) === undefined, 'wrong-typed field => undefined (fallback)');
  io.files[sidecarPath('o/c', io)] = JSON.stringify({ version: 1, signals: { owners: [], deps: [] } });
  assert(loadSignalsSidecar('o/c', io) === undefined, 'missing repoId => undefined (fallback)');
  console.log('PASS: test_invalid_shape_reads_undefined');
}

function test_tolerates_bare_signals_object(): void {
  const io = fakeSignalsIO();
  // A bare RepoSignals (no version envelope) is still accepted.
  io.files[sidecarPath('o/d', io)] = JSON.stringify({ repoId: 'o/d', owners: ['@o/team'], deps: [] });
  const loaded = loadSignalsSidecar('o/d', io);
  assert(!!loaded && loaded!.owners.join(',') === '@o/team', 'bare RepoSignals object accepted');
  console.log('PASS: test_tolerates_bare_signals_object');
}

function test_inference_prefers_sidecar_else_markdown(): void {
  const io = fakeSignalsIO();
  const markdownDocs = [
    { topic: 'ownership', content: '# Ownership\n\n```\n* @acme/from-markdown\n```' },
  ];

  // No sidecar => falls back to the markdown parse.
  const fromMarkdown = repoSignals('acme/repo', markdownDocs, io);
  assert(fromMarkdown.owners.join(',') === '@acme/from-markdown', 'absent sidecar => markdown parse');

  // Sidecar present => preferred over markdown (distinct owner proves the source).
  writeSignalsSidecar('acme/repo', { repoId: 'acme/repo', owners: ['@acme/from-sidecar'], deps: [] }, io);
  const fromSidecar = repoSignals('acme/repo', markdownDocs, io);
  assert(fromSidecar.owners.join(',') === '@acme/from-sidecar', 'present sidecar => preferred');

  // Corrupt sidecar => falls back to markdown again.
  io.files[sidecarPath('acme/repo', io)] = 'not json';
  const fallback = repoSignals('acme/repo', markdownDocs, io);
  assert(fallback.owners.join(',') === '@acme/from-markdown', 'corrupt sidecar => markdown fallback');
  console.log('PASS: test_inference_prefers_sidecar_else_markdown');
}

function fakeRepoWithCodeowners(meta: RepoMeta, codeowners: string): RepoSource {
  return {
    meta,
    readFile: (rel: string) => (rel === 'CODEOWNERS' ? codeowners : undefined),
    listFiles: () => [],
  };
}

function test_ingest_repo_writes_sidecar(): void {
  const memIO = fakeMemoryIO();
  const sigIO = fakeSignalsIO();
  const repo = fakeRepoWithCodeowners(
    { id: 'acme/orders', defaultBranch: 'main', headSha: 'h1' },
    '* @acme/payments\n',
  );
  ingestRepo(repo, undefined, memIO, sigIO);
  const loaded = loadSignalsSidecar('acme/orders', sigIO);
  assert(!!loaded, 'extraction wrote a sidecar');
  assert(loaded!.owners.join(',') === '@acme/payments', 'sidecar carries the extracted owner');
  // The sidecar is a faithful machine-readable form of the markdown parse.
  const ownershipKey = Object.keys(memIO.files).find((k) => k.endsWith('/ownership.md'))!;
  const fromMarkdown = signalsFromMemory('acme/orders', [
    { topic: 'ownership', content: memIO.files[ownershipKey] },
  ]);
  assert(
    JSON.stringify(loaded!.owners) === JSON.stringify(fromMarkdown.owners),
    'sidecar owners match the markdown parse (faithful)',
  );
  console.log('PASS: test_ingest_repo_writes_sidecar');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('ingest/signals-sidecar (structured signals decoupling)', () => {
  it('test_round_trip', test_round_trip);
  it('test_filename_is_flat_and_traversal_safe', test_filename_is_flat_and_traversal_safe);
  it('test_corrupt_reads_undefined', test_corrupt_reads_undefined);
  it('test_invalid_shape_reads_undefined', test_invalid_shape_reads_undefined);
  it('test_tolerates_bare_signals_object', test_tolerates_bare_signals_object);
  it('test_inference_prefers_sidecar_else_markdown', test_inference_prefers_sidecar_else_markdown);
  it('test_ingest_repo_writes_sidecar', test_ingest_repo_writes_sidecar);
});
