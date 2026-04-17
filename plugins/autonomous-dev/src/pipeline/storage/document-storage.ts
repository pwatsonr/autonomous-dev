import { DocumentType } from '../types/document-type';
import { PipelineConfig } from '../types/config';
import { DirectoryManager } from './directory-manager';
import { AuditLogger } from './audit-logger';
import { QuotaEnforcer } from './quota-enforcer';
import { TemplateEngine } from '../template-engine/template-engine';
import { IdCounter } from '../frontmatter/id-generator';
import { CreateDocumentRequest, DocumentHandle, createDocument } from './document-creator';
import { DocumentContent, readDocument, readVersion } from './document-reader';
import { DocumentFilter, listDocuments } from './document-lister';
import { WriteVersionRequest, VersionRecord, writeVersion } from './version-writer';
import { listVersions } from './version-lister';
import { deleteDocument } from './document-deleter';
import { initializePipeline, PipelineInitResult } from './pipeline-initializer';

/**
 * Unified facade for all document storage operations.
 * Implements DocumentStorageAPI from TDD Section 5.1.
 *
 * Responsibilities:
 *   - Delegates to individual components
 *   - Enforces quotas before writes
 *   - Logs all mutations to audit log
 *   - Provides single entry point for all storage operations
 */
export class DocumentStorage {
  private directoryManager: DirectoryManager;
  private auditLogger: AuditLogger;
  private quotaEnforcer: QuotaEnforcer;
  private templateEngine: TemplateEngine;
  private idCounter: IdCounter;

  constructor(
    config: PipelineConfig,
    idCounter: IdCounter,
  ) {
    this.directoryManager = new DirectoryManager(config.pipeline.rootDir);
    this.auditLogger = new AuditLogger(this.directoryManager);
    this.quotaEnforcer = new QuotaEnforcer(config, this.directoryManager);
    this.templateEngine = new TemplateEngine();
    this.idCounter = idCounter;
  }

  /** Initialize a new pipeline directory with all required files. */
  async initializePipeline(pipelineId: string, title: string): Promise<PipelineInitResult> {
    const result = await initializePipeline(this.directoryManager, pipelineId, title);
    await this.auditLogger.appendEvent(
      pipelineId, 'pipeline_created', { title }, 'system',
    );
    return result;
  }

  /** Create a new document. Enforces quotas. */
  async createDocument(request: CreateDocumentRequest): Promise<DocumentHandle> {
    // Pre-write: render content to check size
    const tempContent = this.templateEngine.renderTemplate(request.type, {
      title: request.title,
    });
    await this.quotaEnforcer.checkBeforeDocumentCreate(request.pipelineId, tempContent);

    const handle = await createDocument(
      request,
      this.directoryManager,
      this.templateEngine,
      this.idCounter,
    );

    await this.auditLogger.appendEvent(
      request.pipelineId,
      'document_created',
      { documentId: handle.documentId, type: request.type, version: '1.0' },
      request.authorAgent,
      handle.documentId,
    );

    return handle;
  }

  /** Read current version of a document. */
  async readDocument(pipelineId: string, type: DocumentType, documentId: string): Promise<DocumentContent> {
    return readDocument(pipelineId, type, documentId, this.directoryManager);
  }

  /** Read a specific version of a document. */
  async readVersion(pipelineId: string, type: DocumentType, documentId: string, version: string): Promise<DocumentContent> {
    return readVersion(pipelineId, type, documentId, version, this.directoryManager);
  }

  /** List documents in a pipeline with optional filter. */
  async listDocuments(pipelineId: string, filter?: DocumentFilter): Promise<DocumentHandle[]> {
    return listDocuments(pipelineId, this.directoryManager, filter);
  }

  /** List all versions of a document. */
  async listVersions(pipelineId: string, type: DocumentType, documentId: string): Promise<VersionRecord[]> {
    return listVersions(pipelineId, type, documentId, this.directoryManager);
  }

  /** Write a new version. Enforces quotas. */
  async writeVersion(request: WriteVersionRequest): Promise<VersionRecord> {
    await this.quotaEnforcer.checkBeforeVersionWrite(
      request.pipelineId, request.type, request.documentId, request.content,
    );

    const record = await writeVersion(request, this.directoryManager);

    await this.auditLogger.appendEvent(
      request.pipelineId,
      'version_created',
      { documentId: request.documentId, version: request.version, reason: request.reason },
      request.authorAgent,
      request.documentId,
    );

    return record;
  }

  /** Delete a document (admin). */
  async deleteDocument(pipelineId: string, type: DocumentType, documentId: string, actorId: string): Promise<void> {
    return deleteDocument(pipelineId, type, documentId, this.directoryManager, this.auditLogger, actorId);
  }

  /** Get the directory manager for direct path queries. */
  getDirectoryManager(): DirectoryManager {
    return this.directoryManager;
  }

  /** Get the audit logger for direct event queries. */
  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }
}
