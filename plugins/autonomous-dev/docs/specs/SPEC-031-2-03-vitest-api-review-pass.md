# SPEC-031-2-03: Secondary `\bvi\.` API Review Pass

## Metadata
- **Parent Plan**: PLAN-031-2 (vitest → jest sweep)
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats (§5.2, OQ-31-05)
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1651)
- **Tasks Covered**: PLAN-031-2 task 4 (`\bvi\.` review and per-hit decision)
- **SPECs amended by this spec**: 0–5 SPECs (typically TDD-022 / TDD-024 children)
- **Estimated effort**: 30–60 minutes (depends on hit count; ~5 min per hit)
- **Status**: Draft
- **Depends on**: SPEC-031-2-02 (vitest token sweep already applied; remaining `vi.*` refs are residual)

## Summary
After the SPEC-031-2-02 token sweep, some SPECs still reference Vitest-specific
APIs (`vi.fn()`, `vi.mock()`, `vi.spyOn()`, etc.) without using the bare
`vitest` token. This spec runs a secondary scan for `\bvi\.` and, for each
hit, either renames the API to its Jest equivalent (case (a)) or records an
Open Question OQ-31-05 (case (b)) when no clean equivalent exists.

## Functional Requirements

- **FR-1**: A secondary scan MUST run `grep -rln "\bvi\." plugins/autonomous-dev/docs/specs/`
  and capture the file list. Task: PLAN-031-2 task 4.
- **FR-2**: For each match, the SPEC text around the hit MUST be classified:
  - **Case (a)** — clean Jest rename: applies to one of the supported
    bidirectional pairs:
    | Vitest | Jest |
    |--------|------|
    | `vi.fn()` | `jest.fn()` |
    | `vi.mock(` | `jest.mock(` |
    | `vi.unmock(` | `jest.unmock(` |
    | `vi.spyOn(` | `jest.spyOn(` |
    | `vi.useFakeTimers(` | `jest.useFakeTimers(` |
    | `vi.useRealTimers(` | `jest.useRealTimers(` |
    | `vi.clearAllMocks(` | `jest.clearAllMocks(` |
    | `vi.resetAllMocks(` | `jest.resetAllMocks(` |
    | `vi.restoreAllMocks(` | `jest.restoreAllMocks(` |
    | `vi.advanceTimersByTime(` | `jest.advanceTimersByTime(` |
  - **Case (b)** — no clean Jest equivalent: e.g., `vi.hoisted(`,
    `vi.importActual(`, `vi.importMock(`. Reference is left intact;
    matrix Notes column flags as OQ-31-05 follow-up.
- **FR-3**: Case (a) renames MUST be applied by hand (not via global sed)
  because the surrounding code-fence context determines whether a rename
  preserves the SPEC's intent. Each rename is a single-file edit.
- **FR-4**: Every `\bvi\.` hit (in non-carve-out SPECs) MUST be either
  renamed under FR-3 OR recorded as case (b) in the matrix. No untouched,
  unrecorded hits may remain.
- **FR-5**: After this spec, `grep -rln "\bvi\." plugins/autonomous-dev/docs/specs/`
  MUST return ONLY hits that are either:
  - inside a SPEC-031-2-01 historical-context carve-out, OR
  - declared as OQ-31-05 case (b) in the matrix preamble whitelist.

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|-------------|--------|---------------------|
| Per-hit accountability | Every `\bvi\.` match has a recorded disposition (rename, OQ-31-05, or carve-out) | Compare grep hit count to matrix entries |
| Rename correctness | `vi.X(` always becomes `jest.X(` (paren preserved) | Spot-check renames; no `vi.X)` without paren |
| No accidental over-substitution | Strings like `via.fn()` or `videofeed.X` are unaffected | Word-boundary anchored grep + manual review |

## Patterns to Find/Replace

**Find pattern**: `\bvi\.` (regex; matches the literal `vi.` only when
preceded by a non-word character or start-of-string)

**Replacement table** (case (a) only; applied per-file, not globally):

| Find | Replace |
|------|---------|
| `vi.fn(` | `jest.fn(` |
| `vi.mock(` | `jest.mock(` |
| `vi.unmock(` | `jest.unmock(` |
| `vi.spyOn(` | `jest.spyOn(` |
| `vi.useFakeTimers(` | `jest.useFakeTimers(` |
| `vi.useRealTimers(` | `jest.useRealTimers(` |
| `vi.clearAllMocks(` | `jest.clearAllMocks(` |
| `vi.resetAllMocks(` | `jest.resetAllMocks(` |
| `vi.restoreAllMocks(` | `jest.restoreAllMocks(` |
| `vi.advanceTimersByTime(` | `jest.advanceTimersByTime(` |

