# PLAN-010-2: Cost Tracking & Budget Enforcement

## Metadata
- **Parent TDD**: TDD-010-config-governance
- **Estimated effort**: 5 days
- **Dependencies**: [PLAN-010-1-layered-config-system]
- **Blocked by**: [PLAN-010-1-layered-config-system] (reads cost caps and governance fields from the effective config)
- **Priority**: P0

## Objective

Implement the `CostGovernor` component described in TDD-010 Sections 3.3 and 3.4. This plan delivers cost extraction from Claude Code session output, the append-only JSONL cost ledger with denormalized daily/monthly aggregates, the three-tier budget enforcement system (per-request, daily, monthly), cost escalation payloads, per-request cost tracking in state files, ledger rotation, and the `autonomous-dev cost` CLI reporting commands. The system must ensure that no Claude Code session runs when any cost cap is exceeded (fail-closed).

## Scope

### In Scope
- Cost extraction regex from Claude Code session stdout/stderr (TDD-010 Section 3.3.1)
- Per-request cost tracking: `cost_accrued_usd` and per-phase `cost_usd` fields in request `state.json` (Section 3.3.2)
- Append-only cost ledger at `~/.autonomous-dev/cost-ledger.jsonl` (Section 3.3.3)
- Denormalized daily/monthly aggregates in each ledger entry (Section 3.3.3)
- Tail-read strategy for budget checks (Strategy A, Section 3.3.4)
- Full-scan strategy for reporting queries (Strategy B, Section 3.3.4)
- Pre-session budget check: verify no cap is exceeded before spawning a session (Section 3.4.1)
- Post-session budget check: record cost and check for cap exceedance after session (Section 3.4.1)
- Three-tier cap hierarchy: per-request, daily, monthly (Section 3.4.2)
- Cost escalation payload construction (Section 3.4.3)
- Request pausing on per-request cap exceedance; ALL requests pausing on daily/monthly cap exceedance
- Ledger error handling: missing file creation, corruption detection, write failure retry (Section 5.2)
- Stale daily/monthly total detection and reset (new day/new month boundary)
- `autonomous-dev cost` CLI: today's spend, daily breakdown, monthly breakdown, per-request, per-repo (Section 3.3.6)
- Cost ledger integrity: append-only, no modification path (Section 6.2)
- Unit and integration tests for cost tracking and budget enforcement
- Test fixtures: `cost-ledger-sample.jsonl`, `claude-output-with-cost.txt`, `claude-output-crashed.txt`

### Out of Scope
- Cost ledger monthly rotation and archival (PLAN-010-4, as it is a retention/cleanup concern)
- Plugin hook wiring for `Stop` and `SubagentStop` (the functions are built here; hook integration is deferred)
- Hash-chain integrity for ledger entries (Phase 3 / future work per TDD-010 Section 6.2)
- Priority-based cap exemptions (TDD-010 OQ-3; current design: no exemptions)
- Model-specific cost tracking (TDD-010 OQ-2; deferred pending decision)
- Retroactive correction entries (TDD-010 OQ-8; deferred pending decision)

## Tasks

1. **Implement cost extraction from session output** -- Parse Claude Code stdout/stderr for cost information using the regex pattern from Section 3.3.1. Handle multiple format variations (`Total cost:`, `Session cost:`, `Cost:`). Return `0.00` with a warning log if no cost is found.
   - Files to create: `lib/cost_extractor.sh`
   - Acceptance criteria: Extracts correct dollar amount from all documented output formats. Returns `0.00` when no cost line is present (crashed session). Logs a warning event when cost is missing. Handles output with multiple cost lines (takes the last one).
   - Estimated effort: 2 hours

2. **Implement cost ledger append** -- Write a new JSONL entry to `~/.autonomous-dev/cost-ledger.jsonl`. Each entry includes all fields from Section 4.2. Daily and monthly totals are computed at write time by reading the last entry and incrementing (tail-read + add).
   - Files to create: `lib/cost_ledger.sh`
   - Acceptance criteria: Each call appends exactly one line. The line is valid JSON matching the Section 4.2 schema. `daily_total_usd` reflects the running total for the current UTC day. `monthly_total_usd` reflects the running total for the current UTC month. Write uses atomic temp-file + `mv` pattern. If the ledger does not exist, it is created.
   - Estimated effort: 5 hours

3. **Implement daily/monthly aggregate computation** -- Implement the tail-read strategy (read last line, check date match) for fast budget checks. Implement the full-scan strategy (stream through `jq`) for reporting. Handle day/month boundary transitions: reset daily total when date changes, reset both when month changes.
   - Files to modify: `lib/cost_ledger.sh`
   - Acceptance criteria: `get_daily_total()` returns the correct total for today via tail-read. Returns `0.00` if the last entry is from a previous day. `get_monthly_total()` returns the correct total for this month. Full-scan functions can compute arbitrary aggregates (cost per request, per repo, per day, per month).
   - Estimated effort: 4 hours

