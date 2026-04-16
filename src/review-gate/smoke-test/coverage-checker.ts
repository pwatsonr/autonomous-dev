/**
 * Coverage checker for smoke tests.
 *
 * Validates that every parent section is covered by at least one child
 * document via its `traces_from` mapping. Produces a CoverageMatrix with
 * per-section coverage status, overall coverage percentage, and gap list.
 *
 * Based on SPEC-004-4-1 section 2.
 */

import {
  ParentDocument,
  ChildDocument,
  CoverageMatrix,
  ParentSectionCoverage,
} from './types';

// ---------------------------------------------------------------------------
// CoverageChecker
// ---------------------------------------------------------------------------

export class CoverageChecker {
  /**
   * Checks coverage of parent sections by child documents.
   *
   * For each parent section, determines which children reference it via
   * their `traces_from` mappings.
   *
   * Edge cases:
   * - Parent with 0 sections: returns 100% coverage, pass: true.
   * - Child traces to a nonexistent parent section: warning logged,
   *   not counted as coverage for any parent section.
   * - Multiple children covering the same section: all listed in covered_by.
   */
  check(parent: ParentDocument, children: ChildDocument[]): CoverageMatrix {
    const parentSectionIds = new Set(parent.sections.map((s) => s.id));

    // Warn about children tracing to nonexistent parent sections
    for (const child of children) {
      for (const trace of child.traces_from) {
        if (trace.document_id !== parent.id) {
          continue;
        }
        for (const sectionId of trace.section_ids) {
          if (!parentSectionIds.has(sectionId)) {
            console.warn(
              `CoverageChecker: Child "${child.id}" traces to nonexistent ` +
              `parent section "${sectionId}" in parent "${parent.id}". Ignoring.`
            );
          }
        }
      }
    }

    // Handle parent with 0 sections
    if (parent.sections.length === 0) {
      return {
        parent_id: parent.id,
        parent_sections: [],
        coverage_percentage: 100,
        gaps: [],
        pass: true,
      };
    }

    // Build per-section coverage
    const parentSections: ParentSectionCoverage[] = parent.sections.map((section) => {
      const coveredBy: string[] = [];

      for (const child of children) {
        for (const trace of child.traces_from) {
          if (trace.document_id !== parent.id) {
            continue;
          }
          if (trace.section_ids.includes(section.id)) {
            coveredBy.push(child.id);
            break; // Only count this child once per parent section
          }
        }
      }

      const coverageType = coveredBy.length >= 1 ? 'full' : 'none';

      return {
        section_id: section.id,
        covered_by: coveredBy,
        coverage_type: coverageType,
      } as ParentSectionCoverage;
    });

    // Calculate gaps and coverage percentage
    const gaps = parentSections
      .filter((s) => s.coverage_type === 'none')
      .map((s) => s.section_id);

    const coveredCount = parentSections.filter((s) => s.coverage_type !== 'none').length;
    const totalSections = parentSections.length;
    const coveragePercentage = Math.round((coveredCount / totalSections) * 10000) / 100;

    return {
      parent_id: parent.id,
      parent_sections: parentSections,
      coverage_percentage: coveragePercentage,
      gaps,
      pass: coveragePercentage === 100,
    };
  }
}
