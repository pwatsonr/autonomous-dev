# SPEC-003-5-01: Document Lifecycle State Machine, Pipeline State Models, and State I/O

## Metadata
- **Parent Plan**: PLAN-003-5
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 11 hours

## Description
Implement the document lifecycle state machine (all valid state transitions per TDD Section 2.3), the `PipelineState` and `DocumentState` data models, and the atomic state file I/O for reading and writing `pipeline.yaml`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/flow/document-state-machine.ts` | Create |
| `src/pipeline/flow/pipeline-state.ts` | Create |
| `src/pipeline/flow/pipeline-state-io.ts` | Create |

## Implementation Details

### Task 1: `src/pipeline/flow/document-state-machine.ts`

```typescript
import { DocumentStatus } from '../types/frontmatter';

/**
 * Valid state transitions per TDD Section 2.3:
 *
 * draft              -> in-review           (submit for review)
 * in-review          -> approved            (review passed)
 * in-review          -> revision-requested  (review: changes needed)
 * in-review          -> rejected            (review: fundamentally flawed)
 * revision-requested -> in-review           (revision submitted / resubmit)
 * approved           -> stale               (backward cascade invalidation)
 * stale              -> approved            (re-approved after cascade)
 * stale              -> revision-requested  (needs revision after cascade)
 * any                -> cancelled           (cancellation)
 *
 * Terminal states (no outgoing transitions except cancelled):
 *   approved (can go to stale via cascade)
 *   rejected
 *   cancelled
 *
 * Invalid transitions (examples):
 *   approved  -> draft        (cannot un-approve to draft)
 *   rejected  -> in-review    (cannot resubmit after rejection)
 *   draft     -> approved     (cannot skip review)
 */

