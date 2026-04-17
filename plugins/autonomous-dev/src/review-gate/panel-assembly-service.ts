import { DocumentType } from '../pipeline/types/document-type';
import {
  REVIEWER_ROLES,
  PRIMARY_ROLE_BY_DOC_TYPE,
  SPECIALIST_ROLES_BY_DOC_TYPE,
} from './reviewer-roles';

/**
 * A single reviewer assignment within a panel.
 */
export interface ReviewerAssignment {
  /** Unique per invocation, e.g. "product-analyst-1234" */
  reviewer_id: string;
  /** From REVIEWER_ROLES */
  role_id: string;
  role_name: string;
  /** Distinct seed for perspective variation */
  agent_seed: number;
  specialization: 'primary' | 'specialist';
  prompt_identity: string;
}

/**
 * Configuration for panel sizes and rotation policies per document type.
 */
export interface PanelConfiguration {
  panel_sizes: Record<DocumentType, number>;
  rotation_policy: Record<DocumentType, RotationPolicy>;
}

export type RotationPolicy = 'rotate_none' | 'rotate_specialist' | 'rotate_all';

export const DEFAULT_PANEL_SIZES: Record<DocumentType, number> = {
  [DocumentType.PRD]: 2,
  [DocumentType.TDD]: 2,
  [DocumentType.PLAN]: 1,
  [DocumentType.SPEC]: 1,
  [DocumentType.CODE]: 2,
};

export const DEFAULT_ROTATION_POLICY: RotationPolicy = 'rotate_specialist';

/**
 * Simple deterministic hash for reproducible seed generation.
 */
