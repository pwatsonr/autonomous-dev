# SPEC-014-2-02: Typed-CONFIRM Modal for Destructive Operations

## Metadata
- **Parent Plan**: PLAN-014-2
- **Tasks Covered**: TASK-005 (Typed CONFIRM Modal System)
- **Estimated effort**: 5 hours

## Description
Implement a server-authoritative typed-confirmation flow that protects destructive operations from accidental and CSRF-bypassed execution. The user must (a) request a confirmation token, (b) type the EXACT, server-issued phrase (case-sensitive) into a modal, and (c) submit the typed phrase WITH the token. Tokens are one-time-use, session-bound, expire in 60 seconds, and are rate-limited to 3 per session per minute. Server-side enforcement is non-negotiable — no client-side bypass possible. Applies to: kill-switch activation, circuit-breaker reset, allowlist removal, trust-level reduction, pipeline deletion, config reset.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/security/confirmation-tokens.ts` | Create | `TypedConfirmationService` class with token generation, validation, rate limiting, cleanup |
| `src/portal/security/confirmation-phrases.ts` | Create | Allowlist mapping `action -> phrase` (single source of truth) |
| `src/portal/routes/confirmation-routes.ts` | Create | `POST /api/security/confirmation/request` and `POST /api/security/confirmation/validate` |
| `src/portal/middleware/require-confirmation.ts` | Create | `requireConfirmation(action)` middleware factory for protected routes |
| `src/portal/components/confirm-modal.hbs` | Create | Server-rendered modal partial with HTMX wiring |
| `src/portal/public/js/confirm-modal.js` | Create | Client-side modal show/hide, input validation, error display |
| `src/portal/views/components/confirm-modal-input.hbs` | Create | HTMX swap target for the typed input + Confirm button enablement |

## Implementation Details

### Confirmation Phrase Allowlist (`confirmation-phrases.ts`)

```typescript
export const CONFIRMATION_PHRASES: Readonly<Record<string, string>> = Object.freeze({
  'kill-switch':            'EMERGENCY STOP',
  'circuit-breaker-reset':  'RESET BREAKER',
  'allowlist-remove':       'REMOVE ACCESS',
  'trust-level-reduce':     'REDUCE TRUST',
  'delete-pipeline':        'DELETE FOREVER',
  'reset-config':           'RESET CONFIG',
});

