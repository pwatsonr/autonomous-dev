import { DocumentType } from '../pipeline/types/document-type';

/**
 * A reviewer role definition with identity, specialization, and prompt fragment.
 */
export interface ReviewerRole {
  role_id: string;
  role_name: string;
  document_types: DocumentType[];
  designation: Map<DocumentType, 'primary' | 'specialist'>;
  specialization_description: string;
  prompt_identity: string;
}

/**
 * All 8 reviewer roles (from TDD section 3.1.2).
 */
export const REVIEWER_ROLES: Record<string, ReviewerRole> = {
  'product-analyst': {
    role_id: 'product-analyst',
    role_name: 'Product Analyst',
    document_types: [DocumentType.PRD],
    designation: new Map<DocumentType, 'primary' | 'specialist'>([
      [DocumentType.PRD, 'primary'],
    ]),
    specialization_description:
      'Requirements engineering, clarity assessment, completeness validation, measurability checks, internal consistency analysis.',
    prompt_identity:
      'You are a senior product analyst with deep experience in requirements engineering. You evaluate product requirement documents for clarity, completeness, measurability, and internal consistency. You are rigorous about testable acceptance criteria and have zero tolerance for vague requirements.',
  },

  'domain-expert': {
    role_id: 'domain-expert',
    role_name: 'Domain Expert',
    document_types: [DocumentType.PRD],
    designation: new Map<DocumentType, 'primary' | 'specialist'>([
      [DocumentType.PRD, 'specialist'],
    ]),
    specialization_description:
      'Real-world usage assessment, user story realism, domain constraint validation, problem framing scope.',
    prompt_identity:
      'You are a domain expert who evaluates product requirements from the perspective of real-world usage. You assess whether user stories are realistic, whether domain constraints are respected, and whether the problem framing captures the full scope of user needs.',
  },

  'architect-reviewer': {
    role_id: 'architect-reviewer',
    role_name: 'Architect Reviewer',
    document_types: [DocumentType.TDD],
    designation: new Map<DocumentType, 'primary' | 'specialist'>([
      [DocumentType.TDD, 'primary'],
    ]),
    specialization_description:
      'Architectural soundness, trade-off analysis, data model integrity, API contract completeness, integration robustness.',
    prompt_identity:
      'You are a senior software architect who evaluates technical design documents for architectural soundness, appropriate trade-off analysis, data model integrity, API contract completeness, and integration robustness. You look for scalability gaps, failure mode blindspots, and architectural decisions that contradict their stated requirements.',
  },

  'security-reviewer': {
    role_id: 'security-reviewer',
    role_name: 'Security Reviewer',
    document_types: [DocumentType.TDD],
    designation: new Map<DocumentType, 'primary' | 'specialist'>([
      [DocumentType.TDD, 'specialist'],
    ]),
    specialization_description:
      'Threat coverage, authentication/authorization completeness, data protection, secure integration patterns.',
    prompt_identity:
      'You are a security architect who evaluates technical designs for threat coverage, authentication/authorization completeness, data protection measures, and secure integration patterns. You identify attack surfaces that the design fails to address and flag security assumptions that are not explicitly validated.',
  },

  'delivery-reviewer': {
    role_id: 'delivery-reviewer',
    role_name: 'Delivery Reviewer',
    document_types: [DocumentType.PLAN],
    designation: new Map<DocumentType, 'primary' | 'specialist'>([
      [DocumentType.PLAN, 'primary'],
    ]),
    specialization_description:
      'Work decomposition realism, dependency identification, effort estimation accuracy, test strategy, design alignment.',
    prompt_identity:
      'You are a senior engineering manager who evaluates implementation plans for realistic work decomposition, accurate dependency identification, reasonable effort estimates, comprehensive test strategies, and alignment with the parent technical design. You flag tasks that are too large, dependencies that are missing, and estimates that seem unrealistic.',
  },

  'implementation-reviewer': {
    role_id: 'implementation-reviewer',
    role_name: 'Implementation Reviewer',
    document_types: [DocumentType.SPEC],
    designation: new Map<DocumentType, 'primary' | 'specialist'>([
      [DocumentType.SPEC, 'primary'],
    ]),
    specialization_description:
      'Acceptance criteria precision, file path accuracy, test case comprehensiveness, code pattern clarity, plan alignment.',
    prompt_identity:
      'You are a senior engineer who evaluates implementation specifications for precise acceptance criteria, accurate file paths, comprehensive test cases, clear code patterns, and alignment with the parent plan. You ensure every criterion is unambiguous enough that any engineer could implement it without further clarification.',
  },

  'code-quality-reviewer': {
    role_id: 'code-quality-reviewer',
    role_name: 'Code Quality Reviewer',
    document_types: [DocumentType.CODE],
    designation: new Map<DocumentType, 'primary' | 'specialist'>([
      [DocumentType.CODE, 'primary'],
    ]),
    specialization_description:
      'Spec compliance, test coverage, code quality, documentation completeness, performance, maintainability.',
    prompt_identity:
      'You are a senior code reviewer who evaluates implementations for spec compliance, test coverage, code quality, documentation completeness, performance characteristics, and maintainability. You look for missed acceptance criteria, insufficient test coverage, code smells, missing error handling, and documentation gaps.',
  },

  'security-code-reviewer': {
    role_id: 'security-code-reviewer',
    role_name: 'Security Code Reviewer',
    document_types: [DocumentType.CODE],
    designation: new Map<DocumentType, 'primary' | 'specialist'>([
      [DocumentType.CODE, 'specialist'],
    ]),
    specialization_description:
      'Injection vulnerabilities, authentication bypass, authorization gaps, data leakage, insecure defaults, input validation.',
    prompt_identity:
      'You are a security engineer who reviews code for injection vulnerabilities, authentication bypass risks, authorization gaps, data leakage, insecure defaults, and input validation failures. You evaluate whether security requirements from the spec are correctly implemented.',
  },
};

/**
 * Maps each document type to its primary reviewer role_id.
 */
export const PRIMARY_ROLE_BY_DOC_TYPE: Record<DocumentType, string> = {
  [DocumentType.PRD]: 'product-analyst',
  [DocumentType.TDD]: 'architect-reviewer',
  [DocumentType.PLAN]: 'delivery-reviewer',
  [DocumentType.SPEC]: 'implementation-reviewer',
  [DocumentType.CODE]: 'code-quality-reviewer',
};

/**
 * Maps each document type to its specialist reviewer role_ids (may be empty).
 */
export const SPECIALIST_ROLES_BY_DOC_TYPE: Record<DocumentType, string[]> = {
  [DocumentType.PRD]: ['domain-expert'],
  [DocumentType.TDD]: ['security-reviewer'],
  [DocumentType.PLAN]: [],
  [DocumentType.SPEC]: [],
  [DocumentType.CODE]: ['security-code-reviewer'],
};
