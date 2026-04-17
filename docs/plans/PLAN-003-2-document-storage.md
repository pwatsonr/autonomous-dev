# PLAN-003-2: Document Storage Layer

## Metadata
- **Parent TDD**: TDD-003-document-pipeline
- **Estimated effort**: 5 days
- **Dependencies**: [PLAN-003-1 (types, frontmatter, templates)]
- **Blocked by**: [PLAN-003-1]
- **Priority**: P0

## Objective
Deliver the file-system-based persistence layer that stores all pipeline documents, versions, reviews, diffs, and metadata. After this plan, the system can create pipelines, create documents from templates, persist them to disk with correct directory layout, read documents back, manage symlinks for current versions, enforce storage quotas, and perform all CRUD operations atomically. This layer is the "database" for the entire pipeline.

## Scope
### In Scope
- TDD Section 3.4: Document Storage Layer (directory structure, naming conventions, file operations, atomicity, storage quotas)
- TDD Section 4.1: Configuration file I/O (reading/writing `config.yaml` from disk)
- TDD Section 4.3: Audit log format and append-only writes
- TDD Section 5.1: Document Storage API contract (`createDocument`, `readDocument`, `readVersion`, `listVersions`, `writeVersion`, `listDocuments`, `deleteDocument`)
- Pipeline directory creation and `pipeline.yaml` initial file structure (TDD Section 3.9.2 -- structure only, not state machine logic)

### Out of Scope
- Versioning logic (version numbering, diffs, regression) -- PLAN-003-3
- Decomposition records and traceability files -- PLAN-003-4
- Pipeline state machine and flow control -- PLAN-003-5
- Backward cascade event storage -- PLAN-003-5
- Review gate scoring (separate TDD)

## Tasks

1. **Implement atomic file write utility** -- Write-then-rename function for crash-safe file writes on POSIX systems. All downstream file operations use this utility.
   - Files to create: `src/pipeline/storage/atomic-io.ts`
   - Acceptance criteria: Implements `atomicWrite(targetPath, content)` per TDD Section 3.4.3. Uses temp file with timestamp suffix, then `rename()`. Implements `atomicSymlink(target, linkPath)` for symlink swap. Both operations are atomic on POSIX. Error handling for permission denied, disk full, and invalid paths.
   - Estimated effort: 3 hours

2. **Implement directory layout manager** -- Creates and manages the directory hierarchy: `.autonomous-dev/pipelines/{PIPE_ID}/documents/{type}/{DOC_ID}/` with `reviews/` and `diffs/` subdirectories, plus `decomposition/` directory.
   - Files to create: `src/pipeline/storage/directory-manager.ts`
   - Acceptance criteria: Creates the full directory tree per TDD Section 3.4.1. Path computation is deterministic given pipeline ID, document type, and document ID. `mkdirp` semantics (create intermediate directories). Naming follows TDD Section 3.4.2 conventions exactly.
   - Estimated effort: 4 hours

3. **Implement pipeline directory initialization** -- Creates a new pipeline root directory with `pipeline.yaml` (initial state), `audit.log` (empty), `traceability.yaml` (empty), and the `documents/` and `decomposition/` subdirectories.
   - Files to create: `src/pipeline/storage/pipeline-initializer.ts`
   - Acceptance criteria: Pipeline ID follows `PIPE-{YYYY}-{MMDD}-{SEQ}` format per TDD Section 3.4.2. Initial `pipeline.yaml` contains correct structure per TDD Section 3.9.2 with status "active" and empty document states. Atomic writes for all initial files.
   - Estimated effort: 3 hours

4. **Implement document creation** -- Creates a new document directory, renders the template with initial frontmatter values, writes the initial version file (`v1.0.md`), and creates the `current.md` symlink.
   - Files to create: `src/pipeline/storage/document-creator.ts`
   - Acceptance criteria: Implements `createDocument(request: CreateDocumentRequest): Promise<DocumentHandle>` per TDD Section 5.1. Uses the Template Engine from PLAN-003-1 to render the template. Populates frontmatter fields (id, parent_id, pipeline_id, type, status, version, timestamps, author_agent, traces_from, depth, sibling_index, sibling_count, depends_on, dependency_type, execution_mode, priority). Creates `reviews/` and `diffs/` subdirectories. `current.md` symlink points to `v1.0.md`.
   - Estimated effort: 6 hours

