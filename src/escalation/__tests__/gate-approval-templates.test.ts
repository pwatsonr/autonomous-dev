/**
 * Unit tests for Gate Approval Templates (SPEC-009-3-3, Task 7).
 *
 * Tests verify:
 *  13. PRD template has 3 options
 *  14. PRD template includes approve
 *  15. PRD template includes reject
 *  16. Code review template has approve, request_changes, reject
 *  17. Deployment template has approve, reject, defer
 *  18. Security review template has approve, remediate, reject
 *  19. All templates have >= 2 options
 *  20. Custom config overrides defaults
 *  21. Missing custom config uses defaults
 */

import {
  getGateApprovalTemplate,
  getCustomTemplate,
  type GateTemplateType,
  type GateTemplateConfig,
} from "../gate-approval-templates";
import type { EscalationOption } from "../types";

// ---------------------------------------------------------------------------
// PRD Approval Template
// ---------------------------------------------------------------------------

describe("Gate Approval Templates - PRD Approval", () => {
  // Test 13: PRD template has 3 options
  it("has 3 options", () => {
    const options = getGateApprovalTemplate("prd_approval");
    expect(options).toHaveLength(3);
  });

  // Test 14: PRD template includes approve
  it("includes an approve option", () => {
    const options = getGateApprovalTemplate("prd_approval");
    const approveOption = options.find((opt) => opt.action === "approve");
    expect(approveOption).toBeDefined();
    expect(approveOption!.label).toBe("Approve PRD");
    expect(approveOption!.description).toBe(
      "Approve the PRD as-is and proceed to implementation",
    );
  });

  // Test 15: PRD template includes reject
  it("includes a reject option", () => {
    const options = getGateApprovalTemplate("prd_approval");
    const rejectOption = options.find((opt) => opt.action === "reject");
    expect(rejectOption).toBeDefined();
    expect(rejectOption!.label).toBe("Reject PRD");
    expect(rejectOption!.description).toBe(
      "Reject the PRD; pipeline will be cancelled",
    );
  });

  it("includes an approve_with_conditions option", () => {
    const options = getGateApprovalTemplate("prd_approval");
    const condOption = options.find(
      (opt) => opt.action === "approve_with_conditions",
    );
    expect(condOption).toBeDefined();
    expect(condOption!.label).toBe("Approve with conditions");
  });
});

// ---------------------------------------------------------------------------
// Code Review Template
// ---------------------------------------------------------------------------

// Test 16: Code review template has approve, request_changes, reject
describe("Gate Approval Templates - Code Review", () => {
  it("has approve, retry_with_changes, and reject options", () => {
    const options = getGateApprovalTemplate("code_review");
    const actions = options.map((opt) => opt.action);

    expect(actions).toContain("approve");
    expect(actions).toContain("retry_with_changes");
    expect(actions).toContain("reject");
  });

  it("has correct labels", () => {
    const options = getGateApprovalTemplate("code_review");
    expect(options.find((o) => o.action === "approve")!.label).toBe(
      "Approve code",
    );
    expect(options.find((o) => o.action === "retry_with_changes")!.label).toBe(
      "Request changes",
    );
    expect(options.find((o) => o.action === "reject")!.label).toBe(
      "Reject code",
    );
  });
});

// ---------------------------------------------------------------------------
// Deployment Approval Template
// ---------------------------------------------------------------------------

// Test 17: Deployment template has approve, reject, defer
describe("Gate Approval Templates - Deployment Approval", () => {
  it("has approve, reject, and cancel (defer) options", () => {
    const options = getGateApprovalTemplate("deployment_approval");
    const actions = options.map((opt) => opt.action);

    expect(actions).toContain("approve");
    expect(actions).toContain("reject");
    expect(actions).toContain("cancel"); // defer maps to cancel action
  });

  it("has correct labels", () => {
    const options = getGateApprovalTemplate("deployment_approval");
    expect(options.find((o) => o.action === "approve")!.label).toBe(
      "Approve deployment",
    );
    expect(options.find((o) => o.action === "reject")!.label).toBe(
      "Reject deployment",
    );
    expect(options.find((o) => o.action === "cancel")!.label).toBe(
      "Defer deployment",
    );
  });
});

// ---------------------------------------------------------------------------
// Security Review Template
// ---------------------------------------------------------------------------

