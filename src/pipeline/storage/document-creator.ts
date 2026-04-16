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

export class DocumentCreationError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'DocumentCreationError';
  }
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
  try {
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
  } catch (err: unknown) {
    if (err instanceof DocumentCreationError) {
      throw err;
    }
    throw new DocumentCreationError(
      `Failed to create document: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }
}
