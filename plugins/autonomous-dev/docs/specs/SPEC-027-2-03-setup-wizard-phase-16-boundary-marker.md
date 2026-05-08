# SPEC-027-2-03: Setup-Wizard Phase-16 Boundary Marker (`skills/setup-wizard/SKILL.md`)

## Metadata
- **Parent Plan**: PLAN-027-2
- **Parent TDD**: TDD-027 §4.3 (boundary marker shape), §6.3 (insertion point), §10.1 (well-formedness checks), §15 (TDD-033 coordination), G-05 (boundary contract goal)
- **Tasks Covered**: PLAN-027-2 Task 5 (insert boundary marker between phase 10 and phase 11), Task 6 (phase-16 contract self-consistency check)
- **Estimated effort**: 2.0 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-027-2-03-setup-wizard-phase-16-boundary-marker.md`
- **Depends on**: SPEC-027-2-02 (the `provides:` list references `cloud-prompt-tree.md` whose authoring is in SPEC-027-2-02). May land independently from SPEC-027-2-02 — the marker references the future filename and is forward-compatible.

## Summary
Insert a single HTML-comment block in `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` between the existing Phase 10 ("Verification and Next Steps") and the (TDD-033-owned) Phase 11. The block is the **machine-detectable phase-16 boundary marker** specified in TDD-027 §4.3: it declares `provides:` (content authored by TDD-027), `consumes:` (runtime checks owned by TDD-033), `runtime owner: TDD-033`, and `content owner: TDD-027`. The marker is invisible in rendered Markdown but `grep "PHASE-16 CONTRACT"` returns exactly 2 lines (BEGIN + END). Existing phases 1–10 remain byte-identical. The marker enables (a) the standards-meta-reviewer's well-formedness check (PLAN-021-3) and (b) TDD-033's runtime contract verification before invoking phase 16.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` | Modify | Insert one HTML-comment marker block (~15 lines) between the end of Phase 10's body and the existing "Error Handling (applies to all phases)" trailing block (or wherever Phase 10's body ends). Phases 1–10 byte-identical to `main`. |

## Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Insert exactly one boundary marker block in `SKILL.md`. | TDD-027 §4.3, §6.3 |
| FR-2 | The marker MUST begin with the verbatim line `<!-- BEGIN PHASE-16 CONTRACT (TDD-027 §6 ↔ TDD-033 §5) -->` and end with the verbatim line `<!-- END PHASE-16 CONTRACT -->`. | TDD-027 §4.3 |
| FR-3 | The marker block MUST contain a `provides:` list with at least 2 entries: `cloud-prompt-tree.md` (authored by SPEC-027-2-02) and `phase-16-content.md` (placeholder for forward-compatibility per TDD-027 §6.1). | TDD-027 §4.3, §6.1 |
| FR-4 | The marker block MUST contain a `consumes:` list with exactly the 3 runtime checks named in TDD-027 §4.3: (1) "are autonomous-dev-deploy-* plugins installed?", (2) "which firewall backend does this OS support?", (3) "is cred-proxy already bootstrapped?". | TDD-027 §4.3 |
| FR-5 | The marker block MUST contain the verbatim line `runtime owner: TDD-033`. | TDD-027 §4.3 |
| FR-6 | The marker block MUST contain the verbatim line `content owner: TDD-027`. | TDD-027 §4.3 |
| FR-7 | The marker block MUST be inserted between the end of Phase 10's body content and the next existing top-level Markdown section. On `main` today, the next section after Phase 10 is the H1 "Error Handling (applies to all phases)" at line 799. The marker MUST therefore appear after Step 10.4's closing fence and before that H1. | TDD-027 §6.3 (insertion between phase 10 and the next phase / next section) |
| FR-8 | Existing Phase 1 through Phase 10 content MUST be byte-identical to `main`. | TDD-027 §4.2 (G-08), §10.1 |
| FR-9 | `grep -c "PHASE-16 CONTRACT" SKILL.md` MUST return exactly 2 (the BEGIN and END lines). | PLAN-027-2 Task 6 |
| FR-10 | The marker block MUST be a valid HTML comment so it renders invisibly in standard Markdown viewers (no `<!--` inside the block content, no premature `-->`). | TDD-027 §4.3, §10.1 |
| FR-11 | The `provides:` and `consumes:` items MUST each be on their own line, prefixed with two-space indent + dash (`  - `), to enable a simple line-oriented parser to extract them. | TDD-027 §10.1 (parse check) |
| FR-12 | The PR description MUST capture the output of the phase-16 contract self-consistency check (PLAN-027-2 Task 6): grep output, parsed `provides` / `consumes` lists, and confirmation that both owner lines are present. | PLAN-027-2 Task 6 |

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|------------|--------|--------------------|
| Marker rendering invisibility | Marker text MUST NOT appear in rendered Markdown output | `pandoc SKILL.md -t plain` does not contain "PHASE-16 CONTRACT" or "runtime owner" outside HTML-comment passthrough; visual review in GitHub's Markdown renderer |
| Marker parseability | A 5-line shell script (or grep + awk) extracts BEGIN/END line numbers, provides count, consumes count, and both owner lines in < 100 ms | `scripts/check-phase-16-contract.sh` (optional one-shot per PLAN-027-2 Task 6) or manual `grep -n` + `awk` chain |
| File-size impact | + ≤ 20 lines net (~15 expected per TDD-027 §8.3) | `wc -l SKILL.md` before vs. after; budgeted in TDD-027 §8.3 as "negligible" |
| Phase preservation | All 10 existing phase H1 headings present in the same document order | `grep -nE "^# Phase [0-9]+" SKILL.md` returns the same 10 lines as `main` |
| Append-only diff | `git diff main -- SKILL.md` shows zero `-` lines outside diff headers | Visual review of `git diff` |

