# SPEC-027-2-04: Onboarding Eval Suite Activation + 4 Cases (`onboarding-questions.yaml`)

## Metadata
- **Parent Plan**: PLAN-027-2
- **Parent TDD**: TDD-027 §7.2 (case table), §13 (test strategy), §8.4 (regression policy), FR-1536 (shared schema), FR-1538 (regression baseline)
- **Tasks Covered**: PLAN-027-2 Task 7 (activate suite + author 4 cases), Task 8 (smoke run of the 4 new cases)
- **Estimated effort**: 3.0 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-027-2-04-onboarding-eval-suite-activation-and-cases.md`
- **Depends on**: SPEC-027-2-01 (the modified onboarding agent must contain the pause-states subsection and first-cloud-deploy appendix that these eval cases assert against). The smoke run (Task 8) targets the post-SPEC-027-2-01 agent.

## Summary
Activate the `onboarding` eval suite in `plugins/autonomous-dev-assist/evals/eval-config.yaml` (today `enabled: false`) and create `plugins/autonomous-dev-assist/evals/test-cases/onboarding-questions.yaml` (today does not exist) with exactly 4 cases matching TDD-027 §7.2 verbatim: `onboard-cloud-001`, `onboard-pause-001`, `onboard-pause-002`, `onboard-pause-003`. Each case follows the `id` / `difficulty` / `question` / `must_mention[]` / `must_not_mention[]` shared schema mandated by FR-1536 and consumed by the eval scoring logic in `eval-config.yaml` (`scoring.accuracy.method: topic_and_mention_match`). Per PLAN-027-2 Task 8, smoke-run the 4 cases against the SPEC-027-2-01-modified onboarding agent and record per-case pass/fail in the PR body.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/evals/test-cases/onboarding-questions.yaml` | Create | New file. 4 cases. Header (suite/skill/description) + `cases:` list. |
| `plugins/autonomous-dev-assist/evals/eval-config.yaml` | Modify | Flip the `onboarding.enabled` field from `false` to `true` (line 34 on `main`). Remove the trailing `# placeholder -- no test cases yet` comment OR replace it with `# 4 cases per TDD-027 §7.2`. No other edits. |

## Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Create `plugins/autonomous-dev-assist/evals/test-cases/onboarding-questions.yaml` containing exactly 4 cases, in this order: `onboard-cloud-001`, `onboard-pause-001`, `onboard-pause-002`, `onboard-pause-003`. | TDD-027 §7.2, PLAN-027-2 Task 7 |
| FR-2 | Each new case MUST have these top-level keys (matching FR-1536 shared schema): `id` (string), `difficulty` (enum: `easy`, `medium`, `hard`), `question` (string), `must_mention` (list of strings), `must_not_mention` (list of strings). For backward compatibility with the existing legacy reader pattern observed in `troubleshoot-scenarios.yaml`, the file MAY include optional bridge keys (`category`, `severity`, `scenario`); the implementer SHOULD include them mirroring the convention used by SPEC-027-1-04. | TDD-027 §7.2, FR-1536 |
| FR-3 | `onboard-cloud-001`: difficulty `easy`, question `how do I onboard a new cloud backend?`, must_mention contains `setup-wizard --with-cloud` and `phase 16`, must_not_mention contains `pip install autonomous-dev-deploy`. | TDD-027 §7.2 |
| FR-4 | `onboard-pause-001`: difficulty `medium`, question `what does cost-cap-tripped mean during onboarding?`, must_mention contains `ledger.json`, `raise cap`, `do NOT hand-edit`, must_not_mention contains `set --cost-cap 0`. | TDD-027 §7.2 |
| FR-5 | `onboard-pause-002`: difficulty `medium`, question `pipeline paused on awaiting-approval — is something broken?`, must_mention contains `deploy approve` and `expected for prod`, must_not_mention contains `force-approve`. | TDD-027 §7.2 |
| FR-6 | `onboard-pause-003`: difficulty `medium`, question `what is firewall-denied? did I install something wrong?`, must_mention contains `denied.log`, `allowlist`, `expected for new plugins`, must_not_mention contains `disable firewall`. | TDD-027 §7.2 |
| FR-7 | The file MUST start with a YAML header block defining the suite metadata: `suite: onboarding`, `skill: onboarding`, and a one-line `description:` matching the `eval-config.yaml` description ("Validates the onboarding skill walks new users through setup correctly."). The body of the file is a top-level `cases:` list containing the 4 cases. | Convention: existing `troubleshoot-scenarios.yaml` and `help-questions.yaml` start with `suite:` / `skill:` / `description:` |
| FR-8 | The YAML MUST validate as a single document (`yaml.safe_load` succeeds). Required keys per case (`id`, `question`, `must_mention`, `must_not_mention`) MUST be present on every case. | PLAN-027-2 Task 7 acceptance |
| FR-9 | `eval-config.yaml` MUST be modified to flip the `suites.onboarding.enabled` field from `false` to `true` (currently line 34). The comment "# placeholder -- no test cases yet" MUST be removed or replaced (e.g., `# 4 cases per TDD-027 §7.2`). No other lines in `eval-config.yaml` may be modified. | PLAN-027-2 Task 7 |
| FR-10 | Smoke run (PLAN-027-2 Task 8): run the 4 new cases via the PLAN-017-3 eval runner against the SPEC-027-2-01-modified `agents/onboarding.md`. Record per-case pass/fail in the PR description. The acceptance bar is ≥ 3 of 4 passing on first run; failures are triaged with prompt-tuning notes for follow-up but do not block this spec's merge. | PLAN-027-2 Task 8, TDD-027 §13.2 |
| FR-11 | The activation MUST NOT regress any existing eval suite. Per FR-1538 / TDD-027 §8.4, the existing `help-questions`, `troubleshoot-scenarios`, `config-questions`, and the four reviewer-eval suites MUST continue to pass at their existing thresholds (≥80% per-suite per `eval-config.yaml`). | TDD-027 §8.4, FR-1538 |
| FR-12 | The `must_mention` and `must_not_mention` strings MUST match the TDD-027 §7.2 table verbatim (substring matching at evaluation time; the strings stored here are the patterns to search for). | TDD-027 §7.2 (verbatim quote requirement) |

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|------------|--------|--------------------|
| YAML parse time | < 100 ms for the file | `python -c "import yaml; yaml.safe_load(open('onboarding-questions.yaml'))"` exit 0 in < 100 ms |
| Per-case smoke-pass rate (PLAN-027-2 Task 8) | ≥ 3 of 4 cases pass first run | Run the 4 new cases via the PLAN-017-3 eval runner against the SPEC-027-2-01-modified onboarding agent; record per-case pass/fail in PR body |
| Existing eval suite regression | 0 cases regress across help / troubleshoot / config / reviewer suites | Run full `eval all` via PLAN-017-3 runner; compare pass-list to `main` baseline |
| Eval runtime impact (per `eval all` invocation) | < 30 s additional wall-clock | Per TDD-027 §8.3 budget (proportional growth: +4 cases ≈ +6 s at ~1.5 s per case) |
| Per-`eval all` API cost increase | < $0.30 total | Per TDD-027 §8.6 (4 cases at ~$0.05 each) |
| `eval-config.yaml` schema validation | Continues to validate after the `enabled: true` flip | YAML safe-load + visual review of the `suites.onboarding` block |

## Technical Approach

### Schema-shape decision
Same reconciliation logic as SPEC-027-1-04: TDD-027's case table uses the lightweight `must_mention` / `must_not_mention` schema (FR-1536). The existing `troubleshoot-scenarios.yaml` adds legacy bridge keys (`category`, `severity`, `scenario`). For the new `onboarding-questions.yaml`, the implementer should:

- **Authoritative keys** (per FR-1536, normative): `id`, `difficulty`, `question`, `must_mention`, `must_not_mention`.
- **Bridge keys** (recommended for legacy-reader compatibility): `category` (e.g., `cloud-onboarding`, `pause-state`), `severity` (mirror `difficulty`), `scenario` (mirror `question` so a legacy field-name reader still has a textual title).
- The `eval-config.yaml`'s `scoring.accuracy.method: topic_and_mention_match` reads `must_mention`; bridge keys are inert at scoring time.

### File-creation strategy
1. Create `plugins/autonomous-dev-assist/evals/test-cases/onboarding-questions.yaml`.
2. Author the 7-line YAML header (suite / skill / description / blank) modeled on `troubleshoot-scenarios.yaml` lines 1-11.
3. Author the 4 cases under a top-level `cases:` list using 2-space indentation and the `- id: …` block style.
4. Save and run `python -c "import yaml; yaml.safe_load(open(p))"` to validate.

