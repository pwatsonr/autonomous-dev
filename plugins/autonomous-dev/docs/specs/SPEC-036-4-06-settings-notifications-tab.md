# SPEC-036-4-06: Settings Notifications Tab

## Metadata
- **Parent Plan**: PLAN-036-4
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1, §6.5 — notifications)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-20: notifications)
- **Tasks Covered**: Notifications subset of PLAN-036-4 Task 5 (General tab)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-035-2 (`Btn`, `Chip`, `Card`), SPEC-036-4-01 (route + tab shell)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Render the Notifications subsection within the Settings General panel:
Discord webhook URL, Slack webhook URL, default notification method
(radio: discord / slack / both / none), and Do-Not-Disturb hours
(start/end time inputs). Validation is **bidirectional** — the server
validates URL format and webhook reachability on POST (authoritative),
the client validates URL shape and DND time-range coherence on `input`.

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | The General panel includes a `Card` titled "Notifications" containing four control groups: Discord webhook (`<input type="url" id="discord-webhook">`), Slack webhook (`<input type="url" id="slack-webhook">`), default method (4 radios `name="notify-default"`), DND hours (`<input type="time" id="dnd-start">` and `#dnd-end` plus a checkbox `#dnd-enabled`). |
| AC-02 | Each webhook input shows a `Chip` next to it indicating last-test status (`tone="ok"` if last `POST` returned 2xx, `tone="warn"` for 4xx, `tone="err"` for 5xx, `tone="muted"` if untested). A "Test" `Btn kind="ghost" size="sm"` triggers `hx-post="/api/settings/notifications/test/:channel"` and updates the chip. |
| AC-03 | **Client-side validation** (`form-validation.js`): URL inputs validate against `^https://(discord\.com\|hooks\.slack\.com)/` for the respective channel — mismatched host renders `field-error` "Discord webhook must start with https://discord.com/". Empty URLs are allowed only if that channel is not selected as default. DND start ≥ end (when DND enabled and times are non-wrapping) renders `field-error` "DND end must be after start (or wrap past midnight)". |
| AC-04 | **Server-side validation** (`POST /api/settings/notifications`): URL format validated with stricter regex (full webhook path); selected default method must have a non-empty webhook; DND times parsed as `HH:MM`; mismatch returns 400 with `{ errors: { fieldId: message } }`. |
| AC-05 | The "Test" button POSTs a synthetic message to the webhook server-side (never client-side, per CSP and to avoid leaking bot tokens to the browser). Server returns the upstream status; the panel swaps the chip via `hx-target`. |
| AC-06 | If `notify-default` is `none`, the DND controls render disabled with helper text "DND has no effect when notifications are off". The disable is enforced both server- and client-side. |
| AC-07 | A "Send test notification now" `Btn kind="primary"` is enabled only when the saved configuration is valid (server-side check on render); clicking sends a real notification and shows the result inline. |

## Acceptance Criteria — Bidirectional Summary

- **Server-side path**: `POST /api/settings/notifications` validates URL hosts, default-method coherence, DND time format. Returns 400 with field-keyed errors.
- **Client-side path**: `input` events validate URL prefix, default-method/webhook coherence, DND ordering. Inserts/removes `field-error` spans. Disables Save while any error present.

## Implementation

- Notifications card fragment: `fragments/notifications-card.tsx` (snapshot testable).
- Webhook test server route: `server/routes/notifications-test.ts` shells out to `fetch` with a 5s timeout; returns the upstream status code in a small JSON body.
- Client predicate: URL prefix + DND-coherence functions exported from `form-validation.js` for unit testing.

## Tests

- **Snapshot (`tests/snapshot/notifications-card.test.ts`)**: all four states (untested / ok / warn / err) for both webhooks; DND enabled and disabled.
- **Server (`tests/integration/settings-notifications.test.ts`)**: POST with `discord` URL hosted on `evil.com` → 400; POST default=`discord` with empty webhook → 400; POST DND start `23:00` end `01:00` (wrap) → 200; webhook test endpoint stubbed via mock returns 503 → chip becomes `err`.
- **Client (`tests/clientside/form-validation-notifications.test.ts`)**: bad-host URL inserts error; valid URL clears it; DND `start=10:00 end=09:00` (non-wrap) inserts error; wrap allowed when explicitly opted in.

## Verification

- `bun test` for the three test files passes.
- Manual smoke: enter Discord webhook with bad host, observe inline error; enter valid one, click Test, observe chip flip to `ok`; toggle DND, observe disabled controls when default=none.
