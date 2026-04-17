# TDD-002: State Machine & Request Lifecycle

| Field          | Value                                                  |
|----------------|--------------------------------------------------------|
| **Title**      | State Machine & Request Lifecycle                      |
| **TDD ID**     | TDD-002                                                |
| **Version**    | 0.1.0                                                  |
| **Date**       | 2026-04-08                                             |
| **Author**     | Paul Watson (Staff Engineer)                           |
| **Status**     | Draft                                                  |
| **Parent PRD** | PRD-001: System Core & Daemon Engine                   |
| **Plugin**     | `autonomous-dev` (Claude Code plugin)                  |
| **Covers**     | FR-200 through FR-214, FR-300 through FR-310, NFR-01, NFR-02, NFR-07, NFR-09 |

---

## 1. Overview

This document specifies the technical design for the state machine and request lifecycle subsystem of the `autonomous-dev` plugin. This subsystem is the backbone of the entire system: every request flows through it, every crash recovery depends on it, and every downstream component (document pipeline, agent factory, parallel execution) reads and writes through it.

The design is driven by three non-negotiable constraints from the PRD:

1. **Zero data loss.** No state may be lost due to crash, power loss, or unexpected termination (NFR-01). This rules out in-memory-only state and demands atomic file operations.
2. **Idempotent re-entry.** Re-entering any state after a crash must produce the same outcome as entering it for the first time (NFR-02). This means all state transitions must be deterministic given the same inputs.
3. **Pure-function testability.** All state machine logic must be `(state, event) -> new_state` functions testable without spawning Claude Code sessions (NFR-09).

The subsystem comprises four components:

- **State File** (`state.json`): The authoritative record of a request's current position in the pipeline.
- **Event Log** (`events.jsonl`): An append-only audit trail of every significant event.
- **Request Tracker**: ID generation, uniqueness enforcement, and request discovery.
- **Lifecycle Engine**: The transition logic, validation, timeout enforcement, and cleanup orchestration consumed by the supervisor loop (designed in a separate TDD).

All four components operate on the filesystem. There is no database. There are no network calls. This is deliberate: the system must survive with only `bash`, `jq`, and `git` as dependencies (NFR-06).

---

## 2. Architecture

### 2.1 Component Diagram

```
+--------------------------------------------------------------------+
|                     Supervisor Loop (TDD-001)                      |
|  (selects request, spawns session, captures exit, calls into us)   |
+---+---------------------------+---------------------------+--------+
    |                           |                           |
    v                           v                           v
+---+----------+  +-------------+-----------+  +------------+--------+
| Lifecycle    |  | State File Manager      |  | Event Logger        |
| Engine       |  |                         |  |                     |
| - validate() |  | - read(request_id)      |  | - append(event)     |
| - advance()  |  | - write_atomic(state)   |  | - read_all(req_id)  |
| - pause()    |  | - validate_schema()     |  | - read_since(ts)    |
| - fail()     |  | - migrate(state, v_old, |  | - rotate()          |
| - cancel()   |  |          v_new)         |  |                     |
| - retry()    |  | - checkpoint()          |  |                     |
+---+----------+  +---+---------------------+  +---+-----------------+
    |                  |                            |
    |                  v                            v
    |           +------+--------+            +------+--------+
    |           | state.json    |            | events.jsonl  |
    |           | state.json.tmp|            +---------------+
    |           | checkpoint/   |
    |           +---------------+
    |
    v
+---+-------------------+
| Request Tracker       |
| - generate_id()       |
| - discover_requests() |
| - cleanup()           |
| - archive()           |
+---+-------------------+
    |
    v
+---+------------------------------------+
| {project}/.autonomous-dev/requests/    |
|   REQ-20260408-a3f1/                   |
|     state.json                         |
|     events.jsonl                       |
|     checkpoint/                        |
|       state.json.{timestamp}           |
|   REQ-20260408-b7c2/                   |
|     state.json                         |
|     events.jsonl                       |
|     checkpoint/                        |
+----------------------------------------+
```

### 2.2 State Machine Diagram

```
                          +----------+
                          |  intake  |
                          +----+-----+
                               |
                               v
                          +----+-----+
                          |   prd    |<--------+
                          +----+-----+         |
                               |          (review fail,
                               v           retries remain)
                       +-------+--------+      |
                       |  prd_review    +------+
                       +-------+--------+
                               |
                               v
                          +----+-----+
                          |   tdd    |<--------+
                          +----+-----+         |
                               |               |
                               v               |
                       +-------+--------+      |
                       |  tdd_review    +------+
                       +-------+--------+
                               |
                               v
                          +----+-----+
                          |   plan   |<--------+
                          +----+-----+         |
                               |               |
                               v               |
                       +-------+--------+      |
                       |  plan_review   +------+
                       +-------+--------+
                               |
                               v
                          +----+-----+
                          |   spec   |<--------+
                          +----+-----+         |
                               |               |
                               v               |
                       +-------+--------+      |
                       |  spec_review   +------+
                       +-------+--------+
                               |
                               v
                          +----+-----+
                          |   code   |<--------+
                          +----+-----+         |
                               |               |
                               v               |
                       +-------+--------+      |
                       |  code_review   +------+
                       +-------+--------+
                               |
                               v
                       +-------+--------+
                       |  integration   |
                       +-------+--------+
                               |
                               v
                          +----+-----+
                          |  deploy  |
                          +----+-----+
                               |
                               v
                          +----+-----+
                          | monitor  |
                          +----------+

    ANY STATE -----> paused -----> (original state)
    ANY STATE -----> failed -----> (checkpoint state via retry)
    ANY STATE -----> cancelled     (terminal)
    failed -------> cancelled      (terminal)
```

---

## 3. Detailed Design

### 3.1 State File Manager

#### 3.1.1 File Location

Each request's state file lives at:

```
{project_root}/.autonomous-dev/requests/{request_id}/state.json
```

Where `{project_root}` is the absolute path to the target repository (must be on the allowlist per FR-507). The `.autonomous-dev/` directory is `.gitignore`-d by convention; it is operational state, not source code.

#### 3.1.2 Atomic Write Protocol

All writes to `state.json` follow this sequence (FR-205):

```
1. Serialize new state to JSON string
2. Write JSON to  {dir}/state.json.tmp  (O_WRONLY | O_CREAT | O_TRUNC)
3. fsync the file descriptor  (ensures data hits disk, not just OS buffer)
4. mv {dir}/state.json.tmp {dir}/state.json  (atomic on POSIX)
```

In bash:

```bash
state_write_atomic() {
  local dir="$1"
  local json="$2"
  local tmp="${dir}/state.json.tmp"
  local target="${dir}/state.json"

  printf '%s\n' "$json" > "$tmp"
  # fsync via a subshell trick: dd conv=fsync or python -c
  python3 -c "import os; fd=os.open('${tmp}',os.O_RDONLY); os.fsync(fd); os.close(fd)" 2>/dev/null \
    || sync  # fallback if python3 unavailable
  mv -f "$tmp" "$target"
}
```

**Why `mv` and not direct write?** On POSIX systems, `mv` within the same filesystem is an atomic `rename(2)` syscall. The file is either the old version or the new version; there is no intermediate corrupted state. A crash during the `printf` step leaves only the `.tmp` file, and the previous `state.json` remains intact.

