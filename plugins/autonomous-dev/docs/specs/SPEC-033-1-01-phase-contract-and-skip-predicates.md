# SPEC-033-1-01: Phase Contract Spec + Skip-Predicate Helper Library

## Metadata
- **Parent Plan**: PLAN-033-1 (Wizard Orchestrator + Phase Modules 8 & 11)
- **Parent TDD**: TDD-033-setup-wizard-phase-modules
- **Parent PRD**: AMENDMENT-002 (extends AMENDMENT-001)
- **Tasks Covered**: PLAN-033-1 Task 1 (`_phase-contract.md`), Task 2 (`lib/skip-predicates.sh`)
- **Estimated effort**: 1.0 day
- **Status**: Draft
- **Author**: Specification Author (development-lifecycle-orchestrator)
- **Date**: 2026-05-02

## 1. Summary

This spec creates the shared phase-module contract document and the bash
helper library for skip-predicate evaluation that every TDD-033 phase
module (8, 11, 12, 13, 14, 15, 16) is reviewed against. The contract
document is the single source of truth for the YAML front-matter schema,
checkpoint conventions, helper-script naming, and the four mandatory
eval cases. The skip-predicate library is the read-only helper layer the
orchestrator calls before entering any phase to decide skip vs. run.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                  | Task |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | A markdown file at `plugins/autonomous-dev-assist/skills/setup-wizard/phases/_phase-contract.md` MUST document the YAML front-matter schema with all twelve keys from TDD-033 §5.1. | T1   |
| FR-2  | Each documented key MUST include a type, a one-line semantic description, and a worked example drawn from a TDD-033 §6 phase block.          | T1   |
| FR-3  | The contract MUST document the per-step checkpoint contract referencing `~/.autonomous-dev/wizard-checkpoint.json`.                          | T1   |
| FR-4  | The contract MUST document the script-naming convention for skip-predicate and idempotency-probe helpers (`<verb>_<noun>` snake_case bash function in `lib/*.sh`). | T1   |
| FR-5  | The contract MUST list the four mandatory eval cases (`happy-path.md`, `skip-with-consequence.md`, `error-recovery.md`, `idempotency-resume.md`) plus the case-12/16-only `linked-prd-no-duplication.md`. | T1   |
| FR-6  | A bash library at `plugins/autonomous-dev-assist/skills/setup-wizard/lib/skip-predicates.sh` MUST define the helpers `is_github_origin`, `has_config_key`, `config_key_equals`, `is_cli_only_mode`, `is_macos`, `is_linux`. | T2   |
| FR-7  | Each helper MUST exit with code `0` when the predicate is true (i.e. the phase should be skipped) and code `1` when the predicate is false. | T2   |
| FR-8  | Each helper MUST be pure: no writes to disk, no network calls, only file reads of `~/.autonomous-dev/config.json` (or a configured override) and detection-only commands (`uname`, `git remote`). | T2   |
| FR-9  | Each helper MUST emit no stdout output other than the single boolean answer. Errors during the predicate evaluation MUST go to stderr with a `[skip-predicates]` prefix and exit `2` (not `0` or `1`). | T2   |
| FR-10 | A bats test file at `plugins/autonomous-dev-assist/tests/setup-wizard/skip-predicates.bats` MUST exercise each helper across truth-table inputs.                                             | T2   |

## 3. Non-Functional Requirements

| Requirement              | Target                                       | Measurement Method                                                |
|--------------------------|----------------------------------------------|-------------------------------------------------------------------|
| Helper invocation latency | < 50ms per helper on cold cache              | `time skip-predicates is_github_origin`, averaged over 20 runs    |
| Bash compatibility       | bash 4.x and bash 5.x both pass bats suite   | `bats` run on macOS (bash 5) and Linux (bash 4)                   |
| Read-only invariant      | Zero filesystem writes during helper exec    | `inotifywait`/`fs-snapshot` diff before/after each helper         |
| Documentation completeness | 12/12 front-matter keys + checkpoint + eval cases documented | Manual rubric checklist mapped 1:1 against TDD-033 §5.1, §10.4   |

## 4. Technical Approach

