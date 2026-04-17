# SPEC-003-5-04: Backward Cascade Event Model, Scoper, Depth Limiter, and Orchestrator

## Metadata
- **Parent Plan**: PLAN-003-5
- **Tasks Covered**: Task 10, Task 11, Task 12, Task 13
- **Estimated effort**: 19 hours

## Description
Implement the backward cascade subsystem: the cascade event data model, the scoped cascade logic (partitions affected vs. unaffected children), the cascade depth limiter (enforces max depth with escalation), and the cascade orchestrator that coordinates the full 9-step cascade flow (validate, identify, pause, stale, re-open, revise, re-evaluate, resume).

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/cascade/cascade-event.ts` | Create |
| `src/pipeline/cascade/cascade-scoper.ts` | Create |
| `src/pipeline/cascade/depth-limiter.ts` | Create |
| `src/pipeline/cascade/cascade-controller.ts` | Create |

## Implementation Details

### Task 10: `src/pipeline/cascade/cascade-event.ts`

```typescript
import { DocumentType } from '../types/document-type';

export type CascadeStatus =
  | 'initiated'
  | 'parent_revised'
  | 'children_re_evaluated'
  | 'resolved'
  | 'escalated';

export interface AffectedDocument {
  documentId: string;
  type: DocumentType;
  previousStatus: string;
  newStatus: string;
}

export interface BackwardCascadeEvent {
  /** Cascade event ID: CASCADE-{PIPE_SEQ}-{SEQ} */
  id: string;
  /** Pipeline this cascade belongs to */
  pipelineId: string;
  /** What triggered the cascade */
  triggeredBy: {
    /** The review that found the defect */
    reviewId: string;
    /** The specific finding in the review */
    findingDescription: string;
    /** The reviewer agent */
    reviewerAgent: string;
  };
  /** The document containing the defect */
  targetDocument: {
    documentId: string;
    type: DocumentType;
    /** Section IDs in the target that are affected */
    affectedSections: string[];
  };
  /** Documents affected by the cascade */
  affectedDocuments: AffectedDocument[];
  /** Current status of the cascade */
  status: CascadeStatus;
  /** Current cascade depth (1 = direct parent, 2 = grandparent, etc.) */
  cascadeDepth: number;
  /** Maximum cascade depth allowed */
  maxDepth: number;
  /** ISO 8601 timestamps for each status transition */
  timestamps: {
    initiated: string;
    parentRevised?: string;
    childrenReEvaluated?: string;
    resolved?: string;
    escalated?: string;
  };
}

/**
 * Generates a cascade event ID.
 * Format: CASCADE-{PIPE_SEQ}-{SEQ}
 * Where PIPE_SEQ is extracted from the pipeline ID and SEQ is incremented.
 */
export function generateCascadeId(pipelineId: string, sequence: number): string {
  const pipeSeq = pipelineId.split('-').pop()!;
  return `CASCADE-${pipeSeq}-${String(sequence).padStart(3, '0')}`;
}
```

### Task 11: `src/pipeline/cascade/cascade-scoper.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { analyzeImpact } from '../traceability/impact-analyzer';

export interface CascadeScopeResult {
  /** Child document IDs affected by the cascade (traces_from intersects affected sections) */
  affectedChildren: string[];
  /** Child document IDs NOT affected (remain in current state) */
  unaffectedChildren: string[];
  /** All transitively affected documents (children + their descendants) */
  allAffectedDocuments: string[];
}

/**
 * Determines which children are affected by a parent defect.
 *
 * Algorithm (TDD Section 3.8.3):
 *   1. Get all direct children of the target document from the tree.
 *   2. For each child: read its traces_from entries.
 *   3. If traces_from intersects the affected section IDs: child is affected.
 *   4. For affected children: add all their descendants to the affected set.
 *   5. Unaffected children (no intersection) remain in their current state.
 *
 * Uses the traceability impact analyzer (PLAN-003-4) for transitive impact.
 *
 * @param pipelineId Pipeline ID
 * @param targetDocumentId The document containing the defect
 * @param affectedSections Section IDs in the target that are affected
 * @param childIds Direct child document IDs
 * @param storage Document storage layer
 */
