# SPEC-034-2-05: Voice and Copy Sweep — 31 Portal Templates

## Metadata
- **Parent Plan**: PLAN-034-2 (CI Lint Gates and Voice/Copy Sweep)
- **Parent TDD**: TDD-034 (Portal Redesign Foundations) — §5.6 (R-22, R-23)
- **Parent PRD**: PRD-018 (Portal Visual Redesign)
- **Estimated effort**: 1 day
- **Dependencies**: PLAN-034-1 (token migration so font-mono token exists), SPEC-034-2-02 (`lint-no-emoji.sh` script must exist so post-sweep verification has a tool)
- **Priority**: P1
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-034-2-05-voice-sweep.md`

## Objective

Sweep all 31 `.tsx` files under `plugins/autonomous-dev-portal/server/templates/` in a single reviewable commit applying TDD-034 §5.6 content fundamentals: sentence-case headings, no exclamation marks, no emoji, mono wrapping for IDs / status / timestamps, costs to two decimals, ISO timestamps in tables, and replacement of ad-hoc strings with kit canonical strings. No logic changes — string and class-assignment edits only.

## Acceptance Criteria

- AC-01: All 31 `.tsx` files under `server/templates/` have been touched by the sweep commit (verifiable via `git diff --stat HEAD~1 -- 'plugins/autonomous-dev-portal/server/templates/**/*.tsx'` showing 31 file rows, even if some show only +0/-0 because the file was already compliant — explicitly note such files in the commit body).
- AC-02: `bash plugins/autonomous-dev-portal/scripts/lint-no-emoji.sh` exits 0 against the post-sweep tree.
- AC-03: `git grep -nE '"Daemon is running"|"No requests found"|"Kill switch is currently engaged"|"Error loading data"' plugins/autonomous-dev-portal/server/templates/` returns zero matches.
- AC-04: `git grep -nE '"Daemon running"|"No active requests"|"Failed to load data"' plugins/autonomous-dev-portal/server/templates/` returns at least one match each (canonical replacements landed).
- AC-05: `git grep -nE '!"|!</' plugins/autonomous-dev-portal/server/templates/` returns zero matches inside JSX text nodes (no exclamation marks in user-facing strings).
- AC-06: Every `REQ-*` and `RUN-*` ID rendering in templates is wrapped in `<code>` or `<span class="mono">` (verified by `git grep -nE '\\bREQ-' templates/` showing each match adjacent to a `<code>` or `mono` class).
- AC-07: Status words `RUNNING`, `ENGAGED`, `TRIPPED` rendered as text are wrapped in `<code>` or `<span class="mono">`.
- AC-08: Cost renderings use `.toFixed(2)` (verified by `git grep -nE '\\$\\{[^}]*cost[^}]*\\}' templates/` — every match contains `.toFixed(2)`).
- AC-09: ISO timestamps in `<table>` cells use compact form `YYYY-MM-DD HH:mm:ssZ`; relative timestamps (`3 min ago`) appear only in non-table prose.
- AC-10: Kill-switch engaged copy is `"Kill switch ENGAGED at <ISO>. All daemon processing will halt."` with the ISO injected from the existing template variable (no hardcoded date).
- AC-11: Existing portal test suite (`bun test plugins/autonomous-dev-portal/`) runs and any test breakage is isolated to user-facing string assertions; logic-level tests pass unchanged.
- AC-12: The sweep is a single commit (per TDD-034 §5.6 "single commit"); commit body lists the seven rules applied and the canonical replacements.

## Implementation

Files:
- All 31 `.tsx` files under `plugins/autonomous-dev-portal/server/templates/`. Enumerate via `find plugins/autonomous-dev-portal/server/templates -name '*.tsx' | sort` at sweep start; pin the count to confirm 31.

Steps:
1. **Inventory pass** — for each of the 31 files, scan user-facing strings and record (file, line, current text, rules violated). Output is a working changelog (not committed) that drives the apply pass.
2. **Apply pass** — in a single commit, for each file:
   - Rewrite headings/labels to sentence case (proper nouns excepted: `Kill Switch` stays).
   - Remove exclamation marks from JSX text.
   - Remove emoji (replace with `.dot` primitive or text status badge).
   - Wrap IDs (`REQ-*`, `RUN-*`), status words, and timestamps in `<code>` or `<span class="mono">`.
   - Convert cost rendering to `${(cost).toFixed(2)}`.
   - Convert table-cell timestamps to ISO compact format (use the existing date helper or inline `toISOString().replace('T',' ').slice(0,19)+'Z'`).
   - Replace ad-hoc strings with canonicals: `"Daemon is running"` → `"Daemon running"`, `"No requests found"` → `"No active requests"`, `"Kill switch is currently engaged"` → `"Kill switch ENGAGED at ${iso}. All daemon processing will halt."`, `"Error loading data"` → `"Failed to load data"`.
3. Run `bash plugins/autonomous-dev-portal/scripts/lint-no-emoji.sh` and confirm exit 0.
4. Run `bun test plugins/autonomous-dev-portal/` and address any user-facing-string assertion breakage in the sweep commit (string assertions get updated to match new copy; do NOT loosen logic assertions).
5. Open a PR with the diff fully visible (no squashed file moves) so review is line-by-line.

## Tests

- Existing portal suite must run; assertion breakage limited to copy strings (update assertion strings, not logic).
- Manual review: PR reviewer reads every changed string and confirms each satisfies §5.6 rules.
- `lint-no-emoji.sh` exits 0 (mechanical post-condition).

## Verification

```bash
find plugins/autonomous-dev-portal/server/templates -name '*.tsx' | wc -l        # prints 31
bash plugins/autonomous-dev-portal/scripts/lint-no-emoji.sh                       # exits 0
git grep -nE '"Daemon is running"|"No requests found"|"Error loading data"' \
  plugins/autonomous-dev-portal/server/templates/                                 # zero matches
git grep -nE '"Daemon running"|"No active requests"|"Failed to load data"' \
  plugins/autonomous-dev-portal/server/templates/                                 # >= 1 match each
bun test plugins/autonomous-dev-portal/                                           # all logic tests pass
```
