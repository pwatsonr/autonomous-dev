import { QualityRubric } from '../../types/quality-rubric';

/**
 * Quality rubric for PRD (Product Requirements Document) artifacts.
 *
 * 7 categories, weights sum to 1.0, aggregation: mean.
 * Based on TDD Section 3.3.2.
 */
export const PRD_RUBRIC: QualityRubric = {
  documentType: 'PRD',
  version: '1.0',
  aggregationMethod: 'mean',
  categories: [
    {
      id: 'completeness',
      name: 'Completeness',
      description: 'All required sections are present and substantive',
      weight: 0.20,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'Multiple required sections missing or empty' },
        { min: 40, max: 69, description: 'Some sections incomplete or superficial' },
        { min: 70, max: 89, description: 'All sections present with adequate depth' },
        { min: 90, max: 100, description: 'All sections thorough and detailed' },
      ],
    },
    {
      id: 'clarity',
      name: 'Clarity',
      description: 'Requirements are unambiguous and clearly communicated',
      weight: 0.15,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'Requirements are vague, contradictory, or unintelligible' },
        { min: 40, max: 69, description: 'Some requirements are ambiguous or poorly worded' },
        { min: 70, max: 89, description: 'Requirements are clear and understandable' },
        { min: 90, max: 100, description: 'Crystal clear with precise, measurable language throughout' },
      ],
    },
    {
      id: 'feasibility',
      name: 'Feasibility',
      description: 'Requirements are technically achievable within stated constraints',
      weight: 0.15,
      minimumScore: 65,
      scoringGuide: [
        { min: 0, max: 39, description: 'Requirements are unrealistic or technically impossible' },
        { min: 40, max: 69, description: 'Some requirements may be difficult to achieve within constraints' },
        { min: 70, max: 89, description: 'Requirements are achievable with known approaches' },
        { min: 90, max: 100, description: 'Clear implementation path with proven patterns and technologies' },
      ],
    },
    {
      id: 'user_value',
      name: 'User Value',
      description: 'Requirements clearly articulate value to end users',
      weight: 0.15,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'No connection between requirements and user needs' },
        { min: 40, max: 69, description: 'User value implied but not explicitly stated' },
        { min: 70, max: 89, description: 'User value clearly articulated for most requirements' },
        { min: 90, max: 100, description: 'Every requirement tied to specific user outcomes with evidence' },
      ],
    },
    {
      id: 'scope_definition',
      name: 'Scope Definition',
      description: 'Boundaries of what is included and excluded are explicit',
      weight: 0.15,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'No scope boundaries defined; open-ended requirements' },
        { min: 40, max: 69, description: 'Scope partially defined with significant gaps' },
        { min: 70, max: 89, description: 'Clear in-scope and out-of-scope sections with rationale' },
        { min: 90, max: 100, description: 'Precise scope with explicit exclusions and future considerations' },
      ],
    },
    {
      id: 'acceptance_criteria',
      name: 'Acceptance Criteria',
      description: 'Each requirement has testable acceptance criteria',
      weight: 0.10,
      minimumScore: 75,
      scoringGuide: [
        { min: 0, max: 39, description: 'No acceptance criteria defined' },
        { min: 40, max: 69, description: 'Some requirements lack acceptance criteria or criteria are vague' },
        { min: 70, max: 89, description: 'Most requirements have testable acceptance criteria' },
        { min: 90, max: 100, description: 'All requirements have precise, measurable acceptance criteria' },
      ],
    },
    {
      id: 'risk_assessment',
      name: 'Risk Assessment',
      description: 'Known risks are identified with mitigation strategies',
      weight: 0.10,
      minimumScore: 60,
      scoringGuide: [
        { min: 0, max: 39, description: 'No risk assessment or mitigation strategies' },
        { min: 40, max: 69, description: 'Some risks identified but mitigations incomplete' },
        { min: 70, max: 89, description: 'Major risks identified with viable mitigation strategies' },
        { min: 90, max: 100, description: 'Comprehensive risk matrix with prioritized mitigations' },
      ],
    },
  ],
};