## Technical Approach

### Insertion location (precise anchor)
1. Read `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`.
2. Locate the end of Step 10.4's body (the closing triple-backtick fence on the "Happy building!" code block, currently at approximately line 795).
3. The next Markdown structure on `main` is the horizontal-rule line `---` at line 797 followed by `# Error Handling (applies to all phases)` at line 799.
4. Insert the marker block AFTER the horizontal rule and BEFORE the "# Error Handling" H1 — i.e., between line 797 (`---`) and line 799 (`# Error Handling …`).
5. Surround the marker block with a single blank line above (after the `---`) and a single blank line below (before the `# Error Handling` H1).

If the line numbers drift by the time the implementer reaches this spec, the anchor is "after the horizontal rule that closes Phase 10 and before the first H1 that follows it" — the line numbers are illustrative only.

### Boundary marker block (verbatim)

```markdown
<!-- BEGIN PHASE-16 CONTRACT (TDD-027 §6 ↔ TDD-033 §5) -->
provides:
  - cloud-prompt-tree.md
  - phase-16-content.md
consumes:
  - runtime check: are autonomous-dev-deploy-* plugins installed?
  - runtime check: which firewall backend does this OS support?
  - runtime check: is cred-proxy already bootstrapped?
runtime owner: TDD-033
content owner: TDD-027
<!-- END PHASE-16 CONTRACT -->
```

The block is exactly 11 lines (BEGIN + 9 content lines + END). It contains no nested `<!--` or `-->` sequences, satisfying FR-10.

### Phase-16 contract self-consistency check (Task 6)

The check is a 4-assertion procedure recorded in the PR description:

1. `grep -c "PHASE-16 CONTRACT" SKILL.md` returns exactly 2.
2. The lines between BEGIN and END contain a `provides:` key followed by ≥ 2 dash-prefixed list items.
3. The lines between BEGIN and END contain a `consumes:` key followed by exactly 3 dash-prefixed list items.
4. The lines between BEGIN and END contain both `runtime owner: TDD-033` and `content owner: TDD-027`.

The implementer MAY author a one-shot helper at `scripts/check-phase-16-contract.sh` (not required); future enforcement is delegated to the standards-meta-reviewer per TDD-027 §10.1.

### Error handling at edit time
- If the horizontal-rule anchor cannot be located between Phase 10 and the next H1, abort with "anchor not found"; do NOT silently insert at a guessed location.
- If a `PHASE-16 CONTRACT` marker already exists in the file, abort and surface the conflict (this spec creates the marker fresh).
- If the existing Phase 10 has been refactored or renumbered upstream, abort and ask the orchestrator how to proceed.

