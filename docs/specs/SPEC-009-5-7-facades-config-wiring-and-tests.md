# SPEC-009-5-7: Audit & Notification Facades, Config, Wiring, and Tests

## Metadata
- **Parent Plan**: PLAN-009-5
- **Tasks Covered**: Task 17 (NotificationFramework facade), Task 18 (AuditTrailEngine facade), Task 19 (Config loaders), Task 20 (Barrel exports), Task 21 (Audit unit tests), Task 22 (Notification unit tests), Task 23 (Integration tests)
- **Estimated effort**: 33 hours

## Description

Implement the two main facade classes (AuditTrailEngine and NotificationFramework) that serve as the entry points consumed by all other PLAN-009 subsystems. Includes configuration loaders for the `audit:` and `notifications:` YAML sections, barrel exports for both modules, and the complete unit and integration test suites for both audit trail and notification framework components.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/audit/audit-trail-engine.ts` | Create | AuditTrail facade implementing the shared interface |
| `src/notifications/notification-framework.ts` | Create | NotificationFramework facade |
| `src/audit/audit-config.ts` | Create | Audit config parsing and validation |
| `src/notifications/notification-config.ts` | Create | Notification config parsing and validation |
| `src/audit/index.ts` | Create | Audit barrel exports |
| `src/notifications/index.ts` | Create | Notification barrel exports |
| `src/audit/__tests__/event-writer.test.ts` | Create | Event writer unit tests |
| `src/audit/__tests__/hash-chain.test.ts` | Create | Hash chain unit tests |
| `src/audit/__tests__/hash-verifier.test.ts` | Create | Hash verifier unit tests |
| `src/audit/__tests__/decision-replay.test.ts` | Create | Decision replay unit tests |
| `src/audit/__tests__/log-archival.test.ts` | Create | Log archival unit tests |
| `src/notifications/__tests__/batcher.test.ts` | Create | Batcher unit tests |
| `src/notifications/__tests__/dnd-filter.test.ts` | Create | DND filter unit tests |
| `src/notifications/__tests__/fatigue-detector.test.ts` | Create | Fatigue detector unit tests |
| `src/notifications/__tests__/systemic-failure-detector.test.ts` | Create | Systemic failure unit tests |
| `src/notifications/__tests__/delivery-manager.test.ts` | Create | Delivery manager unit tests |
| `src/audit/__tests__/audit-trail.integration.test.ts` | Create | Audit integration tests |
| `src/notifications/__tests__/notification-framework.integration.test.ts` | Create | Notification integration tests |

## Implementation Details

### audit-trail-engine.ts

```typescript
export class AuditTrailEngine implements AuditTrail {
  constructor(
    private writer: AuditEventWriter,
    private hashChain: HashChainComputer,
    private replay: DecisionReplay,
    private verifier: HashChainVerifier,
  ) {}

  // Append an event (used by all other subsystems via AuditTrail interface)
  async append(event: Omit<AuditEvent, 'event_id' | 'timestamp' | 'hash' | 'prev_hash'>): Promise<void>;

  // Replay events for a request ID
  async replay(requestId: string): Promise<AuditEvent[]>;

  // Verify hash chain integrity
  async verify(): Promise<VerificationResult>;
}
```

The `AuditTrail` interface consumed by PLAN-009-1 through PLAN-009-4:

```typescript
export interface AuditTrail {
  append(event: Omit<AuditEvent, 'event_id' | 'timestamp' | 'hash' | 'prev_hash'>): Promise<void>;
}
```

This minimal interface is what other plans depend on. The `AuditTrailEngine` implements the full interface plus replay and verification.

### notification-framework.ts

```typescript
export class NotificationFramework {
  constructor(
    private dndFilter: DndFilter,
    private fatigueDetector: FatigueDetector,
    private batcher: NotificationBatcher,
    private deliveryManager: DeliveryManager,
    private systemicDetector: SystemicFailureDetector,
    private config: NotificationConfig,
    private timer: Timer,
  ) {}

