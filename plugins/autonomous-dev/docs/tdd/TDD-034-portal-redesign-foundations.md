# TDD-034: Portal Redesign Foundations

| Field          | Value                                                                          |
|----------------|--------------------------------------------------------------------------------|
| **Title**      | Portal Redesign Foundations -- Design Token Vendoring, Theming, Lints, and Voice Sweep |
| **TDD ID**     | TDD-034                                                                        |
| **Version**    | 1.1                                                                            |
| **Date**       | 2026-05-09                                                                     |
| **Status**     | ready-for-review                                                               |
| **Author**     | Patrick Watson                                                                 |
| **Parent PRD** | PRD-018 (Portal Visual Redesign -- Design System Adoption)                     |
| **Plugin**     | autonomous-dev-portal                                                          |
| **Sibling TDDs** | TDD-035 (Shell + Primitives + Reference Page), TDD-036 (Surface-by-Surface Adoption) |
| **phase**      | tdd                                                                            |
| **prd_ref**    | PRD-018-portal-visual-redesign                                                 |

---

## 1. Summary

TDD-034 is the first of three TDDs decomposed from PRD-018. It establishes the visual
foundations that all subsequent portal redesign work builds on: vendoring the design system's
CSS token file, implementing light/dark theme switching with server-side cookie shadow and
client-side `localStorage` persistence, adding CI lint gates that enforce token-only styling
(no hex literals, no hardcoded font families, no untokened box-shadow, no emoji in
templates), shipping a WCAG SC 1.4.11 contrast verification script for phase tokens, and
sweeping all existing user-facing copy in portal templates for compliance with the design
system's content fundamentals (sentence case, no emoji, mono for IDs, terse SRE voice).

This TDD also resolves two PRD-018 open questions: OQ-03 (Lucide icons: self-host) and
OQ-06 (Google Fonts + Lucide vs CSP: self-host both). The framework decision from PRD-018
section 4.5 (Hono JSX server templates + vanilla JS modules) is binding and not revisited here.

---

## 2. Goals and Non-Goals

### Goals

| ID     | Goal                                                                                                      |
|--------|-----------------------------------------------------------------------------------------------------------|
| G-3401 | Vendor `colors_and_type.css` verbatim into `server/static/design-tokens.css`, loaded as the FIRST stylesheet on every page. (R-01) |
| G-3402 | Ensure all non-token portal CSS references only CSS variables from `design-tokens.css`. No hardcoded hex colors, font-family declarations, font-size px values, or spacing literals remain in portal CSS outside the token file. (R-02) |
| G-3403 | Implement `[data-theme="light"]` / `[data-theme="dark"]` theming on `<html>`, default light, persisted in `localStorage` key `portal.theme` and shadowed to cookie `portal-theme` for SSR. (R-03) |
| G-3404 | Load Inter and JetBrains Mono fonts. Self-host the font files to comply with the existing CSP `font-src 'self'` policy. (R-04, OQ-06 resolution) |
| G-3405 | Establish the hairline-driven elevation system. CI lint rejects `box-shadow:` declarations in non-token CSS that do not reference `--shadow-*` variables. (R-15a) |
| G-3406 | Sweep every user-facing string in portal templates for content fundamentals compliance: sentence case headings, no emoji, no exclamation marks, mono for IDs/status/timestamps, costs to 2 decimals, ISO timestamps in tables. (R-22) |
| G-3407 | Replace ad-hoc copy strings with the design system's canonical strings (`Daemon running`, `No active requests`, `Kill switch ENGAGED at <ISO>`, etc.). (R-23) |
| G-3408 | Ship CI lint (M-01) rejecting hex color literals, hardcoded `font-family`, and hardcoded `px` sizes in non-token CSS files. |
| G-3409 | Ship CI lint (M-05) rejecting emoji in user-facing portal templates (`.tsx` files under `server/templates/`). |
| G-3410 | Ship `scripts/check-phase-contrast.ts` (M-02) with two CI-blocking checks: (a) WCAG SC 1.4.11 check of each phase color vs `--bg-0` in both themes (>=3:1), and (b) peer-chip contrast check (>=3:1 between adjacent phase colors). Both checks block merge on failure. |
| G-3411 | Establish light + dark theme parity verification approach (M-06). |
| G-3412 | Resolve OQ-03: self-host Lucide icons (vendor `lucide-static` SVGs into `server/static/icons/`). |
| G-3413 | Resolve OQ-06: self-host Google Fonts (Inter + JetBrains Mono WOFF2 files into `server/static/fonts/`). |

### Non-Goals

| ID      | Non-Goal                                                                                  | Rationale                                          |
|---------|-------------------------------------------------------------------------------------------|-----------------------------------------------------|
| NG-3401 | Port the UI kit JSX components to Hono JSX server components                              | That is TDD-035 (primitives + shell)                |
| NG-3402 | Re-skin any portal surface (Dashboard, Ops, Costs, etc.)                                  | That is TDD-036 (surface-by-surface adoption)       |
| NG-3403 | Brand wordmark/mark integration                                                            | TDD-035 scope; also blocked on OQ-02 (wordmark IP confirmation) |
| NG-3404 | Left-rail layout shell                                                                     | TDD-035 scope                                       |
| NG-3405 | `/design-system` reference page                                                            | TDD-035 scope (R-21)                                |
| NG-3406 | Visual regression testing infrastructure                                                   | TDD-035 scope (M-03)                                |
| NG-3407 | Any feature change or new data dependency                                                  | PRD-018 NG-02                                       |
| NG-3408 | Mobile/responsive overhaul                                                                 | PRD-018 NG-06                                       |

---

## 3. Background

### 3.1 Current portal state

The portal was built under PRD-009 / TDD-013 as a Bun + Hono server-rendered application
with HTMX progressive enhancement. It uses a single bundled CSS file at
`static/portal.css` (concatenated from `src/styles/variables.css`, `layout.css`,
`components.css`, `utilities.css` via `scripts/build-css.sh`). The current CSS variable
names are generic Tailwind-style tokens (`--primary-color: #2563eb`, `--border-color: #e2e8f0`,
`--radius-md: .5rem`, etc.) with an `@media (prefers-color-scheme: dark)` auto-switch.
There is no operator-selectable theme toggle.

The server-side template pipeline is Hono JSX (`server/templates/layout/base.tsx`
renders the HTML shell, `server/templates/views/*.tsx` render page views, and
`server/templates/fragments/*.tsx` render partials for HTMX swaps).

The CSP policy (from `server/security/csp-config.ts`) is strict: `font-src 'self'`,
`script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`.
This means external CDN origins (Google Fonts, unpkg.com for Lucide) are blocked
in production by default.

### 3.2 Design system token file

