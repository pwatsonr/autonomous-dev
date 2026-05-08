# SPEC-032-3-03: Stub-Assertion Staleness Lessons-Learned Appendix

## Metadata
- **Parent Plan**: PLAN-032-3 (Spec Drift Sweep + Stub-Assertion Lessons)
- **Parent TDD**: TDD-032 §5.5 (WS-5)
- **Parent PRD**: PRD-017 (FR-1721, FR-1722, FR-1723, FR-1724, FR-1725)
- **Tasks Covered**: PLAN-032-3 Task 6 (pattern + cited examples), Task 7 (proposed convention + worked example + deferred adoption)
- **Estimated effort**: 1 day
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-3-03-stub-assertion-staleness-lessons-learned.md`

## Summary
Author the stub-assertion-staleness lessons-learned appendix at
`plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md`.
The appendix is a doc-only artifact; it documents an antipattern
discovered during the TDD-010-024 spec→code session, cites three
real examples from the codebase, proposes a future test-helper
convention (`stubOf().supersededBy().delete()`), and explicitly
defers adoption.

This spec ships ONE new markdown file. No code changes. No new test
helper is implemented (NG-04: documentation, not enforcement).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md` | Create | Single appendix containing all five sections |

The directory `plugins/autonomous-dev/docs/lessons-learned/` may not
exist yet; the implementer creates it (an empty `.gitkeep` if no
sibling files exist; otherwise the directory is created implicitly
by writing the appendix).

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | A new file `plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md` exists. | T6 |
| FR-2 | The file has a `## Pattern Description` section explaining: SPEC-N stubs assert `console.warn('stub')` to certify wiring; SPEC-N+1 replaces the stub with a real implementation; the SPEC-N test continues to pass vacuously because either (a) unrelated `console.warn` calls match the assertion, OR (b) the stub-warning was silently dropped during a typing-driven test edit. The section cites PRD-017 §4.1 for the broader accumulation pattern. | T6 |
| FR-3 | The file has a `## Cited Examples` section with at least THREE real examples sourced from the spec→code session. | T6 |
| FR-4 | Each cited example reports: (a) Spec ID, (b) test file path, (c) line number of the stale assertion, (d) the stub assertion text, (e) which SPEC-N+1 replaced the stub (with the commit SHA from `git log --oneline -- <stub-file>`), (f) why the assertion still passes (unrelated `console.warn` collateral OR silently dropped from test). | T6 |
| FR-5 | If three examples cannot be sourced from the spec→code session (Risk: thin commit-log context), the file ships with as many as ARE sourceable (≥ 1) and explicitly documents the gap in the section's prose. The minimum acceptable count is one full example PLUS the pattern description. | T6 |
| FR-6 | The file has a `## Proposed Convention` section documenting the `stubOf(specId, replacedBySpecId?).supersededBy(...).delete()` helper from TDD §5.5.1. The section MUST include: (a) the helper's full signature, (b) the intended import path `@autonomous-dev/test-utils` (proposed; not implemented), (c) the failure mode when `.delete()` is invoked on a stub whose superseder has shipped. | T7 |
| FR-7 | The file has a `## Worked Example` section showing the diff sketched in TDD §5.5.1: the addition of `.delete()` to a `stubOf(...).supersededBy(...)` chain in the SPEC-N+1 PR. The diff renders correctly in markdown fenced-diff blocks. | T7 |
| FR-8 | The file has a `## Deferred Adoption` section enumerating the open questions from FR-1725: (a) runtime no-op vs. compile-time check (TDD-032 OQ-02 recommends runtime with `test.fail`), (b) interaction with `describe.skip`, (c) failure mechanism (`throw`, `fail`, or `warn`), (d) location of `@autonomous-dev/test-utils` (standalone package vs. internal to the autonomous-dev plugin). | T7 |
| FR-9 | The file has a `## Cross-references` section linking to PRD-017 §5.5, TDD-032 §5.5, PRD-016 (test-side cleanup owner), and the three (or fewer) cited examples' commit SHAs as anchor links. | T7 |
| FR-10 | The proposed convention is documented as a PROPOSAL — the file MUST NOT imply the convention is enforced or adopted. The `## Deferred Adoption` heading is the canonical signal. | T7 |
| FR-11 | The file passes the existing `lychee` markdown link check from PLAN-016-2. | T6 + T7 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Example sourcing reproducibility | A reader can re-run the `git grep` + `git log --oneline` workflow and confirm each cited example | Manual reproduction of one cited example by the reviewer |
| Section count | Exactly 5 named sections present in order | Visual heading inspection |
| Length | ≤ 1500 words (≈ 3 pages rendered) | `wc -w` |
| Worked-example correctness | The diff snippet renders as a markdown fenced-diff block (with `+` and `-` line prefixes) and is syntactically valid markdown | Render in any markdown previewer; visual inspection |
| Adoption neutrality | The file's tone is descriptive, not prescriptive — it documents a proposal, not a decree | Reviewer reads the file cold and confirms the proposal-vs-decree distinction is clear |
| Link integrity | All internal and external links resolve | `lychee` PASS |
| Regression posture | `npm test` pass count is exactly equal to baseline (doc-only) | TG-06 |

