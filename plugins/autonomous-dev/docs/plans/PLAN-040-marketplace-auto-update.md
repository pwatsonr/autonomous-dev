# PLAN-040: Marketplace-driven Daemon Self-Upgrade — Task Decomposition

| Field | Value |
|-------|-------|
| **PLAN ID** | PLAN-040 |
| **Parent PRD** | PRD-022 |
| **Parent TDD** | TDD-039 |
| **Date** | 2026-05-17 |
| **Status** | Retroactive — all tasks shipped in PRs #300, #301, #302 |

> Companion to PRD-022 and TDD-039. This Plan is the task-level record of what was built, in what order, with which dependencies. Useful for understanding the slicing decisions and for spotting where to extend the mechanism in the future.

---

## Slicing strategy

Three phases, each its own PR, deliberately ordered low-risk-to-high-risk:

1. **Phase 1 — Detect & log only.** No state mutation, no upgrade action. Goal: make the signal visible in `/logs` before any auto-restart is wired. Operator can manually inspect cached versions for a release cycle to build confidence in the discovery logic.
2. **Phase 2 — Stage upgrade on idle.** Adds the actual restart, but guarded by three independent gates (active request, throttle, installer presence). Goal: confidence that we won't bounce mid-phase or in a tight loop.
3. **Phase 3 — Rollback.** Adds the safety net: if a new version doesn't settle within its trial deadline, the next startup of that version rolls back to `.last-good-version`. Goal: confidence that a bad release can't permanently brick the daemon.

Each phase is independently revertable. Phase 1 logs but doesn't act, so it can sit in production safely on its own. Phase 2 needs Phase 1 (uses `check_upgrade_available` as its detector). Phase 3 needs Phase 2 (uses `.last-good-version` and `.upgrade-trial-pending` files written by stage_upgrade).

---

## Tasks

### Phase 1 (PR #300)

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-040-01 | Create `bin/lib/version-helpers.sh` with `current_version`, `latest_cached_version`, `compare_semver` | Claude | Done | 0.3 | Pure functions, always return exit 0 (callers check string content) |
| T-040-02 | Add `check_upgrade_available()` to `supervisor-loop.sh` with once-per-version log de-dup | Claude | Done | 0.2 | Reads from `LIB_DIR/version-helpers.sh`; uses `LAST_UPGRADE_LOGGED_VERSION` global |
| T-040-03 | Wire `check_upgrade_available` into the main loop on `% UPGRADE_CHECK_EVERY_N_POLLS == 1` cadence | Claude | Done | 0.1 | Default 60 iterations |
| T-040-04 | Add `UPGRADE_CHECK_EVERY_N_POLLS` + `LAST_UPGRADE_LOGGED_VERSION` globals | Claude | Done | 0.05 | Env-overridable |
| T-040-05 | Write `tests/bats/version_helpers.bats` (12 cases covering all three helpers) | Claude | Done | 0.4 | Includes edge cases: 0.10 vs 0.9 ordering, incomplete extractions, empty cache |

### Phase 2 (PR #301)

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-040-06 | Add `UPGRADE_THROTTLE_FILE`, `UPGRADE_THROTTLE_SECONDS`, `LAST_GOOD_VERSION_FILE` globals | Claude | Done | 0.05 | Env-overridable |
| T-040-07 | Add `upgrade_throttled()` reading mtime with `stat -f %m` (macOS) / `-c %Y` (Linux) fallback | Claude | Done | 0.2 | Cross-platform date math |
| T-040-08 | Add `stage_upgrade(from, to)` with three gates: active_request, throttle, installer-presence | Claude | Done | 0.5 | Bails early on each guard; writes `.last-good-version` + touches throttle before handoff |
| T-040-09 | Spawn detached `nohup install-daemon.sh --force` with `disown`, set `SHUTDOWN_REQUESTED=true` | Claude | Done | 0.2 | 2s sleep buys us a clean exit window |
| T-040-10 | Extend `check_upgrade_available` to call `stage_upgrade` after logging | Claude | Done | 0.1 | `stage_upgrade` is the gatekeeper; safe to call every detector tick |
| T-040-11 | Write `tests/bats/stage_upgrade.bats` (7 cases: throttle file lifecycle, three gates) | Claude | Done | 0.5 | Function extraction from supervisor-loop via `awk` so we can test in isolation |

### Phase 3 (PR #302)

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-040-12 | Add `UPGRADE_TRIAL_FLAG`, `UPGRADE_TRIAL_DEADLINE_SECONDS`, `UPGRADE_TRIAL_PROBATION_ITERATIONS`, `UPGRADE_TRIAL_PENDING` globals | Claude | Done | 0.05 | Env-overridable |
| T-040-13 | Extend `stage_upgrade` to write `.upgrade-trial-pending` JSON `{target, from, started, deadline}` | Claude | Done | 0.1 | Trial flag written AFTER `.last-good-version` so the breadcrumb exists even if stage_upgrade gets killed mid-write |
| T-040-14 | Add `check_upgrade_trial()` for startup: no-op / probation / rollback decision tree | Claude | Done | 0.4 | Three outcomes per TDD §3; rollback case spawns detached installer for `.last-good-version` |
| T-040-15 | Add `clear_upgrade_trial_if_probation_passed()` for main loop | Claude | Done | 0.1 | Fires when iteration_count ≥ UPGRADE_TRIAL_PROBATION_ITERATIONS |
| T-040-16 | Wire `check_upgrade_trial` into startup (before main_loop) | Claude | Done | 0.05 | Before existing crash-state load |
| T-040-17 | Wire `clear_upgrade_trial_if_probation_passed` into main loop (after `check_upgrade_available`) | Claude | Done | 0.05 | Cheap per-iteration check |
| T-040-18 | Write `tests/bats/upgrade_trial.bats` (7 cases: no-flag/future/wrong-target/probation-clear edges) | Claude | Done | 0.5 | Function extraction + `current_version` stub via shadowed function |

### Documentation (this PR)

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-040-19 | Write PRD-022 retroactively | Claude | Done | 0.3 | This file's parent |
| T-040-20 | Write TDD-039 retroactively | Claude | Done | 0.3 | Architecture record |
| T-040-21 | Write PLAN-040 retroactively (this file) | Claude | Done | 0.2 | — |

**Total: ~4.2 hours of implementation work captured across 3 PRs and 26 bats tests, plus ~0.8 hours of retroactive documentation.**

---

## Follow-ups (out of scope)

These are ideas surfaced during the design conversation but not built:

| ID | Idea | Why deferred |
|----|------|--------------|
| F-040-01 | Portal banner showing "upgrade available" and rollback events | UX work; not blocking the mechanism |
| F-040-02 | Version pin file (`~/.autonomous-dev/.version-pin`) for operators who want to hold an older version | No demand today; design space not blocked |
| F-040-03 | Multi-step rollback (if `.last-good-version` is itself bad, dig further) | Today's mechanism stops after one hop; releases are bumped one at a time, so this is unlikely to matter |
| F-040-04 | Self-upgrade for the portal Bun process | Different lifecycle (no launchd job); separate design |
| F-040-05 | Telemetry: emit upgrade events to a counter the operator can query | Today the operator reads `/logs`; metric surface is a follow-up |

---

## References

- **PR #300** — Phase 1 implementation (detect & log)
- **PR #301** — Phase 2 implementation (stage_upgrade on idle)
- **PR #302** — Phase 3 implementation (trial-flag rollback)
- **PRD-022** — product requirements
- **TDD-039** — technical design
