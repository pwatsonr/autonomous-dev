/**
 * Unit tests for ArtifactRegistry (SPEC-022-1-02 / SPEC-022-1-05).
 *
 * Covers schema loading + caching, validation behavior, atomic-write
 * persistence (temp + rename), path-traversal defenses, and load round-trips.
 *
 * @module tests/chains/test-artifact-registry
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ArtifactRegistry } from '../../intake/chains/artifact-registry';
import {
  createTempRequestDir,
  cleanupTempDir,
  loadArtifactSchemas,
  loadSecurityFindingsExample,
} from '../helpers/chain-fixtures';

const SCHEMA_ROOT = path.resolve(__dirname, '..', '..', 'schemas', 'artifacts');

describe('ArtifactRegistry', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempRoot);
  });

  it('loadSchemas registers both shipped types', async () => {
    const reg = await loadArtifactSchemas();
    const types = reg.knownTypes();
    const keys = types.map((t) => `${t.artifactType}@${t.schemaVersion}`);
    expect(keys).toContain('security-findings@1.0');
    expect(keys).toContain('code-patches@1.0');
  });

  it('loadSchemas returns errors for a malformed schema file but loads the others', async () => {
    // Synthesize a temp schema dir mirroring the real one, with one bad file.
    const tmpSchemaRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ad-schema-'),
    );
    try {
      const goodDir = path.join(tmpSchemaRoot, 'security-findings');
      await fs.mkdir(goodDir, { recursive: true });
      await fs.copyFile(
        path.join(SCHEMA_ROOT, 'security-findings', '1.0.json'),
        path.join(goodDir, '1.0.json'),
      );
      const badDir = path.join(tmpSchemaRoot, 'broken-type');
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(path.join(badDir, '1.0.json'), '{ this is not json');

      const reg = new ArtifactRegistry();
      const out = await reg.loadSchemas(tmpSchemaRoot);
      expect(out.errors.length).toBeGreaterThan(0);
      expect(out.errors.some((e) => e.includes('broken-type'))).toBe(true);
      expect(out.loaded).toContain('security-findings@1.0');
    } finally {
      await cleanupTempDir(tmpSchemaRoot);
    }
  });

  it('validate returns isValid:true for canonical security-findings example', async () => {
    const reg = await loadArtifactSchemas();
    const example = await loadSecurityFindingsExample();
    const r = reg.validate('security-findings', '1.0', example);
    expect(r.isValid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('validate returns isValid:false with pointer at /findings/0/severity for an enum violation', async () => {
    const reg = await loadArtifactSchemas();
    const example = JSON.parse(
      JSON.stringify(await loadSecurityFindingsExample()),
    );
    example.findings[0].severity = 'urgent';
    const r = reg.validate('security-findings', '1.0', example);
    expect(r.isValid).toBe(false);
    const ptrs = r.errors.map((e) => e.pointer);
    expect(ptrs).toContain('/findings/0/severity');
  });

  it("validate of unknown type returns isValid:false with 'unknown artifact type'", async () => {
    const reg = await loadArtifactSchemas();
    const r = reg.validate('not-a-real-type', '1.0', {});
    expect(r.isValid).toBe(false);
    expect(r.errors[0].message).toContain('unknown artifact type');
  });

  it('persist writes file at <requestRoot>/.autonomous-dev/artifacts/<type>/<scanId>.json', async () => {
    const reg = await loadArtifactSchemas();
    const example = await loadSecurityFindingsExample();
    const rec = await reg.persist(
      tempRoot,
      'security-findings',
      'scan-001',
      example,
    );
    const expected = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
      'scan-001.json',
    );
    expect(rec.filePath).toBe(expected);
    const stat = await fs.stat(expected);
    // POSIX file mode bits.
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('persist creates parent directories if absent (mkdir recursive)', async () => {
    const reg = await loadArtifactSchemas();
    const nested = path.join(tempRoot, 'deeper', 'still');
    await reg.persist(
      nested,
      'security-findings',
      'scan-002',
      await loadSecurityFindingsExample(),
    );
    const exists = fsSync.existsSync(
      path.join(nested, '.autonomous-dev', 'artifacts', 'security-findings'),
    );
    expect(exists).toBe(true);
  });

  it('persist uses temp file then rename (no .tmp.* file remains after)', async () => {
    const reg = await loadArtifactSchemas();
    await reg.persist(
      tempRoot,
      'security-findings',
      'scan-003',
      await loadSecurityFindingsExample(),
    );
    const dir = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
    );
    const entries = await fs.readdir(dir);
    expect(entries.some((n) => n.includes('.tmp.'))).toBe(false);
  });

  it('persist with simulated rename failure unlinks the temp file', async () => {
    // We can't reliably jest.spyOn fs.promises.rename across runtimes
    // (some Node builds expose it as a non-configurable getter). Instead,
    // make rename fail by pre-creating the target as a directory: rename of
    // a regular file onto an existing directory throws EISDIR/ENOTEMPTY,
    // which exercises the SAME error-handling branch (catch → unlink temp).
    const reg = await loadArtifactSchemas();
    const dir = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
    );
    await fs.mkdir(dir, { recursive: true });
    // Create a directory at the target file path so fs.rename fails.
    await fs.mkdir(path.join(dir, 'scan-004.json'));
    await expect(
      reg.persist(
        tempRoot,
        'security-findings',
        'scan-004',
        await loadSecurityFindingsExample(),
      ),
    ).rejects.toThrow();
    const entries = fsSync.existsSync(dir) ? await fs.readdir(dir) : [];
    expect(entries.some((n) => n.includes('.tmp.'))).toBe(false);
  });

  it("persist rejects scanId containing '..'", async () => {
    const reg = await loadArtifactSchemas();
    await expect(
      reg.persist(tempRoot, 'security-findings', '..evil', {}),
    ).rejects.toThrow('invalid scanId');
  });

  it("persist rejects scanId containing '/'", async () => {
    const reg = await loadArtifactSchemas();
    await expect(
      reg.persist(tempRoot, 'security-findings', 'a/b', {}),
    ).rejects.toThrow('invalid scanId');
  });

  it('load round-trips a persisted artifact deep-equal', async () => {
    const reg = await loadArtifactSchemas();
    const example = await loadSecurityFindingsExample();
    await reg.persist(tempRoot, 'security-findings', 'scan-005', example);
    const loaded = await reg.load(tempRoot, 'security-findings', 'scan-005');
    expect(loaded).toEqual(example);
  });

  it("load throws 'artifact not found' on ENOENT", async () => {
    const reg = await loadArtifactSchemas();
    await expect(
      reg.load(tempRoot, 'security-findings', 'never-written'),
    ).rejects.toThrow('artifact not found');
  });

  it('knownTypes returns lex-sorted list', async () => {
    const reg = await loadArtifactSchemas();
    const list = reg.knownTypes();
    const names = list.map((t) => t.artifactType);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('loadSchemas called twice replaces the cache (no duplicates)', async () => {
    const reg = new ArtifactRegistry();
    await reg.loadSchemas(SCHEMA_ROOT);
    const before = reg.knownTypes().length;
    await reg.loadSchemas(SCHEMA_ROOT);
    const after = reg.knownTypes().length;
    expect(after).toBe(before);
  });
});
