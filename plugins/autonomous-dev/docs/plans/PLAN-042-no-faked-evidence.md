# PLAN-042: No Faked Evidence — Task Decomposition

| Field | Value |
|-------|-------|
| **PLAN ID** | PLAN-042 |
| **Parent PRD** | PRD-024 |
| **Parent TDD** | TDD-041 |
| **Date** | 2026-05-19 |
| **Status** | Proposed |

> Decomposes the no-faked-evidence design into four
> independently-shippable phases, ordered observability-first then
> enforcement. Each phase is mergeable on its own and adds value
> without requiring the next. Phase A ships pure observability
> (audit-log capture, no behavior change). Phase B adds verification
> that **logs** but does not fail. Phase C flips to refusal mode.
> Phase D adds the operator override. Each phase has explicit
> file:line targets and a test pass-count target.

---

## Slicing strategy

The design (TDD-041) introduces three new mechanisms — command-audit
log, evidence verifier, operator override — plus a classifier
config. Shipping them all at once would be a single high-risk merge
that's hard to revert and impossible to roll back partially. Slicing
by **observability first, enforcement second** lets us:

1. See real production data on what executor agents actually do
   (Phase A audit log) before we decide what to verify.
2. Calibrate the classifier and the 50% tail-overlap threshold
   against real evidence claims (Phase B logs without enforcing).
3. Flip enforcement on once we have data (Phase C).
4. Add the recovery path (Phase D) before enforcement starts
   producing false positives operators have to live with.

| Phase | What | Risk | Rough hours | Mergeable independently |
|-------|------|------|-------------|-------------------------|
| A | Command-audit log shim (observability only, no enforcement) | Low | 5 | Yes |
| B | Daemon-side verifier — logs verdict, doesn't enforce | Medium | 6 | Yes (depends on A) |
| C | Refusal mode: verification failure overrides phase-result to fail | Medium-High | 3 | Yes (depends on B) |
| D | Operator override (CLI + portal toggle) | Low | 4 | Yes (depends on C) |

**Total: ~18 hours of implementation across 4 PRs.**

---

## Phase A — Command-audit log shim (observability)

**Goal:** Every `Bash` tool invocation made by an
`integration`/`deploy`/`test` executor agent is recorded to
`${req_dir}/command-audit.jsonl` in the format defined in TDD-041
§D-05. No verification yet; no behavior change. The audit log file
is created, written, and inspected only — not consumed by enforcement
logic.

### Targets

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-042-A-01 | Create `plugins/autonomous-dev/hooks/audit-log-writer.sh` — a PreToolUse hook script that takes the SDK tool event (Bash tool name + argv + cwd) and writes a JSONL record to `${REQ_DIR}/command-audit.jsonl` | TBD | Todo | 1.0 | Hook receives event as stdin JSON per Claude SDK hook contract; writes via a daemon-owned FD passed through `$AUDIT_LOG_FD` |
| T-042-A-02 | Wire the hook into the executor agents via the agent frontmatter (`hooks: PreToolUse, PostToolUse`) — only for `integration`, `deploy`, `test` agents | TBD | Todo | 0.5 | `plugins/autonomous-dev/agents/{code,deploy,test}-executor.md` frontmatter |
| T-042-A-03 | In `spawn-session.sh`, before launching the agent, create `${req_dir}/command-audit.jsonl` with mode 0600 and export `AUDIT_LOG_FD` pointing to a daemon-owned write FD | TBD | Todo | 0.8 | Insert around line 200 (before the `claude` invocation); requires a small bash FD-management block |
| T-042-A-04 | Implement bash DEBUG-trap fallback in the executor agent's session wrapper for indirect spawns (when the agent runs a shell script that itself spawns commands) | TBD | Todo | 0.8 | Best-effort; flagged `source=debug_trap` in the JSONL |
| T-042-A-05 | Add a daemon-side helper `plugins/autonomous-dev/lib/verification/audit-log-reader.sh` that exposes `audit_log_has_command(req_dir, command, exit_code)` and `audit_log_entries(req_dir, phase)` | TBD | Todo | 0.5 | Used by Phase B; useful in Phase A for diagnostics |
| T-042-A-06 | New bats test file `tests/bats/audit_log_capture.bats` — 6 cases: log file created, log entry written for Bash tool call, log entry contains expected fields, agent cannot open the log for write, log survives agent crash mid-phase, DEBUG-trap fallback captures indirect spawns | TBD | Todo | 1.0 | Pass target: 6 |
| T-042-A-07 | Update portal request-detail to surface the audit log entries under a new collapsible "Command audit" region (read-only) | TBD | Todo | 0.4 | Optional in this phase; if it stretches scope, defer to Phase D where the verification record gets its own region anyway |

