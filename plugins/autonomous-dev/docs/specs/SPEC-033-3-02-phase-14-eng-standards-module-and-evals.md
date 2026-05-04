# SPEC-033-3-02: Phase 14 Module — Engineering Standards Bootstrap + Eval Set

## Metadata
- **Parent Plan**: PLAN-033-3
- **Parent TDD**: TDD-033 §6.5
- **Parent PRD**: AMENDMENT-002 §4.5, AC-03
- **Tasks Covered**: PLAN-033-3 Tasks 2 (module), 3 (eval set)
- **Estimated effort**: 1.75 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Author the phase 14 module that bootstraps engineering standards in
the operator's repo. The phase auto-detects primary language, offers
a matching bundled standards pack (or "author your own"), writes
`<repo>/.autonomous-dev/standards.yaml`, validates via TDD-021's
schema validator, exercises the **prompt renderer**
(SPEC-021-3-01) at least once, runs the
**standards-meta-reviewer** (SPEC-021-3-02) in dry-run mode against
recent commits, and optionally enables **two-person-approval** for
fix-recipe applications. Phase 14 is dry-run-only on the operator's
repo (no PR, no CI invocation).

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                            | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | A markdown file at `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-14-eng-standards.md` MUST exist with valid front-matter per `_phase-contract.md`. | T2   |
| FR-2  | Front-matter MUST set `phase: 14`, `title: "Engineering standards bootstrap"`, `amendment_001_phase: 14`, `tdd_anchors: [TDD-021]`, `required_inputs.phases_complete: [1,2,3,4,5,6,7]`. | T2   |
| FR-3  | Front-matter MUST set `skip_predicate: "skip-predicates.sh phase_14_skip_predicate"` where the wrapper exits 0 only when `wizard.skip_phase_14=true` (default false). | T2   |
| FR-4  | `skip_consequence` MUST contain the verbatim text "Author agents will not be standards-aware; code may violate team conventions silently." | T2   |
| FR-5  | Front-matter MUST set `idempotency_probe: "idempotency-checks.sh phase-14-probe"` (wrapper documented in §4). | T2   |
| FR-6  | Front-matter MUST set `output_state.config_keys_written: ["standards.pack_id", "standards.path", "standards.two_person_approval_enabled", "standards.last_dry_run_at"]` and `output_state.files_created: ["<repo>/.autonomous-dev/standards.yaml", "<repo>/.autonomous-dev/standards-dry-run-<YYYY-MM-DD>.json"]`. | T2   |
| FR-7  | The module MUST auto-detect the operator's primary language by invoking `autonomous-dev detect-language --repo <path>`. The detected language is **surfaced for confirmation/override** (NOT auto-accepted) per TDD-033 §6.5. | T2   |
| FR-8  | The module MUST offer a bundled standards pack matching the confirmed language: `typescript-strict`, `python-pep8`, `go-default`, `javascript-airbnb`, etc. The pack list is data-driven from `plugins/autonomous-dev/config/standards-packs.json`. The operator may also choose "author your own" (writes a stub `standards.yaml` with comments and exits the offer-pack step). | T2   |
| FR-9  | When a pack is chosen, the module MUST copy the pack template from `plugins/autonomous-dev/templates/standards-packs/<pack-id>.yaml` to `<repo>/.autonomous-dev/standards.yaml`. | T2   |
| FR-10 | The module MUST validate the resulting file via `autonomous-dev standards validate --repo <repo>`. On non-zero exit, the module emits the validator's stderr to operator and offers re-pick (up to 3 attempts) before exiting with status="failed". | T2   |
| FR-11 | The module MUST exercise the prompt renderer at least once: invoke `autonomous-dev standards render-prompt --rule-id <pack>:<sample-rule>` and assert non-empty `STANDARDS_SECTION` in stdout. The sample rule ID is taken from the pack's first listed rule. | T2   |
| FR-12 | The module MUST run `autonomous-dev standards-meta-reviewer --dry-run --against HEAD~5..HEAD` and capture the JSON findings to `<repo>/.autonomous-dev/standards-dry-run-$(date +%Y-%m-%d).json`. The dry-run MUST NOT write to any other location, MUST NOT post comments, MUST NOT mutate the repo. | T2   |
| FR-13 | If `<repo>` has fewer than 5 commits in the current branch's history, the module MUST adapt the range to `HEAD~$(git rev-list --count HEAD)..HEAD` (or whatever range covers all available commits) and document the truncation in the dry-run JSON's metadata field. | T2   |
| FR-14 | The module MUST offer a two-person-approval flag prompt: "Enable two-person-approval for fix-recipe applications? [y/N]". On y → write `standards.two_person_approval_enabled=true`; on N → write false. The flag wires to SPEC-021-3-02's contract; phase 14 does NOT need to verify the contract works at runtime here (eval covers that). | T2   |
| FR-15 | If `<repo>/.autonomous-dev/standards.yaml` already exists, the module MUST offer a 3-way diff prompt: `keep` (skip rewrite), `merge` (operator-driven 3-way merge with the new pack), or `replace` (overwrite). The choice MUST be recorded in `wizard-checkpoint.json`. | T2   |
| FR-16 | The module MUST issue exactly one SIGHUP to the daemon at phase end so it picks up new standards (skipped in headless eval via fixture flag). | T2   |
| FR-17 | The module MUST NOT write any file except: `<repo>/.autonomous-dev/standards.yaml`, the dated `standards-dry-run-*.json`, and `~/.autonomous-dev/wizard-checkpoint.json` / `wizard-state.json` / `wizard.log` (orchestrator infrastructure). A bats fs-snapshot diff MUST verify this. | T2   |
| FR-18 | An eval directory at `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-14-eng-standards/` MUST contain four cases: `happy-path.md`, `skip-with-consequence.md`, `error-recovery.md`, `idempotency-resume.md`. | T3   |
| FR-19 | `happy-path.md` MUST: confirm TS detection, pick `typescript-strict`, validate exit 0, assert prompt renderer returned non-empty STANDARDS_SECTION matching the SPEC-021-3-01 schema, assert meta-reviewer dry-run produced JSON without crash, set two-person-approval=true, assert state file written. | T3   |
| FR-20 | `skip-with-consequence.md` MUST: set `wizard.skip_phase_14=true`, assert verbatim consequence text emitted, assert no `standards.yaml` written, assert phases.14.status="skipped". | T3   |
| FR-21 | `error-recovery.md` MUST cover three sub-cases: (a) detection returns "unknown" → operator manually picks; (b) operator picks `python-pep8` against a TS repo and `standards validate` fails → diagnostic + offer re-pick; (c) pack template file missing → phase exits with pointer to `/autonomous-dev-assist:troubleshoot`. | T3   |
| FR-22 | `idempotency-resume.md` MUST cover four sub-cases: (a) existing `standards.yaml` → operator picks `keep` → validate runs but no rewrite → phase complete; (b) existing → operator picks `merge` → merged file validates → phase complete; (c) existing → operator picks `replace` → overwrite + validate → phase complete; (d) third re-run with no changes → `phase-14-probe` emits `already-complete` → no body execution. | T3   |
| FR-23 | The four-case suite MUST achieve ≥ 90% pass rate per TDD-033 §9.3. | T3   |
| FR-24 | `happy-path.md` MUST also assert the **prompt-renderer regression gate** (per PLAN-033-3 risk row "TDD-021 prompt renderer regression"): the renderer's `STANDARDS_SECTION` output MUST match the SPEC-021-3-01 schema (specific fields per that spec). If the renderer is broken, the eval fails (not silently passes). | T3   |

