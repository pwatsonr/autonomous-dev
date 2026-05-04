# SPEC-033-2-03: Phase 12 Eval Set + PRD-015 Cross-Link Duplication Scanner

## Metadata
- **Parent Plan**: PLAN-033-2
- **Parent TDD**: TDD-033 §9.1, §9.4
- **Parent PRD**: AMENDMENT-002 AC-03, AC-05
- **Tasks Covered**: PLAN-033-2 Task 3
- **Estimated effort**: 1.5 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Author the phase-12 eval set: five cases including a dedicated
`linked-prd-no-duplication.md` that regex-scans the rendered phase 12
output against PRD-015's chain section for any verbatim sentence
≥ 40 characters and asserts zero matches (AMENDMENT-002 AC-05). The
remaining four cases cover the canonical happy-path / skip /
error-recovery / idempotency-resume rubric per TDD-033 §9.1, plus the
token-scope downgrade case from TDD-033 §9.4.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                            | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | An eval directory at `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-12-ci-setup/` MUST contain exactly five eval case files: `happy-path.md`, `skip-with-consequence.md`, `error-recovery.md`, `idempotency-resume.md`, `linked-prd-no-duplication.md`. | T3   |
| FR-2  | Each eval case file MUST conform to the eval-case schema defined in TDD-033 §9.1 (front-matter: `phase`, `case_type`, `expected_outcome`, `assertions[]`; body: setup steps, run steps, assertion sections). | T3   |
| FR-3  | `happy-path.md` MUST exercise: GitHub origin + scoped PAT + admin perms → workflows scaffolded → repo secret set → branch protection on → probe-PR runs green within 5 min → PR closed (NOT merged) → branch deleted → state written. It MUST emit assertion `verification line {"phase":12,"step":"verify","status":"completed"} present in wizard.log`. | T3   |
| FR-4  | `happy-path.md` MUST include a token-leak sweep assertion: `regex "ghp_[A-Za-z0-9]{36}" against {stdout, wizard.log, transcript}` returns 0 matches. | T3   |
| FR-5  | `happy-path.md` MUST include a probe-PR-merge-blocked assertion: while the probe-PR's checks are pending, the PR's `mergeable_state` is `blocked` (proves branch protection is enforced). | T3   |
| FR-6  | `skip-with-consequence.md` MUST simulate a non-GitHub origin (gitlab.com fixture) and assert: the verbatim consequence text "GitHub-only support; daemon will run but workflow validation must be done manually." appears in operator-facing output; `phases.12.status == "skipped"`; no `.github/workflows/*` files written; no `gh` invocations recorded. | T3   |
| FR-7  | `error-recovery.md` MUST cover the **token-scope downgrade** case from TDD-033 §9.4: PAT has `repo` only (no admin permission on repo). Asserts: `gh_token_has_admin_scope` returns 1; phase aborts with diagnostic "your token needs `repo` + `workflow` scopes; current token does not have admin permissions on this repo"; **zero partial state** (no workflow files, no secret, no protection). | T3   |
| FR-8  | `error-recovery.md` MUST also cover a probe-PR run-failure sub-case: PAT has scopes, scaffolds succeed, branch protection set, but the probe-PR's CI workflow exits non-zero. Asserts: cleanup-trap fires; PR closed; branch deleted; phase status="failed"; diagnostic enumerates failed contexts. | T3   |
| FR-9  | `idempotency-resume.md` MUST cover three sub-cases: (a) workflows already scaffolded matching template hash → skip rescaffold; (b) branch protection already configured with matching contexts → skip protection write; (c) phase killed mid-probe-PR → re-run uses fresh timestamp branch (no collision) AND offers to clean up the prior stale branch. | T3   |
| FR-10 | `linked-prd-no-duplication.md` MUST regex-scan the rendered phase 12 output (transclusion of `phase-12-ci-setup.md` with all banners, prose, and code blocks) for any contiguous sentence ≥ 40 characters that also appears verbatim in `docs/prds/PRD-015-...md`'s chain section. The case MUST assert zero matches. | T3   |
| FR-11 | The duplication-scanner case MUST be deterministic: the scanner script reads both files, splits the rendered phase output into sentence-like fragments using delimiters `[.!?]\s+`, drops fragments < 40 chars, and exact-matches each against the PRD-015 chain section. Match → fail with the offending sentence printed. | T3   |
| FR-12 | The duplication-scanner case MUST run on every PR that modifies either `phases/phase-12-ci-setup.md` OR `docs/prds/PRD-015-*.md` (CI gating; documented in `STAGE-3-CANARY.md` SPEC-033-2-05). | T3   |
| FR-13 | The five-case suite MUST achieve ≥ 90% pass rate per TDD-033 §9.3 / AMENDMENT-002 AC-03. The duplication-scanner case is **mandatory pass** (auto-fail of the suite on any duplication detection per TDD-033 §15 risk "coordination drift"). | T3   |
| FR-14 | Every eval case MUST assert structured log lines per TDD-033 §10.5: `{"phase": 12, "step": "<name>", "status": "<state>", "duration_ms": N}` for at least the major step transitions (intro, verify-scopes, scaffold-workflows, configure-protection, probe-pr-create, cleanup-probe). | T3   |

