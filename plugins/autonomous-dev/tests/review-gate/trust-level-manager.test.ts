import { TrustLevelManager } from '../../src/review-gate/trust-level-manager';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrustLevelManager', () => {
  // -----------------------------------------------------------------------
  // Test 14: full_auto -- PRD approved
  // -----------------------------------------------------------------------
  test('full_auto: PRD approved => no human approval required', () => {
    const manager = new TrustLevelManager('full_auto');
    const decision = manager.requiresHumanApproval('PRD', 'approved');

    expect(decision.human_approval_required).toBe(false);
    expect(decision.gate_paused).toBe(false);
    expect(decision.reason).toContain('full_auto');
  });

  // -----------------------------------------------------------------------
  // Test 15: full_auto -- Code approved
  // -----------------------------------------------------------------------
  test('full_auto: Code approved => no human approval required', () => {
    const manager = new TrustLevelManager('full_auto');
    const decision = manager.requiresHumanApproval('Code', 'approved');

    expect(decision.human_approval_required).toBe(false);
    expect(decision.gate_paused).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 16: approve_roots -- PRD approved
  // -----------------------------------------------------------------------
  test('approve_roots: PRD approved => human approval required, gate paused', () => {
    const manager = new TrustLevelManager('approve_roots');
    const decision = manager.requiresHumanApproval('PRD', 'approved');

    expect(decision.human_approval_required).toBe(true);
    expect(decision.gate_paused).toBe(true);
    expect(decision.reason).toContain('approve_roots');
    expect(decision.reason).toContain('PRD');
  });

  // -----------------------------------------------------------------------
  // Test 17: approve_roots -- PRD changes_requested
  // -----------------------------------------------------------------------
  test('approve_roots: PRD changes_requested => no human approval (AI did not approve)', () => {
    const manager = new TrustLevelManager('approve_roots');
    const decision = manager.requiresHumanApproval('PRD', 'changes_requested');

    expect(decision.human_approval_required).toBe(false);
    expect(decision.gate_paused).toBe(false);
    expect(decision.reason).toContain('did not approve');
  });

  // -----------------------------------------------------------------------
  // Test 18: approve_roots -- TDD approved
  // -----------------------------------------------------------------------
  test('approve_roots: TDD approved => no human approval (TDD is not a root)', () => {
    const manager = new TrustLevelManager('approve_roots');
    const decision = manager.requiresHumanApproval('TDD', 'approved');

    expect(decision.human_approval_required).toBe(false);
    expect(decision.gate_paused).toBe(false);
    expect(decision.reason).toContain('autonomous');
  });

  // -----------------------------------------------------------------------
  // Test 19: approve_phase_1 -- PRD approved
  // -----------------------------------------------------------------------
  test('approve_phase_1: PRD approved => human approval required', () => {
    const manager = new TrustLevelManager('approve_phase_1');
    const decision = manager.requiresHumanApproval('PRD', 'approved');

    expect(decision.human_approval_required).toBe(true);
    expect(decision.gate_paused).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 20: approve_phase_1 -- TDD approved
  // -----------------------------------------------------------------------
  test('approve_phase_1: TDD approved => human approval required', () => {
    const manager = new TrustLevelManager('approve_phase_1');
    const decision = manager.requiresHumanApproval('TDD', 'approved');

    expect(decision.human_approval_required).toBe(true);
    expect(decision.gate_paused).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 21: approve_phase_1 -- Plan approved
  // -----------------------------------------------------------------------
  test('approve_phase_1: Plan approved => no human approval', () => {
    const manager = new TrustLevelManager('approve_phase_1');
    const decision = manager.requiresHumanApproval('Plan', 'approved');

    expect(decision.human_approval_required).toBe(false);
    expect(decision.gate_paused).toBe(false);
    expect(decision.reason).toContain('autonomous');
  });

  // -----------------------------------------------------------------------
  // Test 22: approve_all -- Spec approved
  // -----------------------------------------------------------------------
  test('approve_all: Spec approved => human approval required', () => {
    const manager = new TrustLevelManager('approve_all');
    const decision = manager.requiresHumanApproval('Spec', 'approved');

    expect(decision.human_approval_required).toBe(true);
    expect(decision.gate_paused).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 23: approve_all -- Code changes_requested
  // -----------------------------------------------------------------------
  test('approve_all: Code changes_requested => no human approval (not approved)', () => {
    const manager = new TrustLevelManager('approve_all');
    const decision = manager.requiresHumanApproval('Code', 'changes_requested');

    expect(decision.human_approval_required).toBe(false);
    expect(decision.gate_paused).toBe(false);
    expect(decision.reason).toContain('did not approve');
  });

  // -----------------------------------------------------------------------
  // Test 24: human_only -- any document type
  // -----------------------------------------------------------------------
  test('human_only: any document type => human approval required, AI skipped', () => {
    const manager = new TrustLevelManager('human_only');

    const docTypes = ['PRD', 'TDD', 'Plan', 'Spec', 'Code'] as const;
    for (const docType of docTypes) {
      const decision = manager.requiresHumanApproval(docType, 'approved');

      expect(decision.human_approval_required).toBe(true);
      expect(decision.gate_paused).toBe(true);
      expect(decision.reason).toContain('human_only');
    }
  });

  // -----------------------------------------------------------------------
  // Test 25: Default trust level is approve_roots
  // -----------------------------------------------------------------------
  test('Default trust level is approve_roots', () => {
    const manager = new TrustLevelManager();

    expect(manager.getTrustLevel()).toBe('approve_roots');

    // PRD should need approval
    const prdDecision = manager.requiresHumanApproval('PRD', 'approved');
    expect(prdDecision.human_approval_required).toBe(true);

    // TDD should not
    const tddDecision = manager.requiresHumanApproval('TDD', 'approved');
    expect(tddDecision.human_approval_required).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Additional: approve_all with all document types approved
  // -----------------------------------------------------------------------
  test('approve_all: all document types require approval when AI approves', () => {
    const manager = new TrustLevelManager('approve_all');

    const docTypes = ['PRD', 'TDD', 'Plan', 'Spec', 'Code'] as const;
    for (const docType of docTypes) {
      const decision = manager.requiresHumanApproval(docType, 'approved');
      expect(decision.human_approval_required).toBe(true);
      expect(decision.gate_paused).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // Additional: human_only ignores AI outcome
  // -----------------------------------------------------------------------
  test('human_only: requires human approval even when AI says changes_requested', () => {
    const manager = new TrustLevelManager('human_only');
    const decision = manager.requiresHumanApproval('Plan', 'changes_requested');

    expect(decision.human_approval_required).toBe(true);
    expect(decision.gate_paused).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Additional: rejected AI outcome returns to author
  // -----------------------------------------------------------------------
  test('approve_roots: PRD rejected => no human approval, returns to author', () => {
    const manager = new TrustLevelManager('approve_roots');
    const decision = manager.requiresHumanApproval('PRD', 'rejected');

    expect(decision.human_approval_required).toBe(false);
    expect(decision.gate_paused).toBe(false);
  });
});