## 3. Non-Functional Requirements

| Requirement                       | Target                                                                  | Measurement Method                                                |
|-----------------------------------|-------------------------------------------------------------------------|-------------------------------------------------------------------|
| Eval pass rate                    | ≥ 90% per TDD-033 §9.3 / AMENDMENT-002 AC-03                             | eval framework score                                              |
| Dry-run isolation                 | 0 fs writes outside the documented allow-list                            | fs-snapshot diff per case                                         |
| Dry-run JSON dating               | Exactly one file per UTC date; re-run same day overwrites the day's file| filename pattern + bats test                                       |
| Prompt renderer non-empty         | STANDARDS_SECTION length > 0 for the sample rule                         | eval assertion                                                     |
| Meta-reviewer dry-run no-crash    | Exit 0 from `standards-meta-reviewer --dry-run`                          | eval assertion                                                     |
| Auto-detect surfaced not auto-accepted | Confirmation prompt always shown; eval test for "wrong detection" path | eval sub-case                                              |
| Phase total runtime (happy)       | < 90 s wall clock                                                        | eval framework duration                                            |

## 4. Technical Approach

**File: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-14-eng-standards.md`**

```yaml
---
phase: 14
title: "Engineering standards bootstrap"
amendment_001_phase: 14
tdd_anchors: [TDD-021]
prd_links: []
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys: []
optional_inputs:
  existing_standards_yaml: true
