/**
 * Unit tests for gate matrix (SPEC-009-1-4 cross-ref to SPEC-009-1-1).
 *
 * Covers all 28 matrix cells, security_review invariant at all levels,
 * L0 all-human, L3 all-system-except-security, and type exhaustiveness.
 */

import {
  TRUST_GATE_MATRIX,
  lookupGateAuthority,
} from "../gate-matrix";
import type {
  TrustLevel,
  PipelineGate,
  GateAuthority,
} from "../types";

const EXPECTED_MATRIX: Record<TrustLevel, Record<PipelineGate, GateAuthority>> = {
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
};

const ALL_LEVELS: TrustLevel[] = [0, 1, 2, 3];
const ALL_GATES: PipelineGate[] = [
  "prd_approval",
  "code_review",
  "test_review",
  "deployment_approval",
  "security_review",
  "cost_approval",
  "quality_gate",
];

describe("TRUST_GATE_MATRIX", () => {
  describe("all 28 matrix cells match the spec table", () => {
    for (const level of ALL_LEVELS) {
      for (const gate of ALL_GATES) {
        test(`TRUST_GATE_MATRIX[${level}]["${gate}"] === "${EXPECTED_MATRIX[level][gate]}"`, () => {
          expect(TRUST_GATE_MATRIX[level][gate]).toBe(EXPECTED_MATRIX[level][gate]);
        });
      }
    }
  });

  test("each level has exactly 7 gates", () => {
    for (const level of ALL_LEVELS) {
      expect(Object.keys(TRUST_GATE_MATRIX[level]).length).toBe(7);
    }
  });

  test("matrix has exactly 4 levels", () => {
    expect(Object.keys(TRUST_GATE_MATRIX).length).toBe(4);
  });
});

describe("lookupGateAuthority", () => {
  describe("all 28 combinations return correct authority", () => {
    for (const level of ALL_LEVELS) {
      for (const gate of ALL_GATES) {
        test(`lookupGateAuthority(${level}, "${gate}") === "${EXPECTED_MATRIX[level][gate]}"`, () => {
          expect(lookupGateAuthority(level, gate)).toBe(EXPECTED_MATRIX[level][gate]);
        });
      }
    }
  });

  describe("security_review returns human at every trust level", () => {
    for (const level of ALL_LEVELS) {
      test(`security_review returns "human" at L${level}`, () => {
        expect(lookupGateAuthority(level, "security_review")).toBe("human");
      });
    }
  });

  describe("L0 requires human for all gates", () => {
    for (const gate of ALL_GATES) {
      test(`lookupGateAuthority(0, "${gate}") === "human"`, () => {
        expect(lookupGateAuthority(0, gate)).toBe("human");
      });
    }
  });

  describe("L3 requires system for all gates except security_review", () => {
    for (const gate of ALL_GATES) {
      const expected = gate === "security_review" ? "human" : "system";
      test(`lookupGateAuthority(3, "${gate}") === "${expected}"`, () => {
        expect(lookupGateAuthority(3, gate)).toBe(expected);
      });
    }
  });
});
