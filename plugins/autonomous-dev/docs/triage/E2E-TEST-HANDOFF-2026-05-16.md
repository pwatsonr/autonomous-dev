# Full end-to-end test handoff — 2026-05-16

A self-contained playbook for a future Claude session to run a comprehensive
end-to-end test of the entire autonomous-dev system: the daemon pipeline, the
portal, the autopilot loop, the self-improvement loop, the request CLI, and
all the bug-fix paths that landed in PLAN-039 + PRD-020. Bounded by cost
ceilings and an explicit stop list.

**Use this when:** the operator says "run the full E2E test", "do another big
test", or anything indicating they want the system exercised end-to-end again.

---

## TL;DR

1. Read the **current-state snapshot** below — don't re-discover what's already in place.
2. Run the **test phases** in order. Each phase has explicit acceptance criteria.
3. Log any findings to `docs/triage/PLAN-039-SMOKE-TEST-FINDINGS.md` (the bug log) as you go.
4. Hit the **stop conditions** and clean up per the **cleanup checklist**.
5. Total bounded cost: **~$25–60** depending on how many of the optional phases the operator approves. Estimated time: **~1.5–4 hours** background-wallclock.

---

## Current-state snapshot (2026-05-16, post-cleanup)

| Item | Value |
|---|---|
| Branch | `main` (clean) |
| Latest commits | `d9355c0` (portal-audit follow-up) ← `945221b` ← `4845e43` PR #266 (daemon log cleanup) ← `c707a0c` PR #265 (portal audit) |
| Plugin version | **0.2.0** (in `plugins/autonomous-dev/.claude-plugin/plugin.json` + the marketplace) |
| Live launchd daemon | **running**, `Service: running (macOS/launchd)`, kill-switch disengaged |
| Daemon code path | `~/.claude/plugins/cache/autonomous-dev/autonomous-dev/0.1.0/bin/supervisor-loop.sh` — but the 0.1.0 cache dir **was overwritten with the merged main code** (B-13 filter `done\|cancelled\|failed\|paused` is present). So the live daemon already runs the fixed code; no `install-daemon` re-point is strictly required. (A `0.2.0/` dir also exists but has older code — don't repoint launchd at it.) |
| Allowlist | `["/Users/pwatson/codebase/autonomous-dev", "/Users/pwatson/codebase/autonomous-dev-homelab"]` |
| Test repos on disk | none (all `~/codebase/ad-*` cleaned) |
| `~/.autonomous-dev/request-actions/` | empty |
| `~/.autonomous-dev/gate-decisions/` | empty |
| `.claude/autopilot-state.json` | `status: completed` (safe — won't auto-resume) |
| Cumulative real spend YTD | **~$33.32** (real money spent on prior tests, in `~/.autonomous-dev/cost-ledger.json`) |
| Open PRs | check `gh pr list` — likely 0 unless something landed between sessions |
| Open known-bug | **B-07** (webhook UI add-form — low). **B-14** (autopilot loop fresh-start failure mode — deferred). All other B-01..B-13 are resolved-and-merged. |

### What's already proven (don't redo)
- **Hello-world pipeline:** REQ-000001 walked all 14 phases to `done` on a Python `hello()` function (~$7).
- **Build-out pipeline:** REQ-000003 walked all 14 phases to `done` on a multi-file Python CLI todo app — `todo/cli.py`, `todo/storage.py`, `todo/__main__.py`, `tests/test_cli.py`, all merged to master (~$12.69). Plus `phase_history` + `events.jsonl` + portal action + gate-decisions all working.
- **Both runs surfaced bugs that are now fixed** in PLAN-039 + PRD-020 (B-01..B-13).

### What is *not* yet proven and the E2E test should cover
- The pipeline working **against the live launchd daemon** (not the from-source workaround) — REQ-000007 was queued for this but got cancelled, so this is the headline result the next test should produce.
- A **non-`feature` request type** end-to-end (bug, infra, refactor, hotfix) — these have different `phase_overrides` per the `PHASE_OVERRIDE_MATRIX`.
- The **portal pages** rendering against a real request (request-detail, /approvals, /costs, /ops, /agents, /audit, /design-system, /settings, /repos) — only request-detail was unit-tested.
- The **gate-approval flow** — every prior run let the daemon advance through `gate` states automatically because the reviewer agents returned `pass`. We've never tested a *human* approving/rejecting a gate via the portal.
- The **autopilot loop** (`/universal-dev:autopilot "<direction>"`) — B-14 means the fresh-start mode failed once; needs a proper retry from the entry-point skill, not `autopilot-resume`.
- The **self-improvement loop** (`/autonomous-dev:observe`) — never exercised; needs accumulated metrics from prior agent runs (now we have ~$33 worth, so there's data).
- The **request CLI verbs** beyond `submit`: `status`, `list`, `cancel`, `pause`, `resume`, `feedback`, `priority`, `logs`, `kill`, and bug-submit.
- The **failure paths**: a phase that fails and retries up to `MAX_RETRIES_PER_PHASE` then terminal-`failed`; a phase that times out (no wall-clock cap on macOS sans coreutils — would need `coreutils` or a contrived in-prompt sleep); the `WALL_CLOCK_TIMEOUT` synthesized result; the missing-phase-result synthesis.
- The **webhook UI** (FR-020-08) — the form persistence now works server-side, but no one's exercised it through a real browser.

---

## Prerequisites (do these before starting)

1. **Confirm the launchd daemon is healthy:** `autonomous-dev daemon status` shows `Service: running`. If not: `autonomous-dev daemon start`.
2. **Confirm the daemon code path has the B-13 fix:** `grep -c 'done|cancelled|failed|paused' ~/.claude/plugins/cache/autonomous-dev/autonomous-dev/0.1.0/bin/supervisor-loop.sh` should be **≥ 1**. If 0, the operator must do the `/plugin` resync in `claude` and then `autonomous-dev install-daemon && autonomous-dev daemon stop && start`. **Do NOT skip this check** — if the cache is stale, the test will run the old broken code and produce nonsense.
3. **Confirm `node` and `bun` are on PATH:** `which node bun`. The intake CLI needs `node` to actually execute (`bun` to build).
4. **Confirm `~/.autonomous-dev/intake-auth.yaml` exists:** if not, the submit CLI errors.
5. **Confirm working tree is clean:** `git status -s` returns nothing. If the operator has WIP, leave it alone — but flag it.
6. **Establish a cost budget** — confirm with the operator before starting if it's > $25.

---

## Test plan

Each phase has: **Goal**, **Steps**, **Acceptance**, **Cost estimate**, **Time estimate**. Run them **in the order listed** unless the operator skips one. Always log unexpected findings to `docs/triage/PLAN-039-SMOKE-TEST-FINDINGS.md` as **B-1N** entries.

### Phase 0 — Setup (no cost)

**Goal:** clean test repo for the daemon-pipeline tests.

**Steps:**
```bash
TEST=~/codebase/ad-e2e-test
rm -rf "$TEST"
mkdir -p "$TEST"
git -C "$TEST" init -q
git -C "$TEST" config user.email t@x.com
git -C "$TEST" config user.name "E2E Test"
echo "# todo (e2e-test)" > "$TEST/README.md"
echo "__pycache__/
.pytest_cache/" > "$TEST/.gitignore"
git -C "$TEST" add -A
git -C "$TEST" commit -q -m init

# allowlist
cp ~/.claude/autonomous-dev.json /tmp/autonomous-dev.json.bak.e2e
jq --arg r "$TEST" '.repositories.allowlist += [$r]' ~/.claude/autonomous-dev.json > /tmp/cfg.e2e.json && mv /tmp/cfg.e2e.json ~/.claude/autonomous-dev.json
autonomous-dev config validate
```

**Acceptance:** `config validate` says `PASS`, the test repo is on the allowlist, daemon is still running.

---

### Phase 1 — Daemon pipeline, `feature` request, live daemon (~$10–15, ~25–30 min)

**Goal:** prove the live launchd daemon walks a `feature` request all 14 phases to `done` against a real repo, with no manual intervention. This is the headline test the prior session set up but never completed.

**Steps:**
```bash
TEST=~/codebase/ad-e2e-test
autonomous-dev request submit "Add a tiny Python CLI todo app. 'todo add \"<text>\"' appends a task and 'todo list' prints all tasks numbered (1, 2, ...). Persist to ~/.todo.json (create if missing). 'todo --help'. pytest tests for add (single + multiple), list (empty + populated), persistence (survives a fresh process). Stdlib only (plus pytest)." --repo "$TEST" --type feature
# note the REQ-id
```
Then **wait, don't poll aggressively.** Check every 5–10 minutes:
```bash
REQ=REQ-NNNNNN   # the id submit printed
jq -c '{id,status,phase:.current_phase,esc:.escalation_count,cost:.cost_accrued_usd}' "$TEST/.autonomous-dev/requests/$REQ/state.json"
```

**Acceptance (all must hold):**
- ✓ `status` reaches `done`, `phase` reaches `monitor`, `escalation_count == 0`, `error == null`.
- ✓ `phase_history` in the state.json has 13 entries (one per non-`intake` phase).
- ✓ `events.jsonl` has clean single-step `phase_advance` for every transition (no skips — proves B-08 is fixed at runtime, not just in tests).
- ✓ After `done`, the daemon does NOT keep dispatching the `monitor` agent — confirm by checking that no new sessions appear in `cost-ledger.json` for this REQ after `status: done` (proves B-13 is fixed at runtime).
- ✓ `cost_accrued_usd` is non-zero and matches the sum of sessions in `cost-ledger.json` for this REQ (B-03 / B-10).
- ✓ `~/.autonomous-dev/request-actions/<REQ>.json` exists and reflects the terminal state (B-06's portal-write side).
- ✓ The test repo has real artifacts: `docs/prd/<slug>.md`, `docs/tdd/<slug>.md`, `docs/plans/<slug>.md`, `docs/specs/<slug>.md` (FR-020-07), `todo/*.py`, `tests/*.py`, and a merge commit on `master` integrating `autonomous/<REQ>`.

**If anything fails:** log it as a new B-1N finding in the bug doc with the exact state.json + relevant `daemon.log` excerpt. Don't try to fix mid-test.

---

### Phase 2 — Portal verification (~$0, ~10 min)

**Goal:** the operator (or a Claude-in-Chrome session if MCP is available) clicks through the portal and confirms every page renders against the real REQ from Phase 1.

**Steps (operator action — give them the URL list):**
- Open `http://127.0.0.1:19280/`
- Visit each page and screenshot or note any issue:
  - `/` (Dashboard) — KPI strip; "Awaiting approval: 0" (Phase 1's REQ is done by now); recent activity should show the REQ.
  - `/requests` — REQ from Phase 1 is in the list; clicking it opens `/repo/ad-e2e-test/request/REQ-NNNNNN` (B-01/B-05 → FR-020-04). The detail page renders the real PRD/TDD/Plan/Spec content from the artifact files (FR-020-07).
  - `/approvals` — should be empty (Phase 1 had no human-gated approvals; reviewers auto-passed). If it has zombies from prior tests, that's a finding.
  - `/costs` — MTD spend matches the cost-ledger total; per-request costs match `state.json.cost_accrued_usd`.
  - `/ops` — daemon status pill green, kill-switch button works (test arm + reset).
  - `/agents` — lists every agent file; per-agent metrics if any.
  - `/audit` — audit log has entries from Phase 1.
  - `/design-system` — visual smoke (no broken styles).
  - `/settings` — Notifications tab: Discord/Slack webhook fields persist on save (B-07 / FR-020-08). Allowlist tab: add a junk path, then remove it. Costs/trust/repos tabs render.
  - `/repos` — lists allowlisted repos with MTD spend each.

**Acceptance:** no 404s, no 500s, no console errors that look related to autonomous-dev. Webhook fields persist a round-trip. Any visual/UX issue → bug doc.

---

### Phase 3 — `bug` request type, type-specific phase sequence (~$5–8, ~15–20 min)

**Goal:** prove `phase_overrides[]` from `PHASE_OVERRIDE_MATRIX` correctly skips phases for non-`feature` types. `bug` should skip `prd` and `prd_review` (the matrix's `bug.skippedPhases`).

**Steps:**
```bash
TEST=~/codebase/ad-e2e-test
autonomous-dev request submit "Fix a small bug: the 'todo list' output incorrectly numbers tasks starting at 0 instead of 1. Update the printer and the tests to match." --repo "$TEST" --type bug
```

**Acceptance:**
- ✓ Reaches `done`.
- ✓ `events.jsonl` for this REQ has **no** `phase_advance` entries with `from: prd` or `from: prd_review` — those phases were skipped (the request went `intake → tdd → tdd_review → plan → ...`).
- ✓ `state.json.phase_overrides[]` does NOT contain `prd` or `prd_review`.
- ✓ The fix actually exists in the test repo (`master` got another merge commit, the `print` line was edited).
- ✓ Cost is **lower** than Phase 1 (fewer phases × ~$0.5–1 each).

**If the daemon ran `prd` for a `bug` request:** B-1N finding — `state_json_writer` isn't reading `PHASE_OVERRIDE_MATRIX` correctly for `bug`.

---

### Phase 4 — Approval-gate flow with a human approval (~$5–8, ~20–30 min)

**Goal:** test the gate-approval surface end-to-end: a request enters `gate` status, the operator approves it via the portal, the daemon picks up the decision and advances.

**Prereq:** trust level config. Check `~/.claude/autonomous-dev.json` `trust.system_default_level` — at L0/L1 the daemon should pause at gates and wait for human input. If trust is high enough to auto-pass, this phase is moot. Bump trust DOWN to L1 if needed:
```bash
jq '.trust = {"system_default_level": "L1"}' ~/.claude/autonomous-dev.json > /tmp/t.json && mv /tmp/t.json ~/.claude/autonomous-dev.json
autonomous-dev config validate
```

**Steps:**
```bash
autonomous-dev request submit "Add a 'todo done <n>' command that marks task n complete. Tests for marking done, bad-index error, idempotent re-done." --repo "$TEST" --type feature
# wait for it to reach `prd_review/gate`
```

Then operator: open the portal `/approvals` page, find the request, click "Approve" (or "Request Changes" for the alternate path). Repeat for each gate the daemon parks at. The daemon should pick up each decision within one poll (30s) and continue.

**Acceptance:**
- ✓ The daemon stops at each `*_review` phase (status `gate`).
- ✓ `gate-decisions/ad-e2e-test__<REQ>.json` is written with `state: pending` while at the gate (B-06).
- ✓ Operator's approval flips `state: approved` (verify `cat ~/.autonomous-dev/gate-decisions/...`) — confirms the portal's POST handler writes through.
- ✓ Daemon proceeds within one poll interval.
- ✓ `waitedMin` in the gate-decisions file is non-zero during the wait (the `phase_history[].gate_entered_at` math).
- ✓ Reaches `done` after all gates approved.

If you don't want to do this phase, set trust back to high and skip — note in the doc.

---

### Phase 5 — Request CLI surface (~$0, ~10 min)

**Goal:** every `autonomous-dev request <verb>` works.

**Steps (against the REQ from Phase 4, or a fresh small REQ):**
```bash
autonomous-dev request list                                       # active only (default)
autonomous-dev request list --state done                          # filter
autonomous-dev request status REQ-NNNNNN                          # current state
autonomous-dev request logs REQ-NNNNNN | head -20                 # tail logs
autonomous-dev request priority REQ-NNNNNN high                   # bump priority
autonomous-dev request feedback REQ-NNNNNN "extra clarification"  # add a note
# only test pause/resume on a real in-flight REQ — submit a tiny feature first:
autonomous-dev request submit "no-op for pause test" --repo "$TEST" --type feature
autonomous-dev request pause REQ-NNNNNN
sleep 60   # confirm daemon doesn't process it
autonomous-dev request resume REQ-NNNNNN
# eventually:
autonomous-dev request cancel REQ-NNNNNN                          # cancel
```

Also test bug-submit (`autonomous-dev:submit-bug` skill):
```
/autonomous-dev:submit-bug
```
The skill should collect a `BugReport`'s fields interactively and submit a `--type bug` request.

**Acceptance:**
- ✓ Each verb completes with exit 0 and a sensible JSON/text output.
- ✓ `pause` → daemon stops polling that REQ; `resume` → it picks back up.
- ✓ `cancel` flips the state to `cancelled`, after which the daemon ignores it (regression for B-13: confirm no extra sessions).
- ✓ `priority` bump is reflected in `state.json.priority` and changes ordering on next `select_request`.

---

### Phase 6 — Autopilot loop (entry point, NOT autopilot-resume) (~$30–50, ~30–60 min)

**Goal:** prove the autopilot generates a PRD → TDD → Plan → Spec → code PR for *one* feature from a product direction, *without* the silent-failure mode of B-14.

**IMPORTANT — what NOT to do:** do NOT pre-init `.claude/autopilot-state.json` and call `autopilot-resume` against a `current_phase: prd, iteration: 0` state. That was the B-14 failure mode — `autopilot-resume` expects to *continue* an in-progress run.

**Right way (fresh run):**
```bash
AP_REPO=~/codebase/ad-e2e-autopilot
rm -rf "$AP_REPO"; mkdir -p "$AP_REPO"; git -C "$AP_REPO" init -q
git -C "$AP_REPO" config user.email a@x.com; git -C "$AP_REPO" config user.name "AP Test"
echo "# autopilot target" > "$AP_REPO/README.md"
git -C "$AP_REPO" add -A; git -C "$AP_REPO" commit -q -m init

# Run the entry point — IN-SESSION (claude --print), bounded to 1 iteration
cd "$AP_REPO"
claude -p '/universal-dev:autopilot "Build a tiny Python CLI calculator: add/sub/mul/div subcommands, --help, pytest tests." --max-iterations 1' \
  --permission-mode bypassPermissions \
  --max-budget-usd 50 \
  > "$AP_REPO/.claude/autopilot-run.log" 2>&1
cd /Users/pwatson/codebase/autonomous-dev
```

Or — invoke via `autopilot-loop.sh` AFTER the initial `autopilot` skill has set up state:
```bash
# step A: bootstrap via the entry point (writes the state file properly)
cd "$AP_REPO"
claude -p '/universal-dev:autopilot "<direction>" --max-iterations 1' --max-budget-usd 50
# step B: if it pauses at a gate or returns mid-run, drive the rest with the loop
bash ~/.claude/plugins/cache/pwatson-homelab/universal-dev/1.0.0/scripts/autopilot-loop.sh
```

**Acceptance:**
- ✓ `~/codebase/ad-e2e-autopilot/.claude/autopilot-state.json` exists and is populated (iteration ≥ 1).
- ✓ `docs/prd/*.md` exists in the autopilot repo (auto-generated PRD).
- ✓ A code PR opened (or merge commit if no remote, like the daemon does).
- ✓ Final state `status: completed` (not `paused` / not deleted — that was B-14).

**If it fails silently (B-14 repro):** capture stderr + the `.claude/` dir state before the failure, file B-1N. The investigation: `autopilot-resume` may be the wrong entry for fresh runs; or the `autopilot` skill itself has a bug; check `~/.claude/plugins/cache/pwatson-homelab/universal-dev/1.0.0/skills/autopilot.md`.

---

### Phase 7 — Self-improvement loop (~$3–5, ~10–15 min)

**Goal:** exercise the agent self-improvement / production-intelligence loop on the accumulated agent-run metrics from prior tests.

**Steps:**
```bash
/autonomous-dev:observe
```
or via CLI if the skill expects it:
```bash
autonomous-dev observe --scope all
```

The skill should: read accumulated agent-run metrics from `~/.autonomous-dev/metrics/` (or equivalent), identify a weak agent (if any), optionally propose a modification, and surface a report. If trust is L1, modifications wait for human approval.

**Acceptance:**
- ✓ The skill runs without error.
- ✓ Produces an observation report (somewhere — likely a `~/.autonomous-dev/observations/<id>.json` or a portal entry).
- ✓ Either: identifies a weak agent and suggests a tweak (great signal), OR cleanly reports "no actionable findings" (also fine — means agents are performing OK on the limited data).

**If the skill 404s or errors:** B-1N. The metrics infrastructure might not be fully wired (it was always a stretch goal — `performance-analyst` agent exists, but the end-to-end observe loop may be in earlier stages of completeness).

---

### Phase 8 — Failure paths (~$5–10, ~20 min)

**Goal:** confirm the daemon handles agent failure + retry-exhaustion + the `failed` terminal state correctly (B-08 + PRD-020 FR-020-01).

**Setup (force a failure):** submit a request with an intentionally absurd direction that an agent will reasonably fail / write `phase-result-X.json` with `status: fail`:
```bash
autonomous-dev request submit "Implement a working time machine in Python that lets us travel to the past. Include pytest tests proving time travel works." --repo "$TEST" --type feature
```
(Yes, this is silly — the point is to see review agents legitimately reject the PRD and force the retry-exhaustion path.)

**Acceptance:**
- ✓ A reviewer (`doc-reviewer`) returns `status: fail` in its `phase-result-*.json`.
- ✓ The daemon increments `escalation_count`, retries the author phase.
- ✓ After `MAX_RETRIES_PER_PHASE` (3) failures, state goes to `status: failed, error: MAX_RETRIES_EXCEEDED` (PRD-020-31).
- ✓ Daemon STOPS dispatching after `failed` (B-13).
- ✓ `events.jsonl` has the `failed` event.

---

### Phase 9 — Reconciliation (~$0, ~5 min)

**Goal:** verify the orphan-SQLite-row reconciliation FR-020-03.

**Setup:** delete a state.json file for an in-flight request behind the daemon's back.
```bash
# Pick one of the requests still in SQLite. Easier: just delete a completed REQ's state.json.
rm ~/codebase/ad-e2e-test/.autonomous-dev/requests/REQ-NNNNNN/state.json
# then wait for the next reconciliation pass (runs every N polls per supervisor-loop.sh)
```

**Acceptance:**
- ✓ The daemon detects the missing state.json, logs `Marking orphan SQLite row as cancelled: REQ-NNNNNN`, writes a minimal `cancelled` request-action to `~/.autonomous-dev/request-actions/REQ-NNNNNN.json`.
- ✓ The portal `/requests` page shows it as `cancelled`.

---

## Stop conditions (HARD)

Stop immediately and report to the operator if any of these:
- Cumulative spend in `cost-ledger.json` exceeds the operator's stated budget.
- More than 2 phases fail acceptance — something fundamental is broken; don't keep burning money.
- `daemon.log` shows `circuit_breaker_tripped: true` — daemon halted itself.
- Any phase runs >2× its estimated time (probable hang).
- A real GitHub PR was opened on a real repo (`autonomous-dev` or `autonomous-dev-homelab`) by accident — the daemon should only touch allowlisted test repos.

## Soft stops (report, but it's OK to continue)
- A B-1N finding logged.
- A phase skipped per operator request.

---

## Bug-logging convention

Append findings to `plugins/autonomous-dev/docs/triage/PLAN-039-SMOKE-TEST-FINDINGS.md`. Format:
```markdown
| B-1N | low|med|high | daemon|portal|autopilot|cli | <one-line symptom> | <what to check / where to fix> |
```
Include enough context that a future session can reproduce: the REQ-id, the daemon-log timestamps, the state.json snapshot if relevant. Don't try to fix mid-test — log it and move on. After the test, the operator decides which to prioritize.

---

## Cleanup checklist

When the test is done (whether all phases passed, you hit a stop condition, or the operator says stop):

```bash
# 1. Stop the launchd daemon (avoid races during cleanup)
autonomous-dev daemon stop

# 2. Cancel any in-flight requests
for REQ in $(jq -r '.repositories.allowlist[]' ~/.claude/autonomous-dev.json | \
              xargs -I{} sh -c 'ls -d {}/.autonomous-dev/requests/*/ 2>/dev/null' | \
              xargs -I{} jq -r '.id' {}/state.json 2>/dev/null); do
  [ -n "$REQ" ] && autonomous-dev request cancel "$REQ" 2>/dev/null || true
done

# 3. Kill any stray daemon / autopilot processes
pkill -f supervisor-loop.sh 2>/dev/null
pkill -f autopilot-loop 2>/dev/null
pkill -f autopilot-resume 2>/dev/null

# 4. Remove test repos
rm -rf ~/codebase/ad-e2e-test ~/codebase/ad-e2e-autopilot

# 5. Restore allowlist (the backup is at /tmp/autonomous-dev.json.bak.e2e from Phase 0)
cp /tmp/autonomous-dev.json.bak.e2e ~/.claude/autonomous-dev.json
autonomous-dev config validate

# 6. Clear portal artifacts
rm -f ~/.autonomous-dev/request-actions/*.json ~/.autonomous-dev/gate-decisions/*.json

# 7. Reset autopilot state (so /universal-dev:autopilot-resume can't auto-restart)
jq '.status = "completed" | .notes = "Reset after E2E test <date>."' .claude/autopilot-state.json > /tmp/aps.json && mv /tmp/aps.json .claude/autopilot-state.json

# 8. Optionally — restore trust level if you bumped it in Phase 4
# (manual; check what value was there before)

# 9. Remove any stale lock
rm -f ~/.autonomous-dev/daemon.lock

# 10. Restart the launchd daemon (back to normal)
autonomous-dev daemon start
autonomous-dev daemon status   # confirm "Service: running"

# 11. Final state check (everything should be clean)
echo "test repos: $(ls -d ~/codebase/ad-* 2>/dev/null || echo none)"
echo "request-actions: $(ls ~/.autonomous-dev/request-actions/ 2>/dev/null | wc -l | tr -d ' ')"
echo "gate-decisions:  $(ls ~/.autonomous-dev/gate-decisions/ 2>/dev/null | wc -l | tr -d ' ')"
echo "branch:          $(git branch --show-current)"
echo "dirty?:          $(git status --short | wc -l | tr -d ' ') file(s)"
echo "cost added:      $(...)"
```

(Note: cost-ledger is real spend; don't wipe it unless the operator says to.)

---

## Reference / cheatsheet

### Key paths
- Daemon code (live): `~/.claude/plugins/cache/autonomous-dev/autonomous-dev/0.1.0/bin/supervisor-loop.sh`
- Daemon code (source on main): `~/codebase/autonomous-dev/plugins/autonomous-dev/bin/supervisor-loop.sh`
- Daemon log: `~/.autonomous-dev/logs/daemon.log` (JSONL — use `jq -c` to query)
- Daemon config: `~/.claude/autonomous-dev.json`
- Intake auth: `~/.autonomous-dev/intake-auth.yaml`
- Intake DB: `~/.autonomous-dev/intake.db` (SQLite)
- Cost ledger: `~/.autonomous-dev/cost-ledger.json`
- Portal data dir: `${AUTONOMOUS_DEV_STATE_DIR:-~/.autonomous-dev}/request-actions/` + `gate-decisions/`
- Per-request state: `<repo>/.autonomous-dev/requests/<REQ-id>/state.json`
- Per-request artifacts (post-FR-020-07): `<repo>/docs/prd|tdd|plans|specs/<slug>.md`
- Bug log: `plugins/autonomous-dev/docs/triage/PLAN-039-SMOKE-TEST-FINDINGS.md`
- Autopilot state: `.claude/autopilot-state.json`
- Autopilot loop: `~/.claude/plugins/cache/pwatson-homelab/universal-dev/1.0.0/scripts/autopilot-loop.sh`

### Useful one-liners
- Watch a request progress: `watch -n 5 'jq -c "{id,status,phase:.current_phase,esc:.escalation_count,cost:.cost_accrued_usd}" <repo>/.autonomous-dev/requests/<REQ>/state.json'`
- Tail daemon log for a REQ: `tail -f ~/.autonomous-dev/logs/daemon.log | jq -c 'select(.message | test("REQ-NNNNNN")) | {ts:.timestamp,iter:.iteration,msg:.message}'`
- See all phase_advance events: `jq -c 'select(.event=="phase_advance") | {from,to,ts:.timestamp}' <repo>/.autonomous-dev/requests/<REQ>/events.jsonl`
- Per-REQ cost rollup: `jq --arg req <REQ> '.daily | to_entries | map(.value.sessions[]) | map(select(.request_id == $req)) | map(.cost_usd) | add' ~/.autonomous-dev/cost-ledger.json`
- Portal: `http://127.0.0.1:19280`

### Known caveats
- `timeout` / `setsid` / `gtimeout` are not on this macOS by default — daemon falls back to no wall-clock cap (already handled). If a hung agent matters, `brew install coreutils` adds them.
- The `0.2.0` cache dir exists alongside `0.1.0` but has older code; do NOT `install-daemon` re-point at `0.2.0` until that's investigated.
- Plugin version is `0.2.0` in source but `0.1.0` in the cache path. Don't conflate.
- The portal serves on `127.0.0.1:19280` — pre-existing 27 portal `bun test tests/unit/` failures are unrelated to anything you'll see.

### Estimated full E2E run cost
| Phase | Cost | Time |
|---|---|---|
| 0. Setup | $0 | 2 min |
| 1. Daemon `feature` E2E | $10–15 | 25–30 min |
| 2. Portal smoke | $0 | 10 min (operator) |
| 3. `bug`-type pipeline | $5–8 | 15–20 min |
| 4. Gate approval flow | $5–8 | 20–30 min |
| 5. CLI verbs | $0 (existing REQs) | 10 min |
| 6. Autopilot loop | $30–50 | 30–60 min |
| 7. Self-improvement | $3–5 | 10–15 min |
| 8. Failure paths | $5–10 | 20 min |
| 9. Reconciliation | $0 | 5 min |
| **Total** | **$58–96** | **~2.5–3.5 h** |

If the budget is tight: phases 1, 2, 3, 5, 9 are the high-value-low-cost core (~$15–23). Phases 4, 6, 7, 8 are stretch goals.

---

## Opening prompt for the next session (paste verbatim)

> Run the full E2E test from `plugins/autonomous-dev/docs/triage/E2E-TEST-HANDOFF-2026-05-16.md`. Read the current-state snapshot first; if anything's drifted (new commits, allowlist changed, daemon stopped, leftover test repos), reconcile before starting. Run phases in order; log findings to `PLAN-039-SMOKE-TEST-FINDINGS.md` as you go. Stop on the hard-stop conditions. Cost budget: confirm with me before starting if you'd run more than $25. After: clean up per the checklist and report what passed, what failed, and any new B-1N entries.
