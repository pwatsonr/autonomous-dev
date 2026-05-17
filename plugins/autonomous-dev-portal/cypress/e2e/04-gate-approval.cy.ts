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
//
// Note on round-trip behavior: in production the daemon consumes the gate
// decision and the portal removes the row from the queue. In this suite the
// daemon is not running, so the approve/reject/already-decided tests use
// `cy.intercept` to mock the HTMX response. This converts them from
// round-trip tests into contract tests (right endpoint, right HTTP verb,
// right payload). The HTMX swap target is replaced with an empty fragment
// so the "row gone" UI assertion still passes against the mocked response.

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

        // Mock the HTMX approve response. The portal route returns
        // `text/html` (a replacement row fragment) which HTMX swaps into
        // `[data-approval-id=...]` via `hx-swap="outerHTML"`. Returning an
        // empty body cleanly removes the row, which lets the test assert
        // both the contract (right endpoint hit) AND that the UI handles
        // a "decision processed" response without a real daemon round-trip.
        cy.intercept("POST", "**/api/approvals/GATE-APPROVE/approve", {
            statusCode: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
            body: "",
        }).as("approveGate");

        cy.visit("/approvals");

        // Wait for HTMX to attach behavior to the button before clicking.
        cy.get('[data-approval-id="GATE-APPROVE"]')
            .find('button[hx-post*="approve"]')
            .should("be.visible")
            .click();

        // Contract check: HTMX POSTed to the approve endpoint. The button
        // has no `hx-vals`, so the request body is empty; CSRF (when
        // enabled — see `server/security/csrf-protection.ts`) flows via
        // the `X-CSRF-Token` header that HTMX picks up from the page's
        // CSRF meta tag.
        cy.wait("@approveGate").then((interception) => {
            expect(interception.request.url).to.include(
                "/api/approvals/GATE-APPROVE/approve",
            );
            expect(interception.request.method).to.equal("POST");
        });

        // Row removed by HTMX outerHTML swap with empty mock response.
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

        // Mock the HTMX reject response. See `approves a gate via button
        // click` above for the rationale — same swap target, same contract.
        cy.intercept("POST", "**/api/approvals/GATE-REJECT/reject", {
            statusCode: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
            body: "",
        }).as("rejectGate");

        cy.visit("/approvals");

        // Wait for HTMX to attach behavior to the button before clicking.
        cy.get('[data-approval-id="GATE-REJECT"]')
            .find('button[hx-post*="reject"]')
            .should("be.visible")
            .click();

        // Contract check: HTMX POSTed to the reject endpoint.
        cy.wait("@rejectGate").then((interception) => {
            expect(interception.request.url).to.include(
                "/api/approvals/GATE-REJECT/reject",
            );
            expect(interception.request.method).to.equal("POST");
        });

        // Row removed by HTMX outerHTML swap with empty mock response.
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

        // Seed the gate AND an overlaying "rejected" decision. The
        // ledger reader (`server/wiring/request-ledger-reader.ts`)
        // overlays gate-decision files on top of request-action files:
        // a "rejected" decision flips the request to `done`, so the
        // approvals page (which filters `status === "gate"`) must not
        // list it. (An "approved" decision leaves the action-status
        // alone — the daemon advances the phase on its next loop, and
        // until then the request is still effectively gated. Use
        // "rejected" to verify the overlay path that doesn't depend on
        // a live daemon write-back.)
        cy.seedRequest("DECIDED-GATE", gate);
        cy.seedGateDecision("test-repo", "DECIDED-GATE", {
            id: "DECIDED-GATE",
            repo: "test-repo",
            state: "rejected",
            decision: "rejected",
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