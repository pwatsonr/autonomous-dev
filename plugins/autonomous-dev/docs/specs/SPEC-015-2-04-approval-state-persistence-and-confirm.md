# SPEC-015-2-04: Approval State Persistence, Idempotent Re-render, 24h Escalation, Typed-CONFIRM

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Task 3 (typed-CONFIRM modal integration), Task 4 (gate action endpoint handlers)
- **Estimated effort**: 7 hours

## Description

Implement the server-side gate action endpoints (`POST /repo/:repo/request/:id/gate/{approve,request-changes,reject}`), the typed-CONFIRM token system that protects high-cost rejects (>$50), the 24-hour escalation marker, and the idempotent re-render rule that lets a refreshed page show the correct gate panel state regardless of whether the action completed before the page reload. This spec consumes `IntakeRouterClient` (SPEC-015-2-03), the gate panel template (SPEC-015-2-01), and the data accessor (PLAN-015-1). It does NOT cover the settings editor (SPEC-015-2-02) or test scaffolding (SPEC-015-2-05).

The "idempotent re-render" requirement says: if the user clicks Approve, the request reaches the intake router and `state.json` is updated, but the user's browser tab is closed before the HTMX response arrives, the next time the user loads `/repo/:repo/request/:id` they MUST see the resolved panel ("Approved by op1 at ..."), NOT a fresh action panel that would let them double-click. This is achieved by reading `status` and `phase_history` from the data accessor on every page render and rendering the resolved variant when `status` is no longer `pending-approval`.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/lib/confirmation-token-store.ts` | Create | In-memory single-use token store with TTL |
| `src/portal/js/gate-confirmation.ts` | Create | Modal lifecycle, listens for `gate:requires-confirm` from SPEC-015-2-01 |
| `src/portal/templates/fragments/confirm-modal.hbs` | Create | Modal markup with REJECT typing field |
| `src/portal/routes/gate-actions.ts` | Create | Three POST handlers + shared `processGateAction` |
| `src/portal/lib/escalation.ts` | Create | `computeEscalation(state)` helper |
| `src/portal/lib/panel-context-builder.ts` | Create | Builds the template context for the gate panel given a state.json |
| `src/portal/app.ts` | Modify | Mount `gateActionsRouter` |
| `src/portal/templates/layouts/base.hbs` | Modify | Inject `gate-confirmation.ts` script tag and modal partial |

## Implementation Details

### Confirmation Token Store

Tokens are minted server-side, returned to the client via a dedicated endpoint, typed back into the modal, and consumed once by the gate action endpoint.

```typescript
// confirmation-token-store.ts
interface TokenEntry {
  token: string;
  operatorId: string;
  scope: string;        // e.g., "reject_REQ-20260428-a1b2"
  expiresAt: number;    // Date.now() + ttl
  consumed: boolean;
}

export class ConfirmationTokenStore {
  private tokens = new Map<string, TokenEntry>();
  private readonly TTL_MS = 60_000;     // 60 seconds

  mint(operatorId: string, scope: string): string {
    const token = crypto.randomUUID();
    this.tokens.set(token, {
      token,
      operatorId,
      scope,
      expiresAt: Date.now() + this.TTL_MS,
      consumed: false,
    });
    this.gc();
    return token;
  }

  consume(token: string, operatorId: string, scope: string): { valid: boolean; reason?: string } {
    const entry = this.tokens.get(token);
    if (!entry) return { valid: false, reason: 'unknown_token' };
    if (entry.consumed) return { valid: false, reason: 'already_consumed' };
    if (Date.now() > entry.expiresAt) return { valid: false, reason: 'expired' };
    if (entry.operatorId !== operatorId) return { valid: false, reason: 'operator_mismatch' };
    if (entry.scope !== scope) return { valid: false, reason: 'scope_mismatch' };
    entry.consumed = true;
    return { valid: true };
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.tokens.entries()) {
      if (v.expiresAt < now || v.consumed) this.tokens.delete(k);
    }
  }
}
```

The store is process-local (single Bun server). Token loss across restart is acceptable since the TTL is 60s and the modal flow is short-lived. We do NOT persist tokens to disk.

### Token-Issuing Endpoint

```
POST /repo/:repo/request/:id/gate/confirm-token
  Body: { action: 'reject' }
  Response 200: { token: string, expiresAt: number, scope: string, requiresType: 'REJECT' }
  Response 400: { error: 'cost_below_threshold' }   // when cost ≤ $50
  Response 404: { error: 'request_not_found' }
```

Cost threshold check is server-authoritative — the client `data-high-cost` attribute is advisory only. If the user attempts to mint a token for a low-cost reject, the endpoint refuses (`cost_below_threshold`) so the gate handler still works without a token.

