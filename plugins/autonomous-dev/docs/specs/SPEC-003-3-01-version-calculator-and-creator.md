# SPEC-003-3-01: Version Number Calculator and Version Creation Orchestrator

## Metadata
- **Parent Plan**: PLAN-003-3
- **Tasks Covered**: Task 1, Task 2
- **Estimated effort**: 7 hours

## Description
Implement the version number calculator that determines the next version (major or minor increment) based on the current version and reason, and the version creation orchestrator that coordinates the full version creation flow: compute next version, write the file via storage layer, update symlink, produce a `VersionRecord`, and log the event.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/versioning/version-calculator.ts` | Create |
| `src/pipeline/versioning/version-creator.ts` | Create |

## Implementation Details

### Task 1: `src/pipeline/versioning/version-calculator.ts`

```typescript
import { VersionReason } from '../types/frontmatter';

/**
 * Parses a version string "MAJOR.MINOR" into components.
 */
export function parseVersion(version: string): { major: number; minor: number } {
  const match = version.match(/^(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid version string: ${version}`);
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
}

/**
 * Formats major.minor into a version string.
 */
export function formatVersion(major: number, minor: number): string {
  return `${major}.${minor}`;
}

/**
 * Determines the next version number given the current version and reason.
 *
 * Rules (TDD Section 3.5.1):
 *   INITIAL:            Always "1.0" (ignores currentVersion)
 *   REVIEW_REVISION:    Minor increment (1.0 -> 1.1 -> 1.2)
 *   BACKWARD_CASCADE:   Major increment (1.3 -> 2.0)
 *   ROLLBACK:           Minor increment from CURRENT version (not target)
 *                        e.g. current=1.2, rollback to 1.0 -> new version is 1.3
 *
 * Important: minor increments do NOT wrap. 9.9 -> 9.10, NOT 10.0.
 * Major increments reset minor to 0. 1.3 -> 2.0.
 * Version numbers are never reused.
 *
 * @param currentVersion The current (latest) version string, e.g. "1.2"
 * @param reason Why the new version is being created
 * @returns The next version string
 */
export function calculateNextVersion(
  currentVersion: string | null,
  reason: VersionReason,
): string {
  if (reason === 'INITIAL') {
    return '1.0';
  }

  if (currentVersion === null) {
    throw new Error('currentVersion is required for non-INITIAL versions');
  }

  const { major, minor } = parseVersion(currentVersion);

  switch (reason) {
    case 'REVIEW_REVISION':
    case 'ROLLBACK':
      return formatVersion(major, minor + 1);
    case 'BACKWARD_CASCADE':
      return formatVersion(major + 1, 0);
    default:
      throw new Error(`Unknown version reason: ${reason}`);
  }
}
```

### Task 2: `src/pipeline/versioning/version-creator.ts`

```typescript
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
```

## Acceptance Criteria
1. `calculateNextVersion(null, 'INITIAL')` returns `"1.0"`.
2. `calculateNextVersion("1.0", 'REVIEW_REVISION')` returns `"1.1"`.
3. `calculateNextVersion("1.2", 'REVIEW_REVISION')` returns `"1.3"`.
4. `calculateNextVersion("1.3", 'BACKWARD_CASCADE')` returns `"2.0"`.
5. `calculateNextVersion("1.2", 'ROLLBACK')` returns `"1.3"` (minor increment from current, not from target).
6. `calculateNextVersion("9.9", 'REVIEW_REVISION')` returns `"9.10"` (no major wrap).
7. `calculateNextVersion` throws for unknown reason.
8. `calculateNextVersion` throws when `currentVersion` is null for non-INITIAL reason.
9. `createVersion` delegates file I/O to storage layer.
10. `createVersion` updates the `version` and `updated_at` fields in the content's frontmatter before writing.
11. `createVersion` returns a `VersionRecord` with `sourceVersion` set for rollbacks.
12. Version strings always match `^\d+\.\d+$` pattern.

## Test Cases

### Unit Tests: `tests/pipeline/versioning/version-calculator.test.ts`
- `INITIAL reason always returns 1.0`
- `REVIEW_REVISION: 1.0 -> 1.1`
- `REVIEW_REVISION: 1.1 -> 1.2`
- `REVIEW_REVISION: 1.9 -> 1.10 (not 2.0)`
- `REVIEW_REVISION: 9.9 -> 9.10`
- `BACKWARD_CASCADE: 1.3 -> 2.0`
- `BACKWARD_CASCADE: 2.5 -> 3.0`
- `ROLLBACK: 1.2 -> 1.3`
- `ROLLBACK: 2.0 -> 2.1`
- `throws for null currentVersion with REVIEW_REVISION`
- `throws for unknown reason`
- `parseVersion parses "1.0" correctly`
- `parseVersion throws for invalid format "1"`
- `parseVersion throws for invalid format "abc"`
- `formatVersion produces "1.0" from (1, 0)`

### Unit Tests: `tests/pipeline/versioning/version-creator.test.ts`
- `createVersion calls storage.listVersions to get current version`
- `createVersion calls calculateNextVersion with correct args`
- `createVersion updates frontmatter version in content`
- `createVersion updates frontmatter updated_at in content`
- `createVersion calls storage.writeVersion with computed version`
- `createVersion returns VersionRecord with sourceVersion for rollbacks`
- `createVersion with INITIAL reason does not list versions`
- `createVersion with REVIEW_REVISION increments from latest version`