## Technical Approach

### Sourcing the cited examples

Step 1: locate stub assertions in the test tree.

```bash
# Find every test that asserts on console.warn('stub'...)
git grep -nE "console\.warn\(.*['\"]stub['\"]" \
  -- 'plugins/autonomous-dev/tests/' \
  > /tmp/stub-assertions.txt

# Each line: <test-file>:<line>:<text>
```

Step 2: for each candidate, identify the SPEC-N that landed the
stub.

```bash
# Walk a candidate test file's blame to find the commit that
# introduced the stub assertion.
git blame -L<line>,<line> <test-file>
# → commit SHA + author + line. Map the commit to the spec via
# the commit message convention (specs land with messages like
# "feat(...): ... (SPEC-XXX-Y-NN)").
```

Step 3: identify the SPEC-N+1 that replaced the stub.

```bash
# Walk the corresponding implementation file's commit log.
git log --oneline -- <impl-file> | head -20
# Look for a commit whose message references SPEC-XXX-(Y+1)-MM or a
# similar successor pattern. Confirm by reading the diff that the
# stub was replaced with a real implementation.
```

Step 4: confirm vacuity.

For each example, decide which of the two failure modes applies:
- **Collateral match:** the SPEC-N+1 implementation emits its own
  `console.warn(...)` for unrelated reasons, and the SPEC-N test's
  assertion still matches that unrelated warning.
- **Silent drop:** during a typing-driven edit (e.g., switching from
  Jest to Vitest), the stub assertion was implicitly removed from
  the test body but the test was not deleted.

Document the failure mode per example.

### Example body template

```markdown
### Example 1: SPEC-XXX-Y-NN → SPEC-XXX-(Y+1)-MM

- **Spec ID (stub):** SPEC-XXX-Y-NN
- **Test file:** `plugins/autonomous-dev/tests/foo/bar.test.ts:42`
- **Stub assertion text:**
  ```ts
  expect(console.warn).toHaveBeenCalledWith(
    expect.stringContaining('stub'),
  );
  ```
- **Replaced by:** SPEC-XXX-(Y+1)-MM (commit `<7-char-SHA>`)
- **Why still passing:** [Collateral match | Silent drop] — explanation.
```

Repeat for examples 2 and 3.

### Proposed-convention body

```markdown
## Proposed Convention

```ts
// proposed; lives in @autonomous-dev/test-utils when adopted
function stubOf(
  specId: string,
  replacedBySpecId?: string,
): {
  supersededBy: (laterSpecId: string) => {
    delete: () => void;
  };
};
```

- **Usage at spec landing time:**
  ```ts
  stubOf('SPEC-023-2-04').supersededBy('SPEC-023-3-03');
  // returns a tag object; the test continues to assert vacuously.
  ```
- **Usage at superseder landing time:**
  ```ts
  stubOf('SPEC-023-2-04').supersededBy('SPEC-023-3-03').delete();
  // calling .delete() at this point asserts: "the superseder has
  // shipped; this stub assertion is no-op now and should be deleted
  // in this same PR."
  ```
- **Failure mode:** if `.delete()` is invoked on a stub chain whose
  superseder has NOT shipped, the helper throws (or `test.fail`s, per
  OQ-02) so the next CI run blocks the PR.
- **Failure mode (alternate):** if the stub chain is not invoked and
  the superseder HAS shipped, the helper does nothing — the human
  reviewer catches it during the SPEC-N+1 PR review.

The helper is a TAGGED MARKER, not an enforcement mechanism. Its
value is twofold:
1. The presence of `stubOf(...).supersededBy(...)` calls makes
   stale-stub assertions GREP-ABLE and review-tractable.
2. The `.delete()` flip surfaces the stale block in the SPEC-N+1
   PR's diff so the reviewer deletes the assertion.
```

### Worked-example diff

