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

  /**
   * Counts all documents across all type directories in a pipeline.
   * A "document" is a subdirectory under any type directory.
   */
  private async countDocuments(pipelineId: string): Promise<number> {
    const documentsDir = this.directoryManager.getDocumentsDir(pipelineId);

    let count = 0;
    let typeEntries: string[];
    try {
      typeEntries = await fs.readdir(documentsDir);
    } catch {
      // documents dir doesn't exist yet => 0 documents
      return 0;
    }

    for (const typeDir of typeEntries) {
      const typePath = path.join(documentsDir, typeDir);
      const stat = await fs.stat(typePath);
      if (!stat.isDirectory()) continue;

      const docEntries = await fs.readdir(typePath);
      for (const docEntry of docEntries) {
        const docPath = path.join(typePath, docEntry);
        const docStat = await fs.stat(docPath);
        if (docStat.isDirectory()) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Counts version files (matching v{MAJOR}.{MINOR}.md) in a document directory.
   */
  private async countVersions(
    pipelineId: string,
    type: string,
    documentId: string,
  ): Promise<number> {
    const docDir = path.join(
      this.directoryManager.getDocumentsDir(pipelineId),
      type,
      documentId,
    );

    let entries: string[];
    try {
      entries = await fs.readdir(docDir);
    } catch {
      return 0;
    }

    const versionRegex = /^v\d+\.\d+\.md$/;
    return entries.filter(e => versionRegex.test(e)).length;
  }

  /**
   * Computes the total size in bytes of all files under the pipeline directory.
   * Walks the directory tree recursively.
   */
  private async computeTotalSize(pipelineId: string): Promise<number> {
    const pipelineDir = this.directoryManager.getPipelineDir(pipelineId);
    return this.dirSize(pipelineDir);
  }

  /**
   * Recursively sums file sizes in a directory.
   */
  private async dirSize(dirPath: string): Promise<number> {
    let total = 0;

    let entries: string[];
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry);
      const stat = await fs.lstat(entryPath);
      if (stat.isFile()) {
        total += stat.size;
      } else if (stat.isDirectory()) {
        total += await this.dirSize(entryPath);
      }
      // Symlinks are not counted (lstat reports the symlink itself, not target)
    }

    return total;
  }
}
