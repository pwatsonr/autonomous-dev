import type { Rubric } from '../types';

/**
 * Hardcoded rubric for PRD (Product Requirements Document) review gates.
 *
 * 7 categories, weights sum to 100, approval threshold 85.
 * Calibration examples for problem_clarity, requirements_completeness,
 * and requirements_testability are verbatim from TDD-004 section 3.2.2.
 */
export const PRD_RUBRIC: Rubric = {
  document_type: 'PRD',
  version: '1.0.0',
  approval_threshold: 85,
  total_weight: 100,
  categories: [
    {
      id: 'problem_clarity',
      name: 'Problem Clarity',
      weight: 15,
      description:
        'The problem statement is specific, scoped, and supported by evidence or user research.',
      min_threshold: 60,
      calibration: {
        score_0:
          'No problem statement exists, or the statement is a single vague sentence with no supporting evidence.',
        score_50:
          'Problem is stated but lacks specificity; no data, user quotes, or metrics support it.',
        score_100:
          'Problem is precisely scoped with quantified impact, supported by user research or data, and clearly distinguishes symptoms from root causes.',
      },
    },
    {
      id: 'goals_measurability',
      name: 'Goals Measurability',
      weight: 15,
      description:
        'Goals are specific, measurable, achievable, relevant, and time-bound (SMART).',
      min_threshold: 60,
      calibration: {
        score_0:
          'No goals defined, or goals are vague aspirations with no measurable criteria.',
        score_50:
          'Goals are stated but lack quantified success criteria or timelines.',
        score_100:
          'Every goal has quantified success metrics, clear timelines, and explicit measurement methodology.',
      },
    },
    {
      id: 'user_story_coverage',
      name: 'User Story Coverage',
      weight: 15,
      description:
        'User stories cover all personas and key workflows with acceptance criteria.',
      min_threshold: 60,
      calibration: {
        score_0:
          'No user stories or personas identified.',
        score_50:
          'Some user stories exist but not all personas or key workflows are covered.',
        score_100:
          'Comprehensive user stories for every persona and workflow, each with clear acceptance criteria and edge cases.',
      },
    },
    {
      id: 'requirements_completeness',
      name: 'Requirements Completeness',
      weight: 20,
      description:
        'All functional and non-functional requirements are enumerated with no gaps.',
      min_threshold: 70,
      calibration: {
        score_0:
          'Requirements section is missing or contains only a handful of bullet points with no detail.',
        score_50:
          'Core functional requirements listed but non-functional requirements (performance, security, accessibility) are absent or superficial.',
        score_100:
          'Every functional requirement has a unique ID, priority, and acceptance criterion; non-functional requirements specify measurable targets (e.g., p99 latency < 200ms).',
      },
    },
    {
      id: 'requirements_testability',
      name: 'Requirements Testability',
      weight: 15,
      description:
        'Each requirement can be verified through a concrete test or measurable criterion.',
      min_threshold: 60,
      calibration: {
        score_0:
          'Requirements are subjective or unmeasurable (e.g., "the system should be fast").',
        score_50:
          'Some requirements have testable criteria but others remain vague or subjective.',
        score_100:
          'Every requirement has an explicit, automatable acceptance test or a quantified metric with a defined measurement method.',
      },
    },
    {
      id: 'risk_identification',
      name: 'Risk Identification',
      weight: 10,
      description:
        'Known risks are identified with likelihood, impact, and mitigation strategies.',
      min_threshold: 50,
      calibration: {
        score_0:
          'No risks identified or risk section is absent.',
        score_50:
          'Some risks listed but without likelihood, impact assessment, or mitigation strategies.',
        score_100:
          'Comprehensive risk register with likelihood/impact matrix, prioritized mitigations, and contingency plans for each risk.',
      },
    },
    {
      id: 'internal_consistency',
      name: 'Internal Consistency',
      weight: 10,
      description:
        'Requirements, goals, and user stories are internally consistent with no contradictions.',
      min_threshold: 50,
      calibration: {
        score_0:
          'Contradictions exist between sections; goals conflict with requirements or user stories.',
        score_50:
          'Mostly consistent but some minor contradictions or ambiguous overlaps between sections.',
        score_100:
          'Fully consistent document with explicit cross-references between goals, requirements, and user stories; no contradictions.',
      },
    },
  ],
};
