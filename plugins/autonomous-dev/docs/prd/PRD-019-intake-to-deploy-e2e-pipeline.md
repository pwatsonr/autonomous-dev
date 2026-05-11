---
governance:
  status: ready-for-review
  created_at: "2026-05-11T12:00:00Z"
  updated_at: "2026-05-11T17:30:00Z"
  phase: prd
  jira_epic: ""
  slug: intake-to-deploy-e2e-pipeline
  history:
    - status: ready-for-review
      timestamp: "2026-05-11T12:00:00Z"
      actor: product-manager
    - status: ready-for-review
      timestamp: "2026-05-11T17:30:00Z"
      actor: product-manager
      note: "v1.1 revision addressing PRD reviewer findings"
---

# PRD-019: Intake-to-Deploy End-to-End Pipeline

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **Title**   | Intake-to-Deploy End-to-End Pipeline        |
| **PRD ID**  | PRD-019                                    |
| **Version** | 1.1                                        |
| **Date**    | 2026-05-11                                 |
| **Author**  | Patrick Watson                             |
| **Status**  | Ready for Review                           |
| **Plugin**  | autonomous-dev                             |

---

## Changelog

### v1.1 (2026-05-11)

Revision addressing PRD reviewer findings:

- **MAJOR-1 (OQ-019-01)**: Locked agent dispatch mechanism. The `claude` CLI `--agent <name>` flag is verified. FR-019-11 updated to use `claude --agent <agent-name> --prompt <phase-prompt> --print --output-format json --max-turns <N>`. OQ-019-01 removed from Open Questions.
- **MAJOR-2 (OQ-019-02)**: Locked review pass/fail detection. Phase agents write `phase-result.json` to `~/.autonomous-dev/portal/request-actions/<REQ-id>/phase-result-<phase>.json`. FR-019-14, FR-019-12, FR-019-10 updated. OQ-019-02 removed from Open Questions.
- **MINOR-1**: FR-019-01/02/03 rewritten to scope changes to `initRouter()` only; `submit_handler.ts` already supports optional deps.
- **MINOR-2**: New FR-019-06a added specifying `status` vs `current_phase` field mapping in SQLite and `state.json`.
- **MINOR-3 (OQ-019-04)**: Locked `intake` as bookkeeping-only state. FR-019-09 updated. OQ-019-04 removed from Open Questions.
- Open Questions reduced from 6 to 2 (OQ-019-05 and OQ-019-06 remain as TDD-level decisions).

---

## 1. Problem Statement

The autonomous-dev system has accumulated 18 prior PRDs, a working CLI intake layer (PRD-008), a functional daemon supervisor (PRD-001), 18 defined agents (PRD-003/012), a portal with live readers (PRD-018/PLAN-038), and pipeline variant routing (PRD-011). Despite all of these subsystems existing and individually working, no request has ever been autonomously processed from submission through to a merged commit. The pipeline is broken at three critical seams.

- **Current state**: Running `autonomous-dev request submit "<description>" --repo <path> --type feature` passes validation but fails with `INTERNAL_ERROR` at persistence time. The `initRouter()` function in `cli_adapter.ts:829` has a `TODO(PLAN-011-1)` that leaves three dependencies undefined (`claudeClient`, `duplicateDetector`, `injectionRules`), causing the submit handler to crash when it reaches NLP parsing or duplicate detection stages. Even if submission were fixed, the daemon's `main_loop()` in `supervisor-loop.sh:1889` calls `select_request()` which scans `.autonomous-dev/requests/*/state.json` files on the filesystem -- but the intake layer only writes to SQLite, never producing a `state.json` file (the FR-824a two-phase handoff from PRD-008 was specified but never implemented). And even if requests appeared as `state.json` files, the daemon's `spawn_session()` at line 1002 sends a raw prompt to `claude --print` with no agent mapping -- it does not select from the 18 agents in `plugins/autonomous-dev/agents/*.md` or advance the request through the phase state machine. Finally, the daemon never writes request-progress files to `~/.autonomous-dev/portal/request-actions/`, so the portal's request-ledger reader (PLAN-038 TASK-010) returns empty arrays and the operator sees blank tables.

- **Desired state**: An operator runs `autonomous-dev request submit "Add dark mode to the dashboard" --repo /path/to/repo --type feature`, the request persists to both SQLite and `state.json`, the daemon picks it up within one poll interval, and the pipeline autonomously advances through PRD -> TDD -> Plan -> Spec -> Code -> Review -> Deploy, spawning the correct agent for each phase, writing progress to the portal's request-actions directory, and ultimately producing a merged commit on the target repo's branch. The operator can monitor progress in the portal in real time.

- **Business impact**: Until this pipeline works end-to-end, the autonomous-dev system is a collection of disconnected subsystems with zero real utility. No request has ever been autonomously completed. This PRD is the integration work that transforms 247 PRs of infrastructure into a product that delivers its core value proposition: submit a request and walk away while the system ships it.

---

## 2. Goals & Success Metrics