  // Main entry point: submit a notification for delivery
  emit(payload: NotificationPayload): void;

  // Generate and deliver daily digest
  generateDailyDigest(): void;

  // Shutdown: flush buffers, cancel timers
  shutdown(): void;
}
```

#### emit() pipeline

```
function emit(payload):
  // Step 1: DND check
  if dndFilter.shouldSuppress(payload):
    dndFilter.queue(payload)
    return

  // Step 2: Fatigue check (per-recipient, requires knowing the target)
  recipientId = resolveRecipient(payload)
  if fatigueDetector.isFatigued(recipientId) && payload.urgency !== "immediate":
    batcher.submit(payload)   // Buffer for digest
    return

  // Step 3: Record for fatigue tracking
  fatigueDetector.record(recipientId)

  // Step 4: Systemic failure check (for failure-type notifications)
  if payload.event_type === "pipeline_failed" || payload.event_type === "escalation":
    detection = systemicDetector.recordFailure(extractFailureRecord(payload))
    if detection.systemic:
      // Suppress this individual notification; systemic alert already created
      deliveryManager.deliver(detection.alert)
      return

  // Step 5: Submit to batcher (handles exempt types and batching logic)
  batcher.submit(payload)
```

#### Daily Digest

Generated at a configured time (default: 09:00 local time). Summarizes:
- Active requests and their statuses.
- Pending escalations.
- Trust level changes in the last 24 hours.
- Systemic issues detected.

Uses `deliveryManager.deliver()` with a `"informational"` urgency digest notification.

### audit-config.ts

```typescript
export interface AuditConfig {
  log_path: string;                              // Default: ".autonomous-dev/events.jsonl"
  integrity: {
    hash_chain_enabled: boolean;                 // Default: false (Phase 1/2)
    verification_schedule: string;               // Cron expression, default: "0 2 * * *" (2 AM daily)
  };
  retention: {
    active_days: number;                         // Default: 90
    archive_path: string;                        // Default: ".autonomous-dev/archive/"
  };
  decision_log: {
    include_alternatives: boolean;               // Default: true
    include_confidence: boolean;                 // Default: true
  };
}
```

Validation: `active_days` must be positive (default 90). `hash_chain_enabled` must be boolean (default false). Invalid values fall back to defaults.

### notification-config.ts

```typescript
export interface NotificationConfig {
  default_method: DeliveryMethod;                // Default: "cli"
  per_type_overrides: Partial<Record<NotificationEventType, DeliveryMethod>>;
  batching: BatchingConfig;
  dnd: DndConfig;
  fatigue: FatigueConfig;
  cross_request: CrossRequestConfig;
  daily_digest_time: string;                     // HH:MM format, default: "09:00"
  daily_digest_timezone: string;                 // IANA timezone
}
```

### Barrel Exports

**src/audit/index.ts**:
```typescript
export { AuditTrailEngine } from './audit-trail-engine';
export { AuditEventWriter } from './event-writer';
export { HashChainComputer } from './hash-chain';
export { HashChainVerifier } from './hash-verifier';
export { DecisionReplay } from './decision-replay';
export { LogArchival } from './log-archival';
export * from './types';

export function createAuditTrailEngine(config: AuditConfig): AuditTrailEngine;
```

**src/notifications/index.ts**:
```typescript
export { NotificationFramework } from './notification-framework';
export { DeliveryManager } from './delivery-manager';
export { NotificationBatcher } from './batcher';
export { DndFilter } from './dnd-filter';
export { FatigueDetector } from './fatigue-detector';
export { SystemicFailureDetector } from './systemic-failure-detector';
export { CliDeliveryAdapter } from './adapters/cli-adapter';
export { DiscordDeliveryAdapter } from './adapters/discord-adapter';
export { SlackDeliveryAdapter } from './adapters/slack-adapter';
export { FileDropDeliveryAdapter } from './adapters/file-drop-adapter';
export * from './types';

