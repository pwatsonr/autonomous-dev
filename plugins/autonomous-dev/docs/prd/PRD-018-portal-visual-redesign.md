# PRD-018: Portal Visual Redesign — autonomous-dev Design System Adoption

| Field       | Value                                          |
|-------------|------------------------------------------------|
| **Title**   | Portal Visual Redesign — Design System Adoption|
| **PRD ID**  | PRD-018                                        |
| **Version** | 0.1                                            |
| **Date**    | 2026-05-09                                     |
| **Author**  | Patrick Watson                                 |
| **Status**  | Draft                                          |
| **Plugin**  | autonomous-dev-portal                          |
| **Source**  | claude.ai/design bundle `1Pk1tLTNNUgKR8opZBCUeg` |
| **Builds on**| PRD-009 (Web Control Plane)                   |

---

## 1. Problem Statement

The portal shipped under PRD-009 with a functional UI but no visual identity — a pragmatic choice to unblock the surface area while design intent was unsettled. Six months later, the system is in operator hands and the lack of a consistent visual language is now a real cost:

1. **Status communication is inconsistent.** Different surfaces invent ad-hoc color choices for "ok / warn / err / in-progress." There is no shared vocabulary, so a yellow chip in one view doesn't mean the same thing as a yellow chip in another.
2. **Density is wrong for the audience.** The current type scale, padding, and corner radii read as a generic SaaS app. Operators run portfolio views with 20+ active requests; the chrome eats the data.
3. **Phase identity is invisible.** PRD / TDD / Plan / Spec / Code / Review / Deploy / Observe are first-class concepts the operator must track at a glance — today they are indistinguishable strings.
4. **No brand presence.** The portal has no wordmark, no mark, no consistent treatment in the page title, and nothing to anchor screenshots in docs or shared links.
5. **Safety controls don't read as safety controls.** Kill switch and circuit breaker UI carry the same weight as a "refresh" button. For a system that can ship code autonomously, the destructive controls need to look destructive.

The user has commissioned a complete design system (`autonomous-dev-design-system`) — tokens, components, full UI kits for every portal surface, brand assets, voice/tone rules, content fundamentals. This PRD is the request to **adopt that system as the portal's visual layer**.

---

## 2. Goals

