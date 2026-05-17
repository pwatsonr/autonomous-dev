// PLAN-021 Phase 1A — Cypress configuration for portal UI coverage.
//
// Configured for baseUrl http://localhost:19282 (matches portal:cypress script),
// viewport 1440x900, defaultCommandTimeout 4000ms. e2e.setupNodeEvents is
// empty for now — Phase 1B will add database reset hooks.

import { defineConfig } from "cypress";

export default defineConfig({
    e2e: {
        baseUrl: "http://localhost:19282",
        viewportWidth: 1440,
        viewportHeight: 900,
        defaultCommandTimeout: 4000,
        setupNodeEvents(on, config) {
            // Empty for Phase 1A; Phase 1B will add database reset hooks
        },
    },
});