## Acceptance Criteria

```
Given the SKILL.md file before edit
When this spec's edits are applied
Then `grep -c "PHASE-16 CONTRACT" SKILL.md` returns exactly 2
And one match is the BEGIN line and the other is the END line
And no other "PHASE-16 CONTRACT" string appears anywhere in the file
```

```
Given the modified SKILL.md
When the BEGIN line is inspected
Then it equals "<!-- BEGIN PHASE-16 CONTRACT (TDD-027 §6 ↔ TDD-033 §5) -->"
And it appears after the horizontal-rule line that closes Phase 10
And it appears before the H1 "# Error Handling (applies to all phases)"
```

```
Given the modified SKILL.md
When the lines between the BEGIN and END markers are extracted
Then the line "provides:" appears
And it is followed by at least 2 lines beginning with "  - "
And one of those lines contains "cloud-prompt-tree.md"
And one of those lines contains "phase-16-content.md"
```

```
Given the modified SKILL.md
When the lines between the BEGIN and END markers are extracted
Then the line "consumes:" appears
And it is followed by exactly 3 lines beginning with "  - runtime check:"
And one mentions "autonomous-dev-deploy-*"
And one mentions "firewall backend"
And one mentions "cred-proxy"
```

```
Given the modified SKILL.md
When the lines between the BEGIN and END markers are extracted
Then the line "runtime owner: TDD-033" appears exactly once
And the line "content owner: TDD-027" appears exactly once
```

```
Given the modified SKILL.md
When `git diff main -- plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` is run
Then no `-` line appears outside diff headers
And all `+` lines fall between the Phase-10 closing horizontal rule and the "# Error Handling" H1
And `grep -nE "^# Phase [0-9]+" SKILL.md` returns the same 10 lines as on main
```

```
Given the modified SKILL.md
When the file is rendered as standard Markdown (e.g., GitHub renderer or `pandoc -t plain`)
Then the marker block is invisible (HTML-comment passthrough)
And the rendered Phase 10 closing and Error Handling opening are unchanged from main
```

```
Given the PR description for this spec's commit
When the phase-16 contract self-consistency check section is read
Then it contains the four assertion outputs from PLAN-027-2 Task 6
And all four assertions are marked as PASS
```

### Edge cases / sad paths

```
Given the implementer attempts to insert the marker INSIDE Phase 10's body
When the static check is run
Then `grep -nE "^# Phase 10$" SKILL.md` followed by the marker line numbers shows the marker line < the next H1 boundary
And the implementer MUST relocate the marker to the post-horizontal-rule position
```

```
Given the implementer accidentally types `<--` (single-dash) instead of `<!--`
When the file is rendered as Markdown
Then the marker text appears in the rendered output (FR-10 violated)
And the standards-meta-reviewer MUST auto-fail the diff
```

```
Given a future TDD adds a second marker block (e.g., PHASE-17 CONTRACT)
When `grep -c "PHASE-16 CONTRACT" SKILL.md` is re-run
Then it MUST still return exactly 2
And the future block uses a distinct label, not "PHASE-16"
```

```
Given the `provides:` list omits `cloud-prompt-tree.md`
When the standards-meta-reviewer runs
Then it auto-fails per TDD-027 §10.1 ("Phase-16 provides/consumes block empty")
And the implementer MUST restore the entry before merge
```

## Test Requirements

### Static
- `grep -c "PHASE-16 CONTRACT" SKILL.md` returns 2.
- `grep -c "<!-- BEGIN PHASE-16 CONTRACT (TDD-027 §6 ↔ TDD-033 §5) -->" SKILL.md` returns 1.
- `grep -c "<!-- END PHASE-16 CONTRACT -->" SKILL.md` returns 1.
- `grep -c "^runtime owner: TDD-033$" SKILL.md` returns 1.
- `grep -c "^content owner: TDD-027$" SKILL.md` returns 1.
- `grep -c "cloud-prompt-tree.md" SKILL.md` returns ≥ 1.
- `grep -c "phase-16-content.md" SKILL.md` returns ≥ 1.
- `awk '/BEGIN PHASE-16/,/END PHASE-16/' SKILL.md | grep -c "^  - runtime check:"` returns 3.
- `git diff main -- plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` shows zero deletion lines.
- `grep -nE "^# Phase [0-9]+" SKILL.md` returns the same 10 lines (line numbers may drift, but headings are byte-identical).