**Phase A pass target: 6 new bats tests + existing 20 from PRs
#338/#339 continue green.**

**File:line targets:**
- `plugins/autonomous-dev/bin/spawn-session.sh:~200` (create audit
  log + export FD)
- `plugins/autonomous-dev/hooks/audit-log-writer.sh` (new file)
- `plugins/autonomous-dev/lib/verification/audit-log-reader.sh` (new
  file)
- `plugins/autonomous-dev/agents/code-executor.md`,
  `deploy-executor.md`, `test-executor.md` (frontmatter `hooks:` field)
- `plugins/autonomous-dev/tests/bats/audit_log_capture.bats` (new file)

**Rollback:** delete the hook wiring lines in `spawn-session.sh` and
the frontmatter `hooks:` field. The hook file and reader are inert if
not invoked. The log file is in `${req_dir}` and is cleaned up by
the existing retention policy.

---

## Phase B — Daemon-side verifier (log only, no enforcement)

**Goal:** After each `integration`/`deploy`/`test` phase that claims
`status=pass`, the daemon runs the verifier defined in TDD-041 §2.
The verifier writes `verification-<phase>.json` per TDD-041 §D-06 but
**does not** override the phase-result envelope. The reviewer chain
proceeds as before. We collect real data on classification accuracy
and tail-overlap distributions for a couple of weeks before enabling
Phase C.

### Targets

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-042-B-01 | Create `plugins/autonomous-dev/lib/verification/idempotent-commands.json` — the starter allowlist from TDD-041 §D-02 (≈ 20 entries with per-command timeouts) | TBD | Todo | 0.5 | Schema: `{commands: [{first_token, args_pattern?, mutating_flags?, timeout_s, description}]}` |
| T-042-B-02 | Create `plugins/autonomous-dev/lib/verification/non-idempotent-commands.json` — the denylist with regex heuristics from TDD-041 §D-02 | TBD | Todo | 0.3 | Schema: `{commands: [...], heuristic_patterns: [...]}` |
| T-042-B-03 | Implement `plugins/autonomous-dev/lib/verification/classifier.sh` — `classify_command(command_string) → "idempotent" | "non_idempotent" | "unclassifiable"` | TBD | Todo | 0.8 | Pure-shell implementation against the JSON files via jq; no external deps |
| T-042-B-04 | Implement `plugins/autonomous-dev/lib/verification/reexecutor.sh` — `reexecute(command, cwd, timeout_s) → {exit_code, output_tail_50_lines}`. Strips `CLAUDE_*` and `ANTHROPIC_*` env vars per TDD-041 §D-03 | TBD | Todo | 1.0 | Uses `timeout(1)` for timeout enforcement; captures combined stdout+stderr |
| T-042-B-05 | Implement `plugins/autonomous-dev/lib/verification/tail-comparator.sh` — `compare_tails(claimed, actual) → {overlap_ratio, verdict}` per TDD-041 §D-04 (normalize whitespace, strip ANSI/durations/timestamps, line-multiset subsequence, 50% threshold) | TBD | Todo | 1.0 | Threshold is a constant at top of file; revisitable in Phase C |
| T-042-B-06 | Implement `plugins/autonomous-dev/lib/verification/verify-evidence.sh` — orchestrator that reads `phase-result-<phase>.json`, iterates `evidence[]`, calls classifier+reexecutor/audit-log-reader+tail-comparator per entry, writes `verification-<phase>.json` | TBD | Todo | 1.5 | The main entry point Phase C will wire into spawn-session.sh |
| T-042-B-07 | Wire the verifier into `spawn-session.sh` between the existing PR #339 evidence-empty check (line 312) and the synthesis block (line 314). For Phase B: **always log, never override** (write the verification record but leave `phase-result-<phase>.json` untouched) | TBD | Todo | 0.5 | Single block; gated behind `AUTONOMOUS_DEV_VERIFY_MODE=log` env var so Phase C can flip to `enforce` |
| T-042-B-08 | New bats test file `tests/bats/evidence_verification_log_mode.bats` — 8 cases: idempotent re-exec match, idempotent re-exec mismatch (logs but doesn't override), non-idempotent audit log match, non-idempotent audit log absent (logs but doesn't override), unclassifiable command, status=fail short-circuit, timeout, verification record file shape | TBD | Todo | 0.7 | Pass target: 8 |

