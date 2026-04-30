# SPEC-024-2-04: Credential Delivery, TTL Enforcement, Audit, and CLI

## Metadata
- **Parent Plan**: PLAN-024-2
- **Tasks Covered**: Task 7 (stdin delivery), Task 8 (Unix socket fallback with SCM_RIGHTS), Task 9 (TTL enforcement / auto-revocation), Task 10 (audit log integration), Task 11 (`cred-proxy status` and `revoke` CLI)
- **Estimated effort**: 13 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-2-04-delivery-ttl-audit-cli.md`

## Description
Wire the security-critical machinery around the `CredentialProxy` skeleton from SPEC-024-2-01: delivery (how the credential reaches the backend), TTL (when it stops being valid), audit (what gets recorded), and operator surface (CLI commands). This is the single largest spec in the PLAN-024-2 series — these five concerns share so much state that splitting them further would force the same data structures to be re-defined across multiple specs. They are presented together; engineers can implement them in the order listed (delivery → socket → TTL → audit → CLI), each step building on the previous.

After this spec, the proxy is fully functional end-to-end: a privileged backend spawned by the daemon receives credentials via stdin, can re-acquire via the Unix socket if it needs additional scopes mid-deploy, and every issuance/revocation/denial is recorded in the HMAC-chained audit log from PLAN-019-4. The `cred-proxy status` and `cred-proxy revoke` CLI commands give operators visibility and emergency override.

This spec replaces the `NotImplemented` throws in `CredentialProxy.acquire` and `CredentialProxy.revoke` from SPEC-024-2-01 with the full implementation that calls the appropriate scoper, schedules auto-revocation, emits audit events, and tracks active tokens.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/cred-proxy/proxy.ts` | Modify | Replace `NotImplemented` throws; wire scoper, TTL, audit |
| `plugins/autonomous-dev/src/cred-proxy/active-tokens.ts` | Create | In-memory registry of issued tokens + auto-revoke timers |
| `plugins/autonomous-dev/src/cred-proxy/socket-server.ts` | Create | Unix socket server with SCM_RIGHTS auth |
| `plugins/autonomous-dev/src/cred-proxy/audit-emitter.ts` | Create | Wraps PLAN-019-4 audit writer with `credential_*` events |
| `plugins/autonomous-dev/src/sessions/session-spawner.ts` | Modify | Stdin delivery + register live backend |
| `plugins/autonomous-dev/src/cli/commands/cred-proxy.ts` | Create | `status`, `revoke`, `allow` subcommands |
| `plugins/autonomous-dev/src/cli/dispatcher.ts` | Modify | Register `cred-proxy` subcommand group |
| `plugins/autonomous-dev/tests/cred-proxy/test-proxy-acquire.test.ts` | Create | End-to-end with mock scopers |
| `plugins/autonomous-dev/tests/cred-proxy/test-active-tokens.test.ts` | Create | TTL timers, early release, shutdown |
| `plugins/autonomous-dev/tests/cred-proxy/test-socket-server.test.ts` | Create | Real Unix socket in temp dir |
| `plugins/autonomous-dev/tests/cred-proxy/test-cli.test.ts` | Create | CLI subcommand integration |

## Implementation Details

### `src/cred-proxy/active-tokens.ts`

```ts
import type { ScopedCredential, Provider } from './types';

export interface ActiveToken {
  readonly token_id: string;
  readonly provider: Provider;
  readonly operation: string;
  readonly caller: string;
  readonly issued_at: string;
  readonly expires_at: string;
  /** Cloud-side revocation closure returned by the scoper. */
  readonly revoke: () => Promise<void>;
  /** Timer handle for auto-revocation; cancelled on early release. */
  readonly timer: NodeJS.Timeout;
}

export class ActiveTokenRegistry {
  private readonly byId = new Map<string, ActiveToken>();

  register(t: ActiveToken): void { this.byId.set(t.token_id, t); }

  get(token_id: string): ActiveToken | undefined { return this.byId.get(token_id); }

  list(): readonly ActiveToken[] { return Array.from(this.byId.values()); }

  remove(token_id: string): ActiveToken | undefined {
    const t = this.byId.get(token_id);
    if (t) { clearTimeout(t.timer); this.byId.delete(token_id); }
    return t;
  }

  drainAll(): readonly ActiveToken[] {
    const all = this.list();
    for (const t of all) clearTimeout(t.timer);
    this.byId.clear();
    return all;
  }
}
```

