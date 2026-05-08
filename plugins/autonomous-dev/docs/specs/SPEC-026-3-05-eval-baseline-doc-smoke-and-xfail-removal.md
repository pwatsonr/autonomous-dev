# SPEC-026-3-05: Eval-the-Eval Baseline + Doc-Smoke + PLAN-026-2 XFAIL Removal

## Metadata
- **Parent Plan**: PLAN-026-3
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-3 Task 9 (eval-the-eval baseline run + post-merge run + artifact capture), Task 10 (doc-only smoke test + remove deploy-runbook XFAIL from PLAN-026-2 + final anchor scan)
- **Estimated effort**: 5 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02
- **Depends on**: SPEC-026-3-01 / -02 / -03 (deploy-runbook.md complete + runbook.md See-also index), SPEC-026-3-04 (both eval YAMLs exist)

## Summary
Close the PLAN-026-3 cascade with three deliverables:
1. **Eval-the-eval baseline + post-merge runs** (Task 9): execute `evals/runner.sh --suite chains-eval` and `--suite deploy-eval` against (a) the **pre-merge HEAD** (proves negative cases catch real hallucinations TODAY) and (b) the **post-merge candidate** (proves the new SKILL/runbook content lifts pass-rate to ≥95% per FR-1538). Capture both runs as JSON artifacts in `evals/results/`. The PR description embeds both pass-rate percentages with links to the artifacts.
2. **Doc-only smoke test** (Task 10): create `tests/docs/test-deploy-runbook-and-evals-026-3.test.sh` asserting deploy-runbook structure, safety strings, negative-bag absence, runbook.md See-also block presence, eval YAML validity, ≥20/≥30 case counts, and zero SHA-pin matches. The script also runs `markdown-link-check` and treats the cred-proxy/firewall links as XFAIL (whitelisted until TDD-025).
3. **Remove the deploy-runbook XFAIL from PLAN-026-2's smoke** (Task 10): edit `tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` to drop the XFAIL block — now that `deploy-runbook.md` exists, the `chains-runbook.md` §8 → `deploy-runbook.md` cross-link resolves and the whitelist is no longer needed.

## Functional Requirements

### Eval-the-eval baseline + post-merge runs (Task 9)

