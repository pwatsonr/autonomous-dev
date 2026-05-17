# Portal Bug Catalog — 2026-05-16

**Probe context.** Portal source-mode at `http://localhost:19280` (PID 24971 at time of probe), daemon alive (`~/.autonomous-dev/heartbeat.json` < 60s old, `iteration_count` advancing). All bugs below were reproduced via `curl` and source inspection from the running build. Each repro should complete in under 60 seconds.

**Top-3 worst offenders.**

1. **BUG-1 (P0) — Settings reader and writer use different files with different shapes.** Every save on the General tab returns "SAVED" but the page never reflects the saved value on reload. This is the "change data and it not saving" experience.
2. **BUG-5 (P0) — Approve button on `/approvals` is permanently broken.** The reader pulls gates from the request ledger (`gate-decisions/*.json`); the writer (`/api/approvals/:id/approve`) looks the id up in a *different* file (`approvals-queue.json`) that has never been populated. Every Approve click returns 404. The approvals UI is wallpaper.
3. **BUG-2 (P0) — `/health` always reports daemon dead.** The Hono `/health` route reads `last_seen` from `heartbeat.json` but the daemon writes `timestamp`. The rail "Daemon down" pill and degradation banner on every page are driven by this. Two other readers (`daemon-status` + `daemon-readers`) have the same disagreement against the third reader (`readers/schemas/heartbeat.ts`).

The catalog has **18 bugs**: 7 P0, 8 P1, 3 P2.

