# PLAN-003-3: Versioning Engine

## Metadata
- **Parent TDD**: TDD-003-document-pipeline
- **Estimated effort**: 5 days
- **Dependencies**: [PLAN-003-1 (types, frontmatter), PLAN-003-2 (storage layer)]
- **Blocked by**: [PLAN-003-2]
- **Priority**: P0

## Objective
Deliver the document revision management subsystem: version numbering (major/minor), structured section-level diffs, quality regression detection, and rollback. After this plan, the system can track the full revision history of any document, compute meaningful diffs between versions, detect when a revision makes a document worse, and safely roll back to a prior version without losing audit trail.

## Scope
### In Scope
- TDD Section 3.5: Versioning Engine (version numbering, version creation, structured diff, quality regression detection)
- TDD Section 4.2: Review feedback schema (the versioning engine stores review files alongside versions)
- TDD Section 5.3: Versioning Engine API contract (`createVersion`, `computeDiff`, `checkRegression`, `rollback`, `getHistory`)
- Review feedback file I/O (writing `v{VERSION}-review-{SEQ}.yaml` files)
- Diff file I/O (writing `v{FROM}-to-v{TO}.diff` files)

### Out of Scope
- Review gate scoring logic and reviewer agent orchestration (separate TDD)
- Decomposition and traceability (PLAN-003-4)
- Backward cascade version bumping logic (PLAN-003-5 consumes versioning API)
- Pipeline state machine transitions (PLAN-003-5)
- Template validation (PLAN-003-1, already delivered)

## Tasks

1. **Implement version number calculator** -- Determine the next version number given the current version and the reason for the new version. Minor increment for review revisions and template updates; major increment for backward cascades and fundamental restructures. Rollbacks create a new version number (not reuse).
   - Files to create: `src/pipeline/versioning/version-calculator.ts`
   - Acceptance criteria: Minor increment: `1.0 -> 1.1 -> 1.2`. Major increment: `1.3 -> 2.0`. Rollback from `1.2` to `1.0` produces `1.3` (new version, old content) per TDD Section 3.5.1. Version strings match `^\d+\.\d+$` pattern. Never reuses a version number.
   - Estimated effort: 3 hours

2. **Implement version creation orchestrator** -- Coordinates version creation: computes next version number, calls storage layer to write the version file, updates symlink, produces `VersionRecord`, and logs the event.
   - Files to create: `src/pipeline/versioning/version-creator.ts`
   - Acceptance criteria: Implements `createVersion(request: VersionCreateRequest): Promise<VersionRecord>` per TDD Section 5.3. Accepts `reason` enum: INITIAL, REVIEW_REVISION, BACKWARD_CASCADE, ROLLBACK. Computes content hash (SHA-256). Delegates file I/O to storage layer (PLAN-003-2). Returns complete `VersionRecord` per TDD Section 3.5.2.
   - Estimated effort: 4 hours

