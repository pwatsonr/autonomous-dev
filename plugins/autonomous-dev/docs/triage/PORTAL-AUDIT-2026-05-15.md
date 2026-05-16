# Portal audit — 2026-05-15

Walkthrough of `http://localhost:19280` while an autonomous-dev request was
in-flight (REQ-000005 in `ad-buildout-test`, REQ-260512 in `test-project`).
Daemon was running (PID 85249, lock alive) but `daemon status` reports
`stopped (macOS/launchd)` because launchd shows it down. Plugin cache is still
the stale `0.1.0` build (per project memory) — some findings here are likely
already fixed on `main` but not live; that's called out per item.

> **Update (deep-interaction pass):** Section "Deep-interaction findings"
> at the bottom of this doc adds bugs found by *clicking* every button,
> *changing* every select, and *watching the network tab* — not just by
> reading the rendered page. The biggest new finding is that **none of
> the form controls on `/settings` actually save** — they update the DOM
> and silently revert on reload.

## Severity legend
- **P0** — broken navigation or wrong data the operator will act on
- **P1** — confusing/contradictory but recoverable
- **P2** — cosmetic / stale fixture / nit

---

## P0 — Request detail route 404s for every real request

- **Where:** Dashboard → "Awaiting approval" → **Review** link
  (`/repo/ad-buildout-test/request/REQ-000005`) and Requests page → request
  ID link (same URL pattern).
- **Observed:** Both real requests render the generic 404 page
  ("Error 404: Page Not Found", "Portfolio dashboard" link in the
  suggestions). Verified via curl — server returns `HTTP/1.1 404`.
- **Root cause (confirmed in source):**
  `server/routes/request-detail.ts` validates path params then calls
  `loadRequestRecord(repo, id)` which returns `null`, so `notFound(c)` fires.
  The reader expects a daemon `state.json` at the target repo path, but
  `~/.autonomous-dev/request-actions/REQ-000005.json` is the only file on
  disk and its `repo` field is the *slug* `"ad-buildout-test"`, not the full
  path the daemon writes. Result: the 3-tier fallback chain never finds
  state and never produces even a minimal record.
- **Impact:** There is no way to view a single request in the UI. Operator
  cannot reach gate approval from anywhere except the API.
- **Repro:**
  ```
  curl -s -o /dev/null -w "%{http_code}\n" \
    http://localhost:19280/repo/ad-buildout-test/request/REQ-000005
  # → 404
  ```

## P0 — `/repo/<name>` is also 404

- **Where:** Dashboard → Repos card → click any repo tile
  (e.g. `~/projects/ad-buildout-test` button).
- **Observed:** The button looks clickable but there is no `GET /repo/:repo`
  route registered in `server/routes/index.ts`. The buttons just submit a
  POST or do nothing useful; manual navigation 404s.
- **Impact:** Drilling from dashboard into a repo's request list is broken.

## P0 — `/approvals` says "0 open gates" while dashboard says 2 awaiting

- **Where:** Dashboard chrome shows "Requests (2 active)" and the
  "Awaiting approval" card lists two gates (SPEC for REQ-000005, PRD for
  REQ-260512). `/approvals` page shows:
  - "No gates to approve" button
  - "Open gates · 0"
  - "Reviewer chain across 0 repos"
- **Impact:** The page designed specifically for approvals can't see the
  approvals other pages know about. Operator can't act.

## P0 — Three different MTD spend numbers across three pages

| Page         | MTD spend shown        | Cap shown    |
|--------------|-----------------------:|-------------:|
| `/` Dashboard | **$2.42**             | $400.00      |
| `/requests`   | **$2.67**             | (none)       |
| `/costs`      | **$28.64**            | $500.00      |

Same wall clock, same session. The Avg/request × 2 on `/costs` is internally
consistent ($14.32 × 2 = $28.64), so `/costs` is probably the real number.
Dashboard and Requests are pulling from a different / stale source. Cost
caps also disagree ($400 vs $500), suggesting one is hard-coded fixture.

