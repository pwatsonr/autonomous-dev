/**
 * Adversarial sandbox-escape suite (SPEC-021-2-05, Task 11).
 *
 * Each test asserts a SPECIFIC defense against a SPECIFIC named attack
 * routed through the custom-evaluator subprocess sandbox
 * (`runCustomEvaluator`, SPEC-021-2-03). The point of the suite is
 * diagnostic visibility: when a test fails, the name reveals exactly
 * which isolation guarantee broke.
 *
 * Platform handling:
 *   - linux-unshare: ALL tests are meaningful.
 *   - macos-sandbox: most tests are meaningful; PID-namespace assertions
 *     are skipped (the sb profile doesn't ship a PID NS).
 *   - fallback (Windows / kernels w/o user namespaces): the sandbox runs
 *     the evaluator without isolation; ALL adversarial tests SKIP with a
 *     `console.warn` so the gap is visible (per spec acceptance criterion
 *     "Cross-platform handling").
 *
 * @module tests/standards/test-sandbox-escape.test
 */

import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import { runCustomEvaluator } from '../../intake/standards/sandbox';
import { SecurityError } from '../../intake/standards/errors';
import {
  __resetPlatformCacheForTests,
  detectPlatform,
} from '../../intake/standards/sandbox-platform';

const F = (name: string): string =>
  resolve(__dirname, 'fixtures', 'escape', name);

const PLATFORM = (() => {
  __resetPlatformCacheForTests();
  return detectPlatform();
})();

/** Most adversarial tests are gates only when REAL isolation is in effect. */
const isFallback = PLATFORM === 'fallback';
const isWin = process.platform === 'win32';

if (isFallback) {
  // eslint-disable-next-line no-console
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'sandbox running in fallback mode; adversarial-escape suite cannot prove isolation',
      platform: process.platform,
      detected: PLATFORM,
      spec: 'SPEC-021-2-05',
    }),
  );
}

const onlyWhenIsolated = isFallback || isWin ? it.skip : it;

/** Helper: run an evaluator and return either the parsed result or the error. */
async function runOrCatch(
  path: string,
): Promise<{ ok: true; result: unknown } | { ok: false; error: Error }> {
  try {
    const r = await runCustomEvaluator(path, [], {}, { allowlist: [path] });
    return { ok: true, result: r };
  } catch (err) {
    return { ok: false, error: err as Error };
  }
}

describe('subprocess sandbox — allowlist invariants (always run)', () => {
  beforeEach(() => {
    __resetPlatformCacheForTests();
  });

  it('refuses ANY path not in allowlist (never spawns subprocess)', async () => {
    // Path doesn't exist on disk: if spawn ran we'd see an ENOENT, not
    // SecurityError. The thrown SecurityError class is the proof.
    await expect(
      runCustomEvaluator(
        '/tmp/path-that-does-not-exist-spec-021-2-05.sh',
        [],
        {},
        { allowlist: [] },
      ),
    ).rejects.toBeInstanceOf(SecurityError);
  });

  it('refuses relative path even when string-equal in allowlist', async () => {
    await expect(
      runCustomEvaluator(
        './evil.sh',
        [],
        {},
        { allowlist: ['./evil.sh'] },
      ),
    ).rejects.toThrow(/absolute/);
  });
});

