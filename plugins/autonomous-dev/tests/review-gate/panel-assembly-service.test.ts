import { DocumentType } from '../../src/pipeline/types/document-type';
import {
  REVIEWER_ROLES,
  PRIMARY_ROLE_BY_DOC_TYPE,
  SPECIALIST_ROLES_BY_DOC_TYPE,
  ReviewerRole,
} from '../../src/review-gate/reviewer-roles';
import {
  PanelAssemblyService,
  ReviewerAssignment,
  generateSeed,
  DEFAULT_PANEL_SIZES,
  PanelConfiguration,
  RotationPolicy,
} from '../../src/review-gate/panel-assembly-service';

/**
 * Unit tests for reviewer-roles.ts and panel-assembly-service.ts
 * (SPEC-004-2-1: Reviewer Roles, Panel Assembly & Rotation)
 */

// ---------------------------------------------------------------------------
// Reviewer Roles validation
// ---------------------------------------------------------------------------

describe('REVIEWER_ROLES', () => {
  it('defines exactly 8 roles', () => {
    expect(Object.keys(REVIEWER_ROLES)).toHaveLength(8);
  });

  it.each(Object.entries(REVIEWER_ROLES))(
    '%s has required fields',
    (_id, role: ReviewerRole) => {
      expect(role.role_id).toBeTruthy();
      expect(role.role_name).toBeTruthy();
      expect(role.document_types.length).toBeGreaterThanOrEqual(1);
      expect(role.designation.size).toBeGreaterThanOrEqual(1);
      expect(role.specialization_description).toBeTruthy();
      expect(role.prompt_identity).toBeTruthy();
    },
  );

  it.each(Object.entries(REVIEWER_ROLES))(
    '%s prompt_identity is at least 40 words',
    (_id, role: ReviewerRole) => {
      const wordCount = role.prompt_identity.split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(40);
    },
  );
});

describe('PRIMARY_ROLE_BY_DOC_TYPE', () => {
  it('maps PRD -> product-analyst', () => {
    expect(PRIMARY_ROLE_BY_DOC_TYPE[DocumentType.PRD]).toBe('product-analyst');
  });

  it('maps TDD -> architect-reviewer', () => {
    expect(PRIMARY_ROLE_BY_DOC_TYPE[DocumentType.TDD]).toBe('architect-reviewer');
  });

  it('maps PLAN -> delivery-reviewer', () => {
    expect(PRIMARY_ROLE_BY_DOC_TYPE[DocumentType.PLAN]).toBe('delivery-reviewer');
  });

  it('maps SPEC -> implementation-reviewer', () => {
    expect(PRIMARY_ROLE_BY_DOC_TYPE[DocumentType.SPEC]).toBe('implementation-reviewer');
  });

  it('maps CODE -> code-quality-reviewer', () => {
    expect(PRIMARY_ROLE_BY_DOC_TYPE[DocumentType.CODE]).toBe('code-quality-reviewer');
  });
});

describe('SPECIALIST_ROLES_BY_DOC_TYPE', () => {
  it('maps PRD -> [domain-expert]', () => {
    expect(SPECIALIST_ROLES_BY_DOC_TYPE[DocumentType.PRD]).toEqual(['domain-expert']);
  });

  it('maps TDD -> [security-reviewer]', () => {
    expect(SPECIALIST_ROLES_BY_DOC_TYPE[DocumentType.TDD]).toEqual(['security-reviewer']);
  });

  it('maps PLAN -> []', () => {
    expect(SPECIALIST_ROLES_BY_DOC_TYPE[DocumentType.PLAN]).toEqual([]);
  });

  it('maps SPEC -> []', () => {
    expect(SPECIALIST_ROLES_BY_DOC_TYPE[DocumentType.SPEC]).toEqual([]);
  });

  it('maps CODE -> [security-code-reviewer]', () => {
    expect(SPECIALIST_ROLES_BY_DOC_TYPE[DocumentType.CODE]).toEqual(['security-code-reviewer']);
  });
});

// ---------------------------------------------------------------------------
// generateSeed
// ---------------------------------------------------------------------------