## 3. Non-Functional Requirements

| Requirement                       | Target                                                                  | Measurement Method                                                |
|-----------------------------------|-------------------------------------------------------------------------|-------------------------------------------------------------------|
| Suite pass rate                   | ≥ 90% per TDD-033 §9.3                                                   | eval framework score over the five cases                          |
| Duplication-scanner auto-fail     | Any ≥40-char verbatim match → suite fails                                | scanner exit code propagates                                       |
| Token-leak sweep coverage         | All four streams (stdout, stderr, wizard.log, transcript) per case      | regex grep across captured artifacts                               |
| Suite runtime (CI)                | < 12 minutes wall clock total (probe-PR is the dominant cost)            | CI duration metric                                                 |
| Determinism                       | 0 flakes across 10 consecutive runs                                      | flake-detection job in nightly CI                                   |
| Eval-case schema conformance      | All five files validate against TDD-033 §9.1 schema                      | bats schema-validator test                                          |

## 4. Technical Approach

**Files created:**
- `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-12-ci-setup/happy-path.md`
- `.../phase-12-ci-setup/skip-with-consequence.md`
- `.../phase-12-ci-setup/error-recovery.md`
- `.../phase-12-ci-setup/idempotency-resume.md`
- `.../phase-12-ci-setup/linked-prd-no-duplication.md`
- `plugins/autonomous-dev-assist/evals/scanners/prd-duplication-scanner.sh` — the regex scanner used by FR-11.

**Eval-case file shape (canonical front-matter):**

```yaml
---
phase: 12
case_type: happy-path | skip-with-consequence | error-recovery | idempotency-resume | linked-prd-no-duplication
expected_outcome: complete | skipped | failed | scanner-clean
fixture_repo: tests/fixtures/setup-wizard/repos/<name>
fixture_token: tests/fixtures/setup-wizard/tokens/<name>.env
gh_shim_responses: tests/fixtures/setup-wizard/gh-shims/<name>.json
assertions:
  - id: A-1
    description: <human readable>
    type: regex-match | exit-code | file-exists | file-hash | log-line | scanner-clean
    expected: <pattern or value>
---
```

**`happy-path.md` outline:**

```markdown
# Setup
- Fixture repo: tests/fixtures/setup-wizard/repos/github-happy (origin=git@github.com:fixture-org/fixture-repo.git)
- Fixture PAT: ghp_FAKETESTHAPPYTOKEN0123456789012345678901
- gh shim: configured to return permissions.admin=true; gh secret set ok; protection PUT 200; pr create #42; run list 2 contexts → success after 30s simulated

# Run
1. Invoke `autonomous-dev wizard --phase 12` against fixture repo
2. Provide fixture PAT via stdin

# Assertions
- A-1 (verify-line): wizard.log contains exactly one line `{"phase":12,"step":"verify","status":"completed",...}`
- A-2 (token-leak): grep -E "ghp_[A-Za-z0-9]{36}" {stdout,stderr,wizard.log,transcript} returns 0
- A-3 (scaffold-hash): sha256(.github/workflows/autonomous-dev-ci.yml) == sha256(template/autonomous-dev-ci.yml)
- A-4 (secret set): gh shim recorded `gh secret set AUTONOMOUS_DEV_TOKEN`
- A-5 (protection): gh shim recorded PUT branches/main/protection with contexts ["autonomous-dev-ci","autonomous-dev-cd"]
- A-6 (mergeable-state-blocked-while-pending): probe-PR mergeable_state == "blocked" during the poll
- A-7 (cleanup): no probe branch remains on origin or local; PR #42 closed (not merged)
- A-8 (state file): wizard-state.json phases.12.status == "complete"
- A-9 (config keys): config.json contains ci.github_pat_env="GH_TOKEN", ci.workflow_paths=[3 paths], ci.branch_protection_enabled=true, ci.required_status_checks=["autonomous-dev-ci","autonomous-dev-cd"]
- A-10 (suite-level token-leak): regex sweep across all four streams returns 0 (NFR token leak)
```

