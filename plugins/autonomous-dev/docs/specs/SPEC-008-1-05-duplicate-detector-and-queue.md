# SPEC-008-1-05: Duplicate Detector & Request Queue

## Metadata
- **Parent Plan**: PLAN-008-1
- **Tasks Covered**: Task 10, Task 11
- **Estimated effort**: 11 hours

## Description

Implement the semantic duplicate detector using local `all-MiniLM-L6-v2` embeddings via `@xenova/transformers`, and the priority request queue with FIFO ordering, depth enforcement, estimated wait time, and starvation prevention.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/core/duplicate_detector.ts` | Create |
| `intake/queue/request_queue.ts` | Create |
| `intake/queue/starvation_monitor.ts` | Create |

## Implementation Details

### Task 10: Duplicate Detector

**Embedding model setup:**

```typescript
import { pipeline } from '@xenova/transformers';

class DuplicateDetector {
  private embedder: FeatureExtractionPipeline | null = null;

  async initialize(): Promise<void> {
    this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
}
```

The model produces 384-dimensional `Float32Array` embeddings. The model (~50MB) is downloaded on first initialization and cached locally by `@xenova/transformers`.

**Detection algorithm:**

```typescript
async detectDuplicate(
  newRequest: ParsedRequest,
  db: Repository,
  config: DuplicateDetectionConfig
): Promise<DuplicateResult> {
  if (!config.enabled) {
    return { isDuplicate: false, candidates: [] };
  }

  const queryText = `${newRequest.title} ${newRequest.description}`;
  const queryEmbedding = await this.encode(queryText);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.lookback_days);
  const candidates = await db.getRequestEmbeddings(cutoff);

  const scored = candidates.map(c => ({
    requestId: c.request_id,
    title: c.title,
    similarity: cosineSimilarity(queryEmbedding, c.embedding),
    status: c.status,
  }));

  const matches = scored
    .filter(s => s.similarity >= config.similarity_threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  return { isDuplicate: matches.length > 0, candidates: matches };
}
```

**Cosine similarity function:**

```typescript
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
```

**Configuration defaults:**

```typescript
interface DuplicateDetectionConfig {
  enabled: boolean;           // default: true
  similarity_threshold: number; // default: 0.85
  lookback_days: number;      // default: 30
}
```

**Embedding storage:**
- Stored in `request_embeddings` table as raw BLOB (`Buffer.from(embedding.buffer)`).
- Retrieved via `new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)`.

**DuplicateResult:**

```typescript
interface DuplicateResult {
  isDuplicate: boolean;
  candidates: DuplicateCandidate[];
}

interface DuplicateCandidate {
  requestId: string;
  title: string;
  similarity: number;
  status: RequestStatus;
}
```

### Task 11: RequestQueue

**Queue ordering SQL (from TDD 3.7.1):**

```sql
SELECT * FROM requests
WHERE status = 'queued'
ORDER BY
  CASE priority
    WHEN 'high'   THEN 0
    WHEN 'normal'  THEN 1
    WHEN 'low'     THEN 2
  END ASC,
  created_at ASC;
```

**Enqueue with depth enforcement:**

```typescript
async enqueue(request: RequestEntity, config: QueueConfig): Promise<EnqueueResult> {
  const currentDepth = await this.db.getQueuedRequestCount();
  if (currentDepth >= config.max_depth) {
    return {
      success: false,
      error: `Queue is at capacity (${config.max_depth} requests).`,
      currentDepth,
    };
  }
  await this.db.insertRequest(request);
  const position = await this.db.getQueuePosition(request.request_id);
  const estimatedWait = await this.estimateWaitTime(position);
  return { success: true, requestId: request.request_id, position, estimatedWait };
}
```

**Queue config defaults:**

```typescript
interface QueueConfig {
  max_depth: number;  // default: 50
}
```

**Estimated wait time:**

```typescript
async estimateWaitTime(position: number): Promise<string> {
  const avgDuration = await this.db.getAveragePipelineDuration(20);
  const concurrentSlots = await this.db.getMaxConcurrentSlots();
  if (!avgDuration || !concurrentSlots) {
    return 'Unable to estimate (insufficient history)';
  }
  const waitMs = (position / concurrentSlots) * avgDuration;
  return formatDuration(waitMs);
}
```

Uses a rolling average of the last 20 completed requests' total duration, divided by concurrent pipeline slots.

**Starvation Monitor (`starvation_monitor.ts`):**

```typescript
class StarvationMonitor {
  private timer: NodeJS.Timeout | null = null;

