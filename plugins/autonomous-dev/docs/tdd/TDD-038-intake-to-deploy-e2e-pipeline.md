---
governance:
  status: ready-for-review
  created_at: "2026-05-11T22:00:00Z"
  updated_at: "2026-05-11T22:00:00Z"
  phase: tdd
  jira_epic: ""
  slug: intake-to-deploy-e2e-pipeline
  prd_ref: intake-to-deploy-e2e-pipeline
  history:
    - status: ready-for-review
      timestamp: "2026-05-11T22:00:00Z"
      actor: tdd-author
---

# TDD-038: Intake-to-Deploy End-to-End Pipeline

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **TDD ID**  | TDD-038                                    |
| **Version** | 1.0                                        |
| **Date**    | 2026-05-11                                 |
| **Author**  | Patrick Watson                             |
| **Plugin**  | autonomous-dev                             |
| **PRD**     | PRD-019 v1.1                               |

---

## 1. Overview

This TDD specifies the technical changes required to wire the autonomous-dev pipeline end-to-end: from CLI submission through the daemon supervisor, per-phase agent dispatch via `claude --agent`, review gate cycling, portal state synchronization, and terminal completion. The system has accumulated 247 PRs of infrastructure -- intake layer, daemon supervisor, 18 agents, portal readers -- but no request has ever completed autonomously. This design connects the three broken seams:

1. **Submit-to-filesystem handoff**: The `initRouter()` function in `cli_adapter.ts` leaves three dependencies undefined, causing submit to crash. After fixing the wiring, the submit handler must write a `state.json` file using the FR-824a two-phase commit pattern so the daemon can discover work.

2. **Daemon-to-agent dispatch**: The daemon's `spawn_session()` currently invokes `claude --print` with no agent mapping. It must resolve the correct agent per phase (using `claude --agent <name>`) and construct phase-appropriate prompts containing prior artifacts and review feedback.

3. **Phase advancement and portal sync**: After each agent session, the daemon must read the `phase-result.json` output, advance the state machine, and write request-action files to the portal's backing store.

**PRD Reference**: `docs/prd/PRD-019-intake-to-deploy-e2e-pipeline.md`

---

## 2. Goals & Non-Goals

### Goals

- Fix `initRouter()` so `autonomous-dev request submit` succeeds without `claudeClient`, `duplicateDetector`, or `injectionRules` configured
- Implement the FR-824a two-phase `state.json` write on submit so the daemon discovers new requests via its existing filesystem scan
- Implement per-phase agent dispatch in the daemon using `claude --agent <name>` with the locked phase-to-agent mapping table
- Implement post-session phase advancement logic reading `phase-result.json` files, including review-failure retry loops
- Synchronize pipeline state to portal request-action files on every transition so the portal shows real-time progress
- Deliver an end-to-end smoke test that validates submit through at least one completed phase

### Non-Goals

- Modifying agent specifications (`agents/*.md`) -- they are defined and working
- Portal UI changes -- this TDD only writes the data files the portal already reads
- Multi-repo request routing or cross-repo coordination
- Per-request cost attribution in the portal cost panel
- Deploy backend logic changes (PRD-014 scope)
- Discord/Slack intake channels (PRD-008 Phase 3-4)
- Implementing `claudeClient` for NLP parsing or `duplicateDetector` for embedding-based dedup
- Parallel request processing (future PRD; single-threaded loop is acceptable for v1)

---

## 3. Strategic Alignment

- **Consistency**: All filesystem writes follow the existing atomic tmp+mv pattern used throughout `supervisor-loop.sh`. The `state.json` schema extends the existing structure read by `select_request()` and `validate_state_file()` -- no breaking changes. The portal request-action file format matches the `RequestActionFile` interface already consumed by `request-ledger-reader.ts`.

- **Technical debt**: This design resolves three long-standing TODO items: the `TODO(PLAN-011-1)` at `cli_adapter.ts:843`, the unimplemented FR-824a handoff from PRD-008, and the missing agent dispatch in `spawn_session()`. It introduces no new debt; all code paths are tested by the smoke test.

- **Long-term trajectory**: The phase-to-agent mapping is a simple lookup table that can be extended for new request types or pipeline variants (PRD-011) without structural changes. The `phase-result.json` contract establishes a clean agent-daemon boundary that supports future agent evolution (output format changes) without daemon modifications. The design keeps the daemon single-threaded for v1 but documents the exact point (`select_request` -> `spawn_session` loop in `main_loop()`) where parallel dispatch can be wired later.

---

## 4. System Architecture

### Component Diagram

```
+---------------------------+       +-----------------------------+
|  CLI (autonomous-dev)     |       |  Daemon (supervisor-loop)   |
|  cli_adapter.ts           |       |  supervisor-loop.sh         |
|                           |       |                             |
|  initRouter()  ---------->|       |  main_loop()                |
|    |                      |       |    |                        |
|    +-> IntakeRouter       |       |    +-> select_request()     |
|         |                 |       |    |   scan state.json files|
|         +-> SubmitHandler |       |    |                        |
|              |            |       |    +-> resolve_agent()  NEW |
|              +-> SQLite   |       |    |   phase -> agent name  |
|              |            |       |    |                        |
|              +-> state.json NEW   |    +-> spawn_session()      |
|                           |       |    |   claude --agent <name>|
+---------------------------+       |    |                        |
                                    |    +-> read phase-result    |
+---------------------------+       |    |   .json            NEW |
|  Portal (autonomous-dev-  |       |    |                        |
|  portal)                  |       |    +-> advance_phase()  NEW |
|                           |       |    |   update state.json    |
|  request-ledger-reader.ts |       |    |                        |
|    reads:                 |       |    +-> write_portal_    NEW |
|    request-actions/*.json |       |    |   request_action()     |
|    gate-decisions/*.json  |       |    |                        |
+---------------------------+       +----+------------------------+
                                         |
                                    +----v------------------------+
                                    |  Agent Session               |
                                    |  claude --agent prd-author   |
                                    |    --prompt <context>        |
                                    |    --print --output-format   |
                                    |    json --max-turns <N>      |
                                    |                              |
                                    |  Writes:                     |
                                    |    docs/prd/<slug>.md  (art) |
                                    |    phase-result-prd.json     |
                                    +------------------------------+
```

### Canonical Filesystem Layout

The following ASCII tree resolves the directory layout disambiguation deferred from the PRD. Both flat files (`<REQ-id>.json`) and subdirectories (`<REQ-id>/phase-result-*.json`) coexist under `request-actions/` because they are different filesystem node types (file vs. directory).

```
~/.autonomous-dev/
  portal/
    request-actions/
      REQ-000001.json              <-- portal summary (written by daemon on every state transition)
      REQ-000001/                  <-- per-request subdir (written by agent or spawn-session wrapper)
        phase-result-prd.json
        phase-result-prd_review.json
        phase-result-tdd.json
        ...
      REQ-000002.json
      REQ-000002/
        phase-result-prd.json
        ...
    gate-decisions/
      <repo>__<REQ-id>.json        <-- gate decisions (existing, unchanged)
  heartbeat.json                   <-- daemon heartbeat (existing)
  cost-ledger.json                 <-- cost ledger (existing)
  intake.db                        <-- SQLite intake database (existing)
  logs/
    daemon.log                     <-- daemon log (existing)
    session-REQ-000001-*.json      <-- session output (existing)

<target_repo>/
  .autonomous-dev/
    requests/
      REQ-000001/
        state.json                 <-- request lifecycle state
        events.jsonl               <-- event stream
        checkpoint.json            <-- session checkpoint
```

