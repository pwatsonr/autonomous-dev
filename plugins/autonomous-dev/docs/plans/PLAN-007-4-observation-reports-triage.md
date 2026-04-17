# PLAN-007-4: Observation Reports & Human Triage

## Metadata
- **Parent TDD**: TDD-007-production-intelligence
- **Estimated effort**: 7 days
- **Dependencies**: [PLAN-007-1, PLAN-007-2, PLAN-007-3]
- **Blocked by**: [PLAN-007-3] (requires candidate observations from the analytics engine)
- **Priority**: P0

## Objective

Build the report generator that transforms candidate observations into structured YAML-frontmatter + Markdown files, implement the file-based human triage interface, and create the observation-to-PRD promotion pipeline. This plan delivers the human-facing layer of the Production Intelligence Loop: the artifacts that the PM Lead reads, triages, and acts upon.

## Scope

### In Scope
- Observation report file format: YAML frontmatter + Markdown body (section 3.9)
- File naming scheme: `OBS-YYYYMMDD-HHMMSS-<short-id>.md` (section 3.9.1)
- Full report template with all sections: summary, severity rationale, evidence (metrics, logs, alerts), root cause hypothesis, recommended action, related observations (section 3.9.2)
- Observation report schema validation against TDD section 4.1
- File-based triage interface: PM Lead edits YAML frontmatter (section 3.10.1)
- Triage processing: scan pending observations, validate decisions, execute promote/dismiss/defer/investigate actions (section 3.10.2)
- Deferred observation re-triage when `defer_until` date arrives (section 3.10.2 step 3)
- Observation-to-PRD promotion pipeline (section 3.12.1)
- Generated PRD template with structured fields (section 3.12.2)
- Triage audit log (section 4.4)
- Observation run metadata format (section 4.5)
- File retention policy: archive after `observation_days`, delete after `archive_days` (Appendix B)
- Schema validation for YAML frontmatter on read and write

### Out of Scope
- MCP data collection (PLAN-007-1)
- PII/secret scrubbing (PLAN-007-2)
- Error detection, analytics, deduplication, scoring (PLAN-007-3)
- Governance: cooldown, oscillation, effectiveness tracking (PLAN-007-5)
- Notification-based triage via Slack/Discord (Phase 3, PLAN-007-5)
- Auto-promotion engine (Phase 3, PLAN-007-5)
- Weekly digest report generation (PLAN-007-5)
- Web UI for triage (rejected alternative per TDD section 9.3)

## Tasks

1. **Implement observation report generator** -- Build the file writer that takes a candidate observation from the analytics engine and produces a YAML-frontmatter + Markdown report file.
   - Files to create/modify: `src/reports/report-generator.ts`
   - Acceptance criteria: Output matches the full report example from TDD section 3.9.2. YAML frontmatter includes all fields from the observation report schema (section 4.1): id, timestamp, service, repo, type, severity, confidence, triage_status (initially `pending`), triage_decision (null), cooldown_active, fingerprint, occurrence_count, data_sources, related_observations, oscillation_warning, tokens_consumed, observation_run_id. Markdown body includes: summary, severity rationale table, evidence sections (metrics from Prometheus, logs from OpenSearch, alerts from Grafana), root cause hypothesis with disclaimer, and recommended action.
   - Estimated effort: 8 hours

2. **Implement file naming and directory placement** -- Generate observation file names in the format `OBS-YYYYMMDD-HHMMSS-<hex4>.md` and place them in `.autonomous-dev/observations/YYYY/MM/`.
   - Files to create/modify: `src/reports/file-naming.ts`
   - Acceptance criteria: File name includes the observation timestamp and 4-character random hex short ID. Year and month subdirectories are created if they do not exist. No file name collisions (hex4 provides uniqueness; if collision detected, regenerate).
   - Estimated effort: 2 hours

3. **Implement YAML frontmatter schema validation** -- Build a validator that checks observation report frontmatter against the schema from TDD section 4.1 on both read and write.
   - Files to create/modify: `src/reports/schema-validator.ts`
   - Acceptance criteria: Validates all required fields are present and have correct types (string, enum, float, integer, boolean, list). Enum fields validated against allowed values (type: error|anomaly|trend|adoption; severity: P0|P1|P2|P3; triage_status: pending|promoted|dismissed|deferred|investigating|cooldown; data source status: available|degraded|unreachable|not_configured). Invalid frontmatter is rejected with a clear error message listing violations. Validator runs before writing new reports and when reading reports for triage processing.
   - Estimated effort: 4 hours

