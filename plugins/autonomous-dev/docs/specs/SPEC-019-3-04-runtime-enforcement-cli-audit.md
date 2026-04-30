# SPEC-019-3-04: Runtime Trust Enforcement, Plugin Trust/Revoke CLI & Audit Log Integration

## Metadata
- **Parent Plan**: PLAN-019-3
- **Tasks Covered**: Task 8 (runtime enforcement), Task 9 (CLI subcommands), Task 10 (audit log integration)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-3-04-runtime-enforcement-cli-audit.md`

## Description
Close the trust loop by wiring three remaining pieces: (1) runtime trust enforcement in `HookExecutor` so revoked plugins are skipped on the next invocation without waiting for a SIGUSR1 reload, (2) `plugin trust` / `plugin revoke` CLI subcommands that mutate the allowlist atomically and trigger reload, and (3) audit log integration that writes one entry per trust decision (registered, rejected, runtime-revoked, meta-review verdict). Together these make the trust system operationally complete: an operator can grant trust, revoke it instantly, and inspect the full decision history.

The audit log writer is a thin wrapper around the existing audit infrastructure from TDD-007 / PLAN-007-X. PLAN-019-4 will own the canonical schema; this spec uses a placeholder schema that is forward-compatible (additive fields only, no field renames).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/executor.ts` | Modify | Add `trustValidator.isTrusted()` check before invocation |
| `plugins/autonomous-dev/src/hooks/trust-validator.ts` | Modify | Implement `isTrusted()` with audit emission; add audit calls to step methods |
| `plugins/autonomous-dev/src/hooks/audit-emitter.ts` | Create | `TrustAuditEmitter` thin wrapper over existing audit writer |
| `plugins/autonomous-dev/src/cli/commands/plugin-trust.ts` | Create | `plugin trust` and `plugin revoke` subcommands |
| `plugins/autonomous-dev/src/cli/index.ts` | Modify | Register the new subcommands |
| `plugins/autonomous-dev/src/config/atomic-write.ts` | Modify | Reuse for backup + atomic config mutation |
| `plugins/autonomous-dev/src/daemon/startup-checks.ts` | Modify | Refuse to start if `~/.claude/trusted-keys/` is world-writable |

## Implementation Details

### Runtime Trust Check in `HookExecutor`

```ts
// src/hooks/executor.ts (modify the invocation method)
async executeHook(plugin: RegisteredPlugin, hookPoint: string, ctx: HookContext): Promise<HookResult> {
  if (!this.trustValidator.isTrusted(plugin.id)) {
    this.auditEmitter.emit({
      decision: 'runtime-revoked',
      pluginId: plugin.id,
      pluginVersion: plugin.version,
      hookPoint,
      reason: 'trust revoked since last reload',
      timestamp: new Date().toISOString(),
    });
    return { skipped: true, reason: 'trust revoked' };
  }
  return this.invokeInSandbox(plugin, hookPoint, ctx);
}
```

This check is O(1) (set lookup) and fires before every hook invocation. It catches operator revocations between reloads.

### `isTrusted` with Audit Emission

```ts
// src/hooks/trust-validator.ts (replace stub from SPEC-019-3-01)
private trustedSet: Set<string> = new Set();

reloadTrustedSet(): void {
  this.trustedSet = new Set(this.config.allowlist);
}

isTrusted(pluginId: string): boolean {
  return this.trustedSet.has(pluginId);
}
```

`reloadTrustedSet()` is called by the SIGUSR1 reload handler (PLAN-019-1) after the new config is loaded. The constructor calls it once for initial state.

### Audit Emission in Step Methods

Each step that returns `{ trusted: false, ... }` MUST also emit a rejection audit entry. Each successful registration emits a `registered` entry. Each meta-review invocation emits a `meta-review-verdict` entry. Pattern:

```ts
private emitAudit(decision: AuditDecision, manifest: HookManifest, reason?: string, verdict?: { pass: boolean; findings: string[] }) {
  this.auditEmitter.emit({
    decision,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    reason,
    metaReviewVerdict: verdict,
    timestamp: new Date().toISOString(),
  });
}
```

Every code path through `validatePlugin` produces exactly one audit entry (rejection at first failed step, or `registered` at the end of step 7).

### `TrustAuditEmitter`

