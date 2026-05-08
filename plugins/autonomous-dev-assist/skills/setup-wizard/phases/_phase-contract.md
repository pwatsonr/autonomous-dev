# Phase Module Contract (TDD-033)

> **Status: Read-only reference; not an executable skill.**
>
> Authoritative contract for every phase module under `phases/phase-NN-*.md`
> in the setup-wizard. Cross-references: TDD-033 §5.1 (front-matter schema),
> §6 (per-phase design), §9.1 (eval cases), §10.4 (checkpoint contract).

---

## 1. YAML Front-Matter Schema

Every phase module MUST begin with a YAML front-matter block delimited by
`---` at top-of-file. The block MUST contain (at minimum) the following twelve
keys:

| key                   | type             | required | description                                                                                  | example                                                              |
|-----------------------|------------------|----------|----------------------------------------------------------------------------------------------|----------------------------------------------------------------------|
| `phase`               | integer          | yes      | Phase number per AMENDMENT-001 phase registry.                                               | `12`                                                                 |
| `title`               | string           | yes      | Operator-facing phase title rendered in the orchestrator banner.                             | `"CI workflows + secrets + branch protection"`                       |
| `amendment_001_phase` | integer          | yes      | The phase number from AMENDMENT-001 this module implements (usually equal to `phase`).       | `12`                                                                 |
| `tdd_anchors`         | list of strings  | yes      | TDD IDs that this phase implements operator-facing surfaces for.                              | `[TDD-016, TDD-017]`                                                  |
| `prd_links`           | list of strings  | yes      | PRD IDs that own chain-level guidance referenced by this phase. Empty for non-chain phases.  | `[PRD-015]`                                                           |
| `required_inputs`     | object           | yes      | Inputs the phase requires. See §1.1.                                                          | `{phases_complete: [1,2,3,4,5,6,7], config_keys: ['.repos.allowlist']}` |
| `optional_inputs`     | object           | yes      | Inputs the phase consults if present (boolean flags only).                                    | `{github_token_present: true}`                                        |
| `skip_predicate`      | string           | yes      | Bash command (sourced from `lib/skip-predicates.sh`) that determines skip-vs-run.             | `"skip-predicates.sh is_github_origin"`                               |
| `skip_consequence`    | string (block)   | yes      | Verbatim operator-facing prose explaining what the operator loses by skipping.                | `"Without phase 12, the daemon will not run in CI."`                  |
| `idempotency_probe`   | string           | yes      | Bash command (sourced from `lib/idempotency-checks.sh`) that emits start-fresh / resume-from:<step> / already-complete. | `"idempotency-checks.sh phase-12-probe"` |
| `output_state`        | object           | yes      | Declares what the phase writes. See §1.2.                                                     | (see §1.3 worked example)                                             |
| `verification`        | list of strings  | yes      | Operator-facing verification bullets emitted at phase close.                                  | `["Probe PR runs green", "Branch protection report present"]`         |
| `eval_set`            | string           | yes      | Path to the phase's eval case directory.                                                       | `"evals/test-cases/setup-wizard/phase-12-ci-setup/"`                  |

### 1.1 `required_inputs`

```yaml
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]    # phase numbers that must be complete
  config_keys: [".repositories.allowlist"]  # config keys that must be present
```

### 1.2 `output_state`

```yaml
output_state:
  config_keys_written:
    - ci.workflows_installed
    - ci.branch_protection_enabled
  files_created:
    - ".github/workflows/autonomous-dev-ci.yml"
  external_resources_created:
    - "GitHub branch protection rule on main"
    - "github.repo.secret.AUTONOMOUS_DEV_TOKEN"
```

`config_keys_written` is consumed by the rollback CLI (SPEC-033-4-04) for
snapshot capture; `external_resources_created` is consumed for revocation
dispatch.

### 1.3 Worked Example (Phase 12, copied from TDD-033 §5.1)

```yaml
---
phase: 12
title: "CI workflows + secrets + branch protection"
amendment_001_phase: 12
tdd_anchors: [TDD-016, TDD-017]
prd_links: [PRD-015]
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys: [".repositories.allowlist"]
optional_inputs:
  github_token_present: true
skip_predicate: "scripts/skip-predicates.sh phase-12-ci-setup"
skip_consequence: |
  Without phase 12, autonomous-dev will not run in CI. PRs from the daemon
  will not have status checks; branch protection will not gate them.
idempotency_probe: "scripts/idempotency-checks.sh phase-12-ci-setup"
output_state:
  config_keys_written: [".ci.workflows_installed", ".ci.branch_protection_enabled"]
  files_created: [".github/workflows/autonomous-dev-ci.yml", ".github/workflows/autonomous-dev-cd.yml"]
  external_resources_created: ["GitHub branch protection rule on main"]
verification:
  - "Probe PR runs green"
  - "Branch protection report shows required checks"
eval_set: "evals/test-cases/setup-wizard/phase-12-ci-setup/"
---
```

