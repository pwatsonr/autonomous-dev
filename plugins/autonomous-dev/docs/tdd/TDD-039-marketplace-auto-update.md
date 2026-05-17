# TDD-039: Marketplace-driven Daemon Self-Upgrade

| Field | Value |
|-------|-------|
| **TDD ID** | TDD-039 |
| **Parent PRD** | PRD-022 |
| **Date** | 2026-05-17 |
| **Status** | Retroactive — implementation shipped in PRs #300, #301, #302 |

> Companion to PRD-022. This TDD captures the architecture decisions made during the design conversation on 2026-05-17, preserved here so future maintainers can see *why* the mechanism is shaped the way it is.

---

## 1. Architecture Overview

The mechanism is split into three orthogonal concerns, each shipped in its own PR:

```
┌──────────────────────────────────────────────────────────────┐
│ Phase 1 (PR #300): detect & log                              │
│                                                              │
│   bin/lib/version-helpers.sh                                 │
│      current_version(script_path)                            │
│      latest_cached_version(cache_dir)                        │
│      compare_semver(a, b)                                    │
│                                                              │
│   supervisor-loop.sh                                         │
│      check_upgrade_available()  ← logs daemon_upgrade_       │
│        called once per UPGRADE_CHECK_EVERY_N_POLLS           │
│        no state mutation, no upgrade action                  │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ Phase 2 (PR #301): stage_upgrade on idle                     │
│                                                              │
│   check_upgrade_available() additionally calls               │
│      stage_upgrade(from, to)                                 │
│                                                              │
│   stage_upgrade gates:                                       │
│      ╴ active_request_id?  → bail                            │
│      ╴ upgrade_throttled?  → bail                            │
│      ╴ installer present?  → bail if not                     │
│                                                              │
│   stage_upgrade actions (in order):                          │
│      1. write .last-good-version = from                      │
│      2. touch .upgrade-throttle                              │
│      3. spawn detached install-daemon.sh --force             │
│      4. SHUTDOWN_REQUESTED = true                            │
│      5. main loop exits, daemon process ends                 │
│      6. plist KeepAlive.SuccessfulExit=false → no respawn    │
│      7. detached helper completes; launchd brings up new     │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ Phase 3 (PR #302): trial-flag rollback                       │
│                                                              │
│   stage_upgrade also writes:                                 │
│      .upgrade-trial-pending = {target, from, started,        │
│                                deadline = now + 180s}        │
│                                                              │
│   new daemon's startup path adds:                            │
│      check_upgrade_trial()                                   │
│        ╴ flag.target != my_version  → no-op                  │
│        ╴ now <= deadline            → probation              │
│        ╴ now > deadline             → roll back              │
│                                                              │
│   new daemon's main loop adds:                               │
│      clear_upgrade_trial_if_probation_passed()               │
│        ╴ pending && iteration_count ≥ 5 → clear flag         │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Why Bash, not a separate process

Considered: write the upgrader as a separate Go binary or Node service. **Rejected** because:
- Single-file change keeps the supervisor self-contained
- No new install-time dependency (Go/Node toolchain on operator's machine)
- The shell-out-to-`install-daemon.sh` pattern already exists; we're reusing it
- Locks against drift: if the daemon is on shell, the upgrader has to be on shell too

---

## 3. Why detached helper + clean exit, not in-process restart

The daemon **cannot** `launchctl bootout` itself and then `bootstrap` — `bootout` kills the calling process (us) before `bootstrap` runs. So we need the work to happen *after* we exit.

Two patterns considered:

**A. exec into install-daemon.sh.** Rejected: install-daemon's last step is `launchctl bootstrap`, which spawns a new daemon process. If we exec into install-daemon and that exits, launchd sees a clean exit of the original ProgramArguments and doesn't respawn (per `KeepAlive.SuccessfulExit: false`).

**B. nohup + disown the installer, then exit.** ✓ Adopted. The detached helper:
- Sleeps 2s so we have time to exit cleanly
- Calls `install-daemon.sh --force` which bootouts (kills any remaining old daemon) and bootstraps the new one
- Inherits its own stdout/stderr to `${LOG_DIR}/upgrade-helper.log` so output isn't lost

The 2s sleep is the only timing-dependent piece. It's not load-bearing — `install-daemon` is idempotent w.r.t. bootout (will succeed even if the old daemon is already gone) — just a courtesy.

---

## 4. Why `.last-good-version` is written BEFORE handoff

Race condition: if we wait until after the new daemon proves itself, there's a window where the new daemon could crash with no breadcrumb of what to roll back to. Writing it before handoff guarantees the breadcrumb exists if anything goes wrong.

The cost: if the upgrade is interrupted before stage_upgrade actually exits (e.g., daemon SIGKILL'd between writing the file and spawning the helper), `.last-good-version` will be stale on next start. But the trial flag won't exist (it's written *after* `.last-good-version`), so `check_upgrade_trial` returns no-op and the stale `.last-good-version` is harmless.

---

## 5. Why 180-second trial deadline + 5-iteration probation

| Threshold | Value | Reasoning |
|-----------|-------|-----------|
| `UPGRADE_TRIAL_DEADLINE_SECONDS` | 180 | Long enough for two ThrottleInterval × respawn cycles + one healthy iteration's worth of work. Short enough that an operator notices within a few minutes if rollback fired. |
| `UPGRADE_TRIAL_PROBATION_ITERATIONS` | 5 | At 30s POLL_INTERVAL, this is ~2.5 minutes of consistent healthy behavior. Long enough to filter "crashes immediately after first iteration" failure mode. |
| `UPGRADE_THROTTLE_SECONDS` | 3600 | If a release is bad enough to roll back, we want at least an hour before we try again. Stops cache churn from triggering ping-pong. |
| `UPGRADE_CHECK_EVERY_N_POLLS` | 60 | At default 30s POLL_INTERVAL, this is once per 30 minutes. Cache reads are cheap; this cadence is conservative. |

All four are env-overridable for testing and operator preference.

---

## 6. Failure modes considered

| Mode | What happens | Mitigation |
|------|--------------|------------|
| New version crash-loops on every start | Each respawn re-runs `check_upgrade_trial`. Eventually deadline passes; one respawn detects expiry and triggers rollback. | Trial flag + deadline + `.last-good-version` |
| `.last-good-version` missing or names non-existent installer | `check_upgrade_trial` logs warning and clears flag rather than rolling back | "Limp on new" beats "refuse to boot" |
| Cache contains malformed/partial new version | `latest_cached_version()` requires `bin/supervisor-loop.sh` to exist; falls back to next-highest | Filter at discovery time |
| Operator manually downgrades cache | `compare_semver(running, latest)` returns ≥ 0; no upgrade action | We don't auto-downgrade |
| Upgrade fires mid-request | `stage_upgrade` reads heartbeat's `active_request_id`; bails if non-empty | Active-request guard (FR-022-03) |
| Throttle file doesn't exist (first run) | `upgrade_throttled` returns 1 (not throttled); upgrade proceeds | Acceptable behavior |
| Throttle file mtime in the future (clock skew) | `age = now - mtime` is negative; `(( age < UPGRADE_THROTTLE_SECONDS ))` is true; treats as throttled | Defensive — better to skip than upgrade in unknown clock state |
| jq missing or malformed trial-flag JSON | All `jq` calls have `2>/dev/null || …` fallbacks; flag is cleared if unparseable | Refuse-to-roll-back rather than infinite-rollback |

---

## 7. State files

All under `~/.autonomous-dev/`:

| File | Owner | Lifecycle |
|------|-------|-----------|
| `heartbeat.json` | every daemon iteration | Already existed; `active_request_id` field consumed by stage_upgrade |
| `.last-good-version` | stage_upgrade write; check_upgrade_trial read | Written before each upgrade; survives until next upgrade overwrites it |
| `.upgrade-throttle` | stage_upgrade touch; upgrade_throttled read | mtime-only; content irrelevant |
| `.upgrade-trial-pending` | stage_upgrade write (JSON); check_upgrade_trial read+delete; clear_upgrade_trial_if_probation_passed delete | Lifecycle: created at upgrade-time, deleted by either (a) probation pass, (b) successful rollback, or (c) check_upgrade_trial detecting a different target than us |

---

## 8. Test strategy

Three bats test files, one per phase, all pure-bash unit tests that don't need a real daemon or launchctl:

- `tests/bats/version_helpers.bats` (12 tests) — primitives in isolation
- `tests/bats/stage_upgrade.bats` (7 tests) — gate logic in isolation; the actual launchctl bootstrap is not exercised
- `tests/bats/upgrade_trial.bats` (7 tests) — startup-path probation/no-op outcomes

What's *not* covered by tests and remains manual:
- End-to-end upgrade against a real launchd job
- Rollback path with a real crash-looping fake binary

Both are reasonable to skip — the gate logic and the primitives are well-tested; the launchctl-as-Linux-equivalent (systemd on linux) integration is environmental, not algorithmic.

---

## 9. Risks accepted

- **Test gap for end-to-end.** Manual verification is the contract.
- **Rollback only goes one step back.** If `.last-good-version` is itself bad, we don't keep digging. Acceptable — releases are bumped one at a time.
- **No portal visibility yet.** Operator must look at `/logs` to see `daemon_upgrade_available` / `upgrade_trial_failed`. UI surface is a follow-up.
