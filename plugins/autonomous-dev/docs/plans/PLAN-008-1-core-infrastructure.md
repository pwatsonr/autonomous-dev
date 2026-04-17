# PLAN-008-1: Core Infrastructure & Shared Services

## Metadata
- **Parent TDD**: TDD-008-intake-layer
- **Estimated effort**: 8 days
- **Dependencies**: None (foundational)
- **Blocked by**: None
- **Priority**: P0

## Objective

Build the foundational layer that all adapters and higher-level features depend on: the SQLite database schema, data access layer, IntakeAdapter interface, IntakeRouter with command dispatch, AuthzEngine (RBAC with repo-scoped permissions), RateLimiter, prompt injection sanitizer, request parsing pipeline, priority queue with starvation prevention, and the internal event contract. This plan delivers a fully functional core that can accept, authorize, queue, and manage requests -- but without any channel adapter wired up yet.

## Scope

### In Scope
- SQLite schema creation (all tables: `requests`, `request_embeddings`, `conversation_messages`, `user_identities`, `activity_log`, `authz_audit_log`, `rate_limit_actions`, `notification_deliveries`, `id_counter`) with WAL mode
- Migration framework for versioned schema changes
- `Repository` data access layer (CRUD for all tables)
- `IntakeAdapter` interface definition and all shared type definitions (`IncomingCommand`, `CommandSource`, `MessageTarget`, `FormattedMessage`, `StructuredPrompt`, `UserResponse`, `TimeoutExpired`, `DeliveryReceipt`, `ChannelType`)
- `IntakeRouter` with command handler registration, dispatch pipeline (resolve user -> authorize -> rate limit -> execute)
- All 10 `CommandHandler` implementations (submit, status, list, cancel, pause, resume, priority, logs, feedback, kill)
- `AuthzEngine` with YAML config loading, hot-reload via `fs.watchFile`, role hierarchy, repo-scoped permission overrides, author-of-request special case, and review gate approval
- `RateLimiter` with sliding window counter algorithm backed by SQLite
- `Sanitizer` with externalized `injection-rules.yaml` rule set (block/flag/escape actions)
- NLP parser integration (Claude API structured extraction with `ParsedRequest` schema)
- Ambiguity detector with clarifying question generation (5-round max)
- Duplicate detector with local `all-MiniLM-L6-v2` embeddings via `@xenova/transformers`
- `RequestQueue` with priority ordering, FIFO within priority, depth enforcement (max 50), and estimated wait time
- Starvation prevention background timer (15-minute interval, promotion logic)
- Request ID generation (`REQ-NNNNNN` atomic counter)
- State machine validation for all request state transitions
- Authorization audit logging (SQLite + structured JSON)
- Internal event contract types (`IntakeEvent` and `PipelineEvent` discriminated unions)
- Error response format and error code enum
- Description length enforcement
- `intake-auth.yaml` configuration file schema and loader
- `intake-config.yaml` configuration file schema with `${ENV_VAR}` resolution
- Graceful shutdown framework (`SIGTERM` handler, WAL checkpoint)
- Unit tests for all core components (see Testing Strategy)
- Integration tests for submit flow, authorization chain, starvation promotion, and full lifecycle

### Out of Scope
- Claude App adapter (slash command registration, CLI formatting) -- PLAN-008-2
- Discord adapter and bot -- PLAN-008-3
- Slack adapter and bot -- PLAN-008-4
- NotificationEngine, formatters, digest scheduler -- PLAN-008-5
- ConversationManager, TimeoutHandler, bidirectional communication -- PLAN-008-5
- File attachment support (TQ-1, deferred)
- Multi-repo requests (TQ-6, deferred)
- Request watchers (TQ-9, deferred)
- Multi-level escalation chains (TQ-4, deferred)

## Tasks

1. **Define TypeScript interfaces and shared types** -- Create all shared type definitions from TDD sections 3.1, 3.5.1, 5.3, and 6.2.
   - Files to create: `intake/adapters/adapter_interface.ts`
   - Acceptance criteria: `IntakeAdapter`, `ChannelType`, `AdapterHandle`, `MessageTarget`, `FormattedMessage`, `StructuredPrompt`, `PromptOption`, `UserResponse`, `TimeoutExpired`, `DeliveryReceipt`, `IncomingCommand`, `CommandSource` all exported with JSDoc
   - Estimated effort: 3 hours

