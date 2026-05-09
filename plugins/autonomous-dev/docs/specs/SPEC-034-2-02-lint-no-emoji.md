# SPEC-034-2-02: Lint No Emoji in Portal Templates

## Metadata
- **Parent Plan**: PLAN-034-2 (CI Lint Gates and Voice/Copy Sweep)
- **Parent TDD**: TDD-034 (Portal Redesign Foundations) — §5.9 (M-05), §5.6 rule 2
- **Parent PRD**: PRD-018 (Portal Visual Redesign)
- **Estimated effort**: 2 hours
- **Dependencies**: none (lint can land before sweep; SPEC-034-2-05 sweep clears any pre-existing hits before SPEC-034-2-04 wires it as merge-blocking)
- **Priority**: P1
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-034-2-02-lint-no-emoji.md`

## Objective

Author `plugins/autonomous-dev-portal/scripts/lint-no-emoji.sh` to enforce M-05 — reject Unicode emoji codepoints in `server/templates/**/*.tsx` so the portal's deliberately text-only voice stays text-only. After SPEC-034-2-05 clears the existing tree and SPEC-034-2-04 wires this lint as merge-blocking, any future emoji introduction fails CI before merge.

## Acceptance Criteria

- AC-01: File `plugins/autonomous-dev-portal/scripts/lint-no-emoji.sh` exists, is `chmod +x`, has `set -euo pipefail` and a `#!/usr/bin/env bash` shebang.
- AC-02: Script uses `grep -Pn` against the Unicode ranges from TDD-034 §5.6 rule 2: `\x{1F300}-\x{1F9FF}`, `\x{2600}-\x{26FF}`, `\x{2700}-\x{27BF}`, `\x{FE00}-\x{FE0F}`, `\x{1F1E0}-\x{1F1FF}`, plus ZWJ (`\x{200D}`), keycap combiner (`\x{20E3}`), and tag chars (`\x{E0020}-\x{E007F}`).
- AC-03: Script skips lines beginning with `//` or `*` (TS/JSX comment lines).
- AC-04: Script scans `server/templates/**/*.tsx` via `find ... -name '*.tsx' -print0` and `read -r -d ''` to handle paths with spaces.
- AC-05: Fixture `tests/fixtures/lint/bad-emoji.tsx` containing `<span>OK ✅</span>` triggers exit 1 with the file path and matched line printed.
- AC-06: Fixture `tests/fixtures/lint/clean.tsx` (no emoji) exits 0.
- AC-07: Running against the post-SPEC-034-2-05 template tree exits 0.
- AC-08: Exit code is non-zero on any hit; zero otherwise.

## Implementation

Files:
- `plugins/autonomous-dev-portal/scripts/lint-no-emoji.sh` — new script, body per TDD-034 §5.9.
- `plugins/autonomous-dev-portal/tests/fixtures/lint/bad-emoji.tsx` — `export const X = () => <span>OK ✅</span>;`
- `plugins/autonomous-dev-portal/tests/fixtures/lint/clean.tsx` — `export const X = () => <span>OK</span>;`

Steps:
1. Copy script body verbatim from TDD-034 §5.9 into `lint-no-emoji.sh`. `chmod +x`.
2. Add `--scan-file <path>` override flag analogous to SPEC-034-2-01 so the test driver can target fixtures.
3. Write the two fixture `.tsx` files.
4. Add shell-test driver `tests/lint/test-lint-no-emoji.sh`: asserts `bad-emoji.tsx` exits 1, `clean.tsx` exits 0, full template scan exits 0 (post-sweep — gate this on SPEC-034-2-05).

## Tests

- `tests/lint/test-lint-no-emoji.sh` — paired good/bad fixtures; assert exit codes 0/1.

## Verification

```bash
bash plugins/autonomous-dev-portal/scripts/lint-no-emoji.sh                       # exits 0 after sweep
bash plugins/autonomous-dev-portal/scripts/lint-no-emoji.sh \
  --scan-file plugins/autonomous-dev-portal/tests/fixtures/lint/bad-emoji.tsx     # exits 1
bash plugins/autonomous-dev-portal/tests/lint/test-lint-no-emoji.sh               # exits 0
```
