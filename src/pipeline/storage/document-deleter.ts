import * as fs from 'fs/promises';
import { DocumentType } from '../types/document-type';
import { DirectoryManager } from './directory-manager';
import { AuditLogger } from './audit-logger';

/**
 * Deletes a document and all its contents (all versions, reviews, diffs).
 * Admin-only operation. Does NOT cascade -- caller must handle
 * traceability updates (removing traces_to from parent, etc.).
 *
 * Steps:
 *   1. Verify document directory exists
 *   2. Remove the entire directory recursively
 *   3. Log deletion event to audit log
 *
 * @throws Error if directory does not exist
 */
export async function deleteDocument(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
  auditLogger: AuditLogger,
  actorId: string,
): Promise<void> {
  const docDir = directoryManager.getDocumentDir(pipelineId, type, documentId);

  // Verify exists
  try {
    await fs.access(docDir);
  } catch {
    throw new Error(`Document directory not found: ${docDir}`);
  }

  // Remove recursively
  await fs.rm(docDir, { recursive: true, force: true });

  // Audit
  await auditLogger.appendEvent(
    pipelineId,
    'document_deleted',
    { documentId, type, deletedDir: docDir },
    actorId,
    documentId,
  );
}
