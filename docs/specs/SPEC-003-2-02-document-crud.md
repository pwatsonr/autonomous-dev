# SPEC-003-2-02: Document Creation, Reading, and Listing

## Metadata
- **Parent Plan**: PLAN-003-2
- **Tasks Covered**: Task 4, Task 5, Task 6
- **Estimated effort**: 14 hours

## Description
Implement the core document CRUD operations: creating a new document from a template with populated frontmatter, reading a document (current version via symlink or specific version), and listing/filtering documents within a pipeline.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/storage/document-creator.ts` | Create |
| `src/pipeline/storage/document-reader.ts` | Create |
| `src/pipeline/storage/document-lister.ts` | Create |

## Implementation Details

### Task 4: `src/pipeline/storage/document-creator.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { DocumentFrontmatter, Priority, ExecutionMode, DependencyType } from '../types/frontmatter';
import { DirectoryManager } from './directory-manager';
import { atomicWrite, atomicSymlink } from './atomic-io';
import { TemplateEngine } from '../template-engine/template-engine';
import { generateDocumentId, IdCounter } from '../frontmatter/id-generator';

export interface CreateDocumentRequest {
  pipelineId: string;
  type: DocumentType;
  title: string;
  authorAgent: string;
  parentId: string | null;
  tracesFrom: string[];
  depth: number;
  siblingIndex: number;
  siblingCount: number;
  dependsOn: string[];
  dependencyType: DependencyType[];
  executionMode: ExecutionMode;
  priority: Priority;
}

export interface DocumentHandle {
  documentId: string;
  pipelineId: string;
  type: DocumentType;
  version: string;
  filePath: string;
  symlinkPath: string;
  documentDir: string;
}

/**
 * Creates a new document in the pipeline.
 *
 * Steps:
 *   1. Generate document ID via id-generator
 *   2. Create document directory tree via directory-manager
 *   3. Build frontmatter from request + template defaults
 *   4. Render template with frontmatter via template-engine
 *   5. Write v1.0.md via atomicWrite
 *   6. Create current.md symlink pointing to v1.0.md
 *   7. Return DocumentHandle
 *
 * @throws DocumentCreationError if any step fails
 */
export async function createDocument(
  request: CreateDocumentRequest,
  directoryManager: DirectoryManager,
  templateEngine: TemplateEngine,
  idCounter: IdCounter,
): Promise<DocumentHandle> {
  // 1. Generate ID
  const documentId = await generateDocumentId(
    request.type,
    request.pipelineId,
    idCounter,
  );

  // 2. Create directory tree
  await directoryManager.createDocumentDirs(
    request.pipelineId,
    request.type,
    documentId,
  );

  // 3. Build frontmatter overrides
  const now = new Date().toISOString();
  const frontmatterOverrides: Partial<DocumentFrontmatter> = {
    id: documentId,
    title: request.title,
    pipeline_id: request.pipelineId,
    type: request.type,
    status: 'draft',
    version: '1.0',
    created_at: now,
    updated_at: now,
    author_agent: request.authorAgent,
    parent_id: request.parentId,
    traces_from: request.tracesFrom,
    traces_to: [],
    depth: request.depth,
    sibling_index: request.siblingIndex,
    sibling_count: request.siblingCount,
    depends_on: request.dependsOn,
    dependency_type: request.dependencyType,
    execution_mode: request.executionMode,
    priority: request.priority,
  };

  // 4. Render template
  const content = templateEngine.renderTemplate(request.type, {
    title: request.title,
    frontmatterOverrides,
  });

  // 5. Write v1.0.md
  const versionFilePath = directoryManager.getVersionFilePath(
    request.pipelineId,
    request.type,
    documentId,
    '1.0',
  );
  await atomicWrite(versionFilePath, content);

  // 6. Create current.md symlink
  const symlinkPath = directoryManager.getCurrentSymlinkPath(
    request.pipelineId,
    request.type,
    documentId,
  );
  await atomicSymlink('v1.0.md', symlinkPath);

  // 7. Return handle
  return {
    documentId,
    pipelineId: request.pipelineId,
    type: request.type,
    version: '1.0',
    filePath: versionFilePath,
    symlinkPath,
    documentDir: directoryManager.getDocumentDir(
      request.pipelineId,
      request.type,
      documentId,
    ),
  };
}
```

### Task 5: `src/pipeline/storage/document-reader.ts`

```typescript
import * as fs from 'fs/promises';
import { DocumentType } from '../types/document-type';
import { DocumentFrontmatter } from '../types/frontmatter';
import { parseFrontmatter, ParseResult } from '../frontmatter/parser';
import { DirectoryManager } from './directory-manager';

export interface DocumentContent {
  /** Parsed frontmatter */
  frontmatter: Partial<DocumentFrontmatter>;
  /** Markdown body (after frontmatter) */
  body: string;
  /** Raw file content */
  rawContent: string;
  /** Version string extracted from filename or frontmatter */
  version: string;
  /** Absolute file path */
  filePath: string;
}

