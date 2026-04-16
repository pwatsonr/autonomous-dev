import { DocumentStorage } from '../storage/document-storage';
import { reconstructTree } from '../decomposition/tree-reconstructor';

/**
 * Given a document and specific section IDs, identifies all downstream
 * documents that trace to those sections (directly or transitively).
 *
 * Algorithm:
 *   1. Reconstruct the decomposition tree for the pipeline.
 *   2. Find all direct children of the target document.
 *   3. Filter children to those whose traces_from intersects the affected sections.
 *   4. For each affected child: recursively find their children
 *      (transitive impact -- all descendants of affected children are also affected).
 *   5. Return all affected document IDs.
 *
 * Used by the backward cascade controller (PLAN-003-5) to scope cascades.
 *
 * @param pipelineId Pipeline ID
 * @param documentId The document whose sections changed
 * @param sectionIds The affected section IDs
 * @param storage Document storage layer
 * @returns Array of all affected document IDs (direct and transitive)
 */
export async function analyzeImpact(
  pipelineId: string,
  documentId: string,
  sectionIds: string[],
  storage: DocumentStorage,
): Promise<string[]> {
  const tree = await reconstructTree(pipelineId, storage);
  const affectedSections = new Set(sectionIds);
  const affectedDocuments: string[] = [];

  // Find direct children
  let directChildren: string[];
  try {
    directChildren = tree.getNode(documentId).childIds;
  } catch {
    return []; // Document not in tree or has no children
  }

  // Filter to affected children (traces_from intersects affected sections)
  for (const childId of directChildren) {
    const childDoc = await storage.readDocument(
      pipelineId,
      tree.getNode(childId).type,
      childId,
    );
    const tracesFrom = (childDoc.frontmatter.traces_from as string[]) ?? [];
    const isAffected = tracesFrom.some(t => affectedSections.has(t));

    if (isAffected) {
      // This child and ALL its descendants are affected
      const subtree = tree.getSubtree(childId);
      for (const node of subtree) {
        if (!affectedDocuments.includes(node.documentId)) {
          affectedDocuments.push(node.documentId);
        }
      }
    }
  }

  return affectedDocuments;
}