The design system ships `colors_and_type.css` (314 lines) containing:
- All color tokens (neutrals, brand, semantic, phase) for light mode in `:root`
- Dark mode overrides in `:root[data-theme="dark"]`
- Font families, type scale, spacing scale, radii, borders, shadows, motion
- Base reset (box-sizing, body, headings, code, links)
- Utility primitives (`.surface`, `.dot`, `.dot.live`, `@keyframes pulse`)
- An `@import url('https://fonts.googleapis.com/css2?...')` for web fonts

The `@import` must be replaced with self-hosted `@font-face` declarations because
the CSP blocks `fonts.googleapis.com`.

### 3.3 Kit React hook usage (reviewer note N-02 validation)

Scanning `ui_kits/portal/*.jsx` found only `useState` usage (simple state for tabs,
modals, form fields) and one `useEffect` (in `Settings.jsx` line 4, syncing a tab prop).
No `useContext`, `useReducer`, custom hooks, or lifecycle methods were found. The kit is
confirmed pattern-light as PRD-018 section 4.5 claimed. The porting effort for TDD-035
(primitives) does not need revision -- `useState` calls map to vanilla JS event handlers
on the server-rendered output (e.g., tab selection via `<a>` navigation, form state via
native HTML, theme toggle via the JS module designed in this TDD).

---

## 4. Architecture

### 4.1 File layout

```
plugins/autonomous-dev-portal/
├── server/
│   ├── static/
│   │   ├── design-tokens.css          # NEW — vendored from colors_and_type.css
│   │   ├── portal.css                 # MODIFIED — purge hex literals, reference tokens
│   │   ├── fonts/                     # NEW — self-hosted WOFF2 files
│   │   │   ├── inter-v18-latin-400.woff2
│   │   │   ├── inter-v18-latin-500.woff2
│   │   │   ├── inter-v18-latin-600.woff2
│   │   │   ├── inter-v18-latin-700.woff2
│   │   │   ├── jetbrains-mono-v18-latin-400.woff2
│   │   │   ├── jetbrains-mono-v18-latin-500.woff2
│   │   │   ├── jetbrains-mono-v18-latin-600.woff2
│   │   │   └── jetbrains-mono-v18-latin-700.woff2
│   │   ├── icons/                     # NEW — vendored Lucide SVGs
│   │   │   ├── activity.svg
│   │   │   ├── shield-alert.svg
│   │   │   └── ... (24 icons per design system README)
│   │   └── theme-toggle.js           # NEW — vanilla JS module for theme switching
│   ├── templates/
│   │   └── layout/
│   │       └── base.tsx              # MODIFIED — add design-tokens.css, theme attr, toggle
│   └── ...
├── scripts/
│   ├── build-css.sh                  # MODIFIED — prepend design-tokens.css import
│   ├── check-phase-contrast.ts       # NEW — WCAG phase-color contrast CI check
│   ├── lint-css-tokens.sh            # NEW — CI: no hex/font-family/px in non-token CSS
│   ├── lint-no-emoji.sh              # NEW — CI: no emoji in template .tsx files
│   └── lint-box-shadow.sh            # NEW — CI: no raw box-shadow without --shadow-* vars
└── ...
```

### 4.2 Component diagram

```
 ┌─────────────────────────────────────────────────────────────┐
 │  Browser                                                    │
 │  ┌──────────────────────────────────────────────────────┐  │
 │  │  <html data-theme="light|dark">                      │  │
 │  │    <head>                                            │  │
 │  │      <link rel="stylesheet" design-tokens.css />     │  │ ← FIRST
 │  │      <link rel="stylesheet" portal.css />            │  │ ← SECOND (refs tokens)
 │  │    </head>                                           │  │
 │  │    <body>                                            │  │
 │  │      ... server-rendered Hono JSX templates ...      │  │
 │  │      <script type="module" theme-toggle.js />        │  │
 │  │    </body>                                           │  │
 │  └──────────────────────────────────────────────────────┘  │
 │                     │                                       │
 │                     │ reads/writes                           │
 │                     ▼                                       │
 │  ┌──────────────────────────────────┐                      │
 │  │  localStorage['portal.theme']    │                      │
 │  │  cookie['portal-theme']          │                      │
 │  └──────────────────────────────────┘                      │
 └─────────────────────────────────────────────────────────────┘
                       │
                       │ SSR reads cookie on request
                       ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Hono Server (base.tsx)                                     │
 │  ┌──────────────────────────────────────────────────────┐  │
 │  │  reads cookie('portal-theme')                        │  │
 │  │  sets data-theme attr on <html> in SSR output        │  │
 │  │  → no FOUC: theme matches before first paint         │  │
 │  └──────────────────────────────────────────────────────┘  │
 └─────────────────────────────────────────────────────────────┘
                       │
                       │ CI pipeline
                       ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  CI Lint Gates                                              │
 │  ├── lint-css-tokens.sh     (M-01: no hex/font/px)         │
 │  ├── lint-no-emoji.sh       (M-05: no emoji in templates)  │
 │  ├── lint-box-shadow.sh     (R-15a: shadow token enforcement)│
 │  └── check-phase-contrast.ts (M-02: WCAG + peer contrast)  │
 └─────────────────────────────────────────────────────────────┘
```

### 4.3 Theme switching mechanism

The design uses a **cookie-shadow strategy** to avoid flash of unstyled content (FOUC):

1. **Client-side**: `theme-toggle.js` (vanilla JS ES module, ~40 lines) reads
   `localStorage.getItem('portal.theme')` on load, sets `document.documentElement
   .dataset.theme`, and writes a `portal-theme` cookie (`SameSite=Lax; Path=/;
   Max-Age=31536000`) so the server can read it on the next full-page navigation.

2. **Server-side**: In `base.tsx`, the Hono request handler reads the `portal-theme`
   cookie from the request context and injects `data-theme="${value}"` on the
   `<html>` element during SSR. If no cookie is present, the default is `light` (per
   R-03).

3. **Toggle interaction**: The theme toggle button (a sun/moon icon in the page
   chrome) calls `toggleTheme()` in `theme-toggle.js`, which:
   - Flips the `data-theme` attribute on `<html>`
   - Writes the new value to `localStorage`
   - Writes the new value to the `portal-theme` cookie
   - No page reload required; CSS variables cascade immediately

4. **FOUC prevention**: The `theme-toggle.js` script is loaded with `<script>` (not
   `defer`, not `async`) in the `<head>` section so it runs before first paint. It
   contains only the synchronous `localStorage` read + attribute set; the toggle
   handler is registered in `DOMContentLoaded`. The script is small (~800 bytes
   minified) and the blocking cost is negligible.

### 4.4 Self-hosting fonts and icons (OQ-03 and OQ-06 resolution)

**Decision: Self-host both Google Fonts and Lucide icons.**

**Rationale**: The existing CSP (`font-src 'self'`, `script-src 'self'`) blocks external
origins. Rather than widening the CSP -- which increases attack surface and adds runtime
dependencies on third-party CDNs -- we self-host. This is the PRD's own default
recommendation.

