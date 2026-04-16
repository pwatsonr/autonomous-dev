import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentType } from '../types/document-type';
import { DocumentFrontmatter } from '../types/frontmatter';
import { parseFrontmatter } from '../frontmatter/parser';
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
    const realPath = await fs.realpath(symlinkPath);
    const rawContent = await fs.readFile(realPath, 'utf-8');
    const parseResult = parseFrontmatter(rawContent);
    const version = parseResult.frontmatter.version
      ?? extractVersionFromFilename(path.basename(realPath));

    return {
      frontmatter: parseResult.frontmatter,
      body: parseResult.body,
      rawContent,
      version,
      filePath: realPath,
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
 * Helper: extracts version from a version filename.
 * e.g., "v1.1.md" -> "1.1"
 */
function extractVersionFromFilename(filename: string): string {
  const match = /^v(\d+\.\d+)\.md$/.exec(filename);
  if (match) {
    return match[1];
  }
  return '1.0';
}
