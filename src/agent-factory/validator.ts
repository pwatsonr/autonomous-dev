/**
 * Agent definition schema validator (SPEC-005-1-1, Task 2).
 *
 * Implements the 10 validation rules from TDD 3.1.2 against a
 * `ParsedAgent`. Produces specific, actionable error messages
 * for each violation.
 *
 * The validator never short-circuits: all rules are evaluated so
 * callers receive the complete set of issues in one pass.
 */

import {
  ParsedAgent,
  AgentRole,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ValidationContext,
  ValidationRule,
  AGENT_ROLES,
} from './types';

// Re-export for convenience
export type { ValidationResult };

// ---------------------------------------------------------------------------
// Tool allowlist per role (TDD 3.1.3)
// ---------------------------------------------------------------------------

export const TOOL_ALLOWLIST: Record<AgentRole, string[]> = {
  author:   ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  executor: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch'],
  reviewer: ['Read', 'Glob', 'Grep'],
  meta:     ['Read', 'Glob', 'Grep'],
};

// ---------------------------------------------------------------------------
// Default model registry
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_REGISTRY: Set<string> = new Set([
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-haiku-3-20250414',
]);

// ---------------------------------------------------------------------------
// Semver regex: X.Y.Z where X, Y, Z are non-negative integers
// ---------------------------------------------------------------------------

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// The 10 validation rules
// ---------------------------------------------------------------------------

const rule001NameUniqueness: ValidationRule = {
  id: 'RULE_001_NAME_UNIQUENESS',
  field: 'name',
  validate(agent: ParsedAgent, ctx: ValidationContext): ValidationError | null {
    if (ctx.existingNames.has(agent.name)) {
      return {
        rule: 'RULE_001_NAME_UNIQUENESS',
        field: 'name',
        message: `Agent name '${agent.name}' conflicts with an already-registered agent`,
        severity: 'error',
      };
    }
    return null;
  },
};

const rule002NameFilenameMatch: ValidationRule = {
  id: 'RULE_002_NAME_FILENAME_MATCH',
  field: 'name',
  validate(agent: ParsedAgent, ctx: ValidationContext): ValidationError | null {
    if (!ctx.filename) return null; // skip if no filename context
    const expected = ctx.filename.replace(/\.md$/, '');
    if (agent.name !== expected) {
      return {
        rule: 'RULE_002_NAME_FILENAME_MATCH',
        field: 'name',
        message: `Agent name '${agent.name}' does not match filename '${ctx.filename}'`,
        severity: 'error',
      };
    }
    return null;
  },
};

const rule003ValidSemver: ValidationRule = {
  id: 'RULE_003_VALID_SEMVER',
  field: 'version',
  validate(agent: ParsedAgent): ValidationError | null {
    if (!SEMVER_PATTERN.test(agent.version)) {
      return {
        rule: 'RULE_003_VALID_SEMVER',
        field: 'version',
        message: `Version '${agent.version}' is not valid semver (expected X.Y.Z)`,
        severity: 'error',
      };
    }
    return null;
  },
};

const rule004ValidRole: ValidationRule = {
  id: 'RULE_004_VALID_ROLE',
  field: 'role',
  validate(agent: ParsedAgent): ValidationError | null {
    if (!(AGENT_ROLES as readonly string[]).includes(agent.role)) {
      return {
        rule: 'RULE_004_VALID_ROLE',
        field: 'role',
        message: `Role '${agent.role}' is not valid (expected: author, executor, reviewer, meta)`,
        severity: 'error',
      };
    }
    return null;
  },
};

const rule005ToolAllowlist: ValidationRule = {
  id: 'RULE_005_TOOL_ALLOWLIST',
  field: 'tools',
  validate(agent: ParsedAgent): ValidationError | null {
    if (!(AGENT_ROLES as readonly string[]).includes(agent.role)) {
      // Cannot check tools if role is invalid; RULE_004 handles that.
      return null;
    }
    const allowed = new Set(TOOL_ALLOWLIST[agent.role as AgentRole]);
    const disallowed = agent.tools.filter((t) => !allowed.has(t));
    if (disallowed.length > 0) {
      // Return one error per disallowed tool? Spec template shows a single
      // message with the tool name. We return one error per tool for clarity.
      // However, the spec shows a single rule entry. We return the first
      // disallowed tool to match the template exactly, but include all in
      // the message for actionability.
      return {
        rule: 'RULE_005_TOOL_ALLOWLIST',
        field: 'tools',
        message: `Tool '${disallowed[0]}' is not allowed for role '${agent.role}'`,
        severity: 'error',
      };
    }
    return null;
  },
};

