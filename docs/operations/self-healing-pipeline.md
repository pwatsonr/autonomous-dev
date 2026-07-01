# Self-Healing Pipeline — Operator Guide

> **REQ-000056 / #620** — This feature requires daemon ≥ 0.3.52.
> Architecture decisions: [ADR-005](../architecture/adr-005-self-heal-dispatch.md).

---

## 1. Overview

The self-healing pipeline extends `supervisor-loop.sh` so that every
detectable in-run failure mode triggers an automatic remediation or safe
continue before escalating to a human. Nine failure modes (F1–F9) are
monitored continuously; each maps to a detector, an event written to
`events.jsonl`, and a policy-driven remediator. Human escalation is the
**final** resort, not the first. See
[ADR-005](../architecture/adr-005-self-heal-dispatch.md) for the architectural
rationale.

---

## 2. Failure-Mode Catalog

| ID | Name | Trigger | Remediation Policy |
|----|------|---------|-------------------|
| F1 | Review-gate loop | The same review-gate `reason` fingerprint appears ≥ N times (`AUTONOMOUS_DEV_SELF_HEAL_REVIEW_LOOP_THRESHOLD`, default 3) | Disable the review chain for the phase (`review_chain_disabled = true`) and re-run without it |
| F2 | Repeated reviewer timeout | A single reviewer has timed out ≥ N times (`AUTONOMOUS_DEV_SELF_HEAL_REVIEWER_TIMEOUT_THRESHOLD`, default 2) | Multiply the reviewer's timeout budget (`AUTONOMOUS_DEV_SELF_HEAL_REVIEWER_TIMEOUT_MULTIPLIER`, default 2×); if still blocking, exclude the reviewer |
| F3 | Phase timeout with progress | A hard phase timeout fires but the working tree has advanced since phase start | Extend the phase budget by `AUTONOMOUS_DEV_SELF_HEAL_BUDGET_EXTENSION_FACTOR` (default 1.5×); requeue the phase instead of failing |
| F4 | Reviewer error / unparseable JSON | A reviewer exits non-zero or produces invalid JSON | Retry once (`retryOnce: true`); if the reviewer is non-blocking, exclude it from future runs this phase |
| F5 | Suspicious empty result | A session completes but `result_file` is empty or missing | Mark `suspicious_previous_result = true` in state; prepend a `[SELF-HEAL HINT]` to the next session prompt; requeue |
| F6 | Suspicious fast result | A session completes in `< phase_median_duration / AUTONOMOUS_DEV_SELF_HEAL_SUSPICIOUS_FAST_RATIO` seconds | Same as F5: mark suspicious, hint next prompt, requeue |
| F7 | Verification false-negative | A phase result claims `fail` but a fresh test-result artifact shows passing | Rewrite `result_file` with `self_verified: true`; `advance_phase` skips `escalation_count++` and promotes to `pass` |
| F8 | Verification false-negative corrected | Follows F7: the corrected result advances the phase | Emits `verification_false_negative_corrected` event; no further action |
| F9 | Novel / unknown failure | No other mode matched; unexpected error in a detector/remediator | Capture full diagnostic bundle (env, state, log tail); attempt `gh issue create` if configured; escalate to `paused` |

---

## 3. Environment Variables