### Service Boundaries

- **CLI Adapter** (`cli_adapter.ts`): Constructs the `IntakeRouter` with optional deps, dispatches submit commands, and writes `state.json` after SQLite insertion
- **Daemon Supervisor** (`supervisor-loop.sh`): Discovers work via filesystem scan, resolves agent names per phase, spawns Claude sessions, reads phase results, advances the state machine, and syncs to portal
- **Agent Sessions** (`claude --agent <name>`): Stateless per-phase execution units that produce artifacts and write `phase-result.json` files
- **Portal Reader** (`request-ledger-reader.ts`): Read-only consumer of `request-actions/*.json` files; no changes required in this TDD

### Data Flow

1. Operator runs `autonomous-dev request submit "..." --repo <path> --type feature`
2. CLI adapter constructs `IntakeRouter` (with optional deps undefined), routes to `SubmitHandler`
3. `SubmitHandler` persists to SQLite, then writes `state.json` atomically to `<repo>/.autonomous-dev/requests/<id>/state.json` with `status: "queued"`, `current_phase: "intake"`
4. Daemon's `select_request()` scans allowlisted repos, finds the new `state.json`
5. Daemon transitions `intake` -> `prd`: sets `status: "running"`, `current_phase: "prd"`
6. Daemon resolves `prd` -> `prd-author` agent, builds phase prompt, spawns `claude --agent prd-author --prompt <prompt> --print --output-format json --max-turns 50`
7. Agent writes PRD artifact to repo and `phase-result-prd.json` to `~/.autonomous-dev/portal/request-actions/<REQ-id>/`
8. Daemon reads `phase-result-prd.json`, sees `status: "pass"`, advances to `prd_review`
9. Cycle repeats through `tdd`, `plan`, `spec`, `code`, `code_review`, `integration`, `deploy`
10. On terminal completion, daemon sets `status: "done"`, writes final portal action file

### Request Lifecycle State Machine

```
                             +----------+
                             |  queued   |   (status)
            submit creates   |  intake   |   (current_phase)
                             +----+-----+
                                  |
                    daemon picks up (first poll)
                                  |
                             +----v-----+
                             | running  |
                             |  prd     |   agent: prd-author
                             +----+-----+
                                  |
                        exit 0, result pass
                                  |
                             +----v-----+
                             |  gate    |
                             | prd_review|  agent: doc-reviewer
                             +----+-----+
                                  |
                     +------------+------------+
                     |                         |
               result: pass              result: fail
                     |                         |
                +----v-----+            +------v----+
                |  running |            |  running  |
                |   tdd    |            |   prd     | (retry w/ feedback)
                +----+-----+            +-----------+
                     |
                     ...  (tdd -> tdd_review -> plan -> ... -> deploy)
                     |
                +----v-----+
                |   done   |
                |  deploy  |   terminal state
                +----------+
```

---

## 5. Architectural Trade-offs

| Decision | Option A | Option B | Chosen | Rationale |
|----------|----------|----------|--------|-----------|
| **Agent output contract**: How does the daemon determine phase pass/fail? | Parse free-form session stdout/stderr for keywords ("PASS", "FAIL") | Agent (or wrapper) writes structured `phase-result-<phase>.json` to a known path | **Option B** | Parsing free-form output is fragile and breaks when agent prompts change. A structured file contract is a stable API boundary. The `spawn-session.sh` wrapper can synthesize the file from `--output-format json` output when agents do not produce it natively, so no agent spec changes are needed. |
| **state.json write location**: Where does the submit handler write state.json? | `~/.autonomous-dev/requests/<id>/state.json` (centralized, daemon-specific) | `<target_repo>/.autonomous-dev/requests/<id>/state.json` (per-repo, as PRD-001 defined) | **Option B** | The daemon's `select_request()` already scans `<repo>/.autonomous-dev/requests/*/state.json` across allowlisted repos. Writing to a centralized location would require a new scan path. Option B is backward-compatible with zero daemon changes to work discovery. |
| **Review feedback delivery**: How does retry feedback reach the generation agent? | Store feedback in `state.json` under `current_phase_metadata.review_feedback` and read from there in the phase prompt | Store feedback only in `phase-result-<review>.json` and inject from there | **Both** | `phase-result.json` is the primary source (written by reviewer agent). The daemon copies feedback into `state.json` so that `resolve_phase_prompt()` has a single place to read context. This dual-write is intentional: `phase-result.json` is the audit record; `state.json` is the runtime view. |
| **waitedMin computation** (OQ-019-06) | Track gate entry/exit timestamps in the daemon and compute elapsed minutes on each portal write | Record `gate_entered_at` in `state.json.phase_history` entries and compute delta at portal write time | **Option B** | Daemon-side timers are lost on restart. Recording the timestamp in `phase_history` persists through crashes and daemon restarts. The computation `(now - gate_entered_at) / 60000` is trivial at write time. |
| **code vs. integration boundary** (OQ-019-05) | `code-executor` creates branch, commits, AND creates PR; `integration` (test-executor) runs tests only | `code-executor` creates branch and commits code only; `integration` (test-executor) runs tests AND creates PR | **Option A** | PRD-001 defines integration as "Integration tests pass, PR created" but the PR is a natural output of a test-passing commit. The `code-executor` agent already has `Bash` tool access and can run `git checkout -b`, `git commit`, and `gh pr create`. Having the code agent own the full branch lifecycle (branch + commit + PR) keeps the code-to-review feedback loop tight -- if `code_review` fails, the code agent can amend the same branch. The `integration` phase (`test-executor`) then runs the integration test suite against the PR branch and reports pass/fail. The `deploy-executor` handles merge-to-main. |

---

## 6. Detailed Design

### 6.1 Data Model

#### SQLite Schema -- No Migration Required