| ID    | Requirement |
|-------|-------------|
| FR-1  | The implementer MUST run `evals/runner.sh --suite chains-eval --baseline` against the **pre-merge HEAD** (the commit BEFORE this PR's eval YAMLs and runbook content land — i.e., main as of the start of PLAN-026-3 work, NOT mid-PR work). The runner produces a JSON results file. |
| FR-2  | The implementer MUST run `evals/runner.sh --suite deploy-eval --baseline` against the same pre-merge HEAD. |
| FR-3  | If the runner does NOT have a `--baseline` flag, it is invoked normally and the results-file path is suffixed with `-baseline-026-3` to distinguish it from the post-merge run. |
| FR-4  | The pre-merge baseline runs MUST demonstrate that the NEGATIVE cases FAIL (the assist hallucinates the bad command today, so `must_not_mention` matches). The PR description MUST list which negative cases failed at baseline (proving they detect real hallucinations) and which passed (those whose hallucination guard happens to already hold pre-PR). |
| FR-5  | The implementer MUST run `evals/runner.sh --suite chains-eval` and `--suite deploy-eval` against the **post-merge candidate tree** (the working tree of this PR with all PLAN-026-1 / PLAN-026-2 / SPEC-026-3-01 through -04 outputs applied). |
| FR-6  | The post-merge runs MUST achieve ≥ 95% pass rate on each suite (per FR-1538). |
| FR-7  | The implementer MUST also re-run the existing 90-case suite as a regression smoke. The existing suite MUST hold ≥ 95% (per PRD-015 §8.6 quality gate). |
| FR-8  | All three results JSON files (chains-eval pre, chains-eval post, deploy-eval pre, deploy-eval post, existing-90 post) MUST be committed to `plugins/autonomous-dev-assist/evals/results/` with names matching `eval-baseline-026-3-<timestamp>.json` and `eval-post-026-3-<timestamp>.json` and `eval-regression-026-3-<timestamp>.json`. (Five files total: 2 baseline + 2 post + 1 regression, OR if combined per-suite, fewer files with the same data.) |
| FR-9  | The PR description MUST embed the pass-rate percentages from each run AND link to the result JSONs (relative paths within the repo). |
| FR-10 | If the runner consumes API budget, the implementer MUST not run the suite more than 5 times total during this spec's work (cost ceiling per TDD-026 §10.6). The total cost MUST be reported in the PR description. |

### Doc-only smoke test (Task 10, primary deliverable)

| ID    | Requirement |
|-------|-------------|
| FR-11 | A new bash script MUST be created at `plugins/autonomous-dev-assist/tests/docs/test-deploy-runbook-and-evals-026-3.test.sh`, executable (`chmod +x`), starting with `#!/usr/bin/env bash` and `set -euo pipefail`. |
| FR-12 | The script MUST assert that `instructions/deploy-runbook.md` exists and contains all eight `## ` H2 sections at the expected anchors: `## 1. Bootstrap`, `## 2. The approval state machine`, `## 3. Cost-cap trip recovery`, `## 4. Ledger inspection`, `## 5. HealthMonitor + SLA tracker`, `## 6. Rollback`, `## 7. Common errors`, `## 8. See also`. |
| FR-13 | The script MUST assert these safety strings appear in `deploy-runbook.md` with the specified minimum counts: `regardless of trust level` ≥ 3 (≥ 2 in §2, ≥ 1 in §7 mapping (7)); `do NOT edit by hand` ≥ 2; `do NOT rm the ledger` ≥ 1; `deploy ledger reset` ≥ 3 (all in §3). |
| FR-14 | The script MUST assert that the deploy negative-bag matches ZERO times across the entire `deploy-runbook.md`: regex `deploy force-approve|deploy auto-prod|deploy.*--no-approval|cost cap.*ignore`. The exception is `edit.*ledger\.json`, which is permitted ONLY on lines that ALSO contain `do NOT`. |
| FR-15 | The script MUST assert that `instructions/runbook.md` ends with a `## See also` H2 block containing four bulleted links: `chains-runbook.md`, `deploy-runbook.md`, `cred-proxy-runbook.md`, `firewall-runbook.md`. |
| FR-16 | The script MUST assert that `evals/test-cases/chains-eval.yaml` exists, passes `yamllint`, and declares ≥ 20 cases (verify via `yq '.cases | length'`). |
| FR-17 | The script MUST assert that `evals/test-cases/deploy-eval.yaml` exists, passes `yamllint`, and declares ≥ 30 cases. |
| FR-18 | The script MUST assert that the SHA-pin regex `(commit[[:space:]]+[a-f0-9]{7,40}\|as of [a-f0-9]{7,40}\|fixed in [a-f0-9]{7,40})` matches ZERO times across all new/modified files (`deploy-runbook.md`, `runbook.md`, `chains-eval.yaml`, `deploy-eval.yaml`). |
| FR-19 | The script MUST run `markdown-link-check` against `deploy-runbook.md` and `runbook.md`. The two TDD-025-owned links (`cred-proxy-runbook.md`, `firewall-runbook.md`) are XFAIL: if `markdown-link-check` reports those two as dead but no others, the test PASSES. The XFAIL block MUST contain a comment `# XFAIL: TDD-025 ships these runbooks; remove this whitelist when those runbooks land`. |
| FR-20 | The script MUST run `yamllint` on the two new eval YAMLs. |
| FR-21 | The script MUST emit `[OK]` / `[FAIL]` / `[SKIP]` lines per subtest and exit 1 if any subtest failed. |
| FR-22 | The script MUST be wired into the existing assist test dispatcher (the same dispatcher targeted by SPEC-026-1-04 and SPEC-026-2-04). |
| FR-23 | If `markdown-link-check` or `yamllint` is unavailable, the script SKIPS those subtests with `[SKIP]` and continues — does NOT fail the whole test. |

### Remove PLAN-026-2's deploy-runbook XFAIL (Task 10, secondary deliverable)

| ID    | Requirement |
|-------|-------------|
| FR-24 | The implementer MUST edit `plugins/autonomous-dev-assist/tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` (created by SPEC-026-2-04) to REMOVE the XFAIL block that whitelists the `chains-runbook.md` §8 → `deploy-runbook.md` cross-link. The block to remove begins with `# XFAIL: PLAN-026-3 lands the deploy-runbook target` and ends at the matching close of the conditional / filter. |
| FR-25 | After the XFAIL is removed, the smoke MUST validate that the cross-link `chains-runbook.md` §8 → `deploy-runbook.md` resolves (i.e., the file exists; `markdown-link-check` finds zero unexpected dead links). |
| FR-26 | The edit MUST be surgical: only the XFAIL block is removed; other assertions in the SPEC-026-2-04 smoke remain untouched. `git diff` shows only the deletion of the XFAIL lines. |
| FR-27 | After the edit, running `bash tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` MUST exit 0 (the cross-link target now exists, so the test passes without the whitelist). |

### Final anchor-convention scan (Task 10, tertiary)

| ID    | Requirement |
|-------|-------------|
| FR-28 | The doc-smoke (FR-11–23) MUST scan all six touched files (`deploy-runbook.md`, `runbook.md`, `chains-eval.yaml`, `deploy-eval.yaml`, the new smoke script, the modified PLAN-026-2 smoke script) for SHA pinning. Zero matches required. |
| FR-29 | The doc-smoke MUST run `markdownlint` on `deploy-runbook.md` and `runbook.md` — zero errors required. |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| New smoke script runtime | < 15 seconds (excludes `markdown-link-check` network) | `time bash test-deploy-runbook-and-evals-026-3.test.sh` |
| `shellcheck` pass on new smoke | 0 errors | `shellcheck test-deploy-runbook-and-evals-026-3.test.sh` |
| `markdownlint` pass on `deploy-runbook.md` | 0 errors | `markdownlint deploy-runbook.md` |
| `markdownlint` pass on `runbook.md` | 0 errors | `markdownlint runbook.md` |
| Eval pass-rate post-merge: chains-eval | ≥ 95% | from results JSON |
| Eval pass-rate post-merge: deploy-eval | ≥ 95% | from results JSON |
| Existing 90-case suite regression | ≥ 95% | from results JSON |
| Eval cost (5-run ceiling) | ≤ $25 USD | runner output's cost summary |
| Idempotent smoke output | identical 5x | 5 consecutive runs produce same stdout (modulo timestamps in [SKIP] / `markdown-link-check` output — which the script normalizes) |

## Technical Approach

### Files created
- `plugins/autonomous-dev-assist/tests/docs/test-deploy-runbook-and-evals-026-3.test.sh`
- `plugins/autonomous-dev-assist/evals/results/eval-baseline-026-3-<timestamp>.json` (chains + deploy combined OR per-suite)
- `plugins/autonomous-dev-assist/evals/results/eval-post-026-3-<timestamp>.json`
- `plugins/autonomous-dev-assist/evals/results/eval-regression-026-3-<timestamp>.json`

### Files modified
- `plugins/autonomous-dev-assist/tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` (remove XFAIL block)

### Procedure

#### Step 1: Eval-the-eval baseline (pre-merge HEAD)
1. `git stash` (or work in a separate worktree) to isolate the pre-merge HEAD.
2. Check out the commit BEFORE this PR's PLAN-026-3 changes landed (the commit at the start of the cascade — likely the merge commit of PLAN-026-2).
3. Verify `evals/test-cases/chains-eval.yaml` and `deploy-eval.yaml` are NOT present at that ref (they are the spec deliverables of SPEC-026-3-04).
4. **Special handling for missing YAMLs at baseline:** the runner cannot exercise YAMLs that don't exist at the baseline commit. Two options:
   - (a) Copy ONLY the YAMLs from the post-merge tree into the baseline checkout, run the suites, capture the result. This isolates "what the assist answered" from "what content existed".
   - (b) If the runner refuses to run with missing case files, document this as a SKIP and rely solely on the post-merge run + the negative-bag enforcement at runtime.
5. Run: `evals/runner.sh --suite chains-eval > evals/results/eval-baseline-026-3-chains.json` (or via `--baseline` flag if present).
6. Run: `evals/runner.sh --suite deploy-eval > evals/results/eval-baseline-026-3-deploy.json`.
7. Note the per-case pass/fail outcomes; specifically record which negative cases FAILED (proving they detect today's hallucinations).

#### Step 2: Eval-the-eval post-merge (this PR's working tree)
1. Return to the working tree (post-merge candidate).
2. Run: `evals/runner.sh --suite chains-eval > evals/results/eval-post-026-3-chains.json`.
3. Run: `evals/runner.sh --suite deploy-eval > evals/results/eval-post-026-3-deploy.json`.
4. Run the existing 90-case suite: `evals/runner.sh --suite help-questions > evals/results/eval-regression-026-3-help.json` (substitute the canonical 90-case suite name — read `eval-config.yaml` to confirm).
5. Verify: chains-eval ≥ 95%, deploy-eval ≥ 95%, regression ≥ 95%. If any below, do NOT merge — iterate on the runbook/SKILL content (or, in extreme cases, on the eval cases themselves if they encode the wrong expected answer).

#### Step 3: Author the doc-smoke script
1. **Read** `tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` (SPEC-026-2-04's output) for the canonical bash style: `set -euo pipefail`, `ok() / fail() / skip()` helpers, `FAIL` counter, exit logic.
2. **Author** `tests/docs/test-deploy-runbook-and-evals-026-3.test.sh` covering FR-11–23.
3. **Wire** into the existing test dispatcher (`Grep` for the SPEC-026-2-04 smoke filename; add the new smoke alongside).
4. **Run** the script against the post-spec tree; iterate until exit 0.
5. **shellcheck** the script (zero errors).

#### Step 4: Remove the PLAN-026-2 XFAIL
1. `Edit` `tests/docs/test-classifier-and-chains-runbook-026-2.test.sh`.
2. Use `old_string` containing the XFAIL comment + the conditional block; replace with `new_string` containing only the simple `markdown-link-check` invocation (no whitelist). The exact text depends on SPEC-026-2-04's implementation; the implementer reads the file first to confirm.
3. Run the modified PLAN-026-2 smoke against the post-spec tree; verify exit 0.
4. Run `shellcheck` on the modified file (zero errors).

#### Step 5: Final scans
1. `markdownlint deploy-runbook.md runbook.md` exits 0.
2. `yamllint chains-eval.yaml deploy-eval.yaml` exits 0.
3. SHA-pin regex grep across all six touched files: 0 matches.
4. `markdown-link-check` on the four touched runbook/eval files: only `cred-proxy-runbook.md` and `firewall-runbook.md` dead (XFAIL whitelisted in the new smoke).

### Smoke-script structure (illustrative)

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
ASSIST_DIR="${REPO_ROOT}/plugins/autonomous-dev-assist"
DEPLOY_RB="${ASSIST_DIR}/instructions/deploy-runbook.md"
RUNBOOK="${ASSIST_DIR}/instructions/runbook.md"
CHAINS_EVAL="${ASSIST_DIR}/evals/test-cases/chains-eval.yaml"
DEPLOY_EVAL="${ASSIST_DIR}/evals/test-cases/deploy-eval.yaml"

FAIL=0
ok()   { echo "[OK]   $*"; }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }
skip() { echo "[SKIP] $*"; }

# FR-12 deploy-runbook eight H2 sections
[[ -f "$DEPLOY_RB" ]] && ok "deploy-runbook.md exists" || fail "deploy-runbook.md missing"

for hdr in '^## 1\. Bootstrap' \
           '^## 2\. The approval state machine' \
           '^## 3\. Cost-cap trip recovery' \
           '^## 4\. Ledger inspection' \
           '^## 5\. HealthMonitor \+ SLA tracker' \
           '^## 6\. Rollback' \
           '^## 7\. Common errors' \
           '^## 8\. See also'; do
  grep -qE "$hdr" "$DEPLOY_RB" && ok "deploy-runbook: $hdr" \
                              || fail "deploy-runbook: missing $hdr"
done

# FR-13 safety strings
rotl=$(grep -c 'regardless of trust level' "$DEPLOY_RB" || true)
(( rotl >= 3 )) && ok "deploy-runbook: 'regardless of trust level' x$rotl" \
                || fail "deploy-runbook: 'regardless of trust level' = $rotl (need >=3)"

dnh=$(grep -c 'do NOT edit by hand' "$DEPLOY_RB" || true)
(( dnh >= 2 )) && ok "deploy-runbook: 'do NOT edit by hand' x$dnh" \
              || fail "deploy-runbook: 'do NOT edit by hand' = $dnh (need >=2)"

dnr=$(grep -c 'do NOT rm the ledger' "$DEPLOY_RB" || true)
(( dnr >= 1 )) && ok "deploy-runbook: 'do NOT rm the ledger' x$dnr" \
              || fail "deploy-runbook: 'do NOT rm the ledger' = $dnr (need >=1)"

dlr=$(grep -c 'deploy ledger reset' "$DEPLOY_RB" || true)
(( dlr >= 3 )) && ok "deploy-runbook: 'deploy ledger reset' x$dlr" \
              || fail "deploy-runbook: 'deploy ledger reset' = $dlr (need >=3)"

# FR-14 negative-bag absence
neg=$(grep -cE 'deploy force-approve|deploy auto-prod|deploy.*--no-approval|cost cap.*ignore' "$DEPLOY_RB" || true)
(( neg == 0 )) && ok "deploy-runbook: deploy negative-bag absent" \
               || fail "deploy-runbook: $neg negative-bag matches"

# edit.*ledger\.json only inside 'do NOT' lines
bad=$(grep -E 'edit.*ledger\.json' "$DEPLOY_RB" | grep -vc 'do NOT' || true)
(( bad == 0 )) && ok "deploy-runbook: 'edit.*ledger.json' only in do-NOT context" \
              || fail "deploy-runbook: $bad lines mention edit-ledger outside do-NOT"

# FR-15 runbook.md See-also tail
last_h2=$(grep -n '^## ' "$RUNBOOK" | tail -1 | cut -d: -f2-)
[[ "$last_h2" == "## See also" ]] && ok "runbook.md ends with ## See also" \
                                  || fail "runbook.md tail H2 = '$last_h2' (expected ## See also)"

for target in 'chains-runbook.md' 'deploy-runbook.md' 'cred-proxy-runbook.md' 'firewall-runbook.md'; do
  awk '/^## See also/,/EOF/' "$RUNBOOK" | grep -q "$target" \
    && ok "runbook.md See-also: $target" \
    || fail "runbook.md See-also: missing link to $target"
done

# FR-16 / FR-17 eval YAMLs
[[ -f "$CHAINS_EVAL" ]] && ok "chains-eval.yaml exists" || fail "chains-eval.yaml missing"
[[ -f "$DEPLOY_EVAL" ]] && ok "deploy-eval.yaml exists" || fail "deploy-eval.yaml missing"

if command -v yq >/dev/null 2>&1; then
  cn=$(yq '.cases | length' "$CHAINS_EVAL" 2>/dev/null || echo 0)
  (( cn >= 20 )) && ok "chains-eval: $cn cases" || fail "chains-eval: $cn cases (need >=20)"
  dn=$(yq '.cases | length' "$DEPLOY_EVAL" 2>/dev/null || echo 0)
  (( dn >= 30 )) && ok "deploy-eval: $dn cases" || fail "deploy-eval: $dn cases (need >=30)"
else
  skip "yq not installed; cannot count cases"
fi

if command -v yamllint >/dev/null 2>&1; then
  yamllint "$CHAINS_EVAL" >/dev/null 2>&1 && ok "yamllint chains-eval" || fail "yamllint chains-eval"
  yamllint "$DEPLOY_EVAL" >/dev/null 2>&1 && ok "yamllint deploy-eval" || fail "yamllint deploy-eval"
else
  skip "yamllint not installed"
fi

# FR-18 SHA-pin scan across all six touched files
SHA_RE='(commit[[:space:]]+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})'
for f in "$DEPLOY_RB" "$RUNBOOK" "$CHAINS_EVAL" "$DEPLOY_EVAL"; do
  c=$(grep -cE "$SHA_RE" "$f" || true)
  (( c == 0 )) && ok "no SHA pin in $(basename "$f")" \
              || fail "SHA pin in $(basename "$f"): $c match(es)"
done

# FR-19 markdown-link-check with cred-proxy / firewall XFAIL
# XFAIL: TDD-025 ships these runbooks; remove this whitelist when those runbooks land
if command -v markdown-link-check >/dev/null 2>&1; then
  out=$(markdown-link-check --quiet "$RUNBOOK" 2>&1 || true)
  filtered=$(echo "$out" | grep -E '^\s*\[✖\]' | grep -vE 'cred-proxy-runbook\.md|firewall-runbook\.md' || true)
  if [[ -z "$filtered" ]]; then
    ok "link-check runbook.md (cred-proxy/firewall XFAIL whitelisted)"
  else
    fail "link-check runbook.md: unexpected dead links: $filtered"
  fi
  markdown-link-check --quiet "$DEPLOY_RB" >/dev/null 2>&1 \
    && ok "link-check deploy-runbook.md" \
    || fail "link-check deploy-runbook.md"
else
  skip "markdown-link-check not installed"
fi

# FR-29 markdownlint
if command -v markdownlint >/dev/null 2>&1; then
  markdownlint "$DEPLOY_RB" >/dev/null 2>&1 && ok "markdownlint deploy-runbook" || fail "markdownlint deploy-runbook"
  markdownlint "$RUNBOOK"   >/dev/null 2>&1 && ok "markdownlint runbook"        || fail "markdownlint runbook"
else
  skip "markdownlint not installed"
fi

(( FAIL > 0 )) && { echo ""; echo "FAILED: $FAIL subtest(s)"; exit 1; }
echo ""
echo "PASSED: PLAN-026-3 invariants hold"
exit 0
```

## Interfaces and Dependencies
- **Consumes**: outputs of SPEC-026-3-01/-02/-03/-04 (the runbook + index + two eval YAMLs); SPEC-026-2-04 smoke (the file edited to remove XFAIL); existing `runner.sh`, `scorer.sh`, and `eval-config.yaml`.
- **Produces**: the doc-smoke script, the eval result JSONs, and the modified PLAN-026-2 smoke.
- **Closes**: the PLAN-026-3 cascade. After this spec, all DoD bullets in PLAN-026-3 are satisfied.

## Acceptance Criteria

### Eval pass-rates (the dominant FR-1538 quality gate)
```
Given the post-merge candidate tree
When `evals/runner.sh --suite chains-eval` is run
Then >= 95% of cases pass
And the result JSON is committed to evals/results/

Given the post-merge candidate tree
When `evals/runner.sh --suite deploy-eval` is run
Then >= 95% of cases pass

Given the post-merge candidate tree
When the existing 90-case suite is run
Then >= 95% of cases pass
And no case that passed pre-PR fails post-PR (regression check)
```

### Negative-cases-fail-at-baseline contract
```
Given the pre-merge HEAD
When the chains-eval and deploy-eval suites are run with the post-PR YAMLs
Then >= 1 negative case (must_not_mention) FAILS at baseline
And the PR description lists the failing-at-baseline cases by id (proves the cases detect real hallucinations)
```

### Smoke script existence and pass
```
Given the post-spec tree
When `bash plugins/autonomous-dev-assist/tests/docs/test-deploy-runbook-and-evals-026-3.test.sh` is run
Then exit 0
And stdout contains "PASSED: PLAN-026-3 invariants hold"
```

### Smoke detects regressions (mutation matrix)
```
Given the smoke script
When deploy-runbook.md is mutated to remove "do NOT edit by hand"
Then the script exits 1 with FAIL referencing 'do NOT edit by hand'

Given the smoke script
When the runbook.md "## See also" block is removed
Then the script exits 1

Given the smoke script
When chains-eval.yaml is reduced to 19 cases
Then the script exits 1

Given the smoke script
When a SHA pin "as of c1884eb" is inserted into deploy-runbook.md
Then the script exits 1

Given the smoke script
When a phrase "edit ledger.json fields manually" is added to deploy-runbook.md (without 'do NOT' on the same line)
Then the script exits 1
```

### XFAIL removal in PLAN-026-2 smoke
```
Given the post-spec tree
When `grep 'XFAIL: PLAN-026-3 lands the deploy-runbook target' tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` is run
Then 0 matches (the XFAIL comment is removed)

Given the post-spec tree
When `bash tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` is run
Then exit 0 (the cross-link to deploy-runbook.md now resolves without whitelisting)
```

### shellcheck and markdownlint
```
Given the new smoke script
When `shellcheck` is run
Then exit 0

Given the modified PLAN-026-2 smoke
When `shellcheck` is run
Then exit 0

Given deploy-runbook.md and runbook.md
When `markdownlint` is run on each
Then exit 0
```

### PR description embeds artifacts
```
Given the merged PR
When the PR description is read
Then it embeds chains-eval pass-rate >= 95% with a link to the result JSON
And it embeds deploy-eval pass-rate >= 95% with a link to the result JSON
And it embeds the existing-90-case regression pass-rate >= 95%
And it lists which negative cases failed at baseline (proving the cases detect today's hallucinations)
And it reports the total eval cost (USD) for the runs in this spec's work
```

### Wiring into the test dispatcher
```
Given the existing test dispatcher
When invoked
Then it transitively runs test-deploy-runbook-and-evals-026-3.test.sh
And on failure of that script, the dispatcher exit code is non-zero
```

## Test Requirements
- Run the new smoke script against the post-spec tree → exit 0.
- Run the mutation matrix (5 mutations listed above) → 5 yield exit 1.
- `shellcheck` on both smoke scripts → 0 errors each.
- Verify the modified PLAN-026-2 smoke runs green WITHOUT the XFAIL block (the deploy-runbook.md target exists post-merge).
- Eval pass-rate gates: chains-eval ≥ 95%, deploy-eval ≥ 95%, existing-90 ≥ 95%.
- Manually inspect 2 result JSONs and confirm the per-case pass/fail breakdown is sensible (no suspicious 100% pass that would suggest the scorer is broken).

## Implementation Notes
- **Eval baseline strategy.** Running the suites against the literal pre-merge HEAD requires the eval YAMLs to exist at that ref — they don't. The pragmatic approach: copy the YAMLs from the working tree onto the baseline checkout, run the suites against the OLD assist's prompt + OLD SKILL/runbook content, and capture the results. This isolates "the assist's pre-PR knowledge" as the variable and proves the new content lifts pass-rate. Document the methodology in the PR description.
- **Cost ceiling.** TDD-026 §10.6 caps per-PR eval spend at ~$5 (chains-eval + deploy-eval at $2.50 each). The 5-run ceiling for THIS spec's work allows: 2 baseline + 2 post + 1 regression = 5 runs total, ~$25. If any run requires re-execution (a flake), report it in the PR.
- **Result JSON stability.** The runner's JSON output may include timestamps and per-case latency that differ across runs. The smoke script does NOT assert on the JSON content — only that the file exists and that the pass-rate header line meets the threshold. The PR description quotes the pass-rate from the JSON.
- **`markdownlint --on PUSH only.`** If the project's CI runs `markdownlint` on push (not on every save), the smoke script's `markdownlint` invocation may exit 0 locally but reveal issues in CI. The smoke runs BOTH locally and in CI; if local passes but CI fails, investigate the version drift.
- **The XFAIL removal is a contract.** SPEC-026-2-04's DoD documented that SPEC-026-3-05 would remove the XFAIL. This spec satisfies that contract. Failing to do so leaves a warning whitelist that is no longer needed and confuses future maintainers.
- **Don't expand the new smoke beyond its FRs.** Adding "while we're here, also check X" creates a smoke that does too much and runs slowly. The new smoke is laser-focused on PLAN-026-3 invariants. Smoke tests for other plans live in their own files.
- **Edge case: TDD-025 lands first.** If TDD-025 ships `cred-proxy-runbook.md` / `firewall-runbook.md` BEFORE this PR merges, the XFAIL block in this spec's new smoke is no longer needed for those two files (they exist). The implementer should detect this at merge time and remove the XFAIL preemptively. Document in PR if it happens.

## Rollout Considerations
- Pure documentation + tests + result artifacts. No runtime impact on the assist.
- Rollback: `git revert` removes the new smoke script + the result JSONs + the XFAIL deletion (re-introducing the XFAIL block). The rollback is safe because the runbook + eval YAMLs (created by SPEC-026-3-01 through -04) remain — the smoke just stops enforcing them.
- The eval suites become CI-gated only after TDD-028 §6 wires them into `eval-config.yaml`. The PR's pass-rate is captured manually here; the recurring CI gate ships in TDD-028.

## Effort Estimate
- Eval baseline + post + regression runs (≤ 5 runs total, ~30 min each with API latency): 2 hours
- Result-artifact authoring + PR-description embedding: 0.5 hour
- Smoke-script authoring + shellcheck: 1.5 hours
- XFAIL removal in PLAN-026-2 smoke + verification: 0.5 hour
- Mutation-matrix validation: 0.5 hour
- **Total: 5 hours**
