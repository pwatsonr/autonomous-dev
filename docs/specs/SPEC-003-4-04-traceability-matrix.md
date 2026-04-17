# SPEC-003-4-04: Traceability Matrix, Gap/Orphan Detection, Impact Analysis, and Facades

## Metadata
- **Parent Plan**: PLAN-003-4
- **Tasks Covered**: Task 8, Task 9, Task 10, Task 11, Task 12, Task 13, Task 14
- **Estimated effort**: 27 hours

## Description
Implement the full traceability subsystem: trace data models, the traceability matrix regenerator (builds forward chains from document frontmatter), gap detection (identifies requirements with incomplete trace chains), orphan detection (identifies documents tracing to removed parent sections), trace chain retrieval (returns the full forward chain for a requirement), impact analysis (finds all downstream documents affected by section changes), and the API facades for both decomposition and traceability.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/traceability/trace-types.ts` | Create |
| `src/pipeline/traceability/matrix-regenerator.ts` | Create |
| `src/pipeline/traceability/gap-detector.ts` | Create |
| `src/pipeline/traceability/orphan-detector.ts` | Create |
| `src/pipeline/traceability/chain-retriever.ts` | Create |
| `src/pipeline/traceability/impact-analyzer.ts` | Create |
| `src/pipeline/traceability/index.ts` | Create (barrel/facade) |
| `src/pipeline/decomposition/index.ts` | Create (barrel/facade) |

## Implementation Details

### Task 8: `src/pipeline/traceability/trace-types.ts`

```typescript
import { DocumentType } from '../types/document-type';

export type TraceLinkType = 'implements' | 'addresses' | 'tests' | 'derived_from';
export type TraceLinkStatus = 'active' | 'stale' | 'orphaned';
export type GapSeverity = 'critical' | 'warning';

export interface TraceLink {
  /** Source document ID */
  sourceId: string;
  /** Source document type */
  sourceType: DocumentType;
  /** Source section ID (the requirement/section being traced) */
  sourceSectionId: string;
  /** Target document ID */
  targetId: string;
  /** Target document type */
  targetType: DocumentType;
  /** Link type */
  linkType: TraceLinkType;
  /** Link status */
  status: TraceLinkStatus;
}

export interface TraceChainEntry {
  /** Document ID at this level */
  documentId: string;
  /** Document type at this level */
  type: DocumentType;
  /** Section ID being traced at this level */
  sectionId: string;
  /** Status of the document */
  status: string;
}

export interface TraceChain {
  /** The originating requirement (PRD section) */
  requirementId: string;
  /** Entry at each pipeline level: PRD -> TDD -> Plan -> Spec -> Code */
  entries: {
    prd: TraceChainEntry | null;
    tdd: TraceChainEntry | null;
    plan: TraceChainEntry | null;
    spec: TraceChainEntry | null;
    code: TraceChainEntry | null;
  };
  /** Whether the chain is complete (has entries at every level that has been reached) */
  complete: boolean;
  /** Gaps in the chain */
  gaps: TraceGap[];
}

export interface TraceGap {
  /** Requirement/section ID with missing coverage */
  sourceId: string;
  /** Source document type */
  sourceType: DocumentType;
  /** Source section ID */
  sourceSectionId: string;
  /** Pipeline level where coverage is missing */
  missingAtLevel: DocumentType;
  /** Severity: critical if no downstream trace at a reached level */
  severity: GapSeverity;
  /** Human-readable description */
  description: string;
}

export interface TraceabilityMatrix {
  /** All trace links in the pipeline */
  links: TraceLink[];
  /** Forward chains from PRD requirements through to code */
  chains: TraceChain[];
  /** Detected gaps */
  gaps: TraceGap[];
  /** Orphaned document IDs */
  orphans: string[];
  /** ISO 8601 timestamp of last regeneration */
  regeneratedAt: string;
}
```

### Task 9: `src/pipeline/traceability/matrix-regenerator.ts`

```typescript
import yaml from 'js-yaml';
import { DocumentType, PIPELINE_ORDER, getDepth } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { TraceabilityMatrix, TraceLink, TraceChain, TraceGap, TraceChainEntry } from './trace-types';
import { detectGaps } from './gap-detector';
import { detectOrphans } from './orphan-detector';
import { atomicWrite } from '../storage/atomic-io';

