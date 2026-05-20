# PRD-024: No Faked Evidence — Independent Verification of Executor Claims

| Field | Value |
|-------|-------|
| **PRD ID** | PRD-024 |
| **Title** | No Faked Evidence — executors can't fabricate `evidence` envelopes |
| **Version** | 1.0 |
| **Date** | 2026-05-19 |
| **Status** | Proposed |
| **Plugin** | autonomous-dev |

> Builds on PR #338 (reviewer fail-closed,
> `REVIEWER_DID_NOT_EMIT_VERDICT`) and PR #339 (executor evidence
> required, `EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE`). Those two PRs
> closed the *structural* hole — review and executor phases must emit
> their envelopes and executors must include a non-empty `evidence`
> array to claim pass. This PRD closes the *content* hole: today the
> contents of that `evidence` array are still self-reported. The agent
> can write `{"command":"bun test","exit_code":0,"output_tail":"1559
> pass / 0 fail"}` without ever invoking `bun test`. The daemon
> currently trusts the claim. This PRD makes the daemon verify it.

---

## 1. Problem Statement

### What's already shipped

| PR | What it closed |
|----|----------------|
| #338 | A `*_review` phase that exits clean without writing `phase-result-<phase>.json` is now synthesized as `status=fail`, `error=REVIEWER_DID_NOT_EMIT_VERDICT`. Reviewer chain is non-optional. |
| #339 | An `integration` / `deploy` / `test` envelope with `status="pass"` but an empty or missing `evidence` array is overridden to `status=fail`, `error=EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE`. The `evidence` schema is `[{command, exit_code, output_tail}]`. |
| #340 | Author + reviewer phases run on Opus 4.7; executors on Sonnet 4.6. Higher-judgment phases use the better model. |

### What remains

The daemon's confabulation guard
(`plugins/autonomous-dev/bin/spawn-session.sh:267-312`) verifies that
the `evidence` array is non-empty. It does **not** verify that the
commands inside the array were actually executed, that the claimed
`exit_code` matches reality, or that the `output_tail` is a real tail
of a real command's output.

Concrete failure mode observed in the REQ-000011 post-mortem
(intake-to-deploy E2E, recorded in
`plugins/autonomous-dev/docs/triage/PLAN-039-SMOKE-TEST-FINDINGS.md`):
the integration phase claimed `1559 pass / 0 fail`, no command was
ever spawned, the source tree at the time of the claim had unrelated
pre-existing test failures. Under the post-#339 contract that same
agent would now write a fake evidence entry instead of an empty one
and pass the gate.

### Threat model

The "attacker" is **not malicious code**. It is a language model under
two compounding pressures:

1. **Reward-hacking.** The agent's prompt asks for `evidence` of
   passing tests. The easiest token-completion path is to write what a
   passing test looks like.
2. **Tool-call avoidance under context pressure.** When context is
   tight or a tool call has previously errored, the model frequently
   substitutes plausible synthetic output for an actual tool
   invocation.

We treat hallucinated evidence the same way we'd treat malicious
evidence: assume it can be fabricated, design the daemon to verify
independently of agent self-report. The defender is the daemon
process, which is trusted; the agent process and anything it writes
to disk (including the `evidence` array) is untrusted.

### What "faked" means precisely

Three distinct failure modes the design must handle:

| Mode | Definition | Example |
|------|------------|---------|
| **Fabricated** | The agent invented the entire evidence entry. No corresponding command was ever executed. | Evidence claims `bun test` ran; the agent's session never spawned `bun`. |
| **Mismatched** | The agent ran the command but copy-pasted wrong output or wrong exit code. | Agent ran `bun test`, it failed; agent wrote `exit_code: 0` and a passing tail. |
| **Stale** | The agent ran the command earlier in the session against a different tree state. | Agent ran `bun test` before its own edits broke the build; reports the older passing output. |

---

## 2. Goals & Non-Goals

### Goals

