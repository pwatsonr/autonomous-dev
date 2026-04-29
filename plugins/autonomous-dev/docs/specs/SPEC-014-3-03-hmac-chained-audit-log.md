# SPEC-014-3-03: HMAC-Chained Audit Log for Portal Actions

## Metadata
- **Parent Plan**: PLAN-014-3
- **Tasks Covered**: TASK-006 (SecretRedactor), TASK-007 (AuditLogger), TASK-008 (KeyManager), TASK-009 (Audit Verify CLI)
- **Estimated effort**: 11 hours

## Description
Every state-changing portal action (auth, request submission/cancellation, configuration change, key rotation) MUST emit a tamper-evident audit entry. This spec implements the full audit pipeline: `SecretRedactor` masks secrets in entry payloads with a length-floor algorithm; `AuditLogger` writes append-only NDJSON entries to a 0600-mode file; each entry's `entry_hmac` is `HMAC-SHA256(key, prev_hmac || canonical_entry_json)`, forming a Merkle-style chain; `KeyManager` stores 32-byte keys at `${CLAUDE_PLUGIN_DATA}/.audit-keys` (0600) with 90-day automatic rotation and indefinite retention of historical keys for verification; the `audit verify` CLI subcommand walks the chain end-to-end and reports tampering, sequence gaps, and key-rotation boundaries. The chain is the integrity contract — any modification to any entry invalidates every downstream HMAC.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/security/secret-redactor.ts` | Create | Length-floor redaction |
| `src/security/audit-logger.ts` | Create | AuditLogger class + entry shape |
| `src/security/hmac-chain.ts` | Create | Pure HMAC computation, no I/O |
| `src/security/key-manager.ts` | Create | KeyManager with rotation |
| `src/security/keystore-adapter.ts` | Create | Filesystem keystore (platform keystore deferred) |
| `src/cli/audit-verify.ts` | Create | `audit verify` CLI subcommand |
| `src/cli/commands.ts` | Modify | Register `audit verify` subcommand |
| `bin/autonomous-dev.sh` | Modify | Route `audit` to CLI dispatcher |

## Implementation Details

### Task 1: `SecretRedactor` Class

```
class SecretRedactor {
  redact(secret: string): string
  redactInText(text: string, knownSecrets: string[]): string
}
```

- Constants: `MIN_SECRET_LENGTH = 8`, `MARKER = "••••"` (four U+2022 bullets, 4 chars).
- `redact(s)`:
  - If `typeof s !== 'string'` → throw `SecurityError("Invalid secret type")`.
  - If `Array.from(s).length < MIN_SECRET_LENGTH` (Unicode code-point count, NOT `s.length`) → throw `SecurityError("Secret too short: <N> code points (minimum: 8)")`. **Use `Array.from` to handle surrogate pairs correctly.**
  - If code-point count is 8–11 → return `MARKER + last 2 code points`.
  - If code-point count ≥ 12 → return `MARKER + last 4 code points`.
