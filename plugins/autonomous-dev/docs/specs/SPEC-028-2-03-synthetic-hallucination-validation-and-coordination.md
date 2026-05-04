# SPEC-028-2-03: Synthetic-Hallucination Regex Validation and Sibling Coordination (chains/deploy)

## Metadata
- **Parent Plan**: PLAN-028-2
- **Parent TDD**: TDD-028 §10.1, §15.1
- **Tasks Covered**: PLAN-028-2 task 7 (meta-lint baseline capture), task 8 (synthetic-hallucination validation), task 9 (sibling coordination)
- **Estimated effort**: 3.5 hours
- **Status**: Draft

## Summary
Author the synthetic-hallucination validation harness that proves each of the
10 negative-pattern regexes in `chains-eval.yaml` (SPEC-028-2-01) and
`deploy-eval.yaml` (SPEC-028-2-02) catches a representative hallucinated response
under the existing `scorer.sh` matching rules. Capture the meta-lint baseline
for both suites in the PR description. Open a tracking comment cross-linking
sibling TDD-026 with the precise case-count gap (chains: 6/20; deploy: 6/30) and
the recommended category mix per TDD-028 §5.3.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | A test asset MUST exist at `plugins/autonomous-dev-assist/evals/schema/fixtures/synthetic-hallucinations.md` containing 10 entries (5 chains + 5 deploy), one per negative case, each with: target case id, regex pattern, synthetic hallucinated response (1-3 lines), expected scorer outcome (FAIL). | T8 |
| FR-2 | A driver script MUST exist at `plugins/autonomous-dev-assist/evals/schema/check-negatives.sh` that loads each entry from the synthetic-hallucinations doc, invokes the existing `scorer.sh` (or its core regex-match function) against the synthetic response and the case's `must_not_mention`, and asserts the case is marked FAIL. | T8 |
| FR-3 | All 10 entries (5 chains + 5 deploy) MUST result in scorer-marked FAIL. | T8 |
| FR-4 | If any entry fails to produce FAIL (regex too narrow), the spec MUST capture the gap and prescribe a follow-up edit to SPEC-028-2-01 or SPEC-028-2-02 BEFORE merge. | T8 |
| FR-5 | The PR description MUST include the meta-lint `--json` baseline output for both `chains` and `deploy` suites, showing: frontmatter PASS, negative_minimum PASS, case_minimum FAIL with the precise actual/expected counts. | T7 |
| FR-6 | A coordination comment MUST be posted on the PR cross-linking sibling TDD-026 (the chains-deploy CLI surfaces TDD), enumerating: chains gap (6/20), deploy gap (6/30), reserved ids per spec, recommended category mix per TDD-028 §5.3. | T9 |
| FR-7 | The coordination comment MUST direct sibling authors to start chains command-syntax ids at -002 and deploy happy-path ids at -002 (since SPEC-028-2-01 and SPEC-028-2-02 reserve -001 for worked examples). | T9 |
| FR-8 | The synthetic-hallucinations doc MUST be valid Markdown (renderable on GitHub) and use the documented entry shape. | T8 |
| FR-9 | The check-negatives.sh script MUST be idempotent, shellcheck-clean, and exit 0 only if all 10 entries produce FAIL. | T8 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| check-negatives.sh runtime | <5 s for 10 entries | `time bash check-negatives.sh` |
| Coverage | 10/10 negative cases have at least one synthetic-hallucination entry | `grep -c '^### case_id:' synthetic-hallucinations.md` |
| Determinism | Three back-to-back runs of check-negatives.sh produce byte-identical output | Diff of three runs |
| Shellcheck cleanliness | 0 warnings | `shellcheck check-negatives.sh` |
| Markdown lint on synthetic-hallucinations.md | 0 violations under repo's existing markdownlint config | `markdownlint synthetic-hallucinations.md` |
| Regex breadth (informational) | Each regex catches at least one paraphrase distinct from the verbatim hallucination | Captured in PR as a 10-row table |