**Startup recovery for orphaned `.tmp` files:** On startup, the State File Manager scans each request directory. If a `state.json.tmp` exists alongside a `state.json`, the `.tmp` is deleted (it represents an incomplete write from a crashed process). If a `state.json.tmp` exists but `state.json` does not, this indicates a crash between the first-ever write's `printf` and its `mv`. In this case, the `.tmp` is promoted to `state.json` only if it passes schema validation; otherwise it is moved to a `corrupt/` subdirectory for forensic inspection and the request is marked `failed`.

#### 3.1.3 Schema Validation

On every read, the State File Manager validates the loaded JSON against the state file schema (Section 4.1). Validation checks:

1. **Required fields present.** All fields marked `required` in the schema exist.
2. **Type correctness.** Each field matches its declared JSON type.
3. **Enum constraints.** `status` is a recognized state name. `priority` is within range.
4. **Temporal consistency.** `updated_at >= created_at`. Phase history entries are in chronological order.
5. **Schema version recognized.** `schema_version` is <= the current version supported by the running code.

If validation fails, the request transitions to `failed` with `failure_reason: "state_corruption"` and an event is logged with the specific validation errors (FR-213).

#### 3.1.4 Checkpointing

Before each phase execution (FR-307), the current `state.json` is copied to:

```
{request_dir}/checkpoint/state.json.{ISO-8601-timestamp}
```

Example: `checkpoint/state.json.2026-04-08T10-05-30Z`

Checkpoints enable the `retry` command to restore a known-good state without re-running prior phases. The checkpoint directory retains only the most recent 5 checkpoints; older ones are deleted.

### 3.2 Event Logger

#### 3.2.1 Append-Only Log

Each request has an event log at:

```
{project_root}/.autonomous-dev/requests/{request_id}/events.jsonl
```

Events are appended using:

```bash
event_append() {
  local events_file="$1"
  local event_json="$2"
  printf '%s\n' "$event_json" >> "$events_file"
}
```

**Why no atomic write for the event log?** The event log is append-only. A crash mid-append may produce a truncated final line, but all prior lines remain intact. On read, the event parser discards any final line that fails JSON parsing (treating it as a torn write). This is the standard pattern for append-only logs (cf. write-ahead logs in databases).

#### 3.2.2 Torn-Write Recovery

When reading `events.jsonl`, each line is independently parsed. If the last line is malformed:

1. Log a warning: `"Discarding torn write at end of events.jsonl for {request_id}"`.
2. Truncate the file to remove the partial line.
3. Continue processing with all valid events.

If any line other than the last is malformed, this indicates corruption beyond a torn write. The request is transitioned to `failed` with `failure_reason: "event_log_corruption"`.

#### 3.2.3 Event Log Rotation

Per open question OQ-2 in the PRD, the event log rotation strategy is:

- **Active requests:** No rotation. The log grows unbounded for the lifetime of the request. Typical request lifecycle produces 50-200 events (< 100 KB). Even pathological cases with maximum retries at every phase produce < 1 MB.
- **Archived requests:** The `events.jsonl` is included in the archive tarball (FR-701) and removed from the active directory.
- **Maximum size guard:** If `events.jsonl` exceeds 10 MB (indicating a bug or runaway loop), the event logger stops appending and logs a warning. The request continues to function; events are simply no longer recorded until an operator intervenes.

### 3.3 Request Tracker

#### 3.3.1 ID Generation (FR-200)

Request IDs follow the format: `REQ-{YYYYMMDD}-{4-char-hex}`

Examples: `REQ-20260408-a3f1`, `REQ-20260409-00b7`

Generation algorithm:

```bash
generate_request_id() {
  local date_part
  date_part="$(date -u +%Y%m%d)"
  local hex_part
  hex_part="$(openssl rand -hex 2)"  # 2 bytes = 4 hex chars
  echo "REQ-${date_part}-${hex_part}"
}
```

**Uniqueness guarantee:** 4 hex characters yield 65,536 possible IDs per calendar day. At the target throughput of 10+ requests per week (Section 8 of PRD), collision probability is negligible. However, the system still checks for directory existence before creating the state directory. If a collision occurs (directory exists), a new hex part is generated. After 5 failed attempts, ID generation fails and the submit command exits with an error.

**ID format regex:** `^REQ-[0-9]{8}-[0-9a-f]{4}$`

#### 3.3.2 Request Discovery

The supervisor loop discovers actionable requests by scanning all configured repositories:

```bash
discover_requests() {
  for repo in "${ALLOWLIST[@]}"; do
    local req_dir="${repo}/.autonomous-dev/requests"
    [ -d "$req_dir" ] || continue
    for dir in "${req_dir}"/REQ-*/; do
      [ -f "${dir}/state.json" ] || continue
      echo "${dir}"
    done
  done
}
```

Discovery returns all request directories. The supervisor loop then reads each `state.json`, filters for actionable states (not `paused`, `failed`, `cancelled`, or `monitor`), sorts by priority (ascending numerically; 0 = highest), and selects the first.

#### 3.3.3 Concurrency Model (FR-211)

Multiple requests coexist without conflict because:

1. **Isolated directories.** Each request has its own `{request_id}/` directory. No two requests share a state file.
2. **Single-writer guarantee.** The supervisor loop processes one request per iteration (FR-102). Even with concurrent requests, only one is being actively worked at any moment.
3. **Lock file.** The daemon lock file (FR-109) prevents multiple supervisor instances. A single writer to any given state file is guaranteed.
4. **No cross-request state.** A request's state file contains only its own data. The global cost ledger is a separate concern (TDD for resource governance). Request dependencies (`blocked_by`) are evaluated by reading the blocking request's state file read-only.

**Important concurrency subtlety:** When evaluating `blocked_by` dependencies, the supervisor reads the blocking request's `state.json`. This is a read-only operation and requires no locking. The blocking request may be updated by a concurrent iteration, but since we have a single-writer guarantee (one supervisor, one request per iteration), this cannot happen. If future designs introduce multi-worker parallelism, this assumption must be revisited.

### 3.4 Lifecycle Engine

The Lifecycle Engine is the pure-function core of the state machine. It accepts a current state and an event, validates the transition, and returns the new state (or an error).

#### 3.4.1 Transition Function Signature

```
transition(current_state: StateFile, event: TransitionEvent) -> Result<StateFile, TransitionError>
```

In bash, this is implemented as:

```bash
# Returns 0 on success (new state JSON on stdout), non-zero on failure (error on stderr)
state_transition() {
  local current_state_json="$1"
  local event_type="$2"       # "advance" | "review_fail" | "pause" | "fail" | "cancel" | "retry" | "resume"
  local metadata_json="$3"    # event-specific data
  local timestamp="$4"        # ISO-8601

  # ... validation, transition logic, new state construction ...
}
```

#### 3.4.2 Transition Rules

The engine enforces these rules strictly:

**Rule 1: Forward-only sequential advancement.**
The `advance` event moves a request from its current state to the next state in the pipeline order. No state may be skipped.

```
Pipeline order: intake -> prd -> prd_review -> tdd -> tdd_review -> plan ->
  plan_review -> spec -> spec_review -> code -> code_review -> integration ->
  deploy -> monitor
```

**Rule 2: Review-to-generation regression.**
A `review_fail` event on a `_review` state moves the request back to its corresponding generation state (e.g., `prd_review` -> `prd`), but only if the retry count for that review phase has not been exhausted.

**Rule 3: Universal meta-state transitions.**
Any active state (not `cancelled`) can transition to `paused` or `failed`. Any active state (not `cancelled`, `failed`) can transition to `cancelled`.

