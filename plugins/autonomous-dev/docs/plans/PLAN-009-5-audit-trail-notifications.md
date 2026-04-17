# PLAN-009-5: Audit Trail & Notifications

## Metadata
- **Parent TDD**: TDD-009-trust-escalation
- **Estimated effort**: 12 days
- **Dependencies**: [PLAN-009-1 (trust engine types), PLAN-009-2 (escalation types)]
- **Blocked by**: None (interface can be built in parallel; concrete wiring after PLAN-009-1 and PLAN-009-2)
- **Priority**: P1

## Objective

Implement the Audit Trail Engine and Notification Framework subsystems. The Audit Trail provides an append-only, hash-chained event log that records every significant system event for compliance, debugging, and decision replay. The Notification Framework delivers events to humans via multiple channels (CLI, Discord, Slack, file_drop) with batching, Do Not Disturb, fatigue detection, and cross-request systemic failure correlation. Together, these subsystems ensure that nothing happens silently and that every action is recorded for posterity.

## Scope

### In Scope

**Audit Trail Engine:**
- Append-only event log (`events.jsonl`) using JSON Lines format
- Full `AuditEvent` schema with all event types (17 types per TDD Section 3.4.1)
- Write protocol: serialize -> compute hash chain fields (Phase 3) -> append with `O_APPEND` -> `fsync()`
- File-level mutex (`flock()`) for concurrent write serialization
- Decision log: `autonomous_decision` events with alternatives, confidence, and rationale
- Decision replay: filter events by `request_id`, sort by timestamp, produce chronological narrative (streaming filter for Phase 1; in-memory index for Phase 2)
- Hash-chain integrity algorithm (Phase 3): SHA-256 chaining, genesis event, canonical serialization with sorted keys
- Hash-chain verification: validate entire log for tamper evidence
- Event log retention: active period (configurable, default 90 days) + archive to cold storage
- Audit configuration data model (`audit:` YAML section)
- Phase 1: events written without hash fields (empty strings); Phase 3 enables hash chaining via config flag

**Notification Framework:**
- Seven notification event types with independently configurable delivery methods and urgency
- Four delivery adapters: CLI (stdout), Discord (embed JSON), Slack (Block Kit JSON), file_drop (raw JSON)
- `DeliveryAdapter` interface and fallback chain: configured method -> CLI -> file_drop; if all fail, pipeline pauses
- Notification batching: non-urgent notifications accumulated and flushed at interval or max buffer size
- Batch-exempt types: `escalation` and `error` always delivered immediately
- Do Not Disturb (DND): suppress non-immediate notifications during configured hours; flush on DND end
- DND overnight window support (e.g., 22:00 to 07:00 crossing midnight)
- Notification fatigue detection: threshold per recipient per hour; automatic switch to digest mode with cooldown
- Cross-request systemic failure detection: correlate failures by repository, pipeline phase, and failure type; suppress individual escalations; emit single systemic alert
- Daily digest generation
- Notification configuration data model (`notifications:` YAML section)

### Out of Scope

- External API integration (actual Slack API calls, Discord bot implementation) -- adapters produce formatted payloads; transport is the platform layer's responsibility per TDD Section 9.5
- Trust scoring computation (Phase 3, separate follow-up)
- Hash chain migration for existing events (Phase 3 backfill task, tracked separately)
- Office-hours routing (Phase 3 feature)

## Tasks

1. **Define audit event type system** -- Create TypeScript types for the audit trail.
   - Files to create: `src/audit/types.ts`
   - Types: `AuditEvent` (per TDD Section 3.4.1: `event_id`, `event_type`, `timestamp`, `request_id`, `repository`, `pipeline_phase`, `agent`, `payload`, `hash`, `prev_hash`), `AuditEventType` (17-member union), `AutonomousDecisionPayload`, `VerificationResult`, `IntegrityError`
   - Acceptance criteria: All types match TDD Section 3.4 contracts; all 17 event types enumerated
   - Estimated effort: 3 hours