/**
 * Regenerates the full traceability matrix from document frontmatter.
 *
 * 5-step process per TDD Section 3.7.2:
 *
 * Step 1: Walk all documents in the pipeline.
 *   For each document, read frontmatter to extract:
 *     - id, type, status, traces_from, traces_to, parent_id
 *
 * Step 2: Build trace links from frontmatter.
 *   For each document with traces_from entries:
 *     Create TraceLink from parent -> this document for each traced section.
 *
 * Step 3: Build forward chains.
 *   Starting from each PRD section, follow traces_to links:
 *   PRD section -> TDD documents (via decomposition records) ->
 *   Plan documents -> Spec documents -> Code documents.
 *   Build a TraceChain for each PRD section.
 *
 * Step 4: Detect gaps (delegate to gap-detector).
 *
 * Step 5: Detect orphans (delegate to orphan-detector).
 *
 * @param pipelineId Pipeline ID
 * @param storage Document storage layer
 * @returns Complete TraceabilityMatrix
 */
export async function regenerate(
  pipelineId: string,
  storage: DocumentStorage,
): Promise<TraceabilityMatrix> {
  // Step 1: Walk all documents
  const allDocs = await storage.listDocuments(pipelineId);
  const docMap = new Map<string, { id: string; type: DocumentType; status: string; tracesFrom: string[]; tracesTo: string[]; parentId: string | null }>();

  for (const doc of allDocs) {
    const fullDoc = await storage.readDocument(pipelineId, doc.type, doc.documentId);
    docMap.set(doc.documentId, {
      id: doc.documentId,
      type: doc.type,
      status: fullDoc.frontmatter.status ?? 'draft',
      tracesFrom: (fullDoc.frontmatter.traces_from as string[]) ?? [],
      tracesTo: (fullDoc.frontmatter.traces_to as string[]) ?? [],
      parentId: fullDoc.frontmatter.parent_id ?? null,
    });
  }

  // Step 2: Build trace links
  const links: TraceLink[] = [];
  for (const [docId, doc] of docMap) {
    if (doc.parentId && doc.tracesFrom.length > 0) {
      const parent = docMap.get(doc.parentId);
      if (parent) {
        for (const sectionId of doc.tracesFrom) {
          links.push({
            sourceId: doc.parentId,
            sourceType: parent.type,
            sourceSectionId: sectionId,
            targetId: docId,
            targetType: doc.type,
            linkType: 'implements',
            status: 'active',
          });
        }
      }
    }
  }

  // Step 3: Build forward chains from PRD sections
  const prdDocs = allDocs.filter(d => d.type === DocumentType.PRD);
  const chains: TraceChain[] = [];

  for (const prdDoc of prdDocs) {
    const prdFull = await storage.readDocument(pipelineId, DocumentType.PRD, prdDoc.documentId);
    // Parse PRD sections to get all section IDs
    const { parseSections } = await import('../versioning/section-parser');
    const sections = parseSections(prdFull.rawContent);

    for (const section of flattenSectionsList(sections.sections)) {
      const chain = buildForwardChain(
        prdDoc.documentId,
        section.id,
        docMap,
        links,
      );
      chains.push(chain);
    }
  }

  // Step 4: Detect gaps
  const gaps = await detectGaps(pipelineId, storage, chains, docMap);

  // Step 5: Detect orphans
  const orphans = await detectOrphans(pipelineId, storage);

  const matrix: TraceabilityMatrix = {
    links,
    chains,
    gaps,
    orphans,
    regeneratedAt: new Date().toISOString(),
  };

  // Write traceability.yaml
  const traceabilityPath = storage.getDirectoryManager().getTraceabilityPath(pipelineId);
  await atomicWrite(traceabilityPath, yaml.dump(matrix, { lineWidth: 120, noRefs: true }));

  return matrix;
}

/**
 * Builds a forward trace chain starting from a PRD section.
 */
function buildForwardChain(
  prdId: string,
  sectionId: string,
  docMap: Map<string, any>,
  links: TraceLink[],
): TraceChain {
  // Find documents at each level that trace to this section
  // PRD -> TDD -> PLAN -> SPEC -> CODE
  // ... follow links transitively
  return {
    requirementId: `${prdId}:${sectionId}`,
    entries: { prd: null, tdd: null, plan: null, spec: null, code: null },
    complete: false,
    gaps: [],
  }; // placeholder
}

function flattenSectionsList(sections: any[]): any[] {
  const result: any[] = [];
  for (const s of sections) {
    result.push(s);
    if (s.subsections) result.push(...flattenSectionsList(s.subsections));
  }
  return result;
}
```

### Task 10: `src/pipeline/traceability/gap-detector.ts`

```typescript
import { DocumentType, PIPELINE_ORDER, getDepth } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { TraceGap, TraceChain } from './trace-types';