**Rule 4: Pause resumption.**
`paused` transitions back to the state stored in `paused_from`. The `paused_from` field is set when entering `paused` and cleared when leaving.

**Rule 5: Retry from checkpoint.**
`failed` transitions to the state stored in `last_checkpoint` via the `retry` event. This resets the retry counter for that phase.

**Rule 6: Terminal state immutability.**
`cancelled` is terminal. No events are accepted. Attempting a transition on a cancelled request returns a `TransitionError`.

**Rule 7: `monitor` is a sink.**
`monitor` does not advance to another state. It is exited only by `cancel` or `fail`.

#### 3.4.3 Timeout Enforcement

Each state has a configurable timeout (from the `state_machine.timeouts_by_phase` config). The timeout clock starts when the state is entered (`entered_at` timestamp in the current phase history entry).

On each supervisor iteration, before spawning a session:

```
if now - current_phase.entered_at > timeout_for_phase:
    if retry_count < max_retries:
        transition(state, "fail_phase", {reason: "timeout"})
        # stays in same state, increments retry
    else:
        transition(state, "fail", {reason: "timeout_exhausted"})
        # or escalate to paused
```

The `monitor` state has `indefinite` timeout and is exempt from timeout checks.

#### 3.4.4 Retry Accounting

Each phase tracks its own retry count in the current phase history entry (`retry_count`). When a `review_fail` or phase error causes re-entry:

1. The retry counter increments.
2. If `retry_count >= max_retries` for the phase, the request transitions to `paused` (for review states, triggering escalation per FR-303) or `failed` (for generation/execution states).
3. The retry counter resets to 0 when the request advances past the phase (i.e., a review passes).

#### 3.4.5 Dependency Evaluation (FR-214)

Requests may declare `blocked_by: ["REQ-xxx", ...]`. Dependencies are evaluated as:

```
is_blocked(state) -> bool:
    for dep_id in state.blocked_by:
        dep_state = read_state(dep_id)
        if dep_state is None:
            return true   # unknown dependency = blocked (safe default)
        if dep_state.status not in COMPLETED_STATES:
            return true
    return false

COMPLETED_STATES = {"deploy", "monitor", "cancelled"}
```

A blocked request remains in `intake` and is skipped during request selection. It is not an error; it simply waits.

**Circular dependency detection:** On intake, the system checks for cycles by following the `blocked_by` chain. If a cycle is detected, the submit command rejects the request with an error.

---

## 4. Data Models / Schemas