2. **Implement Audit Event Writer** -- Append-only writer with atomic append and fsync.
   - Files to create: `src/audit/event-writer.ts`
   - Write protocol per TDD Section 3.4.1: serialize to single-line JSON -> append with `O_APPEND` -> `fsync()`
   - File-level mutex using `flock()` advisory lock for concurrent write serialization
   - Lock held only for append+fsync duration
   - Event ID generation: UUID v4
   - Hash fields set to empty string in Phase 1 (hash chain disabled by default)
   - Error handling per TDD Section 6: retry with exponential backoff (3 attempts); if persistent, buffer events in memory and raise `infrastructure` escalation
   - Acceptance criteria: Events appended atomically; file never truncated; concurrent writes serialized; fsync called after each write; write failures retried with backoff; events buffered in memory during retry
   - Estimated effort: 8 hours

3. **Implement Hash Chain Computer (Phase 3 ready)** -- Compute SHA-256 hash chains for event integrity.
   - Files to create: `src/audit/hash-chain.ts`
   - Algorithm per TDD Section 3.4.2: canonical serialization (sorted keys, exclude `hash` and `prev_hash`), genesis event uses `"GENESIS"` as prev_hash, subsequent events chain to previous hash
   - `computeHash(event, prevHash): { hash, prev_hash }` function
   - Enabled/disabled via `audit.integrity.hash_chain_enabled` config flag
   - When disabled, returns empty strings for both fields (Phase 1/2 behavior)
   - Acceptance criteria: Hash computation matches TDD algorithm; canonical serialization is deterministic; genesis event handled correctly; disabled mode returns empty strings
   - Estimated effort: 4 hours

4. **Implement Hash Chain Verifier** -- Verify the integrity of the entire event log.
   - Files to create: `src/audit/hash-verifier.ts`
   - `verifyIntegrity(logPath): VerificationResult` per TDD Section 3.4.2
   - Checks: prev_hash matches expected; hash correctly computed from canonical fields
   - Reports: total events, errors with line number and event_id, chain head hash
   - Error handling per TDD Section 6: hash chain broken -> log `hash_chain_integrity_failure` to separate integrity log, emit `immediate` notification, do NOT halt pipeline
   - Acceptance criteria: Valid chain passes; tampered event detected; deleted event detected; reordered events detected; broken chain does not halt pipeline
   - Estimated effort: 4 hours

5. **Implement Decision Replay** -- Filter and replay decisions for a given request ID.
   - Files to create: `src/audit/decision-replay.ts`
   - Phase 1: streaming filter over `events.jsonl` -- read line by line, parse JSON, filter by `request_id`, sort by timestamp
   - Output: chronological narrative of all events for the request
   - Phase 2 extension point: in-memory index built on demand for faster queries
   - Acceptance criteria: Returns all events for a request ID in chronological order; handles large log files without loading entire file into memory; returns empty result for unknown request IDs
   - Estimated effort: 4 hours

6. **Implement Event Log Archival** -- Move old events from active log to archive.
   - Files to create: `src/audit/log-archival.ts`
   - Events older than `audit.retention.active_days` (default 90) moved to `audit.retention.archive_path`
   - Archive preserves hash chain continuity: records chain-head hash at time of archival
   - Archive files named by date range
   - Acceptance criteria: Events older than threshold moved to archive; active log only contains recent events; archive preserves hash chain head; original events not deleted until archive confirmed written
   - Estimated effort: 4 hours

7. **Define notification type system** -- Create TypeScript types for the notification framework.
   - Files to create: `src/notifications/types.ts`
   - Types: `NotificationPayload` (per TDD Section 3.5.1), `NotificationEventType` (7-member union), `DeliveryAdapter` interface, `DeliveryResult`, `BatchingConfig`, `DndConfig`, `FatigueConfig`, `CrossRequestConfig`
   - Acceptance criteria: All types match TDD Section 3.5 contracts; `DeliveryAdapter` interface has `deliver()` and `deliverBatch()` methods
   - Estimated effort: 3 hours

