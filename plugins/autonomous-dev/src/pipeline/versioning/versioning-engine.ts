import { DocumentType } from '../types/document-type';
import { PipelineConfig } from '../types/config';
import { DocumentStorage } from '../storage/document-storage';
import { VersionRecord } from '../storage/version-writer';
import { VersionDiff, computeDiff } from './diff-engine';
import { writeDiff } from './diff-writer';
import { checkRegression, RegressionCheckResult } from './regression-detector';
import { rollback } from './rollback-executor';
import { createVersion, VersionCreateRequest } from './version-creator';
import { getHistory } from './history-retriever';
import { getLatestScore } from './review-feedback-io';

/**
 * Unified facade for all versioning operations.
 * Implements VersioningEngineAPI from TDD Section 5.3.
 *
 * Methods:
 *   createVersion - Create a new version of a document
 *   computeDiff   - Compute section-level diff between two versions
 *   checkRegression - Check for quality regression
 *   rollback      - Roll back to a previous version
 *   getHistory    - Get complete version history
 *
 * Automatic behavior:
 *   - On version creation (non-INITIAL): automatically computes and writes
 *     a diff between the previous version and the new version.
 *   - All operations logged to audit log via storage layer.
 */
export class VersioningEngine {
  constructor(
    private readonly storage: DocumentStorage,
    private readonly config: PipelineConfig,
  ) {}

  /**
   * Creates a new version of a document.
   *
   * Automatically computes and writes a diff unless this is the INITIAL version.
   */
  async createVersion(request: VersionCreateRequest): Promise<VersionRecord> {
    // Get previous version content for diff (if not initial)
    let previousContent: string | null = null;
    let previousVersion: string | null = null;

    if (request.reason !== 'INITIAL') {
      const history = await this.storage.listVersions(
        request.pipelineId, request.type, request.documentId,
      );
      if (history.length > 0) {
        previousVersion = history[history.length - 1].version;
        const prevDoc = await this.storage.readVersion(
          request.pipelineId, request.type, request.documentId, previousVersion,
        );
        previousContent = prevDoc.rawContent;
      }
    }

    // Create the new version
    const record = await createVersion(request, this.storage);

    // Auto-generate diff for non-initial versions
    if (previousContent !== null && previousVersion !== null) {
      const diff = computeDiff(
        previousContent,
        request.content,
        previousVersion,
        record.version,
      );
      await writeDiff(
        diff,
        request.pipelineId,
        request.type,
        request.documentId,
        this.storage.getDirectoryManager(),
      );
    }

    return record;
  }

  /**
   * Computes a section-level diff between two specific versions.
   */
  async computeDiff(
    pipelineId: string,
    type: DocumentType,
    documentId: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<VersionDiff> {
    const fromDoc = await this.storage.readVersion(pipelineId, type, documentId, fromVersion);
    const toDoc = await this.storage.readVersion(pipelineId, type, documentId, toVersion);
    return computeDiff(fromDoc.rawContent, toDoc.rawContent, fromVersion, toVersion);
  }

  /**
   * Checks for quality regression by comparing new score against previous.
   */
  async checkRegression(
    pipelineId: string,
    type: DocumentType,
    documentId: string,
    newScore: number,
  ): Promise<RegressionCheckResult> {
    const previousScore = await getLatestScore(
      pipelineId, type, documentId,
      this.storage.getDirectoryManager(),
    );
    return checkRegression(newScore, previousScore, this.config, type);
  }

  /**
   * Rolls back a document to a previous version.
   */
  async rollback(
    pipelineId: string,
    type: DocumentType,
    documentId: string,
    targetVersion: string,
    authorAgent: string,
  ): Promise<VersionRecord> {
    return rollback(pipelineId, type, documentId, targetVersion, authorAgent, this.storage);
  }

  /**
   * Returns the complete version history for a document.
   */
  async getHistory(
    pipelineId: string,
    type: DocumentType,
    documentId: string,
  ): Promise<VersionRecord[]> {
    return getHistory(pipelineId, type, documentId, this.storage);
  }
}
