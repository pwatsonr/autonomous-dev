# SPEC-024-2-01: ScopedCredential Types, CredentialProxy Skeleton, and Privileged-Backends Allowlist

## Metadata
- **Parent Plan**: PLAN-024-2
- **Tasks Covered**: Task 1 (`ScopedCredential` interface + proxy skeleton), Task 2 (privileged-backends allowlist enforcement)
- **Estimated effort**: 4.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-2-01-scoped-credential-types-proxy-skeleton-allowlist.md`

## Description
Lay the type foundation and security gate for the entire CredentialProxy subsystem. This spec creates the `ScopedCredential` interface (per TDD-024 §7.1), the `CredentialProxy` class skeleton with `acquire`/`revoke` method signatures, and the privileged-backends allowlist check that runs before any scoper is invoked. The 15-minute (900 second) TTL is a private module-scope `const` — never read from config, never overridden by callers. The allowlist check identifies callers via `process.env.AUTONOMOUS_DEV_PLUGIN_ID` (set by the daemon at child spawn), and when the request arrives over the Unix socket also cross-checks the SCM_RIGHTS-validated PID/UID against the registry of currently-running privileged backends.

This spec ships no scopers, no delivery mechanisms, and no audit emission — those land in subsequent specs (SPEC-024-2-02, -03, -04). What it ships is: a compiling type surface that downstream specs depend on, and a hardened entry point that rejects every non-allowlisted caller with `SecurityError` before any cloud API call can occur.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/cred-proxy/types.ts` | Create | `ScopedCredential`, `Provider`, `Scope`, `SecurityError`, `CredentialScoper` interfaces |
| `plugins/autonomous-dev/src/cred-proxy/proxy.ts` | Create | `CredentialProxy` class skeleton with `TTL_SECONDS`, `acquire`, `revoke` |
| `plugins/autonomous-dev/src/cred-proxy/caller-identity.ts` | Create | Resolves caller `pluginId` from env + optional socket peer credentials |
| `plugins/autonomous-dev/src/config/extensions-schema.ts` | Modify | Add `privileged_backends: string[]` to the extensions config schema |
| `plugins/autonomous-dev/tests/cred-proxy/test-proxy-skeleton.test.ts` | Create | Constructor, TTL constant, allowlist enforcement |
| `plugins/autonomous-dev/tests/cred-proxy/test-caller-identity.test.ts` | Create | Env-only path, env+socket path, spoof detection |

## Implementation Details

### `src/cred-proxy/types.ts`

```ts
export type Provider = 'aws' | 'gcp' | 'azure' | 'k8s';
export type Delivery = 'stdin' | 'socket';

export interface Scope {
  /** Free-form, provider-specific resource identifiers (region/account/project/etc). */
  readonly [key: string]: string;
}

export interface ScopedCredential {
  readonly provider: Provider;
  readonly delivery: Delivery;
  /** Provider-specific JSON payload (STS creds, kubeconfig, etc). Opaque to the proxy. */
  readonly payload: string;
  /** ISO-8601 UTC timestamp when the credential becomes invalid. */
  readonly expires_at: string;
  /** UUIDv4 — used by the proxy and audit log to correlate issuance and revocation. */
  readonly token_id: string;
  readonly scope: { readonly operation: string; readonly resources: Scope };
}

export interface CredentialScoper {
  readonly provider: Provider;
  scope(operation: string, scope: Scope): Promise<{
    payload: string;
    expires_at: string;
    revoke: () => Promise<void>;
  }>;
}

export class SecurityError extends Error {
  readonly code: 'NOT_ALLOWLISTED' | 'CALLER_UNKNOWN' | 'CALLER_SPOOFED';
  constructor(code: SecurityError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'SecurityError';
  }
}
```

`ScopedCredential` is `readonly` end-to-end so downstream specs cannot mutate it after issuance. `Scope` is intentionally an open record — each scoper validates the keys it actually consumes (the proxy itself does not validate scope shape).

### `src/cred-proxy/proxy.ts`

