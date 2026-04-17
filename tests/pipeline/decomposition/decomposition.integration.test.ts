import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { PipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../../../src/pipeline/types/config';
import { InMemoryIdCounter } from '../../../src/pipeline/frontmatter/id-generator';
import { DocumentStorage } from '../../../src/pipeline/storage/document-storage';
import {
  decompose,
  DecompositionError,
} from '../../../src/pipeline/decomposition/decomposition-engine';
import { reconstructTree } from '../../../src/pipeline/decomposition/tree-reconstructor';
import { ProposedChild } from '../../../src/pipeline/decomposition/decomposition-record-io';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(rootDir: string, overrides?: Partial<PipelineConfig['decomposition']>): PipelineConfig {
  return {
    ...DEFAULT_PIPELINE_CONFIG,
    pipeline: {
      ...DEFAULT_PIPELINE_CONFIG.pipeline,
      rootDir,
    },
    decomposition: {
      ...DEFAULT_PIPELINE_CONFIG.decomposition,
      ...overrides,
    },
  };
}

function makeChild(overrides: Partial<ProposedChild> & { id: string }): ProposedChild {
  return {
    title: `Child ${overrides.id}`,
    tracesFrom: [],
    executionMode: 'parallel',
    dependsOn: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe('Decomposition Integration', () => {
  let tmpDir: string;
  let config: PipelineConfig;
  let storage: DocumentStorage;
  let idCounter: InMemoryIdCounter;
  const pipelineId = 'PIPE-INTEG-001';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decomp-integ-'));
    config = makeConfig(tmpDir);
    idCounter = new InMemoryIdCounter();
    storage = new DocumentStorage(config, idCounter);
    await storage.initializePipeline(pipelineId, 'Integration Test Pipeline');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: creates a PRD and approves it by writing a new version with status=approved.
   * Returns the document ID.
   */
  async function createApprovedPRD(): Promise<string> {
    const handle = await storage.createDocument({
      pipelineId,
      type: DocumentType.PRD,
      title: 'Integration PRD',
      authorAgent: 'agent-prd-writer',
      parentId: null,
      tracesFrom: [],
      depth: 0,
      siblingIndex: 0,
      siblingCount: 1,
      dependsOn: [],
      dependencyType: [],
      executionMode: 'sequential',
      priority: 'normal',
    });

    // Read the current content and write a new version with status=approved
    const currentContent = await storage.readDocument(pipelineId, DocumentType.PRD, handle.documentId);
    const rawContent = currentContent.rawContent.replace(
      /status:\s*draft/,
      'status: approved',
    );

    await storage.writeVersion({
      pipelineId,
      type: DocumentType.PRD,
      documentId: handle.documentId,
      version: '1.1',
      content: rawContent,
      reason: 'REVIEW_REVISION',
      authorAgent: 'agent-reviewer',
    });

    return handle.documentId;
  }

  test('create PRD -> approve -> decompose to 3 TDDs -> verify directory structure, decomposition record, tree', async () => {
    const prdId = await createApprovedPRD();

    // Read the approved PRD to get section IDs
    const prdContent = await storage.readDocument(pipelineId, DocumentType.PRD, prdId);

    // Build proposed children that trace from actual sections in the PRD template
    // We need to know what sections the template creates. Get all section-like headings.
    const sectionMatches = prdContent.rawContent.match(/^##\s+(.+)$/gm) ?? [];
    const sectionIds = sectionMatches.map(m =>
      m.replace(/^##\s+/, '').toLowerCase().replace(/\s+/g, '-'),
    );

    // Create 3 proposed children that cover all sections
    const sectionsPerChild = Math.ceil(sectionIds.length / 3);
    const proposedChildren: ProposedChild[] = [];
    for (let i = 0; i < 3; i++) {
      const start = i * sectionsPerChild;
      const tracesFrom = sectionIds.slice(start, start + sectionsPerChild);
      proposedChildren.push(
        makeChild({
          id: `TDD-proposed-${i}`,
          title: `TDD ${String.fromCharCode(65 + i)}`,
          tracesFrom: tracesFrom.length > 0 ? tracesFrom : sectionIds.slice(0, 1),
        }),
      );
    }

    // Build the current tree (just the PRD)
    const currentTree = await reconstructTree(pipelineId, storage);

    const result = await decompose(
      {
        pipelineId,
        parentId: prdId,
        parentType: DocumentType.PRD,
        proposedChildren,
        decompositionAgent: 'agent-decomposer',
      },
      storage,
      config,
      currentTree,
    );

    // Verify result
    expect(result.success).toBe(true);
    expect(result.createdChildren).toHaveLength(3);

    // Verify each created child can be read
    for (const childId of result.createdChildren) {
      const childDoc = await storage.readDocument(pipelineId, DocumentType.TDD, childId);
      expect(childDoc.frontmatter.type).toBe(DocumentType.TDD);
      expect(childDoc.frontmatter.parent_id).toBe(prdId);
      expect(childDoc.frontmatter.depth).toBe(1);
      expect(childDoc.frontmatter.status).toBe('draft');
    }

    // Verify decomposition record exists on disk
    const dm = storage.getDirectoryManager();
    const decompDir = dm.getDecompositionDir(pipelineId);
    const recordFile = path.join(decompDir, `${prdId}-decomposition.yaml`);
    const recordExists = await fs.access(recordFile).then(() => true).catch(() => false);
    expect(recordExists).toBe(true);

    // Verify tree reconstruction includes all nodes
    const fullTree = await reconstructTree(pipelineId, storage);
    expect(fullTree.getTotalNodeCount()).toBe(4); // 1 PRD + 3 TDDs
    expect(fullTree.getMaxDepth()).toBe(1);

    const rootNode = fullTree.getNode(prdId);
    expect(rootNode.childIds).toHaveLength(3);
    for (const childId of result.createdChildren) {
      expect(rootNode.childIds).toContain(childId);
    }
  });

  test('decompose with 11 children -> LIMIT_EXCEEDED rejection', async () => {
    const prdId = await createApprovedPRD();

    const prdContent = await storage.readDocument(pipelineId, DocumentType.PRD, prdId);
    const sectionMatches = prdContent.rawContent.match(/^##\s+(.+)$/gm) ?? [];
    const sectionIds = sectionMatches.map(m =>
      m.replace(/^##\s+/, '').toLowerCase().replace(/\s+/g, '-'),
    );

    // Create 11 proposed children (exceeds default limit of 10)
    const proposedChildren: ProposedChild[] = [];
    for (let i = 0; i < 11; i++) {
      proposedChildren.push(
        makeChild({
          id: `TDD-proposed-${i}`,
          title: `TDD ${i}`,
          tracesFrom: sectionIds.length > 0 ? [sectionIds[0]] : ['section-0'],
        }),
      );
    }

    const currentTree = await reconstructTree(pipelineId, storage);

    await expect(
      decompose(
        {
          pipelineId,
          parentId: prdId,
          parentType: DocumentType.PRD,
          proposedChildren,
          decompositionAgent: 'agent-decomposer',
        },
        storage,
        config,
        currentTree,
      ),
    ).rejects.toThrow(DecompositionError);

    try {
      await decompose(
        {
          pipelineId,
          parentId: prdId,
          parentType: DocumentType.PRD,
          proposedChildren,
          decompositionAgent: 'agent-decomposer',
        },
        storage,
        config,
        currentTree,
      );
    } catch (err) {
      expect((err as DecompositionError).type).toBe('LIMIT_EXCEEDED');
    }
  });

  test('decompose with missing coverage -> SMOKE_TEST_FAILED rejection', async () => {
    const prdId = await createApprovedPRD();

    const prdContent = await storage.readDocument(pipelineId, DocumentType.PRD, prdId);
    const sectionMatches = prdContent.rawContent.match(/^##\s+(.+)$/gm) ?? [];
    const sectionIds = sectionMatches.map(m =>
      m.replace(/^##\s+/, '').toLowerCase().replace(/\s+/g, '-'),
    );

    // Only cover first section, leaving others uncovered
    const proposedChildren: ProposedChild[] = [];
    if (sectionIds.length > 1) {
      proposedChildren.push(
        makeChild({
          id: 'TDD-partial',
          title: 'TDD Partial',
          tracesFrom: [sectionIds[0]], // Only first section
        }),
      );

      const currentTree = await reconstructTree(pipelineId, storage);

      await expect(
        decompose(
          {
            pipelineId,
            parentId: prdId,
            parentType: DocumentType.PRD,
            proposedChildren,
            decompositionAgent: 'agent-decomposer',
          },
          storage,
          config,
          currentTree,
        ),
      ).rejects.toThrow(DecompositionError);

      try {
        await decompose(
          {
            pipelineId,
            parentId: prdId,
            parentType: DocumentType.PRD,
            proposedChildren,
            decompositionAgent: 'agent-decomposer',
          },
          storage,
          config,
          currentTree,
        );
      } catch (err) {
        expect((err as DecompositionError).type).toBe('SMOKE_TEST_FAILED');
      }
    } else {
      // If template only has one section or none, this test is trivially satisfied
      // by checking that full coverage with a ghost section causes scope creep failure
      proposedChildren.push(
        makeChild({
          id: 'TDD-partial',
          title: 'TDD Partial',
          tracesFrom: ['nonexistent-section'],
        }),
      );

      const currentTree = await reconstructTree(pipelineId, storage);

      await expect(
        decompose(
          {
            pipelineId,
            parentId: prdId,
            parentType: DocumentType.PRD,
            proposedChildren,
            decompositionAgent: 'agent-decomposer',
          },
          storage,
          config,
          currentTree,
        ),
      ).rejects.toThrow(DecompositionError);
    }
  });

  test('decompose PRD -> decompose TDD -> reconstruct tree -> tree has 2 levels', async () => {
    const prdId = await createApprovedPRD();

    // Read PRD sections
    const prdContent = await storage.readDocument(pipelineId, DocumentType.PRD, prdId);
    const sectionMatches = prdContent.rawContent.match(/^##\s+(.+)$/gm) ?? [];
    const sectionIds = sectionMatches.map(m =>
      m.replace(/^##\s+/, '').toLowerCase().replace(/\s+/g, '-'),
    );

    // Step 1: Decompose PRD into 1 TDD (keep it simple)
    const prdChildren: ProposedChild[] = [
      makeChild({
        id: 'TDD-proposed-0',
        title: 'TDD Alpha',
        tracesFrom: sectionIds.length > 0 ? sectionIds : ['overview'],
      }),
    ];

    const treeBeforePrd = await reconstructTree(pipelineId, storage);
    const prdResult = await decompose(
      {
        pipelineId,
        parentId: prdId,
        parentType: DocumentType.PRD,
        proposedChildren: prdChildren,
        decompositionAgent: 'agent-decomposer',
      },
      storage,
      config,
      treeBeforePrd,
    );

    expect(prdResult.success).toBe(true);
    const tddId = prdResult.createdChildren[0];

    // Step 2: Approve the TDD by writing new version
    const tddContent = await storage.readDocument(pipelineId, DocumentType.TDD, tddId);
    const tddApproved = tddContent.rawContent.replace(
      /status:\s*draft/,
      'status: approved',
    );
    await storage.writeVersion({
      pipelineId,
      type: DocumentType.TDD,
      documentId: tddId,
      version: '1.1',
      content: tddApproved,
      reason: 'REVIEW_REVISION',
      authorAgent: 'agent-reviewer',
    });

    // Read TDD sections
    const tddContentApproved = await storage.readDocument(pipelineId, DocumentType.TDD, tddId);
    const tddSectionMatches = tddContentApproved.rawContent.match(/^##\s+(.+)$/gm) ?? [];
    const tddSectionIds = tddSectionMatches.map(m =>
      m.replace(/^##\s+/, '').toLowerCase().replace(/\s+/g, '-'),
    );

    // Step 3: Decompose TDD into 2 PLANs
    const tddChildren: ProposedChild[] = [
      makeChild({
        id: 'PLAN-proposed-0',
        title: 'Plan Phase 1',
        tracesFrom: tddSectionIds.length > 0 ? tddSectionIds : ['api-design'],
      }),
    ];

    // If there are multiple sections, split them
    if (tddSectionIds.length > 1) {
      const half = Math.ceil(tddSectionIds.length / 2);
      tddChildren[0] = makeChild({
        id: 'PLAN-proposed-0',
        title: 'Plan Phase 1',
        tracesFrom: tddSectionIds.slice(0, half),
      });
      tddChildren.push(
        makeChild({
          id: 'PLAN-proposed-1',
          title: 'Plan Phase 2',
          tracesFrom: tddSectionIds.slice(half),
          dependsOn: [],
        }),
      );
    }

    const treeBeforeTdd = await reconstructTree(pipelineId, storage);
    const tddResult = await decompose(
      {
        pipelineId,
        parentId: tddId,
        parentType: DocumentType.TDD,
        proposedChildren: tddChildren,
        decompositionAgent: 'agent-decomposer',
      },
      storage,
      config,
      treeBeforeTdd,
    );

    expect(tddResult.success).toBe(true);

    // Step 4: Reconstruct and verify tree has 2 levels
    const finalTree = await reconstructTree(pipelineId, storage);

    // PRD (depth 0) -> TDD (depth 1) -> PLANs (depth 2)
    expect(finalTree.getMaxDepth()).toBe(2);
    expect(finalTree.getRootId()).toBe(prdId);

    const rootNode = finalTree.getNode(prdId);
    expect(rootNode.childIds).toContain(tddId);

    const tddNode = finalTree.getNode(tddId);
    expect(tddNode.childIds).toHaveLength(tddResult.createdChildren.length);
    for (const planId of tddResult.createdChildren) {
      expect(tddNode.childIds).toContain(planId);
      const planNode = finalTree.getNode(planId);
      expect(planNode.type).toBe(DocumentType.PLAN);
      expect(planNode.depth).toBe(2);
      expect(planNode.parentId).toBe(tddId);
    }
  });
});
