/**
 * Platform detection + sandbox argv builder for the custom-evaluator
 * subprocess sandbox (SPEC-021-2-03).
 *
 * Three modes:
 *   - 'linux-unshare':  Linux + util-linux. Wraps the evaluator in
 *                       `unshare --net --mount` (new network + mount NS) and
 *                       `prlimit --as / --rss` (256MB memory cap).
 *   - 'macos-sandbox':  macOS + sandbox-exec available. Wraps the evaluator
 *                       in `sandbox-exec -f <profile> <evaluator>`. The
 *                       profile denies all network and restricts file
 *                       writes to the sandbox cwd.
 *   - 'fallback':       Anything else (Windows, BSDs without unshare,
 *                       hardened kernels with user.max_user_namespaces=0).
 *                       Direct execFile with a logged warning.
 *
 * Detection runs `unshare --version` / `sandbox-exec -p '(version 1)' true`
 * exactly ONCE per process; the result is cached for the daemon's lifetime
 * to avoid a per-evaluator probe storm.
 *
 * @module intake/standards/sandbox-platform
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';

export type Platform = 'linux-unshare' | 'macos-sandbox' | 'fallback';

let cachedPlatform: Platform | undefined;
let weakWarningEmitted = false;

function hasUnshareSupport(): boolean {
  try {
    execFileSync('unshare', ['--version'], { stdio: 'ignore' });
    // Probe a no-op user-namespaced process to detect kernels that ship
    // unshare but disable the relevant namespaces.
    execFileSync('unshare', ['--net', '--mount', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasSandboxExec(): boolean {
  try {
    execFileSync('sandbox-exec', ['-p', '(version 1)', '/usr/bin/true'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function detectPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform;
  if (process.platform === 'linux' && hasUnshareSupport()) {
    cachedPlatform = 'linux-unshare';
  } else if (process.platform === 'darwin' && hasSandboxExec()) {
    cachedPlatform = 'macos-sandbox';
  } else {
    cachedPlatform = 'fallback';
  }
  return cachedPlatform;
}

/** Reset cached platform detection. EXPORTED FOR TESTS ONLY. */
export function __resetPlatformCacheForTests(): void {
  cachedPlatform = undefined;
  weakWarningEmitted = false;
}

function logWeakSandboxWarningOnce(): void {
  if (weakWarningEmitted) return;
  weakWarningEmitted = true;
  // eslint-disable-next-line no-console
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'custom-evaluator sandbox running in fallback mode (no unshare/sandbox-exec); isolation is weaker',
      platform: process.platform,
      spec: 'SPEC-021-2-03',
    }),
  );
}

export interface SandboxCommand {
  command: string;
  baseArgs: string[];
}

/** Resolve the absolute path to the macOS sandbox profile. */
function macosProfilePath(): string {
  // The profile lives at <plugin-root>/bin/sandbox-profiles/macos-sandbox.sb.
  // __dirname here is .../intake/standards (when compiled) or the .ts source
  // dir (under ts-jest). Both resolve to the same plugin root via ../../bin.
  const root = process.env.AUTONOMOUS_DEV_ROOT ?? resolvePath(__dirname, '..', '..');
  return resolvePath(root, 'bin', 'sandbox-profiles', 'macos-sandbox.sb');
}

export function buildSandboxCommand(
  platform: Platform,
  evaluatorPath: string,
): SandboxCommand {
  switch (platform) {
    case 'linux-unshare':
      return {
        command: 'unshare',
        baseArgs: [
          '--net',
          '--mount',
          'prlimit',
          '--as=268435456',
          '--rss=268435456',
          evaluatorPath,
        ],
      };
    case 'macos-sandbox':
      return {
        command: 'sandbox-exec',
        baseArgs: ['-f', macosProfilePath(), evaluatorPath],
      };
    case 'fallback':
      logWeakSandboxWarningOnce();
      return { command: evaluatorPath, baseArgs: [] };
  }
  // Exhaustive — TS narrow-out:
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _exhaustive: never = platform;
  throw new Error(`Unknown platform: ${String(platform)}`);
}

// Re-export used in tests for legibility.
export const __testing = { dirname };