### `eval-config.yaml` modification (single-line flip + comment)
1. Read `plugins/autonomous-dev-assist/evals/eval-config.yaml`.
2. Locate line 34: `    enabled: false  # placeholder -- no test cases yet`.
3. Replace with: `    enabled: true  # 4 cases per TDD-027 §7.2`.
4. Confirm no other lines are modified.

### Header (verbatim authoring guidance)

```yaml
# onboarding-questions.yaml -- Test cases for the onboarding skill
# 4 cases covering cloud onboarding and pipeline pause states (TDD-027 §7.2)

suite: onboarding
skill: onboarding
description: >
  Validates that the onboarding skill correctly answers questions about
  cloud onboarding (setup-wizard --with-cloud) and pipeline pause states
  (cost-cap-tripped, awaiting-approval, firewall-denied) per TDD-027 §7.2.

cases:
```

### Case bodies (verbatim from TDD-027 §7.2)

```yaml
  - id: onboard-cloud-001
    difficulty: easy
    category: cloud-onboarding         # bridge
    severity: easy                      # bridge
    scenario: "how do I onboard a new cloud backend?"  # bridge
    question: "how do I onboard a new cloud backend?"
    must_mention:
      - "setup-wizard --with-cloud"
      - "phase 16"
    must_not_mention:
      - "pip install autonomous-dev-deploy"

  - id: onboard-pause-001
    difficulty: medium
    category: pause-state
    severity: medium
    scenario: "what does cost-cap-tripped mean during onboarding?"
    question: "what does cost-cap-tripped mean during onboarding?"
    must_mention:
      - "ledger.json"
      - "raise cap"
      - "do NOT hand-edit"
    must_not_mention:
      - "set --cost-cap 0"

  - id: onboard-pause-002
    difficulty: medium
    category: pause-state
    severity: medium
    scenario: "pipeline paused on awaiting-approval — is something broken?"
    question: "pipeline paused on awaiting-approval — is something broken?"
    must_mention:
      - "deploy approve"
      - "expected for prod"
    must_not_mention:
      - "force-approve"

  - id: onboard-pause-003
    difficulty: medium
    category: pause-state
    severity: medium
    scenario: "what is firewall-denied? did I install something wrong?"
    question: "what is firewall-denied? did I install something wrong?"
    must_mention:
      - "denied.log"
      - "allowlist"
      - "expected for new plugins"
    must_not_mention:
      - "disable firewall"
```

### Smoke-run procedure (Task 8)
1. Confirm `agents/onboarding.md` already contains the SPEC-027-2-01 edits (pause-states subsection + first-cloud-deploy appendix).
2. Invoke the PLAN-017-3 eval runner targeting the `onboarding` suite:
   ```
   bash plugins/autonomous-dev-assist/evals/runner.sh --suite onboarding
   ```
3. Capture per-case results into the PR body in this format:
   ```
   onboard-cloud-001: PASS|FAIL (notes)
   onboard-pause-001: PASS|FAIL (notes)
   onboard-pause-002: PASS|FAIL (notes)
   onboard-pause-003: PASS|FAIL (notes)
   ```
4. If ≥ 3 of 4 pass, FR-10 is satisfied. If < 3 pass, document the failures with prompt-tuning notes and link a follow-up item against PLAN-017-3 / TDD-028.

### Error handling at edit time
- If `onboarding-questions.yaml` already exists on disk, abort with a conflict (this spec creates the file fresh).
- If `eval-config.yaml`'s line 34 has drifted (the `enabled: false` field is missing or moved), locate by key path `suites.onboarding.enabled` rather than by line number; abort if the key is missing.
- If `agents/onboarding.md` does NOT contain the SPEC-027-2-01 edits at smoke-run time, skip Task 8 and document the dependency in the PR body.

## Acceptance Criteria

```
Given the autonomous-dev-assist plugin tree on main
When this spec's edits are applied
Then plugins/autonomous-dev-assist/evals/test-cases/onboarding-questions.yaml exists
And the file's top-level keys include suite, skill, description, cases
And the cases list contains exactly 4 entries
```

```
Given the new onboarding-questions.yaml
When the case ids are extracted in document order
Then they are exactly:
  - "onboard-cloud-001"
  - "onboard-pause-001"
  - "onboard-pause-002"
  - "onboard-pause-003"
And each case has non-empty `must_mention` and `must_not_mention` lists
```

