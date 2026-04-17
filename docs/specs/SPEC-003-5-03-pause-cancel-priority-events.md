# SPEC-003-5-03: Pause/Resume, Cancellation, Priority Change, and Event Emitter

## Metadata
- **Parent Plan**: PLAN-003-5
- **Tasks Covered**: Task 6, Task 7, Task 8, Task 9
- **Estimated effort**: 15 hours

## Description
Implement the pause/resume handler (halts and restarts pipeline processing), the cancellation handler (full pipeline and subtree cancellation), the priority change handler (propagates priority to all documents), and the pipeline event emitter (structured event emission with all 25 event types).

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/flow/pause-resume-handler.ts` | Create |
| `src/pipeline/flow/cancellation-handler.ts` | Create |
| `src/pipeline/flow/priority-handler.ts` | Create |
| `src/pipeline/flow/event-emitter.ts` | Create |

## Implementation Details

### Task 6: `src/pipeline/flow/pause-resume-handler.ts`

```typescript
import { PipelineState } from './pipeline-state';
import { readPipelineState, writePipelineState } from './pipeline-state-io';
import { DirectoryManager } from '../storage/directory-manager';

export interface PauseResult {
  success: boolean;
  wasAlreadyPaused: boolean;
  pausedAt: string | null;
}

export interface ResumeResult {
  success: boolean;
  wasAlreadyActive: boolean;
  /** Document IDs that are ready to proceed after resume */
  readyDocuments: string[];
}

/**
 * Pauses a pipeline.
 *
 * Behavior per TDD Section 3.9.4:
 *   - Sets status to PAUSED.
 *   - Records paused_at timestamp.
 *   - Documents retain their current state (no status changes).
 *   - In-review documents are NOT interrupted mid-review.
 *   - Pausing an already-paused pipeline is a no-op.
 *   - Writes pipeline.yaml atomically.
 *   - Emits "pipeline_paused" event.
 */
export async function pausePipeline(
  pipelineId: string,
  directoryManager: DirectoryManager,
  actorId: string,
): Promise<PauseResult> {
  const state = await readPipelineState(pipelineId, directoryManager);
  if (!state) throw new Error(`Pipeline ${pipelineId} not found`);

  if (state.status === 'PAUSED') {
    return { success: true, wasAlreadyPaused: true, pausedAt: state.pausedAt };
  }

  if (state.status !== 'ACTIVE') {
    throw new Error(`Cannot pause pipeline in ${state.status} state`);
  }

  state.status = 'PAUSED';
  state.pausedAt = new Date().toISOString();
  await writePipelineState(state, directoryManager);

  return { success: true, wasAlreadyPaused: false, pausedAt: state.pausedAt };
}

/**
 * Resumes a paused pipeline.
 *
 * Behavior per TDD Section 3.9.4:
 *   - Sets status to ACTIVE.
 *   - Clears paused_at.
 *   - Re-evaluates all documents:
 *     - draft documents with met dependencies: ready to assign
 *     - in-review documents: continue review (already in progress)
 *     - revision-requested documents: ready to assign for revision
 *   - Resuming a non-paused pipeline is a no-op.
 *   - Writes pipeline.yaml atomically.
 *   - Emits "pipeline_resumed" event.
 */
export async function resumePipeline(
  pipelineId: string,
  directoryManager: DirectoryManager,
  actorId: string,
): Promise<ResumeResult> {
  const state = await readPipelineState(pipelineId, directoryManager);
  if (!state) throw new Error(`Pipeline ${pipelineId} not found`);

  if (state.status !== 'PAUSED') {
    return { success: true, wasAlreadyActive: true, readyDocuments: [] };
  }

  state.status = 'ACTIVE';
  state.pausedAt = null;

  // Identify documents ready to proceed
  const readyDocuments: string[] = [];
  for (const [docId, docState] of Object.entries(state.documentStates)) {
    if (docState.status === 'draft' || docState.status === 'revision-requested') {
      const depsApproved = docState.blockedBy.every(bid =>
        state.documentStates[bid]?.status === 'approved',
      );
      if (depsApproved) readyDocuments.push(docId);
    }
  }

  await writePipelineState(state, directoryManager);

  return { success: true, wasAlreadyActive: false, readyDocuments };
}
```

### Task 7: `src/pipeline/flow/cancellation-handler.ts`

```typescript
import { PipelineState } from './pipeline-state';
import { readPipelineState, writePipelineState } from './pipeline-state-io';
import { DirectoryManager } from '../storage/directory-manager';

export interface CancellationResult {
  success: boolean;
  /** Documents that were cancelled (changed status) */
  cancelledDocuments: string[];
  /** Documents that were already in terminal state (not changed) */
  preservedDocuments: string[];
  mode: 'full' | 'subtree';
}

