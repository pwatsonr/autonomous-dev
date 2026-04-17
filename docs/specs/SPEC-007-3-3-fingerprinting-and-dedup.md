# SPEC-007-3-3: Fingerprint Generation, Deduplication & Fuzzy Matching

## Metadata
- **Parent Plan**: PLAN-007-3
- **Tasks Covered**: Task 6 (fingerprint generation & stack normalization), Task 7 (dedup engine), Task 8 (fuzzy similarity)
- **Estimated effort**: 18 hours

## Description

Implement the SHA-256 fingerprint generator with stack trace normalization, the three deduplication windows (intra-run, inter-run 7d, post-triage 30d), and the fuzzy similarity layer using Jaccard similarity on stack frames, Levenshtein distance on error messages, and temporal correlation. These components prevent duplicate observations from flooding the triage queue.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/fingerprint.ts` | Create | SHA-256 fingerprint from structural components |
| `src/engine/stack-normalizer.ts` | Create | Remove line numbers, memory addresses, thread IDs, timestamps |
| `src/engine/deduplicator.ts` | Create | Three-window dedup engine with fingerprint store I/O |
| `src/engine/similarity.ts` | Create | Jaccard, Levenshtein, temporal correlation |
| `tests/engine/fingerprint.test.ts` | Create | Determinism and normalization tests |
| `tests/engine/deduplicator.test.ts` | Create | All three window scenarios |
| `tests/engine/similarity.test.ts` | Create | Fuzzy matching threshold tests |

## Implementation Details

### Task 6: Fingerprint Generation & Stack Trace Normalization

**Fingerprint components** (hashed in this order):

```typescript
import { createHash } from 'crypto';

function generateFingerprint(candidate: CandidateObservation): string {
  const normalizedStack = candidate.log_samples.length > 0
    ? normalizeStackTrace(extractStackTrace(candidate.log_samples))
    : '';

  const components = [
    candidate.service,                    // e.g., "api-gateway"
    candidate.error_class ?? 'unknown',   // e.g., "ConnectionPoolExhausted"
    candidate.endpoint ?? '*',            // e.g., "/api/v2/orders" or "*"
    String(candidate.error_code ?? ''),   // e.g., "503"
    normalizedStack,                      // Top 3 normalized frames
  ].join('|');

  return createHash('sha256').update(components).digest('hex');
}
```

**Stack trace normalization** -- remove deployment-specific artifacts so the same logical error produces the same fingerprint across deployments:

```typescript
function normalizeStackTrace(stackTrace: string): string {
  const frames = parseStackFrames(stackTrace);

  // Take top 3 frames only
  const top3 = frames.slice(0, 3);

  return top3.map(frame => {
    let normalized = frame;

    // Remove line numbers: Foo.java:42 -> Foo.java:*
    normalized = normalized.replace(/:(\d+)/g, ':*');

    // Remove memory addresses: 0x7fff5fbff8a0 -> 0x*
    normalized = normalized.replace(/0x[0-9a-fA-F]+/g, '0x*');

    // Remove thread IDs: [thread-42] -> [thread-*]
    normalized = normalized.replace(/\[thread-\d+\]/g, '[thread-*]');
    // Alternative: Thread-42 -> Thread-*
    normalized = normalized.replace(/Thread-\d+/g, 'Thread-*');

    // Remove timestamps embedded in traces
    normalized = normalized.replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g,
      '<timestamp>'
    );

    // Remove instance/pod IDs: pod-abc123def -> pod-*
    normalized = normalized.replace(/pod-[a-z0-9]+/g, 'pod-*');

    return normalized.trim();
  }).join('\n');
}

