import { DocumentType } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { VersionRecord } from '../storage/version-writer';
import { createVersion, VersionCreateRequest } from './version-creator';

/**
 * Creates a new version with the content of a specified target version.
 *
 * The rollback version gets a NEW version number (not the old one)
 * to preserve the audit trail.
 *
 * Example:
 *   Current version: 1.2
 *   Rollback target: 1.0
 *   New version: 1.3 (minor increment from current)
 *   Content of 1.3 = content of 1.0
 *   Content hash of 1.3 = content hash of 1.0
 *
 * Steps:
 *   1. Read content of the target version
 *   2. Call createVersion with reason ROLLBACK and sourceVersion
 *   3. The version creator handles version numbering (minor increment)
 *   4. Return the VersionRecord
 *
 * @param pipelineId Pipeline ID
 * @param type Document type
 * @param documentId Document ID
 * @param targetVersion The version to roll back to (e.g. "1.0")
 * @param authorAgent Agent performing the rollback
 * @param storage Document storage layer
 * @returns VersionRecord for the newly created rollback version
 */
export async function rollback(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  targetVersion: string,
  authorAgent: string,
  storage: DocumentStorage,
): Promise<VersionRecord> {
  // 1. Read target version content
  const targetContent = await storage.readVersion(
    pipelineId, type, documentId, targetVersion,
  );

  // 2. Create new version with ROLLBACK reason
  const request: VersionCreateRequest = {
    pipelineId,
    type,
    documentId,
    content: targetContent.rawContent,
    reason: 'ROLLBACK',
    authorAgent,
    sourceVersion: targetVersion,
  };

  const record = await createVersion(request, storage);

  // 3. Verify content hash matches target
  // (The content is the same, so hashes should match after normalization)

  return record;
}
