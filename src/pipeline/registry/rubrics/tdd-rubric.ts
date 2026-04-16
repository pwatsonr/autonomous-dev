import { QualityRubric } from '../../types/quality-rubric';

/**
 * Quality rubric for TDD (Technical Design Document) artifacts.
 *
 * 7 categories, weights sum to 1.0, aggregation: mean.
 * Based on TDD Section 3.3.3.
 */
export const TDD_RUBRIC: QualityRubric = {
  documentType: 'TDD',
  version: '1.0',
  aggregationMethod: 'mean',
  categories: [
    {
      id: 'completeness',
      name: 'Completeness',
      description: 'All architectural decisions, interfaces, and data models are documented',
      weight: 0.15,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'Major architectural areas undocumented' },
        { min: 40, max: 69, description: 'Key interfaces or data models missing' },
        { min: 70, max: 89, description: 'All major components documented with adequate detail' },
        { min: 90, max: 100, description: 'Exhaustive coverage of all technical decisions and rationale' },
      ],
    },
    {
      id: 'technical_accuracy',
      name: 'Technical Accuracy',
      description: 'Technical claims are correct and design choices are sound',
      weight: 0.20,
      minimumScore: 75,
      scoringGuide: [
        { min: 0, max: 39, description: 'Fundamental technical errors or impossible designs' },
        { min: 40, max: 69, description: 'Some technical inaccuracies or questionable choices' },
        { min: 70, max: 89, description: 'Technically sound with well-justified decisions' },
        { min: 90, max: 100, description: 'Demonstrably correct with references to proven patterns' },
      ],
    },
    {
      id: 'architecture_quality',
      name: 'Architecture Quality',
      description: 'System architecture follows best practices and is maintainable',
      weight: 0.20,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'Architecture is monolithic, tightly coupled, or unscalable' },
        { min: 40, max: 69, description: 'Architecture has some coupling or scalability concerns' },
        { min: 70, max: 89, description: 'Well-structured architecture with clear separation of concerns' },
        { min: 90, max: 100, description: 'Exemplary architecture with extensibility and evolution paths' },
      ],
    },
    {
      id: 'api_design',
      name: 'API Design',
      description: 'APIs are well-designed, consistent, and developer-friendly',
      weight: 0.15,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'APIs are inconsistent, poorly typed, or undocumented' },
        { min: 40, max: 69, description: 'APIs are functional but lack consistency or ergonomics' },
        { min: 70, max: 89, description: 'APIs are consistent, well-typed, and documented' },
        { min: 90, max: 100, description: 'APIs follow industry best practices with versioning and discoverability' },
      ],
    },
    {
      id: 'error_handling',
      name: 'Error Handling',
      description: 'Error scenarios are identified with clear handling strategies',
      weight: 0.10,
      minimumScore: 65,
      scoringGuide: [
        { min: 0, max: 39, description: 'No error handling strategy defined' },
        { min: 40, max: 69, description: 'Some error paths covered but gaps remain' },
        { min: 70, max: 89, description: 'Comprehensive error handling with recovery strategies' },
        { min: 90, max: 100, description: 'Full error taxonomy with graceful degradation and observability' },
      ],
    },
    {
      id: 'testing_strategy',
      name: 'Testing Strategy',
      description: 'Testing approach covers all layers with clear boundaries',
      weight: 0.10,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'No testing strategy defined' },
        { min: 40, max: 69, description: 'Basic testing approach but missing layers or edge cases' },
        { min: 70, max: 89, description: 'Multi-layer testing strategy with clear boundaries' },
        { min: 90, max: 100, description: 'Comprehensive test pyramid with performance and integration plans' },
      ],
    },
    {
      id: 'security_considerations',
      name: 'Security Considerations',
      description: 'Security threats are identified and addressed in the design',
      weight: 0.10,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 39, description: 'No security considerations documented' },
        { min: 40, max: 69, description: 'Some security concerns noted but not fully addressed' },
        { min: 70, max: 89, description: 'Key security threats identified with mitigations in design' },
        { min: 90, max: 100, description: 'Threat model with defense-in-depth and security review plan' },
      ],
    },
  ],
};
