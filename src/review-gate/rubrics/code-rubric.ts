import type { Rubric } from '../types';

/**
 * Hardcoded rubric for Code artifact review gates.
 *
 * 7 categories, weights sum to 100, approval threshold 85.
 * Based on TDD-004 section 3.2.6.
 */
export const CODE_RUBRIC: Rubric = {
  document_type: 'Code',
  version: '1.0.0',
  approval_threshold: 85,
  total_weight: 100,
  categories: [
    {
      id: 'spec_compliance',
      name: 'Spec Compliance',
      weight: 25,
      description:
        'Implementation matches the specification exactly with no deviations.',
      min_threshold: 80,
      calibration: {
        score_0:
          'Implementation bears no resemblance to the specification.',
        score_50:
          'Core functionality matches the spec but some items are implemented incorrectly or missing.',
        score_100:
          'Every spec item is implemented exactly as specified with documented rationale for any intentional deviations.',
      },
    },
    {
      id: 'test_coverage',
      name: 'Test Coverage',
      weight: 20,
      description:
        'Tests cover all specified behaviors, edge cases, and error paths.',
      min_threshold: 70,
      calibration: {
        score_0:
          'No tests written, or tests do not execute.',
        score_50:
          'Happy path tests pass but edge cases and error paths are untested.',
        score_100:
          'Comprehensive test suite covering all behaviors, edge cases, error paths, and boundary conditions with high coverage metrics.',
      },
    },
    {
      id: 'code_quality',
      name: 'Code Quality',
      weight: 15,
      description:
        'Code follows project standards, is readable, well-structured, and maintainable.',
      min_threshold: 60,
      calibration: {
        score_0:
          'Code is unreadable, violates all project standards, or is unmaintainable.',
        score_50:
          'Code is mostly readable but has style issues, code smells, or inconsistent patterns.',
        score_100:
          'Exemplary code with clear abstractions, consistent style, comprehensive documentation, and no code smells.',
      },
    },
    {
      id: 'documentation_completeness',
      name: 'Documentation Completeness',
      weight: 10,
      description:
        'Code is documented with JSDoc, inline comments, and usage examples where appropriate.',
      min_threshold: 50,
      calibration: {
        score_0:
          'No documentation or comments of any kind.',
        score_50:
          'Some functions documented but public APIs or complex logic lack comments.',
        score_100:
          'All public APIs have JSDoc, complex logic has inline comments, and usage examples are provided.',
      },
    },
    {
      id: 'performance',
      name: 'Performance',
      weight: 10,
      description:
        'Code meets performance requirements and avoids unnecessary overhead.',
      min_threshold: 50,
      calibration: {
        score_0:
          'Severe performance issues; O(n^2+) where O(n) is possible, or memory leaks present.',
        score_50:
          'Acceptable performance but obvious optimization opportunities are missed.',
        score_100:
          'Optimized implementation meeting all performance targets with benchmarks documenting results.',
      },
    },
    {
      id: 'security',
      name: 'Security',
      weight: 10,
      description:
        'Code follows security best practices with no known vulnerabilities.',
      min_threshold: 60,
      calibration: {
        score_0:
          'Code has critical security vulnerabilities (injection, exposed secrets, no auth).',
        score_50:
          'Basic security measures in place but some best practices are not followed.',
        score_100:
          'Follows all security best practices, input validation everywhere, no exposed secrets, and defense-in-depth.',
      },
    },
    {
      id: 'maintainability',
      name: 'Maintainability',
      weight: 10,
      description:
        'Code is easy to understand, modify, and extend by other developers.',
      min_threshold: 50,
      calibration: {
        score_0:
          'Code is a tangled mess that no one else could understand or modify.',
        score_50:
          'Code is understandable with effort but refactoring would be needed for extensions.',
        score_100:
          'Code is modular, well-named, follows SOLID principles, and has clear extension points.',
      },
    },
  ],
};
