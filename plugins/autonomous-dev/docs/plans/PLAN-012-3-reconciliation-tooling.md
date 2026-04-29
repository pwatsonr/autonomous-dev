# PLAN-012-3: Reconciliation Tooling for state.json/SQLite Drift

## Metadata
- **Parent TDD**: TDD-012-intake-daemon-handoff
- **Estimated effort**: 2 days
- **Dependencies**: ["PLAN-012-1", "PLAN-012-2"]
- **Blocked by**: []
- **Priority**: P1

## Objective
CLI reconciliation tooling to detect and repair state.json/SQLite inconsistencies that can occur due to crashes, FS errors, or partial transaction failures. Provides operational tooling to maintain data consistency across the dual-persistence system.

## Scope
### In Scope
- New CLI subcommand `autonomous-dev request reconcile` with `--detect`, `--repair`, `--cleanup-temp` modes
- `intake/core/reconciliation_manager.ts` per TDD-012 §12.1
- Four divergence categories per §12.1:
  - `missing_file`: SQLite has request, no state.json
  - `stale_file`: state.json older than SQLite update
  - `content_mismatch`: field values differ
  - `orphaned_file`: state.json exists, no SQLite record
- Repair strategies per §12.3: regenerate from SQLite for missing/stale; update from newer for mismatch; import to SQLite for orphaned (with confirmation) else archive
- Orphaned temp file cleanup: scan `state.json.tmp.*` older than 10min with dead PIDs; promote `.needs_promotion` (F4 recovery); remove others
- Two-phase commit pattern reused from PLAN-012-1 for repair operations (consistency during reconciliation)
- CLI flags: `--detect`, `--repair`, `--cleanup-temp`, `--force` (non-interactive), `--repo`, `--output-json`

### Out of Scope
- Two-phase commit core (PLAN-012-1)
- Schema migration (PLAN-012-2)
- Adapter integration (PLAN-011-*)
- Continuous reconciliation daemon mode (future)

## Tasks

1. **CLI subcommand infrastructure** -- add `request reconcile` to bash dispatcher; argument parsing for all modes.
   - Files: `bin/autonomous-dev.sh`
   - Acceptance: `--help` displays usage; all flags parse; routes to TS reconciliation manager; validates repo paths.
   - Effort: 2h

2. **ReconciliationManager core** -- `detectDivergence(repoPath)` returning structured `DivergenceReport[]` per §12.1.
   - Files: `intake/core/reconciliation_manager.ts` (new)
   - Acceptance: scans `{repo}/.autonomous-dev/requests/`; detects all 4 categories with structured reports.
   - Effort: 6h

3. **Repair strategies** -- `repair(report, options)` per category per §12.3.
   - Files: `intake/core/reconciliation_manager.ts`
   - Acceptance: missing_file → regenerate state.json; stale_file → update from SQLite if newer; content_mismatch → newer wins by timestamp; orphaned_file → import or archive; all repairs use two-phase commit.
   - Effort: 8h

4. **Orphaned temp file cleanup** -- detect + clean per §9 F4 recovery.
   - Files: `intake/core/reconciliation_manager.ts`
   - Acceptance: scans for `state.json.tmp.*` >10min old; checks PID alive (kill -0); promotes `.needs_promotion` after validation; removes from dead PIDs; logs all actions with request_id.
   - Effort: 4h

5. **Force flag for non-interactive use** -- `--force` auto-approves all repairs.
   - Files: `intake/core/reconciliation_manager.ts`
   - Acceptance: --force completes without prompts; interactive mode confirms destructive actions; force mode logs auto-approvals; safety guardrails maintained (schema validation + backups).
   - Effort: 2h

6. **CLI integration + report output** -- wire to CLI; JSON output support.
   - Files: `intake/cli/reconcile_command.ts` (new), `bin/autonomous-dev.sh`
   - Acceptance: `--detect` outputs human-readable summary; `--repair` performs + reports; `--cleanup-temp` handles temps; `--output-json` produces machine-readable JSON per §12.2; exit codes (0 no issues / 1 inconsistencies / 2 repair failures).
   - Effort: 4h

7. **Integration test suite** -- synthetic divergence scenarios.
   - Files: `intake/__tests__/integration/reconciliation.test.ts` (new)
   - Acceptance: covers all 4 divergence types; force mode no-prompt; repair failures handled; perf <30s for 100 requests.
   - Effort: 6h

## Dependencies & Integration Points

**Exposes:**
- `ReconciliationManager` class for operational tooling
- `autonomous-dev request reconcile` CLI for operators
- Divergence detection API (potential continuous monitoring future)
- Repair strategy patterns reusable for future consistency tools

**Consumes:**
- PLAN-012-1: two-phase commit pattern for atomic repairs
- PLAN-012-2: schema validation for state.json
- Repository class from DB layer
- Filesystem utilities

## Test Plan

- **Unit:** each reconciliation method isolated with mocked deps + controlled state
- **Integration:** end-to-end flows using temporary test repos with real SQLite
- **Chaos:** simulated crash scenarios with orphaned temps
- **Performance:** benchmarks at 10/100/500 request scales

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Repair introduces new inconsistencies due to races | Low | High | Advisory file locking during repairs; reuse proven two-phase commit |
| Large repos cause timeouts/memory issues | Medium | Medium | Batch processing >1000 requests; progress reporting |
| Cleanup removes valid data due to PID reuse | Low | High | 10+ minute age requirement; schema validation before removal; archive instead of delete |
| CLI integration breaks existing structure | Low | Medium | Follow established patterns; backward compat; CLI testing |

## Test Scenarios

- SQLite-only request → state.json regenerated correctly
- state.json-only → imported to SQLite with validation
- Field mismatch (priority differs) → newer timestamp wins
- Orphaned temp from dead PID → removed safely
- `.needs_promotion` with valid content → promoted to state.json
- Force mode completes without prompts
- Repair failures handled gracefully + logged

## Acceptance Criteria

- [ ] `autonomous-dev request reconcile --detect` scans test repo and reports divergences
- [ ] All 4 divergence categories detected with synthetic data
- [ ] Repair successfully fixes each category
- [ ] Orphaned temp cleanup promotes `.needs_promotion` + removes stale
- [ ] `--force` completes without prompts (scripted use)
- [ ] JSON output matches TDD-012 §12.2 spec
- [ ] Unit tests >90% coverage on reconciliation logic
- [ ] Integration tests verify complete workflows
- [ ] Performance: <30s for 100-request repo
- [ ] No lint or security warnings
- [ ] CLI help complete and accurate