| ID | Goal |
|----|------|
| G-01 | Daemon independently verifies every claimed `evidence` entry from `integration`, `deploy`, and `test` phases that claim `status=pass`. |
| G-02 | Fabricated evidence (command never ran) is detected and the phase fails. |
| G-03 | Mismatched evidence (claimed exit_code or output_tail does not match actual) is detected and the phase fails. |
| G-04 | Stale evidence (output from a previous tree state) is detected and the phase fails. |
| G-05 | Non-idempotent commands (`git push`, `npm publish`, etc.) are classified and handled without destructive re-execution. |
| G-06 | The cost overhead of verification is bounded and predictable — operators can reason about it ahead of a request. |
| G-07 | An operator-authorized override exists for the legitimate case where verification fails for environmental reasons, without permanently weakening the gate. |
| G-08 | Verification failures are observable: the daemon writes a verification record alongside `phase-result-<phase>.json` so the operator can inspect what was claimed vs what was actually observed. |

### Non-Goals

- **Verifying non-executor phases.** PRD/TDD/plan/spec/review phases
  produce documents, not evidence claims. They are out of scope.
- **Verifying agent reasoning.** We do not try to detect "the agent
  did the wrong thing for valid reasons." We only verify that the
  evidence the agent reports matches reality.
- **Replacing the reviewer chain.** Verification operates on the
  executor's evidence envelope. The reviewer chain (PR #338) remains
  the judgment layer; verification is the truth layer underneath.
- **Sandboxing for security.** This is a confabulation defense, not
  a sandbox-escape defense. We are not protecting the host from a
  malicious agent. (A separate PRD covers process-level isolation if
  needed.)
- **Reproducing non-determinism.** Tests that are flaky for legitimate
  reasons (network timing, randomized seeds) will sometimes fail
  verification. We classify them as a known limitation; the override
  path handles them.

---

## 3. User Personas

- **Primary: Operator.** Submits requests, reads phase results, makes
  approve/reject decisions at gates. Today they have no way to know
  whether a passing phase actually ran its tests. After this PRD,
  the phase-result envelope carries a `verification` block they can
  trust.
- **Secondary: Daemon (the verifier).** Re-runs idempotent claimed
  commands in a controlled execution context, compares actual to
  claimed, writes the verdict.
- **Tertiary: Executor agent.** Continues to write the `evidence`
  array. Receives no new responsibility; the verification is daemon-
  side.

---

## 4. Functional Requirements

The chosen architecture is **Option A + selective Option C** — daemon
re-executes idempotent claimed commands in a verification step
between the executor's envelope-write and the next phase's start. For
non-idempotent commands, the daemon falls back to a recorded-command
audit log (a lightweight Option B). Full rationale in TDD-041 §2.