### 4.1 State File Schema (`state.json`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AutonomousDevRequestState",
  "description": "The authoritative state record for a single autonomous-dev request.",
  "type": "object",
  "required": [
    "schema_version",
    "id",
    "status",
    "priority",
    "title",
    "repository",
    "branch",
    "created_at",
    "updated_at",
    "cost_accrued_usd",
    "turn_count",
    "escalation_count",
    "blocked_by",
    "phase_history",
    "current_phase_metadata",
    "error",
    "last_checkpoint"
  ],
  "additionalProperties": false,
  "properties": {
    "schema_version": {
      "type": "integer",
      "description": "Schema version for migration support. Current version: 1. The system refuses to operate on unrecognized versions (NFR-07).",
      "minimum": 1,
      "const": 1
    },
    "id": {
      "type": "string",
      "description": "Unique request tracking ID. Format: REQ-{YYYYMMDD}-{4-char-hex}.",
      "pattern": "^REQ-[0-9]{8}-[0-9a-f]{4}$"
    },
    "status": {
      "type": "string",
      "description": "Current state in the pipeline.",
      "enum": [
        "intake",
        "prd",
        "prd_review",
        "tdd",
        "tdd_review",
        "plan",
        "plan_review",
        "spec",
        "spec_review",
        "code",
        "code_review",
        "integration",
        "deploy",
        "monitor",
        "paused",
        "failed",
        "cancelled"
      ]
    },
    "priority": {
      "type": "integer",
      "description": "Request priority. 0 = highest (most urgent). Default: 5. Used by the supervisor loop to select the next request to work on.",
      "minimum": 0,
      "maximum": 9,
      "default": 5
    },
    "title": {
      "type": "string",
      "description": "Human-readable title of the request. Set at intake from the submitted request content.",
      "minLength": 1,
      "maxLength": 200
    },
    "description": {
      "type": "string",
      "description": "Optional longer description of the request, typically the original submitted text or a summary.",
      "maxLength": 10000
    },
    "repository": {
      "type": "string",
      "description": "Absolute path to the target repository. Must be on the allowlist.",
      "pattern": "^/"
    },
    "branch": {
      "type": "string",
      "description": "Git branch name created for this request. Convention: autonomous/{request_id}.",
      "pattern": "^autonomous/REQ-[0-9]{8}-[0-9a-f]{4}$"
    },
    "worktree_path": {
      "type": ["string", "null"],
      "description": "Absolute path to the git worktree for this request. Null if no worktree has been created yet.",
      "default": null
    },
    "created_at": {
      "type": "string",
      "description": "ISO-8601 UTC timestamp of request creation.",
      "format": "date-time"
    },
    "updated_at": {
      "type": "string",
      "description": "ISO-8601 UTC timestamp of the last state file modification. Must be >= created_at.",
      "format": "date-time"
    },
    "cost_accrued_usd": {
      "type": "number",
      "description": "Total cost accrued by this request across all sessions, in USD. Updated after each session completes.",
      "minimum": 0,
      "default": 0
    },
    "turn_count": {
      "type": "integer",
      "description": "Total number of Claude Code turns consumed across all phases.",
      "minimum": 0,
      "default": 0
    },
    "escalation_count": {
      "type": "integer",
      "description": "Number of times this request has been escalated to a human. Incremented when entering paused due to review failure or error exhaustion.",
      "minimum": 0,
      "default": 0
    },
    "blocked_by": {
      "type": "array",
      "description": "Array of request IDs that must reach a completed state before this request advances past intake. Empty array means no dependencies.",
      "items": {
        "type": "string",
        "pattern": "^REQ-[0-9]{8}-[0-9a-f]{4}$"
      },
      "default": [],
      "uniqueItems": true
    },
    "phase_history": {
      "type": "array",
      "description": "Ordered array of phase execution records. The last entry is the current or most recently completed phase. Entries are appended, never removed.",
      "items": {
        "$ref": "#/$defs/PhaseHistoryEntry"
      }
    },
    "current_phase_metadata": {
      "type": "object",
      "description": "Phase-specific metadata for the currently active phase. Structure varies by phase. Cleared and repopulated on each state transition.",
      "properties": {
        "review_criteria": {
          "type": "string",
          "description": "For _review states: the quality criteria being evaluated."
        },
        "review_feedback": {
          "type": ["string", "null"],
          "description": "For _review states: feedback from the last failed review, passed to the generation state on regression."
        },
        "artifacts": {
          "type": "array",
          "description": "Paths to artifacts produced in or relevant to this phase, relative to the repository root.",
          "items": { "type": "string" }
        },
        "pr_number": {
          "type": ["integer", "null"],
          "description": "For integration/deploy/monitor states: the GitHub PR number."
        },
        "pr_url": {
          "type": ["string", "null"],
          "description": "For integration/deploy/monitor states: the full PR URL."
        },
        "context_tokens_estimated": {
          "type": ["integer", "null"],
          "description": "Estimated token count consumed in the current session, for context window management (FR-308)."
        }
      },
      "additionalProperties": true
    },
    "error": {
      "type": ["object", "null"],
      "description": "Error information if the request is in a failed or error state. Null when no error.",
      "properties": {
        "message": {
          "type": "string",
          "description": "Human-readable error description."
        },
        "code": {
          "type": "string",
          "description": "Machine-readable error code.",
          "enum": [
            "timeout",
            "timeout_exhausted",
            "retries_exhausted",
            "review_failed",
            "state_corruption",
            "event_log_corruption",
            "session_crash",
            "cost_cap_exceeded",
            "turn_budget_exceeded",
            "context_window_exhaustion",
            "rate_limited",
            "dependency_failed",
            "cancelled_by_operator",
            "kill_switch",
            "unknown"
          ]
        },
        "phase": {
          "type": "string",
          "description": "The phase in which the error occurred."
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "When the error occurred."
        },
        "session_id": {
          "type": ["string", "null"],
          "description": "The Claude Code session ID that produced the error, if applicable."
        },
        "details": {
          "type": "object",
          "description": "Additional structured error context (e.g., exit code, stderr snippet).",
          "additionalProperties": true
        }
      },
      "required": ["message", "code", "phase", "timestamp"]
    },
    "last_checkpoint": {
      "type": ["string", "null"],
      "description": "The state name of the last successful checkpoint. Used by the retry command to know where to resume. Null if no checkpoint has been taken.",
      "enum": [
        "intake", "prd", "prd_review", "tdd", "tdd_review",
        "plan", "plan_review", "spec", "spec_review",
        "code", "code_review", "integration", "deploy", "monitor",
        null
      ]
    },
    "paused_from": {
      "type": ["string", "null"],
      "description": "When status is 'paused', this records the state the request was in before pausing. Used to resume. Null when not paused.",
      "default": null
    },
    "paused_reason": {
      "type": ["string", "null"],
      "description": "When status is 'paused', a human-readable explanation of why. Null when not paused.",
      "default": null
    },
    "failure_reason": {
      "type": ["string", "null"],
      "description": "When status is 'failed', a human-readable explanation of the terminal failure. Null when not failed.",
      "default": null
    },
    "generation": {
      "type": "integer",
      "description": "Depth counter for self-generated requests. A human-submitted request is generation 0. A request spawned by the system from a generation-0 request is generation 1. Used to prevent infinite recursion (PRD R-9).",
      "minimum": 0,
      "default": 0
    },
    "tags": {
      "type": "array",
      "description": "Operator-defined tags for filtering and reporting.",
      "items": { "type": "string" },
      "default": [],
      "uniqueItems": true
    }
  },
  "$defs": {
    "PhaseHistoryEntry": {
      "type": "object",
      "required": ["state", "entered_at", "exited_at", "session_id", "turns_used", "cost_usd"],
      "properties": {
        "state": {
          "type": "string",
          "description": "The phase/state name."
        },
        "entered_at": {
          "type": "string",
          "format": "date-time",
          "description": "ISO-8601 UTC timestamp when this phase was entered."
        },
        "exited_at": {
          "type": ["string", "null"],
          "format": "date-time",
          "description": "ISO-8601 UTC timestamp when this phase was exited. Null if this is the active phase."
        },
        "session_id": {
          "type": ["string", "null"],
          "description": "The Claude Code session ID that processed this phase. Null if no session has started yet."
        },
        "turns_used": {
          "type": "integer",
          "description": "Number of Claude Code turns consumed in this phase entry.",
          "minimum": 0
        },
        "cost_usd": {
          "type": "number",
          "description": "Cost in USD consumed in this phase entry.",
          "minimum": 0
        },
        "retry_count": {
          "type": "integer",
          "description": "Number of retries consumed in this phase entry. Not present on the intake phase.",
          "minimum": 0,
          "default": 0
        },
        "exit_reason": {
          "type": ["string", "null"],
          "description": "Why this phase exited: 'completed', 'review_pass', 'review_fail', 'timeout', 'error', 'paused', 'cancelled'. Null if active.",
          "enum": ["completed", "review_pass", "review_fail", "timeout", "error", "paused", "cancelled", null]
        }
      }
    }
  }
}
```

### 4.2 Event Log Schema (`events.jsonl`)

Each line in the event log is an independent JSON object conforming to:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AutonomousDevEvent",
  "description": "A single event in the append-only request event log.",
  "type": "object",
  "required": ["timestamp", "event_type", "request_id", "session_id"],
  "properties": {
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "ISO-8601 UTC timestamp of when the event occurred."
    },
    "event_type": {
      "type": "string",
      "description": "The type of event.",
      "enum": [
        "request_created",
        "state_transition",
        "phase_started",
        "phase_completed",
        "review_pass",
        "review_fail",
        "retry",
        "timeout",
        "error",
        "paused",
        "resumed",
        "failed",
        "cancelled",
        "escalation",
        "checkpoint_created",
        "checkpoint_restored",
        "cost_update",
        "context_window_warning",
        "dependency_resolved",
        "dependency_blocked",
        "session_started",
        "session_ended",
        "artifact_created",
        "pr_created",
        "pr_merged",
        "cleanup_started",
        "cleanup_completed"
      ]
    },
    "request_id": {
      "type": "string",
      "description": "The request tracking ID this event belongs to.",
      "pattern": "^REQ-[0-9]{8}-[0-9a-f]{4}$"
    },
    "from_state": {
      "type": ["string", "null"],
      "description": "The state before this event. Null for events that do not involve a state change (e.g., cost_update, session_started)."
    },
    "to_state": {
      "type": ["string", "null"],
      "description": "The state after this event. Null for events that do not involve a state change."
    },
    "session_id": {
      "type": ["string", "null"],
      "description": "The Claude Code session ID associated with this event. Null if the event was produced by the supervisor loop outside of a session (e.g., cleanup, dependency check)."
    },
    "metadata": {
      "type": "object",
      "description": "Event-type-specific structured data. Schema varies by event_type. Always an object, never null.",
      "additionalProperties": true
    }
  }
}
```

#### 4.2.1 Event Type Metadata Schemas

Each `event_type` has a specific `metadata` shape. Key examples:

**`state_transition`:**
```json
{
  "metadata": {
    "trigger": "advance | review_fail | timeout | error | manual",
    "retry_count": 0,
    "turns_used_in_phase": 28,
    "cost_usd_in_phase": 1.85,
    "artifacts": ["docs/prd/PRD-dark-mode.md"]
  }
}
```

**`review_pass` / `review_fail`:**
```json
{
  "metadata": {
    "score": 0.87,
    "criteria_met": ["completeness", "feasibility"],
    "criteria_failed": [],
    "feedback": "PRD covers all acceptance criteria..."
  }
}
```

**`error`:**
```json
{
  "metadata": {
    "error_code": "session_crash",
    "exit_code": 1,
    "stderr_tail": "Error: context window exceeded",
    "retry_remaining": 2
  }
}
```

**`escalation`:**
```json
{
  "metadata": {
    "reason": "review_retries_exhausted",
    "phase": "prd_review",
    "retry_count": 3,
    "notification_channel": "webhook",
    "notification_sent": true
  }
}
```

**`cost_update`:**
```json
{
  "metadata": {
    "session_cost_usd": 1.85,
    "total_cost_usd": 4.32,
    "daily_budget_remaining_usd": 95.68,
    "per_request_budget_remaining_usd": 45.68
  }
}
```

