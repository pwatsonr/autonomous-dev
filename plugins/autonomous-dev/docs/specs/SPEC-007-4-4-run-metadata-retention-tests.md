# SPEC-007-4-4: Run Metadata, File Retention & Reports Test Suite

## Metadata
- **Parent Plan**: PLAN-007-4
- **Tasks Covered**: Task 9 (observation run metadata writer), Task 10 (file retention policy), Task 11 (unit and integration tests)
- **Estimated effort**: 19 hours

## Description

Implement the per-run metadata log writer matching TDD section 4.5, the file retention policy that archives old observations and deletes expired archives per Appendix B, and the comprehensive test suite for report generation, schema validation, triage processing, PRD generation, and retention.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/reports/run-metadata.ts` | Create | Per-run metadata log writer |
| `src/reports/retention.ts` | Create | Archive and delete policy |
| `tests/reports/report-generator.test.ts` | Modify | Comprehensive output format tests |
| `tests/reports/schema-validator.test.ts` | Modify | Valid, invalid, edge-case YAML tests |
| `tests/triage/triage-processor.test.ts` | Modify | Full lifecycle tests |
| `tests/triage/prd-generator.test.ts` | Modify | PRD format and compatibility tests |
| `tests/reports/retention.test.ts` | Create | Archive and delete policy tests |
| `tests/integration/triage-lifecycle.test.ts` | Create | End-to-end triage cycle |

## Implementation Details

### Task 9: Observation Run Metadata Writer

Written at the end of each observation run to `.autonomous-dev/logs/intelligence/RUN-<id>.log`. Format matches TDD section 4.5.

```typescript
interface RunMetadata {
  run_id: string;
  started_at: string;
  completed_at: string;
  services_in_scope: string[];
  data_source_status: {
    prometheus: DataSourceStatus;
    grafana: DataSourceStatus;
    opensearch: DataSourceStatus;
    sentry: DataSourceStatus;
  };
  observations_generated: number;
  observations_deduplicated: number;
  observations_filtered: number;
  triage_decisions_processed: number;
  total_tokens_consumed: number;
  queries_executed: {
    prometheus: number;
    grafana: number;
    opensearch: number;
    sentry: number;
  };
  errors: string[];
}

async function writeRunMetadata(metadata: RunMetadata, rootDir: string): Promise<void> {
  const logPath = path.join(rootDir, '.autonomous-dev/logs/intelligence', `${metadata.run_id}.log`);

  // Write as YAML for readability (consistent with TDD section 4.5 format)
  const content = yaml.dump(metadata, { lineWidth: 120, noRefs: true });
  await fs.writeFile(logPath, content, 'utf-8');
}
```

**Example output**:

```yaml
run_id: RUN-20260408-143000
started_at: "2026-04-08T14:30:00Z"
completed_at: "2026-04-08T14:35:22Z"
services_in_scope:
  - api-gateway
  - order-service
  - user-service
data_source_status:
  prometheus: available
  grafana: available
  opensearch: degraded
  sentry: not_configured
observations_generated: 2
observations_deduplicated: 1
observations_filtered: 3
triage_decisions_processed: 1
total_tokens_consumed: 38200
queries_executed:
  prometheus: 21
  grafana: 6
  opensearch: 8
  sentry: 0
errors:
  - "OpenSearch response time degraded (7.2s)"
```

### Task 10: File Retention Policy

Runs as a cleanup step at the end of each observation run.

```typescript
interface RetentionConfig {
  observation_days: number;   // Default 90
  archive_days: number;       // Default 365
}

interface RetentionResult {
  archived: string[];         // File paths moved to archive
  deleted: string[];          // File paths permanently deleted
  skipped: string[];          // Files exempt from retention (e.g., promoted with active PRD)
}

