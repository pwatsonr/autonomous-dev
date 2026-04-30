# SPEC-019-4-04: Audit Log Writer (HMAC-Chained) + Wire Events + Audit Verify CLI + Audit Query CLI

## Metadata
- **Parent Plan**: PLAN-019-4
- **Tasks Covered**: Task 7 (audit log writer), Task 8 (wire writer into all events), Task 9 (`audit verify` CLI), Task 10 (`audit query` CLI)
- **Estimated effort**: 11 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-4-04-audit-log-writer-and-cli.md`

## Description
Deliver the durable, tamper-evident audit surface that captures every plugin lifecycle event, every hook invocation outcome, every reviewer verdict, and every trust decision. The core is a single-fd append-only writer with HMAC chaining: each line embeds the previous line's HMAC so any modification anywhere in the file is detectable end-to-end. A serialization mutex guarantees that concurrent writers (the daemon's many promises) cannot interleave bytes. Two CLI subcommands round it out: `audit verify` walks the chain and reports tampering; `audit query` filters by plugin/since/type for operator forensics. All emitters from PLAN-019-3 (trust validator) and SPEC-019-4-03 (executor) are wired through this writer.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/audit/audit-writer.ts` | Create | `AuditWriter` class: open, append, mutex, HMAC chain, key bootstrap |
| `plugins/autonomous-dev/src/audit/audit-types.ts` | Create | `AuditEntry`, `AuditEventType`, `AuditPayload` discriminated union |
| `plugins/autonomous-dev/src/audit/key-store.ts` | Create | Resolve `AUDIT_HMAC_KEY` from env or `~/.autonomous-dev/audit-key`; bootstrap if missing |
| `plugins/autonomous-dev/src/audit/rotation.ts` | Create | Size-cap rotation (100MB default); gzip rotated files |
| `plugins/autonomous-dev/src/audit/verify.ts` | Create | Pure function `verifyAuditLog(path, key) => VerifyResult`; reused by CLI and tests |
| `plugins/autonomous-dev/src/cli/commands/audit-verify.ts` | Create | CLI wrapper around `verifyAuditLog` |
| `plugins/autonomous-dev/src/cli/commands/audit-query.ts` | Create | CLI streaming reader with filters |
| `plugins/autonomous-dev/src/cli/index.ts` | Modify | Register `audit verify` and `audit query` subcommands |
| `plugins/autonomous-dev/src/hooks/executor.ts` | Modify | Emit `hook_invoked` audit entry on each result; emit `hook_blocked` on block failure |
| `plugins/autonomous-dev/src/hooks/trust-validator.ts` | Modify | Emit `plugin_registered`, `plugin_rejected`, `plugin_revoked`, `trust_decision` audit entries |
| `plugins/autonomous-dev/src/reviewers/aggregate.ts` | Modify | Emit `reviewer_verdict` and `reviewer_fallback` audit entries |
| `plugins/autonomous-dev/.claude-plugin/plugin.json` | Modify | Add `extensions.audit_log.max_size_mb` userConfig (default 100); `extensions.audit_log.max_rotations` (default 10) |

## Implementation Details

### Audit Entry Shape (`src/audit/audit-types.ts`)

```ts
export type AuditEventType =
  | 'plugin_registered'
  | 'plugin_rejected'
  | 'plugin_revoked'
  | 'trust_decision'
  | 'hook_invoked'
  | 'hook_blocked'
  | 'reviewer_verdict'
  | 'reviewer_fallback'
  | 'audit_key_rotated';

export interface AuditEntryCommon {
  /** ISO-8601 UTC timestamp with millisecond precision. */
  ts: string;
  type: AuditEventType;
  /** Payload schema depends on `type`; concrete shapes per emitter. */
  payload: Record<string, unknown>;
  /** Plugin identity; `built-in` for first-party events. */
  plugin_id: string;
  plugin_version: string;
  /** HMAC of the previous entry; literal `GENESIS` for the first line. */
  prev_hmac: string;
  /** HMAC of (prev_hmac + canonicalize(payload-with-ts-and-type-and-plugin)). */
  hmac: string;
}
```

The `hmac` field signs **everything that uniquely identifies this entry**, namely the canonical JSON of `{ts, type, plugin_id, plugin_version, payload}` concatenated after `prev_hmac`. The `prev_hmac` field itself is part of the signed input via concatenation, not via inclusion in the canonicalized object — this is the chaining mechanism.

### Writer (`src/audit/audit-writer.ts`)

