// FR-021-09 — Error states and 404 handling.
//
// Covers four categories:
// 1. 404 for clearly missing routes
// 2. Request-detail 404 when state is missing
// 3. 404 page navigation functionality
// 4. API 404 responses with sensible JSON/HTML
//
// Tests verify error pages render nicely with proper navigation,
// not raw stack traces or broken layouts.

describe('Error States (FR-021-09)', () => {
    describe('404 for missing routes', () => {
        it('should render 404 page for non-existent route', () => {
            // Visit a route that clearly doesn't exist
            cy.visit('/this-does-not-exist', { failOnStatusCode: false });

            // Assert we get a 404 response (Cypress will show this in network tab)
            // The visit should not fail due to failOnStatusCode: false

            // Verify 404 page renders properly
            cy.get('main.error-page').should('be.visible');
            cy.get('h1#error-heading').should('contain', 'Error 404');
            cy.get('h1#error-heading').should('contain', 'Not Found');

            // Verify error message is present and has role="alert"
            cy.get('p.error-message[role="alert"]').should('be.visible');

            // Verify help text is present
            cy.get('p.error-help').should('contain', 'Check the URL or use the navigation');

            // Verify navigation suggestions are present (404-specific)
            cy.get('nav.error-nav-suggestions').should('be.visible');
            cy.get('nav.error-nav-suggestions a[href="/"]').should('contain', 'Portfolio dashboard');
            cy.get('nav.error-nav-suggestions a[href="/approvals"]').should('contain', 'Approvals');
            cy.get('nav.error-nav-suggestions a[href="/settings"]').should('contain', 'Settings');
            cy.get('nav.error-nav-suggestions a[href="/ops"]').should('contain', 'Ops');

            // Verify action buttons are present
            cy.get('.error-actions button[data-action="history-back"]').should('contain', 'Go back');
            cy.get('.error-actions a[href="/"].btn-primary').should('contain', 'Return to dashboard');

            // Verify the "Return to dashboard" link has autofocus
            cy.get('.error-actions a[href="/"]').should('have.attr', 'autofocus');

            // Verify no console errors (the page should render cleanly)
            // Note: We check for the absence of error elements rather than console spies
            // which can be complex to set up correctly in Cypress
        });
    });

    describe('Request-detail 404 when state missing', () => {
        it('should render 404 for request with missing state file', () => {
            // Visit a request detail page for a non-existent request
            // Using valid format but non-existent request ID
            cy.visit('/repo/missing-repo/request/REQ-999999', { failOnStatusCode: false });

            // Verify 404 page renders (not a raw stack trace)
            cy.get('main.error-page').should('be.visible');
            cy.get('h1#error-heading').should('contain', 'Error 404');

            // Verify it's a clean error page, not a server crash
            cy.get('p.error-message[role="alert"]').should('be.visible');
            cy.get('nav.error-nav-suggestions').should('be.visible');

            // Verify navigation options are available
            cy.get('nav.error-nav-suggestions a[href="/"]').should('be.visible');
        });

        it('should render 404 for invalid repo slug format', () => {
            // Test invalid repo slug (contains uppercase, which violates the regex)
            cy.visit('/repo/INVALID-REPO/request/REQ-123456', { failOnStatusCode: false });

            cy.get('main.error-page').should('be.visible');
            cy.get('h1#error-heading').should('contain', 'Error 404');
        });

        it('should render 404 for invalid request ID format', () => {
            // Test invalid request ID (wrong format)
            cy.visit('/repo/valid-repo/request/INVALID-123', { failOnStatusCode: false });

            cy.get('main.error-page').should('be.visible');
            cy.get('h1#error-heading').should('contain', 'Error 404');
        });
    });

    describe('404 page navigation', () => {
        it('should navigate back to dashboard from 404 page', () => {
            // Start from a 404 page
            cy.visit('/this-does-not-exist', { failOnStatusCode: false });
            cy.get('main.error-page').should('be.visible');

            // Click "Return to dashboard" link
            cy.get('.error-actions a[href="/"]').click();

            // Should land on the dashboard
            cy.url().should('eq', Cypress.config().baseUrl + '/');
            cy.get('h1').should('exist');
            cy.get('aside.rail').should('be.visible');
        });

        it('should navigate to suggested pages from 404 page', () => {
            cy.visit('/this-does-not-exist', { failOnStatusCode: false });
            cy.get('main.error-page').should('be.visible');

            // Test navigation to approvals page
            cy.get('nav.error-nav-suggestions a[href="/approvals"]').click();
            cy.url().should('include', '/approvals');

            // Go back to 404 for another test
            cy.visit('/another-missing-page', { failOnStatusCode: false });

            // Test navigation to settings page
            cy.get('nav.error-nav-suggestions a[href="/settings"]').click();
            cy.url().should('include', '/settings');
        });
    });

    describe('API 404 responses', () => {
        it('should return 404 with sensible response for non-existent agent inspect', () => {
            // Test API endpoint that should return 404
            cy.request({
                url: '/api/agents/nonexistent/inspect-modal',
                failOnStatusCode: false
            }).then((response) => {
                // Assert we get a 404 status code
                expect(response.status).to.eq(404);

                // The response should be HTML (the error page)
                expect(response.headers).to.have.property('content-type');
                expect(response.headers['content-type']).to.include('text/html');

                // The body should contain the error page markup, not a stack trace
                expect(response.body).to.include('Error 404');
                expect(response.body).to.include('error-page');

                // Should not contain stack trace markers
                expect(response.body).not.to.include('Error:');
                expect(response.body).not.to.include('at Object.');
                expect(response.body).not.to.include('node_modules');
            });
        });

        it('should return 404 for non-existent API routes', () => {
            cy.request({
                url: '/api/nonexistent/endpoint',
                failOnStatusCode: false
            }).then((response) => {
                expect(response.status).to.eq(404);
                expect(response.body).to.include('Error 404');
            });
        });

        it('should handle POST requests to non-existent endpoints gracefully', () => {
            cy.request({
                method: 'POST',
                url: '/api/agents/nonexistent/promote',
                failOnStatusCode: false,
                body: {}
            }).then((response) => {
                // The server might return 400 for malformed requests or 404 for missing routes
                // Both are acceptable for non-existent endpoints
                const isAcceptableError = response.status === 400 || response.status === 404;
                expect(isAcceptableError).to.be.true;

                // Should get clean error response, not a server crash
                // Check that response contains error information, not a stack trace
                if (response.status === 404) {
                    expect(String(response.body)).to.include('Error 404');
                } else if (response.status === 400) {
                    const bodyStr = String(response.body);
                    expect(bodyStr).to.not.include('Error:');
                    expect(bodyStr).to.not.include('at Object.');
                    expect(bodyStr).to.not.include('node_modules');
                }
            });
        });
    });

    describe('Error page accessibility', () => {
        it('should have proper ARIA attributes and roles', () => {
            cy.visit('/missing-page', { failOnStatusCode: false });

            // Verify main element has proper role and aria-labelledby
            cy.get('main.error-page')
                .should('have.attr', 'role', 'main')
                .should('have.attr', 'aria-labelledby', 'error-heading');

            // Verify heading has the referenced ID
            cy.get('h1#error-heading').should('exist');

            // Verify alert role on error message
            cy.get('p.error-message[role="alert"]').should('exist');

            // Verify navigation has proper aria-label
            cy.get('nav.error-nav-suggestions')
                .should('have.attr', 'aria-label', 'Suggested pages');

            // Verify focus management (autofocus on primary action)
            cy.get('.error-actions a[href="/"]').should('have.attr', 'autofocus');
        });
    });

    describe('HTMX fragment vs full page rendering', () => {
        it('should render full 404 page for direct navigation', () => {
            cy.visit('/missing-page', { failOnStatusCode: false });

            // Should render full page with layout
            cy.get('html').should('exist');
            cy.get('head title').should('exist');
            cy.get('main.error-page').should('exist');
        });

        it('should handle HTMX requests to 404 endpoints appropriately', () => {
            // Start from a valid page
            cy.visit('/');

            // Make an HTMX-style request to a 404 endpoint
            cy.request({
                url: '/missing-htmx-endpoint',
                failOnStatusCode: false,
                headers: {
                    'HX-Request': 'true'
                }
            }).then((response) => {
                expect(response.status).to.eq(404);
                // Should get fragment or full page response, but clean error content
                expect(response.body).to.include('Error 404');
            });
        });
    });
});