| Metric | Baseline | Target | Measurement Method |
|--------|----------|--------|--------------------|
| E2E request completion rate | 0% (no request has ever completed) | 80% of submitted feature requests reach `deploy` state without manual intervention at trust level L2 | Count of requests reaching `deploy` vs. total submitted, from `events.jsonl` audit logs per request |
| Submit-to-intake latency | N/A (submit fails) | p95 < 3 seconds from CLI invocation to `state.json` written and SQLite row committed | Timestamp delta between CLI process start and `state.json` mtime |
| Daemon pickup latency | N/A (daemon never picks up requests) | Within 1 poll interval (default 30 seconds) of `state.json` being written, daemon begins processing | Delta between `state.json` `created_at` and first `events.jsonl` entry for `prd` phase entry |
| Phase-to-agent mapping accuracy | 0% (no agent mapping exists) | 100% of phases dispatch to the correct agent as defined in `agents/*.md` | Unit test coverage on the phase-to-agent mapping table; verified by smoke test |
| Portal request visibility | 0 requests visible (empty tables) | 100% of in-flight requests appear in the portal with current phase, status, and cost | Portal request-ledger reader returns non-empty arrays; verified by comparing portal output to `state.json` ground truth |
| Single-request cycle time (intake to deploy) | Infinite (never completes) | < 4 hours for a small feature request (< 500 LOC change) at trust level L2 | Wall-clock delta from intake timestamp to deploy timestamp in `events.jsonl` |

---

## 3. User Personas

### System Operator (Patrick)
- **Role**: Engineer who installed, configured, and operates the autonomous-dev daemon on a development workstation running macOS. Has admin role in `~/.autonomous-dev/intake-auth.yaml`. Monitors the portal daily.
- **Goals**: Submit feature requests via CLI and watch them flow through the pipeline to merged commits without manual intervention. Diagnose stalled requests by inspecting portal dashboards and daemon logs.
- **Pain points**: Has invested effort in 247 PRs of infrastructure. Runs `autonomous-dev request submit` and gets `INTERNAL_ERROR`. Opens the portal and sees empty request tables. Cannot verify that the system works because the pipeline has never completed a single request end-to-end.

### Code Consumer (Downstream Developer)
- **Role**: Developer maintaining the target repository who receives PRs generated by autonomous-dev.
- **Goals**: Review and merge system-generated PRs with confidence that they have passed quality gates. Understand which request produced a given PR and what phase it came from.
- **Pain points**: Has never received a PR from the system because the pipeline stalls before reaching the code phase.

---

## 4. User Stories

### Happy Path

- **US-019-01** (P0): As a System Operator, I want to run `autonomous-dev request submit "Add dark mode to dashboard" --repo /path/to/repo --type feature` and have the request persist to both SQLite and a `state.json` file so that the daemon can discover and process it.
- **US-019-02** (P0): As a System Operator, I want the daemon's next poll iteration to discover the newly-persisted `state.json`, select it as actionable work, and begin processing it so that I do not have to manually trigger pipeline execution.
- **US-019-03** (P0): As a System Operator, I want each pipeline phase to dispatch the correct agent (e.g., `prd-author` for the `prd` phase, `code-executor` for the `code` phase) so that each phase produces the right artifact using the right model and tools.
- **US-019-04** (P0): As a System Operator, I want the pipeline to advance the request through all phases (PRD -> TDD -> Plan -> Spec -> Code -> Review -> Deploy) automatically, writing state transitions to `events.jsonl` and updating `state.json` after each phase, so that I can trace the full lifecycle.
- **US-019-05** (P0): As a System Operator, I want the daemon to write request progress to `~/.autonomous-dev/portal/request-actions/<id>.json` after every state transition so that the portal's request-ledger reader shows real-time pipeline progress.
- **US-019-06** (P1): As a System Operator, I want to run an end-to-end smoke test that submits a request, verifies the daemon picks it up, completes at least the PRD phase, and produces a `docs/prd/*.md` artifact so that I can validate the pipeline is operational.

### Edge Cases

- **US-019-07** (P0): As a System Operator, when `claudeClient` is not configured, I want the submit handler to skip NLP parsing gracefully (using the raw description as the title, and flag overrides for repo/priority/deadline) so that submission succeeds without requiring an external API call.
- **US-019-08** (P0): As a System Operator, when `duplicateDetector` is not configured, I want the submit handler to skip duplicate detection gracefully so that submission succeeds without requiring an embedding store.
- **US-019-09** (P0): As a System Operator, when a phase's agent session exits with non-zero, I want the daemon to follow the existing retry/escalation logic (retry up to `MAX_RETRIES_PER_PHASE`, then escalate) rather than crashing the daemon or silently dropping the request.
- **US-019-10** (P1): As a System Operator, when the pipeline is at a `_review` phase and the review fails, I want the daemon to transition back to the preceding generation phase with feedback (e.g., `prd_review` failure returns to `prd` with review comments) so that the agent can improve its output.
- **US-019-11** (P1): As a Code Consumer, when the pipeline reaches the `code` phase, I want the code-executor agent to produce changes on a branch named `autonomous/<request-id>` and create a PR so that I receive a reviewable PR with context linking back to the request.