**`session_started` / `session_ended`:**
```json
{
  "metadata": {
    "session_id": "sess_abc123",
    "phase": "prd",
    "max_turns": 50,
    "exit_code": 0,
    "turns_used": 28,
    "duration_seconds": 2958
  }
}
```

### 4.3 Example: Complete State File

```json
{
  "schema_version": 1,
  "id": "REQ-20260408-a3f1",
  "status": "prd_review",
  "priority": 1,
  "title": "Add dark mode support to dashboard",
  "description": "Users have requested dark mode. Implement a theme switcher and dark color palette across all dashboard components.",
  "repository": "/Users/pwatson/codebase/dashboard-app",
  "branch": "autonomous/REQ-20260408-a3f1",
  "worktree_path": "/Users/pwatson/.autonomous-dev/worktrees/REQ-20260408-a3f1",
  "created_at": "2026-04-08T09:15:00Z",
  "updated_at": "2026-04-08T10:42:00Z",
  "cost_accrued_usd": 2.47,
  "turn_count": 38,
  "escalation_count": 0,
  "blocked_by": [],
  "phase_history": [
    {
      "state": "intake",
      "entered_at": "2026-04-08T09:15:00Z",
      "exited_at": "2026-04-08T09:16:12Z",
      "session_id": "sess_abc123",
      "turns_used": 3,
      "cost_usd": 0.12,
      "retry_count": 0,
      "exit_reason": "completed"
    },
    {
      "state": "prd",
      "entered_at": "2026-04-08T09:16:12Z",
      "exited_at": "2026-04-08T10:05:30Z",
      "session_id": "sess_def456",
      "turns_used": 28,
      "cost_usd": 1.85,
      "retry_count": 0,
      "exit_reason": "completed"
    },
    {
      "state": "prd_review",
      "entered_at": "2026-04-08T10:05:30Z",
      "exited_at": null,
      "session_id": "sess_ghi789",
      "turns_used": 7,
      "cost_usd": 0.50,
      "retry_count": 0,
      "exit_reason": null
    }
  ],
  "current_phase_metadata": {
    "review_criteria": "completeness, feasibility, clarity",
    "review_feedback": null,
    "artifacts": ["docs/prd/PRD-dark-mode.md"]
  },
  "error": null,
  "last_checkpoint": "prd",
  "paused_from": null,
  "paused_reason": null,
  "failure_reason": null,
  "generation": 0,
  "tags": ["dashboard", "ux"]
}
```

### 4.4 Example: Event Log Entries

```jsonl
{"timestamp":"2026-04-08T09:15:00Z","event_type":"request_created","request_id":"REQ-20260408-a3f1","from_state":null,"to_state":"intake","session_id":null,"metadata":{"title":"Add dark mode support to dashboard","repository":"/Users/pwatson/codebase/dashboard-app","priority":1,"submitted_by":"cli"}}
{"timestamp":"2026-04-08T09:15:01Z","event_type":"session_started","request_id":"REQ-20260408-a3f1","from_state":null,"to_state":null,"session_id":"sess_abc123","metadata":{"phase":"intake","max_turns":10}}
{"timestamp":"2026-04-08T09:16:12Z","event_type":"session_ended","request_id":"REQ-20260408-a3f1","from_state":null,"to_state":null,"session_id":"sess_abc123","metadata":{"phase":"intake","exit_code":0,"turns_used":3,"duration_seconds":71}}
{"timestamp":"2026-04-08T09:16:12Z","event_type":"state_transition","request_id":"REQ-20260408-a3f1","from_state":"intake","to_state":"prd","session_id":"sess_abc123","metadata":{"trigger":"advance","retry_count":0,"turns_used_in_phase":3,"cost_usd_in_phase":0.12,"artifacts":[]}}
{"timestamp":"2026-04-08T09:16:13Z","event_type":"checkpoint_created","request_id":"REQ-20260408-a3f1","from_state":null,"to_state":null,"session_id":null,"metadata":{"checkpoint_state":"prd","checkpoint_file":"checkpoint/state.json.2026-04-08T09-16-13Z"}}
{"timestamp":"2026-04-08T09:16:14Z","event_type":"session_started","request_id":"REQ-20260408-a3f1","from_state":null,"to_state":null,"session_id":"sess_def456","metadata":{"phase":"prd","max_turns":50}}
{"timestamp":"2026-04-08T10:05:30Z","event_type":"session_ended","request_id":"REQ-20260408-a3f1","from_state":null,"to_state":null,"session_id":"sess_def456","metadata":{"phase":"prd","exit_code":0,"turns_used":28,"duration_seconds":2956}}
{"timestamp":"2026-04-08T10:05:30Z","event_type":"artifact_created","request_id":"REQ-20260408-a3f1","from_state":null,"to_state":null,"session_id":"sess_def456","metadata":{"artifact":"docs/prd/PRD-dark-mode.md","phase":"prd"}}
{"timestamp":"2026-04-08T10:05:30Z","event_type":"state_transition","request_id":"REQ-20260408-a3f1","from_state":"prd","to_state":"prd_review","session_id":"sess_def456","metadata":{"trigger":"advance","retry_count":0,"turns_used_in_phase":28,"cost_usd_in_phase":1.85,"artifacts":["docs/prd/PRD-dark-mode.md"]}}
{"timestamp":"2026-04-08T10:05:31Z","event_type":"cost_update","request_id":"REQ-20260408-a3f1","from_state":null,"to_state":null,"session_id":null,"metadata":{"session_cost_usd":1.85,"total_cost_usd":1.97,"daily_budget_remaining_usd":98.03,"per_request_budget_remaining_usd":48.03}}
```

---

## 5. State Transition Table

### 5.1 Forward Transitions (advance event)

| From State      | To State        | Conditions                                                  | Side Effects                                            |
|-----------------|-----------------|-------------------------------------------------------------|---------------------------------------------------------|
| `intake`        | `prd`           | Request parsed; repo on allowlist; not blocked by deps      | Create branch, create worktree, write checkpoint        |
| `prd`           | `prd_review`    | PRD document exists on branch                               | Write checkpoint                                        |
| `prd_review`    | `tdd`           | Review passes quality criteria                              | Reset retry count, write checkpoint                     |
| `tdd`           | `tdd_review`    | TDD document exists on branch                               | Write checkpoint                                        |
| `tdd_review`    | `plan`          | Review passes quality criteria                              | Reset retry count, write checkpoint                     |
| `plan`          | `plan_review`   | Implementation plan exists on branch                        | Write checkpoint                                        |
| `plan_review`   | `spec`          | Review passes quality criteria                              | Reset retry count, write checkpoint                     |
| `spec`          | `spec_review`   | Implementation spec exists on branch                        | Write checkpoint                                        |
| `spec_review`   | `code`          | Review passes quality criteria                              | Reset retry count, write checkpoint                     |
| `code`          | `code_review`   | All code written, lint passes, unit tests pass              | Write checkpoint                                        |
| `code_review`   | `integration`   | Review passes quality criteria                              | Reset retry count, write checkpoint                     |
| `integration`   | `deploy`        | Integration tests pass, PR created                          | Write checkpoint, record PR metadata                    |
| `deploy`        | `monitor`       | Deployment confirmed (PR merged or deploy script succeeded) | Send completion notification, write checkpoint          |

### 5.2 Backward Transitions (review_fail event)

