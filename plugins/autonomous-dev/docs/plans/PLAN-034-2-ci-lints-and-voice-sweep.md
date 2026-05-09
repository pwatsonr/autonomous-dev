# PLAN-034-2: CI Lint Gates (Tokens / Emoji / Box-Shadow) and Voice/Copy Sweep

## Metadata
- **Parent TDD**: TDD-034-portal-redesign-foundations
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 3 days
- **Dependencies**: ["PLAN-034-1"]
- **Blocked by**: ["PLAN-034-1"]
- **Priority**: P1
- **Stage**: TDD-034 §8 Phase 4 (CI lint gates) + Phase 5 (voice/copy sweep)

## Objective

Lock in the token-only discipline established by PLAN-034-1 with three merge-blocking
CI lint scripts (no untokened hex / font-family / px in non-token CSS, no untokened
`box-shadow` declarations, no emoji in `.tsx` templates), and execute the one-shot
content-fundamentals sweep across all 31 portal templates -- replacing ad-hoc
copy with kit canonical strings, normalizing IDs/timestamps to mono, and converting
sentence-case headings. After this plan lands, regressions on token discipline and
voice fundamentals are caught at PR time, not in review.

## Scope

### In Scope
- `plugins/autonomous-dev-portal/scripts/lint-css-tokens.sh` -- M-01 enforcement: hex literals, hardcoded `font-family`, hardcoded `px` in non-token CSS (TDD-034 §5.8). Hex regex `#[0-9][0-9a-fA-F]{2,7}\b` per §5.8 rationale; `1px` and structural dimensions (`max-width` etc.) allowlisted.
- `plugins/autonomous-dev-portal/scripts/lint-box-shadow.sh` -- R-15a enforcement: `box-shadow:` declarations in non-token CSS must reference `var(--shadow-*)` (TDD-034 §5.5).
- `plugins/autonomous-dev-portal/scripts/lint-no-emoji.sh` -- M-05 enforcement: emoji codepoints (`U+1F300-U+1F9FF`, `U+2600-U+26FF`, `U+2700-U+27BF`, `U+FE00-U+FE0F`, `U+1F1E0-U+1F1FF`, ZWJ, keycap range, tag range) in `server/templates/**/*.tsx` (TDD-034 §5.9).
- CI workflow update (`.github/workflows/portal-ci.yml` or equivalent) -- run all three scripts as merge-blocking jobs, conditionally triggered on PRs touching `plugins/autonomous-dev-portal/server/static/*.css`, `plugins/autonomous-dev-portal/src/styles/**`, or `plugins/autonomous-dev-portal/server/templates/**`.
- Voice/copy sweep across all 31 `.tsx` files under `plugins/autonomous-dev-portal/server/templates/` (TDD-034 §5.6) -- single commit applying the seven content-fundamentals rules and the canonical-string replacements (R-22, R-23).
- `plugins/autonomous-dev-portal/scripts/README.md` (or equivalent) -- short reference documenting how to run each lint locally and the allowlist rationale.

### Out of Scope
- Phase contrast verification (M-02) and theme parity (M-06) -- PLAN-034-3.
- New canonical strings beyond the kit's documented set -- product owner sign-off out of scope (TDD-034 OI-3402).
- Pre-commit hook installation -- TDD-034 §6 row 3 chose CI-only enforcement; pre-commit deferred.
- Migration of any non-portal CSS or template tree -- scope is the portal plugin only.
- Visual regression / screenshot infrastructure -- TDD-035.

## Work Breakdown

1. **Author `lint-css-tokens.sh`** (TDD-034 §5.8) -- bash script that scans `server/static/*.css` and `src/styles/**/*.css` (excluding `design-tokens.css`) for: (a) hex color literals matching `#[0-9][0-9a-fA-F]{2,7}\b` outside `var()`/`url()`/comments, (b) `font-family:` declarations not containing `var(--font-`, (c) `(font-size|padding|margin|gap|border-radius)` declarations with `[0-9]+px` outside `var()` and outside the `0px`/`1px` allowlist. Exit 1 with line-number diagnostics on any hit. Acceptance: runs against PLAN-034-1's migrated CSS with zero hits; an intentionally seeded test fixture (a CSS file containing `color: #ff0000`) triggers exit 1 with the line number.
2. **Author `lint-box-shadow.sh`** (TDD-034 §5.5) -- scan the same CSS set, fail on any `box-shadow:` line that does not contain `var(--shadow-`. Allowlist: `design-tokens.css` itself (defines the shadow tokens). Acceptance: fixture `box-shadow: 0 2px 4px black;` triggers exit 1; fixture `box-shadow: var(--shadow-1);` passes.
3. **Author `lint-no-emoji.sh`** (TDD-034 §5.9) -- `grep -P` against the 7 Unicode ranges from §5.6 rule 2 across `server/templates/**/*.tsx`, exit 1 on any hit. Skip `//` and `*` comment-only lines. Acceptance: a fixture `.tsx` containing `<span>OK ✅</span>` triggers exit 1; a clean file passes.
4. **Wire all three scripts into CI** -- add a `portal-lint` job to the portal CI workflow that runs the three scripts in sequence; condition the job on path-filter matches for `server/static/*.css`, `src/styles/**`, `server/templates/**`. Acceptance: a deliberately broken PR (hex injected into a portal CSS file) fails the `portal-lint` job before merge.
5. **Voice/copy sweep -- inventory pass** (TDD-034 §5.6) -- enumerate every user-facing string across the 31 `.tsx` templates. Capture: file path, line, current string, rule violations (sentence case, emoji, exclamation, ID-not-mono, cost-not-2dp, non-ISO-timestamp, ad-hoc-vs-canonical). Output: a working changelog (not committed) used to drive task 6. Acceptance: every template scanned; reviewer can spot-check the inventory against any one template.
6. **Voice/copy sweep -- apply pass** (TDD-034 §5.6 rules 1-7 + canonical-string list) -- single commit replacing strings, wrapping IDs/status/timestamps in `<code>` or `<span class="mono">`, fixing cost rendering to `.toFixed(2)`, swapping ad-hoc strings for kit canonicals (`"Daemon is running"` → `"Daemon running"`, `"No requests found"` → `"No active requests"`, `"Kill switch is currently engaged"` → `"Kill switch ENGAGED at <ISO>. All daemon processing will halt."`, `"Error loading data"` → `"Failed to load data"`). Acceptance: `lint-no-emoji.sh` exits 0 on the post-sweep tree; PR reviewer confirms the diff is string-only (no logic changes).
7. **Author `scripts/README.md`** -- one-page reference: how to run each lint locally (`bash scripts/lint-css-tokens.sh`), what each enforces, the allowlist rationale (1px borders, `0px` resets, structural dimensions). Acceptance: a developer who has not seen TDD-034 can run the lints from the README alone.