### Error States

- **US-019-12** (P0): As a System Operator, when the submit handler encounters a filesystem error writing `state.json` (permission denied, disk full), I want the SQLite transaction to be rolled back and a clear error message returned to the CLI so that no orphaned state exists.
- **US-019-13** (P0): As a System Operator, when the daemon encounters a `state.json` with an unrecognized phase in its `current_phase` field, I want it to log a warning and skip that request (not crash) so that one corrupt request does not block all other requests.

---

## 5. Functional Requirements

### 5.1 Submit Router Fix: Graceful Construction with Optional Dependencies

- **FR-019-01** (P0): The `initRouter()` function in `cli_adapter.ts` SHALL construct the submit handler with `claudeClient`, `duplicateDetector`, and `injectionRules` as optional (possibly undefined) dependencies. The router SHALL be constructable with only `authz`, `rateLimiter`, and `db` provided. Note: the `submit_handler.ts` already supports optional deps -- it guards each one with `if (this.deps.X)` checks at `submit_handler.ts:92-196`. No handler changes are required; this FR addresses only the `initRouter()` wiring at `cli_adapter.ts:843-880`. -- **Acceptance criterion**: `initRouter()` resolves without throwing when `claudeClient`, `duplicateDetector`, and `injectionRules` are all undefined; `router.route({ command: 'submit', ... })` reaches the handler's `execute()` method.

- **FR-019-02** (P0): When `claudeClient` is undefined, the existing submit handler gracefully skips the NLP parsing stage (Stage 2), using the raw description truncated to 100 characters as the title and `null` for NLP-derived fields. No handler changes are required; this FR confirms the existing behavior. The `initRouter()` fix in FR-019-01 is the only code change needed to enable this path. -- **Acceptance criterion**: `autonomous-dev request submit "Add dark mode" --repo /path/to/repo` persists a row in SQLite with `title = "Add dark mode"` and `target_repo = "/path/to/repo"` when `claudeClient` is undefined.

- **FR-019-03** (P0): When `duplicateDetector` is undefined, the existing submit handler gracefully skips the duplicate detection stage (Stage 3). When `injectionRules` is undefined or an empty array, the existing submit handler skips the sanitization stage (Stage 1). No handler changes are required; this FR confirms the existing behavior. The `initRouter()` fix in FR-019-01 is the only code change needed. -- **Acceptance criterion**: Submitting the same description twice succeeds both times when `duplicateDetector` is undefined. A description containing text that would trigger injection rules passes when `injectionRules` is empty.

- **FR-019-04** (P0): The `initRouter()` function SHALL resolve the `TODO(PLAN-011-1)` at `cli_adapter.ts:843-880` by wiring the three optional deps from config when available, and passing `undefined` when not. No new config schema is required -- the deps are simply omitted from the handler constructor arguments. -- **Acceptance criterion**: `initRouter()` resolves without throwing; `router.route({ command: 'submit', ... })` reaches the handler's `execute()` method.

### 5.2 State.json Handoff on Submit

- **FR-019-05** (P0): On successful SQLite insertion of a new request, the submit handler SHALL write a `state.json` file to `<target_repo>/.autonomous-dev/requests/<request_id>/state.json` using the FR-824a two-phase commit pattern: (1) write a temporary file `state.json.tmp.<pid>`, (2) commit the SQLite transaction, (3) atomically `rename()` the temp file to `state.json`. If the rename fails, the SQLite transaction SHALL be rolled back. -- **Acceptance criterion**: After a successful `submit`, both `SELECT * FROM requests WHERE request_id = ?` returns a row AND `<repo>/.autonomous-dev/requests/<id>/state.json` exists with matching `id`, `status`, `priority`, `target_repo`, `title`, `created_at`.

- **FR-019-06** (P0): The `state.json` written by the submit handler SHALL contain all fields required by the daemon's `select_request()` and `spawn_session()` functions: `id`, `status` (set to `queued`), `current_phase` (set to `intake`), `priority` (integer: high=0, normal=1, low=2), `created_at`, `updated_at`, `title`, `description`, `target_repo`, `source`, `type` (from `--type` flag, default `feature`), `blocked_by` (empty array), `phase_history` (empty array), `current_phase_metadata` (empty object), `cost_accrued_usd` (0), `turn_count` (0), `escalation_count` (0), `schema_version` (1), `error` (null). -- **Acceptance criterion**: The daemon's `validate_state_file()` and `select_request()` accept the written file without errors.

- **FR-019-06a** (P0): The system SHALL use two separate fields to track request lifecycle and pipeline position, with the following canonical mapping:
  - **SQLite `requests` table**: `status` column = `'queued' | 'running' | 'gate' | 'done' | 'cancelled'` (top-level lifecycle state); `current_phase` column = `'intake' | 'prd' | 'prd_review' | 'tdd' | 'tdd_review' | 'plan' | 'plan_review' | 'spec' | 'spec_review' | 'code' | 'code_review' | 'integration' | 'deploy'` (pipeline position).
  - **`state.json`**: SHALL include BOTH `status` and `current_phase` as separate top-level fields with the same value domains as SQLite.
  - **Daemon behavior**: The supervisor reads `status` to filter actionable rows (`queued` -> pick up; `done` -> skip), then reads `current_phase` to decide which agent to dispatch.
  -- **Acceptance criterion**: `state.json` written by the submit handler contains `"status": "queued"` and `"current_phase": "intake"` as separate fields. The daemon's `select_request()` filters on `status` and reads `current_phase` for dispatch.

