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
