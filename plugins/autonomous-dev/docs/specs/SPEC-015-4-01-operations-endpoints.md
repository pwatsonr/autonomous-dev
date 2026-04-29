# SPEC-015-4-01: Operations Endpoints (Kill-Switch & Circuit-Breaker) with Typed-CONFIRM Gating

## Metadata
- **Parent Plan**: PLAN-015-4
- **Tasks Covered**: TASK-003 (typed-CONFIRM modal system), TASK-004 (ops page handler + templates), TASK-005 (kill-switch endpoints), TASK-006 (circuit-breaker reset endpoint)
- **Estimated effort**: 13.5 hours (≈1.7 days)

## Description
Build the `/ops` operations dashboard and the destructive-action endpoints it drives: `POST /ops/kill-switch/engage`, `POST /ops/kill-switch/reset`, and `POST /ops/circuit-breaker/reset`. Every mutation is gated by a typed-CONFIRM token (UUID, 60s TTL, single-use, action-bound) per TDD-014 §11 and SPEC-014-2-02. Endpoints proxy to the intake router HTTP client (PLAN-015-2), append an audit entry via the HMAC-chained logger (SPEC-014-3-03), and broadcast the result through the SSE event bus (PLAN-015-1).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/auth/typed-confirm.ts` | Create | `TypedConfirmManager` class with `generateConfirmationToken`, `validateConfirmationToken`, internal `Map<string, ConfirmToken>` and 5-second sweep timer |
| `src/portal/auth/typed-confirm.test.ts` | Create | Unit tests for token lifecycle, expiry, action-binding, single-use semantics |
| `src/portal/templates/components/typed-confirm-modal.hbs` | Create | Modal partial: action title, danger description, `<input name="confirmText">`, hidden `confirmationToken`, HTMX `hx-post` on enclosing form |
| `src/portal/static/js/typed-confirm.js` | Create | Listens for `[data-confirm-action]`, fetches token from `POST /ops/confirm-token`, opens modal, disables submit until typed text === "CONFIRM" |
| `src/portal/routes/ops.ts` | Create | `GET /ops` page handler + `POST /ops/confirm-token` token issuance endpoint |
| `src/portal/templates/ops.hbs` | Create | Full page template extending `layouts/base.hbs` |
| `src/portal/templates/fragments/daemon-status.hbs` | Create | HTMX fragment refreshed via SSE; shows status pill, heartbeat age, last_request_id |
| `src/portal/templates/fragments/operation-controls.hbs` | Create | Engage/Reset/Circuit-Reset buttons; each carries `data-confirm-action` |
| `src/portal/routes/ops/kill-switch.ts` | Create | Engage + reset POST handlers wired through `OperationsHandler` |
| `src/portal/routes/ops/circuit-breaker.ts` | Create | Reset POST handler wired through `OperationsHandler` |
| `src/portal/services/operations-handler.ts` | Create | Service composing intake-router client, typed-CONFIRM, audit logger; exposes `engageKillSwitch`, `resetKillSwitch`, `resetCircuitBreaker`, `getKillSwitchState`, `getCircuitBreakerState` |
| `src/portal/middleware/daemon-health-middleware.ts` | Consume | `requireHealthyDaemon` from SPEC-015-4-03 (no modification here) |
| `src/portal/lib/intake-router-client.ts` | Consume | From PLAN-015-2 (`submitCommand`) |
| `src/portal/audit/audit-logger.ts` | Consume | From SPEC-014-3-03 (`AuditLogger.log`) |

## Implementation Details

### TypedConfirmManager (`src/portal/auth/typed-confirm.ts`)

```typescript
export interface ConfirmToken {
  token: string;        // crypto.randomUUID()
  action: string;       // e.g. "kill-switch.engage"
  operatorId: string;
  createdAt: number;    // Date.now()
  expiresAt: number;    // createdAt + 60_000
}

export interface TypedConfirmManagerOptions {
  ttlMs?: number;       // default 60_000
  sweepIntervalMs?: number; // default 5_000
  now?: () => number;   // for tests
}

