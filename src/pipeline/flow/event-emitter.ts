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