| ID   | Goal                                                                                                                                            |
|------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| G-01 | Adopt the `colors_and_type.css` token set as the portal's single source of design tokens. Every color, font, size, space, radius, and motion value in the portal must come from these tokens; no hand-coded magic numbers. |
| G-02 | Re-skin every portal surface (Dashboard, Approvals, Request Detail, Settings, Costs, Ops) to match the kit in `ui_kits/portal/*.jsx` pixel-faithfully — same layout, same component vocabulary, same density. |
| G-03 | Establish the brand mark and wordmark (`[ autonomous-dev ]` bracket motif) on the persistent left rail, the page title, and the (currently empty) login surface. Use the supplied `assets/wordmark.svg`, `wordmark-dark.svg`, `mark.svg`. |
| G-04 | Implement the phase color vocabulary (8 colors, one per pipeline phase) consistently — used as left bar on repository cards, chip backgrounds in timelines, and as accent on phase-scoped views. Operator must be able to identify any phase by color alone. |
| G-05 | Apply the safety-control treatment: kill switch, circuit breaker, and other destructive actions read as destructive (semantic `--err` palette, distinct iconography, distinct typography). Idle/passive controls read as idle. |
| G-06 | Adopt the content fundamentals — sentence case, no emoji, mono for IDs/status/timestamps/numerics, sans for headings and prose, terse SRE voice. Sweep all existing copy strings to comply. |
| G-07 | Ship both a light theme (`--bg-0: #fafaf7`) and a true-dark theme (`#14130f`) with parity. Theme is operator-selectable; default is light to match a typical desktop browser environment, persistence is per-operator. |
| G-08 | Establish a Design System reference page inside the portal itself (route: `/design-system`) that renders every token group and component cluster from `preview/*.html`. This is the canonical reference for future contributors and the regression-test surface. |
| G-09 | Add a 1px-rule, hairline-driven elevation system replacing any existing shadow-heavy cards. Cards: 1px border, 3px radius, no shadow. The repo card on the dashboard gets the 4px left bar in a phase color (the system's one decorative motif). |
| G-10 | Establish the `dot.live` pulsing indicator as the canonical "live state" affordance for SSE-streamed surfaces — heartbeat, in-flight phase, active polling. Replace any spinner / loading bar / skeleton-shimmer currently used. |

## 3. Non-Goals

| ID    | Non-Goal                                                                                                                          |
|-------|-----------------------------------------------------------------------------------------------------------------------------------|
| NG-01 | Not a frontend framework migration. Whether to keep the current Hono JSX renderer or move to a different stack is out of scope of this PRD; the design tokens and component shapes are framework-agnostic and must work in either world. The TDD will recommend an answer — see open question OQ-01. |
| NG-02 | Not a feature change. No new portal surfaces, no new data fetched, no new SSE events. Pure visual / typographic / componentry rework. |
| NG-03 | Not a custom-font undertaking. We ship JetBrains Mono + Inter from Google Fonts (CDN) for v1. Self-hosting fonts is a follow-up. |
| NG-04 | Not a vendored-icon undertaking. Lucide icons are CDN-linked. Vendoring as `lucide-static` files is a follow-up. |
| NG-05 | Not a brand identity exercise. The wordmark and bracket motif as supplied in the design bundle are accepted as-is; we do not run a separate brand exploration in scope of this PRD. |
| NG-06 | Not a mobile/responsive overhaul. The kit targets desktop/laptop with the 220px left rail + 1280px content max-width as designed. Tablet looks acceptable; phone is explicitly not supported. |
| NG-07 | Not an accessibility re-audit. Existing accessibility behaviors must be preserved (keyboard focus, ARIA labels, semantic HTML); the design kit's `:focus-visible` 2px outline and underlined links inherit that posture, but a full a11y audit is a follow-up. |
| NG-08 | Not a revisit of PRD-009 NG-04 ("not a SPA / framework-heavy UI"). The supplied kit is React JSX but the components are simple enough to port to HTMX-rendered server templates. The TDD picks the path. |

---

## 4. User Stories

### Operator at the Dashboard

**As an operator** running a portfolio of 5+ repos, **I want** the dashboard to surface, at a glance: how many requests are active per repo, which repos have something awaiting my approval, what phase each active request is in, and how much money I've spent month-to-date — **so that** my morning check-in takes 30 seconds, not 5 minutes.

The new dashboard implements this via:
- KPI strip across the top (active, awaiting approval, MTD spend, standards hits) — sourced from `Dashboard.jsx` lines 16-30.
- Repo cards (one per allowlisted repo) with the 4px phase-colored left bar showing the highest-priority active phase, MTD cost, active request count, and a click-through.
- Approval queue strip showing the next 3 gates regardless of repo, with reviewer / standards / cost classification chips.

### Operator approving a request

**As an operator** at trust level L1, **I want** the approval surface to render the artifact (PRD/TDD/diff) at full readability with a clear approve / request-changes / reject action, **so that** I never approve a complex artifact in a chat window again.

### Operator setting up cost caps

**As an operator** new to the system, **I want** the settings forms to validate as I type, with the live-applied value visible immediately (no save-and-pray), **so that** I don't break my daemon by editing the JSON file by hand.

### Operator during an incident

**As an operator** facing a runaway request, **I want** the kill switch on the Ops page to be visually unmistakable — distinct from any other control, with the engaged / disengaged state immediately legible — **so that** the action of last resort is the action of one second.

---

## 5. Requirements

### 5.1 Tokens & Theming

| ID   | Requirement                                                                                                                                                |
|------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-01 | The contents of `colors_and_type.css` are vendored verbatim into `plugins/autonomous-dev-portal/server/static/design-tokens.css` and imported as the FIRST stylesheet on every page. |
| R-02 | All other portal CSS references variables from `design-tokens.css`. No hard-coded color, font-family, font-size, spacing, or radius values may remain in non-token CSS. CI rejects PRs that introduce them. |
| R-03 | Light and dark themes are toggled by `[data-theme="light"]` / `[data-theme="dark"]` on `<html>`. Default is light. Choice persists in `localStorage` keyed `portal.theme`. SSR honors the cookie shadow (`portal-theme`). |
| R-04 | The Inter and JetBrains Mono fonts load via the `@import` already present in `colors_and_type.css`. Self-hosting is a follow-up. |

### 5.2 Layout Shell

| ID   | Requirement                                                                                                                                                |
|------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-05 | The persistent left rail is exactly 220px wide and contains: brand wordmark (top, 24px tall), section nav (Dashboard, Approvals, Costs, Ops, Settings), and a fixed-bottom global ops bar showing daemon status / kill-switch state / current MTD spend. |
| R-06 | No top header on most pages. Page title sits as `<h1>` (28px) at the top of the content column. Page-level actions sit to the right of the title in a `head-actions` group. |
| R-07 | Content column max-width is 1280px on dashboard / detail / settings; tables go full-width. |

### 5.3 Components

| ID   | Requirement                                                                                                                                                |
|------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-08 | The kit's `Primitives.jsx` is ported into the portal as either JSX (if framework retained) or template helpers (if HTMX) — exposing: `Btn`, `Chip` (status / phase variants), `Dot` (live / static), `Score` (0-100 bar), `CostRing`, `Card`, `KillSwitch`. |
| R-09 | Buttons follow the kit: primary (`--brand` background), secondary (transparent w/ border), ghost (no border, fills on hover), destructive (`--err` background). All have hover, active, focus-visible states matching `colors_and_type.css`. |
| R-10 | Status communication uses dot + UPPERCASE word badge (e.g. `● RUNNING`, `● ENGAGED`, `● TRIPPED`). Emoji are forbidden anywhere in the portal. CI lint rejects emoji in template strings. |
| R-11 | Phase chips render the phase name UPPERCASE (`PRD`, `TDD`, `PLAN`, `SPEC`, `CODE`, `REVIEW`, `DEPLOY`, `OBSERVE`) on the corresponding `--phase-*` background. |
| R-12 | The repo card on the dashboard has a 4px-wide left bar in `--phase-<active-phase>`. If no active phase, the bar is `--muted`. |
| R-13 | The kill switch surface uses the `KillSwitch` primitive — distinct from any other button — with `--err` palette when armed-to-engage and a flat-warning treatment when engaged. Confirmation requires typing `CONFIRM` per existing safety pattern. |
| R-14 | Tables use horizontal hairlines only — no zebra by default, no outer card frame. Sticky headers, hover-row highlight in `--bg-2`, active-selection 2px left bar in `--brand`. |
| R-15 | A pulsing `.dot.live` indicator replaces every spinner / skeleton / loader. SSE-streamed surfaces use it on the heartbeat, the in-flight phase chip, and the cost-ring center dot. |

### 5.4 Surface-by-Surface Adoption

| ID   | Requirement                                                                                                                                                |
|------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-16 | **Dashboard** matches `ui_kits/portal/Dashboard.jsx` — KPI strip, repo cards grid, approval queue strip, standards drift summary. |
| R-17 | **Request Detail** matches `RequestDetail.jsx` — artifact pane, timeline, gate panel, agent log, run history. |
| R-18 | **Costs** matches `Costs.jsx` — cost ring, time series, per-phase breakdown table, projection. |
| R-19 | **Ops** matches `Ops.jsx` — daemon status, heartbeat history, circuit breaker, kill switch, recent log entries. |
| R-20 | **Settings** matches `Settings.jsx` — trust levels, cost caps, allowlist, notifications, all with live form validation. |
| R-21 | A new route `/design-system` renders the contents of `preview/*.html` as a navigable token + component reference. Used as the canonical visual regression surface. |

### 5.5 Voice / Content

| ID   | Requirement                                                                                                                                                |
|------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-22 | Sweep every user-facing string in the portal for compliance with the README's content fundamentals: sentence case, no emoji, no exclamation marks, no hype words, ID rendering in mono, costs to 2 decimals always, ISO timestamps in tables / relative in prose. |
| R-23 | Replace the current ad-hoc copy with the kit's strings (`Daemon running`, `No active requests`, `Kill switch ENGAGED at <ISO>. All daemon processing will halt.`, etc.). |

---

## 6. Success Metrics

| ID   | Metric                                                                                                                                                     |
|------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| M-01 | 100% of design tokens used. CI grep for hex colors / px sizes / hardcoded font names in non-token CSS returns zero matches outside `design-tokens.css`. |
| M-02 | Operator can identify the phase of any in-flight request by color alone (no text), verified in user testing with 1 operator. |
| M-03 | Visual regression tests on `/design-system` cover all 17 component clusters from `preview/`, fail on any token-level diff. |
| M-04 | Before/after screenshot pairs for all 6 surfaces ship with the PR; reviewer can see the kit applied pixel-faithfully. |
| M-05 | Zero emoji and zero hex-color literals in user-facing portal templates after the sweep. CI enforces. |
| M-06 | Light + dark themes have feature parity. The same screenshots in dark match the kit's dark expectation. |

---

## 7. Open Questions

| ID    | Question                                                                                                                                                                                                                                       |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| OQ-01 | The supplied kit is React JSX. PRD-009 NG-04 forbids a SPA / framework-heavy UI. Options: (a) port the JSX components to the existing Hono JSX server-render pipeline; (b) port to plain template helpers in whatever templating the portal currently uses; (c) accept a small client-side React bundle scoped to component primitives only. The TDD must pick one with a tradeoff write-up. |
| OQ-02 | The brand wordmark and bracket motif are original to the design bundle and have no upstream blessing. Confirm before we ship them publicly. |
| OQ-03 | Lucide icons via CDN: acceptable for v1, or do we vendor up front? CDN gives faster iteration; vendoring removes a runtime external dep. |
| OQ-04 | Theme default: light or dark? The design system says "Dark mode is a true dark, not gray-900" — implying dark is the spec. README implies light is default. Pick one. |
| OQ-05 | Does the `/design-system` reference page ship with the redesign or come as a follow-up? Recommendation: ship together; it doubles as the regression-test surface. |

---

## 8. Constraints

- **No new data dependencies.** The redesign reads from the same daemon state files / sqlite / SSE streams as today.
- **No new build chain.** Whatever the portal builds with today is the build the redesign uses (TBD by TDD per OQ-01).
- **Bun runtime is fixed.** The portal's Bun-based server (current state on `865adab`) is the runtime. No node migration in scope.
- **Portal must remain fully functional during incremental rollout.** No big-bang switchover. Token-first rollout, then shell, then surfaces, in that order.

---

## 9. Related bugs (logged during install / setup, not in redesign scope)

While running the autonomous-dev-assist setup wizard and installing the sibling plugins on 2026-05-09, five bugs surfaced. They are tracked in `docs/triage/setup-wizard-bugs.md`. Two are already fixed; three are open. This PRD lists them so they don't get lost — but the **fixes are out-of-scope for the visual redesign** and should land as standalone PRs (or in a follow-up PRD-019 — "Setup wizard / plugin install closeout").

| Bug ID | Severity   | Status               | Title                                                                                  | Fix landing |
|--------|------------|----------------------|----------------------------------------------------------------------------------------|-------------|
| B-1    | annoying   | open (workaround applied locally) | Config perms not auto-chmod 600 when secrets (webhook URLs / tokens) are written. V-017 warning fires. | Standalone PR: detect secret keys on save in `autonomous-dev config` write path → auto-chmod 600. |
| B-2    | cosmetic   | open                 | Wizard counts skills under `plugins/autonomous-dev/skills/` (always 0 — skills live in `autonomous-dev-assist`). Wording confuses users. | Standalone PR against `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`. |
| B-3    | **blocker**| open                 | Wizard documents CLI subcommands that don't exist (`request submit`, `request status`, `cost`, `agent list`, `observe`). Phase-7 first-request flow is impossible as written. | Either implement the missing subcommands in `intake/cli/dispatcher.ts`, or rewrite wizard Phases 5/7/9/10 to reflect the actual CLI surface (Discord/Slack adapters as primary entry points). Decide in a follow-up PRD or RFC. |
| B-4    | blocker    | **fixed in #152**    | `.claude-plugin/marketplace.json` missing the 5 sibling plugins (portal + 4 deploy backends) — they were unreachable to end users. | Done. Recommend a CI lint that requires every `plugins/*/plugin.json` to have a corresponding marketplace.json entry so this can't drift again. |
| B-5    | blocker    | **fixed in #153**    | All 5 sibling plugin manifests failed Claude Code validation (`author` was a string instead of `{name,url}`; portal additionally used JSON-Schema-style userConfig with unsupported keys). | Done. Recommend a CI lint that runs the Claude Code plugin validator against every manifest in the repo as part of CI. |

### Recommended follow-up

Bundle B-1, B-2, B-3 into a single closeout PRD ("PRD-019: setup wizard / plugin install closeout") if doing them together is cheaper than three small PRs. B-3 in particular needs an RFC-style scope decision (implement the CLI vs. rewrite the wizard), not just a fix.

The redesign work in this PRD does not depend on any of these bugs being fixed. They're listed here for traceability only.

---

## 10. References

- Source design bundle: `claude.ai/design`, handle `1Pk1tLTNNUgKR8opZBCUeg`. Extracted to (gitignored) developer machine for reading. Authoritative copy lives at the URL.
- `autonomous-dev-design-system/README.md` — content fundamentals + visual foundations.
- `autonomous-dev-design-system/project/SKILL.md` — agent-skill manifest.
- `autonomous-dev-design-system/project/colors_and_type.css` — token source-of-truth.
- `autonomous-dev-design-system/project/ui_kits/portal/*.jsx` — reference component implementations.
- `autonomous-dev-design-system/project/preview/*.html` — token + component preview cards.
- `autonomous-dev-design-system/project/screenshots/*.png` — target visual reference.
- PRD-009 (Web Control Plane) — the upstream portal PRD this redesign builds on.
