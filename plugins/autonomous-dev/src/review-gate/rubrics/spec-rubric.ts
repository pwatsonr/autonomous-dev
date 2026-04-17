import type { Rubric } from '../types';

/**
 * Hardcoded rubric for Spec (Implementation Specification) review gates.
 *
 * 6 categories, weights sum to 100, approval threshold 80.
 * Based on TDD-004 section 3.2.5.
 */
export const SPEC_RUBRIC: Rubric = {
  document_type: 'Spec',
  version: '1.0.0',
  approval_threshold: 80,
  total_weight: 100,
  categories: [
    {
      id: 'acceptance_criteria_precision',
      name: 'Acceptance Criteria Precision',
      weight: 25,
      description:
        'Acceptance criteria are precise, unambiguous, and directly testable.',
      min_threshold: 70,
      calibration: {
        score_0:
          'No acceptance criteria defined, or criteria are subjective and untestable.',
        score_50:
          'Acceptance criteria exist but some are vague or lack measurable thresholds.',
        score_100:
          'Every acceptance criterion is precise, quantified, and directly translatable into automated tests.',
      },
    },
    {
      id: 'file_path_accuracy',
      name: 'File Path Accuracy',
      weight: 15,
      description:
        'File paths referenced in the spec are accurate and follow project conventions.',
      min_threshold: 60,
      calibration: {
        score_0:
          'No file paths specified, or paths are incorrect or use non-existent directories.',
        score_50:
          'File paths are mostly correct but some reference wrong locations or violate naming conventions.',
        score_100:
          'All file paths are verified, follow project conventions, and are organized in a logical structure.',
      },
    },
    {
      id: 'test_case_coverage',
      name: 'Test Case Coverage',
      weight: 20,
      description:
        'Test cases cover happy paths, edge cases, error paths, and boundary conditions.',
      min_threshold: 60,
      calibration: {
        score_0:
          'No test cases defined.',
        score_50:
          'Happy path tests exist but edge cases, error paths, and boundary conditions are missing.',
        score_100:
          'Comprehensive test matrix covering happy paths, edge cases, error paths, boundary conditions, and performance scenarios.',
      },
    },
    {
      id: 'code_pattern_clarity',
      name: 'Code Pattern Clarity',
      weight: 15,
      description:
        'Code patterns and implementation approaches are clearly described with examples.',
      min_threshold: 50,
      calibration: {
        score_0:
          'No guidance on code patterns or implementation approach.',
        score_50:
          'Patterns mentioned at a high level but lack concrete examples or implementation detail.',
        score_100:
          'Clear code patterns with concrete examples, type signatures, and step-by-step implementation guidance.',
      },
    },
    {
      id: 'plan_alignment',
      name: 'Plan Alignment',
      weight: 15,
      description:
        'Spec items trace directly to plan tasks with no gaps or orphans.',
      min_threshold: 70,
      calibration: {
        score_0:
          'No reference to the implementation plan; spec appears disconnected.',
        score_50:
          'Spec references the plan but some tasks are missing or mapping is incomplete.',
        score_100:
          'Every spec item maps to a plan task with bidirectional traceability and no orphaned items.',
      },
    },
    {
      id: 'dependency_completeness',
      name: 'Dependency Completeness',
      weight: 10,
      description:
        'All dependencies (libraries, APIs, services) are identified with version constraints.',
      min_threshold: 50,
      calibration: {
        score_0:
          'No dependencies listed or external requirements undocumented.',
        score_50:
          'Major dependencies listed but version constraints or transitive dependencies are missing.',
        score_100:
          'All dependencies documented with version constraints, compatibility notes, and fallback options.',
      },
    },
  ],
};
