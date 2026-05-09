# SPEC-034-2-01: Lint CSS Tokens (hex / font-family / px)

## Metadata
- **Parent Plan**: PLAN-034-2 (CI Lint Gates and Voice/Copy Sweep)
- **Parent TDD**: TDD-034 (Portal Redesign Foundations) — §5.8 (M-01)
- **Parent PRD**: PRD-018 (Portal Visual Redesign)
- **Estimated effort**: 3 hours
- **Dependencies**: PLAN-034-1 (token migration must already be merged so the lint runs clean on day one)
- **Priority**: P1
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-034-2-01-lint-css-tokens.md`

## Objective

Author `plugins/autonomous-dev-portal/scripts/lint-css-tokens.sh` to enforce M-01 — reject hex color literals, hardcoded `font-family`, and hardcoded `px` sizes in non-token CSS. The script scans `server/static/*.css` and `src/styles/**/*.css`, excludes `design-tokens.css`, and exits non-zero with line-numbered diagnostics on any hit. Once landed and wired by SPEC-034-2-04, no PR can merge a token-discipline regression in portal CSS.

## Acceptance Criteria

- AC-01: File `plugins/autonomous-dev-portal/scripts/lint-css-tokens.sh` exists, is `chmod +x`, has `set -euo pipefail` and a `#!/usr/bin/env bash` shebang.
- AC-02: Hex check uses regex `#[0-9][0-9a-fA-F]{2,7}\b` (per TDD-034 §5.8 v1.1 fix — first char after `#` must be a digit so CSS ID selectors `#main`/`#sidebar` are never false-positives).
- AC-03: Font-family check rejects any `font-family:` declaration that does not contain `var(--font-`.
- AC-04: Px check rejects `[0-9]+px` in `(font-size|padding|margin|gap|border-radius)` declarations, with a `\b[01]px\b` allowlist (border hairlines, `0px` resets) and `var(--*` allowlist; structural dims (`max-width`, `min-width`, `width`, `height`) are not scanned.
- AC-05: All three checks skip lines beginning with `/*` or `*` (CSS comments) and lines containing `var(--`.
- AC-06: Fixture `tests/fixtures/lint/bad-hex.css` containing `color: #ff0000;` triggers exit 1 with the line number printed; `bad-font.css` (`font-family: Arial;`) and `bad-px.css` (`font-size: 17px;`) likewise exit 1.
- AC-07: Fixture `tests/fixtures/lint/clean.css` (only `var(--*)` references and `1px solid var(--line-1)`) exits 0.
- AC-08: Running the script against the post-PLAN-034-1 portal CSS tree exits 0 (no real-codebase regressions caused by the lint itself).

## Implementation

Files:
- `plugins/autonomous-dev-portal/scripts/lint-css-tokens.sh` — new script, body per TDD-034 §5.8.
- `plugins/autonomous-dev-portal/tests/fixtures/lint/bad-hex.css` — `.bad { color: #ff0000; }`
- `plugins/autonomous-dev-portal/tests/fixtures/lint/bad-font.css` — `.bad { font-family: Arial; }`
- `plugins/autonomous-dev-portal/tests/fixtures/lint/bad-px.css` — `.bad { font-size: 17px; }`
- `plugins/autonomous-dev-portal/tests/fixtures/lint/clean.css` — clean reference using only tokens.

Steps:
1. Copy the script body verbatim from TDD-034 §5.8 into `lint-css-tokens.sh`. `chmod +x`.
2. Compute `PORTAL_DIR` as `$(cd "$(dirname "$0")/.." && pwd)`; scan `server/static/*.css` and `src/styles/**/*.css` excluding `design-tokens.css`.
3. Write the four fixture files. They live under `tests/fixtures/lint/` so the lint's normal scan path does NOT include them.
4. Add a tiny shell-test driver `tests/lint/test-lint-css-tokens.sh` that invokes the script with each fixture path forwarded via a `--scan-file <path>` flag (extend the script to accept an override scan list when `--scan-file` is passed; otherwise fall back to the default tree).
5. No production-code changes; no template changes.

## Tests

- Shell-test driver `tests/lint/test-lint-css-tokens.sh`: asserts `bad-hex.css`, `bad-font.css`, `bad-px.css` each exit 1; `clean.css` exits 0; full repo scan exits 0.
- Drive via `bash tests/lint/test-lint-css-tokens.sh`.

## Verification

```bash
bash plugins/autonomous-dev-portal/scripts/lint-css-tokens.sh                    # exits 0
bash plugins/autonomous-dev-portal/scripts/lint-css-tokens.sh \
  --scan-file plugins/autonomous-dev-portal/tests/fixtures/lint/bad-hex.css     # exits 1
bash plugins/autonomous-dev-portal/tests/lint/test-lint-css-tokens.sh           # exits 0
```