**Phase B pass target: 8 new bats tests; 6 from Phase A and 20 from
PRs #338/#339 stay green; verification records appear in
`${req_dir}/` on every passing executor phase but no phase results
change.**

**File:line targets:**
- `plugins/autonomous-dev/lib/verification/*.sh` (new — 4 files)
- `plugins/autonomous-dev/lib/verification/*.json` (new — 2 files)
- `plugins/autonomous-dev/bin/spawn-session.sh:312` (insert
  verifier-orchestrator call after the PR #339 guard)
- `plugins/autonomous-dev/tests/bats/evidence_verification_log_mode.bats`
  (new)

**Rollback:** unset `AUTONOMOUS_DEV_VERIFY_MODE` (or set to `off`).
The verifier code is dormant.

---

## Phase C — Refusal mode

**Goal:** Flip `AUTONOMOUS_DEV_VERIFY_MODE` from `log` to `enforce`.
Verification failures override `phase-result-<phase>.json` to
`status=fail` with the appropriate `EVIDENCE_*` error code. The 30-
fixture red-team suite from PRD-024 §6 ships as part of this phase to
prove fabrication detection.

### Targets

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-042-C-01 | Modify the verifier-orchestrator call in `spawn-session.sh` to, when `AUTONOMOUS_DEV_VERIFY_MODE=enforce`, override `phase-result-<phase>.json` to `{status: "fail", error: "<EVIDENCE_*>", feedback: "<details>", synthesized: true}` when any verification verdict is fail (and override is not enabled) | TBD | Todo | 0.5 | Mirrors the PR #339 override pattern at lines 297–307 |
| T-042-C-02 | Default `AUTONOMOUS_DEV_VERIFY_MODE` to `enforce` in the daemon config (`plugins/autonomous-dev/lib/config-defaults.json` or equivalent) | TBD | Todo | 0.1 | Operators can still set `log` for debugging |
| T-042-C-03 | Build the red-team fixture suite — 30 deliberately-fabricated evidence envelopes split 10/10/10 across fabricated/mismatched/stale. Each fixture is a JSON file + a tiny harness that spawns spawn-session.sh against a mocked agent that writes the fixture. | TBD | Todo | 1.5 | `plugins/autonomous-dev/tests/fixtures/evidence-red-team/` directory |
| T-042-C-04 | New bats test file `tests/bats/evidence_verification_red_team.bats` driving the 30 fixtures. Pass: phase fails with the expected `EVIDENCE_*` error code | TBD | Todo | 0.5 | Pass target: 30 (the red-team suite from PRD-024 §6) |
| T-042-C-05 | New bats test file `tests/bats/evidence_verification_enforce.bats` — 5 cases: enforce mode overrides phase-result on idempotent mismatch, enforce mode overrides on audit-log absent, enforce mode does not override on status=fail short-circuit, log-mode envvar disables enforcement, enforce is default | TBD | Todo | 0.4 | Pass target: 5 |

**Phase C pass target: 35 new bats tests; previous 34 stay green; the
red-team suite achieves the 95% fabrication-detection success metric
from PRD-024 §6.**

**File:line targets:**
- `plugins/autonomous-dev/bin/spawn-session.sh:~312-340` (extend the
  Phase B insertion with the override block, gated by mode)
- `plugins/autonomous-dev/lib/config-defaults.json` (set default mode)
- `plugins/autonomous-dev/tests/fixtures/evidence-red-team/` (new)
- `plugins/autonomous-dev/tests/bats/evidence_verification_red_team.bats`
  (new)
- `plugins/autonomous-dev/tests/bats/evidence_verification_enforce.bats`
  (new)

**Rollback:** set `AUTONOMOUS_DEV_VERIFY_MODE=log` (or `off`) in
`config-defaults.json`. Phase B's verification records continue to be
written but stop affecting phase outcomes.

---

## Phase D — Operator override

**Goal:** Operators can authorize "trust the agent on this run" via
CLI and portal. The override is per-request, audited, and does not
persist. With the override applied, the verification step still runs
and writes its record, but a fail verdict does not change the
phase-result envelope.

### Targets

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-042-D-01 | Extend `${req_dir}/request.json` schema to include the optional `verification_override: {enabled, reason, set_by, set_at}` block | TBD | Todo | 0.2 | Schema-only update; no migration needed for existing requests |
| T-042-D-02 | Add `autonomous-dev override-verification REQ-NNNNNN --reason "..."` CLI sub-command in `plugins/autonomous-dev/bin/autonomous-dev` (or wherever subcommands are dispatched) | TBD | Todo | 0.7 | Writes the block + appends to the request's audit-trail JSONL |
| T-042-D-03 | Modify the verifier-orchestrator to read `request.json` `verification_override`. When `enabled=true`, write the verification record with `override_applied=true, override_reason=<reason>` and skip the phase-result override step | TBD | Todo | 0.4 | Behavior switch in `verify-evidence.sh` |
| T-042-D-04 | Add portal route `POST /repo/:repo/request/:id/override` in `plugins/autonomous-dev-portal/server/routes/` with CSRF guard, body `{reason: string}`, sets the override block, redirects back to request detail | TBD | Todo | 0.8 | Mirrors the existing approval-gate route shape |
| T-042-D-05 | Add a "Verification override" toggle to the request-detail page template (one of `plugins/autonomous-dev-portal/server/templates/views/request-detail/region-*.tsx`), shown only when the latest verification record has `overall_verdict=fail` and `override_applied=false` | TBD | Todo | 0.6 | Form posts to the new route from T-042-D-04 |
| T-042-D-06 | Add a "Verification" region to the request-detail page that surfaces `verification-<phase>.json` per phase: classification table, per-entry verdicts, overall verdict, override state. Read-only render of the file. | TBD | Todo | 0.8 | One region template; consumes the file written by Phase B/C |
| T-042-D-07 | New bats test file `tests/bats/evidence_verification_override.bats` — 5 cases: override set via CLI persists, override set via CLI causes enforce mode to log-only, override does not affect subsequent requests, override without reason is rejected, audit trail entry written | TBD | Todo | 0.5 | Pass target: 5 |
| T-042-D-08 | New portal test file `plugins/autonomous-dev-portal/tests/routes/override-route.test.ts` — 4 cases: POST with valid CSRF + reason returns 302 + sets block, POST without CSRF returns 403, POST without reason returns 400, GET request-detail with override applied shows the audit row | TBD | Todo | 0.5 | Pass target: 4 |

**Phase D pass target: 9 new tests (5 bats + 4 portal). Previous 69
stay green.**

**File:line targets:**
- `plugins/autonomous-dev/bin/autonomous-dev` (new sub-command)
- `plugins/autonomous-dev/lib/verification/verify-evidence.sh` (read
  override flag, branch)
- `plugins/autonomous-dev-portal/server/routes/override.ts` (new route)
- `plugins/autonomous-dev-portal/server/templates/views/request-detail/region-verification.tsx`
  (new region template)
- `plugins/autonomous-dev/tests/bats/evidence_verification_override.bats`
  (new)
- `plugins/autonomous-dev-portal/tests/routes/override-route.test.ts`
  (new)

**Rollback:** revert the route + region + CLI sub-command. The
override block in `request.json` becomes inert if no code reads it.

---

## Cross-cutting

### Verification gate per PR

Every PR in this plan must:

1. Run the full bats suite locally and post a before/after pass-count
   diff in the PR description.
2. Confirm the 20 tests from PRs #338/#339 continue to pass (no
   regression in the structural guards this PRD builds on).