**File 1: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/_phase-contract.md`**
A pure-prose reference. Sections (in order):
1. Title + status banner ("Read-only reference; not an executable skill").
2. Front-matter schema table: column headers `key | type | required | description | example`.
3. Worked example: full front-matter block copied verbatim from TDD-033 §5.1 phase-12 sample, annotated.
4. Checkpoint contract: location `~/.autonomous-dev/wizard-checkpoint.json`, schema `{phase: NN, last_completed_step: "...", started_at: "ISO-8601", state: "in-progress|verification-failed|complete"}`.
5. Helper-naming conventions: skip predicates live in `lib/skip-predicates.sh`, idempotency probes in `lib/idempotency-checks.sh`, named `verb_noun` (e.g. `is_github_origin`, `gh_branch_protection_configured`).
6. Mandatory eval cases enumeration with one-paragraph description per case.
7. Cross-reference list (TDD-033 §5.1, §6, §9.1, §10.4).

**File 2: `plugins/autonomous-dev-assist/skills/setup-wizard/lib/skip-predicates.sh`**
Single bash file, `set -uo pipefail` (no `-e` because exit codes are the API). Begins with header docstring describing the contract: "exit 0 = skip, exit 1 = run, exit 2 = predicate-evaluation error". Each helper is a function; the script also supports `skip-predicates.sh <function-name> [args]` dispatch for orchestrator invocation.

| Helper              | Inputs (env or args)             | Predicate logic                                                                                          |
|---------------------|----------------------------------|----------------------------------------------------------------------------------------------------------|
| `is_github_origin`  | none                             | `git remote -v 2>/dev/null \| grep -qE '(github\.com\|github\.[a-z0-9.-]+)'` → true                       |
| `has_config_key`    | `$1` = key path                  | `jq -e ".${1}" ~/.autonomous-dev/config.json >/dev/null 2>&1` → true                                     |
| `config_key_equals` | `$1` = key path, `$2` = value    | jq returns the value AND it equals `$2` (string compare); else false                                     |
| `is_cli_only_mode`  | none                             | `config_key_equals 'wizard.cli_only' 'true'` → true; else false                                          |
| `is_macos`          | none                             | `[[ "$(uname -s)" == "Darwin" ]]` → true                                                                 |
| `is_linux`          | none                             | `[[ "$(uname -s)" == "Linux" ]]` → true                                                                  |

`config.json` path resolves via `${AUTONOMOUS_DEV_CONFIG:-$HOME/.autonomous-dev/config.json}` so bats can override.

**File 3: `plugins/autonomous-dev-assist/tests/setup-wizard/skip-predicates.bats`**
Per-helper tests. Setup creates a temp `AUTONOMOUS_DEV_CONFIG` and a temp git repo. Each `@test` block sets up the predicate input and asserts both exit code and a no-stdout invariant.

## 5. Interfaces and Dependencies

**Consumed:**
- `jq` (>= 1.6) — must be available on `$PATH`.
- `git` (>= 2.20) for `git remote -v`.
- `~/.autonomous-dev/config.json` (created by inline phases 1-7; tests stub it).

**Produced:**
- Bash callable: `bash lib/skip-predicates.sh <function> [args]` returning the contract exit codes.
- Sourceable: `source lib/skip-predicates.sh` exposes all functions to a parent shell.
- Markdown reference at the contract file path.

**No external services. No state writes.**

## 6. Acceptance Criteria

### Contract document (FR-1 through FR-5)

```
Given the file plugins/autonomous-dev-assist/skills/setup-wizard/phases/_phase-contract.md
When a reviewer maps each row of TDD-033 §5.1's front-matter table to a row in the contract
Then every one of the twelve keys (phase, title, amendment_001_phase, tdd_anchors,
     prd_links, required_inputs, optional_inputs, skip_predicate, skip_consequence,
     idempotency_probe, output_state, verification, eval_set) appears with type,
     description, and a worked example
And the worked example block compiles as valid YAML
And the four mandatory eval-case names plus the case-12/16-only fifth case are listed
And the checkpoint file path and JSON schema are documented
```

### `is_github_origin` predicate (FR-6, FR-7, FR-8, FR-9)

```
Given a working directory whose `git remote -v` output contains "github.com"
When `bash lib/skip-predicates.sh is_github_origin` is invoked
Then the exit code is 0
And stdout is empty
And no file under the cwd or $HOME has been modified

Given a working directory whose `git remote -v` output contains only a self-hosted gitlab URL
When `bash lib/skip-predicates.sh is_github_origin` is invoked
Then the exit code is 1
And stdout is empty

Given a working directory that is not a git repo
When `bash lib/skip-predicates.sh is_github_origin` is invoked
Then the exit code is 1 (predicate false; absence of github means not github)
And stderr is empty
```

### `has_config_key` predicate (FR-6, FR-7)

```
Given a config.json containing {"intake": {"discord": {"enabled": true}}}
When `bash lib/skip-predicates.sh has_config_key intake.discord.enabled` runs
Then exit code is 0

