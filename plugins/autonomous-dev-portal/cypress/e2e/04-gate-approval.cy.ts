// FR-021-04 — Gate approval flow testing.
//
// This spec verifies the core gate approval workflow:
// 1. Gates appear in the /approvals list when seeded with status: "gate"
// 2. Approve/Reject buttons trigger the correct API calls
// 3. Decisions are processed and gates disappear from the list
// 4. Bulk approval handles multiple gates correctly
//
// Test strategy: Seed request-action files with gate status, intercept POST
// calls to verify correct API usage, and assert UI state changes.

import { aGate } from "../support/builders";

describe("Gate Approval Flow (FR-021-04)", () => {
    beforeEach(() => {
        // Reset state directory and clear any in-memory caches
        cy.resetState();
    });

    it("displays gates in the approvals list", () => {
        const gate1 = aGate({
            id: "GATE-001",
            repo: "test-repo",
            title: "Pending Code Review Gate",
            phase: "CODE",
        });

        const gate2 = aGate({
            id: "GATE-002",
            repo: "another-repo",
            title: "Standards Review Gate",
            phase: "REVIEW",
        });

        // Seed two gates
        cy.seedRequest("GATE-001", gate1);
        cy.seedRequest("GATE-002", gate2);

        // Visit approvals page
        cy.visit("/approvals");

        // Assert both gates appear in the list
        cy.contains("Pending Code Review Gate").should("be.visible");
        cy.contains("Standards Review Gate").should("be.visible");

        // Verify gate rows contain the Approve button using correct selectors
        cy.get('[data-approval-id="GATE-001"]').within(() => {
            cy.contains("Approve").should("be.visible");
        });

        cy.get('[data-approval-id="GATE-002"]').within(() => {
            cy.contains("Approve").should("be.visible");
        });
    });

    it("approves a gate via button click", () => {
        const gate = aGate({
            id: "GATE-APPROVE",
            repo: "test-repo",
            title: "Gate to Approve",
            phase: "CODE",
        });

        cy.seedRequest("GATE-APPROVE", gate);

        // Setup intercept to capture the approve API call
        cy.intercept("POST", "/api/approvals/GATE-APPROVE/approve", {
            statusCode: 200,
            body: {
                success: true,
                decision: {
                    row: '<div data-decision="approved"></div>'
                }
            },
        }).as("approveGate");

        cy.visit("/approvals");

        // Click the Approve button
        cy.get('[data-approval-id="GATE-APPROVE"]').within(() => {
            cy.contains("Approve").click();
        });

        // Verify the API call was made
        cy.wait("@approveGate").then((interception) => {
            expect(interception.request.url).to.include("/api/approvals/GATE-APPROVE/approve");
        });

        // Gate should be replaced with approval indicator or disappear
        cy.get('[data-approval-id="GATE-APPROVE"]').should("not.exist");
    });

    it("rejects a gate via button click", () => {
        const gate = aGate({
            id: "GATE-REJECT",
            repo: "test-repo",
            title: "Gate to Reject",
            phase: "REVIEW",
        });

        cy.seedRequest("GATE-REJECT", gate);

        // Setup intercept for the reject API call
        cy.intercept("POST", "/api/approvals/GATE-REJECT/reject", {
            statusCode: 200,
            body: {
                success: true,
                decision: {
                    row: '<div data-decision="rejected"></div>'
                }
            },
        }).as("rejectGate");

        cy.visit("/approvals");

        // Click the Reject button
        cy.get('[data-approval-id="GATE-REJECT"]').within(() => {
            cy.contains("Reject").click();
        });

        // Verify the API call was made
        cy.wait("@rejectGate").then((interception) => {
            expect(interception.request.url).to.include("/api/approvals/GATE-REJECT/reject");
        });

        // Gate should be replaced or disappear after rejection
        cy.get('[data-approval-id="GATE-REJECT"]').should("not.exist");
    });

    it("handles bulk approval of multiple gates", () => {
        const gates = [
            aGate({
                id: "BULK-001",
                repo: "repo-a",
                title: "First Bulk Gate",
                phase: "CODE",
            }),
            aGate({
                id: "BULK-002",
                repo: "repo-b",
                title: "Second Bulk Gate",
                phase: "REVIEW",
            }),
            aGate({
                id: "BULK-003",
                repo: "repo-c",
                title: "Third Bulk Gate",
                phase: "DEPLOY",
            }),
        ];

        // Seed all three gates
        gates.forEach((gate) => {
            cy.seedRequest(gate.id!, gate);
        });

        // Setup intercept for bulk approve API call
        cy.intercept("POST", "/api/approvals/bulk-approve", {
            statusCode: 200,
            body: {
                success: true,
                approved: ["BULK-001", "BULK-002", "BULK-003"]
            },
        }).as("bulkApprove");

        cy.visit("/approvals");

        // Verify all gates are visible
        cy.contains("First Bulk Gate").should("be.visible");
        cy.contains("Second Bulk Gate").should("be.visible");
        cy.contains("Third Bulk Gate").should("be.visible");

        // Click Bulk Approve button
        cy.contains("Bulk approve").click();

        // Handle confirmation modal
        cy.on("window:confirm", (str) => {
            expect(str).to.include("Approve every gate matching the current filter");
            return true;
        });

        // Verify the bulk API call
        cy.wait("@bulkApprove").then((interception) => {
            expect(interception.request.url).to.include("/api/approvals/bulk-approve");
        });

        // All gates should disappear after bulk approval
        cy.contains("First Bulk Gate").should("not.exist");
        cy.contains("Second Bulk Gate").should("not.exist");
        cy.contains("Third Bulk Gate").should("not.exist");
    });

    it("shows empty state when no gates are pending", () => {
        // Don't seed any gates
        cy.visit("/approvals");

        // Should show empty state message
        cy.contains("No open gates").should("be.visible");
    });

    it("handles already-decided gate gracefully", () => {
        const gate = aGate({
            id: "DECIDED-GATE",
            repo: "test-repo",
            title: "Already Decided Gate",
            phase: "CODE",
        });

        // Seed the gate and a decision
        cy.seedRequest("DECIDED-GATE", gate);
        cy.seedGateDecision("test-repo", "DECIDED-GATE", {
            request_id: "DECIDED-GATE",
            repo: "test-repo",
            state: "approved",
            decision: "approved",
            operator_id: "test-operator",
            decided_at: new Date().toISOString(),
        });

        cy.visit("/approvals");

        // Gate shouldn't appear in pending list since it's already decided
        cy.contains("Already Decided Gate").should("not.exist");
        // Should still show empty state
        cy.contains("No open gates").should("be.visible");
    });

    after(() => {
        // Clean up test state
        cy.resetState();
    });
});