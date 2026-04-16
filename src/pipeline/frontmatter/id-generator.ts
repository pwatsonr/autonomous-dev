import { DocumentType } from '../types/document-type';

/**
 * Interface for the atomic counter backing the ID generator.
 * Injectable for testability (in-memory counter for tests,
 * file-based counter for production).
 */
export interface IdCounter {
  /** Returns and increments the next sequence number for the given scope. */
  next(scope: string): Promise<number>;
}

/**
 * In-memory counter for testing.
 */
export class InMemoryIdCounter implements IdCounter {
  private counters: Map<string, number> = new Map();

  async next(scope: string): Promise<number> {
    const current = this.counters.get(scope) ?? 0;
    const next = current + 1;
    this.counters.set(scope, next);
    return next;
  }
}

/**
 * Generates deterministic document IDs.
 *
 * Format:
 *   Root PRDs: {TYPE}-{SEQ}        e.g. "PRD-001"
 *   Children:  {TYPE}-{PIPE_SEQ}-{DOC_SEQ}  e.g. "TDD-001-01"
 *
 * Where:
 *   TYPE     = DocumentType enum value
 *   SEQ      = 3-digit zero-padded pipeline sequence
 *   PIPE_SEQ = pipeline sequence from pipeline ID (e.g., "001" from "PIPE-2026-0408-001")
 *   DOC_SEQ  = 2-digit zero-padded document sequence within type
 *
 * @param type The document type
 * @param pipelineId The pipeline ID (used to extract PIPE_SEQ)
 * @param counter The counter to use for sequence generation
 * @returns Generated document ID string
 */
export async function generateDocumentId(
  type: DocumentType,
  pipelineId: string,
  counter: IdCounter,
): Promise<string> {
  const pipeSeq = pipelineId.split('-').pop()!; // "001" from "PIPE-2026-0408-001"
  const docSeq = await counter.next(`${pipelineId}:${type}`);

  if (type === DocumentType.PRD) {
    return `PRD-${pipeSeq}`;
  }

  return `${type}-${pipeSeq}-${String(docSeq).padStart(2, '0')}`;
}