describe('generateSeed', () => {
  it('returns a non-negative integer', () => {
    const seed = generateSeed('product-analyst', 1, 0);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(seed)).toBe(true);
  });

  it('is deterministic (same inputs produce same output)', () => {
    const a = generateSeed('architect-reviewer', 3, 1);
    const b = generateSeed('architect-reviewer', 3, 1);
    expect(a).toBe(b);
  });

  it('varies with different iteration numbers', () => {
    const a = generateSeed('product-analyst', 1, 0);
    const b = generateSeed('product-analyst', 2, 0);
    expect(a).not.toBe(b);
  });

  it('varies with different slots', () => {
    const a = generateSeed('product-analyst', 1, 0);
    const b = generateSeed('product-analyst', 1, 1);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// PanelAssemblyService
// ---------------------------------------------------------------------------

describe('PanelAssemblyService', () => {
  let service: PanelAssemblyService;

  beforeEach(() => {
    service = new PanelAssemblyService();
  });

  // --- Test case 1: PRD default panel ---
  describe('PRD default panel', () => {
    it('returns 2 assignments: product-analyst (primary) + domain-expert (specialist)', () => {
      const panel = service.assemblePanel(DocumentType.PRD, 'author-1', 1);
      expect(panel).toHaveLength(2);
      expect(panel[0].role_id).toBe('product-analyst');
      expect(panel[0].specialization).toBe('primary');
      expect(panel[1].role_id).toBe('domain-expert');
      expect(panel[1].specialization).toBe('specialist');
    });
  });

  // --- Test case 2: TDD default panel ---
  describe('TDD default panel', () => {
    it('returns architect-reviewer + security-reviewer', () => {
      const panel = service.assemblePanel(DocumentType.TDD, 'author-1', 1);
      expect(panel).toHaveLength(2);
      expect(panel[0].role_id).toBe('architect-reviewer');
      expect(panel[0].specialization).toBe('primary');
      expect(panel[1].role_id).toBe('security-reviewer');
      expect(panel[1].specialization).toBe('specialist');
    });
  });

  // --- Test case 3: Plan single reviewer ---
  describe('Plan single reviewer', () => {
    it('returns 1 delivery-reviewer', () => {
      const panel = service.assemblePanel(DocumentType.PLAN, 'author-1', 1);
      expect(panel).toHaveLength(1);
      expect(panel[0].role_id).toBe('delivery-reviewer');
      expect(panel[0].specialization).toBe('primary');
    });
  });

  // --- Test case 4: Spec single reviewer ---
  describe('Spec single reviewer', () => {
    it('returns 1 implementation-reviewer', () => {
      const panel = service.assemblePanel(DocumentType.SPEC, 'author-1', 1);
      expect(panel).toHaveLength(1);
      expect(panel[0].role_id).toBe('implementation-reviewer');
      expect(panel[0].specialization).toBe('primary');
    });
  });

  // --- Test case 5: Code default panel ---
  describe('Code default panel', () => {
    it('returns code-quality-reviewer + security-code-reviewer', () => {
      const panel = service.assemblePanel(DocumentType.CODE, 'author-1', 1);
      expect(panel).toHaveLength(2);
      expect(panel[0].role_id).toBe('code-quality-reviewer');
      expect(panel[0].specialization).toBe('primary');
      expect(panel[1].role_id).toBe('security-code-reviewer');
      expect(panel[1].specialization).toBe('specialist');
    });
  });

  // --- Test case 6: Custom panel size 3 for PRD ---
  describe('Custom panel size 3 for PRD', () => {
    it('returns primary + specialist + second primary with different seed', () => {
      const custom = new PanelAssemblyService({
        panel_sizes: { ...DEFAULT_PANEL_SIZES, [DocumentType.PRD]: 3 },
      });
      const panel = custom.assemblePanel(DocumentType.PRD, 'author-1', 1);
      expect(panel).toHaveLength(3);
      expect(panel[0].role_id).toBe('product-analyst');
      expect(panel[0].specialization).toBe('primary');
      expect(panel[1].role_id).toBe('domain-expert');
      expect(panel[1].specialization).toBe('specialist');
      // Third slot: second primary (no more specialists)
      expect(panel[2].role_id).toBe('product-analyst');
      expect(panel[2].specialization).toBe('primary');
      // Different seed from first primary
      expect(panel[2].agent_seed).not.toBe(panel[0].agent_seed);
    });
  });

  // --- Test case 7: Custom panel size 1 for TDD ---
  describe('Custom panel size 1 for TDD', () => {
    it('returns only architect-reviewer', () => {
      const custom = new PanelAssemblyService({
        panel_sizes: { ...DEFAULT_PANEL_SIZES, [DocumentType.TDD]: 1 },
      });
      const panel = custom.assemblePanel(DocumentType.TDD, 'author-1', 1);
      expect(panel).toHaveLength(1);
      expect(panel[0].role_id).toBe('architect-reviewer');
    });
  });

  // --- Test case 8: Author exclusion ---
  describe('Author exclusion', () => {
    it('does not assign author as reviewer when role_id matches authorId', () => {
      const panel = service.assemblePanel(DocumentType.PLAN, 'delivery-reviewer', 1);
      expect(panel).toHaveLength(1);
      // The assignment should still be delivery-reviewer but with a different seed
      expect(panel[0].role_id).toBe('delivery-reviewer');
      // The key point: reviewer_id should differ from a normal assignment
      // because it was replaced due to author exclusion
      const normalPanel = service.assemblePanel(DocumentType.PLAN, 'someone-else', 1);
      expect(panel[0].agent_seed).not.toBe(normalPanel[0].agent_seed);
    });
  });

  // --- Test case 9: Unique reviewer IDs ---
  describe('Unique reviewer IDs', () => {
    it('all assignments in a panel have distinct reviewer_id values', () => {
      const panel = service.assemblePanel(DocumentType.PRD, 'author-1', 1);
      const ids = panel.map(a => a.reviewer_id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all assignments in a custom size-3 panel have distinct reviewer_id values', () => {
      const custom = new PanelAssemblyService({
        panel_sizes: { ...DEFAULT_PANEL_SIZES, [DocumentType.PRD]: 3 },
      });
      const panel = custom.assemblePanel(DocumentType.PRD, 'author-1', 1);
      const ids = panel.map(a => a.reviewer_id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // --- Test case 10: rotate_none iteration 2 ---
  describe('rotate_none iteration 2', () => {
    it('panels are identical (same seeds)', () => {
      const svc = new PanelAssemblyService({
        rotation_policy: {
          [DocumentType.PRD]: 'rotate_none' as RotationPolicy,
          [DocumentType.TDD]: 'rotate_none' as RotationPolicy,
          [DocumentType.PLAN]: 'rotate_none' as RotationPolicy,
          [DocumentType.SPEC]: 'rotate_none' as RotationPolicy,
          [DocumentType.CODE]: 'rotate_none' as RotationPolicy,
        },
      });
      const panel1 = svc.assemblePanel(DocumentType.PRD, 'author-1', 1);
      const panel2 = svc.assemblePanel(DocumentType.PRD, 'author-1', 2, panel1);

      expect(panel2).toHaveLength(panel1.length);
      for (let i = 0; i < panel1.length; i++) {
        expect(panel2[i].role_id).toBe(panel1[i].role_id);
        expect(panel2[i].agent_seed).toBe(panel1[i].agent_seed);
        expect(panel2[i].reviewer_id).toBe(panel1[i].reviewer_id);
      }
    });
  });

  // --- Test case 11: rotate_specialist iteration 2 ---
  describe('rotate_specialist iteration 2', () => {
    it('primary has same seed, specialist has different seed', () => {
      // rotate_specialist is the default
      const panel1 = service.assemblePanel(DocumentType.PRD, 'author-1', 1);
      const panel2 = service.assemblePanel(DocumentType.PRD, 'author-1', 2, panel1);

      // Primary: same seed
      expect(panel2[0].role_id).toBe(panel1[0].role_id);
      expect(panel2[0].agent_seed).toBe(panel1[0].agent_seed);

      // Specialist: different seed
      expect(panel2[1].role_id).toBe(panel1[1].role_id);
      expect(panel2[1].agent_seed).not.toBe(panel1[1].agent_seed);
    });
  });

  // --- Test case 12: rotate_specialist iteration 3 ---
  describe('rotate_specialist iteration 3', () => {
    it('primary still same seed, specialist seed differs from both iteration 1 and 2', () => {
      const panel1 = service.assemblePanel(DocumentType.PRD, 'author-1', 1);
      const panel2 = service.assemblePanel(DocumentType.PRD, 'author-1', 2, panel1);
      const panel3 = service.assemblePanel(DocumentType.PRD, 'author-1', 3, panel2);

      // Primary: same seed across all 3
      expect(panel3[0].agent_seed).toBe(panel1[0].agent_seed);

      // Specialist: all 3 iterations have different seeds
      const seeds = [panel1[1].agent_seed, panel2[1].agent_seed, panel3[1].agent_seed];
      expect(new Set(seeds).size).toBe(3);
    });
  });

  // --- Test case 13: rotate_all iteration 2 ---
  describe('rotate_all iteration 2', () => {
    it('all seeds differ between iterations', () => {
      const svc = new PanelAssemblyService({
        rotation_policy: {
          [DocumentType.PRD]: 'rotate_all' as RotationPolicy,
          [DocumentType.TDD]: 'rotate_all' as RotationPolicy,
          [DocumentType.PLAN]: 'rotate_all' as RotationPolicy,
          [DocumentType.SPEC]: 'rotate_all' as RotationPolicy,
          [DocumentType.CODE]: 'rotate_all' as RotationPolicy,
        },
      });
      const panel1 = svc.assemblePanel(DocumentType.PRD, 'author-1', 1);
      const panel2 = svc.assemblePanel(DocumentType.PRD, 'author-1', 2, panel1);

      for (let i = 0; i < panel1.length; i++) {
        expect(panel2[i].agent_seed).not.toBe(panel1[i].agent_seed);
      }
    });
  });

  // --- Test case 14: Rotation with single reviewer (Plan) ---
  describe('Rotation with single reviewer (Plan)', () => {
    it('rotate_specialist on Plan: primary is retained, panel identical across iterations', () => {
      const panel1 = service.assemblePanel(DocumentType.PLAN, 'author-1', 1);
      const panel2 = service.assemblePanel(DocumentType.PLAN, 'author-1', 2, panel1);

      expect(panel2).toHaveLength(1);
      expect(panel2[0].role_id).toBe(panel1[0].role_id);
      expect(panel2[0].agent_seed).toBe(panel1[0].agent_seed);
    });
  });

  // --- Test case 15: Seed determinism ---
  describe('Seed determinism', () => {
    it('same inputs produce same seeds across multiple calls', () => {
      const panel1a = service.assemblePanel(DocumentType.TDD, 'author-1', 1);
      const panel1b = service.assemblePanel(DocumentType.TDD, 'author-1', 1);

      expect(panel1a).toHaveLength(panel1b.length);
      for (let i = 0; i < panel1a.length; i++) {
        expect(panel1a[i].agent_seed).toBe(panel1b[i].agent_seed);
        expect(panel1a[i].reviewer_id).toBe(panel1b[i].reviewer_id);
      }
    });
  });

  // --- Test case 16: Panel size 0 throws ---
  describe('Panel size 0', () => {
    it('throws error (minimum panel size is 1)', () => {
      const custom = new PanelAssemblyService({
        panel_sizes: { ...DEFAULT_PANEL_SIZES, [DocumentType.PRD]: 0 },
      });
      expect(() => custom.assemblePanel(DocumentType.PRD, 'author-1', 1)).toThrow(
        /panel size must be at least 1/i,
      );
    });
  });

  // --- Additional: ReviewerAssignment fields ---
  describe('ReviewerAssignment fields', () => {
    it('each assignment has all required fields populated', () => {
      const panel = service.assemblePanel(DocumentType.CODE, 'author-1', 1);
      for (const assignment of panel) {
        expect(assignment.reviewer_id).toBeTruthy();
        expect(assignment.role_id).toBeTruthy();
        expect(assignment.role_name).toBeTruthy();
        expect(typeof assignment.agent_seed).toBe('number');
        expect(['primary', 'specialist']).toContain(assignment.specialization);
        expect(assignment.prompt_identity.length).toBeGreaterThan(0);
      }
    });
  });
});
