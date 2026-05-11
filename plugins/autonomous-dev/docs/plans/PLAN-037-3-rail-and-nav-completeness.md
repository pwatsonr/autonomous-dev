# PLAN-037-3: Rail-ops + nav completeness

## Metadata
- **Parent**: PLAN-037-portal-kit-parity
- **Effort**: 2 days
- **Dependencies**: [PLAN-037-1] (theme), [PLAN-037-2] (daemon-status endpoint)
- **Priority**: P0 (rail is visible on every page)

## Objective

Make the left rail visually and functionally match the kit's `Shell.jsx`:
- 7 nav items (currently 5) across two groups with mono uppercase group labels
- Real icons (Lucide) on every nav item
- Count badges on Approvals + Requests + Agents
- Brand wordmark + meta-mono caption `CONTROL PLANE · v0.1.0`
- 3-line rail-ops bar (Daemon / Breaker / MTD spend) + kill button + theme toggle

**Note**: the kit shows a Homelab nav entry. We intentionally omit it from portal core — Homelab will be contributed by the `autonomous-dev-homelab` plugin via a future plugin-contribution mechanism (separate plan).

## Scope

### In Scope
1. **Extend `rail-nav.tsx`** to include the 2 missing portal-core nav entries — Requests (`/requests` — note: no `/requests` route exists today; this plan also registers a stub that 302s to `/` for now until a Requests surface ships), Agents (`/settings#agents`, since Agents is a Settings tab today). (Homelab is intentionally not added — see Objective note.)
2. **Add group labels** ("OPERATE" / "SYSTEM") above each `.rail-nav-group` using the kit's `.rail-nav-group-label` class (kit `app.css` already defines it).
3. **Render Lucide icons** for every nav item using the existing `icon()` helper from `server/lib/icons.tsx`. Mapping: Dashboard→activity, Approvals→shield-alert, Requests→git-pull-request, Costs→dollar-sign, Agents→bot, Settings→sliders (add to vendored set if missing), Ops→terminal.
4. **Wire count badges**: extend `RailNav` props to accept `requestsCount`, `agentsAlertCount` and render the `.count` badge when > 0.
5. **Extend `BrandWordmark`** to render the `meta-mono` caption `CONTROL PLANE · v{version}` underneath. Read version from `plugin.json`.
6. **Rewrite `rail-ops` block in `shell.tsx`** to render 3 metric lines per kit:
   - `<dot> Daemon {state} {ageSeconds}s`
   - `<dot> Breaker {OK|TRIPPED} {count}/{threshold}`
   - `MTD spend ${mtdSpend} ({pctOfCap}%)`
   then the kill button + theme toggle.
7. **Thread shell props in `renderFullPage`** (`server/templates/index.tsx:152-172`) — fetch from `/api/daemon-status` (PLAN-037-2) server-side OR derive locally from heartbeat.json, then pass `approvalsCount`, `daemonStatus`, `breakerState`, `mtdSpend`, `mtdPctOfCap`, `killSwitchEngaged` to every `<ShellLayout>` invocation.

### Out of Scope
- Building a real Requests surface (just a nav stub so the link works).
- Homelab nav entry and surface — deferred to a future plugin-contribution plan; will be contributed by `autonomous-dev-homelab` rather than added to the portal core nav.
- Live SSE updates to the rail-ops bar — initial render only. Live updates land in a follow-up if needed.

## Verification
- `curl -s http://127.0.0.1:19280/` shows 8 nav items, mono group labels, lucide SVGs inline, MTD spend value rendered (e.g. `$16.84 MTD (4%)`).
- Daemon status line updates correctly when the daemon is stopped (`autonomous-dev daemon stop`) — shows "Daemon down" with err-tone dot.

## Tests
- Unit: `rail-nav.test.tsx` extended for 8 items + badges + icons; `shell-layout.test.tsx` extended for the new shell props.
- Integration: render dashboard with daemon up and down; assert rail content differs.

## Risks
| Risk | Mitigation |
|---|---|
| `sliders` icon not in vendored set | Add it to `static/icons/` in the same PR |
| Reading heartbeat.json on every page render is slow | Cache for 5s in memory; the rail tolerates 5s staleness |
