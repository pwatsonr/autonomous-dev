/**
 * Caller-identity resolution for the CredentialProxy (SPEC-024-2-01).
 *
 * The proxy MUST reject every non-allowlisted caller before a scoper
 * runs. Identity comes from two sources:
 *
 *   1. `process.env.AUTONOMOUS_DEV_PLUGIN_ID` — set by the daemon's
 *      session spawner (PLAN-018-2) when it forks the privileged backend
 *      child process. This is the authoritative identity for the stdin
 *      delivery path (the env var lives in the child's process address
 *      space and cannot be forged by other processes on the host).
 *
 *   2. Optional Unix-socket peer credentials — when the request arrives
 *      via `/tmp/autonomous-dev-cred.sock`, SO_PEERCRED gives us the
 *      peer's `(pid, uid)`. We cross-check against the live-backends
 *      registry, which is populated by the spawner at fork time and torn
 *      down at child exit.
 *
 * The registry is in-process state inside the single daemon. Multi-daemon
 * scenarios are explicitly out of scope (TDD-024 §7.4).
 *
 * @module intake/cred-proxy/caller-identity
 */

import { SecurityError } from './types';

/**
 * Caller context attached to an `acquire()` invocation. Empty for stdin;
 * populated by the socket server on each accepted connection.
 */
export interface CallerContext {
  /** Set when the request arrives via Unix socket; absent for stdin. */
  readonly socketPeer?: { pid: number; uid: number };
}

interface PrivilegedBackendRegistration {
  pid: number;
  uid: number;
  pluginId: string;
}

/**
 * Live-backends registry. Module-scope so the spawner and the proxy
 * share the same state without explicit threading. Tests reset it via
 * `__resetLiveBackendsForTests`.
 */
const liveBackends = new Map<number, PrivilegedBackendRegistration>();

/** Register a privileged backend at child fork time. */
export function registerLiveBackend(
  reg: PrivilegedBackendRegistration,
): void {
  liveBackends.set(reg.pid, { ...reg });
}

/** Unregister at child exit. */
export function unregisterLiveBackend(pid: number): void {
  liveBackends.delete(pid);
}

/**
 * Test-only escape hatch. Production code never calls this — the
 * registry's lifetime is the daemon's lifetime.
 */
export function __resetLiveBackendsForTests(): void {
  liveBackends.clear();
}

/**
 * Resolve the calling plugin's id. Throws `SecurityError` on any
 * mismatch — the proxy translates the throw into a `credential_denied`
 * audit event (SPEC-024-2-04).
 */
export function resolveCaller(caller?: CallerContext): string {
  const envPluginId = process.env.AUTONOMOUS_DEV_PLUGIN_ID;
  if (!envPluginId) {
    throw new SecurityError(
      'CALLER_UNKNOWN',
      'AUTONOMOUS_DEV_PLUGIN_ID not set',
    );
  }

  if (!caller?.socketPeer) {
    // Stdin path: the env var IS the identity (set by the daemon when
    // spawning the child). No peer-cred cross-check is possible — and
    // none is needed, because the env var is private to the child's
    // process address space.
    return envPluginId;
  }

  // Socket path: cross-check SCM_RIGHTS peer against the live-backends
  // registry. The daemon fork is the only legitimate source of
  // (env=plugin-X, pid registered as plugin-X) — anything else is a
  // spoofed caller and gets rejected.
  const reg = liveBackends.get(caller.socketPeer.pid);
  if (
    !reg ||
    reg.uid !== caller.socketPeer.uid ||
    reg.pluginId !== envPluginId
  ) {
    throw new SecurityError(
      'CALLER_SPOOFED',
      `peer pid=${caller.socketPeer.pid} uid=${caller.socketPeer.uid} does not match env identity ${envPluginId}`,
    );
  }
  return envPluginId;
}