### `src/cred-proxy/audit-emitter.ts`

```ts
import type { AuditWriter } from '../audit/writer';   // PLAN-019-4
import type { Provider } from './types';

export type CredentialEventType =
  | 'credential_issued'
  | 'credential_revoked'
  | 'credential_expired'
  | 'credential_denied';

export interface CredentialEventBase {
  type: CredentialEventType;
  caller: string;
  provider: Provider;
  operation: string;
  scope: Record<string, string>;
  token_id?: string;
  reason?: string; // populated on _denied and on _revoked when forced
}

export class CredentialAuditEmitter {
  constructor(private readonly writer: AuditWriter) {}

  emit(event: CredentialEventBase): void {
    this.writer.append({ category: 'cred-proxy', timestamp: new Date().toISOString(), ...event });
  }
}
```

The emitter is a thin shim — the HMAC chaining and on-disk persistence live in PLAN-019-4's `AuditWriter`. Tests use a fake `AuditWriter` to assert event shape; SPEC-024-2-05's integration test verifies the chain remains intact.

### `src/cred-proxy/proxy.ts` — full implementation

Replace the SPEC-024-2-01 skeleton with:

```ts
import { TTL_SECONDS } from './ttl';                            // exports the const from SPEC-024-2-01
import type { ScopedCredential, Provider, Scope, CredentialScoper } from './types';
import { SecurityError } from './types';
import { resolveCaller, type CallerContext } from './caller-identity';
import { ActiveTokenRegistry } from './active-tokens';
import { CredentialAuditEmitter } from './audit-emitter';
import { randomUUID } from 'node:crypto';

export interface CredentialProxyDeps {
  readonly scopers: ReadonlyMap<Provider, CredentialScoper>;
  readonly privilegedBackends: ReadonlySet<string>;
  readonly registry: ActiveTokenRegistry;
  readonly audit: CredentialAuditEmitter;
}

export class CredentialProxy {
  constructor(private readonly deps: CredentialProxyDeps) {}

  async acquire(provider: Provider, operation: string, scope: Scope, caller?: CallerContext): Promise<ScopedCredential> {
    let pluginId: string;
    try { pluginId = resolveCaller(caller); }
    catch (err) {
      const e = err as SecurityError;
      this.deps.audit.emit({ type: 'credential_denied', caller: 'unknown', provider, operation, scope, reason: e.code });
      throw err;
    }

    if (!this.deps.privilegedBackends.has(pluginId)) {
      this.deps.audit.emit({ type: 'credential_denied', caller: pluginId, provider, operation, scope, reason: 'NOT_ALLOWLISTED' });
      throw new SecurityError('NOT_ALLOWLISTED', `plugin ${pluginId} not in privileged_backends`);
    }

    const scoper = this.deps.scopers.get(provider);
    if (!scoper) throw new Error(`no scoper registered for provider ${provider}`);

    const result = await scoper.scope(operation, scope);
    const token_id = randomUUID();
    const issued_at = new Date().toISOString();
    const delivery = caller?.socketPeer ? 'socket' : 'stdin';

    const cred: ScopedCredential = {
      provider,
      delivery,
      payload: result.payload,
      expires_at: result.expires_at,
      token_id,
      scope: { operation, resources: scope },
    };

    const timer = setTimeout(() => { this.expire(token_id).catch(() => {}); }, TTL_SECONDS * 1000);
    timer.unref(); // do not keep the daemon alive solely on this timer

    this.deps.registry.register({
      token_id, provider, operation, caller: pluginId, issued_at, expires_at: result.expires_at,
      revoke: result.revoke, timer,
    });

    this.deps.audit.emit({ type: 'credential_issued', caller: pluginId, provider, operation, scope, token_id });
    return cred;
  }

  async revoke(token_id: string, reason: 'released' | 'admin-forced' = 'released'): Promise<void> {
    const t = this.deps.registry.remove(token_id);
    if (!t) return; // already gone
    await this.callRevokeWithRetry(t.revoke);
    this.deps.audit.emit({ type: 'credential_revoked', caller: t.caller, provider: t.provider, operation: t.operation, scope: {}, token_id, reason });
  }

  /** Internal: fired by the per-token timer at TTL. */
  private async expire(token_id: string): Promise<void> {
    const t = this.deps.registry.remove(token_id);
    if (!t) return;
    await this.callRevokeWithRetry(t.revoke);
    this.deps.audit.emit({ type: 'credential_expired', caller: t.caller, provider: t.provider, operation: t.operation, scope: {}, token_id });
  }

  /** 3 retries with exponential backoff (100ms, 400ms, 1600ms). Final failure is logged but swallowed. */
  private async callRevokeWithRetry(fn: () => Promise<void>): Promise<void> {
    const delays = [0, 100, 400, 1600];
    let lastErr: unknown;
    for (const d of delays) {
      if (d) await new Promise(r => setTimeout(r, d));
      try { await fn(); return; } catch (err) { lastErr = err; }
    }
    console.error('[cred-proxy] revoke failed after 3 retries; cloud TTL will reclaim', lastErr);
  }

  /** Called by the daemon shutdown handler. Revokes all active tokens. */
  async shutdown(): Promise<void> {
    const all = this.deps.registry.drainAll();
    await Promise.allSettled(all.map(t =>
      this.callRevokeWithRetry(t.revoke).then(() =>
        this.deps.audit.emit({ type: 'credential_revoked', caller: t.caller, provider: t.provider, operation: t.operation, scope: {}, token_id: t.token_id, reason: 'daemon-shutdown' })
      )
    ));
  }
}
```