export async function scopeCascade(
  pipelineId: string,
  targetDocumentId: string,
  affectedSections: string[],
  childIds: string[],
  storage: DocumentStorage,
): Promise<CascadeScopeResult> {
  const affectedSectionSet = new Set(affectedSections);
  const affectedChildren: string[] = [];
  const unaffectedChildren: string[] = [];

  for (const childId of childIds) {
    // Read child's traces_from
    // Need to determine child's type from pipeline state
    const allDocs = await storage.listDocuments(pipelineId);
    const childDoc = allDocs.find(d => d.documentId === childId);
    if (!childDoc) {
      unaffectedChildren.push(childId);
      continue;
    }

    const fullChild = await storage.readDocument(pipelineId, childDoc.type, childId);
    const tracesFrom = (fullChild.frontmatter.traces_from as string[]) ?? [];

    const isAffected = tracesFrom.some(t => affectedSectionSet.has(t));
    if (isAffected) {
      affectedChildren.push(childId);
    } else {
      unaffectedChildren.push(childId);
    }
  }

  // Get all transitively affected documents
  const allAffectedDocuments = await analyzeImpact(
    pipelineId,
    targetDocumentId,
    affectedSections,
    storage,
  );

  return {
    affectedChildren,
    unaffectedChildren,
    allAffectedDocuments,
  };
}
```

### Task 12: `src/pipeline/cascade/depth-limiter.ts`

```typescript
import { PipelineConfig } from '../types/config';

export type DepthLimitAction = 'proceed' | 'proceed_with_warning' | 'escalate';

export interface DepthLimitResult {
  action: DepthLimitAction;
  currentDepth: number;
  maxDepth: number;
  message: string;
}

/**
 * Enforces cascade depth limits.
 *
 * Rules (TDD Section 3.8.4):
 *   Depth 1 (direct parent): automatic, no warning.
 *   Depth 2 (grandparent): automatic with warning logged.
 *   Depth 3+: escalate to human.
 *
 * Default maxDepth: 2 (configurable via backward_cascade.max_depth).
 *
 * @param currentDepth The current cascade depth (1 = direct parent revision)
 * @param config Pipeline configuration
 * @returns DepthLimitResult with action recommendation
 */
export function checkCascadeDepth(
  currentDepth: number,
  config: PipelineConfig,
): DepthLimitResult {
  const maxDepth = config.backwardCascade.maxDepth;

  if (currentDepth > maxDepth) {
    return {
      action: 'escalate',
      currentDepth,
      maxDepth,
      message: `Cascade depth ${currentDepth} exceeds maximum ${maxDepth}. Human escalation required.`,
    };
  }

  if (currentDepth === maxDepth) {
    return {
      action: 'proceed_with_warning',
      currentDepth,
      maxDepth,
      message: `Cascade at maximum depth ${currentDepth}/${maxDepth}. Proceeding with warning.`,
    };
  }

  return {
    action: 'proceed',
    currentDepth,
    maxDepth,
    message: `Cascade depth ${currentDepth} within limits.`,
  };
}
```

### Task 13: `src/pipeline/cascade/cascade-controller.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { PipelineConfig } from '../types/config';
import { DocumentStorage } from '../storage/document-storage';
import { VersioningEngine } from '../versioning/versioning-engine';
import { PipelineState } from '../flow/pipeline-state';
import { readPipelineState, writePipelineState } from '../flow/pipeline-state-io';
import { DirectoryManager } from '../storage/directory-manager';
import { BackwardCascadeEvent, CascadeStatus, generateCascadeId, AffectedDocument } from './cascade-event';
import { scopeCascade, CascadeScopeResult } from './cascade-scoper';
import { checkCascadeDepth, DepthLimitResult } from './depth-limiter';
import { PipelineEventEmitter } from '../flow/event-emitter';

export interface CascadeInitiateRequest {
  pipelineId: string;
  /** The review that found the upstream defect */
  reviewId: string;
  /** The reviewer agent */
  reviewerAgent: string;
  /** Description of the defect */
  findingDescription: string;
  /** The document containing the defect */
  targetDocumentId: string;
  /** The document type of the target */
  targetDocumentType: DocumentType;
  /** Section IDs in the target that are affected */
  affectedSections: string[];
  /** Actor initiating the cascade */
  actorId: string;
}

/**
 * Backward Cascade Controller.
 * Implements BackwardCascadeAPI from TDD Section 5.6.
 *
 * The 9-step cascade flow (TDD Section 3.8.1):
 *
 * 1. VALIDATE: Confirm the upstream defect claim.
 *    - Target document exists.
 *    - Affected sections exist in the target document.
 *
 * 2. IDENTIFY: Find all affected downstream documents.
 *    - Use cascade scoper to partition children.
 *    - Use impact analyzer for transitive effects.
 *
 * 3. PAUSE: Pause in-flight work on affected documents.
 *    - Mark affected approved children as "stale".
 *    - Mark affected in-review/draft children as "cancelled" or leave.
 *
 * 4. STALE: Mark affected children as "stale".
 *
 * 5. RE-OPEN: Re-open the target document for revision.
 *    - Transition target to "revision-requested".
 *    - Create major version bump via versioning engine (reason: BACKWARD_CASCADE).
 *
 * 6. WAIT: Wait for target document revision and re-review.
 *    (This step is asynchronous -- the cascade tracks its status.)
 *
 * 7. RE-EVALUATE: After target revision, re-evaluate stale children.
 *    - Unaffected children: re-approved automatically (if config allows).
 *    - Affected children: set to "revision-requested".
 *
 * 8. RESUME: Resume pipeline processing for re-evaluated documents.
 *
 * 9. RESOLVE: Mark cascade as resolved.
 *
 * Circuit breaker: If the same section is cascaded twice, escalate to human.
 */
