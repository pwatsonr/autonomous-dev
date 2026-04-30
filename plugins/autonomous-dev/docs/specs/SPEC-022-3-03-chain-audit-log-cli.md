# SPEC-022-3-03: Chain Audit Log Writer, Executor Wiring, and `chains audit` CLI

## Metadata
- **Parent Plan**: PLAN-022-3
- **Tasks Covered**: Task 6 (chain audit log writer), Task 7 (wire audit-writer into chain executor), Task 8 (`chains audit verify` and `chains audit query` CLI)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-3-03-chain-audit-log-cli.md`

## Description
Ship the forensics layer for plugin chains: an HMAC-chained append-only log of every chain lifecycle event, the executor wiring that emits those events, and CLI subcommands for verification and queries. The log structure mirrors PLAN-019-4's hook audit log but writes to a separate file with its own HMAC chain so chain forensics and hook forensics can be analyzed independently. Each entry contains a timestamp, event type, chain ID, payload, the previous entry's HMAC, and its own HMAC over (prev_hmac || canonical_payload). The chain stays intact across process restarts because the writer always seeks to the last line of the file on init.

`autonomous-dev chains audit verify` walks the log start-to-finish and recomputes every HMAC; any mismatch is reported and the command exits non-zero. `chains audit query` filters by chain ID, plugin ID, since-timestamp, and event type, with JSON output for downstream tooling.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/chains/audit-writer.ts` | Create | HMAC-chained writer; serialized concurrent writes; rotation at 100MB |
| `plugins/autonomous-dev/src/chains/audit-events.ts` | Create | Event type enum + payload TypeScript types |
| `plugins/autonomous-dev/src/chains/executor.ts` | Modify | Emit audit entries at every lifecycle event |
| `plugins/autonomous-dev/src/cli/commands/chains-audit.ts` | Create | `verify` and `query` subcommands |
| `plugins/autonomous-dev/src/cli/index.ts` | Modify | Register `chains audit` subcommand group |
| `plugins/autonomous-dev/tests/chains/test-chain-audit.test.ts` | Create | HMAC chain integrity, concurrency, restart-resume tests |
| `plugins/autonomous-dev/tests/chains/test-executor-audit-emission.test.ts` | Create | Verifies executor emits the right entries per scenario |
| `plugins/autonomous-dev/tests/cli/test-chains-audit-cli.test.ts` | Create | CLI flag coverage |

## Implementation Details

### Log File Location

Default path: `~/.autonomous-dev/chains-audit.log`. Override via env var `CHAINS_AUDIT_LOG_PATH` (used by tests). Created with mode 0600 if absent.

### Entry Shape

One JSONL entry per line:

```json
{
  "ts": "2026-04-29T12:00:00.123Z",
  "type": "plugin_invoked",
  "chain_id": "CH-2026-04-29-abc123",
  "payload": { "plugin_id": "rule-set-enforcement", "step": 1 },
  "prev_hmac": "<base64 hmac of previous entry; empty string for first entry>",
  "hmac": "<base64 hmac-sha256 over canonicalJSON({ts,type,chain_id,payload,prev_hmac})>"
}
```