export class TypedConfirmManager {
  generateConfirmationToken(action: string, operatorId: string): ConfirmToken;
  validateConfirmationToken(token: string, expectedAction: string, operatorId: string): { valid: boolean; reason?: 'unknown' | 'expired' | 'action_mismatch' | 'operator_mismatch' };
  consume(token: string): void;            // delete from map
  size(): number;                           // for tests
  stop(): void;                             // clear sweep timer
}
```

Behaviors:
- Tokens stored in `Map<string, ConfirmToken>`. Sweep timer deletes expired tokens every 5s; cleanup is also performed inline on each validate call before lookup (defense in depth).
- `validateConfirmationToken` returns `{ valid: false, reason: 'expired' }` for tokens older than `ttlMs` and removes them. Action mismatch and operator mismatch return their own reasons WITHOUT consuming the token (so the operator can retry without round-tripping for a new token).
- `consume(token)` is called by route handlers ONLY after the action has been authorized AND the intake router call has been issued (do not delete on transient errors that operators should retry).
- Allowed action namespace (validated against an allowlist constant): `kill-switch.engage`, `kill-switch.reset`, `circuit-breaker.reset`.

### Token-Issuance Endpoint (`POST /ops/confirm-token`)

Request body: `{ "action": "<allowed-action>" }`. Response: `{ token: string, action: string, expiresIn: 60 }`. Returns 400 for unknown actions. Rate-limit per session: max 3 issued tokens per minute (use existing rate-limit middleware from PLAN-014-2). Requires CSRF token like every other portal mutation.

### Operations Handler (`src/portal/services/operations-handler.ts`)

```typescript
export interface OperationResult {
  success: boolean;
  error?: string;        // operator-safe message
  errorCode?: 'INVALID_TOKEN' | 'EXPIRED_TOKEN' | 'ACTION_MISMATCH' | 'INTAKE_FAILED' | 'DAEMON_UNHEALTHY';
  intakeRequestId?: string;
}

export class OperationsHandler {
  constructor(
    private intakeClient: IntakeRouterClient,
    private confirmManager: TypedConfirmManager,
    private auditLogger: AuditLogger,
    private eventBus: SSEEventBus
  ) {}

  async engageKillSwitch(reason: string, operatorId: string, confirmationToken: string): Promise<OperationResult>;
  async resetKillSwitch(operatorId: string, confirmationToken: string): Promise<OperationResult>;
  async resetCircuitBreaker(operatorId: string, confirmationToken: string): Promise<OperationResult>;

  async getKillSwitchState(): Promise<{ engaged: boolean; engagedBy?: string; engagedAt?: string; reason?: string }>;
  async getCircuitBreakerState(): Promise<{ state: 'closed' | 'open' | 'half-open'; lastResetAt?: string; failureCount: number }>;
}
```

Each mutation method follows the same recipe:
1. `validateConfirmationToken(token, expectedAction, operatorId)`. On failure, return `{ success: false, error, errorCode }`. Do NOT consume the token.
2. Call `intakeClient.submitCommand({ command: '<engage|reset|circuit-reset>', source: 'portal', sourceUserId: operatorId, payload: { reason } })`. On non-2xx, append audit entry with `outcome: 'failed'` and return `INTAKE_FAILED`. Do NOT consume the token.
3. On 2xx, `consume(token)`, append audit entry with `outcome: 'success'`, broadcast SSE event, return `{ success: true, intakeRequestId }`.

`reason` length ≤ 500 chars (validated). Empty `reason` for `engage` returns 400 with `MISSING_REASON` BEFORE step 1.

### Route Handlers

`POST /ops/kill-switch/engage`:
- Middleware: CSRF (PLAN-014-2), `requireHealthyDaemon` (SPEC-015-4-03)
- Body: `{ reason: string, confirmationToken: string }` (JSON or form-encoded)
- Returns 200 `{ success: true, intakeRequestId }`, 400 `{ success: false, error, errorCode }` for token/validation errors, 503 from middleware when daemon unhealthy.

`POST /ops/kill-switch/reset`:
- Same surface; body is `{ confirmationToken: string }` (no reason required).

`POST /ops/circuit-breaker/reset`:
- Same surface as kill-switch reset.

### `GET /ops` Page

Renders `ops.hbs` with the following context:
- `daemonStatus`: from `DaemonHealthMonitor.getDaemonStatus()` (SPEC-015-4-03)
- `killSwitchState`: from `OperationsHandler.getKillSwitchState()`
- `circuitBreakerState`: from `OperationsHandler.getCircuitBreakerState()`
- `operatorId`: from auth context
- `csrfToken`: from CSRF middleware
- `staleBanner`: from banner-injection middleware (SPEC-015-4-03)

The page contains two HTMX-driven fragments:
- `#daemon-status` listens via `hx-sse="connect:/sse/events; swap:daemon-status"` (event name `daemon-status`).
- `#operation-controls` re-renders via `hx-sse="swap:kill-switch-state"` and `swap:circuit-breaker-state`.