```ts
export class AuditWriter {
  private fd: number | null = null;
  private mutex: Promise<void> = Promise.resolve();
  private lastHmac: string = 'GENESIS';
  private readonly key: Buffer;

  static async open(opts: {logPath: string; key: Buffer}): Promise<AuditWriter> {
    // 1. Open logPath with flags: O_WRONLY | O_APPEND | O_CREAT, mode 0600.
    // 2. If file is non-empty, read the LAST line, parse JSON, set lastHmac to its hmac.
    //    (Use fs.read backwards from EOF to find the last \n.)
    // 3. Return constructed writer.
  }

  async append(entry: Omit<AuditEntryCommon, 'prev_hmac' | 'hmac'>): Promise<AuditEntryCommon> {
    // Serialize via this.mutex chain so concurrent appends do not interleave.
    return (this.mutex = this.mutex.then(async () => {
      const prev_hmac = this.lastHmac;
      const signedBody = canonicalize({
        ts: entry.ts, type: entry.type,
        plugin_id: entry.plugin_id, plugin_version: entry.plugin_version,
        payload: entry.payload,
      });
      const hmac = createHmac('sha256', this.key)
        .update(prev_hmac).update(signedBody).digest('hex');
      const full: AuditEntryCommon = { ...entry, prev_hmac, hmac };
      const line = JSON.stringify(full) + '\n';
      await fs.write(this.fd!, Buffer.from(line, 'utf8'));
      this.lastHmac = hmac;
      return full;
    }) as unknown as Promise<AuditEntryCommon>);
  }

  async close(): Promise<void> {
    await this.mutex;
    if (this.fd !== null) await fs.close(this.fd);
    this.fd = null;
  }
}
```

Key invariants:
- The fd is opened with `O_APPEND` so even if the process crashes mid-append, no other writer can interleave bytes.
- The mutex (`this.mutex = this.mutex.then(...)`) is a JS-level chain, sufficient because Node is single-threaded for JS execution. (Cross-process safety is out of scope; single daemon per host.)
- `lastHmac` is recovered from the last existing line on open so a daemon restart continues the chain seamlessly.
- `O_APPEND` semantics on POSIX guarantee single-write atomicity up to `PIPE_BUF` (4096 bytes on Linux/macOS); audit entries must stay under this cap. Enforce by truncating `payload` if `JSON.stringify(full).length > 3800` and setting `payload._truncated: true` (with the original-size recorded). Tests assert no entry exceeds 4096 bytes.

### Key Bootstrap (`src/audit/key-store.ts`)

```ts
export async function resolveAuditKey(): Promise<{key: Buffer; rotated: boolean}> {
  if (process.env.AUDIT_HMAC_KEY) {
    return {key: Buffer.from(process.env.AUDIT_HMAC_KEY, 'hex'), rotated: false};
  }
  const path = `${homedir()}/.autonomous-dev/audit-key`;
  try {
    const hex = await fs.readFile(path, 'utf8');
    return {key: Buffer.from(hex.trim(), 'hex'), rotated: false};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // First run OR operator deleted the key → generate new + warn.
    const key = randomBytes(32);
    await fs.mkdir(dirname(path), {recursive: true});
    await fs.writeFile(path, key.toString('hex'), {mode: 0o600});
    return {key, rotated: true};
  }
}
```

If `rotated: true`, the daemon's first action is to write an `audit_key_rotated` entry with `prev_hmac: GENESIS` (chain restart) and a CRITICAL log line.

### Rotation (`src/audit/rotation.ts`)

On each `append`, after writing, check `fstat(fd).size`. If size >= `max_size_mb * 1024 * 1024`:
1. Acquire the mutex.
2. Close the fd.
3. Shift `audit.log.{N-1}` → `audit.log.{N}` for N from `max_rotations` down to 1; if `audit.log.{max_rotations}` exists, gzip it to `audit.log.{max_rotations}.gz` (and delete the older `.gz` if at cap).
4. Rename `audit.log` → `audit.log.1`.
5. Reopen `audit.log`. Reset `lastHmac` from the just-rotated `audit.log.1`'s last line so the new file's first entry chains correctly.
6. Release the mutex.

Defaults: `max_size_mb = 100`, `max_rotations = 10` (1GB total cap). Configurable per the manifest userConfig keys.

### Verify Function (`src/audit/verify.ts`)

