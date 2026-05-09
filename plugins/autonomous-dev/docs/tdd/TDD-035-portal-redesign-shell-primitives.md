# TDD-035: Portal Redesign — Shell, Primitives, and Design System Reference Page

| Field          | Value                                                              |
|----------------|--------------------------------------------------------------------|
| **Title**      | Portal Redesign — Shell, Primitives, and Design System Reference   |
| **TDD ID**     | TDD-035                                                            |
| **Version**    | 1.1                                                                |
| **Date**       | 2026-05-09                                                         |
| **Status**     | ready-for-review                                                   |
| **Phase**      | tdd                                                                |
| **PRD Ref**    | PRD-018-portal-visual-redesign                                     |
| **Author**     | Patrick Watson                                                     |
| **Parent PRD** | PRD-018: Portal Visual Redesign — Design System Adoption           |
| **Plugin**     | autonomous-dev-portal                                              |
| **Sibling TDDs** | TDD-034 (Foundations: tokens, theming, voice, CI lints), TDD-018-C (Surface adoption) |
| **Updated At** | 2026-05-09T20:00:00Z                                               |

---

## 1. Summary

TDD-035 is the second of three TDDs decomposed from PRD-018. It covers the portal's **layout shell** (220px left rail, brand wordmark, global ops bar), the **seven primitive components** (`Btn`, `Chip`, `Dot`, `Score`, `CostRing`, `Card`, `KillSwitch`), and the **`/design-system` reference page** that renders all 20 preview cards from the design bundle.

The core technical work is porting the design bundle's React JSX primitives to Hono JSX server-side components (per PRD-018 section 4.5's binding framework decision) and restructuring the portal's `BaseLayout` from its current `<header><nav>` top-bar pattern to the 220px persistent left-rail pattern established by the kit. Where the kit uses client-side state (theme toggle), this TDD ships a vanilla JS module — no React runtime, no bundler.

This TDD is deliberately scoped to **structure and components**. It does not re-skin the six existing surfaces (Dashboard, Approvals, Request Detail, Settings, Costs, Ops) — that is TDD-018-C. It does not vendor design tokens or implement CI lints — that is TDD-034. Its deliverables are: (1) a layout shell that all existing and future pages render inside, (2) a `primitives.tsx` file exporting seven Hono JSX components with the prop APIs pinned by PRD-018 R-08, and (3) a `/design-system` route serving the regression-test surface.

---

## 2. Goals and Non-Goals

### Goals

| ID     | Goal                                                                                                                |
|--------|---------------------------------------------------------------------------------------------------------------------|
| G-3501 | Replace the current top-bar `<header><nav>` layout with a 220px persistent left rail containing brand wordmark, section nav, and global ops bar. |
| G-3502 | Port the kit's 7 primitive components to Hono JSX TSX at `server/components/primitives.tsx` with the exact prop APIs from R-08. |
| G-3503 | Ship the `/design-system` route rendering all 20 preview cards as the canonical visual regression surface. |
| G-3504 | Vendor brand assets (`wordmark.svg`, `wordmark-dark.svg`, `mark.svg`) to `server/static/brand/`, gated on OQ-02 resolution. |
| G-3505 | Implement theme-aware wordmark switching (light wordmark on dark theme, dark wordmark on light theme) via server-rendered markup with a vanilla JS module for runtime toggle. |
| G-3506 | Ensure all shipped components comply with the hairline elevation rule (R-15a): 1px borders, 3px radii, no box-shadow outside `--shadow-*` tokens. |
| G-3507 | Establish the pulsing `.dot.live` indicator as the canonical live-state affordance, replacing any spinner or skeleton currently used. |

### Non-Goals

| ID      | Non-Goal                                                                                      | Rationale                                         |
|---------|-----------------------------------------------------------------------------------------------|---------------------------------------------------|
| NG-3501 | Re-skinning existing surface pages (Dashboard, Costs, Ops, etc.)                               | TDD-018-C scope                                   |
| NG-3502 | Vendoring `colors_and_type.css` or implementing CI lints (hex, emoji, box-shadow)              | TDD-034 scope                                     |
| NG-3503 | Mobile / responsive layout                                                                     | PRD-018 NG-06 — desktop only                      |
| NG-3504 | Self-hosting fonts or vendoring Lucide icons                                                   | PRD-018 NG-03 and NG-04 — follow-up               |
| NG-3505 | New data fetching or SSE event schemas                                                         | PRD-018 NG-02 — pure visual rework                |
| NG-3506 | Accessibility re-audit beyond preserving existing a11y behaviors                               | PRD-018 NG-07                                     |
| NG-3507 | Client-side React runtime or build chain                                                       | PRD-018 section 4.5 binding — Hono JSX + vanilla JS only |

---

## 3. Strategic Alignment

**Consistency**: The portal already uses Hono JSX server-side templates (`server/templates/layout/base.tsx`, `server/templates/fragments/*.tsx`). This TDD extends that pattern by adding a `server/components/` directory for reusable primitives — a natural evolution of the existing architecture. The new components follow the same `FC<Props>` pattern used by `Navigation`, `DaemonStatusPill`, and other existing fragments.

**Technical debt**: The current `BaseLayout` hardcodes a `<header><nav>` pattern that diverges from the kit's left-rail design. Rather than shimming the new layout into the old structure, this TDD replaces `BaseLayout` with `ShellLayout` — a clean break that eliminates the debt of maintaining two layout paradigms. The old `Navigation` fragment is deprecated and replaced by `RailNav`.

**Long-term trajectory**: The primitives file becomes the single source of truth for the portal's component vocabulary. TDD-018-C consumes these components without re-implementing them. Future portal surfaces (login, onboarding) also compose from this set. The `/design-system` page serves as both contributor reference and CI regression surface — a pattern that pays for itself over the lifetime of the portal.

---

## 4. System Architecture

### Component Diagram

```
plugins/autonomous-dev-portal/server/
  components/                          (NEW)
    primitives.tsx                     Btn, Chip, Dot, Score, CostRing, Card, KillSwitch
    shell.tsx                          ShellLayout (left rail + content column)
    rail-nav.tsx                       Section nav items
    rail-ops-bar.tsx                   Fixed-bottom global ops bar
    brand-wordmark.tsx                 Theme-aware wordmark SVG inline
    theme-toggle.tsx                   Vanilla JS module loader for toggle
  templates/
    layout/
      base.tsx                         DEPRECATED — replaced by ShellLayout
    views/
      design-system.tsx                NEW — /design-system page
      ...existing views (unchanged but will import ShellLayout)
  routes/
    index.ts                           Updated — adds /design-system route
    design-system.ts                   NEW — route handler
  static/
    brand/                             NEW — vendored brand SVGs
      wordmark.svg
      wordmark-dark.svg
      mark.svg
    js/                                NEW — vanilla JS modules
      theme-toggle.js                  Client-side theme toggle logic
    portal.css                         EXTENDED — shell + primitive CSS classes
```

### Service Boundaries

- **Hono JSX server renderer**: Owns all HTML generation. Primitives are pure functions that return JSX elements — no state, no side effects, no hooks.
- **Static asset serving**: Brand SVGs and the theme-toggle JS module are served from `/static/brand/` and `/static/js/` via the existing `staticAssets` middleware.
- **Client-side vanilla JS**: Theme toggle is the only client-side behavior in this TDD's scope. It reads/writes `localStorage` and toggles `data-theme` on `<html>`. No framework.

### Data Flow

The shell and primitives are purely presentational. They receive props from route handlers and render HTML. The only data flow addition is:

1. Route handler reads daemon state (existing pattern via `StateReader`, `HeartbeatReader`, `CostReader`).
2. Route handler passes props to `ShellLayout`, which renders the rail ops bar with daemon status, kill-switch state, and MTD spend.
3. `ShellLayout` wraps the page-specific view as `{children}`.

The `/design-system` route has no data dependencies — it renders static preview content.

---

## 5. Architectural Trade-offs

