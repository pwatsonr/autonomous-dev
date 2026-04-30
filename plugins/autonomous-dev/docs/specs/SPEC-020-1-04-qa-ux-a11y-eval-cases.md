# SPEC-020-1-04: QA + UX + Accessibility Eval Case Suites (75 cases)

## Metadata
- **Parent Plan**: PLAN-020-1
- **Tasks Covered**: Task 7 (25 qa-reviewer cases), Task 8 (20 ux-reviewer cases), Task 9 (30 a11y-reviewer cases)
- **Estimated effort**: 11 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-020-1-04-qa-ux-a11y-eval-cases.md`

## Description
Authors the three eval suites that exercise the QA, UX/UI, and accessibility specialist reviewers against deterministic fixture diffs. Total: 75 cases (25 + 20 + 30). The 15th eval suite (standards reviewer) ships in SPEC-020-1-03 because it depends on fixture YAML files. These suites are consumed by PLAN-017-3's `assist-evals` workflow on every PR and on a nightly cron, providing a regression baseline that catches reviewer drift as the agent prompts evolve.

Each case is fully self-contained: `input` is a complete unified-diff string (no reference to real files), `expected_findings[]` lists at least one rubric-matched finding (matched permissively by `category` substring, not exact text), and `forbidden_findings[]` lists false positives the reviewer must NOT produce on this input. Security-critical cases are tagged `security_critical: true` and required to pass at 100% — failure of any one of those gates the suite.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/evals/test-cases/qa-reviewer-eval.yaml` | Create | 25 cases; 5+ tagged `security_critical` (SQL injection, path traversal, null deref, race, error-path leak) |
| `plugins/autonomous-dev-assist/evals/test-cases/ux-reviewer-eval.yaml` | Create | 20 cases; ~10 clean / ~10 dirty; no security-critical (per TDD §9) |
| `plugins/autonomous-dev-assist/evals/test-cases/a11y-reviewer-eval.yaml` | Create | 30 cases; security-critical: keyboard trap, missing alt, contrast <3:1; WCAG criterion in each `category` |

## Implementation Details

### Common Suite Header

Every suite YAML opens with:

```yaml
suite: <reviewer-id>
schema_version: 1
total_cases: <N>
security_critical_pass_rate_required: 1.0
match_strategy: permissive  # category substring match, not exact title
cases:
  # ...
```

### QA Reviewer Suite — `qa-reviewer-eval.yaml`

25 cases distributed across the six TDD §5.1 categories. Required minimums:

| Category | Min cases | Security-critical examples |
|----------|-----------|---------------------------|
| Input validation | 4 | SQL injection (1), path traversal (1) |
| Boundary conditions | 4 | Off-by-one in bounds check (1) |
| Race conditions | 4 | TOCTOU file open (1) |
| Error paths | 4 | Resource leak on throw (1) |
| Null handling | 4 | Null deref in error branch (1) |
| Resource leaks | 5 | None required security-critical |

Total security-critical: 5 cases (one per asterisked example). Tag each with `security_critical: true`.

Example case:

```yaml
- id: QA-001
  description: "SQL injection via string concatenation"
  security_critical: true
  category_under_test: input-validation
  input: |
    diff --git a/src/db/users.ts b/src/db/users.ts
    +export async function findUser(name: string) {
    +  return db.query(`SELECT * FROM users WHERE name = '${name}'`);
    +}
  expected_findings:
    - severity: critical
      category: input-validation
  forbidden_findings:
    - category: performance  # not what we're testing
```

### UX Reviewer Suite — `ux-reviewer-eval.yaml`

20 cases. ~50/50 clean (10 cases with `expected_findings: []`) vs dirty (10 with at least one finding). Each dirty case targets one of the six UX heuristics:

| Heuristic | Min dirty cases |
|-----------|----------------|
| Information density / hierarchy | 1 |
| Color-only signaling | 2 |
| State coverage (loading/empty/error/success) | 2 |
| Mobile responsiveness | 1 |
| Form labels | 2 |
| Button labels | 2 |

Clean cases include: a backend-only diff (must short-circuit to APPROVE per SPEC-020-1-02 non-frontend guard), a well-formed React form with all labels and ARIA, a properly styled error state with icon + text, a button with explicit `aria-label`.

Example dirty case:

```yaml
- id: UX-007
  description: "Error state shown by red text only (color-only signal)"
  security_critical: false
  category_under_test: color-only-signaling
  input: |
    diff --git a/src/components/Field.tsx b/src/components/Field.tsx
    +<input className={hasError ? 'text-red-600' : ''} />
  expected_findings:
    - severity: medium
      category: color-only
  forbidden_findings: []
```

### Accessibility Reviewer Suite — `a11y-reviewer-eval.yaml`

30 cases. Each case's `category` field MUST cite a WCAG criterion number. Distribution:

