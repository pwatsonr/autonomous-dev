# SPEC-008-1-06: IntakeRouter, Command Handlers & State Machine

## Metadata
- **Parent Plan**: PLAN-008-1
- **Tasks Covered**: Task 12, Task 13
- **Estimated effort**: 12 hours

## Description

Implement the central `IntakeRouter` with its command dispatch pipeline (resolve user -> authorize -> rate limit -> execute), all 10 `CommandHandler` implementations, and the state machine validation that governs which actions are valid in each request state.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/core/intake_router.ts` | Create |
| `intake/handlers/submit_handler.ts` | Create |
| `intake/handlers/status_handler.ts` | Create |
| `intake/handlers/list_handler.ts` | Create |
| `intake/handlers/cancel_handler.ts` | Create |
| `intake/handlers/pause_handler.ts` | Create |
| `intake/handlers/resume_handler.ts` | Create |
| `intake/handlers/priority_handler.ts` | Create |
| `intake/handlers/logs_handler.ts` | Create |
| `intake/handlers/feedback_handler.ts` | Create |
| `intake/handlers/kill_handler.ts` | Create |

## Implementation Details

### Task 12: IntakeRouter and CommandHandlers

**Router dispatch pipeline:**

```typescript
class IntakeRouter {
  private handlers: Map<string, CommandHandler> = new Map();

  constructor(
    private authz: AuthzEngine,
    private rateLimiter: RateLimiter,
    private db: Repository,
  ) {
    this.registerHandlers();
  }

  async route(command: IncomingCommand): Promise<CommandResult> {
    // Step 0: Lookup handler
    const handler = this.handlers.get(command.commandName);
    if (!handler) {
      return { success: false, error: `Unknown command: ${command.commandName}`, errorCode: 'VALIDATION_ERROR' };
    }

    // Step 1: Resolve internal user identity
    const userId = await this.resolveUserId(command.source);

    // Step 2: Authorization check
    const authzContext = handler.buildAuthzContext(command);
    const decision = await this.authz.authorize(userId, command.commandName as AuthzAction, authzContext);
    await this.db.insertAuditLog(decision);
    if (!decision.granted) {
      return { success: false, error: `Permission denied: ${decision.reason}`, errorCode: 'AUTHZ_DENIED' };
    }

    // Step 3: Rate limit check
    const actionType = handler.isQueryCommand() ? 'query' : 'submission';
    const rateResult = await this.rateLimiter.checkLimit(userId, actionType, ...);
    if (!rateResult.allowed) {
      return { success: false, error: rateResult.message, errorCode: 'RATE_LIMITED', retryAfterMs: rateResult.retryAfterMs };
    }

    // Step 4: Execute
    try {
      return await handler.execute(command, userId);
    } catch (error) {
      if (error instanceof InvalidStateError) {
        return { success: false, error: error.message, errorCode: 'INVALID_STATE' };
      }
      return { success: false, error: 'An internal error occurred.', errorCode: 'INTERNAL_ERROR' };
    }
  }
}
```

**Handler interface:**

```typescript
interface CommandHandler {
  execute(command: IncomingCommand, userId: string): Promise<CommandResult>;
  buildAuthzContext(command: IncomingCommand): AuthzContext;
  isQueryCommand(): boolean;
}
```

**Handler specifications:**

| Handler | Query? | Args | Flags | Key Behavior |
|---------|--------|------|-------|-------------|
| `SubmitHandler` | No | `description` | `--priority`, `--repo`, `--deadline`, `--force` | Validates description length, runs sanitizer -> NLP parser -> ambiguity detector -> duplicate detector -> enqueue. Returns `{ requestId, position, estimatedWait }`. |
| `StatusHandler` | Yes | `request-id` | (none) | Fetches request by ID, returns full status object with phase, progress, blocker, artifact links, age. Returns `NOT_FOUND` if missing. |
| `ListHandler` | Yes | (none) | `--priority`, `--status` | Queries active requests, applies filters, returns sorted array with queue depth count. |
| `CancelHandler` | No | `request-id` | (none) | Validates state (must be `queued`, `active`, or `paused`). Prompts for confirmation (returns `{ confirmationRequired: true }` on first call). On confirmation, sets status to `cancelled`, emits `request_cancelled` event. |
| `PauseHandler` | No | `request-id` | (none) | Validates state (must be `active`). Sets status to `paused`, records `paused_at_phase`. Emits `request_paused` event. |
| `ResumeHandler` | No | `request-id` | (none) | Validates state (must be `paused` or `failed`). Sets status back to `active` (paused) or `queued` (failed). Emits `request_resumed` event. |
| `PriorityHandler` | No | `request-id`, `level` | (none) | Validates state (must be `queued`). Validates level enum. Updates priority, recalculates queue position. Emits `priority_changed` event. |
| `LogsHandler` | Yes | `request-id` | `--all` | Fetches activity log entries. Default: last 50. `--all`: no limit. Returns formatted log array. |
| `FeedbackHandler` | No | `request-id`, `message` | (none) | Validates state (must be `active`). Records message via `ConversationManager.receiveFeedback`. Emits `feedback_received` event. |
| `KillHandler` | No | (none) | (none) | Requires `admin` role. First call returns `{ confirmationRequired: true, message: 'Type CONFIRM to proceed' }`. On confirmation (args[0] === 'CONFIRM'), pauses ALL active requests, emits `kill_all` event. |

**`buildAuthzContext` per handler:**
- Handlers that take a `request-id` extract `targetRepo` from the request entity.
- `SubmitHandler` extracts `targetRepo` from `--repo` flag.
- `KillHandler` returns empty context (admin-only, no request scope).
- `ListHandler`, `LogsHandler`, `StatusHandler` return empty context (viewer-allowed).

### Task 13: State Machine Validation

**Valid transitions table:**

| Current State | Allowed Actions |
|--------------|-----------------|
| `queued` | `cancel`, `priority` |
| `active` | `cancel`, `pause`, `feedback` |
| `paused` | `cancel`, `resume` |
| `failed` | `resume`, `cancel` |
| `cancelled` | (none -- terminal) |
| `done` | (none -- terminal) |

**Implementation:**

```typescript
const STATE_TRANSITIONS: Record<RequestStatus, string[]> = {
  queued:    ['cancel', 'priority'],
  active:    ['cancel', 'pause', 'feedback'],
  paused:    ['cancel', 'resume'],
  failed:    ['resume', 'cancel'],
  cancelled: [],
  done:      [],
};

