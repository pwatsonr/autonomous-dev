/**
 * Unit tests for the YAML standards loader (SPEC-021-1-05, TDD-021 §16).
 *
 * The corpus at `tests/fixtures/standards/v1/` is described in INDEX.md.
 * The parser at `parse-fixtures-index.ts` extracts the table rows into
 * descriptors, then `describe.each` iterates them — adding a new fixture
 * to either table automatically extends coverage.
 *
 * In addition to the corpus-driven cases, this suite asserts:
 *   - Security: FAILSAFE_SCHEMA rejects `!!python/object` and `!!js/function`.
 *   - Size cap: files larger than `MAX_FILE_BYTES` are rejected via stat,
 *     before `readFile` is ever called (verified with `jest.spyOn(fs, ...)`).
 *   - IO: missing path returns `io_error`; multiple schema errors all
 *     surface in `errors[]` (not just the first).
 *
 * @module tests/standards/test-loader.test
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  loadStandardsFile,
  MAX_FILE_BYTES,
  __resetValidatorCacheForTests,
} from '../../intake/standards/loader';
import {
  parseFixturesIndex,
  FIXTURE_ROOT,
  type ValidFixture,
  type InvalidFixture,
} from './parse-fixtures-index';

// ---------------------------------------------------------------------------
// Corpus-driven blocks
// ---------------------------------------------------------------------------

const index = parseFixturesIndex();
const validRows: ValidFixture[] = index.valid;
const invalidRows: InvalidFixture[] = index.invalid;

beforeAll(() => {
  // Recompiling the validator between test files is cheap (~1ms) but
  // resetting up-front guarantees no leftover state from a sibling suite.
  __resetValidatorCacheForTests();
});

describe('loadStandardsFile — INDEX-driven valid fixtures', () => {
  // Sanity-check that the parser actually found the corpus.
  it('parses INDEX.md with at least one valid fixture', () => {
    expect(validRows.length).toBeGreaterThan(0);
  });

  it.each(validRows.map((f) => [f.relPath, f]))(
    'loads %s clean (no errors, artifact present)',
    async (_label, fixture) => {
      const r = await loadStandardsFile((fixture as ValidFixture).absPath);
      expect(r.errors).toEqual([]);
      expect(r.artifact).not.toBeNull();
      expect(r.artifact?.version).toBe('1');
    },
  );
});

describe('loadStandardsFile — INDEX-driven invalid fixtures', () => {
  it('parses INDEX.md with at least one invalid fixture', () => {
    expect(invalidRows.length).toBeGreaterThan(0);
  });

  it.each(invalidRows.map((f) => [f.relPath, f]))(
    'rejects %s with the documented error type',
    async (_label, fixture) => {
      const f = fixture as InvalidFixture;
      const r = await loadStandardsFile(f.absPath);
      expect(r.artifact).toBeNull();
      expect(r.errors.length).toBeGreaterThan(0);
      const types = r.errors.map((e) => e.type);
      expect(types).toContain(f.expectedErrorType);
    },
  );
});

// ---------------------------------------------------------------------------
// Security: FAILSAFE_SCHEMA + size cap
// ---------------------------------------------------------------------------

describe('loadStandardsFile — security defenses', () => {
  it('rejects !!python/object payload as parse_error (FAILSAFE_SCHEMA)', async () => {
    const p = path.join(FIXTURE_ROOT, 'invalid', 'python-object-tag.yaml');
    const r = await loadStandardsFile(p);
    expect(r.artifact).toBeNull();
    expect(r.errors[0].type).toBe('parse_error');
  });

  it('rejects !!js/function payload as parse_error (FAILSAFE_SCHEMA)', async () => {
    const p = path.join(FIXTURE_ROOT, 'invalid', 'js-function-tag.yaml');
    const r = await loadStandardsFile(p);
    expect(r.artifact).toBeNull();
    expect(r.errors[0].type).toBe('parse_error');
  });

  it('rejects files larger than MAX_FILE_BYTES without reading their contents', async () => {
    // Use a real temp file whose stat reports a size > MAX_FILE_BYTES.
    // Spying on stat avoids actually allocating 1MB+ on disk while still
    // exercising the real readFile-not-called branch.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'std-loader-size-'));
    const target = path.join(tmp, 'huge.yaml');
    await fs.writeFile(target, 'version: "1"\n', 'utf8');

    const statSpy = jest.spyOn(fs, 'stat').mockResolvedValue({
      // Only `size` is read by the loader; everything else is filler.
      size: MAX_FILE_BYTES + 1,
    } as unknown as Awaited<ReturnType<typeof fs.stat>>);
    const readSpy = jest.spyOn(fs, 'readFile');

    try {
      const r = await loadStandardsFile(target);
      expect(r.artifact).toBeNull();
      expect(r.errors[0].type).toBe('size_exceeded');
      // Critical: the loader must NOT pull contents into memory.
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
      readSpy.mockRestore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// IO + multi-error surfacing
// ---------------------------------------------------------------------------

describe('loadStandardsFile — IO + error surfacing', () => {
  it('returns io_error for a non-existent path', async () => {
    const missing = path.join(
      os.tmpdir(),
      `does-not-exist-${Date.now()}-${Math.random()}.yaml`,
    );
    const r = await loadStandardsFile(missing);
    expect(r.artifact).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].type).toBe('io_error');
  });

  it('returns io_error when readFile throws (e.g., permission denied)', async () => {
    // Synthesize a permission-denied scenario by spying on fs.readFile.
    // chmod 000 is unreliable across CI environments (Linux containers
    // run as root and ignore the bits), so we mock instead.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'std-loader-eacces-'));
    const target = path.join(tmp, 'denied.yaml');
    await fs.writeFile(target, 'version: "1"\n', 'utf8');

    const readSpy = jest.spyOn(fs, 'readFile').mockImplementation(() => {
      const err = new Error("EACCES: permission denied, open 'denied.yaml'");
      (err as NodeJS.ErrnoException).code = 'EACCES';
      throw err;
    });

    try {
      const r = await loadStandardsFile(target);
      expect(r.artifact).toBeNull();
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].type).toBe('io_error');
      expect(r.errors[0].message).toMatch(/EACCES/);
    } finally {
      readSpy.mockRestore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('surfaces every schema error in errors[] (not just the first)', async () => {
    const p = path.join(FIXTURE_ROOT, 'invalid', 'multiple-errors.yaml');
    const r = await loadStandardsFile(p);
    expect(r.artifact).toBeNull();
    // The fixture violates two schema rules (bad id pattern + empty
    // requires); Ajv was compiled with `allErrors: true` so both must
    // surface.
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
    expect(r.errors.every((e) => e.type === 'schema_error')).toBe(true);
  });
});
