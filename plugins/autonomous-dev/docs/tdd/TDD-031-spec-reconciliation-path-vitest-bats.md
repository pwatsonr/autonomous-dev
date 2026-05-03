# TDD-031: SPEC Reconciliation — Path Drift, Vitest, and Bats Sweeps

| Field          | Value                                                                |
|----------------|----------------------------------------------------------------------|
| **Title**      | SPEC Reconciliation — Path Drift, Vitest, and Bats Sweeps            |
| **TDD ID**     | TDD-031                                                              |
| **Version**    | 1.0                                                                  |
| **Date**       | 2026-05-02                                                           |
| **Status**     | Draft                                                                |
| **Author**     | Patrick Watson                                                       |
| **Parent PRD** | PRD-016: Test-Suite Stabilization & Jest Harness Migration           |
| **Plugin**     | autonomous-dev (docs only — no plugin runtime impact)                |
| **Sibling TDDs** | TDD-029 (harness migration + CI gate), TDD-030 (closeout backfill) |

---

## 1. Summary

TDD-031 is the doc-only sibling of PRD-016. It reconciles three classes of drift in the
SPEC corpus where the SPEC text disagrees with the as-built tree:

1. **Path drift** (~17 SPECs): SPECs cite `src/portal/...` paths that were relocated to
   `plugins/autonomous-dev-portal/server/...` during the portal extraction.
2. **Vitest references** (~26 SPECs): SPECs in TDD-022 (chains-cli) and TDD-024
   (cred-proxy) name Vitest as the test runner; the as-built runner is Jest.
3. **Bats references** (~15 SPECs): SPECs in TDD-002 and TDD-010 cite
   `tests/unit/test_*.sh` Bats files; the as-built corpus is Jest-only.

(Audited counts from `main@2937725`, against
`plugins/autonomous-dev/docs/specs/`. PRD-016 §1's "~30+ / ~10 / ~10" estimates
under-counted the vitest cohort because it included only chains-cli and cred-proxy;
the actual scan identifies 26 SPECs across more TDDs.)

The design is a **doc-only PR with no production code diff**. Its value is restoring
the SPEC corpus's trustworthiness: a reviewer reading any reconciled SPEC sees a path
that exists, a runner reference that matches the gate, and either a real Bats file or
an explicit retirement note.

This TDD ships nothing executable. Its risk profile is dominated by misedits — a
sed-driven sweep that introduces more confusion than it removes — so the design centers
on a verification mechanism: **post-amendment, every cited path must resolve**.

---

## 2. Goals & Non-Goals

### Goals

- **G-3101** Amend ~17 SPECs so cited paths under `src/portal/...` resolve to the
  as-built `plugins/autonomous-dev-portal/server/...` tree.
- **G-3102** Amend ~26 SPECs so test-runner references read `Jest` instead of `Vitest`.
- **G-3103** Reconcile ~15 SPECs that cite `tests/unit/test_*.sh` Bats files: each is
  either (a) amended to point at the equivalent Jest suite, or (b) retired with an
  explicit note linking the Jest replacement.
- **G-3104** Add a CI guard that grep-fails on `src/portal/`, `vitest`, and bare
  `bats` token strings inside `plugins/autonomous-dev/docs/specs/**.md` so the drift
  cannot recur.
- **G-3105** Ship as a single doc-only PR with a per-SPEC diff summary in the PR
  description so reviewers can spot-check rather than read every diff.
- **G-3106** Verify mechanically (not by eyeballing): after the sweep, every cited
  path under `plugins/...` in an amended SPEC must exist in the tree.

### Non-Goals