4. **Implement per-request cost tracking in state files** -- After recording a session cost, update the request's `state.json`: increment the current phase's `cost_usd` field and recalculate `cost_accrued_usd` as the sum of all phase costs. Use atomic write (`.tmp` + `mv`).
   - Files to create: `lib/cost_request_tracker.sh`
   - Acceptance criteria: Phase cost is incremented (not replaced). Request cumulative cost is the sum of all phases. State file is updated atomically. Works correctly when a request has multiple phases with costs.
   - Estimated effort: 3 hours

5. **Implement pre-session budget check** -- Before spawning a Claude Code session, check all three caps in order: monthly, daily, per-request. Return a structured status indicating which (if any) cap is exceeded and what action to take. This is the `CostGovernor.check_budgets()` function.
   - Files to create: `lib/cost_governor.sh`
   - Acceptance criteria: Returns pass/fail status for each cap level. Monthly cap exceedance blocks ALL work. Daily cap exceedance blocks ALL work. Per-request cap exceedance blocks only that request. If any cap is exceeded, the function returns non-zero. The check reads caps from the effective config (PLAN-010-1).
   - Estimated effort: 4 hours

6. **Implement post-session budget check and request pausing** -- After recording a session cost, re-check all caps. If a cap is now exceeded, transition affected requests to `paused` status. For daily/monthly caps, pause ALL active requests. For per-request caps, pause only the individual request.
   - Files to modify: `lib/cost_governor.sh`
   - Acceptance criteria: Newly exceeded per-request cap pauses only that request. Newly exceeded daily cap pauses all active requests. Newly exceeded monthly cap pauses all active requests. Paused requests have their status updated in `state.json`.
   - Estimated effort: 3 hours

7. **Implement cost escalation payload** -- When a cap is exceeded, construct and emit the escalation payload from Section 3.4.3. Include cap type, cap value, current spend, overage amount, affected request IDs, and recommendation text.
   - Files to modify: `lib/cost_governor.sh`
   - Acceptance criteria: Payload matches the JSON structure from Section 3.4.3. All fields are populated accurately. Escalation type is `cost`, urgency is `immediate`. Recommendation text varies by cap type (per-request vs daily vs monthly).
   - Estimated effort: 2 hours

8. **Implement `autonomous-dev cost` CLI commands** -- Build the cost reporting CLI from Section 3.3.6: default (today + current month), `--daily` (daily breakdown for current month), `--monthly` (monthly breakdown for current year), `--request REQ-X` (per-request breakdown), `--repo /path` (per-repo breakdown).
   - Files to create: `commands/cost.sh`
   - Acceptance criteria: Default output shows today's spend and remaining daily budget, plus current month's spend and remaining monthly budget. `--daily` shows a table of per-day totals. `--monthly` shows per-month totals. `--request` and `--repo` show per-phase breakdowns. Output is human-readable with dollar formatting. Empty ledger produces clean "no data" output.
   - Estimated effort: 4 hours

9. **Implement ledger error handling** -- Handle all error scenarios from TDD-010 Section 5.2: missing ledger (create new), corrupted last line (refuse to start), write failure (retry once, then pause and escalate), stale date (reset totals).
   - Files to modify: `lib/cost_ledger.sh`
   - Acceptance criteria: Missing ledger file is auto-created on first write. Corrupted last line (invalid JSON) causes the system to refuse work and log an error. Write failure retries once; on second failure, pauses all requests and emits escalation. Date boundary transitions reset daily/monthly totals correctly.
   - Estimated effort: 3 hours

10. **Unit tests for cost extraction and ledger operations** -- Test cost regex against various Claude Code output formats. Test ledger append, tail-read, full-scan, date boundary handling, and error cases.
    - Files to create: `test/unit/test_cost_extractor.sh`, `test/unit/test_cost_ledger.sh`
    - Acceptance criteria: Tests cover: successful cost extraction from all known formats, missing cost line, multi-line output, ledger append with correct aggregates, day boundary reset, month boundary reset, empty ledger, corrupted ledger detection.
    - Estimated effort: 4 hours

11. **Unit tests for budget enforcement** -- Test pre-session and post-session checks with amounts below, at, and above each cap. Test the cap hierarchy (per-request vs daily vs monthly).
    - Files to create: `test/unit/test_cost_governor.sh`
    - Acceptance criteria: Tests cover: all three caps below limit (pass), each cap individually exceeded (correct response), multiple caps exceeded simultaneously (monthly takes precedence), post-session check triggers request pause, escalation payload is correct.
    - Estimated effort: 4 hours