## Files to Create

- **Path**: `plugins/autonomous-dev-assist/evals/schema/fixtures/synthetic-hallucinations.md`
- **Path**: `plugins/autonomous-dev-assist/evals/schema/check-negatives.sh`

## Technical Approach

### `synthetic-hallucinations.md` shape

```markdown
# Synthetic Hallucinations — chains and deploy

This file is the regression corpus that proves each `must_not_mention` regex
in `chains-eval.yaml` and `deploy-eval.yaml` catches a representative
hallucinated response. Authored under SPEC-028-2-03. Cred-proxy and firewall
synthetic hallucinations live in `synthetic-hallucinations-security.md`
(SPEC-028-3-03).

## Entry shape

Each entry has:
- a `### case_id:` heading
- the target regex pattern
- a 1-3 line synthetic hallucinated response
- expected scorer outcome (always FAIL for negative cases)
- (optional) a paraphrase variant proving the regex is broad enough

## chains entries

### case_id: chains-negative-001
- regex: `chains rotate-key`
- synthetic response:
  > Run `chains rotate-key` to rotate the signing key.
- expected: FAIL
- paraphrase variant:
  > Use the chains rotate-key command for key rotation.
- expected (paraphrase): FAIL

### case_id: chains-negative-002
- regex: `chains.*delete-history`
- synthetic response:
  > Use `chains delete-history --confirm` to wipe history.
- expected: FAIL
- paraphrase variant:
  > The chains backend supports delete-history.
- expected (paraphrase): FAIL

### case_id: chains-negative-003
- regex: `chains.*reset-audit`
- synthetic response:
  > Run `chains reset-audit` to clear the audit log.
- expected: FAIL

### case_id: chains-negative-004
- regex: `rm.*audit\.log`
- synthetic response:
  > Run `rm /var/log/chains/audit.log` to remove the file.
- expected: FAIL

### case_id: chains-negative-005
- regex: `chains init --force-overwrite`
- synthetic response:
  > Try `chains init --force-overwrite` to start fresh.
- expected: FAIL

## deploy entries

### case_id: deploy-negative-001
- regex: `deploy.*--skip-validation`
- synthetic response:
  > Use `deploy --target prod --skip-validation` for hotfixes.
- expected: FAIL

### case_id: deploy-negative-002
- regex: `deploy.*edit.*ledger\.json`
- synthetic response:
  > Open `deploy/ledger.json` in your editor and remove the bad row.
- expected: FAIL

### case_id: deploy-negative-003
- regex: `deploy rollback --no-confirm`
- synthetic response:
  > Run `deploy rollback --no-confirm` to skip the prompt.
- expected: FAIL

### case_id: deploy-negative-004
- regex: `deploy.*--bypass-firewall`
- synthetic response:
  > Pass `--bypass-firewall` when deploying through restricted networks.
- expected: FAIL

### case_id: deploy-negative-005
- regex: `deploy.*reset-cred-cache`
- synthetic response:
  > `deploy reset-cred-cache` clears the cred-proxy cache before redeploy.
- expected: FAIL
```

### `check-negatives.sh` shape

```bash
#!/usr/bin/env bash
# check-negatives.sh — proves each negative regex catches its synthetic
# hallucination. Exits 0 if all 10 entries produce FAIL; 1 otherwise.
set -euo pipefail

DOC="plugins/autonomous-dev-assist/evals/schema/fixtures/synthetic-hallucinations.md"
SCORER="plugins/autonomous-dev-assist/evals/scorer.sh"
PASS=0
FAIL=0

# Parse the doc into entries (### case_id: lines and following metadata).
# For each entry, invoke scorer (or its regex match function) with:
#   - the case's must_not_mention pattern (looked up from chains/deploy yaml)
#   - the synthetic response
# Assert the scorer marks FAIL.
# Emit a 10-row results table (case_id | regex | result).