| Decision | Option A | Option B | Chosen | Rationale |
|----------|----------|----------|--------|-----------|
| **Btn variant implementation** | JSX inheritance — a base `ButtonBase` with subclass-like wrappers (`PrimaryBtn`, `DestructiveBtn`) | Composition — single `Btn` component with `kind` prop that maps to CSS classes | **Option B** | The kit uses a single `.btn` element with modifier classes (`.primary`, `.ghost`, `.destructive`). A single component with a `kind` prop mirrors this 1:1, keeps the API surface minimal (one import, not five), and matches the prop signature pinned by R-08. Inheritance would fragment the API for no structural benefit. |
| **KillSwitch confirm modal** | Native `<dialog>` element with `showModal()` | Custom modal `<div>` with backdrop, managed by vanilla JS | **Option A** | `<dialog>` is well-supported in all target browsers (Chrome 37+, Firefox 98+, Safari 15.4+), provides built-in focus trapping and backdrop, requires zero framework code, and satisfies the a11y requirements (escape key, focus return) without custom implementation. The portal already has a `confirm-modal.tsx` fragment using a similar pattern. |
| **Brand wordmark rendering** | Inline SVG directly in the JSX component — the wordmark is small (6 lines) | `<img>` tag referencing vendored `.svg` files, swapped by theme | **Option A** | Inline SVG allows `currentColor` inheritance for the text fill and `var(--brand)` for the bracket color, making theme switching instantaneous without swapping `src` attributes. The wordmark SVG is 6 lines — there is no size penalty. The `<img>` approach would require two separate requests and a JS swap on theme change, adding complexity for a trivial payload. The vendored SVG files still ship for external consumers (docs, screenshots). |
| **Preview card rendering on /design-system** | Server-side render from the raw HTML files in `preview/` via `dangerouslySetInnerHTML` or equivalent | Re-implement each card as a Hono JSX component using the primitives | **Option B** | The preview HTML files reference their own `_card.css` with `@import url('../../colors_and_type.css')` which conflicts with the portal's CSS pipeline. Re-implementing the 20 cards as JSX components that use the portal's own primitives and design tokens produces a true integration test — the regression surface exercises the actual components, not copies of them. Raw HTML injection would also violate FR-S34 (no `dangerouslySetInnerHTML`). |
| **Theme toggle implementation** | HTMX-driven: server round-trip on toggle, sets cookie, re-renders page | Vanilla JS module: client-side `data-theme` attribute swap + `localStorage` persistence | **Option B** | R-03 specifies `localStorage` keyed `portal.theme` for persistence and a cookie shadow `portal-theme` for SSR. A full page reload on theme toggle would cause visible flash and break SSE connections. Vanilla JS provides instant toggle with no network dependency. The cookie shadow is set by the same JS module so subsequent SSR renders honor the choice. |

---

## 6. Detailed Design

### 6.1 Layout Shell — `ShellLayout`

**File**: `server/components/shell.tsx`

The shell replaces `BaseLayout` and establishes the two-column grid layout.

```tsx
import type { FC } from "hono/jsx";
import { RailNav } from "./rail-nav";
import { RailOpsBar } from "./rail-ops-bar";
import { BrandWordmark } from "./brand-wordmark";

interface ShellProps {
    activePath: string;
    cspNonce?: string;
    /** Theme preference read from portal-theme cookie by route handler. */
    theme?: "light" | "dark";
    /** Daemon status for the ops bar. */
    daemonStatus?: "running" | "stale" | "dead" | "unknown";
    /** Kill switch state for the ops bar. */
    killSwitchEngaged?: boolean;
    /** Breaker state for the ops bar. */
    breakerTripped?: boolean;
    /** Month-to-date spend for the ops bar. */
    mtdSpend?: number;
    /** Pending approval gate count for nav badge. */
    gateCount?: number;
    children?: unknown;
}

export const ShellLayout: FC<ShellProps> = ({
    activePath,
    cspNonce,
    theme = "light",
    daemonStatus = "unknown",
    killSwitchEngaged = false,
    breakerTripped = false,
    mtdSpend,
    gateCount,
    children,
}) => (
    <html lang="en" data-theme={theme}>
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>autonomous-dev portal</title>
            <link rel="stylesheet" href="/static/design-tokens.css" />
            <link rel="stylesheet" href="/static/portal.css" />
            <script src="/static/htmx.min.js" defer nonce={cspNonce ?? ""}></script>
            <script src="/static/js/theme-toggle.js" type="module" nonce={cspNonce ?? ""}></script>
        </head>
        <body>
            <div class="app">
                <aside class="rail">
                    <div class="rail-brand">
                        <BrandWordmark />
                        <div class="meta-mono">CONTROL PLANE</div>
                    </div>
                    <RailNav activePath={activePath} gateCount={gateCount} />
                    <RailOpsBar
                        daemonStatus={daemonStatus}
                        killSwitchEngaged={killSwitchEngaged}
                        breakerTripped={breakerTripped}
                        mtdSpend={mtdSpend}
                    />
                </aside>
                <main class="main">
                    {children}
                </main>
            </div>
            <div id="modal-slot"></div>
        </body>
    </html>
);
```

**Theme prop wiring**: Route handlers must read the `portal-theme` cookie (as established by TDD-034 SS 5.3) and pass `theme={cookieValue}` when rendering ShellLayout. Example:

```tsx
// In a route handler:
import { getCookie } from "hono/cookie";

export function dashboardHandler(c: Context): Response {
    const theme = getCookie(c, "portal-theme") === "dark" ? "dark" : "light";
    return c.html(<ShellLayout activePath="/" theme={theme}>
        <DashboardView />
    </ShellLayout>);
}
```

This ensures the server-rendered HTML matches the client's theme preference on first paint, preventing flash-of-wrong-theme. The vanilla JS module (Section 6.7) handles runtime toggle and keeps the cookie in sync.

**Rendered HTML shape** (R-05, R-06, R-07):

```html
<html lang="en" data-theme="light">
<body>
  <div class="app">                          <!-- CSS grid: 220px | 1fr -->
    <aside class="rail">                     <!-- sticky, full height -->
      <div class="rail-brand">               <!-- wordmark top, 24px -->
        <div class="wm">
          <span class="br">[</span>autonomous-dev<span class="br">]</span>
        </div>
        <div class="meta-mono">CONTROL PLANE</div>
      </div>
      <nav class="rail-nav" aria-label="Primary">
        <!-- nav items with icons, badges -->
      </nav>
      <div class="rail-ops">                 <!-- fixed-bottom -->
        <!-- daemon status, breaker, MTD spend, kill-switch button, theme toggle -->
      </div>
    </aside>
    <main class="main">                      <!-- max-width: 1280px -->
      <div class="page-head">
        <h1>Page Title</h1>
        <div class="head-actions">
          <!-- page-level action buttons -->
        </div>
      </div>
      <!-- page content -->
    </main>
  </div>
</body>
</html>
```

**CSS classes** (sourced from `app.css` lines 64-161):

| Class | Purpose | Key properties |
|-------|---------|----------------|
| `.app` | Root grid | `grid-template-columns: 220px 1fr; min-height: 100vh` |
| `.rail` | Left sidebar | `background: var(--bg-1); border-right: 1px solid var(--line-1); sticky; height: 100vh` |
| `.rail-brand` | Wordmark area | `padding: 18px 18px 12px` |
| `.rail-brand .wm` | Wordmark text | `font-family: var(--font-mono); font-weight: 700; font-size: 16px` |
| `.rail-brand .wm .br` | Bracket accent | `color: var(--brand)` |
| `.rail-nav` | Nav links | `padding: 8px; flex: 1; gap: 1px` |
| `.rail-nav a` | Nav item | `padding: 7px 10px; border-radius: 3px; font-size: 13px` |
| `.rail-nav a.active` | Active item | `background: var(--bg-2); box-shadow: inset 2px 0 0 var(--brand)` |
| `.rail-ops` | Bottom ops bar | `border-top: 1px solid var(--line-1); padding: 12px` |
| `.main` | Content column | `padding: 28px 36px; max-width: 1280px` |
| `.main.wide` | Full-width tables | `max-width: none` |
| `.page-head` | Page title row | `display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 24px` |
| `.page-head h1` | Page title | `font-size: 28px; font-weight: 700; margin: 0` |
| `.head-actions` | Action buttons group | `display: flex; gap: var(--s-2); align-items: center` |

The `.head-actions` container sits to the right of the page title (R-06: "page-level actions in a head-actions group right of the title"). Action buttons within `.head-actions` inherit the `Btn` primitive's prop API. Page views compose actions as:

```tsx
<div class="page-head">
    <h1>Operations</h1>
    <div class="head-actions">
        <Btn kind="ghost" size="sm">Export</Btn>
        <Btn kind="primary" size="sm">Run diagnostic</Btn>
    </div>
</div>
```

### 6.2 Rail Navigation — `RailNav`

**File**: `server/components/rail-nav.tsx`

```tsx
import type { FC } from "hono/jsx";

interface NavItem {
    href: string;
    label: string;
    icon: string;
    group: "operate" | "system";
    countKey?: string;
}

const NAV_ITEMS: readonly NavItem[] = [
    { href: "/",          label: "Dashboard",  icon: "layout",   group: "operate" },
    { href: "/approvals", label: "Approvals",  icon: "inbox",    group: "operate" },
    { href: "/costs",     label: "Costs",      icon: "dollar",   group: "operate" },
    { href: "/ops",       label: "Operations", icon: "cpu",      group: "operate" },
    { href: "/settings",  label: "Settings",   icon: "sliders",  group: "system"  },
    { href: "/audit",     label: "Audit",      icon: "shield",   group: "system"  },
    { href: "/design-system", label: "Design system", icon: "layout", group: "system" },
];

interface Props {
    activePath: string;
    gateCount?: number;
}
```

The component renders two `<div class="group">` sections ("Operate" and "System") with anchor tags. Active item detection uses `activePath === item.href`. The approval nav item shows `gateCount` as a `<span class="count">` badge when non-zero.

