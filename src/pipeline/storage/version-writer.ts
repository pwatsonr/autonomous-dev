import * as crypto from 'crypto';
import { DocumentType } from '../types/document-type';
import { VersionReason } from '../types/frontmatter';
import { DirectoryManager } from './directory-manager';
import { atomicWrite, atomicSymlink } from './atomic-io';

export interface WriteVersionRequest {
  pipelineId: string;
  type: DocumentType;
  documentId: string;
  /** The version string to use (e.g. "1.1"). Caller (versioning engine) determines this. */
  version: string;
  /** Full Markdown content including frontmatter */
  content: string;
  /** Why this version was created */
  reason: VersionReason;
  /** Agent that created this version */
  authorAgent: string;
}

export interface VersionRecord {
  /** Version string, e.g. "1.1" */
  version: string;
  /** Why this version was created */
  reason: VersionReason;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Agent that created this version */
  author: string;
  /** SHA-256 hash of the content */
  contentHash: string;
  /** Absolute path to the version file */
  filePath: string;
  /** For rollbacks: the version that was rolled back to */
  sourceVersion?: string;
}

/**
 * Writes a new version file and updates the current.md symlink.
 *
 * This is a "dumb" writer. It does NOT compute the version number
 * (that is the versioning engine's job in PLAN-003-3).
 * It accepts a version string and writes the file.
 *
 * Content normalization before hashing:
 *   - Normalize line endings to \n
 *   - Trim trailing whitespace from each line
 *   - Strip BOM if present
 *
 * Steps:
 *   1. Normalize content for hashing
 *   2. Compute SHA-256 content hash
 *   3. Write v{version}.md via atomicWrite
 *   4. Update current.md symlink to point to v{version}.md
 *   5. Return VersionRecord
 */
export async function writeVersion(
  request: WriteVersionRequest,
  directoryManager: DirectoryManager,
): Promise<VersionRecord> {
  // 1. Normalize
  const normalizedContent = normalizeForHash(request.content);

  // 2. Hash
  const contentHash = crypto
    .createHash('sha256')
    .update(normalizedContent, 'utf-8')
    .digest('hex');

  // 3. Write version file
  const filePath = directoryManager.getVersionFilePath(
    request.pipelineId, request.type, request.documentId, request.version,
  );
  await atomicWrite(filePath, request.content);

  // 4. Update symlink
  const symlinkPath = directoryManager.getCurrentSymlinkPath(
    request.pipelineId, request.type, request.documentId,
  );
  await atomicSymlink(`v${request.version}.md`, symlinkPath);

  // 5. Return record
  return {
    version: request.version,
    reason: request.reason,
    timestamp: new Date().toISOString(),
    author: request.authorAgent,
    contentHash,
    filePath,
  };
}

/**
 * Normalizes content for consistent SHA-256 hashing.
 * - Strip BOM (U+FEFF)
 * - Normalize line endings to \n
 * - Trim trailing whitespace from each line
 */
export function normalizeForHash(content: string): string {
  return content
    .replace(/^\uFEFF/, '')          // Strip BOM
    .replace(/\r\n/g, '\n')          // CRLF -> LF
    .replace(/\r/g, '\n')            // CR -> LF
    .split('\n')
    .map(line => line.trimEnd())     // Trim trailing whitespace per line
    .join('\n');
}
