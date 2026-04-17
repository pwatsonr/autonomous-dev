# SPEC-003-2-04: Config Loader, Audit Logger, Document Deletion, and Storage Facade

## Metadata
- **Parent Plan**: PLAN-003-2
- **Tasks Covered**: Task 10, Task 11, Task 12, Task 13
- **Estimated effort**: 12 hours

## Description
Implement the configuration file loader (reads and merges `config.yaml` with defaults), the append-only audit logger with hash-chain integrity, the document deletion admin operation, and the `DocumentStorageAPI` facade that unifies all storage operations behind a single entry point.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/storage/config-loader.ts` | Create |
| `src/pipeline/storage/audit-logger.ts` | Create |
| `src/pipeline/storage/document-deleter.ts` | Create |
| `src/pipeline/storage/document-storage.ts` | Create |
| `src/pipeline/storage/index.ts` | Create (barrel) |

## Implementation Details

### Task 10: `src/pipeline/storage/config-loader.ts`

```typescript
import * as fs from 'fs/promises';
import yaml from 'js-yaml';
import { PipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../types/config';

export class ConfigValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Invalid config: ${field} -- ${reason}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Deep-merges a partial config onto the defaults.
 * Only leaf values from the partial override the defaults.
 * Unknown keys are ignored (not passed through).
 */
function deepMerge(defaults: PipelineConfig, partial: Record<string, unknown>): PipelineConfig {
  // Recursive merge: for each key in defaults, if partial has the same key
  // and both are objects, recurse. Otherwise use partial value if present.
  // ...
}

/**
 * Validates merged config values:
 *   - pipeline.maxDepth must be 4 (hardcoded, reject override)
 *   - storage.maxDocumentsPerPipeline must be 1-1000
 *   - storage.maxVersionsPerDocument must be 1-100
 *   - storage.maxTotalSizeBytes must be > 0
 *   - storage.maxDocumentSizeBytes must be > 0
 *   - reviewGates.defaults.approvalThreshold must be 0-100
 *   - reviewGates.defaults.regressionMargin must be 0-100
 *   - reviewGates.defaults.panelSize must be >= 1
 *   - reviewGates.defaults.maxIterations must be >= 1
 *   - decomposition.maxChildrenPerDecomposition must be 1-50
 *   - decomposition.maxTotalNodes must be 1-500
 *   - decomposition.explosionThresholdPercent must be 1-100
 *   - backwardCascade.maxDepth must be 1-10
 *
 * @throws ConfigValidationError for invalid values
 */
function validateConfig(config: PipelineConfig): void { ... }

/**
 * Loads configuration from config.yaml, merges with defaults,
 * and validates.
 *
 * @param configPath Absolute path to config.yaml (may not exist)
 * @returns Merged and validated PipelineConfig
 */
export async function loadConfig(configPath: string): Promise<PipelineConfig> {
  let partial: Record<string, unknown> = {};

  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    partial = yaml.load(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err; // re-throw non-ENOENT errors (e.g. malformed YAML)
    }
    // File not found: use all defaults (this is fine)
  }

  const merged = deepMerge(DEFAULT_PIPELINE_CONFIG, partial);
  validateConfig(merged);
  return merged;
}
```

### Task 11: `src/pipeline/storage/audit-logger.ts`

```typescript
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { DirectoryManager } from './directory-manager';

export interface PipelineEvent {
  /** UUID v4 event ID */
  eventId: string;
  /** Pipeline this event belongs to */
  pipelineId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type (e.g. 'document_created', 'version_created', etc.) */
  eventType: string;
  /** Document ID, if this event is about a specific document */
  documentId?: string;
  /** Free-form details about the event */
  details: Record<string, unknown>;
  /** Agent or system that triggered the event */
  actorId: string;
  /** SHA-256 hash of the previous log entry (hash chain) */
  previousHash: string;
}

/**
 * Append-only audit logger with hash chain integrity.
 *
 * Format: Newline-delimited JSON (JSONL).
 * Each line is a JSON-serialized PipelineEvent.
 * Each event includes a hash of the previous event's JSON string.
 * First event uses previousHash = SHA-256 of empty string.
 *
 * File is opened in append mode only (flag 'a').
 */