### 6.3 Rail Ops Bar — `RailOpsBar`

**File**: `server/components/rail-ops-bar.tsx`

Renders the fixed-bottom section of the left rail:

```html
<div class="rail-ops">
  <div class="line"><span class="dot live"></span> Daemon running <span class="v">2s</span></div>
  <div class="line"><span class="dot ok"></span> Breaker OK <span class="v">0/3</span></div>
  <div class="line"><span class="dot warn"></span> MTD spend <span class="v">$1,843.00</span></div>
  <button class="kbtn" hx-get="/ops/kill-switch-modal?step=arm" hx-target="#modal-slot">
    Engage kill switch
  </button>
  <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme">
    <span class="tt-track light">
      <span class="tt-knob"></span>
      <span class="tt-l tt-light">LIGHT</span>
      <span class="tt-l tt-dark">DARK</span>
    </span>
  </button>
</div>
```

The daemon status line uses `.dot.live` when status is "running" (R-15), `.dot.warn` when "stale", `.dot.err` when "dead", `.dot.muted` when "unknown". The breaker line uses `.dot.ok` when not tripped, `.dot.err` when tripped. MTD spend uses `.dot.warn` when above 80% of monthly cap, `.dot.ok` otherwise.

The kill-switch button uses the `.kbtn` class (R-13): `border: 1px solid var(--err-line); color: var(--err)`. When engaged, the text changes to "Kill switch ENGAGED" and the button gains `background: var(--err-tint)`.

### 6.4 Brand Wordmark — `BrandWordmark`

**File**: `server/components/brand-wordmark.tsx`

```tsx
import type { FC } from "hono/jsx";

interface BrandWordmarkProps {
    /**
     * Whether to render the bracket motif around the wordmark text.
     * Default true. Set to false if OQ-02 resolves as REPLACE, or
     * controlled via PORTAL_WORDMARK_BRACKETS env var (default "1").
     */
    showBrackets?: boolean;
}

export const BrandWordmark: FC<BrandWordmarkProps> = ({
    showBrackets = (process.env["PORTAL_WORDMARK_BRACKETS"] ?? "1") === "1",
}) => (
    <div class="wm">
        {showBrackets && <span class="br">[</span>}
        {" autonomous-dev "}
        {showBrackets && <span class="br">]</span>}
    </div>
);
```

The wordmark renders inline text (not an SVG `<img>`) so that `color` and CSS variables control the theme-aware appearance:

- Light theme: brackets are `var(--brand)` (`#c8631a`), text is `var(--fg-0)` (`#1a1a17`).
- Dark theme: brackets are `var(--brand)` (`#e89255`), text is `var(--fg-0)` (`#ede9d8`).

No JS needed for theme switching -- CSS custom properties handle it. The vendored SVG files (`/static/brand/wordmark.svg`, `wordmark-dark.svg`, `mark.svg`) ship for external use (docs, screenshots) and are served as static assets.

**OQ-02 bracket fallback**: The `showBrackets` prop defaults to `true` but is gated on the `PORTAL_WORDMARK_BRACKETS` environment variable (default `"1"`). If OQ-02 resolves as REPLACE, set `PORTAL_WORDMARK_BRACKETS=0` to render "autonomous-dev" in plain mono without brackets. No code change or redeployment required -- only an env var flip.

### 6.5 Primitive Components — `primitives.tsx`

**File**: `server/components/primitives.tsx`

All seven components are pure Hono JSX function components. No hooks, no state, no side effects. The rendered HTML uses the CSS classes from `app.css` which are added to `portal.css` by this TDD.

#### 6.5.0 API Authority

The prop signatures defined in this section (SS 6.5.1 through SS 6.5.7) are the **authoritative consumer contract** for TDD-018-C surface adoption and all future portal surface work. They supersede the design kit's own prop names.

The kit served as the visual and structural reference for these components. The prop API has been rationalized for clarity and consistency within the portal's Hono JSX context. Specific renames from the kit:

| Kit prop name | TDD-035 prop name | Component | Rationale |
|---------------|-------------------|-----------|-----------|
| `kind` | `variant` | `Chip` | Avoids collision with `Btn.kind`; `variant` is semantically correct for "type of chip" |
| `n` / `value` | `value` (number) | `Score` | Standardized to `value` across all numeric primitives |
| `kind` (Chip) | `variant` | `Chip` | Distinguishes chip classification axis from button classification |

TDD-018-C surface authors must use the R-08 signatures defined here, not the kit's original prop names. The kit's prop names are not supported and will not be accepted in code review.

#### 6.5.1 `Btn`

```tsx
import type { FC } from "hono/jsx";

type BtnKind = "primary" | "secondary" | "ghost" | "destructive";
type BtnSize = "sm" | "md";

interface BtnProps {
    kind?: BtnKind;
    size?: BtnSize;
    disabled?: boolean;
    children?: unknown;
    [key: string]: unknown; // pass-through for hx-* attributes
}

export const Btn: FC<BtnProps> = ({
    kind = "secondary",
    size = "md",
    disabled = false,
    children,
    ...rest
}) => {
    const classes = ["btn"];
    if (kind !== "secondary") classes.push(kind);
    if (size === "sm") classes.push("sm");
    return (
        <button class={classes.join(" ")} disabled={disabled} {...rest}>
            {children}
        </button>
    );
};
```

**Rendered HTML**:
```html
<button class="btn primary">Approve</button>
<button class="btn ghost sm">Cancel</button>
<button class="btn destructive">Engage kill switch</button>
```

**CSS states** (R-09):

| Kind | Default | Hover | Active | Focus-visible |
|------|---------|-------|--------|---------------|
| `primary` | `background: var(--brand); color: #fff` | `background: var(--brand-hover)` | `background: var(--brand-press)` | `outline: 2px solid var(--brand); outline-offset: 2px` |
| `secondary` | `background: var(--bg-1); border: 1px solid var(--line-2)` | `background: var(--bg-2)` | `background: var(--bg-3)` | Same outline |
| `ghost` | `background: transparent; border-color: transparent` | `background: var(--bg-2)` | `background: var(--bg-3)` | Same outline |
| `destructive` | `border-color: var(--err-line); color: var(--err)` | `background: var(--err-tint)` | `background: var(--err-tint); border-color: var(--err)` | Same outline |

Size `sm`: `height: 24px; padding: 0 8px; font-size: 12px`. Default `md`: `height: 30px; padding: 0 12px; font-size: 13px`.

#### 6.5.2 `Chip`

```tsx
type ChipVariant = "status" | "phase";
type StatusTone = "ok" | "warn" | "err" | "info" | "muted" | "brand";
type PhaseName = "prd" | "tdd" | "plan" | "spec" | "code" | "review" | "deploy" | "observe";

interface ChipProps {
    variant: ChipVariant;
    tone?: StatusTone | PhaseName;
    children?: unknown;
}

export const Chip: FC<ChipProps> = ({ variant, tone, children }) => {
    if (variant === "phase" && tone) {
        return (
            <span class={`chip-phase ${tone}`}>
                {(tone as string).toUpperCase()}
            </span>
        );
    }
    return (
        <span class={`chip ${tone ?? ""}`}>
            {children}
        </span>
    );
};
```

**Rendered HTML** (R-10, R-11):
```html
<!-- Status chip -->
<span class="chip ok">RUNNING</span>
<span class="chip err">TRIPPED</span>

<!-- Phase chip -->
<span class="chip-phase code">CODE</span>
<span class="chip-phase prd">PRD</span>
```

Phase chips use the `.chip-phase` class which includes a `::before` pseudo-element rendering a 6px colored dot (R-10 dot+badge pattern). Status chips use the `.chip` class with tone modifier. Both are UPPERCASE, 11px mono, pill-shaped (R-10, R-11).

#### 6.5.3 `Dot`

```tsx
type DotTone = "ok" | "warn" | "err" | "info" | "muted";

interface DotProps {
    tone?: DotTone;
    live?: boolean;
}

export const Dot: FC<DotProps> = ({ tone = "muted", live = false }) => (
    <span class={`dot ${live ? "live" : tone}`}></span>
);
```

**Rendered HTML** (R-15):
```html
<span class="dot live"></span>    <!-- pulsing green, replaces spinners -->
<span class="dot ok"></span>
<span class="dot err"></span>
```

**CSS**: 8px circle, `border-radius: 50%`. The `.dot.live` class applies `animation: pulse 1.6s infinite` — a box-shadow ripple from `rgba(47,122,62,0.45)` to transparent over 6px. This is the canonical live-state indicator replacing all spinners (R-15).

#### 6.5.4 `Score`