### `src/cred-proxy/socket-server.ts`

```ts
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CredentialProxy } from './proxy';

export const SOCKET_PATH = '/tmp/autonomous-dev-cred.sock';

interface SocketRequest { provider: string; operation: string; scope: Record<string, string> }
interface SocketResponse { ok: boolean; cred?: unknown; error?: string }

export class CredProxySocketServer {
  private server?: net.Server;
  /** Serializes all request handling — TDD §7.3 says "no race." */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly proxy: CredentialProxy) {}

  async start(): Promise<void> {
    // Atomic create-with-mode: remove stale, then create at 0o600 via fs.writeFileSync trick? No — use net.Server then chmod.
    // To avoid the create→chmod race, we set process umask before listen and restore after.
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o700 });
    const previousUmask = process.umask(0o077);
    try {
      this.server = net.createServer((sock) => this.handle(sock));
      await new Promise<void>((resolve, reject) => this.server!.listen(SOCKET_PATH, (err?: Error) => err ? reject(err) : resolve()));
      // Defense in depth: explicit chmod even though umask was set.
      fs.chmodSync(SOCKET_PATH, 0o600);
    } finally {
      process.umask(previousUmask);
    }
  }

  private handle(sock: net.Socket): void {
    // SCM_RIGHTS / peer credentials: Node exposes peer PID/UID via the platform-specific
    // `getpeercred` syscall through `sock as any`._handle?.getsockname... — but the public API
    // surface is unstable. We use the `unix-dgram` / `node-getsockopt` shim approach:
    const peer = getPeerCred(sock); // helper documented below
    let buf = '';
    sock.on('data', (chunk) => { buf += chunk.toString('utf8'); });
    sock.on('end', () => {
      this.chain = this.chain.then(async () => {
        try {
          const req = JSON.parse(buf) as SocketRequest;
          const cred = await this.proxy.acquire(req.provider as any, req.operation, req.scope, { socketPeer: peer });
          sock.end(JSON.stringify({ ok: true, cred } satisfies SocketResponse) + '\n');
        } catch (err) {
          sock.end(JSON.stringify({ ok: false, error: (err as Error).message } satisfies SocketResponse) + '\n');
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  }
}

/**
 * Reads SO_PEERCRED from the socket using the Linux/macOS-specific getsockopt path.
 * On Linux: SO_PEERCRED returns {pid, uid, gid}.
 * On macOS: LOCAL_PEERCRED + LOCAL_PEERPID (two getsockopt calls).
 * Implementation uses `process.getuid()`/`process.getgid()` fallback ONLY for tests
 * with a mock socket — never in production.
 */
function getPeerCred(sock: net.Socket): { pid: number; uid: number } {
  // Production implementation uses native binding: e.g., `node-unix-socket` or a small N-API addon.
  // The implementor should add the chosen package to package.json. This spec mandates the
  // INTERFACE (returns {pid, uid}), not the specific package.
  const fd = (sock as any)._handle?.fd;
  if (typeof fd !== 'number') throw new Error('socket has no fd; cannot read peer credentials');
  return readSoPeercred(fd); // implemented in the chosen native binding
}
```