skip_predicate: "skip-predicates.sh phase_14_skip_predicate"
skip_consequence: |
  Author agents will not be standards-aware; code may violate team conventions silently.
idempotency_probe: "idempotency-checks.sh phase-14-probe"
output_state:
  config_keys_written:
    - standards.pack_id
    - standards.path
    - standards.two_person_approval_enabled
    - standards.last_dry_run_at
  files_created:
    - "<repo>/.autonomous-dev/standards.yaml"
    - "<repo>/.autonomous-dev/standards-dry-run-<YYYY-MM-DD>.json"
  external_resources_created: []
verification:
  - "standards.yaml validates via autonomous-dev standards validate"
  - "Prompt renderer returns non-empty STANDARDS_SECTION"
  - "Meta-reviewer --dry-run produces JSON without crash"
  - "two_person_approval_enabled flag persisted"
  - "Daemon SIGHUP issued"
eval_set: "evals/test-cases/setup-wizard/phase-14-eng-standards/"
---
```

**Idempotency probe wrapper** (`idempotency-checks.sh phase-14-probe`):
```
1. result=$(standards_yaml_exists_at <repo>/.autonomous-dev/standards.yaml)
2. If result == start-fresh → emit start-fresh
3. If result == resume-with-diff → emit resume-from:offer-pack (operator chooses keep/merge/replace)
4. If result == already-complete:
   a. Check today's dry-run file exists; if missing → emit resume-from:meta-reviewer-dry-run
   b. Else emit already-complete
```

**Module body steps:**

| Step name                  | Behavior                                                                                                                                |
|----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `intro`                    | Banner; phase configures engineering standards on the operator's repo.                                                                  |
| `detect-language`          | `autonomous-dev detect-language --repo <repo>`. Stdout = single language id or "unknown".                                               |
| `confirm-language`         | Surface detection; "Detected: typescript. Confirm or override (ts/py/go/js/...)?".                                                      |
| `offer-pack`               | Read `standards-packs.json`; offer entries matching language + "author your own".                                                       |
| `existing-yaml-decision`   | If standards.yaml exists → keep/merge/replace prompt (FR-15); record in checkpoint.                                                     |
| `write-yaml`               | Skipped on `keep`. Copy pack template (or 3-way merge for `merge`). Write to `<repo>/.autonomous-dev/standards.yaml`.                   |
| `validate-yaml`            | `autonomous-dev standards validate --repo <repo>`; on non-zero → diagnostic + re-pick loop (≤3).                                        |
| `exercise-prompt-renderer` | Pick first rule from chosen pack; `autonomous-dev standards render-prompt --rule-id <pack>:<rule>`; assert non-empty STANDARDS_SECTION; capture for eval evidence. |
| `meta-reviewer-dry-run`    | Determine commit range (FR-13). `autonomous-dev standards-meta-reviewer --dry-run --against <range>`. Pipe JSON to dated file.          |
| `two-person-approval`      | y/N prompt; record flag.                                                                                                                 |
| `write-config`             | Write the four config keys.                                                                                                              |
| `sighup`                   | SIGHUP daemon (skipped in headless eval).                                                                                                |
| `summary`                  | Verification line per TDD-033 §10.5.                                                                                                     |

**Three-way merge UX (FR-15 `merge`):**
- Generate a candidate by overlaying the chosen pack on the existing file (operator-supplied keys win on conflict).
- Write candidate to `<repo>/.autonomous-dev/standards.yaml.candidate`.
- Open in `$EDITOR` (default `vi`); operator saves.
- Atomic-rename `.candidate` → `standards.yaml` after operator confirms diff. On editor exit non-zero → abort merge, leave existing file untouched.

**Eval set design:**

`happy-path.md`:
```yaml
---
phase: 14
case_type: happy-path
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
fixture_pack: typescript-strict
operator_inputs:
  detection_confirm: y
  pack_choice: typescript-strict
  two_person_approval: y