/**
 * Cancels a pipeline (full or subtree).
 *
 * Full cancellation (TDD Section 3.9.5):
 *   - Pipeline status set to CANCELLED.
 *   - Non-terminal documents (draft, in-review, revision-requested, stale)
 *     are marked as "cancelled".
 *   - Terminal documents (approved, rejected) preserve their status.
 *   - All files preserved for forensic review.
 *   - Emits "pipeline_cancelled" event.
 *
 * Subtree cancellation:
 *   - Only affects the specified rootDocumentId and its descendants.
 *   - Siblings are unaffected.
 *   - Pipeline status remains ACTIVE (unless all documents are now terminal).
 *   - Traceability matrix updated (delegated to caller).
 *   - Emits "subtree_cancelled" event.
 */
export async function cancelPipeline(
  pipelineId: string,
  directoryManager: DirectoryManager,
  mode: 'full' | 'subtree',
  rootDocumentId?: string,
  actorId?: string,
): Promise<CancellationResult> {
  const state = await readPipelineState(pipelineId, directoryManager);
  if (!state) throw new Error(`Pipeline ${pipelineId} not found`);

  const cancelledDocuments: string[] = [];
  const preservedDocuments: string[] = [];

  if (mode === 'full') {
    state.status = 'CANCELLED';

    for (const [docId, docState] of Object.entries(state.documentStates)) {
      if (isNonTerminal(docState.status)) {
        docState.status = 'cancelled';
        cancelledDocuments.push(docId);
      } else {
        preservedDocuments.push(docId);
      }
    }
  } else {
    // Subtree cancellation
    if (!rootDocumentId) throw new Error('rootDocumentId required for subtree cancellation');

    const subtreeIds = collectSubtreeIds(rootDocumentId, state);
    for (const docId of subtreeIds) {
      const docState = state.documentStates[docId];
      if (docState && isNonTerminal(docState.status)) {
        docState.status = 'cancelled';
        cancelledDocuments.push(docId);
      } else if (docState) {
        preservedDocuments.push(docId);
      }
    }
  }

  await writePipelineState(state, directoryManager);

  return {
    success: true,
    cancelledDocuments,
    preservedDocuments,
    mode,
  };
}

function isNonTerminal(status: string): boolean {
  return !['approved', 'rejected', 'cancelled'].includes(status);
}

/**
 * Collects all document IDs in the subtree rooted at the given document.
 */
function collectSubtreeIds(rootId: string, state: PipelineState): string[] {
  const result: string[] = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const docState = state.documentStates[current];
    if (docState) {
      for (const childId of docState.children) {
        result.push(childId);
        queue.push(childId);
      }
    }
  }
  return result;
}
```

### Task 8: `src/pipeline/flow/priority-handler.ts`

```typescript
import { Priority } from '../types/frontmatter';
import { PipelineState } from './pipeline-state';
import { readPipelineState, writePipelineState } from './pipeline-state-io';
import { DirectoryManager } from '../storage/directory-manager';

const VALID_PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low'];