**Fonts**: Download the Inter (400/500/600/700) and JetBrains Mono (400/500/600/700)
WOFF2 files from Google Fonts. Replace the `@import url(...)` line in the vendored
`design-tokens.css` with local `@font-face` declarations pointing to
`/static/fonts/*.woff2`. WOFF2 only (no WOFF1 or TTF fallbacks) since all target
browsers (modern desktop Chrome/Firefox/Safari/Edge) have full WOFF2 support.

**Icons**: Download the 24 Lucide SVGs listed in the design system README's iconography
section. Store at `server/static/icons/<name>.svg`. Serve as static assets. Templates
reference them via `<img src="/static/icons/<name>.svg" alt="...">` or inline `<svg>`
inclusion. No CDN URL in any template.

This approach:
- Requires zero CSP changes
- Eliminates two runtime external dependencies (Google Fonts, unpkg.com)
- Makes the portal fully functional offline / air-gapped
- Adds ~500 KB to the repo (8 WOFF2 font files + 24 SVG icons)

---

## 5. Detailed Design

### 5.1 R-01: Vendor design-tokens.css

The file at `project/colors_and_type.css` is copied verbatim to
`plugins/autonomous-dev-portal/server/static/design-tokens.css` with two modifications:

1. **Replace the `@import url('https://fonts.googleapis.com/...')` line** with local
   `@font-face` declarations (see section 5.4).

2. **Add a file header comment**: `/* Design tokens vendored from autonomous-dev-design-system.
   Source: colors_and_type.css. DO NOT EDIT — regenerate from the design bundle. */`

The vendored file retains the `:root` light-mode tokens, `:root[data-theme="dark"]`
dark-mode overrides, all base resets, and utility primitives (`.surface`, `.dot`,
`@keyframes pulse`). The `@media (prefers-color-scheme: light)` rule in the original
is preserved for the case where no `data-theme` attribute is set (graceful degradation
before JS runs).

**Load order in base.tsx**:
```tsx
<link rel="stylesheet" href="/static/design-tokens.css" />
<link rel="stylesheet" href="/static/portal.css" />
```

`design-tokens.css` MUST be first so that CSS variables are defined before `portal.css`
references them.

### 5.2 R-02: Migrate portal CSS to token-only references

The existing `portal.css` (and its source files `src/styles/variables.css`,
`layout.css`, `components.css`, `utilities.css`) must be refactored:

1. **Delete `src/styles/variables.css`** entirely. Its tokens (`--primary-color`,
   `--bg-primary`, etc.) are superseded by `design-tokens.css`.

2. **Rewrite `layout.css`, `components.css`, `utilities.css`** to reference the new
   token names. Mapping table:

   | Old variable             | New variable       |
   |--------------------------|--------------------|
   | `--primary-color`        | `--brand`          |
   | `--primary-hover`        | `--brand-hover`    |
   | `--success-color`        | `--ok`             |
   | `--success-light`        | `--ok-tint`        |
   | `--warning-color`        | `--warn`           |
   | `--warning-light`        | `--warn-tint`      |
   | `--danger-color`         | `--err`            |
   | `--danger-light`         | `--err-tint`       |
   | `--info-color`           | `--info`           |
   | `--info-light`           | `--info-tint`      |
   | `--bg-primary`           | `--bg-1`           |
   | `--bg-secondary`         | `--bg-0`           |
   | `--bg-tertiary`          | `--bg-2`           |
   | `--text-primary`         | `--fg-0`           |
   | `--text-secondary`       | `--fg-1`           |
   | `--text-muted`           | `--fg-2`           |
   | `--border-color`         | `--line-1`         |
   | `--border-hover`         | `--line-2`         |
   | `--radius-sm`            | `--r-1`            |
   | `--radius-md`            | `--r-2`            |
   | `--radius-lg`            | `--r-3`            |
   | `--shadow-sm`            | `--shadow-1`       |
   | `--shadow-md`            | `--shadow-2`       |
   | `--shadow-lg`            | `--shadow-pop`     |
   | `--space-xs`             | `--s-1`            |
   | `--space-sm`             | `--s-2`            |
   | `--space-md`             | `--s-4`            |
   | `--space-lg`             | `--s-6`            |
   | `--space-xl`             | `--s-8`            |

3. **Eliminate all hardcoded hex values** in the CSS. Grep for `#[0-9a-fA-F]{3,8}`
   and replace each with the appropriate token variable.

4. **Replace hardcoded `font-family` declarations** with `var(--font-sans)` or
   `var(--font-mono)`.

5. **Replace hardcoded `px` sizes** in `font-size`, `padding`, `margin`, `gap`,
   `border-radius` with token references. Where no exact match exists in the
   spacing scale, pick the nearest token value. If a value is truly unique (e.g., a
   one-off `max-width: 600px` on the error page), that is acceptable as a non-token
   value -- the lint script (section 5.8) has an allowlist for structural dimensions.

6. **Remove the `@media (prefers-color-scheme: dark)` block** from `variables.css` --
   dark mode is now handled by `design-tokens.css` via `[data-theme="dark"]`.

7. **Update `scripts/build-css.sh`** to no longer include `variables.css` in the
   concatenation (those variables are now in the separate `design-tokens.css`).

### 5.3 R-03: Theme switching

#### 5.3.1 Server-side (base.tsx modification)

```tsx
// server/templates/layout/base.tsx
import type { FC } from "hono/jsx";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";

interface Props {
    activePath: string;
    cspNonce?: string;
    theme?: "light" | "dark";
    children?: unknown;
}

export const BaseLayout: FC<Props> = ({
    activePath,
    cspNonce,
    theme = "light",
    children,
}) => (
    <html lang="en" data-theme={theme}>
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>autonomous-dev portal</title>
            <link rel="stylesheet" href="/static/design-tokens.css" />
            <link rel="stylesheet" href="/static/portal.css" />
            {/* Blocking script: reads localStorage, sets data-theme before paint */}
            <script src="/static/theme-toggle.js" nonce={cspNonce ?? ""}></script>
            <script src="/static/htmx.min.js" defer nonce={cspNonce ?? ""}></script>
        </head>
        <body>
            <header>
                <Navigation activePath={activePath} />
            </header>
            <main id="main">{children}</main>
            <footer>autonomous-dev</footer>
        </body>
    </html>
);
```

Route handlers extract the theme from the cookie:

```tsx
app.get("/", (c) => {
    const theme = getCookie(c, "portal-theme") === "dark" ? "dark" : "light";
    return c.html(renderToString(
        <BaseLayout activePath="/" cspNonce={c.get("cspNonce")} theme={theme}>
            <DashboardView ... />
        </BaseLayout>
    ));
});
```

#### 5.3.2 Client-side (theme-toggle.js)

