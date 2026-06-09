# PRD-026: Portal v3 Design Implementation

| Field | Value |
|-------|-------|
| **PRD ID** | PRD-026 |
| **Title** | Portal v3 Design Implementation — pipeline-first control plane |
| **Version** | 1.0 |
| **Date** | 2026-06-08 |
| **Status** | Proposed |
| **Plugin** | autonomous-dev-portal |

> Source of truth: the **`autonomous-dev-v3`** design bundle exported
> from Claude Design (a React/JSX prototype). It was analyzed file-by-file
> against the current Hono portal; the structured gap analysis is
> persisted at
> `plugins/autonomous-dev/docs/triage/PORTAL-V3-DESIGN-GAP-2026-06-08.designs.json`.
> The prototype's **design tokens are byte-identical** to the portal's
> shipped `static/design-tokens.css` — v3 is an evolution *on* the
> PRD-018 token system, not a re-skin. The job is to recreate the v3
> layouts pixel-faithfully in the existing Hono + HTMX server-rendered
> stack (`server/components/*.tsx`, `server/routes/*.tsx`, `static/*.css`,
> `server/charts/`), not to port React.

---

## 1. Problem Statement

The portal today renders a **repos-grid + standards-drift + requests-table**
dashboard and a single-column request detail. The v3 design reframes the
portal around the thing that is actually unique about this product — the
**8-phase pipeline** — and pushes density, live-ness, and operator
ergonomics well past the current chrome. The shell (220px rail, ops bar,
theme toggle) already matches v3 (shipped in PRD-018 / SPEC-035/037); the
gap is almost entirely **layout, new components, and a handful of token
value drifts**, not foundations.

The gap analysis (7 design files, ~140 individual gaps) groups cleanly:

- **A stale-token bug shared with PRD-025** — `app.css` re-declares dark
  `--phase-*` with old values (fixed under PRD-025 FR-025-02; listed here
  because it blocks visual accuracy of every phase chip).
- **Missing structural chrome** — sticky frosted `Topbar`, `.main-inner`
  wrapper, `100vh`/overflow scroll model, density-token layer.
- **New hero surfaces** — pipeline swimlanes, KPI sparkline strip, 14-day
  stacked cost bars, agents-by-utilization grid.
- **Reworked detail/ops/approvals/logs** — clickable phase track + sticky
  gate panel + diff viewer; 6-column approvals grid with reviewer
  check-dots; ops tiles (kill / breakers / firewall / cost ceiling /
  daemon); streaming `.log` terminal.
- **Optional polish** — density + accent presets ("tweaks"), inspector
  slide-over.

## 2. Goals & Non-Goals

### Goals

- **G1.** Recreate the v3 dashboard (swimlanes + KPI sparklines + cost
  bars + agents grid) as the portal hero, server-rendered, pixel-faithful
  to the prototype's measured values.
- **G2.** Land the structural chrome (Topbar, `.main-inner`, scroll model,
  density tokens) that every v3 view depends on.
- **G3.** Rework request-detail, approvals, ops, and logs to the v3
  layouts.