Operation buttons render with `data-confirm-action="kill-switch.engage|kill-switch.reset|circuit-breaker.reset"`. Clicking triggers the modal flow in `typed-confirm.js`.

## Acceptance Criteria

- [ ] `generateConfirmationToken('kill-switch.engage', 'op1')` returns a UUID-shaped token; the same call twice produces distinct tokens; the manager's internal size grows by 2.
- [ ] `validateConfirmationToken` returns `{ valid: false, reason: 'expired' }` for a token whose `expiresAt < now`; the token is deleted as a side effect.
- [ ] `validateConfirmationToken` returns `{ valid: false, reason: 'action_mismatch' }` when the token was issued for `kill-switch.engage` but `kill-switch.reset` is requested; the token is NOT consumed.
- [ ] After a successful operation, `consume(token)` removes the token; a second validate call returns `{ valid: false, reason: 'unknown' }`.
- [ ] `GET /ops` renders `ops.hbs` with the documented context keys present.
- [ ] `POST /ops/confirm-token` with `{ action: 'kill-switch.engage' }` returns `{ token, action: 'kill-switch.engage', expiresIn: 60 }`. With `{ action: 'unknown.foo' }` it returns 400 `{ error: 'UNKNOWN_ACTION' }`.
- [ ] `POST /ops/confirm-token` issued more than 3 times in a 60s window for the same session returns 429.
- [ ] `POST /ops/kill-switch/engage` with valid token and `reason: "manual stop"` returns 200; one `kill-switch.engage` audit entry is appended; one `kill-switch-engaged` SSE event is broadcast; the token is consumed.
- [ ] `POST /ops/kill-switch/engage` with an expired token returns 400 `{ errorCode: 'EXPIRED_TOKEN' }` and the intake router is NOT called.
- [ ] `POST /ops/kill-switch/engage` with a token issued for `kill-switch.reset` returns 400 `{ errorCode: 'ACTION_MISMATCH' }` and the token is NOT consumed.
- [ ] `POST /ops/kill-switch/engage` with empty `reason` returns 400 `{ errorCode: 'MISSING_REASON' }` BEFORE token validation.
- [ ] `POST /ops/kill-switch/engage` returns 503 (from `requireHealthyDaemon` middleware) when daemon status is `dead` or `unknown`; no token is consumed.
- [ ] When the intake router returns 5xx, the endpoint returns 502 `{ errorCode: 'INTAKE_FAILED' }`, the audit entry records `outcome: 'failed'`, and the token is NOT consumed.
- [ ] `POST /ops/kill-switch/reset` and `POST /ops/circuit-breaker/reset` follow the same contract as engage (without `reason`); each emits its own `kill-switch-reset` / `circuit-breaker-reset` SSE event.
- [ ] Operation buttons in `operation-controls.hbs` carry `data-confirm-action` attributes matching the action allowlist.
- [ ] `typed-confirm.js` disables the modal's submit button until the typed input strictly equals `CONFIRM` (case-sensitive, no surrounding whitespace).
- [ ] All new TS files pass `bun run lint:check` with `--max-warnings=0`.

## Dependencies

- SPEC-014-2-02: Typed-CONFIRM modal pattern (UI behavior, "CONFIRM" string match).
- SPEC-014-3-03: HMAC-chained `AuditLogger.log` interface.
- PLAN-014-2 §TASK-001: CSRF middleware and rate-limit middleware.
- PLAN-015-1: SSE event bus (`broadcast(event, data)`).
- PLAN-015-2: `IntakeRouterClient.submitCommand` and `IncomingCommand` shape.
- SPEC-015-4-03 (sibling): `requireHealthyDaemon` middleware and `DaemonHealthMonitor`.

## Notes

- Token issuance is a deliberate two-step flow: client requests a token, then submits the operation with that token. This keeps tokens short-lived and tied to a single operator action, preventing CSRF-like replay against destructive endpoints.
- The `consume`-on-success-only policy means a flaky intake-router connection lets operators retry without a fresh modal interaction. Intentional: improves UX without weakening replay protection (the token is still single-use once intake confirms).
- The action allowlist is enumerated in code, not configuration, to prevent injection of new destructive actions via runtime config.
- Memory bound: at 3 tokens/min/session × 60s TTL × ~100 sessions, the in-memory map stays under 1 KB. No persistence layer needed.