export class BackwardCascadeController {
  constructor(
    private readonly storage: DocumentStorage,
    private readonly versioningEngine: VersioningEngine,
    private readonly config: PipelineConfig,
    private readonly directoryManager: DirectoryManager,
    private readonly eventEmitter: PipelineEventEmitter,
  ) {}

  /**
   * Initiates a backward cascade.
   */
  async initiate(request: CascadeInitiateRequest): Promise<BackwardCascadeEvent> {
    // Step 1: Validate
    const targetDoc = await this.storage.readDocument(
      request.pipelineId,
      request.targetDocumentType,
      request.targetDocumentId,
    );
    // Validate affected sections exist in target
    // ... (parse sections and check)

    // Check depth limit
    const depthResult = checkCascadeDepth(1, this.config);
    if (depthResult.action === 'escalate') {
      // Escalate immediately
      return this.createEscalatedEvent(request, depthResult);
    }

    // Circuit breaker: check if same section was cascaded before
    // ... read pipeline state for active cascades

    // Step 2: Identify affected documents
    const state = await readPipelineState(request.pipelineId, this.directoryManager);
    if (!state) throw new Error(`Pipeline ${request.pipelineId} not found`);

    const targetState = state.documentStates[request.targetDocumentId];
    const childIds = targetState?.children ?? [];

    const scope = await scopeCascade(
      request.pipelineId,
      request.targetDocumentId,
      request.affectedSections,
      childIds,
      this.storage,
    );

    // Step 3-4: Mark affected children as stale
    const affectedDocs: AffectedDocument[] = [];
    for (const docId of scope.allAffectedDocuments) {
      const docState = state.documentStates[docId];
      if (docState && docState.status === 'approved') {
        const prev = docState.status;
        docState.status = 'stale';
        affectedDocs.push({
          documentId: docId,
          type: docState.type,
          previousStatus: prev,
          newStatus: 'stale',
        });
      }
    }

    // Step 5: Re-open target for revision
    if (targetState) {
      targetState.status = 'revision-requested';
    }

    // Create cascade event
    const cascadeSeq = (state.activeCascades?.length ?? 0) + 1;
    const cascadeId = generateCascadeId(request.pipelineId, cascadeSeq);

    const cascadeEvent: BackwardCascadeEvent = {
      id: cascadeId,
      pipelineId: request.pipelineId,
      triggeredBy: {
        reviewId: request.reviewId,
        findingDescription: request.findingDescription,
        reviewerAgent: request.reviewerAgent,
      },
      targetDocument: {
        documentId: request.targetDocumentId,
        type: request.targetDocumentType,
        affectedSections: request.affectedSections,
      },
      affectedDocuments: affectedDocs,
      status: 'initiated',
      cascadeDepth: 1,
      maxDepth: this.config.backwardCascade.maxDepth,
      timestamps: {
        initiated: new Date().toISOString(),
      },
    };

    // Track cascade in pipeline state
    state.activeCascades.push(cascadeId);
    await writePipelineState(state, this.directoryManager);

    // Emit event
    await this.eventEmitter.emit(
      request.pipelineId,
      'cascade_initiated',
      { cascadeId, targetDocumentId: request.targetDocumentId, affectedCount: affectedDocs.length },
      request.actorId,
      request.targetDocumentId,
    );

    return cascadeEvent;
  }

  /**
   * Returns the current status of a cascade.
   */
  async getStatus(
    pipelineId: string,
    cascadeId: string,
  ): Promise<BackwardCascadeEvent | null> {
    // Read from stored cascade events
    // For MVP: cascade events stored alongside pipeline state
    return null; // placeholder
  }

  /**
   * Resolves a cascade after parent revision and child re-evaluation.
   */
  async resolve(
    pipelineId: string,
    cascadeId: string,
    actorId: string,
  ): Promise<BackwardCascadeEvent> {
    const state = await readPipelineState(pipelineId, this.directoryManager);
    if (!state) throw new Error(`Pipeline ${pipelineId} not found`);

    // Remove from active cascades
    state.activeCascades = state.activeCascades.filter(id => id !== cascadeId);

    // Re-evaluate stale children
    if (this.config.backwardCascade.autoApproveUnaffected) {
      // Unaffected children that were marked stale can be re-approved
      // Affected children are set to revision-requested
    }

    await writePipelineState(state, this.directoryManager);

    await this.eventEmitter.emit(
      pipelineId,
      'cascade_resolved',
      { cascadeId },
      actorId,
    );

    return {} as BackwardCascadeEvent; // placeholder
  }

