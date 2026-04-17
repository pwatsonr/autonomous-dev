import {
  HumanDecisionHandler,
  HumanDecision,
  HumanDecisionValidationError,
} from '../../src/review-gate/human-decision-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<HumanDecision> = {}): HumanDecision {
  return {
    action: 'approve',
    operator_id: 'operator-001',
    rationale: 'Looks good to me.',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HumanDecisionHandler', () => {
  const handler = new HumanDecisionHandler();
  const gateId = 'gate-001';
  const documentId = 'PRD-001';
  const originalAiOutcome = 'changes_requested';

  // -----------------------------------------------------------------------
  // Test 26: Approve action
  // -----------------------------------------------------------------------
  test('Approve: returns outcome "approved" with audit record', () => {
    const decision = makeDecision({ action: 'approve' });
    const result = handler.processDecision(decision, gateId, documentId, originalAiOutcome);

    expect(result.outcome).toBe('approved');
    expect(result.iteration_reset).toBe(false);
    expect(result.audit_record.operator_id).toBe('operator-001');
    expect(result.audit_record.action).toBe('approve');
    expect(result.audit_record.gate_id).toBe(gateId);
    expect(result.audit_record.document_id).toBe(documentId);
  });

  // -----------------------------------------------------------------------
  // Test 27: Approve generates override finding
  // -----------------------------------------------------------------------
  test('Approve: generates override finding with "human override" and severity "suggestion"', () => {
    const decision = makeDecision({ action: 'approve' });
    const result = handler.processDecision(decision, gateId, documentId, originalAiOutcome);

    expect(result.findings_addendum).toHaveLength(1);
    const finding = result.findings_addendum[0];
    expect(finding.severity).toBe('suggestion');
    expect(finding.description).toContain('human override');
    expect(finding.description).toContain(originalAiOutcome);
  });

  // -----------------------------------------------------------------------
  // Test 28: Approve with notes
  // -----------------------------------------------------------------------
  test('Approve with notes: notes converted to suggestion findings, outcome "approved"', () => {
    const decision = makeDecision({
      action: 'approve_with_notes',
      notes: 'Consider improving section 3 clarity in the next revision.',
    });
    const result = handler.processDecision(decision, gateId, documentId, originalAiOutcome);

    expect(result.outcome).toBe('approved');
    expect(result.findings_addendum).toHaveLength(1);
    const finding = result.findings_addendum[0];
    expect(finding.severity).toBe('suggestion');
    expect(finding.section_id).toBe('human_notes');
    expect(finding.category_id).toBe('human_override');
    expect(finding.description).toContain('section 3 clarity');
  });

  // -----------------------------------------------------------------------
  // Test 29: Approve with notes -- missing notes throws
  // -----------------------------------------------------------------------
  test('Approve with notes: missing notes throws ValidationError', () => {
    const decision = makeDecision({ action: 'approve_with_notes' });
    // notes is undefined

    expect(() => {
      handler.processDecision(decision, gateId, documentId, originalAiOutcome);
    }).toThrow(HumanDecisionValidationError);
    expect(() => {
      handler.processDecision(decision, gateId, documentId, originalAiOutcome);
    }).toThrow(/notes.*required/i);
  });

  // -----------------------------------------------------------------------
  // Test 29b: Approve with notes -- empty string notes throws
  // -----------------------------------------------------------------------
  test('Approve with notes: empty string notes throws ValidationError', () => {
    const decision = makeDecision({ action: 'approve_with_notes', notes: '   ' });

    expect(() => {
      handler.processDecision(decision, gateId, documentId, originalAiOutcome);
    }).toThrow(HumanDecisionValidationError);
  });

  // -----------------------------------------------------------------------
  // Test 30: Revise action
  // -----------------------------------------------------------------------
  test('Revise: returns outcome "changes_requested", iteration_reset true, guidance as major finding', () => {
    const decision = makeDecision({
      action: 'revise',
      guidance: 'Rewrite the architecture section to address scalability.',
    });
    const result = handler.processDecision(decision, gateId, documentId, originalAiOutcome);

    expect(result.outcome).toBe('changes_requested');
    expect(result.iteration_reset).toBe(true);
    expect(result.findings_addendum).toHaveLength(1);
    const finding = result.findings_addendum[0];
    expect(finding.severity).toBe('major');
    expect(finding.section_id).toBe('human_guidance');
    expect(finding.description).toContain('architecture section');
  });

  // -----------------------------------------------------------------------
  // Test 31: Revise -- missing guidance throws
  // -----------------------------------------------------------------------
  test('Revise: missing guidance throws ValidationError', () => {
    const decision = makeDecision({ action: 'revise' });
    // guidance is undefined

    expect(() => {
      handler.processDecision(decision, gateId, documentId, originalAiOutcome);
    }).toThrow(HumanDecisionValidationError);
    expect(() => {
      handler.processDecision(decision, gateId, documentId, originalAiOutcome);
    }).toThrow(/guidance.*required/i);
  });

  // -----------------------------------------------------------------------
  // Test 32: Reject action
  // -----------------------------------------------------------------------
  test('Reject: returns outcome "rejected", critical:reject finding, iteration_reset false', () => {
    const decision = makeDecision({
      action: 'reject',
      rationale: 'This approach is fundamentally flawed.',
    });
    const result = handler.processDecision(decision, gateId, documentId, originalAiOutcome);

    expect(result.outcome).toBe('rejected');
    expect(result.iteration_reset).toBe(false);
    expect(result.findings_addendum).toHaveLength(1);
    const finding = result.findings_addendum[0];
    expect(finding.severity).toBe('critical');
    expect(finding.critical_sub).toBe('reject');
    expect(finding.description).toContain('Rejected by human operator');
    expect(finding.description).toContain('fundamentally flawed');
  });

  // -----------------------------------------------------------------------
  // Test 33: Cascade up action
  // -----------------------------------------------------------------------
  test('Cascade up: returns outcome "cascade_up", critical:reject finding with backward cascade', () => {
    const decision = makeDecision({
      action: 'cascade_up',
      rationale: 'The issue originates from the parent PRD.',
    });
    const result = handler.processDecision(decision, gateId, documentId, originalAiOutcome);

    expect(result.outcome).toBe('cascade_up');
    expect(result.iteration_reset).toBe(false);
    expect(result.findings_addendum).toHaveLength(1);
    const finding = result.findings_addendum[0];
    expect(finding.severity).toBe('critical');
    expect(finding.critical_sub).toBe('reject');
    expect(finding.description).toContain('backward cascade');
    expect(finding.description).toContain('parent document');
  });

  // -----------------------------------------------------------------------
  // Test 34: Audit record completeness
  // -----------------------------------------------------------------------
  test('Audit record has all required fields for every action', () => {
    const actions = ['approve', 'reject', 'cascade_up'] as const;

    for (const action of actions) {
      const decision = makeDecision({ action });
      const result = handler.processDecision(decision, gateId, documentId, originalAiOutcome);
      const audit = result.audit_record;

      expect(audit.decision_id).toBeDefined();
      expect(audit.decision_id).toMatch(/^audit-/);
      expect(audit.gate_id).toBe(gateId);
      expect(audit.document_id).toBe(documentId);
      expect(audit.operator_id).toBe('operator-001');
      expect(audit.action).toBe(action);
      expect(audit.rationale).toBeDefined();
      expect(audit.rationale.length).toBeGreaterThan(0);
      expect(audit.timestamp).toBeDefined();
      expect(audit.original_ai_outcome).toBe(originalAiOutcome);
    }

    // approve_with_notes
    const notesDecision = makeDecision({ action: 'approve_with_notes', notes: 'Some notes.' });
    const notesResult = handler.processDecision(notesDecision, gateId, documentId, originalAiOutcome);
    expect(notesResult.audit_record.action).toBe('approve_with_notes');
    expect(notesResult.audit_record.decision_id).toMatch(/^audit-/);

    // revise
    const reviseDecision = makeDecision({ action: 'revise', guidance: 'Fix section 2.' });
    const reviseResult = handler.processDecision(reviseDecision, gateId, documentId, originalAiOutcome);
    expect(reviseResult.audit_record.action).toBe('revise');
    expect(reviseResult.audit_record.decision_id).toMatch(/^audit-/);
  });

  // -----------------------------------------------------------------------
  // Test 35: Missing operator_id throws
  // -----------------------------------------------------------------------
  test('Missing operator_id throws ValidationError', () => {
    const decision = makeDecision({ operator_id: '' });

    expect(() => {
      handler.processDecision(decision, gateId, documentId, originalAiOutcome);
    }).toThrow(HumanDecisionValidationError);
    expect(() => {
      handler.processDecision(decision, gateId, documentId, originalAiOutcome);
    }).toThrow(/operator_id.*required/i);
  });

  // -----------------------------------------------------------------------
  // Test 36: Missing rationale throws
  // -----------------------------------------------------------------------
  test('Missing rationale throws ValidationError', () => {
    const decision = makeDecision({ rationale: '' });

    expect(() => {
      handler.processDecision(decision, gateId, documentId, originalAiOutcome);
    }).toThrow(HumanDecisionValidationError);
    expect(() => {
      handler.processDecision(decision, gateId, documentId, originalAiOutcome);
    }).toThrow(/rationale.*required/i);
  });

  // -----------------------------------------------------------------------
  // Additional: Each decision produces a unique decision_id
  // -----------------------------------------------------------------------
  test('Each decision produces a unique decision_id', () => {
    const decision1 = makeDecision();
    const decision2 = makeDecision();

    const result1 = handler.processDecision(decision1, gateId, documentId, originalAiOutcome);
    const result2 = handler.processDecision(decision2, gateId, documentId, originalAiOutcome);

    expect(result1.audit_record.decision_id).not.toBe(result2.audit_record.decision_id);
  });

  // -----------------------------------------------------------------------
  // Additional: Finding IDs are prefixed with "human-"
  // -----------------------------------------------------------------------
  test('Generated findings have IDs prefixed with "human-"', () => {
    const decision = makeDecision({ action: 'reject', rationale: 'Bad approach.' });
    const result = handler.processDecision(decision, gateId, documentId, originalAiOutcome);

    for (const finding of result.findings_addendum) {
      expect(finding.id).toMatch(/^human-/);
    }
  });
});