Given the same config.json
When `bash lib/skip-predicates.sh has_config_key intake.slack.enabled` runs
Then exit code is 1

Given a missing config.json
When `bash lib/skip-predicates.sh has_config_key any.key` runs
Then exit code is 1 (treat missing config as predicate-false, not error)
```

### `config_key_equals` predicate (FR-6, FR-7)

```
Given a config.json containing {"wizard": {"cli_only": "true"}}
When `bash lib/skip-predicates.sh config_key_equals wizard.cli_only true` runs
Then exit code is 0

Given the same config.json
When `bash lib/skip-predicates.sh config_key_equals wizard.cli_only false` runs
Then exit code is 1
```

### `is_macos` / `is_linux` predicates (FR-6, FR-7)

```
Given uname -s returns "Darwin"
When `bash lib/skip-predicates.sh is_macos` runs
Then exit code is 0
And `bash lib/skip-predicates.sh is_linux` runs and exits 1
```

### Read-only invariant (FR-8)

```
Given a fresh fs-snapshot taken before invocation
When any helper in skip-predicates.sh is invoked
Then the post-invocation fs-snapshot diff against the pre-snapshot is empty
```

### Error path (FR-9)

```
Given jq is not on PATH
When any helper using jq is invoked
Then exit code is 2
And stderr begins with "[skip-predicates]"
And stdout is empty
```

## 7. Test Requirements

**Unit (bats) — `tests/setup-wizard/skip-predicates.bats`:**

| Test ID | Helper             | Setup                                    | Assert                              |
|---------|--------------------|------------------------------------------|-------------------------------------|
| T-101   | is_github_origin   | temp repo with github.com remote          | exit 0, no stdout                   |
| T-102   | is_github_origin   | temp repo with gitlab remote              | exit 1                              |
| T-103   | is_github_origin   | non-repo dir                              | exit 1, no stderr                   |
| T-104   | is_github_origin   | repo with `*.github.mycompany.com` remote | exit 0 (GHES support)               |
| T-201   | has_config_key     | config has nested key                     | exit 0                              |
| T-202   | has_config_key     | config missing key                        | exit 1                              |
| T-203   | has_config_key     | no config file                            | exit 1, no stderr                   |
| T-301   | config_key_equals  | matching value                            | exit 0                              |
| T-302   | config_key_equals  | non-matching value                        | exit 1                              |
| T-303   | config_key_equals  | missing key                               | exit 1                              |
| T-401   | is_cli_only_mode   | cli_only=true in config                   | exit 0                              |
| T-501   | is_macos           | mocked `uname -s = Darwin`                | exit 0                              |
| T-601   | is_linux           | mocked `uname -s = Linux`                 | exit 0                              |
| T-701   | error path         | jq removed from PATH                      | exit 2, stderr `[skip-predicates]`  |
| T-801   | invariant          | fs-snapshot before/after                  | empty diff                          |

Tests run on bash 4 (Linux runner) and bash 5 (macOS runner) per NFR.

**Integration:** None at this layer; the orchestrator integration is exercised in SPEC-033-1-03.

## 8. Implementation Notes

- The dispatch shim at the bottom of `skip-predicates.sh` is intentionally minimal:
  ```bash
  if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    fn="${1:-}"; shift || true
    declare -F "$fn" >/dev/null || { echo "[skip-predicates] unknown function: $fn" >&2; exit 2; }
    "$fn" "$@"
  fi
  ```
- `set -e` is intentionally NOT set; the helpers communicate through exit codes.
- Existing inline phases 1-7 already populate `~/.autonomous-dev/config.json`; do not change that schema.
- Avoid `awk`/`sed` parsing of JSON — `jq` is mandatory.
- For bats portability, prefer `command -v jq >/dev/null 2>&1` over `which jq`.

## 9. Rollout Considerations

- These artifacts are libraries; no feature flag required.
- The contract document is read-only reference and ships as part of the same PR as the orchestrator loop (SPEC-033-1-03).
- Backward-compatible: existing inline phases do not source this library; only the new orchestrator loop does.

## 10. Effort Estimate

| Activity                               | Estimate |
|----------------------------------------|----------|
| Author `_phase-contract.md`            | 0.5 day  |
| Implement `skip-predicates.sh` helpers | 0.25 day |
| Author bats suite                      | 0.25 day |
| **Total**                              | **1.0 day** |