export function generateSeed(roleId: string, iterationNumber: number, slot: number): number {
  let hash = 0;
  const input = `${roleId}-${iterationNumber}-${slot}`;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Composes review panels based on document type and configuration.
 * Implements reviewer rotation logic across iterations.
 */
export class PanelAssemblyService {
  private panelSizes: Record<DocumentType, number>;
  private rotationPolicies: Record<DocumentType, RotationPolicy>;

  constructor(private config: Partial<PanelConfiguration> = {}) {
    this.panelSizes = { ...DEFAULT_PANEL_SIZES, ...config.panel_sizes };
    this.rotationPolicies = {
      [DocumentType.PRD]: DEFAULT_ROTATION_POLICY,
      [DocumentType.TDD]: DEFAULT_ROTATION_POLICY,
      [DocumentType.PLAN]: DEFAULT_ROTATION_POLICY,
      [DocumentType.SPEC]: DEFAULT_ROTATION_POLICY,
      [DocumentType.CODE]: DEFAULT_ROTATION_POLICY,
      ...config.rotation_policy,
    };
  }

  /**
   * Assemble a review panel for a given document type, iteration, and author.
   *
   * @param documentType - The type of document being reviewed
   * @param authorId - The author's identifier (excluded from the panel)
   * @param iterationNumber - Current review iteration (1-based)
   * @param previousPanel - Panel from the previous iteration (used for rotation)
   * @returns Array of ReviewerAssignment objects forming the panel
   */
  assemblePanel(
    documentType: DocumentType,
    authorId: string,
    iterationNumber: number,
    previousPanel?: ReviewerAssignment[],
  ): ReviewerAssignment[] {
    const panelSize = this.panelSizes[documentType];

    if (panelSize < 1) {
      throw new Error(`Panel size must be at least 1, got ${panelSize} for ${documentType}`);
    }

    const rotationPolicy = this.rotationPolicies[documentType];

    // For iterations > 1 with a previous panel, apply rotation logic
    if (iterationNumber > 1 && previousPanel && previousPanel.length > 0) {
      return this.applyRotation(documentType, authorId, iterationNumber, previousPanel, rotationPolicy, panelSize);
    }

    // Fresh assembly for iteration 1 (or when no previous panel)
    return this.assembleFreshPanel(documentType, authorId, iterationNumber, panelSize);
  }

  /**
   * Assemble a fresh panel (iteration 1 or no previous panel available).
   */
  private assembleFreshPanel(
    documentType: DocumentType,
    authorId: string,
    iterationNumber: number,
    panelSize: number,
  ): ReviewerAssignment[] {
    const primaryRoleId = PRIMARY_ROLE_BY_DOC_TYPE[documentType];
    const specialistRoleIds = SPECIALIST_ROLES_BY_DOC_TYPE[documentType];
    const assignments: ReviewerAssignment[] = [];

    // Slot 1: primary reviewer
    const primarySeed = generateSeed(primaryRoleId, iterationNumber, 0);
    let primaryAssignment = this.createAssignment(primaryRoleId, primarySeed, 'primary');

    // Author exclusion for primary
    if (primaryAssignment.role_id === authorId) {
      const altSeed = generateSeed(primaryRoleId, iterationNumber, 100);
      primaryAssignment = this.createAssignment(primaryRoleId, altSeed, 'primary');
    }

    assignments.push(primaryAssignment);

    // Slots 2..N
    let slotIndex = 1;
    while (assignments.length < panelSize) {
      if (slotIndex - 1 < specialistRoleIds.length) {
        // Add specialist
        const specialistRoleId = specialistRoleIds[slotIndex - 1];
        const specSeed = generateSeed(specialistRoleId, iterationNumber, slotIndex);
        let specAssignment = this.createAssignment(specialistRoleId, specSeed, 'specialist');

        // Author exclusion for specialist
        if (specAssignment.role_id === authorId) {
          const altSeed = generateSeed(specialistRoleId, iterationNumber, slotIndex + 100);
          specAssignment = this.createAssignment(specialistRoleId, altSeed, 'specialist');
        }

        assignments.push(specAssignment);
      } else {
        // No more specialists; add another instance of the primary with a different seed
        const extraSeed = generateSeed(primaryRoleId, iterationNumber, slotIndex);
        let extraAssignment = this.createAssignment(primaryRoleId, extraSeed, 'primary');

        // Author exclusion
        if (extraAssignment.role_id === authorId) {
          const altSeed = generateSeed(primaryRoleId, iterationNumber, slotIndex + 100);
          extraAssignment = this.createAssignment(primaryRoleId, altSeed, 'primary');
        }

        // Ensure unique reviewer_id vs existing assignments
        if (assignments.some(a => a.reviewer_id === extraAssignment.reviewer_id)) {
          const uniqueSeed = generateSeed(primaryRoleId, iterationNumber, slotIndex + 200);
          extraAssignment = this.createAssignment(primaryRoleId, uniqueSeed, 'primary');
        }

        assignments.push(extraAssignment);
      }
      slotIndex++;
    }

    return assignments;
  }

  /**
   * Apply rotation policy to produce the panel for a subsequent iteration.
   */
  private applyRotation(
    documentType: DocumentType,
    authorId: string,
    iterationNumber: number,
    previousPanel: ReviewerAssignment[],
    policy: RotationPolicy,
    panelSize: number,
  ): ReviewerAssignment[] {
    switch (policy) {
      case 'rotate_none':
        // Return same panel as previous iteration (reuse seeds)
        return previousPanel.map(a => ({ ...a }));

      case 'rotate_specialist': {
        // Primary: same role, same seed. Specialist: new seed.
        const result: ReviewerAssignment[] = [];
        for (const prev of previousPanel) {
          if (prev.specialization === 'primary') {
            result.push({ ...prev });
          } else {
            // Generate new seed for specialist
            const newSeed = prev.agent_seed + iterationNumber * 1000;
            const rotated = this.createAssignment(prev.role_id, newSeed, 'specialist');

            // Author exclusion
            if (rotated.role_id === authorId) {
              const altSeed = newSeed + 500;
              result.push(this.createAssignment(rotated.role_id, altSeed, 'specialist'));
            } else {
              result.push(rotated);
            }
          }
        }
        return result;
      }

      case 'rotate_all': {
        // All slots get fresh seeds based on hash(role_id + iterationNumber)
        const result: ReviewerAssignment[] = [];
        for (let i = 0; i < previousPanel.length; i++) {
          const prev = previousPanel[i];
          const newSeed = generateSeed(prev.role_id, iterationNumber, i);
          let assignment = this.createAssignment(prev.role_id, newSeed, prev.specialization);

          // Author exclusion
          if (assignment.role_id === authorId) {
            const altSeed = generateSeed(prev.role_id, iterationNumber, i + 100);
            assignment = this.createAssignment(prev.role_id, altSeed, prev.specialization);
          }

          result.push(assignment);
        }
        return result;
      }

      default:
        throw new Error(`Unknown rotation policy: ${policy}`);
    }
  }

  /**
   * Create a ReviewerAssignment from a role_id, seed, and specialization.
   */
  private createAssignment(
    roleId: string,
    seed: number,
    specialization: 'primary' | 'specialist',
  ): ReviewerAssignment {
    const role = REVIEWER_ROLES[roleId];
    if (!role) {
      throw new Error(`Unknown reviewer role: ${roleId}`);
    }

    return {
      reviewer_id: `${roleId}-${seed}`,
      role_id: roleId,
      role_name: role.role_name,
      agent_seed: seed,
      specialization,
      prompt_identity: role.prompt_identity,
    };
  }
}
