# SPEC-003-3-03: Diff File Writer, Quality Regression Detector, and Rollback Executor

## Metadata
- **Parent Plan**: PLAN-003-3
- **Tasks Covered**: Task 5, Task 6, Task 7
- **Estimated effort**: 8 hours

## Description
Implement the diff file writer that serializes `VersionDiff` to YAML in the document's `diffs/` directory, the quality regression detector that flags score drops exceeding the configured margin, and the rollback executor that creates a new version with the content of a previous version (preserving audit trail with a new version number).

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/versioning/diff-writer.ts` | Create |
| `src/pipeline/versioning/regression-detector.ts` | Create |
| `src/pipeline/versioning/rollback-executor.ts` | Create |

## Implementation Details

### Task 5: `src/pipeline/versioning/diff-writer.ts`

```typescript
import yaml from 'js-yaml';
import * as path from 'path';
import { VersionDiff } from './diff-engine';
import { DirectoryManager } from '../storage/directory-manager';
import { atomicWrite } from '../storage/atomic-io';
import { DocumentType } from '../types/document-type';

/**
 * Writes a VersionDiff to the document's diffs/ directory as YAML.
 *
 * File naming: v{FROM}-to-v{TO}.diff
 * Example: v1.0-to-v1.1.diff
 *
 * @param diff The computed VersionDiff
 * @param pipelineId Pipeline ID
 * @param type Document type
 * @param documentId Document ID
 * @param directoryManager Directory manager for path computation
 * @returns Absolute path to the written diff file
 */
