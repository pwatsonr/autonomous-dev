import {
  generateCascadeId,
  BackwardCascadeEvent,
  CascadeStatus,
  AffectedDocument,
} from '../../../src/pipeline/cascade/cascade-event';
import { DocumentType } from '../../../src/pipeline/types/document-type';

/**
 * Unit tests for cascade-event (SPEC-003-5-04, Task 10).
 */

describe('generateCascadeId', () => {
  it('produces correct format', () => {
    const id = generateCascadeId('PIPE-2026-0408-001', 1);
    expect(id).toBe('CASCADE-001-001');
  });

  it('produces correct format with multi-digit sequence', () => {
    const id = generateCascadeId('PIPE-2026-0408-001', 42);
    expect(id).toBe('CASCADE-001-042');
  });

  it('extracts last segment from pipeline ID', () => {
    const id = generateCascadeId('PIPE-2026-0415-099', 5);
    expect(id).toBe('CASCADE-099-005');
  });

  it('pads sequence to 3 digits', () => {
    const id = generateCascadeId('PIPE-2026-0408-001', 1);
    expect(id).toMatch(/CASCADE-\d+-\d{3}/);
  });
});

describe('BackwardCascadeEvent', () => {
  it('accepts all required fields', () => {
    const event: BackwardCascadeEvent = {
      id: 'CASCADE-001-001',
      pipelineId: 'PIPE-2026-0408-001',
      triggeredBy: {
        reviewId: 'REVIEW-001',
        findingDescription: 'Missing scope section',
        reviewerAgent: 'reviewer-agent-1',
      },
      targetDocument: {
        documentId: 'PRD-001',
        type: DocumentType.PRD,
        affectedSections: ['scope', 'requirements'],
      },
      affectedDocuments: [
        {
          documentId: 'TDD-001-01',
          type: DocumentType.TDD,
          previousStatus: 'approved',
          newStatus: 'stale',
        },
      ],
      status: 'initiated',
      cascadeDepth: 1,
      maxDepth: 2,
      timestamps: {
        initiated: '2026-04-08T12:00:00.000Z',
      },
    };

    expect(event.id).toBe('CASCADE-001-001');
    expect(event.pipelineId).toBe('PIPE-2026-0408-001');
    expect(event.triggeredBy.reviewId).toBe('REVIEW-001');
    expect(event.triggeredBy.findingDescription).toBe('Missing scope section');
    expect(event.triggeredBy.reviewerAgent).toBe('reviewer-agent-1');
    expect(event.targetDocument.documentId).toBe('PRD-001');
    expect(event.targetDocument.type).toBe(DocumentType.PRD);
    expect(event.targetDocument.affectedSections).toEqual(['scope', 'requirements']);
    expect(event.affectedDocuments).toHaveLength(1);
    expect(event.affectedDocuments[0].documentId).toBe('TDD-001-01');
    expect(event.status).toBe('initiated');
    expect(event.cascadeDepth).toBe(1);
    expect(event.maxDepth).toBe(2);
    expect(event.timestamps.initiated).toBe('2026-04-08T12:00:00.000Z');
  });

  it('accepts optional timestamp fields', () => {
    const event: BackwardCascadeEvent = {
      id: 'CASCADE-001-001',
      pipelineId: 'PIPE-2026-0408-001',
      triggeredBy: {
        reviewId: 'REVIEW-001',
        findingDescription: 'Defect found',
        reviewerAgent: 'reviewer-agent-1',
      },
      targetDocument: {
        documentId: 'PRD-001',
        type: DocumentType.PRD,
        affectedSections: ['scope'],
      },
      affectedDocuments: [],
      status: 'resolved',
      cascadeDepth: 1,
      maxDepth: 2,
      timestamps: {
        initiated: '2026-04-08T12:00:00.000Z',
        parentRevised: '2026-04-08T13:00:00.000Z',
        childrenReEvaluated: '2026-04-08T14:00:00.000Z',
        resolved: '2026-04-08T15:00:00.000Z',
      },
    };

    expect(event.timestamps.parentRevised).toBe('2026-04-08T13:00:00.000Z');
    expect(event.timestamps.childrenReEvaluated).toBe('2026-04-08T14:00:00.000Z');
    expect(event.timestamps.resolved).toBe('2026-04-08T15:00:00.000Z');
  });
});

describe('CascadeStatus', () => {
  it('has 5 values', () => {
    const statuses: CascadeStatus[] = [
      'initiated',
      'parent_revised',
      'children_re_evaluated',
      'resolved',
      'escalated',
    ];
    expect(statuses).toHaveLength(5);

    // Verify each is assignable to CascadeStatus
    const assertStatus = (s: CascadeStatus) => s;
    for (const status of statuses) {
      expect(assertStatus(status)).toBe(status);
    }
  });
});

describe('AffectedDocument', () => {
  it('captures status transition', () => {
    const doc: AffectedDocument = {
      documentId: 'TDD-001-01',
      type: DocumentType.TDD,
      previousStatus: 'approved',
      newStatus: 'stale',
    };

    expect(doc.documentId).toBe('TDD-001-01');
    expect(doc.type).toBe(DocumentType.TDD);
    expect(doc.previousStatus).toBe('approved');
    expect(doc.newStatus).toBe('stale');
  });
});