- **G4.** Keep token discipline: **zero new hex outside `design-tokens.css`**,
  all new CSS consumes existing tokens (enforced by the now-live linter
  from PRD-025 FR-025-01), CSP-clean (no inline styles/scripts beyond the
  nonce'd FOUC IIFE), WCAG 2.2 AA preserved.
- **G5.** Keep the suite green — unit, Cypress e2e, and Playwright visual
  goldens regenerated intentionally, not by accident.

### Non-Goals

- **NG1.** Porting the Claude-Design `tweaks-panel.jsx` frosted-glass
  harness or its `postMessage` protocol — that is design-tool
  scaffolding. Only its *intents* (density, accent presets) are in scope,
  rendered in the portal's own opaque aesthetic (§4.5, P2).
- **NG2.** Replacing the token system, fonts, or brand. v3 reuses them.
- **NG3.** Client-side React. The portal stays Hono SSR + HTMX + small
  vanilla JS modules.
- **NG4.** New backend data sources beyond what the views need
  (swimlane grouping, per-agent utilization, 14-day phase-split cost
  series) — those are additive readers, not new subsystems.

## 3. User Personas

- **Operator at a glance.** Wants in-flight work, burn rate, gate
  backlog, and "what needs me" visible without drilling. v3's KPI strip +
  swimlanes + approvals badges serve this.
- **Operator triaging one request.** Wants the phase track, the current
  artifact, the reviewer verdicts, and approve/reject in one screen — v3's
  request-detail two-column layout.
- **Operator on incident.** Wants kill-switch, breakers, firewall, cost
  ceiling, daemon health on one Ops page.

## 4. Functional Requirements

> Effort tags (xs/s/m/l/xl) carried from the gap analysis. Target files
> are under `plugins/autonomous-dev-portal/`.

### 4.1 P0 — structural chrome (unblocks every view)

- **FR-026-01 (m).** Add a sticky, frosted `Topbar` component
  (`server/components/topbar.tsx`): `h1` at 17px, optional sub-title,
  live indicator, right-slot for page actions, `backdrop-filter: blur`.
  Every route renders its own `Topbar` (replaces the static `.page-head`).
  The 17px title is the single most visible regression vs today's 26–28px.
- **FR-026-02 (s).** Add the `.main-inner` content wrapper
  (`max-width:1480px`, density-token padding) and switch the layout to the
  v3 scroll model: `.app{height:100vh}`, `body{overflow:hidden}`,
  `.main{overflow-y:auto}` — required for sticky Topbar and any slide-over.
- **FR-026-03 (s).** Add the **density token layer** to
  `design-tokens.css`: `[data-density="comfortable"|"compact"]` defining
  `--row-y`, `--pad-card`, `--pad-section`; refactor card/section/table
  padding to consume them.
- **FR-026-04 (xs, shared w/ PRD-025 FR-025-02).** Remove the stale dark
  `--phase-*` block from `app.css`; phase colors come only from
  `design-tokens.css`.
- **FR-026-05 (xs).** Fix the rail/shell CSS detail drifts the gap
  analysis enumerates: `.rail-nav-group-label` selector mismatch (labels
  currently unstyled), active-icon brand color, count-badge contrast,
  `.rail-ops` background, brand caption letter-spacing, theme-toggle
  title-case labels.

### 4.2 P0 — dashboard hero

- **FR-026-10 (xl).** **Pipeline swimlanes:** an 8-column board grouped by
  phase (PRD→Observe), each lane a phase header (dot + label + count) over
  stacked **pipeline cards** (`.pcard`: id+priority, title, progress bar,
  agent avatar + ETA, cost; `--lane-color` from phase token; `attn` /
  `blocked` / `live` states). Cards link to request-detail. Needs a
  `readDashboardData()` extension to group in-flight requests by phase.
- **FR-026-11 (m).** **KPI strip** of 4 tiles (In-flight, Burn rate, Gate
  pass-rate, Approvals queue), each with delta + sub-line and a **server-
  rendered sparkline** (reuse `server/charts/sparkline.ts`). `--kpi-num`
  28px; `overflow:hidden`; delta up/down color rules.
- **FR-026-12 (m).** **14-day stacked cost bars** by phase
  (`.cost-bars`/`.cost-bar`/`.seg` + axis + phase legend), fed by a
  14-day phase-split series from the cost reader (reuse
  `stacked_bar_chart.ts` palette/scale).
- **FR-026-13 (m).** **Agents-by-utilization grid** (top-9 on dashboard,
  full 18 on Agents view): per-agent phase chip, role, util bar, runs,
  p50, MTD spend. Needs a per-agent utilization reader.
- **FR-026-14 (s).** **Activity feed** (`.feed`/`.feed-row`): timestamp,
  agent chip, message, result; newest row flash-highlight; "Streaming"
  live dot. Fed by the existing log/event pipeline.
- **FR-026-15 (xs).** `.sec-head h2` → 13px mono uppercase `--fg-2`
  eyebrow (currently 16px sans); `.seg` segmented control active-class
  `.on`→`.active`, height 26→28px; `.card-h` padding 14→12px, `h3` 14→13px.

### 4.3 P1 — request detail

- **FR-026-20 (l).** **Phase track:** 8 numbered dots with a hairline
  connector; states `done`/`now`(pulsing amber)/`pending`; clicking a
  phase swaps the artifact pane **inline** (not a modal). Replaces the
  flat bordered-button track.
- **FR-026-21 (l).** **Two-column `.rdetail` layout:** artifact pane +
  **360px sticky gate panel** unifying reviewer verdict rows
  (pass/warn/fail dots), pass/warn/fail chip summary, note textarea,
  approve/reject/defer buttons, and the post-decision banner. Use
  `minmax(0,1fr)` first column + `min-width:0` so long content can't blow
  out the panel (the verifier-caught bug in the prototype).
- **FR-026-22 (m).** **Artifact panes** per phase: PRD markdown, live
  spec (heading + prose + code blocks), and a **multi-file diff viewer**
  (`.diff` with two line-number columns, `.hunk` rows, add/del/context
  line classes, horizontal scroll on `.body`).

### 4.4 P1 — approvals, ops, logs

- **FR-026-30 (l).** **Approvals:** 6-column grid
  (`request | title | gate | reviewer-checks | waiting | actions`) with
  per-reviewer **check-dots** (`.cdot` pass/warn/fail/pending), row
  selection + preview card, gate-stats-7d card (auto/operator/rejected/
  re-spec'd + median time-to-approve), filter strip, double-confirm bulk
  approve. Add the missing `.btn.ok-btn` and `.btn.xs` classes.
- **FR-026-31 (l).** **Ops:** kill-switch **tile** (promoted from the
  rail; engage requires typing `STOP`; engaged-pulse animation), per-
  service **breaker grid**, autopilot tile, firewall egress allowlist,
  cost-ceiling meter, daemon health tile. Wire to `readOpsHealth()`
  (incl. circuit-breaker + production-intelligence state — see PRD-025
  FR-025-… / PRD-009 FR-935/938).
- **FR-026-32 (m).** **Logs:** a `.log` terminal container (not `ul/li`)
  with timestamp + agent-tag + tone-colored message columns, grep input,
  filter strip, follow-tail, flash-on-new-line. Token-only colors
  (`--bg-0`/`--fg-*`/`--info`), closing PRD-018 R-02 for the log block.

### 4.5 P2 — polish

- **FR-026-40 (m).** **Inspector slide-over** (480px right pane) for quick
  request preview without leaving the list — a portal-native opaque panel
  + HTMX slot, replacing modal overlays where the design uses the
  inspector.
- **FR-026-41 (m).** **Density + accent "tweaks"** rendered in the
  portal's own aesthetic (NOT the Claude-Design harness): density toggle
  (wired to FR-026-03 tokens) and 4 accent presets (amber/cyan/sage/rose)
  that rewrite `--brand*` at runtime via a small vanilla-JS module +
  rail-ops trigger. Persist via the existing settings store.

## 5. Acceptance Criteria

- **AC-01.** Every route renders the sticky frosted `Topbar`; the page
  title is 17px; the content scrolls under it with `body` overflow hidden.
  (FR-026-01/02)
- **AC-02.** Toggling `[data-density]` visibly changes row/card/section
  padding via tokens only; no per-component magic numbers. (FR-026-03)
- **AC-03.** The dashboard shows 8 phase swimlanes populated from real
  in-flight requests; a card click opens that request's detail; empty
  lanes render the `—` placeholder. (FR-026-10)
- **AC-04.** KPI tiles render server-side sparklines; 14-day cost bars
  stack by phase with a legend; agents grid shows util/runs/p50/MTD.
  (FR-026-11/12/13)
- **AC-05.** Request-detail shows the numbered phase track with the
  current phase pulsing; clicking a phase swaps the artifact inline; the
  360px gate panel stays sticky and never overflows on long diffs.
  (FR-026-20/21/22)
- **AC-06.** Approvals shows reviewer check-dots and gate-stats; Ops shows
  all five tiles and the kill-switch requires typing `STOP`; Logs streams
  in a `.log` terminal with flash-on-new. (FR-026-30/31/32)
- **AC-07.** `lint-css-tokens.sh` + `lint-box-shadow.sh` (live per PRD-025
  FR-025-01) pass: no new hex, no raw box-shadow outside tokens.
- **AC-08.** `bun test` (unit) and Cypress e2e pass; Playwright visual
  goldens are regenerated and reviewed; accessibility checks (contrast,
  focus order, keyboard nav) pass for every reworked view.

## 6. Success Metrics

| Metric | Baseline | Target |
|--------|----------|--------|
| v3 hero (swimlanes + KPI + cost + agents) | absent | shipped |
| Views on the sticky Topbar chrome | 0 / 9 | 9 / 9 |
| New hex outside `design-tokens.css` | (drift present) | 0 (CI-enforced) |
| Reworked views with regenerated visual goldens | 0 | dashboard, request-detail, approvals, ops, logs |
| WCAG 2.2 AA regressions | — | 0 |

## 7. Open Questions

- **OQ-01.** Swimlanes vs list vs timeline: ship all three view modes
  (design has the toggle) or swimlanes-only first?
- **OQ-02.** Sparkline/cost data: live readers now, or seeded/derived
  until the readers land (dashboard stays presentational)?
- **OQ-03.** Accent presets (FR-026-41): ship in this PRD or split to a
  follow-up? They touch `--brand*` at runtime and need a contrast re-check
  per preset.
- **OQ-04.** Inspector slide-over vs keeping modal overlays — is the
  slide-over worth the new shell slot for v1?

## 8. References

- Design gap analysis (this repo):
  `plugins/autonomous-dev/docs/triage/PORTAL-V3-DESIGN-GAP-2026-06-08.designs.json`
- Design bundle: `autonomous-dev-v3` (Claude Design export) — `index.html`,
  `dashboard.jsx`, `request-detail.jsx`, `views.jsx`, `shell.jsx`,
  `app.jsx`, `static/app.css`, `static/design-tokens.css`
- Token foundation & contrast rules: **PRD-018** (portal visual redesign,
  M-02 phase contrast / OI-3403)
- Shipped shell: SPEC-035 (ShellLayout), SPEC-037 (dark default + theme
  toggle)
- Token-lint enablement dependency: **PRD-025** FR-025-01/02
- Reviewers to run on this work: `ux-ui-reviewer`, `accessibility-reviewer`
