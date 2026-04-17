# SPEC-008-1-02: Repository Data Access Layer & Request ID Generation

## Metadata
- **Parent Plan**: PLAN-008-1
- **Tasks Covered**: Task 3, Task 4
- **Estimated effort**: 9 hours

## Description

Build the typed data access layer (`Repository`) that provides parameterized CRUD operations for all tables, along with the atomic request ID generator. The repository is the single point of database interaction for the entire intake layer -- no other module writes raw SQL.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/db/repository.ts` | Create |

## Implementation Details

### Task 3: Repository Data Access Layer

The `Repository` class wraps a `better-sqlite3` database instance and exposes typed methods with parameterized queries. All methods use prepared statements for performance.

**Constructor:**

```typescript
class Repository {
  constructor(private db: BetterSqlite3.Database) {}
}
```

**Required methods with signatures:**

```typescript
// Request CRUD
insertRequest(request: RequestEntity): void;
getRequest(requestId: string): RequestEntity | null;
updateRequest(requestId: string, updates: Partial<RequestEntity>): void;

// Queue queries
getQueuedRequestCount(): number;
getQueuePosition(requestId: string): number;
getQueuedCountByPriority(): Record<Priority, number>;

// Conversation messages
insertConversationMessage(msg: ConversationMessage): string; // Returns message_id (UUID)
markMessageResponded(messageId: string): void;
getPendingPrompts(): ConversationMessage[];

// Activity logging
insertActivityLog(entry: ActivityLogEntry): void;
getActivityLog(requestId: string, limit?: number): ActivityLogEntry[];

// Audit logging
insertAuditLog(decision: AuthzDecision): void;

// Rate limiting
countActions(userId: string, actionType: string, windowStart: Date): number;
recordAction(userId: string, actionType: string, timestamp: Date): void;
getOldestActionInWindow(userId: string, actionType: string, windowStart: Date): Date | null;

// Embeddings
insertEmbedding(requestId: string, embedding: Float32Array): void;
getRequestEmbeddings(cutoffDate: Date): EmbeddingCandidate[];

// Aggregations for digest and queue
countRequestsByState(): Record<RequestStatus, number>;
getBlockedRequests(): RequestEntity[];
getCompletedSince(since: Date): RequestEntity[];
getAveragePipelineDuration(sampleSize: number): number | null;
getMaxConcurrentSlots(): number;

// Notification delivery tracking
insertDelivery(delivery: NotificationDelivery): number;
updateDeliveryStatus(deliveryId: number, status: string, error?: string): void;
findDuplicateDelivery(requestId: string, payloadHash: string): NotificationDelivery | null;

// User identity
getUserByPlatformId(channelType: ChannelType, platformId: string): UserIdentity | null;
getUserByInternalId(internalId: string): UserIdentity | null;
upsertUser(user: UserIdentity): void;
getUserCount(): number;

// Shutdown support
checkpoint(): void; // PRAGMA wal_checkpoint(TRUNCATE)

// Transaction support
transaction<T>(fn: () => T): T;
```

**Key implementation rules:**

- All queries use `?` placeholders, never string interpolation.
- `insertConversationMessage` generates a UUID v4 for `message_id`.
- `getQueuePosition` uses the priority-ordered query from TDD section 3.7.1 and counts rows ahead of the target request.
- `getRequestEmbeddings(cutoffDate)` returns rows where the associated request is `queued`, `active`, or completed after `cutoffDate`.
- `getAveragePipelineDuration(sampleSize)` computes the average of `(updated_at - created_at)` in milliseconds for the last `sampleSize` requests with status `done`.
- `getMaxConcurrentSlots` reads from `intake-config.yaml` (or returns a default of 1).
- `checkpoint()` executes `PRAGMA wal_checkpoint(TRUNCATE)`.
- `transaction()` wraps `db.transaction()` from `better-sqlite3`.
- Embedding BLOBs are stored as raw `Buffer` from `Float32Array.buffer`.

### Task 4: Request ID Generation

Atomic counter in SQLite using the `id_counter` table:

```typescript
generateRequestId(): string {
  const result = this.db.prepare(`
    UPDATE id_counter
    SET current_value = current_value + 1
    WHERE counter_name = 'request_id'
    RETURNING current_value
  `).get() as { current_value: number };
  return `REQ-${String(result.current_value).padStart(6, '0')}`;
}
```

The `UPDATE ... RETURNING` is atomic within SQLite's single-writer lock, preventing duplicate IDs under any concurrency scenario.

## Acceptance Criteria

1. All methods listed above are implemented and exported.
2. Every SQL query uses parameterized placeholders (`?`), never string concatenation.
3. `generateRequestId()` produces `REQ-000001`, `REQ-000002`, etc. in sequence.
4. `generateRequestId()` never produces duplicate IDs even when called rapidly in a loop.
5. `insertConversationMessage` returns a valid UUID v4 string.
6. `getQueuePosition` returns 1-based position using priority + FIFO ordering.
7. `checkpoint()` executes without error on an open WAL-mode database.
8. `transaction()` rolls back all changes if the callback throws.
9. Embedding round-trip: `insertEmbedding` followed by `getRequestEmbeddings` returns the exact same `Float32Array` values.

## Test Cases

1. **Request CRUD round-trip**: Insert a request, retrieve by ID, verify all fields match.
2. **Update partial fields**: Insert a request, update `priority` and `status`, verify only those fields changed and `updated_at` advanced.
3. **ID sequence**: Call `generateRequestId()` 100 times, verify all unique and sequential from `REQ-000001` to `REQ-000100`.
4. **ID format**: Verify output matches `/^REQ-\d{6}$/`.
5. **Queue position ordering**: Insert 3 requests (low, high, normal priority), verify `getQueuePosition` returns 1 for high, 2 for normal, 3 for low.
6. **Queue FIFO within priority**: Insert 3 normal-priority requests at different times, verify positions are in insertion order.
7. **Conversation message UUID**: Call `insertConversationMessage` twice, verify both return distinct valid UUID v4 strings.
8. **Rate limit counting**: Record 5 actions for user A, record 3 for user B, verify `countActions` returns correct counts per user.
9. **Rate limit windowing**: Record actions at various timestamps, verify `countActions` only counts those within the window.
10. **Embedding round-trip**: Create a `Float32Array([0.1, 0.2, 0.3])`, insert, retrieve, verify byte-exact equality.
11. **Transaction rollback**: Start a transaction, insert a request, throw an error, verify the request is not in the database.
12. **Checkpoint**: Call `checkpoint()` on a WAL-mode database, verify no error thrown.
13. **getUserByPlatformId**: Insert a user with `discord_id`, look up by `('discord', id)`, verify match. Look up by `('slack', id)`, verify null.
14. **countRequestsByState**: Insert requests in various states, verify aggregation counts match.
