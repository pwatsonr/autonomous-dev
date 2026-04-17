# SPEC-003-4-01: Decomposition Strategy Registry, Tree Data Structure, and Record I/O

## Metadata
- **Parent Plan**: PLAN-003-4
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 9 hours

## Description
Implement the decomposition strategy registry (maps pipeline transitions to decomposition strategies), the `DecompositionNode`/`DecompositionTree` in-memory data structures for representing the parent-child document graph, and the decomposition record I/O (reading and writing YAML decomposition files in the `decomposition/` directory).

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/decomposition/strategy-registry.ts` | Create |
| `src/pipeline/decomposition/decomposition-tree.ts` | Create |
| `src/pipeline/decomposition/decomposition-record-io.ts` | Create |

## Implementation Details

### Task 1: `src/pipeline/decomposition/strategy-registry.ts`

```typescript
import { DocumentType } from '../types/document-type';

export type DecompositionStrategyId = 'domain' | 'phase' | 'task' | 'direct';

export interface DecompositionStrategy {
  /** Unique strategy identifier */
  id: DecompositionStrategyId;
  /** Human-readable description */
  description: string;
  /** Parent document type this strategy applies from */
  parentType: DocumentType;
  /** Child document type this strategy produces */
  childType: DocumentType;
}

/**
 * Strategy registry per TDD Section 3.6.1:
 *
 * | Transition    | Strategy | Description                                |
 * |---------------|----------|--------------------------------------------|
 * | PRD -> TDD    | domain   | Split by domain/bounded context            |
 * | TDD -> PLAN   | phase    | Split by implementation phase               |
 * | PLAN -> SPEC  | task     | Split by individual task                   |
 * | SPEC -> CODE  | direct   | 1:1 mapping, no decomposition logic needed |
 */
const STRATEGIES: DecompositionStrategy[] = [
  {
    id: 'domain',
    description: 'Split by domain or bounded context',
    parentType: DocumentType.PRD,
    childType: DocumentType.TDD,
  },
  {
    id: 'phase',
    description: 'Split by implementation phase',
    parentType: DocumentType.TDD,
    childType: DocumentType.PLAN,
  },
  {
    id: 'task',
    description: 'Split by individual task',
    parentType: DocumentType.PLAN,
    childType: DocumentType.SPEC,
  },
  {
    id: 'direct',
    description: '1:1 direct generation, no decomposition logic',
    parentType: DocumentType.SPEC,
    childType: DocumentType.CODE,
  },
];

/**
 * Returns the decomposition strategy for a parent->child type transition.
 *
 * @throws Error if no strategy exists for the transition
 *         (e.g., CODE has no decomposition)
 */
export function getStrategy(
  parentType: DocumentType,
  childType: DocumentType,
): DecompositionStrategy {
  const strategy = STRATEGIES.find(
    s => s.parentType === parentType && s.childType === childType,
  );
  if (!strategy) {
    throw new Error(
      `No decomposition strategy for transition ${parentType} -> ${childType}`,
    );
  }
  return strategy;
}

/**
 * Returns all registered strategies.
 */
export function getAllStrategies(): DecompositionStrategy[] {
  return [...STRATEGIES];
}
```

### Task 2: `src/pipeline/decomposition/decomposition-tree.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { DocumentStatus, ExecutionMode } from '../types/frontmatter';

export interface DecompositionNode {
  /** Document ID */
  documentId: string;
  /** Document type */
  type: DocumentType;
  /** Current status */
  status: DocumentStatus;
  /** Current version */
  version: string;
  /** Depth in pipeline (0 = PRD) */
  depth: number;
  /** Parent document ID (null for root) */
  parentId: string | null;
  /** IDs of child documents */
  childIds: string[];
  /** IDs of sibling documents this node depends on */
  dependsOn: string[];
  /** Execution mode: parallel or sequential */
  executionMode: ExecutionMode;
  /** 0-based sibling index */
  siblingIndex: number;
  /** Total number of siblings */
  siblingCount: number;
}

export class DecompositionTree {
  private nodes: Map<string, DecompositionNode> = new Map();
  private rootId: string | null = null;

  /**
   * Adds a node to the tree.
   * If this is the first node at depth 0, it becomes the root.
   */
  addNode(node: DecompositionNode): void {
    this.nodes.set(node.documentId, node);
    if (node.depth === 0 && this.rootId === null) {
      this.rootId = node.documentId;
    }
  }