/**
 * Identifies requirements with incomplete trace chains.
 *
 * Algorithm (TDD Section 3.7.3 pseudocode):
 *
 *   For each chain in the traceability matrix:
 *     Determine the deepest level reached in the pipeline
 *     (i.e., the deepest level at which any document exists).
 *     For each level from PRD+1 down to the deepest reached level:
 *       If the chain has no entry at this level:
 *         This is a gap.
 *         Severity = "critical" if no downstream trace at a reached level.
 *
 * "Reached level" means at least one document of that type exists
 * in the pipeline (not necessarily in this chain).
 *
 * @param pipelineId Pipeline ID
 * @param storage Document storage layer
 * @param chains Pre-computed forward chains (from regenerator)
 * @param docMap Pre-computed document map (from regenerator)
 * @returns Array of TraceGap
 */
export async function detectGaps(
  pipelineId: string,
  storage: DocumentStorage,
  chains: TraceChain[],
  docMap: Map<string, any>,
): Promise<TraceGap[]> {
  // Determine which levels have been reached
  const reachedLevels = new Set<DocumentType>();
  for (const doc of docMap.values()) {
    reachedLevels.add(doc.type);
  }

  const gaps: TraceGap[] = [];

  for (const chain of chains) {
    // Check each reached level
    for (const type of PIPELINE_ORDER) {
      if (!reachedLevels.has(type)) continue;
      if (type === DocumentType.PRD) continue; // PRD is the source, not a gap target

      const levelKey = type.toLowerCase() as keyof typeof chain.entries;
      if (chain.entries[levelKey] === null) {
        gaps.push({
          sourceId: chain.requirementId.split(':')[0],
          sourceType: DocumentType.PRD,
          sourceSectionId: chain.requirementId.split(':')[1],
          missingAtLevel: type,
          severity: 'critical',
          description: `Requirement "${chain.requirementId}" has no coverage at ${type} level`,
        });
      }
    }
  }

  return gaps;
}
```

### Task 11: `src/pipeline/traceability/orphan-detector.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { parseSections, toSectionId } from '../versioning/section-parser';

/**
 * Identifies documents whose traces_from entries reference sections
 * that no longer exist in the parent's current version.
 *
 * This can happen after a backward cascade revision removes or renames
 * sections in a parent document.
 *
 * Algorithm:
 *   1. List all documents with depth > 0 (non-root documents).
 *   2. For each document: read its traces_from entries.
 *   3. Read the parent document's current version.
 *   4. Parse the parent's sections to get valid section IDs.
 *   5. If any traces_from entry references an invalid section ID: orphan.
 *
 * @returns Array of document IDs that are orphaned
 */
export async function detectOrphans(
  pipelineId: string,
  storage: DocumentStorage,
): Promise<string[]> {
  const allDocs = await storage.listDocuments(pipelineId);
  const orphans: string[] = [];

  for (const doc of allDocs) {
    if (doc.depth === 0) continue; // Root PRDs have no traces_from
    if (!doc.parentId) continue;

    const fullDoc = await storage.readDocument(pipelineId, doc.type, doc.documentId);
    const tracesFrom = (fullDoc.frontmatter.traces_from as string[]) ?? [];
    if (tracesFrom.length === 0) continue;

    // Read parent
    try {
      const parentDoc = await storage.readDocument(
        pipelineId,
        getParentDocType(doc.type),
        doc.parentId,
      );
      const parentSections = parseSections(parentDoc.rawContent);
      const validSectionIds = new Set(
        flattenSections(parentSections.sections).map(s => s.id),
      );

      // Check if all traces_from reference valid sections
      for (const trace of tracesFrom) {
        if (!validSectionIds.has(trace)) {
          orphans.push(doc.documentId);
          break; // Only add once per document
        }
      }
    } catch {
      // Parent not found: document is orphaned
      orphans.push(doc.documentId);
    }
  }

  return orphans;
}

function getParentDocType(type: DocumentType): DocumentType {
  const typeMap: Record<string, DocumentType> = {
    TDD: DocumentType.PRD,
    PLAN: DocumentType.TDD,
    SPEC: DocumentType.PLAN,
    CODE: DocumentType.SPEC,
  };
  return typeMap[type] ?? DocumentType.PRD;
}

function flattenSections(sections: any[]): any[] {
  const result: any[] = [];
  for (const s of sections) {
    result.push(s);
    if (s.subsections) result.push(...flattenSections(s.subsections));
  }
  return result;
}
```

### Task 12: `src/pipeline/traceability/chain-retriever.ts`

```typescript
import yaml from 'js-yaml';
import * as fs from 'fs/promises';
import { TraceabilityMatrix, TraceChain } from './trace-types';
import { DirectoryManager } from '../storage/directory-manager';