```ts
export interface VerifyResult {
  intact: boolean;
  total: number;
  tamperedAt: number[];        // 1-based line numbers
  brokenChainAt: number[];     // lines whose prev_hmac does not match prior line's hmac
}

export async function verifyAuditLog(path: string, key: Buffer): Promise<VerifyResult> {
  // Streamed line-by-line read; never load full log into memory.
  // For each line:
  //   - Parse JSON; if parse fails → tamperedAt.push(line).
  //   - Recompute hmac from {ts, type, plugin_id, plugin_version, payload} + prev_hmac.
  //     If recomputed !== entry.hmac → tamperedAt.push(line).
  //   - Compare entry.prev_hmac to expectedPrev (last entry's hmac, or GENESIS for first).
  //     Mismatch → brokenChainAt.push(line).
  //   - Update expectedPrev to entry.hmac (even if tampered, so we can detect contiguous breaks).
  // Return {intact: tamperedAt.length === 0 && brokenChainAt.length === 0, ...}.
}
```

`audit_key_rotated` entries are special: their `prev_hmac` is permitted to be `GENESIS` even mid-log. The verifier flags such entries with `brokenChainAt.push(line)` only if the entry type is NOT `audit_key_rotated`.

### CLI: `audit verify` (`src/cli/commands/audit-verify.ts`)

Usage: `autonomous-dev audit verify [--json] [--log <path>]`

- Resolves log path from `--log` or default `~/.autonomous-dev/audit.log`.
- Resolves key via `resolveAuditKey()`.
- Calls `verifyAuditLog`.
- Human output: `Verified N entries; chain intact` OR `Tampered entries at lines: K1, K2, ...; broken-chain at lines: L1, ...`.
- JSON output: `{"intact": bool, "total": N, "tamperedAt": [...], "brokenChainAt": [...]}`.
- Exit code: 0 if `intact: true`, 1 otherwise.

### CLI: `audit query` (`src/cli/commands/audit-query.ts`)

Usage: `autonomous-dev audit query [--plugin <id>] [--since <iso8601>] [--type <event-type>] [--limit <n>] [--json] [--log <path>]`

- Streamed read; filters apply with AND semantics.
- `--limit n` returns the n most-recent matching entries (must read whole log to know recency; documented).
- Default human output: tabular `ts | type | plugin | summary` (summary = first 60 chars of `JSON.stringify(payload)`).
- `--json` output: JSONL of full entries.
- Exit 0 always (queries are read-only); errors (bad path, bad date) exit 2.

### Wiring Audit Emitters

| Emitter | File | Event Type | Trigger |
|---------|------|------------|---------|
| Trust validator accepts plugin | `trust-validator.ts` | `plugin_registered` | After successful trust check on `register()` |
| Trust validator rejects plugin | `trust-validator.ts` | `plugin_rejected` | When a plugin fails any trust check at registration |
| Runtime trust check revokes plugin | `trust-validator.ts` | `plugin_revoked` | When PLAN-019-3's runtime check forces revocation |
| Trust scoring decision | `trust-validator.ts` | `trust_decision` | Each per-plugin trust score computation; payload includes score + factors |
| Hook success or non-block failure | `executor.ts` | `hook_invoked` | After every `HookResult` is appended to `results` (one entry per result) |
| Hook block failure | `executor.ts` | `hook_blocked` | Just before `HookBlockedError` is thrown |
| Reviewer verdict captured | `reviewers/aggregate.ts` | `reviewer_verdict` | After each `Verdict` (with fingerprint) is finalized |
| Multi-reviewer fallback triggered | `reviewers/aggregate.ts` | `reviewer_fallback` | When `usedFallback === true`; one entry per gate per invocation |

All emitters share one `AuditWriter` singleton owned by the daemon; per-callsite injection is via constructor or a getter that returns the shared instance.

## Acceptance Criteria

