# SPEC-015-2-04: Approval State Persistence & Idempotent Page Reload

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Approval state persistence, idempotent re-render after page reload, 24-hour delay UI
- **Estimated effort**: 5 hours

## Description
Persist approval-gate UI state to the daemon's request artifacts (not just in-memory) so an operator who closes the browser tab and returns later sees the exact same approval prompt with remaining typed-CONFIRM TTL, accurately rendered escalation status, and any in-progress 24-hour delays counted down to current wall-clock time. The portal becomes a stateless reflection of the daemon's authoritative state — closing or reloading never loses progress and never causes double-approval. The page-reload path is idempotent: re-rendering produces the same DOM and re-issuing an idempotent approval submission returns the prior result.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/approvals/approval-state.ts` | Create | Reads + caches per-request approval status from state.json |
| `src/portal/approvals/idempotency.ts` | Create | Idempotency-key handling on POST /approvals/:id |
| `src/portal/approvals/delay-clock.ts` | Create | Server-rendered countdown + auto-refresh via SSE |
| `src/portal/templates/fragments/approval-prompt.tsx` | Modify | Add data attributes for idempotency + remaining TTL |
| `src/portal/templates/fragments/delay-countdown.tsx` | Create | Live countdown for 24h delays |

## Implementation Details

### Approval State Reader

```typescript
// src/portal/approvals/approval-state.ts

export interface ApprovalState {
  requestId: string;
  gateName: 'prd' | 'tdd' | 'plan' | 'spec' | 'code' | 'security' | 'deploy';
  status: 'pending' | 'approved' | 'rejected' | 'awaiting-delay' | 'expired';
  promptText: string;
  promptEmittedAt: number;        // epoch ms
  ttlExpiresAt: number;           // epoch ms; for typed-CONFIRM TTL
  delayExpiresAt: number | null;  // epoch ms; null when not in 24h delay
  decision?: { actor: string; decidedAt: number; comment?: string };
  idempotencyKey: string;         // SHA-256 of (requestId + gateName + promptEmittedAt)
}

export class ApprovalStateReader {
  constructor(private stateAccessor: StateAccessor) {}

  async getApproval(requestId: string): Promise<ApprovalState | null> {
    const state = await this.stateAccessor.read(requestId);
    if (!state.approval_pending) return null;
    return this.toApprovalState(state);
  }

  private toApprovalState(state: RequestState): ApprovalState {
    // Map state.json fields → ApprovalState; compute idempotencyKey deterministically
    const idempotencyKey = sha256(`${state.id}:${state.approval_pending.gate}:${state.approval_pending.emitted_at}`);
    // ...
  }
}
```

### Idempotency Wrapper

```typescript
// src/portal/approvals/idempotency.ts

const idempotencyCache = new Map<string, Promise<ApprovalSubmitResult>>();

export async function submitWithIdempotency(
  key: string,
  fn: () => Promise<ApprovalSubmitResult>
): Promise<ApprovalSubmitResult> {
  const existing = idempotencyCache.get(key);
  if (existing) return existing;                       // return cached promise
  const promise = fn().catch((err) => { idempotencyCache.delete(key); throw err; });
  idempotencyCache.set(key, promise);
  setTimeout(() => idempotencyCache.delete(key), 60_000);  // GC after 60s
  return promise;
}
```

In the route handler:

```typescript
app.post('/approvals/:requestId', async (c) => {
  const { requestId } = c.req.param();
  const body = await c.req.json();
  const idempotencyKey = body.idempotencyKey ?? '';
  if (!idempotencyKey) return c.json({ error: 'idempotency_key required' }, 400);
  const result = await submitWithIdempotency(idempotencyKey, () => intakeClient.submitApproval(requestId, body));
  return c.json(result);
});
```

The frontend includes `idempotencyKey` from the rendered approval-prompt's `data-idempotency-key` attribute. Re-clicking Approve after a network error does NOT trigger a second authoritative submission.

### 24-Hour Delay Countdown

```tsx
// src/portal/templates/fragments/delay-countdown.tsx