// Test 18: Security review template has approve, remediate, reject
describe("Gate Approval Templates - Security Review", () => {
  it("has approve, retry_with_changes (remediate), and reject options", () => {
    const options = getGateApprovalTemplate("security_review");
    const actions = options.map((opt) => opt.action);

    expect(actions).toContain("approve");
    expect(actions).toContain("retry_with_changes");
    expect(actions).toContain("reject");
  });

  it("has correct labels", () => {
    const options = getGateApprovalTemplate("security_review");
    expect(options.find((o) => o.action === "approve")!.label).toBe(
      "Approve (no findings)",
    );
    expect(
      options.find((o) => o.action === "retry_with_changes")!.label,
    ).toBe("Remediate and retry");
    expect(options.find((o) => o.action === "reject")!.label).toBe(
      "Reject (critical findings)",
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-template: minimum options
// ---------------------------------------------------------------------------

// Test 19: All templates have >= 2 options
describe("Gate Approval Templates - All templates", () => {
  const gateTypes: GateTemplateType[] = [
    "prd_approval",
    "code_review",
    "deployment_approval",
    "security_review",
  ];

  it.each(gateTypes)("template '%s' has >= 2 options", (gateType) => {
    const options = getGateApprovalTemplate(gateType);
    expect(options.length).toBeGreaterThanOrEqual(2);
  });

  it.each(gateTypes)(
    "template '%s' has at least one approve/retry and one cancel/reject option",
    (gateType) => {
      const options = getGateApprovalTemplate(gateType);
      const hasApproveOrRetry = options.some(
        (opt) =>
          opt.action === "approve" ||
          opt.action === "approve_with_conditions" ||
          opt.action === "retry_with_changes",
      );
      const hasCancelOrReject = options.some(
        (opt) => opt.action === "cancel" || opt.action === "reject",
      );
      expect(hasApproveOrRetry).toBe(true);
      expect(hasCancelOrReject).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Custom config
// ---------------------------------------------------------------------------

// Test 20: Custom config overrides defaults
describe("Gate Approval Templates - Custom config", () => {
  it("overrides defaults when custom config is provided", () => {
    const customOptions: EscalationOption[] = [
      {
        option_id: "custom-1",
        label: "Custom Approve",
        action: "approve",
        description: "Custom approval option",
      },
      {
        option_id: "custom-2",
        label: "Custom Reject",
        action: "reject",
        description: "Custom rejection option",
      },
    ];

    const config: GateTemplateConfig = {
      prd_approval: customOptions,
    };

    const result = getCustomTemplate("prd_approval", config);
    expect(result).toHaveLength(2);
    expect(result[0].option_id).toBe("custom-1");
    expect(result[0].label).toBe("Custom Approve");
    expect(result[1].option_id).toBe("custom-2");
    expect(result[1].label).toBe("Custom Reject");
  });

  // Test 21: Missing custom config uses defaults
  it("uses defaults when no custom config is provided", () => {
    const result = getCustomTemplate("prd_approval");
    const defaultResult = getGateApprovalTemplate("prd_approval");

    expect(result).toEqual(defaultResult);
  });

  it("uses defaults when custom config does not contain the gate type", () => {
    const config: GateTemplateConfig = {
      code_review: [
        { option_id: "c-1", label: "Custom", action: "approve" },
        { option_id: "c-2", label: "Custom2", action: "reject" },
      ],
    };

    // Request prd_approval which is NOT in the config
    const result = getCustomTemplate("prd_approval", config);
    const defaultResult = getGateApprovalTemplate("prd_approval");

    expect(result).toEqual(defaultResult);
  });

  it("returns deep copies so callers cannot mutate defaults", () => {
    const result1 = getGateApprovalTemplate("prd_approval");
    result1[0].label = "MUTATED";

    const result2 = getGateApprovalTemplate("prd_approval");
    expect(result2[0].label).toBe("Approve PRD");
  });

  it("returns deep copies from custom templates too", () => {
    const customOptions: EscalationOption[] = [
      { option_id: "c-1", label: "Original", action: "approve" },
      { option_id: "c-2", label: "Original2", action: "reject" },
    ];
    const config: GateTemplateConfig = {
      prd_approval: customOptions,
    };

    const result1 = getCustomTemplate("prd_approval", config);
    result1[0].label = "MUTATED";

    const result2 = getCustomTemplate("prd_approval", config);
    expect(result2[0].label).toBe("Original");
  });
});