- [ ] `AuditWriter.open()` creates `~/.autonomous-dev/audit.log` with mode 0600 if absent; reuses existing file otherwise.
- [ ] On reopen of a non-empty log, `lastHmac` matches the last existing entry's `hmac`.
- [ ] `append()` produces a line of canonical JSON with non-empty `hmac` and the prior entry's `hmac` as `prev_hmac`.
- [ ] First entry in a fresh log has `prev_hmac: "GENESIS"`.
- [ ] Concurrent `append()` calls from `Promise.all([...100 promises])` produce exactly 100 lines, all chained correctly (no missing lines, no interleaved bytes).
- [ ] Each line is ≤ 4096 bytes; oversized payloads are truncated with `payload._truncated: true` and `payload._original_size` recorded.
- [ ] If `AUDIT_HMAC_KEY` env var is set, it overrides the file-stored key; otherwise, the file at `~/.autonomous-dev/audit-key` is used.
- [ ] If neither env nor file exists, a 32-byte random key is generated, written to `~/.autonomous-dev/audit-key` with mode 0600, and `audit_key_rotated` is the first audit entry written.
- [ ] Rotation: when `audit.log` reaches `max_size_mb`, it is renamed to `audit.log.1` (existing `.1` shifts to `.2`, etc.); the oldest rotation beyond `max_rotations` is gzipped or deleted per policy.
- [ ] `verifyAuditLog` on a clean log returns `{intact: true, total: N, tamperedAt: [], brokenChainAt: []}`.
- [ ] Modifying a single byte in any entry's `payload` causes `verifyAuditLog` to report that entry's line in `tamperedAt`; subsequent entries appear in `brokenChainAt` because `prev_hmac` no longer matches.
- [ ] `audit verify` exits 0 on intact log, 1 on any tampering, and human output matches the documented format.
- [ ] `audit verify --json` emits `{intact, total, tamperedAt, brokenChainAt}` as a single JSON object.
- [ ] `audit query --plugin com.acme.foo --limit 10` returns the 10 most-recent entries for that plugin in tabular form.
- [ ] `audit query --since 2026-04-01T00:00:00Z --type hook_invoked` filters by both criteria (AND semantics).
- [ ] `audit query --json` emits JSONL.
- [ ] After registering one plugin, invoking one hook successfully, and revoking the plugin, the audit log contains at least 3 entries: `plugin_registered`, `hook_invoked`, `plugin_revoked`. The chain is intact.
- [ ] A `block`-mode failure causes both `hook_invoked` (with error payload) AND `hook_blocked` to be written before the executor throws.
- [ ] Multi-reviewer fallback emits one `reviewer_fallback` entry plus one `reviewer_verdict` per built-in reviewer used.
- [ ] `audit_key_rotated` entries are NOT flagged as broken-chain by `verifyAuditLog` even though their `prev_hmac` is `GENESIS` mid-log.
- [ ] Manifest userConfig keys `extensions.audit_log.max_size_mb` (default 100) and `extensions.audit_log.max_rotations` (default 10) are present and validated.

## Dependencies

- **Blocked by**: SPEC-019-4-01 (`Verdict` for `reviewer_verdict` payloads), SPEC-019-4-02 (`Verdict.fingerprint` populated), SPEC-019-4-03 (`HookResult`, `HookBlockedError` for executor wiring), PLAN-019-3 (trust validator surfaces).
- **Consumed by**: SPEC-019-4-05 (unit + integration tests), any future PRD-009 approval-gate work, future kill-switch event recording.
- **External**: Node `fs`, `crypto`, `zlib` standard libs only — no new third-party deps.

## Notes

- HMAC over `prev_hmac + canonical_json` (rather than including `prev_hmac` inside the canonicalized object) means we sign `prev_hmac` exactly once per entry; this avoids ambiguity from JSON canonicalization treating it as a regular field. Each verification step recomputes by the same recipe.
- `O_APPEND` is the linchpin: even multi-process appenders cannot interleave bytes within a single `write(2)` call up to `PIPE_BUF`. We additionally serialize at the JS level via the mutex for ordering guarantees (chain integrity requires reads of `lastHmac` and writes to be atomic from the JS perspective).
- Truncation is hostile to forensics but necessary to honor the atomicity guarantee. The truncation marker (`_truncated`) makes it auditable.
- Rotation deliberately gzips the OLDEST rotation rather than every rotation so that recent rotations remain `tail`-able. Tradeoff documented in operator guide (PLAN-019-4 §risks).
- `audit_key_rotated` is the only special case in chain verification; all other entries must chain. This intentional break is the price of allowing key recovery without losing the ability to verify post-rotation.
- The CLI commands are read-only; they never call `AuditWriter.open()` (which is write-mode). They use `verifyAuditLog` and a streaming reader instead. Operators can safely run `audit verify` while the daemon is active.
- `audit query --limit n` requires reading the whole log to determine recency; for very large logs (10M+ entries) this is O(n). Documented in operator guide. A future optimization could maintain a per-day index, out of scope here.
- We do not auto-delete the gzipped oldest rotation; we just stop creating new ones beyond `max_rotations`. Operators control retention via cron or manual cleanup. This is intentional: silent deletion would itself be a forensic gap.
- Per TDD §14, every emitter is required to include `plugin_id` and `plugin_version`. For first-party events, `plugin_id = 'built-in'` and `plugin_version` = the autonomous-dev plugin version string.