export class AuditLogger {
  /** Hash of the last event appended (in-memory cache) */
  private lastHash: string | null = null;

  constructor(private readonly directoryManager: DirectoryManager) {}

  /**
   * Appends a pipeline event to the audit log.
   *
   * Steps:
   *   1. If lastHash is null, read the last line of the log to initialize it.
   *      If the log is empty, use SHA-256('') as the initial previous hash.
   *   2. Set event.previousHash = lastHash
   *   3. Serialize event to JSON (single line, no newlines in values)
   *   4. Append line + '\n' to audit.log using fs.appendFile
   *   5. Update lastHash = SHA-256(serialized line)
   */
  async appendEvent(
    pipelineId: string,
    eventType: string,
    details: Record<string, unknown>,
    actorId: string,
    documentId?: string,
  ): Promise<PipelineEvent> {
    const logPath = this.directoryManager.getAuditLogPath(pipelineId);

    // Initialize hash chain if needed
    if (this.lastHash === null) {
      this.lastHash = await this.getLastHash(logPath);
    }

    const event: PipelineEvent = {
      eventId: crypto.randomUUID(),
      pipelineId,
      timestamp: new Date().toISOString(),
      eventType,
      documentId,
      details,
      actorId,
      previousHash: this.lastHash,
    };

    const line = JSON.stringify(event);
    await fs.appendFile(logPath, line + '\n', 'utf-8');

    this.lastHash = crypto.createHash('sha256').update(line).digest('hex');
    return event;
  }

  /**
   * Reads all events from the audit log for a pipeline.
   * Verifies hash chain integrity on read.
   *
   * @throws AuditIntegrityError if hash chain is broken
   */
  async readEvents(pipelineId: string): Promise<PipelineEvent[]> {
    const logPath = this.directoryManager.getAuditLogPath(pipelineId);
    const content = await fs.readFile(logPath, 'utf-8');
    if (!content.trim()) return [];

    const lines = content.trim().split('\n');
    const events: PipelineEvent[] = [];
    let expectedPreviousHash = crypto.createHash('sha256').update('').digest('hex');

    for (let i = 0; i < lines.length; i++) {
      const event = JSON.parse(lines[i]) as PipelineEvent;
      if (event.previousHash !== expectedPreviousHash) {
        throw new AuditIntegrityError(i, expectedPreviousHash, event.previousHash);
      }
      events.push(event);
      expectedPreviousHash = crypto.createHash('sha256').update(lines[i]).digest('hex');
    }

    return events;
  }

  private async getLastHash(logPath: string): Promise<string> {
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      if (lines.length === 0) {
        return crypto.createHash('sha256').update('').digest('hex');
      }
      return crypto.createHash('sha256').update(lines[lines.length - 1]).digest('hex');
    } catch {
      return crypto.createHash('sha256').update('').digest('hex');
    }
  }
}

export class AuditIntegrityError extends Error {
  constructor(
    public readonly lineIndex: number,
    public readonly expectedHash: string,
    public readonly actualHash: string,
  ) {
    super(`Audit log integrity violation at line ${lineIndex}: expected ${expectedHash}, got ${actualHash}`);
    this.name = 'AuditIntegrityError';
  }
}
```

### Task 12: `src/pipeline/storage/document-deleter.ts`

```typescript
import * as fs from 'fs/promises';
import { DocumentType } from '../types/document-type';
import { DirectoryManager } from './directory-manager';
import { AuditLogger } from './audit-logger';

/**
 * Deletes a document and all its contents (all versions, reviews, diffs).
 * Admin-only operation. Does NOT cascade -- caller must handle
 * traceability updates (removing traces_to from parent, etc.).
 *
 * Steps:
 *   1. Verify document directory exists
 *   2. Remove the entire directory recursively
 *   3. Log deletion event to audit log
 *
 * @throws DocumentNotFoundError if directory does not exist
 */
