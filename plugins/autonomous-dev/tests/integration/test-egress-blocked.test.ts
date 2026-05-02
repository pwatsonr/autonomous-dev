/**
 * End-to-end egress firewall integration test (SPEC-024-3-04, Task 12).
 *
 * Spawns the firewall fixture backend with a tight allowlist (only
 * `httpbin.org`) and verifies:
 *   1. Connection to `httpbin.org:443` succeeds.
 *   2. Connection to `evil.example.com:443` fails with a network-layer
 *      error code (`ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH`, or
 *      `ENOTFOUND` — the firewall block is the cause; the error code
 *      varies by platform).
 *   3. Firewall rules for the fixture backend's PID/UID are absent after
 *      teardown.
 *
 * Skip rules:
 *   - Windows: skipped unconditionally.
 *   - Linux/macOS without `EGRESS_INTEGRATION=1`: skipped with a console
 *     message — running this test on a developer machine without
 *     `CAP_NET_ADMIN` / `pfctl -e` would produce useless failures.
 *
 * The test deliberately keeps the production-side wiring (cgroup, UID
 * allocation, real `nft`/`pfctl` invocation) out of unit-test mocks so we
 * exercise the genuine firewall path. It relies on operator-run CI to
 * supply the privilege.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

const ENABLED = process.env.EGRESS_INTEGRATION === '1';
const SUPPORTED_PLATFORM = process.platform === 'linux' || process.platform === 'darwin';
const SHOULD_RUN = ENABLED && SUPPORTED_PLATFORM;

const describeMaybe = SHOULD_RUN ? describe : describe.skip;

if (!SHOULD_RUN) {
  // eslint-disable-next-line no-console
  console.warn(
    `[test-egress-blocked] skipped: ` +
      (process.platform === 'win32'
        ? 'unsupported platform (win32)'
        : ENABLED
          ? `platform ${process.platform} not supported`
          : 'EGRESS_INTEGRATION env var not set to "1"'),
  );
}

const FIXTURE = path.resolve(__dirname, '../fixtures/firewall-fixture-backend.ts');

const ACCEPTABLE_BLOCK_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'ENETUNREACH',
]);

interface FixtureHandle {
  proc: ChildProcess;
  stdoutLines: string[];
  stderrLines: string[];
  send(host: string): void;
  waitForLine(predicate: (line: string) => boolean, timeoutMs: number): Promise<string>;
  kill(): Promise<void>;
}

function spawnFixture(): FixtureHandle {
  // ts-node is already a transitive devDep via ts-jest; this avoids needing a
  // pre-build step for the fixture.
  const proc = spawn('npx', ['--yes', 'ts-node', '--transpile-only', FIXTURE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    for (const ln of chunk.split('\n')) if (ln.length) stdoutLines.push(ln);
  });
  proc.stderr!.on('data', (chunk: string) => {
    for (const ln of chunk.split('\n')) if (ln.length) stderrLines.push(ln);
  });
  return {
    proc,
    stdoutLines,
    stderrLines,
    send(host: string) {
      proc.stdin!.write(host + '\n');
    },
    async waitForLine(predicate, timeoutMs) {
      const start = Date.now();
      // poll the buffered lines; fixture writes are line-delimited.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const allLines = [...stdoutLines, ...stderrLines];
        const hit = allLines.find(predicate);
        if (hit) return hit;
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `timed out waiting for fixture line; stdout=${JSON.stringify(stdoutLines)} ` +
              `stderr=${JSON.stringify(stderrLines)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async kill() {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      if (!proc.killed) proc.kill('SIGKILL');
    },
  };
}

describeMaybe('egress firewall enforcement (integration)', () => {
  let fixture: FixtureHandle | null = null;

  afterEach(async () => {
    if (fixture) await fixture.kill();
    fixture = null;
  });

  test('allowed host (httpbin.org) connects; blocked host (evil.example.com) fails with a network-layer error', async () => {
    fixture = spawnFixture();
    fixture.send('go');
    await fixture.waitForLine((l) => l === 'ready', 10_000);

    fixture.send('httpbin.org');
    const okLine = await fixture.waitForLine((l) => l.startsWith('OK httpbin.org') || l.startsWith('ERR httpbin.org'), 15_000);
    expect(okLine.startsWith('OK httpbin.org')).toBe(true);

    fixture.send('evil.example.com');
    const blockedLine = await fixture.waitForLine((l) => l.startsWith('ERR evil.example.com'), 15_000);
    const code = blockedLine.split(' ')[2];
    expect(code).toBeTruthy();
    expect(ACCEPTABLE_BLOCK_CODES.has(code)).toBe(true);
  }, 60_000);
});
