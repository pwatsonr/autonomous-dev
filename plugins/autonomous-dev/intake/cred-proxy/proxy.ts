/**
 * CredentialProxy — issues 15-minute, operation-scoped cloud credentials
 * to privileged backend plugins.
 *
 * This file is the SPEC-024-2-01 SKELETON. `acquire()` and `revoke()`
 * throw `NotImplemented`; SPEC-024-2-04 replaces them with the full
 * implementation that calls the appropriate scoper, schedules
 * auto-revocation, and emits audit events. What this skeleton commits to
 * is:
 *
 *   - The 15-minute (900-second) TTL is a private module-scope `const`,
 *     never read from config, never overridden by callers (TDD-024 §7.4).
 *   - Caller identity is resolved via `resolveCaller` and cross-checked
 *     against the privileged-backends allowlist BEFORE any scoper is
 *     invoked. Non-allowlisted callers are rejected with `SecurityError`.
 *   - The scoper-presence check distinguishes "you're not allowed" from
 *     "we don't know how to scope this provider" — the latter is a
 *     generic `Error`, not a `SecurityError`.
 *
 * @module intake/cred-proxy/proxy
 */

import { randomUUID } from 'node:crypto';

import {
  type CredentialScoper,
  type Provider,
  type Scope,
  type ScopedCredential,
  SecurityError,
} from './types';
import { resolveCaller, type CallerContext } from './caller-identity';

/**
 * TTL in seconds. Hard-coded per TDD-024 §7.4. NOT configurable.
 *
 * Re-exported from `./ttl` so SPEC-024-2-04's `active-tokens.ts` can
 * import the constant without inducing a circular dependency on
 * `proxy.ts`. The two re-exports are equivalent — pick whichever import
 * keeps your file's dependency graph tidy.
 */
export const TTL_SECONDS = 900;

/**
 * Constructor-injected dependencies. SPEC-024-2-04 will extend this
 * interface with the active-token registry and audit emitter; the
 * skeleton ships only the two surfaces required by allowlist enforcement
 * so downstream specs can grow the dep set additively.
 */
export interface CredentialProxyDeps {
  readonly scopers: ReadonlyMap<Provider, CredentialScoper>;
  readonly privilegedBackends: ReadonlySet<string>;
}

/**
 * In-process credential proxy. Single instance per daemon; SPEC-024-2-04
 * wires it to the IPC server (operator CLI) and the session spawner
 * (stdin delivery to backends).
 */
export class CredentialProxy {
  constructor(private readonly deps: CredentialProxyDeps) {}

  /**
   * Acquire a scoped credential. Steps:
   *
   *   1. Resolve caller identity (throws on missing/spoofed).
   *   2. Check allowlist (throws `NOT_ALLOWLISTED`).
   *   3. Check scoper presence (throws generic `Error`).
   *   4. Invoke scoper (SPEC-024-2-04 — currently `NotImplemented`).
   *
   * The skeleton intentionally throws `NotImplemented` after the three
   * authorisation checks pass so downstream specs can lean on the
   * stable type surface without enabling accidental partial calls.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async acquire(
    provider: Provider,
    operation: string,
    scope: Scope,
    caller?: CallerContext,
  ): Promise<ScopedCredential> {
    const pluginId = resolveCaller(caller); // throws SecurityError on mismatch
    if (!this.deps.privilegedBackends.has(pluginId)) {
      throw new SecurityError(
        'NOT_ALLOWLISTED',
        `plugin ${pluginId} not in privileged_backends`,
      );
    }
    const scoper = this.deps.scopers.get(provider);
    if (!scoper) {
      throw new Error(`no scoper registered for provider ${provider}`);
    }
    // Scoper invocation, TTL timer wiring, audit emission live in
    // SPEC-024-2-04. The skeleton placeholder throws so the type surface
    // compiles for downstream specs:
    void operation;
    void scope;
    throw new Error(
      'NotImplemented: scoper invocation lives in SPEC-024-2-04',
    );
  }

  /**
   * Revoke an active token. Implemented in SPEC-024-2-04 alongside TTL
   * enforcement; the skeleton throws so callers cannot accidentally
   * treat a no-op as success.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async revoke(token_id: string): Promise<void> {
    void token_id;
    throw new Error('NotImplemented: revoke lives in SPEC-024-2-04');
  }

  /** Exposed for tests + future status CLI. */
  protected newTokenId(): string {
    return randomUUID();
  }
}
