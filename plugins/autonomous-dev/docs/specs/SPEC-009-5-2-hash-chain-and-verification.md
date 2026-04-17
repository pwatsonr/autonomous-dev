# SPEC-009-5-2: Hash Chain Computation and Verification

## Metadata
- **Parent Plan**: PLAN-009-5
- **Tasks Covered**: Task 3 (Implement Hash Chain Computer), Task 4 (Implement Hash Chain Verifier)
- **Estimated effort**: 8 hours

## Description

Implement the SHA-256 hash chain computation algorithm for audit event integrity and the verifier that validates the entire event log for tamper evidence. The hash chain provides cryptographic proof that the event log has not been modified after the fact -- events cannot be inserted, deleted, reordered, or altered without breaking the chain. Phase 1/2 runs with hash chain disabled (empty strings); Phase 3 enables it via config flag.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/audit/hash-chain.ts` | Create | SHA-256 hash chain computation |
| `src/audit/hash-verifier.ts` | Create | Full log integrity verification |

## Implementation Details

### hash-chain.ts

```typescript
export class HashChainComputer {
  constructor(private enabled: boolean) {}

  // Compute hash for an event, chaining to the previous hash
  computeHash(
    event: Omit<AuditEvent, 'hash' | 'prev_hash'>,
    prevHash: string,
  ): { hash: string; prev_hash: string };
}
```

#### Hash Computation Algorithm (TDD Section 3.4.2)

```
function computeHash(event, prevHash):
  if !this.enabled:
    return { hash: "", prev_hash: "" }

  // Step 1: Canonical serialization
  canonical = canonicalize(event)  // JSON with sorted keys, excludes hash/prev_hash

  // Step 2: Compute SHA-256
  hash = sha256(canonical + prevHash)

  // Step 3: Return hex-encoded hash
  return { hash: hash.toString('hex'), prev_hash: prevHash }
```

#### Canonical Serialization

```typescript
function canonicalize(event: Omit<AuditEvent, 'hash' | 'prev_hash'>): string {
  // Deep sort all keys at every level of the object
  const sorted = deepSortKeys(event);
  // Stringify with no whitespace
  return JSON.stringify(sorted);
}

function deepSortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(deepSortKeys);
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = deepSortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}
```

#### Genesis Event

The first event in the log uses `"GENESIS"` as its `prev_hash`:

```
first event:
  prev_hash = "GENESIS"
  hash = sha256(canonicalize(event) + "GENESIS")
```

#### Determinism Requirements

The canonical serialization MUST be deterministic:
- All object keys sorted lexicographically at every nesting level.
- No whitespace in JSON output.
- Numbers serialized with `JSON.stringify` (IEEE 754).
- Dates serialized as ISO 8601 strings (already strings in the event).
- `undefined` values excluded (JSON.stringify handles this).

### hash-verifier.ts

```typescript
export class HashChainVerifier {
  constructor(
    private hashComputer: HashChainComputer,
    private integrityLogPath?: string,   // Separate log for integrity failures
  ) {}

  // Verify the entire event log
  async verify(logPath: string): Promise<VerificationResult>;
}
```

#### Verification Algorithm

```
async function verify(logPath):
  events = readJsonLines(logPath)
  errors = []
  prevHash = "GENESIS"

  for (i, event) of events:
    // Check prev_hash chain
    if event.prev_hash !== prevHash:
      errors.push({
        lineNumber: i + 1,
        eventId: event.event_id,
        errorType: "prev_hash_mismatch",
        expected: prevHash,
        actual: event.prev_hash,
      })

    // Recompute hash
    expectedHash = sha256(canonicalize(eventWithoutHash) + event.prev_hash)
    if event.hash !== expectedHash:
      errors.push({
        lineNumber: i + 1,
        eventId: event.event_id,
        errorType: "hash_mismatch",
        expected: expectedHash,
        actual: event.hash,
      })

    prevHash = event.hash

  // Report
  result = {
    valid: errors.length === 0,
    totalEvents: events.length,
    errors,
    chainHeadHash: prevHash,
  }

  // If errors found, log to integrity log and emit notification
  if errors.length > 0:
    logIntegrityFailure(errors)
    // Do NOT halt pipeline (TDD Section 6)

  return result
```

#### Error Handling (TDD Section 6)

When the hash chain is broken:
1. Log `hash_chain_integrity_failure` to a separate integrity log file (not the main events.jsonl, since that file may be compromised).
2. Emit `immediate` urgency notification.
3. Do NOT halt the pipeline -- integrity failures are alerts, not blockers.
4. Return the full `VerificationResult` with all errors for investigation.

#### Streaming Verification

For large log files, the verifier reads line-by-line (streaming) rather than loading the entire file into memory. Uses `readline` interface or equivalent.

## Acceptance Criteria

1. Hash computation uses SHA-256 algorithm.
2. Canonical serialization sorts keys at all nesting levels.
3. Canonical serialization is deterministic (same input always produces same output).
4. Genesis event uses `"GENESIS"` as `prev_hash`.
5. Disabled mode returns empty strings for both `hash` and `prev_hash`.
6. Valid chain passes verification.
7. Tampered event (modified payload) detected by `hash_mismatch`.
8. Deleted event (gap in chain) detected by `prev_hash_mismatch`.
9. Reordered events detected (prev_hash does not match expected).
10. Integrity failure logged to separate file (not events.jsonl).
11. Integrity failure emits immediate notification.
12. Integrity failure does NOT halt pipeline.
13. Verification handles large files via streaming (no full file load).

## Test Cases

### Hash Chain Computer

1. **Genesis event hash** -- First event with `prevHash = "GENESIS"`; hash is `sha256(canonical + "GENESIS")`.
2. **Chain continuation** -- Second event with `prevHash = firstEvent.hash`; chain is valid.
3. **Deterministic canonicalization** -- Same event fields in different insertion order produce identical canonical string.
4. **Nested objects sorted** -- `{ payload: { z: 1, a: 2 } }` canonicalizes with `a` before `z`.
5. **Arrays preserved in order** -- `{ items: [3, 1, 2] }` serializes as `[3,1,2]` (arrays not sorted).
6. **Disabled mode returns empty** -- `enabled = false`; `computeHash(...)` returns `{ hash: "", prev_hash: "" }`.
7. **Different payloads produce different hashes** -- Two events with different payloads have different hashes.
8. **Same payload different prevHash produces different hash** -- Changing the chain changes the hash.

### Hash Chain Verifier

9. **Valid 10-event chain passes** -- Generate 10 chained events; `verify()` returns `{ valid: true, totalEvents: 10, errors: [] }`.
10. **Tampered event detected** -- Modify event 5's payload after writing; `verify()` reports `hash_mismatch` at line 5.
11. **Deleted event detected** -- Remove event 3 from the log; `verify()` reports `prev_hash_mismatch` at what was event 4 (now line 3).
12. **Reordered events detected** -- Swap events 4 and 5; `verify()` reports errors at both positions.
13. **Empty log file** -- `verify()` on empty file returns `{ valid: true, totalEvents: 0, errors: [] }`.
14. **Single event chain** -- One genesis event; valid.
15. **Integrity failure logged separately** -- Tampered chain triggers write to integrity log file (not events.jsonl).
16. **Integrity failure does not halt** -- After detecting tampering, pipeline continues (verify function returns normally, no throw).
17. **Chain head hash returned** -- `verify()` returns the hash of the last event as `chainHeadHash`.
18. **Streaming verification** -- Verify a 10,000-line file without memory spike (mock file, assert readline-based reading).