function parseStackFrames(stackTrace: string): string[] {
  // Split on common frame delimiters:
  // "at " (Java/JS), "File " (Python), "in " (Ruby/Go)
  const lines = stackTrace.split('\n');
  return lines.filter(line =>
    line.trim().startsWith('at ') ||
    line.trim().match(/^File "/) ||
    line.trim().match(/^\s+in /) ||
    line.trim().match(/^\s+\w+\./) // Generic frame pattern
  );
}
```

### Task 7: Deduplication Engine

Three windows with distinct behaviors:

```typescript
interface FingerprintEntry {
  hash: string;
  service: string;
  error_class: string;
  endpoint: string;
  first_seen: string;       // ISO 8601
  last_seen: string;        // ISO 8601
  occurrence_count: number;
  linked_observation_id: string;
  triage_status: string;
}

interface FingerprintStore {
  fingerprints: FingerprintEntry[];
}

interface DeduplicationResult {
  action: 'new' | 'merge_intra_run' | 'update_inter_run' | 'auto_dismiss' | 'related_to_promoted';
  existing_observation_id?: string;
  reason?: string;
}

class Deduplicator {
  private store: FingerprintStore;
  private intraRunFingerprints: Map<string, CandidateObservation> = new Map();

  constructor(private storePath: string) {}

  async load(service: string): Promise<void> {
    const filePath = path.join(this.storePath, `${service}.json`);
    this.store = await readJsonFile(filePath) ?? { fingerprints: [] };
  }

  async save(service: string): Promise<void> {
    const filePath = path.join(this.storePath, `${service}.json`);
    await writeJsonFile(filePath, this.store);
  }

  deduplicate(candidate: CandidateObservation, fingerprint: string): DeduplicationResult {
    const now = new Date();

    // Window 1: Intra-run (within current run)
    if (this.intraRunFingerprints.has(fingerprint)) {
      const existing = this.intraRunFingerprints.get(fingerprint)!;
      existing.occurrence_count = (existing.occurrence_count ?? 1) + 1;
      return {
        action: 'merge_intra_run',
        existing_observation_id: existing.observation_id,
      };
    }

    // Window 2: Inter-run (last 7 days, pending observations)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const interRunMatch = this.store.fingerprints.find(fp =>
      fp.hash === fingerprint &&
      fp.triage_status === 'pending' &&
      new Date(fp.last_seen) > sevenDaysAgo
    );
    if (interRunMatch) {
      interRunMatch.last_seen = now.toISOString();
      interRunMatch.occurrence_count++;
      return {
        action: 'update_inter_run',
        existing_observation_id: interRunMatch.linked_observation_id,
        reason: `Matches pending observation ${interRunMatch.linked_observation_id}`,
      };
    }

    // Window 3: Post-triage (last 30 days)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const postTriageMatch = this.store.fingerprints.find(fp =>
      fp.hash === fingerprint &&
      new Date(fp.last_seen) > thirtyDaysAgo &&
      (fp.triage_status === 'dismissed' || fp.triage_status === 'promoted')
    );
    if (postTriageMatch) {
      if (postTriageMatch.triage_status === 'dismissed') {
        return {
          action: 'auto_dismiss',
          existing_observation_id: postTriageMatch.linked_observation_id,
          reason: 'previously_dismissed_duplicate',
        };
      }
      if (postTriageMatch.triage_status === 'promoted') {
        return {
          action: 'related_to_promoted',
          existing_observation_id: postTriageMatch.linked_observation_id,
          reason: 'related_to_promoted',
        };
      }
    }

    // No match: new observation
    this.intraRunFingerprints.set(fingerprint, candidate);
    return { action: 'new' };
  }

  registerFingerprint(fingerprint: string, candidate: CandidateObservation): void {
    this.store.fingerprints.push({
      hash: fingerprint,
      service: candidate.service,
      error_class: candidate.error_class ?? 'unknown',
      endpoint: candidate.endpoint ?? '*',
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      occurrence_count: 1,
      linked_observation_id: candidate.observation_id,
      triage_status: 'pending',
    });
  }
}
```

**Fingerprint store file**: `.autonomous-dev/fingerprints/<service>.json`. Read at run start, written at run end.

### Task 8: Fuzzy Similarity Matching

Near-duplicate detection for cases where exact fingerprints differ but the underlying issue is the same.

```typescript
interface SimilarityMatch {
  matched: boolean;
  method: 'jaccard_stack' | 'levenshtein_message' | 'temporal_correlation';
  similarity_score: number;
  existing_observation_id: string;
}

// Jaccard similarity on normalized stack frames
function jaccardStackSimilarity(framesA: string[], framesB: string[]): number {
  const setA = new Set(framesA);
  const setB = new Set(framesB);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

// Levenshtein distance on error messages
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[a.length][b.length];
}

function levenshteinSimilarity(a: string, b: string): number {
  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - (distance / maxLen);
}

// Temporal correlation: same service, error spike within 5 minutes
function temporalCorrelation(
  candidateTimestamp: Date,
  existingTimestamp: Date,
  candidateService: string,
  existingService: string
): boolean {
  if (candidateService !== existingService) return false;
  const diffMs = Math.abs(candidateTimestamp.getTime() - existingTimestamp.getTime());
  return diffMs <= 5 * 60 * 1000; // 5 minutes
}

