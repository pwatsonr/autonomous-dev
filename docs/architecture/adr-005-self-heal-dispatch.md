# ADR-005: Self-Healing Pipeline Dispatch Architecture

| Field       | Value                                            |
|-------------|--------------------------------------------------|
| Status      | Accepted                                         |
| Date        | 2026-06-30                                       |
| Request ID  | REQ-000056                                       |
| Tracking    | #620 (umbrella), #615, #616, #617, #618          |
| Supersedes  | —                                                |

---

## Context

The autonomous-dev supervisor loop (`supervisor-loop.sh`) previously handled
in-run failures by hard-failing or escalating to a human without attempting
automated remediation. Issue #620 requires that every reachable failure mode
(a) always be detected + recorded and (b) trigger an automatic remediation or
safe continue, with a human as the **final** escalation.

This document collects the eight architecture decisions made during the TDD
phase (TDD §11) that shaped the implementation in
`plugins/autonomous-dev/bin/lib/self-heal.sh` and the supervisor integration
hooks (H1–H9) added to `supervisor-loop.sh`.

---

## ADR-1: Data-driven dispatch table vs. inline conditionals

### Context

The PRD requires adding a new failure mode in ≤3 files (NFR-MAINTAINABILITY-01)
and the test plan mandates data-driven dispatch (TC-007).

### Decision

A single lookup function `_selfheal_table_lookup(mode_id)` maps each of the
nine failure modes (F1–F9) to a `(detector_fn|event_type|remediator_fn|policy)`
tuple. Per-integration-point ordered ID arrays
(`_SELFHEAL_DISPATCH_REVIEW_OUTCOME`, etc.) control which modes fire at each
hook. The supervisor iterates the table; it never contains mode-specific logic.

### Alternatives Considered

- **Inline `case` in `supervisor-loop.sh`** — rejected; violates
  NFR-MAINTAINABILITY-01 and makes the file harder to review.
- **External JSON config parsed by jq** — rejected; adds a runtime dependency
  on jq schema parsing and complicates bats fixtures.

### Consequences

Adding a new failure mode requires exactly: one `case` branch in
`_selfheal_table_lookup`, one detector function, one remediator function,
one bats test file, and one JSON schema.

---

## ADR-2: Self-heal state nested under `current_phase_metadata.self_heal`

### Context

PRD constraint N2 forbids breaking schema changes; daemons running older
versions of state.json must silently ignore new fields.

### Decision

All self-heal runtime state (`review_loop.*`, `reviewer_timeouts.*`,
`budget_extended_*`, `suspicious_previous_result`, `excluded_reviewers`,
`review_chain_disabled`, etc.) is written under
`.current_phase_metadata.self_heal` in `state.json`, using the atomic
`selfheal_state_set` helper.

### Alternatives Considered

- **Top-level `self_heal` key** — rejected; broader surface area, harder to
  reason about lifetime across phase advances.

### Consequences

The sub-object is cleared on every phase advance via the existing
`current_phase_metadata` reset, **except** for a small set of cross-phase
fields (`excluded_reviewers`, `review_chain_disabled`,
`review_chain_disabled_at`, `review_chain_disabled_for_phase`) that are
explicitly preserved by the `advance_phase` jq filter (hook H9).

---

## ADR-3: Bash + jq, no new runtime dependencies

### Context

TC-005 forbids introducing new third-party runtime dependencies.

### Decision

All detectors and remediators are pure bash functions using only jq (already
required), standard POSIX utilities, and existing supervisor helpers. The only
TypeScript surface touched is the reviewer runner (`intake/reviewers/runner.ts`
and `bin/review-gate-cli.ts`), which was already TypeScript.

### Alternatives Considered

- **Migrate self-heal logic to TypeScript** — rejected; `supervisor-loop.sh` is
  the canonical integration surface and round-tripping via a spawned TS process
  adds startup overhead on every hot path.

### Consequences

Slightly more verbose detector code (bash string manipulation vs. typed TS
objects), offset by comprehensive bats coverage.

---

## ADR-4: Schema validation gated by env flag, but events always appended

### Context

NFR-OBSERVABILITY-01 requires that all emitted events conform to the 15 JSON
schemas (draft-07) in `docs/schemas/events/`. FR-DETECT-05 requires that
events are always written, even if validation fails.

### Decision