assertions:
  - id: A-1
    description: standards.yaml validates
    type: cli-exit
    command: autonomous-dev standards validate --repo {fixture_repo}
    expected: 0
  - id: A-2
    description: prompt renderer non-empty + schema-conformant
    type: regex-match
    target: stdout-render-prompt
    pattern: 'STANDARDS_SECTION:[^\n]+\n.+\n'
  - id: A-3
    description: prompt renderer SPEC-021-3-01 schema
    type: schema-validate
    target: stdout-render-prompt
    schema: tests/fixtures/setup-wizard/schemas/standards-section.json
  - id: A-4
    description: meta-reviewer dry-run produced JSON
    type: file-exists
    path: "{fixture_repo}/.autonomous-dev/standards-dry-run-{TODAY}.json"
  - id: A-5
    description: meta-reviewer dry-run JSON parses
    type: json-valid
    target: file-A-4
  - id: A-6
    description: two_person_approval flag persisted
    type: config-equals
    key: standards.two_person_approval_enabled
    expected: true
  - id: A-7
    description: SIGHUP delta 1
    type: counter-delta
    target: daemon-hup-counter
    expected: 1
  - id: A-8
    description: dry-run isolation
    type: fs-snapshot-diff
    allowlist: [{fixture_repo}/.autonomous-dev/standards.yaml, {fixture_repo}/.autonomous-dev/standards-dry-run-{TODAY}.json, ~/.autonomous-dev/wizard-state.json, ~/.autonomous-dev/wizard-checkpoint.json, ~/.autonomous-dev/logs/wizard.log]