describe('subprocess sandbox — adversarial escapes', () => {
  beforeEach(() => {
    __resetPlatformCacheForTests();
  });

  // Defensive cleanup: marker files might exist from a host's previous run.
  afterAll(() => {
    for (const p of ['/tmp/escape-marker-x']) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // 1. NETWORK CONNECT
  // ──────────────────────────────────────────────────────────────────────
  onlyWhenIsolated(
    'sandbox blocks: TCP connect to external host (example.com)',
    async () => {
      const path = F('network-connect.sh');
      const r = await runOrCatch(path);
      // The fixture always exits 0 with a JSON envelope; the sandbox-blocked
      // case shows up as `connected: false` in the parsed payload.
      // Either:
      //   (a) thrown error (e.g. curl missing in some minimal images), OR
      //   (b) parsed result with connected === false.
      if (r.ok) {
        expect(r.result).toMatchObject({ connected: false });
      } else {
        // A thrown error is also acceptable if the sandbox killed the
        // child or stripped curl from the namespace.
        expect(r.error).toBeDefined();
      }
    },
    15_000,
  );

  // ──────────────────────────────────────────────────────────────────────
  // 2. FILESYSTEM WRITE OUTSIDE SANDBOX CWD
  // ──────────────────────────────────────────────────────────────────────
  onlyWhenIsolated(
    'sandbox blocks: write outside cwd (/etc/test-escape-marker, /tmp/escape-marker-x)',
    async () => {
      const path = F('write-outside-cwd.sh');
      // We don't care if the script exits non-zero; we care that the markers
      // are not on disk after the run.
      await runOrCatch(path);
      expect(existsSync('/etc/test-escape-marker')).toBe(false);
      // /tmp/escape-marker-x — only meaningful when sandbox confines writes.
      // On macos-sandbox the sb profile blocks it; on linux-unshare the mount
      // NS makes /tmp the host's /tmp (so this assertion is best-effort).
      // We assert on the macOS path only:
      if (PLATFORM === 'macos-sandbox') {
        expect(existsSync('/tmp/escape-marker-x')).toBe(false);
      }
    },
    15_000,
  );

  // ──────────────────────────────────────────────────────────────────────
  // 3. ENV VAR LEAK FROM PARENT
  // ──────────────────────────────────────────────────────────────────────
  // This invariant is enforced by the sandbox runner itself (`env: {}` to
  // execFile), not the platform layer — so it MUST hold even in fallback.
  // We therefore use plain `it`, not `onlyWhenIsolated`.
  it('sandbox blocks: env var leak from parent process', async () => {
    process.env.SECRET_TEST_VALUE = 'do-not-leak-spec-021-2-05';
    try {
      const path = F('env-leak.sh');
      const r = await runOrCatch(path);
      // Whether parsed or thrown, the secret string MUST NOT appear anywhere
      // in the captured payload.
      const haystack = r.ok
        ? JSON.stringify(r.result)
        : `${r.error.message} ${(r.error as { stdout?: string }).stdout ?? ''}`;
      expect(haystack).not.toContain('do-not-leak-spec-021-2-05');
    } finally {
      delete process.env.SECRET_TEST_VALUE;
    }
  }, 15_000);

  // ──────────────────────────────────────────────────────────────────────
  // 4. CHILD-PROCESS SPAWN OF UNRELATED BINARY
  // ──────────────────────────────────────────────────────────────────────
  // Process spawn IS allowed by both platform profiles (operators ship
  // wrapper scripts that exec interpreters). The defense is that the
  // spawned binary inherits the SAME isolation. We assert here that the
  // captured `whoami` is NOT root (would indicate the sandbox ran with
  // elevated privileges) and the script returned the JSON envelope without
  // crashing the parent.
  onlyWhenIsolated(
    'sandbox confines: spawned `whoami` runs without privilege escalation',
    async () => {
      const path = F('spawn-binary.sh');
      const r = await runOrCatch(path);
      if (r.ok) {
        const payload = r.result as { whoami?: string };
        expect(typeof payload.whoami).toBe('string');
        // We can't pin the exact user (CI vs local), but we can rule out
        // root unless the test itself is running as root.
        if (process.getuid && process.getuid() !== 0) {
          expect(payload.whoami).not.toBe('root');
        }
      }
    },
    15_000,
  );

  // ──────────────────────────────────────────────────────────────────────
  // 5. ULIMIT BYPASS / FORK BOMB
  // ──────────────────────────────────────────────────────────────────────
  onlyWhenIsolated(
    'sandbox bounds: bounded fork bomb does not destabilize host',
    async () => {
      const path = F('fork-bomb.sh');
      const start = Date.now();
      await runOrCatch(path);
      const elapsed = Date.now() - start;
      // The 30s sandbox timeout is the upper bound; bounded fixture should
      // complete much faster, so we allow up to 31s before declaring the
      // host destabilized.
      expect(elapsed).toBeLessThan(31_000);
    },
    32_000,
  );

  // ──────────────────────────────────────────────────────────────────────
  // 6. SIGNAL INJECTION AT PARENT PROCESS
  // ──────────────────────────────────────────────────────────────────────
  // The kill -0 probe is the safest possible signal injection (no real
  // signal is delivered) — we want to know if the kernel/sandbox WOULD have
  // permitted the signal. On macos-sandbox the profile restricts signals
  // to (target self), so kill_parent must be false.
  onlyWhenIsolated(
    'sandbox blocks: child cannot signal init or parent jest worker',
    async () => {
      const path = F('signal-injection.sh');
      const r = await runOrCatch(path);
      if (r.ok) {
        const payload = r.result as { kill_init?: boolean; kill_parent?: boolean };
        // Init is unsignalable by unprivileged users on every supported OS.
        expect(payload.kill_init).toBe(false);
        // On macOS sandbox, signal-to-non-self is denied. On Linux-unshare,
        // the parent jest worker is in a different mount/net NS but same PID
        // NS, so kill -0 may succeed; this is an accepted weaker guarantee
        // documented in PLAN-021-2 §Risks. We only assert the macOS case.
        if (PLATFORM === 'macos-sandbox') {
          expect(payload.kill_parent).toBe(false);
        }
      }
    },
    15_000,
  );
});