| ID      | Non-Goal                                                                            | Rationale                                                                              |
|---------|-------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|
| NG-3101 | Re-deriving SPEC content                                                            | Per PRD-016 NG-05: path/text amendments only; behavior-content is not re-evaluated     |
| NG-3102 | Refactoring the SPEC numbering or filename scheme                                   | Out of scope; only the body text changes                                               |
| NG-3103 | Production code changes referenced by amended paths                                 | Doc-only; if a SPEC reveals a real production gap, that's a TDD-030-class follow-up    |
| NG-3104 | Retroactively adding SPECs for files that exist but have no SPEC                    | Out of scope; SPEC backfill is a separate effort                                       |
| NG-3105 | Creating the missing Bats files cited by TDD-002/010 SPECs                          | The Bats coverage was retired; recreating it is a non-goal per PRD-016 NG-03           |
| NG-3106 | Removing the vitest dev-dependency from `package.json`                              | Out of scope; the sweep amends prose only, not actual dependencies                     |
| NG-3107 | Running the amended SPECs through a SPEC review re-pass                             | The reconciliation amends content already reviewed; no re-review needed unless the     |
|         |                                                                                     | reviewer flags a finding mid-amendment                                                 |

---

## 3. Background

### 3.1 The three drift classes

**Path drift** is the largest class by line count. During the portal extraction, code
under `src/portal/...` moved to `plugins/autonomous-dev-portal/server/...`. SPECs
authored before the extraction still cite the old paths. Confirmed against the tree:

```
$ grep -rln "src/portal" plugins/autonomous-dev/docs/specs/ | wc -l
17

# sample affected SPECs:
SPEC-014-2-01-csrf-protection.md
SPEC-014-2-02-typed-confirm-modal.md
SPEC-015-1-01-file-watcher-fs-watch-polling-debounce.md
SPEC-015-1-04-cost-heartbeat-log-readers-with-redaction.md
... (13 more, mostly TDD-014 and TDD-015 children)
```

**Vitest references** appeared because some SPECs were authored against an
exploratory Vitest setup that never made it past prototype. The as-built runner is
Jest. The cohort is bigger than PRD-016's estimate:

```
$ grep -rlni "vitest" plugins/autonomous-dev/docs/specs/ | wc -l
26

# sample affected SPECs (TDDs 005, 006, 012, 013, 017–024):
SPEC-019-1-05-unit-and-integration-tests.md
SPEC-022-1-05-unit-and-standards-to-fix-integration-tests.md
SPEC-024-2-05-tests-and-kind-integration.md
... (23 more)
```

**Bats references** are SPEC text from the era when the plugin had a hybrid Jest+Bats
strategy. Bats was retired in favor of Jest-only; the SPECs were not updated.

```
$ grep -rln "tests/unit/test_.*\.sh\|\.bats" plugins/autonomous-dev/docs/specs/ | wc -l
15

# sample (TDDs 002, 010):
SPEC-002-...
SPEC-010-...
```

### 3.2 Why this is doc-only

PRD-016 §13 explicitly forbids re-deriving SPEC content during the sweep. A SPEC is
"reconciled" by changing path text or runner-name text; the SPEC's intent (what the
test should cover, what the production module should do) is left intact.

If a reviewer notices that a SPEC is fundamentally wrong about behavior (e.g., the
SPEC describes an interface that no longer exists), the reconciliation log records
the discrepancy as an Open Question; the SPEC is not rewritten.

### 3.3 Why a CI guard matters

Without an enforcement mechanism, the next round of SPEC authoring re-introduces
drift. A 1-line `grep` step in CI is the simplest way to make the reconciliation
durable.

---

## 4. Architecture

This TDD has no runtime architecture. The "architecture" is the **transformation
pipeline** plus the **verification gate**:

```
                    ┌────────────────────────────────┐
                    │  plugins/autonomous-dev/        │
                    │  docs/specs/SPEC-NNN-N-NN.md    │  (~58 affected files)
                    └─────────────┬───────────────────┘
                                  │
                    ┌─────────────▼───────────────────┐
                    │   1. Audit: grep for tokens     │
                    │   - "src/portal/"  →  17 hits   │
                    │   - "Vitest"/"vitest" → 26 hits │
                    │   - ".bats"/"test_*.sh" → 15 hits│
                    └─────────────┬───────────────────┘
                                  │
                    ┌─────────────▼───────────────────┐
                    │   2. Per-class amendment        │
                    │   ├─ Path: tree-aware sed       │
                    │   ├─ Vitest: token replace      │
                    │   └─ Bats: per-file decision    │
                    │     (point at Jest OR retire)   │
                    └─────────────┬───────────────────┘
                                  │
                    ┌─────────────▼───────────────────┐
                    │   3. Verification (mechanical)  │
                    │   - every plugins/... path in  │
                    │     amended SPECs exists in tree│
                    │   - no remaining src/portal/   │
                    │   - no remaining vitest        │
                    │   - no orphan .bats refs       │
                    └─────────────┬───────────────────┘
                                  │
                    ┌─────────────▼───────────────────┐
                    │   4. CI guard:                  │
                    │   .github/workflows/ci.yml      │
                    │   grep-fails the three tokens   │
                    └─────────────────────────────────┘
```

The pipeline runs once (the sweep) plus continuously (the CI guard).

---

## 5. Per-Class Amendment Strategy

### 5.1 Path drift (FR-1650)

The 17 affected SPECs share a uniform substitution. A single tree-aware sed:

```bash
# Verify before running:
grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/

# Apply (BSD sed on macOS; -i.bak then remove .bak files):
find plugins/autonomous-dev/docs/specs -name "*.md" -exec \
  sed -i.bak 's|src/portal/|plugins/autonomous-dev-portal/server/|g' {} \;
find plugins/autonomous-dev/docs/specs -name "*.md.bak" -delete
```

**Why this is safe:** The substitution is a strict prefix replacement. The directory
`src/portal/` maps 1:1 to `plugins/autonomous-dev-portal/server/`; subpaths are
preserved (`src/portal/auth/foo.ts` becomes
`plugins/autonomous-dev-portal/server/auth/foo.ts`).

**What this misses:** SPECs that cite `src/portal` without a trailing slash (e.g.,
"the portal lives in `src/portal`"). The audit (§5.4) catches these in a follow-up
pass.

### 5.2 Vitest references (FR-1651)

The 26 affected SPECs need a case-aware replacement (`Vitest` → `Jest`,
`vitest` → `jest`):

```bash
find plugins/autonomous-dev/docs/specs -name "*.md" -exec \
  sed -i.bak -e 's/\bVitest\b/Jest/g' -e 's/\bvitest\b/jest/g' {} \;
find plugins/autonomous-dev/docs/specs -name "*.md.bak" -delete
```

**Why this is safe:** Word-boundary anchors (`\b`) prevent substring matches. The
ASCII-only nature of the tokens means no Unicode collation issues.

**What this misses:** SPECs that reference Vitest-specific APIs (`vi.fn()`,
`vi.mock()`) without naming Vitest. Mitigation: the verification pass (§5.4) greps
for `\bvi\.` as a secondary signal; the affected SPECs are flagged for manual review.

### 5.3 Bats references (FR-1652)

The 15 affected SPECs cannot be sed-edited. Each Bats reference is one of two cases:

| Case | Action                                                            | Example                                                       |
|------|-------------------------------------------------------------------|---------------------------------------------------------------|
| (a)  | Bats file has a Jest equivalent: amend the SPEC to cite the Jest path | `tests/unit/test_daemon_lifecycle.sh` → `tests/intake/daemon-lifecycle.test.ts` |
| (b)  | Bats coverage was retired with no replacement: amend the SPEC to record the retirement | "Bats coverage retired in TDD-026-prep cleanup; no Jest replacement." |

This requires per-SPEC judgment. The work is manual: 15 files × ~5 min per file =
~75 min total. Each amendment is a separate commit so the reviewer can verify the
case-(a) vs case-(b) decision per file.

The bookkeeping lives in `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
(new file), with a per-SPEC row:

```markdown
| SPEC               | Class | Action                                              | Approver |
|--------------------|-------|-----------------------------------------------------|----------|
| SPEC-002-1-05      | Bats  | (a) → tests/intake/daemon-lifecycle.test.ts         | @pwatson |
| SPEC-002-2-04      | Bats  | (b) Retired, no Jest replacement                    | @pwatson |
| ... (13 more)      |       |                                                     |          |
```

### 5.4 Verification (FR-1654, G-3106)

Three checks, all run as a single bash script committed to
`scripts/verify-spec-reconciliation.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. No remaining src/portal/ references
if grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/ ; then
  echo "FAIL: src/portal/ references remain"; exit 1