### Confirmation Modal UX

```handlebars
{{!-- confirm-modal.hbs --}}
<div id="confirm-modal" class="modal" hidden role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
  <div class="modal-backdrop" data-dismiss="true"></div>
  <div class="modal-content">
    <h3 id="confirm-modal-title">Confirm rejection</h3>
    <p class="modal-body">
      You are rejecting <strong id="confirm-modal-request-title"></strong>
      with cost <strong id="confirm-modal-cost"></strong>.
    </p>
    <p>Type <code id="confirm-modal-typed-text">REJECT</code> to confirm:</p>
    <input type="text"
           id="confirm-modal-input"
           autocomplete="off"
           autocorrect="off"
           autocapitalize="off"
           spellcheck="false"
           aria-describedby="confirm-modal-help">
    <p id="confirm-modal-help" class="modal-help">This action cannot be undone.</p>
    <div class="modal-actions">
      <button id="confirm-modal-cancel" type="button">Cancel</button>
      <button id="confirm-modal-submit" type="button" disabled class="btn-danger">Reject</button>
    </div>
  </div>
</div>
```

`gate-confirmation.ts`:

```typescript
class GateConfirmationController {
  start(): void {
    document.addEventListener('gate:requires-confirm', (e) => {
      this.handle(e as CustomEvent);
    });
  }

  private async handle(event: CustomEvent): Promise<void> {
    const { requestId, action, costAmount, form } = event.detail;
    if (action !== 'reject') return;       // Currently only reject uses CONFIRM
    if (!form) return;

    // 1. Mint token
    const repo = form.dataset.repo || form.action.match(/\/repo\/([^/]+)/)?.[1];
    const tokenResp = await fetch(`/repo/${repo}/request/${requestId}/gate/confirm-token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken()},
      body: JSON.stringify({ action: 'reject' }),
    });
    if (!tokenResp.ok) {
      this.showInlineError(form, 'Could not start confirmation flow. Please retry.');
      return;
    }
    const { token, requiresType } = await tokenResp.json();

    // 2. Show modal
    const result = await this.showModal({
      requestId, costAmount, requiresType, requestTitle: form.closest<HTMLElement>('.gate-action-panel')?.dataset.requestTitle ?? requestId,
    });

    if (!result.confirmed) return;          // Cancelled

    // 3. Inject token + submit form via HTMX
    let tokenInput = form.querySelector<HTMLInputElement>('input[name="confirmationToken"]');
    if (!tokenInput) {
      tokenInput = document.createElement('input');
      tokenInput.type = 'hidden';
      tokenInput.name = 'confirmationToken';
      form.appendChild(tokenInput);
    }
    tokenInput.value = token;

    // Mark the reject button as the implicit submitter (HTMX uses formdata)
    htmx.trigger(form, 'submit');
  }

  private showModal(opts: {requestId: string; costAmount: number; requiresType: string; requestTitle: string}): Promise<{confirmed: boolean}>;
  private showInlineError(form: HTMLFormElement, message: string): void;
}
```

The modal:
- Disables the submit button until the input value === `requiresType` exactly (case-sensitive).
- Cancel button or backdrop click resolves `{confirmed: false}` and clears the input.
- Returns focus to the originating reject button on close (focus management).
- Cannot be re-opened while open (idempotent guard via `aria-hidden` check).

### Gate Action Endpoints

All three (`approve`, `request-changes`, `reject`) share `processGateAction`:

```typescript
async function processGateAction(c: Context, action: 'approve' | 'request-changes' | 'reject'): Promise<Response> {
  const repo = c.req.param('repo');
  const requestId = c.req.param('id');
  const operatorId = getOperatorId(c);
  const formData = await c.req.formData();
  const comment = (formData.get('comment') ?? '').toString().trim();
  const submittedAction = formData.get('action')?.toString();
  const confirmationToken = formData.get('confirmationToken')?.toString();

  // 1. URL/form action consistency check
  if (submittedAction !== action) {
    return renderPanel(c, requestId, repo, { validationError: 'Action mismatch' }, 400);
  }

  // 2. Comment required for request-changes
  if (action === 'request-changes' && !comment) {
    return renderPanel(c, requestId, repo, { validationError: 'Comment is required for Request Changes' }, 422);
  }

  // 3. Read state for idempotency + cost
  const state = await stateAccessor.read(repo, requestId);
  if (!state) return renderPanel(c, requestId, repo, { validationError: 'Request not found' }, 404);

  // 3a. Idempotent re-render: if already resolved, return resolved panel (no error)
  if (state.status !== 'pending-approval') {
    return renderPanel(c, requestId, repo, { state, panelMode: 'resolved' }, 200);
  }

  // 4. High-cost reject token check
  if (action === 'reject' && state.cost.total > 50) {
    if (!confirmationToken) {
      return renderPanel(c, requestId, repo, { state, requiresConfirm: true }, 428);
    }
    const result = tokenStore.consume(confirmationToken, operatorId, `reject_${requestId}`);
    if (!result.valid) {
      return renderPanel(c, requestId, repo, { state, validationError: `Confirmation invalid: ${result.reason}` }, 422);
    }
  }

  // 5. Submit to intake router
  const intakeResponse = await intakeClient.submitCommand({
    command: action,
    requestId: crypto.randomUUID(),         // command id, not target request
    targetRequestId: requestId,
    comment: comment || undefined,
    source: 'portal',
    sourceUserId: operatorId,
    confirmationToken,
  });

  if (!intakeResponse.success) {
    // Distinguish transient vs permanent
    const isTransient = intakeResponse.errorCode === 'NETWORK_TRANSIENT';
    const status = isTransient ? 503 : 422;
    return renderPanel(c, requestId, repo, {
      state,
      [isTransient ? 'serviceError' : 'validationError']: intakeResponse.error,
    }, status);
  }

  // 6. Audit
  await auditLogger.logGateAction({
    operatorId,
    requestId,
    action,
    comment: comment || undefined,
    intakeCommandId: intakeResponse.commandId,
    timestamp: new Date().toISOString(),
  });

  // 7. Re-render resolved panel
  // Note: state.json may not have updated yet (intake router writes asynchronously),
  // so we synthesize the resolved view from the response rather than re-reading.
  return renderPanel(c, requestId, repo, {
    state: { ...state, status: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'changes-requested' },
    panelMode: 'resolved',
    resolvedBy: operatorId,
    resolvedAt: new Date().toISOString(),
    action,
    comment: comment || undefined,
  }, 200);
}

