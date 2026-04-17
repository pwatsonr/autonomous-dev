/**
 * Shared type definitions for the smoke test components.
 *
 * Defines all interfaces used by CoverageChecker, ScopeContainmentChecker,
 * ContradictionDetector, and SmokeTestExecutor.
 *
 * Based on SPEC-004-4-1.
 */

// ---------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------

/** A parent document with identified sections. */
export interface ParentDocument {
  id: string;
  sections: { id: string; title: string; content: string }[];
}

/** A child document with sections and traceability references to the parent. */
export interface ChildDocument {
  id: string;
  sections: { id: string; title: string; content: string }[];
  traces_from: { document_id: string; section_ids: string[] }[];
}

// ---------------------------------------------------------------------------
// Coverage types
// ---------------------------------------------------------------------------

/** Coverage status for a single parent section. */
export interface ParentSectionCoverage {
  section_id: string;
  covered_by: string[];              // child document IDs
  coverage_type: 'full' | 'partial' | 'none';
}

/** Coverage matrix summarising how well children cover the parent. */
export interface CoverageMatrix {
  parent_id: string;
  parent_sections: ParentSectionCoverage[];
  coverage_percentage: number;
  gaps: string[];                     // parent section IDs with no child coverage
  pass: boolean;
}

// ---------------------------------------------------------------------------
// Scope containment types
// ---------------------------------------------------------------------------

/** Configuration for the scope containment check. */
export interface ScopeContainmentConfig {
  creep_threshold_percentage: number;  // default: 20
}

/** Scope containment result across all children. */
export interface ScopeContainmentResult {
  children_with_scope_creep: {
    child_id: string;
    unmapped_sections: string[];
    creep_percentage: number;
  }[];
  pass: boolean;
}

// ---------------------------------------------------------------------------
// Contradiction types
// ---------------------------------------------------------------------------

/** A detected contradiction between two sibling children. */
export interface Contradiction {
  child_a_id: string;
  child_b_id: string;
  entity: string;
  statement_a: string;
  statement_b: string;
  confidence: number;                 // 0-1
}

/** Result of contradiction detection across all sibling children. */
export interface ContradictionResult {
  contradictions: Contradiction[];
  pass: boolean;
}

/**
 * Pluggable interface for Phase 3 AI-agent-based contradiction detection.
 * The heuristic implementation is the default; Phase 3 can provide an
 * AI-agent implementation.
 */
export interface ContradictionDetectionStrategy {
  detect(childA: ChildDocument, childB: ChildDocument): Promise<Contradiction[]>;
}

// ---------------------------------------------------------------------------
// Smoke test orchestration types
// ---------------------------------------------------------------------------

/** Configuration for the smoke test executor. */
export interface SmokeTestConfig {
  max_iterations: number;             // default: 2
  scope_creep_threshold: number;      // default: 20
}

/** Complete result of a smoke test execution. */
export interface SmokeTestResult {
  smoke_test_id: string;
  parent_document_id: string;
  parent_document_version: string;
  child_document_ids: string[];
  timestamp: string;
  coverage: CoverageMatrix & { pass: boolean };
  scope_containment: ScopeContainmentResult;
  contradiction_detection: ContradictionResult;
  overall_pass: boolean;
  iteration: number;
  max_iterations: number;
}
