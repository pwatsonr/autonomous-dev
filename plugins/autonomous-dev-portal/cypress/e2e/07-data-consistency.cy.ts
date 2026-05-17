// FR-021-07 — Dashboard data consistency.
//
// Verifies that gate counts shown on the Dashboard "Awaiting approval" KPI
// agree with the count shown on the /approvals page header within the same
// session. Both surfaces read from the same daemon state (request-action
// files in $AUTONOMOUS_DEV_STATE_DIR/request-actions), so any disagreement
// is a reader bug.
//
// MTD-spend extension (follow-up to PR #294): cross-page MTD consistency
// is now covered via a cost-ledger seeding helper (`cy.seedCostLedger`).
// All three pages (Dashboard, Costs, Requests) call the same `readMtdSpend()`
// reader in `server/wiring/daemon-readers.ts`, so the agreement assertion
// here would fail if any page diverged from the canonical source.
//
// Uses the FR-021-04 fixture API (resetState + seedRequest) so this spec
// shares the existing builder surface; the new cost-ledger helpers extend
// it without breaking the existing tests.

import { aGate } from "../support/builders";

// 5s in-memory cache on `readMtdSpend()` (daemon-readers.ts:CACHE_TTL_MS).
// Wait one full cycle plus a safety margin after seeding so the first
// portal read for the spec sees fresh disk state. The agreement assertion
// itself does not depend on this — two reads within 5s share the cached
// value either way — but the value-floor assertion does.
const MTD_CACHE_SETTLE_MS = 5500;

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

    // FR-021-07 follow-up — MTD-spend cross-page consistency.
    //
    // All three pages (Dashboard, Costs, Requests) call the same
    // `readMtdSpend()` reader; the value they render must be identical
    // within a 5s window. We seed a known dollar amount into the
    // cost-ledger, wait past the cache TTL so the first read picks up
    // the fresh disk value, then compare the rendered KPI text across
    // pages. Two pages can disagree only if a reader is wired wrong.
    describe("MTD spend cross-page consistency", () => {
        // Pin a backup path per-suite so the after() hook always knows
        // which file to restore from. The Date.now suffix prevents two
        // parallel runs (or a stuck run from a prior CI invocation) from
        // sharing the same backup blob.
        const backupPath = `/tmp/cypress-cost-ledger-backup-${String(
            Date.now(),
        )}.json`;

        before(() => {
            // Snapshot the operator's real `~/.autonomous-dev/cost-ledger.json`
            // even though the portal under test uses `AUTONOMOUS_DEV_STATE_DIR`
            // (so seeding writes to /tmp/cypress-state). Defense in depth:
            // if a future task path ever drifts back to the real file, the
            // operator's daily cost data is still recoverable.
            cy.backupCostLedger(backupPath);
        });

        after(() => {
            cy.restoreCostLedger(backupPath);
        });

        it("MTD spend matches between Dashboard KPI and /costs page", () => {
            const seeded = 42.5;
            cy.seedCostLedger(seeded);
            // Settle the daemon-reader cache so the next visit reads
            // fresh disk state, not a residual 0 from a prior visit.
            cy.wait(MTD_CACHE_SETTLE_MS);

            // Dashboard — read the MTD spend KPI.
            cy.visit("/");
            cy.contains(".kpi", "MTD spend").within(() => {
                cy.get(".kpi-num")
                    .invoke("text")
                    .then((dashMtd) => {
                        cy.wrap(dashMtd.trim()).as("dashMtd");
                    });
            });

            // Costs — read the MTD spend KPI from the same fragment id.
            cy.visit("/costs");
            cy.contains(".kpi", "MTD spend").within(() => {
                cy.get(".kpi-num")
                    .invoke("text")
                    .then((costsMtd) => {
                        cy.get<string>("@dashMtd").then((dashMtd) => {
                            expect(
                                costsMtd.trim(),
                                "dashboard MTD vs costs MTD",
                            ).to.eq(dashMtd);
                            // Floor — seeded value must show up in at
                            // least one of the two ($X.YZ rounded). The
                            // operator's real ledger is NOT used: the
                            // portal under test points at the cypress
                            // state dir, so the value we wrote is the
                            // only contributor to MTD.
                            expect(
                                costsMtd.trim(),
                                "seeded value rendered",
                            ).to.eq(`$${seeded.toFixed(2)}`);
                        });
                    });
            });
        });

        it("MTD spend matches between Dashboard KPI and /requests page", () => {
            const seeded = 73.21;
            cy.seedCostLedger(seeded);
            cy.wait(MTD_CACHE_SETTLE_MS);

            cy.visit("/");
            cy.contains(".kpi", "MTD spend").within(() => {
                cy.get(".kpi-num")
                    .invoke("text")
                    .then((dashMtd) => {
                        cy.wrap(dashMtd.trim()).as("dashMtd2");
                    });
            });

            // Requests page also surfaces an "MTD spend" KPI fed by the
            // same `readMtdSpend()` call (server/routes/requests.ts).
            cy.visit("/requests");
            cy.contains(".kpi", "MTD spend").within(() => {
                cy.get(".kpi-num")
                    .invoke("text")
                    .then((reqMtd) => {
                        cy.get<string>("@dashMtd2").then((dashMtd) => {
                            expect(
                                reqMtd.trim(),
                                "dashboard MTD vs requests MTD",
                            ).to.eq(dashMtd);
                            expect(
                                reqMtd.trim(),
                                "seeded value rendered",
                            ).to.eq(`$${seeded.toFixed(2)}`);
                        });
                    });
            });
        });
    });
});
