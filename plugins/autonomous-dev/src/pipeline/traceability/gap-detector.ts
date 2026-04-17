import { DocumentType, PIPELINE_ORDER } from '../types/document-type';
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
  docMap: Map<string, { id: string; type: DocumentType; status: string; tracesFrom: string[]; tracesTo: string[]; parentId: string | null }>,
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
