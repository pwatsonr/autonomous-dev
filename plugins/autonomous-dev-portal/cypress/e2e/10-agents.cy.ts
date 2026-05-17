// FR-021-10 — Agent inspect modal + actions Cypress spec.
//
// Covers agent table, inspect modal functionality, and action buttons
// (Promote/Shadow/Freeze) with proper intercepted POSTs to avoid mutating
// real agent state.

describe('Agent Management (FR-021-10)', () => {
    beforeEach(() => {
        // Reset state between tests
        cy.request({
            method: 'POST',
            url: '/__test/reset',
            headers: {
                'X-Cypress-Test': '1'
            }
        });

        // Intercept all agent action endpoints to prevent real mutations
        cy.intercept('POST', '/api/agents/*/promote*', {
            statusCode: 200,
            body: { success: true, message: 'Agent promoted' }
        }).as('promoteAgent');

        cy.intercept('POST', '/api/agents/*/shadow', {
            statusCode: 200,
            body: { success: true, message: 'Agent moved to shadow mode' }
        }).as('shadowAgent');

        cy.intercept('POST', '/api/agents/*/freeze', {
            statusCode: 200,
            body: { success: true, message: 'Agent frozen' }
        }).as('freezeAgent');

        cy.intercept('POST', '/api/agents/*/unshadow', {
            statusCode: 200,
            body: { success: true, message: 'Agent unshadowed' }
        }).as('unshadowAgent');

        cy.intercept('POST', '/api/agents/*/unfreeze', {
            statusCode: 200,
            body: { success: true, message: 'Agent unfrozen' }
        }).as('unfreezeAgent');
    });

    it('visits /agents and verifies table has 18 rows (the real registry)', () => {
        cy.visit('/agents');
        cy.get('h1').should('contain', 'Agents');

        // Verify table exists and has expected structure
        cy.get('table.tbl').should('exist');
        cy.get('table.tbl thead tr th').should('have.length', 7);

        // The real registry should have 18 agents
        cy.get('table tbody tr[data-agent]').should('have.length', 18);

        // Verify the actual rendered headers (Agent/Version/Status/Mode/
        // Last dispatch/Runs (30d)/FP rate).
        cy.get('table.tbl thead').within(() => {
            cy.contains('th', 'Agent');
            cy.contains('th', 'Version');
            cy.contains('th', 'Status');
            cy.contains('th', 'Mode');
        });
    });

    it('clicks an agent row and verifies inspect modal opens', () => {
        cy.visit('/agents');

        // Get the first agent row
        cy.get('table tbody tr[data-agent]').first().then($row => {
            const agentName = $row.attr('data-agent');

            // Intercept the modal fetch request
            cy.intercept('GET', `/agents/${agentName}/inspect-modal`).as('fetchModal');

            // Click the agent row
            cy.get('table tbody tr[data-agent]').first().click();

            // Verify the modal fetch was called
            cy.wait('@fetchModal');

            // Verify modal appears in the modal-slot
            cy.get('#modal-slot').should('not.be.empty');
            cy.get('#modal-slot .modal').should('be.visible');
            cy.get('#modal-slot .modal h3').should('contain', agentName);
        });
    });

    it('verifies the modal contains agent name and version', () => {
        cy.visit('/agents');

        // Click first agent row
        cy.get('table tbody tr[data-agent]').first().then($row => {
            const agentName = $row.attr('data-agent');

            cy.intercept('GET', `/agents/${agentName}/inspect-modal`).as('fetchModal');
            $row.trigger('click');
            cy.wait('@fetchModal');

            // Verify modal content
            cy.get('#modal-slot .modal').within(() => {
                cy.get('h3').should('contain', agentName);

                // Check that stats grid has expected fields
                cy.get('dl.stats-grid').within(() => {
                    cy.contains('dt', 'Version').should('exist');
                    cy.contains('dt', 'Mode').should('exist');
                    cy.contains('dt', 'Last dispatch').should('exist');
                });

                // Verify action buttons are present
                cy.get('.modal-actions').should('exist');
                cy.get('button').should('have.length.at.least', 2); // At least Shadow/Freeze and Close
            });
        });
    });

    it('clicks Close button and verifies modal closes', () => {
        cy.visit('/agents');

        // Open modal
        cy.get('table tbody tr[data-agent]').first().click();
        cy.get('#modal-slot .modal').should('be.visible');

        // Click Close button
        cy.get('#modal-slot .modal .modal-actions button.ghost').click();

        // Verify modal disappears (the close handler clears innerHTML and reloads)
        cy.get('#modal-slot').should('be.empty');
    });

    it('action buttons - Shadow intercepts POST correctly', () => {
        cy.visit('/agents');

        // Click first agent row to open modal
        cy.get('table tbody tr[data-agent]').first().then($row => {
            const agentName = $row.attr('data-agent');

            cy.intercept('GET', `/agents/${agentName}/inspect-modal`).as('fetchModal');
            $row.trigger('click');
            cy.wait('@fetchModal');

            // Find and click Shadow button if it exists and is not disabled
            cy.get('#modal-slot .modal .modal-actions').within(() => {
                cy.get('button').contains('Shadow').then($btn => {
                    if (!$btn.is(':disabled')) {
                        cy.wrap($btn).click();

                        // Verify the intercepted POST was called
                        cy.wait('@shadowAgent').then((interception) => {
                            expect(interception.request.url).to.include(`/api/agents/${agentName}/shadow`);
                        });
                    } else {
                        // If disabled, just verify it exists
                        cy.wrap($btn).should('be.disabled');
                    }
                });
            });
        });
    });

    it('action buttons - Freeze intercepts POST correctly', () => {
        cy.visit('/agents');

        // Click first agent row to open modal
        cy.get('table tbody tr[data-agent]').first().then($row => {
            const agentName = $row.attr('data-agent');

            cy.intercept('GET', `/agents/${agentName}/inspect-modal`).as('fetchModal');
            $row.trigger('click');
            cy.wait('@fetchModal');

            // Find and click Freeze button if it exists and is not disabled
            cy.get('#modal-slot .modal .modal-actions').within(() => {
                cy.get('button').contains('Freeze').then($btn => {
                    if (!$btn.is(':disabled')) {
                        cy.wrap($btn).click();

                        // Verify the intercepted POST was called
                        cy.wait('@freezeAgent').then((interception) => {
                            expect(interception.request.url).to.include(`/api/agents/${agentName}/freeze`);
                        });
                    } else {
                        // If disabled, just verify it exists
                        cy.wrap($btn).should('be.disabled');
                    }
                });
            });
        });
    });

    it('action buttons - Promote intercepts POST correctly', () => {
        cy.visit('/agents');

        // Click first agent row to open modal
        cy.get('table tbody tr[data-agent]').first().then($row => {
            const agentName = $row.attr('data-agent');

            cy.intercept('GET', `/agents/${agentName}/inspect-modal`).as('fetchModal');
            $row.trigger('click');
            cy.wait('@fetchModal');

            // Find and click Promote button if it exists and is not disabled
            cy.get('#modal-slot .modal .modal-actions').within(() => {
                cy.get('button').contains('Promote').then($btn => {
                    if (!$btn.is(':disabled')) {
                        cy.wrap($btn).click();

                        // Verify the intercepted POST was called
                        cy.wait('@promoteAgent').then((interception) => {
                            expect(interception.request.url).to.include(`/api/agents/${agentName}/promote`);
                        });
                    } else {
                        // If disabled, just verify it exists
                        cy.wrap($btn).should('be.disabled');
                    }
                });
            });
        });
    });

    it('verifies buttons are properly disabled based on agent state', () => {
        cy.visit('/agents');

        // Open modal for first agent
        cy.get('table tbody tr[data-agent]').first().then($row => {
            const agentName = $row.attr('data-agent');

            cy.intercept('GET', `/agents/${agentName}/inspect-modal`).as('fetchModal');
            $row.trigger('click');
            cy.wait('@fetchModal');

            // Check button states based on agent status shown in modal
            cy.get('#modal-slot .modal').within(() => {
                cy.get('h3 .chip').invoke('text').then((statusText) => {
                    const status = statusText.trim().toLowerCase();

                    cy.get('.modal-actions').within(() => {
                        if (status.includes('baseline')) {
                            // If baseline, Promote should be disabled
                            cy.get('button').contains('Promote').should('be.disabled');
                        }

                        if (status.includes('frozen')) {
                            // If frozen, Unfreeze should be available, Freeze should not
                            cy.get('button').contains('Unfreeze').should('exist');
                            cy.get('button').contains('Shadow').should('be.disabled');
                        }

                        if (status.includes('shadow')) {
                            // If shadow, Unshadow should be available
                            cy.get('button').contains('Unshadow').should('exist');
                        }

                        // Close button should always be enabled
                        cy.get('button').contains('Close').should('not.be.disabled');
                    });
                });
            });
        });
    });

    it('handles agent row click via keyboard (Enter key)', () => {
        cy.visit('/agents');

        // Focus on first agent row and press Enter
        cy.get('table tbody tr[data-agent]').first().then($row => {
            const agentName = $row.attr('data-agent');

            cy.intercept('GET', `/agents/${agentName}/inspect-modal`).as('fetchModalKeyboard');

            // Focus the row and press Enter
            cy.wrap($row).focus().type('{enter}');

            // Verify modal opens
            cy.wait('@fetchModalKeyboard');
            cy.get('#modal-slot .modal').should('be.visible');
            cy.get('#modal-slot .modal h3').should('contain', agentName);
        });
    });

    it('handles clicking modal background to close', () => {
        cy.visit('/agents');

        // Open modal
        cy.get('table tbody tr[data-agent]').first().click();
        cy.get('#modal-slot .modal').should('be.visible');

        // Click the modal background (modal-bg element)
        cy.get('#modal-slot .modal-bg').click('topLeft');

        // Modal should close (close handler clears innerHTML)
        cy.get('#modal-slot').should('be.empty');
    });
});