export function getConfirmationPhrase(action: string): string | null {
  return CONFIRMATION_PHRASES[action] ?? null;
}
```

Adding a new destructive action requires updating this file. The service rejects requests for actions not in the allowlist.

### `TypedConfirmationService`

`ConfirmationConfig`:
- `tokenTTL: number` — milliseconds, default `60_000`
- `maxTokensPerSession: number` — default `3`
- `rateLimitWindow: number` — milliseconds, default `60_000`
- `maxConfirmationLength: number` — default `100` (input length cap)

`ConfirmationToken` (internal):
- `token: string` (32 hex chars from `crypto.randomBytes(16)`)
- `createdAt: number`
- `sessionId: string`
- `action: string`
- `confirmationPhrase: string` (denormalized at issue time so phrase changes don't affect live tokens)
- `metadata?: Record<string, unknown>`

`generateConfirmationToken(sessionId, request: {action, metadata?}) -> {token?, success, error?}`:
1. Validate `action` against `CONFIRMATION_PHRASES` allowlist. If unknown: `{success: false, error: 'unknown-action'}`.
2. Run `checkRateLimit(sessionId)`. If exceeded: `{success: false, error: 'rate-limit-exceeded'}`.
3. `token = crypto.randomBytes(16).toString('hex')` (32 chars).
4. Resolve `confirmationPhrase = getConfirmationPhrase(action)`.
5. Store `{token, createdAt: Date.now(), sessionId, action, confirmationPhrase, metadata}` in `Map<token, ConfirmationToken>`.
6. Append `Date.now()` to `rateLimitStore.get(sessionId)` array (create if absent).
7. Log: `{event: 'confirmation_token_issued', sessionId, action}`.
8. Return `{token, success: true}`.

`validateConfirmation(token, sessionId, userInput) -> {valid, error?, action?, metadata?}`:
1. Look up `stored = tokenStore.get(token)`. If missing: `{valid: false, error: 'invalid-or-expired-token'}`.
2. If `stored.sessionId !== sessionId`: `{valid: false, error: 'session-mismatch'}` (do NOT delete — could be a guess attack on another session).
3. If `Date.now() - stored.createdAt > tokenTTL`: delete and `{valid: false, error: 'token-expired'}`.
4. If `userInput.length > maxConfirmationLength`: `{valid: false, error: 'input-too-long'}`.
5. If `userInput !== stored.confirmationPhrase` (strict, case-sensitive, no trim): `{valid: false, error: 'phrase-mismatch'}`. Do NOT delete — allow retry within TTL.
6. Delete from store (one-time use).
7. Log: `{event: 'confirmation_validated', sessionId, action: stored.action}`.
8. Return `{valid: true, action: stored.action, metadata: stored.metadata}`.

`checkRateLimit(sessionId) -> boolean`:
- Read `attempts = rateLimitStore.get(sessionId) || []`.
- Filter to entries where `now - timestamp < rateLimitWindow`.
- Return `validAttempts.length < maxTokensPerSession`.

Cleanup runs every 30 seconds:
- Delete tokens older than `tokenTTL`.
- Prune `rateLimitStore` entries: drop attempts older than window; delete session entry if no attempts remain.
- LRU cap: max 5,000 active tokens — evict oldest if exceeded.

### Confirmation Routes

`POST /api/security/confirmation/request`:
- Body: `{action: string, metadata?: object}`
- Auth required (existing session middleware)
- CSRF required (SPEC-014-2-01 middleware)
- Calls `service.generateConfirmationToken(req.session.id, req.body)`
- Response 200: `{token, phrase, ttl: 60}` (phrase echoed so UI can render the prompt — this is fine because typing IS the confirmation)
- Response 429: `{error: 'rate-limit-exceeded'}` if rate-limited
- Response 400: `{error: 'unknown-action'}` if action not allowlisted

`POST /api/security/confirmation/validate`:
- Body: `{token: string, userInput: string}`
- Auth + CSRF required
- Calls `service.validateConfirmation(token, req.session.id, userInput)`
- On success: stores result in `req.session.confirmedActions[token] = {action, validatedAt: Date.now(), expiresAt: Date.now() + 30_000}`. The action's actual route handler reads this within 30 seconds to consume the confirmation.
- Response 200 on success, 400 with error code on failure.

### `requireConfirmation(action)` Middleware

Used on the actual destructive endpoint:
```typescript
router.post('/admin/kill-switch', requireConfirmation('kill-switch'), killSwitchHandler);
```

Behavior:
1. Read `confirmationToken = req.headers['x-confirmation-token']` or `req.body._confirmationToken`.
2. If missing: 403 `{error: 'confirmation-required', action}`.
3. Look up `req.session.confirmedActions[confirmationToken]`. If missing: 403 `{error: 'invalid-confirmation'}`.
4. If `confirmation.action !== action`: 403 `{error: 'wrong-action-confirmed'}`.
5. If `Date.now() > confirmation.expiresAt`: 403 `{error: 'confirmation-expired'}`. Delete from session.
6. Delete from session (one-time use). Call `next()`.

### Modal UI (`confirm-modal.hbs`)

```handlebars
<div id="confirm-modal" class="modal-overlay" role="dialog" aria-labelledby="confirm-title" aria-modal="true" hidden>
  <div class="modal-content">
    <h2 id="confirm-title">Confirm {{actionLabel}}</h2>
    <p>To proceed, type the following phrase EXACTLY:</p>
    <code class="confirm-phrase">{{phrase}}</code>
    <input
      type="text"
      id="confirm-input"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      maxlength="100"
      aria-describedby="confirm-error"
    />
    <p id="confirm-error" class="error" role="alert" hidden></p>
    <p class="confirm-ttl">Expires in <span id="confirm-countdown">60</span>s</p>
    <div class="modal-actions">
      <button type="button" id="confirm-cancel">Cancel</button>
      <button type="button" id="confirm-submit" disabled>Confirm</button>
    </div>
  </div>