The existing `requests` table schema (v3, migrations `001`-`003`) already contains all required columns. The `status` column CHECK constraint includes `'queued'` (which maps to the daemon's `queued` lifecycle state), and the `current_phase` column is a free-text field with no CHECK constraint, so it accepts the pipeline phases defined in FR-019-06a.

**Note**: The existing CHECK constraint on `status` includes `('queued', 'active', 'paused', 'cancelled', 'done', 'failed')` but the PRD's `status` domain is `('queued', 'running', 'gate', 'done', 'cancelled')`. The `submit_handler.ts` writes `status: 'queued'` which satisfies the CHECK. The daemon operates on `state.json` (no CHECK constraints), where `status` can be `running` or `gate`. The SQLite row's `status` field is only written at submit time (`queued`) and is not updated by the daemon -- the daemon reads/writes `state.json` exclusively. No schema migration is required.

#### `state.json` Schema (FR-019-06)

The `state.json` file is the canonical runtime state for a request. Written by the submit handler, read and updated by the daemon.

```json
{
  "id": "REQ-000001",
  "status": "queued",
  "current_phase": "intake",
  "priority": 1,
  "created_at": "2026-05-11T22:00:00Z",
  "updated_at": "2026-05-11T22:00:00Z",
  "title": "Add dark mode to dashboard",
  "description": "Full description text from the submit command",
  "target_repo": "/Users/pwatson/codebase/target-repo",
  "source": "cli",
  "type": "feature",
  "blocked_by": [],
  "phase_history": [],
  "current_phase_metadata": {},
  "cost_accrued_usd": 0,
  "turn_count": 0,
  "escalation_count": 0,
  "schema_version": 1,
  "error": null
}
```

**Field mapping from SQLite `RequestEntity` to `state.json`**:

| SQLite field | state.json field | Transform |
|-------------|-----------------|-----------|
| `request_id` | `id` | Direct |
| `status` | `status` | Direct (`queued`) |
| `current_phase` | `current_phase` | Direct (`intake`) |
| `priority` | `priority` | Map: `high`->0, `normal`->1, `low`->2 |
| `created_at` | `created_at` | Direct |
| `updated_at` | `updated_at` | Direct |
| `title` | `title` | Direct |
| `description` | `description` | Direct |
| `target_repo` | `target_repo` | Direct |
| `source_channel` | `source` | Direct |
| (from `--type` flag) | `type` | Default `feature` |

#### `phase-result-<phase>.json` Schema (FR-019-14)

Written by agents or the `spawn-session.sh` wrapper.

```json
{
  "status": "pass",
  "feedback": null,
  "artifacts": ["docs/prd/add-dark-mode.md"],
  "next_phase": null,
  "cost_usd": 1.25,
  "turns_used": 18,
  "completed_at": "2026-05-11T22:15:00Z"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | `"pass" \| "fail" \| "error"` | Yes | Phase outcome |
| `feedback` | `string \| null` | No | Review feedback for retry (only meaningful on `fail`) |
| `artifacts` | `string[]` | No | Relative file paths produced by the phase |
| `next_phase` | `string \| null` | No | Override for natural next phase |
| `cost_usd` | `number` | No | Session cost for cost tracking |
| `turns_used` | `number` | No | Number of turns consumed |
| `completed_at` | `string` | No | ISO-8601 completion timestamp |

#### Portal Request-Action File Schema (FR-019-16)

Written by the daemon on every state transition. Consumed by `request-ledger-reader.ts`.

```json
{
  "id": "REQ-000001",
  "repo": "/Users/pwatson/codebase/target-repo",
  "title": "Add dark mode to dashboard",
  "phase": "prd",
  "status": "running",
  "cost": 1.25,
  "variant": "feature",
  "createdAt": "2026-05-11T22:00:00Z",
  "completedAt": null,
  "score": 0,
  "turns": 18,
  "waitedMin": 0
}
```

This matches the `RequestActionFile` interface in `request-ledger-reader.ts:28-41` and the `DashboardRequest` interface in `render.ts:60-84`.

#### `events.jsonl` Event Schema

Appended by the daemon after each state transition. One JSON object per line.

```json
{
  "timestamp": "2026-05-11T22:10:00Z",
  "type": "state_transition",
  "request_id": "REQ-000001",
  "details": {
    "from_phase": "intake",
    "to_phase": "prd",
    "from_status": "queued",
    "to_status": "running",
    "session_cost_usd": 0,
    "turns_used": 0,
    "trigger": "daemon_pickup"
  }
}
```

### 6.2 API Design

No REST or GraphQL API changes. All interfaces are internal function signatures and filesystem contracts.

#### `initRouter()` Signature Change

File: `plugins/autonomous-dev/intake/adapters/cli_adapter.ts`, lines 848-882.

Current state: The function has a `TODO(PLAN-011-1)` comment at line 843. The `IntakeRouter` constructor at line 875 already accepts optional deps but the TODO obscures this.

Change: Remove the TODO comment. The existing code already passes `undefined` for the three optional deps because they are not included in the constructor arg. The fix is confirming the existing behavior works and removing the misleading TODO.

```typescript
// BEFORE (line 843-881):
// TODO(PLAN-011-1): wire claudeClient + duplicateDetector + injectionRules
export async function initRouter(): Promise<IntakeRouterLike> {
  // ... existing code ...
  return new IntakeRouter({
    authz,
    rateLimiter,
    db: repo,
    // TODO(PLAN-011-1): wire claudeClient + duplicateDetector + injectionRules
  });
}

// AFTER:
export async function initRouter(): Promise<IntakeRouterLike> {
  // ... existing code unchanged ...
  return new IntakeRouter({
    authz,
    rateLimiter,
    db: repo,
    // claudeClient, duplicateDetector, and injectionRules are intentionally
    // omitted. The SubmitHandler handles undefined deps gracefully:
    // - claudeClient undefined  -> skips NLP parse, uses raw description
    // - duplicateDetector undefined -> skips duplicate detection
    // - injectionRules undefined -> skips sanitization
  });
}
```

#### `writeStateJson()` -- New Function in Submit Handler

File: `plugins/autonomous-dev/intake/handlers/submit_handler.ts`, after line 227 (after `this.db.insertRequest(request)`).

```typescript
/**
 * Write state.json using the FR-824a two-phase commit pattern.
 * 1. Write to state.json.tmp.<pid>
 * 2. (SQLite already committed above)
 * 3. Atomically rename tmp -> state.json
 *
 * On rename failure, the SQLite row persists but state.json is absent.
 * The daemon will not discover the request, but the operator can retry
 * or manually create the state file.
 */
function writeStateJson(request: RequestEntity, targetRepo: string): void {
  const reqDir = path.join(targetRepo, '.autonomous-dev', 'requests', request.request_id);
  const stateFile = path.join(reqDir, 'state.json');
  const tmpFile = `${stateFile}.tmp.${process.pid}`;

  // Path traversal guard (FR-019-07)
  const resolvedDir = path.resolve(reqDir);
  const resolvedRepo = path.resolve(targetRepo);
  if (!resolvedDir.startsWith(resolvedRepo + path.sep) && resolvedDir !== resolvedRepo) {
    throw new Error('VALIDATION_ERROR: state.json path escapes target repo');
  }

  const priorityMap: Record<string, number> = { high: 0, normal: 1, low: 2 };

  const state = {
    id: request.request_id,
    status: 'queued',
    current_phase: 'intake',
    priority: priorityMap[request.priority] ?? 1,
    created_at: request.created_at,
    updated_at: request.updated_at,
    title: request.title,
    description: request.description,
    target_repo: targetRepo,
    source: request.source_channel,
    type: /* from flags */ 'feature',
    blocked_by: [],
    phase_history: [],
    current_phase_metadata: {},
    cost_accrued_usd: 0,
    turn_count: 0,
    escalation_count: 0,
    schema_version: 1,
    error: null,
  };

  fs.mkdirSync(reqDir, { recursive: true });
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpFile, stateFile);
}
```

#### `resolve_agent()` -- New Function in Daemon

File: `plugins/autonomous-dev/bin/supervisor-loop.sh`, new function after `resolve_max_turns()` (after line 934).

```bash
# resolve_agent(phase: string) -> string
#   Returns the agent name for the given pipeline phase.
#   Uses the locked phase-to-agent mapping from PRD-019 FR-019-10.
#
# Arguments:
#   $1 -- phase: The current pipeline phase (e.g., "prd", "code_review").
#
# Stdout:
#   Agent name string (e.g., "prd-author"), or empty string if unmapped.
resolve_agent() {
    local phase="${1:-}"
    case "${phase}" in
        prd)            echo "prd-author" ;;
        prd_review)     echo "doc-reviewer" ;;
        tdd)            echo "tdd-author" ;;
        tdd_review)     echo "doc-reviewer" ;;
        plan)           echo "plan-author" ;;
        plan_review)    echo "doc-reviewer" ;;
        spec)           echo "spec-author" ;;
        spec_review)    echo "doc-reviewer" ;;
        code)           echo "code-executor" ;;
        code_review)    echo "quality-reviewer" ;;
        integration)    echo "test-executor" ;;
        deploy)         echo "deploy-executor" ;;
        *)              echo "" ;;
    esac
}
```

#### `advance_phase()` -- New Function in Daemon

File: `plugins/autonomous-dev/bin/supervisor-loop.sh`, new function after `update_request_state()` (after line 1715).

```bash
# advance_phase(request_id, project) -> void
#   After a successful session, reads phase-result.json, determines the
#   next phase, and atomically updates state.json + events.jsonl + portal.
advance_phase() {
    local request_id="$1"
    local project="$2"

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"

    local current_phase
    current_phase=$(jq -r '.current_phase' "${state_file}")

    local portal_actions_dir="${HOME}/.autonomous-dev/portal/request-actions"
    local result_dir="${portal_actions_dir}/${request_id}"
    local result_file="${result_dir}/phase-result-${current_phase}.json"

    local result_status="pass"
    local result_feedback=""
    local result_artifacts=""
    local result_cost="0"
    local result_turns="0"

    if [[ -f "${result_file}" ]] && jq empty "${result_file}" 2>/dev/null; then
        result_status=$(jq -r '.status // "pass"' "${result_file}")
        result_feedback=$(jq -r '.feedback // ""' "${result_file}")
        result_artifacts=$(jq -r '.artifacts // [] | join(",")' "${result_file}")
        result_cost=$(jq -r '.cost_usd // 0' "${result_file}")
        result_turns=$(jq -r '.turns_used // 0' "${result_file}")
    else
        log_warn "phase-result file missing or corrupt for ${request_id}/${current_phase}. Treating as pass."
    fi

    # Determine next phase
    local is_review_phase=false
    [[ "${current_phase}" == *"_review" ]] && is_review_phase=true

    local next_phase=""
    local next_status=""

    if [[ "${is_review_phase}" == "true" && "${result_status}" == "fail" ]]; then
        # Review failed -- go back to the generation phase with feedback
        next_phase="${current_phase%_review}"
        next_status="running"

        # Copy feedback into state
        local tmp="${state_file}.tmp"
        jq --arg fb "${result_feedback}" \
            '.current_phase_metadata.review_feedback = $fb' \
            "${state_file}" > "${tmp}"
        mv "${tmp}" "${state_file}"
    elif [[ "${result_status}" == "pass" || "${result_status}" == "" ]]; then
        # Advance to next phase in sequence
        next_phase=$(next_phase_for_state "${state_file}")

        if [[ -z "${next_phase}" ]]; then
            # Terminal -- mark done
            next_status="done"
        elif [[ "${next_phase}" == *"_review" ]]; then
            next_status="gate"
        else
            next_status="running"
        fi
    else
        # Error -- leave in current phase, error status already handled by
        # update_request_state() in the error path
        return
    fi

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Record phase completion in phase_history
    local phase_entry
    phase_entry=$(jq -n \
        --arg phase "${current_phase}" \
        --arg status "${result_status}" \
        --arg ts "${ts}" \
        --arg cost "${result_cost}" \
        --arg turns "${result_turns}" \
        '{
            phase: $phase,
            status: $status,
            completed_at: $ts,
            cost_usd: ($cost | tonumber),
            turns_used: ($turns | tonumber)
        }')

    # Update state.json atomically
    local tmp="${state_file}.tmp"
    if [[ -n "${next_phase}" ]]; then
        jq --arg phase "${next_phase}" \
            --arg status "${next_status}" \
            --arg ts "${ts}" \
            --argjson entry "${phase_entry}" \
            '
            .current_phase = $phase |
            .status = $status |
            .updated_at = $ts |
            .phase_history += [$entry] |
            .turn_count = ((.turn_count // 0) + ($entry.turns_used // 0)) |
            if $status == "gate" then
                .current_phase_metadata.gate_entered_at = $ts
            else . end |
            if $status == "done" then
                .completed_at = $ts
            else . end
            ' "${state_file}" > "${tmp}"
    else
        jq --arg status "done" \
            --arg ts "${ts}" \
            --argjson entry "${phase_entry}" \
            '
            .status = "done" |
            .completed_at = $ts |
            .updated_at = $ts |
            .phase_history += [$entry]
            ' "${state_file}" > "${tmp}"
    fi
    mv "${tmp}" "${state_file}"

    # Append state_transition event
    local event
    event=$(jq -n \
        --arg ts "${ts}" \
        --arg req "${request_id}" \
        --arg from_phase "${current_phase}" \
        --arg to_phase "${next_phase:-done}" \
        --arg to_status "${next_status:-done}" \
        --arg cost "${result_cost}" \
        --arg turns "${result_turns}" \
        '{
            timestamp: $ts,
            type: "state_transition",
            request_id: $req,
            details: {
                from_phase: $from_phase,
                to_phase: $to_phase,
                to_status: $to_status,
                session_cost_usd: ($cost | tonumber),
                turns_used: ($turns | tonumber)
            }
        }')
    echo "${event}" >> "${events_file}"

    # Write portal request-action file
    write_portal_request_action "${request_id}" "${project}"

    log_info "Phase advanced: ${request_id} ${current_phase} -> ${next_phase:-DONE} (status=${next_status:-done})"
}
```

#### `write_portal_request_action()` -- New Function in Daemon

File: `plugins/autonomous-dev/bin/supervisor-loop.sh`, new function.

```bash
# write_portal_request_action(request_id, project) -> void
#   Writes/updates the portal request-action file for the given request.
#   Uses atomic tmp+mv pattern.
write_portal_request_action() {
    local request_id="$1"
    local project="$2"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"

    local portal_actions_dir="${HOME}/.autonomous-dev/portal/request-actions"
    mkdir -p "${portal_actions_dir}"  # FR-019-18

    local action_file="${portal_actions_dir}/${request_id}.json"
    local tmp="${action_file}.tmp.$$"

    # Compute waitedMin from phase_history gate timestamps (OQ-019-06 resolution)
    local waited_min=0
    local gate_entered
    gate_entered=$(jq -r '.current_phase_metadata.gate_entered_at // ""' "${state_file}" 2>/dev/null || echo "")
    if [[ -n "${gate_entered}" ]]; then
        local gate_epoch now_epoch
        gate_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${gate_entered}" +%s 2>/dev/null \
                     || date -u -d "${gate_entered}" +%s 2>/dev/null \
                     || echo "0")
        now_epoch=$(date -u +%s)
        if [[ ${gate_epoch} -gt 0 ]]; then
            waited_min=$(( (now_epoch - gate_epoch) / 60 ))
        fi
    fi

    jq -n \
        --arg id "${request_id}" \
        --arg state_file "${state_file}" \
        --argjson waited "${waited_min}" \
        '
        ($state_file | ltrimstr("") | . as $sf |
          (input | .) ) // {}
        ' < /dev/null 2>/dev/null || true

    # Read fields from state.json and build the action file
    jq --arg waited "${waited_min}" \
        '{
            id: .id,
            repo: .target_repo,
            title: .title,
            phase: .current_phase,
            status: (if .status == "queued" then "running"
                     elif .status == "gate" then "gate"
                     elif .status == "done" then "done"
                     else "running" end),
            cost: (.cost_accrued_usd // 0),
            variant: (.type // "feature"),
            createdAt: .created_at,
            completedAt: (.completed_at // null),
            score: (.current_phase_metadata.last_review_score // 0),
            turns: (.turn_count // 0),
            waitedMin: ($waited | tonumber)
        }' "${state_file}" > "${tmp}"

    mv "${tmp}" "${action_file}"
    log_info "Portal request-action updated: ${action_file}"
}
```

### 6.3 Event Architecture

No Kafka topics. The system uses filesystem-based event streams.

#### `events.jsonl` Event Types

| Event Type | Producer | Trigger | Key Fields |
|------------|----------|---------|------------|
| `state_transition` | Daemon | Phase advancement | `from_phase`, `to_phase`, `to_status`, `session_cost_usd`, `turns_used` |
| `session_complete` | Daemon | Successful session exit | `session_cost_usd`, `exit_code` (existing) |
| `session_error` | Daemon | Failed session exit | `session_cost_usd`, `exit_code`, `error` (existing) |
| `session_interrupted` | Daemon | Sleep/wake recovery | `recovery_action` (existing) |
| `retry_exhaustion` | Daemon | Max retries exceeded | `phase`, `retry_count`, `escalated_to` (existing) |

The `state_transition` event type is new. All other event types already exist in the daemon.

### 6.4 Caching Strategy

No Redis caching. The system operates entirely on local filesystem reads.

The daemon's `select_request()` function performs a filesystem scan on every poll iteration. At the expected scale (< 100 active requests across < 10 repos), this completes in < 1 second. If scale increases beyond this, the scan can be replaced with a SQLite query (using the existing `intake.db`) without changing the function interface.

### 6.5 Sequence Diagrams

#### Happy Path: Submit Through First Phase

```
Operator           CLI Adapter         SubmitHandler       SQLite      Filesystem       Daemon
  |                    |                    |                |              |              |
  |--- submit "..." -->|                    |                |              |              |
  |                    |-- initRouter() --->|                |              |              |
  |                    |    (optional deps  |                |              |              |
  |                    |     = undefined)   |                |              |              |
  |                    |                    |                |              |              |
  |                    |<-- router ---------|                |              |              |
  |                    |                    |                |              |              |
  |                    |-- route(submit) -->|                |              |              |
  |                    |                    |-- INSERT ----->|              |              |
  |                    |                    |<-- ok ---------|              |              |
  |                    |                    |                |              |              |
  |                    |                    |-- write tmp ---|------------->|              |
  |                    |                    |-- rename ----  |------------->|              |
  |                    |                    |     state.json |              |              |
  |                    |                    |                |              |              |
  |<-- {requestId} ----|<-- success --------|                |              |              |
  |                    |                    |                |              |              |
  |                    |                    |                |              |-- poll ------>|
  |                    |                    |                |              |              |
  |                    |                    |                |              | select_req() |
  |                    |                    |                |              | found REQ-001|
  |                    |                    |                |              |              |
  |                    |                    |                |              | intake->prd  |
  |                    |                    |                |              | update state |
  |                    |                    |                |              |              |
  |                    |                    |                |              | resolve_agent|
  |                    |                    |                |              | -> prd-author|
  |                    |                    |                |              |              |
  |                    |                    |                |              | spawn_session|
  |                    |                    |                |              | claude       |
  |                    |                    |                |              | --agent      |
  |                    |                    |                |              | prd-author   |
  |                    |                    |                |              |              |
  |                    |                    |                |              | <session runs|
  |                    |                    |                |              |  writes PRD  |
  |                    |                    |                |              |  + result>   |
  |                    |                    |                |              |              |
  |                    |                    |                |              | read result  |
  |                    |                    |                |              | advance_phase|
  |                    |                    |                |              | prd->prd_rev |
  |                    |                    |                |              |              |
  |                    |                    |                |              | write portal |
  |                    |                    |                |              | action file  |
```

#### Review Failure Retry Loop

```
Daemon                  Agent (doc-reviewer)      Filesystem
  |                           |                       |
  | spawn_session             |                       |
  | claude --agent            |                       |
  | doc-reviewer              |                       |
  |-------------------------->|                       |
  |                           |                       |
  |                           |-- phase-result ------>|
  |                           |   {status: "fail",    |
  |                           |    feedback: "..."}   |
  |                           |                       |
  |<-- exit 0 ----------------|                       |
  |                           |                       |
  | read phase-result-prd_review.json                 |
  | result_status = "fail"                            |
  | next_phase = "prd" (strip "_review")              |
  |                                                   |
  | update state.json:                                |
  |   current_phase = "prd"                           |
  |   status = "running"                              |
  |   review_feedback = feedback                      |
  |                                                   |
  | Next iteration: spawn prd-author                  |
  | with feedback in prompt                           |
```

---

## 7. Scalability Analysis

- **Expected load**: 1-3 concurrent requests across 1-5 repositories. Single operator. < 1 request per hour sustained.
- **Bottlenecks**: The daemon's single-threaded `select_request()` -> `spawn_session()` loop means only one request is processed per iteration. At 1-3 concurrent requests, this is acceptable -- each poll iteration processes one request, and the poll interval (30s default) ensures all requests are eventually serviced.
- **Horizontal scaling**: Not applicable. Single-operator, single-machine architecture. If parallel dispatch is needed, the existing `src/parallel/agent-spawner.ts` module can be wired into the main loop in a future PRD.
- **Data volume growth**: Each request produces ~10-20 files (state.json, events.jsonl, phase-result files, artifacts). At 10 requests/day * 20 files = 200 files/day. Filesystem scan in `select_request()` remains fast (< 1s) up to ~10,000 state files across all repos.
- **Cost ceiling**: Per-session cost is bounded by `--max-turns <N>`. The daemon's existing `check_cost_caps()` enforces daily (`$50` default) and monthly (`$500` default) cost caps. The per-phase turn budgets (defined in `resolve_max_turns()`) are: intake=10, prd/tdd/plan/spec=50, reviews=30, code=200, integration=100, deploy=30. At worst-case Sonnet 4 pricing (~$0.10/turn), the maximum single-session cost is: code phase = 200 turns * $0.10 = **$20**. The daily cap of $50 provides a hard ceiling of 2-3 code-phase sessions per day.

---

## 8. Security Considerations

- **Authentication**: The CLI adapter authenticates the operator via the `AuthzEngine` reading `~/.autonomous-dev/intake-auth.yaml`. The daemon runs as the same OS user. No cross-user access is possible.
- **Authorization**: The daemon only scans repos on the allowlist in `~/.claude/autonomous-dev.json`. The submit handler validates that `--repo` points to an existing directory (FR-019-07).
- **Path traversal**: `writeStateJson()` validates that the resolved `state.json` path begins with the target repo's absolute path using `path.resolve()` + `startsWith()` check. The request ID is validated against `^REQ-\d{6}$` (already enforced by `Repository.generateRequestId()`).
- **Agent name injection**: `resolve_agent()` uses a hardcoded `case` statement. The daemon never passes arbitrary strings as agent names to `claude --agent`. Unknown phases return an empty string and the daemon skips the request.
- **Prompt injection**: When `injectionRules` are absent (the v1 configuration), the system operates at trust level L1+ where the operator is the submitter. Raw description text passes through to agent prompts without sanitization. This is acceptable for single-operator use.

---

## 9. Observability Plan

### Log Events

The daemon writes structured JSONL to `~/.autonomous-dev/logs/daemon.log`. New log entries introduced by this design:

| Log Message Pattern | Level | When |
|-------------------|-------|------|
| `Spawning session: request=REQ-* phase=* agent=* max_turns=*` | INFO | Before spawning agent session |
| `Phase advanced: REQ-* <from> -> <to> (status=*)` | INFO | After successful phase advancement |
| `Portal request-action updated: <path>` | INFO | After writing portal file |
| `phase-result file missing or corrupt for REQ-*/*. Treating as pass.` | WARN | When phase-result.json is absent |
| `Intake->prd transition: REQ-* (type=feature)` | INFO | First daemon pickup of new request |

### Daemon Log Queries

To monitor pipeline health, the operator can use:

```bash
# Requests that advanced through at least one phase:
grep '"state_transition"' ~/.autonomous-dev/logs/daemon.log | jq .

# Requests stuck (no state_transition in last hour):
# Compare request-actions/*.json against events.jsonl timestamps

# Cost per request:
jq -r '.details.session_cost_usd' <repo>/.autonomous-dev/requests/REQ-*/events.jsonl
```

### Portal Observability

The portal's `/requests` surface displays real-time pipeline state by reading `request-actions/*.json` files. The `waitedMin` field (resolved in this TDD from OQ-019-06) surfaces how long a request has been waiting at a review gate, enabling the operator to identify stalled reviews.

### Alerting

Existing daemon alerting is sufficient:
- `circuit_breaker` alert: triggers after 3 consecutive crashes (existing)
- `retry_exhaustion` alert: triggers when a request exhausts retries in a phase (existing)
- `state_corruption` alert: triggers on unrecoverable state file corruption (existing)
- `cost_ledger_corruption` alert: triggers on corrupt cost ledger (existing)

---

## 10. Testing Strategy

### Unit Tests

**File: `plugins/autonomous-dev/intake/__tests__/unit/cli_adapter_initrouter.test.ts`** (new)

- `initRouter()` resolves without throwing when `claudeClient`, `duplicateDetector`, and `injectionRules` are all undefined
- `router.route({ command: 'submit', ... })` reaches the handler's `execute()` method
- Submit with valid description and `--repo` persists to SQLite with `title` and `target_repo` set
- Submit with same description twice succeeds both times (no duplicate detection when `duplicateDetector` is undefined)

**File: `plugins/autonomous-dev/intake/__tests__/unit/state_json_writer.test.ts`** (new)

- `writeStateJson()` creates `state.json` with correct schema version and all required fields
- `writeStateJson()` rejects request IDs not matching `^REQ-\d{6}$`
- `writeStateJson()` rejects `--repo` values containing `..` path traversal
- `writeStateJson()` performs atomic tmp+rename (verify no partial writes)
- `writeStateJson()` creates `requests/<id>/` directory if it does not exist
- Generated `state.json` passes the daemon's `validate_state_file()` function

**File: `plugins/autonomous-dev/tests/bats/resolve_agent.bats`** (new)

- `resolve_agent prd` returns `prd-author`
- `resolve_agent prd_review` returns `doc-reviewer`
- `resolve_agent tdd` returns `tdd-author`
- All 12 phase-to-agent mappings verified
- `resolve_agent unknown_phase` returns empty string

**File: `plugins/autonomous-dev/tests/bats/advance_phase.bats`** (new)

- After `prd` success, state transitions to `prd_review` with `status: "gate"`
- After `prd_review` pass, state transitions to `tdd` with `status: "running"`
- After `prd_review` fail, state transitions back to `prd` with `status: "running"` and `review_feedback` set
- After `deploy` completion, state transitions to `status: "done"` with `completed_at` set
- Missing `phase-result.json` treated as pass with warning logged
- Portal request-action file is written after each transition

### Integration Tests

**File: `plugins/autonomous-dev/intake/__tests__/integration/submit_to_state.test.ts`** (new)

- Full submit flow: CLI args -> `initRouter()` -> `SubmitHandler` -> SQLite row + `state.json` file
- Validates that the `state.json` file is parseable by `jq` and matches the schema
- Validates that `select_request()` in the daemon would find and select the written state file

### End-to-End Smoke Test (FR-019-19, FR-019-20)

**File: `plugins/autonomous-dev/test/e2e/smoke-e2e.sh`** (new)

```bash
#!/usr/bin/env bash
set -euo pipefail

# E2E smoke test for the intake-to-deploy pipeline.
# Validates: submit -> state.json -> daemon pickup -> prd phase -> artifact
#
# Prerequisites:
# - claude CLI installed and authenticated
# - autonomous-dev plugin installed
#
# Exit codes:
#   0 = all checks passed
#   1 = a check failed (diagnostic printed)
#   2 = test setup failed

# 1. Create temp repo
TMP_REPO=$(mktemp -d)
trap 'rm -rf "${TMP_REPO}"' EXIT
cd "${TMP_REPO}" && git init -b main && git commit --allow-empty -m "init"

# 2. Add to daemon allowlist (backup and restore)
CONFIG="${HOME}/.claude/autonomous-dev.json"
BACKUP="${CONFIG}.bak.smoke-$$"
cp "${CONFIG}" "${BACKUP}" 2>/dev/null || echo '{}' > "${BACKUP}"
jq --arg repo "${TMP_REPO}" \
  '.repositories.allowlist += [$repo] | .repositories.allowlist |= unique' \
  "${BACKUP}" > "${CONFIG}"

cleanup() {
  mv "${BACKUP}" "${CONFIG}" 2>/dev/null || true
  rm -rf "${TMP_REPO}"
}
trap cleanup EXIT

# 3. Submit request
echo "--- Submitting request ---"
OUTPUT=$(autonomous-dev request submit "Add a hello-world function" \
  --repo "${TMP_REPO}" --type feature 2>&1) || {
  echo "FAIL: submit command failed: ${OUTPUT}"
  exit 1
}

REQ_ID=$(echo "${OUTPUT}" | jq -r '.requestId // .data.requestId // empty' 2>/dev/null || echo "")
if [[ -z "${REQ_ID}" ]]; then
  echo "FAIL: could not extract request ID from submit output"
  exit 1
fi
echo "Request ID: ${REQ_ID}"

# 4. Verify state.json exists
STATE_FILE="${TMP_REPO}/.autonomous-dev/requests/${REQ_ID}/state.json"
if [[ ! -f "${STATE_FILE}" ]]; then
  echo "FAIL: state.json not found at ${STATE_FILE}"
  exit 1
fi

STATUS=$(jq -r '.status' "${STATE_FILE}")
PHASE=$(jq -r '.current_phase' "${STATE_FILE}")
if [[ "${STATUS}" != "queued" || "${PHASE}" != "intake" ]]; then
  echo "FAIL: expected status=queued, current_phase=intake; got status=${STATUS}, phase=${PHASE}"
  exit 1
fi
echo "PASS: state.json written with status=queued, current_phase=intake"

# 5. Run daemon in --once mode
echo "--- Running daemon --once ---"
"${HOME}/.claude/plugins/autonomous-dev/bin/supervisor-loop.sh" --once 2>&1 || {
  echo "WARN: daemon exited non-zero (may be expected if session fails)"
}

# 6. Verify phase advanced
STATUS=$(jq -r '.status' "${STATE_FILE}" 2>/dev/null || echo "unknown")
PHASE=$(jq -r '.current_phase' "${STATE_FILE}" 2>/dev/null || echo "unknown")
if [[ "${PHASE}" == "intake" ]]; then
  echo "FAIL: request still in intake phase after daemon run"
  exit 1
fi
echo "PASS: request advanced to phase=${PHASE}, status=${STATUS}"

# 7. Verify portal request-action file
ACTION_FILE="${HOME}/.autonomous-dev/portal/request-actions/${REQ_ID}.json"
if [[ -f "${ACTION_FILE}" ]]; then
  echo "PASS: portal request-action file exists"
else
  echo "WARN: portal request-action file not written (non-fatal for smoke)"
fi

# 8. Verify phase-result file
RESULT_FILE="${HOME}/.autonomous-dev/portal/request-actions/${REQ_ID}/phase-result-prd.json"
if [[ -f "${RESULT_FILE}" ]]; then
  echo "PASS: phase-result-prd.json exists"
else
  echo "WARN: phase-result-prd.json not written (agent may not produce it natively)"
fi

echo "--- Smoke test complete ---"
exit 0
```

Coverage target: 100% of new functions (unit); smoke test validates the full integration path.

---

## 11. Migration & Rollout Plan

### Phase 1: Submit Fix and State Handoff (Days 1-3)

1. **Remove TODO comment** in `cli_adapter.ts:843-844`. Verify the existing `IntakeRouter` constructor call at line 875-881 already passes `undefined` for optional deps. No functional code change needed -- just confirm and document the behavior.

2. **Implement `writeStateJson()`** in `submit_handler.ts` (after `this.db.insertRequest()` at line 227). Add the path traversal guard, request ID validation, atomic tmp+rename write, and `state.json` schema construction.

3. **Wire `writeStateJson()` into `SubmitHandler.execute()`** between the `insertRequest()` call (line 227) and the queue position query (line 229). Extract `targetRepo` from flags and pass it with the `RequestEntity`.

4. **Add request type propagation**: The `--type` flag value must be carried from CLI flags through the handler into `state.json`. Currently the handler does not extract the type flag; add it to the `RequestEntity` construction at line 199-225.

5. **Rebuild CLI**: `bun run build:cli`

6. **Unit tests**: `cli_adapter_initrouter.test.ts`, `state_json_writer.test.ts`

7. **Manual validation**: `autonomous-dev request submit "test request" --repo /tmp/test-repo --type feature` produces both SQLite row and `state.json`.

### Phase 2: Agent Dispatch and Phase Advancement (Days 3-7)

1. **Add `resolve_agent()` function** to `supervisor-loop.sh` after line 934. Hardcoded case statement with 12 mappings.

2. **Modify `spawn_session()`** (lines 1002-1087) to:
   - Read `current_phase` from `state.json` (currently reads `.status` at line 1018 -- change to `.current_phase`)
   - Call `resolve_agent(current_phase)` to get the agent name
   - If agent name is empty (unknown phase), log warning and skip
   - Replace the bare `claude --print` invocation (lines 1046-1052) with `claude --agent <agent-name> --prompt <prompt> --print --output-format json --max-turns <N>`
   - Call `spawn_session_typed()` from `spawn-session.sh` if the request has type-specific flags

3. **Update `resolve_phase_prompt()`** (lines 951-986) to include:
   - Prior-phase artifact paths (read from `phase_history` in `state.json`)
   - Review feedback (read from `current_phase_metadata.review_feedback`)
   - Output path expectation (where the agent should write its artifact)

4. **Add intake-to-prd transition** in `main_loop()` (after line 1924): When `current_phase == "intake"`, immediately transition to `prd` (or type-appropriate first phase) without spawning a session.

5. **Add `advance_phase()` function** after `update_request_state()`. Reads `phase-result.json`, determines next phase, updates state atomically.

6. **Wire `advance_phase()` into `main_loop()`** success path (line 1949): After `update_request_state()` with `outcome=success`, call `advance_phase()`.

7. **Add `write_portal_request_action()` function** and call it from `advance_phase()` and from the intake-to-prd transition.

8. **Add phase-result synthesis to `spawn-session.sh`**: After the `claude` invocation, if `phase-result-<phase>.json` does not exist, synthesize it from the session output JSON.

9. **Bats tests**: `resolve_agent.bats`, `advance_phase.bats`

### Phase 3: Portal Sync and Smoke Test (Days 7-10)

1. **Ensure `mkdir -p`** for `~/.autonomous-dev/portal/request-actions/` before first write (FR-019-18). Add to `write_portal_request_action()`.

2. **Implement `waitedMin` computation** in `write_portal_request_action()`: Read `gate_entered_at` from `current_phase_metadata`, compute `(now - gate_entered_at) / 60`.

3. **Build smoke test** at `plugins/autonomous-dev/test/e2e/smoke-e2e.sh`. Mark as executable.

4. **Integration test**: `submit_to_state.test.ts` validates the full submit-to-state.json flow.

5. **Manual validation**: Submit a request, run daemon `--once`, verify portal shows the request.

### Rollback Plan

- **Phase 1 rollback**: Revert the `writeStateJson()` addition in `submit_handler.ts`. SQLite persistence continues to work. The daemon will not discover new requests (returns to pre-PR state).
- **Phase 2 rollback**: Revert `spawn_session()` and `main_loop()` changes. The daemon returns to its current behavior (spawning sessions without agent mapping, no phase advancement).
- **Phase 3 rollback**: Remove `write_portal_request_action()` calls. The portal returns to showing empty request tables.

All phases are independently revertible. No database migrations are involved. All filesystem writes are additive (new files/directories).

---

## 12. Risks & Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Agent sessions produce malformed output that `spawn-session.sh` cannot parse into a valid `phase-result.json` | High | High | The wrapper synthesizes a minimal `{status: "pass"}` from exit code when parsing fails. Missing `phase-result.json` after exit 0 is treated as pass with a WARN log (FR-019-14 AC). |
| Phase prompts are insufficient for agents to produce quality artifacts, leading to repeated review failures | Medium | High | Start with minimal prompts (request description + prior artifacts). Measure first-attempt review pass rate in the smoke test. Iterate on phase prompts in follow-up PRs without daemon code changes. |
| `state.json` schema drift between what `writeStateJson()` produces and what `validate_state_file()` / `select_request()` expect | Medium | High | The smoke test (FR-019-19) validates the full path: submit -> state.json -> daemon pickup. The `state_json_writer.test.ts` unit test explicitly runs the output through the daemon's `validate_state_file()` function. |
| Daemon single-threaded loop starves lower-priority requests when a high-priority request is retrying repeatedly | Medium | Medium | Acceptable for v1 (1-3 requests). The existing `MAX_RETRIES_PER_PHASE` (default 3) with exponential backoff (`compute_next_retry_after()`) ensures a failing request does not monopolize the loop. |
| Portal `readRequestLedger()` cannot distinguish between `request-actions/<REQ-id>.json` (flat file) and `request-actions/<REQ-id>/` (directory) since `readdir()` returns both | Low | Medium | `readdir().filter(f => f.endsWith('.json'))` in `request-ledger-reader.ts:99` already filters to `.json` files only. Directories do not end in `.json`, so they are skipped automatically. No reader changes needed. |
| Cost ceiling breach during code phase (200 turns at Sonnet pricing) | Low | Medium | Existing `check_cost_caps()` enforces daily cap ($50 default). Worst-case single session cost is ~$20 for code phase. Operator can adjust `daemon.daily_cost_cap_usd` in config. |

### Open Questions

All questions resolved. The two PRD-deferred questions are addressed in this TDD:

- **OQ-019-05 (code vs. integration boundary)**: Resolved in Section 5 (Trade-offs). The `code-executor` agent creates the branch, commits code, and creates the PR. The `test-executor` (integration phase) runs the integration test suite against the PR branch. The `deploy-executor` handles merge-to-main.

- **OQ-019-06 (waitedMin computation)**: Resolved in Section 5 (Trade-offs) and Section 6.2 (`write_portal_request_action()`). The daemon records `gate_entered_at` in `state.json.current_phase_metadata` when a request enters a `_review` phase. On each portal write, `waitedMin` is computed as `(now - gate_entered_at) / 60`.

---

## 13. Work Breakdown

| Task | Estimate | Dependencies | Phase |
|------|----------|--------------|-------|
| Remove TODO in `initRouter()`, confirm optional deps behavior | 0.5 day | None | Phase 1 |
| Implement `writeStateJson()` in submit_handler.ts | 1 day | None | Phase 1 |
| Wire `writeStateJson()` into SubmitHandler.execute() with type propagation | 0.5 day | writeStateJson | Phase 1 |
| Unit tests for initRouter + state.json writer | 1 day | writeStateJson | Phase 1 |
| Add `resolve_agent()` to supervisor-loop.sh | 0.5 day | None | Phase 2 |
| Modify `spawn_session()` for agent dispatch | 1 day | resolve_agent | Phase 2 |
| Update `resolve_phase_prompt()` for prior artifacts + feedback | 1 day | spawn_session | Phase 2 |
| Add intake-to-prd transition in main_loop | 0.5 day | None | Phase 2 |
| Implement `advance_phase()` | 1.5 days | spawn_session, resolve_agent | Phase 2 |
| Add phase-result synthesis to spawn-session.sh | 0.5 day | advance_phase | Phase 2 |
| Bats tests for resolve_agent + advance_phase | 1 day | resolve_agent, advance_phase | Phase 2 |
| Implement `write_portal_request_action()` with waitedMin | 0.5 day | advance_phase | Phase 3 |
| Build smoke test script | 1 day | All Phase 1 + 2 | Phase 3 |
| Integration test for submit-to-state flow | 0.5 day | Phase 1 | Phase 3 |
| Manual validation + documentation | 0.5 day | All | Phase 3 |
| **Total** | **~10 days** | | |

---

## 14. PRD Requirements Traceability

| PRD Requirement | TDD Section | Acceptance Criteria | Coverage |
|----------------|-------------|---------------------|----------|
| FR-019-01: `initRouter()` constructs submit handler with optional deps | Section 6.2 (API Design: initRouter), Section 11 Phase 1 step 1 | `initRouter()` resolves without throwing when all three deps are undefined; `router.route({command:'submit',...})` reaches handler's `execute()` | Full |
| FR-019-02: When `claudeClient` undefined, NLP parsing skipped | Section 6.2 (API Design: initRouter), Section 10 (Unit Tests) | Submit with `claudeClient=undefined` persists row with `title = raw description truncated to 100 chars` | Full |
| FR-019-03: When `duplicateDetector` undefined, dedup skipped; when `injectionRules` undefined/empty, sanitization skipped | Section 6.2 (API Design: initRouter), Section 10 (Unit Tests) | Submitting same description twice succeeds both times; injection-triggering text passes through | Full |
| FR-019-04: `initRouter()` resolves TODO(PLAN-011-1) by wiring optional deps | Section 6.2 (API Design: initRouter), Section 11 Phase 1 step 1 | TODO comment removed; `initRouter()` returns functional router | Full |
| FR-019-05: Submit handler writes `state.json` using FR-824a two-phase commit | Section 6.2 (API Design: writeStateJson), Section 11 Phase 1 steps 2-3 | After submit, both SQLite row and `<repo>/.autonomous-dev/requests/<id>/state.json` exist with matching fields | Full |
| FR-019-06: `state.json` contains all fields required by daemon | Section 6.1 (state.json schema), Section 6.2 (writeStateJson) | `state.json` contains all 18 fields listed in FR-019-06; daemon's `validate_state_file()` accepts it | Full |
| FR-019-06a: Dual `status`/`current_phase` fields with canonical domain mapping | Section 4 (State Machine), Section 6.1 (state.json schema), Section 6.2 (writeStateJson) | `state.json` has separate `status: "queued"` and `current_phase: "intake"` fields; daemon filters on `status` and dispatches on `current_phase` | Full |
| FR-019-07: Request ID validation + path traversal prevention | Section 6.2 (writeStateJson path traversal guard), Section 8 (Security) | Submit with `--repo` containing `..` fails with `VALIDATION_ERROR`; request ID matches `^REQ-\d{6}$` | Full |
| FR-019-08: Daemon `select_request()` continues to scan filesystem | Section 4 (Data Flow step 4), Section 6.2 (no changes to select_request) | After FR-019-05, daemon's `--once` finds the newly-submitted request | Full |
| FR-019-09: `intake` is bookkeeping only; daemon transitions queued/intake -> running/prd | Section 4 (State Machine), Section 6.2 (advance_phase), Section 11 Phase 2 step 4 | After daemon pickup, `state.json` shows `status: "running"`, `current_phase: "prd"`; `events.jsonl` has transition event | Full |
| FR-019-10: Phase-to-agent mapping table (12 entries) | Section 6.2 (resolve_agent), Section 10 (Bats tests) | `resolve_agent(phase)` returns correct agent name for all 12 phases; unit test covers all mappings | Full |
| FR-019-11: `spawn_session()` uses `claude --agent <name>` | Section 6.2 (spawn_session modification), Section 11 Phase 2 step 2 | `claude` invocation includes `--agent prd-author` for prd phase; log shows `agent=prd-author` | Full |
| FR-019-12: Phase prompt includes prior artifacts and review feedback | Section 6.2 (resolve_phase_prompt update), Section 11 Phase 2 step 3 | Prompt for `tdd` phase includes PRD path; prompt for `prd` retry includes review feedback | Full |
| FR-019-13: Phase advancement after successful session | Section 6.2 (advance_phase), Section 6.5 (Sequence Diagrams) | After `prd` exit 0, state shows `current_phase: "prd_review"`, `status: "gate"`; events.jsonl has transition | Full |
| FR-019-14: Phase agents write `phase-result-<phase>.json`; daemon reads it for review outcome | Section 4 (Filesystem Layout), Section 6.1 (phase-result schema), Section 6.2 (advance_phase) | `phase-result-prd_review.json` with `status: "fail"` and `feedback` causes state to revert to `prd` with feedback set | Full |
| FR-019-15: Terminal phase sets `status: "done"` with `completed_at` | Section 6.2 (advance_phase terminal handling) | Completed request has `status: "done"` and non-null `completed_at` | Full |
| FR-019-16: Portal request-action file written on every state transition | Section 6.1 (Portal action schema), Section 6.2 (write_portal_request_action) | `readRequestLedger()` returns non-empty array after intake->prd transition; entry has `phase: "prd"`, `status: "running"` | Full |
| FR-019-17: Portal status reflects gate state during reviews | Section 6.2 (advance_phase sets gate status), Section 6.2 (write_portal_request_action) | Portal shows `status: "gate"` during `prd_review`; `status: "running"` after transition to `tdd` | Full |
| FR-019-18: Daemon creates `request-actions/` dir if absent; atomic writes | Section 6.2 (write_portal_request_action: mkdir -p), Section 12 (Risks) | `mkdir -p` runs before first write; no `ENOENT` in logs | Full |
| FR-019-19: End-to-end smoke test | Section 10 (Smoke Test), Section 11 Phase 3 step 3 | Smoke test exits 0 on correctly-configured system; exits non-zero with diagnostic on failure | Full |
| FR-019-20: Smoke test runnable in CI | Section 10 (Smoke Test notes) | Smoke test completes < 10 minutes; documents API key requirement if needed | Full |
