/**
 * Unit tests for the file retention policy (SPEC-007-4-4, Task 10).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-4-4-03 through TC-4-4-08.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  applyRetentionPolicy,
  isPrdInActiveState,
  readFrontmatter,
  type RetentionConfig,
  type RetentionResult,
  type AuditLogger,
  DEFAULT_RETENTION_CONFIG,
} from '../../src/reports/retention';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a Date that is `days` days ago from the reference date.
 */
function daysAgo(days: number, from: Date = new Date('2026-04-08T14:30:00Z')): Date {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Builds an observation markdown file content with the given frontmatter.
 */
function buildObservationContent(overrides: Record<string, string | null> = {}): string {
  const defaults: Record<string, string | null> = {
    id: 'OBS-20260408-143000-a1b2',
    timestamp: '2026-04-08T14:30:00.000Z',
    service: 'api-gateway',
    triage_status: 'pending',
    triage_decision: null,
    linked_prd: null,
  };
  const merged = { ...defaults, ...overrides };
  const lines = ['---'];
  for (const [key, value] of Object.entries(merged)) {
    lines.push(`${key}: ${value === null ? 'null' : value}`);
  }
  lines.push('---');
  lines.push('');
  lines.push('# Observation');
  lines.push('');
  lines.push('Body text.');
  return lines.join('\n');
}

/**
 * Creates a test observation file in the observations directory.
 */
async function createTestObservation(
  observationsDir: string,
  opts: {
    id?: string;
    timestamp?: Date;
    triage_status?: string;
    linked_prd?: string | null;
    subDir?: string;
  } = {},
): Promise<string> {
  const id = opts.id ?? `OBS-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const timestamp = opts.timestamp ?? new Date('2026-04-08T14:30:00Z');
  const content = buildObservationContent({
    id,
    timestamp: timestamp.toISOString(),
    triage_status: opts.triage_status ?? 'pending',
    linked_prd: opts.linked_prd ?? null,
  });

  const dir = opts.subDir
    ? path.join(observationsDir, opts.subDir)
    : observationsDir;
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.md`);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Creates a test observation file directly in the archive directory.
 */
async function createArchivedObservation(
  archiveDir: string,
  opts: {
    id?: string;
    timestamp?: Date;
  } = {},
): Promise<string> {
  const id = opts.id ?? `OBS-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const timestamp = opts.timestamp ?? new Date('2026-04-08T14:30:00Z');
  const content = buildObservationContent({
    id,
    timestamp: timestamp.toISOString(),
  });

  await fs.mkdir(archiveDir, { recursive: true });
  const filePath = path.join(archiveDir, `${id}.md`);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Creates a test PRD file with the given status.
 */
async function createTestPrd(
  rootDir: string,
  prdId: string,
  opts: { status?: string } = {},
): Promise<string> {
  const status = opts.status ?? 'Draft';
  const prdDir = path.join(rootDir, '.autonomous-dev', 'prd');
  await fs.mkdir(prdDir, { recursive: true });
  const filePath = path.join(prdDir, `${prdId}.md`);
  const content = [
    '---',
    `title: Test PRD`,
    `status: ${status}`,
    `observation_id: OBS-test`,
    '---',
    '',
    '# Test PRD',
  ].join('\n');
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Mock audit logger that collects messages.
 */
function createMockAuditLogger(): AuditLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info(message: string): void {
      messages.push(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Retention Policy', () => {
  let tmpDir: string;
  let rootDir: string;
  let observationsDir: string;
  let archiveDir: string;
  let auditLog: ReturnType<typeof createMockAuditLogger>;
  const NOW = new Date('2026-04-08T14:30:00Z');

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-test-'));
    rootDir = tmpDir;
    observationsDir = path.join(rootDir, '.autonomous-dev', 'observations');
    archiveDir = path.join(observationsDir, 'archive');
    await fs.mkdir(observationsDir, { recursive: true });
    await fs.mkdir(archiveDir, { recursive: true });
    auditLog = createMockAuditLogger();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // TC-4-4-03: Archives observation older than retention period
  // -------------------------------------------------------------------------

  test('TC-4-4-03: archives observation older than retention period', async () => {
    const obsPath = await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-aaaa',
      timestamp: daysAgo(100, NOW),
    });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.archived).toHaveLength(1);
    expect(result.archived[0]).toBe(obsPath);

    // Verify file was moved
    const archivedFile = path.join(archiveDir, 'OBS-20260101-120000-aaaa.md');
    const stat = await fs.stat(archivedFile);
    expect(stat.isFile()).toBe(true);

    // Original should not exist
    await expect(fs.access(obsPath)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // TC-4-4-04: Does not archive recent observation
  // -------------------------------------------------------------------------

  test('TC-4-4-04: does not archive recent observation', async () => {
    await createTestObservation(observationsDir, {
      id: 'OBS-20260310-120000-bbbb',
      timestamp: daysAgo(30, NOW),
    });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.archived).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // TC-4-4-05: Deletes expired archive
  // -------------------------------------------------------------------------

  test('TC-4-4-05: deletes expired archive', async () => {
    const archivedPath = await createArchivedObservation(archiveDir, {
      id: 'OBS-20250301-120000-cccc',
      timestamp: daysAgo(400, NOW),
    });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toBe(archivedPath);

    // Verify file was deleted
    await expect(fs.access(archivedPath)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // TC-4-4-06: Keeps recent archive
  // -------------------------------------------------------------------------

  test('TC-4-4-06: keeps archive that is not yet expired', async () => {
    await createArchivedObservation(archiveDir, {
      id: 'OBS-20250920-120000-dddd',
      timestamp: daysAgo(200, NOW),
    });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.deleted).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // TC-4-4-07: Skips promoted observation with active PRD
  // -------------------------------------------------------------------------

  test('TC-4-4-07: skips promoted observation with active PRD', async () => {
    await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-eeee',
      timestamp: daysAgo(100, NOW),
      triage_status: 'promoted',
      linked_prd: 'PRD-OBS-active',
    });

    await createTestPrd(rootDir, 'PRD-OBS-active', { status: 'in-progress' });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.skipped).toHaveLength(1);
    expect(result.archived).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // TC-4-4-08: Archives promoted observation with completed PRD
  // -------------------------------------------------------------------------

  test('TC-4-4-08: archives promoted observation with completed PRD', async () => {
    await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-ffff',
      timestamp: daysAgo(100, NOW),
      triage_status: 'promoted',
      linked_prd: 'PRD-OBS-completed',
    });

    await createTestPrd(rootDir, 'PRD-OBS-completed', { status: 'completed' });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.archived).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Archives promoted observation with cancelled PRD
  // -------------------------------------------------------------------------

  test('archives promoted observation with cancelled PRD', async () => {
    await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-1111',
      timestamp: daysAgo(100, NOW),
      triage_status: 'promoted',
      linked_prd: 'PRD-OBS-cancelled',
    });

    await createTestPrd(rootDir, 'PRD-OBS-cancelled', { status: 'cancelled' });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.archived).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Skips promoted observation with draft PRD (active)
  // -------------------------------------------------------------------------

  test('skips promoted observation with draft PRD', async () => {
    await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-2222',
      timestamp: daysAgo(100, NOW),
      triage_status: 'promoted',
      linked_prd: 'PRD-OBS-draft',
    });

    await createTestPrd(rootDir, 'PRD-OBS-draft', { status: 'Draft' });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.skipped).toHaveLength(1);
    expect(result.archived).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Archives promoted observation when PRD does not exist
  // -------------------------------------------------------------------------

  test('archives promoted observation when linked PRD file is missing', async () => {
    await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-3333',
      timestamp: daysAgo(100, NOW),
      triage_status: 'promoted',
      linked_prd: 'PRD-OBS-nonexistent',
    });

    // No PRD file created

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.archived).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Multiple observations with mixed retention outcomes
  // -------------------------------------------------------------------------

  test('handles mixed retention outcomes across multiple files', async () => {
    // Recent (should stay)
    await createTestObservation(observationsDir, {
      id: 'OBS-20260310-120000-r111',
      timestamp: daysAgo(30, NOW),
    });

    // Old, no promotion (should archive)
    await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-o111',
      timestamp: daysAgo(100, NOW),
    });

    // Old, promoted with active PRD (should skip)
    await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-s111',
      timestamp: daysAgo(100, NOW),
      triage_status: 'promoted',
      linked_prd: 'PRD-OBS-mixed-active',
    });
    await createTestPrd(rootDir, 'PRD-OBS-mixed-active', { status: 'in-progress' });

    // Expired archive (should delete)
    await createArchivedObservation(archiveDir, {
      id: 'OBS-20250101-120000-d111',
      timestamp: daysAgo(460, NOW),
    });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.archived).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.deleted).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Audit log messages
  // -------------------------------------------------------------------------

  test('logs audit messages for archived, deleted, and skipped files', async () => {
    await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-log1',
      timestamp: daysAgo(100, NOW),
    });

    await createArchivedObservation(archiveDir, {
      id: 'OBS-20250101-120000-log2',
      timestamp: daysAgo(400, NOW),
    });

    await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-log3',
      timestamp: daysAgo(100, NOW),
      triage_status: 'promoted',
      linked_prd: 'PRD-OBS-log-active',
    });
    await createTestPrd(rootDir, 'PRD-OBS-log-active', { status: 'in-progress' });

    await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(auditLog.messages.some((m) => m.includes('archived'))).toBe(true);
    expect(auditLog.messages.some((m) => m.includes('deleted'))).toBe(true);
    expect(auditLog.messages.some((m) => m.includes('skipping'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Empty directories
  // -------------------------------------------------------------------------

  test('handles empty observations directory gracefully', async () => {
    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      DEFAULT_RETENTION_CONFIG,
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.archived).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Observations at exact boundary
  // -------------------------------------------------------------------------

  test('does not archive observation at exact boundary (90 days)', async () => {
    await createTestObservation(observationsDir, {
      id: 'OBS-20260109-143000-bnd1',
      timestamp: daysAgo(90, NOW),
    });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    // Exactly 90 days is NOT > 90, so should not archive
    expect(result.archived).toHaveLength(0);
  });

  test('archives observation at 91 days', async () => {
    await createTestObservation(observationsDir, {
      id: 'OBS-20260108-143000-bn91',
      timestamp: daysAgo(91, NOW),
    });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.archived).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Subdirectory scanning
  // -------------------------------------------------------------------------

  test('archives observations in year/month subdirectories', async () => {
    await createTestObservation(observationsDir, {
      id: 'OBS-20260101-120000-sub1',
      timestamp: daysAgo(100, NOW),
      subDir: '2026/01',
    });

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.archived).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Non-observation files are ignored
  // -------------------------------------------------------------------------

  test('ignores non-OBS files', async () => {
    // Write a file that does not match OBS-*.md
    await fs.writeFile(
      path.join(observationsDir, 'README.md'),
      '# Not an observation',
      'utf-8',
    );

    const result = await applyRetentionPolicy(
      observationsDir,
      archiveDir,
      { observation_days: 90, archive_days: 365 },
      auditLog,
      rootDir,
      NOW,
    );

    expect(result.archived).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isPrdInActiveState
// ---------------------------------------------------------------------------

describe('isPrdInActiveState', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-state-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns true for in-progress PRD', async () => {
    const prdDir = path.join(tmpDir, '.autonomous-dev', 'prd');
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(prdDir, 'PRD-test.md'),
      '---\nstatus: in-progress\n---\n# PRD',
      'utf-8',
    );
    expect(await isPrdInActiveState('PRD-test', tmpDir)).toBe(true);
  });

  test('returns true for Draft PRD', async () => {
    const prdDir = path.join(tmpDir, '.autonomous-dev', 'prd');
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(prdDir, 'PRD-draft.md'),
      '---\nstatus: Draft\n---\n# PRD',
      'utf-8',
    );
    expect(await isPrdInActiveState('PRD-draft', tmpDir)).toBe(true);
  });

  test('returns false for completed PRD', async () => {
    const prdDir = path.join(tmpDir, '.autonomous-dev', 'prd');
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(prdDir, 'PRD-done.md'),
      '---\nstatus: completed\n---\n# PRD',
      'utf-8',
    );
    expect(await isPrdInActiveState('PRD-done', tmpDir)).toBe(false);
  });

  test('returns false for cancelled PRD', async () => {
    const prdDir = path.join(tmpDir, '.autonomous-dev', 'prd');
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(prdDir, 'PRD-cancel.md'),
      '---\nstatus: cancelled\n---\n# PRD',
      'utf-8',
    );
    expect(await isPrdInActiveState('PRD-cancel', tmpDir)).toBe(false);
  });

  test('returns false for missing PRD file', async () => {
    expect(await isPrdInActiveState('PRD-nonexistent', tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readFrontmatter
// ---------------------------------------------------------------------------

describe('readFrontmatter (retention)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-read-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('reads valid observation frontmatter', async () => {
    const filePath = path.join(tmpDir, 'test.md');
    await fs.writeFile(
      filePath,
      '---\nid: OBS-test\ntimestamp: 2026-04-01T00:00:00Z\nservice: svc\ntriage_status: pending\nlinked_prd: null\n---\n# Body',
      'utf-8',
    );
    const fm = await readFrontmatter(filePath);
    expect(fm).not.toBeNull();
    expect(fm!.id).toBe('OBS-test');
    expect(fm!.timestamp).toBe('2026-04-01T00:00:00Z');
    expect(fm!.triage_status).toBe('pending');
    expect(fm!.linked_prd).toBeNull();
  });

  test('returns null for file without frontmatter', async () => {
    const filePath = path.join(tmpDir, 'no-fm.md');
    await fs.writeFile(filePath, '# Just markdown', 'utf-8');
    const fm = await readFrontmatter(filePath);
    expect(fm).toBeNull();
  });

  test('returns null for missing file', async () => {
    const fm = await readFrontmatter(path.join(tmpDir, 'missing.md'));
    expect(fm).toBeNull();
  });

  test('returns null for frontmatter missing required id field', async () => {
    const filePath = path.join(tmpDir, 'no-id.md');
    await fs.writeFile(
      filePath,
      '---\ntimestamp: 2026-04-01T00:00:00Z\n---\n# Body',
      'utf-8',
    );
    // id is null -> returns null (requires both id and timestamp)
    const fm = await readFrontmatter(filePath);
    expect(fm).toBeNull();
  });
});