---

## 2. Checkpoint Contract

Path: `~/.autonomous-dev/wizard-checkpoint.json`

Schema:

```json
{
  "phase": 12,
  "last_completed_step": "scaffold-workflows",
  "started_at": "2026-05-02T12:34:56Z",
  "state": "in-progress"
}
```

| field                 | type    | values                                                                  |
|-----------------------|---------|-------------------------------------------------------------------------|
| `phase`               | integer | The phase the checkpoint applies to.                                    |
| `last_completed_step` | string  | Step name from the phase module's step table.                           |
| `started_at`          | string  | ISO-8601 UTC timestamp.                                                  |
| `state`               | string  | One of `in-progress`, `verification-failed`, `complete`.                |

The wizard writes the checkpoint after each named step completes. SIGINT
mid-step preserves the most recently committed checkpoint. Resume reads
this file and dispatches via `WIZARD_RESUME_STEP=<last_completed_step+1>`.

The orchestrator state file at `~/.autonomous-dev/wizard-state.json` is a
separate, longer-lived artifact whose schema is owned by SPEC-033-1-03.

---

## 3. Helper-Naming Convention

Skip-predicate functions live in
`plugins/autonomous-dev-assist/skills/setup-wizard/lib/skip-predicates.sh`.

Idempotency-probe functions live in
`plugins/autonomous-dev-assist/skills/setup-wizard/lib/idempotency-checks.sh`.

Each function name MUST be `verb_noun` snake_case bash, e.g.:

| function name                         | location              |
|---------------------------------------|-----------------------|
| `is_github_origin`                    | skip-predicates.sh    |
| `is_cli_only_mode`                    | skip-predicates.sh    |
| `is_macos`                            | skip-predicates.sh    |
| `has_config_key`                      | skip-predicates.sh    |
| `gh_branch_protection_configured`     | idempotency-checks.sh |
| `workflow_template_hash_matches`      | idempotency-checks.sh |
| `wizard_state_phase_complete`         | idempotency-checks.sh |

Skip predicates exit `0` for "skip", `1` for "run", `2` for predicate-evaluation
error. Idempotency probes emit `start-fresh|resume-from:<step>|already-complete`
to stdout and exit `0` on success, `2` on error.

---

## 4. Mandatory Eval Cases

Every phase MUST ship the following four eval cases under
`evals/test-cases/setup-wizard/phase-NN-<topic>/`:

| case file                       | asserts                                                                                             |
|---------------------------------|-----------------------------------------------------------------------------------------------------|
| `happy-path.md`                 | Inputs valid; phase completes; correct config keys written; verification passes.                    |
| `skip-with-consequence.md`      | Operator chooses skip; the verbatim `skip_consequence` text is emitted; phase exits cleanly.        |
| `error-recovery.md`             | An injected error (bad token, missing tool, etc.); phase recovers OR exits with actionable diagnostic. |
| `idempotency-resume.md`         | Phase started, killed mid-way, re-run; resumes correctly with no duplicate writes.                  |

Phases 12 and 16 MUST additionally ship:

| case file                          | asserts                                                                                            |
|------------------------------------|----------------------------------------------------------------------------------------------------|
| `linked-prd-no-duplication.md`     | Rendered phase output contains zero ≥40-char verbatim sentences from PRD-015 (or PRD-017 for 16).  |

Phase 16 MUST additionally ship:

| case file              | asserts                                                                                                   |
|------------------------|-----------------------------------------------------------------------------------------------------------|
| `credential-leak.md`   | For each of the six credential families, injection at any prompt aborts the phase before any state write. |

---

## 5. Cross-References

- TDD-033 §5.1 — Front-matter schema (canonical source).
- TDD-033 §6 — Per-phase detailed design (one section per phase).
- TDD-033 §9.1 — Eval-set rubric.
- TDD-033 §10.4 — Reliability / checkpoint discussion.
- SPEC-033-1-01 — This file's authoring spec.
- SPEC-033-1-03 — Orchestrator loop that consumes this contract.
- AMENDMENT-002 §AC-03 — ≥90% per-phase eval pass requirement.

---

*End of phase contract.*