  start(config: StarvationConfig): void {
    this.timer = setInterval(() => this.promote(config), config.check_interval_ms);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async promote(config: StarvationConfig): Promise<PromotionResult[]> {
    const now = new Date();
    const threshold = new Date(now.getTime() - config.threshold_hours * 3600000);

    // Promote low -> normal
    const lowPromotions = await this.db.promoteStarvedRequests(
      'low', 'normal', threshold, now
    );

    // Promote normal -> high
    const normalPromotions = await this.db.promoteStarvedRequests(
      'normal', 'high', threshold, now
    );

    return [...lowPromotions, ...normalPromotions];
  }
}
```

**Starvation config defaults:**

```typescript
interface StarvationConfig {
  check_interval_ms: number;   // default: 900_000 (15 minutes)
  threshold_hours: number;     // default: 48
}
```

**Promotion SQL:**

```sql
UPDATE requests
SET priority = ?,
    updated_at = ?,
    promotion_count = promotion_count + 1,
    last_promoted_at = ?
WHERE status = 'queued'
  AND priority = ?
  AND COALESCE(last_promoted_at, created_at) < ?
RETURNING request_id
```

**Key design rule**: Promotion is relative to `last_promoted_at`, not `created_at`. A low request promoted to normal at T+48h must wait another 48h before promoting to high. This prevents double-promotion in a single cycle.

## Acceptance Criteria

1. `DuplicateDetector.initialize()` loads the `all-MiniLM-L6-v2` model without error.
2. `cosineSimilarity` returns 1.0 for identical vectors, 0.0 for orthogonal vectors.
3. Two semantically similar descriptions (e.g., "Add user authentication with OAuth2" and "Implement OAuth2-based user auth") produce similarity > 0.85.
4. Two unrelated descriptions (e.g., "Add user auth" and "Fix CSS grid layout in dashboard") produce similarity < 0.5.
5. When `config.enabled = false`, `detectDuplicate` returns `{ isDuplicate: false, candidates: [] }` without calling the embedder.
6. At most 5 candidates are returned, sorted by similarity descending.
7. Queue enqueue succeeds when depth < max_depth.
8. Queue enqueue fails with `QUEUE_FULL` error when depth >= max_depth.
9. Queue position reflects priority ordering: high before normal before low.
10. Queue position is FIFO within the same priority level.
11. Estimated wait time returns a formatted duration string when history is available.
12. Estimated wait time returns "Unable to estimate" when no completed requests exist.
13. Starvation monitor promotes `low` -> `normal` after threshold hours.
14. Starvation monitor promotes `normal` -> `high` after threshold hours.
15. Starvation monitor does NOT promote `high` (already highest).
16. Double-promotion guard: a request promoted from low to normal at T must wait another threshold period before promoting to high.
17. `promotion_count` increments on each promotion; `last_promoted_at` updates.

## Test Cases

1. **Cosine similarity: identical**: `cosineSimilarity(v, v)` === 1.0 for any non-zero vector.
2. **Cosine similarity: orthogonal**: `cosineSimilarity([1,0,0], [0,1,0])` === 0.0.
3. **Cosine similarity: zero vector**: `cosineSimilarity([0,0,0], [1,1,1])` === 0.0 (no divide-by-zero).
4. **Cosine similarity: known pair**: Verify with a hand-computed example (e.g., `[1,2,3]` vs `[4,5,6]`).
5. **Duplicate: disabled config**: `enabled: false` -> returns immediately with empty candidates.
6. **Duplicate: no candidates**: Fresh database, no prior requests -> `isDuplicate: false`.
7. **Duplicate: exact match**: Insert request A, then detect with identical text -> `isDuplicate: true`, similarity ~1.0.
8. **Duplicate: below threshold**: Insert request A, detect with completely unrelated text -> `isDuplicate: false`.
9. **Duplicate: top 5 limit**: Insert 10 similar requests, verify only 5 returned.
10. **Duplicate: lookback window**: Insert old request (31 days ago), verify it is excluded from candidates.
11. **Queue: basic enqueue**: Enqueue a request, verify position is 1.
12. **Queue: priority ordering**: Enqueue low, then high, then normal; verify positions are high=1, normal=2, low=3.
13. **Queue: FIFO within priority**: Enqueue 3 normal requests at T, T+1s, T+2s; verify positions are in insertion order.
14. **Queue: depth enforcement**: Set max_depth=2, enqueue 2 requests (success), enqueue 3rd (failure with QUEUE_FULL).
15. **Queue: estimated wait**: Seed 20 completed requests with known durations (avg 1 hour), 1 concurrent slot; enqueue at position 3; verify estimated wait ~3 hours.
16. **Starvation: low -> normal**: Insert a low-priority request created 49 hours ago; run promote; verify priority is now `normal`.
17. **Starvation: normal -> high**: Insert a normal-priority request created 49 hours ago; run promote; verify priority is now `high`.
18. **Starvation: not yet ready**: Insert a low-priority request created 47 hours ago (under 48h threshold); run promote; verify priority is still `low`.
19. **Starvation: double-promotion guard**: Insert low request at T-49h, promote (low->normal), then immediately run promote again; verify it is NOT promoted to high (last_promoted_at is recent).
20. **Starvation: promotion_count**: After 2 promotions, verify `promotion_count = 2`.