## P0 — CLI adapter missing (stale plugin cache, already known in memory)

- `autonomous-dev request list` fails with:
  > `CLI adapter not found at /Users/pwatson/.claude/plugins/cache/autonomous-dev/autonomous-dev/0.1.0/intake/adapters/cli_adapter.js`
- Matches the open action in `MEMORY.md`: marketplace cache still on
  `0.1.0`, `main` is `0.2.0`. Operator step needed:
  `/plugin` → update autonomous-dev → `autonomous-dev install-daemon` →
  daemon stop/start.

---

## P1 — Daemon logs show repeat errors the UI hides

From `~/.autonomous-dev/logs/daemon.log` over the last ~15 minutes:

- `ERROR Failed to query orphan SQLite rows` followed by
  `ERROR Orphan reconciliation failed` — both on iteration 1 right after
  the stale-heartbeat detection. Ops page just says "No circuit breaker
  telemetry" and "No heartbeat yet"; these errors don't surface anywhere.
- `WARN synthesized phase result for REQ-000005 plan_review
  (exit code only; trust=low)` — repeats for `spec`, `spec_review`. The
  daemon can't read the agent's phase output and is fabricating a result
  from the exit code. UI doesn't flag this; the request still advances.
- `WARN Failed to parse gate_entered_at timestamp: 2026-05-15T23:30:56Z` —
  that's a valid ISO-8601 with `Z`. Likely a parser that expects a
  fractional-second variant. Repeats every iteration that touches a gate.
- `WARN Neither 'timeout' nor 'gtimeout' found; phase sessions will run
  without a wall-clock cap.` — every iteration. Cosmetic from a
  log-noise standpoint, but it means **phase budget caps are silently
  not enforced** on this machine.
- `WARN State file missing for REQ-123456, writing minimal cancelled
  action` — orphan handling working, but there's no audit trail in the UI.

## P1 — Data dissonance between intake.db and request-actions/

- `intake.db` has **4 requests** (REQ-000003, 000004, 000005, 000006) all
  `status='queued' phase='intake'`.
- `~/.autonomous-dev/request-actions/` has **2 files** (REQ-000005,
  REQ-260512) with different statuses (`running`/`gate`).
- REQ-260512 doesn't exist in `intake.db` at all — it's only in the
  portal ledger. Conversely 03/04/06 are in the DB but invisible in the
  portal because there's no action file.
- The portal trusts the action ledger; the daemon trusts the DB. Either
  these two stores need a reconciler, or one is the source of truth and
  the other should be derived.

## P1 — Phase header for REQ-000005 disagrees across pages

| Source                                    | Phase           | Status            |
|-------------------------------------------|-----------------|-------------------|
| Dashboard "Awaiting approval"             | SPEC            | gate · pending    |
| Dashboard "Active requests" table         | SPEC            | gate · pending    |
| `/requests` table                         | **SPEC_REVIEW** | GATE              |
| `request-actions/REQ-000005.json` on disk | **CODE**        | running           |
| `intake.db`                               | **intake**      | queued            |
| Daemon log (most recent)                  | spec_review     | synthesized       |

Five different answers for "what phase is this request in."

## P1 — `/agents` page has stat tiles with no numbers and an empty table body

- "Total agents", "Frozen", "Shadow" tile values are blank.
- The 18 agent rows render with name + version + mode (`BASELINE`/`SHADOW`)
  + `active` only. Columns "Last dispatch", "Runs (30d)", "FP rate"
  have headers but no cells. So the table is structurally there but
  rendering nothing for half its columns.

## P1 — `/settings` "Agents" tab shows a different agent universe than `/agents`

- `/agents` (real registry) has 18 reviewers/executors/authors named after
  the plugin (`accessibility-reviewer`, `agent-meta-reviewer`,
  `architecture-reviewer`, `code-executor`, `deploy-executor`, …).
