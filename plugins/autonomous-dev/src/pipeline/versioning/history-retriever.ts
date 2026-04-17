import { DocumentType } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { VersionRecord } from '../storage/version-writer';

/**
 * Retrieves the complete version history for a document.
 *
 * Returns all VersionRecords in chronological order (sorted by version number).
 * Each record includes: version, reason, sourceVersion (for rollbacks),
 * timestamp, author, contentHash, and filePath.
 *
 * This is a thin wrapper around storage.listVersions that ensures
 * consistent behavior and can be extended later with review summaries.
 *
 * @param pipelineId Pipeline ID
 * @param type Document type
 * @param documentId Document ID
 * @param storage Document storage layer
 * @returns Array of VersionRecords sorted chronologically
 */
export async function getHistory(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  storage: DocumentStorage,
): Promise<VersionRecord[]> {
  return storage.listVersions(pipelineId, type, documentId);
}
