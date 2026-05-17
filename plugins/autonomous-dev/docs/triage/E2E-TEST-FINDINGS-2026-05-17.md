# E2E test findings — 2026-05-17

Standalone bug report from running the full E2E playbook
(`plugins/autonomous-dev/docs/triage/E2E-TEST-HANDOFF-2026-05-16.md`, PR #268)
against the live launchd daemon (plugin 0.1.0 cache, post–B-13 filter).

All entries are also indexed in `PLAN-039-SMOKE-TEST-FINDINGS.md` (rows
B-15…B-22) — this doc adds prose context, repro steps, root-cause hypotheses,
and a fix-order recommendation that the table doesn't have room for.

---

## TL;DR

8 new bugs found. **4 are HIGH** and block the system from being end-to-end
trustworthy:

| Bug | Sev | Area | One-line |
|---|---|---|---|
| B-15 | HIGH | cli | `request cancel` / `kill` cannot be confirmed from CLI |
| B-17 | HIGH | daemon | Doc-author phases produce no artifacts; reviewer fails silently synth-passed |
| B-18 | HIGH | cli ↔ daemon | SQLite never updated by daemon → CLI control plane stale |
| B-20 | HIGH | cli | `request priority` flag wiring broken |
| B-22 | HIGH | daemon | Integration/deploy artifacts never committed; master never merged |
| B-16 | low | daemon | Missing per-phase prompt files; fallback masks quality |
| B-19 | med | cli | `request logs` only shows intake event, not daemon pipeline events |
| B-21 | med | daemon | `phase_history` contains only 3 of 13 phases on a successful run |

Net effect: **the pipeline can reach `status: done` while shipping zero
documentation to disk, no commits past the `code` phase, and no merge to
master** — and the operator has no CLI tool to inspect, pause, or cancel
in-flight work once it's running.

Confirmed-fixed-and-working at runtime (from prior work): B-01, B-03, B-05,
B-06, B-08, B-09, B-10, B-13 — see the "Confirmed working" section below.

---

## Test summary

- **Cost**: $3.23 added to the cost-ledger (cumulative YTD $36.55). Well
  under the $80 cap.
- **Pipeline run**: REQ-000008 (Python CLI todo app) walked all 14 phases
  to `done/monitor` on the live launchd daemon in ~36 minutes, escalation
  count 0, no error, `cost_accrued_usd` matches the ledger rollup exactly
  ($3.23 / $3.23).
- **What passed**: phase-0 setup, phase-2 portal HTTP smoke (all 10
  routes 200, `/repo/<repo>/request/<REQ>` works), phase-9 orphan
  reconciliation (fired at daemon boot, cancelled missing-state rows).
- **What failed**: phase-1 acceptance (missing `docs/*.md`, partial
  `phase_history`, no master merge), phase-5 CLI verbs.
- **What was skipped**: phase-3 (bug-type), phase-4 (gate-approval),
  phase-8 (failure-paths) all blocked by B-17 (reviewer-fail masked).
  Phase-6 (autopilot) over budget. Phase-7 (`/observe`) needs MCP servers
  not configured in this env.

---

## Findings — daemon

### B-17 — HIGH — Doc-author phases produce no artifacts; reviewer fails silently synth-passed

**Symptom.** REQ-000008 reached `done/monitor` with zero on-disk
documentation. `docs/prd/<slug>.md`, `docs/tdd/<slug>.md`,
`docs/plans/<slug>.md`, `docs/specs/<slug>.md` — none exist. Reviewer
agents that explicitly returned `{"status": "fail"}` in their text output
were converted to `{"status": "pass", "synthesized": true}` by the
daemon and the pipeline advanced anyway.

**Two compounding root causes.**

1. **Read-only agents.** The four doc-author agents
   (`prd-author`, `tdd-author`, `plan-author`, `spec-author`) and all
   reviewer agents (`doc-reviewer`, `quality-reviewer`, etc.) declare
   `tools: Read, Glob, Grep, WebSearch, WebFetch` in their frontmatter
   — no `Write`. They cannot create the `docs/<kind>/<slug>.md` artifact
   nor their own `phase-result-<phase>.json`. They complete narratively
   (text-only) and exit 0. **Important narrowing:** `code-executor`,
   the integration agent, and the deploy agent **do** have `Write`,
   produced rich agent-written phase-result-*.json files, and created
   real files on disk. Only doc-author + reviewer phases are affected.

2. **Synthesis fallback masks explicit failure.** When the daemon finds
   no `phase-result-<phase>.json` after an agent session,
   `synthesize_phase_result` writes
   `{"status": "pass", "synthesized": true, "feedback": "synthesized from exit code 0"}`
   based solely on the agent's exit code. It doesn't parse the agent's
   final text output, so when `doc-reviewer` outputs verbatim
   `{"status": "fail", "feedback": "BLOCK - No PRD document exists to review."}`,
   the daemon ignores it.

**Repro.** REQ-000008, 2026-05-17, live launchd daemon, plugin 0.1.0
cache. Author session
`session-1778981392.txt` ($0.29, 16 turns) contains the agent's verbatim
text: *"I notice that I don't have a Write tool available to actually
create the files."* Reviewer session `session-1778981577.txt` ($0.14,
15 turns) contains the verbatim BLOCK verdict. Same pattern on
`tdd` + `tdd_review`, `plan` + `plan_review`, `spec` + `spec_review`.