- `/settings` → Agents tab has **17 different agents** (`architect`,
  `coder`, `gate-keeper`, `intake`, `linter`, `merger`, `observer`,
  `planner`, `release-manager`, `researcher`, `docs-writer`, `explainer`,
  …) with synthetic stats incrementing in tidy patterns (60/55/50, then
  67/66/63, 74/77/76, …) and version numbers `1.0.0` → `1.17.0` in
  sequence — clearly a fixture.
- The "Inspect <agent>" modals for every fixture agent appear to be in the
  accessibility tree at once (all 17 forms with Promote/Shadow/Freeze
  buttons readable). Hopefully hidden via CSS; either way an a11y screen
  reader would dump all of them as a single page.

## P1 — `code-executor` shows mode SHADOW on `/agents`

The real `code-executor` is the workhorse for writing code. Showing it in
SHADOW means it produces output but doesn't affect anything — if that's
actually true the pipeline can't ship. If it's a display bug the column is
just lying. Worth confirming against the registry.

## P1 — `/costs` "Daily spend · last 30 days" chart is empty

- Section heading renders, the surrounding region renders, but no chart
  body / svg.
- "Run rate / day: $1.91", "Days left:" (blank value).

## P1 — Ops page tile vs body disagreement on MCP servers

- Tile: "MCP servers · 0/0 · all healthy"
- Body region "MCP servers": "No MCP server telemetry"

If we have no telemetry we don't know if they're healthy — the tile is
asserting a fact based on no data.

---

## P2 — Cosmetic / fixture-leak / nits

- **"Portfolio dashboard"** is the link label on the 404 page; everywhere
  else it's just "Dashboard". Leftover from the rename.
- **"+ New request"** links to
  `https://github.com/pwatsonr/autonomous-dev#submitting-a-request` from
  both Dashboard and Requests. The repo is `pwatson/autonomous-dev` (per
  git config) and the anchor likely doesn't exist either — both routes
  externalize the most common operator action into a broken doc link.
- **Cost caps** input fields on `/settings` show empty values (no current
  cap loaded into the textbox even though the chrome shows `cap $400.00`
  and `cap $500.00` elsewhere).
- **Per-repo overrides** table has fixture repos `acme/widgets` and
  `system/core`.
- **Engineering standards** has fixture rules `S-101`, `S-201`, `S-301`
  with generic descriptions, "Applies: `acme,beta`".
- **Deploy backends** lists fixture entries `fly-prod`, `k8s-stage`,
  `render-canary`.
- **CONTROL PLANE · v0.1.0** in the sidebar — same stale plugin version
  string the daemon is running. Once the cache is refreshed this should
  read `0.2.0`.
- **REQ-260512 row on Dashboard "Active requests"** has no title text;
  REQ-000005 has its description ("Add the core todo CLI…"). On
  `/requests` the title column is missing entirely.
- **Variant column on `/requests`** shows the phase name (`SPEC_REVIEW`,
  `PRD`) instead of the variant (which is empty in both action files).
- **Requests page stat tiles** "Active", "In gate", "Completed today"
  all have empty number values — labels and units render with no
  count between them.

---

## Suggested triage order

1. **Fix `/repo/:repo/request/:id` 404** — the operator-blocking path.
   Either fix `loadRequestRecord` to recognize slug-only repo identifiers,
   or have the daemon write `state.json` to a path the portal can find.
2. **Reconcile dashboard MTD vs costs MTD** — pick one cost source. The
   "$2.42 vs $28.64" gap will cause panic when the daily cap "trips" or
   when it doesn't.
3. **Get `/approvals` reading the same data the dashboard reads.** Two
   different views of the gate queue is worse than one wrong view.
4. **Decide DB-vs-action-ledger source of truth** for request listings,
   then add a reconciler for the orphan case. The 4-vs-2 split today is
   the symptom of that decision not being made.
