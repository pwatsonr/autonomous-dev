/**
 * Resolve an ABSOLUTE home directory, or throw (ONBOARD R1).
 *
 * Prefers `$HOME` when it is absolute, else `os.homedir()`; fail-closed if
 * neither is absolute so persisted state (memory tree, ownership manifest,
 * question queue) can never land under a relative CWD path — which, for a
 * daemon-spawned run, could be a request worktree or the live checkout.
 */
import * as os from 'os';
import * as path from 'path';

export function resolveAbsoluteHome(): string {
  const h = process.env.HOME;
  if (h && path.isAbsolute(h)) return h;
  const fallback = os.homedir();
  if (!path.isAbsolute(fallback)) {
    throw new Error('Cannot resolve an absolute home directory ($HOME unset/relative and os.homedir() non-absolute).');
  }
  return fallback;
}