2. **Create SQLite schema and migration framework** -- Implement the full DDL from TDD section 4.1 with a migration runner that tracks applied migrations in a `_migrations` table.
   - Files to create: `intake/db/schema.sql`, `intake/db/migrations/001_initial.sql`, `intake/db/migrator.ts`
   - Acceptance criteria: WAL mode enabled, foreign keys ON, all tables created with correct constraints and indexes, migration runner is idempotent
   - Estimated effort: 4 hours

3. **Build Repository data access layer** -- Typed CRUD operations for all tables, parameterized queries, transaction support.
   - Files to create: `intake/db/repository.ts`
   - Acceptance criteria: Methods for `insertRequest`, `getRequest`, `updateRequest`, `getQueuedRequestCount`, `getQueuePosition`, `insertConversationMessage`, `markMessageResponded`, `insertActivityLog`, `insertAuditLog`, `countActions`, `recordAction`, `getRequestEmbeddings`, `countRequestsByState`, `getBlockedRequests`, `getCompletedSince`, `getQueuedCountByPriority`, `getAveragePipelineDuration`, `getMaxConcurrentSlots`, `checkpoint`
   - Estimated effort: 8 hours

4. **Implement Request ID generation** -- Atomic counter in SQLite per TDD section 4.2.
   - Files to create/modify: `intake/db/repository.ts`
   - Acceptance criteria: Generates `REQ-NNNNNN` format, atomic increment, no duplicate IDs under concurrent access
   - Estimated effort: 1 hour

5. **Implement AuthzEngine** -- RBAC authorization engine per TDD section 3.11.
   - Files to create: `intake/authz/authz_engine.ts`, `intake/authz/audit_logger.ts`
   - Acceptance criteria: Loads `intake-auth.yaml`, hot-reloads on file change (5s poll), role hierarchy (viewer < contributor < operator < admin), repo-scoped overrides, author-of-request special case, review gate approval, every decision logged to audit table and structured JSON
   - Estimated effort: 6 hours

6. **Implement RateLimiter** -- Sliding window counter per TDD section 3.12.
   - Files to create: `intake/rate_limit/rate_limiter.ts`
   - Acceptance criteria: Separate windows for submissions (1 hour) and queries (1 minute), role-based limit overrides, accurate `retryAfterMs` calculation, actions recorded in `rate_limit_actions` table
   - Estimated effort: 4 hours

7. **Implement Sanitizer** -- Prompt injection defense per TDD section 3.8.
   - Files to create: `intake/core/sanitizer.ts`, `intake/config/injection-rules.yaml`
   - Acceptance criteria: Loads rules from YAML, supports block/flag/escape actions, processes all 7 default rules (system_prompt_override, role_assumption, system_message_injection, template_delimiter, output_manipulation, instruction_injection, data_exfiltration), returns `SanitizationResult` with applied rules list
   - Estimated effort: 4 hours

8. **Implement NLP Parser** -- Claude API structured extraction per TDD section 3.5.1 stage 2.
   - Files to create: `intake/core/request_parser.ts`
   - Acceptance criteria: Sends user text as `user` message with extraction schema in `system` message (defense-in-depth), returns `ParsedRequest` with all fields, extracts `target_repo` from flags/URLs/known-repos/null, confidence score populated
   - Estimated effort: 5 hours

9. **Implement Ambiguity Detector** -- Per TDD section 3.5.1 stage 3.
   - Files to create/modify: `intake/core/request_parser.ts`
   - Acceptance criteria: Flags requests with confidence < 0.6, no target repo, or < 15 words without technical terms. Generates up to 3 clarifying questions via Claude. Tracks conversation round count (5-round max)
   - Estimated effort: 3 hours

10. **Implement Duplicate Detector** -- Local embeddings per TDD section 3.6.
    - Files to create: `intake/core/duplicate_detector.ts`
    - Acceptance criteria: Uses `all-MiniLM-L6-v2` via `@xenova/transformers`, stores embeddings as raw `Float32Array` BLOB, cosine similarity against candidates within lookback window (default 30 days), threshold default 0.85, returns top 5 matches, configurable enable/disable
    - Estimated effort: 6 hours

