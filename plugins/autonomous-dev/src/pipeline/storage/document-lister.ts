import * as fs from 'fs/promises';
import { DocumentType, PIPELINE_ORDER } from '../types/document-type';
import { DocumentStatus } from '../types/frontmatter';
import { DirectoryManager } from './directory-manager';
import { readDocument } from './document-reader';

export interface DocumentFilter {
  type?: DocumentType;
  status?: DocumentStatus;
  parentId?: string;
  minDepth?: number;
  maxDepth?: number;
}

export interface DocumentHandle {
  documentId: string;
  pipelineId: string;
  type: DocumentType;
  status: DocumentStatus;
  version: string;
  depth: number;
  parentId: string | null;
  title: string;
}

/**
 * Lists all documents in a pipeline, optionally filtered.
 *
 * Algorithm:
 *   1. If filter.type specified: scan only that type subdirectory
 *      Otherwise: scan all 5 type subdirectories
 *   2. For each type directory: list document subdirectories
 *   3. For each document directory: read frontmatter from current.md
 *   4. Apply remaining filters (status, parentId, minDepth, maxDepth)
 *   5. Sort results by document ID
 *   6. Return DocumentHandle[] array
 *
 * Performance note: reads frontmatter from every document.
 * At 100 documents max, this is ~100 file reads (acceptable for MVP).
 */
export async function listDocuments(
  pipelineId: string,
  directoryManager: DirectoryManager,
  filter?: DocumentFilter,
): Promise<DocumentHandle[]> {
  // 1. Determine which types to scan
  const typesToScan: DocumentType[] = filter?.type
    ? [filter.type]
    : [...PIPELINE_ORDER];

  const handles: DocumentHandle[] = [];

  // 2. For each type directory, list document subdirectories
  for (const type of typesToScan) {
    const typeDir = directoryManager.getTypeDir(pipelineId, type);

    let entries: string[];
    try {
      const dirEntries = await fs.readdir(typeDir, { withFileTypes: true });
      entries = dirEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (err: unknown) {
      // If the type directory doesn't exist, skip it
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw err;
    }

    // 3. For each document directory, read frontmatter from current.md
    for (const documentId of entries) {
      try {
        const content = await readDocument(
          pipelineId,
          type,
          documentId,
          directoryManager,
        );

        const fm = content.frontmatter;
        const handle: DocumentHandle = {
          documentId,
          pipelineId,
          type,
          status: (fm.status as DocumentStatus) ?? 'draft',
          version: content.version,
          depth: (fm.depth as number) ?? 0,
          parentId: (fm.parent_id as string | null) ?? null,
          title: (fm.title as string) ?? '',
        };

        // 4. Apply remaining filters
        if (filter?.status !== undefined && handle.status !== filter.status) {
          continue;
        }
        if (filter?.parentId !== undefined && handle.parentId !== filter.parentId) {
          continue;
        }
        if (filter?.minDepth !== undefined && handle.depth < filter.minDepth) {
          continue;
        }
        if (filter?.maxDepth !== undefined && handle.depth > filter.maxDepth) {
          continue;
        }

        handles.push(handle);
      } catch {
        // Skip documents that can't be read (e.g., missing current.md)
        continue;
      }
    }
  }

  // 5. Sort by document ID
  handles.sort((a, b) => a.documentId.localeCompare(b.documentId));

  // 6. Return
  return handles;
}
