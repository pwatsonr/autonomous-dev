# Session-Limit 429 Backoff — Operator Notes

**REQ-000061** | Implemented: 2026-07-07 | Applies to: `supervisor-loop.sh` ≥ commit containing REQ-000061

---

## What This Is

Claude returns `HTTP 429` for two distinct reasons:

| Class | Trigger | Retry strategy |
|-------|---------|----------------|
| `session_limit` | You've consumed all active parallel sessions in your quota | Park dispatch until the quota window resets (parsed from the response body) |
| `rate_limit` (generic) | Token-rate or request-rate exceeded | Exponential back-off ladder (pre-existing behaviour) |

Prior to REQ-000061, both classes were handled identically by the generic rate-limit ladder. When a session-limit 429 hit during a busy pipeline the daemon would keep spawning sessions, advancing the exponential ladder, and eventually burning 45 sessions before a human noticed (incident #636).

---

## How Detection Works

`detect_session_limit` in `lib/rate_limit_handler.sh` scans the raw response body for:

```
session limit|session_limit|You've hit your session limit
```

*and* a `resets?` clause that signals a quota reset time. Only responses that contain both markers are classified as `session_limit`. Plain 429 responses without a reset phrase fall through to the generic ladder.

---

## Reset-Time Parsing

`parse_session_limit_reset` extracts the reset time from phrases like:

| Example phrase | Result |
|----------------|--------|
| `resets 1:20pm (America/Chicago)` | Converted via IANA tz database → UTC |
| `resets 8:00am UTC` | Parsed directly |
| `resets 1pm PST` | Offset from abbreviation map → UTC |
| `resets at 13:20 UTC` | "at" form, 24-hour |
| No parseable reset clause | `parse_status=no_reset_clause` → floor applied |

**Next-day rollover**: if the computed UTC reset time is in the past (the reset is "today" but already elapsed), 86 400 seconds are added to move to tomorrow's window.

**Fallback chain**: IANA `date` → `python3 calendar.timegm` → floor.

---

## Config Reference

All options live under `governance.session_limit` in `config_defaults.json` (or your project's `config.json`):

```json
"session_limit": {
  "enabled": true,
  "buffer_seconds": 60,
  "floor_seconds": 900,
  "next_day_rollover": true,
  "abbreviation_map": {
    "PST": "-08:00", "PDT": "-07:00",
    "MST": "-07:00", "MDT": "-06:00",
    "CST": "-06:00", "CDT": "-05:00",
    "EST": "-05:00", "EDT": "-04:00",
    "UTC": "+00:00", "Z":   "+00:00"
  }
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Master switch. Also overridable via env `AUTONOMOUS_DEV_SL_ENABLED=false`. |
| `buffer_seconds` | `60` | Seconds added to the parsed reset time before unblocking. |
| `floor_seconds` | `900` | Minimum backoff (15 min) used when reset time cannot be parsed. |
| `next_day_rollover` | `true` | Roll reset time to next day if it's already in the past. |
| `abbreviation_map` | (see above) | Maps timezone abbreviations to UTC offsets. Extend for non-US zones. |

---

## State File

Written to `$HOME/.autonomous-dev/rate-limit-state.json`. The v2 schema adds `class`, `raw_reset_text`, and `parse_method` fields:

```json
{
  "schema_version": 2,
  "active": true,
  "consecutive_rate_limits": 1,
  "backoff_seconds": 3600,
  "kill_switch": false,
  "retry_at": "2026-07-07T19:20:00Z",
  "class": "session_limit",
  "raw_reset_text": "resets 1:20pm (America/Chicago)",
  "parse_method": "parsed"
}
```

`consecutive_rate_limits` is **pinned at 1** for `session_limit` — session-limit hits do not advance the exponential back-off ladder.

---

## Events

A `rate_limit_backoff` event is appended to the request's `events.jsonl`:

```json
{
  "timestamp": "2026-07-07T18:22:11Z",
  "event_type": "rate_limit_backoff",
  "request_id": "REQ-000061",
  "session_id": "rl-1783448531-12345",
  "class": "session_limit",
  "retry_at": "2026-07-07T19:20:00Z",
  "source": "parsed",
  "raw_reset_text": "resets 1:20pm (America/Chicago)"
}
```

Tail-dedup prevents duplicate events: if the last line already has the same `retry_at`, a second write is skipped.

---

## Diagnosing a Stuck Daemon

If the daemon appears hung after a session-limit error:

```bash
# 1. Check current state
cat ~/.autonomous-dev/rate-limit-state.json | jq .

# 2. Check retry_at vs now
now=$(date -u +%s)
retry_at=$(jq -r '.retry_at' ~/.autonomous-dev/rate-limit-state.json)

# On macOS:
retry_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$retry_at" +%s 2>/dev/null)
# On Linux:
retry_epoch=$(date -d "$retry_at" +%s 2>/dev/null)

echo "Seconds remaining: $(( retry_epoch - now ))"

# 3. To unblock immediately (emergency only):
# Source the library and clear state, OR delete the file:
rm ~/.autonomous-dev/rate-limit-state.json
```

---

## Disabling the Feature

To fall back to the old generic 429 ladder behaviour:

```bash
# Per-run (env var):
AUTONOMOUS_DEV_SL_ENABLED=false ./bin/supervisor-loop.sh ...

# Permanently (project config):
# In .autonomous-dev/config.json:
# { "governance": { "session_limit": { "enabled": false } } }
```

---

## Adding Timezone Abbreviations

If Claude's error messages include an unrecognised timezone abbreviation (e.g. `NZST`), add it to the `abbreviation_map` in your project's `config.json`:

```json
"abbreviation_map": {
  "NZST": "+12:00",
  "NZDT": "+13:00"
}
```

IANA timezone names (e.g. `Pacific/Auckland`) are resolved natively by `date` on systems with the IANA timezone database and do not require an entry here.
