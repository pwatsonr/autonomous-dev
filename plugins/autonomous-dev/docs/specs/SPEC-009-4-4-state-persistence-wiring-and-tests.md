# SPEC-009-4-4: State Persistence, Module Wiring, and Tests

## Metadata
- **Parent Plan**: PLAN-009-4
- **Tasks Covered**: Task 7 (State Preservation File Layout), Task 9 (Barrel exports), Task 10 (Unit tests), Task 11 (Integration tests)
- **Estimated effort**: 19 hours

## Description

Implement the incremental state persistence layer that maintains pipeline state files after each phase completion (enabling fast snapshot capture at kill time), wire all emergency module dependencies with barrel exports, and deliver the complete test suite including unit tests for all components and integration tests covering kill-during-active-pipeline scenarios plus the kill switch drill from TDD Section 8.3.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/emergency/state-persistence.ts` | Create | Incremental pipeline state file management |
| `src/emergency/index.ts` | Create | Barrel exports and factory |
| `src/emergency/__tests__/abort-manager.test.ts` | Create | Abort manager unit tests |
| `src/emergency/__tests__/kill-switch.test.ts` | Create | Kill switch unit tests |
| `src/emergency/__tests__/state-snapshot.test.ts` | Create | State snapshot unit tests |
| `src/emergency/__tests__/halted-gate.test.ts` | Create | HALTED gate unit tests |
| `src/emergency/__tests__/pause-resume.test.ts` | Create | Pause/resume unit tests |
| `src/emergency/__tests__/kill-switch.integration.test.ts` | Create | Integration and drill tests |

## Implementation Details

### state-persistence.ts

```typescript
export class StatePersistence {
  constructor(private baseDir: string) {}

  // Write pipeline state after each phase completion (called by pipeline orchestrator)
  writePipelineState(requestId: string, state: PipelineState): void;

  // Write artifact manifest for a request
  writeArtifactManifest(requestId: string, artifacts: string[]): void;

  // Read pipeline state for a request
  readPipelineState(requestId: string): PipelineState | null;

  // Read artifact manifest for a request
  readArtifactManifest(requestId: string): string[];

  // Clean up state files for a completed request
  cleanup(requestId: string): void;
}

export interface PipelineState {
  requestId: string;
  currentPhase: string;
  phaseStatus: "running" | "completed" | "pending" | "failed";
  completedPhases: string[];
  trustLevel: number;
  lastUpdated: string;  // ISO 8601
}
```

#### File Layout (TDD Section 3.3.1)

```
.autonomous-dev/
  state/
    {request-id}/
      pipeline.json           -- Pipeline position, updated after each phase
    escalations/
      pending.json            -- Pending escalation list (managed by PLAN-009-2)
    kill-snapshot-{ts}.json   -- Kill snapshots (managed by state-snapshot.ts)
  workspaces/
    {request-id}/             -- Generated artifacts (managed by pipeline)
  events.jsonl                -- Audit event log (managed by PLAN-009-5)
```

#### Incremental write semantics

- `writePipelineState` is called by the pipeline orchestrator after each phase completes.
- Write is atomic: write to temp file, fsync, then rename.
- This means the state file is always in a consistent state, even during hard kill.
- If write fails, log error but do not halt the pipeline (state loss is acceptable for a single phase).

### index.ts

```typescript
export { KillSwitch } from './kill-switch';
export { AbortManager } from './abort-manager';
export { HaltedGate } from './halted-gate';
export { PauseResumeController } from './pause-resume';
export { StateSnapshotCapture } from './state-snapshot';
export { StatePersistence } from './state-persistence';
export * from './types';