function validateStateTransition(currentStatus: RequestStatus, action: string): void {
  const allowed = STATE_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(action)) {
    throw new InvalidStateError(
      `Cannot ${action} a request in '${currentStatus}' state. ` +
      `Allowed actions: ${allowed?.join(', ') ?? 'none'}.`
    );
  }
}
```

Every state-mutating handler (`CancelHandler`, `PauseHandler`, `ResumeHandler`, `PriorityHandler`, `FeedbackHandler`) calls `validateStateTransition` before executing.

## Acceptance Criteria

1. Router dispatches to the correct handler for all 10 command names.
2. Router returns `VALIDATION_ERROR` for unknown commands.
3. Router checks authorization before rate limiting; checks rate limiting before execution.
4. Authorization denial returns `AUTHZ_DENIED` error code and logs the audit entry.
5. Rate limit exceeded returns `RATE_LIMITED` error code with `retryAfterMs`.
6. `SubmitHandler` returns `requestId`, `position`, and `estimatedWait` on success.
7. `StatusHandler` returns `NOT_FOUND` for nonexistent request IDs.
8. `CancelHandler` requires confirmation; returns `confirmationRequired: true` on first call.
9. `PauseHandler` rejects requests not in `active` state with `INVALID_STATE`.
10. `ResumeHandler` accepts both `paused` and `failed` states.
11. `PriorityHandler` rejects requests not in `queued` state with `INVALID_STATE`.
12. `KillHandler` requires admin role and typed "CONFIRM".
13. `KillHandler` without "CONFIRM" returns confirmation prompt, does not execute.
14. All state-mutating handlers call `validateStateTransition` before modifying state.
15. Terminal states (`cancelled`, `done`) reject all actions with `INVALID_STATE`.

## Test Cases

1. **Router: unknown command**: `route({ commandName: 'explode', ... })` returns `VALIDATION_ERROR`.
2. **Router: authz denied**: User is `viewer`, command is `submit`; verify `AUTHZ_DENIED` returned and audit log written.
3. **Router: rate limited**: User has exceeded submission limit; verify `RATE_LIMITED` returned with `retryAfterMs > 0`.
4. **Router: happy path**: User is `contributor`, command is `submit` with valid args; verify handler `execute` is called.
5. **Router: internal error**: Handler throws unexpected error; verify `INTERNAL_ERROR` returned (not the raw error).
6. **SubmitHandler: success**: Valid description; verify request created in DB, queue position returned.
7. **SubmitHandler: injection blocked**: Description triggers sanitizer block; verify `INJECTION_BLOCKED` returned.
8. **SubmitHandler: duplicate found**: Similar request exists; verify `DUPLICATE_DETECTED` returned with candidates.
9. **StatusHandler: found**: Request exists; verify all status fields returned.
10. **StatusHandler: not found**: Request does not exist; verify `NOT_FOUND`.
11. **ListHandler: filtered**: Insert 3 requests (high, normal, low); filter by `--priority high`; verify 1 result.
12. **CancelHandler: confirmation flow**: First call returns confirmation prompt; second call with confirmation cancels.
13. **CancelHandler: invalid state**: Request is `done`; verify `INVALID_STATE`.
14. **PauseHandler: success**: Request is `active`; verify status becomes `paused`, `paused_at_phase` recorded.
15. **PauseHandler: invalid state**: Request is `queued`; verify `INVALID_STATE`.
16. **ResumeHandler: from paused**: Request is `paused`; verify status becomes `active`.
17. **ResumeHandler: from failed**: Request is `failed`; verify status becomes `queued`.
18. **ResumeHandler: invalid state**: Request is `active`; verify `INVALID_STATE`.
19. **PriorityHandler: success**: Request is `queued`, change to `high`; verify priority updated and new position returned.
20. **PriorityHandler: invalid state**: Request is `active`; verify `INVALID_STATE`.
21. **LogsHandler: default limit**: Insert 100 log entries; verify only last 50 returned.
22. **LogsHandler: --all flag**: Insert 100 log entries with `--all`; verify all 100 returned.
23. **FeedbackHandler: success**: Request is `active`; verify message recorded in conversation_messages.
24. **FeedbackHandler: invalid state**: Request is `queued`; verify `INVALID_STATE`.
25. **KillHandler: non-admin**: User is `operator`; verify `AUTHZ_DENIED`.
26. **KillHandler: no confirmation**: Admin calls without "CONFIRM"; verify confirmation prompt returned.
27. **KillHandler: confirmed**: Admin calls with "CONFIRM"; verify all active requests paused, `kill_all` event emitted.
28. **State machine: all valid transitions**: For each (state, action) pair in the table, verify no error thrown.
29. **State machine: all invalid transitions**: For each invalid (state, action) pair, verify `InvalidStateError` thrown with descriptive message.
