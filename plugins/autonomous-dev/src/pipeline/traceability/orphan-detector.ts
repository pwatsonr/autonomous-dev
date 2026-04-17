import { DocumentType } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';

/**
 * Returns the expected parent document type for a given child type.
 */
function getParentDocType(type: DocumentType): DocumentType {
  const typeMap: Record<string, DocumentType> = {
    TDD: DocumentType.PRD,
    PLAN: DocumentType.TDD,
    SPEC: DocumentType.PLAN,
    CODE: DocumentType.SPEC,
  };
  return typeMap[type] ?? DocumentType.PRD;
}

/**
 * Recursively flattens a nested sections array into a flat list.
 */
function flattenSections(sections: { id: string; subsections?: any[] }[]): { id: string }[] {
  const result: { id: string }[] = [];
  for (const s of sections) {
    result.push(s);
    if (s.subsections) result.push(...flattenSections(s.subsections));
  }
  return result;
}

/**
 * Identifies documents whose traces_from entries reference sections
 * that no longer exist in the parent's current version.
 *
 * This can happen after a backward cascade revision removes or renames
 * sections in a parent document.
 *
 * Algorithm:
 *   1. List all documents with depth > 0 (non-root documents).
 *   2. For each document: read its traces_from entries.
 *   3. Read the parent document's current version.
 *   4. Parse the parent's sections to get valid section IDs.
 *   5. If any traces_from entry references an invalid section ID: orphan.
 *
 * @returns Array of document IDs that are orphaned
 */
export async function detectOrphans(
  pipelineId: string,
  storage: DocumentStorage,
): Promise<string[]> {
  const allDocs = await storage.listDocuments(pipelineId);
  const orphans: string[] = [];

  for (const doc of allDocs) {
    if (doc.depth === 0) continue; // Root PRDs have no traces_from
    if (!doc.parentId) continue;

    const fullDoc = await storage.readDocument(pipelineId, doc.type, doc.documentId);
    const tracesFrom = (fullDoc.frontmatter.traces_from as string[]) ?? [];
    if (tracesFrom.length === 0) continue;

    // Read parent
    try {
      const parentType = getParentDocType(doc.type);
      const parentDoc = await storage.readDocument(
        pipelineId,
        parentType,
        doc.parentId,
      );

      // Dynamically import section parser (from the versioning module)
      const { parseSections } = await import('../versioning/section-parser');
      const parentSections = parseSections(parentDoc.rawContent);
      const validSectionIds = new Set(
        flattenSections(parentSections.sections).map((s: { id: string }) => s.id),
      );

      // Check if all traces_from reference valid sections
      for (const trace of tracesFrom) {
        if (!validSectionIds.has(trace)) {
          orphans.push(doc.documentId);
          break; // Only add once per document
        }
      }
    } catch {
      // Parent not found: document is orphaned
      orphans.push(doc.documentId);
    }
  }

  return orphans;
}
