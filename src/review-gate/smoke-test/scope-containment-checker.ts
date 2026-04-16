/**
 * Scope containment checker for smoke tests.
 *
 * Detects child document sections that are not traceable to any parent
 * section, indicating scope creep. Reports per-child creep percentage
 * and evaluates against a configurable threshold.
 *
 * Scope creep is a warning, not a blocking failure in the overall smoke test.
 *
 * Based on SPEC-004-4-1 section 3.
 */

import {
  ParentDocument,
  ChildDocument,
  ScopeContainmentConfig,
  ScopeContainmentResult,
} from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ScopeContainmentConfig = {
  creep_threshold_percentage: 20,
};

// ---------------------------------------------------------------------------
// ScopeContainmentChecker
// ---------------------------------------------------------------------------

export class ScopeContainmentChecker {
  /**
   * Checks scope containment for all children against the parent document.
   *
   * For each child, determines which of its sections do not trace back to
   * any parent section. Sections like "Introduction" or "Overview" in
   * children that don't map to a specific parent section are expected;
   * the 20% default threshold accommodates this.
   *
   * Edge cases:
   * - Child with 0 sections: creep_percentage is 0, not flagged.
   */
  check(
    parent: ParentDocument,
    children: ChildDocument[],
    config?: Partial<ScopeContainmentConfig>
  ): ScopeContainmentResult {
    const mergedConfig: ScopeContainmentConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    const childrenWithScopeCreep: ScopeContainmentResult['children_with_scope_creep'] = [];

    for (const child of children) {
      // Child with 0 sections: creep_percentage 0, not flagged
      if (child.sections.length === 0) {
        continue;
      }

      // Build the set of child section IDs that are mapped to the parent.
      // traces_from.section_ids lists the child section IDs that trace back
      // to the parent document. A child section is "unmapped" if its ID does
      // not appear in any traces_from entry for this parent.
      const mappedChildSectionIds = new Set<string>();
      for (const trace of child.traces_from) {
        if (trace.document_id === parent.id) {
          for (const sectionId of trace.section_ids) {
            mappedChildSectionIds.add(sectionId);
          }
        }
      }

      const unmappedSections: string[] = [];
      for (const section of child.sections) {
        if (!mappedChildSectionIds.has(section.id)) {
          unmappedSections.push(section.id);
        }
      }

      const creepPercentage =
        Math.round((unmappedSections.length / child.sections.length) * 10000) / 100;

      if (unmappedSections.length > 0) {
        childrenWithScopeCreep.push({
          child_id: child.id,
          unmapped_sections: unmappedSections,
          creep_percentage: creepPercentage,
        });
      }
    }

    // pass = ALL children have creep_percentage <= threshold
    const pass = childrenWithScopeCreep.every(
      (c) => c.creep_percentage <= mergedConfig.creep_threshold_percentage
    );

    return {
      children_with_scope_creep: childrenWithScopeCreep,
      pass,
    };
  }
}