async function applyRetentionPolicy(
  observationsDir: string,
  archiveDir: string,
  config: RetentionConfig,
  auditLog: AuditLogger
): Promise<RetentionResult> {
  const result: RetentionResult = { archived: [], deleted: [], skipped: [] };
  const now = new Date();

  // Phase 1: Archive observations older than observation_days
  const observationFiles = await glob('**/OBS-*.md', { cwd: observationsDir, ignore: ['archive/**'] });
  for (const file of observationFiles) {
    const filePath = path.join(observationsDir, file);
    const fm = await readFrontmatter(filePath);
    if (!fm) continue;

    const obsDate = new Date(fm.timestamp);
    const daysSinceObs = (now.getTime() - obsDate.getTime()) / (24 * 60 * 60 * 1000);

    if (daysSinceObs > config.observation_days) {
      // Check exemption: promoted observations with active PRDs
      if (fm.triage_status === 'promoted' && fm.linked_prd) {
        const prdActive = await isPrdInActiveState(fm.linked_prd);
        if (prdActive) {
          result.skipped.push(filePath);
          auditLog.info(`Retention: skipping ${fm.id} (promoted, PRD active)`);
          continue;
        }
      }

      // Move to archive
      const archivePath = path.join(archiveDir, path.basename(file));
      await fs.rename(filePath, archivePath);
      result.archived.push(filePath);
      auditLog.info(`Retention: archived ${fm.id}`);
    }
  }

  // Phase 2: Delete archived observations older than archive_days
  const archiveFiles = await glob('OBS-*.md', { cwd: archiveDir });
  for (const file of archiveFiles) {
    const filePath = path.join(archiveDir, file);
    const fm = await readFrontmatter(filePath);
    if (!fm) continue;

    const obsDate = new Date(fm.timestamp);
    const daysSinceObs = (now.getTime() - obsDate.getTime()) / (24 * 60 * 60 * 1000);

    if (daysSinceObs > config.archive_days) {
      await fs.unlink(filePath);
      result.deleted.push(filePath);
      auditLog.info(`Retention: deleted archived ${fm.id}`);
    }
  }

  return result;
}

