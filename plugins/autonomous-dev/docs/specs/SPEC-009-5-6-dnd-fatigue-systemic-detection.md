# SPEC-009-5-6: DND Filter, Fatigue Detection, and Systemic Failure Detection

## Metadata
- **Parent Plan**: PLAN-009-5
- **Tasks Covered**: Task 14 (DND Filter), Task 15 (Fatigue Detector), Task 16 (Systemic Failure Detector)
- **Estimated effort**: 14 hours

## Description

Implement the three notification intelligence components: the Do Not Disturb filter that suppresses non-immediate notifications during configured hours, the fatigue detector that monitors notification volume and switches to digest mode when thresholds are exceeded, and the systemic failure detector that correlates failures across requests to identify infrastructure-level issues. These components sit in the notification pipeline between submission and delivery, reducing noise while ensuring critical alerts always break through.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/notifications/dnd-filter.ts` | Create | DND window suppression |
| `src/notifications/fatigue-detector.ts` | Create | Volume-based fatigue and digest mode |
| `src/notifications/systemic-failure-detector.ts` | Create | Cross-request failure correlation |

## Implementation Details

### dnd-filter.ts

```typescript
export class DndFilter {
  constructor(
    private config: DndConfig,
    private clock: Clock,       // Injectable for testing
  ) {}

  // Check if a notification should be suppressed
  shouldSuppress(payload: NotificationPayload): boolean;

  // Queue a suppressed notification for post-DND delivery
  queue(payload: NotificationPayload): void;

  // Flush queued notifications (called when DND ends)
  flush(): NotificationPayload[];

  // Check if currently in DND window
  isInDndWindow(): boolean;

  // Get count of queued notifications
  getQueueSize(): number;
}

export interface Clock {
  now(): Date;
}
```

#### DND Window Evaluation

```
function isInDndWindow():
  if !config.enabled: return false

  now = clock.now() in config.timezone
  currentTime = formatAsHHMM(now)  // e.g., "22:30"

  start = config.startTime  // e.g., "22:00"
  end = config.endTime      // e.g., "07:00"

  // Handle overnight window (crosses midnight)
  if start > end:
    // e.g., 22:00 to 07:00
    return currentTime >= start || currentTime < end

  // Normal window (same day)
  // e.g., 12:00 to 13:00
  return currentTime >= start && currentTime < end
```

#### Suppression Rules

1. `immediate` urgency: NEVER suppressed, regardless of DND. Always delivered.
2. All other urgencies during DND window: suppressed and queued.
3. Post-DND flush: when `isInDndWindow()` transitions from `true` to `false`, call `flush()` to deliver queued notifications.

The DND filter checks periodically (via timer) for DND end and triggers flush. Alternatively, the notification framework calls `isInDndWindow()` before each delivery and handles the transition.

### fatigue-detector.ts

```typescript
export class FatigueDetector {
  constructor(
    private config: FatigueConfig,
    private clock: Clock,
  ) {}

  // Record a notification delivery to a recipient
  record(recipientId: string): void;

  // Check if a recipient is fatigued
  isFatigued(recipientId: string): boolean;

  // Get or create fatigue state for a recipient
  getFatigueState(recipientId: string): FatigueState;
}

interface FatigueState {
  recipientId: string;
  deliveryTimestamps: Date[];        // Sliding window entries
  fatigued: boolean;
  fatiguedSince?: Date;
  cooldownEndsAt?: Date;
}
```

#### Sliding Window Algorithm (TDD Section 3.5.4)

```
function record(recipientId):
  state = getFatigueState(recipientId)
  now = clock.now()

  // Add timestamp
  state.deliveryTimestamps.push(now)

  // Prune entries older than 1 hour
  cutoff = now - 1_hour
  state.deliveryTimestamps = state.deliveryTimestamps.filter(t => t >= cutoff)