export const DelayCountdown = ({ expiresAt }: { expiresAt: number }) => (
  <div
    class="countdown"
    data-expires-at={expiresAt}
    hx-get={`/approvals/delay-status?expires=${expiresAt}`}
    hx-trigger="every 60s"
    hx-swap="outerHTML"
  >
    <span>{formatRemaining(expiresAt - Date.now())}</span>
  </div>
);

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'Delay complete - awaiting CONFIRM';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m remaining`;
}
```

Server endpoint `GET /approvals/delay-status` returns the same fragment so HTMX can swap the new countdown server-side every 60 seconds. This avoids client-side timer drift and works through page reload (server is source of truth).

### Page Reload Idempotency

When an operator reloads `/repo/foo/request/REQ-000123`:
1. Server reads current state.json
2. ApprovalStateReader returns the SAME `ApprovalState` for the same `(emitted_at, gate)` tuple
3. Same `idempotencyKey` → same DOM rendering
4. If operator clicks Approve and the network request times out, retrying with the same idempotencyKey returns the cached result (or the daemon's authoritative decision once it lands)

### Approval State Transitions Visible in UI

| state.json status | UI shows |
|-------------------|----------|
| `approval_pending` (no delay) | Prompt + Approve/Reject buttons + TTL countdown |
| `approval_pending` (with `delay_expires_at` future) | DelayCountdown + disabled buttons |
| `approval_pending` (delay elapsed, awaiting CONFIRM) | Re-enabled buttons + "Delay complete" message |
| `approval_decided` (within 5 min) | Decision summary + actor + timestamp |
| `approval_decided` (after 5 min) | Auto-collapse to compact "Approved by X" line |
| `approval_expired` | Expired notice + "Re-request" button (admin-only) |

## Acceptance Criteria

- [ ] `ApprovalStateReader.getApproval(requestId)` returns deterministic `ApprovalState` for the same state.json
- [ ] `idempotencyKey` is identical across two page reloads of the same approval prompt
- [ ] `submitWithIdempotency` returns the same Promise for two simultaneous submissions with identical key
- [ ] Network timeout + retry with same key does NOT double-submit to the daemon
- [ ] 24h delay countdown updates every 60s via HTMX (server-rendered, not client-timer)
- [ ] Approve/Reject buttons are disabled during delay period (HTML `disabled` attribute, not just CSS)
- [ ] Page reload during delay shows the correct remaining time computed from server-current `delay_expires_at`
- [ ] After delay completes, buttons re-enable on next 60s poll without operator action
- [ ] Decision history (actor, timestamp, comment) persists across reloads
- [ ] Idempotency cache GCs after 60s (verified by mocked timers in tests)

## Dependencies

- **SPEC-015-2-01**: approval gate UI flow (this plan extends with persistence)
- **SPEC-015-2-03**: intake-router HTTP client (target of idempotent submissions)
- **SPEC-015-1-03**: state.json reader (source of approval state)
- **PLAN-018-1**: request types, state.json v1.1 schema (`approval_pending` field)

## Notes

- Idempotency is server-enforced via the cache + a deterministic key derived from `(requestId, gate, emitted_at)`. Client-supplied keys are validated against server expectation; mismatch is a 400 error.
- The `60s` TTL on the idempotency cache matches the typed-CONFIRM TTL — if a client retries after >60s, that's a fresh approval attempt requiring a new typed-CONFIRM token.
- Server-rendered countdown via HTMX avoids client-side clock drift (operator's laptop suspended, time skew, etc.).
- Future enhancement: WebSocket / SSE-driven countdown updates instead of 60s polling — out of scope for v1; deferred until SSE bus exposes per-request channels.
- The `auto-collapse to compact line` is intentional UX: long-resolved decisions shouldn't dominate the view.
