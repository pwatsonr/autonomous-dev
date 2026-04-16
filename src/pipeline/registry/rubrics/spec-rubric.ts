import { QualityRubric } from '../../types/quality-rubric';

/**
 * Quality rubric for SPEC (Implementation Specification) artifacts.
 *
 * 6 categories, weights sum to 1.0, aggregation: mean.
 * Based on TDD Section 3.3.5.
 */
export const SPEC_RUBRIC: QualityRubric = {
  documentType: 'SPEC',
  version: '1.0',
  aggregationMethod: 'mean',
  categories: [
    {
      id: 'precision',
      name: 'Precision',
      description: 'Specifications are exact enough for direct code translation',
      weight: 0.25,
      minimumScore: 75,
      scoringGuide: [
        { min: 0, max: 39, description: 'Specifications require significant interpretation' },
        { min: 40, max: 69, description: 'Some areas are open to interpretation' },
        { min: 70, max: 89, description: 'Clear enough for implementation with minimal questions' },
        { min: 90, max: 100, description: 'Pseudo-code-level precision throughout' },
      ],
    },
    {
      id: 'completeness',
      name: 'Completeness',
      description: 'All plan tasks are fully specified with implementation details',
      weight: 0.20,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'Major implementation details missing' },
        { min: 40, max: 69, description: 'Some tasks lack full specification' },
        { min: 70, max: 89, description: 'All tasks specified with adequate detail' },
        { min: 90, max: 100, description: 'Exhaustive specification ready for coding' },
      ],
    },
    {
      id: 'testability',
      name: 'Testability',
      description: 'Test cases and acceptance criteria are defined for each task',
      weight: 0.20,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'No test cases or acceptance criteria defined' },
        { min: 40, max: 69, description: 'Some tasks missing test definitions' },
        { min: 70, max: 89, description: 'Test cases defined for all major tasks' },
        { min: 90, max: 100, description: 'Comprehensive test matrix with edge cases and error paths' },
      ],
    },
    {
      id: 'api_contracts',
      name: 'API Contracts',
      description: 'API interfaces, types, and contracts are precisely defined',
      weight: 0.15,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'API contracts are missing or undefined' },
        { min: 40, max: 69, description: 'Some API contracts are incomplete or loosely typed' },
        { min: 70, max: 89, description: 'API contracts are well-defined with types and examples' },
        { min: 90, max: 100, description: 'Full contract definitions with validation rules and edge cases' },
      ],
    },
    {
      id: 'error_handling',
      name: 'Error Handling',
      description: 'Error scenarios are specified with expected behaviors',
      weight: 0.10,
      minimumScore: 65,
      scoringGuide: [
        { min: 0, max: 39, description: 'No error handling specifications' },
        { min: 40, max: 69, description: 'Some error paths specified but gaps remain' },
        { min: 70, max: 89, description: 'Error scenarios documented with expected behaviors' },
        { min: 90, max: 100, description: 'Complete error catalog with recovery and fallback behaviors' },
      ],
    },
    {
      id: 'implementation_guidance',
      name: 'Implementation Guidance',
      description: 'Sufficient guidance for developers to implement without design decisions',
      weight: 0.10,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 39, description: 'No implementation guidance provided' },
        { min: 40, max: 69, description: 'Some guidance but significant design decisions left to developer' },
        { min: 70, max: 89, description: 'Clear guidance that minimizes implementation ambiguity' },
        { min: 90, max: 100, description: 'Step-by-step guidance with code patterns and examples' },
      ],
    },
  ],
};