5. **Implement document reading** -- Read the current version (follow symlink) or a specific version. Parse frontmatter and return structured `DocumentContent`.
   - Files to create: `src/pipeline/storage/document-reader.ts`
   - Acceptance criteria: Implements `readDocument(documentId)` and `readVersion(documentId, version)` per TDD Section 5.1. Returns `DocumentContent` with parsed frontmatter, markdown body, and raw content. Throws structured error if document or version not found. Follows `current.md` symlink for current version.
   - Estimated effort: 4 hours

6. **Implement document listing and filtering** -- List all documents in a pipeline with optional filtering by type, status, parent ID, and depth range.
   - Files to create: `src/pipeline/storage/document-lister.ts`
   - Acceptance criteria: Implements `listDocuments(pipelineId, filter?)` per TDD Section 5.1. Returns `DocumentHandle[]` sorted by document ID. Filter supports `type`, `status`, `parentId`, `minDepth`, `maxDepth` per `DocumentFilter` interface. Scans document directories and reads frontmatter from `current.md`.
   - Estimated effort: 4 hours

7. **Implement version file writing** -- Write a new version file to a document directory and update the `current.md` symlink atomically.
   - Files to create: `src/pipeline/storage/version-writer.ts`
   - Acceptance criteria: Implements `writeVersion(request: VersionCreateRequest): Promise<VersionRecord>` per TDD Section 5.1. Creates `v{MAJOR}.{MINOR}.md` file with atomic write. Updates `current.md` symlink atomically. Returns `VersionRecord` with version, reason, timestamp, author, content hash (SHA-256), and file path. Does not handle version numbering logic (that is PLAN-003-3); accepts the version string as input.
   - Estimated effort: 4 hours

8. **Implement version listing** -- List all version files for a document, ordered by version number.
   - Files to create: `src/pipeline/storage/version-lister.ts`
   - Acceptance criteria: Implements `listVersions(documentId): Promise<VersionRecord[]>` per TDD Section 5.1. Parses version filenames matching `v{MAJOR}.{MINOR}.md` pattern. Returns records sorted by version (semantic ordering). Reads metadata from each version's frontmatter.
   - Estimated effort: 3 hours

9. **Implement storage quota enforcement** -- Check and enforce limits on documents per pipeline, versions per document, total pipeline storage, and single document size.
   - Files to create: `src/pipeline/storage/quota-enforcer.ts`
   - Acceptance criteria: Enforces all limits from TDD Section 3.4.4 (max 100 documents/pipeline, max 20 versions/document, max 500 MB total, max 1 MB per document). All limits configurable via `config.yaml`. Returns structured error with specific limit exceeded. Checks run before write operations, not after.
   - Estimated effort: 4 hours

10. **Implement configuration file I/O** -- Read and parse `config.yaml` from the `.autonomous-dev/` root, merge with hardcoded defaults, and provide typed access to all configuration values.
    - Files to create: `src/pipeline/storage/config-loader.ts`
    - Acceptance criteria: Reads `config.yaml` per TDD Section 4.1. Merges with default values (every field has a default so config file is optional). Validates configuration values (e.g., max_depth must be 4, thresholds must be in range). Returns typed `PipelineConfig` object using types from PLAN-003-1 Task 12. Config file is optional (all defaults work).
    - Estimated effort: 3 hours

11. **Implement audit log writer** -- Append-only, newline-delimited JSON log writer with hash chain for integrity.
    - Files to create: `src/pipeline/storage/audit-logger.ts`
    - Acceptance criteria: Appends `PipelineEvent` objects as JSONL per TDD Section 4.3. Each entry includes hash of previous entry for tamper detection per TDD Section 7.1. File is opened in append mode only. Provides `appendEvent(event)` and `readEvents(pipelineId): PipelineEvent[]` methods. Hash chain verified on read.
    - Estimated effort: 4 hours

