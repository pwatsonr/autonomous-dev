import { QualityRubric } from '../../types/quality-rubric';

/**
 * Quality rubric for CODE artifacts.
 *
 * 7 categories, weights sum to 1.0, aggregation: mean.
 * Based on TDD Section 3.3.6.
 */
export const CODE_RUBRIC: QualityRubric = {
  documentType: 'CODE',
  version: '1.0',
  aggregationMethod: 'mean',
  categories: [
    {
      id: 'correctness',
      name: 'Correctness',
      description: 'Code produces correct results for all specified inputs and scenarios',
      weight: 0.20,
      minimumScore: 80,
      scoringGuide: [
        { min: 0, max: 39, description: 'Fundamental logic errors or crashes' },
        { min: 40, max: 69, description: 'Works for happy path but edge cases fail' },
        { min: 70, max: 89, description: 'Correct for all specified scenarios' },
        { min: 90, max: 100, description: 'Provably correct with defensive handling and invariant checks' },
      ],
    },
    {
      id: 'test_coverage',
      name: 'Test Coverage',
      description: 'Tests cover all specified behaviors, edge cases, and error paths',
      weight: 0.15,
      minimumScore: 75,
      scoringGuide: [
        { min: 0, max: 39, description: 'Minimal or no tests' },
        { min: 40, max: 69, description: 'Happy path covered but edge cases missing' },
        { min: 70, max: 89, description: 'Good coverage of specified behaviors and common edge cases' },
        { min: 90, max: 100, description: 'Comprehensive coverage with edge cases, error paths, and property tests' },
      ],
    },
    {
      id: 'code_quality',
      name: 'Code Quality',
      description: 'Code follows project standards, is readable, and maintainable',
      weight: 0.15,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'Unreadable, violates project standards, or unmaintainable' },
        { min: 40, max: 69, description: 'Mostly readable with some style issues or code smells' },
        { min: 70, max: 89, description: 'Clean, well-structured code that follows project standards' },
        { min: 90, max: 100, description: 'Exemplary code with clear abstractions and documentation' },
      ],
    },
    {
      id: 'spec_conformance',
      name: 'Spec Conformance',
      description: 'Implementation matches the specification exactly',
      weight: 0.15,
      minimumScore: 75,
      scoringGuide: [
        { min: 0, max: 39, description: 'Significant deviations from specification' },
        { min: 40, max: 69, description: 'Some spec items not implemented or implemented incorrectly' },
        { min: 70, max: 89, description: 'All spec items implemented correctly' },
        { min: 90, max: 100, description: 'Exact spec compliance with documented rationale for any deviations' },
      ],
    },
    {
      id: 'error_handling',
      name: 'Error Handling',
      description: 'Errors are handled gracefully with appropriate logging and recovery',
      weight: 0.10,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'Errors are swallowed, ignored, or cause crashes' },
        { min: 40, max: 69, description: 'Basic error handling but missing edge cases or logging' },
        { min: 70, max: 89, description: 'Proper error handling with logging and user-facing messages' },
        { min: 90, max: 100, description: 'Robust error handling with recovery, retry, and observability' },
      ],
    },
    {
      id: 'documentation',
      name: 'Documentation',
      description: 'Code is documented with JSDoc, inline comments, and usage examples',
      weight: 0.10,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 39, description: 'No documentation or comments' },
        { min: 40, max: 69, description: 'Some documentation but key functions or modules undocumented' },
        { min: 70, max: 89, description: 'Public APIs documented with JSDoc and key logic commented' },
        { min: 90, max: 100, description: 'Comprehensive documentation with usage examples and design notes' },
      ],
    },
    {
      id: 'performance',
      name: 'Performance',
      description: 'Code meets performance requirements and avoids unnecessary overhead',
      weight: 0.15,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 39, description: 'Severe performance issues or O(n^2+) where O(n) is possible' },
        { min: 40, max: 69, description: 'Acceptable performance but optimization opportunities missed' },
        { min: 70, max: 89, description: 'Efficient implementation meeting performance requirements' },
        { min: 90, max: 100, description: 'Optimized with benchmarks and performance documentation' },
      ],
    },
  ],
};