**Downstream consequences.**
- Phase-1 acceptance fails on missing doc artifacts.
- Phase-4 (gate-approval) un-testable: gates can't fire because
  reviewer fails are masked as passes.
- Phase-8 (failure-paths / `MAX_RETRIES_EXCEEDED`) un-testable for the
  same reason.

**Fix sketches.**
- (a) Add `Write` to `tools:` frontmatter in
  `agents/{prd,tdd,plan,spec}-author.md` and all reviewer agents. Or:
  introduce a write-mediator where the daemon parses the agent's
  output for path/content blocks and writes them post-session.
- (b) `synthesize_phase_result` must parse the agent's final result
  text for a JSON code-block containing `"status": "fail"` /
  `"block"` and honor it. Regression test: a deliberately-blocked
  reviewer must terminate the pipeline in `failed` state, not
  silently advance.

---

### B-22 — HIGH — Integration/deploy artifacts never committed; master never merged

**Symptom.** After REQ-000008 reaches `done/monitor`,
`git -C ad-e2e-test status -s` shows:

```
 M todo.py
?? integration_test.py
?? Dockerfile
?? DEPLOYMENT.md
?? dist/
?? docker-compose.yml
?? install.sh
?? .github/
?? pyproject.toml
?? simple_todo_cli.egg-info/
```

— modified `todo.py` + 9 untracked entries. Only the `code` phase's
commit (`a6e73d9 feat: add Python CLI todo application`, just
`todo.py` + `test_todo.py`) reached the `autonomous/REQ-000008` branch.
`git log master` is still at `bfecfb7 init`. The state.json and
`request-actions/REQ-000008.json` both say `status: done`, yet master
has never seen any of the work.

**Root cause.** The `integration` agent's session text describes
"verified the code is ready" but never runs `git add` / `git commit`
/ `git checkout master && git merge`. The `deploy` agent builds wheels
into `dist/` and writes deployment scaffolding but also never commits.
No phase in the pipeline takes ownership of "make the work durable on
the integration branch and merge to master".

**Compounding consequence.** The next REQ run against the same repo
would inherit a dirty working tree (everything from the prior run, plus
whatever new files), which `code-executor` would likely misinterpret as
its own staging area.

**Fix sketches.**
- (a) The `integration` agent prompt must include: *stage and commit
  your changes, then `git checkout master && git merge --no-ff
  autonomous/<REQ>` (or open a PR)*. The `deploy` agent prompt must
  also commit before exiting.
- (b) The daemon auto-commits at end-of-phase with a fixed message,
  and the `integration` phase explicitly merges to master before
  advancing.
- (c) Introduce a dedicated `commit` phase between `code` and
  `integration` whose only responsibility is to stage + commit
  whatever's dirty.

---

### B-21 — med — `phase_history` only contains 3 of 13 phases on a successful run

**Symptom.** On REQ-000008 at terminal `status: done`:

```json
"phase_history": [
  {"phase": "code",        "status": "completed", "completed_at": "..."},
  {"phase": "integration", "status": "completed", "completed_at": "..."},
  {"phase": "deploy",      "status": "completed", "completed_at": "..."}
]
```

All 13 `phase-result-*.json` files exist on disk, and the daemon's
`events.jsonl` has 13 corresponding `phase_advance` entries. So
`phase_history` is the only consumer that has the wrong number of
rows.

**Root cause hypothesis.** The `phase_history` append in
`state_json_writer` apparently only fires for phases the daemon
"really executes" with an agent-written `phase-result-<phase>.json`
(code/integration/deploy), not for review or daemon-synthesized
phases. Phase-1 acceptance ("phase_history has 13 entries (one per
non-intake phase)") fails.

**Fix sketch.** Make `phase_advance` always append to `phase_history`
regardless of whether the phase-result was agent-written or synthesized.

---

### B-16 — low — Missing per-phase prompt files; fallback masks quality

**Symptom.** Daemon log on REQ-000008 startup:

```
{"ts":"2026-05-17T01:29:52Z","msg":"No prompt file for phase 'prd'. Using fallback prompt."}
```

Pipeline progressed on the fallback, so this isn't blocking — but if
every phase is running on a generic fallback prompt, the per-phase
prompt customization that the codebase nominally supports is silently
absent. Likely contributes to the doc-author quality variance we see
in B-17.

**Fix sketch.** Audit per-phase prompt files (likely
`plugins/autonomous-dev/bin/prompts/` or similar); ship missing
per-phase prompt files. Low because the fallback works.

---

## Findings — CLI

These four are all of one family: the CLI's control plane is
disconnected from where the daemon actually keeps state.

### B-15 — HIGH — `request cancel` / `kill` un-runnable from CLI

**Symptom.** Every `autonomous-dev request cancel <REQ>` returns:

```json
{
  "confirmationRequired": true,
  "message": "Are you sure you want to cancel request '<REQ>'? Call again with CONFIRM to proceed."
}
```

— and **there is no way to provide CONFIRM from the CLI.** Same for
`request kill` ("Type CONFIRM to proceed"). No flag (`--confirm`,
`-y`), no positional, no env var satisfies the gate.

**Root cause.** The handlers (`intake/adapters/cli_adapter.js:13698`
for cancel, `:14125` for kill) require `confirmation === "CONFIRM"` as
`args[1]`. The CLI bindings (`:19621` cancel, `:19639` kill) declare
only `<request-id>` as a positional and never push CONFIRM into the
args array — see `buildCommand` at `:19487`, which builds
`args = [requestId]` only. The Slack and Discord adapters correctly
pass `['CONFIRM']` (`slack/main.ts:649`,
`discord_interaction_handler.ts:105`), so the gap is CLI-only.

**Repro.** `autonomous-dev request cancel <REQ-NNNNNN>` against any
queued REQ.

**Workaround during testing.** Edit SQLite directly (blocked by the
harness classifier as a route-around — needs operator) or restart
the daemon, which orphan-reconciles missing-state requests.

**Fix sketch.** Add `--confirm` / `-y` opt to the cancel + kill CLI
bindings; in the action, append `'CONFIRM'` to `args` (or pass via
`flags.confirmation`) when the flag is set. Tests should cover both
verbs with and without the flag.

---

### B-18 — HIGH — SQLite never updated by daemon → CLI control plane stale

**Symptom.** With REQ-000008 actively executing in `plan` phase:

```sh
$ autonomous-dev request status REQ-000008
{
  "requestId": "REQ-000008",
  "status": "queued",
  "currentPhase": "intake",
  "updatedAt": "2026-05-17T01:27:02.837Z"   # = submit time
}
```

— but the per-repo `state.json` has
`{status: "running", current_phase: "plan", ...}` with 5 completed
`phase_advance` events in `events.jsonl`.

Because every CLI verb that gates on SQLite `status` refuses to act
on a "queued" request that isn't really queued:

```sh
$ autonomous-dev request pause REQ-000008
ERROR [INVALID_STATE]: Cannot pause a request in 'queued' state. Allowed actions: cancel, priority.

$ autonomous-dev request resume REQ-000008
ERROR [INVALID_STATE]: Cannot resume a request in 'queued' state. Allowed actions: cancel, priority.

$ autonomous-dev request feedback REQ-000008 "..."
ERROR [INVALID_STATE]: Cannot feedback a request in 'queued' state. Allowed actions: cancel, priority.
```

**Root cause.** The daemon's `state_json_writer` (or `advance_phase`)
writes the per-repo `state.json` and `events.jsonl`, but never issues
a corresponding `UPDATE requests SET status=?, current_phase=?,
updated_at=?` against SQLite. SQLite stays frozen at the row inserted
by `submit` forever. Combined with B-15 (cancel/kill un-runnable even
when SQLite says queued), the CLI cannot meaningfully control any
request once the daemon has picked it up.

**Fix sketches.**
- (Preferred, smallest diff.) The daemon updates SQLite at each phase
  transition with a 2-line `UPDATE`. This keeps `status.allowed_actions`
  logic on the CLI side consistent with reality.
- (Larger refactor.) The CLI verbs read from `state.json` (the
  canonical runtime source) rather than SQLite. This is more invasive
  and forces the CLI to know about per-repo state directories.

---

### B-20 — HIGH — `request priority` flag wiring broken

**Symptom.**

```sh
$ autonomous-dev request priority REQ-000008 high
ERROR [VALIDATION_ERROR]: Missing required argument: priority level (high, normal, low)
```

even though the commander binding (`cli_adapter.js:19630`) declares
two positionals `<request-id> <level>` and the action calls
`dispatch("priority", { priority: level }, requestId)`.