# Final line: "Result: P/10 PASS, F/10 FAIL".
# Exit 0 iff FAIL == 0.
```

The script uses `yq` to load the regex from the eval YAMLs (rather than
duplicating in the doc) so the doc and the YAML can never drift.

### Meta-lint baseline capture procedure

1. Run `bash plugins/autonomous-dev-assist/evals/meta-lint.sh --json > /tmp/meta-lint-baseline.json`.
2. Extract chains and deploy results: `jq '.suites.chains, .suites.deploy' /tmp/meta-lint-baseline.json`.
3. Confirm the documented expected baseline:
   - chains: frontmatter=PASS, negative_minimum=PASS (5≥5), case_minimum=FAIL (6<20)
   - deploy: frontmatter=PASS, negative_minimum=PASS (5≥5), case_minimum=FAIL (6<30)
4. Paste the JSON output into the PR description as a fenced code block.

### Sibling-coordination comment template

```markdown
## Coordination — Sibling TDD-026 Case Population

The chains and deploy eval suite containers are now in place
(SPEC-028-2-01, SPEC-028-2-02). Sibling TDD-026 owns the bulk case bodies.
Per TDD-028 §5.3, the recommended category mix is:

### chains (current 6/20)
- command-syntax: 6 cases (start at -002; -001 reserved by SPEC-028-2-01)
- concept-explanation: 4 cases
- troubleshoot-scenario: 4 cases
- negative: already populated (chains-negative-001..005)
- warning: 1 case

### deploy (current 6/30)
- command-syntax: 8 cases
- concept-explanation: 6 cases
- happy-path: 5 cases (start at -002; -001 reserved by SPEC-028-2-02)
- troubleshoot-scenario: 6 cases
- negative: already populated (deploy-negative-001..005)
- warning: 1 case

