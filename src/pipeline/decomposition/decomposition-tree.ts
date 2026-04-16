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