4. **Implement file-based triage interface** -- Document the triage workflow and implement the triage processor that reads PM Lead edits to observation YAML frontmatter.
   - Files to create/modify: `src/triage/triage-processor.ts`
   - Acceptance criteria: Triage processor scans all observation files. Detects files where `triage_decision` is not null but `triage_status` is still `pending`. Validates that `triage_decision` is one of: promote, dismiss, defer, investigate. Validates `triage_by` and `triage_at` are populated. For deferred observations, validates `defer_until` is a valid date. Updates `triage_status` to match the decision. Rejects invalid decisions with a clear error message logged to the triage audit log.
   - Estimated effort: 6 hours

5. **Implement triage action handlers** -- Build the handlers for each triage decision: promote, dismiss, defer, investigate.
   - Files to create/modify: `src/triage/actions/promote.ts`, `src/triage/actions/dismiss.ts`, `src/triage/actions/defer.ts`, `src/triage/actions/investigate.ts`
   - Acceptance criteria: **Promote**: triggers PRD generation pipeline (task 7). **Dismiss**: updates fingerprint store with dismissal status so future duplicates are auto-dismissed. **Defer**: sets a reminder for `defer_until` date; deferred observation is excluded from triage queue until that date. **Investigate**: flags the observation for additional data collection on the next observation run (runner collects deeper data for that service/error class). Each action logs to the triage audit trail.
   - Estimated effort: 6 hours

6. **Implement deferred observation re-triage** -- At the start of each observation run, check deferred observations where `defer_until <= today` and reset them to pending.
   - Files to create/modify: `src/triage/triage-processor.ts`
   - Acceptance criteria: Deferred observations with `defer_until` in the past are reset: `triage_status` back to `pending`, `triage_decision` back to null. A note is appended to the Markdown body: "Deferred observation returned for re-triage." The original deferral reason and date are preserved in the audit log.
   - Estimated effort: 3 hours

7. **Implement observation-to-PRD promotion pipeline** -- Build the PRD generator that creates a pipeline-compatible PRD from a promoted observation per TDD section 3.12.
   - Files to create/modify: `src/triage/prd-generator.ts`, PRD template
   - Acceptance criteria: Reads the promoted observation report. Extracts structured data: service, repo, severity, evidence, root cause hypothesis, recommended action, metric values. Generates a PRD using Claude with context from the observation, service config, and previous observations. PRD follows the template from TDD section 3.12.2 with YAML frontmatter (title, version, date, author as "Production Intelligence Loop", status as Draft, source as production-intelligence, observation_id, severity, service). PRD body includes: problem statement, evidence, constraints, success criteria table, and scope. PRD is written to `.autonomous-dev/prd/PRD-OBS-<observation-id>.md`. Observation report is updated with `linked_prd` field.
   - Estimated effort: 8 hours

8. **Implement triage audit log** -- Write JSONL audit entries for every triage action per TDD section 4.4.
   - Files to create/modify: `src/triage/audit-log.ts`
   - Acceptance criteria: Each triage action logs a JSON entry to `.autonomous-dev/logs/intelligence/triage-audit.log` in JSONL format. Entry includes: observation_id, action, actor, timestamp, reason, generated_prd (if promoted), auto_promoted (boolean). File is append-only. Entries are parseable for reporting and governance analysis.
   - Estimated effort: 3 hours

9. **Implement observation run metadata writer** -- Write the per-run metadata log from TDD section 4.5 at the end of each observation run.
   - Files to create/modify: `src/reports/run-metadata.ts`
   - Acceptance criteria: Metadata includes: run_id, started_at, completed_at, services_in_scope, data_source_status, observations_generated, observations_deduplicated, observations_filtered, triage_decisions_processed, total_tokens_consumed, queries_executed (per source), errors. Written to `.autonomous-dev/logs/intelligence/RUN-<id>.log`.
   - Estimated effort: 3 hours

10. **Implement file retention policy** -- At the end of each observation run, move old observation files to archive and delete expired archives per Appendix B.
    - Files to create/modify: `src/reports/retention.ts`
    - Acceptance criteria: Observations older than `observation_days` (from config) are moved to `.autonomous-dev/observations/archive/`. Archived observations older than `archive_days` are permanently deleted. Retention runs as a cleanup step at the end of each observation run. Moved/deleted files are logged. Promoted observations are never archived until their linked PRD is in a terminal state.
    - Estimated effort: 4 hours