  /**
   * Escalates a cascade to human intervention.
   */
  async escalate(
    pipelineId: string,
    cascadeId: string,
    reason: string,
    actorId: string,
  ): Promise<void> {
    await this.eventEmitter.emit(
      pipelineId,
      'human_escalation',
      { cascadeId, reason },
      actorId,
    );
  }

  private createEscalatedEvent(
    request: CascadeInitiateRequest,
    depthResult: DepthLimitResult,
  ): BackwardCascadeEvent {
    return {
      id: generateCascadeId(request.pipelineId, 1),
      pipelineId: request.pipelineId,
      triggeredBy: {
        reviewId: request.reviewId,
        findingDescription: request.findingDescription,
        reviewerAgent: request.reviewerAgent,
      },
      targetDocument: {
        documentId: request.targetDocumentId,
        type: request.targetDocumentType,
        affectedSections: request.affectedSections,
      },
      affectedDocuments: [],
      status: 'escalated',
      cascadeDepth: depthResult.currentDepth,
      maxDepth: depthResult.maxDepth,
      timestamps: {
        initiated: new Date().toISOString(),
        escalated: new Date().toISOString(),
      },
    };
  }
}
```

## Acceptance Criteria
1. `BackwardCascadeEvent` ID follows `CASCADE-{PIPE_SEQ}-{SEQ}` format.
2. `BackwardCascadeEvent` tracks all required fields: triggeredBy, targetDocument, affectedDocuments, status, cascadeDepth, maxDepth, timestamps.
3. `scopeCascade` correctly partitions children into affected (traces_from intersects) and unaffected.
4. `scopeCascade` includes transitive impact (affected children's descendants).
5. `checkCascadeDepth` returns `proceed` for depth 1.
6. `checkCascadeDepth` returns `proceed_with_warning` for depth equal to maxDepth.
7. `checkCascadeDepth` returns `escalate` for depth exceeding maxDepth.
8. `initiate` validates that affected sections exist in the target document.
9. `initiate` marks affected approved children as "stale".
10. `initiate` re-opens target document for revision.
11. `initiate` tracks cascade in pipeline state's `activeCascades` array.
12. `initiate` emits `cascade_initiated` event.
13. `resolve` removes cascade from `activeCascades` and emits `cascade_resolved` event.
14. `escalate` emits `human_escalation` event.
15. Circuit breaker: same section cascaded twice triggers human escalation.

## Test Cases

### Unit Tests: `tests/pipeline/cascade/cascade-event.test.ts`
- `generateCascadeId produces correct format`
- `BackwardCascadeEvent accepts all required fields`
- `CascadeStatus has 5 values`

### Unit Tests: `tests/pipeline/cascade/cascade-scoper.test.ts`
- `affected child: traces_from intersects affected sections`
- `unaffected child: traces_from does not intersect affected sections`
- `all children affected: all have matching traces`
- `no children affected: none have matching traces`
- `transitive impact: affected child's descendants included`
- `child with empty traces_from: unaffected`

### Unit Tests: `tests/pipeline/cascade/depth-limiter.test.ts`
- `depth 1, maxDepth 2: proceed`
- `depth 2, maxDepth 2: proceed_with_warning`
- `depth 3, maxDepth 2: escalate`
- `depth 1, maxDepth 1: proceed_with_warning`
- `depth 2, maxDepth 1: escalate`
- `uses configured maxDepth from config`

### Unit Tests: `tests/pipeline/cascade/cascade-controller.test.ts`
- `initiate: validates target document exists`
- `initiate: validates affected sections exist in target`
- `initiate: marks affected children as stale`
- `initiate: re-opens target for revision`
- `initiate: creates cascade event with correct fields`
- `initiate: adds cascade to active list`
- `initiate: emits cascade_initiated event`
- `initiate: escalates when depth limit exceeded`
- `resolve: removes cascade from active list`
- `resolve: emits cascade_resolved event`
- `escalate: emits human_escalation event`

### Integration Test: `tests/pipeline/cascade/cascade.integration.test.ts`
- `TDD review finds PRD defect -> cascade marks affected Plans stale, PRD re-opened`
- `cascade resolved after PRD revision -> stale Plans set to revision-requested`
- `cascade at depth 3 -> escalation triggered`