8. **Implement CLI Delivery Adapter** -- Formatted text output to stdout.
   - Files to create: `src/notifications/adapters/cli-adapter.ts`
   - Formats notification payload as human-readable console output
   - Color-coded by urgency (red for immediate, yellow for soon, default for informational)
   - Always available (no external dependencies)
   - `deliverBatch()` outputs grouped summary
   - Acceptance criteria: Payloads rendered as readable text; urgency color-coded; batch output grouped by request ID and event type
   - Estimated effort: 3 hours

9. **Implement Discord Delivery Adapter** -- Discord embed JSON formatter.
   - Files to create: `src/notifications/adapters/discord-adapter.ts`
   - Formats notification as Discord embed JSON with fields, color-coded by urgency
   - Produces payload only; does not make HTTP calls (platform layer handles transport)
   - `deliverBatch()` produces a single embed with multiple fields
   - Acceptance criteria: Output is valid Discord embed JSON; color matches urgency; batch produces consolidated embed
   - Estimated effort: 3 hours

10. **Implement Slack Delivery Adapter** -- Slack Block Kit JSON formatter.
    - Files to create: `src/notifications/adapters/slack-adapter.ts`
    - Formats notification as Slack Block Kit JSON with section blocks and mrkdwn formatting
    - Produces payload only; does not make HTTP calls
    - `deliverBatch()` produces a single message with multiple sections
    - Acceptance criteria: Output is valid Slack Block Kit JSON; mrkdwn formatting correct; batch produces consolidated message
    - Estimated effort: 3 hours

11. **Implement File Drop Delivery Adapter** -- Raw JSON file writer.
    - Files to create: `src/notifications/adapters/file-drop-adapter.ts`
    - Writes notification payload as a JSON file to configured directory
    - File named: `<notification_id>.json`
    - `deliverBatch()` writes a single file with array of payloads
    - Acceptance criteria: JSON file written atomically; file name matches notification ID; batch file contains array
    - Estimated effort: 2 hours

12. **Implement Delivery Manager with Fallback Chain** -- Orchestrate delivery with fallback.
    - Files to create: `src/notifications/delivery-manager.ts`
    - Fallback chain per TDD Section 3.5.1: configured method -> CLI -> file_drop
    - If all methods fail, signal pipeline to pause (per NFR-10)
    - Accepts per-event-type delivery method overrides from config
    - Acceptance criteria: Configured method tried first; CLI fallback on failure; file_drop as last resort; pipeline pauses if all fail; per-type overrides respected
    - Estimated effort: 4 hours

13. **Implement Notification Batcher** -- Buffer and flush non-urgent notifications.
    - Files to create: `src/notifications/batcher.ts`
    - Per TDD Section 3.5.2: `immediate` urgency never batched; exempt types never batched; buffer flushed at interval (default 60 min) or max size (default 50); flushed batch grouped by request ID and event type
    - Acceptance criteria: Exempt types bypass buffer; buffer flushed at interval; buffer flushed at max size; batch output grouped correctly; timer is cancellable for cleanup
    - Estimated effort: 4 hours

14. **Implement DND Filter** -- Suppress non-immediate notifications during DND hours.
    - Files to create: `src/notifications/dnd-filter.ts`
    - Per TDD Section 3.5.3: during DND window, only `immediate` urgency breaks through; all others queued and delivered when DND ends
    - Supports overnight windows crossing midnight (e.g., 22:00 to 07:00)
    - Timezone-aware evaluation using configured timezone
    - Acceptance criteria: Non-immediate notifications suppressed during DND; immediate notifications break through; overnight windows work correctly; post-DND flush delivers queued notifications; timezone conversion correct
    - Estimated effort: 4 hours

15. **Implement Fatigue Detector** -- Monitor notification volume and switch to digest mode.
    - Files to create: `src/notifications/fatigue-detector.ts`
    - Per TDD Section 3.5.4: 1-hour sliding window per recipient; threshold (default 20/hour); when fatigued, send meta-notification, buffer for cooldown (default 30 min), then flush as digest
    - Acceptance criteria: Threshold triggers digest mode; meta-notification sent; cooldown period respected; digest flushed after cooldown; window expiration resets count; immediate-urgency notifications never suppressed by fatigue
    - Estimated effort: 4 hours