- `redactInText(text, secrets)`: for each `secret` of length ≥ 8, replace all literal occurrences in `text` with the redacted form. Use `String.prototype.replaceAll` with the literal string (no regex, no escaping concerns).
- The `extractPotentialSecrets` heuristic from the plan is **NOT** included — heuristic extraction has too many false positives (UUIDs, hashes, base64 blobs that aren't secrets). Callers MUST pass the list of known secrets explicitly.

### Task 2: `hmac-chain.ts` (Pure Functions)

```
canonicalEntryJson(entry: Omit<AuditEntry, 'entry_hmac'>): string
computeEntryHmac(key: Buffer, prevHmac: string, entry: Omit<AuditEntry, 'entry_hmac'>): string
```

- `canonicalEntryJson`: produces a deterministic JSON representation. Keys are emitted in fixed order: `timestamp, sequence, action, user, resource, details, previous_hmac`. Use `JSON.stringify(obj, fixedKeyOrder)`. Number serialization is JS-default (no NaN/Infinity allowed — caller validates).
- `computeEntryHmac(key, prevHmac, entry)`:
  - `data = prevHmac + canonicalEntryJson(entry)` (UTF-8 string concatenation).
  - Returns `crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex')`.
- These two functions have ZERO I/O and ZERO state. They are the verification primitive.

### Task 3: `AuditLogger` Class

```
interface AuditEntry {
  timestamp: string         // ISO-8601 UTC, millisecond precision
  sequence: number          // monotonically increasing, starts at 1
  action: string            // event type, e.g. "request.submit"
  user: string              // operator identity
  resource: string          // affected resource, e.g. "REQ-000123"
  details: object           // arbitrary, secrets pre-redacted
  previous_hmac: string     // hex string, "" for sequence=1
  key_id: string            // KeyManager key ID active at write time
  entry_hmac: string        // hex string of HMAC-SHA256
}

class AuditLogger {
  constructor(logPath: string, keyManager: KeyManager, redactor: SecretRedactor)
  initialize(): Promise<void>
  log(payload: {action, user, resource, details, secrets?: string[]}): Promise<void>
}
```

- `initialize()`:
  - If `logPath` does not exist: create it with mode `0o600`, set `sequence = 0`, `lastHmac = ""`. Then call `log({action: "audit_log_initialized", user: "system", resource: logPath, details: {version: "1.0"}})`.
  - If it exists: stream-read the last newline-terminated line, parse JSON, set `sequence = parsed.sequence` and `lastHmac = parsed.entry_hmac`. On parse failure throw `SecurityError("Audit log corrupted - cannot parse last entry")`.
- `log({action, user, resource, details, secrets})`:
  1. `this.sequence += 1`.
  2. Redact: if `secrets` is provided, run `details = redactInText(JSON.stringify(details), secrets)` then `JSON.parse` it back. Also redact known field names (`password, token, api_key, secret, credential`) by walking the object and replacing values via `redactor.redact` (catching `SecurityError` for short values and replacing with `MARKER` only).
  3. Build the entry with `timestamp = new Date().toISOString()`, `key_id = keyManager.getCurrentKeyId()`, `previous_hmac = this.lastHmac`.
  4. `entry.entry_hmac = computeEntryHmac(keyManager.getCurrentKey(), this.lastHmac, entry)`.
  5. Serialize as `JSON.stringify(entry) + "\n"`.
  6. `await fs.appendFile(logPath, line, { flag: 'a', mode: 0o600 })`. Note: `appendFile` with `flag: 'a'` opens with `O_APPEND|O_WRONLY|O_CREAT` per Node docs.
  7. `this.lastHmac = entry.entry_hmac`.
- The logger is single-process; concurrent writers from separate processes would corrupt the chain. Document this in JSDoc; a multi-process locking story is out of scope.

### Task 4: `KeyManager` Class

```
class KeyManager {
  constructor(keyStorePath: string)         // default ${CLAUDE_PLUGIN_DATA}/.audit-keys
  initialize(): Promise<void>
  getCurrentKey(): Buffer
  getCurrentKeyId(): string
  getKey(keyId: string): Buffer              // for verification
  rotateKey(): Promise<string>
}
```

- Key size: 32 bytes from `crypto.randomBytes(32)`. Rotation period: 90 days.
- Storage format: a single JSON file with shape `{ version: "1.0", active_key_id: "...", keys: [{id, key_hex, created_at, expires_at, active}] }`. File mode `0o600` enforced via `fs.chmod` after write.
- `initialize()`:
  - If file missing: create initial key, mark active, save, return.
  - If present: load, verify exactly one `active: true` entry, set `activeKeyId`. If `now() - active.created_at > 90 days`, call `rotateKey()` automatically.
- `rotateKey()`:
  - Mark current key `active = false` (retain in keys[] for verification of historical entries).
  - Generate new 32-byte key, compute `keyId = "audit-" + base36(timestamp) + "-" + hex(randomBytes(4))`.
  - Append to `keys[]`, set as active, save.
  - Returns the new key ID.
- **Encryption-at-rest**: the plan's `aes-256-gcm` envelope is **DEFERRED** — it depended on `createCipher` (deprecated/insecure) and a key derived from `process.env.CLAUDE_PLUGIN_DATA`, which is a plaintext path, not a secret. Storage in this spec is plaintext JSON at 0600 mode; document explicitly that the file inherits OS-level filesystem confidentiality. Real platform-keystore integration (Keychain, Secret Service) is a separate plan.
- **Old keys are retained indefinitely**. Verification of multi-year audit logs requires every key that was ever active. Cleanup is manual.

### Task 5: `audit verify` CLI Subcommand

```
class AuditVerifier {
  constructor(keyManager: KeyManager)
  verifyLog(logPath: string): Promise<VerificationResult>
}

interface VerificationResult {
  totalEntries: number
  validEntries: number
  invalidEntries: Array<{line, sequence, error, expected?, actual?}>
  sequenceGaps: Array<{line, expected, actual}>
  keyRotations: Array<{line, sequence, newKeyId}>
  verified: boolean
}
```

- The CLI entry point lives in `src/cli/audit-verify.ts`. It parses one positional argument (log path), calls `verifyLog`, prints a summary report (no emojis, plain text), and exits 0 on `verified: true` or 1 otherwise.
- Bash dispatch: `bin/autonomous-dev.sh` adds an `audit` case that delegates to `cmd_audit_delegate` which routes `verify` to `node dist/cli/audit-verify.js "$@"`. Subcommand validation follows the SPEC-011-1-01 pattern (allowlist `{verify}`, error on unknown).
- `verifyLog(logPath)`:
  1. Open the log read-only, stream line-by-line.
  2. For each line: parse JSON. On parse failure record an `invalidEntries` row and continue.
  3. Check `entry.sequence === expectedSequence`. On mismatch record `sequenceGaps` and update `expectedSequence` to `entry.sequence + 1` to continue verification.
  4. Look up the key for `entry.key_id` via `keyManager.getKey(...)`. If missing, record `invalidEntries` row with `error: "key_not_found"`.
  5. Recompute HMAC: `computeEntryHmac(key, prevHmac, entryWithoutHmac)`. Compare to `entry.entry_hmac`. Record mismatch.
  6. If `entry.action === "key_rotation"`: append to `keyRotations`.
  7. Update `prevHmac = entry.entry_hmac`, `expectedSequence = entry.sequence + 1`.
- Performance target: stream-process 100K entries in < 5 seconds on a modern laptop. No buffering of the full log into memory.

## Acceptance Criteria

- [ ] `redactor.redact("hi")` throws `SecurityError("Secret too short")`
- [ ] `redactor.redact("password")` returns `"••••rd"` (8 chars → last 2)
- [ ] `redactor.redact("supersecretpw1")` returns `"••••tpw1"` (≥12 chars → last 4)
- [ ] `redactor.redact("café1234")` (7 code points × multibyte) is treated as 7-code-point input → throws (verifies Unicode-aware counting)
- [ ] `auditLogger.log({...})` produces a line that ends with `\n` and parses as valid JSON
- [ ] After 100 sequential `log()` calls, the HMAC chain verifies clean: `verifier.verifyLog()` returns `verified: true, validEntries: 100`
- [ ] Tampering: modifying any single character in any entry's `details` field causes `verifier.verifyLog()` to return `verified: false` with that line in `invalidEntries`
- [ ] Sequence gap: deleting one line from the middle of a log produces exactly one entry in `sequenceGaps` with the missing number
- [ ] Key rotation: after `keyManager.rotateKey()` mid-log, both pre-rotation and post-rotation entries verify correctly via `entry.key_id` lookup
- [ ] Audit log file permissions are exactly `0600` after creation and after every append (verified via `fs.stat().mode & 0o777`)
- [ ] Keystore file permissions are exactly `0600`
- [ ] `bin/autonomous-dev.sh audit verify <path>` exits 0 on a clean log, exit 1 on tampered log
- [ ] `bin/autonomous-dev.sh audit foo` exits 1 with `"ERROR: Unknown audit subcommand: foo"` on stderr
- [ ] Verification of a 100K-entry log completes in ≤ 5000ms (perf test)
- [ ] All new TS files pass `npm run lint:security`
- [ ] `npm test -- --testPathPattern='(secret-redactor|audit-logger|hmac-chain|key-manager|audit-verify)'` passes

## Dependencies

- Node.js `crypto`, `fs/promises`, `readline` (for streaming).
- `${CLAUDE_PLUGIN_DATA}` environment variable resolves at runtime; default `$HOME/.claude/autonomous-dev/data` if unset.
- SPEC-011-1-01 patterns for bash subcommand routing (allowlist + error format).
- Consumed by SPEC-014-3-04 adversarial tests (tampering, gap detection, rotation crossings).

## Notes

- **Why HMAC-SHA256 and not signatures**: Audit log integrity needs detection of tampering by anyone without the key. HMAC achieves that with one key per logger instance. Public-key signatures would also work but require key infrastructure (CA, distribution) beyond the scope of an embedded portal.
- **Why `previous_hmac` AND `entry_hmac`**: Storing `previous_hmac` in the entry makes the chain self-describing — verification doesn't need any external state. Removing this field would force the verifier to track HMAC across lines, which is fine for sequential reads but breaks parallel verification optimizations.
- **Canonical JSON ordering**: The `canonicalEntryJson` function fixes the key order. Without this, `JSON.stringify` could produce different bytes on different Node versions or after field reordering, breaking HMAC reproducibility. This is the same property that makes JWS payloads deterministic.
- **What the chain does NOT protect against**: An attacker with the audit key (e.g. root on the box) can rewrite the entire log with valid HMACs. This is a fundamental limitation of single-key chains. Mitigations (offsite write-once shipping, hardware security modules) are out of scope.
- **Secret redaction is best-effort**: The redactor only masks values the caller passes in `secrets[]` plus a small set of known field names. Engineers MUST audit `details` payloads at every `log()` call site. A future plan introduces compile-time redaction macros.
- **No key encryption-at-rest in this spec**: See KeyManager note. The 0600 file mode is the only confidentiality mechanism; document this clearly in the keystore-adapter JSDoc.
