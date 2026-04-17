# SPEC-003-2-03: Version File Writing, Version Listing, and Storage Quotas

## Metadata
- **Parent Plan**: PLAN-003-2
- **Tasks Covered**: Task 7, Task 8, Task 9
- **Estimated effort**: 11 hours

## Description
Implement the "dumb" version file writer (accepts a version string and content, writes the file, updates the symlink), the version lister (scans version files and returns sorted records), and the storage quota enforcer (pre-write validation against configured limits for documents, versions, total size, and per-document size).

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/storage/version-writer.ts` | Create |
| `src/pipeline/storage/version-lister.ts` | Create |
| `src/pipeline/storage/quota-enforcer.ts` | Create |

## Implementation Details

### Task 7: `src/pipeline/storage/version-writer.ts`

```typescript
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
```

### Task 8: `src/pipeline/storage/version-lister.ts`

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentType } from '../types/document-type';
import { DirectoryManager } from './directory-manager';
import { VersionRecord } from './version-writer';
import { parseFrontmatter } from '../frontmatter/parser';

/** Regex matching version file names: v{MAJOR}.{MINOR}.md */
const VERSION_FILE_REGEX = /^v(\d+)\.(\d+)\.md$/;

/**
 * Parses a version string "MAJOR.MINOR" into a sortable tuple.
 */
function parseVersion(version: string): [number, number] {
  const [major, minor] = version.split('.').map(Number);
  return [major, minor];
}

/**
 * Compares two version tuples for sorting.
 * 1.0 < 1.1 < 1.10 < 2.0
 */
function compareVersions(a: [number, number], b: [number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

/**
 * Lists all versions for a document, sorted by version number (ascending).
 *
 * Algorithm:
 *   1. Read directory entries for the document directory
 *   2. Filter entries matching VERSION_FILE_REGEX
 *   3. For each matching file: read frontmatter to extract metadata
 *   4. Build VersionRecord for each
 *   5. Sort by version (semantic ordering: 1.0 < 1.1 < 1.10 < 2.0)
 *   6. Return sorted array
 */
export async function listVersions(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
): Promise<VersionRecord[]> {
  const docDir = directoryManager.getDocumentDir(pipelineId, type, documentId);
  const entries = await fs.readdir(docDir);

  const versions: VersionRecord[] = [];
  for (const entry of entries) {
    const match = entry.match(VERSION_FILE_REGEX);
    if (!match) continue;

    const version = `${match[1]}.${match[2]}`;
    const filePath = path.join(docDir, entry);
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseFrontmatter(content);

    versions.push({
      version,
      reason: (parsed.frontmatter as any).version_reason ?? 'INITIAL',
      timestamp: parsed.frontmatter.updated_at ?? '',
      author: parsed.frontmatter.author_agent ?? '',
      contentHash: '', // computed lazily or by versioning engine
      filePath,
    });
  }

  // Sort by semantic version
  versions.sort((a, b) => {
    const va = parseVersion(a.version);
    const vb = parseVersion(b.version);
    return compareVersions(va, vb);
  });

  return versions;
}
```

### Task 9: `src/pipeline/storage/quota-enforcer.ts`

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { PipelineConfig } from '../types/config';
import { DirectoryManager } from './directory-manager';

export type QuotaViolation =
  | 'MAX_DOCUMENTS_EXCEEDED'
  | 'MAX_VERSIONS_EXCEEDED'
  | 'MAX_TOTAL_SIZE_EXCEEDED'
  | 'MAX_DOCUMENT_SIZE_EXCEEDED';

export class QuotaExceededError extends Error {
  constructor(
    public readonly violation: QuotaViolation,
    public readonly limit: number,
    public readonly actual: number,
  ) {
    super(
      `Storage quota exceeded: ${violation} (limit=${limit}, actual=${actual})`,
    );
    this.name = 'QuotaExceededError';
  }
}

export class QuotaEnforcer {
  constructor(
    private readonly config: PipelineConfig,
    private readonly directoryManager: DirectoryManager,
  ) {}

  /**
   * Checks whether adding a new document would exceed the per-pipeline document limit.
   * Must be called BEFORE creating a new document.
   *
   * @throws QuotaExceededError if limit would be exceeded
   */
  async checkDocumentLimit(pipelineId: string): Promise<void> {
    const currentCount = await this.countDocuments(pipelineId);
    const limit = this.config.storage.maxDocumentsPerPipeline;
    if (currentCount >= limit) {
      throw new QuotaExceededError('MAX_DOCUMENTS_EXCEEDED', limit, currentCount);
    }
  }

  /**
   * Checks whether adding a new version would exceed the per-document version limit.
   * Must be called BEFORE writing a new version.
   *
   * @throws QuotaExceededError if limit would be exceeded
   */
  async checkVersionLimit(
    pipelineId: string,
    type: string,
    documentId: string,
  ): Promise<void> {
    const currentCount = await this.countVersions(pipelineId, type, documentId);
    const limit = this.config.storage.maxVersionsPerDocument;
    if (currentCount >= limit) {
      throw new QuotaExceededError('MAX_VERSIONS_EXCEEDED', limit, currentCount);
    }
  }