app.post('/repo/:repo/request/:id/gate/approve', csrfProtection, (c) => processGateAction(c, 'approve'));
app.post('/repo/:repo/request/:id/gate/request-changes', csrfProtection, (c) => processGateAction(c, 'request-changes'));
app.post('/repo/:repo/request/:id/gate/reject', csrfProtection, (c) => processGateAction(c, 'reject'));
```

### Idempotent Re-render Rule

The gate action panel is rendered by reading `state.json` via the data accessor on EVERY GET of the request detail page AND on every gate action POST response. The rendering rule:

| state.status | escalation_at present | Panel rendered |
|-----|-----|-----|
| `pending-approval` | absent | Action panel with three buttons |
| `pending-approval` | present (≥ 24h since created_at) | Action panel + escalation badge |
| `approved` / `rejected` / `changes-requested` | (any) | Resolved panel: "{Action} by {operator} at {timestamp}" |
| `cancelled` / `completed` | (any) | Resolved panel: "Request {status}" (no action history) |

This means: if a user has the page open and a different operator approves the request via Slack, the SSE state-change event triggers the page to re-fetch the panel fragment via `hx-get`, and the new render shows the resolved panel. No duplicate-action window exists.

If a user clicks Approve and the network drops AFTER the intake router commits but BEFORE the response arrives, the user reloads, the data accessor reads the now-`approved` state, and the resolved panel is shown.

### 24h Escalation

```typescript
// escalation.ts
export function computeEscalation(state: { created_at: string; status: string; escalated_at?: string }): { escalated: boolean; escalatedAt?: string } {
  if (state.status !== 'pending-approval') return { escalated: false };
  if (state.escalated_at) return { escalated: true, escalatedAt: state.escalated_at };

  const created = new Date(state.created_at).getTime();
  const ageMs = Date.now() - created;
  if (ageMs >= 86_400_000) {       // 24 hours
    return { escalated: true, escalatedAt: state.created_at };   // use created_at as escalation timestamp
  }
  return { escalated: false };
}
```

`escalated_at` is set by the daemon (TDD-001) when it transitions a request past 24h. The portal does NOT mutate `escalated_at`. If the daemon hasn't set it yet but the age threshold has passed, the portal computes escalation locally for display — this handles clock skew or daemon delay gracefully.

### Panel Context Builder

```typescript
// panel-context-builder.ts
export function buildPanelContext(state: RequestState, opts: { panelMode?: 'resolved'; resolvedBy?: string; resolvedAt?: string; action?: string; comment?: string; validationError?: string; serviceError?: string; requiresConfirm?: boolean } = {}): PanelContext {
  const escalation = computeEscalation(state);
  const clarifyingQuestion = extractClarifyingQuestion(state);
  return {
    requestId: state.request_id,
    title: state.description.slice(0, 80),
    repo: state.repository,
    cost: { total: state.cost_accrued_usd ?? 0 },
    status: state.status,
    panelMode: opts.panelMode ?? (state.status === 'pending-approval' ? 'active' : 'resolved'),
    escalatedAt: escalation.escalated ? escalation.escalatedAt : undefined,
    clarifyingQuestion,
    resolvedBy: opts.resolvedBy,
    resolvedAt: opts.resolvedAt,
    resolvedAction: opts.action,
    resolvedComment: opts.comment,
    validationError: opts.validationError,
    serviceError: opts.serviceError,
    requiresConfirm: opts.requiresConfirm,
  };
}