```markdown
## Worked Example

In SPEC-023-3-03's implementation PR, the diff to the SPEC-023-2-04
test file looks like:

\`\`\`diff
- stubOf('SPEC-023-2-04').supersededBy('SPEC-023-3-03');
+ stubOf('SPEC-023-2-04').supersededBy('SPEC-023-3-03').delete();
\`\`\`

The `.delete()` flip lives in SPEC-023-3-03's PR and surfaces the
stale `expect(console.warn)...` block in the diff so the reviewer
deletes the assertion in the same PR.

After the SPEC-023-3-03 PR merges, the diff to the SPEC-023-2-04
test file (in a follow-up cleanup commit) looks like:

\`\`\`diff
- stubOf('SPEC-023-2-04').supersededBy('SPEC-023-3-03').delete();
- expect(console.warn).toHaveBeenCalledWith(
-   expect.stringContaining('stub'),
- );
\`\`\`

The reviewer's responsibility is to ensure both flips happen in the
same PR (FR-1724).
```

(Above, the literal `\`\`\`` sequences are escape-quoted; the actual
file uses real triple-backtick fences.)

### Deferred-adoption body

```markdown
## Deferred Adoption

PRD-017 §6 / FR-1725 explicitly defers adoption. Open questions for
the follow-up PRD:

1. **Runtime no-op or compile-time check?** TDD-032 OQ-02 recommends
   runtime with `test.fail`. A compile-time check would require
   stub-call-graph analysis (heavyweight; rejected).
2. **How does the helper interact with `describe.skip`?** A skipped
   describe block does not invoke `stubOf(...)`; the helper's
   `.delete()` semantics need to handle skip-by-default contexts
   without false negatives.
3. **Failure mechanism on `.delete()` with shipped superseder:**
   `throw`, `fail`, or `warn`? `throw` is loudest; `warn` is
   weakest. PRD's R4 acknowledges adoption may be replaced by a
   different mechanism.
4. **Where does `@autonomous-dev/test-utils` live?** Standalone npm
   package vs. internal to the autonomous-dev plugin. Adoption may
   prefer the in-plugin path to avoid release coupling.

Adoption is a follow-up PRD; this appendix is the spec for that
future work.
```

## Interfaces and Dependencies

**Consumes:**
- The autonomous-dev test tree's history (via `git grep` and
  `git log --oneline`).
- The PRD-017 / TDD-032 cross-references.

**Produces:**
- A canonical reference for any future PRD that adopts the
  `stubOf()` convention. PRD-017 R4 acknowledges adoption may not
  happen; the appendix's documentation value stands either way.

**Cross-references:**
- See FR-9.

## Acceptance Criteria

```
Given the worktree after this spec lands
When `ls plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md` runs
Then the file exists

Given the appendix
When the file is rendered
Then the following sections are present in order:
  - Pattern Description
  - Cited Examples
  - Proposed Convention
  - Worked Example
  - Deferred Adoption
  - Cross-references

Given the Pattern Description section
When read
Then it explains the SPEC-N stub → SPEC-N+1 implementation accumulation pattern
And it cites PRD-017 §4.1 explicitly
And it documents both failure modes (collateral match AND silent drop)

Given the Cited Examples section
When the examples are counted
Then at least one full example is present
And up to three examples are present (target)
And each present example reports Spec ID, test file path, line number, stub text, replaced-by SPEC-N+1, replaced-by commit SHA, failure mode

Given each cited example's commit SHA
When `git show <sha>` is run
Then the commit exists in the repo's history
And the diff confirms the stub→implementation transition

Given a reviewer attempting to reproduce one cited example
When the reviewer runs the documented `git grep` + `git log --oneline` workflow
Then the reviewer arrives at the same SPEC-N stub commit and SPEC-N+1 superseder commit

Given the Proposed Convention section
When read
Then it documents the helper signature
And it documents the import path `@autonomous-dev/test-utils` (proposed)
And it documents the failure mode when `.delete()` is invoked on a stub whose superseder has shipped

Given the Worked Example section
When rendered as markdown
Then a fenced-diff block with `-` and `+` line prefixes is visible
And the diff shows the addition of `.delete()` to a `stubOf(...).supersededBy(...)` chain
And the diff is syntactically valid markdown (fenced block parses)

Given the Deferred Adoption section
When read
Then the four open questions from FR-1725 are enumerated
And the section explicitly states adoption is a follow-up PRD's responsibility (FR-10)

Given the Cross-references section
When `lychee` link check runs
Then exit code is 0 (all links resolve)

Given the appendix
When word-counted
Then total word count is ≤ 1500

Given the worktree at HEAD on this branch
When `npm test` is run
Then pass count is EXACTLY EQUAL to the pre-spec baseline (TG-06; doc-only)

Given the appendix
When a reader re-reads the Proposed Convention section without prior context
Then the reader cannot infer the convention is currently enforced or adopted (FR-10 / NFR row "Adoption neutrality")
```