3. For Phases B/C/D: include a manual smoke run of a real
   autonomous-dev request and attach the generated
   `verification-<phase>.json` and `command-audit.jsonl` to the PR.
4. Phase C specifically: the 30-fixture red-team suite must report
   ≥ 95% pass (the 95% threshold from PRD-024 §6 success metrics).

### Rollback strategy

Each phase is a single PR with a clean revert.

- **Phase A revert:** drop the hook wiring; audit log stops being
  written. No downstream effects (B/C/D depend on A, but if A is
  reverted before B ships there's no problem; if A is reverted after
  B ships, B's verifier sees an absent audit log and treats all
  non-idempotent commands as fabricated — operators would need to
  override or roll forward).
- **Phase B revert:** set `AUTONOMOUS_DEV_VERIFY_MODE=off`. Phase A's
  audit log keeps being written but is not consumed.
- **Phase C revert:** set `AUTONOMOUS_DEV_VERIFY_MODE=log`. Phases A
  and B keep producing records; no enforcement.
- **Phase D revert:** revert the route + region + CLI sub-command.
  Enforcement (Phase C) still works; operators just lose the override
  UX (they'd have to hand-edit `request.json` to set the block, which
  is acceptable for a short rollback window).

### Telemetry to capture during Phase B logging period

Before flipping Phase C on, collect at least 50 real autonomous-dev
runs in Phase B's log-only mode and review:

- Distribution of `classification` across executor phases (how often
  do we hit `unclassifiable`?)
- Distribution of `tail_overlap_ratio` for matching idempotent
  re-executions (calibrates the 50% threshold)
- False-positive candidates: phases where `overall_verdict=fail` was
  recorded but a human spot-check says the agent did the work
  correctly
- Time and cost overhead per phase (validates the 30% target from
  PRD-024 §6)

A short triage doc (PLAN-042 follow-up) captures these findings before
Phase C ships.

---

## Follow-ups (out of scope)

| ID | Idea | Why deferred |
|----|------|--------------|
| F-042-01 | Container-level process isolation for the re-execution step | This PRD is hallucination defense, not sandbox defense; separate PRD |
| F-042-02 | Verification for the `code` phase (the agent's edits) | The `code` phase doesn't produce an `evidence` array today; verifying source edits requires a different architecture (diff-applied semantic checks); separate PRD if needed |
| F-042-03 | Aggregated verification dashboard in the portal (cross-request fabrication rates by agent, by phase, over time) | Observability-on-top-of-data; ship after Phase D has data to aggregate |
| F-042-04 | Harden the audit log against malicious agents (peer-credentials check on the writer socket) | Threat model expansion; not needed for hallucination defense |
| F-042-05 | Auto-grow the idempotent-commands allowlist from observed-safe usage (statistical learning from audit logs) | Cute but premature; one-line PRs to the allowlist are fine |
| F-042-06 | Cross-phase staleness check (the verifier notices that a `git status` evidence from phase N predates a `git commit` from phase N-1) | Useful but additive; ship after the per-entry checks are proven |

---

## References

- **Parent PRD:** PRD-024
- **Parent TDD:** TDD-041
- **Prior PRs:** #338 (reviewer fail-closed), #339 (executor evidence
  required), #340 (model upgrades)
- **Implementation surface to be created/modified:**
  - `plugins/autonomous-dev/bin/spawn-session.sh:312`
  - `plugins/autonomous-dev/hooks/audit-log-writer.sh` (new)
  - `plugins/autonomous-dev/lib/verification/*.sh` (new directory)
  - `plugins/autonomous-dev/lib/verification/{idempotent,non-idempotent}-commands.json` (new)
  - `plugins/autonomous-dev/agents/{code,deploy,test}-executor.md` (frontmatter)
  - `plugins/autonomous-dev/bin/autonomous-dev` (CLI sub-command)
  - `plugins/autonomous-dev-portal/server/routes/override.ts` (new)
  - `plugins/autonomous-dev-portal/server/templates/views/request-detail/region-verification.tsx` (new)
- **Test surface to be created:**
  - `plugins/autonomous-dev/tests/bats/audit_log_capture.bats` (6)
  - `plugins/autonomous-dev/tests/bats/evidence_verification_log_mode.bats` (8)
  - `plugins/autonomous-dev/tests/bats/evidence_verification_enforce.bats` (5)
  - `plugins/autonomous-dev/tests/bats/evidence_verification_red_team.bats` (30)
  - `plugins/autonomous-dev/tests/bats/evidence_verification_override.bats` (5)
  - `plugins/autonomous-dev/tests/fixtures/evidence-red-team/` (30 fixtures)
  - `plugins/autonomous-dev-portal/tests/routes/override-route.test.ts` (4)
- **Triage doc:** `plugins/autonomous-dev/docs/triage/PLAN-039-SMOKE-TEST-FINDINGS.md`
- **Related plans:** PLAN-009-1 (trust ladder, where `trust_level`
  used by FR-024-05 is defined)