16. **Implement Systemic Failure Detector** -- Correlate failures across requests.
    - Files to create: `src/notifications/systemic-failure-detector.ts`
    - Per TDD Section 3.5.5: three patterns (same repo, same phase, same failure type); configurable window (default 60 min) and threshold (default 3)
    - When alert fires: suppress individual pending escalation notifications, emit single `systemic_issue` notification with `immediate` urgency, log `systemic_issue_detected` audit event
    - Acceptance criteria: Per-repo pattern detected; per-phase pattern detected; per-type pattern detected; window expiration prunes old records; individual notifications suppressed when systemic alert fires; systemic alert has correct summary with counts and affected requests
    - Estimated effort: 6 hours

17. **Implement NotificationFramework class (main facade)** -- Orchestrates all notification components.
    - Files to create: `src/notifications/notification-framework.ts`
    - Public API: `emit(payload): void` -- routes through DND filter, fatigue detector, batcher, and delivery manager
    - Wires: DND check -> fatigue check -> batch or deliver -> delivery manager with fallback
    - Daily digest generation at configured time
    - Acceptance criteria: Full notification flow works for all urgency levels; DND, fatigue, and batching interact correctly; daily digest generated
    - Estimated effort: 4 hours

18. **Implement Audit Trail Engine class (main facade)** -- Orchestrates event writer, hash chain, and decision replay.
    - Files to create: `src/audit/audit-trail-engine.ts`
    - Public API: `append(event): void`, `replay(requestId): AuditEvent[]`, `verify(): VerificationResult`
    - Implements the `AuditTrail` interface consumed by all other plans
    - Acceptance criteria: Events appended correctly; replay returns filtered events; verify validates hash chain; interface satisfies all consumers (trust engine, escalation engine, kill switch)
    - Estimated effort: 3 hours

19. **Implement configuration loaders** -- Parse `audit:` and `notifications:` config sections.
    - Files to create/modify: `src/audit/audit-config.ts`, `src/notifications/notification-config.ts`
    - All fields from TDD Sections 4.3 and 4.4
    - Acceptance criteria: Valid configs load; invalid configs fall back to defaults; immutable fields enforced
    - Estimated effort: 3 hours

20. **Implement barrel exports** -- Create module indexes.
    - Files to create: `src/audit/index.ts`, `src/notifications/index.ts`
    - Acceptance criteria: Clean imports; all dependencies injectable
    - Estimated effort: 1 hour

21. **Unit tests for Audit Trail** -- Cover TDD Section 8.1 audit test focus areas.
    - Files to create: `src/audit/__tests__/event-writer.test.ts`, `src/audit/__tests__/hash-chain.test.ts`, `src/audit/__tests__/hash-verifier.test.ts`, `src/audit/__tests__/decision-replay.test.ts`, `src/audit/__tests__/log-archival.test.ts`
    - Test focus: append-only semantics, correct field population, hash chain computation, valid chain passes, tampered event detected, deleted event detected, reordered events detected
    - Acceptance criteria: 100% branch coverage on audit code
    - Estimated effort: 8 hours

22. **Unit tests for Notification Framework** -- Cover TDD Section 8.1 notification test focus areas.
    - Files to create: `src/notifications/__tests__/batcher.test.ts`, `src/notifications/__tests__/dnd-filter.test.ts`, `src/notifications/__tests__/fatigue-detector.test.ts`, `src/notifications/__tests__/systemic-failure-detector.test.ts`, `src/notifications/__tests__/delivery-manager.test.ts`
    - Test focus: exempt types bypass buffer, buffer flushed at interval and max size, DND suppression with immediate breakthrough, post-DND flush, fatigue threshold and cooldown, systemic pattern detection and window expiration
    - Acceptance criteria: 100% branch coverage on notification code
    - Estimated effort: 8 hours