| From State      | To State  | Conditions                                    | Side Effects                                                      |
|-----------------|-----------|-----------------------------------------------|-------------------------------------------------------------------|
| `prd_review`    | `prd`     | Review fails; `retry_count < max_retries`     | Increment retry, store review feedback in `current_phase_metadata` |
| `tdd_review`    | `tdd`     | Review fails; `retry_count < max_retries`     | Increment retry, store review feedback                             |
| `plan_review`   | `plan`    | Review fails; `retry_count < max_retries`     | Increment retry, store review feedback                             |
| `spec_review`   | `spec`    | Review fails; `retry_count < max_retries`     | Increment retry, store review feedback                             |
| `code_review`   | `code`    | Review fails; `retry_count < max_retries`     | Increment retry, store review feedback                             |

### 5.3 Meta-State Transitions

| From State      | To State    | Event       | Conditions                                           | Side Effects                                         |
|-----------------|-------------|-------------|------------------------------------------------------|------------------------------------------------------|
| Any (not cancelled) | `paused`    | `pause`     | Kill switch engaged, cost cap hit, or review retries exhausted | Set `paused_from`, `paused_reason`; increment `escalation_count` if review-triggered; send notification |
| `paused`        | (original)  | `resume`    | Kill switch cleared, cost cap raised, or human approves | Restore `status` to `paused_from`; clear `paused_from` and `paused_reason` |
| Any (not cancelled) | `failed`    | `fail`      | Retries exhausted, unrecoverable error, state corruption | Set `failure_reason`, `error` object; send notification |
| `failed`        | (checkpoint) | `retry`    | Operator issues retry; `last_checkpoint` is set       | Restore state to `last_checkpoint`; reset phase retry count; clear error |
| Any (not cancelled, not failed) | `cancelled` | `cancel`    | Operator issues cancel command                        | Trigger cleanup (delete worktree, archive state); immutable from this point |
| `failed`        | `cancelled` | `cancel`    | Operator issues cancel on a failed request            | Trigger cleanup                                       |

### 5.4 Invalid Transitions (rejected by the engine)

| From State  | To State    | Reason                                                  |
|-------------|-------------|---------------------------------------------------------|
| `cancelled` | Any         | Cancelled is terminal. No transitions out.              |
| `monitor`   | Next state  | Monitor has no forward successor; only paused/failed/cancelled. |
| `intake`    | `tdd`       | States cannot be skipped. Must go through `prd` and `prd_review`. |
| `prd`       | `tdd`       | Must pass through `prd_review` first.                   |
| `prd_review`| `prd`       | Only valid on `review_fail` event; invalid via `advance`. |
| `paused`    | Any (not original) | Paused can only resume to the state stored in `paused_from`. |
| `failed`    | Any (not checkpoint, not cancelled) | Failed can only retry to `last_checkpoint` or cancel. |
| Any         | `intake`    | No state can transition back to `intake`. Intake is entry-only. |

### 5.5 Error States (automatic transitions)

| Trigger                               | Current State | Target State | Condition                                             |
|---------------------------------------|---------------|--------------|-------------------------------------------------------|
| Session exit code non-zero            | Any active    | Same state (retry) or `failed` | Retry if `retry_count < max_retries`; else `failed`   |
| Phase timeout exceeded                | Any active    | Same state (retry) or `paused` | Retry if retries remain; else `paused` with escalation |
| State file validation failure         | Any           | `failed`     | Always; `failure_reason: "state_corruption"`           |
| Event log corruption (non-tail)       | Any           | `failed`     | Always; `failure_reason: "event_log_corruption"`       |
| Cost cap exceeded (per-request)       | Any active    | `paused`     | Always; `paused_reason: "per_request_cost_cap"`        |
| Turn budget exceeded (per-phase)      | Any active    | `failed` or `paused` | Treated as timeout exhaustion                    |
| Kill switch engaged                   | Any active    | `paused`     | Always; `paused_reason: "kill_switch"`                 |
| Dependency failed (blocking request cancelled/failed) | `intake` | `failed` | `failure_reason: "dependency_failed"`       |
| Rate limit backoff exhausted          | Any active    | `paused`     | After max backoff reached; `paused_reason: "rate_limited"` |

---

## 6. Error Handling & Recovery

### 6.1 Crash Recovery

The system is designed so that a crash at any point is recoverable:

| Crash Point                            | State on Disk After Crash              | Recovery Action                                          |
|----------------------------------------|----------------------------------------|----------------------------------------------------------|
| During `state.json.tmp` write          | `.tmp` exists, `state.json` is previous version | Delete `.tmp`, continue from `state.json`               |
| During `mv` of `.tmp` to `state.json`  | Atomic; either old or new version exists | No action needed; `mv` is atomic                        |
| During event log append                | Last line may be truncated             | Discard truncated last line on read                      |
| After state write, before session spawn | State says "entering phase X"         | Supervisor re-reads state, re-enters phase X (idempotent) |
| During Claude Code session             | State shows active phase with `exited_at: null` | Supervisor detects un-exited phase, increments retry, re-enters |
| After session exit, before state update | Session completed but state not updated | Supervisor re-reads state, re-enters same phase. Idempotency requirement (NFR-02) ensures this is safe. |

### 6.2 Corrupt State Detection

On every state file read:

1. JSON parse the file. If parse fails, attempt to read from most recent checkpoint.
2. Validate against schema (Section 4.1). If validation fails, transition to `failed`.
3. Check temporal consistency: `updated_at >= created_at`, phase history in order.
4. Check status consistency: `paused_from` is non-null iff `status == "paused"`.
5. Check `schema_version` is recognized.

If the state file is entirely missing (deleted externally), the request is treated as non-existent. The supervisor logs a warning and skips it.

### 6.3 Orphaned Resource Detection

On startup, the supervisor scans for:

- **Orphaned `.tmp` files:** Deleted (Section 3.1.2).
- **Orphaned worktrees:** Worktree directories that do not correspond to any active request are logged as warnings. They are not auto-deleted (risk of deleting intentional worktrees); the `cleanup` command handles them.
- **Orphaned lock files:** If `daemon.lock` exists but the PID it contains is not running, the lock is released.

### 6.4 Stale Heartbeat Recovery

When the supervisor starts and detects a stale heartbeat (FR-104):

1. Log: `"Stale heartbeat detected. Last beat: {timestamp}. Assumed prior crash or sleep."`
2. Scan all active requests for un-exited phase history entries (`exited_at: null`).
3. For each such request, the current phase is treated as interrupted. The supervisor will re-enter the phase on the next iteration with retry semantics.

### 6.5 Split-Brain Prevention

A single-writer guarantee is enforced via:

1. **Lock file** (`~/.autonomous-dev/daemon.lock`): Contains the PID. On startup, if the lock exists, check if the PID is alive. If alive, refuse to start. If dead, steal the lock.
2. **Single-request-per-iteration model**: The supervisor works on exactly one request per iteration. No concurrent writes to the same state file.

If the lock file is corrupted (not a valid PID), it is deleted and re-acquired.

---

## 7. State File Versioning & Migration

### 7.1 Versioning Strategy

The `schema_version` field is an integer, starting at 1. It increments on any change to the state file schema that is not purely additive.

**Additive changes** (new optional field with a default value) do NOT require a version bump. The existing schema tolerates missing optional fields by using defaults.

**Breaking changes** (removing a field, renaming a field, changing a field's type, or changing a required field's semantics) require a version bump and a migration function.

