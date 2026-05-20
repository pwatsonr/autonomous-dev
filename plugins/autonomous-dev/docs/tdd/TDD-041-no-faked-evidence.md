# TDD-041: No Faked Evidence — Independent Verification of Executor Claims

| Field | Value |
|-------|-------|
| **TDD ID** | TDD-041 |
| **Parent PRD** | PRD-024 |
| **Date** | 2026-05-19 |
| **Status** | Proposed |

> Companion to PRD-024. Pins the architecture (hybrid re-execution +
> recorded-command audit log), the file formats, and the failure modes
> the design accepts. Implementation lands in PLAN-042 phases.

---

## 1. Architecture Overview

```
                       ┌──────────────────────────────────────────────────┐
                       │   Executor session (integration/deploy/test)      │
                       │                                                   │
   Claude SDK Bash ───▶│   PreToolUse hook ──▶ append-only audit writer    │
   tool invocation     │   (writes /req-dir/command-audit.jsonl via a       │
                       │    daemon-owned FD the agent never has)            │
                       │                                                   │
                       │   Agent does work, writes:                        │
                       │     - phase-result-<phase>.json                    │
                       │       (status, feedback, evidence[])               │
                       │     - other artifacts                              │
                       └──────────────────────────────────────────────────┘
                                          │
                                          ▼
                       ┌──────────────────────────────────────────────────┐
                       │   spawn-session.sh post-agent guard chain          │
                       │                                                   │
                       │   Existing PR #339 check:                          │
                       │     status==pass && evidence.length<1              │
                       │       → override to fail                            │
                       │       (EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE)      │
                       │                                                   │
                       │   NEW: verify-evidence step                        │
                       │     for entry in evidence[]:                       │
                       │       classify(command)                             │
                       │         ├─ idempotent      → daemon re-executes    │
                       │         ├─ non-idempotent  → check audit log       │
                       │         └─ unclassifiable  → trust gate            │
                       │       compare claimed vs actual                    │
                       │     write verification-<phase>.json                 │
                       │     if any verdict==fail → override phase-result   │
                       │       to status=fail with error=EVIDENCE_*          │
                       └──────────────────────────────────────────────────┘
                                          │
                                          ▼
                       ┌──────────────────────────────────────────────────┐
                       │   Reviewer chain (PR #338 fail-closed)            │
                       │   Reads phase-result-<phase>.json (now verified)   │
                       └──────────────────────────────────────────────────┘
```

The cutover from "agent claim" to "verified claim" is a single point:
the `verify-evidence` step in `spawn-session.sh` runs **after** the
existing PR #339 evidence-empty check and **before** the daemon's
phase-transition logic reads the envelope. The reviewer chain
downstream sees only post-verification envelopes.

---

## 2. Design Decisions

### D-01: Hybrid re-execution + audit log (not pure re-exec, not pure sandboxed recording, not verifier-phase agent)

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **A. Daemon re-runs every claimed command.** | Conceptually clean; deterministic; no shim infra needed; catches all three failure modes. | 2x cost; destructive for non-idempotent commands (`git push`, `npm publish`); non-deterministic commands fail spuriously. | Partial — used for **idempotent** commands only. |
| **B. Sandboxed command logging.** Wrap the agent in a shim that records every shell invocation to an append-only audit file the agent can't write. Validate evidence against the log. | Cheap; can't be faked; works for non-idempotent commands. | Requires shim infra (PROMPT_COMMAND, strace, or Claude SDK hook); doesn't catch the *content* of a command's output, only that it ran with a particular exit code. | Partial — used for **non-idempotent** commands and as a presence-of-command check feeding into A. |
| **C. Per-phase verifier agent** (a new `*_verify` phase). | Clean separation; observable as its own pipeline step; uses the same agent infra. | Doubles the number of phases (~10→~20); doubles cost more than option A; introduces a second confabulation surface (the verifier could also fabricate). | Rejected — the verifier itself would need verification. |
| **A+B hybrid (this design).** | Cheap for the common case (audit log presence-check is free), accurate for idempotent commands (full re-execution catches mismatched + stale), bounded blast radius (destructive operations never re-run). | Two mechanisms instead of one; requires the classification step in FR-024-02. | ✓ **Chosen.** |

