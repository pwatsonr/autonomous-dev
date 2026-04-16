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
  /** Tracks sections that have been cascaded, keyed by pipelineId:documentId */
  private cascadedSections: Map<string, Set<string>> = new Map();

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
    // Step 1: Validate target document exists
    const targetDoc = await this.storage.readDocument(
      request.pipelineId,
      request.targetDocumentType,
      request.targetDocumentId,
    );

    // Validate affected sections exist in target document body
    this.validateAffectedSections(targetDoc.body, request.affectedSections);

    // Check depth limit
    const depthResult = checkCascadeDepth(1, this.config);
    if (depthResult.action === 'escalate') {
      // Escalate immediately
      const escalatedEvent = this.createEscalatedEvent(request, depthResult);
      await this.eventEmitter.emit(
        request.pipelineId,
        'human_escalation',
        { cascadeId: escalatedEvent.id, reason: depthResult.message },
        request.actorId,
        request.targetDocumentId,
      );
      return escalatedEvent;
    }

    // Circuit breaker: check if same section was cascaded before
    const circuitBreakerKey = `${request.pipelineId}:${request.targetDocumentId}`;
    const previouslyCascaded = this.cascadedSections.get(circuitBreakerKey);
    if (previouslyCascaded) {
      const repeatedSections = request.affectedSections.filter(s => previouslyCascaded.has(s));
      if (repeatedSections.length > 0) {
        const escalatedEvent = this.createEscalatedEvent(request, {
          action: 'escalate',
          currentDepth: 1,
          maxDepth: this.config.backwardCascade.maxDepth,
          message: `Circuit breaker: sections [${repeatedSections.join(', ')}] have been cascaded before. Human escalation required.`,
        });
        await this.eventEmitter.emit(
          request.pipelineId,
          'human_escalation',
          {
            cascadeId: escalatedEvent.id,
            reason: `Circuit breaker triggered: repeated cascade on sections [${repeatedSections.join(', ')}]`,
          },
          request.actorId,
          request.targetDocumentId,
        );
        return escalatedEvent;
      }
    }

    // Track cascaded sections for circuit breaker
    if (!this.cascadedSections.has(circuitBreakerKey)) {
      this.cascadedSections.set(circuitBreakerKey, new Set());
    }
    for (const section of request.affectedSections) {
      this.cascadedSections.get(circuitBreakerKey)!.add(section);
    }

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

    return {
      id: cascadeId,
      pipelineId,
      triggeredBy: { reviewId: '', findingDescription: '', reviewerAgent: '' },
      targetDocument: { documentId: '', type: 'PRD' as DocumentType, affectedSections: [] },
      affectedDocuments: [],
      status: 'resolved' as CascadeStatus,
      cascadeDepth: 1,
      maxDepth: this.config.backwardCascade.maxDepth,
      timestamps: {
        initiated: '',
        resolved: new Date().toISOString(),
      },
    };
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

  /**
   * Validates that the affected section IDs exist as headings in the document body.
   * Section IDs are derived from Markdown headings (e.g., "## Scope" -> "scope").
   *
   * @throws Error if any affected section is not found in the document
   */
  private validateAffectedSections(body: string, affectedSections: string[]): void {
    // Extract section IDs from Markdown headings
    const headingPattern = /^#{1,6}\s+(.+)$/gm;
    const documentSections = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(body)) !== null) {
      // Convert heading text to section ID (lowercase, spaces to hyphens)
      const sectionId = match[1].trim().toLowerCase().replace(/\s+/g, '-');
      documentSections.add(sectionId);
    }

    const missingSections = affectedSections.filter(s => !documentSections.has(s));
    if (missingSections.length > 0) {
      throw new Error(
        `Affected sections not found in target document: [${missingSections.join(', ')}]`,
      );
    }
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
