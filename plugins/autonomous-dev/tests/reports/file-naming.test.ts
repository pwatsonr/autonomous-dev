/**
 * Unit tests for observation file naming and directory placement
 * (SPEC-007-4-1, Task 2).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-4-1-07 through TC-4-1-09.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import {
  generateObservationId,
  getObservationFilePath,
  regenerateShortId,
  writeObservationReport,
} from '../../src/reports/file-naming';

// ---------------------------------------------------------------------------
// generateObservationId
// ---------------------------------------------------------------------------

describe('generateObservationId', () => {
  // TC-4-1-07: Correct format from known timestamp
  it('TC-4-1-07: generates OBS-YYYYMMDD-HHMMSS-XXXX format', () => {
    const now = new Date('2026-04-08T14:30:22.000Z');
    const id = generateObservationId(now);

    // Should match the expected pattern
    expect(id).toMatch(/^OBS-20260408-143022-[a-f0-9]{4}$/);
  });

  it('generates unique IDs on repeated calls', () => {
    const now = new Date('2026-04-08T14:30:22.000Z');
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateObservationId(now));
    }
    // With 4 hex chars (65536 possibilities), 100 calls should be unique
    expect(ids.size).toBe(100);
  });

  it('uses current time when no argument is provided', () => {
    const id = generateObservationId();
    expect(id).toMatch(/^OBS-\d{8}-\d{6}-[a-f0-9]{4}$/);
  });

  it('correctly handles midnight timestamps', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const id = generateObservationId(now);
    expect(id).toMatch(/^OBS-20260101-000000-[a-f0-9]{4}$/);
  });

  it('correctly handles end-of-day timestamps', () => {
    const now = new Date('2026-12-31T23:59:59.000Z');
    const id = generateObservationId(now);
    expect(id).toMatch(/^OBS-20261231-235959-[a-f0-9]{4}$/);
  });
});

// ---------------------------------------------------------------------------
// getObservationFilePath
// ---------------------------------------------------------------------------

describe('getObservationFilePath', () => {
  // TC-4-1-08: April 2026 -> .autonomous-dev/observations/2026/04/
  it('TC-4-1-08: places April 2026 report in correct directory', () => {
    const id = 'OBS-20260408-143022-a1b2';
    const filePath = getObservationFilePath(id, '/projects/my-app');

    expect(filePath).toBe(
      path.join('/projects/my-app', '.autonomous-dev', 'observations', '2026', '04', 'OBS-20260408-143022-a1b2.md'),
    );
  });

  it('extracts year and month correctly for January', () => {
    const id = 'OBS-20260115-090000-ff00';
    const filePath = getObservationFilePath(id, '/root');
    expect(filePath).toContain(path.join('observations', '2026', '01'));
    expect(filePath.endsWith('OBS-20260115-090000-ff00.md')).toBe(true);
  });

  it('extracts year and month correctly for December', () => {
    const id = 'OBS-20261231-235959-abcd';
    const filePath = getObservationFilePath(id, '/root');
    expect(filePath).toContain(path.join('observations', '2026', '12'));
  });

  it('throws for invalid ID format', () => {
    expect(() => getObservationFilePath('INVALID', '/root')).toThrow(
      'Invalid observation ID format: INVALID',
    );
  });

  it('throws for ID with uppercase hex', () => {
    expect(() =>
      getObservationFilePath('OBS-20260408-143022-A1B2', '/root'),
    ).toThrow('Invalid observation ID format');
  });

  it('throws for ID with wrong number of hex chars', () => {
    expect(() =>
      getObservationFilePath('OBS-20260408-143022-a1b', '/root'),
    ).toThrow('Invalid observation ID format');
  });
});

// ---------------------------------------------------------------------------
// regenerateShortId
// ---------------------------------------------------------------------------

describe('regenerateShortId', () => {
  it('preserves the timestamp prefix', () => {
    const original = 'OBS-20260408-143022-a1b2';
    const regenerated = regenerateShortId(original);

    expect(regenerated).toMatch(/^OBS-20260408-143022-[a-f0-9]{4}$/);
    // Very likely to differ (1 in 65536 chance of collision)
    // We just check it matches the format
  });

  it('generates a different suffix', () => {
    const original = 'OBS-20260408-143022-a1b2';
    const results = new Set<string>();
    for (let i = 0; i < 50; i++) {
      results.add(regenerateShortId(original));
    }
    // All should start with same prefix
    for (const r of results) {
      expect(r.startsWith('OBS-20260408-143022-')).toBe(true);
    }
    // Very likely to have multiple unique suffixes
    expect(results.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// writeObservationReport
// ---------------------------------------------------------------------------

describe('writeObservationReport', () => {
  let tmpDir: string;

  beforeEach(async () => {
    const os = await import('os');
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // TC-4-1-09: Directory auto-creation
  it('TC-4-1-09: creates directories automatically when they do not exist', async () => {
    const id = 'OBS-20260408-143022-a1b2';
    const content = '---\nid: test\n---\n\n# Test';

    const filePath = await writeObservationReport(id, content, tmpDir);

    // Verify directory was created
    const expectedDir = path.join(
      tmpDir,
      '.autonomous-dev',
      'observations',
      '2026',
      '04',
    );
    const stats = await fs.stat(expectedDir);
    expect(stats.isDirectory()).toBe(true);

    // Verify file was written
    const written = await fs.readFile(filePath, 'utf-8');
    expect(written).toBe(content);
  });

  it('writes file at the correct path', async () => {
    const id = 'OBS-20260408-143022-a1b2';
    const content = 'test content';

    const filePath = await writeObservationReport(id, content, tmpDir);

    expect(filePath).toBe(
      path.join(
        tmpDir,
        '.autonomous-dev',
        'observations',
        '2026',
        '04',
        'OBS-20260408-143022-a1b2.md',
      ),
    );
  });

  it('handles collision by regenerating the short ID', async () => {
    const id = 'OBS-20260408-143022-a1b2';
    const content = `---\nid: ${id}\n---\n\n# Test`;

    // Write the first file
    await writeObservationReport(id, content, tmpDir);

    // Write again with the same ID (collision)
    const secondPath = await writeObservationReport(id, content, tmpDir);

    // The second file should have a different name
    expect(secondPath).not.toContain('OBS-20260408-143022-a1b2.md');
    // But should still be in the same directory
    expect(secondPath).toContain(
      path.join('.autonomous-dev', 'observations', '2026', '04'),
    );
    // The content should have the updated ID
    const secondContent = await fs.readFile(secondPath, 'utf-8');
    expect(secondContent).not.toContain('OBS-20260408-143022-a1b2');
  });

  it('writes to different directories for different months', async () => {
    const id1 = 'OBS-20260108-100000-aaaa';
    const id2 = 'OBS-20260208-100000-bbbb';

    const path1 = await writeObservationReport(id1, 'jan', tmpDir);
    const path2 = await writeObservationReport(id2, 'feb', tmpDir);

    expect(path1).toContain(path.join('2026', '01'));
    expect(path2).toContain(path.join('2026', '02'));
  });
});