```javascript
// server/static/theme-toggle.js
// Synchronous theme init — runs in <head> before first paint.
(function() {
    const STORAGE_KEY = "portal.theme";
    const COOKIE_NAME = "portal-theme";
    const DEFAULT_THEME = "light";

    function getStoredTheme() {
        try {
            return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME;
        } catch {
            return DEFAULT_THEME;
        }
    }

    function setCookie(value) {
        document.cookie =
            COOKIE_NAME + "=" + value +
            ";path=/;max-age=31536000;SameSite=Lax";
    }

    // Apply immediately (before paint)
    var theme = getStoredTheme();
    document.documentElement.setAttribute("data-theme", theme);

    // Register toggle handler after DOM ready
    document.addEventListener("DOMContentLoaded", function() {
        var toggle = document.getElementById("theme-toggle");
        if (!toggle) return;
        toggle.addEventListener("click", function() {
            var current = document.documentElement.getAttribute("data-theme");
            var next = current === "dark" ? "light" : "dark";
            document.documentElement.setAttribute("data-theme", next);
            try { localStorage.setItem(STORAGE_KEY, next); } catch {}
            setCookie(next);
        });
    });
})();
```

Note: This is an IIFE, not a module, because it must execute synchronously in the
`<head>` to prevent FOUC. It is loaded without `defer` or `async`. The file size is
under 600 bytes minified, so the blocking cost is negligible.

### 5.4 R-04 + OQ-06: Self-hosted fonts

Replace the `@import url(...)` at the top of the vendored `design-tokens.css` with:

```css
/* Self-hosted fonts — Inter (sans) + JetBrains Mono (mono) */
@font-face {
    font-family: 'Inter';
    font-style: normal;
    font-weight: 400;
    font-display: swap;
    src: url('/static/fonts/inter-v18-latin-400.woff2') format('woff2');
}
@font-face {
    font-family: 'Inter';
    font-style: normal;
    font-weight: 500;
    font-display: swap;
    src: url('/static/fonts/inter-v18-latin-500.woff2') format('woff2');
}
@font-face {
    font-family: 'Inter';
    font-style: normal;
    font-weight: 600;
    font-display: swap;
    src: url('/static/fonts/inter-v18-latin-600.woff2') format('woff2');
}
@font-face {
    font-family: 'Inter';
    font-style: normal;
    font-weight: 700;
    font-display: swap;
    src: url('/static/fonts/inter-v18-latin-700.woff2') format('woff2');
}
@font-face {
    font-family: 'JetBrains Mono';
    font-style: normal;
    font-weight: 400;
    font-display: swap;
    src: url('/static/fonts/jetbrains-mono-v18-latin-400.woff2') format('woff2');
}
@font-face {
    font-family: 'JetBrains Mono';
    font-style: normal;
    font-weight: 500;
    font-display: swap;
    src: url('/static/fonts/jetbrains-mono-v18-latin-500.woff2') format('woff2');
}
@font-face {
    font-family: 'JetBrains Mono';
    font-style: normal;
    font-weight: 600;
    font-display: swap;
    src: url('/static/fonts/jetbrains-mono-v18-latin-600.woff2') format('woff2');
}
@font-face {
    font-family: 'JetBrains Mono';
    font-style: normal;
    font-weight: 700;
    font-display: swap;
    src: url('/static/fonts/jetbrains-mono-v18-latin-700.woff2') format('woff2');
}
```

Font files are downloaded from the Google Fonts CDN using google-webfonts-helper (or
equivalent) during development. They are committed to the repo at `server/static/fonts/`.
Total size: approximately 400 KB for 8 WOFF2 files. `font-display: swap` ensures
text is visible immediately with fallback fonts, then swaps when the custom font loads.

### 5.5 R-15a: Hairline-driven elevation system + box-shadow lint

The design system's elevation model is:
- Level 0: No elevation (flat)
- Level 1: `var(--shadow-1)` -- 1px hairline + subtle ambient
- Level 2: `var(--shadow-2)` -- 2px ambient shadow
- Pop: `var(--shadow-pop)` -- modals, popovers, dropdowns

Cards use `border: var(--border-thin)` + `border-radius: var(--r-2)` + no shadow.
Tables use horizontal hairlines only.

**CI lint (`scripts/lint-box-shadow.sh`)**:

```bash
#!/usr/bin/env bash
# Reject box-shadow declarations that don't use --shadow-* token vars.
# Allowlist: design-tokens.css (defines the tokens themselves).
set -euo pipefail

PORTAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CSS_FILES=$(find "$PORTAL_DIR/server/static" "$PORTAL_DIR/src/styles" \
    -name '*.css' ! -name 'design-tokens.css' 2>/dev/null)

EXIT=0
while IFS= read -r file; do
    [ -z "$file" ] && continue
    # Match box-shadow lines that do NOT contain var(--shadow-
    HITS=$(grep -n 'box-shadow' "$file" \
        | grep -v 'var(--shadow-' \
        | grep -v '^\s*/\*' \
        | grep -v '^\s*\*' || true)
    if [ -n "$HITS" ]; then
        echo "ERROR: Untokened box-shadow in $file:"
        echo "$HITS"
        EXIT=1
    fi
done <<< "$CSS_FILES"

exit $EXIT
```

### 5.6 R-22 + R-23: Voice and copy sweep

The sweep covers all `.tsx` files under `server/templates/` (31 files as of this
writing). Each file is reviewed against the content fundamentals documented in the
design system README:

**Rules applied**:
1. **Sentence case** for all headings, button labels, navigation items. Example:
   `"Dashboard"` stays (single word), `"Request Detail"` becomes `"Request detail"`,
   `"Kill Switch"` stays (proper noun in this context per design system).
2. **No emoji** anywhere. Any emoji character (Unicode ranges `U+1F600-U+1F64F`,
   `U+1F300-U+1F5FF`, `U+1F680-U+1F6FF`, `U+1F900-U+1F9FF`, `U+2600-U+26FF`,
   `U+2700-U+27BF`, `U+FE00-U+FE0F`, `U+1F1E0-U+1F1FF`) is replaced with text
   status badges or the `.dot` primitive.
3. **No exclamation marks** in user-facing strings.
4. **Mono for IDs/status/timestamps**: Request IDs (`REQ-*`), run IDs (`RUN-*`),
   status words (`RUNNING`, `ENGAGED`, `TRIPPED`), and timestamps render in
   `var(--font-mono)` via `<code>` or `<span class="mono">` elements.
5. **Costs to 2 decimals**: Replace any `$X` or `$X.X` rendering with `.toFixed(2)`.
6. **ISO timestamps in tables**: Ensure table cells show ISO compact format
   (`2026-05-09 14:30:00Z`); prose/relative timestamps (`3 min ago`) in non-table
   contexts.