**`skip-with-consequence.md` outline:**

- Fixture repo: origin = `https://gitlab.com/x/y.git`.
- Run wizard --phase 12.
- Assertions:
  - A-1: stdout contains the verbatim FR-4 consequence text from SPEC-033-2-02.
  - A-2: phases.12.status == "skipped" in wizard-state.json.
  - A-3: no `.github/workflows/*.yml` files written (filesystem assertion).
  - A-4: gh shim recorded zero invocations.

**`error-recovery.md` outline:** two sub-cases.

Sub-case A (token-scope downgrade — TDD-033 §9.4):
- Fixture PAT shim: `permissions.admin=false`.
- Assertions:
  - A-1: wizard exits with diagnostic regex `your token needs .* repo .* workflow .* admin`.
  - A-2: zero `.github/workflows/*.yml` files written.
  - A-3: gh shim recorded ZERO `gh secret set` and ZERO PUT `branches/main/protection` calls.
  - A-4: phases.12.status == "failed".
  - A-5: token-leak sweep returns 0.

Sub-case B (probe-PR run failure):
- Fixture: scopes ok, scaffolds + secret + protection succeed, but `gh run list` returns conclusion=failure for autonomous-dev-ci.
- Assertions:
  - A-1: probe-PR poll exits early on first failure.
  - A-2: cleanup-trap fired (no probe branch remains).
  - A-3: phases.12.status == "failed".
  - A-4: diagnostic enumerates failed context "autonomous-dev-ci".

**`idempotency-resume.md` outline:** three sub-cases.

Sub-case A (workflows already match):
- Fixture: workflow files pre-populated with template-matching hash.
- Assertions: scaffold step skipped (log marker `step":"scaffold-workflows","status":"skipped-idempotent"`); other steps run.

Sub-case B (branch protection already configured):
- Fixture: gh shim returns existing protection with matching contexts.
- Assertions: configure-protection step skipped; probe-PR still runs (verification only).

Sub-case C (mid-probe kill + stale-branch detect):
- Step 1: run wizard --phase 12; SIGTERM during probe-pr-poll. Assert trap fired (branch + PR cleaned).
- Step 2: simulate `kill -9` failure: pre-create branch `autonomous-dev-wizard-probe-1234567890` on origin (fixture) without trap.
- Step 3: re-run wizard --phase 12.
- Assertions:
  - A-1: re-run lists the stale branch and prompts.
  - A-2: on operator-y, stale branch deleted before proceeding.
  - A-3: new probe-PR uses a fresh timestamp branch (regex `autonomous-dev-wizard-probe-\d{10,}` and != stale timestamp).

**`linked-prd-no-duplication.md` outline:**

Front-matter:
```yaml
phase: 12
case_type: linked-prd-no-duplication
expected_outcome: scanner-clean
fixture_inputs:
  rendered_phase_md: plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-12-ci-setup.md
  prd_chain_md: docs/prds/PRD-015-ci-cd-pipeline-and-chain-orchestration.md
assertions:
  - id: SCAN-1
    description: zero ≥40-char verbatim duplications between rendered phase and PRD-015 chain section
    type: scanner-clean
    expected: 0 matches
```

Body invokes the scanner:
```bash
plugins/autonomous-dev-assist/evals/scanners/prd-duplication-scanner.sh \
  --rendered phases/phase-12-ci-setup.md \
  --prd       docs/prds/PRD-015-*.md \
  --section   "chain" \
  --min-len   40 \
  || fail "PRD-015 duplication detected"
```

**Scanner script (`prd-duplication-scanner.sh`):**

```bash
#!/usr/bin/env bash
# usage: prd-duplication-scanner.sh --rendered <md> --prd <md> --section <name> --min-len N
# emits matches to stderr, exit 0 = clean, exit 1 = duplication found
set -euo pipefail
# ... arg parsing ...

# Extract chain section from PRD by markdown header heuristic:
prd_chain="$(awk -v sect="$section" '
  $0 ~ "^## " sect {flag=1; next}
  $0 ~ "^## " && flag {exit}
  flag {print}
' "$prd")"

# Split rendered into sentence fragments
mapfile -t fragments < <(awk 'BEGIN{RS="[.!?]"} {gsub(/\n/," "); gsub(/^[ \t]+|[ \t]+$/, ""); if (length($0) >= MINLEN) print $0}' MINLEN="$min_len" "$rendered")

found=0
for frag in "${fragments[@]}"; do
  if grep -qF -- "$frag" <<< "$prd_chain"; then
    echo "DUPLICATION: $frag" >&2
    found=1
  fi
done
exit "$found"
```

