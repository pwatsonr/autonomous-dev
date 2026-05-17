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

export {};
