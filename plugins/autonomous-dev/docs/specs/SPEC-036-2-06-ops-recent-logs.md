# SPEC-036-2-06: Ops Recent Log Entries

## Metadata
- **Parent Plan**: PLAN-036-2-costs-and-ops
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.4)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-19)
- **Tasks Covered**: PLAN-036-2 Task 8
- **Dependencies**: SPEC-036-2-04 (Ops route composition); PLAN-035-2 token surface (no primitive consumed)
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Date**: 2026-05-09

## 1. Summary

Implement `fragments/live-log.tsx` — the dark, theme-defying log tail
that renders the last 50 log entries from `~/.autonomous-dev/logs/daemon.log`,
filtered to `ERROR | WARN | INFO`. Each line is colored by level. Per
TDD-036 §6.4 the container background is the literal `#14130f` regardless
of the active theme — this is the single documented exception to the
no-hex CI lint, and the fragment must whitelist it inline.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                          | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | The fragment MUST render a `<div class="log" id="log-tail">` container with `background: #14130f`, `max-height: 320px`, `overflow: auto`, `scroll-behavior: smooth`. | T8   |
| FR-2  | The fragment MUST consume `recentLog: LogEntry[]` (last 50, server-trimmed) and render one `<div class="log-line">` per entry containing a timestamp span, a level span, and a message span. | T8   |
| FR-3  | Per-level coloring MUST resolve via tokens: INFO → `var(--info)`, WARN → `var(--warn)`, ERROR → `var(--err)`. Phase/deploy markers (matching `^(phase|deploy|agent)\b`) → `var(--brand)` and bold. Timestamps → `var(--fg-2)` (muted). | T8   |
| FR-4  | The fragment MUST filter `recentLog` to levels in `{INFO, WARN, ERROR}`; DEBUG / TRACE entries MUST be dropped server-side before render. | T8   |
| FR-5  | When `recentLog.length === 0`, the fragment MUST render a single muted line "No log entries yet" inside the container (do NOT collapse the dark block — preserves the visual anchor).                                                                  | T8   |
| FR-6  | When `health.daemon.status === 'stopped'` (offline flag from SPEC-036-2-04 FR-8), the fragment MUST render a single muted line "Daemon offline" instead of the recentLog body.                                                                          | T8   |
| FR-7  | The fragment MUST emit `id="log-tail"` so SSE OOB swaps on the `ops:log` channel append new lines. Server-side, the route handler MUST trim the rendered list to last 200 entries before each emit (mitigates DOM-growth risk).                          | T8   |
| FR-8  | The fragment file MUST carry a top-of-file comment whitelisting the `#14130f` literal: `/* lint:no-hex-allow #14130f — theme-defying log container per TDD-036 §6.4 */`. The CI no-hex lint MUST honor this whitelist marker.                            | T8   |
| FR-9  | Tabular display: each line uses CSS grid `grid-template-columns: 11ch 6ch 1fr` (timestamp, level, message). Mono font from token set; 12px line size from token set.                                                                                     | T8   |
| FR-10 | Agent-dispatch lines (matching `^agent .* (dispatched|finished)`) MUST receive an additional `marker` class for the `--brand` bold treatment.                                                                                                            | T8   |

## 3. Acceptance Criteria

```
Given recentLog = 50 entries with mixed INFO/WARN/ERROR/DEBUG levels
When the fragment renders
Then DEBUG entries are absent from the output
And INFO/WARN/ERROR entries render with their token-colored level spans
And the container has style background #14130f and max-height 320px
And the container has id="log-tail"
```

```
Given recentLog includes "agent prd-author@1.0.0 dispatched"
When the fragment renders
Then that line has class containing "marker"
And the level/message spans resolve to var(--brand)
And font-weight is bold
```

```
Given recentLog = [] AND daemon.status === 'running'
When the fragment renders
Then the single line "No log entries yet" renders inside the dark block

Given daemon.status === 'stopped'
When the fragment renders
Then the single line "Daemon offline" renders (overrides recentLog body)
```

## 4. Implementation Notes

- File: `server/templates/fragments/live-log.tsx`. The whitelist comment lives at line 1.
- Source data: server reads tail of `~/.autonomous-dev/logs/daemon.log` (last 50 INFO/WARN/ERROR entries) into `recentLog` before rendering. File-read errors degrade to the empty state, not a crash.
- Server-side trim to last 200 before SSE emit lives in the route handler (SPEC-036-2-04), not the fragment.
- Per PLAN-036-2 Risks, an alternative was a `--log-bg` token in `colors_and_type.css`. We pin to the inline whitelist for now since TDD-034 lints already ship with whitelist comment support; revisit if the kit evolves.
- Do not add client-side JS for auto-scroll — `scroll-behavior: smooth` plus the `id="log-tail"` SSE swap is sufficient.

## 5. Tests

- **Unit**: `tests/unit/live-log.test.ts` — fixture entries cover mixed levels, agent-dispatch markers, DEBUG filtering, empty state, daemon-offline state.
- **Lint**: CI no-hex check parses the whitelist comment and allows `#14130f` only inside `live-log.tsx`. A second-file `#14130f` literal MUST fail the lint (regression test for the whitelist scope).
- **Integration**: rolled into `tests/integration/ops.test.ts` — assert `#log-tail` present, `marker` class present on dispatch line, `Daemon offline` text in offline variant.

## 6. Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/live-log.test.ts` passes all fixtures.
- CI no-hex lint passes (whitelist honored); a planted second-file `#14130f` is correctly rejected.
- Manual: `bun run dev`, visit `/ops`, watch SSE-driven log updates append + scroll; toggle daemon stub to verify offline path.