### D-02: Classification — allowlist plus heuristic, deny-by-default for unknowns

Three classes, defined by a lookup against an idempotent-command
allowlist with optional regex matchers:

| Class | Rule | Examples |
|-------|------|----------|
| **Idempotent** | Command's first token (after env-var prefix stripping) matches an entry in `idempotent-commands.json` AND no argument matches a known mutating-flag pattern. | `bun test`, `npm test`, `pytest -k foo`, `cargo test --no-run`, `ruff check src/`, `eslint --max-warnings 0`, `tsc --noEmit`, `git status`, `git diff HEAD`, `gh pr view 123` |
| **Non-idempotent** | Command's first token matches a `non-idempotent-commands.json` entry, OR matches a heuristic regex (`^git push`, `^gh pr create`, `^npm publish`, `^docker push`, `^terraform apply`, `^rm -rf`, anything touching `$HOME` outside the worktree). | `git push origin main`, `gh pr create --fill`, `npm publish`, `docker push registry/x:tag`, `terraform apply -auto-approve` |
| **Unclassifiable** | Neither set matched. | Custom scripts (`./scripts/whatever.sh`), unusual binaries, novel CLI tools. |

The allowlists are versioned files at
`plugins/autonomous-dev/lib/verification/idempotent-commands.json` and
`non-idempotent-commands.json`. Adding entries is a one-line PR.

Unclassifiable commands fail the phase **unless** the request's
trust level is at or above a configured threshold (TDD-009 trust
ladder), in which case they pass with `verdict=UNCLASSIFIABLE_TRUSTED`
recorded for audit.

**Why deny-by-default for unknowns.** A confabulating model is more
likely to invent commands than to choose obscure-but-real ones. Real
executor work routes through the dozen-or-so well-known test/build
tools. Anything else deserves a second look.

### D-03: Re-execution context

The daemon's re-execution runs in:

- **Working directory:** the request's worktree (`$req_dir/worktree`).
- **Environment:** the daemon's environment minus
  `CLAUDE_*` and `ANTHROPIC_*` vars (so the re-execution can't
  trigger a recursive agent call).
- **Stdin:** `/dev/null`.
- **Timeout:** the smaller of (a) the original agent phase timeout
  remaining or (b) a per-command timeout from the allowlist (default
  300s).
- **Output capture:** combined stdout/stderr to a temp file; the last
  50 lines (normalized whitespace, ANSI escapes stripped) become the
  observed `output_tail`.

The re-execution is a regular subshell, not a container. Process
isolation is **out of scope** — we're catching confabulation, not
escape. See §6 risks accepted.

### D-04: Output-tail comparison — subsequence match, not exact match

Test runners emit slightly different output across runs even when
they pass identically (durations, file ordering, line numbering of
parallel workers). An exact-string compare would produce a 90%
false-positive rate.

The comparator:

1. Normalizes whitespace (collapse runs of spaces, strip trailing
   whitespace on lines).
2. Strips ANSI escape sequences.
3. Strips numeric durations (`\b\d+(\.\d+)?\s*(ms|s|seconds)\b`).
4. Strips ISO-8601 timestamps.
5. Asserts the actual normalized tail is a **superset** (by
   line-multiset) of at least 50% of the claimed normalized tail's
   non-empty lines.

50% is chosen empirically — passes typical `bun test` and `pytest`
output, fails when the claimed tail is unrelated text. The threshold
is configurable.

### D-05: Audit log file format

`${req_dir}/command-audit.jsonl` — append-only JSON lines, one record
per Bash tool invocation:

```jsonl
{"ts":"2026-05-19T12:34:56Z","phase":"integration","command":"bun test","argv":["bun","test"],"cwd":"/path/to/worktree","exit_code":0,"duration_ms":4521,"source":"sdk_hook"}
{"ts":"2026-05-19T12:35:02Z","phase":"integration","command":"git status","argv":["git","status"],"cwd":"/path/to/worktree","exit_code":0,"duration_ms":12,"source":"sdk_hook"}
```

The agent process **cannot** open this file for write or read. It is
created by the daemon with mode 0600 before the agent starts and the
file descriptor is held by a small writer subprocess that the Claude
SDK PreToolUse hook talks to over a pipe. The agent's own filesystem
permissions don't matter — the wrapper, not the agent, owns the FD.

