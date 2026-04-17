import {
  TRUST_GATE_MATRIX,
  lookupGateAuthority,
} from "../../src/trust/gate-matrix";
import type {
  TrustLevel,
  PipelineGate,
  GateAuthority,
} from "../../src/trust/types";

/**
 * Expected matrix values from the spec table.
 * [level][gate] = expected authority
 */
const EXPECTED_MATRIX: Record<
  TrustLevel,
  Record<PipelineGate, GateAuthority>
> = {
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
  // Test Case 1: All 28 matrix cells match the table above
  describe("all 28 matrix cells match the spec table", () => {
    for (const level of ALL_LEVELS) {
      for (const gate of ALL_GATES) {
        test(`TRUST_GATE_MATRIX[${level}]["${gate}"] === "${EXPECTED_MATRIX[level][gate]}"`, () => {
          expect(TRUST_GATE_MATRIX[level][gate]).toBe(
            EXPECTED_MATRIX[level][gate],
          );
        });
      }
    }
  });

  // Test Case 9 (partial): Type exhaustiveness -- matrix has exactly 7 gates per level
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
  // Test Case 1 (via function): All 28 combinations return correct authority
  describe("all 28 combinations return correct authority", () => {
    for (const level of ALL_LEVELS) {
      for (const gate of ALL_GATES) {
        test(`lookupGateAuthority(${level}, "${gate}") === "${EXPECTED_MATRIX[level][gate]}"`, () => {
          expect(lookupGateAuthority(level, gate)).toBe(
            EXPECTED_MATRIX[level][gate],
          );
        });
      }
    }
  });

  // Test Cases 2-5: security_review returns "human" at every level
  describe("security_review returns human at every trust level", () => {
    test('security_review returns "human" at L0', () => {
      expect(lookupGateAuthority(0, "security_review")).toBe("human");
    });

    test('security_review returns "human" at L1', () => {
      expect(lookupGateAuthority(1, "security_review")).toBe("human");
    });

    test('security_review returns "human" at L2', () => {
      expect(lookupGateAuthority(2, "security_review")).toBe("human");
    });

    test('security_review returns "human" at L3', () => {
      expect(lookupGateAuthority(3, "security_review")).toBe("human");
    });
  });

  // Test Case 6: L0 requires human for all gates
  describe("L0 requires human for all gates", () => {
    for (const gate of ALL_GATES) {
      test(`lookupGateAuthority(0, "${gate}") === "human"`, () => {
        expect(lookupGateAuthority(0, gate)).toBe("human");
      });
    }
  });

  // Test Case 7: L3 requires system for all gates except security_review
  describe("L3 requires system for all gates except security_review", () => {
    for (const gate of ALL_GATES) {
      if (gate === "security_review") {
        test(`lookupGateAuthority(3, "security_review") === "human"`, () => {
          expect(lookupGateAuthority(3, "security_review")).toBe("human");
        });
      } else {
        test(`lookupGateAuthority(3, "${gate}") === "system"`, () => {
          expect(lookupGateAuthority(3, gate)).toBe("system");
        });
      }
    }
  });

  // Test Case 8: L1 mixed authorities
  describe("L1 mixed authorities", () => {
    test('prd_approval is "human" at L1', () => {
      expect(lookupGateAuthority(1, "prd_approval")).toBe("human");
    });

    test('code_review is "human" at L1', () => {
      expect(lookupGateAuthority(1, "code_review")).toBe("human");
    });

    test('deployment_approval is "human" at L1', () => {
      expect(lookupGateAuthority(1, "deployment_approval")).toBe("human");
    });

    test('test_review is "system" at L1', () => {
      expect(lookupGateAuthority(1, "test_review")).toBe("system");
    });

    test('quality_gate is "system" at L1', () => {
      expect(lookupGateAuthority(1, "quality_gate")).toBe("system");
    });
  });

  // Test Case 9: Type exhaustiveness -- Object.keys(TRUST_GATE_MATRIX[0]).length === 7
  test("type exhaustiveness: matrix level 0 has exactly 7 gates", () => {
    expect(Object.keys(TRUST_GATE_MATRIX[0]).length).toBe(7);
  });
});