23. **Integration tests** -- End-to-end audit and notification scenarios.
    - Files to create: `src/audit/__tests__/audit-trail.integration.test.ts`, `src/notifications/__tests__/notification-framework.integration.test.ts`
    - Scenarios from TDD Section 8.2: event log hash chain verification (clean and tampered); notification fatigue -> digest mode switch; 3 failures in same repo within window -> systemic alert
    - Acceptance criteria: All scenarios pass; hash chain verification works end-to-end; fatigue detection triggers correctly; systemic alert suppresses individual notifications
    - Estimated effort: 6 hours

## Dependencies & Integration Points

- **PLAN-009-1 (Trust Engine)**: Emits `trust_level_change_requested`, `trust_level_changed`, `gate_decision` events via the `AuditTrail` interface this plan implements.
- **PLAN-009-2 (Escalation Engine)**: Emits `escalation_raised`, `escalation_timeout` events. Sends escalation notifications via the notification framework.
- **PLAN-009-3 (Response Handler)**: Emits `escalation_resolved`, `human_override` events. Triggers re-escalation notifications.
- **PLAN-009-4 (Kill Switch)**: Emits `kill_issued`, `cancel_issued`, `pause_issued`, `resume_issued`, `system_reenabled` events. Sends immediate-urgency kill notifications.
- **Platform Layer**: Delivery adapters produce formatted payloads. The platform layer (or third-party integrations) handles actual transport to Slack/Discord APIs.

## Testing Strategy

- **Unit tests**: Each component tested in isolation. Mock file system for event writer. Mock clock/timer for batcher, DND, and fatigue detector. Mock delivery adapters.
- **Integration tests**: Wire real audit trail components and notification components. Run end-to-end scenarios with file system assertions.
- **Property-based testing**: For hash chain, generate random event sequences and verify chain integrity holds.
- **Concurrency testing**: Verify that concurrent event writes are serialized correctly via the mutex.
- **Fallback testing**: Verify delivery fallback chain by simulating adapter failures.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Event log file grows unbounded without archival | Medium | Medium | Archival moves old events to cold storage. Default active retention is 90 days. Log size monitored. |
| Concurrent writes cause contention on file-level mutex | Low | Low | Lock is held only for append+fsync (microseconds). At 100 events/second (NFR target), contention is negligible. |
| DND timezone handling edge cases (DST transitions) | Medium | Low | Use a well-tested timezone library (e.g., Luxon or date-fns-tz). Integration tests cover DST transition dates. |
| Systemic failure detector false positives | Medium | Medium | Threshold and window are configurable. Default values (3 failures in 60 minutes) are conservative. False positives are logged and can be tuned. |
| Notification fatigue meta-notification could itself be fatiguing | Low | Low | Meta-notification is sent once per fatigue trigger, not per suppressed notification. Cooldown prevents rapid cycling. |
| Hash chain backfill migration (Phase 3) may be slow for large logs | Low | Medium | Migration is a one-time operation. Can be run offline. Documented as a separate Phase 3 task. |

## Definition of Done

- [ ] All source files created and passing TypeScript compilation with strict mode
- [ ] Audit events appended atomically with `O_APPEND` and `fsync()`
- [ ] Concurrent writes serialized via file-level mutex
- [ ] All 17 audit event types correctly populated
- [ ] Hash chain computation matches TDD algorithm (disabled by default, enabled via config for Phase 3)
- [ ] Hash chain verification detects tampered, deleted, and reordered events
- [ ] Decision replay returns chronological events for a request ID
- [ ] Event log archival moves old events to archive path with chain head preserved
- [ ] All 4 delivery adapters produce correctly formatted output
- [ ] Delivery fallback chain works: configured -> CLI -> file_drop -> pipeline pause
- [ ] Notification batching buffers non-urgent notifications and flushes at interval or max size
- [ ] DND suppresses non-immediate notifications during configured hours (including overnight windows)
- [ ] Fatigue detection triggers digest mode at threshold with meta-notification and cooldown
- [ ] Systemic failure detection correlates by repo, phase, and type with configurable window and threshold
- [ ] Systemic alert suppresses individual notifications and emits single immediate alert
- [ ] All unit tests pass with 100% branch coverage
- [ ] All integration test scenarios pass
- [ ] `AuditTrail` interface satisfies all consumer plans (PLAN-009-1 through PLAN-009-4)
