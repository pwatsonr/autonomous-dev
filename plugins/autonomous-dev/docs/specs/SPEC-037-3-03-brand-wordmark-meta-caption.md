# SPEC-037-3-03: BrandWordmark — CONTROL PLANE · v{version} meta caption

## Metadata
- **Parent Plan**: PLAN-037-3-rail-and-nav-completeness
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-3 Scope item 5
- **Estimated effort**: 0.25 day
- **Dependencies**: SPEC-035-1-04 (existing BrandWordmark)
- **Priority**: P1
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Extend `BrandWordmark` to render a second line — a `.meta-mono` caption reading `CONTROL PLANE · v{version}` — directly under the `[ autonomous-dev ]` wordmark. The version string is read at module load from `plugins/autonomous-dev-portal/.claude-plugin/plugin.json` so it stays in sync with the plugin manifest without manual edits.

## Acceptance Criteria

- **AC-01**: A new `version` constant is defined in `brand-wordmark.tsx` via a `readFileSync` of the plugin manifest at module load, with a static fallback `"0.0.0"` if the file is missing or malformed. Read is one-time (module init), not per-render.
- **AC-02**: Rendered output adds, as the last child of `<div class="wm">`'s sibling, a `<div class="meta-mono">CONTROL PLANE · v{version}</div>` element. The wordmark itself is unchanged.
- **AC-03**: A new optional prop `showCaption?: boolean` defaults to `true`. When `false`, the caption is suppressed (allows existing isolated unit tests to keep their snapshots).
- **AC-04**: Caption renders the literal `·` (U+00B7 middle dot) between `CONTROL PLANE` and the version — not a hyphen.
- **AC-05**: The caption renders identically in both `theme="light"` and `theme="dark"` — color is supplied entirely by `.meta-mono` CSS (which already reads `var(--fg-2)`).
- **AC-06**: Bracket-suppress path from SPEC-035-1-04 (AC-03) still works: caption is independent of `showBrackets`.

## Implementation

Files modified:
1. `plugins/autonomous-dev-portal/server/components/brand-wordmark.tsx` — add version read + caption render.
2. `plugins/autonomous-dev-portal/server/static/portal.css` — ensure `.rail-brand .meta-mono` has `margin-top: 4px; font-size: 10px; letter-spacing: 0.08em` to match kit (add if absent).

Steps:
1. Add a private top-level `PLUGIN_VERSION` constant: try/catch `readFileSync` of `../../.claude-plugin/plugin.json`, parse JSON, read `.version`, default to `"0.0.0"`.
2. Update the returned JSX so both branches (with/without brackets) wrap into a single fragment that emits the existing `<div class="wm">…</div>` followed by an optional `<div class="meta-mono">CONTROL PLANE · v{PLUGIN_VERSION}</div>`.
3. Caller in `shell.tsx` does not change — default-on behavior surfaces the caption automatically.

## Tests

Extend `plugins/autonomous-dev-portal/tests/unit/components/brand-wordmark.test.tsx`:

| ID | Assertion |
|----|-----------|
| BW-05 | Default render contains text `CONTROL PLANE · v` |
| BW-06 | Caption uses a U+00B7 middle dot (not `-` or `·` alternate) |
| BW-07 | `showCaption={false}` suppresses the `.meta-mono` element entirely |
| BW-08 | Version string matches the value in `plugin.json` (read inside the test for parity) |
| BW-09 | `showBrackets={false}` + default caption renders both the no-bracket wordmark AND the caption |

## Verification

```bash
cd plugins/autonomous-dev-portal
npm test -- tests/unit/components/brand-wordmark.test.tsx
curl -s http://127.0.0.1:19280/ | grep -o "CONTROL PLANE · v[0-9.]*"
```