`selfheal_emit_event` runs `ajv validate` when
`AUTONOMOUS_DEV_SELF_HEAL_VALIDATE_SCHEMA=1` (the CI default). On validation
failure it emits a `log_warn` but **still appends the event**. This preserves
the visibility-over-purity principle: a schema drift is surfaced in CI (where
validate=1), not silently dropped in production.

### Alternatives Considered

- **Hard-fail on schema mismatch** — rejected; violates FR-DETECT-05 and
  would cause a self-heal infrastructure failure to mask the original failure.

### Consequences

Schema drift is a CI failure (not a runtime failure). Operators running with
`AUTONOMOUS_DEV_SELF_HEAL_VALIDATE_SCHEMA=0` get all events with no
validation overhead.

---

## ADR-5: F7 (self-verify) is single-pass per result file

### Context

S-OP-2 and FR-REM-04 require that F7 (verification false-negative correction)
does **not** consume the request's retry budget. Risk #2 in the TDD warns
against stale-artifact false flips.

### Decision

The F7 detector checks that the test-result artifact's `mtime` is ≥
`phase_started_at` before accepting it as fresh. The F7 remediator rewrites
`result_file` exactly once with `self_verified: true`. The `advance_phase`
hook checks for that flag and bypasses the `escalation_count++` path,
promoting the phase to `pass` without consuming a retry.

### Alternatives Considered

- **Re-run the test command before overriding** — deferred to a follow-up;
  tracked as OQ-2 in the TDD. Re-running inside the supervisor loop risks
  introducing a second unbounded session.

### Consequences

A genuinely intermittent test bug remains masked for one cycle. The F7 event
stream (`verification_false_negative_detected` /
`verification_false_negative_corrected`) surfaces the pattern so operators can
investigate.

---

## ADR-6: Kill switch default = ON (self-healing enabled by default)

### Context

OQ-5 in the TDD asked whether self-healing should be opt-in (default OFF) in
v1. PRD risk "changes phase-failure semantics" was raised.

### Decision

`AUTONOMOUS_DEV_SELF_HEAL` defaults to `1` (enabled). The "v1 opt-in, v2
default-on" path is replaced by "v1 default-on with kill switch." The PRD
principle is that human escalation is the **final** resort, not the first; a
default-off implementation would defeat that goal for all operators who never
read the migration notes.

### Alternatives Considered

- **Default-off in v1** — rejected; new operators would get the worst of both
  worlds (legacy hard-fail semantics) and never benefit from self-healing.

### Consequences

Operators relying on the current "fast fail" behavior must set
`AUTONOMOUS_DEV_SELF_HEAL=0` explicitly in the daemon environment. This is
documented in the operator guide and the migration note in §14 of the spec.

---

## ADR-7: Reviewer `blocking` attribute lives in the chain config JSON

### Context

OQ-1 in the TDD asked where to store the "is this reviewer blocking the gate?"
attribute needed by F2 (repeated reviewer timeout → fallback to single
reviewer).

### Decision

Each entry in `intake/reviewers/chains/<request_type>.json` carries an
explicit `blocking: boolean` field (existing in the live TypeScript type
`ReviewerEntry.blocking`). Defaulting to `true` preserves today's gate-blocking
behavior for all existing chains.

### Alternatives Considered

- **Infer blocking-ness from reviewer name** — rejected; magic strings are
  brittle and untestable.

### Consequences

Chain config schema gains one optional field per entry. Existing chain JSON
files implicitly default to `blocking: true` (conservative). CI snapshot tests
per chain file enforce the explicit value requirement.

---

## ADR-8: Issue filing is opportunistic and gated by an env flag

### Context

PRD constraint N4 forbids mandatory network calls (including `gh issue create`)
in offline or CI environments.

### Decision

`remediate_novel_failure` (F9 remediator) attempts `gh issue create` only if
all three conditions hold: (1) `AUTONOMOUS_DEV_SELF_HEAL_FILE_ISSUES=1`,
(2) `gh auth status` exits 0, and (3) a `--repo` target is resolvable. If any
condition fails, the diagnostic bundle is written locally but no remote issue
is created.

### Alternatives Considered

- **Always attempt issue creation** — rejected; violates N4.
- **Never file issues** — rejected; loses operator visibility for novel failures.

### Consequences

The default behavior (`AUTONOMOUS_DEV_SELF_HEAL_FILE_ISSUES=0`) is
bundle-only and safe in every environment. Operators with `gh` configured and
appropriate repo access can opt into automatic issue filing.
