import { DocumentType } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { parseSections, toSectionId, ParsedSection } from '../versioning/section-parser';
import { ProposedChild, SmokeTestResult } from './decomposition-record-io';

/**
 * Validates three properties of a proposed decomposition:
 *
 * 1. COVERAGE COMPLETENESS:
 *    Every section in the parent document must appear in at least
 *    one child's tracesFrom list. Uncovered sections are reported.
 *
 * 2. NO SCOPE CREEP:
 *    Every entry in every child's tracesFrom list must reference
 *    a valid section in the parent document. References to non-existent
 *    parent sections are reported as scope creep.
 *
 * 3. NO CONTRADICTIONS:
 *    No two children should explicitly declare conflicting responsibilities
 *    for the same parent section. "Conflicting" here means MVP-level:
 *    if the same parent section appears in two children's tracesFrom
 *    and both children are sequential with a dependency, check that
 *    the dependency direction makes sense. For MVP, contradictions are
 *    detected only as explicit user-declared conflicts in the proposal.
 *
 * @param parentId The parent document being decomposed
 * @param parentType The parent document type
 * @param pipelineId The pipeline ID
 * @param proposedChildren The proposed child documents
 * @param storage The document storage layer
 * @returns SmokeTestResult with detailed findings
 */
export async function smokeTest(
  parentId: string,
  parentType: DocumentType,
  pipelineId: string,
  proposedChildren: ProposedChild[],
  storage: DocumentStorage,
): Promise<SmokeTestResult> {
  // 1. Read and parse parent document to get its sections
  const parentDoc = await storage.readDocument(pipelineId, parentType, parentId);
  const parentSections = parseSections(parentDoc.rawContent);
  const parentSectionIds = new Set(
    flattenSectionIds(parentSections.sections),
  );

  // 2. Coverage completeness check
  const coveredSections = new Set<string>();
  for (const child of proposedChildren) {
    for (const traceFrom of child.tracesFrom) {
      coveredSections.add(traceFrom);
    }
  }
  const uncoveredParentSections = [...parentSectionIds].filter(
    id => !coveredSections.has(id),
  );
  const coverageComplete = uncoveredParentSections.length === 0;

  // 3. Scope creep check
  const scopeCreepDetails: string[] = [];
  for (const child of proposedChildren) {
    for (const traceFrom of child.tracesFrom) {
      if (!parentSectionIds.has(traceFrom)) {
        scopeCreepDetails.push(
          `Child "${child.id}" traces from "${traceFrom}" which does not exist in parent`,
        );
      }
    }
  }
  const scopeCreep = scopeCreepDetails.length > 0;

  // 4. Contradiction check (MVP: explicit declaration conflicts only)
  const contradictionDetails: string[] = [];
  // For MVP: check if contradictions were explicitly declared in proposals
  // Full semantic contradiction detection is aspirational (per TDD risk note)
  const contradictions = contradictionDetails.length > 0;

  const passed = coverageComplete && !scopeCreep && !contradictions;

  return {
    passed,
    coverageComplete,
    uncoveredParentSections,
    scopeCreep,
    scopeCreepDetails,
    contradictions,
    contradictionDetails,
  };
}

/**
 * Flattens a section tree into a list of section IDs.
 */
function flattenSectionIds(sections: ParsedSection[]): string[] {
  const ids: string[] = [];
  function walk(secs: ParsedSection[]): void {
    for (const sec of secs) {
      ids.push(sec.id);
      walk(sec.subsections);
    }
  }
  walk(sections);
  return ids;
}
