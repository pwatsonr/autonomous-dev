/**
 * Smoke tests for the `reconcile` CLI orchestrator (SPEC-012-3-03).
 *
 * Strategy: inject a fake {@link ReconciliationManagerLike} so the test
 * never touches SQLite or the filesystem under .autonomous-dev/. Each
 * test exercises one ladder rung in the exit-code matrix:
 *
 *   - happy path:                 no drift               → exit 0
 *   - drift, detect-only:         drift, no --auto-repair → exit 1
 *   - drift, --auto-repair:       all repairs succeed     → exit 0
 *   - drift, --auto-repair fails: repair → manual_required → exit 2
 *   - --cleanup-temps:            invoked end-to-end
 *   - --out:                      writes JSON file (mode 0o600)
 *   - bad --repo:                 commander raises → exit 2
 *
 * @module __tests__/cli/reconcile_command.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildAuditLog,
  computeExitCode,
  defaultDbPath,
  runReconcileCommand,
  type ReconcileCliFlags,
  type ReconciliationManagerLike,
} from '../../cli/reconcile_command';
import type {
  DivergenceReport,
  RepairResult,
  TempCleanupReport,
} from '../../core/types/reconciliation';
import type {
  FullReconciliationOptions,
  FullReconciliationResult,
} from '../../core/reconciliation_manager';
import type { Logger } from '../../authz/audit_logger';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface FakeManager extends ReconciliationManagerLike {
  calls: FullReconciliationOptions[];
}

/**
 * Build a fake {@link ReconciliationManagerLike} that returns `result`
 * for every invocation and records the options it was called with.
 */
function makeFakeManager(
  result: FullReconciliationResult,
): FakeManager {
  const calls: FullReconciliationOptions[] = [];
  return {
    calls,
    async runFullReconciliation(opts) {
      calls.push(opts);
      return result;
    },
  };
}

/**
 * Capture `WriteStream`-like writes into an array of strings. Returned
 * object satisfies the {@link NodeJS.WriteStream} contract narrowly enough
 * for the orchestrator (it only calls `.write()`).
 */
interface CaptureStream {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  stream: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  output: string[];
}

function captureStream(): CaptureStream {
  const output: string[] = [];
  const stream = {
    write: (chunk: string | Uint8Array): boolean => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    },
  };
  return { stream, output };
}

function noopLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** Build a synthetic {@link DivergenceReport} for content_mismatch drift. */
function makeReport(idSuffix: number): DivergenceReport {
  return {
    request_id: `REQ-${String(idSuffix).padStart(6, '0')}`,
    repository: '/tmp/fake-repo',
    category: 'content_mismatch',
    description: 'fields differ: priority',
    fields_differing: ['priority'],
    detected_at: '2026-04-30T10:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Group 1: exit code matrix
// ---------------------------------------------------------------------------

describe('runReconcileCommand — exit codes', () => {
  test('happy path with no drift exits 0', async () => {
    const manager = makeFakeManager({ reports: [] });
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runReconcileCommand(
      ['--repo', '/tmp/fake-repo'],
      { manager, stdout: stdout.stream, stderr: stderr.stream, logger: noopLogger() },
    );
    expect(code).toBe(0);
    expect(stderr.output).toEqual([]);
    // Audit log was emitted on stdout.
    expect(stdout.output.length).toBe(1);
    const audit = JSON.parse(stdout.output[0]);
    expect(audit.event).toBe('reconcile.run');
    expect(audit.inconsistencies_found).toBe(0);
    expect(audit.exit_code).toBe(0);
  });

  test('drift exists in detect-only mode exits 1', async () => {
    const manager = makeFakeManager({ reports: [makeReport(1), makeReport(2)] });
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runReconcileCommand(
      ['--repo', '/tmp/fake-repo'],
      { manager, stdout: stdout.stream, stderr: stderr.stream },
    );
    expect(code).toBe(1);
    expect(manager.calls[0].repair).toBe(false);
    const audit = JSON.parse(stdout.output[0]);
    expect(audit.inconsistencies_found).toBe(2);
    expect(audit.repairs_attempted).toBe(0);
    expect(audit.exit_code).toBe(1);
  });

  test('drift with --auto-repair where repairs succeed exits 0', async () => {
    const reports = [makeReport(1), makeReport(2)];
    const repairs: RepairResult[] = reports.map((r) => ({
      request_id: r.request_id,
      category: r.category,
      action: 'auto_repaired',
      after_hash: 'sha256:dead',
    }));
    const manager = makeFakeManager({ reports, repairs });
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runReconcileCommand(
      ['--repo', '/tmp/fake-repo', '--auto-repair'],
      { manager, stdout: stdout.stream, stderr: stderr.stream },
    );
    expect(code).toBe(0);
    expect(manager.calls[0].repair).toBe(true);
    expect(manager.calls[0].force).toBe(true);
    const audit = JSON.parse(stdout.output[0]);
    expect(audit.repairs_attempted).toBe(2);
    expect(audit.repairs_successful).toBe(2);
    expect(audit.manual_intervention_needed).toBe(0);
  });

  test('drift with --auto-repair where one repair fails exits 2', async () => {
    const reports = [makeReport(1), makeReport(2)];
    const repairs: RepairResult[] = [
      {
        request_id: reports[0].request_id,
        category: reports[0].category,
        action: 'auto_repaired',
      },
      {
        request_id: reports[1].request_id,
        category: reports[1].category,
        action: 'manual_required',
        error_message: 'schema invalid',
      },
    ];
    const manager = makeFakeManager({ reports, repairs });
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runReconcileCommand(
      ['--repo', '/tmp/fake-repo', '--auto-repair'],
      { manager, stdout: stdout.stream, stderr: stderr.stream },
    );
    expect(code).toBe(2);
    const audit = JSON.parse(stdout.output[0]);
    expect(audit.manual_intervention_needed).toBe(1);
  });

  test('drift in --dry-run still exits 1 (drift signaled regardless of mode)', async () => {
    const manager = makeFakeManager({ reports: [makeReport(1)] });
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runReconcileCommand(
      ['--repo', '/tmp/fake-repo', '--dry-run'],
      { manager, stdout: stdout.stream, stderr: stderr.stream },
    );
    expect(code).toBe(1);
    expect(manager.calls[0].dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 2: --cleanup-temps phase
// ---------------------------------------------------------------------------

describe('runReconcileCommand — cleanup phase', () => {
  test('--cleanup-temps invokes cleanup phase and reports it in the audit log', async () => {
    const cleanup: TempCleanupReport = {
      scanned: 3,
      removed: ['/tmp/fake-repo/.autonomous-dev/requests/REQ-000001/state.json.tmp.999.aaa'],
      promoted: [],
      preserved: ['/tmp/fake-repo/.autonomous-dev/requests/REQ-000002/state.json.tmp.123.bbb'],
      errors: [],
    };
    const manager = makeFakeManager({ reports: [], cleanup });
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runReconcileCommand(
      ['--repo', '/tmp/fake-repo', '--cleanup-temps'],
      { manager, stdout: stdout.stream, stderr: stderr.stream },
    );
    expect(code).toBe(0);
    expect(manager.calls[0].cleanupTemps).toBe(true);
    const audit = JSON.parse(stdout.output[0]);
    expect(audit.cleanup).toEqual({
      scanned: 3,
      removed: 1,
      promoted: 0,
      preserved: 1,
      errors: 0,
    });
  });

  test('--cleanup-temps without other flags only invokes cleanup (repair=false)', async () => {
    const manager = makeFakeManager({
      reports: [],
      cleanup: { scanned: 0, removed: [], promoted: [], preserved: [], errors: [] },
    });
    const stdout = captureStream();
    const stderr = captureStream();
    await runReconcileCommand(
      ['--repo', '/tmp/fake-repo', '--cleanup-temps'],
      { manager, stdout: stdout.stream, stderr: stderr.stream },
    );
    expect(manager.calls[0].repair).toBe(false);
    expect(manager.calls[0].cleanupTemps).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 3: --out file output
// ---------------------------------------------------------------------------

describe('runReconcileCommand — --out path', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-cli-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('--out path writes audit log to file (mode 0o600) and not to stdout', async () => {
    const manager = makeFakeManager({ reports: [] });
    const stdout = captureStream();
    const stderr = captureStream();
    const outPath = path.join(tmpDir, 'audit.json');

    const code = await runReconcileCommand(
      ['--repo', '/tmp/fake-repo', '--out', outPath],
      { manager, stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(code).toBe(0);
    // Nothing on stdout when --out is used.
    expect(stdout.output).toEqual([]);
    // File exists, parses as valid JSON, has audit shape.
    expect(fs.existsSync(outPath)).toBe(true);
    const raw = fs.readFileSync(outPath, 'utf-8');
    const audit = JSON.parse(raw);
    expect(audit.event).toBe('reconcile.run');
    expect(audit.repository).toBe('/tmp/fake-repo');
    // File mode is 0o600 — readable/writable by owner only.
    const stat = fs.statSync(outPath);
    // Mask off the type bits; compare just the permission octal.
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('--out parent dir not writable yields system error (exit 2)', async () => {
    // Construct a path under a directory that does not exist.
    const manager = makeFakeManager({ reports: [] });
    const stdout = captureStream();
    const stderr = captureStream();
    const outPath = path.join(tmpDir, 'no-such-subdir', 'audit.json');

    const code = await runReconcileCommand(
      ['--repo', '/tmp/fake-repo', '--out', outPath],
      { manager, stdout: stdout.stream, stderr: stderr.stream },
    );
    expect(code).toBe(2);
    expect(stderr.output.some((l) => l.includes('failed to write audit log'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 4: argument validation
// ---------------------------------------------------------------------------

describe('runReconcileCommand — argument validation', () => {
  test('missing --repo (commander required option) exits 2', async () => {
    const manager = makeFakeManager({ reports: [] });
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runReconcileCommand(
      [],
      { manager, stdout: stdout.stream, stderr: stderr.stream },
    );
    expect(code).toBe(2);
    expect(manager.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group 5: pure helpers
// ---------------------------------------------------------------------------

describe('computeExitCode (pure)', () => {
  function flags(over: Partial<ReconcileCliFlags> = {}): ReconcileCliFlags {
    return {
      repo: '/r',
      dryRun: false,
      autoRepair: false,
      cleanupTemps: false,
      ...over,
    };
  }

  test('no drift → 0 in any mode', () => {
    expect(computeExitCode(flags(), { reports: [] })).toBe(0);
    expect(
      computeExitCode(flags({ autoRepair: true, dryRun: true }), { reports: [] }),
    ).toBe(0);
  });

  test('drift, no --auto-repair → 1', () => {
    expect(computeExitCode(flags(), { reports: [makeReport(1)] })).toBe(1);
  });

  test('drift, --auto-repair, all auto_repaired → 0', () => {
    const reports = [makeReport(1)];
    const repairs: RepairResult[] = [
      { request_id: reports[0].request_id, category: reports[0].category, action: 'auto_repaired' },
    ];
    expect(
      computeExitCode(flags({ autoRepair: true }), { reports, repairs }),
    ).toBe(0);
  });

  test('drift, --auto-repair, any manual_required → 2', () => {
    const reports = [makeReport(1)];
    const repairs: RepairResult[] = [
      { request_id: reports[0].request_id, category: reports[0].category, action: 'manual_required' },
    ];
    expect(
      computeExitCode(flags({ autoRepair: true }), { reports, repairs }),
    ).toBe(2);
  });

  test('drift, --auto-repair, error_message present → 2', () => {
    const reports = [makeReport(1)];
    const repairs: RepairResult[] = [
      {
        request_id: reports[0].request_id,
        category: reports[0].category,
        action: 'auto_repaired',
        error_message: 'late failure',
      },
    ];
    expect(
      computeExitCode(flags({ autoRepair: true }), { reports, repairs }),
    ).toBe(2);
  });
});

describe('buildAuditLog (pure)', () => {
  test('serializes flags + counters + duration verbatim', () => {
    const audit = buildAuditLog({
      flags: {
        repo: '/r',
        dryRun: true,
        autoRepair: false,
        cleanupTemps: false,
      },
      result: {
        reports: [makeReport(1), makeReport(2), makeReport(3)],
      },
      startedAt: new Date('2026-04-30T12:00:00.000Z'),
      durationMs: 412,
      exitCode: 1,
    });
    expect(audit.event).toBe('reconcile.run');
    expect(audit.repository).toBe('/r');
    expect(audit.flags).toEqual({ dryRun: true, autoRepair: false, cleanupTemps: false });
    expect(audit.inconsistencies_found).toBe(3);
    expect(audit.repairs_attempted).toBe(0);
    expect(audit.duration_ms).toBe(412);
    expect(audit.exit_code).toBe(1);
    expect(audit.timestamp).toBe('2026-04-30T12:00:00.000Z');
  });

  test('cleanup metrics derived from TempCleanupReport when present', () => {
    const cleanup: TempCleanupReport = {
      scanned: 5,
      removed: ['a', 'b'],
      promoted: ['c'],
      preserved: ['d'],
      errors: [{ path: 'e', message: 'boom' }],
    };
    const audit = buildAuditLog({
      flags: { repo: '/r', dryRun: false, autoRepair: false, cleanupTemps: true },
      result: { reports: [], cleanup },
      startedAt: new Date('2026-04-30T12:00:00.000Z'),
      durationMs: 10,
      exitCode: 0,
    });
    expect(audit.cleanup).toEqual({
      scanned: 5,
      removed: 2,
      promoted: 1,
      preserved: 1,
      errors: 1,
    });
  });
});

describe('defaultDbPath', () => {
  test('returns ~/.autonomous-dev/intake.sqlite3 when HOME is set', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = '/tmp/fake-home';
    try {
      expect(defaultDbPath()).toBe('/tmp/fake-home/.autonomous-dev/intake.sqlite3');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