```tsx
interface ScoreProps {
    value: number;   // 0..100
    threshold?: number;
    label?: string;
}

export const Score: FC<ScoreProps> = ({ value, threshold = 85, label }) => {
    const ok = value >= threshold;
    const color = ok ? "var(--ok)" : value >= threshold * 0.8 ? "var(--warn)" : "var(--err)";
    return (
        <span class="score-inline">
            {label && <span class="score-label">{label}</span>}
            <span class="score-track">
                <span
                    class="score-fill"
                    style={`width: ${value}%; background: ${color}`}
                ></span>
            </span>
            <span class="score-num meta-mono">{value}</span>
        </span>
    );
};
```

**Rendered HTML**:
```html
<span class="score-inline">
  <span class="score-label">PRD</span>
  <span class="score-track">
    <span class="score-fill" style="width: 88%; background: var(--ok)"></span>
  </span>
  <span class="score-num meta-mono">88</span>
</span>
```

The track is 80px wide, 4px tall, `var(--bg-3)` background, 999px radius. Fill inherits radius and uses `--ok` (green) when at or above threshold, `--warn` when within 80% of threshold, `--err` below.

#### 6.5.5 `CostRing`

```tsx
interface CostRingProps {
    spent: number;
    cap: number;
    label?: string;   // "TODAY" | "MONTH"
}

export const CostRing: FC<CostRingProps> = ({ spent, cap, label }) => {
    const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
    const circumference = 2 * Math.PI * 34; // r=34
    const offset = circumference - (circumference * pct) / 100;
    const color = pct >= 80 ? "var(--warn)" : "var(--brand)";

    return (
        <svg class="ring" viewBox="0 0 80 80" width="80" height="80" aria-label={`${label ?? "Cost"}: ${pct.toFixed(0)}%`}>
            <circle cx="40" cy="40" r="34" fill="none" stroke="var(--bg-3)" stroke-width="8" />
            <circle
                cx="40" cy="40" r="34" fill="none"
                stroke={color} stroke-width="8"
                stroke-dasharray={circumference.toFixed(1)}
                stroke-dashoffset={offset.toFixed(1)}
                stroke-linecap="round"
                transform="rotate(-90 40 40)"
            />
            <text x="40" y="38" text-anchor="middle"
                  font-family="var(--font-mono)" font-weight="700" font-size="14"
                  fill="var(--fg-0)">
                {pct.toFixed(0)}%
            </text>
            {label && (
                <text x="40" y="52" text-anchor="middle"
                      font-family="var(--font-mono)" font-size="9"
                      fill="var(--fg-2)">
                    {label}
                </text>
            )}
        </svg>
    );
};
```

The ring is an 80x80 SVG with two circles: a background track in `var(--bg-3)` and a foreground arc in `var(--brand)` (or `var(--warn)` above 80%). The center shows the percentage in mono 14px and the label in mono 9px.

#### 6.5.6 `Card`

```tsx
type PhaseName = "prd" | "tdd" | "plan" | "spec" | "code" | "review" | "deploy" | "observe";
type CardPadding = "sm" | "md" | "lg";

interface CardProps {
    leftBar?: PhaseName;
    padding?: CardPadding;
    children?: unknown;
}

export const Card: FC<CardProps> = ({ leftBar, padding = "md", children }) => {
    const padMap = { sm: "12px", md: "16px", lg: "24px" };
    const style = leftBar
        ? `border-left: 4px solid var(--phase-${leftBar}); padding: ${padMap[padding]}`
        : `padding: ${padMap[padding]}`;

    return (
        <div class="card" style={style}>
            {children}
        </div>
    );
};
```

**Rendered HTML** (R-12):
```html
<!-- Repo card with phase-colored left bar -->
<div class="card" style="border-left: 4px solid var(--phase-code); padding: 16px">
  ...
</div>

<!-- Generic card, no left bar -->
<div class="card" style="padding: 16px">
  ...
</div>
```

Cards: `background: var(--bg-1); border: 1px solid var(--line-1); border-radius: 3px; no shadow` (R-15a). The 4px left bar in a phase color is the system's one decorative motif (R-12).

#### 6.5.7 `KillSwitch` — Full State Machine

The KillSwitch component implements a four-state state machine for the destructive daemon-halt operation. The states are:

```
idle --> armed --> engaged --> idle (via reset)
              \-> idle (timeout / cancel)
```

**State machine definition:**

| State | Description | Transition trigger | Next state |
|-------|-------------|-------------------|------------|
| **idle** | Kill switch disengaged. Daemon processing is active. | Operator clicks "Engage kill switch" button (HTMX GET to `?step=arm`) | armed |
| **armed** | Confirmation UI visible. 30-second window. | Operator types "CONFIRM" and submits POST | engaged |
| **armed** | Confirmation UI visible. 30-second window. | armed_at timestamp exceeds 30s window, or operator navigates away | idle (implicit; server rejects stale POST) |
| **engaged** | Kill switch is engaged. Daemon processing halted. | Operator clicks "Reset kill switch" (POST to `/reset`) | idle |

**Component (presentational layer):**

```tsx
interface KillSwitchProps {
    engaged: boolean;
    onConfirm: string;   // base action URL, e.g. "/ops/kill-switch"
    armed?: boolean;      // intermediate "confirm" state
    armedAt?: string;     // ISO timestamp when armed state began
    csrfToken?: string;   // CSRF token for POST forms
}

export const KillSwitch: FC<KillSwitchProps> = ({
    engaged,
    onConfirm,
    armed = false,
    armedAt,
    csrfToken,
}) => {
    const panelClass = armed ? "ks-panel armed" : "ks-panel";
    const chipClass = engaged ? "chip err" : "chip ok";
    const chipText = engaged ? "ENGAGED" : "DISENGAGED";

    return (
        <div class={panelClass}>
            <div class="ks-status">
                <h4>
                    Kill switch{" "}
                    <span class={chipClass}>{chipText}</span>
                </h4>
                <div class="meta">
                    {engaged
                        ? "All daemon processing halted."
                        : "All daemon processing active."}
                </div>
            </div>
            <div class="ks-action">
                {!engaged && !armed && (
                    <button
                        class="btn destructive"
                        hx-get={`${onConfirm}?step=arm`}
                        hx-target="closest .ks-panel"
                        hx-swap="outerHTML"
                    >
                        Engage kill switch
                    </button>
                )}
                {armed && (
                    <form method="POST" action={onConfirm}>
                        <input type="hidden" name="_csrf" value={csrfToken ?? ""} />
                        <input type="hidden" name="armed_at" value={armedAt ?? ""} />
                        <label class="ks-confirm-label" for="ks-confirm-input">
                            Type CONFIRM to engage
                        </label>
                        <input
                            id="ks-confirm-input"
                            name="confirmation"
                            class="input mono"
                            autocomplete="off"
                            required
                            pattern="CONFIRM"
                        />
                        <button class="btn destructive" type="submit">
                            Confirm engage
                        </button>
                    </form>
                )}
                {engaged && (
                    <form method="POST" action={`${onConfirm}/reset`} style="display:inline">
                        <input type="hidden" name="_csrf" value={csrfToken ?? ""} />
                        <button class="btn" type="submit">
                            Reset kill switch
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
};
```

**Route handlers (server-side state machine):**

**GET `?step=arm` handler** -- returns the armed-state HTMX fragment:

```tsx
// In server/routes/ops-kill-switch.ts (or equivalent ops route file)

app.get("/ops/kill-switch-modal", async (c) => {
    const step = c.req.query("step");
    if (step !== "arm") {
        return c.html(<KillSwitch engaged={false} onConfirm="/ops/kill-switch" />);
    }

    // Generate armed-state fragment with timestamp and CSRF token
    const armedAt = new Date().toISOString();
    const csrfToken = c.get("csrfToken") ?? "";

    // Return HTMX fragment -- replaces the .ks-panel via outerHTML swap
    return c.html(
        <KillSwitch
            engaged={false}
            armed={true}
            armedAt={armedAt}
            csrfToken={csrfToken}
            onConfirm="/ops/kill-switch"
        />
    );
});
```

