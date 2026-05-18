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

## 8. First live trial (2026-05-18) + fix in PR #314

The 2026-05-18 v0.3.0 → v0.3.1 first live trial revealed that the
original `nohup ... &` + `disown` handoff did NOT survive launchd's
reap of the supervisor's process tree on macOS. Evidence:
`upgrade-helper.log` was created (the parent opened it for redirection)
but stayed 0 bytes; `install-daemon.sh` never emitted any output.

All three logs (`daemon_upgrade_available` → `daemon_upgrade_staging`
→ `daemon_upgrade_exiting`) appeared correctly. State files were
written. The detect/stage/rollback machinery was all sound — only the
final handoff step (spawning install-daemon) was broken.

### Fix (PR #314)

Replaced the detached subshell with an OS-aware spawn that uses the
platform's service manager to register a SEPARATE one-shot job:

| OS      | Mechanism                                                |
|---------|----------------------------------------------------------|
| macOS   | Render upgrader plist → `launchctl bootstrap` a separate |
|         | `com.autonomous-dev.daemon.upgrader` job. The new job has |
|         | its own Label and lifecycle — launchd doesn't reap it    |
|         | when the daemon's controlled process exits.              |
| Linux   | `systemd-run --user --no-block` registers a transient    |
|         | unit — same idea, different supervisor.                  |
| Other   | Falls back to the original nohup pattern (best-effort).  |

Each path also falls back to nohup if its primary mechanism fails
(template missing, plutil rejects, launchctl/systemd-run unavailable).
The fallback logs `daemon_upgrade_helper_launched_fallback` so
operators see the reliability degradation in `/logs`.

### Verification

Live trial of the fix will fire on the next release after v0.3.1.
Bats coverage:

- `tests/bats/spawn_upgrade_helper.bats` (9 tests) — macOS plist
  rendering, leftover-bootout defense, launchctl-fails fallback,
  plutil-fails fallback, Linux systemd-run invocation, no-systemd
  fallback, dispatcher OS routing (Darwin/Linux/other).

### Historical note (pre-fix behavior)

- **What works:** check_upgrade_available, log de-dup, all three
  stage_upgrade gates, all state-file writes (`.last-good-version`,
  `.upgrade-throttle`, `.upgrade-trial-pending`), check_upgrade_trial
  startup logic, clear_upgrade_trial_if_probation_passed.
- **What's broken:** the `nohup ... &` + `disown` pattern in
  `stage_upgrade()`. The detached subshell gets killed when the
  supervisor exits, so install-daemon.sh never runs. Plist is not
  rewritten; new daemon does not come up.
- **First live trial:** 2026-05-18, v0.3.0 → v0.3.1 (this release).
  Symptom: `upgrade-helper.log` is created but stays 0 bytes. All
  three log lines (`daemon_upgrade_available` → `daemon_upgrade_staging`
  → `daemon_upgrade_exiting`) appeared correctly; the helper just
  never ran.
- **Operator workaround:** when you see `daemon_upgrade_staging` in
  `/logs`, manually run:
  ```
  ~/.claude/plugins/cache/autonomous-dev/autonomous-dev/<latest>/bin/install-daemon.sh --force
  ```
  That brings up the new daemon, which reads the still-present trial
  flag and enters probation as designed (clears flag after 5
  healthy iterations).
- **Proper fix (deferred):** instead of detaching a subshell from the
  controlled job's process tree, register a SEPARATE one-shot launchd
  job that runs install-daemon. That job is outside our daemon's
  lifecycle and survives our exit. Tracked as a follow-up.

---

## 9. References

- **Implementation PRs:**
  - PR #300 — Phase 1: detect & log (`bin/lib/version-helpers.sh`, `check_upgrade_available`)
  - PR #301 — Phase 2: stage_upgrade on idle (`stage_upgrade`, `upgrade_throttled`)
  - PR #302 — Phase 3: trial-flag rollback (`check_upgrade_trial`, `clear_upgrade_trial_if_probation_passed`)
  - PR #313 — Known-issue note added after first live trial (this section)
- **Companion docs:**
  - TDD-039 — design + module breakdown
  - PLAN-040 — task list (retroactive)
- **Adjacent files:**
  - `plugins/autonomous-dev/bin/supervisor-loop.sh` — call sites and globals
  - `plugins/autonomous-dev/bin/lib/version-helpers.sh` — primitives
  - `plugins/autonomous-dev/bin/install-daemon.sh` — invoked by stage_upgrade
  - `plugins/autonomous-dev/templates/com.autonomous-dev.daemon.plist.template` — KeepAlive contract