async function isPrdInActiveState(prdId: string): Promise<boolean> {
  // Check if the linked PRD is in a terminal state (completed, cancelled)
  // or still active (draft, in-progress, review)
  const prdPath = path.join(ROOT_DIR, '.autonomous-dev/prd', `${prdId}.md`);
  try {
    const content = await fs.readFile(prdPath, 'utf-8');
    const fm = parseFrontmatter(content);
    return fm?.status !== 'completed' && fm?.status !== 'cancelled';
  } catch {
    return false; // PRD not found = not active
  }
}
```

### Task 11: Test Suite

**Report generation tests**:

```typescript
describe('Report Generator', () => {
  test('error observation matches TDD format', () => {
    const input = createMockReportInput({
      type: 'error',
      severity: 'P1',
      service: 'api-gateway',
    });
    const report = generateReport(input);

    // Verify YAML frontmatter
    const fm = parseFrontmatter(report);
    expect(fm.id).toMatch(/^OBS-\d{8}-\d{6}-[a-f0-9]{4}$/);
    expect(fm.type).toBe('error');
    expect(fm.severity).toBe('P1');
    expect(fm.triage_status).toBe('pending');
    expect(fm.triage_decision).toBeNull();

    // Verify Markdown sections
    expect(report).toContain('## Summary');
    expect(report).toContain('## Severity Rationale');
    expect(report).toContain('## Evidence');
    expect(report).toContain('## Root Cause Hypothesis');
    expect(report).toContain('## Recommended Action');
    expect(report).toContain('## Related Observations');
  });

  test.each(['error', 'anomaly', 'trend', 'adoption'])('observation type %s generates valid report', (type) => {
    const input = createMockReportInput({ type });
    const report = generateReport(input);
    const fm = parseFrontmatter(report);
    expect(fm.type).toBe(type);
  });
});
```

**Integration test: full triage lifecycle** (TDD section 8.2):

```typescript
describe('Full Triage Lifecycle', () => {
  test('promote: observation -> edit -> PRD generated -> observation updated', async () => {
    // 1. Create an observation file
    const obsId = await createTestObservation({ severity: 'P1', service: 'api-gateway' });

    // 2. Simulate PM Lead editing YAML frontmatter
    await editObservationFrontmatter(obsId, {
      triage_decision: 'promote',
      triage_by: 'pwatson',
      triage_at: new Date().toISOString(),
      triage_reason: 'Confirmed issue, needs fix.',
    });

    // 3. Run triage processor
    const result = await processPendingTriage(observationsDir, auditLog);
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].decision).toBe('promote');

    // 4. Verify PRD was generated
    const obs = await readObservation(obsId);
    expect(obs.linked_prd).toMatch(/^PRD-OBS-/);
    const prdExists = await fileExists(path.join(prdDir, `${obs.linked_prd}.md`));
    expect(prdExists).toBe(true);

    // 5. Verify observation status updated
    expect(obs.triage_status).toBe('promoted');

    // 6. Verify audit log
    const auditEntries = await auditLog.readAll();
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        observation_id: obsId,
        action: 'promote',
        actor: 'pwatson',
      })
    );
  });

  test('defer -> re-triage cycle', async () => {
    // 1. Create observation and defer
    const obsId = await createTestObservation({});
    await editObservationFrontmatter(obsId, {
      triage_decision: 'defer',
      triage_by: 'pwatson',
      triage_at: new Date().toISOString(),
      triage_reason: 'Wait for next deploy.',
      defer_until: '2026-04-01', // Past date
    });

    // 2. Process triage (sets status to deferred)
    await processPendingTriage(observationsDir, auditLog);

    // 3. Run again (should return deferred observation since defer_until is past)
    const result = await processPendingTriage(observationsDir, auditLog);
    expect(result.deferred_returned).toContain(obsId);

    // 4. Verify observation is back to pending
    const obs = await readObservation(obsId);
    expect(obs.triage_status).toBe('pending');
    expect(obs.triage_decision).toBeNull();
  });
});
```

**Retention tests**:

```typescript
describe('Retention Policy', () => {
  test('archives observation older than retention period', async () => {
    // Create observation with timestamp 100 days ago
    await createTestObservation({ timestamp: daysAgo(100) });
    const result = await applyRetentionPolicy(observationsDir, archiveDir, { observation_days: 90, archive_days: 365 }, auditLog);
    expect(result.archived).toHaveLength(1);
  });

  test('does not archive recent observation', async () => {
    await createTestObservation({ timestamp: daysAgo(30) });
    const result = await applyRetentionPolicy(observationsDir, archiveDir, { observation_days: 90, archive_days: 365 }, auditLog);
    expect(result.archived).toHaveLength(0);
  });

  test('deletes expired archive', async () => {
    await createArchivedObservation({ timestamp: daysAgo(400) });
    const result = await applyRetentionPolicy(observationsDir, archiveDir, { observation_days: 90, archive_days: 365 }, auditLog);
    expect(result.deleted).toHaveLength(1);
  });

  test('skips promoted observation with active PRD', async () => {
    await createTestObservation({ timestamp: daysAgo(100), triage_status: 'promoted', linked_prd: 'PRD-OBS-active' });
    await createTestPrd('PRD-OBS-active', { status: 'in-progress' });
    const result = await applyRetentionPolicy(observationsDir, archiveDir, { observation_days: 90, archive_days: 365 }, auditLog);
    expect(result.skipped).toHaveLength(1);
  });
});
```

## Acceptance Criteria

1. Run metadata includes all fields from TDD section 4.5: run_id, started_at, completed_at, services_in_scope, data_source_status, observations_generated/deduplicated/filtered, triage_decisions_processed, total_tokens_consumed, queries_executed per source, errors.
2. Metadata written to `.autonomous-dev/logs/intelligence/RUN-<id>.log` in YAML format.
3. Observations older than `observation_days` (default 90) are moved to `.autonomous-dev/observations/archive/`.
4. Archives older than `archive_days` (default 365) are permanently deleted.
5. Retention runs as a cleanup step at the end of each observation run.
6. Promoted observations with active PRDs are exempt from archival until PRD reaches terminal state.
7. Moved and deleted files are logged in the run audit.
8. All report generator, schema validator, triage processor, PRD generator, and retention modules have unit tests.
9. Full triage lifecycle integration test passes: observation -> edit -> promote -> PRD generated.
10. Deferred lifecycle test passes: defer -> wait -> re-triage.
11. Retention tests verify archive, delete, and exemption behaviors.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-4-4-01 | Run metadata all fields | Complete run data | All fields present and correctly typed |
| TC-4-4-02 | Run metadata file path | Run ID `RUN-20260408-143000` | Written to `logs/intelligence/RUN-20260408-143000.log` |
| TC-4-4-03 | Retention: archive old | 100-day-old observation, threshold 90 days | Moved to archive/ |
| TC-4-4-04 | Retention: keep recent | 30-day-old observation, threshold 90 days | Not moved |
| TC-4-4-05 | Retention: delete archive | 400-day-old archive, threshold 365 days | Permanently deleted |
| TC-4-4-06 | Retention: keep archive | 200-day-old archive, threshold 365 days | Not deleted |
| TC-4-4-07 | Retention: skip active PRD | Promoted obs, PRD status "in-progress" | Skipped (not archived) |
| TC-4-4-08 | Retention: archive completed PRD | Promoted obs, PRD status "completed" | Archived (PRD terminal) |
| TC-4-4-09 | Integration: full promote cycle | Edit -> process -> PRD -> verify | All steps succeed, links established |
| TC-4-4-10 | Integration: dismiss -> auto-dismiss | Dismiss -> new dup fingerprint | Auto-dismissed on next run |
| TC-4-4-11 | Integration: defer -> return | Defer with past date -> next run | Returned to pending |
| TC-4-4-12 | Run metadata: query counts | 21 Prometheus, 6 Grafana queries | Correct per-source counts in metadata |
