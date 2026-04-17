import type { Rubric } from '../types';

/**
 * Hardcoded rubric for TDD (Technical Design Document) review gates.
 *
 * 7 categories, weights sum to 100, approval threshold 85.
 * Calibration examples for architecture_soundness, tradeoff_rigor,
 * and prd_alignment are verbatim from TDD-004 section 3.2.3.
 */
export const TDD_RUBRIC: Rubric = {
  document_type: 'TDD',
  version: '1.0.0',
  approval_threshold: 85,
  total_weight: 100,
  categories: [
    {
      id: 'architecture_soundness',
      name: 'Architecture Soundness',
      weight: 20,
      description:
        'Architecture is well-structured, scalable, and follows established patterns.',
      min_threshold: 70,
      calibration: {
        score_0:
          'No architecture described, or the design is a monolith with no separation of concerns.',
        score_50:
          'Architecture is described at a high level but lacks detail on component boundaries, scaling strategy, or failure domains.',
        score_100:
          'Architecture has clear component boundaries, explicit scaling strategy, defined failure domains, and references to proven patterns with rationale for each choice.',
      },
    },
    {
      id: 'tradeoff_rigor',
      name: 'Tradeoff Rigor',
      weight: 15,
      description:
        'Design tradeoffs are explicitly stated with alternatives considered and rationale documented.',
      min_threshold: 60,
      calibration: {
        score_0:
          'No tradeoffs discussed; design decisions appear arbitrary with no alternatives considered.',
        score_50:
          'Some tradeoffs mentioned but alternatives are not evaluated or rationale is superficial.',
        score_100:
          'Every major design decision includes at least two alternatives with pros/cons, quantified evaluation criteria, and clear rationale for the chosen approach.',
      },
    },
    {
      id: 'data_model_integrity',
      name: 'Data Model Integrity',
      weight: 15,
      description:
        'Data models are complete, normalized appropriately, and support all identified use cases.',
      min_threshold: 60,
      calibration: {
        score_0:
          'No data model defined, or the model is absent of relationships and constraints.',
        score_50:
          'Data model exists but has gaps in relationships, missing constraints, or unclear normalization.',
        score_100:
          'Complete data model with all entities, relationships, constraints, indexes, and migration strategy documented.',
      },
    },
    {
      id: 'api_contract_completeness',
      name: 'API Contract Completeness',
      weight: 15,
      description:
        'All API contracts are fully defined with types, error codes, and versioning strategy.',
      min_threshold: 60,
      calibration: {
        score_0:
          'No API contracts defined or only informal descriptions of endpoints.',
        score_50:
          'API endpoints listed but missing type definitions, error codes, or versioning.',
        score_100:
          'All APIs have complete type definitions, documented error codes, versioning strategy, and example request/response pairs.',
      },
    },
    {
      id: 'integration_robustness',
      name: 'Integration Robustness',
      weight: 10,
      description:
        'Integration points are identified with error handling, retry, and fallback strategies.',
      min_threshold: 50,
      calibration: {
        score_0:
          'No integration points identified or external dependencies undocumented.',
        score_50:
          'Integration points listed but lacking error handling or retry strategies.',
        score_100:
          'All integration points documented with circuit breakers, retry policies, fallback strategies, and SLA expectations.',
      },
    },
    {
      id: 'security_depth',
      name: 'Security Depth',
      weight: 10,
      description:
        'Security threats are identified with defense-in-depth mitigations.',
      min_threshold: 50,
      calibration: {
        score_0:
          'No security analysis or threat modeling performed.',
        score_50:
          'Basic security concerns noted but no formal threat model or defense strategy.',
        score_100:
          'Complete threat model with STRIDE analysis, defense-in-depth mitigations, and security review checklist.',
      },
    },
    {
      id: 'prd_alignment',
      name: 'PRD Alignment',
      weight: 15,
      description:
        'Technical design directly supports every PRD requirement with explicit traceability.',
      min_threshold: 70,
      calibration: {
        score_0:
          'No reference to the PRD; design appears disconnected from product requirements.',
        score_50:
          'Design mentions the PRD but lacks explicit mapping between technical components and requirements.',
        score_100:
          'Every PRD requirement is explicitly mapped to technical components, with a traceability matrix and rationale for any deviations.',
      },
    },
  ],
};