- **FR-019-07** (P0): The submit handler SHALL validate the generated request ID against `^REQ-\d{6}$` and validate that the resolved `state.json` path is within `<target_repo>/.autonomous-dev/requests/`. Any path traversal attempt SHALL cause submission to fail before any filesystem write. -- **Acceptance criterion**: Submitting with a `--repo` value containing `..` or symlinks pointing outside the repo fails with `VALIDATION_ERROR`.

### 5.3 Daemon Intake DB Polling

- **FR-019-08** (P0): The daemon's `select_request()` function SHALL continue to scan `<repo>/.autonomous-dev/requests/*/state.json` files as it does today. No change to the daemon's work-discovery mechanism is required because FR-019-05 now produces these files on submit. -- **Acceptance criterion**: After FR-019-05 is implemented, running the daemon with `--once` finds the newly-submitted request and selects it.

- **FR-019-09** (P1): The `intake` value for `current_phase` is a bookkeeping state only -- it indicates the submit handler completed validation synchronously and the request is ready for processing. There is no separate agent session for `intake`. When the daemon picks up a request with `status: "queued"` and `current_phase: "intake"`, it SHALL immediately set `status` to `"running"` and `current_phase` to the first pipeline phase (`prd` for `feature` type, or the type-appropriate first phase per PRD-011 variants). This transition SHALL be written atomically to `state.json` and appended to `events.jsonl`. -- **Acceptance criterion**: After daemon picks up an `intake`-phase request, `state.json` shows `status: "running"`, `current_phase: "prd"` (for feature type), and `events.jsonl` contains a `state_transition` event from `intake` to `prd`.

### 5.4 Per-Phase Agent Dispatch

- **FR-019-10** (P0): The daemon SHALL maintain a phase-to-agent mapping that associates each pipeline phase with the correct agent name from `plugins/autonomous-dev/agents/*.md`. Every dispatched agent is responsible for writing a `phase-result.json` file (see FR-019-14) at the end of its session. If agents do not natively produce this file, a thin shell wrapper in `spawn-session.sh` SHALL synthesize the result file from the agent's output JSON. Note: changing agent spec files is out of scope for this PRD. The mapping SHALL be:

  | Phase | Agent Name | Agent Role |
  |-------|-----------|------------|
  | `prd` | `prd-author` | PRD generation |
  | `prd_review` | `doc-reviewer` | Document quality review |
  | `tdd` | `tdd-author` | TDD generation |
  | `tdd_review` | `doc-reviewer` | Document quality review |
  | `plan` | `plan-author` | Implementation plan generation |
  | `plan_review` | `doc-reviewer` | Document quality review |
  | `spec` | `spec-author` | Implementation spec generation |
  | `spec_review` | `doc-reviewer` | Document quality review |
  | `code` | `code-executor` | Code generation and testing |
  | `code_review` | `quality-reviewer` | Code quality review |
  | `integration` | `test-executor` | Integration testing |
  | `deploy` | `deploy-executor` | Deployment execution |

  -- **Acceptance criterion**: For each phase in the table, `resolve_agent(phase)` returns the correct agent name. Unit test covers all 12 mappings.

- **FR-019-11** (P0): The daemon's `spawn_session()` function SHALL invoke the `claude` CLI with the `--agent <agent-name>` flag, where `<agent-name>` is the agent name resolved by FR-019-10 for the request's current phase. The `claude` CLI resolves the agent name to the corresponding file in `plugins/autonomous-dev/agents/<name>.md`. The full invocation SHALL be: `claude --agent <agent-name> --prompt <phase-prompt> --print --output-format json --max-turns <N>`. The existing `--prompt` flag SHALL carry the phase-specific context (request description, prior artifacts, review feedback). -- **Acceptance criterion**: The `claude` command invoked by `spawn_session()` includes `--agent prd-author` when processing a request in `prd` phase. Log entry at `spawn_session` shows `agent=prd-author` when processing a request in `prd` phase.

- **FR-019-12** (P0): The phase prompt resolved by `resolve_phase_prompt()` SHALL include: (a) the request's title and description, (b) the target repository path, (c) any artifacts produced by prior phases (e.g., the PRD document path when entering `tdd` phase), (d) any review feedback from a failed `_review` phase that caused a retry -- sourced from the `feedback` field of the corresponding `phase-result-<phase>.json` file and inlined into the retry prompt, and (e) the output path where the agent should write its artifact. -- **Acceptance criterion**: The prompt string for a `tdd` phase includes the path to the PRD file generated in the `prd` phase. The prompt string for a `prd` retry after `prd_review` failure includes the review feedback from `phase-result-prd_review.json`.

