# SPEC-009-5-1: Audit Event Types and Event Writer

## Metadata
- **Parent Plan**: PLAN-009-5
- **Tasks Covered**: Task 1 (Define audit event type system), Task 2 (Implement Audit Event Writer)
- **Estimated effort**: 11 hours

## Description

Define the complete type system for the audit trail including all 17 event types from TDD Section 3.4.1, and implement the append-only event writer with atomic append, fsync, file-level mutex, and retry-with-backoff error handling. The event writer is the lowest-level persistence component -- every audit event from every subsystem passes through it. It must be reliable, concurrent-safe, and never truncate the log.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/audit/types.ts` | Create | Audit event types, all 17 event types |
| `src/audit/event-writer.ts` | Create | Append-only event log writer |

## Implementation Details

### types.ts

```typescript
export type AuditEventType =
  // Trust events
  | "trust_level_change_requested"
  | "trust_level_changed"
  | "trust_level_change_superseded"
  | "trust_upgrade_confirmed"
  | "trust_upgrade_rejected"
  | "gate_decision"
  | "security_override_rejected"
  // Escalation events
  | "escalation_raised"
  | "escalation_timeout"
  | "escalation_resolved"
  | "escalation_response_received"
  | "human_override"
  | "re_escalation_loop_detected"
  // Kill switch events
  | "kill_issued"
  | "cancel_issued"
  | "system_reenabled"
  // Decision events
  | "autonomous_decision";

export interface AuditEvent {
  event_id: string;                   // UUID v4
  event_type: AuditEventType;
  timestamp: string;                  // ISO 8601 with millisecond precision
  request_id: string;                 // Associated request (or "system" for global events)
  repository: string;                 // Repository context (or "system")
  pipeline_phase: string;             // Current pipeline phase (or "n/a")
  agent: string;                      // Agent that produced the event
  payload: Record<string, unknown>;   // Event-specific data
  hash: string;                       // SHA-256 hash chain (empty in Phase 1/2)
  prev_hash: string;                  // Previous event hash (empty in Phase 1/2)
}

export interface AutonomousDecisionPayload {
  decision: string;                   // What was decided
  alternatives: string[];             // Other options considered
  confidence: number;                 // 0.0 - 1.0
  rationale: string;                  // Why this decision
  context: Record<string, unknown>;   // Supporting data
}

export interface VerificationResult {
  valid: boolean;
  totalEvents: number;
  errors: IntegrityError[];
  chainHeadHash: string;
}

export interface IntegrityError {
  lineNumber: number;
  eventId: string;
  errorType: "hash_mismatch" | "prev_hash_mismatch" | "missing_event" | "reorder_detected";
  expected: string;
  actual: string;
  message: string;
}
```

### event-writer.ts

```typescript
export class AuditEventWriter {
  constructor(
    private logPath: string,              // Path to events.jsonl
    private hashChain?: HashChainComputer, // Optional, Phase 3
  ) {}

  // Append a single event to the log
  async append(event: Omit<AuditEvent, 'event_id' | 'timestamp' | 'hash' | 'prev_hash'>): Promise<AuditEvent>;

  // Get the last event's hash (for chaining)
  getLastHash(): string;
}
```

#### Write Protocol

```
async function append(partialEvent):
  1. event = {
       ...partialEvent,
       event_id: uuidv4(),
       timestamp: new Date().toISOString(),
       hash: "",
       prev_hash: "",
     }

  2. if hashChain is enabled:
       prevHash = this.getLastHash()
       { hash, prev_hash } = hashChain.computeHash(event, prevHash)
       event.hash = hash
       event.prev_hash = prev_hash

  3. serialized = JSON.stringify(event)  // Single line, no newlines in content
  4. line = serialized + "\n"

  // Atomic append with mutex
  5. acquire flock(logPath, LOCK_EX)
  6. try:
       fd = fs.openSync(logPath, O_APPEND | O_WRONLY | O_CREAT)
       fs.writeSync(fd, line)
       fs.fsyncSync(fd)
       fs.closeSync(fd)
     finally:
       release flock

  7. return event
```

#### File-Level Mutex

Use advisory file locking (`flock`) to serialize concurrent writes:

```typescript
import { flockSync } from 'fs-ext'; // Or equivalent

// Lock file: events.jsonl.lock
// Lock held only for the duration of append + fsync
// LOCK_EX (exclusive) prevents concurrent writes
// LOCK_NB (non-blocking) not used -- writers queue
```

If `fs-ext` is not available, use a platform-portable alternative:
- Create a `.lock` file with `O_CREAT | O_EXCL` as a spin-lock with retry.
- Delete the lock file in the finally block.

#### Error Handling (TDD Section 6)

```
Retry with exponential backoff:
  attempt 1: immediate
  attempt 2: 100ms delay
  attempt 3: 500ms delay

If all 3 attempts fail:
  1. Buffer event in memory (this.pendingBuffer: AuditEvent[])
  2. Raise infrastructure escalation: "Audit event log write failure"
  3. Continue pipeline execution (do not halt for audit write failure)
  4. Retry flushing buffer on next successful write
```

#### Event ID Generation

Use UUID v4 for `event_id`. Every event gets a globally unique ID. No sequential counter (unlike escalation IDs) because audit events do not need human-readable IDs.

## Acceptance Criteria

1. All 17 `AuditEventType` values enumerated and exported.
2. `AuditEvent` interface includes all fields from TDD Section 3.4.1.
3. `AutonomousDecisionPayload` includes `decision`, `alternatives`, `confidence`, `rationale`.
4. Events appended atomically with `O_APPEND`.
5. `fsync` called after every write.
6. Concurrent writes serialized via file-level mutex -- no interleaved lines.
7. File is never truncated (append-only).
8. Event IDs are globally unique (UUID v4).
9. Timestamps have millisecond precision (ISO 8601).
10. Hash fields are empty strings when hash chain is disabled (Phase 1/2).
11. Write failures retried 3 times with exponential backoff.
12. Persistent write failure buffers events in memory and raises escalation.
13. Buffered events flushed on next successful write.

## Test Cases

1. **Append single event** -- Write one event; read events.jsonl; contains one JSON line with all fields.
2. **Event ID is UUID v4** -- Verify `event_id` matches UUID v4 pattern.
3. **Timestamp is ISO 8601** -- Verify `timestamp` matches ISO format with milliseconds.
4. **Hash fields empty in Phase 1** -- With no hash chain, `hash` and `prev_hash` are `""`.
5. **Append multiple events** -- Write 5 events; file contains 5 lines.
6. **Append is atomic** -- Each line is valid JSON (no partial writes).
7. **File never truncated** -- Write 3 events; file has 3 lines. Write 2 more; file has 5 lines (not 2).
8. **Concurrent writes serialized** -- Spawn 10 async appends simultaneously; all 10 events present in file; no interleaved content.
9. **fsync called** -- Mock fs; verify `fsyncSync` called after each write.
10. **Write failure retry: success on attempt 2** -- First write throws EAGAIN; second succeeds; event written.
11. **Write failure retry: all attempts fail** -- All 3 attempts fail; event buffered in memory; escalation raised.
12. **Buffered events flushed** -- After buffer, next successful write also flushes buffered events.
13. **Buffer ordering preserved** -- Buffered events written in original order.
14. **Empty log file created on first write** -- If events.jsonl doesn't exist, created on first append.
