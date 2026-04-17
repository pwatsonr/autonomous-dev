# PLAN-008-5: Notification Engine & Bidirectional Communication

## Metadata
- **Parent TDD**: TDD-008-intake-layer
- **Estimated effort**: 7 days
- **Dependencies**: PLAN-008-1 (core infrastructure), PLAN-008-2 (Claude App adapter + CLI formatter), PLAN-008-3 (Discord adapter + embed formatter), PLAN-008-4 (Slack adapter + Block Kit formatter)
- **Blocked by**: PLAN-008-1, PLAN-008-2 (minimum viable; PLAN-008-3 and PLAN-008-4 can complete in parallel)
- **Priority**: P1

## Objective

Implement the proactive notification engine, daily digest scheduler, conversation manager for bidirectional mid-pipeline communication, timeout handler with escalation, and cross-channel notification routing. This plan wires together all adapters and formatters built in PLAN-008-2/3/4 into a unified notification and conversation system. It is the capstone plan that makes the intake layer truly operational -- pipelines can proactively push status updates, ask clarifying questions, handle timeouts, and deliver daily summaries across any channel.

## Scope

### In Scope
- `NotificationEngine` class: subscribes to pipeline phase-transition events, resolves notification targets, selects formatter per channel, delivers with retry per TDD section 3.9.1
- Verbosity filtering (`silent`, `summary`, `verbose`, `debug`) per TDD section 3.9.1
- Notification routing: per-request `NotificationConfig` with multiple routes, each specifying channel type, platform channel ID, thread ID, and optional phase filter per TDD section 3.9.2
- Cross-channel notification: a request submitted on one channel can push notifications to a different channel (e.g., submit in Slack, notify in Discord) per TDD section 3.9.2
- Delivery with retry: exponential backoff (1s, 2s, 4s), max 3 retries, non-retryable errors logged and abandoned per TDD section 3.9.1
- `notification_deliveries` table integration for at-least-once delivery tracking
- `DigestScheduler`: cron-like timer for daily digest generation and delivery per TDD section 3.9.3
- Digest content: active requests by state, blocked requests, completed in last 24h, queue depth by priority per TDD section 3.9.3
- Digest formatting per channel (CLI plain text, Discord embed, Slack Block Kit)
- `ConversationManager` class: tracks all human-system exchanges per request, sends structured prompts, records inbound/outbound messages per TDD section 3.10.1
- `promptAndWait` flow: send prompt via adapter, wait for response or timeout, record messages in `conversation_messages` table per TDD section 3.10.1
- `receiveFeedback` flow: accept unsolicited feedback, record in conversation messages, emit `feedback_received` event for pipeline context injection per TDD section 3.10.1
- `TimeoutHandler`: handles human response timeout with configurable action (pause, proceed-with-default, escalate) per TDD section 3.10.2
- Escalation: notify escalation target when original requester times out per TDD section 3.10.2
- Pipeline event subscription: `PhaseTransitionEvent`, `blocker_detected`, `human_input_needed`, `request_completed`, `request_failed` per TDD section 5.3
- Activity logging for all notification events
- Unit tests for notification engine, digest scheduler, conversation manager, and timeout handler
- Integration tests for notification delivery, cross-channel routing, conversation flow, and timeout escalation
- End-to-end cross-channel test suite

### Out of Scope
- Adapter implementations (already built in PLAN-008-2/3/4)
- Formatter implementations (already built in PLAN-008-2/3/4)
- Core infrastructure (already built in PLAN-008-1)
- File attachment support (TQ-1, deferred)
- Request watchers / notification fan-out (TQ-9, deferred)
- Multi-level escalation chains (TQ-4, single-level only)
- Notification batching / throttling beyond retry (future optimization)

## Tasks

1. **Implement NotificationEngine class** -- Core notification dispatcher per TDD section 3.9.1.
   - Files to create: `intake/notifications/notification_engine.ts`
   - Acceptance criteria: Constructor receives `Repository`, `Map<ChannelType, IntakeAdapter>`, `Map<ChannelType, NotificationFormatter>`. `onPhaseTransition` method: fetches request, checks verbosity filter, resolves targets from `notification_config.routes`, formats per target channel, delivers with retry. Activity log entry created for each notification. Handles adapter unavailability gracefully (log error, do not crash).
   - Estimated effort: 6 hours