11. **Implement RequestQueue** -- Priority queue over `requests` table per TDD section 3.7.
    - Files to create: `intake/queue/request_queue.ts`, `intake/queue/starvation_monitor.ts`
    - Acceptance criteria: Priority ordering (high > normal > low) with FIFO within level, queue depth enforcement (configurable max, default 50), estimated wait time using rolling average of last 20 completions, starvation monitor runs every 15 minutes promoting low->normal and normal->high based on configurable threshold (default 48h), `promotion_count` and `last_promoted_at` tracked
    - Estimated effort: 5 hours

12. **Implement IntakeRouter and CommandHandlers** -- Central dispatch per TDD section 3.14.
    - Files to create: `intake/core/intake_router.ts`, `intake/handlers/submit_handler.ts`, `intake/handlers/status_handler.ts`, `intake/handlers/list_handler.ts`, `intake/handlers/cancel_handler.ts`, `intake/handlers/pause_handler.ts`, `intake/handlers/resume_handler.ts`, `intake/handlers/priority_handler.ts`, `intake/handlers/logs_handler.ts`, `intake/handlers/feedback_handler.ts`, `intake/handlers/kill_handler.ts`
    - Acceptance criteria: Router resolves user identity, checks authz, checks rate limit, then dispatches to handler. Each handler implements `CommandHandler` interface. State machine validation on all state-mutating handlers. `KillHandler` requires admin + typed "CONFIRM". `CancelHandler` prompts for confirmation. Error responses use consistent `ErrorResponse` format with correct error codes
    - Estimated effort: 10 hours

13. **Implement state machine validation** -- Per TDD section 6.3.
    - Files to create/modify: `intake/core/intake_router.ts`
    - Acceptance criteria: All valid transitions allowed (queued->cancel/priority, active->cancel/pause/feedback, paused->cancel/resume, failed->resume/cancel), all invalid transitions return `INVALID_STATE` error code
    - Estimated effort: 2 hours

14. **Implement internal event contract** -- Typed event bus per TDD section 5.3.
    - Files to create: `intake/events/event_types.ts`, `intake/events/event_bus.ts`
    - Acceptance criteria: `IntakeEvent` and `PipelineEvent` discriminated unions defined, simple EventEmitter-based bus with typed subscribe/emit, events emitted by all relevant handlers
    - Estimated effort: 3 hours

15. **Implement graceful shutdown** -- Per TDD section 3.13.3.
    - Files to create/modify: `intake/core/shutdown.ts`
    - Acceptance criteria: `SIGTERM` handler stops accepting new commands, waits for current command to finish, flushes WAL checkpoint, exits cleanly
    - Estimated effort: 2 hours

16. **Write unit test suite** -- Per TDD section 8.1.
    - Files to create: `intake/__tests__/sanitizer.test.ts`, `intake/__tests__/authz_engine.test.ts`, `intake/__tests__/rate_limiter.test.ts`, `intake/__tests__/duplicate_detector.test.ts`, `intake/__tests__/request_parser.test.ts`, `intake/__tests__/request_queue.test.ts`, `intake/__tests__/state_machine.test.ts`, `intake/__tests__/intake_router.test.ts`
    - Acceptance criteria: 100% coverage on parseCommandArgs, sanitizer rules, authz permission matrix, rate limiter edge cases, cosine similarity, starvation promotion, and state transitions
    - Estimated effort: 8 hours

17. **Write integration test suite** -- Per TDD section 8.2.
    - Files to create: `intake/__tests__/integration/submit_flow.test.ts`, `intake/__tests__/integration/authz_chain.test.ts`, `intake/__tests__/integration/starvation.test.ts`, `intake/__tests__/integration/full_lifecycle.test.ts`
    - Acceptance criteria: Submit flow creates request with ID/queue position/embedding. Auth chain verifies each role. Starvation promotion fires at correct time. Full lifecycle covers submit->status->pause->resume->cancel with audit trail
    - Estimated effort: 6 hours