  /**
   * Checks whether the pipeline total size is within limits.
   *
   * @throws QuotaExceededError if total size exceeds limit
   */
  async checkTotalSizeLimit(pipelineId: string): Promise<void> {
    const totalSize = await this.computeTotalSize(pipelineId);
    const limit = this.config.storage.maxTotalSizeBytes;
    if (totalSize >= limit) {
      throw new QuotaExceededError('MAX_TOTAL_SIZE_EXCEEDED', limit, totalSize);
    }
  }

  /**
   * Checks whether a specific content string exceeds the per-document size limit.
   * Called BEFORE writing.
   *
   * @throws QuotaExceededError if content size exceeds limit
   */
  checkDocumentSizeLimit(content: string): void {
    const size = Buffer.byteLength(content, 'utf-8');
    const limit = this.config.storage.maxDocumentSizeBytes;
    if (size > limit) {
      throw new QuotaExceededError('MAX_DOCUMENT_SIZE_EXCEEDED', limit, size);
    }
  }

  /**
   * Runs all applicable quota checks before a document write.
   */
  async checkBeforeDocumentCreate(pipelineId: string, content: string): Promise<void> {
    await this.checkDocumentLimit(pipelineId);
    await this.checkTotalSizeLimit(pipelineId);
    this.checkDocumentSizeLimit(content);
  }

  /**
   * Runs all applicable quota checks before a version write.
   */
  async checkBeforeVersionWrite(
    pipelineId: string,
    type: string,
    documentId: string,
    content: string,
  ): Promise<void> {
    await this.checkVersionLimit(pipelineId, type, documentId);
    await this.checkTotalSizeLimit(pipelineId);
    this.checkDocumentSizeLimit(content);
  }

  private async countDocuments(pipelineId: string): Promise<number> { ... }
  private async countVersions(pipelineId: string, type: string, documentId: string): Promise<number> { ... }
  private async computeTotalSize(pipelineId: string): Promise<number> { ... }
}
```

## Acceptance Criteria
1. `writeVersion` creates `v{version}.md` file with the provided content via atomic write.
2. `writeVersion` updates `current.md` symlink to point to the new version file.
3. `writeVersion` computes SHA-256 hash from normalized content (BOM stripped, LF line endings, trailing whitespace trimmed).
4. `normalizeForHash` produces identical hashes for content differing only in line endings or trailing whitespace.
5. `listVersions` returns all version files sorted by semantic version order (1.0 < 1.1 < 1.10 < 2.0).
6. `listVersions` correctly parses `v{MAJOR}.{MINOR}.md` filenames and ignores non-matching files.
7. `QuotaEnforcer.checkDocumentLimit` throws `QuotaExceededError` with `MAX_DOCUMENTS_EXCEEDED` when the document count >= configured limit.
8. `QuotaEnforcer.checkVersionLimit` throws `QuotaExceededError` with `MAX_VERSIONS_EXCEEDED` when version count >= limit.
9. `QuotaEnforcer.checkTotalSizeLimit` throws when total pipeline size >= configured max.
10. `QuotaEnforcer.checkDocumentSizeLimit` throws when content exceeds per-document size limit.
11. All quota checks run BEFORE the actual write operation, never after.

## Test Cases

### Unit Tests: `tests/pipeline/storage/version-writer.test.ts`
- `writes version file at correct path`
- `updates current.md symlink to new version`
- `computes correct SHA-256 hash`
- `normalizeForHash strips BOM`
- `normalizeForHash converts CRLF to LF`
- `normalizeForHash trims trailing whitespace per line`
- `identical content with different line endings produces same hash`
- `returns VersionRecord with all fields populated`

### Unit Tests: `tests/pipeline/storage/version-lister.test.ts`
- `lists all version files in a document directory`
- `ignores non-version files (current.md, reviews/, diffs/)`
- `sorts versions: 1.0 before 1.1`
- `sorts versions: 1.9 before 1.10 (not lexicographic)`
- `sorts versions: 1.10 before 2.0`
- `returns empty array for document with no versions`

### Unit Tests: `tests/pipeline/storage/quota-enforcer.test.ts`
- `checkDocumentLimit allows when under limit`
- `checkDocumentLimit throws MAX_DOCUMENTS_EXCEEDED at limit`
- `checkVersionLimit allows when under limit`
- `checkVersionLimit throws MAX_VERSIONS_EXCEEDED at limit`
- `checkTotalSizeLimit allows when under limit`
- `checkTotalSizeLimit throws MAX_TOTAL_SIZE_EXCEEDED at limit`
- `checkDocumentSizeLimit allows content under limit`
- `checkDocumentSizeLimit throws MAX_DOCUMENT_SIZE_EXCEEDED for oversized content`
- `uses configured limits, not hardcoded defaults`
- `checkBeforeDocumentCreate runs all 3 relevant checks`
- `checkBeforeVersionWrite runs all 3 relevant checks`

### Integration Test: `tests/pipeline/storage/version-quota.integration.test.ts`
- `write 20 versions -> attempt 21st -> QuotaExceededError`
- `create 100 documents -> attempt 101st -> QuotaExceededError`
- `write version -> read back via listVersions -> version present`
- `write 3 versions -> listVersions returns sorted [1.0, 1.1, 1.2]`
