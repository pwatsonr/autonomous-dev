# Hung-Session Diagnostics

This document describes how to diagnose, triage, and recover from hung or
anomalous phase sessions in autonomous-dev (REQ-000060 / issue #635).

## Overview

Starting with REQ-000060, every phase session now has:

- **A streaming transcript** — agent output is flushed to disk as it is
  produced, so a hang leaves partial output, not a 0-byte file.
- **A per-session heartbeat sidecar** — writes `session-progress.json`
  every `heartbeat_interval_seconds` to the request directory.
- **Anomaly detection** — when a session is silent too long or runs beyond
  the historical p95 baseline, it is flagged as `suspected` hung.
- **Diagnostic snapshots** — `session-stuck-*.json` files in the request
  directory capture ps, lsof, transcript tail, heartbeat samples, and a
  `recovery_hint` when a session is flagged or killed.

## Viewing Stuck Sessions

Use the `observability` CLI verb (requires autonomous-dev on PATH):

```sh
# List all stuck sessions (all requests, default table format)
autonomous-dev observability list-stuck

# Filter to one request
autonomous-dev observability list-stuck --request REQ-000060

# Machine-readable JSON
autonomous-dev observability list-stuck --json

# Show a specific snapshot
autonomous-dev observability show-stuck REQ-000060

# Or by file path
autonomous-dev observability show-stuck \
  .autonomous-dev/requests/REQ-000060/session-stuck-2026-07-07T10-00-00.000Z.json
```

## Snapshot Contents

Each `session-stuck-*.json` contains:

| Field | Description |
|-------|-------------|
| `captured_at` | When the snapshot was taken (ISO-8601 UTC) |
| `mode` | `"advisory"` (live detection) or `"postmortem"` (after kill/timeout) |
| `reason` | Why the session was flagged (see §Reasons) |
| `session.ps_line` | `ps` output for the session PID (or `"unavailable"`) |
| `session.open_fds` | Open file descriptors from `lsof` (or `[]` if unavailable) |
| `transcript.tail_128_lines` | Last 128 lines / 65 KB of agent output |
| `heartbeat.last_two_samples` | Last two heartbeat progress samples |
| `baselines` | Historical p50/p95 for this phase |
| `recovery_hint` | Suggested next action (see §Recovery hints) |

## Reasons

| Reason | Meaning |
|--------|---------|
| `silent_stall` | No new transcript output for ≥ `silent_stall_seconds` |
| `elapsed_over_p95` | Phase elapsed > `anomaly_multiplier` × historical p95 |
| `hard_timeout` | Wall-clock timeout reached |
| `soft_timeout_with_progress` | Timed out but working tree advanced |
| `agent_exited_nonzero` | Agent exited nonzero without writing a phase-result |
| `kill_signal` | Session received an external kill signal |

## Recovery Hints

The `recovery_hint` field uses the table below to suggest a next action:

| Reason | Has network FD | Has transcript write FD | Hint |
|--------|---------------|------------------------|------|
| `silent_stall` | ✓ | ✓ | API stall likely; consider retry after cool-off |
| `silent_stall` | ✗ | ✓ | Agent spinning without I/O; raise log verbosity |
| `silent_stall` | ✓ | ✗ | Transcript closed; check output redirect issues |
| `silent_stall` | ✗ | ✗ | No activity; inspect ps for zombie/defunct |
| `elapsed_over_p95` | * | * | Phase running >Nx p95; inspect transcript tail |
| `hard_timeout` | * | * | Wall-clock timeout; tune timeout via phase_baselines |
| `soft_timeout_with_progress` | * | * | Soft timeout with progress; supervisor will re-enter |
| `agent_exited_nonzero` | * | * | Check transcript tail for error line |
| `kill_signal` | * | * | Check parent supervisor for context |

## Kill switch

To disable all observability instrumentation (including heartbeat, transcript
streaming, and snapshot collection), set:

```sh
export AUTONOMOUS_DEV_OBSERVABILITY=0
```

When `AUTONOMOUS_DEV_OBSERVABILITY=0`, the supervisor falls back to the
original pre-REQ-000060 behavior: direct stdout redirection, no heartbeat,
no snapshots. This is the compat path and does not affect session correctness.

## Tuning

All thresholds are configurable via environment variables or
`~/.autonomous-dev/config.json` under `observability.hung_session.*`:

| Key | Env var | Default | Description |
|-----|---------|---------|-------------|
| `heartbeat_interval_seconds` | `AUTONOMOUS_DEV_HB_INTERVAL_S` | `15` | Heartbeat write interval |
| `silent_stall_seconds` | `AUTONOMOUS_DEV_HS_SILENT_STALL_SECONDS` | `300` | Silence threshold for anomaly |
| `anomaly_multiplier` | `AUTONOMOUS_DEV_HS_ANOMALY_MULTIPLIER` | `3.0` | Multiple of p95 to trigger |
| `kill_on_anomaly` | *(not yet implemented)* | `false` | Kill session on anomaly |

The config file at `plugins/autonomous-dev/config/defaults.json` has the
full default block under `"observability": { "hung_session": { ... } }`.

## Events

Two new event types are written to `events.jsonl` when a session anomaly
is detected:

- `session_hung_suspected` — emitted by the heartbeat sidecar when the
  detector fires with `verdict: "suspected"`.
- `session_stuck` — emitted on hard timeout or nonzero exit (postmortem).
- `session_recovered_after_stall` — emitted when a session recovers after
  being suspected (not yet wired to automatic recovery logic).

Each event conforms to its schema in
`docs/schemas/events/session_hung_suspected.schema.json` and
`docs/schemas/events/session_stuck.schema.json`.

## Snapshots

Advisory snapshots are written by the heartbeat sidecar when a session is
first suspected hung. Postmortem snapshots are written by the supervisor
on hard timeout or nonzero exit.

All snapshot files follow the pattern:

```
session-stuck-YYYY-MM-DDTHH-MM-SS.sssZ.json
```

(Note: `-` separates hours, minutes, and seconds in the time portion to
remain filesystem-safe on case-insensitive volumes.)

Files accumulate in `.autonomous-dev/requests/<REQ-ID>/` and are not
automatically rotated. Use `autonomous-dev observability list-stuck` to
enumerate them.

## Phase Baselines

Historical phase durations are stored at:

```
~/.autonomous-dev/state/observability/phase-baselines.json
```

The file stores a rolling window of up to 200 samples per phase with
computed p50/p95/mean. These baselines feed the anomaly detector.

The file is updated after every session (except timeouts, which are
excluded to avoid skewing the baseline). It is per-machine.

## Related

- Issue #635 (the diagnosis problem this feature addresses)
- Issue #620 (self-healing; complements this feature)
- `docs/schemas/events/session_stuck_snapshot.schema.json` (snapshot schema)
- `docs/schemas/events/phase_baselines.schema.json` (baseline file schema)