2. **Implement verbosity filtering** -- Per TDD section 3.9.1.
   - Files to create/modify: `intake/notifications/notification_engine.ts`
   - Acceptance criteria: `shouldNotify(verbosity, event)` returns: `false` for `silent`, `true` for phase transitions only for `summary`, `true` for phase transitions + sub-steps for `verbose`, `true` for everything for `debug`. Default verbosity is `summary`. Verbosity configurable per request in `notification_config`.
   - Estimated effort: 2 hours

3. **Implement notification routing** -- Per TDD section 3.9.2.
   - Files to create/modify: `intake/notifications/notification_engine.ts`
   - Acceptance criteria: `resolveTargets(request, config)` reads `notification_config.routes` and constructs `MessageTarget[]`. Each route can specify `channelType`, `platformChannelId`, `threadId`, and `events` filter (only notify for specific phases). If no routes configured, defaults to the request's `source_channel`. Cross-channel routing works (e.g., Slack source -> Discord notification).
   - Estimated effort: 3 hours

4. **Implement delivery with retry** -- Per TDD section 3.9.1.
   - Files to create/modify: `intake/notifications/notification_engine.ts`
   - Acceptance criteria: `deliverWithRetry(adapter, target, message, maxRetries=3)` attempts delivery, retries on `retryable` failures with exponential backoff (1s, 2s, 4s). On non-retryable failure, logs to activity log and stops. On success, updates `notification_deliveries` table status to `delivered`. Tracks `attempts` count. `payload_hash` (SHA-256) used for deduplication.
   - Estimated effort: 3 hours

5. **Implement DigestScheduler** -- Per TDD section 3.9.3.
   - Files to create: `intake/notifications/digest_scheduler.ts`
   - Acceptance criteria: `start(config)` calculates ms until next scheduled time (`daily_digest_time` from config, e.g., "09:00"), sets a `setTimeout`, sends digest, then reschedules for next day. `buildDigest()` queries: active requests by state, blocked requests, completed in last 24h, queue depth, queue depth by priority. `stop()` clears the timer.
   - Estimated effort: 4 hours

6. **Implement digest formatting for each channel** -- Extend existing formatters.
   - Files to modify: `intake/notifications/formatters/cli_formatter.ts`, `intake/notifications/formatters/discord_formatter.ts`, `intake/notifications/formatters/slack_formatter.ts`
   - Acceptance criteria: Each formatter's `formatDigest(digest)` method produces channel-appropriate output. CLI: plain text table with counts and blocked request callouts. Discord: embed with fields for each category, color-coded. Slack: Block Kit with header, section fields, and conditional blocker warning. Handles empty digest (no activity in 24h) gracefully. Respects platform limits (Discord 6000 chars, Slack 3000 chars per block) with pagination into multiple messages if needed.
   - Estimated effort: 4 hours

7. **Implement ConversationManager class** -- Per TDD section 3.10.1.
   - Files to create: `intake/conversation/conversation_manager.ts`
   - Acceptance criteria: Constructor receives `Repository`, `Map<ChannelType, IntakeAdapter>`, `TimeoutHandler`. `promptAndWait(requestId, prompt)`: fetches request, records outbound message with `timeout_at`, sends via adapter's `promptUser`, handles response or timeout. `receiveFeedback(requestId, userId, message)`: records inbound message, emits `feedback_received` event. Tracks conversation round count per request for 5-round clarification limit.
   - Estimated effort: 6 hours

8. **Implement TimeoutHandler** -- Per TDD section 3.10.2.
   - Files to create: `intake/conversation/timeout_handler.ts`
   - Acceptance criteria: `handle(requestId, messageId)` reads timeout config (`human_response_action`). For `pause`: pauses request, notifies requester with resume instructions. For `default`: signals pipeline to proceed with conservative default, notifies requester. For `escalate`: looks up `escalation_target` for the request, notifies escalation target with full conversation history. Activity log entry created for timeout. Throws `TimeoutError`.
   - Estimated effort: 4 hours