function extractClarifyingQuestion(state: RequestState): ClarifyingQuestion | undefined {
  // Walk phase_history backwards; return the most recent unresolved clarifying_question metadata
  for (let i = state.phase_history.length - 1; i >= 0; i--) {
    const entry = state.phase_history[i];
    const cq = entry.metadata?.clarifying_question;
    if (cq && !entry.metadata?.resolved) return cq;
  }
  return undefined;
}
```

`renderPanel(c, requestId, repo, opts, status)` is a small helper that calls `stateAccessor.read`, `buildPanelContext`, renders `gate-action-panel.hbs`, and returns the response with the correct status code.

## Acceptance Criteria

- [ ] `ConfirmationTokenStore.mint` returns a UUID, stores it with `expiresAt = now + 60_000`, `consumed = false`
- [ ] `ConfirmationTokenStore.consume` returns `valid: false, reason: 'unknown_token'` for unknown tokens
- [ ] `ConfirmationTokenStore.consume` returns `valid: false, reason: 'already_consumed'` on second call with same token
- [ ] `ConfirmationTokenStore.consume` returns `valid: false, reason: 'expired'` after TTL
- [ ] `ConfirmationTokenStore.consume` returns `valid: false, reason: 'operator_mismatch'` when operator differs
- [ ] `ConfirmationTokenStore.consume` returns `valid: false, reason: 'scope_mismatch'` when scope differs
- [ ] `POST /repo/:repo/request/:id/gate/confirm-token` returns 400 when cost ≤ $50
- [ ] `POST /repo/:repo/request/:id/gate/confirm-token` returns `{token, expiresAt, requiresType: 'REJECT'}` when cost > $50
- [ ] Modal disables submit button until typed input matches `requiresType` exactly (case-sensitive)
- [ ] Modal cancel/backdrop returns focus to the originating button
- [ ] `processGateAction` rejects when URL action does not match form `action` field (returns 400)
- [ ] `processGateAction` requires non-empty comment for `request-changes` (returns 422)
- [ ] `processGateAction` reads state.json and returns resolved panel (200) if status is no longer `pending-approval` (idempotent)
- [ ] `processGateAction` for high-cost reject without token returns 428 Precondition Required
- [ ] `processGateAction` for high-cost reject with valid token consumes the token before calling intake
- [ ] `processGateAction` for high-cost reject with invalid token returns 422 with `validationError` containing the reason
- [ ] `processGateAction` calls `intakeClient.submitCommand` exactly once on the success path
- [ ] `processGateAction` writes one audit log entry on success
- [ ] `processGateAction` returns 503 for `errorCode: 'NETWORK_TRANSIENT'`, 422 for other intake failures
- [ ] `computeEscalation` returns `escalated: false` when status is not pending-approval
- [ ] `computeEscalation` returns `escalated: true` when `escalated_at` is set on state
- [ ] `computeEscalation` returns `escalated: true` when age > 24h even without `escalated_at` set
- [ ] `extractClarifyingQuestion` returns the most recent unresolved entry from `phase_history`
- [ ] `extractClarifyingQuestion` returns `undefined` when no entries have `metadata.clarifying_question`
- [ ] `extractClarifyingQuestion` skips entries with `metadata.resolved === true`

## Test Cases

1. **Token mint/consume happy path** — mint(op1, "reject_R1"); consume(token, op1, "reject_R1") → valid.
2. **Token consume twice** — mint; consume → valid; consume → `already_consumed`.
3. **Token expired** — mint; advance clock 61s; consume → `expired`.
4. **Token operator mismatch** — mint(op1); consume(token, op2, "reject_R1") → `operator_mismatch`.
5. **Token scope mismatch** — mint(op1, "reject_R1"); consume(token, op1, "approve_R1") → `scope_mismatch`.
6. **Confirm-token endpoint low cost** — POST with state.cost.total = 25. Assert: 400, body `error: "cost_below_threshold"`.
7. **Confirm-token endpoint high cost** — POST with cost = 75. Assert: 200, body has `token`, `expiresAt`, `requiresType: "REJECT"`.
8. **Gate POST URL/form mismatch** — POST `/gate/approve` with form `action=reject`. Assert: 400.
9. **Gate POST request-changes empty comment** — POST with `action=request-changes` and empty comment. Assert: 422, body contains "Comment is required".
10. **Gate POST already-resolved (idempotent)** — Setup state.status = 'approved'. POST `/gate/approve`. Assert: 200, response body contains resolved panel HTML; intake client NOT called.
11. **Gate POST low-cost reject no token** — POST `/gate/reject` with state.cost = 25, no token. Assert: 200 (no token required); intake called.
12. **Gate POST high-cost reject no token** — POST `/gate/reject` with cost=75, no token. Assert: 428.
13. **Gate POST high-cost reject invalid token** — POST with random token. Assert: 422, error mentions `unknown_token`.
14. **Gate POST high-cost reject valid token** — Mint token, POST with token. Assert: token consumed; intake called once; 200.
15. **Gate POST intake transient failure** — Mock intake `errorCode: NETWORK_TRANSIENT`. Assert: 503, panel re-rendered with `serviceError`.
16. **Gate POST intake permanent failure** — Mock intake `errorCode: INVALID_TRANSITION`. Assert: 422, panel with `validationError`.
17. **Audit entry written on success** — Mock auditLogger. POST happy path. Assert: `logGateAction` called once with operator, action, requestId, intakeCommandId.
18. **Idempotent re-render across reload** — POST approve → 200 resolved. GET request detail page. Assert: page renders panel in resolved mode (status now `approved`); no action buttons.
19. **Escalation computed when escalated_at missing** — state.created_at = 26h ago, status pending-approval, no escalated_at. Assert: `escalated: true, escalatedAt = created_at`.
20. **Escalation false when resolved** — state.status = 'approved', escalated_at set. Assert: `escalated: false`.
21. **extractClarifyingQuestion most recent unresolved** — phase_history with two clarifying entries, the older unresolved, the newer resolved. Assert: returns older's question.
22. **extractClarifyingQuestion all resolved** — both entries `resolved: true`. Assert: returns undefined.

## Dependencies

- SPEC-015-2-01: `gate-action-panel.hbs` template, `gate:requires-confirm` CustomEvent
- SPEC-015-2-03: `IntakeRouterClient.submitCommand`, error codes
- PLAN-014-2: CSRF middleware (`csrfProtection`)
- PLAN-014-1: `getOperatorId(c)` from auth context
- PLAN-015-1: `stateAccessor.read(repo, requestId)` returning `RequestState | null`
- PLAN-009-5: `auditLogger.logGateAction(entry)`
- TDD-001: Daemon's `escalated_at` field semantics
- HTMX 2.x runtime (already loaded by base layout)

## Notes

- Token store is in-process and lost on restart. This is acceptable: the modal flow is bounded to 60 seconds; restarts during a rejection ceremony are rare and the worst case is the user retypes "REJECT". Persisting tokens to disk would create a synchronization problem with no upside.
- The 428 Precondition Required status for "needs typed-CONFIRM" is chosen deliberately — it's the standard HTTP code for "you need to satisfy a precondition first" and HTMX/browsers don't surface it as a generic error to users (we intercept on the client and run the modal flow).
- The "idempotent re-render" rule means the data accessor is the source of truth on every render. We do NOT cache panel state in the browser. SSE re-fetches the fragment when state.json changes.
- After a successful gate action, we synthesize the resolved panel rather than re-reading state.json. This is because the intake router commits asynchronously and the watcher may not have invalidated the cache yet. Synthesizing avoids a brief flicker where the user sees stale "pending-approval" text.
- The `escalated_at` value falls back to `created_at` when the daemon hasn't stamped it yet. This means the displayed "escalated 25 hours ago" matches "created 25 hours ago" in this fallback case — close enough for operator UX, and consistent once the daemon catches up.
- We deliberately do NOT extend typed-CONFIRM to `approve` actions even on high cost. Approval is a forward action; the cost gate is enforced upstream by the orchestrator's budget check (PLAN-010-2). The typed-CONFIRM is reserved for irreversible/destructive actions.
- Comment field is trimmed before validation. A comment of `"   "` (whitespace only) is treated as empty for the request-changes requirement, preventing trivial bypass.
- The 24h escalation badge does not change the action endpoints' behavior — it's purely advisory display. Operators can still approve/reject normally on escalated requests.
