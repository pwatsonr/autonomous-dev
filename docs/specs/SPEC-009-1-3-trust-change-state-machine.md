# SPEC-009-1-3: Trust Level Change State Machine

## Metadata
- **Parent Plan**: PLAN-009-1
- **Tasks Covered**: Task 4 (Implement Trust Level Change State Machine)
- **Estimated effort**: 6 hours

## Description

Implement the state machine that manages mid-pipeline trust level changes. Trust changes are requested at any time but applied only at gate boundaries, ensuring that in-flight phases are never retroactively affected. Downgrades are always immediate (at the next boundary); upgrades require a confirmation step in Phase 1. Concurrent changes use last-write-wins semantics. All transitions emit audit events via the injected `AuditTrail` interface.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/trust/trust-change-manager.ts` | Create | Trust level change state machine |

## Implementation Details

### State Machine

```
CURRENT_LEVEL ──[requestChange()]──> CHANGE_PENDING ──[resolveAtGateBoundary()]──> NEW_LEVEL
                                         │
                                    (if upgrade)
                                         │
                                    AWAITING_CONFIRMATION ──[confirm()]──> CHANGE_PENDING
                                         │
                                    [reject()]──> CURRENT_LEVEL (change discarded)
```

### TrustChangeManager API

```typescript
export class TrustChangeManager {
  constructor(private auditTrail: AuditTrail) {}

  // Request a trust level change. Returns the pending change.
  requestChange(requestId: string, change: TrustLevelChangeRequest): PendingChange;

  // Called at each gate boundary. If a pending change exists, applies it and returns the new level.
  // If no pending change, returns the current level unchanged.
  resolveAtGateBoundary(requestId: string, currentLevel: TrustLevel): TrustLevel;

  // Confirm a pending upgrade (Phase 1 requirement).
  confirmUpgrade(requestId: string): void;

  // Reject a pending upgrade.
  rejectUpgrade(requestId: string): void;

  // Get the current pending change for a request, if any.
  getPendingChange(requestId: string): PendingChange | null;
}
```

### Key Rules

1. **Downgrade (toLevel < fromLevel)**: Always allowed. Status set to `"pending"` immediately. Applied at next gate boundary without confirmation.

2. **Upgrade (toLevel > fromLevel)**: Status set to `"awaiting_confirmation"`. Requires explicit `confirmUpgrade()` call before it transitions to `"pending"`. If not confirmed before the next gate boundary, it remains awaiting and is not applied.

3. **Same level (toLevel === fromLevel)**: No-op. Logged but no state change.

4. **Concurrent changes (last-write-wins)**: If a second `requestChange()` is called while a previous change is pending, the new change replaces the old one. The replaced change is logged with `trust_level_change_superseded` event.

5. **In-flight phases unaffected**: `resolveAtGateBoundary` is only called at gate boundaries. A phase currently executing is not interrupted or re-evaluated when a change is requested.

6. **Gate boundary application**: When `resolveAtGateBoundary` finds a `"pending"` change:
   - Set the effective level to `change.toLevel`.
   - Clear the pending change.
   - Emit `trust_level_changed` audit event with `{ requestId, fromLevel, toLevel, appliedAtGate }`.

### Audit Events Emitted

| Event Type | When | Payload |
|-----------|------|---------|
| `trust_level_change_requested` | `requestChange()` called | `{ requestId, fromLevel, toLevel, requestedBy, reason }` |
| `trust_level_changed` | `resolveAtGateBoundary()` applies a change | `{ requestId, fromLevel, toLevel, appliedAtGate }` |
| `trust_level_change_superseded` | A pending change is replaced by a new one | `{ requestId, supersededChange, newChange }` |
| `trust_upgrade_confirmed` | `confirmUpgrade()` called | `{ requestId, toLevel }` |
| `trust_upgrade_rejected` | `rejectUpgrade()` called | `{ requestId, toLevel, reason }` |

### Internal State

```typescript
interface PendingChange {
  requestId: string;
  fromLevel: TrustLevel;
  toLevel: TrustLevel;
  status: "pending" | "awaiting_confirmation";
  requestedBy: string;
  requestedAt: Date;
  reason: string;
}

// Map of requestId -> PendingChange
private pendingChanges: Map<string, PendingChange>;
```

## Acceptance Criteria

1. Downgrade from L2 to L0: change is immediately `"pending"` and applies at the next gate boundary.
2. Upgrade from L1 to L3: change is `"awaiting_confirmation"` until confirmed.
3. Confirmed upgrade transitions to `"pending"` and applies at next gate boundary.
4. Rejected upgrade is discarded; current level remains unchanged.
5. Concurrent changes: second request replaces first; superseded event emitted.
6. In-flight phases are not affected -- only the next gate boundary sees the change.
7. Same-level change request is a no-op (logged, no pending state created).
8. All five audit event types are emitted at the correct times with correct payloads.
9. `getPendingChange` returns `null` after a change is applied or rejected.

## Test Cases

1. **Downgrade L2 to L0** -- `requestChange(req, { from: 2, to: 0 })` creates pending change; `resolveAtGateBoundary(req, 2)` returns `0`.
2. **Upgrade L1 to L3 without confirmation** -- `requestChange(req, { from: 1, to: 3 })` creates awaiting_confirmation; `resolveAtGateBoundary(req, 1)` returns `1` (unchanged, not yet confirmed).
3. **Upgrade L1 to L3 with confirmation** -- `requestChange`, `confirmUpgrade`, `resolveAtGateBoundary` returns `3`.
4. **Upgrade rejected** -- `requestChange`, `rejectUpgrade`, `resolveAtGateBoundary` returns `1` (original level).
5. **Concurrent changes (last-write-wins)** -- `requestChange(req, { to: 0 })`, then `requestChange(req, { to: 2 })`. `getPendingChange(req).toLevel` === `2`. Superseded audit event emitted.
6. **No pending change** -- `resolveAtGateBoundary(req, 2)` with no pending change returns `2`.
7. **Same-level request** -- `requestChange(req, { from: 2, to: 2 })` is a no-op.
8. **Audit event: trust_level_change_requested** -- Verify emitted on `requestChange()` with correct payload.
9. **Audit event: trust_level_changed** -- Verify emitted on `resolveAtGateBoundary()` when change applied.
10. **Audit event: trust_level_change_superseded** -- Verify emitted when concurrent change replaces pending.
11. **Change clears after application** -- After `resolveAtGateBoundary` applies a change, `getPendingChange(req)` returns `null`.