```ts
import { randomUUID } from 'node:crypto';
import type { Provider, Scope, ScopedCredential, CredentialScoper } from './types';
import { SecurityError } from './types';
import { resolveCaller, type CallerContext } from './caller-identity';

/** TTL in seconds. Hard-coded per TDD-024 §7.4. NOT configurable. */
export const TTL_SECONDS = 900;

export interface CredentialProxyDeps {
  readonly scopers: ReadonlyMap<Provider, CredentialScoper>;
  readonly privilegedBackends: ReadonlySet<string>;
}

export class CredentialProxy {
  constructor(private readonly deps: CredentialProxyDeps) {}

  async acquire(
    provider: Provider,
    operation: string,
    scope: Scope,
    caller?: CallerContext,
  ): Promise<ScopedCredential> {
    const pluginId = resolveCaller(caller); // throws SecurityError on mismatch
    if (!this.deps.privilegedBackends.has(pluginId)) {
      throw new SecurityError('NOT_ALLOWLISTED', `plugin ${pluginId} not in privileged_backends`);
    }
    const scoper = this.deps.scopers.get(provider);
    if (!scoper) {
      throw new Error(`no scoper registered for provider ${provider}`);
    }
    // Scoper invocation, TTL timer wiring, audit emission: SPEC-024-2-04.
    // Skeleton placeholder so the type surface compiles for downstream specs:
    throw new Error('NotImplemented: scoper invocation lives in SPEC-024-2-04');
  }

  async revoke(token_id: string): Promise<void> {
    // Implemented in SPEC-024-2-04 alongside TTL enforcement.
    throw new Error('NotImplemented: revoke lives in SPEC-024-2-04');
  }

  /** Exposed for tests + future status CLI. */
  protected newTokenId(): string { return randomUUID(); }
}
```

The skeleton intentionally `throw`s `NotImplemented` for scoper invocation and revocation — those land in SPEC-024-2-04. What it implements fully here: caller resolution, allowlist enforcement, scoper-presence check.

### `src/cred-proxy/caller-identity.ts`

```ts
export interface CallerContext {
  /** Set when the request arrives via Unix socket; absent for stdin path. */
  readonly socketPeer?: { pid: number; uid: number };
}

interface PrivilegedBackendRegistration {
  pid: number;
  uid: number;
  pluginId: string;
}

const liveBackends = new Map<number, PrivilegedBackendRegistration>();

export function registerLiveBackend(reg: PrivilegedBackendRegistration): void {
  liveBackends.set(reg.pid, reg);
}
export function unregisterLiveBackend(pid: number): void {
  liveBackends.delete(pid);
}

export function resolveCaller(caller?: CallerContext): string {
  const envPluginId = process.env.AUTONOMOUS_DEV_PLUGIN_ID;
  if (!envPluginId) {
    throw new SecurityError('CALLER_UNKNOWN', 'AUTONOMOUS_DEV_PLUGIN_ID not set');
  }
  if (!caller?.socketPeer) {
    // Stdin path: env var IS the identity (set by the daemon when spawning the child).
    return envPluginId;
  }
  // Socket path: cross-check SCM_RIGHTS peer against the live-backends registry.
  const reg = liveBackends.get(caller.socketPeer.pid);
  if (!reg || reg.uid !== caller.socketPeer.uid || reg.pluginId !== envPluginId) {
    throw new SecurityError('CALLER_SPOOFED', `peer ${caller.socketPeer.pid} does not match ${envPluginId}`);
  }
  return envPluginId;
}

import { SecurityError } from './types';
```

`registerLiveBackend`/`unregisterLiveBackend` are populated by the session spawner (SPEC-024-2-04 wires the call sites). For this spec the registry is exposed for tests to seed directly.

### `src/config/extensions-schema.ts`

Add the `privileged_backends` field to the existing `extensions` schema (see PLAN-019-3 for the pre-existing trust schema). Validation rule: each entry must be a non-empty plugin ID string matching `^[a-z][a-z0-9-]{1,63}$` (the same regex used elsewhere for plugin IDs). Default: `[]` (empty allowlist; no plugin can call `acquire`).

```ts
// inside the extensions schema definition
privileged_backends: {
  type: 'array',
  items: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' },
  default: [],
  description: 'Plugin IDs allowed to call CredentialProxy.acquire.',
},
```

Operators add to this list via the `cred-proxy allow <plugin>` admin CLI (SPEC-024-2-04).

## Acceptance Criteria

### Type surface

