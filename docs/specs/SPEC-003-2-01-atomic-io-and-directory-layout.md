# SPEC-003-2-01: Atomic I/O, Directory Layout Manager, and Pipeline Initialization

## Metadata
- **Parent Plan**: PLAN-003-2
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 10 hours

## Description
Implement the crash-safe atomic file write and symlink swap utilities, the directory hierarchy manager that creates and navigates the `.autonomous-dev/pipelines/` directory tree, and the pipeline initializer that creates a new pipeline root with all required files and subdirectories.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/storage/atomic-io.ts` | Create |
| `src/pipeline/storage/directory-manager.ts` | Create |
| `src/pipeline/storage/pipeline-initializer.ts` | Create |

## Implementation Details

### Task 1: `src/pipeline/storage/atomic-io.ts`

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Writes content to targetPath atomically using write-then-rename.
 *
 * Algorithm (POSIX atomic rename):
 *   1. Create a temp file at `{targetPath}.{Date.now()}.tmp`
 *   2. Write content to temp file
 *   3. fsync the temp file to ensure durability
 *   4. rename temp file to targetPath (atomic on POSIX)
 *   5. On failure: unlink temp file (best-effort cleanup)
 *
 * @param targetPath Absolute path to the destination file
 * @param content String content to write
 * @throws AtomicWriteError on permission denied, disk full, or invalid path
 */
export async function atomicWrite(
  targetPath: string,
  content: string,
): Promise<void> {
  const tmpPath = `${targetPath}.${Date.now()}.tmp`;
  try {
    const fd = await fs.open(tmpPath, 'w');
    try {
      await fd.writeFile(content, 'utf-8');
      await fd.sync(); // fsync for durability
    } finally {
      await fd.close();
    }
    await fs.rename(tmpPath, targetPath);
  } catch (err: unknown) {
    // Best-effort cleanup of temp file
    await fs.unlink(tmpPath).catch(() => {});
    throw new AtomicWriteError(
      `Atomic write to ${targetPath} failed`,
      err as Error,
    );
  }
}

/**
 * Atomically swaps a symlink to point to a new target.
 *
 * Algorithm:
 *   1. Create a temp symlink at `{linkPath}.{Date.now()}.tmp`
 *   2. rename temp symlink to linkPath (atomic on POSIX)
 *   3. On failure: unlink temp symlink (best-effort cleanup)
 *
 * @param target Relative path the symlink should point to (e.g. "v1.1.md")
 * @param linkPath Absolute path of the symlink (e.g. "/path/to/current.md")
 */
export async function atomicSymlink(
  target: string,
  linkPath: string,
): Promise<void> {
  const tmpLink = `${linkPath}.${Date.now()}.tmp`;
  try {
    await fs.symlink(target, tmpLink);
    await fs.rename(tmpLink, linkPath);
  } catch (err: unknown) {
    await fs.unlink(tmpLink).catch(() => {});
    throw new AtomicWriteError(
      `Atomic symlink swap at ${linkPath} failed`,
      err as Error,
    );
  }
}

export class AtomicWriteError extends Error {
  constructor(message: string, public readonly cause: Error) {
    super(message);
    this.name = 'AtomicWriteError';
  }
}
```

### Task 2: `src/pipeline/storage/directory-manager.ts`

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentType } from '../types/document-type';

/**
 * Directory hierarchy layout (TDD Section 3.4.1):
 *
 * .autonomous-dev/
 *   pipelines/
 *     {PIPE_ID}/
 *       pipeline.yaml
 *       audit.log
 *       traceability.yaml
 *       config.yaml
 *       documents/
 *         PRD/
 *           {DOC_ID}/
 *             v1.0.md
 *             v1.1.md
 *             current.md -> v1.1.md  (symlink)
 *             reviews/
 *               v1.0-review-001.yaml
 *             diffs/
 *               v1.0-to-v1.1.diff
 *         TDD/
 *           {DOC_ID}/
 *             ...
 *         PLAN/
 *         SPEC/
 *         CODE/
 *       decomposition/
 *         {PARENT_ID}-decomposition.yaml
 */

export class DirectoryManager {
  constructor(private readonly rootDir: string) {}

  /** Root pipeline directory: {rootDir}/{pipelineId}/ */
  getPipelineDir(pipelineId: string): string {
    return path.join(this.rootDir, pipelineId);
  }

  /** Documents root: {pipelineDir}/documents/ */
  getDocumentsDir(pipelineId: string): string {
    return path.join(this.getPipelineDir(pipelineId), 'documents');
  }