(The shell here is illustrative; the implementer may rewrite in awk/python provided behavior matches FR-11.)

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-2-02: `phases/phase-12-ci-setup.md` is the input to the duplication scanner and is rendered for the other four eval cases.
- SPEC-033-1-03: orchestrator → produces wizard-state.json + wizard.log for assertions.
- TDD-033 §9.1 / §9.4: case rubric and security check definitions.
- PRD-015: source-of-truth for chain content; the duplication scanner reads its chain section.
- gh shim infrastructure (fixtures dir): canned responses for repos, secrets, protection, pr, run.

**Produced:**
- Five eval case files.
- One reusable scanner script (`prd-duplication-scanner.sh`) — also reusable by SPEC-033-4-02 phase-16 cross-link case.

## 6. Acceptance Criteria

### Five files exist + schema conformance (FR-1, FR-2)

```
Given the eval directory plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-12-ci-setup/
When ls is run
Then exactly five .md files are present: happy-path, skip-with-consequence, error-recovery, idempotency-resume, linked-prd-no-duplication

Given any of the five files
When parsed by the eval-case schema validator
Then validation succeeds (front-matter keys per TDD-033 §9.1; assertions list non-empty)
```

### `happy-path.md` assertions (FR-3, FR-4, FR-5)

```
Given the happy-path fixture
When the eval runs
Then wizard.log contains the verify-line for phase 12 completion
And the four-stream token-leak sweep returns 0 matches
And the probe-PR's mergeable_state was "blocked" during the poll
And the probe-PR was closed (not merged) and branch deleted
And state file phases.12.status == "complete"
```

### `skip-with-consequence.md` (FR-6)

```
Given origin = gitlab.com fixture
When the eval runs
Then the verbatim FR-4 consequence text appears in operator-facing output
And phases.12.status == "skipped"
And no .github/workflows files were written
And the gh shim recorded zero invocations
```

### `error-recovery.md` token-scope downgrade (FR-7)

```
Given a PAT with permissions.admin=false on the repo
When the eval runs
Then the wizard aborted with the documented diagnostic
And ZERO workflow files were written
And ZERO gh secret set or protection PUT calls were recorded
And phases.12.status == "failed"
And the token-leak sweep returns 0
```

### `error-recovery.md` probe-PR run failure (FR-8)

```
Given scopes valid, scaffold + secret + protection complete
And the probe-PR's autonomous-dev-ci run returns conclusion=failure
When the eval runs
Then the poll exits early on first failure
And the cleanup-trap fired (no probe branch remains)
And phases.12.status == "failed" with diagnostic naming "autonomous-dev-ci"
```

### `idempotency-resume.md` three sub-cases (FR-9)

```
Given workflows pre-populated matching template hash
Then scaffold-workflows step is skipped (log marker present)

Given branch protection pre-configured with matching contexts
Then configure-protection step is skipped

Given a stale autonomous-dev-wizard-probe-* branch on origin
When phase 12 re-enters
Then the wizard offers cleanup before proceeding
And on Y the stale branch is deleted
And the new probe-PR uses a fresh, distinct timestamp branch
```

### `linked-prd-no-duplication.md` scanner-clean (FR-10, FR-11)

```
Given phases/phase-12-ci-setup.md and PRD-015's chain section
When prd-duplication-scanner.sh runs with --min-len 40
Then exit code is 0
And stderr emits zero "DUPLICATION:" lines

Given a synthetic test fixture where phase-12 contains a copy-paste sentence ≥40 chars from PRD-015
When the scanner runs
Then exit code is 1
And stderr lists the offending sentence
```

### Suite pass + auto-fail (FR-13, NFR Suite pass + auto-fail)

```
Given the five-case suite is run
When scoring is computed
Then per-case pass rate is ≥ 90%
And on any duplication detection (linked-prd-no-duplication failure), the entire suite is marked failed
```

### Structured log assertions (FR-14)

```
Given any of the five eval cases run
When wizard.log is inspected
Then for each major step (intro, verify-scopes, scaffold-workflows, configure-protection, probe-pr-create, cleanup-probe)
There is at least one line matching `{"phase":12,"step":"<step>","status":"<state>","duration_ms":<int>}`
```