</div>
```

`confirm-modal.js` behavior:
- Exposes `window.openConfirmModal(action, onConfirmed)` for callers.
- Calls `POST /api/security/confirmation/request` with `{action}`.
- Renders modal with received `phrase` and `token`.
- Enables Submit button only when `input.value === phrase` (strict equality).
- Starts 60s countdown; disables Submit at 0.
- On Submit: `POST /api/security/confirmation/validate` with `{token, userInput}`.
- On 200: closes modal, invokes `onConfirmed(token)` so caller can include `X-Confirmation-Token` header in the actual destructive request.
- On 4xx: shows error in `#confirm-error`, keeps modal open (unless expired).
- Cancel button or Escape key: closes modal without firing the action.

## Acceptance Criteria

- [ ] Confirmation phrases defined in single allowlist file; service rejects actions not in allowlist with `unknown-action` error
- [ ] Tokens generated via `crypto.randomBytes(16).toString('hex')` (32 chars)
- [ ] Token TTL enforced server-side at exactly 60 seconds; expired tokens rejected and deleted on validation attempt
- [ ] Rate limiting: max 3 token requests per session per 60-second window; 4th request returns 429
- [ ] Phrase comparison is case-sensitive, no trim, no normalization (strict equality)
- [ ] Token is one-time-use: deleted on successful validation
- [ ] Failed validations (phrase mismatch) do NOT delete the token — user can retry within TTL
- [ ] Validation requires session match — using a token from a different session returns `session-mismatch` and does NOT delete the token
- [ ] `requireConfirmation('action')` middleware blocks destructive route if no valid recent confirmation in session
- [ ] Confirmation expires from session 30 seconds after validation (forces user to actually use it promptly)
- [ ] Cleanup interval (30s) removes expired tokens and rate-limit entries
- [ ] LRU cap at 5,000 tokens prevents memory exhaustion
- [ ] Modal accessible: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, `aria-describedby`, focus trap, Escape closes
- [ ] Modal input has `autocomplete=off`, `autocorrect=off`, `spellcheck=false`, `maxlength=100`
- [ ] Submit button disabled until typed input EXACTLY matches phrase
- [ ] Server-side input length cap (100 chars) enforced — over-length input rejected with `input-too-long`
- [ ] All token issue/validate events logged via security-logger
- [ ] CSRF middleware MUST run before confirmation routes — confirmation does not bypass CSRF

## Dependencies

- **Inbound**: SPEC-014-2-01 (CSRF middleware MUST guard confirmation endpoints)
- **Inbound**: Express session middleware (PLAN-014-1)
- **Outbound**: Destructive route handlers (kill-switch, allowlist-remove, etc.) consume `requireConfirmation(action)` middleware
- **Outbound**: SPEC-014-2-05 imports `TypedConfirmationService` for unit tests; SPEC-014-2-03 templates render modal partial
- **Libraries**: Node `crypto` builtin only

## Notes

- **Why one-time-use server-side tokens?** Defense in depth: even if an attacker bypasses CSRF, they cannot trigger destructive actions without a fresh server-issued token AND knowing the typed phrase.
- **Why echo the phrase to the client?** The phrase is not a secret — it's a forced friction mechanism. Typing "EMERGENCY STOP" prevents click-through accidents. The TOKEN is the secret.
- **Why no trim/normalization?** Strict equality forces deliberate typing. "emergency stop" must fail. Trailing spaces fail. This is intentional.
- **Memory bound rationale**: 5,000 tokens × ~200 bytes = 1MB max. Acceptable for a portal admin tool.
- **Race condition with cleanup**: Generation and validation happen in single-threaded Node — no locking needed. Cleanup interval mutating the Map during iteration is safe with `entries()` snapshot.
- **Multi-tab UX**: Each tab gets its own token. Closing the modal in one tab does not invalidate tokens in others (acceptable — tokens expire in 60s anyway).
- **Future**: Token storage will move to Redis when multi-instance deployment lands (PLAN-014-3 followup).
