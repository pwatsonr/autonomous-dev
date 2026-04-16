import { DocumentStorage } from '../storage/document-storage';
import { analyzeImpact } from '../traceability/impact-analyzer';

export interface CascadeScopeResult {
  /** Child document IDs affected by the cascade (traces_from intersects affected sections) */
  affectedChildren: string[];
  /** Child document IDs NOT affected (remain in current state) */
  unaffectedChildren: string[];
  /** All transitively affected documents (children + their descendants) */
  allAffectedDocuments: string[];
}

/**
 * Determines which children are affected by a parent defect.
 *
 * Algorithm (TDD Section 3.8.3):
 *   1. Get all direct children of the target document from the tree.
 *   2. For each child: read its traces_from entries.
 *   3. If traces_from intersects the affected section IDs: child is affected.
 *   4. For affected children: add all their descendants to the affected set.
 *   5. Unaffected children (no intersection) remain in their current state.
 *
 * Uses the traceability impact analyzer (PLAN-003-4) for transitive impact.
 *
 * @param pipelineId Pipeline ID
 * @param targetDocumentId The document containing the defect
 * @param affectedSections Section IDs in the target that are affected
 * @param childIds Direct child document IDs
 * @param storage Document storage layer
 */
export async function scopeCascade(
  pipelineId: string,
  targetDocumentId: string,
  affectedSections: string[],
  childIds: string[],
  storage: DocumentStorage,
): Promise<CascadeScopeResult> {
  const affectedSectionSet = new Set(affectedSections);
  const affectedChildren: string[] = [];
  const unaffectedChildren: string[] = [];

  for (const childId of childIds) {
    // Read child's traces_from
    // Need to determine child's type from pipeline state
    const allDocs = await storage.listDocuments(pipelineId);
    const childDoc = allDocs.find(d => d.documentId === childId);
    if (!childDoc) {
      unaffectedChildren.push(childId);
      continue;
    }

    const fullChild = await storage.readDocument(pipelineId, childDoc.type, childId);
    const tracesFrom = (fullChild.frontmatter.traces_from as string[]) ?? [];

    const isAffected = tracesFrom.some(t => affectedSectionSet.has(t));
    if (isAffected) {
      affectedChildren.push(childId);
    } else {
      unaffectedChildren.push(childId);
    }
  }

  // Get all transitively affected documents
  const allAffectedDocuments = await analyzeImpact(
    pipelineId,
    targetDocumentId,
    affectedSections,
    storage,
  );

  return {
    affectedChildren,
    unaffectedChildren,
    allAffectedDocuments,
  };
}