| Variable | Default | Semantics |
|----------|---------|-----------|
| `AUTONOMOUS_DEV_SELF_HEAL` | `1` | Master kill switch. Set to `0` to disable all self-heal logic and restore legacy fast-fail semantics. |
| `AUTONOMOUS_DEV_SELF_HEAL_MIN_PHASE_DURATION_SECONDS` | `5` | Minimum session duration below which F6 (suspicious-fast) is not triggered. |
| `AUTONOMOUS_DEV_SELF_HEAL_REVIEW_LOOP_THRESHOLD` | `3` | Number of identical review-gate `reason` fingerprints before F1 fires. |
| `AUTONOMOUS_DEV_SELF_HEAL_REVIEWER_TIMEOUT_THRESHOLD` | `2` | Number of timeouts for a single reviewer before F2 escalates. |
| `AUTONOMOUS_DEV_SELF_HEAL_BUDGET_EXTENSION_FACTOR` | `1.5` | Multiplier applied to the current phase timeout when F3 (timeout with progress) fires. |
| `AUTONOMOUS_DEV_SELF_HEAL_REVIEWER_TIMEOUT_MULTIPLIER` | `2` | Multiplier applied to a reviewer's per-call timeout when F2 fires. |
| `AUTONOMOUS_DEV_SELF_HEAL_DIAG_BUNDLE_MAX_BYTES` | `1048576` | Maximum size (bytes) of the diagnostic bundle captured by F9. |
| `AUTONOMOUS_DEV_SELF_HEAL_SUSPICIOUS_FAST_RATIO` | `10` | A session is suspicious-fast if its duration is less than `phase_median / ratio`. |
| `AUTONOMOUS_DEV_SELF_HEAL_VALIDATE_SCHEMA` | `1` | When `1`, emitted events are validated against `docs/schemas/events/*.schema.json` via `ajv`; a mismatch is `log_warn` only. |
| `AUTONOMOUS_DEV_SELF_HEAL_FILE_ISSUES` | `0` | When `1`, the F9 remediator attempts `gh issue create` after writing the diagnostic bundle. |
| `AUTONOMOUS_DEV_SELF_HEAL_ISSUE_REPO` | `autonomous-dev` | Target repo for `gh issue create` when `FILE_ISSUES=1`. |

---

## 4. Reading `self_heal_summary` from `events.jsonl`

Every request's event log (`<project>/.autonomous-dev/requests/<id>/events.jsonl`)
contains a terminal `self_heal_summary` event written when the request reaches
`done` or `failed`. To inspect it:

```bash
# Print the summary for a specific request
grep '"event_type":"self_heal_summary"' \
    .autonomous-dev/requests/REQ-000056/events.jsonl | jq .

# Sample output:
# {
#   "event_type": "self_heal_summary",
#   "request_id": "REQ-000056",
#   "project": "/path/to/project",
#   "terminal_status": "done",
#   "total_detections": 3,
#   "total_remediations": 2,
#   "modes_triggered": ["F1", "F4"],
#   "timestamp": "2026-06-30T23:59:00Z"
# }
```

To count how many times each mode fired across all requests:

```bash
grep '"event_type":"self_heal_summary"' \
    .autonomous-dev/requests/*/events.jsonl \
    | jq -r '.modes_triggered[]' | sort | uniq -c | sort -rn
```

---

## 5. Resuming a `novel_failure` Pause

When F9 fires and no other mode matched, the request is moved to `paused`
status with `paused_reason` set to `"novel_failure_detected"`. To investigate
and resume:

1. **Read the diagnostic bundle** written by the F9 remediator:
   ```bash
   cat .autonomous-dev/requests/<id>/self-heal-diag-*.json | jq .
   ```

2. **Read the last state snapshot:**
   ```bash
   jq . .autonomous-dev/requests/<id>/state.json
   ```

3. **Resume the request** once you have determined it is safe to continue:
   ```bash
   autonomous-dev request resume <id>
   ```
   The request re-enters the phase it was paused in.

4. **What to expect in `state.json` after resume:**
   - `status` changes from `"paused"` to `"running"`.
   - `current_phase_metadata.self_heal.novel_failure_captured` is cleared.
   - A new session is dispatched for the same phase.

---

## 6. Kill Switch for Legacy Fast-Fail Behavior

Set `AUTONOMOUS_DEV_SELF_HEAL=0` in the daemon's environment before starting
the supervisor. This short-circuits every detector to a no-op, restoring
bit-for-bit legacy semantics on all affected code paths:

```bash
# In your daemon startup script or systemd unit:
export AUTONOMOUS_DEV_SELF_HEAL=0
autonomous-dev daemon start
```

When the kill switch is active:

- All `selfheal_dispatch` calls return `1` immediately without touching
  `state.json` or `events.jsonl`.
- `should_use_review_chain` ignores the `review_chain_disabled` flag.
- `resolve_phase_timeout` ignores `budget_extended_to`.
- `resolve_phase_prompt` does not prepend the `[SELF-HEAL HINT]` prefix.
- No `self_heal_summary` event is emitted.

To verify the kill switch is active, check that no `self_heal_*` keys appear
in a running request's `state.json`:

```bash
jq '.current_phase_metadata.self_heal // "absent"' \
    .autonomous-dev/requests/<id>/state.json
# Output: "absent"
```
