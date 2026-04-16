import type { TrustLevel, PipelineGate, GateAuthority } from "./types";

/**
 * The authoritative 4x7 Trust Gate Matrix from TDD Section 3.1.4.
 *
 * Rows = TrustLevel (0-3), Columns = PipelineGate (7 gates).
 * Each cell is the GateAuthority ("human" | "system") that controls
 * whether the gate requires human or system approval at that trust level.
 *
 * Declared `as const` for deep readonly and literal type narrowing.
 * This means any attempt to assign a non-"human" value to a security_review
 * cell is a TypeScript compilation error.
 */
export const TRUST_GATE_MATRIX = {
  0: {
    prd_approval: "human",
    code_review: "human",
    test_review: "human",
    deployment_approval: "human",
    security_review: "human",
    cost_approval: "human",
    quality_gate: "human",
  },
  1: {
    prd_approval: "human",
    code_review: "human",
    test_review: "system",
    deployment_approval: "human",
    security_review: "human",
    cost_approval: "human",
    quality_gate: "system",
  },
  2: {
    prd_approval: "system",
    code_review: "human",
    test_review: "system",
    deployment_approval: "human",
    security_review: "human",
    cost_approval: "system",
    quality_gate: "system",
  },
  3: {
    prd_approval: "system",
    code_review: "system",
    test_review: "system",
    deployment_approval: "system",
    security_review: "human",
    cost_approval: "system",
    quality_gate: "system",
  },
} as const satisfies Record<TrustLevel, Record<PipelineGate, GateAuthority>>;

/**
 * Look up the gate authority for a given trust level and pipeline gate.
 *
 * Defense-in-depth: security_review always returns "human" regardless of
 * what the matrix contains. The matrix already encodes "human" for all
 * security_review cells, but this function enforces it programmatically
 * as a second layer.
 */
export function lookupGateAuthority(
  level: TrustLevel,
  gate: PipelineGate,
): GateAuthority {
  // Defense-in-depth: security_review is always human, enforced independently
  if (gate === "security_review") {
    return "human";
  }

  return TRUST_GATE_MATRIX[level][gate];
}
