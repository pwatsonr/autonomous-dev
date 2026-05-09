# SPEC-034-2-03: Lint Box-Shadow Tokenization

## Metadata
- **Parent Plan**: PLAN-034-2 (CI Lint Gates and Voice/Copy Sweep)
- **Parent TDD**: TDD-034 (Portal Redesign Foundations) — §5.5 (R-15a)
- **Parent PRD**: PRD-018 (Portal Visual Redesign)
- **Estimated effort**: 2 hours
- **Dependencies**: PLAN-034-1 (CSS migration must already use `var(--shadow-*)` so the lint runs clean on day one)
- **Priority**: P1
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-034-2-03-lint-box-shadow.md`

## Objective

Author `plugins/autonomous-dev-portal/scripts/lint-box-shadow.sh` to enforce R-15a — every `box-shadow:` declaration in non-token CSS must reference a `var(--shadow-*)` token. The portal's elevation system (Level 0/1/2/Pop) is defined exclusively via shadow tokens; raw shadow values bypass the system and are rejected at PR time.

## Acceptance Criteria

- AC-01: File `plugins/autonomous-dev-portal/scripts/lint-box-shadow.sh` exists, is `chmod +x`, has `set -euo pipefail` and a `#!/usr/bin/env bash` shebang.
- AC-02: Script scans `server/static/*.css` and `src/styles/**/*.css`, excluding `design-tokens.css` (which defines the shadow tokens themselves).
- AC-03: Match logic: `grep -n 'box-shadow' "$file" | grep -v 'var(--shadow-' | grep -v '^\s*/\*' | grep -v '^\s*\*'` — any non-empty result is a violation.
- AC-04: Fixture `tests/fixtures/lint/bad-shadow.css` (`.bad { box-shadow: 0 2px 4px black; }`) exits 1 with the line number.
- AC-05: Fixture `tests/fixtures/lint/good-shadow.css` (`.good { box-shadow: var(--shadow-1); }`) exits 0.
- AC-06: Multi-line `box-shadow:` declarations (where the value continues on the next line) are NOT a known case in the portal CSS today; if encountered, the lint flags them — fix the source by collapsing to one line per AC-03's grep semantics.
- AC-07: Running against the post-PLAN-034-1 portal CSS tree exits 0.

## Implementation

Files:
- `plugins/autonomous-dev-portal/scripts/lint-box-shadow.sh` — new script, body per TDD-034 §5.5.
- `plugins/autonomous-dev-portal/tests/fixtures/lint/bad-shadow.css` — see AC-04.
- `plugins/autonomous-dev-portal/tests/fixtures/lint/good-shadow.css` — see AC-05.

Steps:
1. Copy script body verbatim from TDD-034 §5.5 into `lint-box-shadow.sh`. `chmod +x`.
2. Add `--scan-file <path>` override flag for fixture-driven testing (consistent with SPEC-034-2-01/02).
3. Write the two fixture files.
4. Add shell-test driver `tests/lint/test-lint-box-shadow.sh` asserting exit codes 0/1 for each fixture and 0 for full repo scan.

## Tests

- `tests/lint/test-lint-box-shadow.sh` — paired good/bad fixtures.

## Verification

```bash
bash plugins/autonomous-dev-portal/scripts/lint-box-shadow.sh                       # exits 0
bash plugins/autonomous-dev-portal/scripts/lint-box-shadow.sh \
  --scan-file plugins/autonomous-dev-portal/tests/fixtures/lint/bad-shadow.css      # exits 1
bash plugins/autonomous-dev-portal/scripts/lint-box-shadow.sh \
  --scan-file plugins/autonomous-dev-portal/tests/fixtures/lint/good-shadow.css     # exits 0
bash plugins/autonomous-dev-portal/tests/lint/test-lint-box-shadow.sh               # exits 0
```