12. **Create test fixtures** -- Build cost-related fixture files from TDD-010 Section 7.4.
    - Files to create: `test/fixtures/cost-ledger-sample.jsonl`, `test/fixtures/claude-output-with-cost.txt`, `test/fixtures/claude-output-crashed.txt`
    - Acceptance criteria: `cost-ledger-sample.jsonl` contains entries spanning multiple days and months with realistic values. `claude-output-with-cost.txt` contains a realistic session output with a cost line. `claude-output-crashed.txt` has session output without any cost line.
    - Estimated effort: 2 hours

13. **Integration test: cost cap enforcement end-to-end** -- Submit a simulated request, simulate cost recording, verify pause occurs when the cap is hit, verify escalation is emitted.
    - Files to create: `test/integration/test_cost_enforcement.sh`
    - Acceptance criteria: Test simulates multiple session cost recordings that approach and then exceed the daily cap. Verifies the pre-session check blocks work after exceedance. Verifies all active requests are paused. Verifies escalation payload is emitted.
    - Estimated effort: 3 hours

## Dependencies & Integration Points

- **PLAN-010-1 (Config System)**: Reads `governance.daily_cost_cap_usd`, `governance.monthly_cost_cap_usd`, `governance.per_request_cost_cap_usd` from the effective config.
- **Supervisor loop (TDD-001)**: The supervisor loop calls `check_budgets()` before spawning sessions and `record_cost()` after sessions complete.
- **State machine (TDD-002)**: Request pausing updates `state.json` using the state machine's transition function. The cost governor must call the state machine's `pause` transition rather than writing state directly.
- **Escalation system (TDD-009)**: Cost escalation payloads are emitted via the escalation subsystem's `emit_escalation()` function. This plan constructs the payload; the delivery mechanism is owned by TDD-009.
- **Plugin hooks**: The `Stop` hook will call `record_cost()`, and `SubagentStop` will call it for individual subagent cost attribution. The functions are built here; hook wiring is separate.
- **PLAN-010-4 (Cleanup)**: Ledger rotation (monthly archival) is implemented in PLAN-010-4 since it is a retention concern.

## Testing Strategy

- **Unit tests**: Pure-function tests for cost extraction regex, ledger entry construction, aggregate computation, budget comparison logic. No external state needed -- tests pass in sample strings and assert outputs.
- **Integration tests**: End-to-end test with a real ledger file in a temp directory. Simulates a sequence of cost recordings, verifies aggregates, verifies cap enforcement triggers at the right thresholds.
- **Property-based tests**: Cost ledger daily total is monotonically increasing within a day (per TDD-010 Section 7.3). Adding a cost entry always increases the cumulative request cost.
- **Edge case tests**: Zero-cost sessions, very large cost values, ledger with exactly one entry, ledger spanning midnight UTC, ledger spanning month boundary.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Claude Code changes its output format for cost reporting (TDD-010 OQ-1) | Medium | High | Use a flexible regex that handles known variations. Log a warning (not silent failure) when no cost is found. Add a version-detection heuristic if possible. |
| Cost under-reporting for crashed sessions (known limitation per Section 3.3.1) | Medium | Medium | Record `0.00` and log warning. The system under-reports rather than over-reports, which is the safer direction for an append-only ledger. |
| Race condition if two supervisor loops write to the ledger simultaneously | Low | High | The system is single-writer by design (one supervisor loop). Document this assumption. The atomic write pattern (`tmp` + `mv`) prevents partial writes but not concurrent appends. |
| Tail-read strategy gives wrong aggregate if the last line was a different request's entry from an earlier date within the same day | Low | Medium | Tail-read checks the date of the last entry. If the date matches today, the aggregate is authoritative. If it does not match, the total resets to 0 (correct for a new day). |
| Denormalized totals could drift from reality if a write succeeds but the aggregation was stale | Low | Medium | Provide `autonomous-dev cost --reconcile` (or equivalent full-scan recalculation) as a safety valve. Document that the full-scan is authoritative. |

## Definition of Done

- [ ] Cost extraction correctly parses dollar amounts from all known Claude Code output formats
- [ ] Cost extraction returns `0.00` with warning for crashed sessions
- [ ] Cost ledger appends valid JSONL entries with all fields from Section 4.2
- [ ] Daily and monthly totals are denormalized in each entry and reset correctly at day/month boundaries
- [ ] Per-request `cost_accrued_usd` and per-phase `cost_usd` are tracked in `state.json`
- [ ] Pre-session budget check blocks work when any cap is exceeded
- [ ] Post-session budget check pauses affected requests when a cap is newly exceeded
- [ ] Cost escalation payloads match the schema from Section 3.4.3
- [ ] `autonomous-dev cost` CLI shows today, daily, monthly, per-request, and per-repo breakdowns
- [ ] Ledger error handling covers missing file, corruption, write failure, and stale dates
- [ ] All unit tests pass (cost extraction, ledger operations, budget enforcement)
- [ ] Integration test demonstrates end-to-end cap enforcement with request pausing
- [ ] Test fixtures created and used by test suites
