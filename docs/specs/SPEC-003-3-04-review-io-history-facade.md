# SPEC-003-3-04: Review Feedback I/O, Version History Retrieval, and Versioning Engine Facade

## Metadata
- **Parent Plan**: PLAN-003-3
- **Tasks Covered**: Task 8, Task 9, Task 10
- **Estimated effort**: 11 hours

## Description
Implement the review feedback file writer/reader (YAML files in the `reviews/` directory following TDD Section 4.2 schema), the version history retrieval function (returns all `VersionRecord`s in chronological order), and the `VersioningEngineAPI` facade that wires all versioning components into a unified interface with automatic diff generation on version creation.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/versioning/review-feedback-io.ts` | Create |
| `src/pipeline/versioning/history-retriever.ts` | Create |
| `src/pipeline/versioning/versioning-engine.ts` | Create |
| `src/pipeline/versioning/index.ts` | Create (barrel) |

## Implementation Details

### Task 8: `src/pipeline/versioning/review-feedback-io.ts`

```typescript
import yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentType } from '../types/document-type';
import { DirectoryManager } from '../storage/directory-manager';
import { atomicWrite } from '../storage/atomic-io';

/**
 * Review feedback schema per TDD Section 4.2.
 */
export interface ReviewFinding {
  /** Finding severity: critical, major, minor, suggestion */
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  /** Section ID in the document this finding relates to */
  section: string;
  /** Description of the issue */
  description: string;
  /** Suggested resolution */
  suggestedResolution: string;
}

export interface ReviewFeedback {
  /** Unique review ID */
  reviewId: string;
  /** Document being reviewed */
  documentId: string;
  /** Version of the document being reviewed */
  documentVersion: string;
  /** Agent that performed the review */
  reviewerAgent: string;
  /** Which iteration of review (1-based) */
  reviewIteration: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Review outcome: approved, changes_requested, rejected */
  outcome: 'approved' | 'changes_requested' | 'rejected';
  /** Per-category scores (categoryId -> score 0-100) */
  scores: Record<string, number>;
  /** Weighted aggregate score */
  aggregateScore: number;
  /** Threshold that was used for this review */
  approvalThreshold: number;
  /** List of findings */
  findings: ReviewFinding[];
  /** Optional: if this review found an upstream defect */
  upstreamDefect?: {
    /** Target document that has the defect */
    targetDocumentId: string;
    /** Affected sections in the target document */
    affectedSections: string[];
    /** Description of the defect */
    description: string;
  };
}

/**
 * Writes a review feedback file to the document's reviews/ directory.
 *
 * File naming: v{VERSION}-review-{SEQ}.yaml
 * SEQ is 3-digit zero-padded, incrementing for each review of the same version.
 *
 * @returns Absolute path to the written review file
 */