The HMAC key is the `CHAINS_AUDIT_HMAC_KEY` env var (separate from `CHAIN_HMAC_KEY` from SPEC-022-3-02; same resolution pattern as PLAN-019-4's `AUDIT_HMAC_KEY`: env → `~/.autonomous-dev/chains-audit-hmac.key` → first-run generation with CRITICAL warning).

### Event Types (`audit-events.ts`)

```typescript
export type ChainEventType =
  | 'chain_started'
  | 'plugin_invoked'
  | 'plugin_completed'
  | 'plugin_failed'
  | 'artifact_emitted'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_rejected'
  | 'chain_completed'
  | 'chain_failed';

export interface ChainEventPayloads {
  chain_started: { chain_id: string; chain_name: string; trigger: string; plugins: string[] };
  plugin_invoked: { chain_id: string; plugin_id: string; step: number; consumes: string[] };
  plugin_completed: { chain_id: string; plugin_id: string; step: number; duration_ms: number };
  plugin_failed: { chain_id: string; plugin_id: string; step: number; error_code: string; error_message: string };
  artifact_emitted: { chain_id: string; producer_plugin_id: string; artifact_type: string; artifact_id: string; signed: boolean };
  approval_requested: { chain_id: string; gate_id: string; requested_by: string; reason: string };
  approval_granted: { chain_id: string; gate_id: string; granted_by: string };
  approval_rejected: { chain_id: string; gate_id: string; rejected_by: string; reason: string };
  chain_completed: { chain_id: string; duration_ms: number; entries: number };
  chain_failed: { chain_id: string; duration_ms: number; failure_stage: string; error_code: string };
}
```

### Audit Writer (`audit-writer.ts`)

```typescript
export class ChainAuditWriter {
  private mutex = new Mutex();      // serializes writes
  private prevHmac: string = '';     // populated by initFromTail()
  private fd: number | null = null;

  async init(): Promise<void> {
    // Ensure file exists with mode 0600.
    // Read last line (efficient seek-from-end) and parse its hmac → prevHmac.
    // If file is empty/new, prevHmac = ''.
  }

  async append<T extends ChainEventType>(type: T, chainId: string, payload: ChainEventPayloads[T]): Promise<void> {
    return this.mutex.runExclusive(async () => {
      const ts = new Date().toISOString();
      const entry = { ts, type, chain_id: chainId, payload, prev_hmac: this.prevHmac };
      const hmac = createHmac('sha256', getChainsAuditHmacKey()).update(canonicalJSON(entry)).digest('base64');
      const final = { ...entry, hmac };
      await fs.appendFile(this.fd!, JSON.stringify(final) + '\n');
      this.prevHmac = hmac;
      await this.rotateIfNeeded();
    });
  }

  private async rotateIfNeeded(): Promise<void> {
    // If file size > 100MB, close, rename to .1, shift .1→.2, ..., .9→.10, drop .10.
    // Then reopen new empty file. Reset prevHmac = '' (each rotated file is its own chain).
  }
}
```

The mutex (e.g., `async-mutex` if already a dep, or a hand-rolled queue) is essential: two concurrent `append()` calls without serialization would race on `prevHmac` read-modify-write and break the chain.

Rotation cap: 100MB default; configurable via `chains.audit_log.max_size_mb` in `~/.autonomous-dev/config.json`.

### Executor Wiring (`executor.ts` modifications)

The chain executor (from PLAN-022-2) gains a `ChainAuditWriter` injection in its constructor. Emit entries at:

| Lifecycle moment | Event type |
|------------------|-----------|
| Before invoking the first plugin | `chain_started` |
| Before each plugin invocation | `plugin_invoked` |
| After successful plugin return | `plugin_completed` |
| After plugin throws/errors | `plugin_failed` |
| When `ArtifactRegistry.persist()` returns | `artifact_emitted` (executor calls writer; not the registry) |
| Before pausing for approval gate | `approval_requested` |
| When approval gate resolves with grant | `approval_granted` |
| When approval gate resolves with rejection | `approval_rejected` |
| At end of successful chain | `chain_completed` |
| At end of failed chain (any reason) | `chain_failed` |

A successful 3-plugin chain produces ≥10 entries: 1 chain_started + 3 plugin_invoked + 3 plugin_completed + 3 artifact_emitted + 1 chain_completed = 11.

Audit emission is best-effort: if `append()` throws, the executor logs an ERROR but continues the chain (audit failure does NOT abort execution; the operator's forensics may be incomplete but the workload completes). This is opposite to security failures, which DO abort.

### CLI: `chains audit verify`

```
autonomous-dev chains audit verify [--log-path <path>] [--json]
```

- Walks the log line by line.
- For each entry, recompute `hmac` over `canonicalJSON({ts, type, chain_id, payload, prev_hmac})` with the audit key.
- Verify the recomputed value matches `entry.hmac` byte-for-byte (`timingSafeEqual`).
- Verify each entry's `prev_hmac` matches the previous entry's `hmac`.
- On clean log: exit 0; print `OK: <N> entries verified`. With `--json`: `{"status":"ok","entries":N}`.
- On first mismatch: exit 1; print `FAIL: line <L> hmac mismatch (expected=<...> got=<...>)`. With `--json`: `{"status":"fail","line":L,"reason":"hmac_mismatch"}`.
- On parse error (malformed JSONL): exit 2; report line number.

### CLI: `chains audit query`

```
autonomous-dev chains audit query
  [--chain <chain_id>]
  [--plugin <plugin_id>]
  [--since <iso8601>]
  [--type <event_type>]
  [--log-path <path>]
  [--json]      # default: tab-separated; --json emits JSONL
```

- All filters AND together. Empty filter set returns all entries.
- `--plugin` matches against `payload.plugin_id`, `payload.producer_plugin_id`, OR `payload.requested_by` depending on event type. (One plugin, multiple roles.)
- `--since <iso8601>` is inclusive on the timestamp.
- Default output: one line per matching entry, tab-separated `ts | type | chain_id | summary`. `summary` is event-type-specific (e.g., for `plugin_invoked`: `plugin=<id> step=<n>`).
- `--json`: emit each matching entry as a JSON object on its own line (JSONL).
- Exit 0 on success even if 0 matches. Exit 2 on flag parse error or invalid `--since` format.

### CLI Registration (`cli/index.ts`)

Add the subcommand group under existing `autonomous-dev chains <...>` namespace from PLAN-022-1. Use the existing CLI framework (commander/yargs/whatever PLAN-022-1 chose); do NOT introduce a new dep.

## Acceptance Criteria

### Audit Writer (Task 6)

- [ ] `ChainAuditWriter.init()` creates the log file with mode 0600 if absent.
- [ ] `init()` correctly reads the last line of an existing file and sets `prevHmac` to its `hmac`.
- [ ] `init()` on an empty file sets `prevHmac = ''`.
- [ ] Each `append()` writes one JSON line ending in `\n`; line is parseable JSON containing all six required fields.
- [ ] Each entry's `hmac` is base64-encoded HMAC-SHA256 over canonical JSON of `{ts, type, chain_id, payload, prev_hmac}`.
- [ ] Each entry's `prev_hmac` equals the previous entry's `hmac` (for entries 2..N).
- [ ] First entry has `prev_hmac === ''`.
- [ ] 1000 sequential `append()` calls produce 1000 entries with intact HMAC chain (verified by independent chain walker).
- [ ] 100 concurrent `append()` calls (via `Promise.all`) produce 100 entries with intact HMAC chain — no race, no duplicate `prev_hmac`. (verifies mutex)
- [ ] Closing the writer and reopening (simulating daemon restart) resumes from the correct `prevHmac`; the next entry chains correctly.
- [ ] When file size exceeds 100MB, rotation occurs: file renamed to `.1`, new file created, `prevHmac` resets to `''`. Rotation respects `chains.audit_log.max_size_mb` config override.
- [ ] First-run with no `CHAINS_AUDIT_HMAC_KEY` env var generates a 32-byte key, writes to `~/.autonomous-dev/chains-audit-hmac.key` (mode 0600), and logs CRITICAL.

### Executor Wiring (Task 7)

- [ ] A successful 3-plugin chain produces exactly 11 entries: 1 `chain_started`, 3 `plugin_invoked`, 3 `plugin_completed`, 3 `artifact_emitted`, 1 `chain_completed`.
- [ ] A 3-plugin chain where plugin 2 fails produces: 1 `chain_started`, 2 `plugin_invoked`, 1 `plugin_completed` (for plugin 1), 1 `artifact_emitted` (for plugin 1), 1 `plugin_failed` (for plugin 2), 1 `chain_failed`. (Plugin 3 is never invoked.)
- [ ] An approval-gated chain produces `approval_requested` followed by either `approval_granted` or `approval_rejected`; if rejected, no further `plugin_invoked` entries follow.
- [ ] `artifact_emitted.signed` is `true` for privileged-chain artifacts and `false` otherwise.
- [ ] `plugin_completed.duration_ms` is positive and within 50% of the actual measured time (loose check, since timing is jittery).
- [ ] If the audit writer's `append()` throws, the executor logs ERROR and continues; the chain still completes.
- [ ] Each entry's `chain_id` matches the executing chain's ID across all events.

### CLI (Task 8)

- [ ] `chains audit verify` on a clean log exits 0 and prints `OK: <N> entries verified`.
- [ ] `chains audit verify --json` on clean log emits `{"status":"ok","entries":N}` to stdout.
- [ ] `chains audit verify` on a log where line 5 has a tampered `payload` (HMAC unchanged) exits 1 and reports `line 5 hmac mismatch`.
- [ ] `chains audit verify` on a log where line 7 has a broken `prev_hmac` chain link exits 1 and reports `line 7 prev_hmac mismatch`.
- [ ] `chains audit verify` on a log with malformed JSONL (line 3 is `{not json`) exits 2 and reports the line number.
- [ ] `chains audit query --chain CH-X` returns ONLY entries where `chain_id === 'CH-X'`.
- [ ] `chains audit query --plugin rule-set-enforcement` matches entries where `plugin_id`, `producer_plugin_id`, or `requested_by` equals the plugin id.
- [ ] `chains audit query --since 2026-04-29T00:00:00Z` returns entries with `ts >= since` (inclusive).
- [ ] `chains audit query --type plugin_failed --chain CH-X` returns ONLY plugin_failed entries for that chain (AND semantics).
- [ ] `chains audit query --json` emits JSONL (one JSON object per line).
- [ ] `chains audit query` with no matches exits 0 (not an error).
- [ ] `chains audit query --since not-a-date` exits 2 with a parse error message.
- [ ] Invocations route through the existing `autonomous-dev` CLI binary; help text appears under `autonomous-dev chains audit --help`.
- [ ] Coverage on `audit-writer.ts` ≥ 95%; on `chains-audit.ts` CLI ≥ 90%.

## Dependencies

- **Blocked by**: PLAN-022-1 (chain ID assignment, base executor structure), PLAN-022-2 (executor lifecycle, approval gate), SPEC-022-3-02 (artifact signing — audit emission needs to know `signed: boolean`).
- **Reuses**: PLAN-019-4 audit-writer pattern (separate file, own key, same HMAC chaining technique). Reuses `canonical-json.ts` from SPEC-022-3-02.
- **Library**: Node `crypto`, `fs/promises`. Mutex via `async-mutex` (verify if already dep; otherwise hand-roll).
- **CLI framework**: Whatever PLAN-022-1 standardized on; this spec MUST NOT introduce a new framework.

## Notes

- **Why a separate file from `audit.log`?** Cross-correlation between hook events and chain events is rare; isolation gives independent integrity guarantees. A wrapper `autonomous-dev audit query` (out of scope here) can later merge views.
- **Mutex matters.** The most common cause of audit-log corruption is concurrent writes from a multi-worker daemon. The mutex serializes appends. Tests MUST exercise concurrent paths to lock this in.
- **Restart safety.** `init()` reads from the END of the file (efficient: open + lseek SEEK_END − 4096 + scan back to last newline) so daemons restart in O(1) regardless of log size.
- **Rotation resets the chain.** Each rotated file (`chains-audit.log.1`, etc.) has its own HMAC chain starting from `prev_hmac = ''`. `chains audit verify` should be run against each file independently; a rotation-aware mode is out of scope for this spec.
- **Audit emission is fail-open.** A full disk shouldn't kill in-flight workloads — chains complete, audit gaps are logged. Operators monitoring the chain audit log will notice gaps via the `chain_completed.entries` count vs actual entries.
- **`signed` flag on `artifact_emitted` answers "was this from a privileged chain?"** This makes "show me all privileged-chain artifacts in the last 24h" a one-liner: `chains audit query --type artifact_emitted --since ... | jq 'select(.payload.signed)'`.
- **Privacy:** `payload` should not contain the artifact's actual content — only metadata (type, id, producer). The artifact itself lives in `ArtifactRegistry`'s storage, not the audit log.
- **Determinism in tests:** Inject `Clock` and `getChainsAuditHmacKey` via dep-injection (or environment overrides) so tests can produce reproducible entries.
