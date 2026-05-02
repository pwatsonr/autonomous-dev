/**
 * Tests for the `evaluators` CLI subcommand (SPEC-021-2-04).
 *
 * Tests against the in-process functional API (`runEvaluatorsList`,
 * `runEvaluatorsAdd`) rather than spawning the binary, so we can capture
 * stdout/stderr and inject env without a subprocess.
 *
 * @module tests/standards/cli-evaluators.test
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runEvaluatorsAdd,
  runEvaluatorsList,
} from '../../intake/adapters/cli_adapter_evaluators';

interface CapturedIO {
  stdout: string;
  stderr: string;
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    env: NodeJS.ProcessEnv;
  };
}

function captureIO(env: NodeJS.ProcessEnv = {}): CapturedIO {
  const c: CapturedIO = {
    stdout: '',
    stderr: '',
    io: {
      stdout: (s: string) => {
        c.stdout += s;
      },
      stderr: (s: string) => {
        c.stderr += s;
      },
      env,
    },
  };
  return c;
}

describe('evaluators list', () => {
  it('prints exactly the 5 built-in rows when no config given', async () => {
    const c = captureIO();
    const code = await runEvaluatorsList(undefined, c.io);
    expect(code).toBe(0);
    expect(c.stdout).toContain('NAME');
    expect(c.stdout).toContain('framework-detector');
    expect(c.stdout).toContain('endpoint-scanner');
    expect(c.stdout).toContain('sql-injection-detector');
    expect(c.stdout).toContain('dependency-checker');
    expect(c.stdout).toContain('pattern-grep');
    expect(c.stdout).toContain('<built-in>');
    // 5 builtin rows + header = 6 lines (plus trailing newline).
    const dataLines = c.stdout.trim().split('\n').length;
    expect(dataLines).toBe(6);
  });

  it('includes custom evaluators from the config allowlist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    try {
      const cfg = join(dir, 'config.json');
      writeFileSync(
        cfg,
        JSON.stringify({
          extensions: { evaluators_allowlist: ['/abs/path/sec-check.sh'] },
        }),
      );
      const c = captureIO();
      const code = await runEvaluatorsList(cfg, c.io);
      expect(code).toBe(0);
      expect(c.stdout).toContain('sec-check');
      expect(c.stdout).toContain('custom');
      expect(c.stdout).toContain('/abs/path/sec-check.sh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('evaluators add', () => {
  it('exits 1 with admin error when AUTONOMOUS_DEV_ADMIN is unset', async () => {
    const c = captureIO({});
    const code = await runEvaluatorsAdd('/abs/path/x.sh', '/tmp/x.json', c.io);
    expect(code).toBe(1);
    expect(c.stderr).toContain('admin authorization required');
  });

  it('exits 2 on relative path even with admin auth', async () => {
    const c = captureIO({ AUTONOMOUS_DEV_ADMIN: '1' });
    const code = await runEvaluatorsAdd('./relative.sh', '/tmp/x.json', c.io);
    expect(code).toBe(2);
    expect(c.stderr).toContain('absolute');
  });

  it('exits 2 when --config not provided', async () => {
    const c = captureIO({ AUTONOMOUS_DEV_ADMIN: '1' });
    const code = await runEvaluatorsAdd('/abs/x.sh', undefined, c.io);
    expect(code).toBe(2);
    expect(c.stderr).toContain('--config');
  });

  it('appends path to allowlist and exits 0; rewrites config atomically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    try {
      const cfg = join(dir, 'config.json');
      writeFileSync(cfg, JSON.stringify({ extensions: { evaluators_allowlist: [] } }));
      const c = captureIO({ AUTONOMOUS_DEV_ADMIN: '1' });
      const code = await runEvaluatorsAdd('/abs/path/eval.sh', cfg, c.io);
      expect(code).toBe(0);
      expect(c.stdout).toContain('added: /abs/path/eval.sh');
      const reread = JSON.parse(readFileSync(cfg, 'utf8'));
      expect(reread.extensions.evaluators_allowlist).toContain('/abs/path/eval.sh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('idempotent: already-present path → "already in allowlist", exit 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    try {
      const cfg = join(dir, 'config.json');
      writeFileSync(
        cfg,
        JSON.stringify({
          extensions: { evaluators_allowlist: ['/abs/path/eval.sh'] },
        }),
      );
      const c = captureIO({ AUTONOMOUS_DEV_ADMIN: '1' });
      const code = await runEvaluatorsAdd('/abs/path/eval.sh', cfg, c.io);
      expect(code).toBe(0);
      expect(c.stdout).toContain('already in allowlist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates extensions.evaluators_allowlist when missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    try {
      const cfg = join(dir, 'config.json');
      writeFileSync(cfg, '{}');
      const c = captureIO({ AUTONOMOUS_DEV_ADMIN: '1' });
      const code = await runEvaluatorsAdd('/abs/path/eval.sh', cfg, c.io);
      expect(code).toBe(0);
      const reread = JSON.parse(readFileSync(cfg, 'utf8'));
      expect(reread.extensions.evaluators_allowlist).toEqual(['/abs/path/eval.sh']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
