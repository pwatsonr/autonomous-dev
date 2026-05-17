// PLAN-021 Phase 1A — Navigation smoke test.
//
// Covers GET / only (Phase 1A scope; Phase 1B+ will expand to other routes).
// Verifies the portal loads without console errors and renders expected elements.

describe('Navigation smoke (Phase 1A)', () => {
    it('GET / returns 200 with no console errors', () => {
        cy.visit('/');
        cy.get('h1').should('exist');
        cy.get('aside.rail').should('be.visible');
    });
});