export function createKillSwitch(
  stateDir: string,
  escalationEngine: { cancelAllPending(): void },
  auditTrail: AuditTrail,
  notifier: { emit(payload: NotificationPayload): void },
): { killSwitch: KillSwitch; abortManager: AbortManager; haltedGate: HaltedGate };
```

### Integration Test: Kill Switch Drill (TDD Section 8.3)

The drill scenario is an automated test that simulates a realistic kill switch activation:

```
Drill scenario:
  1. Start 3 synthetic pipeline requests (mock executors that respect abort signals)
  2. Wait for all 3 to be actively executing phases
  3. Issue /kill graceful
  4. Assert: all 3 executors stop at the next atomic boundary
  5. Assert: halt timing < 5 seconds from kill issued to all signals received
  6. Assert: state snapshot file written with all 3 requests
  7. Assert: each snapshot has correct pipeline phase and artifacts
  8. Assert: pending escalations cancelled
  9. Assert: HALTED gate rejects new request with SYSTEM_HALTED error
  10. Issue reenable
  11. Assert: system accepts new requests
  12. Start 1 new request; verify it executes normally
```

The drill tests both graceful and hard modes with timing assertions.

## Acceptance Criteria

1. `writePipelineState` writes atomically (temp + fsync + rename).
2. `readPipelineState` returns `null` for nonexistent requests (no error).
3. State files follow the TDD Section 3.3.1 file layout.
4. Pipeline state is readable immediately after write (no caching delays).
5. `cleanup` removes all state files for a request.
6. `import { KillSwitch, AbortManager, HaltedGate } from './emergency'` works.
7. `createKillSwitch` factory wires all dependencies correctly.
8. All unit tests pass with 100% branch coverage.
9. Integration test: graceful kill during 3 active pipelines -- all halt at atomic boundary, state preserved.
10. Integration test: hard kill during 3 active pipelines -- all halt immediately, state preserved.
11. Drill test: full sequence (start -> kill -> verify -> reenable -> verify) passes.
12. Halt timing: signals received by all executors within 5 seconds.

## Test Cases

### Unit: state-persistence.test.ts

1. **Write and read pipeline state** -- Write state for `req-1`; read returns same state.
2. **Read nonexistent request** -- `readPipelineState("unknown")` returns `null`.
3. **Write is atomic** -- Simulate crash during write (mock fs); verify no partial file.
4. **Write artifact manifest** -- Write and read artifact list.
5. **Cleanup removes files** -- Write state, cleanup, read returns `null`.
6. **Multiple requests coexist** -- Write state for `req-1` and `req-2`; each reads independently.

### Integration: kill-switch.integration.test.ts

7. **Graceful kill during active phases** --
   a. Create 3 mock pipeline executors that check abort signal between phases.
   b. Register all 3 with abort manager.
   c. Issue `kill("graceful", "admin")`.
   d. Verify: all 3 executors finish their current phase and stop.
   e. Verify: kill snapshot file exists with 3 request entries.
   f. Verify: `killSwitch.isHalted()` is `true`.
   g. Verify: HALTED gate rejects new request.

8. **Hard kill during active phases** --
   a. Same setup as above.
   b. Issue `kill("hard", "admin")`.
   c. Verify: all 3 executors stop immediately (abort signal fires without waiting for phase completion).
   d. Verify: snapshot captured before abort.

9. **Kill switch drill (TDD 8.3)** --
   a. Start 3 synthetic requests.
   b. Issue `/kill graceful`.
   c. Verify halt timing < 5 seconds.
   d. Verify state snapshots for all 3 requests.
   e. Verify pending escalations cancelled.
   f. Verify HALTED gate blocks new requests.
   g. `reenable("admin")`.
   h. Start 1 new request; verify it executes.

10. **Kill then reenable then kill again** -- Full cycle: kill -> reenable -> kill. Verify state is consistent at each step. Second kill produces a new snapshot (not reusing old one).

11. **Cancel during active pipeline** -- Cancel `req-2` while `req-1` and `req-3` continue. Verify: `req-2` aborted, others unaffected. Verify: `req-2` snapshot captured. System not halted.
