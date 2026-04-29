# SPEC-015-2-04: Approval State Persistence, Idempotent Re-render, 24h Escalation, Typed-CONFIRM

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Task 3 (typed-CONFIRM modal integration), Task 4 (gate action endpoint handlers)
- **Estimated effort**: 7 hours

## Description

Implement the server-side gate action endpoints (`POST /repo/:repo/request/:id/gate/{approve,request-changes,reject}`), the typed-CONFIRM token system that protects high-cost rejects (>$50), the 24-hour escalation marker computation, and the idempotent re-render rule that lets a refreshed page show the correct gate panel state regardless of whether the action completed before reload. Consumes `IntakeRouterClient` (SPEC-015-2-03), the gate panel template (SPEC-015-2-01), and the data accessor (PLAN-015-1). Excludes the settings editor (SPEC-015-2-02) and test scaffolding (SPEC-015-2-05).

The "idempotent re-render" rule: if a user clicks Approve, the request reaches the intake router and `state.json` is updated, but the browser tab closes before the HTMX response arrives, the next time the user loads `/repo/:repo/request/:id` they MUST see the resolved panel — NOT a fresh action panel that would let them double-click. The data accessor reads `status` and `phase_history` on every render; the panel-context-builder switches to resolved mode when `status !== 'pending-approval'`.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/lib/confirmation-token-store.ts` | Create | In-memory single-use tokens with 60s TTL |
| `src/portal/js/gate-confirmation.ts` | Create | Modal lifecycle; listens for `gate:requires-confirm` |
| `src/portal/templates/fragments/confirm-modal.hbs` | Create | Modal markup with REJECT typing field |
| `src/portal/routes/gate-actions.ts` | Create | Three POST handlers + `processGateAction` + token-issuing endpoint |
| `src/portal/lib/escalation.ts` | Create | `computeEscalation(state)` |
| `src/portal/lib/panel-context-builder.ts` | Create | Builds panel template context |
| `src/portal/app.ts` | Modify | Mount `gateActionsRouter` |
| `src/portal/templates/layouts/base.hbs` | Modify | Inject confirm-modal partial + script |

## Implementation Details

### Confirmation Token Store

Process-local in-memory map. Tokens are minted server-side, returned to the client via the token endpoint, typed back into the modal, and consumed once by the gate action endpoint.

```typescript
export class ConfirmationTokenStore {
  private readonly TTL_MS = 60_000;
  mint(operatorId: string, scope: string): string;             // returns UUID; stores entry
  consume(token: string, operatorId: string, scope: string): { valid: boolean; reason?: 'unknown_token' | 'already_consumed' | 'expired' | 'operator_mismatch' | 'scope_mismatch' };
}
```

Tokens are NOT persisted to disk. The store runs GC on each operation, evicting consumed and expired entries.

### Token-Issuing Endpoint

```
POST /repo/:repo/request/:id/gate/confirm-token
  Body:    { action: 'reject' }
  200:     { token, expiresAt, scope, requiresType: 'REJECT' }   when state.cost.total > 50
  400:     { error: 'cost_below_threshold' }                     when cost ≤ 50
  404:     { error: 'request_not_found' }                        when state.json missing
```

Cost threshold is server-authoritative. Client `data-high-cost` is advisory only.

### Confirmation Modal (`confirm-modal.hbs`)

Standard `role="dialog" aria-modal="true"` markup with:
- Title `<h3>Confirm rejection</h3>`
- Body showing request title and cost
- Instruction "Type `REJECT` to confirm:"
- Text input with `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"`
- Cancel + danger-styled Reject buttons
- Reject button starts `disabled`; enabled iff `input.value === 'REJECT'` (case-sensitive, exact match)

### `gate-confirmation.ts` Behavior