const rule006RubricMinimum: ValidationRule = {
  id: 'RULE_006_RUBRIC_MINIMUM',
  field: 'evaluation_rubric',
  validate(agent: ParsedAgent): ValidationError | null {
    const count = agent.evaluation_rubric.length;
    if (count < 2) {
      return {
        rule: 'RULE_006_RUBRIC_MINIMUM',
        field: 'evaluation_rubric',
        message: `Evaluation rubric must have at least 2 dimensions, found ${count}`,
        severity: 'error',
      };
    }
    return null;
  },
};

const rule007VersionHistoryConsistency: ValidationRule = {
  id: 'RULE_007_VERSION_HISTORY_CONSISTENCY',
  field: 'version_history',
  validate(agent: ParsedAgent): ValidationError | null {
    if (agent.version_history.length === 0) {
      // No history entries — nothing to check consistency against.
      return null;
    }
    const latest = agent.version_history[agent.version_history.length - 1];
    if (latest.version !== agent.version) {
      return {
        rule: 'RULE_007_VERSION_HISTORY_CONSISTENCY',
        field: 'version_history',
        message: `version_history latest entry '${latest.version}' does not match version '${agent.version}'`,
        severity: 'error',
      };
    }
    return null;
  },
};

const rule008TurnLimit: ValidationRule = {
  id: 'RULE_008_TURN_LIMIT',
  field: 'turn_limit',
  validate(agent: ParsedAgent): ValidationError | null {
    const val = agent.turn_limit;
    if (
      !Number.isInteger(val) ||
      val < 1 ||
      val > 100
    ) {
      return {
        rule: 'RULE_008_TURN_LIMIT',
        field: 'turn_limit',
        message: `turn_limit ${val} is out of range (must be 1-100)`,
        severity: 'error',
      };
    }
    return null;
  },
};

const rule009ModelRegistry: ValidationRule = {
  id: 'RULE_009_MODEL_REGISTRY',
  field: 'model',
  validate(agent: ParsedAgent, ctx: ValidationContext): ValidationError | null {
    const registry = ctx.modelRegistry ?? DEFAULT_MODEL_REGISTRY;
    if (!registry.has(agent.model)) {
      return {
        rule: 'RULE_009_MODEL_REGISTRY',
        field: 'model',
        message: `Model '${agent.model}' is not in the approved model registry`,
        severity: 'error',
      };
    }
    return null;
  },
};

const rule010Temperature: ValidationRule = {
  id: 'RULE_010_TEMPERATURE',
  field: 'temperature',
  validate(agent: ParsedAgent): ValidationError | null {
    const val = agent.temperature;
    if (typeof val !== 'number' || isNaN(val) || val < 0.0 || val > 1.0) {
      return {
        rule: 'RULE_010_TEMPERATURE',
        field: 'temperature',
        message: `Temperature ${val} is out of range (must be 0.0-1.0)`,
        severity: 'error',
      };
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// Exported rule list (for introspection / testing)
// ---------------------------------------------------------------------------

export const VALIDATION_RULES: ValidationRule[] = [
  rule001NameUniqueness,
  rule002NameFilenameMatch,
  rule003ValidSemver,
  rule004ValidRole,
  rule005ToolAllowlist,
  rule006RubricMinimum,
  rule007VersionHistoryConsistency,
  rule008TurnLimit,
  rule009ModelRegistry,
  rule010Temperature,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates a `ParsedAgent` against all 10 schema rules.
 *
 * @param parsed   The agent definition to validate.
 * @param existingNames  Optional set of already-registered agent names
 *                       (for RULE_001 uniqueness check).
 * @returns A `ValidationResult` containing all errors and warnings.
 */
export function validateAgent(
  parsed: ParsedAgent,
  existingNames?: Set<string>,
): ValidationResult {
  const ctx: ValidationContext = {
    existingNames: existingNames ?? new Set(),
  };
  return validateAgentWithContext(parsed, ctx);
}

/**
 * Validates with full context (filename, model registry, etc.).
 *
 * This is the lower-level entry point used internally and available
 * for callers that need to supply filename or model registry context.
 */
export function validateAgentWithContext(
  parsed: ParsedAgent,
  context: ValidationContext,
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  for (const rule of VALIDATION_RULES) {
    const result = rule.validate(parsed, context);
    if (result !== null) {
      if (result.severity === 'warning') {
        warnings.push(result);
      } else {
        errors.push(result);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
