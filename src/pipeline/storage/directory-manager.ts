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