3. **Implement Markdown section parser** -- Parse a Markdown document into structured sections based on headings. This is the foundation for section-level diffs. Handles nested headings (##, ###, ####) and separates frontmatter from body.
   - Files to create: `src/pipeline/versioning/section-parser.ts`
   - Acceptance criteria: Parses Markdown into a list of sections with: heading text, heading level, section ID (derived from heading), content, word count. Handles nested subsections. Handles documents with or without frontmatter. Preserves raw content for each section.
   - Estimated effort: 4 hours

4. **Implement structured diff engine** -- Compute section-level diffs between two versions of a document. Compare sections by ID, detect added/removed/modified/unchanged sections, compute word count deltas, and track frontmatter changes.
   - Files to create: `src/pipeline/versioning/diff-engine.ts`
   - Acceptance criteria: Produces `VersionDiff` per TDD Section 3.5.3 with: per-section `SectionDiff` (changeType, old/new content, word count delta), frontmatter changes (field-level old/new values), and summary (sections added/removed/modified/unchanged, total word count delta). Handles identical versions (all sections unchanged). Handles completely rewritten documents.
   - Estimated effort: 6 hours

5. **Implement diff file writer** -- Serialize `VersionDiff` to YAML and write to the `diffs/` subdirectory of the document.
   - Files to create: `src/pipeline/versioning/diff-writer.ts`
   - Acceptance criteria: Writes diff file as `v{FROM}-to-v{TO}.diff` in the document's `diffs/` directory per TDD Section 3.4.2. Uses atomic write from storage layer. YAML format is human-readable. Reads back and deserializes correctly.
   - Estimated effort: 2 hours

6. **Implement quality regression detector** -- Compare the new aggregate review score against the previous version's score. Flag regression if the score drops by more than the configured regression margin.
   - Files to create: `src/pipeline/versioning/regression-detector.ts`
   - Acceptance criteria: Implements `checkRegression(documentId, newScore): Promise<RegressionCheckResult>` per TDD Section 3.5.4. Returns `isRegression: true` when `scoreDelta < -regressionMargin`. `regressionMargin` read from configuration (default: 5). Returns recommendation: "proceed" or "rollback_suggested". Handles first review (no previous score) as non-regression.
   - Estimated effort: 3 hours

7. **Implement rollback executor** -- Create a new version with the content of a specified target version. The rollback version gets a new version number (not the old one) to preserve the audit trail.
   - Files to create: `src/pipeline/versioning/rollback-executor.ts`
   - Acceptance criteria: Implements `rollback(documentId, targetVersion): Promise<VersionRecord>` per TDD Section 5.3. Reads content of `targetVersion`, creates a new version with reason `ROLLBACK` and `sourceVersion` set to the target. New version number follows minor increment from current. Content hash of rollback version matches content hash of target version. Audit event logged.
   - Estimated effort: 3 hours

8. **Implement review feedback file writer/reader** -- Write and read review feedback YAML files in the `reviews/` subdirectory of a document.
   - Files to create: `src/pipeline/versioning/review-feedback-io.ts`
   - Acceptance criteria: Writes review files as `v{VERSION}-review-{SEQ}.yaml` per TDD Section 3.4.2. Schema matches TDD Section 4.2 (review_id, document_id, document_version, reviewer_agent, review_iteration, timestamp, outcome, scores, aggregate_score, approval_threshold, findings with severity/section/description/suggested_resolution, optional upstream_defect). Reads back and deserializes correctly. Sequential numbering for multiple reviews of the same version.
   - Estimated effort: 4 hours

9. **Implement version history retrieval** -- Return the complete version history for a document: all `VersionRecord`s in chronological order, optionally including diffs and review summaries.
   - Files to create: `src/pipeline/versioning/history-retriever.ts`
   - Acceptance criteria: Implements `getHistory(documentId): Promise<VersionRecord[]>` per TDD Section 5.3. Returns all versions sorted chronologically. Each record includes version, reason, source version (for rollbacks), timestamp, author, content hash, and file path.
   - Estimated effort: 3 hours

10. **Assemble VersioningEngineAPI facade** -- Wire all versioning components into the unified `VersioningEngineAPI` interface.
    - Files to create: `src/pipeline/versioning/versioning-engine.ts`
    - Acceptance criteria: Implements all methods of `VersioningEngineAPI` from TDD Section 5.3 (`createVersion`, `computeDiff`, `checkRegression`, `rollback`, `getHistory`). Delegates to individual components. Generates diff automatically on version creation (unless it is the initial version). Logs all operations to audit log.
    - Estimated effort: 4 hours

## Dependencies & Integration Points
- **PLAN-003-1**: Uses `DocumentType`, frontmatter types, and `VersionReason` enum.
- **PLAN-003-2**: Uses storage layer for all file I/O (atomic writes, version file writing, symlink updates, audit logging). Version creation calls `writeVersion` on the storage layer.
- **PLAN-003-5** (Pipeline Flow Controller): The flow controller calls `createVersion` when documents are revised and `checkRegression` after reviews. Backward cascades (PLAN-003-5) call `createVersion` with reason `BACKWARD_CASCADE` for major version bumps.
- **Review Gate Engine** (separate TDD): Writes review feedback files via Task 8 of this plan. The review gate calls `checkRegression` to detect quality regression.

## Testing Strategy
- **Unit tests** for every component:
  - Version calculator: minor/major increment logic, rollback version numbering, edge cases (version 9.9 -> 9.10 not 10.0 for minor).
  - Section parser: all five document templates, nested headings, empty sections, documents with no headings.
  - Diff engine: identical versions, completely rewritten versions, single section change, frontmatter-only change, section added, section removed.
  - Regression detector: score above threshold (non-regression), score below threshold (regression), exact margin (non-regression), first review (no regression), zero previous score.
  - Rollback executor: rollback creates new version, content hash matches target, audit trail preserved.
  - Target: 100% coverage for version numbering and regression detection per TDD Section 8.1; 90% for diff engine.
- **Integration tests**:
  - Create document -> create v1.0 -> create v1.1 (review revision) -> compute diff -> verify section-level changes.
  - Create v1.0 -> review (score 90) -> create v1.1 -> review (score 83) -> detect regression -> rollback to v1.0 -> verify v1.2 content matches v1.0.
  - Write review feedback -> read back -> verify all fields preserved.
- **Snapshot tests**: Diff output for known document pairs to detect format regressions.

## Risks
1. **Section parsing ambiguity** -- Markdown heading detection may fail on edge cases (headings inside code blocks, ATX vs. Setext headings, headings with inline code). Mitigation: Only support ATX-style headings (# prefix) which is what all templates use. Skip headings inside fenced code blocks.
2. **SHA-256 content hash sensitivity** -- Trailing whitespace, BOM characters, or line ending differences could cause hash mismatches between "identical" content. Mitigation: Normalize content before hashing (trim trailing whitespace, normalize line endings to `\n`, strip BOM).
3. **Version number overflow** -- Extremely long revision cycles could produce large version numbers. Mitigation: The 20-version limit per document (enforced by storage quotas) prevents this in practice.

## Definition of Done
- [ ] Version numbering correctly computes minor and major increments
- [ ] Rollback creates a new version with old content and preserves audit trail
- [ ] Structured diff computes section-level changes with correct change types
- [ ] Diff files written to `diffs/` directory in YAML format
- [ ] Quality regression detected when score drops exceed configured margin
- [ ] Review feedback files written and read in correct schema
- [ ] Version history returns all versions in chronological order
- [ ] `VersioningEngineAPI` facade exposes all methods from TDD Section 5.3
- [ ] Unit tests pass with >= 100% coverage for version numbering and regression, >= 90% for diff engine
- [ ] Integration test: full revision lifecycle (create, revise, diff, regress, rollback) passes end-to-end
