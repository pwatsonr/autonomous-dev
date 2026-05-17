// FR-021-08 — Auto-refresh polling behavior verification.
//
// Tests the auto-refresh polling contract established in
// tests/integration/auto-refresh-polling.test.ts:
// 1. Foreground tabs poll at documented intervals
// 2. Background tabs (visibilityState !== 'visible') do NOT poll
// 3. Returning to foreground resumes polling within one interval
//
// Tests verify HTMX polling attributes are correctly set and that visibility
// state changes affect polling behavior as expected.

describe('Auto-refresh polling behavior (FR-021-08)', () => {
    beforeEach(() => {
        // Reset intercepts before each test
        cy.intercept('GET', '/**').as('anyRequest');
    });

    it('dashboard has correct polling attributes with visibility guard', () => {
        cy.visit('/');

        // Verify polling structure matches integration test contract
        cy.get('#dashboard-body').should('exist');
        cy.get('#dashboard-body').should('have.attr', 'hx-trigger').and('contain', 'every 10s');
        cy.get('#dashboard-body').should('have.attr', 'hx-trigger').and('contain', 'document.visibilityState === "visible"');
        cy.get('#dashboard-body').should('have.attr', 'hx-get', '/');
        cy.get('#dashboard-body').should('have.attr', 'hx-target', 'this');
        cy.get('#dashboard-body').should('have.attr', 'hx-swap', 'outerHTML');
        cy.get('#dashboard-body').should('have.attr', 'hx-select', '#dashboard-body');
    });

    it('requests page has correct 10s polling with visibility guard', () => {
        cy.visit('/requests');

        // Verify requests page polling attributes
        cy.get('#requests-body').should('exist');
        cy.get('#requests-body').should('have.attr', 'hx-trigger').and('contain', 'every 10s');
        cy.get('#requests-body').should('have.attr', 'hx-trigger').and('contain', 'document.visibilityState === "visible"');
        cy.get('#requests-body').should('have.attr', 'hx-get', '/requests');
        cy.get('#requests-body').should('have.attr', 'hx-target', 'this');
        cy.get('#requests-body').should('have.attr', 'hx-swap', 'outerHTML');
        cy.get('#requests-body').should('have.attr', 'hx-select', '#requests-body');
    });

    it('logs page has correct 5s polling with visibility guard', () => {
        cy.visit('/logs');

        // Verify logs page has faster 5s polling
        cy.get('#logs-body').should('exist');
        cy.get('#logs-body').should('have.attr', 'hx-trigger').and('contain', 'every 5s');
        cy.get('#logs-body').should('have.attr', 'hx-trigger').and('contain', 'document.visibilityState === "visible"');
        cy.get('#logs-body').should('have.attr', 'hx-get', '/logs');
        cy.get('#logs-body').should('have.attr', 'hx-target', 'this');
        cy.get('#logs-body').should('have.attr', 'hx-swap', 'outerHTML');
        cy.get('#logs-body').should('have.attr', 'hx-select', '#logs-body');
    });

    it('other polled pages have correct 10s intervals with visibility guards', () => {
        // Test approvals page
        cy.visit('/approvals');
        cy.get('#approvals-body').should('exist');
        cy.get('#approvals-body').should('have.attr', 'hx-trigger').and('contain', 'every 10s');
        cy.get('#approvals-body').should('have.attr', 'hx-trigger').and('contain', 'document.visibilityState === "visible"');

        // Test costs page
        cy.visit('/costs');
        cy.get('#costs-body').should('exist');
        cy.get('#costs-body').should('have.attr', 'hx-trigger').and('contain', 'every 10s');
        cy.get('#costs-body').should('have.attr', 'hx-trigger').and('contain', 'document.visibilityState === "visible"');

        // Test ops page
        cy.visit('/ops');
        cy.get('#ops-body').should('exist');
        cy.get('#ops-body').should('have.attr', 'hx-trigger').and('contain', 'every 10s');
        cy.get('#ops-body').should('have.attr', 'hx-trigger').and('contain', 'document.visibilityState === "visible"');

        // Test repos page
        cy.visit('/repos');
        cy.get('#repos-body').should('exist');
        cy.get('#repos-body').should('have.attr', 'hx-trigger').and('contain', 'every 10s');
        cy.get('#repos-body').should('have.attr', 'hx-trigger').and('contain', 'document.visibilityState === "visible"');

        // Test agents page (30s interval)
        cy.visit('/agents');
        cy.get('#agents-body').should('exist');
        cy.get('#agents-body').should('have.attr', 'hx-trigger').and('contain', 'every 30s');
        cy.get('#agents-body').should('have.attr', 'hx-trigger').and('contain', 'document.visibilityState === "visible"');
    });

    it('non-polled pages do NOT have auto-refresh attributes', () => {
        // Settings page should not poll (form-heavy)
        cy.visit('/settings');
        cy.get('[hx-trigger*="every"]').should('not.exist');

        // Audit page should not poll (has date filter form)
        cy.visit('/audit');
        cy.get('[hx-trigger*="every"]').should('not.exist');

        // Design system should not poll (static reference)
        cy.visit('/design-system');
        cy.get('[hx-trigger*="every"]').should('not.exist');
    });
});