### 5.5 Phase Advancement State Machine

- **FR-019-13** (P0): After a successful session (exit code 0), the daemon SHALL advance the request to the next phase in the pipeline sequence. The advancement SHALL: (a) read the next phase from `next_phase_for_state()`, (b) update `state.json` atomically (write `.tmp`, then `mv`) setting `current_phase` to the next phase and `status` to `"running"` (or `"gate"` if the next phase is a `_review` phase), (c) append a `state_transition` event to `events.jsonl` with the session ID, cost, and turns used, (d) update `phase_history` with the completed phase entry. -- **Acceptance criterion**: After the `prd` agent exits 0, `state.json` shows `current_phase: "prd_review"` and `status: "gate"`, and `events.jsonl` has a `state_transition` from `prd` to `prd_review`.

- **FR-019-14** (P0): Each phase agent (or its `spawn-session.sh` wrapper) SHALL write a result file to `~/.autonomous-dev/portal/request-actions/<REQ-id>/phase-result-<phase>.json` at the end of its session. The file SHALL contain:
  - `status`: `"pass"` | `"fail"` | `"error"`
  - `feedback`: optional string (review failures feed this back into the retry prompt for the preceding generation phase)
  - `artifacts`: optional list of file paths produced by the phase
  - `next_phase`: optional override (defaults to the natural next phase from the state machine)

  After a `_review` phase session exits 0, the daemon SHALL read the corresponding `phase-result-<phase>.json` file to determine the review outcome. On `status: "pass"`, advance to the next phase. On `status: "fail"`, transition back to the preceding generation phase, set `current_phase_metadata.review_feedback` to the `feedback` field value, and set `status` to `"running"`. If the result file is missing after a session exits 0, treat as a pass with a warning logged.
  -- **Acceptance criterion**: When `prd_review` writes `phase-result-prd_review.json` with `status: "fail"` and `feedback: "Missing success metrics"`, `state.json` shows `current_phase: "prd"`, `status: "running"`, and `current_phase_metadata.review_feedback` contains `"Missing success metrics"`.

- **FR-019-15** (P0): When the pipeline reaches the terminal phase (`deploy` completion or the last phase in a type-specific variant), the daemon SHALL set `status` to `done` (or `monitor` per PRD-001 state definitions), record the completion timestamp, and write a final `state_transition` event. -- **Acceptance criterion**: A fully-completed request has `status: "done"` and a non-null `completed_at` timestamp.

### 5.6 Portal State Synchronization

- **FR-019-16** (P0): After every state transition (phase advancement, retry, pause, fail, cancel, completion), the daemon SHALL write or update a request-action file at `~/.autonomous-dev/portal/request-actions/<request_id>.json` containing: `id`, `repo`, `title`, `phase` (current phase), `status` ("running", "gate", or "done"), `cost` (accumulated USD), `variant` (request type), `createdAt`, `completedAt` (null until done), `score` (latest review score or 0), `turns` (accumulated turn count), `waitedMin` (minutes in gate states). -- **Acceptance criterion**: The portal's `readRequestLedger()` function returns a non-empty array after a request transitions from `intake` to `prd`. The returned entry has `phase: "prd"` and `status: "running"`.

- **FR-019-17** (P0): When a request enters a `_review` phase, the daemon SHALL set the portal request-action `status` to `"gate"`. When it exits the review phase (pass or fail-with-retry), the daemon SHALL update `status` back to `"running"`. -- **Acceptance criterion**: Portal shows `status: "gate"` while a request is in `prd_review` and shows `status: "running"` after it transitions to `tdd`.

- **FR-019-18** (P1): The daemon SHALL create the `~/.autonomous-dev/portal/request-actions/` directory if it does not exist, on first write. Writes SHALL use the atomic temp-file-then-rename pattern to avoid torn reads by the portal server. -- **Acceptance criterion**: `mkdir -p` equivalent runs before first write; no `ENOENT` errors in daemon logs.

### 5.7 End-to-End Smoke Test

- **FR-019-19** (P0): The project SHALL include a smoke test script at `plugins/autonomous-dev/test/e2e/smoke-e2e.sh` (or `.ts`) that: (a) creates a temporary git repository with a minimal codebase, (b) adds the temp repo to the daemon's allowlist, (c) runs `autonomous-dev request submit "Add a hello-world function" --repo <tmp-repo> --type feature`, (d) verifies the `state.json` file exists with `status: "queued"` and `current_phase: "intake"`, (e) runs the daemon in `--once` mode, (f) verifies the request advanced to at least the `prd` phase, (g) verifies a PRD artifact file exists in the repo, (h) verifies the portal request-action file was written, (i) verifies a `phase-result-prd.json` file was written, (j) cleans up. -- **Acceptance criterion**: The smoke test exits 0 on a correctly-configured system. It exits non-zero with a diagnostic message on failure.

- **FR-019-20** (P1): The smoke test SHALL be runnable in CI (no interactive prompts, no long-lived daemon). It SHALL complete in under 10 minutes. It SHALL not require a real Claude API key if the system supports a mock/stub mode; otherwise it SHALL document the API key requirement clearly. -- **Acceptance criterion**: Smoke test runs successfully in a GitHub Actions workflow (or documents why it cannot).

