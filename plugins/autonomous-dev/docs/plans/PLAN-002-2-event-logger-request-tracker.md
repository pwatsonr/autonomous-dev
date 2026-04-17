# PLAN-002-2: Event Logger & Request Tracker

## Metadata
- **Parent TDD**: TDD-002-state-machine
- **Estimated effort**: 2 days
- **Dependencies**: [PLAN-002-1]
- **Blocked by**: [PLAN-002-1]
- **Priority**: P0

## Objective
Deliver the Event Logger (append-only JSONL event recording with torn-write recovery) and the Request Tracker (ID generation, uniqueness enforcement, request discovery, directory scaffolding). These two components provide the audit trail and request identity infrastructure that the Lifecycle Engine (PLAN-002-3) consumes. Together with the State File Manager from PLAN-002-1, they complete the data infrastructure layer.

## Scope
### In Scope
- Event Logger: `event_append()` function for appending structured events to `events.jsonl` (TDD Section 3.2.1)
- Event Logger: `event_read_all()` function for reading all events for a request
- Event Logger: `event_read_since()` function for reading events since a given timestamp
- Event Logger: Torn-write recovery on read -- discard malformed last line, fail on mid-file corruption (TDD Section 3.2.2)
- Event Logger: 10 MB size guard -- stop appending and log warning if event log exceeds limit (TDD Section 3.2.3)
- Request Tracker: `generate_request_id()` with date-hex format and collision detection (TDD Section 3.3.1)
- Request Tracker: `discover_requests()` scanning configured repos for request directories with valid `state.json` (TDD Section 3.3.2)
- Request Tracker: Request directory scaffolding -- create `{request_id}/`, `state.json`, `events.jsonl`, `checkpoint/` with correct permissions
- Request Tracker: ID format validation via regex `^REQ-[0-9]{8}-[0-9a-f]{4}$` (TDD Section 9.3)
- Path traversal prevention -- validate request ID format before use in any filesystem path (TDD Section 9.3)
- Input sanitization for title, description, tags via `jq` encoding (TDD Section 9.4)
- Unit tests for all Event Logger and Request Tracker functions

### Out of Scope
- State file read/write (delivered in PLAN-002-1)
- State transition logic (PLAN-002-3)
- Event log rotation for archived requests (PLAN-002-4)
- Cleanup and archival (PLAN-002-4)
- Multi-repo discovery performance optimization (PLAN-002-4)
- Dependency evaluation / `blocked_by` logic (PLAN-002-3)

## Tasks

1. **Implement `event_append()`** -- Append a JSON event line to `events.jsonl`. Validate event structure against the event schema before appending. Enforce 10 MB size guard.
   - Files to create: `lib/state/event_logger.sh`
   - Acceptance criteria: (a) Event is appended as a single JSON line terminated by newline. (b) Valid events are accepted; malformed events are rejected with error. (c) Append is refused with warning when file exceeds 10 MB. (d) File permissions are `0600`.
   - Estimated effort: 2 hours

2. **Implement `event_read_all()` and `event_read_since()`** -- Read all events for a request, or events since a given ISO-8601 timestamp. Each line is independently parsed.
   - Files to modify: `lib/state/event_logger.sh`
   - Acceptance criteria: (a) Returns array of valid event JSON objects. (b) Filters correctly by timestamp when using `event_read_since()`. (c) Handles empty event log gracefully.
   - Estimated effort: 2 hours

3. **Implement torn-write recovery** -- On read, detect malformed last line (discard and truncate). Detect malformed mid-file lines (transition request to failed with `event_log_corruption` reason).
   - Files to modify: `lib/state/event_logger.sh`
   - Acceptance criteria: (a) Malformed last line is discarded with logged warning; file is truncated to remove it. (b) Malformed non-last line causes function to return error code indicating corruption. (c) Valid event log with no corruption is read without modification.
   - Estimated effort: 3 hours

4. **Implement `generate_request_id()`** -- Generate `REQ-{YYYYMMDD}-{4-char-hex}` using `date -u` and `openssl rand -hex 2`. Check for directory collision. Retry up to 5 times on collision.
   - Files to create: `lib/state/request_tracker.sh`
   - Acceptance criteria: (a) Generated ID matches regex `^REQ-[0-9]{8}-[0-9a-f]{4}$`. (b) If target directory already exists, a new hex part is generated. (c) After 5 collisions, function returns error. (d) ID is deterministically formatted (lowercase hex).
   - Estimated effort: 2 hours

5. **Implement `discover_requests()`** -- Scan all repos in the allowlist for `{repo}/.autonomous-dev/requests/REQ-*/state.json`. Return list of request directory paths.
   - Files to modify: `lib/state/request_tracker.sh`
   - Acceptance criteria: (a) Discovers all request directories with valid `state.json` across all configured repos. (b) Skips directories without `state.json`. (c) Skips repos without `.autonomous-dev/requests/` directory. (d) Returns empty list gracefully when no requests exist.
   - Estimated effort: 2 hours