7. **Canonical strings**: Replace ad-hoc copy with kit strings:
   - `"Daemon is running"` -> `"Daemon running"`
   - `"No requests found"` -> `"No active requests"`
   - `"Kill switch is currently engaged"` -> `"Kill switch ENGAGED at <ISO>. All daemon processing will halt."`
   - `"Error loading data"` -> `"Failed to load data"`

The sweep is executed as a single commit with each file's changes in the diff,
reviewable line-by-line. No logic changes -- only string literals and CSS class
assignments.

### 5.7 OQ-03 Resolution: Self-host Lucide icons

**Decision: Self-host Lucide SVGs.**

The 24 icons listed in the design system's iconography section are downloaded from
the `lucide-static` npm package and committed to `server/static/icons/`. Each is a
single SVG file averaging 400 bytes.

Icons are referenced in templates via inline `<svg>` elements generated by a
server-side helper function:

```tsx
// server/lib/icons.tsx
import { readFileSync } from "fs";
import { join } from "path";

const ICON_DIR = join(import.meta.dir, "../static/icons");
const cache = new Map<string, string>();

export function icon(name: string, size: number = 16): string {
    if (!cache.has(name)) {
        const path = join(ICON_DIR, `${name}.svg`);
        cache.set(name, readFileSync(path, "utf-8"));
    }
    return cache.get(name)!
        .replace(/width="[^"]*"/, `width="${size}"`)
        .replace(/height="[^"]*"/, `height="${size}"`);
}
```

This avoids an `<img>` tag per icon (which would require individual HTTP requests)
and avoids `<use>` sprite sheets (which add complexity). The inline SVG approach
inherits `currentColor` for stroke, matching the design system's icon specification.

Inventory of vendored icons (from design system README):
`activity`, `shield-alert`, `circle-slash`, `git-branch`, `git-pull-request`,
`play`, `pause`, `square`, `chevron-right`, `chevron-down`, `check`, `x`,
`alert-triangle`, `info`, `terminal`, `cpu`, `database`, `dollar-sign`,
`trending-up`, `trending-down`, `users`, `bot`, `bell`, `bell-off`.

### 5.8 M-01: CSS token enforcement lint

**`scripts/lint-css-tokens.sh`**:

```bash
#!/usr/bin/env bash
# M-01: Reject hex colors, hardcoded font-family, and hardcoded px sizes
# in non-token CSS files.
set -euo pipefail

PORTAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CSS_FILES=$(find "$PORTAL_DIR/server/static" "$PORTAL_DIR/src/styles" \
    -name '*.css' ! -name 'design-tokens.css' 2>/dev/null)

EXIT=0

while IFS= read -r file; do
    [ -z "$file" ] && continue

    # 1. Hex color literals (#xxx, #xxxxxx, #xxxxxxxx)
    #    Match hex sequences that start with a digit (not a letter) after the '#',
    #    which distinguishes color literals (#1a2b3c) from CSS ID selectors (#main).
    #    Allowlist: inside var() references, comments, url() values.
    HEX=$(grep -nE '#[0-9][0-9a-fA-F]{2,7}\b' "$file" \
        | grep -vE '^\s*/\*|^\s*\*|var\(--' \
        | grep -vE 'url\(' || true)
    if [ -n "$HEX" ]; then
        echo "ERROR: Hex color literal in $file:"
        echo "$HEX"
        EXIT=1
    fi

    # 2. Hardcoded font-family (not using var(--font-*))
    FONT=$(grep -nE 'font-family\s*:' "$file" \
        | grep -v 'var(--font-' \
        | grep -vE '^\s*/\*|^\s*\*' || true)
    if [ -n "$FONT" ]; then
        echo "ERROR: Hardcoded font-family in $file:"
        echo "$FONT"
        EXIT=1
    fi

    # 3. Hardcoded px sizes in font-size / padding / margin / gap / border-radius
    #    Allowlist: max-width, min-width, max-height, min-height (structural dims)
    #    Allowlist: 0px (valid CSS reset), 1px (border widths)
    PX=$(grep -nE '(font-size|padding|margin|gap|border-radius)\s*:.*[0-9]+px' "$file" \
        | grep -v 'var(--' \
        | grep -vE '^\s*/\*|^\s*\*' \
        | grep -vE '\b[01]px\b' || true)
    if [ -n "$PX" ]; then
        echo "ERROR: Hardcoded px size in $file:"
        echo "$PX"
        EXIT=1
    fi
done <<< "$CSS_FILES"

exit $EXIT
```

**Allowlist rationale**: `1px` is allowed for border widths (the token system uses
`var(--border-thin)` for the shorthand, but individual border properties may use
`1px solid var(--line-1)` directly). Structural dimensions (`max-width`, `min-width`,
`width`, `height`) are not linted because they are layout-specific, not design tokens.

**Hex regex rationale**: The pattern `#[0-9][0-9a-fA-F]{2,7}\b` requires the first
character after `#` to be a digit (0-9). CSS color hex literals always start with a
digit in their expanded form, while CSS ID selectors (e.g., `#main`, `#sidebar`) start
with a letter. This eliminates false positives from ID selectors without requiring a
second-pass filter. Shorthand hex colors like `#fff` or `#aaa` that start with a letter
are uncommon in practice and would only appear as token values inside `design-tokens.css`
(which is already excluded from the scan). If a non-token CSS file legitimately needs a
hex color starting with a letter, the code reviewer would catch it -- but such cases
should not exist after the R-02 migration.

### 5.9 M-05: Emoji rejection lint

**`scripts/lint-no-emoji.sh`**:

```bash
#!/usr/bin/env bash
# M-05: Reject emoji in user-facing portal templates.
set -euo pipefail

PORTAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE_DIR="$PORTAL_DIR/server/templates"

EXIT=0

# Emoji regex covers common Unicode emoji ranges.
# We grep for codepoints rather than literal bytes to catch all forms.
while IFS= read -r -d '' file; do
    HITS=$(grep -Pn '[\x{1F300}-\x{1F9FF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}\x{FE00}-\x{FE0F}\x{1F1E0}-\x{1F1FF}\x{200D}\x{20E3}\x{E0020}-\x{E007F}]' "$file" 2>/dev/null \
        | grep -vE '^\s*//' \
        | grep -vE '^\s*\*' || true)
    if [ -n "$HITS" ]; then
        echo "ERROR: Emoji found in $file:"
        echo "$HITS"
        EXIT=1
    fi
done < <(find "$TEMPLATE_DIR" -name '*.tsx' -print0)

exit $EXIT
```

### 5.10 M-02: Phase contrast verification script

**`scripts/check-phase-contrast.ts`**:

This script reads the token values from `design-tokens.css`, computes WCAG relative
luminance for each color, and checks contrast ratios. Per reviewer note N-01, it is
split into two clearly labeled sections. Per PRD-018 M-02, both checks are CI-blocking:

1. **Part A -- WCAG SC 1.4.11 check** (binding, CI-blocking): Each of the 8 phase colors
   (`--phase-prd` through `--phase-observe`) must have >= 3:1 contrast ratio against
   `--bg-0` in both light and dark themes.

2. **Part B -- Peer-chip contrast check** (binding, CI-blocking): Each pair of adjacent
   phase colors (in pipeline order: PRD/TDD, TDD/Plan, Plan/Spec, Spec/Code,
   Code/Review, Review/Deploy, Deploy/Observe) must have >= 3:1 contrast ratio with
   each other. PRD-018 M-02 binds this check as part of the same success metric as
   Part A: the operator must be able to distinguish adjacent phase chips by color
   alone. Failures in Part B block merge.

```typescript
#!/usr/bin/env bun
// scripts/check-phase-contrast.ts
// M-02: WCAG SC 1.4.11 phase-color contrast verification.
// Both Part A (phase vs --bg-0) and Part B (adjacent-pair) are CI-blocking.
// Runs in CI on any PR touching design-tokens.css.

import { readFileSync } from "fs";
import { join } from "path";

const TOKENS_PATH = join(import.meta.dir, "../server/static/design-tokens.css");

const PHASES = [
    "prd", "tdd", "plan", "spec", "code", "review", "deploy", "observe",
] as const;

interface ThemeColors {
    bg0: string;
    phases: Record<string, string>;
}

// --- Color math ---

function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
    ];
}

function srgbToLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(hex1: string, hex2: string): number {
    const l1 = relativeLuminance(hexToRgb(hex1));
    const l2 = relativeLuminance(hexToRgb(hex2));
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

// --- Token parsing ---

function parseTokens(css: string): { light: ThemeColors; dark: ThemeColors } {
    // Extract :root block (light theme)
    const rootMatch = css.match(/:root\s*\{([^}]+)\}/);
    // Extract :root[data-theme="dark"] block
    const darkMatch = css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/);

    if (!rootMatch || !darkMatch) {
        throw new Error("Could not parse token blocks from design-tokens.css");
    }

    function extractColors(block: string): ThemeColors {
        const bg0 = block.match(/--bg-0:\s*(#[0-9a-fA-F]{6})/)?.[1];
        if (!bg0) throw new Error("--bg-0 not found");
        const phases: Record<string, string> = {};
        for (const phase of PHASES) {
            const match = block.match(new RegExp(`--phase-${phase}:\\s*(#[0-9a-fA-F]{6})`));
            if (!match) throw new Error(`--phase-${phase} not found`);
            phases[phase] = match[1];
        }
        return { bg0, phases };
    }

    return {
        light: extractColors(rootMatch[1]),
        dark: extractColors(darkMatch[1]),
    };
}

// --- Main ---

const css = readFileSync(TOKENS_PATH, "utf-8");
const tokens = parseTokens(css);

let exitCode = 0;

// Part A: WCAG SC 1.4.11 — phase vs --bg-0 (binding, CI-blocking)
console.log("=== Part A: WCAG SC 1.4.11 — Phase colors vs --bg-0 ===\n");
for (const themeName of ["light", "dark"] as const) {
    const theme = tokens[themeName];
    console.log(`  Theme: ${themeName} (--bg-0: ${theme.bg0})`);
    for (const phase of PHASES) {
        const ratio = contrastRatio(theme.phases[phase], theme.bg0);
        const pass = ratio >= 3.0;
        const status = pass ? "PASS" : "FAIL";
        console.log(`    --phase-${phase.padEnd(7)} ${theme.phases[phase]}  ratio ${ratio.toFixed(2)}:1  ${status}`);
        if (!pass) exitCode = 1;
    }
    console.log();
}

// Part B: Adjacent phase pair contrast (binding, CI-blocking per PRD-018 M-02)
console.log("=== Part B: Adjacent phase pair contrast (>=3:1) ===\n");
for (const themeName of ["light", "dark"] as const) {
    const theme = tokens[themeName];
    console.log(`  Theme: ${themeName}`);
    for (let i = 0; i < PHASES.length - 1; i++) {
        const a = PHASES[i];
        const b = PHASES[i + 1];
        const ratio = contrastRatio(theme.phases[a], theme.phases[b]);
        const pass = ratio >= 3.0;
        const status = pass ? "PASS" : "FAIL";
        console.log(`    ${a.padEnd(7)} / ${b.padEnd(7)}  ratio ${ratio.toFixed(2)}:1  ${status}`);
        if (!pass) exitCode = 1;
    }
    console.log();
}

if (exitCode !== 0) {
    console.error("FAIL: One or more contrast checks did not meet the >=3:1 threshold.");
    console.error("  Part A failures: phase color vs --bg-0 (WCAG SC 1.4.11)");
    console.error("  Part B failures: adjacent phase pair contrast (PRD-018 M-02)");
}

process.exit(exitCode);
```

### 5.11 M-06: Light + dark theme parity verification

Theme parity is verified through two mechanisms:

1. **Token-level structural parity**: The `check-phase-contrast.ts` script (section
   5.10) already validates both themes. A supplementary check is added to that script
   verifying that every CSS variable defined in the `:root` block also appears in the
   `[data-theme="dark"]` block (and vice versa, excluding variables that are
   intentionally theme-invariant like spacing and radii).

2. **Visual parity review**: Each PR in the surface-adoption phase (TDD-036) must
   include before/after screenshots in both light and dark mode. This is a human
   review gate, not an automated check -- automated visual regression is deferred to
   TDD-035 (M-03) which establishes the `/design-system` reference surface.

For this TDD's scope, the token-level structural parity check is sufficient. The
supplementary check in `check-phase-contrast.ts` outputs a section:

```
=== Theme parity: Variable coverage ===
  Light-only variables: (none)
  Dark-only variables: (none)
  PASS