---

## 6. Non-Functional Requirements

### Performance

- Submit-to-persistence (CLI invocation to `state.json` written): p95 < 3 seconds. Dominated by SQLite write and filesystem write on local disk.
- Daemon poll-to-dispatch (start of iteration to `claude` process spawned): p95 < 5 seconds. Includes `select_request()` filesystem scan, `resolve_agent()`, and `resolve_phase_prompt()`.
- Portal request-action write: p95 < 200ms per write. Single JSON file atomic write.
- Phase transition overhead (state update + event log + portal write): p95 < 1 second total. All local filesystem operations.

### Security

- The submit handler's path validation (FR-019-07) SHALL prevent path traversal attacks. The `state.json` path SHALL be computed via `path.resolve()` and validated to begin with the target repo's absolute path.
- Agent names referenced by the phase-to-agent mapping (FR-019-10) SHALL be validated against the known set of agent names. The daemon SHALL not accept arbitrary strings as agent names. The `claude` CLI resolves agent names from the installed plugin's agents directory.
- The `--prompt` passed to `claude` SHALL not include raw user input without the existing sanitization from `intake/core/sanitizer.ts` (when `injectionRules` are provided). When `injectionRules` are absent, the system operates at trust level L1+ where the operator is the submitter and injection risk is accepted.

### Scalability

- The system is designed for single-operator use (1-3 concurrent requests across 1-5 repositories). No multi-tenant or distributed scaling is required.
- `select_request()` scans O(repos * requests) state files. At expected scale (< 100 active requests across < 10 repos), this completes in < 1 second. If scale increases, the scan can be replaced with a SQLite query without changing the interface.

---

## 7. Scope

### In Scope

- Fixing `initRouter()` in `cli_adapter.ts` to wire the three optional dependencies without crashing (the submit handler already supports optional deps; no handler changes required)
- Implementing the FR-824a two-phase commit handoff to write `state.json` alongside SQLite on submit
- Implementing per-phase agent dispatch in the daemon's `spawn_session()` using `claude --agent <agent-name>` and the phase-to-agent mapping table
- Implementing phase advancement logic in the daemon's post-session state update flow
- Implementing `phase-result.json` output contract: agents (or a thin `spawn-session.sh` wrapper) write `phase-result-<phase>.json` to `~/.autonomous-dev/portal/request-actions/<REQ-id>/`
- Writing request-action files to the portal's `~/.autonomous-dev/portal/request-actions/` directory on every state transition
- Building an end-to-end smoke test that validates submit through at least one completed phase
- Updating the phase prompt resolver to include prior-phase artifacts and review feedback

### Out of Scope