6. **Implement request directory scaffolding** -- `create_request_directory()` creates the full directory structure for a new request: `{request_id}/`, initial `state.json` (status: `intake`), empty `events.jsonl`, and `checkpoint/` directory. Applies correct permissions.
   - Files to modify: `lib/state/request_tracker.sh`
   - Acceptance criteria: (a) Directory structure matches TDD Section 2.1 layout. (b) Initial `state.json` passes schema validation from PLAN-002-1. (c) Directories are `0700`, files are `0600`. (d) Initial `request_created` event is appended to `events.jsonl`. (e) Uses `state_write_atomic()` from PLAN-002-1 for the initial state file write.
   - Estimated effort: 3 hours

7. **Implement ID format validation and path traversal prevention** -- `validate_request_id()` checks the ID against the regex. All functions that construct filesystem paths from request IDs must call this first.
   - Files to modify: `lib/state/request_tracker.sh`
   - Acceptance criteria: (a) Valid IDs pass. (b) IDs containing `..`, `/`, spaces, or other path-unsafe characters are rejected. (c) IDs not matching the format regex are rejected. (d) All path-constructing functions call `validate_request_id()` before proceeding.
   - Estimated effort: 1 hour

8. **Implement input sanitization** -- `sanitize_input()` function that passes user-provided strings (title, description, tags) through `jq` for safe JSON encoding. Enforces maximum length constraints from the schema.
   - Files to modify: `lib/state/request_tracker.sh`
   - Acceptance criteria: (a) Shell metacharacters in input do not cause injection. (b) Strings exceeding `maxLength` are truncated with warning. (c) Output is valid JSON string content.
   - Estimated effort: 1 hour

9. **Unit tests for Event Logger** -- Cover append, read, torn-write recovery, size guard, and edge cases.
   - Files to create: `tests/unit/test_event_logger.sh`
   - Acceptance criteria: Minimum 15 test cases: 3 append (valid, invalid, size guard), 3 read (all, since timestamp, empty), 4 torn-write (last line, mid-file, no corruption, empty file), 5 edge cases (concurrent appends to separate files, very large events, special characters in metadata).
   - Estimated effort: 4 hours

10. **Unit tests for Request Tracker** -- Cover ID generation, discovery, scaffolding, validation, and sanitization.
    - Files to create: `tests/unit/test_request_tracker.sh`
    - Acceptance criteria: Minimum 15 test cases: 4 ID generation (format, collision retry, exhaustion, uniqueness), 3 discovery (multi-repo, empty, missing dirs), 3 scaffolding (structure, permissions, initial state), 3 validation (valid, traversal, malformed), 2 sanitization (metacharacters, length).
    - Estimated effort: 4 hours

## Dependencies & Integration Points
- **Depends on PLAN-002-1**: Uses `state_write_atomic()` for initial state file creation in scaffolding. Uses `state_read()` and schema validation during discovery. Uses schema definitions for event validation.
- **Consumed by PLAN-002-3**: The Lifecycle Engine calls `event_append()` on every state transition. It calls `discover_requests()` to find actionable requests. It uses `generate_request_id()` when new requests are submitted.
- **Consumed by PLAN-002-4**: The cleanup and archival system reads events via `event_read_all()` and operates on request directories discovered by `discover_requests()`.

## Testing Strategy
- Event Logger tests use temporary directories with pre-written event log fixtures (valid, corrupt last line, corrupt mid-file, oversized).
- Request Tracker tests use temporary directories simulating multi-repo layouts with various request states.
- ID generation tests verify format compliance and collision handling by pre-creating directories.
- All tests are self-contained bash scripts using `jq`. No external test framework.
- Torn-write recovery is tested by writing partial JSON lines (simulating truncation at various byte offsets).

## Risks
1. **`openssl` availability.** `openssl rand -hex 2` may not be available on all systems. Mitigation: provide a fallback using `/dev/urandom` (`head -c 2 /dev/urandom | xxd -p`). Document the fallback chain.
2. **Large-scale discovery performance.** Scanning hundreds of request directories across multiple repos could be slow with `jq`-based validation on each read. Mitigation: discovery only checks for `state.json` existence (file test), not schema validation. Full validation happens when a request is selected for processing.
3. **Event log file locking.** Multiple rapid appends from error cascades could interleave lines. Mitigation: the single-writer guarantee from TDD Section 3.3.3 ensures only one process appends at a time. Document this assumption.

## Definition of Done
- [ ] `event_append()` appends valid events and rejects invalid ones
- [ ] `event_read_all()` and `event_read_since()` return correct event sets
- [ ] Torn-write recovery discards malformed last line and detects mid-file corruption
- [ ] 10 MB size guard prevents runaway event log growth
- [ ] `generate_request_id()` produces correctly formatted IDs with collision retry
- [ ] `discover_requests()` finds all requests across configured repos
- [ ] `create_request_directory()` scaffolds the complete directory structure with correct permissions
- [ ] ID format validation prevents path traversal attacks
- [ ] Input sanitization handles shell metacharacters and length limits
- [ ] 30+ unit tests pass across Event Logger and Request Tracker
- [ ] All functions source `lib/state/state_file_manager.sh` from PLAN-002-1 successfully
- [ ] Code reviewed and merged