  /**
   * Gets a node by document ID.
   * @throws Error if node not found
   */
  getNode(documentId: string): DecompositionNode {
    const node = this.nodes.get(documentId);
    if (!node) throw new Error(`Node not found: ${documentId}`);
    return node;
  }

  /**
   * Returns true if the tree contains the given document ID.
   */
  hasNode(documentId: string): boolean {
    return this.nodes.has(documentId);
  }

  /**
   * Returns the children of a node.
   */
  getChildren(documentId: string): DecompositionNode[] {
    const node = this.getNode(documentId);
    return node.childIds.map(id => this.getNode(id));
  }

  /**
   * Returns the subtree rooted at the given node (inclusive).
   * Traverses depth-first.
   */
  getSubtree(documentId: string): DecompositionNode[] {
    const result: DecompositionNode[] = [];
    const visit = (id: string) => {
      const node = this.getNode(id);
      result.push(node);
      for (const childId of node.childIds) {
        visit(childId);
      }
    };
    visit(documentId);
    return result;
  }

  /**
   * Returns the total number of nodes in the tree.
   */
  getTotalNodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Returns the maximum depth of any node in the tree.
   */
  getMaxDepth(): number {
    let max = 0;
    for (const node of this.nodes.values()) {
      if (node.depth > max) max = node.depth;
    }
    return max;
  }

  /**
   * Returns the root node ID, or null if tree is empty.
   */
  getRootId(): string | null {
    return this.rootId;
  }

  /**
   * Returns all nodes as an array.
   */
  getAllNodes(): DecompositionNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Validates that the dependency graph among siblings is a DAG (no cycles).
   * @returns true if valid DAG, false if cycles detected
   */
  validateDependencyDAG(): boolean {
    // Topological sort on dependsOn edges within each sibling group
    // If the sort completes without detecting a cycle, return true
    for (const node of this.nodes.values()) {
      if (node.dependsOn.length === 0) continue;
      // DFS cycle detection within the dependency subgraph
      const visited = new Set<string>();
      const inStack = new Set<string>();
      const hasCycle = (id: string): boolean => {
        if (inStack.has(id)) return true;
        if (visited.has(id)) return false;
        visited.add(id);
        inStack.add(id);
        const n = this.nodes.get(id);
        if (n) {
          for (const dep of n.dependsOn) {
            if (hasCycle(dep)) return true;
          }
        }
        inStack.delete(id);
        return false;
      };
      if (hasCycle(node.documentId)) return false;
    }
    return true;
  }
}
```

### Task 3: `src/pipeline/decomposition/decomposition-record-io.ts`

```typescript
import yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentType } from '../types/document-type';
import { ExecutionMode } from '../types/frontmatter';
import { DirectoryManager } from '../storage/directory-manager';
import { atomicWrite } from '../storage/atomic-io';

/**
 * Decomposition record schema per TDD Section 3.6.3.
 */
export interface ProposedChild {
  /** Generated document ID */
  id: string;
  /** Title of the child document */
  title: string;
  /** Parent sections this child addresses */
  tracesFrom: string[];
  /** Execution mode for this child */
  executionMode: ExecutionMode;
  /** Sibling IDs this child depends on */
  dependsOn: string[];
}

export interface CoverageMatrixEntry {
  /** Parent section ID */
  parentSection: string;
  /** Child document IDs that trace to this section */
  coveredBy: string[];
}

export interface SmokeTestResult {
  passed: boolean;
  coverageComplete: boolean;
  uncoveredParentSections: string[];
  scopeCreep: boolean;
  scopeCreepDetails: string[];
  contradictions: boolean;
  contradictionDetails: string[];
}

export interface DecompositionRecord {
  /** Parent document ID */
  parentId: string;
  /** Parent document type */
  parentType: DocumentType;
  /** Parent version at time of decomposition */
  parentVersion: string;
  /** Child document type produced */
  childType: DocumentType;
  /** Strategy used */
  strategy: string;
  /** Proposed/created children */
  children: ProposedChild[];
  /** Coverage matrix: which parent sections are covered by which children */
  coverageMatrix: CoverageMatrixEntry[];
  /** Smoke test result (null if not run) */
  smokeTestResult: SmokeTestResult | null;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** Agent that performed the decomposition */
  decompositionAgent: string;
}

/**
 * Writes a decomposition record to the pipeline's decomposition/ directory.
 *
 * File naming: {PARENT_ID}-decomposition.yaml
 * Example: PRD-001-decomposition.yaml
 */