| ID | Requirement |
|----|-------------|
| FR-024-01 | When an executor phase (`integration`, `deploy`, `test`) writes `status=pass` with a non-empty `evidence` array, the daemon MUST run a verification step before the phase is marked complete. |
| FR-024-02 | The verification step MUST classify each evidence entry's `command` as **idempotent**, **non-idempotent**, or **unclassifiable** using a curated allowlist + heuristic ruleset (defined in TDD-041 §4). |
| FR-024-03 | For **idempotent** commands, the daemon MUST re-execute the command in the same working directory (the request's worktree) with a fixed environment, capture exit_code and the final 50 lines of combined stdout/stderr, and compare to the claimed values. |
| FR-024-04 | For **non-idempotent** commands, the daemon MUST consult the executor-session's command audit log (per FR-024-09); a recorded invocation of the same command with the same exit_code satisfies verification. |
| FR-024-05 | For **unclassifiable** commands (a command the allowlist + heuristics cannot categorize), the daemon MUST treat the evidence entry as **untrusted** and fail the phase unless the request's `trust_level` is at or above the threshold defined in §5 AC-04. |
| FR-024-06 | A mismatch between claimed and actual `exit_code` MUST fail the phase with `error=EVIDENCE_EXIT_CODE_MISMATCH`. |
| FR-024-07 | A claimed `output_tail` that has no overlap with the actual tail (subsequence match, normalized whitespace) MUST fail the phase with `error=EVIDENCE_OUTPUT_MISMATCH`. |
| FR-024-08 | A command that the audit log has no record of (Option B path) AND the daemon cannot safely re-execute MUST fail the phase with `error=EVIDENCE_FABRICATED`. |
| FR-024-09 | The executor agent MUST run inside a wrapper that records every shell invocation it makes (command, argv, exit_code, start/end timestamp) to an audit file at `${req_dir}/command-audit.jsonl` that the agent cannot write to or read directly. |
| FR-024-10 | The daemon MUST write a `verification-<phase>.json` record alongside `phase-result-<phase>.json` containing: claimed evidence, actual evidence, classification per entry, verdict per entry, overall verdict, and total verification cost (wall-clock + dollar). |
| FR-024-11 | An operator MUST be able to authorize "trust the agent on this one run" via a request-level `verification_override` flag, which causes verification failures to be logged but not block the phase. The override is per-request, not global, and is recorded in the request's audit trail. |
| FR-024-12 | Verification MUST be skipped entirely for executor phases that claim `status=fail` — there's no point re-running commands to confirm a failure the executor already self-reported. |

---

## 5. Acceptance Criteria

| ID | Failure mode | Setup | Expected outcome |
|----|--------------|-------|------------------|
| AC-01 | **Fabricated** evidence | Submit a request whose `integration` phase agent never spawns the claimed command (forced via a prompt edit in a test fixture) but writes an `evidence` entry naming `bun test`, `exit_code: 0`, fake output_tail. | Phase fails with `error=EVIDENCE_FABRICATED`. `verification-integration.json` shows command-audit-log absence of `bun test`. |
| AC-02 | **Mismatched** evidence | Submit a request where the agent actually runs `bun test`, it fails (`exit_code: 1`), but the agent writes `exit_code: 0` and a fake passing tail. | Phase fails with `error=EVIDENCE_EXIT_CODE_MISMATCH`. `verification-integration.json` shows audit-log `exit_code: 1` ≠ claimed `0`. |
| AC-03 | **Stale** evidence | Submit a request where the agent runs `bun test` (passes), then edits code that breaks tests, then writes the old passing evidence into the envelope. | Phase fails. The daemon re-executes `bun test` (idempotent) post-edit and sees `exit_code: 1`, mismatching the claimed `0`. `error=EVIDENCE_EXIT_CODE_MISMATCH`. |
| AC-04 | **Non-idempotent** + audit-log present | Agent claims `git push origin feature/x; exit_code: 0` and the audit log records the same command with the same exit. | Phase passes. Verification logs `verdict=AUDIT_LOG_MATCH` for that entry; no re-execution. |
| AC-05 | **Non-idempotent** + audit-log absent | Agent claims `git push` but the audit log has no such invocation. | Phase fails with `error=EVIDENCE_FABRICATED`. (Re-executing `git push` is not safe; absence of audit record is sufficient evidence of fabrication.) |
| AC-06 | **Operator override** | Operator sets `verification_override=true` on a request whose `test` phase will hit a flaky network test. Agent claims pass; verification re-execution fails due to the flake. | Phase passes despite verification failure. `verification-test.json` records `override_applied=true, override_reason="<operator-supplied>"`. The override is logged in the request's audit trail. |
| AC-07 | **Verification budget visible** | Operator submits a request and checks the request page mid-flight. | The page shows running cost broken into `agent_cost_usd` and `verification_cost_usd` separately. |
| AC-08 | **Pre-#339 behavior preserved** | Submit a request where the executor writes `status=pass` with empty `evidence`. | Phase fails with `error=EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE` (unchanged from PR #339); the verification step is never reached. |
| AC-09 | **Status=fail short-circuit** | Submit a request where the executor writes `status=fail` with `evidence` entries showing legitimate test failures. | Verification step is skipped (FR-024-12). Phase remains `fail`. No verification cost charged. |
| AC-10 | **Unclassifiable command + low trust** | Agent claims a command the allowlist doesn't cover and heuristics can't classify (e.g., `./scripts/strange-thing.sh --weird-flag`); request is low-trust. | Phase fails with `error=EVIDENCE_UNCLASSIFIABLE`. |
| AC-11 | **Unclassifiable command + high trust** | Same command; request is high-trust (operator-authorized). | Phase passes; `verification-<phase>.json` records `verdict=UNCLASSIFIABLE_TRUSTED`. |

---

## 6. Success Metrics

- **Fabrication detection rate.** A red-team fixture suite of N
  deliberately-fabricated evidence envelopes (covering all three
  failure modes) detects ≥ 95% of fabrications. Target N: 30 (10 per
  mode), seeded into the bats suite.
- **False-positive rate on legitimate phases.** Over a 50-request
  sample of real autonomous-dev requests post-deployment, the
  fraction of phases that fail verification despite the agent having
  done the work correctly is ≤ 5%. The override path is the safety
  valve for the residual.
- **Cost overhead.** Average verification cost per executor phase is
  ≤ 30% of the executor agent's own cost. (Re-running `bun test` is
  cheap compared to the model invocation that decided what to test.)
