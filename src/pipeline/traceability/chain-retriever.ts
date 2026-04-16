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