18. **Write security test suite** -- Per TDD section 8.4.
    - Files to create: `intake/__tests__/security/injection_corpus.test.ts`, `intake/__tests__/security/authz_boundary.test.ts`, `intake/__tests__/security/rate_limit.test.ts`, `intake/__tests__/security/state_transition.test.ts`
    - Acceptance criteria: 50+ injection patterns tested against sanitizer. Every role/action combination tested. Rapid-fire rate limit enforcement verified. Invalid state transitions rejected
    - Estimated effort: 4 hours

## Dependencies & Integration Points

- **Pipeline Core (TDD-001)**: The internal event contract (`IntakeEvent` / `PipelineEvent`) must align with the pipeline core's event system. If TDD-001 is not yet implemented, define the contract as an interface that the pipeline core will implement.
- **Claude API access**: The NLP parser and ambiguity detector require Claude API access for structured extraction and clarifying question generation.
- **`@xenova/transformers`**: NPM dependency for local embedding model (`all-MiniLM-L6-v2`). ~50MB model download on first run.
- **`better-sqlite3` or equivalent**: NPM dependency for SQLite with WAL mode support.
- **`js-yaml`**: NPM dependency for YAML config file loading.

## Testing Strategy

- **Unit tests**: All pure logic components (sanitizer, authz, rate limiter, cosine similarity, state machine, queue ordering, starvation promotion) tested in isolation with deterministic inputs. Mock the database for handler tests.
- **Integration tests**: Use a real in-memory SQLite database. Test full command flows end-to-end through the router (sans adapter layer). Verify database state after each operation.
- **Security tests**: Maintain a corpus of 50+ injection patterns. Run the full authorization matrix. Verify rate limit enforcement under rapid fire.
- **No adapter mocking needed**: This plan tests the core without any channel adapter, so no Discord/Slack mocking is required.

## Risks

1. **`@xenova/transformers` model download**: The 50MB model file must be downloaded on first run. Risk: slow CI, flaky in network-restricted environments. Mitigation: cache the model in CI artifacts; provide a `--skip-embedding` flag for environments where duplicate detection is not needed.
2. **SQLite WAL mode on NFS**: If the data directory is on a network filesystem, WAL mode may not work correctly. Mitigation: document requirement for local filesystem; detect NFS and warn at startup.
3. **Claude API dependency for NLP parser**: If the Claude API is unreachable, the submit flow fails. Mitigation: implement a fallback that uses the raw description as-is (with reduced confidence), flagging for later re-parse.
4. **Hot-reload race condition**: `fs.watchFile` polling interval (5s) means a brief window where the old config is active. Mitigation: acceptable for auth config changes; document that changes take up to 5 seconds to propagate.

## Definition of Done

- [ ] All SQLite tables created with correct constraints and indexes; WAL mode enabled
- [ ] Migration framework runs idempotently; `001_initial.sql` applied on first startup
- [ ] Repository layer has typed CRUD for all tables with parameterized queries
- [ ] `IntakeAdapter` interface and all shared types exported and documented
- [ ] `AuthzEngine` loads YAML config, hot-reloads, enforces full RBAC matrix including repo overrides and author special case
- [ ] `RateLimiter` enforces sliding window limits per action type with role overrides
- [ ] `Sanitizer` loads external YAML rules and correctly blocks/flags/escapes per rule action
- [ ] NLP parser extracts `ParsedRequest` from natural language via Claude API with defense-in-depth message separation
- [ ] Ambiguity detector flags vague requests and generates clarifying questions (max 5 rounds)
- [ ] Duplicate detector uses local embeddings, stores in BLOB, computes cosine similarity with configurable threshold
- [ ] Request queue enforces priority ordering, depth cap, and estimated wait time
- [ ] Starvation monitor promotes starving requests on schedule with relative timing
- [ ] `IntakeRouter` dispatches commands through authz -> rate limit -> handler pipeline
- [ ] All 10 command handlers implemented with state machine validation
- [ ] Internal event types defined; event bus emits events from all relevant handlers
- [ ] Graceful shutdown flushes WAL and stops cleanly on SIGTERM
- [ ] Error responses use consistent format with documented error codes
- [ ] Unit tests pass with >= 95% branch coverage on core logic
- [ ] Integration tests pass for submit flow, authz chain, starvation, and full lifecycle
- [ ] Security tests pass for injection corpus, authz boundary, and rate limit enforcement