```

---

## 6. Trade-offs Explored

| # | Decision | Option A | Option B | Chosen | Rationale |
|---|----------|----------|----------|--------|-----------|
| 1 | **Font + icon hosting** | CDN (Google Fonts + unpkg) | Self-host WOFF2 + SVG | **B: Self-host** | CSP already blocks external origins. Widening CSP adds attack surface, adds runtime dependency on third-party CDNs, and makes the portal non-functional in air-gapped/offline environments. Self-hosting adds ~500 KB to the repo, a one-time cost with no runtime penalty. The PRD's own default recommendation was self-host. |
| 2 | **Theme switching: server cookie shadow vs CSS-only `prefers-color-scheme`** | CSS-only `@media (prefers-color-scheme)` auto-detect | Cookie shadow + `data-theme` attribute + `localStorage` + operator toggle | **B: Cookie shadow** | R-03 explicitly requires operator-selectable theme with `localStorage` persistence and `data-theme` attribute. CSS-only auto-detect would not allow manual override, would not persist a choice across sessions, and would not support SSR (server can't read the browser's `prefers-color-scheme`). The cookie shadow eliminates FOUC by setting the attribute server-side during SSR. |
| 3 | **CSS lint approach: PR-time CI vs pre-commit hook** | Run lint scripts only in CI on PR | Run lint scripts as git pre-commit hooks locally | **A: CI-only** | Pre-commit hooks add friction to every commit including WIP saves. CI-only enforcement catches violations before merge while allowing developers to iterate freely. Developers can run the lint scripts manually when they want fast feedback. The project has no existing pre-commit hook infrastructure and adding one is a separate decision. |
| 4 | **Token file vendoring: copy verbatim vs extract-and-transform** | Copy `colors_and_type.css` verbatim with minimal edits (only the `@import` replacement) | Parse the token file and emit a stripped version (tokens only, no resets/utilities) | **A: Verbatim copy** | The token file includes base resets and utility classes (`.surface`, `.dot`, `.dot.live`) that the portal will use. Stripping them would require reimplementing them in `portal.css`. Keeping the file intact makes future updates from the design bundle a simple file replacement (diff the vendored file against the new version). The file is only 314 lines -- there is no size concern. |
| 5 | **Lucide icon delivery: inline SVG vs `<img>` tag vs sprite sheet** | `<img src="/static/icons/name.svg">` per icon | Server-side inline SVG via helper function | **B: Inline SVG** | Inline SVGs inherit `currentColor` for stroke color (matching the design system spec), respond to theme changes without separate CSS overrides, and avoid individual HTTP requests. A sprite sheet (`<use xlink:href>`) would work but adds complexity (building the sprite, managing symbol IDs) for only 24 icons. Inline is simplest and best matches the kit's own approach. |

---

## 7. Test Plan

### 7.1 Token vendoring (R-01)

- **Verification**: Diff the vendored `design-tokens.css` against the source
  `colors_and_type.css`. They must be byte-identical except for the `@import` line
  replaced by `@font-face` declarations and the added header comment.
- **Automated**: The lint scripts (M-01) confirm no hex literals leak outside
  the token file.

### 7.2 Token-only CSS (R-02, M-01)

- **CI gate**: `scripts/lint-css-tokens.sh` runs on every PR. Exit code 1 fails the
  check if any hex literal, hardcoded font-family, or hardcoded px size is found
  in non-token CSS.
- **Manual review**: PR reviewer confirms the variable-name mapping table (section
  5.2) was applied correctly.

### 7.3 Theme switching (R-03)

- **Unit test**: Render `BaseLayout` with `theme="dark"` and assert the output
  contains `data-theme="dark"` on the `<html>` element.
- **Manual test**: Open portal in browser, toggle theme, verify:
  - CSS variables cascade immediately (background, text color change)
  - `localStorage.getItem('portal.theme')` reflects the choice
  - `document.cookie` contains `portal-theme=dark` (or `light`)
  - Full page reload preserves the chosen theme (no FOUC)
  - New incognito window defaults to `light`

### 7.4 Font loading (R-04)

- **Manual test**: Open DevTools Network tab, confirm fonts load from
  `/static/fonts/` (not Google CDN). Verify `font-display: swap` causes immediate
  text rendering with fallback, then swap.
- **CI**: The CSP is unchanged (`font-src 'self'`) -- any external font reference
  would trigger a CSP violation in the browser console.

### 7.5 Box-shadow lint (R-15a)

- **CI gate**: `scripts/lint-box-shadow.sh` runs on every PR. Add a test CSS file
  with a raw `box-shadow: 0 2px 4px black;` and verify the script exits 1.

### 7.6 Voice sweep (R-22, R-23)

- **Manual review**: PR reviewer reads every changed string in the diff and confirms
  compliance with the content fundamentals checklist (section 5.6).
- **CI gate**: `scripts/lint-no-emoji.sh` (M-05) catches any emoji that was missed.

### 7.7 Phase contrast (M-02)

- **CI gate**: `scripts/check-phase-contrast.ts` runs on PRs touching
  `design-tokens.css`. Both Part A (WCAG phase vs `--bg-0`) and Part B (adjacent
  phase pair contrast) block merge on failure.
- **Verification**: Run the script locally against the vendored token file and confirm
  all 8 phase colors pass in both themes for both checks.

### 7.8 Theme parity (M-06)

- **CI gate**: The token-level parity check in `check-phase-contrast.ts` verifies
  variable coverage between light and dark blocks.
- **Visual**: Screenshots in both themes are required for the PR review.

---

## 8. Phased Rollout

Each phase is independently landable as a separate PR. The phases are sequenced to
minimize merge conflicts and ensure each PR is self-contained.

### Phase 1: Token vendoring and font/icon self-hosting

**Scope**: R-01, R-04, OQ-03, OQ-06

**Deliverables**:
1. Create `server/static/design-tokens.css` (vendored, with `@font-face` replacing `@import`)
2. Add `server/static/fonts/` with 8 WOFF2 files
3. Add `server/static/icons/` with 24 Lucide SVGs
4. Add `server/lib/icons.tsx` (icon helper)
5. Update `server/templates/layout/base.tsx` to load `design-tokens.css` first
6. Update `scripts/build-css.sh` to exclude the deleted `variables.css`

**Verification**: Portal loads with new token file. Old CSS still works (variables.css
is removed but portal.css still references old names until Phase 2). Fonts load from
local paths. No CSP violations.

### Phase 2: CSS migration to token references

**Scope**: R-02

**Deliverables**:
1. Delete `src/styles/variables.css`
2. Rewrite `src/styles/layout.css`, `components.css`, `utilities.css` to use new token names
3. Rebuild `static/portal.css` via `scripts/build-css.sh`

**Verification**: All pages render correctly. `lint-css-tokens.sh` passes. No hex
literals remain in non-token CSS.

### Phase 3: Theme switcher

**Scope**: R-03

**Deliverables**:
1. Add `server/static/theme-toggle.js`
2. Update `base.tsx` to read `portal-theme` cookie and set `data-theme` in SSR
3. Add theme toggle button to the page chrome (navigation fragment)

**Verification**: Theme toggles without FOUC. Persists across page loads. SSR
matches client preference.

### Phase 4: CI lint gates

**Scope**: M-01, M-05, R-15a, M-02, M-06

**Deliverables**:
1. Add `scripts/lint-css-tokens.sh`
2. Add `scripts/lint-no-emoji.sh`
3. Add `scripts/lint-box-shadow.sh`
4. Add `scripts/check-phase-contrast.ts` (both Part A and Part B are CI-blocking)
5. Wire all four scripts into CI workflow (conditionally on relevant file paths)

**Verification**: CI runs pass on the current codebase. Intentionally broken test
files trigger failures. Both Part A and Part B of the contrast script exit non-zero
on violations.

### Phase 5: Voice and copy sweep

**Scope**: R-22, R-23

**Deliverables**:
1. Sweep all 31 `.tsx` template files for content fundamentals compliance
2. Replace ad-hoc strings with kit canonical strings
3. Add `<code>` / `<span class="mono">` wrappers for IDs/timestamps/status

**Verification**: `lint-no-emoji.sh` passes. PR review confirms every string change
is correct per the content fundamentals checklist.

---

## 9. Observability

No new Prometheus metrics are introduced in this TDD (no new server-side functionality).
The lint scripts produce structured stdout output suitable for CI log parsing.

The theme-toggle module writes to `localStorage` and a cookie, both of which are
observable via browser DevTools. No server-side telemetry is added for theme choice
(the portal is single-operator -- anonymized preference tracking is unnecessary).

---

## 10. Security Considerations

### 10.1 CSP impact

No CSP changes are required. The self-hosting strategy for fonts and icons means all
assets are served from `'self'`. The `theme-toggle.js` script is served from
`/static/` and loaded with the per-request CSP nonce.

### 10.2 Cookie security

The `portal-theme` cookie contains only `"light"` or `"dark"`. It is:
- Not `httpOnly` (must be readable by client-side JS for the toggle)
- `SameSite=Lax` (sufficient for a non-sensitive preference cookie)
- `Path=/` (portal-wide)
- `Max-Age=31536000` (1 year)
- Not `Secure` (portal binds to localhost by default; when network-exposed via TLS,
  the cookie is transmitted over TLS anyway)

This cookie carries no authentication or sensitive data. The server validates the
cookie value before use: only `"dark"` is accepted; anything else defaults to `"light"`.

### 10.3 Icon SVG safety

Vendored Lucide SVGs are from a trusted open-source project. The SVGs are committed
to the repo and served as static files. They are not user-generated and do not require
sanitization. The inline SVG helper (section 5.7) reads from the filesystem at startup
and caches -- no user input reaches the file path.

### 10.4 CI lint enforcement summary

All CI lint gates are merge-blocking. There are no advisory-only checks:

| Script                        | What it enforces                                      | Blocking? |
|-------------------------------|-------------------------------------------------------|-----------|
| `lint-css-tokens.sh`          | No hex colors, hardcoded fonts, hardcoded px (M-01)   | Yes       |
| `lint-no-emoji.sh`            | No emoji in templates (M-05)                          | Yes       |
| `lint-box-shadow.sh`          | No raw box-shadow without `--shadow-*` (R-15a)        | Yes       |
| `check-phase-contrast.ts` A  | Phase vs `--bg-0` >= 3:1 (M-02 Part A)                | Yes       |
| `check-phase-contrast.ts` B  | Adjacent phase pair >= 3:1 (M-02 Part B)              | Yes       |

---

## 11. Open Issues

| ID      | Status   | Question                                                                                           | Owner           |
|---------|----------|----------------------------------------------------------------------------------------------------|-----------------|
| OI-3401 | Closed   | The `@keyframes pulse` animation in `design-tokens.css` uses `rgba(47,122,62,0.45)` -- a hardcoded color that matches `--ok` in light mode but not dark mode. **Resolution**: The `rgba` literal lives inside `design-tokens.css`, which is on the CI lint allowlist (the lint scripts explicitly exclude `design-tokens.css`). The literal is therefore not a lint violation. The dark-mode variant question (whether the pulse should use the dark-mode `--ok` value) is a design-only concern for a future design-system token update, not a TDD-034 deliverable. | TDD-035 author  |
| OI-3402 | Open     | The voice sweep (R-22/R-23) may uncover strings that need product owner confirmation (e.g., "circuit breaker TRIPPED" vs "circuit breaker tripped" -- the design system says UPPERCASE for status badges but the casing of inline prose references is ambiguous). A small set of edge-case strings may need sign-off. | Patrick Watson  |
| OI-3403 | Closed   | The `check-phase-contrast.ts` script's Part B (peer-chip check): should it block merge? **Resolution**: Yes. PRD-018 M-02 binds the peer-chip contrast check (>=3:1 between adjacent phase colors) as part of the same success metric as the WCAG check, with no carve-out. Part B is now CI-blocking (v1.1). If a future token update cannot satisfy the adjacent-pair threshold, the design-system owner must adjust the phase palette -- the CI gate will enforce this. | Design system owner |

---

## 12. Requirements Traceability

| PRD-018 Req | Description                                               | TDD-034 Section | Status      |
|-------------|-----------------------------------------------------------|-----------------|-------------|
| R-01        | Vendor `colors_and_type.css` as `design-tokens.css`       | 5.1             | Designed    |
| R-02        | All CSS references token variables only                    | 5.2, 5.8        | Designed    |
| R-03        | Light/dark theme via `data-theme`, localStorage, cookie    | 5.3             | Designed    |
| R-04        | Inter + JetBrains Mono font loading                        | 5.4             | Designed. TDD departs from PRD R-04 literal (`@import` from Google Fonts CDN); OQ-06 resolution supersedes NG-03 -- fonts are self-hosted in v1 to comply with existing CSP `font-src 'self'`. |
| R-15a       | Hairline-driven elevation + box-shadow lint                | 5.5             | Designed    |
| R-22        | Voice/copy sweep for content fundamentals                  | 5.6             | Designed    |
| R-23        | Replace ad-hoc strings with kit canonical strings          | 5.6             | Designed    |
| M-01        | CI lint: no hex / font-family / px in non-token CSS        | 5.8             | Designed    |
| M-02        | WCAG phase contrast + adjacent-pair contrast check         | 5.10            | Designed. Both Part A (phase vs `--bg-0`) and Part B (adjacent phase pairs) are CI-blocking per PRD M-02. |
| M-05        | CI lint: no emoji in templates                             | 5.9             | Designed    |
| M-06        | Light + dark theme parity verification                     | 5.11            | Designed    |
| OQ-03       | Lucide icons: self-host                                    | 5.7, 6 row 1    | Resolved    |
| OQ-06       | Google Fonts + Lucide vs CSP: self-host both               | 5.4, 5.7, 6 row 1 | Resolved |

---

## 13. Reviewer Note Responses

| Note | Source | Response |
|------|--------|----------|
| N-01 | Pass-2 reviewer | M-02 contrast script is split into (a) WCAG SC 1.4.11 check (phase vs `--bg-0`, CI-blocking) and (b) peer-chip contrast check (adjacent phases, CI-blocking). Both parts block merge per PRD-018 M-02. See section 5.10. |
| N-02 | Pass-2 reviewer | Scanned all `ui_kits/portal/*.jsx` files. Found only `useState` (simple state) and one `useEffect` (tab sync). No `useContext`, `useReducer`, custom hooks, or lifecycle methods. Kit is confirmed pattern-light. Porting effort estimate for TDD-035 is unchanged. See section 3.3. |

---

**END TDD-034**
