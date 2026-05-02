/**
 * Thin `execFile` wrapper used by every deployment backend (SPEC-023-1-02).
 *
 * Hard rules:
 *   - Always `shell: false` — even a malicious parameter that slipped past
 *     `validateParameters` cannot reach a shell interpreter.
 *   - Default 60-second timeout (configurable per call).
 *   - Default 10 MiB stdio buffer cap.
 *   - Non-zero exit rejects with `ExternalToolError` carrying both
 *     stdout AND stderr in the error message — operators need both to
 *     debug.
 *
 * @module intake/deploy/exec
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ExternalToolError } from './errors';

const execFileAsync = promisify(execFile);

export interface RunToolOptions {
  /** Working directory for the child process. */
  cwd: string;
  /** Optional environment override. Defaults to inheriting `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Hard timeout. Default: 60s. */
  timeoutMs?: number;
  /** Stdio buffer cap. Default: 10 MiB. */
  maxBufferBytes?: number;
}

export interface RunToolResult {
  stdout: string;
  stderr: string;
}

/**
 * Run an external tool via `execFile` (no shell). Throws
 * `ExternalToolError` on non-zero exit so callers can rely on a
 * structured failure signal.
 */
export async function runTool(
  cmd: string,
  args: string[],
  opts: RunToolOptions,
): Promise<RunToolResult> {
  const timeout = opts.timeoutMs ?? 60_000;
  const maxBuffer = opts.maxBufferBytes ?? 10 * 1024 * 1024;
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout,
      maxBuffer,
      shell: false,
      windowsHide: true,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    // execFile rejection shape: includes `code`, `stdout`, `stderr`.
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    const stdout = e.stdout ? e.stdout.toString() : '';
    const stderr = e.stderr ? e.stderr.toString() : (e.message ?? '');
    throw new ExternalToolError(cmd, args, exitCode, stdout, stderr);
  }
}
