/**
 * Repo-path safety guard for the reliability harness (#524).
 *
 * The harness submits real (potentially mutating) requests. It must NEVER
 * target the autonomous-dev repo itself — doing so would have the daemon
 * rewrite its own source while a batch is in flight. This module is the one
 * choke point that enforces that, and it is exported separately so the
 * dry-run test can assert the refusal without standing up a daemon.
 *
 * @module tools/reliability/guard
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Absolute path to the autonomous-dev repo root, derived from this file's
 * location (tools/reliability/ -> repo root is four levels up:
 * tools/reliability -> plugins/autonomous-dev -> plugins -> <repo>).
 * Resolved at module load; overridable in tests via {@link assertRepoAllowed}.
 */
export const AUTONOMOUS_DEV_REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** Raised when a caller tries to point the harness at a forbidden repo. */
export class ForbiddenRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenRepoError';
  }
}

/**
 * Canonicalize a path for comparison: resolve `~`, make absolute, and
 * follow symlinks where the path exists. Non-existent paths are still
 * normalized (so the guard works for not-yet-created scratch dirs too).
 */
export function canonicalize(p: string): string {
  let expanded = p;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = path.join(process.env.HOME ?? '', expanded.slice(1));
  }
  const abs = path.resolve(expanded);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** True if `child` is the same path as, or nested inside, `ancestor`. */
export function isSameOrInside(child: string, ancestor: string): boolean {
  const c = canonicalize(child);
  const a = canonicalize(ancestor);
  if (c === a) return true;
  const rel = path.relative(a, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Throw {@link ForbiddenRepoError} unless `repo` is a safe target. A repo is
 * forbidden when it is the autonomous-dev repo root or any path inside it.
 *
 * @param repo           Operator-supplied `--repo` path (may not exist yet).
 * @param forbiddenRoot  Override for the protected root (tests only).
 */
export function assertRepoAllowed(
  repo: string,
  forbiddenRoot: string = AUTONOMOUS_DEV_REPO_ROOT,
): void {
  if (!repo || repo.trim() === '') {
    throw new ForbiddenRepoError('--repo is required (a disposable scratch repo path).');
  }
  if (isSameOrInside(repo, forbiddenRoot)) {
    throw new ForbiddenRepoError(
      `Refusing to run the reliability harness against the autonomous-dev repo ` +
        `(or a path inside it): '${repo}'. Point --repo at a disposable scratch ` +
        `repository instead. Protected root: ${canonicalize(forbiddenRoot)}`,
    );
  }
}
