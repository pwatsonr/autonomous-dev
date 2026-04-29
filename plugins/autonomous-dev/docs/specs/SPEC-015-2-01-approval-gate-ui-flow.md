# SPEC-015-2-01: Approval Gate UI Flow — Clarifying Questions, HTMX Buttons, Escalation Status

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Task 2 (gate-action-panel template), Task 10 (gate-actions frontend), portion of Task 4 (HTMX response shape)
- **Estimated effort**: 5 hours

## Description

Render the approval gate panel and wire its three action buttons (Approve / Request Changes / Reject) into the request-detail page. This spec defines the Handlebars fragment, the HTMX swap contracts for each action, the clarifying-questions display when the orchestrator has emitted one, the comment textarea with character counting, and the escalation status badge for requests past 24h. The typed-CONFIRM modal is in SPEC-015-2-04, the HTTP client is in SPEC-015-2-03, and the settings editor is in SPEC-015-2-02. Endpoint handlers are sketched only enough to define the response contract — full handler logic is in SPEC-015-2-04.

The frontend is HTMX-first per TDD-013 §3.2: buttons submit via `hx-post` and replace the panel server-side. Only the typed-CONFIRM hand-off requires JavaScript (a CustomEvent picked up by SPEC-015-2-04).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/templates/fragments/gate-action-panel.hbs` | Create | Buttons + textarea + clarify/escalation slots; supports `panelMode={active|resolved}` |
| `src/portal/templates/fragments/clarifying-questions.hbs` | Create | Renders pending question text + options |
| `src/portal/templates/fragments/escalation-badge.hbs` | Create | Shows "Escalated" badge when `escalatedAt` is set |
| `src/portal/templates/partials/index.ts` | Modify | Register the three fragments as partials |
| `src/portal/js/gate-actions.ts` | Create | Char counter + high-cost intercept that dispatches `gate:requires-confirm` |
| `src/portal/templates/layouts/base.hbs` | Modify | Inject `gate-actions.ts` script tag |

## Implementation Details

### Panel Structure (`gate-action-panel.hbs`)

The fragment has an `id="gate-panel-{{requestId}}"` root and renders one of two branches:
- **Active** (`status === 'pending-approval'`): three submit buttons, comment textarea, csrf, and (if applicable) clarifying-question and escalation slots.
- **Resolved**: a status line such as "Approved by {{resolvedBy}} at {{resolvedAt}}" or "Rejected by {{resolvedBy}}: {{resolvedComment}}". No buttons.

Active form attributes: `hx-target="#gate-panel-{{requestId}}"`, `hx-swap="outerHTML"`, `hx-include="this"`. Each button has `hx-post="/repo/{{repo}}/request/{{requestId}}/gate/{action}"` and `name="action" value="{action}"`. The reject button additionally has `data-requires-confirm="{{#gt cost.total 50}}true{{else}}false{{/gt}}"` and request-changes has `data-requires-comment="true"`.

Textarea: `name="comment"`, `maxlength="1000"`, `aria-describedby="char-count-{{requestId}}"`. Counter span: `<span id="char-count-{{requestId}}" class="char-count">0/1000</span>`.

Buttons are inside a `<div class="gate-actions" role="group" aria-label="Approval actions">`. Each button has `aria-label="<Action> request {{requestId}}"`.

The fragment exposes these context fields (consumed; produced by SPEC-015-2-04's panel-context-builder):
`requestId, title, repo, cost.total, status, panelMode, escalatedAt?, clarifyingQuestion?, resolvedBy?, resolvedAt?, resolvedAction?, resolvedComment?, validationError?, serviceError?`.

### Clarifying Questions (`clarifying-questions.hbs`)

Renders inside `<aside class="clarifying-questions" role="region" aria-label="Clarifying question from orchestrator">`. Contents: `<h4>Orchestrator needs clarification</h4>`, the question text in `<p class="question-text">`, an optional `<ul class="question-options">` with one `<li>` per option, and `<time datetime="{{askedAt}}">` rendered via `formatTime`. Type:

```ts
type ClarifyingQuestion = { text: string; options?: string[]; askedAt: string };
```

### Escalation Badge (`escalation-badge.hbs`)

`<div class="escalation-badge" role="status">` containing the icon, "Escalated" label, and `<time datetime="{{escalatedAt}}" data-relative="true">{{formatRelative escalatedAt}}</time>`. The `role="status"` (polite live region) means screen readers announce the badge non-intrusively after panel re-renders.

### HTMX Swap Contract

| Server status | Server response | Client effect |
|---|---|---|
| 200 (action success) | Re-rendered panel with `panelMode='resolved'` | Outer-HTML swap; buttons disappear |
| 200 (idempotent re-render of already-resolved request) | Same as above | Same |
| 422 (validation error) | Re-rendered panel with `validationError` slot populated | Inline error, buttons remain |
| 428 (high-cost reject without token) | Same panel + `requiresConfirm=true` | Frontend script handles modal |
| 503 (intake unavailable) | Re-rendered panel with `serviceError` slot ("Intake router unavailable; please retry in 30s") | Inline error, buttons remain |
| 400 (URL/form action mismatch) | Re-rendered panel with `validationError='Action mismatch'` | Same |

### Frontend Script (`gate-actions.ts`)

Two responsibilities only — everything else is pure HTMX:

1. **Character counter** — on `input` events bubbling from `.comment-input` textareas, update the sibling `[id=aria-describedby]` span to `${value.length}/1000`.

2. **High-cost reject intercept** — listen on `document` at `capture: true` (so we run before HTMX's bubble-phase listener). When a button with `data-requires-confirm="true"` is clicked, `e.preventDefault()` and `e.stopPropagation()`, then dispatch `gate:requires-confirm` CustomEvent on the panel with `detail: { requestId, action, costAmount, form }`. SPEC-015-2-04 listens, runs the modal, and on success injects the token and calls `htmx.trigger(form, 'submit')`.

3. **Required-comment toggle (subsidiary)** — on the same click handler, when the clicked button has `data-requires-comment="true"`, set `textarea.required = true` so native validation blocks submission of empty comments.

### Resolved Panel Variant

When `panelMode === 'resolved'`, the fragment renders no form and no buttons. Instead:

```handlebars
<div id="gate-panel-{{requestId}}" class="gate-action-panel resolved" data-request-id="{{requestId}}">
  <p class="resolution-status">
    {{statusLabel resolvedAction}} by <strong>{{resolvedBy}}</strong>
    at <time datetime="{{resolvedAt}}">{{formatTime resolvedAt}}</time>
  </p>
  {{#if resolvedComment}}<blockquote class="resolution-comment">{{resolvedComment}}</blockquote>{{/if}}
</div>
```

`statusLabel` Handlebars helper maps `approve→"Approved"`, `request-changes→"Changes requested"`, `reject→"Rejected"`, `cancelled→"Cancelled"`, `completed→"Completed"`.

## Acceptance Criteria

- [ ] Panel renders three action buttons each with `hx-post` to the matching `/gate/{action}` URL and `name="action" value="{action}"`
- [ ] Each button has `aria-label` that includes the request ID
- [ ] Reject button has `data-requires-confirm="true"` when `cost.total > 50`, else `"false"`
- [ ] Request-changes button has `data-requires-comment="true"`
- [ ] Textarea has `maxlength="1000"` wired to a sibling `<span class="char-count">N/1000</span>` updated on every `input` event
- [ ] When `clarifyingQuestion` is present, `clarifying-questions.hbs` is rendered ABOVE the form
- [ ] When `escalatedAt` is present, `escalation-badge.hbs` is rendered showing relative time via `formatRelative`
- [ ] HTMX 200 response containing `panelMode=resolved` swaps and hides action buttons
- [ ] HTMX 422 response includes a `validationError` slot rendered inline
- [ ] HTMX 503 response includes a `serviceError` slot with retry guidance
- [ ] Clicking a reject button with `data-requires-confirm="true"` dispatches `gate:requires-confirm` and HTMX does NOT auto-submit (verified via `htmx:beforeRequest` not firing)
- [ ] Clicking `request-changes` sets `textarea.required = true` so empty submission is blocked client-side
- [ ] CSRF token partial is included inside the form (consumed by middleware in PLAN-014-2)
- [ ] Resolved-mode template renders no form/buttons and a status line via `statusLabel` helper

## Test Cases

1. **Render active, low cost, no clarify, no escalation** — three buttons, no aside, no badge, reject `data-requires-confirm="false"`.
2. **Render active, high cost ($75)** — reject `data-requires-confirm="true"`.
3. **Render with clarifying question** — pass `{text, options: [A,B], askedAt}`. Assert: aside, two `<li>`, `<time datetime>`.
4. **Render with escalation 25h** — pass `escalatedAt = now-25h`. Assert: badge contains relative-time.
5. **Render resolved approve** — `{panelMode:'resolved', resolvedAction:'approve', resolvedBy:'op1', resolvedAt}`. Assert: no buttons, status line "Approved by op1".
6. **Render resolved reject with comment** — same with `resolvedComment="too expensive"`. Assert: blockquote contains comment.
7. **Char counter** — dispatch `input` with 250 chars. Assert: counter shows "250/1000".
8. **High-cost reject intercept** — click reject on `data-requires-confirm="true"`. Assert: `gate:requires-confirm` CustomEvent fired with full detail; `htmx:beforeRequest` NOT fired.
9. **Low-cost reject submits normally** — click reject on `data-requires-confirm="false"`. Assert: no CustomEvent; HTMX submits.
10. **Request-changes empty comment blocked** — click request-changes with empty textarea. Assert: form `:invalid`; no HTMX request fired.
11. **HTMX 503 swap** — server returns 503 + fragment with `<div class="service-error">`. Assert: panel innerHTML replaced; service-error visible.

## Dependencies

- PLAN-013-3: HTMX-aware rendering helpers and CSRF partial
- PLAN-015-1: Data accessor producing the panel context object
- SPEC-015-2-03: HTTP client invoked by the route handler (panel does not call directly)
- SPEC-015-2-04: Confirmation modal listens for `gate:requires-confirm` and panel-context-builder
- Handlebars helpers: `gt`, `formatTime`, `formatRelative`, `statusLabel`

## Notes

- Each button posts to a different URL via per-button `hx-post`; the server still cross-checks `submittedAction === urlAction` and returns 400 on mismatch. This guards against tampered clients.
- `outerHTML` swap is required because the panel's root carries the `id` HTMX targets; preserving the `id` on re-render keeps subsequent submissions wired.
- The `capture: true` listener placement is load-bearing: HTMX binds at bubble phase, so capturing first is the only reliable way to preventDefault before HTMX dispatches its request.
- Escalation is display-only here; setting/clearing `escalated_at` is the daemon's job (TDD-001). The portal computes a fallback when `escalated_at` is missing but age > 24h, so display gracefully tolerates daemon delay.