9. **Wire pipeline event subscription** -- Subscribe NotificationEngine and ConversationManager to pipeline events.
   - Files to create: `intake/notifications/event_subscriber.ts`
   - Acceptance criteria: Subscribes to `PhaseTransitionEvent` -> `NotificationEngine.onPhaseTransition`. Subscribes to `blocker_detected` -> notification with blocker details. Subscribes to `human_input_needed` -> `ConversationManager.promptAndWait`. Subscribes to `request_completed` -> final success notification. Subscribes to `request_failed` -> failure notification with error summary. All subscriptions registered on startup, unsubscribed on shutdown.
   - Estimated effort: 3 hours

10. **Implement cross-channel notification integration test** -- Verify cross-channel routing.
    - Files to create: `intake/__tests__/integration/cross_channel.test.ts`
    - Acceptance criteria: Submit request via Claude App adapter with `notification_config` routing to Discord and Slack. Trigger a phase transition event. Verify that Discord adapter receives embed-formatted message and Slack adapter receives Block Kit message. Verify that CLI adapter also receives notification (source channel default).
    - Estimated effort: 3 hours

11. **Write NotificationEngine unit tests** -- Test core notification logic.
    - Files to create: `intake/__tests__/notifications/notification_engine.test.ts`
    - Acceptance criteria: Verbosity filtering tested for all 4 levels. Route resolution tested with single route, multiple routes, cross-channel, and default fallback. Delivery retry tested: success on first attempt, success on retry, failure after max retries, non-retryable failure. Deduplication via `payload_hash` tested. Activity logging verified.
    - Estimated effort: 4 hours

12. **Write DigestScheduler unit tests** -- Test digest generation and scheduling.
    - Files to create: `intake/__tests__/notifications/digest_scheduler.test.ts`
    - Acceptance criteria: Digest content queries verified (mocked DB). Scheduling calculates correct next-run time. Empty digest handled. Formatter called with correct channel type. Timer cleared on `stop()`.
    - Estimated effort: 2 hours

13. **Write ConversationManager unit tests** -- Test conversation flow and timeout.
    - Files to create: `intake/__tests__/conversation/conversation_manager.test.ts`
    - Acceptance criteria: `promptAndWait` records outbound message, calls adapter `promptUser`, records inbound response. Timeout triggers `TimeoutHandler.handle`. `receiveFeedback` records message and emits event. 5-round clarification limit enforced (6th round returns error). Conversation messages stored with correct `thread_id`.
    - Estimated effort: 4 hours

14. **Write TimeoutHandler unit tests** -- Test all timeout actions.
    - Files to create: `intake/__tests__/conversation/timeout_handler.test.ts`
    - Acceptance criteria: `pause` action pauses request and notifies. `default` action signals pipeline proceed and notifies. `escalate` action looks up escalation target and notifies with conversation history. Activity log entry created. `TimeoutError` thrown.
    - Estimated effort: 3 hours

15. **Write notification delivery integration tests** -- Per TDD section 8.2.
    - Files to create: `intake/__tests__/integration/notification_delivery.test.ts`
    - Acceptance criteria: Mock adapters, real NotificationEngine. Correct formatter called per channel type. Retry on adapter failure verified. At-least-once delivery verified via `notification_deliveries` table. Multiple routes delivered independently.
    - Estimated effort: 3 hours

16. **Write conversation timeout integration tests** -- Per TDD section 8.2.
    - Files to create: `intake/__tests__/integration/conversation_timeout.test.ts`
    - Acceptance criteria: Mock adapter with delayed response (beyond timeout). Verify timeout action triggered: `pause` -> request status is `paused`; `default` -> pipeline proceed signal emitted; `escalate` -> escalation target notified.
    - Estimated effort: 3 hours

## Dependencies & Integration Points