  /** Type directory: {documentsDir}/{type}/ */
  getTypeDir(pipelineId: string, type: DocumentType): string {
    return path.join(this.getDocumentsDir(pipelineId), type);
  }

  /** Document directory: {typeDir}/{documentId}/ */
  getDocumentDir(pipelineId: string, type: DocumentType, documentId: string): string {
    return path.join(this.getTypeDir(pipelineId, type), documentId);
  }

  /** Reviews subdirectory: {documentDir}/reviews/ */
  getReviewsDir(pipelineId: string, type: DocumentType, documentId: string): string {
    return path.join(this.getDocumentDir(pipelineId, type, documentId), 'reviews');
  }

  /** Diffs subdirectory: {documentDir}/diffs/ */
  getDiffsDir(pipelineId: string, type: DocumentType, documentId: string): string {
    return path.join(this.getDocumentDir(pipelineId, type, documentId), 'diffs');
  }

  /** Decomposition directory: {pipelineDir}/decomposition/ */
  getDecompositionDir(pipelineId: string): string {
    return path.join(this.getPipelineDir(pipelineId), 'decomposition');
  }

  /** Version file path: {documentDir}/v{version}.md */
  getVersionFilePath(
    pipelineId: string,
    type: DocumentType,
    documentId: string,
    version: string,
  ): string {
    return path.join(
      this.getDocumentDir(pipelineId, type, documentId),
      `v${version}.md`,
    );
  }

  /** Symlink path: {documentDir}/current.md */
  getCurrentSymlinkPath(
    pipelineId: string,
    type: DocumentType,
    documentId: string,
  ): string {
    return path.join(
      this.getDocumentDir(pipelineId, type, documentId),
      'current.md',
    );
  }

  /** Pipeline state file: {pipelineDir}/pipeline.yaml */
  getPipelineYamlPath(pipelineId: string): string {
    return path.join(this.getPipelineDir(pipelineId), 'pipeline.yaml');
  }

  /** Audit log: {pipelineDir}/audit.log */
  getAuditLogPath(pipelineId: string): string {
    return path.join(this.getPipelineDir(pipelineId), 'audit.log');
  }

  /** Traceability file: {pipelineDir}/traceability.yaml */
  getTraceabilityPath(pipelineId: string): string {
    return path.join(this.getPipelineDir(pipelineId), 'traceability.yaml');
  }

  /**
   * Creates the full directory tree for a new document.
   * Uses mkdirp semantics (creates intermediate directories).
   */
  async createDocumentDirs(
    pipelineId: string,
    type: DocumentType,
    documentId: string,
  ): Promise<void> {
    const docDir = this.getDocumentDir(pipelineId, type, documentId);
    await fs.mkdir(docDir, { recursive: true });
    await fs.mkdir(path.join(docDir, 'reviews'), { recursive: true });
    await fs.mkdir(path.join(docDir, 'diffs'), { recursive: true });
  }

  /**
   * Creates the full directory tree for a new pipeline.
   */
  async createPipelineDirs(pipelineId: string): Promise<void> {
    const pipeDir = this.getPipelineDir(pipelineId);
    await fs.mkdir(pipeDir, { recursive: true });
    await fs.mkdir(path.join(pipeDir, 'documents'), { recursive: true });
    await fs.mkdir(path.join(pipeDir, 'decomposition'), { recursive: true });
    // Type subdirectories are created on demand when the first document of that type is created
  }
}
```

### Task 3: `src/pipeline/storage/pipeline-initializer.ts`

```typescript
import yaml from 'js-yaml';
import { DirectoryManager } from './directory-manager';
import { atomicWrite } from './atomic-io';

export interface PipelineInitResult {
  pipelineId: string;
  pipelineDir: string;
  pipelineYamlPath: string;
  auditLogPath: string;
  traceabilityPath: string;
}

/**
 * Pipeline ID format: PIPE-{YYYY}-{MMDD}-{SEQ}
 * Example: PIPE-2026-0408-001
 *
 * @param date Current date (injectable for testing)
 * @param sequence Sequence number (zero-padded to 3 digits)
 */
export function generatePipelineId(date: Date, sequence: number): string {
  const yyyy = date.getFullYear().toString();
  const mmdd = String(date.getMonth() + 1).padStart(2, '0')
    + String(date.getDate()).padStart(2, '0');
  const seq = String(sequence).padStart(3, '0');
  return `PIPE-${yyyy}-${mmdd}-${seq}`;
}