/**
 * Returns the full forward trace chain for a specific requirement.
 *
 * Works from the regenerated traceability.yaml matrix
 * (does not scan documents directly).
 *
 * @param requirementId The requirement ID in format "{PRD_ID}:{sectionId}"
 * @param pipelineId Pipeline ID
 * @param directoryManager Directory manager for path computation
 * @returns TraceChain for the requirement, or null if not found
 */
export async function getTraceChain(
  requirementId: string,
  pipelineId: string,
  directoryManager: DirectoryManager,
): Promise<TraceChain | null> {
  const traceabilityPath = directoryManager.getTraceabilityPath(pipelineId);

  try {
    const content = await fs.readFile(traceabilityPath, 'utf-8');
    const matrix = yaml.load(content) as TraceabilityMatrix;

    const chain = matrix.chains.find(c => c.requirementId === requirementId);
    return chain ?? null;
  } catch {
    return null;
  }
}
```

### Task 13: `src/pipeline/traceability/impact-analyzer.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { DecompositionTree } from '../decomposition/decomposition-tree';
import { reconstructTree } from '../decomposition/tree-reconstructor';

/**
 * Given a document and specific section IDs, identifies all downstream
 * documents that trace to those sections (directly or transitively).
 *
 * Algorithm:
 *   1. Reconstruct the decomposition tree for the pipeline.
 *   2. Find all direct children of the target document.
 *   3. Filter children to those whose traces_from intersects the affected sections.
 *   4. For each affected child: recursively find their children
 *      (transitive impact -- all descendants of affected children are also affected).
 *   5. Return all affected document IDs.
 *
 * Used by the backward cascade controller (PLAN-003-5) to scope cascades.
 *
 * @param pipelineId Pipeline ID
 * @param documentId The document whose sections changed
 * @param sectionIds The affected section IDs
 * @param storage Document storage layer
 * @returns Array of all affected document IDs (direct and transitive)
 */
export async function analyzeImpact(
  pipelineId: string,
  documentId: string,
  sectionIds: string[],
  storage: DocumentStorage,
): Promise<string[]> {
  const tree = await reconstructTree(pipelineId, storage);
  const affectedSections = new Set(sectionIds);
  const affectedDocuments: string[] = [];

  // Find direct children
  let directChildren: string[];
  try {
    directChildren = tree.getNode(documentId).childIds;
  } catch {
    return []; // Document not in tree or has no children
  }

  // Filter to affected children (traces_from intersects affected sections)
  for (const childId of directChildren) {
    const childDoc = await storage.readDocument(
      pipelineId,
      tree.getNode(childId).type,
      childId,
    );
    const tracesFrom = (childDoc.frontmatter.traces_from as string[]) ?? [];
    const isAffected = tracesFrom.some(t => affectedSections.has(t));

    if (isAffected) {
      // This child and ALL its descendants are affected
      const subtree = tree.getSubtree(childId);
      for (const node of subtree) {
        if (!affectedDocuments.includes(node.documentId)) {
          affectedDocuments.push(node.documentId);
        }
      }
    }
  }

  return affectedDocuments;
}
```

### Task 14: Facades

**`src/pipeline/decomposition/index.ts`:**

```typescript
export { decompose, type DecompositionRequest, type DecompositionResult, DecompositionError } from './decomposition-engine';
export { reconstructTree } from './tree-reconstructor';
export { getStrategy, getAllStrategies, type DecompositionStrategy } from './strategy-registry';
export { DecompositionTree, type DecompositionNode } from './decomposition-tree';
export { smokeTest } from './smoke-test';
export { checkDecompositionLimits, type LimitsCheckResult, DecompositionLimitError } from './limits-checker';
export {
  writeDecompositionRecord,
  readDecompositionRecord,
  readAllDecompositionRecords,
  type DecompositionRecord,
  type ProposedChild,
  type SmokeTestResult,
  type CoverageMatrixEntry,
} from './decomposition-record-io';
```

**`src/pipeline/traceability/index.ts`:**

```typescript
import { DocumentStorage } from '../storage/document-storage';
import { TraceabilityMatrix, TraceChain, TraceGap } from './trace-types';
import { regenerate } from './matrix-regenerator';
import { detectGaps } from './gap-detector';
import { detectOrphans } from './orphan-detector';
import { getTraceChain } from './chain-retriever';
import { analyzeImpact } from './impact-analyzer';

