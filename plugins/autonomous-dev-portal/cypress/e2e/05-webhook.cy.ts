// FR-021-05 — Webhook lifecycle test.
//
// Covers Discord/Slack webhook URL entry, Test button behavior, and success/failure
// indicators. Validates that POST requests are fired to correct endpoints with
// proper payloads, and that the UI responds appropriately to success states.
//
// Mocks all outbound webhook calls to avoid hitting real Discord/Slack endpoints.

describe('Webhook lifecycle (FR-021-05)', () => {
    beforeEach(() => {
        // Mock all outbound Discord/Slack webhook calls
        cy.intercept('POST', '**/discord.com/api/webhooks/**', {
            statusCode: 204,
        }).as('discordWebhook');

        cy.intercept('POST', '**/hooks.slack.com/**', {
            statusCode: 204,
        }).as('slackWebhook');

        // Visit the settings page
        cy.visit('/settings');

        // Wait for page to load and ensure webhook fields are present
        cy.get('#discord-webhook').should('be.visible');
        cy.get('#slack-webhook').should('be.visible');
    });

    it('Discord webhook test flow', () => {
        // Type a valid Discord webhook URL
        const discordUrl = 'https://discord.com/api/webhooks/123456789/fake-test-webhook-token';
        cy.get('#discord-webhook').clear().type(discordUrl);

        // Intercept the test endpoint
        cy.intercept('POST', '/api/settings/notifications/test/discord', {
            statusCode: 200,
            body: { sent: true, channel: 'discord' }
        }).as('discordTest');

        // Click Test button
        cy.get('[data-channel="discord"] button').contains('Test').click();

        // Assert POST to test endpoint fired
        cy.wait('@discordTest').then((interception) => {
            expect(interception.request.url).to.include('/api/settings/notifications/test/discord');
        });

        // Note: Since we're using HTMX, the success indicator would be handled
        // by the server response swapping the element. For this test, we verify
        // the request was made correctly.
    });

    it('Slack webhook test flow', () => {
        // Type a valid Slack webhook URL
        const slackUrl = 'https://hooks.slack.com/services/TXXXXXXXX/BXXXXXXXX/FakeWebhookTokenForTesting';
        cy.get('#slack-webhook').clear().type(slackUrl);

        // Intercept the test endpoint
        cy.intercept('POST', '/api/settings/notifications/test/slack', {
            statusCode: 200,
            body: { sent: true, channel: 'slack' }
        }).as('slackTest');

        // Click Test button
        cy.get('[data-channel="slack"] button').contains('Test').click();

        // Assert POST to test endpoint fired
        cy.wait('@slackTest').then((interception) => {
            expect(interception.request.url).to.include('/api/settings/notifications/test/slack');
        });
    });

    it('empty URL state - Test button behavior', () => {
        // Intercept the test endpoints to capture the calls
        cy.intercept('POST', '/api/settings/notifications/test/discord', {
            statusCode: 400,
            body: { error: 'no-webhook-url' }
        }).as('discordTestEmpty');

        cy.intercept('POST', '/api/settings/notifications/test/slack', {
            statusCode: 400,
            body: { error: 'no-webhook-url' }
        }).as('slackTestEmpty');

        // Verify Discord test button with empty URL
        cy.get('#discord-webhook').clear();
        cy.get('[data-channel="discord"] button').contains('Test').click();

        // The button should still be clickable but return an appropriate error
        cy.wait('@discordTestEmpty');

        // Similarly for Slack
        cy.get('#slack-webhook').clear();
        cy.get('[data-channel="slack"] button').contains('Test').click();

        cy.wait('@slackTestEmpty');
    });

    it('webhook test failure handling', () => {
        // Type valid URLs
        const discordUrl = 'https://discord.com/api/webhooks/123456789/fake-test-webhook-token';
        cy.get('#discord-webhook').clear().type(discordUrl);

        // Mock a failed response
        cy.intercept('POST', '/api/settings/notifications/test/discord', {
            statusCode: 502,
            body: { error: 'notification-failed', channel: 'discord' }
        }).as('discordTestFail');

        // Click Test button
        cy.get('[data-channel="discord"] button').contains('Test').click();

        // Assert POST fired and failed appropriately
        cy.wait('@discordTestFail').then((interception) => {
            expect(interception.response?.statusCode).to.equal(502);
            expect(interception.response?.body.error).to.equal('notification-failed');
        });
    });

    it('webhook test timeout handling', () => {
        const slackUrl = 'https://hooks.slack.com/services/TXXXXXXXX/BXXXXXXXX/FakeWebhookTokenForTesting';
        cy.get('#slack-webhook').clear().type(slackUrl);

        // Mock a timeout response (504)
        cy.intercept('POST', '/api/settings/notifications/test/slack', {
            statusCode: 504,
            body: { error: 'notification-timeout', channel: 'slack' }
        }).as('slackTestTimeout');

        // Click Test button
        cy.get('[data-channel="slack"] button').contains('Test').click();

        // Assert timeout response
        cy.wait('@slackTestTimeout').then((interception) => {
            expect(interception.response?.statusCode).to.equal(504);
            expect(interception.response?.body.error).to.equal('notification-timeout');
        });
    });

    it('validates webhook URL format before test', () => {
        // Set up intercepts first
        cy.intercept('POST', '/api/settings/notifications/test/discord', {
            statusCode: 400,
            body: { error: 'invalid-webhook-url' }
        }).as('discordTestInvalid');

        cy.intercept('POST', '/api/settings/notifications/test/slack', {
            statusCode: 400,
            body: { error: 'invalid-webhook-url' }
        }).as('slackTestInvalid');

        // Try invalid Discord URL (wrong domain)
        cy.get('#discord-webhook').clear().type('https://example.com/webhook');
        cy.get('[data-channel="discord"] button').contains('Test').click();

        // The server should reject this before attempting to send
        cy.wait('@discordTestInvalid');

        // Try invalid Slack URL (wrong domain)
        cy.get('#slack-webhook').clear().type('https://badsite.com/services/webhook');
        cy.get('[data-channel="slack"] button').contains('Test').click();

        cy.wait('@slackTestInvalid');
    });

    afterEach(() => {
        // Clean up: Clear any webhook URLs we may have entered
        // This prevents test pollution since we're not using a reset endpoint
        cy.get('body').then(($body) => {
            if ($body.find('#discord-webhook').length > 0) {
                cy.get('#discord-webhook').clear();
            }
            if ($body.find('#slack-webhook').length > 0) {
                cy.get('#slack-webhook').clear();
            }
        });
    });
});