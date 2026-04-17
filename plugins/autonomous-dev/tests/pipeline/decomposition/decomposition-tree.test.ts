import { DocumentType } from '../../../src/pipeline/types/document-type';
import {
  DecompositionTree,
  DecompositionNode,
} from '../../../src/pipeline/decomposition/decomposition-tree';

function makeNode(overrides: Partial<DecompositionNode> & { documentId: string }): DecompositionNode {
  return {
    type: DocumentType.PRD,
    status: 'draft',
    version: '1.0',
    depth: 0,
    parentId: null,
    childIds: [],
    dependsOn: [],
    executionMode: 'parallel',
    siblingIndex: 0,
    siblingCount: 1,
    ...overrides,
  };
}

describe('DecompositionTree', () => {
  test('addNode and getNode work correctly', () => {
    const tree = new DecompositionTree();
    const node = makeNode({ documentId: 'PRD-001' });
    tree.addNode(node);
    const retrieved = tree.getNode('PRD-001');
    expect(retrieved).toBe(node);
  });

  test('getNode throws for non-existent node', () => {
    const tree = new DecompositionTree();
    expect(() => tree.getNode('MISSING')).toThrow('Node not found: MISSING');
  });

  test('hasNode returns true for existing, false for missing', () => {
    const tree = new DecompositionTree();
    const node = makeNode({ documentId: 'PRD-001' });
    tree.addNode(node);
    expect(tree.hasNode('PRD-001')).toBe(true);
    expect(tree.hasNode('MISSING')).toBe(false);
  });

  test('getChildren returns child nodes', () => {
    const tree = new DecompositionTree();
    const root = makeNode({
      documentId: 'PRD-001',
      childIds: ['TDD-001-01', 'TDD-001-02'],
    });
    const child1 = makeNode({
      documentId: 'TDD-001-01',
      type: DocumentType.TDD,
      depth: 1,
      parentId: 'PRD-001',
      siblingIndex: 0,
      siblingCount: 2,
    });
    const child2 = makeNode({
      documentId: 'TDD-001-02',
      type: DocumentType.TDD,
      depth: 1,
      parentId: 'PRD-001',
      siblingIndex: 1,
      siblingCount: 2,
    });

    tree.addNode(root);
    tree.addNode(child1);
    tree.addNode(child2);

    const children = tree.getChildren('PRD-001');
    expect(children).toHaveLength(2);
    expect(children[0].documentId).toBe('TDD-001-01');
    expect(children[1].documentId).toBe('TDD-001-02');
  });

  test('getSubtree returns all descendants depth-first', () => {
    const tree = new DecompositionTree();
    const root = makeNode({
      documentId: 'PRD-001',
      childIds: ['TDD-001-01'],
    });
    const tdd = makeNode({
      documentId: 'TDD-001-01',
      type: DocumentType.TDD,
      depth: 1,
      parentId: 'PRD-001',
      childIds: ['PLAN-001-01-01', 'PLAN-001-01-02'],
    });
    const plan1 = makeNode({
      documentId: 'PLAN-001-01-01',
      type: DocumentType.PLAN,
      depth: 2,
      parentId: 'TDD-001-01',
      siblingIndex: 0,
      siblingCount: 2,
    });
    const plan2 = makeNode({
      documentId: 'PLAN-001-01-02',
      type: DocumentType.PLAN,
      depth: 2,
      parentId: 'TDD-001-01',
      siblingIndex: 1,
      siblingCount: 2,
    });

    tree.addNode(root);
    tree.addNode(tdd);
    tree.addNode(plan1);
    tree.addNode(plan2);

    const subtree = tree.getSubtree('PRD-001');
    expect(subtree).toHaveLength(4);
    expect(subtree.map(n => n.documentId)).toEqual([
      'PRD-001',
      'TDD-001-01',
      'PLAN-001-01-01',
      'PLAN-001-01-02',
    ]);
  });

  test('getSubtree from a non-root returns only that subtree', () => {
    const tree = new DecompositionTree();
    const root = makeNode({
      documentId: 'PRD-001',
      childIds: ['TDD-001-01', 'TDD-001-02'],
    });
    const tdd1 = makeNode({
      documentId: 'TDD-001-01',
      type: DocumentType.TDD,
      depth: 1,
      parentId: 'PRD-001',
      childIds: ['PLAN-001-01-01'],
    });
    const tdd2 = makeNode({
      documentId: 'TDD-001-02',
      type: DocumentType.TDD,
      depth: 1,
      parentId: 'PRD-001',
    });
    const plan = makeNode({
      documentId: 'PLAN-001-01-01',
      type: DocumentType.PLAN,
      depth: 2,
      parentId: 'TDD-001-01',
    });

    tree.addNode(root);
    tree.addNode(tdd1);
    tree.addNode(tdd2);
    tree.addNode(plan);

    const subtree = tree.getSubtree('TDD-001-01');
    expect(subtree).toHaveLength(2);
    expect(subtree.map(n => n.documentId)).toEqual([
      'TDD-001-01',
      'PLAN-001-01-01',
    ]);
  });

  test('getTotalNodeCount counts all nodes', () => {
    const tree = new DecompositionTree();
    expect(tree.getTotalNodeCount()).toBe(0);

    tree.addNode(makeNode({ documentId: 'PRD-001' }));
    expect(tree.getTotalNodeCount()).toBe(1);

    tree.addNode(makeNode({ documentId: 'TDD-001-01', type: DocumentType.TDD, depth: 1 }));
    expect(tree.getTotalNodeCount()).toBe(2);
  });

  test('getMaxDepth returns maximum depth', () => {
    const tree = new DecompositionTree();
    expect(tree.getMaxDepth()).toBe(0);

    tree.addNode(makeNode({ documentId: 'PRD-001', depth: 0 }));
    expect(tree.getMaxDepth()).toBe(0);

    tree.addNode(makeNode({ documentId: 'TDD-001-01', type: DocumentType.TDD, depth: 1 }));
    expect(tree.getMaxDepth()).toBe(1);

    tree.addNode(makeNode({ documentId: 'PLAN-001-01-01', type: DocumentType.PLAN, depth: 2 }));
    expect(tree.getMaxDepth()).toBe(2);

    tree.addNode(makeNode({ documentId: 'CODE-001-01-01-01-01', type: DocumentType.CODE, depth: 4 }));
    expect(tree.getMaxDepth()).toBe(4);
  });

  test('getRootId returns root node ID', () => {
    const tree = new DecompositionTree();
    expect(tree.getRootId()).toBeNull();

    tree.addNode(makeNode({ documentId: 'PRD-001', depth: 0 }));
    expect(tree.getRootId()).toBe('PRD-001');
  });

  test('getRootId is set only by the first depth-0 node', () => {
    const tree = new DecompositionTree();
    tree.addNode(makeNode({ documentId: 'TDD-001-01', type: DocumentType.TDD, depth: 1 }));
    expect(tree.getRootId()).toBeNull();

    tree.addNode(makeNode({ documentId: 'PRD-001', depth: 0 }));
    expect(tree.getRootId()).toBe('PRD-001');

    // Adding another depth-0 node does not change root
    tree.addNode(makeNode({ documentId: 'PRD-002', depth: 0 }));
    expect(tree.getRootId()).toBe('PRD-001');
  });

  test('getAllNodes returns all nodes', () => {
    const tree = new DecompositionTree();
    tree.addNode(makeNode({ documentId: 'PRD-001' }));
    tree.addNode(makeNode({ documentId: 'TDD-001-01', type: DocumentType.TDD, depth: 1 }));

    const allNodes = tree.getAllNodes();
    expect(allNodes).toHaveLength(2);
    const ids = allNodes.map(n => n.documentId).sort();
    expect(ids).toEqual(['PRD-001', 'TDD-001-01']);
  });

  test('validateDependencyDAG returns true for valid DAG', () => {
    const tree = new DecompositionTree();
    // A -> B (B depends on A)
    tree.addNode(makeNode({
      documentId: 'PLAN-001-01-01',
      type: DocumentType.PLAN,
      depth: 2,
      parentId: 'TDD-001-01',
      siblingIndex: 0,
      siblingCount: 3,
      dependsOn: [],
    }));
    tree.addNode(makeNode({
      documentId: 'PLAN-001-01-02',
      type: DocumentType.PLAN,
      depth: 2,
      parentId: 'TDD-001-01',
      siblingIndex: 1,
      siblingCount: 3,
      dependsOn: ['PLAN-001-01-01'],
    }));
    tree.addNode(makeNode({
      documentId: 'PLAN-001-01-03',
      type: DocumentType.PLAN,
      depth: 2,
      parentId: 'TDD-001-01',
      siblingIndex: 2,
      siblingCount: 3,
      dependsOn: ['PLAN-001-01-01', 'PLAN-001-01-02'],
    }));

    expect(tree.validateDependencyDAG()).toBe(true);
  });

  test('validateDependencyDAG returns false for circular dependency', () => {
    const tree = new DecompositionTree();
    // A depends on B, B depends on A -> cycle
    tree.addNode(makeNode({
      documentId: 'PLAN-001-01-01',
      type: DocumentType.PLAN,
      depth: 2,
      parentId: 'TDD-001-01',
      siblingIndex: 0,
      siblingCount: 2,
      dependsOn: ['PLAN-001-01-02'],
    }));
    tree.addNode(makeNode({
      documentId: 'PLAN-001-01-02',
      type: DocumentType.PLAN,
      depth: 2,
      parentId: 'TDD-001-01',
      siblingIndex: 1,
      siblingCount: 2,
      dependsOn: ['PLAN-001-01-01'],
    }));

    expect(tree.validateDependencyDAG()).toBe(false);
  });

  test('validateDependencyDAG returns false for self-referencing dependency', () => {
    const tree = new DecompositionTree();
    tree.addNode(makeNode({
      documentId: 'PLAN-001-01-01',
      type: DocumentType.PLAN,
      depth: 2,
      dependsOn: ['PLAN-001-01-01'],
    }));

    expect(tree.validateDependencyDAG()).toBe(false);
  });

  test('tree with no nodes: getTotalNodeCount=0, getMaxDepth=0', () => {
    const tree = new DecompositionTree();
    expect(tree.getTotalNodeCount()).toBe(0);
    expect(tree.getMaxDepth()).toBe(0);
  });

  test('tree with single root: getChildren returns empty, getSubtree returns just root', () => {
    const tree = new DecompositionTree();
    tree.addNode(makeNode({ documentId: 'PRD-001' }));

    expect(tree.getChildren('PRD-001')).toEqual([]);
    const subtree = tree.getSubtree('PRD-001');
    expect(subtree).toHaveLength(1);
    expect(subtree[0].documentId).toBe('PRD-001');
  });
});