export function createNotificationFramework(config: NotificationConfig, auditTrail: AuditTrail, timer: Timer): NotificationFramework;
```

## Acceptance Criteria

1. `AuditTrailEngine.append()` writes events correctly and satisfies the `AuditTrail` interface.
2. `AuditTrailEngine.replay()` returns filtered events for a request ID.
3. `AuditTrailEngine.verify()` validates the hash chain.
4. `AuditTrail` interface is importable and can be used as a dependency type by other plans.
5. `NotificationFramework.emit()` routes through DND -> fatigue -> systemic -> batcher pipeline.
6. DND, fatigue, and batching interact correctly (e.g., immediate breaks through all filters).
7. Daily digest generated at configured time.
8. `shutdown()` flushes all buffers and cancels timers.
9. Audit config: valid config loads; invalid falls back to defaults; `hash_chain_enabled` default false.
10. Notification config: valid config loads; invalid falls back to defaults.
11. Barrel imports work: `import { AuditTrailEngine } from './audit'` and `import { NotificationFramework } from './notifications'`.
12. Factory functions wire all dependencies correctly.
13. All unit tests pass with 100% branch coverage.
14. All integration tests pass.

## Test Cases

### AuditTrailEngine Unit Tests

1. **append writes event** -- `append({ event_type: "gate_decision", ... })` writes to events.jsonl.
2. **append populates event_id and timestamp** -- Written event has UUID and ISO timestamp.
3. **replay filters by request_id** -- 10 events for 3 requests; replay returns only matching events.
4. **verify returns valid for clean chain** -- 5 hash-chained events; verify returns `{ valid: true }`.
5. **verify detects tampering** -- Modified event detected.

### NotificationFramework Unit Tests

6. **emit: immediate bypasses DND and fatigue** -- `immediate` notification delivered even during DND with fatigued recipient.
7. **emit: DND suppresses non-immediate** -- During DND, `soon` notification queued, not delivered.
8. **emit: fatigue suppresses non-immediate** -- Fatigued recipient, `informational` notification buffered.
9. **emit: systemic failure detected** -- Third failure for same repo; systemic alert delivered; individual notification suppressed.
10. **emit: normal delivery** -- Non-DND, non-fatigued, non-systemic; notification submitted to batcher.
11. **shutdown flushes and cancels** -- Buffers flushed; timers cancelled.

### Audit Config Tests

12. **Valid full config loads** -- All fields populated correctly.
13. **Missing config uses defaults** -- Empty -> defaults (log_path, hash_chain_enabled=false, active_days=90).
14. **Invalid active_days** -- `active_days: -5` -> fallback to 90.

### Notification Config Tests

15. **Valid config loads** -- All fields populated.
16. **Missing config uses defaults** -- Empty -> defaults (cli, batching defaults, DND disabled).

### Integration: audit-trail.integration.test.ts

17. **Hash chain verification end-to-end (clean)** -- Enable hash chain. Write 20 events. Verify. Result: `{ valid: true, totalEvents: 20 }`.
18. **Hash chain verification end-to-end (tampered)** -- Enable hash chain. Write 20 events. Modify event 10 in the file. Verify. Result: `{ valid: false }` with error at event 10.
19. **Decision replay end-to-end** -- Write 50 events for 5 requests. Replay request 3. Returns only request 3's events in chronological order.
20. **Archival end-to-end** -- Write events spanning 120 days. Archive with 90-day retention. Active log has ~30 days of events. Archive file has ~90 days. Metadata sidecar present.

### Integration: notification-framework.integration.test.ts

21. **Fatigue -> digest mode** -- Send 25 notifications to one recipient in rapid succession (threshold=20). After notification 20, fatigue triggers. Notifications 21-25 buffered. Advance clock past cooldown. Digest delivered with 5 notifications.
22. **3 failures same repo -> systemic alert** -- Emit 3 `pipeline_failed` notifications for the same repo within window. Third triggers systemic alert with `immediate` urgency. Individual notification for third failure suppressed.
23. **DND + flush** -- Set DND 22:00-07:00. Emit 5 non-immediate notifications at 23:00. All queued. Advance clock to 07:00. All 5 delivered.
