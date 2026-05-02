/**
 * Custom-evaluator subprocess sandbox (SPEC-021-2-03, Task 6).
 *
 * `runCustomEvaluator()` is the ONLY place in the codebase that executes
 * operator-supplied code. The trust boundary is enforced in this exact
 * order, BEFORE any subprocess is spawned:
 *
 *   1. Path must be absolute  (SecurityError: 'absolute')
 *   2. Path must be in opts.allowlist  (SecurityError: 'evaluators_allowlist')
 *   3. Sandbox cwd `/tmp/eval-sandbox` mode 0700 (created on first call)
 *   4. Platform-specific argv built (Linux unshare / macOS sandbox-exec / fallback)
 *   5. execFile with: env={}, cwd=SANDBOX_CWD, timeout=30s, killSignal=SIGKILL
 *
 * Failures map to typed errors so callers can attribute regressions:
 *   - SandboxTimeoutError on 30s wall-clock breach
 *   - SandboxMemoryError when child exits 137 (SIGKILL) inside timeout
 *   - SecurityError on allowlist / absolute-path violations
 *
 * Stdout MUST be a single JSON object `{passed: bool, findings: []}`; any
 * deviation produces a clear error mentioning the evaluator path. Stderr is
 * captured but not parsed; consumers route it to the daemon log.
 *
 * @module intake/standards/sandbox
 */

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';

import {
  SandboxMemoryError,
  SandboxTimeoutError,
  SecurityError,
} from './errors';
import { buildSandboxCommand, detectPlatform } from './sandbox-platform';
import type { EvaluatorResult } from './evaluators/types';

const execFileP = promisify(execFile);

/** Per-evaluator working directory; created mode 0700 so multi-tenant hosts
 *  can't observe intermediate state. macOS resolves this to /private/tmp. */
export const SANDBOX_CWD = '/tmp/eval-sandbox';
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB stdout cap
const TIMEOUT_GRACE_MS = 100;

export interface SandboxOptions {
  /** Absolute paths the operator has explicitly allowed. */
  allowlist: string[];
}

export async function runCustomEvaluator(
  evaluatorPath: string,
  filePaths: string[],
  args: Record<string, unknown>,
  opts: SandboxOptions,
): Promise<EvaluatorResult> {
  // 1) Allowlist enforcement — BEFORE any subprocess work.
  if (typeof evaluatorPath !== 'string' || evaluatorPath.length === 0) {
    throw new SecurityError('Custom evaluator path must be a non-empty string');
  }
  if (!isAbsolute(evaluatorPath)) {
    throw new SecurityError(
      `Custom evaluator path must be absolute: "${evaluatorPath}"`,
    );
  }
  const resolved = resolvePath(evaluatorPath);
  if (!opts.allowlist.includes(resolved)) {
    throw new SecurityError(
      `Custom evaluator "${resolved}" is not in extensions.evaluators_allowlist`,
    );
  }

  // 2) Sandbox cwd (idempotent).
  await mkdir(SANDBOX_CWD, { recursive: true, mode: 0o700 });

  // 3) Platform argv.
  const platform = detectPlatform();
  const { command, baseArgs } = buildSandboxCommand(platform, resolved);

  // 4) Evaluator-contract argv.
  const userArgs = [...filePaths, '--args', JSON.stringify(args)];

  const start = Date.now();
  let stdout: string;
  try {
    const result = await execFileP(command, [...baseArgs, ...userArgs], {
      cwd: SANDBOX_CWD,
      env: {}, // Empty env — no inherited secrets.
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      killSignal: 'SIGKILL',
    });
    stdout = result.stdout;
  } catch (err) {
    const elapsed = Date.now() - start;
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: NodeJS.Signals;
      code?: number | string;
      stdout?: string;
    };
    // Timeout detection: Node sets `killed = true` and signal = killSignal
    // (here SIGKILL) when the timeout fires. We treat anything that took
    // ~the full timeout as a SandboxTimeoutError regardless of exit code.
    if (e.killed && elapsed >= TIMEOUT_MS - TIMEOUT_GRACE_MS) {
      throw new SandboxTimeoutError(resolved, elapsed);
    }
    // Memory exhaustion (Linux prlimit kills with SIGKILL → exit 137).
    if (e.code === 137 && elapsed < TIMEOUT_MS - TIMEOUT_GRACE_MS) {
      throw new SandboxMemoryError(resolved);
    }
    // Some scripts exit non-zero but still emit valid JSON on stdout.
    // Honor that contract — return the parsed result rather than re-throw.
    if (typeof e.stdout === 'string' && e.stdout.length > 0) {
      try {
        return parseEvaluatorOutput(e.stdout, resolved);
      } catch {
        // fall through to re-throw the underlying execFile error
      }
    }
    throw err;
  }

  return parseEvaluatorOutput(stdout, resolved);
}

function parseEvaluatorOutput(stdout: string, path: string): EvaluatorResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Custom evaluator "${path}" emitted invalid JSON: ${message}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { passed?: unknown }).passed !== 'boolean' ||
    !Array.isArray((parsed as { findings?: unknown }).findings)
  ) {
    throw new Error(
      `Custom evaluator "${path}" output missing required fields {passed, findings}`,
    );
  }
  const obj = parsed as { passed: boolean; findings: unknown[] };
  return {
    passed: obj.passed,
    findings: obj.findings as EvaluatorResult['findings'],
  };
}
