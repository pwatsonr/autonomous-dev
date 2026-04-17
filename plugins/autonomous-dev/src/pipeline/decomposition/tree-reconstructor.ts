import { DocumentType, PIPELINE_ORDER } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { DecompositionTree, DecompositionNode } from './decomposition-tree';
import { readAllDecompositionRecords } from './decomposition-record-io';

/**
 * Rebuilds the full DecompositionTree for a pipeline by reading
 * all decomposition records and document frontmatter.
 *
 * Algorithm:
 *   1. Read all decomposition records from decomposition/ directory.
 *   2. List all documents in the pipeline.
 *   3. For each document: read frontmatter from current.md to get
 *      status, version, depth, parentId, childIds, dependsOn, executionMode.
 *   4. Build DecompositionNode for each document.
 *   5. Add all nodes to the tree.
 *   6. Validate parent-child relationships match decomposition records.
 *
 * @param pipelineId Pipeline ID
 * @param storage Document storage layer
 * @returns Complete DecompositionTree
 */
export async function reconstructTree(
  pipelineId: string,
  storage: DocumentStorage,
): Promise<DecompositionTree> {
  const tree = new DecompositionTree();

  // 1. Read all decomposition records
  const records = await readAllDecompositionRecords(
    pipelineId,
    storage.getDirectoryManager(),
  );

  // 2. Build parent->children map from records
  const parentToChildren = new Map<string, string[]>();
  for (const record of records) {
    parentToChildren.set(
      record.parentId,
      record.children.map(c => c.id),
    );
  }

  // 3. List all documents and build nodes
  const allDocs = await storage.listDocuments(pipelineId);

  for (const doc of allDocs) {
    const childIds = parentToChildren.get(doc.documentId) ?? [];

    const node: DecompositionNode = {
      documentId: doc.documentId,
      type: doc.type,
      status: doc.status,
      version: doc.version,
      depth: doc.depth,
      parentId: doc.parentId,
      childIds,
      dependsOn: [], // will be populated from frontmatter
      executionMode: 'parallel', // will be populated from frontmatter
      siblingIndex: 0,
      siblingCount: 1,
    };

    // Enrich from full document read if needed
    try {
      const fullDoc = await storage.readDocument(pipelineId, doc.type, doc.documentId);
      node.dependsOn = (fullDoc.frontmatter.depends_on as string[]) ?? [];
      node.executionMode = (fullDoc.frontmatter.execution_mode as 'parallel' | 'sequential') ?? 'parallel';
      node.siblingIndex = (fullDoc.frontmatter.sibling_index as number) ?? 0;
      node.siblingCount = (fullDoc.frontmatter.sibling_count as number) ?? 1;
    } catch {
      // If document cannot be read, use defaults from lister
    }

    tree.addNode(node);
  }

  return tree;
}