---
```

`skip-with-consequence.md`:
- `wizard.skip_phase_14=true`.
- Assertions: verbatim consequence text; no standards.yaml written; phases.14.status=="skipped".

`error-recovery.md`:
- Sub-A (detection unknown): fixture repo has no obvious primary language. detect-language returns "unknown". Operator manually picks `typescript-strict`. Phase proceeds.
- Sub-B (wrong pack): TS repo + operator picks `python-pep8`. validate fails. Diagnostic surfaced. Operator re-picks `typescript-strict`. Phase completes.
- Sub-C (template missing): pack template file deleted from disk. write-yaml fails. Phase exits with troubleshoot pointer.

`idempotency-resume.md`:
- Sub-A (keep): existing standards.yaml; operator picks `keep`; validate runs; meta-reviewer dry-run still runs; phase complete.
- Sub-B (merge): existing + operator picks `merge`; editor opens; operator saves; merged file validates; phase complete.
- Sub-C (replace): existing + operator picks `replace`; overwrite + validate; phase complete.
- Sub-D (already-complete): full state, today's dry-run file already present. Probe emits already-complete. Body not entered.

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-01/02/03: orchestrator + helpers + state.
- SPEC-033-3-01: `standards_yaml_exists_at` helper.
- TDD-021: `autonomous-dev standards validate / render-prompt / standards-meta-reviewer --dry-run` CLI surfaces.
- SPEC-021-3-01: prompt renderer + STANDARDS_SECTION schema.
- SPEC-021-3-02: standards-meta-reviewer + two-person-approval contract.
- PRD-014: `autonomous-dev detect-language --repo` CLI.
- `plugins/autonomous-dev/config/standards-packs.json` — pack catalog.
- `plugins/autonomous-dev/templates/standards-packs/*.yaml` — pack templates.

**Produced:**
- `phases/phase-14-eng-standards.md`.
- `phase_14_skip_predicate` helper (≤ 10 LOC).
- `phase-14-probe` idempotency wrapper (≤ 30 LOC).
- Four eval case files.

## 6. Acceptance Criteria

### Front-matter contract (FR-1, FR-2)

```
Given phases/phase-14-eng-standards.md
When parsed by yq
Then phase=14 and tdd_anchors == ["TDD-021"]
And output_state.config_keys_written contains exactly the four keys from FR-6
And output_state.files_created contains the standards.yaml path and the dated dry-run JSON
```

### Skip-with-consequence (FR-3, FR-4, FR-20)

```
Given wizard.skip_phase_14 == true
When phase 14 enters
Then phase_14_skip_predicate exits 0
And the FR-4 verbatim consequence text is emitted
And phases.14.status == "skipped"
And no <repo>/.autonomous-dev/standards.yaml is written
```

### Detection surfaced not auto-accepted (FR-7, NFR auto-detect surfaced)

```
Given autonomous-dev detect-language returns "typescript"
When confirm-language step runs
Then the operator is prompted for confirmation/override
And input "y" / "Enter" accepts the detected language
And input "py" overrides to python (subject to pack availability)
```

### Pack data-drivenness (FR-8)

```
Given standards-packs.json contains entries [typescript-strict, python-pep8, go-default]
When the offer-pack step runs for confirmed language=python
Then the operator is offered "python-pep8" + "author your own"
And no pack id is hard-coded in the phase module body
```

### Prompt-renderer exercise + regression gate (FR-11, FR-24)

```
Given pack=typescript-strict has rule "ts-strict-null-checks" listed first
When exercise-prompt-renderer runs
Then `autonomous-dev standards render-prompt --rule-id typescript-strict:ts-strict-null-checks` is invoked
And stdout contains a non-empty STANDARDS_SECTION
And the STANDARDS_SECTION matches the SPEC-021-3-01 schema (validated against tests/fixtures/setup-wizard/schemas/standards-section.json)
```

### Meta-reviewer dry-run + dated file (FR-12, FR-13)

```
Given the repo has ≥ 5 commits
When meta-reviewer-dry-run runs
Then `autonomous-dev standards-meta-reviewer --dry-run --against HEAD~5..HEAD` is invoked
And stdout JSON is written to <repo>/.autonomous-dev/standards-dry-run-YYYY-MM-DD.json
And no other fs writes occur

Given the repo has only 3 commits
Then the range is adapted to HEAD~3..HEAD
And the dry-run JSON metadata records "range_truncated": true
```

### Two-person-approval flag (FR-14)

```
Given the operator answers "y" at the two-person-approval prompt
When write-config runs
Then standards.two_person_approval_enabled == true is written
```

### Existing-yaml decision (FR-15)

```
Given <repo>/.autonomous-dev/standards.yaml already exists
When existing-yaml-decision step runs
Then the operator is prompted with keep/merge/replace
And the choice is persisted to wizard-checkpoint.json

Given choice == "keep"
Then write-yaml is skipped; existing file unchanged

Given choice == "merge"
Then $EDITOR is invoked on a candidate file
And atomic-rename happens only after editor exit 0 + operator confirms diff

Given choice == "replace"
Then existing standards.yaml is overwritten
```

### Dry-run fs-write isolation (FR-17, NFR dry-run isolation)

```
Given fs-snapshot taken before phase 14 enters
When the phase completes
Then post-snapshot diff shows only the documented allow-list paths changed
And no other paths under ~/.autonomous-dev or <repo> are touched
```

### Eval pass + four cases (FR-18, FR-19, FR-22, FR-23)

```
Given the four eval cases run via the eval framework
When scoring is computed
Then per-case pass rate is ≥ 90%
And happy-path's 8 assertions all pass
And idempotency-resume's four sub-cases all pass
```

## 7. Test Requirements

**bats — `tests/setup-wizard/phase-14.bats`:**

| Test ID  | Scenario                                  | Assert                                                |
|----------|-------------------------------------------|-------------------------------------------------------|
| P14-101  | Front-matter parse                         | yq returns expected values                            |
| P14-201  | Skip via flag                              | predicate true; consequence emitted; no writes        |
| P14-301  | Detection surfaced                         | confirm prompt always shown                           |
| P14-302  | Pack data-drivenness                       | synthetic pack appears in offer                       |
| P14-401  | Validate fail → re-pick                    | up to 3 re-picks then fail                            |
| P14-501  | Prompt renderer non-empty                  | STANDARDS_SECTION length > 0                          |
| P14-502  | Prompt renderer schema                     | matches SPEC-021-3-01 schema                          |
| P14-601  | Meta-reviewer dated JSON                   | file at expected dated path                           |
| P14-602  | Range truncation when <5 commits           | metadata records truncation                           |
| P14-701  | Existing yaml: keep                        | no rewrite                                            |
| P14-702  | Existing yaml: merge                       | candidate file + atomic rename                        |
| P14-703  | Existing yaml: replace                     | overwrite                                             |
| P14-801  | Two-person-approval flag persisted         | config key true / false correctly                     |
| P14-901  | Dry-run isolation                          | fs-snapshot diff allow-list only                      |
| P14-A01  | Already-complete                           | probe emits already-complete; body not entered        |

**Eval cases:** four files as outlined in §4.

**Mocking:**
- `autonomous-dev` shim with controllable behavior for: `detect-language`, `standards validate`, `standards render-prompt`, `standards-meta-reviewer --dry-run`.
- Test repo fixtures: `ts-greenfield`, `py-greenfield`, `polyglot-unknown`, `ts-with-existing-standards`.
- A mock `$EDITOR` (e.g. `cat > "$1"`) for the merge sub-case.

## 8. Implementation Notes

- TDD-021's `standards-meta-reviewer --dry-run` is contracted to NOT invoke any LLM (per PLAN-033-3 risk row "Reviewer chain dry-run actually runs..."). If that contract evolves, the eval `dry-run-no-cost` assertion (added implicitly via dry-run isolation) catches it.
- The dated dry-run filename uses UTC date to avoid timezone-induced collisions across distributed CI runners.
- "Author your own" path writes a stub file with a templated comment block listing all available rule categories as commented-out hints, so the operator has a starting point.
- Detection-result confirmation uses single-letter input by default (y/n + override codes). Document the supported override codes in the module body.
- The prompt-renderer exercise is the AMENDMENT-002 AC-03 anchor for "exercises the prompt renderer at least once". Failure of A-2/A-3 in the eval is a release-blocker.

## 9. Rollout Considerations

- Feature flag `wizard.phase_14_module_enabled` (default `true`; ships in SPEC-033-3-03 / SPEC-033-4-05). Stage 1 rollout per TDD-033 §8.2.
- Rollback: `autonomous-dev wizard rollback --phase 14` (SPEC-033-4-05) restores the four config keys and **prompts before deleting** `<repo>/.autonomous-dev/standards.yaml` (operator may have edited it). Dated dry-run JSON files are LEFT in place (audit trail).

## 10. Effort Estimate

| Activity                                      | Estimate |
|-----------------------------------------------|----------|
| Front-matter + module body                    | 0.75 day |
| Idempotency wrapper + skip wrapper + 3-way merge UX | 0.25 day |
| Eval cases (4 incl. prompt-renderer schema fixture) | 0.5 day  |
| Unit tests (bats)                              | 0.25 day |
| **Total**                                     | **1.75 day** |
