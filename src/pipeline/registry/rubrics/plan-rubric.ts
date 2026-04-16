import { QualityRubric } from '../../types/quality-rubric';

/**
 * Quality rubric for PLAN (Implementation Plan) artifacts.
 *
 * 6 categories, weights sum to 1.0, aggregation: mean.
 * Based on TDD Section 3.3.4.
 */
export const PLAN_RUBRIC: QualityRubric = {
  documentType: 'PLAN',
  version: '1.0',
  aggregationMethod: 'mean',
  categories: [
    {
      id: 'task_granularity',
      name: 'Task Granularity',
      description: 'Tasks are appropriately sized for single implementation units',
      weight: 0.20,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'Tasks are far too large or absurdly granular' },
        { min: 40, max: 69, description: 'Some tasks need further decomposition or merging' },
        { min: 70, max: 89, description: 'Tasks are well-sized for single implementation sessions' },
        { min: 90, max: 100, description: 'Optimal granularity with clear, atomic work units' },
      ],
    },
    {
      id: 'dependency_accuracy',
      name: 'Dependency Accuracy',
      description: 'Task dependencies and ordering are explicit and correct',
      weight: 0.20,
      minimumScore: 75,
      scoringGuide: [
        { min: 0, max: 39, description: 'Dependencies are missing, circular, or contradictory' },
        { min: 40, max: 69, description: 'Some implicit dependencies not captured or ordering issues' },
        { min: 70, max: 89, description: 'Dependencies are explicit with correct ordering' },
        { min: 90, max: 100, description: 'Complete dependency graph verified with no cycles' },
      ],
    },
    {
      id: 'effort_estimation',
      name: 'Effort Estimation',
      description: 'Effort estimates are realistic and account for complexity',
      weight: 0.15,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 39, description: 'Estimates are missing or wildly unrealistic' },
        { min: 40, max: 69, description: 'Estimates present but may be overly optimistic' },
        { min: 70, max: 89, description: 'Realistic estimates with complexity factors considered' },
        { min: 90, max: 100, description: 'Data-backed estimates with contingency buffers' },
      ],
    },
    {
      id: 'completeness',
      name: 'Completeness',
      description: 'All TDD requirements are represented as tasks in the plan',
      weight: 0.15,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'Significant TDD requirements missing from plan' },
        { min: 40, max: 69, description: 'Some TDD items not represented in tasks' },
        { min: 70, max: 89, description: 'All major TDD items have corresponding tasks' },
        { min: 90, max: 100, description: 'Complete bidirectional TDD-to-task mapping' },
      ],
    },
    {
      id: 'risk_identification',
      name: 'Risk Identification',
      description: 'Implementation risks are identified with contingency plans',
      weight: 0.15,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 39, description: 'No implementation risks identified' },
        { min: 40, max: 69, description: 'Some risks noted but contingency plans missing' },
        { min: 70, max: 89, description: 'Key risks identified with viable contingency plans' },
        { min: 90, max: 100, description: 'Comprehensive risk register with prioritized contingencies' },
      ],
    },
    {
      id: 'acceptance_criteria',
      name: 'Acceptance Criteria',
      description: 'Each task has clear, testable acceptance criteria',
      weight: 0.15,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'No acceptance criteria defined for tasks' },
        { min: 40, max: 69, description: 'Some tasks lack acceptance criteria or criteria are vague' },
        { min: 70, max: 89, description: 'Most tasks have testable acceptance criteria' },
        { min: 90, max: 100, description: 'All tasks have precise, verifiable acceptance criteria' },
      ],
    },
  ],
};