The `getPeerCred` implementation is platform-specific. The implementor MUST choose a maintained native package (candidates: `node-unix-socket`, `unix-socket-creds`) or write a small N-API addon. The acceptance criteria below test the interface, not the internals. CI runs on Linux; macOS support is best-effort.

### `src/sessions/session-spawner.ts` modifications

When the daemon spawns a backend child process and the backend's `extensions.privileged_backends` list includes its plugin ID:

1. Set env `AUTONOMOUS_DEV_PLUGIN_ID=<pluginId>` on the child.
2. Call `registerLiveBackend({ pid: child.pid, uid: process.getuid(), pluginId })` from `caller-identity.ts`.
3. If the spawn config requests an initial credential (manifest hint `credential.initial: { provider, operation, scope }`):
   a. Call `proxy.acquire(provider, operation, scope, { /* no socketPeer — this is the stdin path */ })`.
   b. Write `JSON.stringify(scopedCredential) + '\n'` to `child.stdin`.
   c. Close `child.stdin` (the child gets EOF on its second read).
4. On child exit, call `unregisterLiveBackend(child.pid)`.

The stdin write path is **synchronous from the child's perspective**: it reads stdin once during initialization and never reads again. Backends needing additional credentials use the socket.

### `src/cli/commands/cred-proxy.ts`