async function findSimilarObservations(
  candidate: CandidateObservation,
  recentObservations: ObservationSummary[]
): Promise<SimilarityMatch[]> {
  const matches: SimilarityMatch[] = [];

  for (const existing of recentObservations) {
    // Check 1: Jaccard on stack frames (>80%)
    if (candidate.stack_frames && existing.stack_frames) {
      const jaccard = jaccardStackSimilarity(candidate.stack_frames, existing.stack_frames);
      if (jaccard > 0.80) {
        matches.push({
          matched: true,
          method: 'jaccard_stack',
          similarity_score: jaccard,
          existing_observation_id: existing.id,
        });
        continue; // One match per existing observation
      }
    }

    // Check 2: Levenshtein on error messages (<20% distance = >80% similarity)
    if (candidate.error_message && existing.error_message) {
      const similarity = levenshteinSimilarity(candidate.error_message, existing.error_message);
      if (similarity > 0.80) {
        matches.push({
          matched: true,
          method: 'levenshtein_message',
          similarity_score: similarity,
          existing_observation_id: existing.id,
        });
        continue;
      }
    }

    // Check 3: Temporal correlation
    if (temporalCorrelation(
      candidate.timestamp, existing.timestamp,
      candidate.service, existing.service
    )) {
      matches.push({
        matched: true,
        method: 'temporal_correlation',
        similarity_score: 1.0,
        existing_observation_id: existing.id,
      });
    }
  }

  return matches;
}
```

**When fuzzy matching triggers**: The new candidate and the existing observation are presented to the LLM for a merge/separate decision. The LLM determines whether they represent the same root cause or distinct issues.

## Acceptance Criteria

1. Fingerprint is a SHA-256 hex hash of: `service_name | error_class | endpoint | error_code | normalized_top_3_stack_frames`.
2. Same logical error across deployments produces the same fingerprint after normalization.
3. Stack trace normalization removes line numbers (`Foo.java:42` -> `Foo.java:*`), memory addresses, thread IDs, and timestamps.
4. Only top 3 stack frames are included in the fingerprint.
5. Intra-run dedup: multiple instances merge into one with incremented `occurrence_count`.
6. Inter-run dedup (7 days): matching fingerprint for `pending` observation appends update, does not create new file.
7. Post-triage dedup (30 days): matching `dismissed` observation auto-dismisses with reason `"previously_dismissed_duplicate"`. Matching `promoted` observation flags as `"related_to_promoted"`.
8. Fingerprint store file (`.autonomous-dev/fingerprints/<service>.json`) is read at run start and written at run end.
9. Jaccard similarity on normalized stack frames flags matches > 80%.
10. Levenshtein on error messages flags matches where distance < 20% of message length (similarity > 80%).
11. Temporal correlation flags same-service error spikes within 5 minutes.
12. Fuzzy match triggers LLM merge/separate decision (not automatic merge).

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-3-3-01 | Fingerprint determinism | Same error, different timestamps | Same fingerprint hash |
| TC-3-3-02 | Fingerprint differs on endpoint | Same error, `/api/v1/orders` vs `/api/v2/users` | Different fingerprint hashes |
| TC-3-3-03 | Stack normalization: line numbers | `at Foo.bar(Foo.java:42)` | `at Foo.bar(Foo.java:*)` |
| TC-3-3-04 | Stack normalization: addresses | `at 0x7fff5fbff8a0` | `at 0x*` |
| TC-3-3-05 | Stack normalization: thread IDs | `[thread-42] at Foo.bar` | `[thread-*] at Foo.bar` |
| TC-3-3-06 | Stack normalization: timestamps | `2026-04-08T14:30:22Z at Foo.bar` | `<timestamp> at Foo.bar` |
| TC-3-3-07 | Top 3 frames only | Stack with 10 frames | Only first 3 contribute to fingerprint |
| TC-3-3-08 | Intra-run merge | Two candidates same fingerprint in one run | Merged: `occurrence_count = 2` |
| TC-3-3-09 | Inter-run update | Pending obs from 3 days ago, same fingerprint | `action: 'update_inter_run'` |
| TC-3-3-10 | Inter-run no match (>7d) | Pending obs from 10 days ago, same fingerprint | `action: 'new'` (outside 7d window) |
| TC-3-3-11 | Post-triage auto-dismiss | Dismissed obs from 15 days ago, same fingerprint | `action: 'auto_dismiss'`, reason `"previously_dismissed_duplicate"` |
| TC-3-3-12 | Post-triage related | Promoted obs from 20 days ago, same fingerprint | `action: 'related_to_promoted'` |
| TC-3-3-13 | Post-triage expired (>30d) | Dismissed obs from 35 days ago | `action: 'new'` (outside 30d window) |
| TC-3-3-14 | Jaccard > 80% | Frames: [A,B,C,D,E] vs [A,B,C,D,F] | Jaccard = 4/6 = 0.667 (no match, < 0.80) |
| TC-3-3-15 | Jaccard > 80% match | Frames: [A,B,C,D,E] vs [A,B,C,D,E,F] | Jaccard = 5/6 = 0.833 (match) |
| TC-3-3-16 | Levenshtein < 20% | `"ConnectionPoolExhausted: pool orders-db"` vs `"ConnectionPoolExhausted: pool users-db"` | Distance=8, length=40, ratio=20% -> borderline |
| TC-3-3-17 | Temporal within 5 min | Timestamps 3 min apart, same service | Temporal match |
| TC-3-3-18 | Temporal > 5 min | Timestamps 10 min apart | No temporal match |
| TC-3-3-19 | Temporal different service | Timestamps 1 min apart, different services | No temporal match |