function isFatigued(recipientId):
  state = getFatigueState(recipientId)
  now = clock.now()

  // Check if in cooldown
  if state.fatigued && state.cooldownEndsAt && now < state.cooldownEndsAt:
    return true

  // Check if cooldown expired
  if state.fatigued && state.cooldownEndsAt && now >= state.cooldownEndsAt:
    state.fatigued = false
    state.cooldownEndsAt = undefined
    return false

  // Check threshold
  recentCount = state.deliveryTimestamps.filter(t => t >= now - 1_hour).length
  if recentCount >= config.thresholdPerHour:
    state.fatigued = true
    state.fatiguedSince = now
    state.cooldownEndsAt = now + config.cooldownMinutes * 60 * 1000
    return true

  return false
```

#### Fatigue Behavior

When `isFatigued(recipientId)` returns `true`:
1. **First detection**: emit a single meta-notification to the recipient: `"Notification fatigue detected. {count} notifications in the last hour. Switching to digest mode for {cooldownMinutes} minutes."` This meta-notification is `immediate` urgency.
2. **During cooldown**: all non-immediate notifications for this recipient are buffered.
3. **After cooldown expires**: flush buffered notifications as a digest (via `deliverBatch`). Resume normal delivery.
4. `immediate` urgency notifications are NEVER suppressed by fatigue.

### systemic-failure-detector.ts

```typescript
export class SystemicFailureDetector {
  constructor(
    private config: CrossRequestConfig,
    private auditTrail: AuditTrail,
    private clock: Clock,
  ) {}

  // Record a failure event
  recordFailure(failure: FailureRecord): SystemicDetectionResult;

  // Check if a systemic issue is currently active
  isSystemicIssueActive(pattern: string): boolean;
}

interface FailureRecord {
  requestId: string;
  repository: string;
  pipelinePhase: string;
  failureType: string;
  timestamp: Date;
}

type SystemicDetectionResult =
  | { systemic: false }
  | { systemic: true; pattern: SystemicPattern; affectedRequests: string[]; alert: NotificationPayload };

interface SystemicPattern {
  type: "same_repo" | "same_phase" | "same_failure_type";
  key: string;                      // The repo, phase, or failure type
  count: number;
  windowStart: Date;
}
```

#### Detection Algorithm (TDD Section 3.5.5)

Three correlation patterns, evaluated independently:

1. **Same repository**: >= `threshold` failures in the same repository within `windowMinutes`.
   - Key: `repo:{repository}`
2. **Same pipeline phase**: >= `threshold` failures in the same phase within `windowMinutes`.
   - Key: `phase:{pipelinePhase}`
3. **Same failure type**: >= `threshold` failures of the same type within `windowMinutes`.
   - Key: `type:{failureType}`

```
function recordFailure(failure):
  now = clock.now()
  cutoff = now - windowMinutes * 60 * 1000

  // Add to all three indices
  addToIndex("repo:" + failure.repository, failure)
  addToIndex("phase:" + failure.pipelinePhase, failure)
  addToIndex("type:" + failure.failureType, failure)

  // Prune old entries from all indices
  pruneOlderThan(cutoff)

  // Check each pattern
  for pattern of ["repo:" + failure.repository, "phase:" + ..., "type:" + ...]:
    entries = getIndex(pattern).filter(e => e.timestamp >= cutoff)
    if entries.length >= threshold:
      if !isSystemicIssueActive(pattern):
        // New systemic issue detected
        affectedRequests = unique(entries.map(e => e.requestId))
        alert = createSystemicAlert(pattern, entries.length, affectedRequests)
        markSystemicIssueActive(pattern)
        auditTrail.append({ type: "systemic_issue_detected", pattern, count, affectedRequests })
        return { systemic: true, pattern, affectedRequests, alert }

  return { systemic: false }
