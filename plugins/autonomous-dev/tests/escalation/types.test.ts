import type {
  EscalationType,
  EscalationUrgency,
  TimeoutBehavior,
  RoutingMode,
  EscalationMessage,
  EscalationOption,
  EscalationArtifact,
  CostImpact,
  RoutingTarget,
  EscalationConfig,
} from "../../src/escalation/types";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Escalation types", () => {
  // -------------------------------------------------------------------------
  // AC 3: EscalationType is exactly a 6-member union
  // -------------------------------------------------------------------------
  describe("EscalationType", () => {
    test("accepts all 6 valid escalation types", () => {
      const types: EscalationType[] = [
        "product",
        "technical",
        "infrastructure",
        "security",
        "cost",
        "quality",
      ];
      expect(types).toHaveLength(6);
      // Verify each is assignable (runtime check for completeness)
      for (const t of types) {
        expect(typeof t).toBe("string");
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC 4: TimeoutBehavior is exactly a 4-member union
  // -------------------------------------------------------------------------
  describe("TimeoutBehavior", () => {
    test("accepts all 4 valid timeout behaviors", () => {
      const behaviors: TimeoutBehavior[] = [
        "pause",
        "retry",
        "skip",
        "cancel",
      ];
      expect(behaviors).toHaveLength(4);
    });
  });

  // -------------------------------------------------------------------------
  // EscalationUrgency
  // -------------------------------------------------------------------------
  describe("EscalationUrgency", () => {
    test("accepts all 3 urgency levels", () => {
      const urgencies: EscalationUrgency[] = [
        "immediate",
        "soon",
        "informational",
      ];
      expect(urgencies).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // RoutingMode
  // -------------------------------------------------------------------------
  describe("RoutingMode", () => {
    test("accepts default and advanced modes", () => {
      const modes: RoutingMode[] = ["default", "advanced"];
      expect(modes).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // AC 1: EscalationMessage includes every field from the v1 JSON schema
  // -------------------------------------------------------------------------
  describe("EscalationMessage", () => {
    test("v1 message includes all required and optional fields", () => {
      const message: EscalationMessage = {
        schema_version: "v1",
        escalation_id: "esc-20260408-001",
        timestamp: "2026-04-08T12:00:00Z",
        request_id: "req-001",
        repository: "my-repo",
        pipeline_phase: "code_review",
        escalation_type: "technical",
        urgency: "soon",
        summary: "Build failed after 3 retries",
        failure_reason: "TypeScript compilation error in module X",
        options: [
          { option_id: "opt-1", label: "Retry", action: "retry" },
          { option_id: "opt-2", label: "Skip", action: "skip" },
        ],
        artifacts: [
          { type: "log", path: "logs/build.log", summary: "Build output" },
        ],
        technical_details: "Extended stack trace...",
        previous_escalation_id: "esc-20260407-005",
        retry_count: 3,
        cost_impact: {
          estimated_cost: 12.5,
          currency: "USD",
          threshold_exceeded: false,
          budget_remaining: 87.5,
        },
      };

      expect(message.schema_version).toBe("v1");
      expect(message.escalation_id).toMatch(/^esc-/);
      expect(message.options).toHaveLength(2);
      expect(message.artifacts).toHaveLength(1);
      expect(message.retry_count).toBe(3);
    });

    test("v1 message works with only required fields", () => {
      const message: EscalationMessage = {
        schema_version: "v1",
        escalation_id: "esc-20260408-002",
        timestamp: "2026-04-08T12:00:00Z",
        request_id: "req-002",
        repository: "my-repo",
        pipeline_phase: "deployment",
        escalation_type: "infrastructure",
        urgency: "immediate",
        summary: "Deployment target unreachable",
        failure_reason: "Connection timeout to production cluster",
        options: [
          { option_id: "opt-1", label: "Retry", action: "retry" },
          { option_id: "opt-2", label: "Cancel", action: "cancel" },
        ],
        retry_count: 0,
      };

      expect(message.artifacts).toBeUndefined();
      expect(message.technical_details).toBeUndefined();
      expect(message.previous_escalation_id).toBeUndefined();
      expect(message.cost_impact).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // AC 2: EscalationOption requires option_id, label, and action
  // -------------------------------------------------------------------------
  describe("EscalationOption", () => {
    test("requires option_id, label, and action", () => {
      const option: EscalationOption = {
        option_id: "opt-1",
        label: "Approve",
        action: "approve",
      };

      expect(option.option_id).toBe("opt-1");
      expect(option.label).toBe("Approve");
      expect(option.action).toBe("approve");
      expect(option.description).toBeUndefined();
    });

    test("accepts optional description", () => {
      const option: EscalationOption = {
        option_id: "opt-2",
        label: "Reject",
        action: "reject",
        description: "Reject and return to author for revision",
      };

      expect(option.description).toBe(
        "Reject and return to author for revision",
      );
    });
  });

  // -------------------------------------------------------------------------
  // EscalationArtifact
  // -------------------------------------------------------------------------
  describe("EscalationArtifact", () => {
    test("supports all artifact types", () => {
      const artifacts: EscalationArtifact[] = [
        { type: "log", path: "logs/build.log" },
        { type: "diff", path: "diffs/change.diff", summary: "Code changes" },
        { type: "report", path: "reports/coverage.html" },
        { type: "screenshot", path: "screenshots/failure.png" },
      ];

      expect(artifacts).toHaveLength(4);
      expect(artifacts[0].summary).toBeUndefined();
      expect(artifacts[1].summary).toBe("Code changes");
    });
  });

  // -------------------------------------------------------------------------
  // CostImpact
  // -------------------------------------------------------------------------
  describe("CostImpact", () => {
    test("includes all required fields", () => {
      const impact: CostImpact = {
        estimated_cost: 150,
        currency: "USD",
        threshold_exceeded: true,
      };

      expect(impact.estimated_cost).toBe(150);
      expect(impact.threshold_exceeded).toBe(true);
      expect(impact.budget_remaining).toBeUndefined();
    });

    test("accepts optional budget_remaining", () => {
      const impact: CostImpact = {
        estimated_cost: 50,
        currency: "USD",
        threshold_exceeded: false,
        budget_remaining: 950,
      };

      expect(impact.budget_remaining).toBe(950);
    });
  });

  // -------------------------------------------------------------------------
  // RoutingTarget
  // -------------------------------------------------------------------------
  describe("RoutingTarget", () => {
    test("includes target_id, display_name, and channel", () => {
      const target: RoutingTarget = {
        target_id: "team-lead",
        display_name: "Team Lead",
        channel: "slack",
      };

      expect(target.target_id).toBe("team-lead");
      expect(target.display_name).toBe("Team Lead");
      expect(target.channel).toBe("slack");
    });
  });

  // -------------------------------------------------------------------------
  // EscalationConfig
  // -------------------------------------------------------------------------
  describe("EscalationConfig", () => {
    test("default routing mode with single target", () => {
      const config: EscalationConfig = {
        routing: {
          mode: "default",
          default_target: {
            target_id: "owner",
            display_name: "Repo Owner",
            channel: "cli",
          },
        },
        verbosity: "standard",
        retry_budget: 3,
      };

      expect(config.routing.mode).toBe("default");
      expect(config.routing.advanced).toBeUndefined();
      expect(config.verbosity).toBe("standard");
      expect(config.retry_budget).toBe(3);
    });

    test("advanced routing mode with per-type configuration", () => {
      const defaultTarget: RoutingTarget = {
        target_id: "fallback",
        display_name: "Fallback",
        channel: "email",
      };

      const makeRouting = (id: string) => ({
        primary: { target_id: id, display_name: id, channel: "slack" },
        timeout_minutes: 30,
        timeout_behavior: "pause" as const,
      });

      const config: EscalationConfig = {
        routing: {
          mode: "advanced",
          default_target: defaultTarget,
          advanced: {
            product: makeRouting("product-owner"),
            technical: makeRouting("tech-lead"),
            infrastructure: makeRouting("devops"),
            security: {
              ...makeRouting("security-team"),
              timeout_behavior: "cancel",
              timeout_minutes: 15,
            },
            cost: makeRouting("finance"),
            quality: makeRouting("qa-lead"),
          },
        },
        verbosity: "verbose",
        retry_budget: 5,
      };

      expect(config.routing.mode).toBe("advanced");
      expect(config.routing.advanced!.security.timeout_behavior).toBe(
        "cancel",
      );
      expect(config.routing.advanced!.security.timeout_minutes).toBe(15);
    });
  });
});
