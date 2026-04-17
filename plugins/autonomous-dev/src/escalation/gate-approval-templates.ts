/**
 * Gate Approval Response Templates (SPEC-009-3-3, Task 7).
 *
 * Provides predefined option sets for common gate approval scenarios.
 * These templates are used by the formatter when constructing
 * gate-level escalation messages to present structured response
 * choices to human reviewers.
 *
 * Four built-in templates:
 *   - prd_approval:         PRD review and approval
 *   - code_review:          Code review and feedback
 *   - deployment_approval:  Deployment gate
 *   - security_review:      Security review and remediation
 *
 * Templates are configurable: `getCustomTemplate` allows config
 * overrides to add, remove, or modify options per gate type.
 */

import type { EscalationOption } from "./types";

// ---------------------------------------------------------------------------
// Gate template type
// ---------------------------------------------------------------------------

/** The supported gate approval template types. */
export type GateTemplateType =
  | "prd_approval"
  | "code_review"
  | "deployment_approval"
  | "security_review";

// ---------------------------------------------------------------------------
// Custom config type
// ---------------------------------------------------------------------------

/**
 * Configuration for customizing gate approval templates.
 * Maps gate types to custom option sets that override defaults.
 */
export type GateTemplateConfig = Partial<
  Record<GateTemplateType, EscalationOption[]>
>;

// ---------------------------------------------------------------------------
// Default templates
// ---------------------------------------------------------------------------

const PRD_APPROVAL_TEMPLATE: EscalationOption[] = [
  {
    option_id: "opt-1",
    label: "Approve PRD",
    action: "approve",
    description: "Approve the PRD as-is and proceed to implementation",
  },
  {
    option_id: "opt-2",
    label: "Approve with conditions",
    action: "approve_with_conditions",
    description: "Approve with specified modifications",
  },
  {
    option_id: "opt-3",
    label: "Reject PRD",
    action: "reject",
    description: "Reject the PRD; pipeline will be cancelled",
  },
];

const CODE_REVIEW_TEMPLATE: EscalationOption[] = [
  {
    option_id: "opt-1",
    label: "Approve code",
    action: "approve",
    description: "Code passes review; proceed to next phase",
  },
  {
    option_id: "opt-2",
    label: "Request changes",
    action: "retry_with_changes",
    description: "Code needs modifications; provide feedback for retry",
  },
  {
    option_id: "opt-3",
    label: "Reject code",
    action: "reject",
    description: "Code is fundamentally flawed; cancel the request",
  },
];

const DEPLOYMENT_APPROVAL_TEMPLATE: EscalationOption[] = [
  {
    option_id: "opt-1",
    label: "Approve deployment",
    action: "approve",
    description: "Proceed with deployment",
  },
  {
    option_id: "opt-2",
    label: "Reject deployment",
    action: "reject",
    description: "Do not deploy; cancel the request",
  },
  {
    option_id: "opt-3",
    label: "Defer deployment",
    action: "cancel",
    description: "Defer deployment to a later time",
  },
];

const SECURITY_REVIEW_TEMPLATE: EscalationOption[] = [
  {
    option_id: "opt-1",
    label: "Approve (no findings)",
    action: "approve",
    description: "Security review passed; no issues found",
  },
  {
    option_id: "opt-2",
    label: "Remediate and retry",
    action: "retry_with_changes",
    description: "Security issues found; provide remediation guidance",
  },
  {
    option_id: "opt-3",
    label: "Reject (critical findings)",
    action: "reject",
    description: "Critical security issues; cancel the request",
  },
];

/** Map of gate types to their default templates. */
const DEFAULT_TEMPLATES: Record<GateTemplateType, EscalationOption[]> = {
  prd_approval: PRD_APPROVAL_TEMPLATE,
  code_review: CODE_REVIEW_TEMPLATE,
  deployment_approval: DEPLOYMENT_APPROVAL_TEMPLATE,
  security_review: SECURITY_REVIEW_TEMPLATE,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the default gate approval template for a given gate type.
 *
 * Returns a deep copy of the template so callers cannot mutate the
 * built-in defaults.
 *
 * @param gateType  The type of gate approval template to retrieve.
 * @returns An array of EscalationOption objects for the gate type.
 */
export function getGateApprovalTemplate(
  gateType: GateTemplateType,
): EscalationOption[] {
  const template = DEFAULT_TEMPLATES[gateType];
  return template.map((opt) => ({ ...opt }));
}

/**
 * Get a gate approval template with optional custom config overrides.
 *
 * If the config contains an entry for the given gate type, those custom
 * options are returned instead of the defaults. Otherwise, the default
 * template is returned.
 *
 * @param gateType  The type of gate approval template to retrieve.
 * @param config    Optional custom configuration with per-gate-type overrides.
 * @returns An array of EscalationOption objects (custom or default).
 */
export function getCustomTemplate(
  gateType: GateTemplateType,
  config?: GateTemplateConfig,
): EscalationOption[] {
  if (config && config[gateType]) {
    return config[gateType]!.map((opt) => ({ ...opt }));
  }
  return getGateApprovalTemplate(gateType);
}