export async function writeReviewFeedback(
  feedback: ReviewFeedback,
  pipelineId: string,
  type: DocumentType,
  directoryManager: DirectoryManager,
): Promise<string> {
  const reviewsDir = directoryManager.getReviewsDir(
    pipelineId, type, feedback.documentId,
  );

  // Determine sequence number by counting existing reviews for this version
  const existingFiles = await fs.readdir(reviewsDir).catch(() => []);
  const prefix = `v${feedback.documentVersion}-review-`;
  const existingForVersion = existingFiles.filter(f => f.startsWith(prefix));
  const seq = existingForVersion.length + 1;
  const seqStr = String(seq).padStart(3, '0');

  const filename = `v${feedback.documentVersion}-review-${seqStr}.yaml`;
  const filePath = path.join(reviewsDir, filename);

  const yamlContent = yaml.dump(feedback, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  await atomicWrite(filePath, yamlContent);
  return filePath;
}

/**
 * Reads all review feedback files for a document, optionally filtered by version.
 *
 * @returns Array of ReviewFeedback sorted by timestamp
 */
export async function readReviewFeedback(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
  version?: string,
): Promise<ReviewFeedback[]> {
  const reviewsDir = directoryManager.getReviewsDir(pipelineId, type, documentId);

  let files: string[];
  try {
    files = await fs.readdir(reviewsDir);
  } catch {
    return [];
  }

  // Filter by version if specified
  const pattern = version
    ? new RegExp(`^v${version.replace('.', '\\.')}-review-\\d{3}\\.yaml$`)
    : /^v[\d.]+-review-\d{3}\.yaml$/;

  const reviewFiles = files.filter(f => pattern.test(f)).sort();
  const reviews: ReviewFeedback[] = [];

  for (const file of reviewFiles) {
    const content = await fs.readFile(path.join(reviewsDir, file), 'utf-8');
    reviews.push(yaml.load(content) as ReviewFeedback);
  }

  return reviews.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Returns the latest aggregate score for a document (from the most recent review).
 * Returns null if no reviews exist.
 */
export async function getLatestScore(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
): Promise<number | null> {
  const reviews = await readReviewFeedback(pipelineId, type, documentId, directoryManager);
  if (reviews.length === 0) return null;
  return reviews[reviews.length - 1].aggregateScore;
}
```

### Task 9: `src/pipeline/versioning/history-retriever.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { VersionRecord } from '../storage/version-writer';

/**
 * Retrieves the complete version history for a document.
 *
 * Returns all VersionRecords in chronological order (sorted by version number).
 * Each record includes: version, reason, sourceVersion (for rollbacks),
 * timestamp, author, contentHash, and filePath.
 *
 * This is a thin wrapper around storage.listVersions that ensures
 * consistent behavior and can be extended later with review summaries.
 *
 * @param pipelineId Pipeline ID
 * @param type Document type
 * @param documentId Document ID
 * @param storage Document storage layer
 * @returns Array of VersionRecords sorted chronologically
 */
export async function getHistory(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  storage: DocumentStorage,
): Promise<VersionRecord[]> {
  return storage.listVersions(pipelineId, type, documentId);
}
```

### Task 10: `src/pipeline/versioning/versioning-engine.ts`

```typescript
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
```

### Barrel: `src/pipeline/versioning/index.ts`

```typescript
export { VersioningEngine } from './versioning-engine';
export { calculateNextVersion, parseVersion, formatVersion } from './version-calculator';
export { createVersion, type VersionCreateRequest } from './version-creator';
export { computeDiff, type VersionDiff, type SectionDiff, type DiffSummary } from './diff-engine';
export { parseSections, toSectionId, countWords, type ParsedSection, type DocumentSections } from './section-parser';
export { writeDiff, readDiff } from './diff-writer';
export { checkRegression, type RegressionCheckResult } from './regression-detector';
export { rollback } from './rollback-executor';
export { getHistory } from './history-retriever';
export {
  writeReviewFeedback,
  readReviewFeedback,
  getLatestScore,
  type ReviewFeedback,
  type ReviewFinding,
} from './review-feedback-io';
```

## Acceptance Criteria
1. `writeReviewFeedback` writes a YAML file named `v{VERSION}-review-{SEQ}.yaml` in the document's `reviews/` directory.
2. Sequential numbering: first review of v1.0 is `v1.0-review-001.yaml`, second is `v1.0-review-002.yaml`.
3. `ReviewFeedback` schema includes all fields from TDD Section 4.2: reviewId, documentId, documentVersion, reviewerAgent, reviewIteration, timestamp, outcome, scores, aggregateScore, approvalThreshold, findings, optional upstreamDefect.
4. `readReviewFeedback` reads all review files and returns them sorted by timestamp.
5. `readReviewFeedback` supports optional version filter.
6. `getLatestScore` returns the aggregate score from the most recent review, or null if none.
7. `getHistory` returns all version records sorted chronologically.
8. `VersioningEngine` facade exposes all 5 methods: `createVersion`, `computeDiff`, `checkRegression`, `rollback`, `getHistory`.
9. `VersioningEngine.createVersion` automatically computes and writes a diff for non-INITIAL versions.
10. `VersioningEngine.checkRegression` reads the latest score from review files before comparing.
11. All operations are logged to the audit log via the storage layer.

## Test Cases

### Unit Tests: `tests/pipeline/versioning/review-feedback-io.test.ts`
- `writeReviewFeedback creates file at correct path`
- `writeReviewFeedback filename: v1.0-review-001.yaml for first review`
- `writeReviewFeedback increments sequence for second review of same version`
- `writeReviewFeedback for different version starts at 001`
- `readReviewFeedback returns all reviews sorted by timestamp`
- `readReviewFeedback with version filter returns only matching reviews`
- `readReviewFeedback returns empty array when no reviews exist`
- `round-trip: write -> read preserves all fields`
- `review schema includes findings with severity/section/description/suggestedResolution`
- `review schema includes optional upstreamDefect`
- `getLatestScore returns aggregate score from most recent review`
- `getLatestScore returns null when no reviews exist`

### Unit Tests: `tests/pipeline/versioning/history-retriever.test.ts`
- `getHistory returns all versions sorted chronologically`
- `getHistory returns empty array for document with no versions`
- `getHistory includes version, reason, timestamp, author, contentHash, filePath`

### Unit Tests: `tests/pipeline/versioning/versioning-engine.test.ts`
- `createVersion delegates to version-creator`
- `createVersion auto-generates diff for REVIEW_REVISION`
- `createVersion does NOT generate diff for INITIAL`
- `createVersion writes diff file to diffs/ directory`
- `computeDiff reads both versions from storage and computes diff`
- `checkRegression reads latest score from review files`
- `checkRegression delegates to regression-detector`
- `rollback delegates to rollback-executor`
- `getHistory delegates to history-retriever`

### Integration Test: `tests/pipeline/versioning/full-versioning.integration.test.ts`
- `create v1.0 -> create v1.1 -> diff file exists at v1.0-to-v1.1.diff`
- `create v1.0 -> review (score 90) -> create v1.1 -> review (score 83) -> regression detected`
- `create v1.0 -> create v1.1 -> rollback to v1.0 -> v1.2 exists with v1.0 content`
- `write 2 review feedbacks -> readReviewFeedback returns both sorted`
- `getHistory after 3 versions returns [v1.0, v1.1, v1.2]`
