/**
 * Human Decision Handler for the review gate system.
 *
 * Processes human operator decisions on escalated documents. Supports five
 * actions: approve, approve_with_notes, revise, reject, and cascade_up.
 * Every action produces an immutable audit record.
 *
 * Based on SPEC-004-3-3 section 3.
 */

import * as crypto from 'crypto';
import { MergedFinding } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HumanAction = 'approve' | 'approve_with_notes' | 'revise' | 'reject' | 'cascade_up';

export interface HumanDecision {
  action: HumanAction;
  operator_id: string;
  rationale: string;
  notes?: string; // required for approve_with_notes
  guidance?: string; // required for revise
  timestamp: string; // ISO 8601
}

export interface HumanDecisionResult {
  outcome: 'approved' | 'changes_requested' | 'rejected' | 'cascade_up';
  findings_addendum: MergedFinding[];
  iteration_reset: boolean;
  audit_record: AuditRecord;
}

export interface AuditRecord {
  decision_id: string;
  gate_id: string;
  document_id: string;
  operator_id: string;
  action: HumanAction;
  rationale: string;
  timestamp: string;
  original_ai_outcome: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HumanDecisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// HumanDecisionHandler
// ---------------------------------------------------------------------------

export class HumanDecisionHandler {
  /**
   * Processes a human operator decision and returns the gate outcome,
   * any additional findings, and an immutable audit record.
   *
   * Validates required fields before processing:
   * - operator_id must be non-empty
   * - rationale must be non-empty
   * - approve_with_notes requires non-empty notes
   * - revise requires non-empty guidance
   *
   * @throws HumanDecisionValidationError for invalid decisions.
   */
  processDecision(
    decision: HumanDecision,
    gateId: string,
    documentId: string,
    originalAiOutcome: string
  ): HumanDecisionResult {
    // Validation
    this.validateDecision(decision);

    // Build audit record (immutable, append-only)
    const auditRecord = this.buildAuditRecord(decision, gateId, documentId, originalAiOutcome);

    // Dispatch to action handler
    switch (decision.action) {
      case 'approve':
        return this.handleApprove(decision, auditRecord, originalAiOutcome);
      case 'approve_with_notes':
        return this.handleApproveWithNotes(decision, auditRecord);
      case 'revise':
        return this.handleRevise(decision, auditRecord);
      case 'reject':
        return this.handleReject(decision, auditRecord);
      case 'cascade_up':
        return this.handleCascadeUp(decision, auditRecord);
    }
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private validateDecision(decision: HumanDecision): void {
    if (!decision.operator_id || decision.operator_id.trim() === '') {
      throw new HumanDecisionValidationError('operator_id is required and must be non-empty.');
    }

    if (!decision.rationale || decision.rationale.trim() === '') {
      throw new HumanDecisionValidationError('rationale is required and must be non-empty.');
    }

    if (decision.action === 'approve_with_notes') {
      if (!decision.notes || decision.notes.trim() === '') {
        throw new HumanDecisionValidationError(
          'notes is required for approve_with_notes action and must be non-empty.'
        );
      }
    }

    if (decision.action === 'revise') {
      if (!decision.guidance || decision.guidance.trim() === '') {
        throw new HumanDecisionValidationError(
          'guidance is required for revise action and must be non-empty.'
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Action handlers
  // -------------------------------------------------------------------------

  /**
   * Approve: document marked approved. A system finding records the override.
   */
  private handleApprove(
    decision: HumanDecision,
    auditRecord: AuditRecord,
    originalAiOutcome: string
  ): HumanDecisionResult {
    const overrideFinding = this.createSystemFinding(
      `Approved by human override. Original AI outcome: ${originalAiOutcome}.`,
      'suggestion',
      null,
      'human_override',
      'human_override'
    );

    return {
      outcome: 'approved',
      findings_addendum: [overrideFinding],
      iteration_reset: false,
      audit_record: auditRecord,
    };
  }

  /**
   * Approve with notes: notes converted to suggestion-severity findings.
   */
  private handleApproveWithNotes(
    decision: HumanDecision,
    auditRecord: AuditRecord
  ): HumanDecisionResult {
    const notesFinding = this.createSystemFinding(
      decision.notes!,
      'suggestion',
      null,
      'human_notes',
      'human_override'
    );

    return {
      outcome: 'approved',
      findings_addendum: [notesFinding],
      iteration_reset: false,
      audit_record: auditRecord,
    };
  }

  /**
   * Revise: iteration resets. Human guidance added as a major finding.
   */
  private handleRevise(
    decision: HumanDecision,
    auditRecord: AuditRecord
  ): HumanDecisionResult {
    const guidanceFinding = this.createSystemFinding(
      decision.guidance!,
      'major',
      null,
      'human_guidance',
      'human_guidance'
    );

    return {
      outcome: 'changes_requested',
      findings_addendum: [guidanceFinding],
      iteration_reset: true,
      audit_record: auditRecord,
    };
  }

  /**
   * Reject: pipeline subtree halts. Critical:reject finding generated.
   */
  private handleReject(
    decision: HumanDecision,
    auditRecord: AuditRecord
  ): HumanDecisionResult {
    const rejectFinding = this.createSystemFinding(
      `Rejected by human operator. Rationale: ${decision.rationale}.`,
      'critical',
      'reject',
      'human_decision',
      'human_override'
    );

    return {
      outcome: 'rejected',
      findings_addendum: [rejectFinding],
      iteration_reset: false,
      audit_record: auditRecord,
    };
  }

  /**
   * Cascade up: triggers backward cascade to parent document.
   * Critical:reject finding mentioning backward cascade.
   */
  private handleCascadeUp(
    decision: HumanDecision,
    auditRecord: AuditRecord
  ): HumanDecisionResult {
    const cascadeFinding = this.createSystemFinding(
      'Human confirmed issue is in parent document. Initiating backward cascade.',
      'critical',
      'reject',
      'human_decision',
      'human_override'
    );

    return {
      outcome: 'cascade_up',
      findings_addendum: [cascadeFinding],
      iteration_reset: false,
      audit_record: auditRecord,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Creates a system-generated MergedFinding.
   */
  private createSystemFinding(
    description: string,
    severity: 'critical' | 'major' | 'minor' | 'suggestion',
    criticalSub: 'blocking' | 'reject' | null,
    sectionId: string,
    categoryId: string
  ): MergedFinding {
    return {
      id: `human-${crypto.randomUUID()}`,
      section_id: sectionId,
      category_id: categoryId,
      severity,
      critical_sub: criticalSub,
      upstream_defect: false,
      description,
      evidence: 'Human operator decision',
      suggested_resolution: '',
      reported_by: ['human_operator'],
      resolution_status: 'open',
      prior_finding_id: null,
    };
  }

  /**
   * Builds an immutable audit record for the decision.
   */
  private buildAuditRecord(
    decision: HumanDecision,
    gateId: string,
    documentId: string,
    originalAiOutcome: string
  ): AuditRecord {
    return {
      decision_id: `audit-${crypto.randomUUID()}`,
      gate_id: gateId,
      document_id: documentId,
      operator_id: decision.operator_id,
      action: decision.action,
      rationale: decision.rationale,
      timestamp: decision.timestamp,
      original_ai_outcome: originalAiOutcome,
    };
  }
}
