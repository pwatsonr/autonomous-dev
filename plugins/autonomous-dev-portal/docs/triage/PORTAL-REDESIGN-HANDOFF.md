# Portal Redesign — Handoff (2026-05-11)

## Status in one sentence

The portal at `http://127.0.0.1:19280/` renders the new shell + tokens + primitives end-to-end, every route returns a real status code, every nav item resolves, **but the operator reports the rendered result still doesn't match the design kit**. This document captures everything done, everything known to be off, and the debug protocol for the next session to close the visual gap.

---

## Session summary

This session built and shipped the portal redesign from PRD through running code:

- **PRD-018** Portal Visual Redesign (#154)
- **3 TDDs**: TDD-034 foundations, TDD-035 shell+primitives, TDD-036 surfaces (#155–#160 incl. review fixes)
- **11 plans** across the 3 TDDs (#161–#163)
- **60 specs** decomposing the plans (#164–#174)
- **28 implementation PRs** (#175–#202) shipping the redesign
- **Gap audit + PLAN-037** (8 child plans, #203 + #211)
- **32 specs** for PLAN-037 (#204–#210)
- **7 PLAN-037 implementation PRs** (#212–#218)
- **Daemon-status + action-route wiring** (#219, #220, #221, #222)
- **Agent-factory bridge** (#223 git-context fix, #224 persistence + JSON + version, #227 shadow verb)
- **/requests surface** (#225)
- **Palette widening** for peer-chip contrast (#226 + #231 sync fix)
- **Misc closeouts**: voice sweep (#228), daemon readers (#229), bun.lock untrack (#230)

**Cumulative**: ~183 PRs from initial PRD to handoff.

Everything is on `main`.

---

## What works (verified)

### Routing
Every kit-referenced URL returns 200 or a meaningful error (no silent 404s, no 503 "wiring missing"):

```
/                                  200    Dashboard (6 regions)
/approvals                         200    KPI + filter + gate-list
/requests                          200    KPI + filter + table
/costs                             200    Cost ring + time series + projection
/ops                               200    Daemon + breaker + heartbeat + log
/settings                          200    5 tabs, Save/Discard, modals
/repo/:repo/request/:id            200    Page-head + artifact pane + timeline
/design-system                     200    20 preview cards
/api/daemon-status                 200    {status, mtdSpend, approvalsCount, killSwitchEngaged}
/portal/events                     200    SSE bus emitting heartbeat
/api/agents/:name/inspect          200    JSON via CLI spawn
/api/agents/:name/freeze           200    Persisted + rendered row
/api/agents/:name/unfreeze         200    Persisted
/api/agents/:name/shadow           200    Persisted + rendered row
/api/agents/:name/promote?ver=Y    200    Spawns CLI with version
/ops/kill-switch-modal?step=arm    200    Armed-state fragment
```

### Visual structure (confirmed via `curl` body inspection)
- `<html data-theme="dark">` — dark default (kit-matching)
- `<aside class="rail">` populated with brand wordmark, 7 nav items (Homelab omitted — see decision below), OPERATE/SYSTEM group labels, rail-ops bar (Daemon dot, kill-switch button, theme toggle)
- `<main class="main">` with `.page-head` + `.head-actions`
- Surface markup uses kit classes: `.kpi-strip`, `.gate-row`, `.repo-card`, `.tbl`, `.chip-phase`, etc.
- All 4 stylesheets loaded in order: `design-tokens.css` → `app.css` → `portal.css` → `shell.css`
- Phase palette satisfies WCAG SC 1.4.11 (≥3:1 vs `--bg-0`) **AND** adjacent peer-chip contrast (≥3:1 between sequential pipeline phases) in both themes

### CLI bridge
`autonomous-dev agent {inspect|freeze|unfreeze|shadow|unshadow|promote|list}` works end-to-end with persistence in `~/.autonomous-dev/agent-states.json`. Inspect supports `--json` for machine-readable output.

### Action routes
All POST endpoints wired to file-backed stores (`server/wiring/{approvals,settings,gate,agents,daemon-readers}-*.ts`). CSRF middleware, audit logger, SSE broadcast all hooked up.

---

## What's reported as "still not looking right"

The operator has repeatedly indicated the portal does not visually match the kit. I (Claude) have been operating blind on visuals — I can only `curl` HTML/CSS bodies and infer. The HTML structure is correct per the kit's JSX shape, the CSS classes resolve to real rules, and the palette passes contrast checks.

**Likely causes worth investigating in priority order** — the next session should start here:

### 1. Static asset duplication (HIGHEST PRIORITY)
The portal has TWO `static/` trees:
- `plugins/autonomous-dev-portal/static/` ← the served path (per `routes/index.ts` line 51)
- `plugins/autonomous-dev-portal/server/static/` ← where most agents wrote new files

PR #200 originally synced these. PR #226's palette update went into `server/static/` only and broke the parity until PR #231 caught it. **There may be other files in similar drift state.** The fix is either to delete `server/static/` and update every spec to point at `static/`, OR add a startup-time copy step.

**Debug step for next session**:
```bash
cd plugins/autonomous-dev-portal
diff -r server/static/ static/ 2>&1 | head -50
```
Any difference is a potential bug. Sync the served path, restart, hard-refresh browser.

### 2. Browser caching
The CSS link tags in `shell.tsx` don't carry cache-busting query strings (e.g. `?v=hash`). On every restart of the portal, the served bytes change but the browser may serve a stale copy. The operator has been told to "hard-refresh" but the symptom could persist if the dev tools "Disable cache" toggle isn't on while DevTools is closed.

**Debug step**: open DevTools → Network tab → check "Disable cache" → reload. Look at the size + Last-Modified header on each `*.css` and `*.js` to confirm fresh bytes.

**Fix idea** (one-line): append `?v=${process.env.PORTAL_VERSION || Date.now()}` to each `<link rel="stylesheet">` href.

### 3. The kit's `app.css` was vendored but might be incomplete
PR #201 vendored `/tmp/portal-design-v2/autonomous-dev-design-system/project/ui_kits/portal/app.css` (44KB) into `static/app.css`. The kit's app.css references CSS variables that should be defined in `colors_and_type.css` (vendored as `design-tokens.css`). But the kit's `index.html` ALSO inlines a dark-theme override block before loading `app.css`. We don't replicate that pre-load inline block; we depend on `design-tokens.css` having the `[data-theme="dark"]` selector.

**Debug step**: in the live page, run in console:
```js
getComputedStyle(document.documentElement).getPropertyValue('--bg-0')
```
Should be `#14130f` (dark) when `data-theme="dark"`. If it returns the light value, the cascade is wrong.

### 4. Layout / sizing assumptions
The kit's `app.css` was designed for "design-width 1280; scales down" but never specifies a minimum window width. If the operator is viewing on a 13" laptop with the browser at less than full-screen, the 220px rail + 1280px content max-width may overflow and clip. The screenshots in `/tmp/portal-design-v2/autonomous-dev-design-system/project/screenshots/` show a wide viewport.

**Debug step**: check viewport width during inspection. If <1500px, the rail+content combo is tight.

### 5. Daemon data is real but zero
`/api/daemon-status` returns real readers but `mtdSpend=0`, `approvalsCount=0` because the daemon hasn't generated any work. The rail-ops bar correctly shows "Daemon running" and a $0.00 MTD. If the operator expected populated values matching the kit's mockup screenshots (which used fixture data showing $1,843 etc.), the gap is data, not code.

**Workaround**: extend `server/stubs/*.ts` to produce richer fixture data when no live data is present, OR run some test requests through the daemon to populate the cost ledger.

### 6. Unswept surfaces
Voice sweep (SPEC-034-2-05) was completed in #189 and #228 but might have missed strings buried in conditional branches. Not a layout issue but could explain "doesn't feel right."

---

## Architectural decisions deferred

These are open questions the operator deferred to a later session. They do NOT block visual parity:

### Plugin contribution API for Homelab
The kit's `Shell.jsx` shows a Homelab nav entry. We intentionally do NOT include it in portal core nav (per the operator's explicit direction). The plan is for `autonomous-dev-homelab` plugin to register a contribution at portal startup that adds:
- A `Homelab` nav item under OPERATE
- A `/homelab` route serving a view from the plugin's repo
- Optional rail-ops state (e.g. `homelabFailingCount` badge)

**Status**: not designed, not built. The portal has no plugin-contribution hook today. When ready, this needs a new PRD/TDD.

### Host plugin question
Today the portal ships in `plugins/autonomous-dev-portal/`. Options:
- Keep there; treat `autonomous-dev-portal` as the host that other plugins contribute to.
- Move portal shell into `plugins/autonomous-dev/` core; rename `autonomous-dev-portal` to e.g. `autonomous-dev-portal-host` if it survives at all.

**Status**: pending operator decision. Code is in `autonomous-dev-portal` and that hasn't changed.

---

## Known live bugs (small)

1. **Static asset duplication** between `server/static/` and `static/` — see priority 1 above. The next sweep should pick a canonical location and delete the other.
2. **`/api/agents/X/promote`** requires `?version=X` query param OR `version` form body. The 400 "version-required" error is correct but the kit's Inspect modal doesn't supply version yet, so promote from the UI always 400s. Fix: add a version input to the inspect modal.
3. **Agent-factory `getGitRoot` fallback** (PR #223) tolerates non-git contexts for integrity check, but the audit chain (`audit.ts`) still emits warnings about git context in some paths. Not blocking but noisy in logs.
4. **`bun.lock`** was untracked in PR #230, but other plugin dirs may have similar drift. Sweep on next session.
5. **CI on `main` is partially red** — `spec-reconciliation`, `typecheck`, `lint` were failing before this session started. Out of scope but should be addressed.

---

## Debug protocol for next session

To make progress on the "still not looking right" perception:

### Step 1: capture the gap
Ask the operator to:
1. Open `http://127.0.0.1:19280/` with DevTools open, "Disable cache" checked
2. Take a screenshot of the rendered Dashboard
3. Put it next to `/tmp/portal-design-v2/autonomous-dev-design-system/project/screenshots/dashboard.png`
4. Annotate the differences (specific elements that look wrong)

Without a concrete visual diff, every fix is speculation.

### Step 2: prove the cache + asset story
```bash
# Sweep for stale assets
cd plugins/autonomous-dev-portal
diff -r server/static/ static/ 2>&1

# Verify served bytes
for css in design-tokens.css app.css portal.css shell.css primitives.css; do
  echo "=== $css ==="
  /usr/bin/curl -s "http://127.0.0.1:19280/static/$css" | head -3
  echo "  size: $(/usr/bin/curl -s "http://127.0.0.1:19280/static/$css" | wc -c)"
done
```

### Step 3: pixel-compare the design-system page
The `/design-system` route is the canonical regression surface — it renders every primitive in isolation. If it looks right but the Dashboard looks wrong, the bug is in surface composition. If `/design-system` itself looks wrong, the primitives are misrendering.

### Step 4: check the kit's `index.html` actual render
The kit ships an `index.html` that React-renders the same JSX:
```bash
cd /tmp/portal-design-v2/autonomous-dev-design-system/project/ui_kits/portal/
python3 -m http.server 8123 &
open http://localhost:8123/
```
Compare this rendering to our portal's. Should be visually identical surface-by-surface. Differences are bugs.

### Step 5: only after capturing the diff
Then it's specific edits. Don't change anything without seeing what's wrong.

---

## Operational quickstart

For the next session, after pickup:

```bash
# Daemon needs to be running for fresh heartbeat
autonomous-dev daemon stop && autonomous-dev daemon start

# Portal
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal
pkill -f "bun run server/server" 2>/dev/null
sleep 2
PORTAL_DATA_DIR=~/.autonomous-dev/portal bash bin/start-standalone.sh > /tmp/portal.log 2>&1 &
sleep 5
curl -fsS http://127.0.0.1:19280/ -o /dev/null -w "HTTP %{http_code}\n"  # expect 200

# Hard-refresh in browser: Cmd+Shift+R (Mac)
```

---

## Key files (where to look)

- `plugins/autonomous-dev/docs/prd/PRD-018-portal-visual-redesign.md` — original commission
- `plugins/autonomous-dev/docs/plans/PLAN-037-portal-kit-parity.md` — parity sweep parent
- `plugins/autonomous-dev/docs/triage/setup-wizard-bugs.md` — earlier bug tracker
- `/tmp/PLAN-037-audit.md` — gap audit that drove PLAN-037 (may be wiped on tmp clear)
- `/tmp/portal-design-v2/autonomous-dev-design-system/` — vendored kit source (also `portal-design/` from the first download)
- `plugins/autonomous-dev-portal/server/components/` — shell, rail-nav, brand-wordmark, primitives, kill-switch
- `plugins/autonomous-dev-portal/server/wiring/` — adapter shims for the action routes
- `plugins/autonomous-dev-portal/server/static/` AND `plugins/autonomous-dev-portal/static/` — the duplicated asset trees (priority 1 debug target)

---

## Next-session opening prompt

```
Pick up portal redesign visual debug. Read docs/triage/PORTAL-REDESIGN-
HANDOFF.md first — start with "Debug protocol for next session" Step 1.

Don't dispatch agents until we have a screenshot diff. Every prior round
that tried to fix "doesn't look right" without a concrete visual target
produced PRs that didn't move the needle from the operator's perspective.

Check the static/ vs server/static/ duplication first. Sync any drift.
Then audit cache headers on the served CSS.

Portal: http://127.0.0.1:19280/. Daemon should be running. Cumulative
session: 183 PRs landed.
```
