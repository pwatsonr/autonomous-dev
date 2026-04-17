import type { Rubric } from '../types';

/**
 * Hardcoded rubric for Plan (Implementation Plan) review gates.
 *
 * 6 categories, weights sum to 100, approval threshold 80.
 * Based on TDD-004 section 3.2.4.
 */
export const PLAN_RUBRIC: Rubric = {
  document_type: 'Plan',
  version: '1.0.0',
  approval_threshold: 80,
  total_weight: 100,
  categories: [
    {
      id: 'work_unit_granularity',
      name: 'Work Unit Granularity',
      weight: 20,
      description:
        'Tasks are appropriately sized for single implementation units, neither too large nor too granular.',
      min_threshold: 60,
      calibration: {
        score_0:
          'No task breakdown exists, or tasks are monolithic multi-day efforts with no decomposition.',
        score_50:
          'Tasks are defined but some are too large for a single session or too granular to be meaningful.',
        score_100:
          'Every task is optimally sized for a single implementation session with clear inputs, outputs, and completion criteria.',
      },
    },
    {
      id: 'dependency_accuracy',
      name: 'Dependency Accuracy',
      weight: 20,
      description:
        'Task dependencies and ordering are explicit, correct, and free of cycles.',
      min_threshold: 70,
      calibration: {
        score_0:
          'No dependencies documented, or dependencies are circular or contradictory.',
        score_50:
          'Some dependencies listed but implicit dependencies are missed or ordering has gaps.',
        score_100:
          'Complete dependency graph with no cycles, verified ordering, and explicit rationale for each dependency.',
      },
    },
    {
      id: 'test_strategy_coverage',
      name: 'Test Strategy Coverage',
      weight: 15,
      description:
        'Testing approach covers all layers and is mapped to implementation tasks.',
      min_threshold: 60,
      calibration: {
        score_0:
          'No testing strategy defined or testing is an afterthought.',
        score_50:
          'Basic test plan exists but lacks mapping to tasks or misses layers (unit, integration, e2e).',
        score_100:
          'Comprehensive test strategy with per-task test requirements, coverage targets, and multi-layer approach.',
      },
    },
    {
      id: 'effort_estimation',
      name: 'Effort Estimation',
      weight: 15,
      description:
        'Effort estimates are realistic and account for complexity and unknowns.',
      min_threshold: 50,
      calibration: {
        score_0:
          'No estimates provided, or estimates are wildly unrealistic.',
        score_50:
          'Estimates are present but may be overly optimistic or lack complexity factors.',
        score_100:
          'Data-backed estimates with complexity factors, contingency buffers, and historical comparison.',
      },
    },
    {
      id: 'tdd_alignment',
      name: 'TDD Alignment',
      weight: 15,
      description:
        'All TDD components are represented as tasks with explicit traceability.',
      min_threshold: 70,
      calibration: {
        score_0:
          'No reference to the TDD; plan appears disconnected from technical design.',
        score_50:
          'Plan mentions the TDD but lacks explicit mapping between tasks and design components.',
        score_100:
          'Every TDD component is mapped to implementation tasks with bidirectional traceability.',
      },
    },
    {
      id: 'risk_awareness',
      name: 'Risk Awareness',
      weight: 15,
      description:
        'Implementation risks are identified with contingency plans and escalation paths.',
      min_threshold: 50,
      calibration: {
        score_0:
          'No implementation risks identified.',
        score_50:
          'Some risks noted but contingency plans are missing or vague.',
        score_100:
          'Comprehensive risk register with prioritized contingencies, escalation paths, and risk-adjusted estimates.',
      },
    },
  ],
};