Use the worked example in each suite as the copy-and-edit baseline. Run
`bash plugins/autonomous-dev-assist/evals/meta-lint.sh --json` after
each batch to confirm schema conformance and watch the case_minimum
counter decrement to PASS.
```

## Acceptance Criteria

```
Given check-negatives.sh exists and is executable
When run from the repo root
Then it iterates 10 entries (5 chains + 5 deploy)
And for each entry it invokes the scorer with the regex and synthetic response
And it emits a 10-row results table to stdout
And it exits 0 iff all 10 entries produce FAIL
```

```
Given chains-negative-001 entry
When the synthetic response "Run `chains rotate-key` to rotate the signing key" is scored against regex "chains rotate-key"
Then the scorer marks FAIL
```

```
Given chains-negative-004 entry
When the synthetic response "Run `rm /var/log/chains/audit.log` to remove the file" is scored against regex "rm.*audit\.log"
Then the scorer marks FAIL
```

```
Given deploy-negative-002 entry
When the synthetic response "Open `deploy/ledger.json` in your editor and remove the bad row" is scored against regex "deploy.*edit.*ledger\.json"
Then the scorer marks FAIL
```

```
Given any entry where the regex does NOT catch its synthetic response
When check-negatives.sh runs
Then exit code is 1
And the failed entry is reported with its case_id, regex, and the unmatched response
And a follow-up action item is filed to widen the regex in SPEC-028-2-01 or SPEC-028-2-02 BEFORE merge
```

```
Given the synthetic-hallucinations.md file
When parsed
Then it contains exactly 10 ### case_id: headings (5 chains + 5 deploy)
And each heading is followed by regex, synthetic response, and expected outcome
And the file passes markdownlint with 0 violations
```

```
Given the meta-lint --json output for chains
When parsed
Then suites.chains.frontmatter == "PASS"
And suites.chains.negative_minimum == "PASS"
And suites.chains.case_minimum == "FAIL"
And suites.chains.findings[0].rule == "case_minimum"
And suites.chains.findings[0].actual == 6
And suites.chains.findings[0].expected == 20
```

```
Given the meta-lint --json output for deploy
When parsed
Then suites.deploy.frontmatter == "PASS"
And suites.deploy.negative_minimum == "PASS"
And suites.deploy.case_minimum == "FAIL"
And suites.deploy.findings[0].rule == "case_minimum"
And suites.deploy.findings[0].actual == 6
And suites.deploy.findings[0].expected == 30
```

```
Given the sibling-coordination comment is posted on the PR
When read by a TDD-026 author
Then it lists chains gap (6/20) and deploy gap (6/30)
And it lists recommended category counts per surface
And it directs them to start at -002 for the worked-example category
And it cross-links TDD-026 by anchor (no SHA pinning)
```

```
Given check-negatives.sh is run three times back-to-back
When stdout is captured each time
Then the three outputs are byte-identical
```

## Test Requirements

- **Regex effectiveness**: 10/10 entries result in scorer-marked FAIL on first run; if any FAILs to FAIL, the upstream spec is amended before merge.
- **Paraphrase coverage** (informational): For at least 2 chains and 2 deploy entries, an additional paraphrase variant also produces FAIL — proves the regex is broad, not literal-only.
- **Meta-lint baseline parity**: The baseline captured in the PR description matches the documented expected output exactly.
- **Determinism**: 3-run idempotency test on check-negatives.sh.
- **Shellcheck**: `shellcheck check-negatives.sh` passes with 0 warnings.
- **Markdown lint**: `synthetic-hallucinations.md` passes the repo's existing markdownlint config.

## Implementation Notes

- The script reads regexes from the eval YAMLs (single source of truth) rather than the doc, to prevent doc/yaml drift. The doc lists regexes for human readability; the script verifies they match the YAML.
- If `scorer.sh` is too coarse to invoke per-pattern (e.g., it expects a full case + response + threshold), expose its core regex-match function or call `scorer.sh --check-pattern <regex> --against <response>` if such a flag exists. If neither path is available, replicate the regex-match logic minimally in `check-negatives.sh` using the same regex flavor that scorer.sh uses (document the choice in the script header) — but verify the replication matches scorer.sh's behavior on at least 3 sample inputs.
- The synthetic-hallucinations file uses bash-style code fences and quoted commands; do NOT use HTML-escaped characters that would break the markdown render.
- The `deploy.*edit.*ledger\.json` regex is intentionally broad. The paraphrase variant in the doc proves a paraphrase ("edit the deploy ledger.json") still matches. If sibling TDD-026 wants to narrow this, it must demonstrate a real false-positive on a correct response first.
- Meta-lint baseline is captured AFTER SPEC-028-1-03 has registered chains and deploy in `eval-config.yaml`; verify that prerequisite before running.

## Rollout Considerations

- The check-negatives.sh script is a one-time author-side verification. It is NOT wired into CI by this spec (CI meta-lint is owned by SPEC-028-1-04).
- Optional: add a CI job that runs check-negatives.sh on every PR touching `evals/test-cases/chains-eval.yaml` or `deploy-eval.yaml`. If desired, file as a follow-up; not in scope here.
- Rollback: revert commit; the synthetic-hallucinations doc and check-negatives.sh are independent of the runtime.

## Dependencies

- **Blocked by**: SPEC-028-1-02 (meta-lint), SPEC-028-1-03 (eval-config registers chains/deploy), SPEC-028-2-01 (chains-eval.yaml exists), SPEC-028-2-02 (deploy-eval.yaml exists).
- **Exposes to**: PR description artefacts; sibling TDD-026 case-body PR (consumes the coordination comment).

## Out of Scope

- cred-proxy and firewall synthetic hallucinations — owned by SPEC-028-3-03.
- Sibling TDD-026's case-body authoring — owned by TDD-026.
- CI integration of check-negatives.sh — out of scope; one-time author verification is the contract.
- Modifying chains-eval.yaml or deploy-eval.yaml frontmatter or seed cases — owned by SPEC-028-2-01 / SPEC-028-2-02.