const VALID_TRANSITIONS: Map<DocumentStatus, Set<DocumentStatus>> = new Map([
  ['draft', new Set<DocumentStatus>(['in-review', 'cancelled'])],
  ['in-review', new Set<DocumentStatus>(['approved', 'revision-requested', 'rejected', 'cancelled'])],
  ['revision-requested', new Set<DocumentStatus>(['in-review', 'cancelled'])],
  ['approved', new Set<DocumentStatus>(['stale', 'cancelled'])],
  ['rejected', new Set<DocumentStatus>(['cancelled'])],
  ['stale', new Set<DocumentStatus>(['approved', 'revision-requested', 'cancelled'])],
  ['cancelled', new Set<DocumentStatus>([])], // Terminal
]);

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: DocumentStatus,
    public readonly to: DocumentStatus,
  ) {
    super(`Invalid state transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Validates and returns the target state if the transition is valid.
 *
 * @param currentStatus Current document status
 * @param targetStatus Desired target status
 * @returns The target status (unchanged)
 * @throws InvalidTransitionError if the transition is not valid
 */
export function validateTransition(
  currentStatus: DocumentStatus,
  targetStatus: DocumentStatus,
): DocumentStatus {
  const validTargets = VALID_TRANSITIONS.get(currentStatus);
  if (!validTargets || !validTargets.has(targetStatus)) {
    throw new InvalidTransitionError(currentStatus, targetStatus);
  }
  return targetStatus;
}

/**
 * Returns all valid target states from the given current state.
 */
export function getValidTransitions(currentStatus: DocumentStatus): DocumentStatus[] {
  return Array.from(VALID_TRANSITIONS.get(currentStatus) ?? []);
}

/**
 * Returns true if the given status is a terminal state
 * (no outgoing transitions to non-cancelled states).
 */
export function isTerminalState(status: DocumentStatus): boolean {
  return status === 'rejected' || status === 'cancelled';
}
```

### Task 2: `src/pipeline/flow/pipeline-state.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { DocumentStatus, Priority } from '../types/frontmatter';

export type PipelineStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export interface DocumentState {
  /** Document ID */
  documentId: string;
  /** Document type */
  type: DocumentType;
  /** Current lifecycle status */
  status: DocumentStatus;
  /** Current version string */
  version: string;
  /** Current review iteration (1-based, 0 if never reviewed) */
  reviewIteration: number;
  /** Last review aggregate score (null if never reviewed) */
  lastReviewScore: number | null;
  /** Agent currently assigned to this document (null if unassigned) */
  assignedAgent: string | null;
  /** Parent document ID */
  parentId: string | null;
  /** Child document IDs */
  children: string[];
  /** Document IDs that block this document */
  blockedBy: string[];
  /** Document IDs that this document blocks */
  blocking: string[];
}

export interface PipelineState {
  /** Pipeline ID */
  pipelineId: string;
  /** Pipeline title */
  title: string;
  /** Current status */
  status: PipelineStatus;
  /** Priority */
  priority: Priority;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last update timestamp */
  updatedAt: string;
  /** ISO 8601 timestamp when paused (null if not paused) */
  pausedAt: string | null;
  /** Per-document states keyed by document ID */
  documentStates: Record<string, DocumentState>;
  /** Active backward cascade event IDs */
  activeCascades: string[];
  /** Pipeline metrics */
  metrics: PipelineMetrics;
}

export interface PipelineMetrics {
  totalDocuments: number;
  documentsByStatus: Record<string, number>;
  totalVersions: number;
  totalReviews: number;
}

/**
 * Creates an initial empty PipelineState.
 */
export function createInitialPipelineState(
  pipelineId: string,
  title: string,
  priority: Priority = 'normal',
): PipelineState {
  const now = new Date().toISOString();
  return {
    pipelineId,
    title,
    status: 'ACTIVE',
    priority,
    createdAt: now,
    updatedAt: now,
    pausedAt: null,
    documentStates: {},
    activeCascades: [],
    metrics: {
      totalDocuments: 0,
      documentsByStatus: {},
      totalVersions: 0,
      totalReviews: 0,
    },
  };
}
```

### Task 3: `src/pipeline/flow/pipeline-state-io.ts`

```typescript
import * as fs from 'fs/promises';
import yaml from 'js-yaml';
import { PipelineState } from './pipeline-state';
import { DirectoryManager } from '../storage/directory-manager';
import { atomicWrite } from '../storage/atomic-io';

/**
 * Reads pipeline.yaml and deserializes to PipelineState.
 *
 * @returns PipelineState, or null if pipeline.yaml does not exist
 */
export async function readPipelineState(
  pipelineId: string,
  directoryManager: DirectoryManager,
): Promise<PipelineState | null> {
  const statePath = directoryManager.getPipelineYamlPath(pipelineId);

  try {
    const content = await fs.readFile(statePath, 'utf-8');
    const raw = yaml.load(content) as Record<string, unknown>;

    // Map YAML snake_case keys to TypeScript camelCase
    return mapYamlToPipelineState(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Serializes PipelineState to YAML and writes pipeline.yaml atomically.
 *
 * Pipeline.yaml format (snake_case for YAML convention):
 * ```yaml
 * pipeline_id: PIPE-2026-0408-001
 * title: "Feature X"
 * status: ACTIVE
 * priority: normal
 * created_at: "2026-04-08T12:00:00.000Z"
 * updated_at: "2026-04-08T12:00:00.000Z"
 * paused_at: null
 * document_states:
 *   PRD-001:
 *     document_id: PRD-001
 *     type: PRD
 *     status: draft
 *     version: "1.0"
 *     review_iteration: 0
 *     last_review_score: null
 *     assigned_agent: null
 *     parent_id: null
 *     children: []
 *     blocked_by: []
 *     blocking: []
 * active_cascades: []
 * metrics:
 *   total_documents: 1
 *   documents_by_status:
 *     draft: 1
 *   total_versions: 1
 *   total_reviews: 0
 * ```
 */
export async function writePipelineState(
  state: PipelineState,
  directoryManager: DirectoryManager,
): Promise<void> {
  const statePath = directoryManager.getPipelineYamlPath(state.pipelineId);

  // Update timestamp
  state.updatedAt = new Date().toISOString();

  // Map TypeScript camelCase to YAML snake_case
  const yamlObj = mapPipelineStateToYaml(state);

  const content = yaml.dump(yamlObj, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  await atomicWrite(statePath, content);
}

/**
 * Maps raw YAML (snake_case) to PipelineState (camelCase).
 */
function mapYamlToPipelineState(raw: Record<string, unknown>): PipelineState {
  // Map pipeline_id -> pipelineId, created_at -> createdAt, etc.
  // Map nested document_states with similar key conversion
  // ...
  return {} as PipelineState; // placeholder
}

/**
 * Maps PipelineState (camelCase) to YAML-friendly (snake_case) object.
 */
function mapPipelineStateToYaml(state: PipelineState): Record<string, unknown> {
  // Reverse mapping: pipelineId -> pipeline_id, etc.
  // ...
  return {}; // placeholder
}
```

## Acceptance Criteria
1. `validateTransition('draft', 'in-review')` succeeds.
2. `validateTransition('in-review', 'approved')` succeeds.
3. `validateTransition('in-review', 'revision-requested')` succeeds.
4. `validateTransition('in-review', 'rejected')` succeeds.
5. `validateTransition('revision-requested', 'in-review')` succeeds.
6. `validateTransition('approved', 'stale')` succeeds.
7. `validateTransition('stale', 'approved')` succeeds.
8. `validateTransition('stale', 'revision-requested')` succeeds.
9. Any state -> cancelled succeeds (except already cancelled).
10. `validateTransition('approved', 'draft')` throws `InvalidTransitionError`.
11. `validateTransition('rejected', 'in-review')` throws `InvalidTransitionError`.
12. `validateTransition('cancelled', 'draft')` throws `InvalidTransitionError`.
13. `PipelineState` tracks all fields from TDD Section 3.9.1.
14. `DocumentState` tracks documentId, type, status, version, reviewIteration, lastReviewScore, assignedAgent, parentId, children, blockedBy, blocking.
15. `readPipelineState` returns null when pipeline.yaml does not exist.
16. `writePipelineState` writes atomically and updates `updatedAt` timestamp.
17. Round-trip: write then read preserves all state fields.

## Test Cases

### Unit Tests: `tests/pipeline/flow/document-state-machine.test.ts`
- `draft -> in-review: valid`
- `in-review -> approved: valid`
- `in-review -> revision-requested: valid`
- `in-review -> rejected: valid`
- `revision-requested -> in-review: valid`
- `approved -> stale: valid`
- `stale -> approved: valid`
- `stale -> revision-requested: valid`
- `draft -> cancelled: valid`
- `in-review -> cancelled: valid`
- `approved -> cancelled: valid`
- `rejected -> cancelled: valid`
- `approved -> draft: INVALID`
- `rejected -> in-review: INVALID`
- `draft -> approved: INVALID (cannot skip review)`
- `cancelled -> anything: INVALID`
- `getValidTransitions(draft) returns [in-review, cancelled]`
- `isTerminalState(rejected) returns true`
- `isTerminalState(cancelled) returns true`
- `isTerminalState(approved) returns false`

### Unit Tests: `tests/pipeline/flow/pipeline-state.test.ts`
- `createInitialPipelineState creates state with ACTIVE status`
- `createInitialPipelineState has empty documentStates`
- `createInitialPipelineState has correct timestamps`
- `PipelineMetrics initial values are all zero`

### Unit Tests: `tests/pipeline/flow/pipeline-state-io.test.ts`
- `writePipelineState writes valid YAML`
- `readPipelineState reads back correct state`
- `round-trip: write -> read preserves all fields`
- `readPipelineState returns null for non-existent file`
- `writePipelineState uses atomic write`
- `writePipelineState updates updatedAt timestamp`
- `YAML uses snake_case keys (pipeline_id, not pipelineId)`
- `nested document_states deserialized correctly`