The armed-state mechanism works via HTMX swap: the GET handler returns a complete `<div class="ks-panel armed">` fragment that replaces the original panel. The fragment includes two hidden inputs: `armed_at` (ISO timestamp of when arming occurred) and `_csrf` (the session's CSRF token). No server-side "armed" session state is stored -- the timestamp in the hidden input IS the armed state, validated on POST.

**POST `/ops/kill-switch` handler** -- engages the kill switch:

```tsx
app.post("/ops/kill-switch", async (c) => {
    // (1) CSRF validation: handled by csrfMiddleware (server/security/csrf-protection.ts)
    //     which runs portal-wide via the middleware chain in server/middleware/index.ts.
    //     By the time this handler executes, CSRF is already validated.

    const body = await c.req.parseBody();
    const confirmation = body["confirmation"];
    const armedAt = body["armed_at"];

    // (2) Typed CONFIRM must match exactly (case-sensitive)
    if (typeof confirmation !== "string" || confirmation !== "CONFIRM") {
        return c.html(
            <KillSwitch
                engaged={false}
                armed={true}
                armedAt={typeof armedAt === "string" ? armedAt : ""}
                csrfToken={c.get("csrfToken") ?? ""}
                onConfirm="/ops/kill-switch"
            />,
            422,
        );
    }

    // (3) armed_at must be a valid ISO timestamp within a 30-second window
    if (typeof armedAt !== "string") {
        return c.html(errorFragment("Arming timestamp missing. Please try again."), 422);
    }
    const armedTime = new Date(armedAt).getTime();
    const now = Date.now();
    if (Number.isNaN(armedTime) || now - armedTime > 30_000) {
        // Armed state expired -- return to idle
        return c.html(
            <KillSwitch engaged={false} onConfirm="/ops/kill-switch" />,
            422,
        );
    }

    // (4) Execute daemon halt via existing OperationsHandlers
    try {
        await operationsHandlers.engageKillSwitch({
            reason: "portal-operator-manual",
        });
    } catch (err) {
        // On daemon halt failure: return error fragment + log.
        // Do NOT mark kill switch as engaged if the daemon command fails.
        logger.error("kill_switch_engage_failed", {
            error: err instanceof Error ? err.message : String(err),
            armed_at: armedAt,
        });
        return c.html(
            <div class="ks-panel armed ks-error">
                <div class="ks-status">
                    <h4>Kill switch <span class="chip err">ERROR</span></h4>
                    <div class="meta">
                        Daemon halt command failed. Kill switch was NOT engaged.
                        Check daemon logs and retry.
                    </div>
                </div>
                <div class="ks-action">
                    <button
                        class="btn destructive"
                        hx-get="/ops/kill-switch-modal?step=arm"
                        hx-target="closest .ks-panel"
                        hx-swap="outerHTML"
                    >
                        Retry
                    </button>
                </div>
            </div>,
            500,
        );
    }

    // Success -- return engaged state
    return c.html(
        <KillSwitch engaged={true} onConfirm="/ops/kill-switch" csrfToken={c.get("csrfToken") ?? ""} />
    );
});
```

**POST `/ops/kill-switch/reset` handler** -- resets the kill switch:

```tsx
app.post("/ops/kill-switch/reset", async (c) => {
    // CSRF validated by middleware (server/security/csrf-protection.ts)

    try {
        await operationsHandlers.resetKillSwitch();
    } catch (err) {
        logger.error("kill_switch_reset_failed", {
            error: err instanceof Error ? err.message : String(err),
        });
        return c.html(errorFragment("Kill switch reset failed. Check daemon logs."), 500);
    }

    return c.html(
        <KillSwitch engaged={false} onConfirm="/ops/kill-switch" csrfToken={c.get("csrfToken") ?? ""} />
    );
});
```

**CSRF enforcement**: All POST handlers are protected by the portal-wide CSRF middleware at `server/security/csrf-protection.ts`, registered via the middleware chain in `server/middleware/index.ts`. The CSRF token is injected into forms via the hidden `_csrf` input. The middleware validates the double-submit cookie pattern (token in form body + signature in httpOnly cookie) before the route handler executes. See `csrfMiddleware()` in `server/security/csrf-protection.ts` and the registration order documented in `server/middleware/index.ts` (position after auth middleware).

**POST handler validation summary:**

1. **CSRF token** -- validated by `csrfMiddleware` (portal-wide, `server/security/csrf-protection.ts`). The middleware reads `_csrf` from the form body and validates against the double-submit cookie. Failures return 403 before the handler executes.
2. **Typed CONFIRM** -- case-sensitive exact match. `confirmation !== "CONFIRM"` returns 422 with the armed panel re-rendered (allowing retry).
3. **armed_at within 30s window** -- the ISO timestamp from the hidden input is parsed; if older than 30 seconds or invalid, the panel returns to idle state with 422.
4. **Daemon halt failure** -- if `operationsHandlers.engageKillSwitch()` throws, the handler returns a 500 error fragment with a retry button. The kill switch state is NOT marked as engaged. The error is logged at ERROR level for operator investigation.

**Rendered HTML** (R-13):
```html
<!-- Idle state (disengaged) -->
<div class="ks-panel">
  <div class="ks-status">
    <h4>Kill switch <span class="chip ok">DISENGAGED</span></h4>
    <div class="meta">All daemon processing active.</div>
  </div>
  <div class="ks-action">
    <button class="btn destructive"
            hx-get="/ops/kill-switch-modal?step=arm"
            hx-target="closest .ks-panel"
            hx-swap="outerHTML">
      Engage kill switch
    </button>
  </div>
</div>

<!-- Armed state (awaiting CONFIRM, 30s window) -->
<div class="ks-panel armed">
  <div class="ks-status">
    <h4>Kill switch <span class="chip ok">DISENGAGED</span></h4>
    <div class="meta">All daemon processing active.</div>
  </div>
  <div class="ks-action">
    <form method="POST" action="/ops/kill-switch">
      <input type="hidden" name="_csrf" value="<token>" />
      <input type="hidden" name="armed_at" value="2026-05-09T20:00:00.000Z" />
      <label class="ks-confirm-label" for="ks-confirm-input">
        Type CONFIRM to engage
      </label>
      <input id="ks-confirm-input" name="confirmation" class="input mono"
             autocomplete="off" required pattern="CONFIRM" />
      <button class="btn destructive" type="submit">Confirm engage</button>
    </form>
  </div>
</div>

<!-- Engaged state -->
<div class="ks-panel">
  <div class="ks-status">
    <h4>Kill switch <span class="chip err">ENGAGED</span></h4>
    <div class="meta">All daemon processing halted.</div>
  </div>
  <div class="ks-action">
    <form method="POST" action="/ops/kill-switch/reset" style="display:inline">
      <input type="hidden" name="_csrf" value="<token>" />
      <button class="btn" type="submit">Reset kill switch</button>
    </form>
  </div>
</div>
```

The `.ks-panel.armed` class applies `border-color: var(--err-line); background: var(--err-tint)` — the `--err` palette treatment per R-13. When engaged, the chip reads `ENGAGED` in `--err` tones. The confirmation pattern (type "CONFIRM") matches the existing safety pattern in `server/templates/fragments/typed-confirm-modal.tsx` and FR-S12.

### 6.6 Table Styling (R-14)

Tables are not a component but a CSS class contract. The existing portal tables must adopt these classes:

| Class | Purpose |
|-------|---------|
| `.tbl` | Base table: `width: 100%; border-collapse: collapse; font-size: 13px` |
| `.tbl th` | Sticky header: `10px mono uppercase, border-bottom: 1px solid var(--line-2)` |
| `.tbl td` | Cell: `padding: 10px 12px; border-bottom: 1px solid var(--line-1)` |
| `.tbl tr:hover td` | Row hover: `background: var(--bg-2)` |
| `.tbl tr.active td:first-child` | Active row: `box-shadow: inset 2px 0 0 var(--brand)` |

No zebra striping. No outer card frame. Horizontal hairlines only (R-14).

### 6.7 Theme Toggle — Vanilla JS Module

**File**: `server/static/js/theme-toggle.js`

```javascript
// Theme toggle — vanilla JS, no framework.
// Reads from localStorage, writes to localStorage + cookie for SSR.
(function initTheme() {
    const stored = localStorage.getItem("portal.theme");
    if (stored === "dark" || stored === "light") {
        document.documentElement.setAttribute("data-theme", stored);
    }
    // Set cookie shadow for SSR
    document.cookie = `portal-theme=${
        document.documentElement.getAttribute("data-theme") ?? "light"
    };path=/;max-age=31536000;SameSite=Strict`;
})();

document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme") ?? "light";
        const next = current === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("portal.theme", next);
        document.cookie = `portal-theme=${next};path=/;max-age=31536000;SameSite=Strict`;
        // Update toggle track visual
        const track = btn.querySelector(".tt-track");
        if (track) {
            track.classList.remove("light", "dark");
            track.classList.add(next);
        }
    });
});
```

SSR reads the `portal-theme` cookie in the route handler and passes `theme={cookieValue}` to `ShellLayout` (see SS 6.1 theme prop wiring). The JS module runs immediately (before DOMContentLoaded) to set the attribute and prevent flash-of-wrong-theme.

### 6.8 `/design-system` Route

**File**: `server/routes/design-system.ts`

```typescript
import type { Context } from "hono";
import { DesignSystemPage } from "../templates/views/design-system";

export function designSystemHandler(c: Context): Response {
    return c.html(<DesignSystemPage />);
}
```

**File**: `server/templates/views/design-system.tsx`

The page renders all 20 preview card groups as sections. Each section is implemented as a Hono JSX component that uses the portal's own primitives (not raw HTML from the preview files). This ensures the regression surface exercises the actual component implementations.

**Preview card sections** (20 total, matching `preview/` directory):

| # | Section | Content | Primitives exercised |
|---|---------|---------|----------------------|
| 1 | Type display | Font specimens at 28/20/15/13/12/11px | None (typography only) |
| 2 | Type body | Body text, mono specimens, numerics | None |
| 3 | Colors neutrals | Swatch grid: bg-0 through fg-3 | None |
| 4 | Colors brand | Brand amber swatches + tint/line companions | None |
| 5 | Colors semantic | ok/warn/err/info/muted swatches | `Chip` (status) |
| 6 | Colors phases | 8 phase color swatches | `Chip` (phase) |
| 7 | Spacing and radii | Spacing scale visualization | None |
| 8 | Elevation | Hairline vs shadow demonstration | `Card` |
| 9 | Buttons | All 4 kinds x 2 sizes | `Btn` |
| 10 | Status chips | ok/warn/err/info/muted/brand chips | `Chip` |
| 11 | Phase chips | All 8 phase chips in a row | `Chip` (phase) |
| 12 | Dots | All 5 tones + live | `Dot` |
| 13 | Scores | Score bars at various thresholds | `Score` |
| 14 | Cost ring | Daily + monthly ring examples | `CostRing` |
| 15 | Inputs | Text, select, error state, mono variant | None (CSS only) |
| 16 | Repo card | Normal + attention state | `Card`, `Chip` |
| 17 | Kill switch | Disengaged + tripped states | `KillSwitch`, `Chip` |
| 18 | Cost panel | Budget breakdown with ring | `CostRing` |
| 19 | Timeline | Phase timeline with dots | `Dot`, `Chip` |
| 20 | Brand wordmark | Light + dark wordmark specimens | `BrandWordmark` |

Each section wraps its content in a `<section id="preview-{n}" class="ds-card">` element. The page includes a sticky sidebar table-of-contents linking to each section by anchor.

**Route registration** — `server/routes/index.ts` updated:

```typescript
import { designSystemHandler } from "./design-system";
// ... in registerRoutes():
app.get("/design-system", designSystemHandler);
```

---

## 7. Scalability Analysis

This TDD introduces no new data paths, no new SSE subscriptions, and no new file watchers. The primitives are stateless server-rendered functions — they scale linearly with page render count, which is bounded by the single-operator model (PRD-009 NFR-03).

The `/design-system` page is the largest new page (20 sections), but it is entirely static content with no data dependencies. Render time is bounded by template compilation, which Hono caches.

The shell's ops bar reads daemon status, kill-switch state, and MTD spend. These values are already aggregated by existing readers (`HeartbeatReader`, `StateReader`, `CostReader`). No additional file reads are introduced.

---

## 8. Security Considerations

**CSP compliance**: The vanilla JS theme-toggle module is loaded via `<script type="module" src="/static/js/theme-toggle.js" nonce="...">`. The `nonce` attribute satisfies the existing `script-src 'self' 'nonce-<value>'` policy. No inline scripts are introduced.

**No `dangerouslySetInnerHTML`**: The `/design-system` page re-implements preview cards as JSX components rather than injecting raw HTML. This preserves FR-S34.

**Kill-switch confirmation**: The `KillSwitch` component uses a typed-CONFIRM pattern (FR-S12). The POST form action is protected by the portal-wide CSRF middleware (`server/security/csrf-protection.ts`), which validates a double-submit cookie pattern on all POST/PUT/DELETE/PATCH requests. The armed_at 30-second window prevents stale confirmation replay. See SS 6.5.7 for full validation chain.

**Brand asset serving**: SVG files in `/static/brand/` are served with `Content-Type: image/svg+xml` and inherit the existing CSP `img-src 'self'` policy. No inline SVG injection risk — the wordmark is rendered as text spans, not as an SVG element injected from an external source.

---

## 9. Observability Plan

This TDD adds no new services or data paths, so the observability additions are minimal:

### Structured Logs

| Event | Level | Fields |
|-------|-------|--------|
| `design_system_page_rendered` | INFO | `{ duration_ms }` |
| `shell_layout_rendered` | DEBUG | `{ activePath, daemonStatus }` |
| `kill_switch_engage_failed` | ERROR | `{ error, armed_at }` |
| `kill_switch_reset_failed` | ERROR | `{ error }` |

### Existing Metrics (reused)

The portal's existing `portal_http_request_duration_seconds` histogram (from TDD-013) captures `/design-system` page load time automatically via the timing middleware.

---

## 10. Test Plan

### 10.1 Unit Tests — Primitives

Each primitive component is tested with Hono's JSX rendering in isolation:

| Test | Assertion |
|------|-----------|
| `Btn` renders correct class for each `kind` | `btn primary`, `btn ghost`, `btn destructive`, `btn` (secondary) |
| `Btn` `sm` size renders `.sm` class | Class list includes `sm` |
| `Btn` `disabled` renders `disabled` attribute | Attribute present |
| `Chip` status variant renders `.chip.{tone}` | Class matches tone |
| `Chip` phase variant renders `.chip-phase.{phase}` with UPPERCASE text | Text content is uppercase |
| `Dot` live renders `.dot.live` | Class present |
| `Dot` tone renders `.dot.{tone}` | Class matches tone |
| `Score` above threshold uses `--ok` color | Inline style contains `var(--ok)` |
| `Score` below threshold uses `--warn` or `--err` | Inline style contains `var(--warn)` or `var(--err)` |
| `CostRing` computes correct arc offset | `stroke-dashoffset` matches expected value for spent/cap ratio |
| `CostRing` uses `--warn` above 80% | Stroke color is `var(--warn)` |
| `Card` with `leftBar` renders 4px left border | Inline style includes `border-left: 4px solid var(--phase-...)` |
| `Card` without `leftBar` has no left bar | No `border-left` in style |
| `KillSwitch` disengaged shows DISENGAGED chip | Contains `.chip.ok` with text `DISENGAGED` |
| `KillSwitch` engaged shows ENGAGED chip | Contains `.chip.err` with text `ENGAGED` |
| `KillSwitch` armed shows CONFIRM input + hidden armed_at | Contains `<input name="armed_at">` and `<input name="confirmation">` with `pattern="CONFIRM"` |
| `KillSwitch` armed includes CSRF hidden input | Contains `<input type="hidden" name="_csrf">` |
| `BrandWordmark` with `showBrackets=true` renders brackets | Contains `.br` spans with `[` and `]` |
| `BrandWordmark` with `showBrackets=false` renders without brackets | No `.br` spans present |

### 10.2 Shell Layout Tests

| Test | Assertion |
|------|-----------|
| `ShellLayout` renders `.app` grid with `.rail` and `.main` | Both elements present |
| `ShellLayout` renders wordmark with bracket spans | `.wm .br` elements present |
| `ShellLayout` renders nav items with correct active state | `aria-current="page"` on active item |
| `ShellLayout` includes `design-tokens.css` link | `<link>` element present |
| `ShellLayout` includes theme-toggle script with nonce | `<script>` with correct `nonce` attribute |
| `ShellLayout` renders ops bar with daemon status | `.rail-ops .dot` element with correct class |
| `ShellLayout` with `theme="dark"` renders `data-theme="dark"` on `<html>` | Attribute value is `"dark"` |
| `ShellLayout` with default theme renders `data-theme="light"` on `<html>` | Attribute value is `"light"` |

### 10.3 M-02: Phase Contrast Verification (WCAG + Peer-Chip Split)

This is a critical metric split per PRD reviewer note N-01. Two distinct checks:

**Check A: WCAG 2.1 SC 1.4.11 non-text contrast (each phase color vs `--bg-0`)**

For each of the 8 phase colors in both light and dark themes, compute the WCAG relative luminance contrast ratio against `--bg-0`. Assert >= 3:1.

| Phase | Light `--phase-*` | Light `--bg-0` | Dark `--phase-*` | Dark `--bg-0` |
|-------|-------------------|----------------|-------------------|---------------|
| prd | `#6b4ea8` | `#fafaf7` | `#a48bd9` | `#14130f` |
| tdd | `#2f6f8f` | `#fafaf7` | `#6fa8c7` | `#14130f` |
| plan | `#1d7a5f` | `#fafaf7` | `#66b896` | `#14130f` |
| spec | `#6b6a1a` | `#fafaf7` | `#b5b250` | `#14130f` |
| code | `#c8631a` | `#fafaf7` | `#e89255` | `#14130f` |
| review | `#8a4d1b` | `#fafaf7` | `#c98a55` | `#14130f` |
| deploy | `#2f7a3e` | `#fafaf7` | `#98c39a` | `#14130f` |
| observe | `#5a5a5a` | `#fafaf7` | `#9a978a` | `#14130f` |

**Check B: Peer-chip contrast (between any two adjacent phase colors)**

This is a separate, non-WCAG check. When phase chips appear side-by-side (e.g., in a timeline), any two adjacent phases must be visually distinguishable. Compute the contrast ratio between every pair of adjacent phases in the canonical order (prd, tdd, plan, spec, code, review, deploy, observe). Assert >= 3:1 for each pair.

Note: this peer-chip check is intentionally distinct from Check A. Check A is WCAG compliance. Check B is a product-specific design quality gate. Both checks run in CI via `scripts/check-phase-contrast.ts` as established by TDD-034 SS 5.10. TDD-034 SS 5.10 commits to delivering this script, which implements both WCAG SC 1.4.11 per-phase-vs-bg0 checks and the adjacent-pair "design quality" checks. This TDD consumes the script's output as part of the M-02 acceptance gate. This TDD's responsibility is to ensure the components use the correct `--phase-*` token variables so the contrast script can verify them.

### 10.4 M-03: Visual Regression on `/design-system`

**Framework**: Playwright (consistent with PRD-009 section 13.6).

**Golden image generation and storage**:

- Golden images are generated locally via `npm run gen:visual-goldens`, which runs `UPDATE_GOLDEN=1 npx playwright test tests/visual/design-system.spec.ts --project=golden-gen`.
- The canonical generation environment is macOS (the development platform) or the CI Docker image `mcr.microsoft.com/playwright:v1.40.0-jammy`. Both environments produce identical renders because the test uses a fixed viewport (1440x900) and the portal fonts are system-stack (`-apple-system, BlinkMacSystemFont, "Segoe UI"`) with a fallback to `sans-serif`, and the CI image provides consistent font rendering.
- Binary `.png` files are committed to `tests/visual-regression/goldens/`. If the total golden directory size exceeds 500KB, files are tracked via `git lfs`. Below 500KB, they are committed inline (standard git blob storage).
- Goldens include one full-page screenshot (`design-system-full.png`) and 20 per-card screenshots (`design-system-card-{01..20}.png`).

**CI execution**:

- CI runs visual regression as a separate job (not in the Jest unit test suite). The job uses the Docker image `mcr.microsoft.com/playwright:v1.40.0-jammy` to eliminate cross-OS render diffs.
- Steps: (1) Start the portal server in test mode (`PORT=19281 NODE_ENV=test`). (2) Run `npx playwright test tests/visual/design-system.spec.ts`. (3) On failure, upload the diff image as a CI artifact for reviewer inspection.
- **Missing goldens behavior**: On first run or when golden files are absent, CI fails with exit code 1 and the message: `GOLDEN_MISSING: No golden image found at tests/visual-regression/goldens/<name>.png. Run "npm run gen:visual-goldens" locally and commit the generated files.` There is no auto-generation in CI -- this prevents silent regressions from being introduced when a developer adds a new card section without generating its golden.

**Threshold**: Pixel diff tolerance of 0.1% (accounts for sub-pixel rendering differences). Any diff above this threshold fails the check.

**Golden image update workflow**: When primitives change intentionally, the developer runs `npm run gen:visual-goldens` to regenerate golden images and commits them alongside the code change. The PR diff shows the binary golden changes for reviewer inspection.

### 10.5 Integration Tests

| Test | Scope |
|------|-------|
| GET `/design-system` returns 200 with HTML containing all 20 `ds-card` sections | Route registration + view rendering |
| GET `/design-system` response includes CSP headers | Security middleware integration |
| GET `/` renders ShellLayout (not old BaseLayout) after migration | Shell adoption |
| Static asset `/static/brand/mark.svg` returns 200 with `image/svg+xml` | Brand asset serving |
| Static asset `/static/js/theme-toggle.js` returns 200 with `application/javascript` | JS module serving |
| POST `/ops/kill-switch` with valid CONFIRM + valid armed_at engages kill switch | KillSwitch happy path |
| POST `/ops/kill-switch` with expired armed_at returns 422 + idle fragment | KillSwitch timeout enforcement |
| POST `/ops/kill-switch` with wrong confirmation string returns 422 + armed fragment | KillSwitch confirmation validation |
| POST `/ops/kill-switch` without CSRF token returns 403 | CSRF middleware enforcement |

---

## 11. Migration and Rollout Plan

### Phase 1: Primitives (no surface impact)

**Deliverables**: `server/components/primitives.tsx` with all 7 components + unit tests.

**Risk**: Zero. No existing page imports these components yet. They are additive-only.

**Steps**:
1. Create `server/components/` directory.
2. Implement `primitives.tsx` with all 7 components.
3. Implement unit tests.
4. PR review and merge.

### Phase 2: Shell layout + brand assets

**Deliverables**: `ShellLayout`, `RailNav`, `RailOpsBar`, `BrandWordmark`, theme-toggle JS module, vendored brand SVGs.

**Risk**: Medium. Replacing `BaseLayout` with `ShellLayout` affects every page. The migration must be atomic — all views must switch to `ShellLayout` in a single commit to avoid a half-migrated state.

**Steps**:
1. Implement shell components.
2. Vendor brand assets to `server/static/brand/` (gated on OQ-02).
3. Implement theme-toggle JS module.
4. Update all 10 existing view files to import `ShellLayout` instead of `BaseLayout`.
5. Update `Navigation` references to `RailNav`.
6. Wire theme prop: update each route handler to read `portal-theme` cookie and pass `theme={cookieValue}` to `ShellLayout`.
7. Update shell tests.
8. Mark `BaseLayout` and `Navigation` as deprecated (keep for one release cycle, then remove).
9. PR review and merge.

**Rollback**: If the shell causes issues, revert the single commit that switches view imports. `BaseLayout` remains in the codebase as deprecated.

### Phase 3: `/design-system` page + visual regression

**Deliverables**: Route handler, view template, Playwright visual regression test, golden images.

**Steps**:
1. Implement `design-system.ts` route handler.
2. Implement `design-system.tsx` view with all 20 preview card sections.
3. Register route in `routes/index.ts`.
4. Add nav item to `RailNav`.
5. Generate initial golden images via `npm run gen:visual-goldens`.
6. Commit goldens to `tests/visual-regression/goldens/` (with git lfs if >500KB total).
7. Implement Playwright visual regression test.
8. PR review and merge.

### CSS Migration Strategy

The new CSS classes (`.app`, `.rail`, `.rail-brand`, `.rail-nav`, `.rail-ops`, `.main`, `.btn`, `.chip`, `.chip-phase`, `.dot`, `.card`, `.tbl`, `.ks-panel`, `.score-inline`, `.ring`, `.theme-toggle`, `.tt-*`, `.page-head`, `.head-actions`) are added to `portal.css`. They do not conflict with existing class names because the current portal uses different naming conventions (the existing classes are more verbose — `nav-item`, `status-badge`, etc.).

Existing classes are not removed in this TDD. They are deprecated and cleaned up in TDD-018-C when the surfaces adopt the new components.

---

## 12. Risks and Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **OQ-02 (wordmark IP) blocks brand asset integration.** The bracket motif is original to the design bundle and has no upstream blessing. If OQ-02 resolves as REPLACE, the wordmark SVGs and inline text rendering must be updated. | Medium | Low | The wordmark is isolated in `BrandWordmark` component with a `showBrackets` prop gated on `PORTAL_WORDMARK_BRACKETS` env var. If OQ-02 resolves as REPLACE, set the env var to `0` -- no code change needed. See SS 6.4. |
| **Shell migration breaks existing page layouts.** Switching from top-bar to left-rail changes the document flow for all 10 pages. | Medium | Medium | Phase 2 is a single atomic commit. All views switch simultaneously. The old `BaseLayout` is retained as deprecated for rollback. Integration tests verify each page renders without errors. |
| **Peer-chip contrast (M-02 Check B) fails for some adjacent phases.** The 8 phase colors were designed for individual legibility, not necessarily pairwise distinctness. | Medium | Low | The contrast script reports which pairs fail. The fix is token adjustment in `design-tokens.css` (TDD-034 scope). This TDD's responsibility is to ensure components use the correct tokens so the script can verify them. |
| **`app.css` size bloat.** Porting the full kit CSS adds approximately 400 lines to `portal.css`. | Low | Low | The CSS is organized by component and well-commented. Tree-shaking is not needed for server-rendered CSS served from disk. The portal already serves HTMX (44KB minified) as a single file. |
| **PRD-018 section 4.5 assertion is not fully "pattern-light."** Pre-flight check results below. | Low | Low | See Risks section 12.1. |

### 12.1 Pre-Flight Hooks Validation (PRD-018 Section 4.5 / Reviewer Note N-02)

**Primitives.jsx** (this TDD's scope): `useState` is destructured at line 2 but **never invoked** in any primitive function. The primitives are pure render functions with zero hooks. **Assertion confirmed: Primitives.jsx is pattern-light and fully compatible with Hono JSX server-side rendering.**

**Prop API fidelity note**: The kit's React component prop names differ from the prop APIs defined in this TDD's SS 6.5. The TDD's R-08 prop signatures are the authoritative consumer contract and supersede the kit's own prop names. The kit was the visual and structural reference; the prop API is rationalized here for clarity (e.g., `kind` to `variant` on Chip, `n` to `value` on Score). See SS 6.5.0 for the full mapping. TDD-018-C surface authors must use the R-08 signatures defined in SS 6.5, not the kit's original props.

**Shell.jsx** (this TDD's scope): Uses `React.useState` once — for theme toggle state. The Hono JSX port replaces this with a vanilla JS module (Section 6.7). No other hooks. **Compatible.**

**Settings.jsx** (TDD-018-C scope, not this TDD): Uses `useState` (8 instances) and `useEffect` (1 instance — tab synchronization). The `useEffect` is a simple `setTab(initialTab)` on prop change, which translates to a server-render-time default in Hono JSX (no client-side equivalent needed). **Low risk for TDD-018-C, but flagged for that TDD's author.**

**Other kit files** (TDD-018-C scope): `RequestDetail.jsx` uses `useState` (4 instances, all UI state for tabs/accordions/toast), `App.jsx` uses `useState` (3 instances, routing state which the server already handles). No `useEffect`, `useContext`, `useReducer`, custom hooks, or context providers found anywhere in the kit. **PRD-018 section 4.5 assertion is validated across the full kit.**

### Open Questions

| ID | Question | Owner | Status |
|----|----------|-------|--------|
| OQ-02 | Wordmark bracket motif IP clearance. Blocks brand asset vendoring. TDD proceeds assuming APPROVE; fallback is `PORTAL_WORDMARK_BRACKETS=0` env var (see SS 6.4). | Patrick Watson | OPEN (inherited from PRD-018) |
| OQ-035-01 | Should the `/design-system` page be gated behind authentication in network-accessible mode? | TDD author | RESOLVED -- treat as public. The `/design-system` route serves only static component specimens with no operational data. Operator-only routes are already gated at the portal level by auth middleware. Adding a separate auth gate for a reference page adds operational complexity with no security benefit. |
| OQ-035-02 | The existing `Navigation` fragment imports `DaemonStatusPill`. The new `RailOpsBar` replaces its function. Should `DaemonStatusPill` be deprecated in this TDD or in TDD-018-C? | TDD author | RESOLVED — deprecate in this TDD (Phase 2). The ops bar subsumes its function entirely. |

---

## 13. Work Breakdown

| Task | Estimate | Dependencies | Phase |
|------|----------|--------------|-------|
| Create `server/components/` directory structure | 0.5h | None | 1 |
| Implement `primitives.tsx` — all 7 components | 3h | None | 1 |
| Unit tests for all 7 primitives | 2h | primitives.tsx | 1 |
| Implement `shell.tsx` (ShellLayout with theme prop) | 2h | None | 2 |
| Implement `rail-nav.tsx` | 1h | None | 2 |
| Implement `rail-ops-bar.tsx` | 1.5h | primitives.tsx (uses Dot) | 2 |
| Implement `brand-wordmark.tsx` (with showBrackets prop) | 0.5h | OQ-02 | 2 |
| Implement `theme-toggle.js` vanilla JS module | 1h | None | 2 |
| Vendor brand SVGs to `server/static/brand/` | 0.5h | OQ-02 | 2 |
| Add shell + primitive CSS to `portal.css` (including `.page-head`, `.head-actions`) | 2h | TDD-034 (tokens) | 2 |
| Wire theme prop in all route handlers (read portal-theme cookie) | 1h | shell.tsx | 2 |
| Migrate all 10 views from BaseLayout to ShellLayout | 2h | shell.tsx | 2 |
| Shell integration tests | 1.5h | shell migration | 2 |
| Implement `design-system.tsx` view (20 sections) | 4h | primitives.tsx | 3 |
| Implement `design-system.ts` route handler | 0.5h | design-system.tsx | 3 |
| Register route in `routes/index.ts` | 0.25h | design-system.ts | 3 |
| Playwright visual regression test setup + golden gen script | 2.5h | design-system route | 3 |
| Generate golden images + configure git lfs if needed | 0.5h | visual regression setup | 3 |
| Phase contrast validation (verify components use correct tokens) | 1h | primitives.tsx | 3 |
| KillSwitch route handlers (arm/engage/reset with CSRF + armed_at validation) | 2h | primitives.tsx, csrf-protection.ts | 2 |
| KillSwitch integration tests (happy path, timeout, CSRF) | 1.5h | kill-switch routes | 2 |
| Document `PORTAL_WORDMARK_BRACKETS` env var in deployment config | 0.25h | brand-wordmark.tsx | 2 |
| **Total** | **~31h** | | |

### Environment Variables Introduced

| Variable | Default | Purpose | Section |
|----------|---------|---------|---------|
| `PORTAL_WORDMARK_BRACKETS` | `"1"` | Controls bracket motif visibility in BrandWordmark. Set to `"0"` if OQ-02 resolves as REPLACE. | SS 6.4 |

---

## 14. PRD Requirements Traceability

| PRD Requirement | TDD Section | Coverage |
|----------------|-------------|----------|
| R-05: Persistent left rail 220px, brand wordmark, section nav, fixed-bottom ops bar | Section 6.1, 6.2, 6.3, 6.4 | Full |
| R-06: No top header, page title as h1 28px, head-actions group | Section 6.1 (`.page-head`, `.head-actions` CSS rules and layout documentation) | Full |
| R-07: Content column max-width 1280px, tables full-width | Section 6.1 (`.main` / `.main.wide`) | Full |
| R-08: 7 primitive components with specified prop APIs | Section 6.5 (all subsections). Full (API rationalized vs. kit; see SS 6.5.0 for prop name mapping and authority statement) | Full |
| R-09: Button kinds (primary/secondary/ghost/destructive) with hover/active/focus-visible states | Section 6.5.1 | Full |
| R-10: Status communication via dot + UPPERCASE word badge, no emoji | Section 6.5.2, 6.5.3 | Full |
| R-11: Phase chips UPPERCASE on `--phase-*` background | Section 6.5.2 | Full |
| R-12: Repo card 4px left bar in `--phase-<active-phase>` | Section 6.5.6 | Full |
| R-13: KillSwitch distinct from other buttons, `--err` palette, CONFIRM pattern | Section 6.5.7 (full state machine: idle/armed/engaged/reset, CSRF, armed_at window, daemon failure handling) | Full |
| R-14: Tables hairline-only, sticky headers, hover-row, active-row left bar | Section 6.6 | Full |
| R-15: Pulsing `.dot.live` replaces all spinners | Section 6.5.3 | Full |
| R-15a: Hairline elevation — 1px border, 3px radius, no shadow on cards; `--shadow-*` only | Section 6.5.6, 6.6 | Full |
| R-21: `/design-system` route with 20 preview cards | Section 6.8 | Full |
| G-03: Brand mark + wordmark integration | Section 6.4 (with `showBrackets` prop and `PORTAL_WORDMARK_BRACKETS` env var fallback) | Full (gated on OQ-02) |
| M-02: Phase contrast WCAG + peer-chip (split per N-01) | Section 10.3 (consumes `scripts/check-phase-contrast.ts` as established by TDD-034 SS 5.10) | Full |
| M-03: Visual regression on `/design-system` for all 20 cards | Section 10.4 (golden generation, CI bootstrapping, missing-golden failure mode) | Full |

---

## 15. Appendix: CSS Class Inventory

Complete list of CSS classes introduced by this TDD, sourced from `app.css` in the design bundle and adapted for `portal.css`:

**Shell**: `.app`, `.rail`, `.rail-brand`, `.rail-brand .wm`, `.rail-brand .wm .br`, `.rail-brand .meta-mono`, `.rail-nav`, `.rail-nav .group`, `.rail-nav a`, `.rail-nav a.active`, `.rail-nav a .count`, `.rail-nav a .ic`, `.rail-ops`, `.rail-ops .line`, `.rail-ops .line .v`, `.rail-ops .kbtn`, `.theme-toggle`, `.tt-track`, `.tt-knob`, `.tt-l`, `.tt-light`, `.tt-dark`, `.main`, `.main.wide`, `.page-head`, `.page-head h1`, `.page-head .sub`, `.page-meta`, `.head-actions`

**Primitives**: `.btn`, `.btn.primary`, `.btn.ghost`, `.btn.destructive`, `.btn.sm`, `.chip`, `.chip.ok`, `.chip.warn`, `.chip.err`, `.chip.info`, `.chip.brand`, `.chip-phase`, `.chip-phase.{prd,tdd,plan,spec,code,review,deploy,observe}`, `.dot`, `.dot.ok`, `.dot.warn`, `.dot.err`, `.dot.info`, `.dot.live`, `.score-inline`, `.score-track`, `.score-fill`, `.score-num`, `.score-label`, `.ring`, `.card`, `.card-h`, `.card-b`, `.ks-panel`, `.ks-panel.armed`, `.ks-panel.ks-error`, `.ks-status`, `.ks-action`, `.ks-confirm-label`

**Tables**: `.tbl`, `.tbl th`, `.tbl td`, `.tbl td.mono`, `.tbl td.num`, `.tbl td.title`, `.tbl tr.active`

**Design system page**: `.ds-card`, `.ds-toc`, `.ds-swatch`, `.ds-swatch-grid`

**Animations**: `@keyframes pulse`