## Verification

- **M-01 lint**: seeded fixture `tests/fixtures/lint/bad-hex.css` containing `color: #ff0000;` triggers exit 1; `tests/fixtures/lint/bad-font.css` (`font-family: Arial;`) triggers exit 1; `tests/fixtures/lint/bad-px.css` (`font-size: 17px;`) triggers exit 1; clean fixture passes.
- **R-15a lint**: fixture `tests/fixtures/lint/bad-shadow.css` (`box-shadow: 0 2px 4px black;`) triggers exit 1; fixture `tests/fixtures/lint/good-shadow.css` (`box-shadow: var(--shadow-1);`) passes.
- **M-05 lint**: fixture `tests/fixtures/lint/bad-emoji.tsx` (containing a checkmark emoji) triggers exit 1; fixture without emoji passes.
- **CI integration**: a deliberately broken PR (hex literal injected into `src/styles/components.css`) fails CI on the `portal-lint` job.
- **Voice sweep (R-22, R-23)**: post-sweep `grep` for `"Daemon is running"`, `"No requests found"`, `"Kill switch is currently engaged"`, `"Error loading data"` returns zero matches; canonical replacements are present; `lint-no-emoji.sh` is clean across all 31 templates.

## Test Plan

- **Unit (lint scripts)**: each lint has paired good/bad fixtures under `plugins/autonomous-dev-portal/tests/fixtures/lint/`; a bats or shell-test driver asserts exit code 0 vs. 1.
- **CI**: the three lints are wired into the merge-blocking job per task 4. CI dry-run on a draft PR confirms the `portal-lint` job runs and fails on seeded violations.
- **Manual review (voice sweep)**: PR reviewer reads every changed string in the diff and confirms each follows the §5.6 rules. Non-trivial casing decisions (e.g., `TRIPPED` vs `tripped` in inline prose) are flagged for product owner per OI-3402.
- **Regression**: existing portal test suite runs unchanged after the sweep -- string replacements are template-literal swaps, no logic affected.

## Rollback

- Each lint script and its CI wiring is one commit; revert the wiring commit to disable enforcement without losing the scripts.
- The voice sweep is one commit (per TDD-034 §5.6 "single commit"); revert restores the prior strings if a canonical replacement caused a stakeholder concern.
- No DB or config changes; rollback is purely git.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Lint regex false-positives block legitimate work | Medium | Medium -- developer friction | Each script has a documented allowlist (1px borders, `0px`, structural dims, `var()`/`url()`/comments). README task 7 captures escape hatches. Reviewer can override via `# noqa` line comment if absolutely needed (but no override is added in this plan -- earn it). |
| Hex regex `#[0-9]...` lets through `#fff`/`#aaa` shorthand starting with a letter | Low | Low | Per TDD-034 §5.8 rationale, post-migration the only such literals would live in `design-tokens.css` (already excluded). PR reviewer is the second line if a stray letter-prefixed hex appears. |
| Emoji lint regex misses a Unicode range and an emoji slips through | Medium | Low | Ranges from §5.6 rule 2 cover the common emoji blocks plus ZWJ + variation selectors + tag chars. If a missed range is reported, add it in a follow-up; not critical-path. |
| Voice sweep hits a string the operator depends on programmatically (e.g., a `aria-label` selector in a test) | Medium | Medium -- breaks an integration test | Sweep is one commit, reviewable line-by-line. CI runs the existing suite before merge; any test break surfaces immediately. |
| Canonical string for `Kill switch ENGAGED at <ISO>...` requires runtime ISO timestamp injection | Low | Low | Existing kill-switch template already renders an ISO timestamp; sweep wraps it in the new copy. If the template lacks the timestamp, fall back to the kit canonical for the engaged-without-time case (deferred to OI-3402 if ambiguous). |
| Casing edge cases (`TRIPPED` vs `tripped`) need product owner sign-off | Medium | Low -- one-shot decision | Track in OI-3402 per TDD-034; sweep applies the design-system default (UPPERCASE for status badges, sentence case for prose). Reviewer raises any ambiguity for product owner before merge. |
