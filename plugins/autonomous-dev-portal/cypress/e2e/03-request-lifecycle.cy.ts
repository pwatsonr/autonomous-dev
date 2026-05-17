// FR-021-03 — Request lifecycle end-to-end test.
//
// Tests that requests appear in the portal when seeded and update when their
// phase/status changes. Validates the core request-tracking workflow that
// operators rely on to monitor autonomous-dev progress.
//
// Key behaviors tested:
// - Running requests appear in Active requests table
// - Phase transitions update the UI appropriately
// - Status changes move requests between sections (Active vs Done)
// - Portal reads from filesystem state correctly

import { aRequest, aDone } from '../support/builders';

describe('Request Lifecycle (FR-021-03)', () => {
    const stateDir = '/tmp/cypress-state';

    beforeEach(() => {
        // Clean state before each test to ensure isolation
        cy.task('cleanStateDir', stateDir);
    });

    after(() => {
        // Clean up after all tests in this suite
        cy.task('cleanStateDir', stateDir);
    });

    it('shows running request in Active requests table', () => {
        // Create a running request in PRD phase
        const request = aRequest({
            id: 'REQ-CYTEST-ACTIVE',
            title: 'Test feature implementation',
            phase: 'PRD',
            status: 'running',
            repo: 'test-app',
            cost: 2.45
        });

        // Seed the request to filesystem
        cy.task('seedRequests', { stateDir, requests: [request] });

        // Visit dashboard and verify request appears
        cy.visit('/');

        // Check that request appears in Active requests table
        cy.get('#requests-tbl', { timeout: 10000 })
            .should('be.visible')
            .within(() => {
                cy.contains('REQ-CYTEST-ACTIVE').should('be.visible');
                cy.contains('Test feature implementation').should('be.visible');
                cy.contains('PRD').should('be.visible');
                cy.contains('test-app').should('be.visible');
                cy.contains('$2.45').should('be.visible');
            });
    });

    it('updates phase when request file is modified', () => {
        // Create initial request in PRD phase
        const initialRequest = aRequest({
            id: 'REQ-CYTEST-PHASE',
            title: 'Phase transition test',
            phase: 'PRD',
            status: 'running',
            repo: 'test-app'
        });

        // Seed initial state
        cy.task('seedRequests', { stateDir, requests: [initialRequest] });

        // Visit and verify initial state
        cy.visit('/');
        cy.get('#requests-tbl')
            .should('contain', 'REQ-CYTEST-PHASE')
            .should('contain', 'PRD');

        // Update request to CODE phase
        const updatedRequest = {
            ...initialRequest,
            phase: 'CODE'
        };
        cy.task('seedRequests', { stateDir, requests: [updatedRequest] });

        // Wait a moment for file system changes to be detected
        cy.wait(1000);

        // Refresh page to see changes (polling not implemented in Phase 1A)
        cy.reload();

        // Verify phase chip updated to CODE
        cy.get('#requests-tbl')
            .should('contain', 'REQ-CYTEST-PHASE')
            .should('contain', 'CODE')
            .should('not.contain', 'PRD');
    });

    it('moves completed request from Active table', () => {
        // Create a running request
        const runningRequest = aRequest({
            id: 'REQ-CYTEST-DONE',
            title: 'Request to complete',
            phase: 'CODE',
            status: 'running',
            repo: 'test-app'
        });

        // Seed initial running state
        cy.task('seedRequests', { stateDir, requests: [runningRequest] });

        // Visit and verify request is in Active table
        cy.visit('/');
        cy.get('#requests-tbl')
            .should('contain', 'REQ-CYTEST-DONE');

        // Update request to done status
        const completedRequest = aDone({
            id: 'REQ-CYTEST-DONE',
            title: 'Request to complete',
            status: 'done',
            phase: 'complete',
            repo: 'test-app'
        });
        cy.task('seedRequests', { stateDir, requests: [completedRequest] });

        // Refresh to see changes
        cy.reload();

        // Verify request is no longer in Active table
        // (Dashboard filters out status !== "running" from Active requests)
        cy.get('#requests-tbl')
            .should('not.contain', 'REQ-CYTEST-DONE');
    });

    it('handles multiple requests with different statuses', () => {
        // Create a mix of request statuses
        const requests = [
            aRequest({
                id: 'REQ-CYTEST-MULTI-1',
                title: 'Running request',
                phase: 'PRD',
                status: 'running',
                repo: 'app-1'
            }),
            aRequest({
                id: 'REQ-CYTEST-MULTI-2',
                title: 'Another running request',
                phase: 'CODE',
                status: 'running',
                repo: 'app-2'
            }),
            aDone({
                id: 'REQ-CYTEST-MULTI-3',
                title: 'Completed request',
                repo: 'app-3'
            })
        ];

        // Seed all requests
        cy.task('seedRequests', { stateDir, requests });

        // Visit dashboard
        cy.visit('/');

        // Verify only running requests appear in Active table
        cy.get('#requests-tbl')
            .should('contain', 'REQ-CYTEST-MULTI-1')
            .should('contain', 'REQ-CYTEST-MULTI-2')
            .should('not.contain', 'REQ-CYTEST-MULTI-3');

        // Verify both running requests show different phases
        cy.get('#requests-tbl').within(() => {
            cy.contains('tr', 'REQ-CYTEST-MULTI-1').should('contain', 'PRD');
            cy.contains('tr', 'REQ-CYTEST-MULTI-2').should('contain', 'CODE');
        });
    });
});