---

## 10. Upstream contract

This PRD covers the **cache → running daemon** half of the upgrade pipeline.
The **marketplace → cache** half is owned by claude-code itself. This section
documents the surface we depend on, the surface we explicitly chose *not* to
depend on, and the failure modes we can observe from our side.

### What we depend on

| ID | Dependency | Where it shows up |
|----|------------|-------------------|
| UP-01 | Cache layout: `~/.claude/plugins/cache/autonomous-dev/autonomous-dev/<X.Y.Z>/` with one directory per cached version | `version-helpers.sh::list_cached_versions`, `current_version` |
| UP-02 | Each cached version directory contains a valid plugin tree, specifically `bin/install-daemon.sh` and `bin/supervisor-loop.sh` | `stage_upgrade` gate FR-022-04 / AC-04 |
| UP-03 | Version directory names are valid semver triplets that sort correctly via numeric comparison | `compare_semver` (AC-09) |
| UP-04 | `claude plugin update` pulls the marketplace manifest from GitHub and extracts new versions into the cache layout above | Operator-side prerequisite; we never invoke it ourselves |
| UP-05 | claude-code does not delete the *currently-running* version's directory out from under us | `install-daemon.sh --force` paths and `.last-good-version` rollback both rely on the prior version's tree still being present on disk |

### What we explicitly do not depend on

| ID | Non-dependency | Why |
|----|----------------|-----|
| UP-N1 | No notification / hook / IPC from claude-code when it pulls a new cache version | We discover via filesystem poll (`UPGRADE_CHECK_EVERY_N_POLLS`, default ~30 min). Polling is dumb but observable and survives upgrades of claude-code itself. |
| UP-N2 | No reliance on `plugin.json` `version` field matching the directory name | We treat the directory name as authoritative for semver comparison. Mismatches between `plugin.json` and the cache directory name are upstream's problem, not ours. |
| UP-N3 | No reliance on marketplace.json schema beyond "claude-code accepted it" | If claude-code extracted it into the cache, we assume it parsed. We only inspect the extracted tree. |
| UP-N4 | No coordination with `claude` CLI process | The daemon is a separate launchd / systemd job. Operator may never run `claude` interactively; the cache can still update via background mechanisms. |

### Upstream failure modes

| Mode | Symptom we'd see | Recovery |
|------|------------------|----------|
| Marketplace manifest is invalid JSON | New version never appears in cache | None on our side. Daemon stays on current version indefinitely. **No signal.** |
| GitHub rate-limit / network failure during `claude plugin update` | New version never appears in cache | None on our side. **No signal.** |
| Partial cache extraction (directory exists, `bin/install-daemon.sh` missing) | `stage_upgrade` gate AC-04 trips; we log nothing visible to operator and skip | Self-heals when upstream completes the extraction on a subsequent pull. Throttle does not engage (gate trips before throttle write), so we re-check every cadence. |
| Directory name not valid semver (e.g., `0.3.x-dev/`) | `compare_semver` ignores it; `list_cached_versions` filter excludes non-numeric segments | Latest valid semver still wins. Non-semver directories are invisible to us. |
| `plugin.json` version disagrees with directory name | We honor the directory name (UP-N2) | No action needed; mismatch is benign for our purposes. |
| Currently-running version's directory deleted by upstream cleanup | `current_version` may return `unknown`; rollback target (`.last-good-version`) may not exist on disk | `stage_upgrade` skips when current path is non-cache (AC-08). Rollback installer would fail; daemon would crash-loop on next restart. **No automated recovery — operator must reinstall.** |
| Stuck on old version because cache never advances | Daemon runs old code; no `daemon_upgrade_available` log line ever fires | **No signal.** Operator must notice externally (e.g., comparing release tags vs. running version in heartbeat). |

### Observability gaps

We have no positive signal that the marketplace → cache pipeline is healthy.
The absence of `daemon_upgrade_available` log lines is ambiguous: either no
new version exists, or upstream is broken. If a future PRD wants to close
this gap, candidates are:

- Periodic compare of `current_version` against the GitHub release tags
  (introduces network dependency the daemon doesn't otherwise have).
- A portal-side check that surfaces "running v0.3.5, marketplace claims
  v0.4.0" as a banner.
- Operator-side cron that runs `claude plugin update` on a schedule
  (out-of-band; not this plugin's responsibility).

None of these are in scope for PRD-022. The current contract is: we trust
upstream to deliver versions into the cache, and we promise to promote them
within ~30 min of arrival once delivered.