Listens for `gate:requires-confirm` (dispatched by SPEC-015-2-01's `gate-actions.ts`):

1. Reads `detail = { requestId, action, costAmount, form }`. Action must be `'reject'`; ignore otherwise.
2. POST to `/repo/<repo>/request/<requestId>/gate/confirm-token` with `{action:'reject'}`. On non-2xx, show inline error in the panel and abort.
3. Show modal, populate context (request title, cost). Resolve a `Promise<{confirmed:boolean}>` on cancel/backdrop/ESC or after typing REJECT exactly and clicking submit.
4. On confirm: inject hidden `<input name="confirmationToken">` into `form` with the token value, then `htmx.trigger(form, 'submit')`.
5. On cancel: clear input, return focus to the originating reject button (focus management).

Modal cannot be re-opened while open (guard via `aria-hidden` check on the modal root).

### Gate Action Handler

`processGateAction(c, action)` shared body for the three POST routes:

1. Parse `repo, requestId, operatorId, formData` (comment, submittedAction, confirmationToken).
2. **URL/form consistency**: if `submittedAction !== action`, return 400 with `validationError='Action mismatch'`.
3. **Comment requirement**: if `action === 'request-changes'` and trimmed comment is empty, return 422 with `validationError='Comment is required for Request Changes'`.
4. **Read state**: `stateAccessor.read(repo, requestId)`. If missing, return 404. (Trim before checking.)
5. **Idempotency**: if `state.status !== 'pending-approval'`, render `panelMode='resolved'` and return 200 — NO intake call, NO audit entry.
6. **High-cost reject token check**: if `action === 'reject'` and `state.cost_accrued_usd > 50`:
   - No token → 428 Precondition Required, panel includes `requiresConfirm=true`.
   - Token present → `tokenStore.consume(token, operatorId, 'reject_'+requestId)`. On invalid → 422 with `validationError='Confirmation invalid: <reason>'`.
7. **Submit to intake**: `intakeClient.submitCommand({command:action, requestId: uuid, targetRequestId: requestId, comment, source:'portal', sourceUserId:operatorId, confirmationToken})`.
8. **On intake failure**: status `503` if `errorCode === 'NETWORK_TRANSIENT'` (panel `serviceError`), else `422` (panel `validationError`).
9. **On success**: `auditLogger.logGateAction({operatorId, requestId, action, comment, intakeCommandId, timestamp})`.
10. **Render synthesized resolved panel**: status `200`, `state` shallow-overridden with `status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'changes-requested'`, `panelMode='resolved'`, `resolvedBy=operatorId`, `resolvedAt=now`, `resolvedAction=action`, `resolvedComment=comment`. Synthesizing avoids a flicker when the file watcher hasn't yet invalidated the cache.

Routes mount with CSRF middleware (PLAN-014-2):

```ts
app.post('/repo/:repo/request/:id/gate/approve', csrfProtection, (c) => processGateAction(c, 'approve'));
app.post('/repo/:repo/request/:id/gate/request-changes', csrfProtection, (c) => processGateAction(c, 'request-changes'));
app.post('/repo/:repo/request/:id/gate/reject', csrfProtection, (c) => processGateAction(c, 'reject'));
```

### Idempotent Re-render Rule

The data accessor is the source of truth on every render. Rendering rule for the panel:

| state.status | Panel rendered |
|---|---|
| `pending-approval` (age < 24h, no `escalated_at`) | Active panel |
| `pending-approval` (age ≥ 24h or `escalated_at` set) | Active panel + escalation badge |
| `approved` / `rejected` / `changes-requested` | Resolved panel: "<Action> by <op> at <ts>" + comment |
| `cancelled` / `completed` | Resolved panel: "Request <status>" (no operator) |

This means SSE state-change events triggering `hx-get` of the panel fragment always render the correct mode. No duplicate-action window exists.

### `computeEscalation(state)`

```typescript
export function computeEscalation(state): { escalated: boolean; escalatedAt?: string } {
  if (state.status !== 'pending-approval') return { escalated: false };
  if (state.escalated_at) return { escalated: true, escalatedAt: state.escalated_at };
  if (Date.now() - new Date(state.created_at).getTime() >= 86_400_000) {
    return { escalated: true, escalatedAt: state.created_at };  // fallback when daemon hasn't stamped yet
  }
  return { escalated: false };
}
```

The portal does NOT mutate `escalated_at`; the daemon (TDD-001) is the writer. The local fallback handles the brief window before the daemon stamps the field.

### Panel Context Builder

`buildPanelContext(state, opts) → PanelContext` produces every field the template needs:
`requestId, title (description.slice(0,80)), repo, cost.total, status, panelMode, escalatedAt?, clarifyingQuestion?, resolvedBy?, resolvedAt?, resolvedAction?, resolvedComment?, validationError?, serviceError?, requiresConfirm?`.

`extractClarifyingQuestion(state)` walks `phase_history` from newest to oldest and returns the first entry's `metadata.clarifying_question` where `metadata.resolved !== true`.

`renderPanel(c, requestId, repo, opts, status)` is a small wrapper: read state, build context, render the fragment, return response with the given status.

## Acceptance Criteria

- [ ] `tokenStore.mint` returns a UUID and stores entry with `expiresAt = now + 60_000`, `consumed = false`
- [ ] `tokenStore.consume` returns `valid:false, reason:'unknown_token'` for unknown tokens
- [ ] `tokenStore.consume` returns `valid:false, reason:'already_consumed'` on second call with same token
- [ ] `tokenStore.consume` returns `valid:false, reason:'expired'` after TTL
- [ ] `tokenStore.consume` returns `valid:false, reason:'operator_mismatch'` when operator differs
- [ ] `tokenStore.consume` returns `valid:false, reason:'scope_mismatch'` when scope differs
- [ ] `POST /gate/confirm-token` returns 400 when `state.cost.total <= 50`
- [ ] `POST /gate/confirm-token` returns 200 with `requiresType: 'REJECT'` when cost > 50
- [ ] Modal disables submit until typed input matches `requiresType` exactly (case-sensitive)
- [ ] Modal cancel/backdrop returns focus to the originating reject button
- [ ] `processGateAction` returns 400 when URL action ≠ form `action` field
- [ ] `processGateAction` requires non-empty trimmed comment for `request-changes`, else 422
- [ ] `processGateAction` returns 200 with resolved panel when state is no longer `pending-approval` (idempotent; NO intake call)
- [ ] `processGateAction` returns 428 for high-cost reject without token
- [ ] `processGateAction` consumes the token before calling intake
- [ ] `processGateAction` returns 422 for high-cost reject with invalid token, including the failure reason
- [ ] `processGateAction` calls `intakeClient.submitCommand` exactly once on the success path
- [ ] `processGateAction` writes one audit log entry on success
- [ ] `processGateAction` returns 503 for `errorCode: 'NETWORK_TRANSIENT'`, 422 for other intake failures
- [ ] `computeEscalation` returns `escalated:false` when status is not pending-approval (even if `escalated_at` set)
- [ ] `computeEscalation` returns `escalated:true` when `escalated_at` is set on a pending request
- [ ] `computeEscalation` returns `escalated:true` when age ≥ 24h on a pending request even without `escalated_at`
- [ ] `extractClarifyingQuestion` returns the most recent unresolved entry from `phase_history`
- [ ] `extractClarifyingQuestion` returns `undefined` when all entries lack `clarifying_question` or are `resolved`

## Test Cases

1. **Token mint/consume happy** — mint(op1,"reject_R1"); consume → valid.
2. **Token consume twice** — second consume → `already_consumed`.
3. **Token expired** — advance clock 61s; consume → `expired`.
4. **Token operator mismatch** — consume with op2 → `operator_mismatch`.
5. **Token scope mismatch** — consume with different scope → `scope_mismatch`.
6. **Confirm-token endpoint low cost** — cost=25 → 400, `cost_below_threshold`.
7. **Confirm-token endpoint high cost** — cost=75 → 200, `requiresType:'REJECT'`.
8. **Gate POST URL/form mismatch** — POST `/gate/approve` with form `action=reject` → 400.
9. **Gate POST request-changes empty comment** → 422 "Comment is required".
10. **Gate POST already-resolved (idempotent)** — state.status='approved'; POST `/gate/approve` → 200 resolved panel; intake NOT called.
11. **Gate POST low-cost reject no token** — cost=25, no token → 200; intake called.
12. **Gate POST high-cost reject no token** — cost=75 → 428.
13. **Gate POST high-cost reject random token** → 422; error mentions `unknown_token`.
14. **Gate POST high-cost reject valid token** — token consumed; intake called once; 200; replay of same token returns idempotent 200 with no second intake call.
15. **Gate POST intake transient** — `NETWORK_TRANSIENT` → 503 with `serviceError`.
16. **Gate POST intake permanent** — `INVALID_TRANSITION` → 422 with `validationError`.
17. **Audit entry on success** — `logGateAction` called once with correct fields.
18. **Idempotent re-render across reload** — POST approve → 200 resolved; subsequent GET shows resolved panel.
19. **Escalation when escalated_at missing but old** — created 26h ago, no escalated_at, status pending → `escalated:true, escalatedAt = created_at`.
20. **Escalation false when resolved** — status='approved' even with `escalated_at` set → `escalated:false`.
21. **extractClarifyingQuestion most recent unresolved** — older unresolved + newer resolved → returns older.
22. **extractClarifyingQuestion all resolved** → returns undefined.

## Dependencies

- SPEC-015-2-01: `gate-action-panel.hbs`, `gate:requires-confirm` CustomEvent
- SPEC-015-2-03: `IntakeRouterClient.submitCommand`, error codes (`NETWORK_TRANSIENT`, `INVALID_TRANSITION`, etc.)
- PLAN-014-2: CSRF middleware (`csrfProtection`)
- PLAN-014-1: `getOperatorId(c)` from auth context
- PLAN-015-1: `stateAccessor.read(repo, requestId) → RequestState | null`
- PLAN-009-5: `auditLogger.logGateAction(entry)`
- TDD-001: Daemon's `escalated_at` field semantics
- HTMX 2.x runtime (loaded by base layout)

## Notes

- The token store is in-process and lost on restart. Acceptable: the modal flow is bounded to 60s; restarts during a rejection ceremony are rare and the worst case is the user retypes "REJECT". Persisting tokens to disk would create synchronization problems with no upside.
- HTTP 428 Precondition Required for "needs typed-CONFIRM" is deliberate: it's the correct semantic for "you must satisfy a precondition first" and HTMX/browsers do not surface it as a generic error. Our client intercepts and runs the modal flow.
- After a successful gate action, we synthesize the resolved panel rather than re-reading state.json. The intake router commits asynchronously; the watcher may not have invalidated the cache yet. Synthesizing avoids a brief flicker showing stale "pending-approval" text.
- `escalated_at` falls back to `created_at` when the daemon hasn't stamped it yet. Display reads "25 hours ago" in either case — close enough for operator UX, and consistent once the daemon catches up.
- We deliberately do NOT extend typed-CONFIRM to `approve` actions even on high cost. Approval is forward; the cost gate is enforced upstream by the orchestrator's budget check (PLAN-010-2). Typed-CONFIRM is reserved for irreversible/destructive actions.
- Comments are trimmed before validation. A comment of `"   "` is treated as empty for the request-changes requirement, preventing trivial bypass.
- The 24h escalation badge is purely advisory display. Operators can still approve/reject normally on escalated requests.