fi

# 2. No remaining vitest references (case-insensitive, word-boundary)
if grep -rliEn "\bvitest\b" plugins/autonomous-dev/docs/specs/ ; then
  echo "FAIL: vitest references remain"; exit 1
fi

# 3. No remaining bare bats references
if grep -rlEn "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/ ; then
  echo "FAIL: bats references remain"; exit 1
fi

# 4. Every cited plugins/.../*.ts path in any SPEC under docs/specs/ resolves
missing=0
while IFS= read -r path; do
  if [[ ! -e "$path" ]]; then
    echo "MISSING: $path"
    missing=$((missing+1))
  fi
done < <(grep -rohE "plugins/autonomous-dev[^[:space:]\`]+\.(ts|js|md|json|yml|yaml)" \
            plugins/autonomous-dev/docs/specs/ | sort -u)

if [[ $missing -gt 0 ]]; then
  echo "FAIL: $missing cited paths do not exist"; exit 1
fi

echo "PASS"
```

Check (4) is the load-bearing one: it catches a sed misedit that produces a path that
*looks* right but doesn't exist (e.g., a relocated subfolder). Pre-amendment, this
check would also fail (because of the path drift); post-amendment, it must pass.

---

## 6. Cross-Cutting Concerns

### 6.1 Security

No production code touched; no security surface affected. The CI guard prevents
future drift but is itself read-only (a grep, not a code change).

The one indirect security implication: a SPEC that cites a wrong path can mislead a
reviewer reading the SPEC into approving a security-relevant gap. Reconciliation
removes that misleading signal.

### 6.2 Privacy

No PII in SPEC files. No data handling changes.

### 6.3 Scalability

Doc-only; no runtime cost. The CI grep adds <500 ms to the lint job.

### 6.4 Reliability

The reliability concern is **misedits** — a sed substitution that destroys SPEC
semantics. Mitigated by:

1. The amendment uses word-boundary anchors (`\b`) and prefix anchors (`/`) to limit
   match scope.
2. The verification script (§5.4) catches any cited path that no longer resolves.
3. Each Bats decision (§5.3) is a separate commit so a misclassification is
   revertable in isolation.
4. The PR description includes a per-SPEC diff summary so a reviewer can spot-check
   any individual SPEC without reading the whole diff.

### 6.5 Observability

The reconciliation matrix (`docs/triage/PRD-016-spec-reconciliation.md`) is itself
the observability artifact: every amended SPEC has a row stating what changed and
who approved.

The CI guard's failure message names the offending SPEC and token, so a future
violator gets actionable feedback.

### 6.6 Cost

Engineer-hour cost: ~3 hours (path sweep ~30 min, vitest sweep ~30 min, bats sweep
~75 min, verification + CI ~45 min, PR description authoring ~30 min). Lowest of
the three TDDs.

CI cost: <500 ms per lint run. Negligible.

---

## 7. Alternatives Considered

### 7.1 Have an LLM agent rewrite each SPEC

**Approach:** Hand each affected SPEC to a SPEC-author agent with the instruction
"reconcile against the as-built tree."

**Advantages:**
- Catches subtle drift that grep misses (e.g., descriptive prose that's just
  out of date)
- Could re-derive SPEC content alongside the path fix

**Disadvantages:**
- Re-deriving SPEC content is explicitly a non-goal (PRD-016 NG-05 / NG-3101).
- LLM rewrites are non-deterministic and harder to review than a sed diff.
- The cost (in tokens, in review time) is many times higher than the mechanical
  sweep.
- An agent rewrite of 58 SPECs produces ~58 large diffs; the PR becomes
  unreviewable.

**Why rejected:** PRD-016 wants a mechanical, low-risk amendment. An agent rewrite
inverts both properties.

### 7.2 Codemod-style structured edit (markdown AST + transformer)

**Approach:** Parse each SPEC as markdown AST (e.g., via `remark`), apply a
node-level transformer, write back.

**Advantages:**
- More precise than sed (e.g., can distinguish a code-block path from a prose path)
- Repeatable: re-runnable if drift recurs

**Disadvantages:**
- Markdown AST round-trips are notoriously lossy: code-block fences, table
  alignment, emphasis tokens often shift.
- The complexity gain (~200 lines of transformer code) is not justified for a
  one-shot sweep.
- The verification script (§5.4) catches the misedits that AST-precision would
  prevent, at much lower cost.

**Why rejected:** Too much machinery for a single doc sweep. Sed + verification
script is sufficient.

### 7.3 Skip the bats class; let the references rot

**Approach:** Reconcile path drift and vitest only; leave the 15 bats SPECs untouched
on the grounds that "everyone knows Bats was retired."

**Advantages:**
- Saves ~75 min of manual work
- No risk of misclassifying case (a) vs case (b)

**Disadvantages:**
- Future SPEC reviewers see Bats references and don't know if the Bats coverage
  is current (it isn't), retired (mostly), or still required somewhere (no).
- The CI guard would have to whitelist 15 SPECs, which itself is a code smell.
- PRD-016 G-08 explicitly mandates the Bats reconciliation.

**Why rejected:** The whole point of the reconciliation is to make the SPEC corpus
trustworthy at a glance. Leaving 15 stale references defeats that purpose.

### 7.4 One PR per drift class (3 PRs total)

**Approach:** Ship the path-sweep PR, then the vitest-sweep PR, then the bats-sweep
PR sequentially.

**Advantages:**
- Each PR is smaller and easier to review individually
- Rollback is per-class

**Disadvantages:**
- Three PRs of doc-only diffs are review fatigue without benefit
- The verification script (§5.4) needs to pass against all three classes; running
  it on a partial state requires temporary carve-outs
- The PR description's per-SPEC summary covers all three classes naturally

**Why rejected:** The single-PR approach is cheaper to ship and review (one
verification pass instead of three). The PR description's per-SPEC summary makes
the three classes individually reviewable inside one PR.

---

## 8. Operational Readiness

### 8.1 Rollout sequence

This TDD ships as a single doc-only PR with three commits, in order:

1. **Commit 1 (path drift):** Run §5.1 sed; commit. Verification passes locally.
2. **Commit 2 (vitest):** Run §5.2 sed; commit. Verification passes locally.
3. **Commit 3 (bats):** Apply per-SPEC decisions per §5.3; populate
   `docs/triage/PRD-016-spec-reconciliation.md`. Commit.
4. **Commit 4 (CI guard):** Add `scripts/verify-spec-reconciliation.sh`; wire it
   into `.github/workflows/ci.yml` as a new step. Commit.

### 8.2 Rollback

Each commit is independent and revertable. The PR-level revert restores the SPEC
corpus exactly to its pre-TDD state. No production code is affected, so rollback is
risk-free.

### 8.3 Feature flags

None. Doc edits cannot be feature-flagged.

### 8.4 Canary criteria

- The verification script (§5.4) exits 0 on the PR branch.
- A spot-check by the reviewer of 3 randomly-chosen amended SPECs (one per drift
  class) confirms the amendments are correct.
- The CI guard fails on a deliberate test PR that adds `src/portal/` to a SPEC.

---

## 9. Test Strategy

### 9.1 The verification script is the test

`scripts/verify-spec-reconciliation.sh` is both the test and the gate. Run pre-PR:
must exit 0. Run in CI: must exit 0.

### 9.2 CI guard self-test

A throwaway PR (not merged) that introduces `src/portal/foo.ts` into a SPEC must
fail the new CI step. Documented in the PR description.

### 9.3 Per-SPEC review checklist

The reviewer's spot-check covers:

- One SPEC from the path-sweep cohort: confirm the amended path resolves.
- One SPEC from the vitest cohort: confirm `Jest` reads naturally in context.
- One SPEC from the bats cohort: confirm the case (a)/(b) decision matches the
  reconciliation matrix.

### 9.4 What's not tested

- The semantic correctness of the amended SPECs (NG-3101: not in scope).
- Whether the SPEC's intent matches the production code's behavior (would require
  re-review; out of scope).

---

## 10. Open Questions

| ID    | Question                                                                                                       | Recommendation                                                                                                                                |
|-------|----------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| OQ-31-01 | Should the path sweep also catch `src/portal` (no trailing slash) prose mentions?                              | Yes, as a follow-up pass after the prefix sweep. The verification script (§5.4) check (1) catches any remaining occurrences.                   |
| OQ-31-02 | Do we add the verification script to the harness migration's CI gate (TDD-029) or as a separate step?          | Separate step. TDD-029's gate is about test runners; this is about doc hygiene. Conflating them adds coupling without benefit.                |
| OQ-31-03 | If a SPEC's amended path still doesn't exist (e.g., the production file was renamed, not relocated), what then? | Flag in the reconciliation matrix as Open Question. Do not invent a path; do not delete the cite. The follow-up is a separate code or SPEC PR. |
| OQ-31-04 | Should we backfill the 15 retired Bats files as Jest equivalents while we're here?                              | No. NG-3105: SPEC backfill is a separate effort. The reconciliation amends prose only.                                                         |
| OQ-31-05 | Do we also amend SPECs that reference `vi.fn()` / `vi.mock()` even if they don't use the bare token "vitest"?   | Yes. The §5.4 verification has a secondary check for `\bvi\.` and flags those SPECs for manual review during the vitest sweep.                 |
| OQ-31-06 | The audit says ~30 path-drift SPECs but the actual count is 17. Is the audit wrong or are we missing some?    | The 17 is from `grep -rln "src/portal/"`. Other path-drift forms (e.g., `src/portal` no slash) bring the total higher; OQ-31-01 covers them.   |
| OQ-31-07 | If the verification script's check (4) flags a path drift in an unrelated SPEC, do we fix it in this PR?        | Yes — a path that doesn't resolve is a path that needs fixing regardless of which TDD authored the SPEC. Add a row to the matrix and amend.    |

---

## 11. Implementation Plan (high-level)

| Plan ID    | Title                                  | Scope                                                                                       | Estimate | Depends on |
|------------|----------------------------------------|---------------------------------------------------------------------------------------------|----------|------------|
| Plan 031-A | Path-drift sweep                       | Run §5.1 sed across `docs/specs/`; populate matrix rows for each amended SPEC               | S        | —          |
| Plan 031-B | Vitest sweep                           | Run §5.2 sed; secondary `\bvi\.` review pass; populate matrix                                | S        | —          |
| Plan 031-C | Bats reconciliation                    | Manual per-SPEC case (a)/(b) decisions per §5.3; populate matrix                            | S        | —          |
| Plan 031-D | Verification script + CI guard         | Author `scripts/verify-spec-reconciliation.sh` (§5.4); wire into `.github/workflows/ci.yml` | S        | 031-A, 031-B, 031-C |

All four plans are independent except 031-D, which gates on the others. Total effort
is ~3 engineer-hours; this is the smallest of the three TDDs.

---

## 12. References

- **PRD-016:** Test-Suite Stabilization & Jest Harness Migration —
  `plugins/autonomous-dev/docs/prd/PRD-016-test-suite-stabilization.md`
- **TDD-029:** Sibling — harness migration; reconciliation can ship before, after, or
  in parallel
- **TDD-030:** Sibling — closeout backfill; the as-built `intake/cli/...` paths it
  uses are amended into SPECs by this TDD (per OQ-30-04)
- **SPEC corpus root:** `plugins/autonomous-dev/docs/specs/` (409 files; ~58 affected)
- **Existing CI:** `.github/workflows/ci.yml` — gets the new verification step
- **Audit reference (2026-05-03):** the source of the per-class counts; the actual
  `grep` counts (17 / 26 / 15) take precedence per PRD-016 §11

---

**END TDD-031**