```
Given onboard-cloud-001
When its keys are read
Then difficulty == "easy"
And question == "how do I onboard a new cloud backend?"
And must_mention contains the substrings "setup-wizard --with-cloud" and "phase 16"
And must_not_mention contains "pip install autonomous-dev-deploy"
```

```
Given onboard-pause-001
When its keys are read
Then difficulty == "medium"
And question == "what does cost-cap-tripped mean during onboarding?"
And must_mention contains "ledger.json", "raise cap", and "do NOT hand-edit"
And must_not_mention contains "set --cost-cap 0"
```

```
Given onboard-pause-002
When its keys are read
Then difficulty == "medium"
And question == "pipeline paused on awaiting-approval — is something broken?"
And must_mention contains "deploy approve" and "expected for prod"
And must_not_mention contains "force-approve"
```

```
Given onboard-pause-003
When its keys are read
Then difficulty == "medium"
And question == "what is firewall-denied? did I install something wrong?"
And must_mention contains "denied.log", "allowlist", and "expected for new plugins"
And must_not_mention contains "disable firewall"
```

```
Given the modified eval-config.yaml
When the suites.onboarding block is read
Then enabled is true
And the file parses as valid YAML
And no other lines outside the suites.onboarding block are modified
```

```
Given the new onboarding-questions.yaml
When `python -c "import yaml; yaml.safe_load(open(p))"` is run
Then it exits 0
And the loaded object is a single dict with a "cases" key whose value is a list of 4 dicts
```

```
Given the SPEC-027-2-01-modified agents/onboarding.md
When the PLAN-017-3 eval runner is invoked targeting the onboarding suite
Then it executes the 4 new cases without YAML or schema errors
And the per-case pass/fail summary is recorded in the PR description
And ≥ 3 of 4 cases pass on first run, OR failing cases are triaged with prompt-tuning notes
```

```
Given the existing eval suites (help / troubleshoot / config / reviewer suites)
When the full `eval all` invocation is run after this spec's merge
Then no existing case regresses
And the global per-suite threshold (≥80% per `eval-config.yaml`) holds for every suite
```

### Edge cases / sad paths

```
Given onboard-pause-001's must_not_mention forbids "set --cost-cap 0"
When the agent's response includes any of: "set the cost cap to zero", "--cost-cap 0", "set --cost-cap 0"
Then the eval MUST fail
And the implementer MUST audit the agent's response in the Task 8 smoke run
And SPEC-027-2-01 FR-3 wording (the "do NOT hand-edit" guard) MUST be cross-checked
```

```
Given onboard-pause-002's must_mention requires "expected for prod"
When SPEC-027-2-01's pause-states table cell uses the wording "for prod environments this is mandatory"
Then the eval may FAIL because "expected for prod" is not a verbatim substring of the cell
And the implementer MUST either (a) extend the cell wording in SPEC-027-2-01 to include "expected for prod", or (b) tune the must_mention pattern to match an actual phrase in the agent prompt
And the resolution is recorded in the Task 8 smoke-run notes
```

```
Given the YAML file is created with tab indentation by mistake
When `yaml.safe_load` is invoked
Then it raises a YAMLError
And the implementer MUST re-author with 2-space indentation matching `troubleshoot-scenarios.yaml`
```

```
Given a future plan adds a 5th onboarding case
When that future plan amends `onboarding-questions.yaml`
Then the amendment is an append to the `cases:` list
And no edit to existing cases is permitted (per TDD-027 §4.2 / G-08)
```

## Test Requirements

### Static
- `test -f plugins/autonomous-dev-assist/evals/test-cases/onboarding-questions.yaml` exits 0.
- `python -c "import yaml; d=yaml.safe_load(open(p)); assert len(d['cases'])==4"` exits 0.
- `grep -c "^  - id: onboard-" onboarding-questions.yaml` returns 4.
- `grep -c "must_mention:" onboarding-questions.yaml` returns 4.
- `grep -c "must_not_mention:" onboarding-questions.yaml` returns 4.
- `grep -c '"setup-wizard --with-cloud"' onboarding-questions.yaml` returns ≥ 1.
- `grep -c '"do NOT hand-edit"' onboarding-questions.yaml` returns ≥ 1.
- `grep -A1 "onboarding:" eval-config.yaml | grep "enabled: true"` returns ≥ 1.
- `git diff main -- eval-config.yaml | grep "^[-+]" | grep -v "^---\|^+++" | wc -l` is ≤ 4 (the single-line flip plus optional comment change).

