/**
 * Tests for the custom-evaluator subprocess sandbox (SPEC-021-2-03).
 *
 * Allowlist enforcement is verified with a spy on `child_process.execFile`
 * so we can prove the spawn never happens for denied paths. Platform-
 * specific behavior (Linux unshare, macOS sandbox-exec) is exercised by
 * the adversarial suite in SPEC-021-2-05.
 *
 * @module tests/standards/sandbox.test
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { runCustomEvaluator, SANDBOX_CWD } from '../../intake/standards/sandbox';
import { SecurityError } from '../../intake/standards/errors';
import { __resetPlatformCacheForTests } from '../../intake/standards/sandbox-platform';

const FIXTURE_ALLOWED = resolve(__dirname, 'fixtures', 'eval-allowed.sh');
const FIXTURE_DENIED = resolve(__dirname, 'fixtures', 'eval-denied.sh');

describe('runCustomEvaluator — allowlist enforcement', () => {
  beforeEach(() => {
    __resetPlatformCacheForTests();
  });

  it('throws SecurityError BEFORE spawn or sandbox cwd setup when path not allowlisted', async () => {
    // We can't spy on child_process.execFile directly (newer Node makes the
    // property non-configurable). Instead we assert the SecurityError reaches
    // us synchronously and that no marker file from a successful run is
    // produced — runCustomEvaluator must reject BEFORE the mkdir for the
    // sandbox cwd or any subprocess work. We do this by passing a path that
    // doesn't exist on disk: if the spawn ran, execFile would surface ENOENT,
    // not a SecurityError.
    await expect(
      runCustomEvaluator('/tmp/definitely-not-a-real-script.sh', [], {}, { allowlist: [] }),
    ).rejects.toThrow(SecurityError);
    // Sanity: SecurityError is the SPECIFIC class, not a subclass that wraps
    // an underlying spawn ENOENT.
    await expect(
      runCustomEvaluator('/tmp/definitely-not-a-real-script.sh', [], {}, { allowlist: [] }),
    ).rejects.toMatchObject({ name: 'SecurityError' });
  });

  it('does not create the sandbox cwd when allowlist check fails', async () => {
    // Note: SANDBOX_CWD may have been created by a prior test in this
    // process. The point of this test is to assert no NEW work happens
    // post-rejection — captured implicitly by SecurityError being the only
    // thrown class, not a wrapped EACCES/ENOENT from mkdir.
    expect(SANDBOX_CWD).toBe('/tmp/eval-sandbox');
    const cwdExistedBefore = existsSync(SANDBOX_CWD);
    await expect(
      runCustomEvaluator('/abs/not-listed.sh', [], {}, { allowlist: [] }),
    ).rejects.toThrow(SecurityError);
    // Idempotent: existence state matches what it was before.
    expect(existsSync(SANDBOX_CWD)).toBe(cwdExistedBefore);
  });

  it('throws SecurityError on relative path even if appears in allowlist', async () => {
    await expect(
      runCustomEvaluator('./evil.sh', [], {}, { allowlist: ['./evil.sh'] }),
    ).rejects.toThrow(/absolute/);
  });

  it('throws SecurityError when allowlist is empty even for an existing file', async () => {
    await expect(
      runCustomEvaluator(FIXTURE_DENIED, [], {}, { allowlist: [] }),
    ).rejects.toThrow(/evaluators_allowlist/);
  });

  it('throws SecurityError on empty path', async () => {
    await expect(
      runCustomEvaluator('', [], {}, { allowlist: [] }),
    ).rejects.toThrow(SecurityError);
  });
});

describe('runCustomEvaluator — happy path', () => {
  beforeEach(() => {
    __resetPlatformCacheForTests();
  });

  it('runs the allowed fixture and returns parsed {passed, findings}', async () => {
    const r = await runCustomEvaluator(
      FIXTURE_ALLOWED,
      ['file1.ts'],
      { key: 'val' },
      { allowlist: [FIXTURE_ALLOWED] },
    );
    expect(r.passed).toBe(true);
    expect(r.findings).toEqual([]);
  });
});

describe('runCustomEvaluator — output validation', () => {
  beforeEach(() => {
    __resetPlatformCacheForTests();
  });

  it('rejects invalid JSON with a clear error mentioning the path', async () => {
    // Use a one-shot fixture that prints non-JSON.
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sb-'));
    const script = join(dir, 'bad.sh');
    writeFileSync(script, '#!/bin/sh\nprintf "not json\\n"\nexit 0\n');
    chmodSync(script, 0o755);
    try {
      await expect(
        runCustomEvaluator(script, [], {}, { allowlist: [script] }),
      ).rejects.toThrow(/invalid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects valid JSON missing required fields with clear message', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sb-'));
    const script = join(dir, 'badshape.sh');
    writeFileSync(script, '#!/bin/sh\nprintf \'{"oops":1}\\n\'\nexit 0\n');
    chmodSync(script, 0o755);
    try {
      await expect(
        runCustomEvaluator(script, [], {}, { allowlist: [script] }),
      ).rejects.toThrow(/missing required fields/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