### 7.2 Migration Protocol

```
1. On read, check schema_version.
2. If schema_version == CURRENT_VERSION:
     Proceed normally.
3. If schema_version < CURRENT_VERSION:
     Apply migrations sequentially: v1->v2, v2->v3, ..., vN-1->vN.
     Write the migrated state file atomically.
     Log event: "state_migrated" with from_version and to_version.
4. If schema_version > CURRENT_VERSION:
     REFUSE to operate. Log error: "State file version {v} is newer than
     supported version {CURRENT_VERSION}. Upgrade the plugin."
     Transition to failed with reason "unsupported_schema_version".
```

### 7.3 Migration Function Registry

Migrations are implemented as bash functions:

```bash
# Each migration transforms the JSON and returns the new JSON
migrate_v1_to_v2() {
  local state_json="$1"
  # Example: add a new required field 'tags' with default []
  echo "$state_json" | jq '. + {tags: [], schema_version: 2}'
}

MIGRATIONS=(
  # "from_version:function_name"
  # "1:migrate_v1_to_v2"
  # "2:migrate_v2_to_v3"
)
```

### 7.4 Backward Compatibility Guarantee

- The system never writes a state file with a version older than what it read.
- Migrations are idempotent: applying the same migration twice produces the same result.
- All migration functions are unit-tested with fixture data.
- The system maintains test fixtures for every historical schema version.

---

## 8. Cleanup Strategy

### 8.1 Automated Cleanup (FR-700)

The supervisor loop includes a cleanup check on every Nth iteration (configurable, default: every 100 iterations, approximately once per hour at 30s poll interval):

```
for each request in state "monitor":
    if now - monitor_entered_at > cleanup_retention_days:
        archive_request(request)

for each request in state "cancelled":
    if now - cancelled_at > 7 days:   # short retention for cancelled
        archive_request(request)
```

### 8.2 Archive Procedure

```
archive_request(request_id):
    1. Create archive dir: ~/.autonomous-dev/archive/{request_id}/
    2. Copy state.json and events.jsonl to archive dir.
    3. Compress: tar -czf ~/.autonomous-dev/archive/{request_id}.tar.gz \
         -C ~/.autonomous-dev/archive/ {request_id}/
    4. Remove the uncompressed archive dir.
    5. Delete the git worktree (if exists):
         git -C {repository} worktree remove {worktree_path} --force
    6. Delete the remote branch (if configured to do so):
         git -C {repository} push origin --delete {branch}
    7. Remove the request directory:
         rm -rf {project}/.autonomous-dev/requests/{request_id}/
    8. Log event to global archive log:
         ~/.autonomous-dev/archive/archive.log
```

### 8.3 Manual Cleanup (FR-702)

The `autonomous-dev cleanup` command:

- Without flags: archives all eligible requests (same criteria as automated).
- `--dry-run`: lists what would be archived without acting.
- `--force`: archives requests regardless of retention period.
- `--request {id}`: archives a specific request (must be in terminal state).

### 8.4 Disk Space Accounting

The cleanup system reports disk space recovered after each run:

```
Cleanup complete:
  Archived: 3 requests
  Worktrees removed: 3 (2.1 GB recovered)
  Branches deleted: 3
  State files compressed: 3 (14 KB -> 3 KB)
```

---

## 9. Security Considerations

### 9.1 State File Content

State files SHALL NOT contain:
- API keys or tokens
- User passwords or credentials
- Webhook URLs with embedded secrets (those live in the config file, not state)
- File contents (only paths to artifacts)

### 9.2 File Permissions

- State directories: `0700` (owner-only read/write/traverse).
- State files: `0600` (owner-only read/write).
- Event logs: `0600`.
- Archive tarballs: `0600`.

The `submit` command sets these permissions on directory creation. The state file manager verifies permissions on read and logs a warning (but continues) if permissions are too open.

### 9.3 Path Traversal Prevention

The request ID format (`REQ-{YYYYMMDD}-{4-char-hex}`) is validated by regex before use in any filesystem path construction. This prevents path traversal attacks via crafted IDs (e.g., `../../etc/passwd`).

Repository paths are resolved to absolute paths and checked against the allowlist before any filesystem operations.

### 9.4 Input Validation

All inputs that flow into the state file (title, description, tags) are sanitized:
- Maximum length enforced (see schema constraints).
- No shell metacharacters are interpreted; values are always passed through `jq` for JSON encoding, never interpolated into shell commands.

---

## 10. Testing Strategy

### 10.1 Unit Tests (NFR-09)

The state machine logic is implemented as pure functions. Each function is testable with fixture data and no external dependencies.

| Test Category                  | Count | Description                                                        |
|--------------------------------|-------|--------------------------------------------------------------------|
| Valid forward transitions      | 13    | One test per adjacent pair in the pipeline order.                  |
| Valid backward transitions     | 5     | One test per `_review` -> generation regression.                   |
| Meta-state transitions         | 12    | `pause`, `resume`, `fail`, `retry`, `cancel` from each state type.|
| Invalid transitions rejected   | 15+   | Skipping states, transitioning from cancelled, wrong direction.    |
| Timeout enforcement            | 5     | Timeout triggers retry; timeout with exhausted retries triggers fail.|
| Retry accounting               | 6     | Counter increments, resets, and exhaustion.                        |
| Dependency evaluation          | 5     | Blocked, unblocked, circular detection, missing dep, failed dep.  |
| Schema validation              | 10    | Missing fields, wrong types, bad enums, version mismatch.         |
| ID generation                  | 4     | Format validation, uniqueness check, collision handling.           |

Total: 75+ unit tests.

### 10.2 Integration Tests

| Test Scenario                          | Description                                                       |
|----------------------------------------|-------------------------------------------------------------------|
| Atomic write crash simulation          | Kill process during write; verify state.json integrity.           |
| Event log torn-write recovery          | Truncate last line of events.jsonl; verify graceful recovery.     |
| Full lifecycle happy path              | Request goes intake -> monitor with stub sessions.                |
| Full lifecycle with review failures    | Request regresses 3 times at prd_review, then escalates.         |
| Concurrent request isolation           | Two requests in different repos advance independently.            |
| Stale heartbeat recovery               | Simulate machine sleep; verify request re-entry.                  |
| Schema migration                       | Load a v1 state file with a v2 codebase; verify migration.       |
| Cleanup and archival                   | Complete request, wait for retention, verify archive created.     |
| Lock file with dead PID               | Create lock file with non-existent PID; verify lock is stolen.   |

### 10.3 Property-Based Tests

The transition function is a good candidate for property-based testing:

- **Property 1:** Any valid state + valid event produces a valid state (or a well-formed error).
- **Property 2:** The `cancelled` state is absorbing: no event can leave it.
- **Property 3:** Phase history only grows; entries are never removed.
- **Property 4:** `updated_at` is always >= `created_at` and monotonically non-decreasing.
- **Property 5:** `cost_accrued_usd` is monotonically non-decreasing.

### 10.4 Chaos Tests

- Kill the supervisor at random points in the iteration loop (using `kill -9`). Verify no state corruption after 1000 iterations.
- Fill the disk during a state write. Verify the `.tmp` file is left and `state.json` is intact.
- Corrupt `state.json` with random bytes. Verify the system detects it and transitions to `failed`.

---

## 11. Trade-offs & Alternatives Considered

### 11.1 File-based State vs. SQLite