```ts
// src/hooks/audit-emitter.ts
export type AuditDecision = 'registered' | 'rejected' | 'runtime-revoked' | 'meta-review-verdict';

export interface TrustAuditEntry {
  decision: AuditDecision;
  pluginId: string;
  pluginVersion: string;
  hookPoint?: string;
  reason?: string;
  metaReviewVerdict?: { pass: boolean; findings: string[] };
  timestamp: string; // ISO 8601 UTC
}

export class TrustAuditEmitter {
  constructor(private readonly auditWriter: AuditWriter /* from PLAN-007-X */) {}
  emit(entry: TrustAuditEntry): void {
    this.auditWriter.append('trust', entry);
  }
}
```

The shape is the placeholder per PLAN-019-3 task 10; PLAN-019-4 will subsume it. Field names are additive-only — never renamed.

### CLI: `plugin trust` and `plugin revoke`

```bash
autonomous-dev plugin trust <plugin-id> [--privileged] [--json]
autonomous-dev plugin revoke <plugin-id> [--json]
```

Behavior:
- `plugin trust com.acme.foo` → adds `com.acme.foo` to `extensions.allowlist`.
- `plugin trust com.acme.foo --privileged` → adds to `allowlist` AND `privileged_reviewers`.
- `plugin revoke com.acme.foo` → removes from BOTH `allowlist` and `privileged_reviewers`.
- Both commands:
  1. Read current config.
  2. Write backup to `~/.claude/autonomous-dev.json.bak.<ISO-timestamp>` (mode 0o600).
  3. Mutate the in-memory config.
  4. Atomic write (temp file + rename) to `~/.claude/autonomous-dev.json`.
  5. Send SIGUSR1 to the running daemon (if PID file exists at `~/.autonomous-dev/daemon.pid`).
  6. Print human or JSON output (controlled by `--json`).

```ts
// src/cli/commands/plugin-trust.ts
export async function runPluginTrust(args: { id: string; privileged?: boolean; json?: boolean }) {
  const config = await loadConfig();
  if (!config.extensions.allowlist.includes(args.id)) config.extensions.allowlist.push(args.id);
  if (args.privileged && !config.extensions.privileged_reviewers.includes(args.id)) {
    config.extensions.privileged_reviewers.push(args.id);
  }
  await backupConfig();
  await atomicWriteConfig(config);
  await sendReloadSignal();
  return outputResult({ action: 'trust', id: args.id, privileged: !!args.privileged }, args.json);
}

export async function runPluginRevoke(args: { id: string; json?: boolean }) {
  const config = await loadConfig();
  config.extensions.allowlist = config.extensions.allowlist.filter(x => x !== args.id);
  config.extensions.privileged_reviewers = config.extensions.privileged_reviewers.filter(x => x !== args.id);
  await backupConfig();
  await atomicWriteConfig(config);
  await sendReloadSignal();
  return outputResult({ action: 'revoke', id: args.id }, args.json);
}
```

JSON output schema:
```json
{ "ok": true, "action": "trust", "id": "com.acme.foo", "privileged": false, "configBackup": "/Users/.../autonomous-dev.json.bak.2026-04-29T19:46:00Z", "reloadSignalSent": true }
```

### Daemon Startup Check