### Integration / regression
- The `setup-wizard-questions` eval suite continues to pass at the existing threshold (touched lines are HTML comments and therefore invisible to the agent's prompt-following behavior).
- The `help-questions`, `config-questions`, and `troubleshoot-scenarios` suites are unaffected.
- The standards-meta-reviewer (PLAN-021-3) is run against the diff and confirms (a) append-only pattern, (b) marker well-formedness, (c) both owner anchors present.

### Manual review
- Reviewer renders the file in GitHub's Markdown viewer and confirms the marker block is invisible.
- Reviewer eyeballs the table of contents (H1 / H2 list) and confirms phases 1–10 ordering and titles are unchanged.
- Reviewer cross-references the `provides:` list against SPEC-027-2-02's filename and confirms a match.

## Implementation Notes

- **Why insert AFTER the Phase-10 horizontal rule, not BEFORE it?** The horizontal rule is part of Phase 10's structural close on `main` (it sits at line 797, immediately after Step 10.4's code fence and immediately before the "# Error Handling" H1). Inserting the marker after the rule keeps Phase 10's rendered close clean and places the marker at the expected "between phase 10 and the next phase/section" position per TDD-027 §6.3.
- **Why include `phase-16-content.md` in `provides:` even though no spec authors it yet?** TDD-027 §6.1's contract names two artifacts: `cloud-prompt-tree.md` (authored by SPEC-027-2-02) and `phase-16-content.md` (placeholder; the actual content lives in `cloud-prompt-tree.md` plus the `agents/onboarding.md` appendix from SPEC-027-2-01). Listing both keeps the marker forward-compatible if a future plan splits the content.
- **Why `runtime owner` and `content owner` as plain text, not YAML?** The block sits inside an HTML comment; Markdown viewers don't parse YAML inside `<!--`. Plain key/colon/value lines parse with simple line-oriented tooling and survive any future Markdown-renderer changes.
- **Coordination forward-pointer.** Per TDD-027 §15, this marker is forward-compatible: if TDD-033 ships first, the marker is unused but harmless; if this spec ships first, TDD-033 can rely on its presence at runtime. The PR description should explicitly link to the TDD-033 anchor (`TDD-033 §5`) so reviewers can cross-reference.
- **No `setup-wizard-questions` eval cases need to change** — the marker is invisible to agent invocations of the SKILL prompt.
- **The marker label is uniquely qualified** (`PHASE-16 CONTRACT (TDD-027 §6 ↔ TDD-033 §5)`) to prevent accidental grep collisions with future markers (per PLAN-027-2 Risks).

## Rollout Considerations

- **Rollout**: Markdown-only PR; SKILL.md is reloaded on every wizard invocation. Marker is invisible to operators.
- **Feature flag**: None. The marker is metadata; the runtime (TDD-033) gates phase-16 invocation behind its own checks.
- **Rollback**: Revert the commit. The marker disappears; the existing 10-phase wizard is unaffected (the marker is invisible, so revert is rendering-equivalent).
- **Coordination**: This spec is the **content side** of the phase-16 contract. TDD-033 is the runtime side. Either can land first per TDD-027 §15. The PR description must cite the TDD-033 §5 anchor and the SPEC-027-2-02 file to close the contract triangle.

## Effort Estimate

| Activity | Hours |
|----------|-------|
| Locate the precise insertion anchor in SKILL.md (Phase-10 close → "# Error Handling" H1) | 0.25 |
| Insert the 11-line marker block verbatim | 0.5 |
| Run the 4 phase-16 contract self-consistency assertions and capture output for PR description | 0.5 |
| Verify byte-identical Phase 1–10 content via `git diff` and visual TOC review | 0.5 |
| Cross-check `provides:` list against SPEC-027-2-02 filename | 0.25 |
| **Total** | **2.0** |