> **Update 2026-05-17:** all 18 P0/P1/P2 catalog bugs above (#1–18) are
> now fixed and merged. PRs #271, #272, #273, #275, #276, #277, #278,
> #280, #281, #282, #283, #284, #285 — plus the **foundational #279**
> which added `--allowedTools` to the daemon's claude invocation
> (every prior pipeline run was producing fake "pass" results because
> agents couldn't write files). End-to-end validation REQ-000010 walked
> `prd → … → monitor → done` and **shipped real working code** (`hello.py`
> + passing pytest) for the first time ever in the project's history.
>
> Four new bugs discovered after that work:
> - **BUG-19**: design/review-phase agents (prd-author, tdd-author,
>   plan-author, spec-author, *-reviewer, monitor agent) still synthesize
>   their phase results — they have file tools now but choose not to
>   write `phase-result-<phase>.json`. Pure execution phases (code,
>   integration, deploy) do write them correctly.
> - **BUG-20**: heartbeat goes 15+ min stale after laptop sleep — daemon
>   process is alive but no fresh write until next iteration tick.
>   Self-heals; cosmetic only.
> - **BUG-21**: `autonomous-dev request cancel REQ-N` prompts for
>   `CONFIRM` but no CLI flag accepts it. Subsequent calls just re-loop
>   the same prompt. Operators are locked into `daemon stop` to halt a
>   bad request.
> - **BUG-22**: `/logs` and `/repos` are reachable but missing from the
>   primary rail-nav — operators can only reach them by typing the URL.
>   Surfaced by the Cypress Phase 1B nav-coverage test.

---

## BUG-1 — Settings General-tab save: "SAVED" but never persists (split reader/writer)
- **Severity:** P0
- **Page / control:** `GET /settings` General tab → Trust level select + Save / Cost cap inputs + Save / Notifications form
- **Repro (copy-paste):**
  ```
  curl -s -X POST http://localhost:19280/settings -H "HX-Request: true" \
    --data 'trust-level=L3' | head -c 200
  # → 200, fragment says SAVED
  curl -s http://localhost:19280/settings | grep -oE 'name="trust-level"[^>]*>.*?</select>' | head -c 300
  # → still selected="L2" (or whatever it was before)
  ```
- **Expected:** Trust-level select on the reloaded page reflects L3.
- **Actual:** Reloaded page shows the prior value. `~/.claude/autonomous-dev.json` is touched but the field name written is not the field the reader reads.
- **Where the bug lives:**
  - Writer: `server/wiring/settings-store.tsx:100-162` — `saveFromForm` only knows about `dailyCap`, `defaultVariant`, `defaultBackend`, `notifications.*`. It silently drops `trust-level`, `perRequest`, `daily`, `monthly`, and the trust-override fields, yet still returns the "SAVED" fragment.
  - Reader: `server/wiring/settings-reader.ts:30-69` — reads `~/.autonomous-dev/portal-settings.json` with shape `{trustLevels:{global,perRepo},repositories:{allowlist:[{id,path}]}}`. **Writer never touches this file**; writer mutates `~/.claude/autonomous-dev.json` with the wrong shape.
- **Cypress test that would catch this:**
  ```js
  cy.visit('/settings');
  cy.get('select[name="trust-level"]').select('L3');
  cy.contains('button','Save Trust Level').click();
  cy.contains('SAVED');
  cy.reload();
  cy.get('select[name="trust-level"]').should('have.value','L3');
  ```

---

## BUG-2 — `/health` always reports daemon dead (field name mismatch)
- **Severity:** P0
- **Page / control:** `GET /health` JSON + the "Daemon down" pill in the rail-ops sidebar on every page + the degradation-banner mutation gate
- **Repro:**
  ```
  curl -s http://localhost:19280/health
  # → 503 {"status":"degraded","daemon":{"status":"dead",...}}
  cat ~/.autonomous-dev/heartbeat.json
  # → {"timestamp":"2026-...","pid":...,"iteration_count":...}  (NO "last_seen" key)
  ```
- **Expected:** `/health` returns 200 with `daemon.status:"ok"` when the heartbeat file is fresh.
- **Actual:** Always 503 / `dead` because the JSON reader looks up the wrong key.
- **Where the bug lives:** `server/lib/daemon-status.ts:87-90` reads `obj["last_seen"]`. The daemon writes `timestamp`. `server/readers/schemas/heartbeat.ts:21` expects `ts` and `version:1`. Three readers, three different field names, none agree with the daemon.
- **Note:** `/api/daemon-status` (used by the rail-ops pill in real-time poll) sidesteps this by using `fs.stat().mtimeMs` on the heartbeat file — so the pill *can* read "running" while `/health` says "dead". The degradation-banner uses `/health` though, so it's permanently visible.
- **Cypress:**
  ```js
  cy.request({url:'/health',failOnStatusCode:false}).its('body.daemon.status').should('eq','ok');
  ```

---

## BUG-3 — Allowlist add form sends form-encoded body but endpoint requires JSON
- **Severity:** P0
- **Page / control:** `/settings` → General tab → "Add allowlist path" form
- **Repro:**
  ```
  curl -s -X POST http://localhost:19280/api/settings/allowlist \
    -H "HX-Request: true" -H "Content-Type: application/x-www-form-urlencoded" \
    --data "path=/Users/pwatson/codebase"
  # → 400 {"error":"invalid-body"}
  ```
  The page-rendered form: `<form class="add-allowlist-form" hx-post="/api/settings/allowlist" ...>` with an `<input name="path">`. HTMX submits as form-encoded by default — never JSON.
- **Expected:** Add a real git repo under home → row appears in the allowlist table.
- **Actual:** Every Add click → 400 "invalid-body" (the route body parses `c.req.json()`).
- **Where the bug lives:** `server/routes/settings-actions.tsx:172-181` calls `c.req.json()`; the form on the page (`server/templates/views/settings.tsx:203`) has no `hx-ext="json-enc"`. Either teach the route to accept form-encoded bodies, or add `hx-headers='{"Content-Type":"application/json"}'` + `hx-ext="json-enc"` on the form.
- **Cypress:**
  ```js
  cy.intercept('POST','/api/settings/allowlist').as('add');
  cy.get('input[name="path"]').type('/Users/op/somerepo');
  cy.contains('button','Add').click();
  cy.wait('@add').its('response.statusCode').should('be.oneOf',[200,201,403,422]); // never 400
  ```

---

## BUG-4 — Per-page polling DOES NOT pause when tab is backgrounded
- **Severity:** P1
- **Page / control:** Every page with `hx-trigger`: dashboard, requests, approvals, costs, ops, repos
- **Repro:**
  ```
  curl -s http://localhost:19280/ | grep -oE 'hx-trigger="[^"]*"'
  # → hx-trigger="every 10s"     (no visibility filter)
  ```
- **Expected:** Source declares `hx-trigger="every 10s [document.visibilityState === 'visible']"` (see `server/templates/views/dashboard.tsx:173`) so background tabs stop polling.
- **Actual:** Rendered output is bare `every 10s`. JSX template literal is rendered with HTML-entity encoding that strips/breaks the bracket-expression so HTMX never sees the filter and polls forever. (The brackets-syntax is a real HTMX feature — the issue is how it lands in the DOM.) Result: 6 pages polling at 6 RPM each, indefinitely.
- **Where the bug lives:** Every `views/*.tsx` `hx-trigger` value containing brackets — verified rendered string is bare `every 10s`. The bracket syntax is being entity-encoded or path-parsed by Hono before reaching the browser. Workaround: set the trigger via JS or precompose the value before passing into JSX (escape ampersands explicitly), or use `htmx.config.responseHandling` polling-pause hook.
- **Cypress:** Use `cy.spy(window,'fetch')` after toggling document.visibilityState to "hidden" and assert no `/` GET fires in the next 12s.

---

## BUG-5 — Approve / Reject buttons on `/approvals` always 404
- **Severity:** P0
- **Page / control:** `/approvals` → per-row Approve / Reject buttons; also "Bulk approve"
- **Repro (real id from running system):**
  ```
  curl -s http://localhost:19280/approvals | grep -oE 'data-approval-id="[^"]+"' | head -1
  # → data-approval-id="REQ-000008"
  curl -s -X POST http://localhost:19280/api/approvals/REQ-000008/approve -H "HX-Request: true"
  # → 404 {"error":"not-found"}
  ```
- **Expected:** 200 with the swapped row marked approved.
- **Actual:** 404. The reader (`server/wiring/approvals-reader.ts`) pulls from `request-ledger-reader` (which scans `~/.autonomous-dev/gate-decisions/*.json`), while the writer `FileApprovalsStore.decide()` queries `~/.autonomous-dev/approvals-queue.json` for the id and returns `not-found` when absent. The two stores are never reconciled. Bulk approve has the same disconnect plus a separate `invalid-body` issue (`curl POST /api/approvals/bulk-approve --data filter=all` → 400).
- **Where the bug lives:**
  - Reader: `server/wiring/approvals-reader.ts:8-9` ("approvals-queue.json is bypassed in favor of the request ledger").
  - Writer: `server/wiring/approvals-store.tsx:85` constructs `FileApprovalsStore(approvalsQueuePath())`.
  - Bulk handler: `server/routes/approvals-actions.tsx:156-`. Form path requires `bulkApproveByFilter` dep wired; production config seems to drop into the JSON-only path that 400s on form-encoded bodies.
- **Cypress:**
  ```js
  cy.visit('/approvals');
  cy.get('[data-approval-id]').first().as('row');
  cy.get('@row').find('button').contains('Approve').click();
  cy.get('@row').should('contain','approved'); // not 404
  ```

---

## BUG-6 — Discord/Slack notification "Test" buttons always return 502
- **Severity:** P1
- **Page / control:** `/settings` → General tab → Discord webhook "Test" button, Slack "Test" button, and the "Send notification" test
- **Repro:**
  ```
  curl -s -X POST http://localhost:19280/api/settings/notifications/test/discord
  # → 502 {"error":"notification-failed","channel":"discord"}
  curl -s -X POST http://localhost:19280/api/settings/notifications/test/slack
  # → 502 ...
  curl -s -X POST http://localhost:19280/api/settings/notifications/test/send
  # → 502 ...
  ```
  Even though the persisted Discord webhook URL in `~/.claude/autonomous-dev.json` is a real one (under `notifications.delivery.discord.webhook_url`).
- **Expected:** When a valid webhook is configured, the Test button POSTs the fixed payload and returns 200 `{sent:true,channel}`.
- **Actual:** 502 every time — `NotificationDispatcher.send()` in wiring reports an error before reaching the wire. Likely the dispatcher reads `notifications.discordWebhook` (the flat key the new portal writer uses) but the existing config has the daemon-shape `notifications.delivery.discord.webhook_url`. Either dispatcher field-name disagreement or HTTPS fetch failing. This is what the operator means by "adding webhook and nothing happening".
- **Where the bug lives:** `server/wiring/notification-dispatcher.ts` — needs reconciliation with both shapes; see BUG-1 root cause.
- **Cypress:** Mock POST to `discord.com/api/webhooks/*` and verify Test button POST returns 200.

---

## BUG-7 — DND (do-not-disturb) inputs are hardcoded `disabled`
- **Severity:** P2
- **Page / control:** `/settings` → General → "Do not disturb" checkbox + start/end time inputs
- **Repro:** Page-source contains `<input type="checkbox" id="dnd-enabled" name="dndEnabled" disabled=""/>` and both `dndStart` / `dndEnd` are `disabled=""`. User cannot toggle DND.
- **Expected:** Operator can flip DND and persist start/end times.
- **Actual:** All three inputs are non-interactive; nothing can be changed.
- **Where the bug lives:** `server/templates/fragments/notifications-card.tsx` — `disabled` attribute is unconditional.
- **Cypress:** `cy.get('#dnd-enabled').should('not.be.disabled')`.

---

## BUG-8 — CSRF token rendered as empty string in every form
- **Severity:** P1
- **Page / control:** Every form on `/settings`, kill-switch, etc.
- **Repro:**
  ```
  curl -s http://localhost:19280/settings | grep -oE 'name="_csrf" value="[^"]*"' | sort -u
  # → name="_csrf" value=""    (every occurrence)
  ```
- **Expected:** Each form has a fresh non-empty CSRF token. CSRF middleware enforces token presence (per the spec comment in `settings-actions.tsx`).
- **Actual:** Empty token everywhere. Either CSRF is disabled in this environment (then the field shouldn't be in the markup) or it's enforced (then the form submits will all reject once we fix everything else). The cookie middleware exists at `server/middleware/`.
- **Where the bug lives:** CSRF middleware not wired or not exposing token to JSX context. Auth subsystem (`server/auth/`) — needs `c.set('csrfToken', ...)` before render.
- **Cypress:** `cy.get('input[name="_csrf"]').invoke('val').should('have.length.gt',16)`.

---

## BUG-9 — Request detail "Pause" / "Kill" buttons are inert (no handler, no valid action)
- **Severity:** P1
- **Page / control:** `/repo/:repo/request/:id` → "Pause" and "Kill" buttons in `.head-actions`
- **Repro:**
  ```
  curl -s http://localhost:19280/repo/ad-e2e-test/request/REQ-000008 | grep -oE 'data-request-action="[^"]+"[^>]*'
  # → buttons exist, NO hx-post, NO onclick, NO script binds these.
  curl -s -X POST http://localhost:19280/api/requests/REQ-000008/action \
    -H "Content-Type: application/json" --data '{"action":"pause"}'
  # → 400 {"error":"unknown-action"}      (pause + kill are not in REQUEST_ACTIONS)
  ```
- **Expected:** Click → request paused / killed (or a 409 if not allowed in current state).
- **Actual:** Button click does nothing; even if wired, "pause" and "kill" are not valid actions. The whitelist in `gate-and-request-actions.tsx:47-52` is `{retry, skip, cancel, escalate}`. UI shows verbs the backend does not implement.
- **Where the bug lives:** `server/templates/views/request-detail.tsx` (template needs hx-post wiring + valid action verbs).
- **Cypress:** Click Pause → assert a network POST fires and the request moves to `paused`.

---

## BUG-10 — Pipeline phase buttons on request detail open no modal (data-attr / loader mismatch)
- **Severity:** P1
- **Page / control:** `/repo/:repo/request/:id` → pipeline strip (8 phase buttons: PRD..OBSERVE)
- **Repro:**
  ```
  curl -s http://localhost:19280/repo/ad-e2e-test/request/REQ-000008 > /tmp/rd.html
  grep -c '<dialog' /tmp/rd.html    # → 0
  grep -c 'id="artifact-' /tmp/rd.html  # → 0 (no targets)
  grep 'phase-artifact-modal' /tmp/rd.html  # → not loaded
  ```
- **Expected:** Click PRD → modal opens with the phase's artifact.
- **Actual:** Buttons carry `data-modal-open="artifact-prd"` (which `modal.js` would route to a `[data-modal="artifact-prd"]` backdrop) but no such element is rendered. Meanwhile `phase-artifact-modal.js` is *not* included on the page and would have looked for `#artifact-modal-<phase>` (yet another contract). Clicks are no-ops.
- **Where the bug lives:** `server/templates/views/request-detail.tsx` does not render the dialogs and does not include `phase-artifact-modal.js`. Either include the script + render `<dialog id="artifact-modal-prd">…` per the JS contract, or switch buttons to `hx-get` lazy-loaders.
- **Cypress:** Click each phase pill → assert a dialog with appropriate phase content is visible.

---

## BUG-11 — Settings → Agents tab uses a hardcoded, stale agent list (16 names that don't exist)
- **Severity:** P1
- **Page / control:** `/settings` → Agents tab; the per-agent Promote / Shadow / Freeze buttons
- **Repro:**
  ```
  curl -s http://localhost:19280/api/agents | python3 -c 'import json,sys;print([a["name"] for a in json.load(sys.stdin)][:5])'
  # → ['accessibility-reviewer','agent-meta-reviewer','architecture-reviewer','code-executor','deploy-executor']
  curl -s http://localhost:19280/settings | grep -oE '/api/agents/[a-z-]+/promote' | sort -u | head
  # → /api/agents/architect/promote, /api/agents/coder/promote, /api/agents/intake/promote, ...
  # (none of these names exist in the live agent manifest)
  curl -s -X POST http://localhost:19280/api/agents/coder/shadow
  # → 500 "Agent action failed. Check daemon logs and retry."
  ```
- **Expected:** Agents tab lists the same agents as `/agents` and the buttons act on real agents.
- **Actual:** Hardcoded fixture list (architect, coder, gate-keeper, intake, linter, merger, observer, planner, prd-author, release-manager, researcher, security-reviewer, spec-author, tdd-author, plus a few duplicates). Every action → 500. Inspection modal for any of these → 404 `Agent not found`.
- **Where the bug lives:** `server/templates/views/settings.tsx` agents tab section — uses a stub fixture instead of calling the agents reader. The `/agents` page (`server/routes/agents.tsx`) uses the right reader; settings does not.
- **Cypress:** Assert intersection of settings agent names and `/agents` agent names is `>= 18`.

---

## BUG-12 — Ops page "Refresh" button is inert
- **Severity:** P2
- **Page / control:** `/ops` → "Refresh" button in `.head-actions`
- **Repro:** `curl -s http://localhost:19280/ops | grep 'class="btn">Refresh'` → button has no `hx-get`, no `onclick`, no `data-action`. Click does nothing.
- **Expected:** Manual refresh of the ops body (force the same hx-get the 10s timer triggers).
- **Actual:** Decorative-only button.
- **Where the bug lives:** `server/templates/views/ops.tsx` around line 157 — needs `hx-get="/ops" hx-target="#ops-body" hx-swap="outerHTML"`.
- **Cypress:** Click Refresh → assert a `/ops` request fires immediately.

---

## BUG-13 — Audit page has no filter form and no pagination in production
- **Severity:** P1
- **Page / control:** `/audit`
- **Repro:**
  ```
  curl -s http://localhost:19280/audit | grep -cE '<form[^>]*audit|name="(operatorId|action|startDate|endDate)"|audit-pagination'
  # → 0
  ```
- **Expected:** Filter form with Operator / Action / From / To inputs + pagination controls (`buildQuery` and `Pagination` components exist in `views/audit.tsx`).
- **Actual:** Only the stub fallback renders. `views/audit.tsx:161-189` only renders `FilterForm` + `Pagination` when `page` prop is supplied; production hits the stub path because `activeReader` is `null` (no call site for `setAuditReader` exists in `server.ts` / `lifecycle.ts`).
- **Where the bug lives:** `server/routes/audit.ts:18` — `setAuditReader` exposed but never called from app init.
- **Cypress:** Visit `/audit` → assert `form.audit-filters` exists and `input[name="startDate"]` is interactable.

---

## BUG-14 — Logs page renders stub data from 2025-04-30 (year-old fake)
- **Severity:** P1
- **Page / control:** `/logs`
- **Repro:** `curl -s http://localhost:19280/logs | grep -oE 'datetime="2025-[0-9-]+T[0-9:]+Z"' | head` → fixed timestamps in 2025-04-30. No log live reader. Auto-refresh is wired (every 5s) but it just re-renders the same 3 stub rows.
- **Expected:** Live log lines from the daemon + portal.
- **Actual:** Three fake stub lines, no pagination, no filter, no level picker.
- **Where the bug lives:** `server/routes/logs.ts:6` only imports `loadLogsStub`; no reader interface like the other routes have. Needs a `LogsReader` wired to `~/.autonomous-dev/portal.log` or daemon logs.
- **Cypress:** Assert at least one rendered log timestamp is within the last 24h.

---

## BUG-15 — Standards tab "+ New rule" / Edit links 404 (router never mounted)
- **Severity:** P1
- **Page / control:** `/settings` → Standards tab → "+ New rule" / per-row Edit
- **Repro:**
  ```
  curl -s http://localhost:19280/api/standards/new -o /dev/null -w "%{http_code}\n"
  # → 404
  curl -s http://localhost:19280/api/standards/S-101/edit -o /dev/null -w "%{http_code}\n"
  # → 404
  ```
- **Expected:** Modal fragment with new-rule or edit form.
- **Actual:** 404. `buildStandardsActionRoutes` is defined (`server/routes/standards-actions.tsx:163`) but never imported or mounted in `server/routes/index.ts` / `server/server.ts`.
- **Where the bug lives:** Add an `app.route("/", buildStandardsActionRoutes(deps))` mount and wire a `StandardsStore` dep.
- **Cypress:** Click "+ New rule" → modal renders, not a 404 page.

---

## BUG-16 — Settings Variants/Backends tabs are read-only stubs (no controls rendered)
- **Severity:** P2
- **Page / control:** `/settings` → Variants tab, Backends tab
- **Repro:** Inspect `data-tab-panel="variants"` and `data-tab-panel="backends"` panels in the rendered HTML. Both contain only a `<table class="tbl">` with hardcoded rows ("p8", "fast" for variants; "fly-prod", "k8s-stage", "render-canary" for backends). No `hx-post`, no Add/Edit/Install button, no default-variant `<select>`. Per the templates that exist (`templates/fragments/settings-variants.tsx`, `templates/fragments/settings-backends.tsx`) there should be a default-variant select with `hx-post="/api/settings/default-variant"` and per-row install/health controls; none are rendered.
- **Expected:** Interactive controls per the fragments.
- **Actual:** Static placeholder tables.
- **Where the bug lives:** `server/templates/views/settings.tsx` — the variants/backends panels do not include the fragment components; they inline a placeholder table instead.
- **Cypress:** `cy.get('[data-tab-panel="variants"] select[name="defaultVariant"]').should('exist');`

---

## BUG-17 — Approvals KPI "Cost cap" shows `0` while sub-line says "cap $25/day"
- **Severity:** P2
- **Page / control:** `/approvals` KPI strip
- **Repro:**
  ```
  curl -s http://localhost:19280/approvals | grep -A1 'Cost cap' | head -4
  # → <div class="kpi-num">0</div><div class="kpi-sub">current cap $25/day</div>
  ```
- **Expected:** "0 gates blocked by cost cap" or "0 of $25 used" — coherent.
- **Actual:** The numeric KPI is 0 (gates) but the sub-line ($25/day) is the cap, not a usage. Two different metrics smashed into one tile.
- **Where the bug lives:** `server/templates/views/approvals.tsx` KPI tile renders `costCapDailyUsd` as the sub-line; numerator is a separate "cost-cap gates" count that's unrelated.
- **Cypress:** Render check on `.kpi:contains("Cost cap")` — numerator and sub-line should describe the same metric.

---

## BUG-18 — Kill-switch confirm form bypasses HTMX (full page-reload returns a bare fragment)
- **Severity:** P1
- **Page / control:** Any page → kill-switch modal → "Confirm engage" submit
- **Repro:** Inspect the armed-fragment markup:
  `<form method="POST" action="/ops/kill-switch">...<button type="submit">Confirm engage</button></form>` — note **no `hx-post`** on the form. A normal HTML submit POST replaces the entire page with the fragment body (no `<html>`, no rail). The Cancel button next to it is HTMX-wired but the Confirm button is not.
- **Expected:** Confirm uses `hx-post="/ops/kill-switch" hx-target="closest .ks-panel" hx-swap="outerHTML"`.
- **Actual:** Browser navigates to `/ops/kill-switch` and gets a `<div class="ks-panel ...">` orphan fragment as the whole page. Operator sees a broken page after engaging.
- **Where the bug lives:** `server/components/kill-switch.tsx` armed-state render — needs HTMX attrs on the form. (Out of caution I did *not* fire the POST with a valid CONFIRM. Form-action and field name were verified via the GET render.)
- **Cypress:** Open modal, type CONFIRM, submit → assert URL stays put and only `.ks-panel` is replaced.

---

## Things I verified work (do not list as bugs)

- `/api/daemon-status` returns `running` correctly (uses file mtime, not the JSON field).
- Dashboard repo tile (`<a class="repo-card" href="/requests">`) navigates correctly to `/requests`.
- Request detail page renders (status 200, not 500) for a real id like `REQ-000008`.
- Dashboard MTD value (`$35.80`) matches `/api/daemon-status.mtdSpend` exactly.
- The /agents page lists the real 18-agent manifest (its modal load is also OK *for those names*).
- Kill-switch idle → arm GET works; arm → cancel GET works; arm window is enforced server-side.
- SSE stream at `/portal/events` is reachable and emits heartbeats.
- POST `/api/agents/<real-name>/promote` validates `version-required` (so the protocol is OK; the bug is the stale name list, not the verb).

---

## Suggested triage order

1. BUG-1, BUG-5, BUG-2, BUG-3 — these alone account for "settings don't save", "approvals don't move", "daemon says dead". Land one fixer PR per bug; each is a config-shape decision.
2. BUG-6 — fix the notification dispatcher field-name once BUG-1's settings shape is decided.
3. BUG-9, BUG-10, BUG-18, BUG-15 — wire-up bugs (5 lines each); group into one "interactive controls audit" PR.
4. BUG-4 — investigate why the bracket-expression in `hx-trigger` is being stripped at render time; might be Hono entity-encoding `[` → `&#x5B;`.
5. BUG-11, BUG-13, BUG-14, BUG-16 — readers/templates parity work; one PR per surface.
6. BUG-7, BUG-12, BUG-17 — small polish.
7. BUG-8 — last; everything CSRF-protected will surface its own follow-ups once the above are fixed.