```

#### Systemic Alert Notification

When a systemic issue is detected:
1. **Suppress individual pending escalation notifications** for the affected requests. They are rolled into the systemic alert.
2. **Emit single systemic alert** with `immediate` urgency:
   - Title: `"Systemic issue detected: {pattern.type} - {pattern.key}"`
   - Body: `"{count} failures in {windowMinutes} minutes. Affected requests: {list}. This may indicate an infrastructure or configuration issue."`
3. **Log `systemic_issue_detected` audit event**.

#### Window Expiration

Old failure records are pruned when the window expires. If the count drops below the threshold, the systemic issue is marked inactive, and individual notifications resume.

## Acceptance Criteria

### DND
1. Non-immediate notifications suppressed during DND window.
2. `immediate` urgency always breaks through DND.
3. Overnight windows crossing midnight work correctly (e.g., 22:00 to 07:00).
4. Post-DND flush delivers all queued notifications.
5. Timezone conversion correct for configured timezone.

### Fatigue
6. Threshold triggers digest mode after N notifications in 1 hour.
7. Meta-notification sent once on fatigue detection.
8. Cooldown period respected; non-immediate notifications buffered during cooldown.
9. Digest flushed after cooldown expires.
10. Window expiration resets notification count.
11. `immediate` urgency never suppressed by fatigue.

### Systemic
12. Per-repo pattern detected at threshold.
13. Per-phase pattern detected at threshold.
14. Per-failure-type pattern detected at threshold.
15. Window expiration prunes old records.
16. Individual notifications suppressed when systemic alert fires.
17. Systemic alert has `immediate` urgency.
18. Systemic alert includes affected request list and count.
19. `systemic_issue_detected` audit event logged.

## Test Cases

### DND Filter

1. **In DND window: suppressed** -- Mock clock at 23:00, DND 22:00-07:00. Non-immediate notification suppressed.
2. **In DND window: immediate breaks through** -- Mock clock at 23:00. `immediate` notification NOT suppressed.
3. **Outside DND: not suppressed** -- Mock clock at 10:00. Notification not suppressed.
4. **Overnight window: 23:30 is in DND** -- DND 22:00-07:00. 23:30 is within window.
5. **Overnight window: 06:59 is in DND** -- 06:59 is within window.
6. **Overnight window: 07:00 is NOT in DND** -- 07:00 is outside window.
7. **Same-day window: 12:30 in DND 12:00-13:00** -- Within window.
8. **Post-DND flush** -- Queue 3 notifications during DND. Transition to non-DND. `flush()` returns all 3.
9. **DND disabled** -- `config.enabled = false`. Never suppresses.
10. **Timezone conversion** -- Clock in UTC, DND config in America/New_York. Correct evaluation.

### Fatigue Detector

11. **Below threshold: not fatigued** -- 10 notifications in 1 hour with threshold 20. `isFatigued` returns `false`.
12. **At threshold: fatigued** -- 20 notifications in 1 hour. `isFatigued` returns `true`.
13. **Meta-notification emitted** -- On first fatigue detection, verify meta-notification payload generated.
14. **During cooldown: fatigued** -- After fatigue, within cooldown period. `isFatigued` returns `true`.
15. **After cooldown: not fatigued** -- Advance clock past cooldown. `isFatigued` returns `false`.
16. **Window expiration** -- 20 notifications; advance clock by 61 minutes (past 1-hour window). Old entries pruned. `isFatigued` returns `false`.
17. **Immediate never fatigued** -- Fatigue detection returns `true` but `immediate` urgency should still be delivered (checked by caller, not detector).
18. **Per-recipient tracking** -- User A fatigued, User B not. Independent tracking.

### Systemic Failure Detector

19. **3 failures same repo -> systemic** -- Record 3 failures for `repo-x` within window. Result: `{ systemic: true, pattern: { type: "same_repo", key: "repo-x", count: 3 } }`.
20. **2 failures same repo -> not systemic** -- 2 failures below default threshold 3. Result: `{ systemic: false }`.
21. **3 failures same phase** -- 3 failures in `code_review` phase. Systemic detected.
22. **3 failures same type** -- 3 `timeout` failures. Systemic detected.
23. **Window expiration prunes** -- Record 2 failures at T=0, advance clock past window, record 1 more. Total in window = 1. Not systemic.
24. **Affected requests listed** -- 3 failures from `req-1`, `req-2`, `req-3`. Alert includes all 3 request IDs.
25. **Duplicate detection suppressed** -- After systemic issue active for pattern, recording another failure for same pattern does NOT emit a second alert.
26. **Different patterns independent** -- Same-repo systemic does not suppress same-phase detection.
27. **Audit event logged** -- `systemic_issue_detected` event emitted with pattern and affected requests.
28. **Systemic alert urgency is immediate** -- Alert notification has `urgency: "immediate"`.
