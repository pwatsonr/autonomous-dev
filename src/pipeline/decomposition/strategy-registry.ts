import { DocumentType } from '../types/document-type';

export type DecompositionStrategyId = 'domain' | 'phase' | 'task' | 'direct';

export interface DecompositionStrategy {
  /** Unique strategy identifier */
  id: DecompositionStrategyId;
  /** Human-readable description */
  description: string;
  /** Parent document type this strategy applies from */
  parentType: DocumentType;
  /** Child document type this strategy produces */
  childType: DocumentType;
}

/**
 * Strategy registry per TDD Section 3.6.1:
 *
 * | Transition    | Strategy | Description                                |
 * |---------------|----------|--------------------------------------------|
 * | PRD -> TDD    | domain   | Split by domain/bounded context            |
 * | TDD -> PLAN   | phase    | Split by implementation phase               |
 * | PLAN -> SPEC  | task     | Split by individual task                   |
 * | SPEC -> CODE  | direct   | 1:1 mapping, no decomposition logic needed |
 */
const STRATEGIES: DecompositionStrategy[] = [
  {
    id: 'domain',
    description: 'Split by domain or bounded context',
    parentType: DocumentType.PRD,
    childType: DocumentType.TDD,
  },
  {
    id: 'phase',
    description: 'Split by implementation phase',
    parentType: DocumentType.TDD,
    childType: DocumentType.PLAN,
  },
  {
    id: 'task',
    description: 'Split by individual task',
    parentType: DocumentType.PLAN,
    childType: DocumentType.SPEC,
  },
  {
    id: 'direct',
    description: '1:1 direct generation, no decomposition logic',
    parentType: DocumentType.SPEC,
    childType: DocumentType.CODE,
  },
];

/**
 * Returns the decomposition strategy for a parent->child type transition.
 *
 * @throws Error if no strategy exists for the transition
 *         (e.g., CODE has no decomposition)
 */
export function getStrategy(
  parentType: DocumentType,
  childType: DocumentType,
): DecompositionStrategy {
  const strategy = STRATEGIES.find(
    s => s.parentType === parentType && s.childType === childType,
  );
  if (!strategy) {
    throw new Error(
      `No decomposition strategy for transition ${parentType} -> ${childType}`,
    );
  }
  return strategy;
}

/**
 * Returns all registered strategies.
 */
export function getAllStrategies(): DecompositionStrategy[] {
  return [...STRATEGIES];
}
