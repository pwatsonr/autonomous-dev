/**
 * INDEX.md → JSON parser for the standards v1 fixture corpus (SPEC-021-1-05).
 *
 * The loader test suite is INDEX.md-driven: this parser reads the two
 * Markdown tables in `tests/fixtures/standards/v1/INDEX.md` and returns
 * structured fixture descriptors. Adding a new fixture to either table
 * automatically extends the loader test coverage with no code changes.
 *
 * Intentionally simple — no Markdown library dependency. The grammar is
 * narrow:
 *   - A row is a line starting and ending with `|`.
 *   - The header divider row (`|---|...|`) is skipped.
 *   - The first column is the relative file path.
 *   - For invalid fixtures, the second column is the expected error type.
 *
 * @module tests/standards/parse-fixtures-index
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { LoaderErrorRecord } from '../../intake/standards/loader';

/** Descriptor for a fixture entry parsed from INDEX.md. */
export interface ValidFixture {
  /** Path relative to the v1 fixture directory (e.g., `valid/minimal.yaml`). */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Free-form description from the third column. */
  description: string;
}

export interface InvalidFixture {
  relPath: string;
  absPath: string;
  /** The `LoaderErrorRecord.type` the loader is expected to produce. */
  expectedErrorType: LoaderErrorRecord['type'];
  /** Free-form reason from the fourth column. */
  reason: string;
}

export interface ParsedFixtureIndex {
  rootDir: string;
  valid: ValidFixture[];
  invalid: InvalidFixture[];
}

/**
 * Default location of the fixture index relative to this file.
 *
 * Resolved at module load so a single `import` gives tests both the parsed
 * descriptors and the directory they live under.
 */
export const FIXTURE_ROOT = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'standards',
  'v1',
);

/**
 * Read INDEX.md and return parsed fixture descriptors.
 *
 * @throws Error if INDEX.md does not exist or contains a row whose
 *               `expectedErrorType` is not a known `LoaderErrorRecord.type`.
 */
export function parseFixturesIndex(rootDir: string = FIXTURE_ROOT): ParsedFixtureIndex {
  const indexPath = path.join(rootDir, 'INDEX.md');
  const raw = fs.readFileSync(indexPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  const valid: ValidFixture[] = [];
  const invalid: InvalidFixture[] = [];
  let section: 'none' | 'valid' | 'invalid' = 'none';

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const title = heading[1].toLowerCase();
      if (title.startsWith('valid')) section = 'valid';
      else if (title.startsWith('invalid')) section = 'invalid';
      else section = 'none';
      continue;
    }
    if (section === 'none') continue;
    if (!line.startsWith('|') || !line.trimEnd().endsWith('|')) continue;

    // Split on `|` and drop the leading/trailing empty cells.
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());

    // Skip header and divider rows.
    if (cells.length === 0) continue;
    if (cells[0].toLowerCase() === 'file') continue;
    if (/^-+$/.test(cells[0].replace(/[: ]/g, ''))) continue;

    if (section === 'valid' && cells.length >= 2) {
      const relPath = cells[0];
      valid.push({
        relPath,
        absPath: path.join(rootDir, relPath),
        description: cells[1] ?? '',
      });
    } else if (section === 'invalid' && cells.length >= 3) {
      const relPath = cells[0];
      const expected = cells[1];
      if (!isLoaderErrorType(expected)) {
        throw new Error(
          `INDEX.md: row "${relPath}" has unknown expectedErrorType "${expected}".`,
        );
      }
      invalid.push({
        relPath,
        absPath: path.join(rootDir, relPath),
        expectedErrorType: expected,
        reason: cells[2] ?? '',
      });
    }
  }

  return { rootDir, valid, invalid };
}

function isLoaderErrorType(s: string): s is LoaderErrorRecord['type'] {
  return (
    s === 'io_error' ||
    s === 'size_exceeded' ||
    s === 'parse_error' ||
    s === 'schema_error'
  );
}