**Root cause.** Same family as B-15. The level value reaches
`buildCommand` as `flags.priority = "high"`, but the underlying
handler expects it in `args[1]`. `buildCommand` only puts the request
ID into `args`. The priority verb is non-functional from CLI.

**Fix sketch.** Either change the CLI dispatcher to push `level` into
`args` (`args = [requestId, level]`), or change the handler to read
`flags.priority`. The first option is consistent with B-15's fix
shape.

---

### B-19 — med — `request logs` returns only intake events

**Symptom.**

```sh
$ autonomous-dev request logs REQ-000008
{
  "requestId": "REQ-000008",
  "entries": [
    {"logId": 6, "event": "request_submitted", "phase": "intake",
     "details": "{...position:2...}",
     "createdAt": "2026-05-17T01:27:02.839Z"}
  ],
  "totalReturned": 1
}
```

After 5 phase advances and 4 agent sessions had completed. Ops can't
use this to debug an in-flight request — the rich data lives in
`<repo>/.autonomous-dev/requests/<REQ>/events.jsonl` and
`session-*.txt`, neither of which `logs` reads.

**Fix sketch.** `logs` should additionally tail `events.jsonl` for
the request and optionally interleave per-session summaries from
`session-*.txt`.

---

## Confirmed working at runtime

Re-validating prior fixes on this E2E run:

- **B-01 / B-05** — portal request-detail route at
  `/repo/<repo>/request/<REQ>` returns 200 for REQ-000008.
- **B-03 / B-10** — `state.json.cost_accrued_usd` = `$3.23121605`,
  exactly matches the sum of all REQ-000008 sessions in the cost
  ledger. No more zero-cost drift.
- **B-06** — `~/.autonomous-dev/request-actions/REQ-000008.json` was
  populated correctly at terminal state
  (`{status:"done", phase:"MONITOR", cost:3.23, completedAt:...}`).
- **B-08** — no agent-driven double-advance observed across all 13
  phase transitions.
- **B-09** — the pipeline reached `monitor` cleanly, so the legacy
  sequence + `resolve_agent` mismatch no longer kills mid-pipeline.
- **B-13** — no extra agent sessions dispatched for REQ-000008 after
  `status: done` (last session at `02:05:07Z`, ledger shows no
  later sessions for the REQ).
- **FR-020-03 / orphan reconciliation** — fired at every daemon boot
  during the test (cancelled REQ-000005, 006 at one boot; REQ-000007
  at the cleanup-restart boot) with the expected
  `Marking orphan SQLite row as cancelled` log line and minimal
  `request-actions/<REQ>.json` write.

---

## Recommended fix order

1. **B-15** — smallest, unblocks any future cancel/kill testing.
2. **B-20** — same shape as B-15 (positional vs flags mismatch);
   batch with B-15 in one PR.
3. **B-18** — one 2-line SQL update at phase transitions; unblocks
   the entire CLI ops surface (pause/resume/feedback start working).
4. **B-22** — most damaging in real-world terms: the pipeline claims
   `done` but ships nothing to master. Fix the integration/deploy
   prompts to commit + merge, or add a dedicated `commit` phase.
5. **B-17 (b)** — make synthesis honor explicit BLOCK verdicts in
   agent text. Even if (a) takes longer to land, fixing (b) alone
   restores reviewer authority and unblocks Phase-4 / Phase-8
   testing.
6. **B-17 (a)** — add `Write` to doc-author + reviewer agent
   frontmatter (or build the write-mediator). Larger change.
7. **B-21** — tighten `phase_history` append in `state_json_writer`.
8. **B-19** — extend `request logs` to include `events.jsonl`.
9. **B-16** — audit + ship per-phase prompt files. Lowest, mostly
   quality-of-life.

---

## Test-handoff lessons (for the next E2E session)

- The CLI cancel-confirmation gap (B-15) means the cleanup
  checklist's `for REQ ... autonomous-dev request cancel "$REQ"`
  step **silently no-ops**. Use `autonomous-dev daemon stop` plus
  a daemon-restart (which triggers orphan-reconcile on
  missing-state requests) as the actual unstick mechanism. Update
  the handoff doc.
- `zsh`'s `nomatch` will kill compound `rm -f a/*.json b/*.json`
  commands if either glob is empty (saw this in cleanup —
  request-actions wasn't cleaned because gate-decisions was
  empty). Either `setopt +o nomatch` or run the two `rm`s as
  separate commands.
- `phase-result-*.json` files all-`synthesized:true` is the canary
  signal of B-17 — if you see it on every phase in a fresh run,
  stop and report rather than burn another $3 letting the pipeline
  loop around.
