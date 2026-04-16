/**
 * The five document types in the pipeline, ordered by depth.
 * Depth 0 = PRD (root), Depth 4 = CODE (leaf).
 */
export enum DocumentType {
  PRD = 'PRD',
  TDD = 'TDD',
  PLAN = 'PLAN',
  SPEC = 'SPEC',
  CODE = 'CODE',
}

/**
 * Pipeline ordering array. Index = depth.
 * PIPELINE_ORDER[0] = PRD, PIPELINE_ORDER[4] = CODE.
 */
export const PIPELINE_ORDER: readonly DocumentType[] = [
  DocumentType.PRD,
  DocumentType.TDD,
  DocumentType.PLAN,
  DocumentType.SPEC,
  DocumentType.CODE,
] as const;

/**
 * Returns the depth (0-based) for a given document type.
 * @throws Error if type is not in PIPELINE_ORDER.
 */
export function getDepth(type: DocumentType): number {
  const idx = PIPELINE_ORDER.indexOf(type);
  if (idx === -1) throw new Error(`Unknown document type: ${type}`);
  return idx;
}

/**
 * Returns the child type for a given document type, or null for CODE.
 */
export function getChildType(type: DocumentType): DocumentType | null {
  const depth = getDepth(type);
  return depth < PIPELINE_ORDER.length - 1 ? PIPELINE_ORDER[depth + 1] : null;
}

/**
 * Returns the parent type for a given document type, or null for PRD.
 */
export function getParentType(type: DocumentType): DocumentType | null {
  const depth = getDepth(type);
  return depth > 0 ? PIPELINE_ORDER[depth - 1] : null;
}
