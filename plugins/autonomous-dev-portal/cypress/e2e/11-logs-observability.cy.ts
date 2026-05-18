// REQ-000011 — Enhanced logs observability surface tests
//
// Tests the redesigned logs page with:
// - Multi-select level filtering
// - Full-text search with highlighting
// - Time-range picker (relative/absolute)
// - Server-side pagination with stable cursor
// - Multi-source log support (daemon/portal/audit)
// - Collapsible JSON context trees
// - Click-to-filter functionality
// - URL state preservation

describe('Logs Observability Surface (REQ-000011)', () => {
    beforeEach(() => {
        // Visit logs page
        cy.visit('/logs');

        // Wait for initial load
        cy.get('#logs-container').should('be.visible');
    });

    describe('Level filtering', () => {
        it('should support multi-select level filtering', () => {
            // Open level filter dropdown
            cy.get('[data-testid="level-filter"]').click();

            // Check multiple levels
            cy.get('[data-testid="level-checkbox-info"]').check();
            cy.get('[data-testid="level-checkbox-warn"]').check();
            cy.get('[data-testid="level-checkbox-error"]').check();

            // Apply filter
            cy.get('[data-testid="apply-level-filter"]').click();

            // Verify only selected levels are shown
            cy.get('.log-line').should('exist');
            cy.get('.log-line .level-debug').should('not.exist');
            cy.get('.log-line .level-trace').should('not.exist');

            // Verify URL is updated
            cy.url().should('include', 'level=info,warn,error');
        });

        it('should maintain level filter across page reloads', () => {
            // Apply filter
            cy.get('[data-testid="level-filter"]').click();
            cy.get('[data-testid="level-checkbox-error"]').check();
            cy.get('[data-testid="apply-level-filter"]').click();

            // Reload page
            cy.reload();

            // Verify filter is maintained
            cy.get('[data-testid="level-filter"]').should('contain', 'Error');
            cy.get('.log-line').each(($el) => {
                cy.wrap($el).find('.level').should('have.class', 'level-error');
            });
        });
    });

    describe('Full-text search', () => {
        it('should search across message and structured fields', () => {
            // Enter search term
            cy.get('[data-testid="search-input"]').type('request started');
            cy.get('[data-testid="search-button"]').click();

            // Verify results contain search term
            cy.get('.log-line').should('exist');
            cy.get('.log-line .message').should('contain.text', 'request started');

            // Verify search term is highlighted
            cy.get('.search-highlight').should('exist');
            cy.get('.search-highlight').should('contain.text', 'request started');
        });

        it('should highlight multiple search matches', () => {
            cy.get('[data-testid="search-input"]').type('REQ-');
            cy.get('[data-testid="search-button"]').click();

            // Count highlights
            cy.get('.search-highlight').should('have.length.greaterThan', 1);
        });

        it('should search in JSON context fields', () => {
            cy.get('[data-testid="search-input"]').type('pid');
            cy.get('[data-testid="search-button"]').click();

            // Should find results with pid in context
            cy.get('.log-line').should('exist');
        });
    });

    describe('Time range picker', () => {
        it('should support relative time ranges', () => {
            // Open time range picker
            cy.get('[data-testid="time-range-picker"]').click();

            // Select relative range
            cy.get('[data-testid="relative-tab"]').click();
            cy.get('[data-testid="relative-5m"]').click();

            // Apply
            cy.get('[data-testid="apply-time-range"]').click();

            // Verify URL contains time range
            cy.url().should('include', 'range=5m');
        });

        it('should support absolute time ranges', () => {
            // Open time range picker
            cy.get('[data-testid="time-range-picker"]').click();

            // Select absolute range
            cy.get('[data-testid="absolute-tab"]').click();

            // Set from date/time
            const fromDate = new Date();
            fromDate.setHours(fromDate.getHours() - 1);
            cy.get('[data-testid="from-date"]').type(fromDate.toISOString().slice(0, 16));

            // Set to date/time
            cy.get('[data-testid="to-date"]').type(new Date().toISOString().slice(0, 16));

            // Apply
            cy.get('[data-testid="apply-time-range"]').click();

            // Verify URL contains absolute time range
            cy.url().should('include', 'from=');
            cy.url().should('include', 'to=');
        });
    });

    describe('Source filtering', () => {
        it('should support filtering by log source', () => {
            // Open source filter
            cy.get('[data-testid="source-filter"]').click();

            // Select daemon logs only
            cy.get('[data-testid="source-daemon"]').check();
            cy.get('[data-testid="source-portal"]').uncheck();
            cy.get('[data-testid="source-audit"]').uncheck();

            // Apply filter
            cy.get('[data-testid="apply-source-filter"]').click();

            // Verify only daemon logs are shown
            cy.get('.log-line').each(($el) => {
                cy.wrap($el).should('have.attr', 'data-source', 'daemon');
            });
        });

        it('should show merged timeline view by default', () => {
            // Verify logs from multiple sources are present
            cy.get('.log-line[data-source="daemon"]').should('exist');
            cy.get('.log-line[data-source="portal"]').should('exist');

            // Verify they are sorted by timestamp
            let previousTime = 0;
            cy.get('.log-line time').each(($el) => {
                const time = new Date($el.attr('datetime')).getTime();
                expect(time).to.be.greaterThan(previousTime);
                previousTime = time;
            });
        });
    });

    describe('JSON context trees', () => {
        it('should show collapsible JSON context', () => {
            // Find log line with context
            cy.get('.log-line[data-has-context="true"]').first().as('contextLine');

            // Verify context is initially collapsed
            cy.get('@contextLine').find('.context-tree').should('not.be.visible');

            // Expand context
            cy.get('@contextLine').find('.expand-context').click();

            // Verify context tree is now visible
            cy.get('@contextLine').find('.context-tree').should('be.visible');
            cy.get('@contextLine').find('.json-key').should('exist');
            cy.get('@contextLine').find('.json-value').should('exist');
        });

        it('should support click-to-filter on JSON values', () => {
            // Expand a context tree
            cy.get('.log-line[data-has-context="true"]').first().as('contextLine');
            cy.get('@contextLine').find('.expand-context').click();

            // Click on a JSON value to add as filter
            cy.get('@contextLine').find('.json-value').first().click();

            // Verify filter is applied
            cy.get('.active-filters').should('be.visible');
            cy.get('.filter-chip').should('exist');

            // Verify results are filtered
            cy.get('.log-line').should('have.length.lessThan', 10); // Should reduce results
        });
    });

    describe('Pagination', () => {
        it('should support server-side pagination', () => {
            // Load initial page
            cy.get('.log-line').should('have.length.greaterThan', 0);

            // Load more if pagination controls exist
            cy.get('body').then($body => {
                if ($body.find('[data-testid="load-more"]').length > 0) {
                    cy.get('[data-testid="load-more"]').click();

                    // Verify more logs loaded
                    cy.get('.log-line').should('have.length.greaterThan', 50);
                }
            });
        });

        it('should maintain stable cursor across operations', () => {
            // Apply a filter
            cy.get('[data-testid="level-filter"]').click();
            cy.get('[data-testid="level-checkbox-error"]').check();
            cy.get('[data-testid="apply-level-filter"]').click();

            // Note the first visible log
            cy.get('.log-line').first().should('have.attr', 'data-log-id').then((firstId) => {
                // Refresh the logs (simulate auto-refresh)
                cy.get('[data-testid="refresh-logs"]').click();

                // Verify the same log is still first (stable cursor)
                cy.get('.log-line').first().should('have.attr', 'data-log-id', firstId);
            });
        });
    });

    describe('URL state preservation', () => {
        it('should preserve all filter state in URL', () => {
            // Apply multiple filters
            cy.get('[data-testid="level-filter"]').click();
            cy.get('[data-testid="level-checkbox-error"]').check();
            cy.get('[data-testid="apply-level-filter"]').click();

            cy.get('[data-testid="search-input"]').type('request');
            cy.get('[data-testid="search-button"]').click();

            cy.get('[data-testid="source-filter"]').click();
            cy.get('[data-testid="source-daemon"]').check();
            cy.get('[data-testid="apply-source-filter"]').click();

            // Verify URL contains all filters
            cy.url().should('include', 'level=error');
            cy.url().should('include', 'search=request');
            cy.url().should('include', 'source=daemon');
        });

        it('should restore filter state from URL on page load', () => {
            // Visit with URL parameters
            cy.visit('/logs?level=error,warn&search=request&source=daemon&range=1h');

            // Verify filters are applied
            cy.get('[data-testid="level-filter"]').should('contain', 'Error, Warn');
            cy.get('[data-testid="search-input"]').should('have.value', 'request');
            cy.get('[data-testid="source-filter"]').should('contain', 'Daemon');
            cy.get('[data-testid="time-range-picker"]').should('contain', '1h');
        });
    });

    describe('Color coding and visual design', () => {
        it('should have distinct colors for different log levels', () => {
            // Verify error logs have error styling
            cy.get('.log-line .level-error').should('have.class', 'level-error');
            cy.get('.log-line .level-error').should('have.css', 'color').and('not.equal', 'rgb(0, 0, 0)');

            // Verify warn logs have warn styling
            cy.get('.log-line .level-warn').should('have.class', 'level-warn');
            cy.get('.log-line .level-warn').should('have.css', 'color').and('not.equal', 'rgb(0, 0, 0)');

            // Verify info logs are muted
            cy.get('.log-line .level-info').should('have.class', 'level-info');
        });

        it('should highlight search terms distinctly', () => {
            cy.get('[data-testid="search-input"]').type('request');
            cy.get('[data-testid="search-button"]').click();

            // Verify highlight styling
            cy.get('.search-highlight').should('have.css', 'background-color').and('not.equal', 'rgba(0, 0, 0, 0)');
        });
    });

    describe('Auto-refresh functionality', () => {
        it('should maintain HTMX auto-refresh', () => {
            // Verify auto-refresh is configured
            cy.get('#logs-container').should('have.attr', 'hx-get', '/logs');
            cy.get('#logs-container').should('have.attr', 'hx-trigger').and('include', '5s');
        });

        it('should preserve filter state during auto-refresh', () => {
            // Apply filters
            cy.get('[data-testid="level-filter"]').click();
            cy.get('[data-testid="level-checkbox-error"]').check();
            cy.get('[data-testid="apply-level-filter"]').click();

            // Wait for auto-refresh interval (mock or wait)
            cy.wait(6000);

            // Verify filter is still applied
            cy.get('[data-testid="level-filter"]').should('contain', 'Error');
        });
    });

    describe('Empty states and error handling', () => {
        it('should handle empty log state gracefully', () => {
            // Visit logs with filters that return no results
            cy.visit('/logs?level=trace&search=nonexistent-search-term');

            // Verify empty state is shown
            cy.get('[data-testid="empty-state"]').should('be.visible');
            cy.get('[data-testid="empty-state"]').should('contain', 'No logs found');
        });

        it('should handle bad query parameters gracefully', () => {
            // Visit with invalid parameters
            cy.visit('/logs?level=invalid&from=bad-date', { failOnStatusCode: false });

            // Should return 200 and show logs page with default state
            cy.get('#logs-container').should('be.visible');
            cy.get('.log-line').should('exist');
        });
    });
});