export class DocumentNotFoundError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly version?: string,
  ) {
    super(
      version
        ? `Document ${documentId} version ${version} not found`
        : `Document ${documentId} not found`,
    );
    this.name = 'DocumentNotFoundError';
  }
}

/**
 * Reads the current version of a document (follows current.md symlink).
 */
export async function readDocument(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
): Promise<DocumentContent> {
  const symlinkPath = directoryManager.getCurrentSymlinkPath(
    pipelineId, type, documentId,
  );

  try {
    const rawContent = await fs.readFile(symlinkPath, 'utf-8');
    const parseResult = parseFrontmatter(rawContent);
    const version = parseResult.frontmatter.version ?? extractVersionFromSymlink(symlinkPath);

    return {
      frontmatter: parseResult.frontmatter,
      body: parseResult.body,
      rawContent,
      version,
      filePath: await fs.realpath(symlinkPath),
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DocumentNotFoundError(documentId);
    }
    throw err;
  }
}

/**
 * Reads a specific version of a document.
 */
export async function readVersion(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  version: string,
  directoryManager: DirectoryManager,
): Promise<DocumentContent> {
  const versionPath = directoryManager.getVersionFilePath(
    pipelineId, type, documentId, version,
  );

  try {
    const rawContent = await fs.readFile(versionPath, 'utf-8');
    const parseResult = parseFrontmatter(rawContent);

    return {
      frontmatter: parseResult.frontmatter,
      body: parseResult.body,
      rawContent,
      version,
      filePath: versionPath,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DocumentNotFoundError(documentId, version);
    }
    throw err;
  }
}

/**
 * Helper: extracts version from symlink target filename.
 * e.g., "v1.1.md" -> "1.1"
 */
function extractVersionFromSymlink(symlinkPath: string): string { ... }
```

### Task 6: `src/pipeline/storage/document-lister.ts`

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentType } from '../types/document-type';
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
): Promise<DocumentHandle[]> { ... }
```

## Acceptance Criteria
1. `createDocument` generates a unique ID, creates the directory tree, writes `v1.0.md` with rendered template content, and creates `current.md` symlink pointing to `v1.0.md`.
2. `createDocument` populates all frontmatter fields from the request (id, title, pipeline_id, type, status=draft, version=1.0, timestamps, author_agent, parent_id, traces_from, traces_to=[], depth, sibling_index, sibling_count, depends_on, dependency_type, execution_mode, priority).
3. `readDocument` follows the `current.md` symlink and returns parsed content.
4. `readVersion` reads a specific version file by constructing the path from the version string.
5. Both read functions throw `DocumentNotFoundError` when the document or version does not exist.
6. `listDocuments` with no filter returns all documents sorted by document ID.
7. `listDocuments` with `type` filter only scans the specified type directory.
8. `listDocuments` with `status`, `parentId`, `minDepth`, `maxDepth` filters correctly narrows results.

## Test Cases

### Unit Tests: `tests/pipeline/storage/document-creator.test.ts`
- `creates document directory with reviews/ and diffs/ subdirectories`
- `writes v1.0.md with correct frontmatter`
- `creates current.md symlink pointing to v1.0.md`
- `returns DocumentHandle with correct fields`
- `frontmatter.status is draft`
- `frontmatter.version is 1.0`
- `frontmatter.id matches generated document ID`
- `frontmatter.parent_id is null for root PRD`
- `frontmatter.traces_from is non-empty for child documents`

### Unit Tests: `tests/pipeline/storage/document-reader.test.ts`
- `readDocument returns content from current.md symlink`
- `readDocument returns parsed frontmatter and body`
- `readVersion returns content from specific version file`
- `readDocument throws DocumentNotFoundError for missing document`
- `readVersion throws DocumentNotFoundError for missing version`
- `readDocument resolves symlink to actual file path`

### Unit Tests: `tests/pipeline/storage/document-lister.test.ts`
- `listDocuments returns all documents in pipeline`
- `listDocuments returns results sorted by document ID`
- `listDocuments with type filter only returns documents of that type`
- `listDocuments with status filter only returns matching documents`
- `listDocuments with parentId filter only returns children of that parent`
- `listDocuments with minDepth/maxDepth filter narrows by depth`
- `listDocuments returns empty array for pipeline with no documents`

### Integration Test: `tests/pipeline/storage/document-lifecycle.integration.test.ts`
- `create document -> read back -> content matches`
- `create document -> read specific version v1.0 -> content matches`
- `create 3 documents -> list all -> returns 3 sorted by ID`
- `create PRD + 2 TDDs -> list with type=TDD -> returns 2`
- `create PRD + 2 TDDs -> list with parentId=PRD_ID -> returns 2`