- [ ] `tsc --noEmit` succeeds against `src/cred-proxy/types.ts` with no errors.
- [ ] `ScopedCredential` is fully `readonly` — `cred.payload = 'x'` is a TypeScript compile error.
- [ ] `SecurityError` is `instanceof Error` and exposes `code` of one of the three documented values.
- [ ] `CredentialScoper` is consumable by downstream scoper specs (verified by a stub class implementing the interface in the test file).

### TTL constant

- [ ] `TTL_SECONDS === 900` exactly. The constant is a `const` export at module scope.
- [ ] No code path reads `TTL_SECONDS` from `process.env` or any config object (verified by grep: `grep -nE 'TTL_SECONDS|process\\.env\\.TTL' src/cred-proxy/proxy.ts` shows only the const definition).

### Allowlist enforcement

- [ ] `acquire` with `pluginId` not in `privilegedBackends` rejects with `SecurityError` whose `code === 'NOT_ALLOWLISTED'`. No scoper method is called (verified via a spy scoper).
- [ ] `acquire` with `AUTONOMOUS_DEV_PLUGIN_ID` unset rejects with `SecurityError` `code === 'CALLER_UNKNOWN'`.
- [ ] `acquire` with `pluginId` in the allowlist + valid socket peer (registered via `registerLiveBackend`) proceeds past the allowlist check (then throws `NotImplemented` from the skeleton — that throw is the success signal for this spec).
- [ ] `acquire` with env `AUTONOMOUS_DEV_PLUGIN_ID=plugin-a` but socket peer registered as `plugin-b` rejects with `SecurityError` `code === 'CALLER_SPOOFED'`.
- [ ] `acquire` with a socket peer whose PID is not in the live-backends registry rejects with `CALLER_SPOOFED`.
- [ ] `acquire` requesting a provider with no scoper registered throws a generic `Error` (not `SecurityError`), distinct from authorization failures.

### Config schema

- [ ] Loading a config with `extensions.privileged_backends: ['plugin-a', 'plugin-b']` succeeds; both IDs are accessible.
- [ ] Loading a config with `extensions.privileged_backends: ['BadCase']` fails schema validation (uppercase rejected by the regex).
- [ ] Loading a config with no `privileged_backends` key produces `[]` as the default (no implicit allowlist).

### Caller identity unit tests

- [ ] `resolveCaller(undefined)` with env set returns the env value (stdin path).
- [ ] `resolveCaller({ socketPeer: { pid: 1234, uid: 1000 } })` after `registerLiveBackend({ pid: 1234, uid: 1000, pluginId: 'plugin-a' })` and env `plugin-a` returns `'plugin-a'`.
- [ ] `unregisterLiveBackend(1234)` followed by the same call rejects with `CALLER_SPOOFED`.

## Dependencies

- TypeScript ≥ 5.0 (uses `readonly` on index signatures).
- `node:crypto` `randomUUID` (Node ≥ 14.17, satisfied by the project minimum of Node 18).
- Existing `extensions` config loader (PLAN-019-3 — adding a field, not creating the loader).
- No new npm dependencies introduced.

## Notes

- The `NotImplemented` throws in `acquire`/`revoke` are deliberate. Downstream specs (SPEC-024-2-04 in particular) will replace them. Keeping the skeleton compilable with a runtime-failing implementation gives downstream specs a stable type surface to import against without enabling accidental partial-function calls.
- `process.env.AUTONOMOUS_DEV_PLUGIN_ID` is the contract the daemon's session spawner upholds (PLAN-018-2 already sets per-child env vars; the new key slots into the existing pattern). The spawner extension lives in SPEC-024-2-04.
- The `liveBackends` registry is in-process state inside the daemon — there is exactly one daemon per host. Multi-daemon scenarios are explicitly out of scope (TDD-024 §7.4).
- The plugin-ID regex (`^[a-z][a-z0-9-]{1,63}$`) is duplicated rather than imported from PLAN-019-1 to keep this spec self-contained; the next refactor pass should consolidate to a single shared validator (out of scope here).
- This spec does NOT require the audit log writer (PLAN-019-4) — `credential_denied` events for `SecurityError` rejections are emitted in SPEC-024-2-04 once the audit dependency is wired. Tests for this spec assert on the thrown error only.
