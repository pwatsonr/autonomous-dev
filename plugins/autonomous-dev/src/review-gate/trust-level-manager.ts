/**
 * Trust Level Manager for the review gate system.
 *
 * Determines whether human approval is required based on configurable trust
 * levels and document types. The five trust levels form a spectrum from
 * full autonomy (full_auto) to full human control (human_only).
 *
 * Trust level is evaluated AFTER AI review outcome is determined, BEFORE
 * the gate finalizes. Exception: human_only skips AI review entirely.
 *
 * Based on SPEC-004-3-3 section 2.
 */

import { DocumentType, TrustLevel } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HumanApprovalDecision {
  human_approval_required: boolean;
  reason: string;
  gate_paused: boolean; // true if gate should pause awaiting human decision
}

// ---------------------------------------------------------------------------
// Trust level / document type gate matrix
// ---------------------------------------------------------------------------
//
// | Trust Level      | PRD | TDD | Plan | Spec | Code |
// |------------------|-----|-----|------|------|------|
// | full_auto        | No  | No  | No   | No   | No   |
// | approve_roots    | Yes | No  | No   | No   | No   |
// | approve_phase_1  | Yes | Yes | No   | No   | No   |
// | approve_all      | Yes | Yes | Yes  | Yes  | Yes  |
// | human_only       | Yes | Yes | Yes  | Yes  | Yes  |

// ---------------------------------------------------------------------------
// TrustLevelManager
// ---------------------------------------------------------------------------

export class TrustLevelManager {
  private readonly trustLevel: TrustLevel;

  constructor(trustLevel: TrustLevel = 'approve_roots') {
    this.trustLevel = trustLevel;
  }

  /**
   * Returns the current trust level.
   */
  getTrustLevel(): TrustLevel {
    return this.trustLevel;
  }

  /**
   * Determines whether human approval is required for a given document type
   * and AI outcome.
   *
   * Rules:
   * - full_auto: no human approval for any document type
   * - human_only: always requires human approval, AI review is skipped
   * - approve_roots / approve_phase_1 / approve_all: human approval required
   *   only after AI approves, and only for the document types in the gate matrix
   */
  requiresHumanApproval(
    documentType: DocumentType,
    aiOutcome: 'approved' | 'changes_requested' | 'rejected'
  ): HumanApprovalDecision {
    if (this.trustLevel === 'full_auto') {
      return {
        human_approval_required: false,
        reason: "Trust level 'full_auto': AI decisions are final.",
        gate_paused: false,
      };
    }

    if (this.trustLevel === 'human_only') {
      return {
        human_approval_required: true,
        reason: "Trust level 'human_only': All documents require human review.",
        gate_paused: true,
      };
    }

    // For the remaining levels, human approval is only required AFTER AI approves
    if (aiOutcome !== 'approved') {
      return {
        human_approval_required: false,
        reason: 'AI review did not approve. Returning to author.',
        gate_paused: false,
      };
    }

    const requiresApproval = this.documentTypeRequiresApproval(documentType);
    if (requiresApproval) {
      return {
        human_approval_required: true,
        reason: `Trust level '${this.trustLevel}': ${documentType} documents require human approval after AI approval.`,
        gate_paused: true,
      };
    }

    return {
      human_approval_required: false,
      reason: `Trust level '${this.trustLevel}': ${documentType} documents are autonomous.`,
      gate_paused: false,
    };
  }

  /**
   * Checks whether the given document type requires human approval under
   * the current trust level.
   */
  private documentTypeRequiresApproval(documentType: DocumentType): boolean {
    switch (this.trustLevel) {
      case 'approve_roots':
        return documentType === 'PRD';
      case 'approve_phase_1':
        return documentType === 'PRD' || documentType === 'TDD';
      case 'approve_all':
        return true;
      default:
        return false;
    }
  }
}
