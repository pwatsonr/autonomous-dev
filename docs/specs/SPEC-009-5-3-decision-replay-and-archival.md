# SPEC-009-5-3: Decision Replay and Log Archival

## Metadata
- **Parent Plan**: PLAN-009-5
- **Tasks Covered**: Task 5 (Implement Decision Replay), Task 6 (Implement Event Log Archival)
- **Estimated effort**: 8 hours

## Description

Implement the decision replay feature that filters and reconstructs the chronological narrative of all events for a given request, and the event log archival system that moves old events from the active log to cold storage while preserving hash chain continuity. Decision replay is the primary debugging and forensic tool; archival keeps the active log manageable.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/audit/decision-replay.ts` | Create | Per-request event filtering and narrative reconstruction |
| `src/audit/log-archival.ts` | Create | Active-to-archive event migration |

## Implementation Details

### decision-replay.ts

```typescript
export class DecisionReplay {
  constructor(private logPath: string) {}

  // Replay all events for a request ID, in chronological order
  async replay(requestId: string): Promise<AuditEvent[]>;

  // Stream events for a request (Phase 2 extension point)
  // async *replayStream(requestId: string): AsyncIterable<AuditEvent>;
}
```

#### Phase 1 Algorithm (Streaming Filter)

```
async function replay(requestId):
  results = []

  // Stream line-by-line (do not load full file into memory)
  for line of readLines(logPath):
    event = JSON.parse(line)
    if event.request_id === requestId:
      results.push(event)

  // Sort by timestamp (should already be in order, but defensive)
  results.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  return results
```

Key characteristics:
- Reads the full log file line-by-line (streaming, not loading into memory).
- Filters by `request_id` field.
- Returns events sorted by timestamp (chronological).
- Returns empty array for unknown request IDs (no error).
- Phase 2 extension: in-memory index for faster queries (not implemented in Phase 1).

#### Narrative Formatting (Optional Utility)

```typescript
export function formatNarrative(events: AuditEvent[]): string {
  return events.map(e =>
    `[${e.timestamp}] ${e.event_type}: ${summarizePayload(e.payload)}`
  ).join('\n');
}
```

### log-archival.ts

```typescript
export class LogArchival {
  constructor(
    private logPath: string,
    private archivePath: string,
    private activeRetentionDays: number,    // Default: 90
  ) {}

  // Archive events older than the retention period
  async archive(): Promise<ArchiveResult>;

  // List available archive files
  listArchives(): ArchiveInfo[];
}

export interface ArchiveResult {
  archivedEventCount: number;
  activeEventCount: number;
  archiveFilePath: string;
  chainHeadHashAtArchival: string;
}

export interface ArchiveInfo {
  filePath: string;
  dateRange: { from: string; to: string };
  eventCount: number;
  chainHeadHash: string;
}
```

#### Archive Algorithm

```
async function archive():
  cutoffDate = now() - activeRetentionDays

  // Read all events
  allEvents = readJsonLines(logPath)

  // Partition
  toArchive = allEvents.filter(e => parseDate(e.timestamp) < cutoffDate)
  toKeep = allEvents.filter(e => parseDate(e.timestamp) >= cutoffDate)

  if toArchive.length === 0:
    return { archivedEventCount: 0, ... }

  // Determine archive file name from date range
  dateFrom = toArchive[0].timestamp.slice(0, 10)       // YYYY-MM-DD
  dateTo = toArchive[toArchive.length - 1].timestamp.slice(0, 10)
  archiveFile = `${archivePath}/events-${dateFrom}-to-${dateTo}.jsonl`

  // Write archive atomically
  1. Write toArchive events to temp archive file
  2. fsync temp file
  3. Record chain head hash at point of archival (last archived event's hash)
  4. Write metadata sidecar: `${archiveFile}.meta.json` with { dateRange, eventCount, chainHeadHash }
  5. Rename temp file to final archive path

  // Rewrite active log with remaining events
  6. Write toKeep events to temp active file
  7. fsync temp file
  8. Rename temp file to logPath (atomic replace)

  // Verify: read back active log and ensure event count matches
  9. Verify active log has toKeep.length events

  return { archivedEventCount: toArchive.length, activeEventCount: toKeep.length, ... }
```

#### Safety Guarantees

1. Archive file is written and fsynced BEFORE the active log is rewritten. If the process crashes between these steps, the archive exists and the active log is unchanged (events are duplicated but not lost).
2. The active log rewrite is atomic (write to temp, rename).
3. A metadata sidecar file records the chain head hash at the point of archival, allowing the chain to be verified across archive boundaries.
4. Original events are NOT deleted until the archive file is confirmed written and fsynced.

## Acceptance Criteria

1. `replay(requestId)` returns all events for that request in chronological order.
2. `replay` handles large log files without loading entire file into memory.
3. `replay` returns empty array for unknown request IDs (no error).
4. `formatNarrative` produces human-readable chronological output.
5. Archive moves events older than `activeRetentionDays` to archive path.
6. Active log only contains events within the retention period after archival.
7. Archive file preserves hash chain head hash in metadata sidecar.
8. Archive file is written before active log is rewritten (crash safety).
9. Active log rewrite is atomic.
10. Original events not deleted until archive confirmed written.
11. `listArchives` returns all archive files with date ranges and event counts.

## Test Cases

### Decision Replay

1. **Replay single request** -- Log with events for `req-1` and `req-2`. `replay("req-1")` returns only `req-1` events.
2. **Chronological order** -- Events for `req-1` returned sorted by timestamp, even if log has interleaved events.
3. **Unknown request returns empty** -- `replay("nonexistent")` returns `[]`.
4. **Large log streaming** -- Log with 10,000 events for various requests. `replay("req-1")` completes without loading all 10,000 into memory (mock readline to verify streaming).
5. **All event types included** -- Events of different types for same request all returned.
6. **Format narrative** -- 3 events formatted as readable lines with timestamps and types.

### Log Archival

7. **Archive old events** -- Log with events from 100 days ago and 10 days ago. Archive with 90-day retention. Archive file contains 100-day events; active log contains 10-day events.
8. **No events to archive** -- All events within retention period. `archive()` returns `{ archivedEventCount: 0 }`.
9. **Archive file naming** -- Archive file named `events-YYYY-MM-DD-to-YYYY-MM-DD.jsonl`.
10. **Metadata sidecar** -- `.meta.json` file contains `dateRange`, `eventCount`, `chainHeadHash`.
11. **Active log intact after archive** -- Active log readable; event count matches expected.
12. **Crash safety: archive written before active rewrite** -- Simulate crash after archive write but before active rewrite. Both archive and original active log exist (no data loss).
13. **Atomic active log rewrite** -- Verify temp+rename pattern used (mock fs calls).
14. **listArchives** -- After 2 archival runs, `listArchives()` returns 2 entries with correct metadata.
15. **Archive preserves hash chain head** -- Metadata sidecar's `chainHeadHash` matches the last archived event's hash.