| WCAG Criterion | Cases (clean / dirty) | Security-critical |
|----------------|----------------------|------------------|
| 1.4.3 Contrast | 4 / 2 | contrast <3:1 (1 case) |
| 2.1 Keyboard | 3 / 3 | keyboard trap (1 case) |
| 2.4.3 Focus order | 3 / 2 | none |
| 4.1.2 Name/role/value | 3 / 3 | none |
| 1.1.1 Non-text content | 3 / 4 | missing alt on non-decorative image (1 case) |

Total: 16 clean + 14 dirty = 30. Security-critical: 3 cases.

Example security-critical case:

```yaml
- id: A11Y-022
  description: "Image carries information but has no alt text"
  security_critical: true
  category_under_test: "WCAG 2.2 AA 1.1.1 Non-text Content"
  input: |
    diff --git a/src/components/Banner.tsx b/src/components/Banner.tsx
    +<img src="/promo.png" />
  expected_findings:
    - severity: high
      category: "1.1.1"  # permissive substring match
  forbidden_findings: []
```

Each clean WCAG case must include a positive example demonstrating compliance (e.g. a button with `aria-label` matching its visible icon, an `<img>` with descriptive alt, a focus order that follows DOM order). The reviewer must produce `APPROVE` with empty findings on these inputs to verify low false-positive rate.

### Permissive Matching

The `match_strategy: permissive` field instructs PLAN-017-3's runner to:
- Match `expected_findings[].category` as a case-insensitive substring of the actual finding's `category`.
- Match `expected_findings[].severity` exactly (no rounding).
- Pass the case if every expected finding is present (in any order) AND no forbidden finding fires.
- Ignore extra findings (the reviewer may report more than expected without failing the case).

This keeps the suite stable as agent prompts evolve while still catching material regressions.

## Acceptance Criteria

- [ ] Three YAML files exist at the documented paths and parse with `yq -e .` exit 0.
- [ ] `qa-reviewer-eval.yaml` contains exactly 25 cases under `cases:`.
- [ ] `ux-reviewer-eval.yaml` contains exactly 20 cases.
- [ ] `a11y-reviewer-eval.yaml` contains exactly 30 cases.
- [ ] QA suite contains at least 5 cases with `security_critical: true`, each covering a distinct concern (SQL injection, path traversal, null deref, race condition, error-path leak).
- [ ] A11y suite contains at least 3 cases with `security_critical: true` (keyboard trap, missing alt, contrast <3:1).
- [ ] UX suite contains zero cases with `security_critical: true`.
- [ ] UX suite has 10 ± 1 clean cases (`expected_findings: []`) and 10 ± 1 dirty cases.
- [ ] Every dirty UX case's `category_under_test` maps to one of the six heuristics from SPEC-020-1-02.
- [ ] Every a11y case's `category_under_test` field contains a WCAG criterion number (1.4.3, 2.1, 2.4.3, 4.1.2, or 1.1.1).
- [ ] Every case includes a non-empty `input:` block containing a complete unified-diff fragment (starts with `diff --git`).
- [ ] No case's `input` references a real repository file (each is self-contained and reproducible).
- [ ] Every suite header sets `match_strategy: permissive` and `security_critical_pass_rate_required: 1.0`.
- [ ] Every suite reports `total_cases:` matching the actual count under `cases:`.

## Dependencies

- **Upstream**: SPEC-020-1-01 (the schema reviewers emit against — eval runner validates outputs against it). SPEC-020-1-02 (the three agents the cases exercise).
- **Downstream**: PLAN-017-3 `assist-evals` workflow (consumes these YAMLs as test fixtures); PLAN-020-2 (does not consume directly but expects the eval suites to gate before chain-config rollout).
- **Tooling assumption**: PLAN-017-3's runner already supports the `match_strategy: permissive` directive. If not, this spec adds a follow-up task to PLAN-017-3.

## Notes

- The 75 cases are budgeted at ~9 minutes per case in the full eval run (TDD-017 §6 cost model). Total nightly cron cost across all four suites (incl. standards): ~$45 / run. PLAN-017-3 owns cost monitoring; this spec only ships the cases.
- Permissive matching trades brittleness for resilience. The downside is that a reviewer could rename `category: "sql-injection"` to `category: "injection.sql"` and the case still passes; PLAN-017-3's prompt-version diff catches that drift on PR.
- Clean cases are as important as dirty cases: they prevent false-positive regressions. The 50/50 split in the UX suite and ~50/50 in the a11y suite are deliberate.
- QA suite has no clean-vs-dirty quota because every category is "find a specific defect" — the negative space is covered by `forbidden_findings[]` on the dirty cases (e.g. "the SQL injection case must not also produce a perf finding").
- The `category_under_test` field is metadata for suite organization; it does not affect matching. The permissive matcher operates on `expected_findings[].category` only.
- All 75 cases must be reproducible offline. Do not include any case that requires network access, external API calls, or filesystem state outside the diff string.
