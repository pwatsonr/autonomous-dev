// PLAN-021 Phase 1A — Cypress custom commands.
//
// Type declarations + helpers used by all Phase 2 specs. The
// `resetState`/`seedRequest`/`seedGateDecision` chainables wrap the
// matching tasks defined in cypress.config.ts.

/// <reference types="cypress" />

declare global {
    namespace Cypress {
        interface Chainable {
            resetState(): Chainable<null>;
            seedRequest(id: string, data: object): Chainable<null>;
            seedGateDecision(repo: string, id: string, data: object): Chainable<null>;
            // FR-021-07 follow-up — cost-ledger fixture surface.
            seedCostLedger(usd: number): Chainable<null>;
            backupCostLedger(
                backupPath: string,
            ): Chainable<{ backedUp: boolean; source: string }>;
            restoreCostLedger(
                backupPath: string,
            ): Chainable<{ restored: boolean }>;
            readCostLedger(): Chainable<unknown>;
        }
    }
}

Cypress.Commands.add("resetState", () => {
    return cy.task("clearStateDir");
});

Cypress.Commands.add("seedRequest", (id: string, data: object) => {
    return cy.task("writeRequestAction", { id, content: data });
});

Cypress.Commands.add(
    "seedGateDecision",
    (repo: string, id: string, data: object) => {
        return cy.task("writeGateDecision", { repo, id, content: data });
    },
);

// FR-021-07 follow-up — Cost-ledger seeding helpers.
//
// Why these are separate from `seedRequest`: the daemon writes the cost
// ledger at `${state_dir}/cost-ledger.json` with a `{daily: {YYYY-MM-DD:
// {total_usd}}}` schema — it is NOT one-file-per-request-id like the
// request-actions dir. The MTD-spend consistency spec needs a known
// value across Dashboard / Costs / Requests, so we write the file
// directly with a single entry pinned to today's UTC date.
Cypress.Commands.add("seedCostLedger", (usd: number) => {
    return cy.task("seedCostLedger", { usd });
});

Cypress.Commands.add("backupCostLedger", (backupPath: string) => {
    return cy.task("backupCostLedger", { backupPath });
});

Cypress.Commands.add("restoreCostLedger", (backupPath: string) => {
    return cy.task("restoreCostLedger", { backupPath });
});

Cypress.Commands.add("readCostLedger", () => {
    return cy.task("readCostLedger");
});

export {};
