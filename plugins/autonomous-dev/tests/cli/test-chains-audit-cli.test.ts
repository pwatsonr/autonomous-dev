/**
 * Unit tests for `autonomous-dev chains audit verify|query` CLI
 * (SPEC-022-3-03, Task 8).
 *
 * Covers:
 *   - verify: clean log → exit 0; tampered → exit 1; malformed → exit 2.
 *   - verify --json: JSON output.
 *   - query: filter by --chain / --plugin / --since / --type (AND).
 *   - query --json: JSONL output.
 *   - query --since invalid → exit 2.
 *
 * @module tests/cli/test-chains-audit-cli
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';

import { ChainAuditWriter } from '../../intake/chains/audit-writer';
import {
  runChainsAuditQuery,
  runChainsAuditVerify,
} from '../../intake/cli/chains_audit_command';

const KEY = Buffer.alloc(32, 13);

class CapturingStream extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

async function seedLog(logPath: string): Promise<void> {
  const w = await ChainAuditWriter.open({
    logPath,
    key: KEY,
    clock: (() => {
      let i = 0;
      return () => `2026-04-29T00:00:0${i++}.000Z`;
    })(),
  });
  await w.append('chain_started', 'CH-A', {
    chain_id: 'CH-A',
    chain_name: 'a',
    trigger: 'p1',
    plugins: ['p1', 'p2'],
  });
  await w.append('plugin_invoked', 'CH-A', {
    chain_id: 'CH-A',
    plugin_id: 'p1',
    step: 1,
    consumes: [],
  });
  await w.append('plugin_completed', 'CH-A', {
    chain_id: 'CH-A',
    plugin_id: 'p1',
    step: 1,
    duration_ms: 5,
  });
  await w.append('chain_completed', 'CH-A', {
    chain_id: 'CH-A',
    duration_ms: 10,
    entries: 4,
  });
  // Second chain, different plugin.
  await w.append('chain_started', 'CH-B', {
    chain_id: 'CH-B',
    chain_name: 'b',
    trigger: 'p2',
    plugins: ['p2'],
  });
  await w.close();
}

describe('chains audit verify', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-cli-audit-'));
    logPath = path.join(tmpDir, 'chains-audit.log');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('clean log → exit 0 with OK summary', async () => {
    await seedLog(logPath);
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const code = await runChainsAuditVerify(
      { logPath },
      { stdout, stderr, keyResolver: () => KEY },
    );
    expect(code).toBe(0);
    expect(stdout.text()).toMatch(/^OK: 5 entries verified/);
  });

  it('clean log + --json → emits {"status":"ok",...}', async () => {
    await seedLog(logPath);
    const stdout = new CapturingStream();
    const code = await runChainsAuditVerify(
      { logPath, json: true },
      { stdout, stderr: new CapturingStream(), keyResolver: () => KEY },
    );
    expect(code).toBe(0);
    const out = JSON.parse(stdout.text().trim());
    expect(out).toEqual({ status: 'ok', entries: 5 });
  });

  it('missing log file → exit 0 (verifiably empty)', async () => {
    const code = await runChainsAuditVerify(
      { logPath: path.join(tmpDir, 'absent.log') },
      {
        stdout: new CapturingStream(),
        stderr: new CapturingStream(),
        keyResolver: () => KEY,
      },
    );
    expect(code).toBe(0);
  });

  it('tampered payload → exit 1 with hmac_mismatch', async () => {
    await seedLog(logPath);
    // Tamper line 3: bump duration_ms without re-signing.
    const raw = await fs.readFile(logPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const e = JSON.parse(lines[2]);
    e.payload.duration_ms = 9999;
    lines[2] = JSON.stringify(e);
    await fs.writeFile(logPath, lines.join('\n') + '\n');
    const stderr = new CapturingStream();
    const code = await runChainsAuditVerify(
      { logPath },
      { stdout: new CapturingStream(), stderr, keyResolver: () => KEY },
    );
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/FAIL: line 3 hmac_mismatch/);
  });

  it('malformed JSONL → exit 2', async () => {
    await fs.writeFile(logPath, 'not json\n');
    const stderr = new CapturingStream();
    const code = await runChainsAuditVerify(
      { logPath },
      { stdout: new CapturingStream(), stderr, keyResolver: () => KEY },
    );
    expect(code).toBe(2);
    expect(stderr.text()).toMatch(/line 1/);
  });
});

describe('chains audit query', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-cli-audit-q-'));
    logPath = path.join(tmpDir, 'chains-audit.log');
    await seedLog(logPath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('--chain filters to that chain id', async () => {
    const stdout = new CapturingStream();
    const code = await runChainsAuditQuery(
      { logPath, chain: 'CH-A' },
      { stdout, stderr: new CapturingStream() },
    );
    expect(code).toBe(0);
    const lines = stdout.text().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      expect(l).toMatch(/CH-A/);
    }
  });

  it('--type plugin_invoked --chain CH-A returns one entry', async () => {
    const stdout = new CapturingStream();
    const code = await runChainsAuditQuery(
      { logPath, chain: 'CH-A', type: 'plugin_invoked' },
      { stdout, stderr: new CapturingStream() },
    );
    expect(code).toBe(0);
    const lines = stdout.text().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/plugin_invoked/);
  });

  it('--plugin matches plugin_id in payload', async () => {
    const stdout = new CapturingStream();
    const code = await runChainsAuditQuery(
      { logPath, plugin: 'p1' },
      { stdout, stderr: new CapturingStream() },
    );
    expect(code).toBe(0);
    const lines = stdout.text().split('\n').filter((l) => l.length > 0);
    // p1 appears in plugin_invoked + plugin_completed.
    expect(lines).toHaveLength(2);
  });

  it('--since filters out earlier entries (inclusive)', async () => {
    const stdout = new CapturingStream();
    const code = await runChainsAuditQuery(
      { logPath, since: '2026-04-29T00:00:03.000Z' },
      { stdout, stderr: new CapturingStream() },
    );
    expect(code).toBe(0);
    const lines = stdout.text().split('\n').filter((l) => l.length > 0);
    // Entries 4 (CH-A chain_completed at index 3) and 5 (CH-B chain_started at 4)
    // are at or after the cutoff.
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const l of lines) {
      const ts = l.split('\t')[0];
      expect(Date.parse(ts)).toBeGreaterThanOrEqual(
        Date.parse('2026-04-29T00:00:03.000Z'),
      );
    }
  });

  it('--json emits JSONL', async () => {
    const stdout = new CapturingStream();
    const code = await runChainsAuditQuery(
      { logPath, chain: 'CH-A', json: true },
      { stdout, stderr: new CapturingStream() },
    );
    expect(code).toBe(0);
    const lines = stdout.text().split('\n').filter((l) => l.length > 0);
    for (const l of lines) {
      const parsed = JSON.parse(l);
      expect(parsed.chain_id).toBe('CH-A');
    }
  });

  it('zero matches still exits 0', async () => {
    const stdout = new CapturingStream();
    const code = await runChainsAuditQuery(
      { logPath, chain: 'CH-DOES-NOT-EXIST' },
      { stdout, stderr: new CapturingStream() },
    );
    expect(code).toBe(0);
    expect(stdout.text()).toBe('');
  });

  it('--since invalid → exit 2 with parse error', async () => {
    const stderr = new CapturingStream();
    const code = await runChainsAuditQuery(
      { logPath, since: 'not-a-date' },
      { stdout: new CapturingStream(), stderr },
    );
    expect(code).toBe(2);
    expect(stderr.text()).toMatch(/invalid --since/);
  });

  it('--type invalid → exit 2', async () => {
    const stderr = new CapturingStream();
    const code = await runChainsAuditQuery(
      { logPath, type: 'not_a_real_type' },
      { stdout: new CapturingStream(), stderr },
    );
    expect(code).toBe(2);
    expect(stderr.text()).toMatch(/invalid --type/);
  });
});
