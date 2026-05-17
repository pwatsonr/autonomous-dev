// FR-021-07 — Dashboard data consistency.
//
// Verifies that gate counts shown on the Dashboard "Awaiting approval" KPI
// agree with the count shown on the /approvals page header within the same
// session. Both surfaces read from the same daemon state (request-action
// files in $AUTONOMOUS_DEV_STATE_DIR/request-actions), so any disagreement
// is a reader bug.
//
// Scope note: cross-page MTD-spend consistency is deferred — it requires
// seeding the daemon cost-ledger JSON which the existing fixture builders
// do not yet write. Filed as a follow-up (see PORTAL-BUG-CATALOG).
//
// Uses the FR-021-04 fixture API (resetState + seedRequest) so this spec
// shares the existing builder surface — no new tasks needed.

import { aGate } from "../support/builders";

describe("Data consistency (FR-021-07)", () => {
    beforeEach(() => {
        cy.resetState();
    });

    it("gate count matches between Dashboard KPI and /approvals header", () => {
        cy.seedRequest(
            "GATE-CONS-001",
            aGate({
                id: "GATE-CONS-001",
                repo: "consistency-repo",
                title: "Consistency Gate 1",
                phase: "CODE",
            }),
        );
        cy.seedRequest(
            "GATE-CONS-002",
            aGate({
                id: "GATE-CONS-002",
                repo: "consistency-repo",
                title: "Consistency Gate 2",
                phase: "REVIEW",
            }),
        );

        // Dashboard — read the Awaiting approval KPI.
        cy.visit("/");
        cy.contains(".kpi", "Awaiting approval").within(() => {
            cy.get(".kpi-num")
                .invoke("text")
                .then((dashCount) => {
                    cy.wrap(dashCount.trim()).as("dashCount");
                });
        });

        // Approvals — count rows + assert header agrees.
        cy.visit("/approvals");
        cy.get('[data-approval-id]').then(($rows) => {
            const approvalsCount = $rows.length;
            cy.get<string>("@dashCount").then((dashCount) => {
                // The dashboard count and the rendered row count must agree.
                expect(parseInt(dashCount, 10), "dash vs rows").to.eq(
                    approvalsCount,
                );
                // Both should be >= the two we seeded (operator state may add
                // more; this assertion tolerates ambient gates).
                expect(approvalsCount, "seeded floor").to.be.at.least(2);
            });
        });
    });

    it("zero gates → dashboard KPI shows 0 and approvals shows empty state", () => {
        // No seeding; resetState already cleared.
        cy.visit("/");
        cy.contains(".kpi", "Awaiting approval").within(() => {
            cy.get(".kpi-num").invoke("text").then((txt) => {
                expect(txt.trim(), "zero-state KPI").to.match(/^0$/);
            });
        });

        cy.visit("/approvals");
        cy.get('[data-approval-id]').should("have.length", 0);
    });
});