/**
 * Initial pipeline.yaml content per TDD Section 3.9.2:
 */
function buildInitialPipelineYaml(pipelineId: string, title: string): string {
  const state = {
    pipeline_id: pipelineId,
    title: title,
    status: 'active',
    priority: 'normal',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    paused_at: null,
    document_states: {},
    active_cascades: [],
    metrics: {
      total_documents: 0,
      documents_by_status: {},
      total_versions: 0,
      total_reviews: 0,
    },
  };
  return yaml.dump(state, { lineWidth: 120, noRefs: true });
}

/**
 * Creates a new pipeline directory with all initial files.
 */
export async function initializePipeline(
  directoryManager: DirectoryManager,
  pipelineId: string,
  title: string,
): Promise<PipelineInitResult> {
  // 1. Create directory tree
  await directoryManager.createPipelineDirs(pipelineId);

  // 2. Write pipeline.yaml
  const pipelineYamlPath = directoryManager.getPipelineYamlPath(pipelineId);
  await atomicWrite(pipelineYamlPath, buildInitialPipelineYaml(pipelineId, title));

  // 3. Write empty audit.log
  const auditLogPath = directoryManager.getAuditLogPath(pipelineId);
  await atomicWrite(auditLogPath, '');

  // 4. Write empty traceability.yaml
  const traceabilityPath = directoryManager.getTraceabilityPath(pipelineId);
  await atomicWrite(traceabilityPath, yaml.dump({ links: [], chains: [], gaps: [], orphans: [] }));

  return {
    pipelineId,
    pipelineDir: directoryManager.getPipelineDir(pipelineId),
    pipelineYamlPath,
    auditLogPath,
    traceabilityPath,
  };
}
```

## Acceptance Criteria
1. `atomicWrite` writes content via temp file + rename; file never has partial content.
2. `atomicWrite` cleans up temp file on failure.
3. `atomicSymlink` swaps symlink target atomically via temp symlink + rename.
4. `DirectoryManager` computes deterministic paths for all entities given pipeline/type/document IDs.
5. `DirectoryManager.createDocumentDirs` creates document dir, `reviews/`, and `diffs/` subdirectories.
6. `DirectoryManager.createPipelineDirs` creates pipeline dir, `documents/`, and `decomposition/`.
7. `generatePipelineId` produces IDs matching `PIPE-{YYYY}-{MMDD}-{SEQ}` format.
8. `initializePipeline` creates `pipeline.yaml` with correct initial state, empty `audit.log`, and empty `traceability.yaml`.
9. All file writes use `atomicWrite`.

## Test Cases

### Unit Tests: `tests/pipeline/storage/atomic-io.test.ts`
- `atomicWrite creates file with correct content`
- `atomicWrite overwrites existing file`
- `atomicWrite cleans up temp file on write failure`
- `atomicWrite throws AtomicWriteError on permission denied` (mock fs)
- `atomicSymlink creates symlink pointing to target`
- `atomicSymlink swaps existing symlink to new target`
- `atomicSymlink cleans up temp symlink on failure`
- `concurrent atomicWrite calls do not corrupt file` (2 writers, each writes unique content, final content is one of the two)

### Unit Tests: `tests/pipeline/storage/directory-manager.test.ts`
- `getPipelineDir returns {rootDir}/{pipelineId}`
- `getDocumentDir returns correct nested path for each type`
- `getVersionFilePath returns {docDir}/v{version}.md`
- `getCurrentSymlinkPath returns {docDir}/current.md`
- `getReviewsDir returns {docDir}/reviews`
- `getDiffsDir returns {docDir}/diffs`
- `getPipelineYamlPath returns {pipeDir}/pipeline.yaml`
- `getAuditLogPath returns {pipeDir}/audit.log`
- `createDocumentDirs creates document dir and subdirectories`
- `createPipelineDirs creates pipeline dir and subdirectories`

### Unit Tests: `tests/pipeline/storage/pipeline-initializer.test.ts`
- `generatePipelineId formats correctly for 2026-04-08 seq 1` -> `PIPE-2026-0408-001`
- `generatePipelineId pads sequence to 3 digits`
- `initializePipeline creates pipeline.yaml with correct YAML structure`
- `initializePipeline creates empty audit.log`
- `initializePipeline creates traceability.yaml with empty arrays`
- `initializePipeline pipeline.yaml has status active`
