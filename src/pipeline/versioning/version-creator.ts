import { DocumentType } from '../types/document-type';
import { VersionReason } from '../types/frontmatter';
import { VersionRecord, WriteVersionRequest } from '../storage/version-writer';
import { DocumentStorage } from '../storage/document-storage';
import { calculateNextVersion } from './version-calculator';

export interface VersionCreateRequest {
  pipelineId: string;
  type: DocumentType;
  documentId: string;
  /** Full Markdown content for the new version (including updated frontmatter) */
  content: string;
  /** Why this version is being created */
  reason: VersionReason;
  /** Agent creating this version */
  authorAgent: string;
  /** For ROLLBACK: the version being rolled back to (informational, stored in record) */
  sourceVersion?: string;
}

/**
 * Coordinates version creation.
 *
 * Steps:
 *   1. Get current version from storage (list versions, take last)
 *   2. Calculate next version number
 *   3. Update frontmatter in content with new version and updated_at
 *   4. Delegate to storage.writeVersion for file I/O
 *   5. Return complete VersionRecord
 *
 * @param request The version creation request
 * @param storage The document storage layer
 * @returns The created VersionRecord
 */
export async function createVersion(
  request: VersionCreateRequest,
  storage: DocumentStorage,
): Promise<VersionRecord> {
  // 1. Get current version
  let currentVersion: string | null = null;
  if (request.reason !== 'INITIAL') {
    const versions = await storage.listVersions(
      request.pipelineId, request.type, request.documentId,
    );
    if (versions.length > 0) {
      currentVersion = versions[versions.length - 1].version;
    }
  }

  // 2. Calculate next version
  const nextVersion = calculateNextVersion(currentVersion, request.reason);

  // 3. Update frontmatter in content
  const updatedContent = updateFrontmatterVersion(
    request.content,
    nextVersion,
    new Date().toISOString(),
  );

  // 4. Write via storage
  const writeRequest: WriteVersionRequest = {
    pipelineId: request.pipelineId,
    type: request.type,
    documentId: request.documentId,
    version: nextVersion,
    content: updatedContent,
    reason: request.reason,
    authorAgent: request.authorAgent,
  };

  const record = await storage.writeVersion(writeRequest);

  // 5. Enrich record with source version for rollbacks
  if (request.sourceVersion) {
    record.sourceVersion = request.sourceVersion;
  }

  return record;
}

/**
 * Updates the `version` and `updated_at` fields in the frontmatter
 * section of a Markdown document.
 *
 * Uses regex replacement on the raw YAML between --- delimiters.
 * Does NOT re-serialize the entire frontmatter (preserves formatting).
 */
function updateFrontmatterVersion(
  content: string,
  newVersion: string,
  updatedAt: string,
): string {
  let updated = content.replace(
    /^(version:\s*).+$/m,
    `$1"${newVersion}"`,
  );
  updated = updated.replace(
    /^(updated_at:\s*).+$/m,
    `$1"${updatedAt}"`,
  );
  return updated;
}