## 7. Test Requirements

**bats — `tests/setup-wizard/phase-12-evals.bats`:**

| Test ID | Scenario                                  | Assert                                              |
|---------|-------------------------------------------|-----------------------------------------------------|
| P12E-101 | Five files present                        | ls returns exactly the five names                   |
| P12E-102 | Schema validates                          | each file passes the eval-case schema validator     |
| P12E-201 | Happy-path runs end-to-end                | all 10 assertions in happy-path.md pass             |
| P12E-301 | Skip-with-consequence                     | consequence text + zero side effects                |
| P12E-401 | Error-recovery: token-scope downgrade     | zero partial state                                  |
| P12E-402 | Error-recovery: probe-PR run failure      | cleanup runs; status=failed                         |
| P12E-501 | Idempotency: 3 sub-cases pass             | each sub-case's assertions pass                     |
| P12E-601 | Duplication-scanner clean (real)          | exit 0 against the real PRD-015 + phase-12 files    |
| P12E-602 | Duplication-scanner positive (synthetic)  | exit 1 with a known-injected duplication            |
| P12E-701 | Suite-level auto-fail                     | injecting a duplication marks the suite failed      |
| P12E-801 | Token-leak sweep                          | regex sweep across all 4 streams returns 0 in happy |
| P12E-901 | Determinism (10 runs)                     | 10 consecutive runs all pass                         |

**Fixtures created (under `tests/fixtures/setup-wizard/`):**
- `repos/github-happy/` — bare git repo with github.com origin.
- `repos/gitlab-skip/` — bare git repo with gitlab.com origin.
- `repos/github-stale-probe/` — github origin with a pre-existing `autonomous-dev-wizard-probe-1234567890` branch.
- `tokens/happy.env`, `tokens/no-admin.env` — fixture PAT values (clearly-fake).
- `gh-shims/*.json` — canned response sets per case.
- `synthetic/duplicated-phase-12.md` — synthetic phase-12 with a known PRD-015 sentence injected (positive scanner test).

## 8. Implementation Notes

- The duplication scanner's sentence splitter uses simple `[.!?]\s+` boundaries; markdown code blocks are excluded by stripping fenced regions before splitting (otherwise YAML examples produce false positives). Implementation note: pre-process via `awk '/^```/{f=!f;next}!f' rendered.md`.
- The scanner's `--section "chain"` arg matches the PRD's chain section by markdown H2 heading prefix; if PRD-015 evolves to a different heading naming scheme, this case must update accordingly. Document the section-name contract in `_phase-contract.md`.
- Probe-PR poll fixture uses a "simulated time" gh shim that returns `pending` for the first N gh-run-list calls then `success`. The eval framework injects a clock-fast-forward to keep total runtime under 30 s wall clock.
- The `mergeable_state == "blocked"` assertion (FR-5) requires the gh shim to return the `mergeable_state` field on `gh pr view` calls during the probe-pr-verify-protection step.
- Token-leak sweep regex: `ghp_[A-Za-z0-9]{36}` is the GitHub classic PAT pattern. Newer fine-grained PATs use `github_pat_` prefix; the sweep should include both: `(ghp_[A-Za-z0-9]{36})|(github_pat_[A-Za-z0-9_]{82})`.
- The duplication scanner is an O(N×M) string match (N rendered fragments × M chars in PRD chain). For typical document sizes (< 10 KB each) this is < 10 ms; no optimization needed.

## 9. Rollout Considerations

- The duplication-scanner case is a CI gate (FR-12). It runs:
  - On every PR touching `phases/phase-12-ci-setup.md` (changes to phase content may introduce duplication).
  - On every PR touching `docs/prds/PRD-015-*.md` (changes to PRD chain may introduce duplication via phase content drifting into PRD scope).
- The scanner is shipped as a reusable artifact; SPEC-033-4-02 reuses it for phase 16's PRD-015 cross-link case.
- A bypass exists: `git commit --no-verify` does NOT bypass this; the scanner runs as a CI eval, not a pre-commit hook. CI failure is the only enforcement.

## 10. Effort Estimate

| Activity                                      | Estimate |
|-----------------------------------------------|----------|
| Five eval case files                          | 0.75 day |
| Duplication scanner script                    | 0.25 day |
| Fixture infrastructure                        | 0.25 day |
| bats validation tests                         | 0.25 day |
| **Total**                                     | **1.5 day** |