`source` is `sdk_hook` for Claude SDK Bash tool calls (the common
case) or `debug_trap` for fallback bash-DEBUG-trap captures when the
agent invokes a script that itself spawns subprocesses (these are
less reliable; treat as best-effort).

### D-06: Verification record file format

`${req_dir}/verification-<phase>.json`:

```json
{
  "phase": "integration",
  "claimed_status": "pass",
  "claimed_evidence": [
    {"command": "bun test", "exit_code": 0, "output_tail": "1559 pass / 0 fail\n"}
  ],
  "verifications": [
    {
      "claim_index": 0,
      "command": "bun test",
      "classification": "idempotent",
      "verdict": "pass",
      "actual_exit_code": 0,
      "actual_output_tail": "1559 pass / 0 fail\n",
      "tail_overlap_ratio": 0.97,
      "reexecution_duration_ms": 4380,
      "reexecution_cost_usd": 0.0
    }
  ],
  "overall_verdict": "pass",
  "override_applied": false,
  "override_reason": null,
  "verification_cost_usd": 0.0,
  "verification_wall_clock_ms": 4380,
  "completed_at": "2026-05-19T12:36:14Z"
}
```

For non-idempotent commands `classification: "non_idempotent"`,
`verdict: "audit_log_match"` (or `audit_log_absent` for fail), and
the re-execution fields are null.

### D-07: Operator override mechanism

The override is a request-level field, not a phase-level field, and
not a global config. It is:

1. **Per-request.** Lives in `${req_dir}/request.json`'s
   `verification_override` block: `{enabled: true, reason: "<text>",
   set_by: "<operator-id>", set_at: "<ts>"}`.
2. **Set via two paths:**
   - CLI: `autonomous-dev override-verification REQ-NNNNNN --reason
     "test env differs from agent's"` (a new sub-command in PLAN-042
     Phase D).
   - Portal: a toggle on the request-detail page, gated by CSRF,
     posted to a new route `POST /repo/:repo/request/:id/override`.
3. **Audited.** Setting the override writes a
   `request-action-<ts>.jsonl` entry with the operator's ID and
   reason. The portal renders this in the request's history.
4. **Single-request scope.** The override does not persist beyond the
   request. A second request from the same operator starts with the
   override off.

When `verification_override.enabled` is true, verification still
runs and writes its record, but a `fail` verdict does not override
`phase-result-<phase>.json`. The override path is the audit trail; it
does not weaken the gate for future requests.

---

## 3. Failure Modes Table

| Mode | Likelihood | Symptom | Mitigation |
|------|------------|---------|------------|
| Idempotent command's re-execution succeeds but agent's original execution genuinely failed (test was flaky) | Medium for network-sensitive suites | Phase passes verification despite actually-failed run | Acceptable — the daemon's re-execution is the source of truth. If the flake repeats both times, AC-01/AC-02 still catches the mismatch. |
| Non-idempotent command's audit log is incomplete because the agent shelled out via a script that didn't go through Claude SDK Bash tool | Medium | `verdict=audit_log_absent` → false fail | Bash DEBUG trap fallback (D-05) catches indirect spawns best-effort. Operator override (D-07) is the recovery path. |
| Test re-run mutates filesystem state in a way that breaks subsequent phases | Low for normal test suites; medium for "smoke tests that write to /tmp" or "tests that bind to a port" | A test phase re-execution leaves test artifacts that the next phase steps on | Re-execution runs in the **same worktree** as the agent did (FR-024-03), so any state already produced by the agent is the same state the re-run uses. Pre-existing state collisions are a pre-existing problem, not introduced by this. |
| Re-execution timeout exceeds remaining phase budget | Low | Verification reports `VERIFICATION_INFRASTRUCTURE_ERROR` | Logged; phase fails; operator override path |
| Allowlist drift — a new test runner appears (e.g., `vitest`, `playwright`) and isn't in the allowlist yet | High over time | Phases fail with `EVIDENCE_UNCLASSIFIABLE` | One-line PR to the allowlist file. The allowlist is intentionally cheap to update. |
| Agent finds a way to write to `command-audit.jsonl` (sandbox escape) | Low — the file is daemon-owned and the FD is not exposed to the agent | Audit log is fabricated | We accept that this is not a security boundary — the threat model is hallucination, not malice. Hardening the file ownership is a follow-up (`F-042-04`). |
| Verification's output-tail comparator over-matches and rates fabricated tails as legitimate | Medium for short tails | Mismatched evidence slips through with high overlap ratio | The 50% threshold (D-04) is configurable; the metric is reported in `tail_overlap_ratio` so operators can detect over-matching from observability data. |
| A long-running test that the agent ran in CI but the daemon re-runs locally has a 10x runtime delta and exceeds verification's per-command timeout | Low for typical suites; possible for integration tests against external services | Verification reports timeout | Per-command timeout in the allowlist can be raised. Operator override for the specific request is the fallback. |

