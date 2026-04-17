# SPEC-007-4-2: File-Based Triage Processor & Action Handlers

## Metadata
- **Parent Plan**: PLAN-007-4
- **Tasks Covered**: Task 4 (triage processor), Task 5 (triage action handlers), Task 6 (deferred re-triage)
- **Estimated effort**: 15 hours

## Description

Implement the file-based human triage interface that detects PM Lead edits to observation YAML frontmatter, validates triage decisions, and executes the four actions: promote (triggers PRD generation), dismiss (updates fingerprint store), defer (sets reminder), and investigate (flags for deeper collection). Also implement deferred observation re-triage when the `defer_until` date arrives.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/triage/triage-processor.ts` | Create | Scan observations, detect edits, validate, dispatch actions |
| `src/triage/actions/promote.ts` | Create | Promote action: trigger PRD generation |
| `src/triage/actions/dismiss.ts` | Create | Dismiss action: update fingerprint store |
| `src/triage/actions/defer.ts` | Create | Defer action: set defer_until reminder |
| `src/triage/actions/investigate.ts` | Create | Investigate action: flag for deeper collection |
| `tests/triage/triage-processor.test.ts` | Create | Scan, detect, validate, dispatch tests |
| `tests/triage/actions/*.test.ts` | Create | Per-action handler tests |

## Implementation Details

### Task 4: Triage Processor

The processor runs at step 2 of the runner lifecycle (before data collection). It scans all observation files and detects PM Lead edits.

```typescript
interface TriageDecision {
  observation_id: string;
  file_path: string;
  decision: 'promote' | 'dismiss' | 'defer' | 'investigate';
  triage_by: string;
  triage_at: string;
  triage_reason: string;
  defer_until?: string;    // ISO 8601 date, only for 'defer'
}

interface TriageProcessingResult {
  processed: TriageDecision[];
  errors: TriageError[];
  deferred_returned: string[];  // IDs of deferred obs returned for re-triage
}

async function processPendingTriage(
  observationsDir: string,
  auditLog: TriageAuditLogger
): Promise<TriageProcessingResult> {
  const result: TriageProcessingResult = { processed: [], errors: [], deferred_returned: [] };

  // Step 1: Scan all observation files
  const files = await glob('**/*.md', { cwd: observationsDir });

  for (const file of files) {
    const filePath = path.join(observationsDir, file);
    const validation = validateOnRead(filePath);

    if (!validation.valid) {
      result.errors.push({
        file: filePath,
        error: `Schema validation failed: ${validation.errors.join('; ')}`,
      });
      continue;
    }

    const fm = validation.frontmatter!;

    // Step 2: Detect files where triage_decision is set but triage_status is still 'pending'
    if (fm.triage_decision !== null && fm.triage_status === 'pending') {
      // Validate the decision
      const validDecisions = ['promote', 'dismiss', 'defer', 'investigate'];
      if (!validDecisions.includes(fm.triage_decision)) {
        result.errors.push({
          file: filePath,
          error: `Invalid triage_decision: "${fm.triage_decision}". Must be one of: ${validDecisions.join(', ')}`,
        });
        auditLog.logError(fm.id, `Invalid decision: ${fm.triage_decision}`);
        continue;
      }

      // Validate required fields
      if (!fm.triage_by) {
        result.errors.push({
          file: filePath,
          error: 'triage_by is required when triage_decision is set',
        });
        continue;
      }
      if (!fm.triage_at) {
        result.errors.push({
          file: filePath,
          error: 'triage_at is required when triage_decision is set',
        });
        continue;
      }

      // For defer: validate defer_until
      if (fm.triage_decision === 'defer' && !fm.defer_until) {
        result.errors.push({
          file: filePath,
          error: 'defer_until is required when triage_decision is "defer"',
        });
        continue;
      }

      const decision: TriageDecision = {
        observation_id: fm.id,
        file_path: filePath,
        decision: fm.triage_decision,
        triage_by: fm.triage_by,
        triage_at: fm.triage_at,
        triage_reason: fm.triage_reason ?? '',
        defer_until: fm.defer_until,
      };

      // Dispatch to action handler
      await executeTriageAction(decision, filePath, auditLog);
      result.processed.push(decision);
    }

    // Step 3: Check deferred observations (Task 6)
    if (fm.triage_status === 'deferred' && fm.defer_until) {
      const deferDate = new Date(fm.defer_until);
      if (deferDate <= new Date()) {
        await returnDeferredObservation(filePath, fm, auditLog);
        result.deferred_returned.push(fm.id);
      }
    }
  }

  return result;
}
```

### Task 5: Triage Action Handlers

Each action handler modifies the observation file and performs side effects.

**Promote**:

```typescript
async function executePromote(
  decision: TriageDecision,
  filePath: string,
  auditLog: TriageAuditLogger
): Promise<void> {
  // 1. Update observation file: triage_status -> 'promoted'
  await updateFrontmatter(filePath, {
    triage_status: 'promoted',
  });

  // 2. Trigger PRD generation (SPEC-007-4-3)
  const prdId = await generatePrdFromObservation(filePath, decision);

  // 3. Update observation with linked PRD
  await updateFrontmatter(filePath, {
    linked_prd: prdId,
  });

  // 4. Log to triage audit
  auditLog.log({
    observation_id: decision.observation_id,
    action: 'promote',
    actor: decision.triage_by,
    timestamp: decision.triage_at,
    reason: decision.triage_reason,
    generated_prd: prdId,
    auto_promoted: false,
  });
}
```

**Dismiss**:

```typescript
async function executeDismiss(
  decision: TriageDecision,
  filePath: string,
  auditLog: TriageAuditLogger
): Promise<void> {
  // 1. Update observation file: triage_status -> 'dismissed'
  await updateFrontmatter(filePath, {
    triage_status: 'dismissed',
  });

  // 2. Update fingerprint store with dismissal status
  // This enables future auto-dismiss of duplicates
  const fm = await readFrontmatter(filePath);
  await updateFingerprintStore(fm.service, fm.fingerprint, {
    triage_status: 'dismissed',
    last_seen: new Date().toISOString(),
  });

  // 3. Log to triage audit
  auditLog.log({
    observation_id: decision.observation_id,
    action: 'dismiss',
    actor: decision.triage_by,
    timestamp: decision.triage_at,
    reason: decision.triage_reason,
    generated_prd: null,
    auto_promoted: false,
  });
}
```

**Defer**:

```typescript
async function executeDefer(
  decision: TriageDecision,
  filePath: string,
  auditLog: TriageAuditLogger
): Promise<void> {
  // 1. Update observation file: triage_status -> 'deferred'
  await updateFrontmatter(filePath, {
    triage_status: 'deferred',
  });

  // 2. defer_until is already set by the PM Lead in the YAML
  // No additional scheduling needed -- the processor checks defer_until on each run

  // 3. Log to triage audit
  auditLog.log({
    observation_id: decision.observation_id,
    action: 'defer',
    actor: decision.triage_by,
    timestamp: decision.triage_at,
    reason: decision.triage_reason,
    generated_prd: null,
    auto_promoted: false,
  });
}
```

**Investigate**:

```typescript
async function executeInvestigate(
  decision: TriageDecision,
  filePath: string,
  auditLog: TriageAuditLogger
): Promise<void> {
  // 1. Update observation file: triage_status -> 'investigating'
  await updateFrontmatter(filePath, {
    triage_status: 'investigating',
  });

  // 2. Flag for additional data collection on the next observation run
  // Write an investigation request that the runner picks up
  const fm = await readFrontmatter(filePath);
  await writeInvestigationRequest({
    observation_id: fm.id,
    service: fm.service,
    error_class: extractErrorClass(filePath),
    requested_at: decision.triage_at,
    requested_by: decision.triage_by,
  });

  // 3. Log to triage audit
  auditLog.log({
    observation_id: decision.observation_id,
    action: 'investigate',
    actor: decision.triage_by,
    timestamp: decision.triage_at,
    reason: decision.triage_reason,
    generated_prd: null,
    auto_promoted: false,
  });
}
```

**Frontmatter update helper**:

```typescript
async function updateFrontmatter(filePath: string, updates: Record<string, any>): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) throw new Error(`No frontmatter found in ${filePath}`);

  const frontmatter = yaml.load(fmMatch[1]) as Record<string, any>;
  Object.assign(frontmatter, updates);

  // Validate updated frontmatter
  validateOnWrite(frontmatter);

  const body = content.slice(fmMatch[0].length);
  const newContent = `---\n${yaml.dump(frontmatter)}---${body}`;
  await fs.writeFile(filePath, newContent, 'utf-8');
}
```

### Task 6: Deferred Observation Re-Triage

At the start of each run, check deferred observations whose `defer_until` has passed.

```typescript
async function returnDeferredObservation(
  filePath: string,
  frontmatter: any,
  auditLog: TriageAuditLogger
): Promise<void> {
  // 1. Reset triage fields
  await updateFrontmatter(filePath, {
    triage_status: 'pending',
    triage_decision: null,
    // Preserve triage_by, triage_at, triage_reason as historical record
  });

  // 2. Append note to Markdown body
  const content = await fs.readFile(filePath, 'utf-8');
  const note = `\n\n---\n\n**Deferred observation returned for re-triage** (${new Date().toISOString()})\n\nOriginal deferral by ${frontmatter.triage_by} on ${frontmatter.triage_at}. Reason: "${frontmatter.triage_reason}". Deferred until: ${frontmatter.defer_until}.\n`;
  await fs.writeFile(filePath, content + note, 'utf-8');

  // 3. Log the return
  auditLog.log({
    observation_id: frontmatter.id,
    action: 'deferred_return',
    actor: 'system',
    timestamp: new Date().toISOString(),
    reason: `defer_until ${frontmatter.defer_until} has passed`,
    generated_prd: null,
    auto_promoted: false,
  });
}
```

## Acceptance Criteria

1. Triage processor scans all observation files in `.autonomous-dev/observations/`.
2. Detects files where `triage_decision` is not null but `triage_status` is still `pending`.
3. Validates `triage_decision` is one of: promote, dismiss, defer, investigate.
4. Validates `triage_by` and `triage_at` are populated.
5. For deferred observations, validates `defer_until` is a valid date.
6. Rejects invalid decisions with clear error messages logged to the triage audit log.
7. **Promote**: triggers PRD generation, updates `triage_status` to `promoted`, sets `linked_prd`.
8. **Dismiss**: updates fingerprint store with dismissal status for future auto-dismiss, updates `triage_status` to `dismissed`.
9. **Defer**: sets `triage_status` to `deferred`. Excluded from triage queue until `defer_until`.
10. **Investigate**: flags for additional data collection on next run, updates `triage_status` to `investigating`.
11. Deferred observations with `defer_until <= today` are reset to `pending` with `triage_decision: null`.
12. Deferred return appends a note to the Markdown body preserving original deferral details.
13. All triage actions log to the triage audit trail.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-4-2-01 | Detect promote edit | `triage_decision: promote`, `triage_status: pending` | Promote action dispatched |
| TC-4-2-02 | Detect dismiss edit | `triage_decision: dismiss`, `triage_status: pending` | Dismiss action dispatched |
| TC-4-2-03 | Detect defer edit | `triage_decision: defer`, `defer_until: 2026-04-15` | Defer action dispatched |
| TC-4-2-04 | Detect investigate edit | `triage_decision: investigate` | Investigate action dispatched |
| TC-4-2-05 | Invalid decision rejected | `triage_decision: "delete"` | Error logged, file unchanged |
| TC-4-2-06 | Missing triage_by rejected | `triage_decision: promote`, `triage_by: null` | Error: `triage_by is required` |
| TC-4-2-07 | Missing defer_until rejected | `triage_decision: defer`, `defer_until: null` | Error: `defer_until is required` |
| TC-4-2-08 | Already processed skipped | `triage_status: promoted`, `triage_decision: promote` | Skipped (status already matches) |
| TC-4-2-09 | Promote creates PRD | Valid promote decision | PRD file created, `linked_prd` set |
| TC-4-2-10 | Dismiss updates fingerprint | Valid dismiss decision | Fingerprint store entry: `triage_status: 'dismissed'` |
| TC-4-2-11 | Defer excludes from queue | Deferred observation | Not included in pending triage scans |
| TC-4-2-12 | Investigate flags collection | Valid investigate decision | Investigation request written |
| TC-4-2-13 | Deferred return: past date | `defer_until: 2026-04-01`, today is 2026-04-08 | Reset to pending, note appended |
| TC-4-2-14 | Deferred return: future date | `defer_until: 2026-04-15`, today is 2026-04-08 | Not returned (still deferred) |
| TC-4-2-15 | Deferred return note | Returned observation | Markdown contains "Deferred observation returned for re-triage" |
| TC-4-2-16 | Audit log for each action | Process 3 decisions (promote, dismiss, defer) | 3 audit log entries written |