export async function deleteDocument(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
  auditLogger: AuditLogger,
  actorId: string,
): Promise<void> {
  const docDir = directoryManager.getDocumentDir(pipelineId, type, documentId);

  // Verify exists
  try {
    await fs.access(docDir);
  } catch {
    throw new Error(`Document directory not found: ${docDir}`);
  }

  // Remove recursively
  await fs.rm(docDir, { recursive: true, force: true });

  // Audit
  await auditLogger.appendEvent(
    pipelineId,
    'document_deleted',
    { documentId, type, deletedDir: docDir },
    actorId,
    documentId,
  );
}
```

### Task 13: `src/pipeline/storage/document-storage.ts`

```typescript
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
```

### Barrel: `src/pipeline/storage/index.ts`

```typescript
export { DocumentStorage } from './document-storage';
export { AtomicWriteError } from './atomic-io';
export { DirectoryManager } from './directory-manager';
export { AuditLogger, AuditIntegrityError, type PipelineEvent } from './audit-logger';
export { QuotaEnforcer, QuotaExceededError, type QuotaViolation } from './quota-enforcer';
export { type CreateDocumentRequest, type DocumentHandle } from './document-creator';
export { type DocumentContent, DocumentNotFoundError } from './document-reader';
export { type DocumentFilter } from './document-lister';
export { type WriteVersionRequest, type VersionRecord } from './version-writer';
export { loadConfig, ConfigValidationError } from './config-loader';
```

## Acceptance Criteria
1. `loadConfig` reads `config.yaml`, merges with defaults, and returns typed `PipelineConfig`.
2. `loadConfig` returns all defaults when `config.yaml` does not exist.
3. `loadConfig` throws on malformed YAML (not ENOENT).
4. `loadConfig` validates all config ranges and rejects `pipeline.maxDepth` overrides.
5. `AuditLogger.appendEvent` appends JSONL line with hash of previous entry.
6. `AuditLogger.readEvents` verifies hash chain and throws `AuditIntegrityError` on tampering.
7. First audit event uses `SHA-256('')` as `previousHash`.
8. `deleteDocument` removes the entire document directory recursively and logs an audit event.
9. `DocumentStorage` facade delegates to all individual components.
10. `DocumentStorage` enforces quotas before every write operation.
11. `DocumentStorage` logs audit events for every mutation (create document, create version, delete document, initialize pipeline).

## Test Cases

### Unit Tests: `tests/pipeline/storage/config-loader.test.ts`
- `loadConfig returns defaults when config.yaml missing`
- `loadConfig merges partial config over defaults`
- `loadConfig rejects pipeline.maxDepth override`
- `loadConfig rejects approvalThreshold > 100`
- `loadConfig rejects maxDocumentsPerPipeline < 1`
- `loadConfig rejects maxChildrenPerDecomposition > 50`
- `loadConfig throws on malformed YAML`
- `loadConfig preserves unrelated defaults when only one section overridden`

### Unit Tests: `tests/pipeline/storage/audit-logger.test.ts`
- `appendEvent writes JSONL line to audit.log`
- `appendEvent includes UUID eventId`
- `appendEvent sets previousHash to hash of previous entry`
- `first event has previousHash = SHA-256 of empty string`
- `readEvents returns all events in order`
- `readEvents verifies hash chain`
- `readEvents throws AuditIntegrityError for tampered log`
- `readEvents returns empty array for empty log`
- `multiple appends build valid hash chain`

### Unit Tests: `tests/pipeline/storage/document-deleter.test.ts`
- `deleteDocument removes document directory`
- `deleteDocument logs audit event`
- `deleteDocument throws for non-existent document`

### Unit Tests: `tests/pipeline/storage/document-storage.test.ts`
- `createDocument delegates to document-creator and logs audit event`
- `createDocument enforces quota before creation`
- `writeVersion delegates to version-writer and logs audit event`
- `writeVersion enforces quota before write`
- `readDocument delegates to document-reader`
- `listDocuments delegates to document-lister`
- `deleteDocument delegates to document-deleter`
- `initializePipeline delegates to pipeline-initializer and logs audit event`

### Integration Test: `tests/pipeline/storage/full-storage.integration.test.ts`
- `init pipeline -> create document -> write version -> read back -> content matches`
- `init pipeline -> create document -> list documents -> document found`
- `init pipeline -> create document -> delete document -> list documents -> empty`
- `audit log has entries for all operations in order with valid hash chain`