11. **Write unit and integration tests for reports and triage** -- Test report generation, schema validation, triage processing, PRD generation, and retention per TDD sections 8.1 and 8.2.
    - Files to create/modify: Test files for all report and triage modules
    - Acceptance criteria: Report generator test: given a candidate observation, output matches expected YAML frontmatter + Markdown structure. Schema validator test: valid and invalid frontmatter correctly accepted/rejected. Triage processor test: each decision type (promote, dismiss, defer, investigate) is correctly handled. Deferred re-triage test: observation with past `defer_until` is reset to pending. PRD generator test: promoted observation produces a valid PRD with all required fields. Retention test: files older than threshold are archived; archives older than threshold are deleted. Integration test (from TDD section 8.2): edit observation YAML to set `triage_decision: promote` -> PRD generated on next run -> observation updated with `linked_prd`.
    - Estimated effort: 12 hours

## Dependencies & Integration Points
- **Upstream**: PLAN-007-3 provides candidate observations (structured data objects) that the report generator converts to files. PLAN-007-2 ensures all text content is already scrubbed.
- **Downstream**: PLAN-007-5 reads observation files for governance checks (cooldown, oscillation, effectiveness). The generated PRDs feed into the existing autonomous development pipeline (TDD-001).
- **Human interface**: The PM Lead interacts with observation files directly in their editor (VS Code, vim, etc.). The triage workflow is file-edit based, leveraging Git for audit trail.
- **Pipeline integration**: Generated PRDs must be compatible with the existing pipeline format from TDD-001 (Pipeline Orchestration Core).

## Testing Strategy
- **Unit tests**: Report generator tested with various observation types (error, anomaly, trend, adoption). Schema validator tested with valid, partially invalid, and completely malformed frontmatter. Each triage action handler tested in isolation. PRD template tested for completeness.
- **Integration tests**: Full triage cycle: observation created -> PM Lead edits frontmatter -> triage processor detects and processes -> PRD generated (for promote) or fingerprint updated (for dismiss). Deferred observation lifecycle: defer -> wait -> re-triage. Retention lifecycle: create observation -> age past threshold -> verify archived -> age past archive threshold -> verify deleted.
- **End-to-end test**: From TDD section 8.4: inject error -> observation run detects -> PM Lead promotes -> PRD generated -> links established. Verify all audit log entries are correct.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| PM Lead edits YAML incorrectly (typos in enum values) | High | Low | Schema validator catches invalid values and provides clear error messages. Triage processor skips invalid entries and logs them. |
| File-based triage does not scale with high observation volume | Medium | Medium | Weekly digest (PLAN-007-5) provides a summary view. Phase 3 notification-based triage provides a faster path. Consider triage CLI tool in Phase 2 if volume is a problem. |
| Generated PRDs do not meet pipeline input requirements | Medium | High | PRD template is based on the existing pipeline format. Schema validation ensures required fields. Integration test verifies PRD acceptance by the pipeline. |
| Retention policy accidentally deletes un-triaged observations | Low | High | Only observations older than `observation_days` are archived. Default retention is generous (90 days). Promoted observations with active PRDs are exempt. |
| YAML frontmatter parsing edge cases (special characters, multi-line strings) | Medium | Low | Use a well-tested YAML parser. Schema validator catches parse failures. Escape special characters in generated content. |

## Definition of Done
- [ ] Observation reports match the full format from TDD section 3.9.2 with all YAML frontmatter fields
- [ ] File naming follows `OBS-YYYYMMDD-HHMMSS-<hex4>.md` in the correct directory
- [ ] YAML frontmatter schema validation catches all type and enum violations
- [ ] File-based triage processor detects PM Lead edits and executes promote/dismiss/defer/investigate
- [ ] Deferred observations are automatically re-triaged when `defer_until` date passes
- [ ] Promoted observations produce a valid PRD at `.autonomous-dev/prd/PRD-OBS-<observation-id>.md`
- [ ] Generated PRDs follow the template from TDD section 3.12.2 and are compatible with TDD-001 pipeline
- [ ] Observation reports are updated with `linked_prd` after promotion
- [ ] Triage audit log records all decisions in JSONL format per TDD section 4.4
- [ ] Run metadata captures all fields from TDD section 4.5
- [ ] Retention policy archives and deletes per configured thresholds without data loss
- [ ] All unit and integration tests pass including the full triage lifecycle