**Case (b) — leave intact**: any `vi.<name>(` not in the table above (e.g.,
`vi.hoisted(`, `vi.importActual(`, `vi.stubGlobal(`).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/docs/specs/*.md` (variable subset) | Modify | Per-file hand-edits where case (a) renames apply |
| `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` | Modify | Add OQ-31-05 whitelist subsection under the Vitest section preamble |

## Verification Commands

```bash
# 1. Pre-spec scan (capture baseline hit list)
grep -rln "\bvi\." plugins/autonomous-dev/docs/specs/ | sort | tee /tmp/vi-api-baseline.txt

# 2. Per-hit context inspection
for f in $(cat /tmp/vi-api-baseline.txt); do
  echo "=== $f ==="
  grep -nE "\bvi\." "$f"
done

# 3. After per-file edits, residual hits must match the OQ-31-05 whitelist
grep -rln "\bvi\." plugins/autonomous-dev/docs/specs/ | sort > /tmp/vi-api-residual.txt
diff /tmp/vi-api-residual.txt <(awk '/OQ-31-05 whitelist/,/^---$/' \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -oE "SPEC-[0-9-]+\.md" | sort -u)

# 4. No `\bvi\.` in any rename-target file
# (after edit, the file should have `jest.` not `vi.` for the renamed API)
```

## Acceptance Criteria

```
Given the SPEC corpus after SPEC-031-2-02's token sweep
When `grep -rln "\bvi\."` runs against plugins/autonomous-dev/docs/specs/
Then a list of hit files is captured
And each hit is inspected for context
```

```
Given a `\bvi\.` match that maps to a known Jest equivalent in the rename table
When the SPEC is hand-edited
Then the `vi.X(` is replaced with `jest.X(`
And the parenthesis and surrounding code-fence formatting are preserved
And no other text in the SPEC is modified
```

```
Given a `\bvi\.` match has no clean Jest equivalent (e.g., `vi.hoisted(`)
When classification is performed
Then the SPEC is recorded as OQ-31-05 case (b) in the matrix preamble whitelist
And the SPEC text is NOT modified
And a Notes annotation in the corresponding row in SPEC-031-2-04's matrix table flags the OQ-31-05 follow-up
```

```
Given all per-hit decisions are made
When the post-pass grep runs
Then `grep -rln "\bvi\." plugins/autonomous-dev/docs/specs/` returns only:
  - SPECs in SPEC-031-2-01's historical-context carve-out list, OR
  - SPECs declared in the OQ-31-05 whitelist subsection of the matrix
And no other file matches
```

```
Given a SPEC contains a string like `via.fn()` or `videofeed`
When the `\bvi\.` grep runs
Then those strings do NOT match (word-boundary anchor prevents false positives)
And no edits are applied to those occurrences
```

## Rollback Plan

```bash
git checkout -- plugins/autonomous-dev/docs/specs/    # discard per-file rename edits
git checkout -- plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md
```

If committed via SPEC-031-2-04 and a problem surfaces, revert the SPEC-031-2-04
commit. The token-sweep changes from SPEC-031-2-02 remain in place.

## Implementation Notes

- The `\b` anchor in BSD grep can behave inconsistently. If `grep -E "\bvi\."`
  fails on macOS, fall back to:
  `grep -E "(^|[^[:alnum:]_])vi\." -rn plugins/autonomous-dev/docs/specs/`
  Document the fallback in the matrix preamble.
- This spec is **manual per-file work**. Do not run a global sed across all
  hits — context matters (e.g., `vi.fn()` inside a code fence may need
  different formatting than the same token in prose).
- The rename table is conservative. New `vi.*` APIs that match Jest 1:1
  (e.g., a hypothetical `vi.somethingNew(`) are added to the table by
  amending this spec, not by case-by-case improvisation.
- Case (b) is rare in SPEC prose (which describes tests, not implements
  them). If more than ~3 case (b) hits surface, pause and re-read TDD §5.2
  — the cohort is likely smaller than expected.
- The OQ-31-05 follow-ups are intentionally NOT auto-resolved here. They
  represent SPECs whose intent is genuinely Vitest-coupled; resolving them
  may require SPEC-rewrite PRs or TDD amendments out of TDD-031's scope.

## Out of Scope

- The bare `vitest` token sweep (SPEC-031-2-02).
- Hand-amendment of historical-context carve-outs (SPEC-031-2-04).
- Matrix row population per amended SPEC (SPEC-031-2-04).
- Committing the changes (SPEC-031-2-04).
- Authoring SPEC-rewrite or TDD-amendment PRs to resolve OQ-31-05 cases.
- Modifying `.test.ts` / `.spec.ts` files.
- Production code changes.