export { regenerate } from './matrix-regenerator';
export { detectGaps } from './gap-detector';
export { detectOrphans } from './orphan-detector';
export { getTraceChain } from './chain-retriever';
export { analyzeImpact } from './impact-analyzer';
export * from './trace-types';

/**
 * TraceabilityMatrixAPI facade per TDD Section 5.5.
 * Wraps all traceability functions into a class for convenience.
 */
export class TraceabilityMatrixAPI {
  constructor(private readonly storage: DocumentStorage) {}

  async regenerate(pipelineId: string): Promise<TraceabilityMatrix> {
    return regenerate(pipelineId, this.storage);
  }

  async detectGaps(pipelineId: string): Promise<TraceGap[]> {
    const matrix = await this.regenerate(pipelineId);
    return matrix.gaps;
  }

  async detectOrphans(pipelineId: string): Promise<string[]> {
    return detectOrphans(pipelineId, this.storage);
  }

  async getTraceChain(requirementId: string, pipelineId: string): Promise<TraceChain | null> {
    return getTraceChain(requirementId, pipelineId, this.storage.getDirectoryManager());
  }

  async analyzeImpact(pipelineId: string, documentId: string, sectionIds: string[]): Promise<string[]> {
    return analyzeImpact(pipelineId, documentId, sectionIds, this.storage);
  }
}
```

## Acceptance Criteria
1. `TraceLink`, `TraceChain`, `TraceGap`, `TraceabilityMatrix` interfaces match TDD Section 3.7.1.
2. `regenerate` builds the full matrix from document frontmatter following the 5-step process.
3. `regenerate` writes the result to `traceability.yaml` at the pipeline root.
4. `detectGaps` identifies requirements with missing coverage at reached pipeline levels.
5. Gaps are classified as "critical" when a requirement has NO downstream trace at a reached level.
6. `detectOrphans` identifies documents whose `traces_from` reference invalid parent sections.
7. `detectOrphans` correctly handles cases where the parent document has been revised (sections renamed/removed).
8. `getTraceChain` retrieves a specific requirement's chain from the cached traceability.yaml.
9. `analyzeImpact` returns all downstream document IDs affected by changes to specified sections.
10. `analyzeImpact` follows transitive impact (affected children's descendants are all affected).
11. `TraceabilityMatrixAPI` facade exposes all methods from TDD Section 5.5.
12. Traceability regeneration is triggered after every decomposition.

## Test Cases

### Unit Tests: `tests/pipeline/traceability/trace-types.test.ts`
- `TraceLink accepts all required fields`
- `TraceChain entries map to all 5 pipeline levels`
- `TraceGap has severity critical or warning`

### Unit Tests: `tests/pipeline/traceability/matrix-regenerator.test.ts`
- `regenerate builds links from document frontmatter`
- `regenerate builds forward chains from PRD sections`
- `regenerate writes traceability.yaml`
- `regenerate handles empty pipeline`
- `regenerate handles pipeline with only a PRD`

### Unit Tests: `tests/pipeline/traceability/gap-detector.test.ts`
- `no gaps when all chains are complete`
- `detects gap when TDD level reached but chain has no TDD entry`
- `detects gap at PLAN level when Plans exist but requirement has no Plan`
- `does not report gap for unreached levels (no documents of that type yet)`
- `multiple gaps for single requirement at different levels`
- `gaps have severity critical`

### Unit Tests: `tests/pipeline/traceability/orphan-detector.test.ts`
- `no orphans when all traces_from reference valid parent sections`
- `detects orphan when traces_from references non-existent parent section`
- `detects orphan when parent document does not exist`
- `does not flag PRDs (depth 0) as orphans`
- `handles documents with empty traces_from`

### Unit Tests: `tests/pipeline/traceability/chain-retriever.test.ts`
- `returns chain for existing requirement`
- `returns null for non-existent requirement`
- `returns null when traceability.yaml does not exist`

### Unit Tests: `tests/pipeline/traceability/impact-analyzer.test.ts`
- `single-level impact: affected child returned`
- `unaffected children (different sections) not returned`
- `transitive impact: affected child's descendants included`
- `no children: returns empty array`
- `all children affected: returns all descendants`
- `no sections match: returns empty array`

### Integration Test: `tests/pipeline/traceability/traceability.integration.test.ts`
- `PRD -> 3 TDDs -> regenerate -> 3 chains, all complete at TDD level`
- `PRD -> 3 TDDs -> 6 Plans -> regenerate -> chains complete at Plan level`
- `PRD -> TDD (missing section trace) -> regenerate -> gap detected`
- `PRD revised removing section -> orphan detected in TDD`
- `PRD section changed -> analyzeImpact returns affected TDD and its Plans`
