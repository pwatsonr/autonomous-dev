# PRD-022: Marketplace-driven Daemon Self-Upgrade

| Field | Value |
|-------|-------|
| **PRD ID** | PRD-022 |
| **Title** | Marketplace-driven Daemon Self-Upgrade |
| **Version** | 1.0 |
| **Date** | 2026-05-17 |
| **Status** | Retroactive — implementation shipped in PRs #300, #301, #302 |
| **Plugin** | autonomous-dev |

> **Note on retroactivity.** This PRD was written *after* the implementation landed. The full design lived in a chat thread between operator and Claude on 2026-05-17, then was implemented across three PRs (#300 detect-and-log, #301 stage-upgrade-on-idle, #302 trial-flag rollback). This document is the architectural record so future maintainers don't have to reconstruct intent from commit messages.

---

## 1. Problem Statement

When the autonomous-dev marketplace publishes a new plugin version, claude-code's plugin updater extracts it into `~/.claude/plugins/cache/autonomous-dev/autonomous-dev/<X.Y.Z>/`. The user's launchd job continues to execute the **old** version's `supervisor-loop.sh` until the operator manually:

1. Runs `claude` → `/plugin` → `update autonomous-dev`
2. Then `<NEW_VERSION>/bin/install-daemon.sh --force` to rewrite the plist
3. Then `launchctl unload + load` (or equivalent) to bounce the job

That's three operator steps per upgrade. In practice the operator forgets, leaving the daemon running stale code — sometimes for weeks. Today's failure mode (2026-05-17): the live daemon was still on 0.1.0 even though 0.2.0 had been in the cache since 2026-05-12, which meant a half-dozen bug fixes shipped during that window weren't in effect.

The operator's direct words: *"I also think we should have a way to update the daemon automatically when the marketplace triggers an update."*

---

## 2. Goals & Non-Goals

### Goals

| ID | Goal |
|----|------|
| G-01 | Daemon detects a newer cached version without operator intervention |
| G-02 | Daemon stages the upgrade and exits cleanly so the new version takes over |
| G-03 | Failed upgrades self-roll-back to the last known good version |
| G-04 | Active in-flight requests are not interrupted by an upgrade |
| G-05 | Mechanism is conservative — at most one upgrade attempt per hour, regardless of cache churn |
| G-06 | Operator can disable the mechanism via env var (escape hatch) |

### Non-Goals

- **Marketplace → cache push.** That side is claude-code's responsibility. This PRD assumes a new version eventually arrives in `~/.claude/plugins/cache/...`; how it gets there is upstream.
- **Cross-process coordination.** A single launchd job runs the supervisor; we don't need distributed locks.
- **Downgrade.** If `compare_semver(running, latest) >= 0`, do nothing. We do not auto-downgrade.
- **Plugin-definition changes that require claude-code reload.** New MCP servers, new slash commands, etc. require claude-code to refresh its plugin definitions. This PRD covers the daemon binary only.

---

## 3. User Personas

- **Primary: Operator.** Wants fixes to land without remembering three-step rituals. Sometimes idle for days; daemon must self-heal.
- **Secondary: Plugin maintainer.** Cuts a new release and expects deployed daemons to start running it within ~30 minutes of the cache update, automatically.

---

## 4. Functional Requirements

| ID | Requirement | Notes |
|----|-------------|-------|
| FR-022-01 | Daemon periodically scans `~/.claude/plugins/cache/autonomous-dev/autonomous-dev/` for cached versions | Default cadence: once per 60 iterations × 30s = ~30 min |
| FR-022-02 | Daemon logs `daemon_upgrade_available` once per distinct newer version detected | De-dup via `LAST_UPGRADE_LOGGED_VERSION` so operator sees signal in `/logs` without flood |
| FR-022-03 | When idle and not throttled, daemon stages an upgrade to the newest cached version | "Idle" = `active_request_id` in heartbeat is null/empty |
| FR-022-04 | Upgrade staging writes the old version into `.last-good-version` before handoff | Enables rollback in FR-022-08 |
| FR-022-05 | Upgrade staging writes a trial flag with deadline = now + 180s | New daemon reads this on startup; clears it after probation |
| FR-022-06 | Upgrade staging spawns a detached `install-daemon.sh --force` for the new version | The old daemon then exits 0; launchd's `KeepAlive.SuccessfulExit: false` prevents auto-respawn of the old binary |
| FR-022-07 | New daemon, on startup, reads the trial flag and either enters probation or rolls back | Probation = continue normal operation, clear flag after N (default 5) healthy iterations |
| FR-022-08 | New daemon rolls back if the trial deadline has passed and flag still names us as target | Implies previous attempts of this version's startup crash-looped; spawn detached installer for `.last-good-version`, exit |
| FR-022-09 | Throttle file (`.upgrade-throttle`) prevents repeat attempts within `UPGRADE_THROTTLE_SECONDS` | Default 3600s. Stops cache churn from triggering ping-pong upgrades |
| FR-022-10 | All check cadences, deadlines, and thresholds are env-overridable | `UPGRADE_CHECK_EVERY_N_POLLS`, `UPGRADE_THROTTLE_SECONDS`, `UPGRADE_TRIAL_DEADLINE_SECONDS`, `UPGRADE_TRIAL_PROBATION_ITERATIONS` |

---

## 5. Acceptance Criteria

| ID | Criterion | How verified |
|----|-----------|--------------|
| AC-01 | When `latest_cached_version > current_version` and daemon is idle, an upgrade is staged within one iteration of the next detection tick | Manual: drop a `0.99.0/` directory in the cache with a valid `bin/supervisor-loop.sh` + `bin/install-daemon.sh`, observe daemon log within UPGRADE_CHECK_EVERY_N_POLLS × POLL_INTERVAL |
| AC-02 | When daemon has an `active_request_id` in heartbeat, no upgrade is staged | bats test: `stage_upgrade: skips when active_request_id is set` |
| AC-03 | When `.upgrade-throttle` was touched within UPGRADE_THROTTLE_SECONDS, no upgrade is staged | bats test: `upgrade_throttled: fresh touch -> throttled` |
| AC-04 | When `install-daemon.sh` for target version is missing, no upgrade is staged | bats test: `stage_upgrade: skips when installer is missing` |
| AC-05 | On startup, daemon respects an in-deadline trial flag by entering probation | bats test: `check_upgrade_trial: future deadline -> probation` |
| AC-06 | Daemon clears the trial flag after UPGRADE_TRIAL_PROBATION_ITERATIONS healthy iterations | bats test: `clear_upgrade_trial: in probation, threshold met -> clears flag` |
| AC-07 | On startup with expired trial flag naming current version, daemon spawns rollback installer and exits | Manual; rollback path is logged with `upgrade_trial_failed` |
| AC-08 | Mechanism is no-op when daemon script is run from a non-cache path (dev checkout) | bats test: `current_version returns unknown for a non-cache path` |
| AC-09 | `compare_semver` handles 0.10.0 > 0.9.0 correctly | bats test: `compare_semver handles 0.10 vs 0.9` |

---

## 6. Success Metrics

- **Time-to-deployed-fix (TTDF):** median time from a release tag landing in cache to the operator's daemon executing that version's code. Pre-PRD: days to weeks (manual). Post-PRD: <30 min.
- **Operator manual upgrade actions per release:** Pre-PRD: 3 (plugin update → install-daemon → bounce). Post-PRD: 0 (claude plugin update + cache pull only; daemon self-promotes).
- **Crash-loop incidents from bad releases:** target 0. The trial-flag rollback (FR-022-07 / FR-022-08) is the safety net.

---

## 7. Open Questions

| Q | Resolution |
|---|------------|
| Q-022-01: Should upgrade also fire on first-launch (e.g., cache has multiple versions; running version is not latest)? | **Yes** — check_upgrade_available runs every UPGRADE_CHECK_EVERY_N_POLLS, including iteration 1 (because `% N == 1` matches on first iteration). |
| Q-022-02: What if the operator wants to pin to an old version? | **Defer.** Today's mechanism always upgrades to the highest available semver. A pin file (e.g., `~/.autonomous-dev/.version-pin`) is a follow-up; design space is not blocked by this PRD. |
| Q-022-03: What about portal upgrades? | **Out of scope.** Portal is a Bun process, not a daemon — separate lifecycle. The portal's process manager (or lack thereof) is the operator's responsibility. |
| Q-022-04: Should we surface upgrades in the portal UI? | **Yes, eventually.** The `daemon_upgrade_available` log line is already visible in `/logs`. A dedicated banner is a follow-up. |

---

## 8. References

- **Implementation PRs:**
  - PR #300 — Phase 1: detect & log (`bin/lib/version-helpers.sh`, `check_upgrade_available`)
  - PR #301 — Phase 2: stage_upgrade on idle (`stage_upgrade`, `upgrade_throttled`)
  - PR #302 — Phase 3: trial-flag rollback (`check_upgrade_trial`, `clear_upgrade_trial_if_probation_passed`)
- **Companion docs:**
  - TDD-039 — design + module breakdown
  - PLAN-040 — task list (retroactive)
- **Adjacent files:**
  - `plugins/autonomous-dev/bin/supervisor-loop.sh` — call sites and globals
  - `plugins/autonomous-dev/bin/lib/version-helpers.sh` — primitives
  - `plugins/autonomous-dev/bin/install-daemon.sh` — invoked by stage_upgrade
  - `plugins/autonomous-dev/templates/com.autonomous-dev.daemon.plist.template` — KeepAlive contract