12. **Implement document deletion (admin)** -- Remove a document directory and all its contents. Admin-only operation, not used in normal pipeline flow.
    - Files to create: `src/pipeline/storage/document-deleter.ts`
    - Acceptance criteria: Implements `deleteDocument(documentId)` per TDD Section 5.1. Removes the entire document directory. Logs deletion as audit event. Does not cascade (caller is responsible for traceability updates).
    - Estimated effort: 2 hours

13. **Assemble DocumentStorageAPI facade** -- Wire all individual components into the unified `DocumentStorageAPI` interface.
    - Files to create: `src/pipeline/storage/document-storage.ts`
    - Acceptance criteria: Implements all methods of `DocumentStorageAPI` from TDD Section 5.1. Delegates to individual components. Enforces quotas before writes. Logs all mutations to audit log. Single entry point for all storage operations.
    - Estimated effort: 3 hours

## Dependencies & Integration Points
- **PLAN-003-1**: Uses `DocumentType` enum, frontmatter types, Template Engine API (`renderTemplate`), ID generator, and configuration schema types.
- **PLAN-003-3** (Versioning Engine): Consumes `writeVersion`, `listVersions`, and `readVersion` from this plan. The version writer here is a "dumb" file writer; versioning logic (numbering, diffs, regression) lives in PLAN-003-3.
- **PLAN-003-4** (Decomposition/Traceability): Stores decomposition records in the `decomposition/` directory and the traceability matrix as `traceability.yaml`. Those subsystems call back into storage for reads and writes.
- **PLAN-003-5** (Pipeline Flow Controller): Reads and writes `pipeline.yaml` through the storage layer.

## Testing Strategy
- **Unit tests** for every component:
  - Atomic I/O: concurrent writes don't corrupt files; rename failure is handled.
  - Directory manager: correct paths for all combinations of pipeline/type/document IDs.
  - Document creator: creates correct directory structure, symlink points to v1.0.md, frontmatter populated correctly.
  - Document reader: reads current via symlink, reads specific version, handles missing document/version.
  - Quota enforcer: rejects writes above each limit; accepts writes below limits; uses configured values, not hardcoded.
  - Audit logger: append-only semantics, hash chain verification, JSONL format.
- **Integration tests**:
  - Create pipeline -> create document -> write version -> read back -> verify content matches.
  - Create 101 documents -> verify quota rejection on the 101st.
  - Write version -> update symlink -> read current -> verify new content.
- **Filesystem edge case tests**:
  - Path with special characters in pipeline ID.
  - Symlink pointing to missing target (version file deleted externally).
  - `config.yaml` missing or malformed (falls back to defaults).
- Coverage target: 90% for storage layer per TDD Section 8.1.

## Risks
1. **Symlink portability** -- Symlinks behave differently on different filesystems. Mitigation: TDD Section 9.5 restricts target platforms to macOS and Linux. Add a startup check that validates symlink support.
2. **Concurrent access** -- Multiple agents writing to the same pipeline directory simultaneously. Mitigation: Atomic write-then-rename prevents partial writes. Lock files are not used in MVP; concurrent document creation within the same pipeline is safe because each document has its own directory. Concurrent writes to `pipeline.yaml` require the flow controller to serialize (PLAN-003-5 concern).
3. **Disk space exhaustion** -- Quota enforcement relies on checking before writes, but disk can fill between check and write. Mitigation: The atomic write catches disk-full errors and cleans up the temp file. Quota is a best-effort safeguard, not a guarantee.

## Definition of Done
- [ ] Pipeline directories created with correct structure per TDD Section 3.4.1
- [ ] Documents created from templates with correct frontmatter and symlinks
- [ ] All CRUD operations work: create, read (current and specific version), list (with filters), delete
- [ ] Atomic writes prevent file corruption on POSIX
- [ ] Symlink swap is atomic for `current.md` updates
- [ ] Storage quotas enforced before writes with structured error responses
- [ ] Configuration loaded from `config.yaml` with defaults for all missing values
- [ ] Audit log writes in JSONL format with hash chain integrity
- [ ] `DocumentStorageAPI` facade exposes all methods from TDD Section 5.1
- [ ] Unit and integration tests pass with >= 90% coverage
- [ ] No hardcoded file paths; all paths computed from configuration and conventions
