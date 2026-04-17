/**
 * LLM prompt template for severity override assessment (SPEC-007-3-2, Task 5).
 *
 * The LLM receives the deterministic severity, scoring breakdown, and
 * candidate evidence. It may propose an override of exactly one level.
 */

export const SEVERITY_OVERRIDE_PROMPT = `
You are reviewing a severity assessment for a production issue.

## Deterministic Assessment
- Severity: {severity}
- Score: {score}
- Breakdown:
  - Error rate: {error_rate_value}% -> {error_rate_subscore} (weighted: {error_rate_weighted})
  - Affected users: ~{affected_users} -> {users_subscore} (weighted: {users_weighted})
  - Service criticality: {criticality} -> {criticality_subscore} (weighted: {criticality_weighted})
  - Duration: {duration_minutes} min -> {duration_subscore} (weighted: {duration_weighted})
  - Data integrity: {data_integrity} -> {data_subscore} (weighted: {data_weighted})

## Evidence Summary
{evidence_summary}

## Instructions
Based on the evidence, determine if the severity should be adjusted.
You may adjust by AT MOST one level (e.g., P2 -> P1 or P2 -> P3).
You CANNOT adjust by more than one level.

Respond in this exact format:
OVERRIDE: <yes|no>
NEW_SEVERITY: <P0|P1|P2|P3>
JUSTIFICATION: <one sentence explaining why>
`;