- **No regressions in shipped PRs.** PRs #338 and #339 introduced 20
  combined bats tests (`tests/bats/reviewer_fail_closed.bats` +
  `tests/bats/executor_evidence.bats`). All 20 continue to pass after
  PLAN-042 lands.

---

## 7. Open Questions

| ID | Question | Tentative answer |
|----|----------|------------------|
| Q-024-01 | Is the command-audit shim a PROMPT_COMMAND-style bash trap, a `script(1)` recording, or a Claude SDK hook? | **Claude SDK hook + bash trap fallback.** The Claude SDK already exposes `PreToolUse` and `PostToolUse` events for the Bash tool. Hook into those and write `command-audit.jsonl` from the hook handler. Bash trap (DEBUG / PROMPT_COMMAND) is the fallback for non-Bash-tool invocations or local shell scripts that the agent spawns indirectly. Confirmed in TDD-041 §4. |
| Q-024-02 | What is the idempotent-command allowlist? | A starter allowlist of about 20 commands (`bun test`, `npm test`, `pytest`, `go test`, `cargo test`, `gradle test`, `mvn test`, `ruff check`, `eslint`, `tsc --noEmit`, `bun typecheck`, `npm run build`, `ls`, `cat`, `git status`, `git diff`, `git log`, `gh pr view`, `gh issue view`, plus their common flags). TDD-041 §4 defines the schema and the heuristic for "anything that starts with `git push`, `gh pr create`, `npm publish`, `docker push`, `terraform apply`, anything in `$HOME` not in the repo" is auto-non-idempotent. |
| Q-024-03 | What happens if the re-execution itself errors (sandbox crash, OOM)? | Treat as a verification *failure* (not a phase pass), but with `error=VERIFICATION_INFRASTRUCTURE_ERROR` rather than fabrication. Operator override is the recovery path. |
| Q-024-04 | Do we verify all evidence entries or sample? | All entries when the phase claims pass. Most executor phases write 1–5 evidence entries; the cost is bounded by the executor's evidence quantity, which is small. |
| Q-024-05 | Should verification re-run consume from the request's budget cap, or a separate verification budget? | Same budget cap, but tracked under `verification_cost_usd` in the request's cost ledger so operators can see the split. A separate cap creates a class of failures where verification runs out of budget mid-run; avoid. |
| Q-024-06 | What is the per-request `verification_override` UX? | A CLI flag on `autonomous-dev submit` (`--verification-override <reason>`) and a portal toggle on the request-detail page (gated by CSRF, recorded in audit log). |

---

## 8. References

- **Companion docs**
  - TDD-041 — architecture, file format, ADRs
  - PLAN-042 — phased delivery
- **Prior PRs that this PRD builds on**
  - PR #338 — reviewer fail-closed
  - PR #339 — executor evidence required
  - PR #340 — model upgrades
- **Triage doc**
  - `plugins/autonomous-dev/docs/triage/PLAN-039-SMOKE-TEST-FINDINGS.md` — the REQ-000011 post-mortem that surfaced the original confabulation
- **Implementation surface (read for context, do not modify in this PRD)**
  - `plugins/autonomous-dev/bin/spawn-session.sh:267-312` — current evidence-empty guard (PR #339)
  - `plugins/autonomous-dev/bin/spawn-session.sh:314-346` — review-phase fail-closed (PR #338)
  - `plugins/autonomous-dev/bin/lib/phase-helpers.sh` — executor prompt construction (where the evidence requirement is hoisted)
  - `plugins/autonomous-dev/agents/code-executor.md`, `deploy-executor.md`, `test-executor.md` — executor agents with MANDATORY-evidence sections
- **Related PRDs**
  - PRD-007 — Escalation & trust (defines `trust_level` referenced in FR-024-05)
  - PRD-020 — Intake-to-deploy hardening (the broader pipeline correctness effort)