export class InvalidPriorityError extends Error {
  constructor(public readonly priority: string) {
    super(`Invalid priority: ${priority}. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
    this.name = 'InvalidPriorityError';
  }
}

/**
 * Changes the pipeline priority and propagates to all document frontmatter.
 *
 * Per TDD Section 3.9.6:
 *   - Updates priority in pipeline.yaml.
 *   - Propagates to all document frontmatter (requires versioning updates).
 *     For MVP: updates pipeline state only; frontmatter updates are best-effort.
 *   - Emits "priority_changed" event.
 *
 * @throws InvalidPriorityError for invalid priority values
 */
export async function changePriority(
  pipelineId: string,
  newPriority: Priority,
  directoryManager: DirectoryManager,
  actorId: string,
): Promise<PipelineState> {
  if (!VALID_PRIORITIES.includes(newPriority)) {
    throw new InvalidPriorityError(newPriority);
  }

  const state = await readPipelineState(pipelineId, directoryManager);
  if (!state) throw new Error(`Pipeline ${pipelineId} not found`);

  state.priority = newPriority;
  await writePipelineState(state, directoryManager);

  return state;
}
```

### Task 9: `src/pipeline/flow/event-emitter.ts`

```typescript
import { AuditLogger, PipelineEvent } from '../storage/audit-logger';

/**
 * All 25 pipeline event types per TDD Section 3.9.7.
 */
export type PipelineEventType =
  // Pipeline lifecycle
  | 'pipeline_created'
  | 'pipeline_paused'
  | 'pipeline_resumed'
  | 'pipeline_cancelled'
  | 'pipeline_completed'
  | 'pipeline_failed'
  | 'priority_changed'
  // Document lifecycle
  | 'document_created'
  | 'document_submitted_for_review'
  | 'review_completed'
  | 'document_approved'
  | 'document_revision_requested'
  | 'document_rejected'
  | 'revision_submitted'
  | 'document_cancelled'
  | 'document_marked_stale'
  | 'document_re_approved'
  // Versioning
  | 'version_created'
  | 'rollback_executed'
  | 'quality_regression_detected'
  // Decomposition
  | 'decomposition_requested'
  | 'decomposition_completed'
  // Cascade
  | 'cascade_initiated'
  | 'cascade_resolved'
  // Escalation
  | 'human_escalation';

export interface EventBusListener {
  onEvent(event: PipelineEvent): void | Promise<void>;
}

/**
 * Emits structured pipeline events.
 *
 * All events are:
 *   1. Appended to the audit log (via AuditLogger).
 *   2. Dispatched to optional event bus listeners.
 *
 * Event structure (PipelineEvent):
 *   eventId:     UUID v4
 *   pipelineId:  Pipeline this event belongs to
 *   timestamp:   ISO 8601
 *   eventType:   PipelineEventType
 *   documentId:  (optional) Document this event relates to
 *   details:     Free-form event-specific details
 *   actorId:     Agent or system that triggered the event
 *   previousHash: Hash chain for audit integrity
 */
export class PipelineEventEmitter {
  private listeners: EventBusListener[] = [];

  constructor(private readonly auditLogger: AuditLogger) {}

  /**
   * Emits an event: writes to audit log and dispatches to listeners.
   */
  async emit(
    pipelineId: string,
    eventType: PipelineEventType,
    details: Record<string, unknown>,
    actorId: string,
    documentId?: string,
  ): Promise<PipelineEvent> {
    // Write to audit log
    const event = await this.auditLogger.appendEvent(
      pipelineId,
      eventType,
      details,
      actorId,
      documentId,
    );

    // Dispatch to listeners (fire-and-forget for MVP)
    for (const listener of this.listeners) {
      try {
        await listener.onEvent(event);
      } catch {
        // Listener errors do not block event processing
      }
    }

    return event;
  }

  /**
   * Registers an event bus listener.
   */
  addListener(listener: EventBusListener): void {
    this.listeners.push(listener);
  }

  /**
   * Removes an event bus listener.
   */
  removeListener(listener: EventBusListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }
}
```

## Acceptance Criteria
1. `pausePipeline` sets status to PAUSED, records paused_at, documents retain status.
2. `pausePipeline` on already-paused pipeline is a no-op (returns wasAlreadyPaused: true).
3. `pausePipeline` rejects non-ACTIVE pipelines (e.g., CANCELLED).
4. `resumePipeline` sets status to ACTIVE, clears paused_at.
5. `resumePipeline` identifies draft/revision-requested documents with met dependencies as ready.
6. `resumePipeline` on non-PAUSED pipeline is a no-op.
7. Full cancellation sets pipeline status to CANCELLED, cancels non-terminal documents, preserves approved/rejected.
8. Subtree cancellation only affects the root and its descendants, siblings unaffected.
9. Subtree cancellation does not change pipeline-level status (remains ACTIVE).
10. `changePriority` updates pipeline.yaml priority field.
11. `changePriority` throws `InvalidPriorityError` for invalid values.
12. `PipelineEventEmitter` writes events to audit log via AuditLogger.
13. `PipelineEventEmitter` dispatches to registered listeners.
14. `PipelineEventType` enum defines all 25 event types from TDD Section 3.9.7.
15. Listener errors do not block event processing.

## Test Cases

### Unit Tests: `tests/pipeline/flow/pause-resume-handler.test.ts`
- `pausePipeline: ACTIVE -> PAUSED with timestamp`
- `pausePipeline: already PAUSED -> no-op`
- `pausePipeline: CANCELLED -> throws`
- `pausePipeline: documents retain their status`
- `resumePipeline: PAUSED -> ACTIVE, clears paused_at`
- `resumePipeline: not PAUSED -> no-op`
- `resumePipeline: identifies ready documents`
- `resumePipeline: draft with unmet dependency not in readyDocuments`

### Unit Tests: `tests/pipeline/flow/cancellation-handler.test.ts`
- `full cancel: pipeline status becomes CANCELLED`
- `full cancel: draft documents become cancelled`
- `full cancel: in-review documents become cancelled`
- `full cancel: approved documents preserved`
- `full cancel: rejected documents preserved`
- `subtree cancel: only root and descendants cancelled`
- `subtree cancel: siblings unaffected`
- `subtree cancel: pipeline status remains ACTIVE`
- `subtree cancel: requires rootDocumentId`

### Unit Tests: `tests/pipeline/flow/priority-handler.test.ts`
- `changePriority updates pipeline priority`
- `changePriority: critical, high, normal, low all valid`
- `changePriority throws InvalidPriorityError for invalid value`
- `changePriority writes pipeline.yaml`

### Unit Tests: `tests/pipeline/flow/event-emitter.test.ts`
- `emit writes event to audit log`
- `emit dispatches to registered listeners`
- `emit includes eventId, pipelineId, timestamp, eventType, actorId`
- `emit includes documentId when provided`
- `listener error does not prevent other listeners from receiving event`
- `addListener/removeListener manage listener list`
- `PipelineEventType has 25 values`