```ts
// src/daemon/startup-checks.ts (new check)
export async function assertTrustedKeysSafe(trustedKeysDir: string): Promise<void> {
  try {
    const stat = await fs.stat(trustedKeysDir);
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(
        `Refusing to start: ${trustedKeysDir} has unsafe permissions (${stat.mode.toString(8)}). ` +
        `Run: chmod 0700 ${trustedKeysDir} && chmod 0600 ${trustedKeysDir}/*.pub`
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // dir doesn't exist; signature verify will return false
    throw err;
  }
}
```

Called from the daemon main entry point before starting the hook engine.

## Acceptance Criteria

### Runtime Trust Enforcement
- [ ] Adding `com.acme.foo` to allowlist, restarting daemon, then `plugin revoke com.acme.foo` (which sends SIGUSR1) — the next hook invocation skips the plugin and emits a `runtime-revoked` audit entry.
- [ ] Mutating the in-memory config object (test helper) WITHOUT a SIGUSR1 reload also causes the next invocation to skip — proves the executor consults `isTrusted()` per call, not a cached registration flag.
- [ ] `isTrusted()` is O(1): a benchmark with 10,000 plugins shows <2µs per check.
- [ ] When `isTrusted()` returns false, the executor returns `{ skipped: true, reason: 'trust revoked' }` and does NOT invoke the sandbox.

### CLI Subcommands
- [ ] `autonomous-dev plugin trust com.acme.foo` adds the id to `allowlist` only. `privileged_reviewers` unchanged.
- [ ] `autonomous-dev plugin trust com.acme.foo --privileged` adds the id to BOTH `allowlist` and `privileged_reviewers`.
- [ ] `autonomous-dev plugin revoke com.acme.foo` removes the id from BOTH lists.
- [ ] Both commands create `~/.claude/autonomous-dev.json.bak.<ISO-timestamp>` before mutation; the backup matches the pre-mutation config byte-for-byte.
- [ ] Both commands send SIGUSR1 to the daemon process (verified via PID-file lookup + signal capture in test daemon stub).
- [ ] Both commands write atomically (temp file + rename); a kill -9 mid-mutation leaves either the original or the new file intact, never partial.
- [ ] `--json` output conforms to the schema above; absent `--json`, human-readable output includes the action, id, and backup path.
- [ ] Re-running `plugin trust` with an id already in the allowlist is a no-op (no duplicates), exits 0.
- [ ] Running `plugin revoke` with an id NOT in either list exits 0 (idempotent), no audit entry emitted.

### Audit Log Integration
- [ ] Every successful `validatePlugin` returning trusted emits exactly one `registered` audit entry.
- [ ] Every failed `validatePlugin` (any of the seven steps) emits exactly one `rejected` audit entry containing the step-specific reason string.
- [ ] Meta-review invocations emit a `meta-review-verdict` entry (PASS or FAIL) in addition to either `registered` or `rejected`.
- [ ] Runtime trust check failures emit `runtime-revoked` entries containing the hook point.
- [ ] All audit entries include `pluginId`, `pluginVersion`, `decision`, `timestamp` (ISO 8601 UTC).
- [ ] Test asserts entry shape against a placeholder JSON schema; PLAN-019-4 will replace the schema additively.

### Daemon Startup
- [ ] Daemon refuses to start if `~/.claude/trusted-keys/` exists with mode `0o777` (or any world/group write bit set); error message includes the suggested `chmod` command.
- [ ] Daemon starts normally if the directory does not exist OR has mode `0o700`.
- [ ] The check runs BEFORE any plugin discovery.

## Dependencies

- **SPEC-019-3-01, 02, 03** (blocking): provide the validator and step method shells; this spec wires up audit + runtime + CLI around them.
- **PLAN-019-1** (blocking): `HookExecutor`, SIGUSR1 reload handler, daemon PID file at `~/.autonomous-dev/daemon.pid`.
- TDD-007 / PLAN-007-X: existing audit log writer (`AuditWriter`).
- Existing CLI scaffolding (subcommand registration, JSON output helper).
- Atomic-write helper (already used by config upgrader in SPEC-019-3-01).

## Notes

- **Audit schema is placeholder**: PLAN-019-4 will subsume the entry shape. Field names here are additive-only (e.g. PLAN-019-4 may add `runId`, `correlationId` but will NOT rename `pluginId`). Use a shared TypeScript interface so the rename can be caught at compile time.
- **SIGUSR1 best-effort**: if the daemon PID file is missing or the process is gone, the CLI logs a warning and exits 0 — the config mutation succeeded; the daemon will pick up the new config on next start. This is documented in the CLI help text.
- **Backup naming**: ISO 8601 UTC timestamp (`2026-04-29T19:46:00Z`) means alphabetical sort = chronological sort. Operators can find the most recent backup with `ls -1 ~/.claude/autonomous-dev.json.bak.* | tail -1`.
- **Idempotency**: re-running `plugin trust` for an already-trusted id is a no-op (no duplicate, no audit entry, exit 0). This makes the command safe to run from automation/IaC.
- **Test daemon stub**: integration tests use a stub daemon that listens for SIGUSR1 and records the signal; it does not need a real engine. Real-daemon tests live in SPEC-019-3-05.
- **Permission check fail-loud**: the startup check refuses to start with a clear error message including the exact `chmod` command to fix it. This is the fail-loud counterpart to `SignatureVerifier`'s fail-quiet behavior (which is intentional for the read path).
- **Order of operations** in CLI: backup → mutate → atomic write → signal. Backup BEFORE mutation, signal AFTER atomic write — so a crash between any two steps leaves the file system in a consistent state.
