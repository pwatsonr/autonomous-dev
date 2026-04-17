import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  TriageAuditLogger,
  type TriageAuditEntry,
} from '../../src/triage/audit-log';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<TriageAuditEntry> = {},
): TriageAuditEntry {
  return {
    observation_id: 'OBS-20260408-143022-a7f3',
    action: 'promote',
    actor: 'pwatson',
    timestamp: '2026-04-08T15:12:00Z',
    reason: 'Connection pool issue confirmed. Needs fix PRD.',
    generated_prd: 'PRD-OBS-20260408-143022-a7f3',
    auto_promoted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TriageAuditLogger
// ---------------------------------------------------------------------------

describe('TriageAuditLogger', () => {
  let tmpDir: string;
  let logger: TriageAuditLogger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-log-test-'));
    logger = new TriageAuditLogger(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Basic write/read
  // -----------------------------------------------------------------------

  it('creates log file and parent directories on first write', async () => {
    await logger.log(makeEntry());
    const stat = await fs.stat(logger.getLogPath());
    expect(stat.isFile()).toBe(true);
  });

  it('getLogPath returns expected path', () => {
    expect(logger.getLogPath()).toBe(
      path.join(
        tmpDir,
        '.autonomous-dev',
        'logs',
        'intelligence',
        'triage-audit.log',
      ),
    );
  });

  // TC-4-3-08: promote entry
  it('TC-4-3-08: logs promote entry with generated_prd', async () => {
    const entry = makeEntry({
      action: 'promote',
      generated_prd: 'PRD-OBS-20260408-143022-a7f3',
    });
    await logger.log(entry);
    const entries = await logger.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('promote');
    expect(entries[0].generated_prd).toBe('PRD-OBS-20260408-143022-a7f3');
  });

  // TC-4-3-09: dismiss entry
  it('TC-4-3-09: logs dismiss entry with null generated_prd', async () => {
    const entry = makeEntry({
      observation_id: 'OBS-20260408-150015-b2c1',
      action: 'dismiss',
      actor: 'pwatson',
      timestamp: '2026-04-08T15:30:00Z',
      reason: 'Known flaky test, not a real issue.',
      generated_prd: null,
    });
    await logger.log(entry);
    const entries = await logger.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('dismiss');
    expect(entries[0].generated_prd).toBeNull();
  });

  // TC-4-3-10: append-only
  it('TC-4-3-10: appends entries without overwriting', async () => {
    const entry1 = makeEntry({
      observation_id: 'OBS-001',
      action: 'promote',
      timestamp: '2026-04-08T15:00:00Z',
    });
    const entry2 = makeEntry({
      observation_id: 'OBS-002',
      action: 'dismiss',
      timestamp: '2026-04-08T15:10:00Z',
      generated_prd: null,
    });

    await logger.log(entry1);
    await logger.log(entry2);

    const entries = await logger.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].observation_id).toBe('OBS-001');
    expect(entries[0].action).toBe('promote');
    expect(entries[1].observation_id).toBe('OBS-002');
    expect(entries[1].action).toBe('dismiss');
  });

  // TC-4-3-11: each line parses to valid TriageAuditEntry
  it('TC-4-3-11: each line is valid JSON parseable to TriageAuditEntry', async () => {
    await logger.log(makeEntry({ action: 'promote' }));
    await logger.log(makeEntry({ action: 'dismiss', generated_prd: null }));
    await logger.log(makeEntry({ action: 'defer', generated_prd: null }));

    const raw = await fs.readFile(logger.getLogPath(), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      const parsed = JSON.parse(line) as TriageAuditEntry;
      expect(parsed).toHaveProperty('observation_id');
      expect(parsed).toHaveProperty('action');
      expect(parsed).toHaveProperty('actor');
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('reason');
      expect(parsed).toHaveProperty('generated_prd');
      expect(parsed).toHaveProperty('auto_promoted');
    }
  });

  // TC-4-3-12: auto_promoted flag
  it('TC-4-3-12: records auto_promoted flag', async () => {
    const entry = makeEntry({
      action: 'promote',
      actor: 'system',
      auto_promoted: true,
      reason: 'Auto-promoted: severity P1 with confidence > 0.9',
    });
    await logger.log(entry);

    const entries = await logger.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].auto_promoted).toBe(true);
    expect(entries[0].actor).toBe('system');
  });

  // -----------------------------------------------------------------------
  // logError convenience
  // -----------------------------------------------------------------------

  it('logError writes an error entry with system actor', async () => {
    await logger.logError('OBS-999', 'LLM generation failed: rate limited');
    const entries = await logger.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('error');
    expect(entries[0].actor).toBe('system');
    expect(entries[0].reason).toBe('LLM generation failed: rate limited');
    expect(entries[0].generated_prd).toBeNull();
    expect(entries[0].auto_promoted).toBe(false);
  });

  // -----------------------------------------------------------------------
  // readAll edge cases
  // -----------------------------------------------------------------------

  it('readAll returns empty array when log file does not exist', async () => {
    const entries = await logger.readAll();
    expect(entries).toEqual([]);
  });

  it('readAll returns empty array when log file is empty', async () => {
    const logDir = path.dirname(logger.getLogPath());
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(logger.getLogPath(), '', 'utf-8');

    const entries = await logger.readAll();
    expect(entries).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Filter methods
  // -----------------------------------------------------------------------

  it('readByObservation filters by observation_id', async () => {
    await logger.log(makeEntry({ observation_id: 'OBS-AAA', action: 'promote' }));
    await logger.log(makeEntry({ observation_id: 'OBS-BBB', action: 'dismiss', generated_prd: null }));
    await logger.log(makeEntry({ observation_id: 'OBS-AAA', action: 'defer', generated_prd: null }));

    const filtered = await logger.readByObservation('OBS-AAA');
    expect(filtered).toHaveLength(2);
    expect(filtered.every((e) => e.observation_id === 'OBS-AAA')).toBe(true);
  });

  it('readByAction filters by action type', async () => {
    await logger.log(makeEntry({ action: 'promote' }));
    await logger.log(makeEntry({ action: 'dismiss', generated_prd: null }));
    await logger.log(makeEntry({ action: 'promote' }));

    const promotes = await logger.readByAction('promote');
    expect(promotes).toHaveLength(2);
    expect(promotes.every((e) => e.action === 'promote')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // All required fields present
  // -----------------------------------------------------------------------

  it('audit entry includes all required fields', async () => {
    const entry = makeEntry();
    await logger.log(entry);
    const entries = await logger.readAll();
    const logged = entries[0];

    expect(typeof logged.observation_id).toBe('string');
    expect(typeof logged.action).toBe('string');
    expect(typeof logged.actor).toBe('string');
    expect(typeof logged.timestamp).toBe('string');
    expect(typeof logged.reason).toBe('string');
    expect(logged.auto_promoted === true || logged.auto_promoted === false).toBe(true);
    // generated_prd is string or null
    expect(logged.generated_prd === null || typeof logged.generated_prd === 'string').toBe(true);
  });

  // -----------------------------------------------------------------------
  // Defer entry
  // -----------------------------------------------------------------------

  it('logs defer entry correctly', async () => {
    const entry = makeEntry({
      observation_id: 'OBS-20260408-153022-c4d5',
      action: 'defer',
      actor: 'pwatson',
      timestamp: '2026-04-08T16:00:00Z',
      reason: 'Wait for next deploy cycle.',
      generated_prd: null,
    });
    await logger.log(entry);

    const entries = await logger.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('defer');
    expect(entries[0].generated_prd).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Multiple sequential writes from separate logger instances
  // -----------------------------------------------------------------------

  it('separate logger instances append to the same file', async () => {
    const logger1 = new TriageAuditLogger(tmpDir);
    const logger2 = new TriageAuditLogger(tmpDir);

    await logger1.log(makeEntry({ observation_id: 'OBS-1' }));
    await logger2.log(makeEntry({ observation_id: 'OBS-2' }));

    const entries = await logger1.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].observation_id).toBe('OBS-1');
    expect(entries[1].observation_id).toBe('OBS-2');
  });
});