### Integration / regression
- Run `bash plugins/autonomous-dev-assist/evals/runner.sh --suite onboarding` and capture per-case pass/fail in PR body.
- Run `bash plugins/autonomous-dev-assist/evals/runner.sh` (full `eval all`); confirm no regression in help / troubleshoot / config / reviewer suites.
- The standards-meta-reviewer (PLAN-021-3) is run against the diff and confirms the suite activation does not perturb existing case ordering or content elsewhere.

### Manual review
- Reviewer reads each of the 4 case bodies aloud and confirms `must_mention` / `must_not_mention` lists match TDD-027 §7.2 verbatim.
- Reviewer cross-checks each `must_mention` substring against the SPEC-027-2-01-modified `agents/onboarding.md` to flag any phrase that the agent prompt does not actually emit (high-risk: see edge case onboard-pause-002 above).

## Implementation Notes

- **Why activate the suite as part of this spec rather than a follow-up?** The activation is one line; gating it behind the case authoring keeps the diff atomic and avoids a "suite enabled, file missing" intermediate state that would hard-fail the eval runner.
- **The `expected for prod` substring (onboard-pause-002).** TDD-027 §7.2 mandates this exact `must_mention` string. SPEC-027-2-01's pause-states table for the `awaiting-approval` row says "for prod environments this is mandatory" — which does NOT contain the literal substring "expected for prod". The implementer has two paths: (1) add a clarifying sentence to the SPEC-027-2-01 row that contains "expected for prod" (preferred — cross-spec coordination), or (2) widen the eval `must_mention` to a regex/keyword that matches the existing wording. Path (1) is recommended; path (2) requires a TDD revision per FR-1536. Document the chosen path in PR body.
- **Bridge keys are recommended, not required.** The existing eval runner (`evals/runner.sh`) is treated as an opaque consumer; if it iterates dict keys without strict-shape enforcement, omitting bridge keys is fine. To minimize risk, include them.
- **Why a `description:` field at the top of the YAML file?** It mirrors the convention used by `troubleshoot-scenarios.yaml`, `help-questions.yaml`, and `config-questions.yaml`. The eval runner does not strictly require it, but the convention makes the file self-documenting.
- **Smoke-run dependency on SPEC-027-2-01.** If SPEC-027-2-01 has not yet landed when this spec is implemented, Task 8 cannot be executed meaningfully. Sequence the implementation so SPEC-027-2-01 lands first, OR run Task 8 against a feature branch that includes both spec implementations.
- **No `expected_diagnosis` / `expected_commands` / `expected_fix` legacy keys are required** — the `troubleshoot-scenarios.yaml` legacy schema is older than FR-1536; this new file follows FR-1536's lean shape.

## Rollout Considerations

- **Rollout**: YAML-only PR (one new file, one one-line config flip). The eval runner picks up the activation on its next invocation (PLAN-017-3 PR-trigger or nightly cron).
- **Feature flag**: The `enabled: true` flip in `eval-config.yaml` IS the feature flag. To roll back, flip it back to `enabled: false`.
- **Rollback**: Revert the commit. The suite returns to disabled state; the YAML file may remain on disk (harmless) or be removed.
- **Coordination**: This spec is the **eval-side artifact** of PLAN-027-2. It depends on SPEC-027-2-01's agent-prompt edits to land first for the smoke run to be meaningful. SPEC-027-2-02 and SPEC-027-2-03 are parallel and do not affect this spec's test outcomes.

## Effort Estimate

| Activity | Hours |
|----------|-------|
| Author `onboarding-questions.yaml` (header + 4 cases, ~80 lines) | 1.0 |
| Flip `eval-config.yaml` line 34 from `enabled: false` to `enabled: true` | 0.25 |
| YAML safe-load validation + per-case key verification | 0.25 |
| Smoke run of 4 new cases (Task 8) + record results in PR body | 1.0 |
| Cross-check `must_mention` substrings against SPEC-027-2-01 agent prompt; document `expected for prod` resolution path | 0.25 |
| Regression run of full `eval all` and PR-body capture | 0.25 |
| **Total** | **3.0** |