Three subcommands using the existing IPC pattern from SPEC-019-1-04 (CLI sends a JSON request to the daemon's IPC socket, prints the response):

**`autonomous-dev cred-proxy status [--json]`**
- IPC command: `{ command: 'cred-proxy.status' }`.
- Response: `{ tokens: ActiveToken[] }` with `revoke` and `timer` fields stripped.
- Default rendering: table with columns `token_id (first 12 chars) | caller | provider | operation | issued_at | expires_at | ttl_remaining_s`.
- `--json` → raw payload.

**`autonomous-dev cred-proxy revoke <token_id>`**
- Requires admin role (verified via PLAN-019-3 trust framework — same check used for `cred-proxy allow`).
- IPC: `{ command: 'cred-proxy.revoke', token_id }`.
- Response: `{ ok: boolean }`.
- Exit 0 on `ok: true`, exit 1 otherwise. Prints a confirmation line.

**`autonomous-dev cred-proxy allow <plugin-id>`** (admin only)
- Adds `<plugin-id>` to `extensions.privileged_backends[]` in the live config and persists.
- IPC: `{ command: 'cred-proxy.allow', pluginId }`.
- Audit event `privileged_backend_added` with caller-admin identity (uses PLAN-019-4 audit writer).

The IPC server (PLAN-019-4 / SPEC-019-1-04) gets three new command cases routed to the proxy.

## Acceptance Criteria

### Proxy `acquire`

- [ ] Successful `acquire` returns a `ScopedCredential` with `delivery: 'stdin'` when no `caller.socketPeer` is supplied; `'socket'` when one is.
- [ ] Successful `acquire` registers exactly one `ActiveToken` in the `ActiveTokenRegistry`.
- [ ] Successful `acquire` emits exactly one `credential_issued` audit event with `caller`, `provider`, `operation`, `scope`, and `token_id` populated.
- [ ] `SecurityError` from caller resolution emits one `credential_denied` event with `reason` set to the `SecurityError.code` (one of `CALLER_UNKNOWN`, `CALLER_SPOOFED`).
- [ ] Allowlist rejection emits one `credential_denied` with `reason: 'NOT_ALLOWLISTED'`.
- [ ] Failed audit events still allow the underlying `acquire` to succeed/fail per its own logic (audit emission MUST NOT block credential issuance — verified via a throwing audit emitter).

### TTL enforcement (active-tokens)

- [ ] A token issued at T+0 is auto-revoked within ±2 seconds of T+900s (verified using fake timers; the timer fires at 900_000ms exactly).
- [ ] On auto-revocation, the registry no longer contains the token AND a `credential_expired` audit event is emitted.
- [ ] `revoke(token_id)` called at T+30s revokes immediately, emits `credential_revoked` with `reason: 'released'`, and the auto-revoke timer is cancelled (`clearTimeout` invoked — verified by a spy).
- [ ] `proxy.shutdown()` revokes all active tokens, emits one `credential_revoked` per token with `reason: 'daemon-shutdown'`, and `Promise.allSettled` ensures one failed revoke does not prevent the others from running.
- [ ] `revoke('does-not-exist')` is a no-op (no error, no audit event).
- [ ] Scoper `revoke()` failures retry up to 3 times with delays [0, 100ms, 400ms, 1600ms]. After the 3rd failure, the error is logged and swallowed (the proxy continues; the cloud TTL is the authoritative limit).
- [ ] All TTL timers are `unref()`ed (verified by inspection — the daemon process must not be kept alive solely by pending revoke timers).

### Socket server

- [ ] `start()` creates the socket file at `/tmp/autonomous-dev-cred.sock` with mode `0o600` (verified via `fs.statSync`).
- [ ] `start()` after a previous unclean shutdown removes the stale socket file and creates a fresh one.
- [ ] A connection from a process with peer credentials matching a registered live backend results in a successful `acquire` call with `caller.socketPeer = { pid, uid }`.
- [ ] A connection from a process whose PID is NOT registered in the live-backends registry receives `{ ok: false, error: <...CALLER_SPOOFED... or NOT_ALLOWLISTED...> }`.
- [ ] Two simultaneous connections requesting credentials are handled SERIALLY (verified by a fixture scoper that records the order of `scope()` calls — second call does not start until first returns).
- [ ] The umask is restored to its prior value after `start()` returns (verified by reading `process.umask()` before and after).
- [ ] `stop()` closes the server and unlinks the socket file.
- [ ] Test runs against a real Unix socket in `os.tmpdir()/cred-proxy-test-<rand>/sock` to avoid interference with a running daemon.

### Stdin delivery (session spawner)

- [ ] Spawning a backend with `credential.initial = { provider: 'aws', operation: 'ECS:UpdateService', scope: {...} }` writes one line of JSON to the child's stdin and then closes stdin.
- [ ] The child's `process.env.AUTONOMOUS_DEV_PLUGIN_ID` matches the backend's plugin ID.
- [ ] Reading the child's stdin a second time returns EOF (verified by a fixture child that prints what it reads to stdout — second read returns empty).
- [ ] On child exit, `unregisterLiveBackend` is called with the child's PID.
- [ ] Spawning a backend NOT in `privileged_backends` proceeds without setting the env var or registering — and the child is unable to call `acquire` if it tries (verified end-to-end).

### CLI

- [ ] `autonomous-dev cred-proxy status` prints a table including the columns: token_id (first 12 chars), caller, provider, operation, issued_at, expires_at, ttl_remaining_s.
- [ ] `autonomous-dev cred-proxy status --json` emits a parseable JSON array (`jq -e .` exit 0); each element has the documented fields and NO `revoke` or `timer` fields.
- [ ] `autonomous-dev cred-proxy status` with no active tokens prints `(no active tokens)` and exits 0.
- [ ] `autonomous-dev cred-proxy revoke <token_id>` against an existing token revokes it and prints `revoked: <token_id>`. Exit 0.
- [ ] `autonomous-dev cred-proxy revoke <bogus>` exits 0 with `(no such token)` — `revoke` is idempotent (already-gone is success).
- [ ] `autonomous-dev cred-proxy revoke <token_id>` invoked by a non-admin user is rejected with exit 1 and `admin role required` on stderr.
- [ ] `autonomous-dev cred-proxy allow <plugin-id>` adds the plugin to `extensions.privileged_backends[]` in the live config; subsequent `acquire` calls from that plugin succeed.
- [ ] `autonomous-dev cred-proxy allow` invoked by a non-admin is rejected with the same error.
- [ ] All three commands exit 1 with `daemon is not running` when the IPC socket is absent.

### Audit chain integrity

- [ ] After 1 issuance + 1 revocation, the audit log contains exactly 2 entries (`credential_issued` + `credential_revoked`) with the same `token_id`.
- [ ] The HMAC chain (PLAN-019-4) over the new entries verifies successfully.
- [ ] A failed authorization (caller not allowlisted) produces exactly 1 entry: `credential_denied`.

## Dependencies

- SPEC-024-2-01 (types, skeleton, allowlist, caller identity).
- SPEC-024-2-02 + SPEC-024-2-03 (scopers — the proxy invokes them but doesn't import their internals).
- PLAN-019-4 — `AuditWriter` interface and HMAC chain implementation.
- SPEC-019-1-04 — IPC server pattern for the new `cred-proxy.*` commands.
- PLAN-019-3 — admin-role check used by `revoke` and `allow` CLI commands.
- PLAN-018-2 — session spawner being modified (existing infrastructure).
- A native binding for SO_PEERCRED / LOCAL_PEERCRED on the chosen platform (Linux required, macOS best-effort).

## Notes

- **Why one large spec:** The five concerns (delivery, socket, TTL, audit, CLI) all manipulate the `ActiveTokenRegistry` and consult the `CredentialAuditEmitter`. Splitting them would force the registry interface to be partially defined in three or four specs, leading to drift. Keeping them together means engineers see the full state-management story in one place.
- **Audit emission cannot fail the credential flow:** if the audit writer throws, we still issue or revoke the credential — but we log the audit failure to stderr. The cloud's TTL is the truth-source for "is the credential valid"; the audit log is observability, not authorization. Rationale documented inline at the call sites.
- **3-retry revocation policy:** captured in the risk register of PLAN-024-2. After 3 failures the cloud's TTL (also 900s) is the safety net.
- **Socket peer credentials portability:** Linux's `SO_PEERCRED` (`{pid, uid, gid}`) and macOS's `LOCAL_PEERCRED` + `LOCAL_PEERPID` (separate calls) both produce the same logical pair. Native binding choice is at implementor discretion, but acceptance criteria pin the interface (`{pid, uid}`) so swapping packages later is safe.
- **`/tmp` socket location:** chosen because it is writable by all users and survives across daemon restarts only via the explicit `unlinkSync` on `start`. An alternative is `~/.autonomous-dev/cred.sock` (matching the IPC socket from SPEC-019-1-04). PLAN-024-2 specifies `/tmp` per TDD-024 §7.3 — keeping the documented path. Future hardening: move to abstract sockets (Linux only) to avoid filesystem race surface.
- **`process.umask` interaction:** the `umask(0o077) → listen → chmod 0o600 → restore umask` pattern is defense in depth; the explicit chmod handles platforms where the umask doesn't apply to `bind`. The race window is closed by the `umask` set BEFORE `listen`.
- **CLI admin-role check:** delegates to PLAN-019-3's existing trust validator. If that plan's primitives change, this spec inherits the change at no additional cost.
- **`ttl.ts` re-export:** the `TTL_SECONDS` const moves from `proxy.ts` (SPEC-024-2-01) into a dedicated `ttl.ts` module so `active-tokens.ts` can import it without circularity. The skeleton from SPEC-024-2-01 should be updated to re-export from `ttl.ts` for source-compat with already-written tests.