## Test Requirements

This spec is doc-only. Verification artifacts:

- **Reviewer reproduction (NFR row "Example sourcing reproducibility"):**
  one reviewer (not the author) runs the `git grep` + `git log
  --oneline` workflow for ONE randomly chosen cited example and
  confirms the example's claims. Documented in PR review comments.
- **Word-count check:** `wc -w` on the appendix returns ≤ 1500.
- **Section-presence check:** visual inspection at PR review confirms
  all five named sections (plus Cross-references) are present in
  order.
- **`lychee` link check.** Required.
- **Diff-block rendering check:** the implementer renders the
  appendix in a markdown previewer (or VS Code's preview) and
  confirms the worked-example diff blocks render with `+` and `-`
  prefixes correctly.
- **Adoption neutrality check (FR-10):** the reviewer reads the
  Proposed Convention section without context and confirms the
  proposal-vs-decree distinction is clear. Document in PR review.
- **No new test framework.** Per PRD-017 NG-04. The proposed
  `stubOf()` helper is documented but unimplemented; no test ships
  for it (FR-1725).

## Implementation Notes

- The cited examples are the highest-risk part of this spec. The
  spec→code session's commit log is the source-of-truth; if the
  expected SPEC-N → SPEC-N+1 pairs are not findable, document the
  gap (FR-5 fallback). Two examples are still better than zero;
  one example plus a strong pattern description still satisfies
  FR-1721.
- For each candidate stub, verify the failure mode by running the
  test in isolation:
  ```bash
  npx jest tests/path/to/file.test.ts -t "stub-related test name"
  ```
  Read the test output: if the assertion passes despite the impl
  having shipped, the test is vacuous → cite it.
- The appendix's import path (`@autonomous-dev/test-utils`) is a
  PROPOSED name. If a different name is preferred (e.g.,
  `@autonomous-dev/spec-tooling`), document that the name is
  open-question per FR-8 question 4.
- The worked-example diff blocks use TRIPLE-backtick fences with
  `diff` language tag. Some markdown renderers are picky about
  whitespace inside diff blocks; test rendering before commit.
- The directory `plugins/autonomous-dev/docs/lessons-learned/` may
  not exist. If creating it, do NOT add a `README.md` index (NG-04:
  no new tooling beyond the appendix). The directory exists implicitly
  via the appendix's path.
- **Commit layout:** PLAN-032-3 prescribes a SEPARATE commit
  `docs(lessons): stub-assertion-staleness appendix (PLAN-032-3)`
  for this spec, distinct from SPEC-032-3-01/02's
  `docs(specs): path-drift sweep + amendments summary` commit.
  The two commits land in the same PR but are reviewable
  independently.
- **Tone:** descriptive and analytical. Avoid imperative voice in
  the Proposed Convention section ("the helper SHOULD throw") in
  favor of conditional voice ("when adopted, the helper would
  throw"). This reinforces FR-10's adoption neutrality.

## Rollout Considerations

- **Doc-only.** No CI behavior change.
- **Future use:** when a PRD adopts the convention, that PRD
  references this appendix and updates the open-questions section
  with resolved answers. The appendix's "Deferred Adoption" section
  becomes the audit trail for the resolution.
- **Rollback:** delete the appendix file. No other artifact depends
  on it programmatically.
- **Discoverability:** consider adding a one-line link from
  `plugins/autonomous-dev/docs/lessons-learned/README.md` (if it
  exists) or from PRD-017's "Open questions" section. Optional.
- **Cross-PR coordination:** PRD-016 (test-side cleanup) may delete
  the cited stub assertions as part of its sweep. After PRD-016
  ships, this appendix's cited examples become historical. The
  appendix's value (pattern documentation, proposed convention)
  persists.

## Effort Estimate

- Sourcing 3 cited examples (`git grep` + `git log --oneline` +
  failure-mode confirmation): 0.4 day
- Drafting the Pattern Description, Proposed Convention, Worked
  Example, and Deferred Adoption sections: 0.4 day
- `lychee` link check + reviewer reproduction coordination: 0.2 day
- Total: 1 day