- **Changing agent specifications**: The 18 agents in `agents/*.md` are defined and working. This PRD does not modify their prompts, models, or tool configurations.
- **Portal redesign**: The portal was redesigned in TDD-037/PLAN-038 (PRs #233-#246). This PRD only writes the data files the portal already reads.
- **Multi-repo request routing**: Each request targets a single repo. Cross-repo coordination is a future PRD.
- **Per-request cost attribution**: The cost-ledger tracks daily totals. Per-request cost is recorded in `state.json` but not surfaced in the portal cost panel. Attribution is a future PRD.
- **Deploy backends**: The deploy phase dispatches `deploy-executor.md` which handles deployment mechanics. This PRD does not modify deploy backend logic (PRD-014).
- **Discord/Slack intake channels**: These are PRD-008 Phase 3-4 scope. This PRD focuses on CLI-to-deploy.
- **Claude API client implementation**: This PRD makes `claudeClient` optional. Implementing a real Claude API client for NLP parsing is deferred (PLAN-011-1 future work).
- **Duplicate detector implementation**: This PRD makes `duplicateDetector` optional. Implementing embedding-based duplicate detection is deferred.

---

## 8. Dependencies

### Services

- **Claude Code CLI** (`claude`): The daemon spawns `claude` processes for each phase using `--agent <name>`. Must be installed and authenticated. Version pinning per PRD-001 R-1 mitigation. The `--agent` flag resolves the agent name to `plugins/autonomous-dev/agents/<name>.md`.
- **SQLite** (`better-sqlite3`): The intake layer's canonical request index. Schema at v3, migrations managed by `intake/db/migrator.ts`.

### Database Migrations

- No new SQLite schema migrations required. The existing schema supports all fields needed for FR-019-05/06. The `source` and `adapter_metadata` columns were added per PRD-008 specification. Note: the `current_phase` column already exists; FR-019-06a formalizes the `status` vs `current_phase` separation that is already present in the schema.

### Filesystem Paths (read/write)

- `<repo>/.autonomous-dev/requests/<id>/state.json` -- written by submit handler (new), read by daemon (existing)
- `<repo>/.autonomous-dev/requests/<id>/events.jsonl` -- appended by daemon on state transitions (new write in this PRD's scope)
- `<repo>/.autonomous-dev/requests/<id>/checkpoint.json` -- written by daemon (existing)
- `~/.autonomous-dev/portal/request-actions/<id>.json` -- written by daemon on state transitions (new)
- `~/.autonomous-dev/portal/request-actions/<id>/phase-result-<phase>.json` -- written by phase agents or spawn-session wrapper (new)
- `~/.autonomous-dev/cost-ledger.json` -- updated by daemon (existing)
- `~/.autonomous-dev/heartbeat.json` -- updated by daemon (existing)
- `~/.autonomous-dev/intake.db` -- written by submit handler (existing)
- `~/.claude/autonomous-dev.json` -- read by daemon for config (existing)

### Agent Definitions (read-only, resolved by `claude --agent <name>`)

- `plugins/autonomous-dev/agents/prd-author.md`
- `plugins/autonomous-dev/agents/tdd-author.md`
- `plugins/autonomous-dev/agents/plan-author.md`
- `plugins/autonomous-dev/agents/spec-author.md`
- `plugins/autonomous-dev/agents/code-executor.md`
- `plugins/autonomous-dev/agents/doc-reviewer.md`
- `plugins/autonomous-dev/agents/quality-reviewer.md`
- `plugins/autonomous-dev/agents/test-executor.md`
- `plugins/autonomous-dev/agents/deploy-executor.md`

### Portal Reader (consumed by, not modified)

- `plugins/autonomous-dev-portal/server/wiring/request-ledger-reader.ts` -- reads from `~/.autonomous-dev/portal/request-actions/*.json`. This PRD produces those files. The reader is not modified.

### External APIs

- **Anthropic Claude API**: Consumed by `claude` CLI process. Required for all pipeline phases. Subject to rate limits and cost caps enforced by the daemon's existing governance checks.

### Kafka Topics

- None. The system uses filesystem-based state, not message queues.

### GraphQL Schema

- None. The portal uses a filesystem-backed reader, not a GraphQL API.

---

## 9. Risks & Assumptions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Agent sessions produce malformed output that the daemon cannot parse to determine pass/fail, causing the pipeline to stall | High | High | Phase agents (or the `spawn-session.sh` wrapper) write a structured `phase-result-<phase>.json` to `~/.autonomous-dev/portal/request-actions/<REQ-id>/`. The daemon reads this file rather than parsing free-form session output. If the file is missing after a session exits 0, treat as a pass with a warning logged. |
| Phase prompts are insufficient for agents to produce quality artifacts, leading to repeated review failures and escalations | Medium | High | The prompts are iteratable. Start with minimal prompts that include request description + prior artifacts. Measure review pass rate in the smoke test. If < 50% of PRD generations pass review on first attempt, iterate on the prd-author prompt in a follow-up. |
| The daemon's single-threaded `select_request()` -> `spawn_session()` loop means only one request is processed per iteration, leading to queue starvation for multi-request workloads | Medium | Medium | Acceptable for v1 (single-operator, 1-3 requests). The existing parallel agent spawner (`src/parallel/agent-spawner.ts`) can be wired in a future PRD to process multiple requests concurrently. |
| `state.json` format differences between what the submit handler writes and what `validate_state_file()` / `select_request()` expect, causing the daemon to skip newly-submitted requests | Medium | High | Include a compatibility test that writes a `state.json` using the submit handler and runs it through `validate_state_file()` and the `jq` parsing in `select_request()`. This is part of the smoke test (FR-019-19). |
| The portal's request-actions directory does not exist on fresh installs, causing write failures in the daemon | Low | Medium | FR-019-18 requires `mkdir -p` before first write. The portal server already creates this directory on startup (PLAN-038), but the daemon should not depend on the portal having started first. |
| Review phases require human approval at trust level L0/L1, blocking automated pipeline flow | Low | Low | Document that trust level L2 or higher is required for fully autonomous pipeline operation. At L0/L1, the pipeline pauses at review gates as designed per PRD-001 FR-607. |

### Assumptions

- The `claude` CLI's `--agent <name>` flag resolves the agent name from the installed plugin's agents directory (`plugins/autonomous-dev/agents/<name>.md`). Verified via `claude --help` output.
- The existing `validate_state_file()` function in `supervisor-loop.sh` validates the JSON structure but does not reject files missing the `type` or `source` fields (since legacy state files from PRD-001 predate these fields). New state files will include these fields, but the daemon must tolerate their absence in older files.
- The 18 agent definitions in `agents/*.md` are complete and functional -- they contain the correct system prompts, model selections, and tool configurations for their respective phases. This PRD does not validate agent content.
- The operator has `claude` CLI installed, authenticated, and within API usage limits. The daemon's existing cost cap and rate limit checks (FR-500 through FR-508 from PRD-001) protect against runaway spending.
- The target repository is on the allowlist in `~/.claude/autonomous-dev.json` before submission. The daemon's `select_request()` only scans allowlisted repos.

---

## 10. Release Plan

### Phase 1 -- Submit Fix and State Handoff (Target: Sprint 1, days 1-3)

**Goal**: `autonomous-dev request submit` persists to both SQLite and `state.json` without crashing.

Deliverables:
- Fix `initRouter()` in `cli_adapter.ts` to wire `claudeClient`, `duplicateDetector`, and `injectionRules` as optional deps (FR-019-01 through FR-019-04). Note: submit_handler.ts already supports optional deps; no handler changes required.
- Implement `state.json` two-phase write in the submit handler with dual `status`/`current_phase` fields (FR-019-05, FR-019-06, FR-019-06a, FR-019-07)
- Rebuild CLI bundle (`bun run build:cli`)
- Unit tests: initRouter() with no optional deps, state.json schema validation against `validate_state_file()`
- Manual validation: `autonomous-dev request submit "test" --repo /path --type feature` produces both SQLite row and `state.json` with `status: "queued"` and `current_phase: "intake"`

### Phase 2 -- Agent Dispatch and Phase Advancement (Target: Sprint 1-2, days 3-7)

**Goal**: The daemon picks up requests, dispatches the correct agent per phase via `claude --agent <name>`, and advances through the state machine.

Deliverables:
- Implement `resolve_agent()` function with the phase-to-agent name mapping table (FR-019-10)
- Update `spawn_session()` to invoke `claude --agent <agent-name> --prompt <phase-prompt> --print --output-format json --max-turns <N>` (FR-019-11)
- Implement `phase-result.json` output contract: thin wrapper in `spawn-session.sh` synthesizes result file from agent output JSON if the agent does not produce it natively (FR-019-14)
- Update `resolve_phase_prompt()` to include prior-phase artifacts and review feedback from `phase-result-<phase>.json` (FR-019-12)
- Implement phase advancement in the daemon's post-session handler: reads `phase-result.json`, updates `state.json` with next `current_phase` and appropriate `status`, appends `events.jsonl`, updates `phase_history` (FR-019-13, FR-019-14, FR-019-15)
- Implement intake-to-first-phase bookkeeping transition: `current_phase: "intake"` -> `current_phase: "prd"`, `status: "queued"` -> `status: "running"` (FR-019-09)
- Unit tests: `resolve_agent()` for all 12 phases, `next_phase_for_state()` integration, `phase-result.json` parsing
- Manual validation: daemon with `--once` processes one request from `intake` through `prd`

### Phase 3 -- Portal Sync and Smoke Test (Target: Sprint 2, days 7-10)

**Goal**: Pipeline progress is visible in the portal; an automated smoke test validates the full path.

Deliverables:
- Implement portal request-action file writes on every state transition (FR-019-16, FR-019-17, FR-019-18)
- Build the end-to-end smoke test script (FR-019-19, FR-019-20)
- Integration test: submit -> daemon --once -> portal reader returns correct data
- Manual validation: portal shows request progress in the request table after pipeline execution
- Documentation update: add "First Request" section to operator docs with the exact command sequence

### Rollout Strategy

- All changes land behind the existing `intake.channels.cli.enabled` config flag (default: true). No new feature flags needed.
- Daemon changes are backward-compatible: `select_request()` scanning logic is unchanged; `spawn_session()` falls back to current behavior if `resolve_agent()` returns no match.
- Rollback: if the submit handler's state.json write introduces regressions, the write can be disabled by reverting the submit handler patch without affecting SQLite persistence.
- Monitoring: operator watches daemon logs (`~/.autonomous-dev/logs/daemon.log`) for `spawn_session` and `state_transition` events. Portal request table shows live pipeline state.

---

## 11. Open Questions

| ID | Question | Owner | Status |
|----|----------|-------|--------|
| OQ-019-05 | The `code` phase agent (`code-executor.md`) is expected to create a branch and commit code. Should it also create a PR, or should that happen in the `integration` phase? PRD-001 defines `integration` as "Integration tests pass, PR created". Clarifying the boundary between `code` and `integration` affects the phase prompt content. | System Operator | Open -- deferred to TDD |
| OQ-019-06 | The portal's `request-ledger-reader.ts` expects a `waitedMin` field in request-action files. How should the daemon compute this? It would need to track when a request enters a `_review` (gate) phase and calculate elapsed minutes. This requires either a timer in the daemon or a timestamp field in `state.json`'s `phase_history`. | System Operator | Open -- deferred to TDD |

---

## 12. References

- [PRD-001: System Core & Daemon Engine](./PRD-001-system-core.md) -- State machine, daemon supervision, request lifecycle, phase definitions
- [PRD-008: Unified Request Submission](./PRD-008-unified-request-submission.md) -- CLI intake adapter, FR-824a handoff spec, submit handler pipeline
- [PRD-011: Pipeline Variants & Extension Hooks](./PRD-011-pipeline-variants-extension-hooks.md) -- Type-aware phase sequences, `phase_overrides` in state files
- [PRD-012: Quality Reviewer Suite](./PRD-012-quality-reviewer-suite.md) -- Review agent definitions and quality criteria
- [PRD-018: Portal Visual Redesign](./PRD-018-portal-visual-redesign.md) -- Portal reader infrastructure (PLAN-038)

---

*End of PRD-019: Intake-to-Deploy End-to-End Pipeline (v1.1)*