export async function writeDecompositionRecord(
  record: DecompositionRecord,
  pipelineId: string,
  directoryManager: DirectoryManager,
): Promise<string> {
  const decompDir = directoryManager.getDecompositionDir(pipelineId);
  const filename = `${record.parentId}-decomposition.yaml`;
  const filePath = path.join(decompDir, filename);

  const yamlContent = yaml.dump(record, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  await atomicWrite(filePath, yamlContent);
  return filePath;
}

/**
 * Reads a decomposition record for a specific parent document.
 * Returns null if no decomposition record exists.
 */
export async function readDecompositionRecord(
  parentId: string,
  pipelineId: string,
  directoryManager: DirectoryManager,
): Promise<DecompositionRecord | null> {
  const decompDir = directoryManager.getDecompositionDir(pipelineId);
  const filename = `${parentId}-decomposition.yaml`;
  const filePath = path.join(decompDir, filename);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.load(content) as DecompositionRecord;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Reads all decomposition records for a pipeline.
 */
export async function readAllDecompositionRecords(
  pipelineId: string,
  directoryManager: DirectoryManager,
): Promise<DecompositionRecord[]> {
  const decompDir = directoryManager.getDecompositionDir(pipelineId);
  let files: string[];
  try {
    files = await fs.readdir(decompDir);
  } catch {
    return [];
  }

  const records: DecompositionRecord[] = [];
  for (const file of files) {
    if (file.endsWith('-decomposition.yaml')) {
      const content = await fs.readFile(path.join(decompDir, file), 'utf-8');
      records.push(yaml.load(content) as DecompositionRecord);
    }
  }
  return records;
}
```

## Acceptance Criteria
1. `getStrategy('PRD', 'TDD')` returns strategy with id `'domain'`.
2. `getStrategy('TDD', 'PLAN')` returns strategy with id `'phase'`.
3. `getStrategy('PLAN', 'SPEC')` returns strategy with id `'task'`.
4. `getStrategy('SPEC', 'CODE')` returns strategy with id `'direct'`.
5. `getStrategy('CODE', ...)` throws (CODE has no decomposition).
6. `DecompositionTree` supports add, get, getChildren, getSubtree, getTotalNodeCount, getMaxDepth.
7. `DecompositionTree.validateDependencyDAG` returns false when sibling dependencies form a cycle.
8. `DecompositionTree.getSubtree` returns all descendants (depth-first).
9. `writeDecompositionRecord` writes YAML file named `{PARENT_ID}-decomposition.yaml` in `decomposition/` dir.
10. `readDecompositionRecord` reads back and deserializes to the same structure.
11. `readAllDecompositionRecords` returns all decomposition records for a pipeline.
12. Decomposition record schema includes: parentId, parentType, parentVersion, childType, strategy, children, coverageMatrix, smokeTestResult, createdAt, decompositionAgent.

## Test Cases

### Unit Tests: `tests/pipeline/decomposition/strategy-registry.test.ts`
- `PRD->TDD returns domain strategy`
- `TDD->PLAN returns phase strategy`
- `PLAN->SPEC returns task strategy`
- `SPEC->CODE returns direct strategy`
- `CODE->anything throws`
- `getAllStrategies returns 4 strategies`

### Unit Tests: `tests/pipeline/decomposition/decomposition-tree.test.ts`
- `addNode and getNode work correctly`
- `hasNode returns true for existing, false for missing`
- `getChildren returns child nodes`
- `getSubtree returns all descendants`
- `getTotalNodeCount counts all nodes`
- `getMaxDepth returns maximum depth`
- `getRootId returns root node ID`
- `validateDependencyDAG returns true for valid DAG`
- `validateDependencyDAG returns false for circular dependency`
- `tree with no nodes: getTotalNodeCount=0, getMaxDepth=0`
- `tree with single root: getChildren returns empty, getSubtree returns just root`

### Unit Tests: `tests/pipeline/decomposition/decomposition-record-io.test.ts`
- `writeDecompositionRecord creates correct filename`
- `writeDecompositionRecord writes valid YAML`
- `readDecompositionRecord returns null for non-existent record`
- `round-trip: write -> read preserves all fields`
- `readAllDecompositionRecords returns all records in directory`
- `readAllDecompositionRecords returns empty for empty directory`
- `record schema includes all required fields`
