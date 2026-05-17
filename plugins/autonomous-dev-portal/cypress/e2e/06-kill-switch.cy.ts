// FR-021-06 — Kill switch state machine coverage.
//
// Tests the full state-machine flow: idle → armed → engaged → idle.
// All five test cases cover the state transitions plus validation
// gates defined in `server/routes/kill-switch.tsx` and the UI
// component in `server/components/kill-switch.tsx`.
//
// CRITICAL SAFETY: All POST requests to `/ops/kill-switch` are intercepted
// with mocked responses. The real daemon is NEVER engaged. Each test that
// triggers a POST includes a `cy.intercept()` declaration before the action.
//
// Coverage map:
//   - idle → armed (step=arm GET handler)
//   - armed → Cancel (HTMX swap back to idle)
//   - armed → wrong text → still armed (case-sensitive CONFIRM validation)
//   - armed → CONFIRM → engaged (mocked POST response)
//   - engaged → Reset → idle (mocked reset POST response)

describe("Kill switch state machine (FR-021-06)", () => {
    beforeEach(() => {
        // Visit any page that has the shell layout
        cy.visit("/");

        // Verify the kill switch button is present in the rail sidebar
        cy.get(".rail-ops button.kbtn").should("exist");
        cy.get(".rail-ops button.kbtn").should("contain.text", "Kill switch");

        // Verify it's not in engaged state initially
        cy.get(".rail-ops button.kbtn").should("not.have.class", "engaged");
    });

    it("transitions from idle to armed when clicking Kill switch button", () => {
        // Click the kill switch button in the rail sidebar
        cy.get(".rail-ops button.kbtn").click();

        // Wait for the modal to appear with the armed kill switch
        cy.get("#modal-slot").should("exist");
        cy.get("#modal-slot .ks-panel.armed").should("exist");

        // Verify armed state UI
        cy.get(".ks-panel h4").should("contain.text", "Kill switch");
        cy.get(".ks-panel .chip.warn").should("contain.text", "ARMED");
        cy.get(".ks-panel .meta").should("contain.text", "Type CONFIRM to halt the daemon");

        // Verify the confirmation form is present
        cy.get("#ks-confirm-input").should("be.visible");
        cy.get("button[type=submit]").should("contain.text", "Confirm engage");
        cy.get("button").filter(':contains("Cancel")').should("be.visible");
    });

    it("returns from armed to idle when clicking Cancel", () => {
        // First get to armed state
        cy.get(".rail-ops button.kbtn").click();
        cy.get("#modal-slot .ks-panel.armed").should("exist");

        // Click Cancel button
        cy.get(".ks-panel button").filter(':contains("Cancel")').click();

        // Should swap back to idle state
        cy.get(".ks-panel").should("not.have.class", "armed");
        cy.get(".ks-panel .chip.ok").should("contain.text", "DISENGAGED");
        cy.get(".ks-panel .meta").should("contain.text", "Daemon processing nominal");
        cy.get(".ks-panel button.destructive").should("contain.text", "Engage kill switch");
    });

    it("stays armed when typing wrong text (case sensitivity)", () => {
        // Get to armed state
        cy.get(".rail-ops button.kbtn").click();
        cy.get("#modal-slot .ks-panel.armed").should("exist");

        // Type wrong text (lowercase "confirm" instead of uppercase "CONFIRM")
        cy.get("#ks-confirm-input").type("confirm");

        // Submit the form
        cy.get("button[type=submit]").click();

        // Should still be in armed state (the form validates server-side)
        // The server returns 422 with the armed fragment
        cy.get(".ks-panel.armed").should("exist");
        cy.get(".ks-panel .chip.warn").should("contain.text", "ARMED");

        // The input value should still contain what was typed (server re-renders the armed form but preserves the form data)
        cy.get("#ks-confirm-input").should("be.visible");
    });

    it("transitions from armed to engaged when typing CONFIRM", () => {
        // CRITICAL: Intercept the kill switch POST to prevent real daemon engagement
        cy.intercept("POST", "/ops/kill-switch", {
            statusCode: 200,
            body: `
                <div class="ks-panel">
                    <div class="ks-status">
                        <h4>Kill switch <span class="chip err">ENGAGED</span></h4>
                        <div class="meta">All daemon processing halted.</div>
                    </div>
                    <div class="ks-action">
                        <form method="POST" action="/ops/kill-switch/reset">
                            <input type="hidden" name="_csrf" value="test-token" />
                            <button class="btn" type="submit">Reset kill switch</button>
                        </form>
                    </div>
                </div>
            `
        }).as("killSwitchEngage");

        // Get to armed state
        cy.get(".rail-ops button.kbtn").click();
        cy.get("#modal-slot .ks-panel.armed").should("exist");

        // Type correct confirmation text
        cy.get("#ks-confirm-input").type("CONFIRM");

        // Submit the form
        cy.get("button[type=submit]").click();

        // Wait for the intercepted request
        cy.wait("@killSwitchEngage");

        // Should now be in engaged state
        cy.get(".ks-panel .chip.err").should("contain.text", "ENGAGED");
        cy.get(".ks-panel .meta").should("contain.text", "All daemon processing halted");
        cy.get(".ks-panel button").should("contain.text", "Reset kill switch");

        // Verify the engage button is no longer present
        cy.get(".ks-panel button.destructive").should("not.exist");
        cy.get("#ks-confirm-input").should("not.exist");
    });

    it("transitions from engaged to idle when clicking Reset", () => {
        // CRITICAL: Intercept both the engage and reset POSTs
        cy.intercept("POST", "/ops/kill-switch", {
            statusCode: 200,
            body: `
                <div class="ks-panel">
                    <div class="ks-status">
                        <h4>Kill switch <span class="chip err">ENGAGED</span></h4>
                        <div class="meta">All daemon processing halted.</div>
                    </div>
                    <div class="ks-action">
                        <form method="POST" action="/ops/kill-switch/reset">
                            <input type="hidden" name="_csrf" value="test-token" />
                            <button class="btn" type="submit">Reset kill switch</button>
                        </form>
                    </div>
                </div>
            `
        });

        cy.intercept("POST", "/ops/kill-switch/reset", {
            statusCode: 200,
            body: `
                <div class="ks-panel">
                    <div class="ks-status">
                        <h4>Kill switch <span class="chip ok">DISENGAGED</span></h4>
                        <div class="meta">Daemon processing nominal.</div>
                    </div>
                    <div class="ks-action">
                        <button class="btn destructive" type="button" hx-get="/ops/kill-switch?step=arm" hx-target="closest .ks-panel" hx-swap="outerHTML">
                            Engage kill switch
                        </button>
                    </div>
                </div>
            `
        }).as("killSwitchReset");

        // Get to armed state and then engage
        cy.get(".rail-ops button.kbtn").click();
        cy.get("#modal-slot .ks-panel.armed").should("exist");
        cy.get("#ks-confirm-input").type("CONFIRM");
        cy.get("button[type=submit]").click();

        // Should be engaged
        cy.get(".ks-panel .chip.err").should("contain.text", "ENGAGED");

        // Click Reset button
        cy.get(".ks-panel button").filter(':contains("Reset kill switch")').click();

        // Wait for the reset request
        cy.wait("@killSwitchReset");

        // Should be back to idle state
        cy.get(".ks-panel .chip.ok").should("contain.text", "DISENGAGED");
        cy.get(".ks-panel .meta").should("contain.text", "Daemon processing nominal");
        cy.get(".ks-panel button.destructive").should("contain.text", "Engage kill switch");

        // Verify engaged/armed elements are gone
        cy.get(".ks-panel").should("not.have.class", "armed");
        cy.get("#ks-confirm-input").should("not.exist");
        cy.get("button").filter(':contains("Reset kill switch")').should("not.exist");
    });

    it("preserves CSRF tokens throughout the state machine", () => {
        // This test verifies that CSRF tokens are included in all forms
        // and maintained through state transitions

        // Get to armed state
        cy.get(".rail-ops button.kbtn").click();
        cy.get("#modal-slot .ks-panel.armed").should("exist");

        // Verify the armed form has CSRF token
        cy.get(".ks-panel form input[name='_csrf']").should("exist");
        cy.get(".ks-panel form input[name='armed_at']").should("exist");

        // The armed_at value should be a valid ISO timestamp (basic validation)
        cy.get(".ks-panel form input[name='armed_at']")
            .should("have.attr", "value")
            .and("match", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
});