5. **Refresh plugin cache** (`/plugin` → update autonomous-dev →
   `install-daemon` → daemon stop/start) so we're auditing live code,
   not the `0.1.0` snapshot. Several of these may already be fixed on
   `main` (PRD-020 #260–#263).
6. **Replace the `/settings` Agents-tab fixture** with the real registry,
   or remove the tab until it's wired up.
7. Address the daemon-log issues — orphan SQLite query error,
   `gate_entered_at` parser, missing `timeout` binary warning — and
   surface them in the Ops page so the operator can see them without
   tailing logs.

---

# Deep-interaction findings

Method: clicked every button, changed every `<select>`, typed in every
textbox, and watched `read_network_requests` to see whether the action
actually called the server. "Inert" below means **the click produced
no HTTP request and no observable state change** — the control is wired
to nothing.

## P0 — `/settings` is a read-only mockup

Every control on the General tab is inert:

| Control                           | What happened on interact                      |
|-----------------------------------|------------------------------------------------|
| Trust level select (`L2 → L3`)    | DOM updated, **no network request**. Reverts to L2 on reload. |
| Trust level select (`L2 → L0`)    | Same — no PUT/POST fired. Reverts on reload.   |
| Per-repo override `acme/widgets` select | (Not exercised — repo is itself fixture) |
| Per-repo override "Reset" button (acme) | (Inert — `acme/widgets` isn't a real repo) |
| Per-repo override "Reset" button (system/core) | Correctly disabled (source = "policy") |
| Per-request cap textbox           | Pre-populated `$1` but `~/.autonomous-dev/config.json` has `per_request_cost_cap_usd: 50`. **No persistence path.** |
| Daily cap textbox                 | Shows `$25`, config has `daily_cost_cap_usd: 100` |
| Monthly cap textbox               | Shows `$500`, config has `monthly_cost_cap_usd: 2000` |
| "Reset to defaults"               | (Inert — no defaults endpoint to call)         |
| Repo allowlist "Add" button       | Greyed out when textbox empty (good). No POST when filled. |
| Discord webhook URL textbox       | Placeholder-only. Config has a real Discord webhook URL — UI doesn't read it. |
| Slack webhook URL textbox         | Placeholder-only.                              |
| Discord "Test" button             | **No network request.** Silent no-op.          |
| Slack "Test" button               | **No network request.** Silent no-op.          |
| Default notification method select | Shows "none". Config has `default_method: "discord"`. |
| DND checkbox + Start/End time     | (Untested, but presumed inert — same pattern.) |
| "Send test notification now"      | Disabled when method=none. Cannot test.        |

The Settings page does not have a single "Save" button anywhere — and
no auto-save either. The page is a **purely cosmetic mockup**.

**Concrete proof of the UI-vs-config gap** (compare what the page shows
to what `~/.autonomous-dev/config.json` actually contains):

| Field                | UI shows                | Config has                                |
|----------------------|-------------------------|-------------------------------------------|
| Trust level          | L2                      | `system_default_level: 1` (= **L1**)      |
| Per-request cap      | $1                      | $50                                       |
| Daily cap            | $25                     | $100                                      |
| Monthly cap          | $500                    | $2000                                     |
| Repo allowlist       | "No repos allowlisted"  | 3 real repos (autonomous-dev, autonomous-dev-homelab, ad-buildout-test) |
| Discord webhook      | placeholder, "MUTED"    | Real webhook URL `https://discord.com/api/webhooks/1494900680929054902/...` |
| Default method       | none                    | discord                                   |

Settings → **Variants**, **Standards**, **Backends**, and **Agents**
tabs are all read-only fixtures (no real data, no controls beyond
Inspect on the fictional agent list).

## P0 — Settings → Agents `Inspect` action buttons are inert

Clicking `Inspect` on `architect` opens a modal as expected, but the
Promote/Shadow/Freeze buttons inside it fire **no network request**.
The `architect` row stayed `ACTIVE` after clicking `Shadow`. (Closing
and re-opening confirmed.) The four buttons are wired to nothing.

(The `/agents` page Inspect modal is wired to the registry; its modal
HTML is fetched from `/agents/<name>/inspect-modal` and shows real
agent state. **The Settings → Agents tab modal is a separate, mock-data
implementation.** Two different agent UIs with the same name.)

## P0 — `/ops` "Refresh" button does nothing

No network request. The page does not re-fetch the daemon-status block.

## P0 — `/ops` doesn't see the running daemon

- Portal: `Loop daemon: STOPPED`, `Heartbeat last 24h: offline`, large
  empty state "No heartbeat yet".
- Reality: `~/.autonomous-dev/heartbeat.json` shows `pid: 85249,
  timestamp: 2026-05-15T23:50:09Z, iteration_count: 13` — the daemon
  has been alive 22 minutes with a heartbeat 1 minute old.

The portal's daemon-status reader is consulting launchd (`launchctl
list ...`) which reports the service as down, instead of reading the
heartbeat file the daemon actively writes. So **a running daemon shows
as stopped in the UI** if it was started any way other than launchd.

## P0 — `/requests` filter buttons don't filter

Clicked each of `All / Active / In gate / Completed`. The selected
button changes (visual chip) but the table body is identical for every
filter — both rows always render. Click `Completed` and you get both
rows *plus* a "No completed gates" empty-state message below them.

`Active 0`, `In gate 2`, `Completed today 0` (tile counts) — but the
table shows 2 rows regardless. Implies the filter chips just style
themselves; the table-rendering code ignores them.

## P0 — Dashboard repo tile buttons do nothing

Clicked `ad-buildout-test` and `test-project` tiles. Hover/focus
highlight fires, but no navigation, no modal, no network request.
The buttons are decoration. (`/repo/<name>` is 404 anyway — see
the earlier P0 — so even if they navigated, the destination is missing.)

## P1 — Kill switch banner has no cancel button

Clicking "Kill switch" pops a confirmation banner: **"Kill switch
ARMED — Type CONFIRM to halt the daemon. Window expires in 30
seconds."** The banner has no Cancel/Dismiss button. Operator who
clicks accidentally must either:

- type CONFIRM (destructive), or
- wait 30 seconds, or
- navigate away (which leaves the banner armed if they come back? —
  testing showed the banner persisted across some navigations).

Good safety design overall (typed confirmation), but missing an
explicit "Cancel" is a UX defect.

## P1 — Numbers keep changing across the same session

Same browser session, ~30 minutes apart, no manual refresh:

| Field                       | First read | Second read | Third read |
|-----------------------------|-----------:|------------:|-----------:|
| Dashboard MTD spend         |   $2.42    |    $3.01    |   $4.38    |
| Dashboard active repo MTD   |   $2.42    |    $3.01    |   $3.80 / $4.38 |
| Requests page MTD spend     |   $2.67    |    $3.80    |    —       |
| Costs page MTD spend        |  $28.64    |   $29.77    |    —       |
| Dashboard cap shown         |   $400.00  |    $400.00  |   $400.00  |
| Costs page cap shown        |   $500.00  |    $500.00  |   $500.00  |

The daemon was processing REQ-000005 the whole time so *changes* are
expected — but Dashboard, Requests, and Costs disagreeing with each
other on the same snapshot in time means they're each computing MTD
spend from a different source.

## P1 — REQ-000005 phase keeps jumping around in the UI

Same request, same session:

| Source / time                        | Phase            |
|--------------------------------------|------------------|
| Dashboard, t=0                       | SPEC             |
| Dashboard, t=+30s (theme toggle)     | CODE             |
| Dashboard, t=+25min                  | DEPLOY           |
| `/requests`, t=+10min                | SPEC_REVIEW      |
| `/requests`, t=+25min                | CODE_REVIEW      |
| `request-actions/REQ-000005.json`    | CODE → running   |
| `intake.db`                          | intake → queued  |
| Daemon log most recent               | spec_review/synthesized |

The phase IS changing fast (this is a hello-world flow burning through
phases). The bug is that **the same field is rendered in different
states across pages** on the same screen-load. The dashboard's "Awaiting
approval" card and "Active requests" table can show two different phase
labels for the same request, fetched in the same response.

## P1 — Test buttons that do nothing should be disabled

Discord "Test" and Slack "Test" buttons render as enabled even when the
webhook URL textbox is empty (showing only the placeholder). Clicking
them fires no request — they should be `disabled` until a URL is typed.

## P1 — `Repo allowlist` empty state lies

UI: "No repos allowlisted. Add your first repo."
Config: 3 allowlisted repos.

If an operator follows the prompt to "Add your first repo" they could
end up with stranger state — but since the Add button never persists
anyway, this is moot until the wiring lands.

## P1 — Light/Dark theme: only Light mode has a sidebar `Daemon down` color

Cosmetic. The "Daemon down" red dot and "Breaker unknown" text in the
sidebar render with `body` text color on Light theme and look faded.
Compare to Dark, where they have proper accent treatment.

## P1 — "Bulk approve" button is enabled in the DOM when 0 gates

On `/approvals` it shows as a disabled-looking button but the accessibility
tree exposes it as a real button (`button "No gates to approve"`).
Clicking it does nothing (no requests). Should be `aria-disabled`.

## P2 — Cosmetic confirmations

- The Discord/Slack "MUTED" pill renders before the Test button — it's
  the *current* status, not an indicator of whether the test would fire.
  Probably should sit *after* the URL with clearer labeling.
- Cost cap circles show TODAY: 17%, MONTH: 13% — those numbers tracked
  with the `$1 / $25 / $500` UI values (not the real `$50 / $100 / $2000`
  config), so this widget is computing against the wrong caps too.
- Settings tab navigation uses `?tab=variants|standards|backends|agents`
  query params (URL changes on tab click). That's correct.

---

## Updated triage summary

The earlier triage listed 7 items. After the deep crawl, the picture is:

1. **`/settings` ships no working forms.** Every control is cosmetic —
   no Save, no persistence, no network call. The first triage step
   should be to either wire these to the existing
   `server/routes/settings-actions.tsx` handlers, or label the page
   `(read-only preview)` and hide the controls until backend lands.
2. **Two separate Agents UIs** (`/agents` real registry vs.
   `/settings?tab=agents` fixture) confuse what's source of truth.
   Pick one.
3. The original P0 set (request detail 404, `/repo/:repo` 404, approvals
   queue mismatch, three MTD numbers, CLI cache) all still stand.
4. `/ops` should read the daemon's `heartbeat.json`, not launchd state.
   This is a 30-line fix and unblocks a lot of operator confidence.
5. `/requests` filter buttons need to actually filter the table.
6. Dashboard repo tiles either need a target route (`/repo/<slug>`
   page) or should stop rendering as buttons.

---

# Follow-up items captured during the fix pass (not yet addressed)

These were uncovered while shipping the audit fixes (PRs #265 + #266 +
test fixup `945221b`) and are intentionally **out of scope** of those
PRs. Each is its own future-PR-worth-of-work.

## P0 — Plugin cache ships without `node_modules`

**What it breaks:**
- Daemon orphan reconciliation: `ERROR Failed to query orphan SQLite rows`
  → `ERROR Orphan reconciliation failed`, every iteration.
- CLI (`autonomous-dev request list`, `request submit`, etc.):
  `ERROR: better-sqlite3 is required but not installed. Run: npm install
  better-sqlite3`.

**Root cause:** `~/.claude/plugins/cache/autonomous-dev/autonomous-dev/<version>/`
contains source files but no `node_modules/`. The daemon scripts (and the
CLI adapter) `import Database from 'better-sqlite3'`, which fails at
runtime because Node's resolution can't find the package — the plugin
cache is a leaf directory with no parent `node_modules`.

**Workaround applied on 2026-05-15** (this repo, this machine):

```bash
cd ~/.claude/plugins/cache/autonomous-dev/autonomous-dev/0.1.0
npm install --omit=dev --no-audit --no-fund
# bun install --production refused with "lockfile is frozen" because the
# cache has an npm-format package-lock.json; npm install worked first try.
```

After install: orphan reconciliation logged
`Marking orphan SQLite row as cancelled: REQ-000003 (state file missing)` /
`Orphan reconciliation complete`. CLI started returning JSON.

**Why this should be a real fix, not a workaround:**

1. `/plugin` update (the Claude-Code-driven path) probably wipes/replaces
   the cache directory wholesale. Each cache refresh would re-break orphan
   reconciliation and the CLI until the operator re-runs `npm install` in
   the new cache dir. Today there's no documentation that says they need
   to.
2. The classifier auto-blocks `bun install` / `npm install` inside the
   plugin cache as "self-modification of agent-loaded plugin code paths,"
   which is right — but the user has to opt in explicitly each time.
3. The bun-vs-npm asymmetry (the cache ships `package-lock.json` only,
   no `bun.lockb`; `bun install` refuses; `npm install` works) is silent
   in the install flow.

**Suggested fixes:**

- **Option A — plugin install runs `npm install` automatically.** Add a
  post-install step to `autonomous-dev install-daemon` (or wherever the
  marketplace-cache install runs) that does `npm install --omit=dev` in
  the cached plugin dir if `package.json` is present and `node_modules`
  is missing. Cost: ~3s install per refresh + ~150MB disk per plugin
  version.
- **Option B — bundle the SQLite calls.** Pre-bundle `find-orphan-sqlite-rows-simple.js`
  and `mark-request-cancelled-simple.js` with `bun build --target=node
  --external sqlite3 ...` so they ship as single files with their
  dependency graph inlined. CLI adapter could go the same way (it already
  uses `bun build` for `cli_adapter.js`; the missing `better-sqlite3`
  external should resolve at runtime via a vendored copy or a smaller
  pure-JS SQLite client).
- **Option C — skip orphan reconciliation when deps are missing.** Detect
  the missing `better-sqlite3` once at startup and `log_warn`-once that
  reconciliation is disabled, instead of `log_error` every iteration.
  Doesn't fix the underlying issue but stops the log spam.

**Operator-side mitigation in the meantime:** add `npm install` to the
"after `/plugin` update" runbook step alongside `autonomous-dev install-daemon`.

## P1 — `gate-action-panel.tsx:235` uses `name="csrfToken"`

Same CSRF-naming bug that was just fixed for `settings.tsx:522` in PR
#265 (`75572f6`). Pre-existing on `main`; not part of the audit pass
because that template wasn't on the audit's surface (gate-action panels
only render inside the request-detail view). One-line fix:
`name="csrfToken"` → `name="_csrf"` so the middleware (`csrf-protection.ts:447`)
can validate the body.

## P1 — Daemon writes `~/.autonomous-dev/effective-config.XXXXXX.json` with literal `XXXXXX`

Observed during the 2026-05-15 fix pass: the daemon crash-looped on
startup because `mktemp` failed on an existing file named *exactly*
`effective-config.XXXXXX.json` (placeholder template, not substituted).
Some script in the cached `supervisor-loop.sh` (or its callees) wrote
the file with the template instead of letting `mktemp` substitute random
chars. Manually `rm`-ing the file resolved the crash-loop, but the
underlying bug — whichever code path wrote the placeholder — is still
present. Hunt for `effective-config.XXXXXX` in the daemon bash and
either fix the `mktemp` invocation or migrate to a proper temp-file
helper.

## P2 — Daemon issue 4 (synthesized phase result) is working-as-designed

Already triaged in PR #266 (`a6a303d`). Logged for completeness: the
`WARN synthesized phase result for REQ-000005 plan_review (exit code
only; trust=low)` line comes from `spawn-session.sh:232-243` and is the
documented fallback per SPEC-039-2-07 when the agent doesn't emit
`phase-result-<phase>.json`. Fixing this is an agent-output-quality
project, not a daemon project. Leaving here so the next audit doesn't
re-discover it.
