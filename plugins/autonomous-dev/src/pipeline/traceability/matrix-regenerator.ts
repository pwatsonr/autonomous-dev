import yaml from 'js-yaml';
import { DocumentType, PIPELINE_ORDER } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { TraceabilityMatrix, TraceLink, TraceChain } from './trace-types';
import { detectGaps } from './gap-detector';
import { detectOrphans } from './orphan-detector';
import { atomicWrite } from '../storage/atomic-io';

/** Internal document info extracted from frontmatter during the walk. */
interface DocInfo {
  id: string;
  type: DocumentType;
  status: string;
  tracesFrom: string[];
  tracesTo: string[];
  parentId: string | null;
}

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
  const docMap = new Map<string, DocInfo>();

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
        prdFull.frontmatter.status ?? 'draft',
        docMap,
        links,
      );
      chains.push(chain);
    }
  }

  // Step 4: Detect gaps
  const gaps = await detectGaps(pipelineId, storage, chains, docMap);

  // Attach gaps to their respective chains
  for (const gap of gaps) {
    const reqId = `${gap.sourceId}:${gap.sourceSectionId}`;
    const chain = chains.find(c => c.requirementId === reqId);
    if (chain) {
      chain.gaps.push(gap);
    }
  }

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
 *
 * Follows trace links transitively through the pipeline levels:
 * PRD -> TDD -> PLAN -> SPEC -> CODE
 *
 * At each level, finds documents that trace from the previous level's
 * document+section via the trace links array.
 */
function buildForwardChain(
  prdId: string,
  sectionId: string,
  prdStatus: string,
  docMap: Map<string, DocInfo>,
  links: TraceLink[],
): TraceChain {
  const chain: TraceChain = {
    requirementId: `${prdId}:${sectionId}`,
    entries: { prd: null, tdd: null, plan: null, spec: null, code: null },
    complete: false,
    gaps: [],
  };

  // PRD entry is always present (it's the source)
  chain.entries.prd = {
    documentId: prdId,
    type: DocumentType.PRD,
    sectionId,
    status: prdStatus,
  };

  // Follow trace links level by level
  // At each level, find documents that trace from the current source document + section
  let currentSourceIds = [prdId];
  let currentSectionId = sectionId;

  // Walk through pipeline levels after PRD
  const levelKeys: (keyof typeof chain.entries)[] = ['tdd', 'plan', 'spec', 'code'];
  const levelTypes = [DocumentType.TDD, DocumentType.PLAN, DocumentType.SPEC, DocumentType.CODE];

  for (let i = 0; i < levelKeys.length; i++) {
    const levelKey = levelKeys[i];
    const targetType = levelTypes[i];

    // Find links from any current source document to target type
    // that trace from the relevant section
    const matchingLinks = links.filter(
      l =>
        currentSourceIds.includes(l.sourceId) &&
        l.sourceSectionId === currentSectionId &&
        l.targetType === targetType,
    );

    if (matchingLinks.length > 0) {
      // Take the first matching link's target as the chain entry
      const target = matchingLinks[0];
      const targetDoc = docMap.get(target.targetId);
      if (targetDoc) {
        chain.entries[levelKey] = {
          documentId: target.targetId,
          type: targetType,
          sectionId: currentSectionId,
          status: targetDoc.status,
        };

        // Update sources for next level: the target becomes the source
        // For the next level, we look for documents that have this target as parent
        // and trace from any of its sections
        currentSourceIds = matchingLinks.map(l => l.targetId);

        // For transitivity, the section being traced shifts:
        // child documents at the next level trace from sections of the current target.
        // We look for any link where the source is in the new currentSourceIds.
        // The sectionId carried forward depends on the child's traces_from.
        // For simplicity of the chain model, we keep the original sectionId
        // since the chain represents a single requirement's journey.
      }
    }
  }

  // Determine completeness: the chain is complete if all levels that exist
  // in the pipeline have entries
  const reachedLevels = new Set<DocumentType>();
  for (const doc of docMap.values()) {
    reachedLevels.add(doc.type);
  }

  let complete = true;
  for (const type of PIPELINE_ORDER) {
    if (!reachedLevels.has(type)) continue;
    const key = type.toLowerCase() as keyof typeof chain.entries;
    if (chain.entries[key] === null) {
      complete = false;
      break;
    }
  }
  chain.complete = complete;

  return chain;
}

/**
 * Recursively flattens a nested sections list into a flat array.
 */
function flattenSectionsList(sections: { id: string; subsections?: any[] }[]): { id: string }[] {
  const result: { id: string }[] = [];
  for (const s of sections) {
    result.push(s);
    if (s.subsections) result.push(...flattenSectionsList(s.subsections));
  }
  return result;
}