**Chosen: File-based JSON.**

Pros:
- Zero additional dependencies (NFR-06 requires only bash, jq, git).
- Human-readable; operators can inspect state with `cat` and `jq`.
- Atomic writes via `mv` are well-understood and battle-tested.
- Each request is self-contained in its own directory; no shared database to corrupt.

Cons:
- No built-in query capabilities. Finding all requests in `prd_review` requires scanning all state files.
- No transactions across multiple state files (but the single-writer model makes this unnecessary).

Alternative considered: SQLite. Rejected because it adds a dependency, is harder to inspect manually, and WAL mode complicates atomic crash recovery in a bash context.

### 11.2 Request ID: UUID vs. Date-Hex

**Chosen: `REQ-{YYYYMMDD}-{4-char-hex}`.**

Pros:
- Human-readable: the date component immediately tells you when the request was created.
- Short enough to type and reference in conversation.
- The prefix `REQ-` makes it greppable across logs and code.
- 65,536 possible IDs per day is far more than needed.

Cons:
- Not globally unique across all time and space (unlike UUIDv4).
- 4 hex characters is a small space if the system scales beyond expectations.

Alternative considered: UUIDv4. Rejected for poor human ergonomics. If the 4-hex space becomes a problem, the ID format can be extended to 6 or 8 hex characters in a future schema version.

### 11.3 Event Log: JSONL vs. Structured Log File vs. SQLite

**Chosen: Append-only JSONL.**

Pros:
- Append-only is the simplest write pattern and the most crash-safe.
- One JSON object per line is trivially parseable with `jq` and standard Unix tools.
- No locking or transactions needed.

Cons:
- No indexing. Querying by event type or time range requires a full scan.
- Torn writes on the last line require recovery logic.

Alternative considered: SQLite WAL for the event log. Rejected for the same reason as the state file: unnecessary dependency and complexity for a log that is primarily written and only occasionally read.

### 11.4 Checkpoint Strategy: Full Copy vs. Incremental Delta

**Chosen: Full copy of `state.json`.**

Pros:
- Simple to implement and reason about.
- A checkpoint is always self-contained; no need to reconstruct from a chain of deltas.
- State files are small (< 10 KB), so the overhead is negligible.

Cons:
- Slightly more disk usage than delta-based checkpoints.

Alternative considered: Storing only the diff between checkpoints. Rejected as premature optimization for files that are consistently < 10 KB.

### 11.5 Concurrency: Single-Writer vs. File Locking

**Chosen: Single-writer (one supervisor, one request per iteration).**

Pros:
- No locking complexity.
- No possibility of deadlock.
- Trivially correct: only one process writes any given state file.

Cons:
- Throughput limited to one phase per iteration. With a 30-second poll interval and 14 states, maximum throughput is approximately 14 state transitions per 7 minutes per concurrent request.
- Cannot parallelize multiple phases of the same request.

Alternative considered: File locking (`flock`) with multiple worker processes. Rejected for MVP. The single-host, single-writer model is sufficient for the target throughput (10+ requests/week). Parallelism across requests is supported by the priority queue; parallelism within a request is a future optimization.

---

## 12. Implementation Plan

### Phase 1: MVP (Weeks 1-2)

| Step | Component                    | Deliverable                                                  | Depends On |
|------|------------------------------|--------------------------------------------------------------|------------|
| 1    | Data models                  | `state.json` schema (v1), `events.jsonl` schema              | None       |
| 2    | State File Manager           | `read`, `write_atomic`, `validate_schema` functions          | Step 1     |
| 3    | Event Logger                 | `append`, `read_all`, torn-write recovery                    | Step 1     |
| 4    | Request Tracker              | `generate_id`, `discover_requests`, directory creation        | Step 2     |
| 5    | Lifecycle Engine (core)      | `transition` function with all forward/backward/meta rules   | Step 2, 3  |
| 6    | Lifecycle Engine (timeout)   | Timeout detection and retry/fail logic                       | Step 5     |
| 7    | Lifecycle Engine (checkpoint)| Checkpoint creation and restoration                          | Step 2, 5  |
| 8    | Unit tests                   | 75+ tests covering all transition rules                      | Step 5, 6, 7 |
| 9    | Integration with supervisor  | Wire lifecycle engine into the supervisor loop (TDD-001)     | Step 5     |

### Phase 2: Full (Weeks 3-4)

| Step | Component                    | Deliverable                                                  | Depends On |
|------|------------------------------|--------------------------------------------------------------|------------|
| 10   | Dependency evaluation        | `blocked_by` logic, circular detection                       | Step 5     |
| 11   | Cleanup & archival           | `archive_request`, automated cleanup, `cleanup` command      | Step 4     |
| 12   | Schema migration framework   | Migration registry, `migrate` function, v1 test fixtures     | Step 2     |
| 13   | Chaos tests                  | Kill-and-recover, disk-full, corruption injection             | Step 8     |
| 14   | Multi-repo support           | Discovery across multiple repos, per-project state dirs      | Step 4     |
| 15   | Performance validation       | Benchmark discovery with 100+ requests, state read/write latency | Step 14 |

---

## 13. Open Questions

| ID     | Question                                                                                                              | Impact                | Recommendation                                      | Status |
|--------|-----------------------------------------------------------------------------------------------------------------------|-----------------------|------------------------------------------------------|--------|
| TDD-OQ-1 | Should the `retry` command reset the retry counter for the target phase, or carry forward the count from the failed attempt? | Retry behavior      | Reset to zero. A retry is a deliberate human decision to give the phase a fresh set of attempts. | Proposed |
| TDD-OQ-2 | Should `paused` requests count toward the `max_concurrent_requests` cap?                                            | Capacity planning     | No. Paused requests are not consuming Claude Code sessions. Counting them would block new work unnecessarily. | Proposed |
| TDD-OQ-3 | Should the event log include supervisor-level events (heartbeat, iteration start) or only request-level events?      | Log volume            | Request-level only. Supervisor events belong in `daemon.log`. Mixing them inflates the event log with noise. | Proposed |
| TDD-OQ-4 | What is the maximum number of concurrent requests the file-scanning discovery model can support before performance degrades? | Scalability         | Benchmark needed. Estimate: 1000+ requests across 10 repos should scan in < 1 second with `jq`. | Open   |
| TDD-OQ-5 | Should `failed` requests auto-retry after a configurable cooldown, or always require manual intervention?            | Operator toil         | Manual for MVP (L0 trust). Auto-retry at L2+ trust. This aligns with the trust level model in FR-607. | Proposed |
| TDD-OQ-6 | How should the checkpoint directory be pruned if disk pressure is high?                                               | Disk management       | Keep only the most recent 5 checkpoints per request (already specified in 3.1.4). Under disk pressure, reduce to 1. | Proposed |
| TDD-OQ-7 | Should the `events.jsonl` file be fsynced after each append, or rely on OS buffer flushing?                          | Durability vs. perf   | No fsync on event append. The event log is supplementary to the state file; losing the last event on crash is acceptable. The state file (which IS fsynced) is authoritative. | Proposed |
| TDD-OQ-8 | PRD OQ-2 asks about event log rotation. Should we implement rotation in Phase 1 or defer?                           | Complexity            | Defer to Phase 2. Active request event logs stay under 1 MB. The 10 MB size guard (Section 3.2.3) is sufficient for MVP. | Proposed |

---

*End of TDD-002: State Machine & Request Lifecycle*