---

## 4. State Files / Runtime Contracts

| Surface | Today | Post-PRD |
|---------|-------|----------|
| `${req_dir}/phase-result-<phase>.json` | Written by agent; daemon overrides empty-evidence pass to fail (PR #339) | Same shape; daemon may additionally override `status=pass` to `status=fail` with `error=EVIDENCE_*` after verification. |
| `${req_dir}/command-audit.jsonl` | Does not exist | New — append-only audit log written by daemon-owned writer subprocess via Claude SDK hook |
| `${req_dir}/verification-<phase>.json` | Does not exist | New — verification verdict record (D-06 format) |
| `${req_dir}/request.json` `verification_override` block | Does not exist | New optional block (D-07) |
| `plugins/autonomous-dev/lib/verification/idempotent-commands.json` | Does not exist | New — allowlist (≈ 20 entries to start) |
| `plugins/autonomous-dev/lib/verification/non-idempotent-commands.json` | Does not exist | New — denylist with regex heuristics |
| Request cost ledger (`${req_dir}/cost-ledger.json` per PRD-010-2) | Tracks `agent_cost_usd` per phase | Adds `verification_cost_usd` per phase (cents-precision; re-execution is shell, not LLM, so usually $0; tracked for shape consistency) |

---

## 5. Performance + Cost Analysis

| Class | Frequency in real requests | Per-entry cost | Notes |
|-------|----------------------------|----------------|-------|
| Idempotent re-execution | High — most evidence claims are test/lint runs | Wall-clock equal to the original command (4s–5min); $0 LLM cost; small CPU/IO | The cost driver. Average integration phase has 2–3 evidence entries. |
| Non-idempotent audit-log check | Medium — deploy/integration phases | Sub-millisecond (jq scan of a small JSONL file) | Effectively free. |
| Unclassifiable trust gate | Low — should be rare | Constant time | Effectively free. |
| Output-tail comparator | Per entry | Sub-millisecond | Pure string ops on ≤ 50 lines. |
| Audit log writer subprocess (always-on during executor phases) | Per Bash tool call | Sub-millisecond per call | Long-running but cheap. |

**Per-phase verification overhead estimate** (integration phase as
the worst case): 1 re-execution of `bun test` (≈ 60s for a real repo)
plus a couple of fast lint checks ≈ 70s wall-clock + $0 dollar cost.
The executor agent itself typically costs $0.50–$2.00 and 2–5
minutes. Verification adds ≈ 1 min wall-clock and $0 to that.
Within the 30% overhead target (PRD-024 §6 success metric).

If the executor claimed pass (FR-024-12 says skip-on-fail), we run
verification on every passing executor phase. We do not run it on
the `code`, `test`, `integration_review`, etc., phases — only the
three executor phases listed in FR-024-01.

---

## 6. Risks Accepted

- **No process isolation.** We are not sandboxing the re-execution
  beyond stripping `CLAUDE_*` / `ANTHROPIC_*` env vars. A genuinely
  malicious agent could leave a tripwire in the worktree that the
  re-execution would detonate. This PRD's threat model is
  hallucination, not malice. A separate PRD covers container-level
  isolation if needed.
- **Audit log can theoretically be fabricated.** The daemon-owned FD
  + hook design makes it impractical, but not literally impossible,
  for the agent to inject lines into the JSONL. We accept this; if
  the threat model expands to active attackers, the writer-subprocess
  could move to a unix domain socket with peer-credentials checks.
- **The 50% tail-overlap threshold is empirical.** Tuning it
  conservatively (e.g., to 80%) would catch more fabrications at the
  cost of more false positives on legitimately-variable output. We
  ship at 50% with metrics so the threshold can be revisited from
  data.
- **Network-flaky tests will sometimes need the override.** This is
  explicit, not hidden. The override path is the answer; operators
  are not expected to chase flakes manually.
- **Allowlist will need maintenance.** Test runners and tools change.
  We accept that PRs adding new tools to
  `idempotent-commands.json` are routine maintenance, not gated
  changes.

---

## 7. Architecture Decision Records (mini-ADRs)

- **ADR-041-01:** Hybrid re-execution (idempotent) + audit log
  (non-idempotent) over pure re-execution, pure recording, or
  verifier-phase agent. Rationale: only path that's cheap for the
  common case, safe for destructive ops, and doesn't create a second
  confabulation surface. Status: accepted.
- **ADR-041-02:** Command-class allowlist + denylist + heuristic with
  deny-by-default for unknowns at low trust. Rationale: confabulating
  models invent commands more often than they discover novel-but-real
  ones. Status: accepted.
- **ADR-041-03:** Output-tail comparator is line-multiset
  subsequence with normalization, threshold 50%. Rationale:
  exact-match has unacceptable false-positive rate against real test
  output; subsequence catches fabrication because invented tails have
  no overlap with real ones. Status: accepted, threshold revisitable.
- **ADR-041-04:** Operator override is per-request, set via CLI or
  portal, audited, and does not persist. Rationale: avoid global
  weakening; preserve audit trail; recovery path for legitimate flakes.
  Status: accepted.
- **ADR-041-05:** Command-audit log is written by a daemon-owned
  writer subprocess fed by the Claude SDK PreToolUse hook (with bash
  DEBUG trap as best-effort fallback). Rationale: SDK hook is the
  canonical place to observe Bash tool invocations without trusting
  the agent. Status: accepted.
- **ADR-041-06:** Verification runs after the PR #339 evidence-empty
  guard and before the daemon's phase-transition logic — same file
  (`spawn-session.sh`), adjacent block. Rationale: minimum-surface
  change; existing guards already establish the pattern. Status:
  accepted.
- **ADR-041-07:** Verification is skipped when executor claims
  `status=fail`. Rationale: nothing to verify; re-running would waste
  cost confirming a failure already self-reported. Status: accepted.

---

## 8. References

- **Parent PRD:** PRD-024
- **Companion plan:** PLAN-042
- **Prior PRs:** #338, #339, #340
- **Implementation surface (to be modified by PLAN-042, not by this TDD):**
  - `plugins/autonomous-dev/bin/spawn-session.sh` (insert verify-evidence step at line ~312)
  - `plugins/autonomous-dev/bin/lib/phase-helpers.sh` (no changes needed; evidence requirement already there)
  - `plugins/autonomous-dev/lib/verification/` (new directory: classifier, re-executor, comparator, audit-log reader)
  - `plugins/autonomous-dev/lib/verification/idempotent-commands.json` (new)
  - `plugins/autonomous-dev/lib/verification/non-idempotent-commands.json` (new)
  - `plugins/autonomous-dev/hooks/` (new PreToolUse hook for audit log writer)
- **Test surface (to be created by PLAN-042):**
  - `plugins/autonomous-dev/tests/bats/evidence_verification_idempotent.bats`
  - `plugins/autonomous-dev/tests/bats/evidence_verification_non_idempotent.bats`
  - `plugins/autonomous-dev/tests/bats/evidence_verification_override.bats`
  - `plugins/autonomous-dev/tests/bats/evidence_verification_red_team.bats` (the 30-fixture fabrication suite from PRD-024 §6)
- **Related TDDs:**
  - TDD-009 — trust escalation (provides `trust_level` field consumed by FR-024-05)
  - TDD-010 — config governance (where the threshold and allowlist live)
- **Related triage doc:**
  - `plugins/autonomous-dev/docs/triage/PLAN-039-SMOKE-TEST-FINDINGS.md`