export async function writeDiff(
  diff: VersionDiff,
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
): Promise<string> {
  const diffsDir = directoryManager.getDiffsDir(pipelineId, type, documentId);
  const filename = `v${diff.fromVersion}-to-v${diff.toVersion}.diff`;
  const filePath = path.join(diffsDir, filename);

  const yamlContent = yaml.dump(diff, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  await atomicWrite(filePath, yamlContent);
  return filePath;
}

/**
 * Reads and deserializes a diff file.
 *
 * @param pipelineId Pipeline ID
 * @param type Document type
 * @param documentId Document ID
 * @param fromVersion The "from" version
 * @param toVersion The "to" version
 * @param directoryManager Directory manager for path computation
 * @returns The deserialized VersionDiff
 */
export async function readDiff(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  fromVersion: string,
  toVersion: string,
  directoryManager: DirectoryManager,
): Promise<VersionDiff> {
  const diffsDir = directoryManager.getDiffsDir(pipelineId, type, documentId);
  const filename = `v${fromVersion}-to-v${toVersion}.diff`;
  const filePath = path.join(diffsDir, filename);
  const content = await import('fs/promises').then(fs => fs.readFile(filePath, 'utf-8'));
  return yaml.load(content) as VersionDiff;
}
```

### Task 6: `src/pipeline/versioning/regression-detector.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { PipelineConfig } from '../types/config';

export interface RegressionCheckResult {
  /** Whether this is a regression */
  isRegression: boolean;
  /** New score */
  newScore: number;
  /** Previous score (null if first review) */
  previousScore: number | null;
  /** Score delta (newScore - previousScore), null if first review */
  scoreDelta: number | null;
  /** Configured regression margin */
  regressionMargin: number;
  /** Recommendation: "proceed" or "rollback_suggested" */
  recommendation: 'proceed' | 'rollback_suggested';
}

/**
 * Checks whether a new review score represents a quality regression.
 *
 * Rules (TDD Section 3.5.4):
 *   - If no previous score (first review): NOT a regression.
 *   - If scoreDelta < -regressionMargin: IS a regression.
 *   - If scoreDelta >= -regressionMargin: NOT a regression.
 *   - regressionMargin defaults to 5, configurable via config.yaml.
 *
 * Examples (with margin=5):
 *   previousScore=90, newScore=87: delta=-3, NOT regression
 *   previousScore=90, newScore=85: delta=-5, NOT regression (exact margin)
 *   previousScore=90, newScore=84: delta=-6, IS regression
 *   previousScore=null, newScore=70: first review, NOT regression
 *
 * @param newScore The new aggregate review score (0-100)
 * @param previousScore The previous version's aggregate score (null if first review)
 * @param config Pipeline configuration (for regressionMargin)
 * @param type Document type (for per-type margin override)
 */
export function checkRegression(
  newScore: number,
  previousScore: number | null,
  config: PipelineConfig,
  type: DocumentType,
): RegressionCheckResult {
  // Get margin: per-type override or default
  const typeOverrides = config.reviewGates.overrides[type];
  const margin = typeOverrides?.regressionMargin
    ?? config.reviewGates.defaults.regressionMargin;

  // First review: never a regression
  if (previousScore === null) {
    return {
      isRegression: false,
      newScore,
      previousScore: null,
      scoreDelta: null,
      regressionMargin: margin,
      recommendation: 'proceed',
    };
  }

  const scoreDelta = newScore - previousScore;
  const isRegression = scoreDelta < -margin;

  return {
    isRegression,
    newScore,
    previousScore,
    scoreDelta,
    regressionMargin: margin,
    recommendation: isRegression ? 'rollback_suggested' : 'proceed',
  };
}
```

### Task 7: `src/pipeline/versioning/rollback-executor.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { VersionRecord } from '../storage/version-writer';
import { createVersion, VersionCreateRequest } from './version-creator';

/**
 * Creates a new version with the content of a specified target version.
 *
 * The rollback version gets a NEW version number (not the old one)
 * to preserve the audit trail.
 *
 * Example:
 *   Current version: 1.2
 *   Rollback target: 1.0
 *   New version: 1.3 (minor increment from current)
 *   Content of 1.3 = content of 1.0
 *   Content hash of 1.3 = content hash of 1.0
 *
 * Steps:
 *   1. Read content of the target version
 *   2. Call createVersion with reason ROLLBACK and sourceVersion
 *   3. The version creator handles version numbering (minor increment)
 *   4. Return the VersionRecord
 *
 * @param pipelineId Pipeline ID
 * @param type Document type
 * @param documentId Document ID
 * @param targetVersion The version to roll back to (e.g. "1.0")
 * @param authorAgent Agent performing the rollback
 * @param storage Document storage layer
 * @returns VersionRecord for the newly created rollback version
 */
export async function rollback(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  targetVersion: string,
  authorAgent: string,
  storage: DocumentStorage,
): Promise<VersionRecord> {
  // 1. Read target version content
  const targetContent = await storage.readVersion(
    pipelineId, type, documentId, targetVersion,
  );

  // 2. Create new version with ROLLBACK reason
  const request: VersionCreateRequest = {
    pipelineId,
    type,
    documentId,
    content: targetContent.rawContent,
    reason: 'ROLLBACK',
    authorAgent,
    sourceVersion: targetVersion,
  };

  const record = await createVersion(request, storage);

  // 3. Verify content hash matches target
  // (The content is the same, so hashes should match after normalization)

  return record;
}
```

## Acceptance Criteria
1. `writeDiff` writes a YAML file named `v{FROM}-to-v{TO}.diff` in the document's `diffs/` directory.
2. `writeDiff` uses atomic write for crash safety.
3. `readDiff` reads back the diff file and deserializes to the same `VersionDiff` structure.
4. YAML output is human-readable (line width 120, no refs).
5. `checkRegression` returns `isRegression: false` for first review (no previous score).
6. `checkRegression` returns `isRegression: true` when `scoreDelta < -regressionMargin`.
7. `checkRegression` returns `isRegression: false` when `scoreDelta === -regressionMargin` (exact margin is NOT a regression).
8. `checkRegression` uses per-type margin override when available.
9. `checkRegression` returns `recommendation: 'rollback_suggested'` for regressions.
10. `rollback` reads the target version content and creates a new version with reason `ROLLBACK`.
11. `rollback` sets `sourceVersion` in the returned record to the target version.
12. The content hash of the rollback version matches the content hash of the target version.

## Test Cases

### Unit Tests: `tests/pipeline/versioning/diff-writer.test.ts`
- `writeDiff creates file at correct path`
- `writeDiff filename format: v1.0-to-v1.1.diff`
- `readDiff deserializes back to original VersionDiff`
- `round-trip: writeDiff -> readDiff preserves all fields`
- `writeDiff uses atomic write`

### Unit Tests: `tests/pipeline/versioning/regression-detector.test.ts`
- `first review (previousScore null): not regression, recommendation proceed`
- `score improved: not regression (90 -> 95, delta=+5)`
- `score same: not regression (90 -> 90, delta=0)`
- `score dropped within margin: not regression (90 -> 86, delta=-4, margin=5)`
- `score dropped at exact margin: not regression (90 -> 85, delta=-5, margin=5)`
- `score dropped beyond margin: IS regression (90 -> 84, delta=-6, margin=5)`
- `regression returns rollback_suggested recommendation`
- `uses per-type margin override when available`
- `uses default margin when no per-type override`
- `zero previous score: score increase is not regression`
- `handles perfect score (100) correctly`

### Unit Tests: `tests/pipeline/versioning/rollback-executor.test.ts`
- `rollback reads target version content`
- `rollback creates new version with ROLLBACK reason`
- `rollback version number is minor increment from current (not target)`
- `rollback content matches target content`
- `rollback sets sourceVersion to target version string`
- `rollback logs audit event`

### Integration Test: `tests/pipeline/versioning/rollback.integration.test.ts`
- `create v1.0 -> create v1.1 -> rollback to v1.0 -> v1.2 has v1.0 content`
- `content hash of v1.2 matches content hash of v1.0`
- `version history shows: v1.0, v1.1, v1.2`