- **PLAN-008-1 (Core Infrastructure)**: Repository, event bus, event types, all shared types.
- **PLAN-008-2 (Claude App Adapter)**: `ClaudeAdapter` instance and `CLIFormatter` for CLI channel notifications and prompts. Must be complete for the minimum viable notification system.
- **PLAN-008-3 (Discord Adapter)**: `DiscordAdapter` instance and `DiscordFormatter` for Discord channel notifications and prompts. Can complete in parallel; Discord notifications are wired when the adapter is available.
- **PLAN-008-4 (Slack Adapter)**: `SlackAdapter` instance and `SlackFormatter` for Slack channel notifications and prompts. Can complete in parallel; Slack notifications are wired when the adapter is available.
- **Pipeline Core (TDD-001)**: The notification engine subscribes to pipeline events (`PhaseTransitionEvent`, `blocker_detected`, `human_input_needed`, `request_completed`, `request_failed`). If the pipeline core is not yet implemented, use the event bus interface and mock events in tests.

## Testing Strategy

- **Unit tests**: Mock all adapters and formatters. Test NotificationEngine logic (verbosity, routing, retry, dedup) in isolation. Test DigestScheduler timing and content. Test ConversationManager flow and round counting. Test TimeoutHandler for all three action types.
- **Integration tests**: Use real SQLite database with mock adapters. Verify end-to-end notification delivery, cross-channel routing, conversation persistence, and timeout behavior.
- **Cross-channel tests**: Submit on one channel, verify notifications delivered to another. This is the key differentiating test for this plan.
- **Load test awareness**: The `notification_deliveries` table and retry logic should handle 1000 deliveries/minute without platform rate limit violations (tested via mock adapters counting calls).

## Risks

1. **Pipeline core not yet implemented**: The notification engine subscribes to pipeline events. If the pipeline core is incomplete, we can only test with mock events. Mitigation: define the event contract clearly (already in PLAN-008-1); use mock events in all tests; integrate with real pipeline when available.
2. **Digest timer drift**: `setTimeout` for daily digest can drift due to Node.js event loop delays. Mitigation: recalculate the next run time after each execution; log actual vs scheduled execution time for monitoring.
3. **Cross-channel adapter availability**: If one adapter fails to start (e.g., Discord bot token invalid), notifications to that channel should degrade gracefully. Mitigation: NotificationEngine checks adapter availability before delivery; logs warning and skips unavailable channels; does not crash.
4. **Timeout race condition**: A user might respond just as the timeout fires. Mitigation: use `responded` flag in the database as the source of truth; check flag before executing timeout action; if already responded, discard the timeout.
5. **Escalation target not configured**: If no `escalation_target` is defined for a user and the timeout action is `escalate`, the system must handle this. Mitigation: fall back to `pause` action if no escalation target; log a warning.

## Definition of Done

- [ ] `NotificationEngine` subscribes to pipeline events and dispatches formatted notifications to correct channels
- [ ] Verbosity filtering works for all 4 levels (`silent`, `summary`, `verbose`, `debug`)
- [ ] Notification routing supports multiple routes per request, cross-channel delivery, and phase-specific filtering
- [ ] Delivery retry with exponential backoff handles transient failures; non-retryable failures logged
- [ ] `notification_deliveries` table tracks at-least-once delivery with deduplication via payload hash
- [ ] `DigestScheduler` generates and delivers daily digest at configured time with correct content
- [ ] Digest formatted appropriately per channel (CLI, Discord embed, Slack Block Kit) with pagination for large digests
- [ ] `ConversationManager.promptAndWait` sends structured prompts, records messages, handles responses and timeouts
- [ ] `ConversationManager.receiveFeedback` records feedback and emits event for pipeline context injection
- [ ] 5-round clarification limit enforced
- [ ] `TimeoutHandler` executes correct action (`pause`, `default`, `escalate`) per configuration
- [ ] Escalation notifies the configured target with full conversation history
- [ ] Pipeline event subscribers wired for all event types
- [ ] Cross-channel notification verified (submit on Slack -> notify on Discord)
- [ ] All unit tests pass for notification engine, digest scheduler, conversation manager, and timeout handler
- [ ] Integration tests pass for notification delivery, cross-channel routing, conversation flow, and timeout escalation
- [ ] Activity logs created for all notification and conversation events
