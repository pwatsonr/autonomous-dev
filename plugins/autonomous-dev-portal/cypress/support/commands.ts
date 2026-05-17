// PLAN-021 Phase 1A — Cypress custom commands.
//
// FR-021-03 enhancement: adds type declarations for fixture management tasks.

/// <reference types="cypress" />

// FR-021-03: Type declarations for custom tasks
declare global {
    namespace Cypress {
        interface Chainable {
            // Task type declarations
        }
    }
}

// Extend Cypress task types for our custom tasks
declare module 'cypress' {
    interface Cypress {
        env(): any;
    }
    namespace Cypress {
        interface Tasks {
            seedRequests(params: { stateDir: string; requests: any[] }): null;
            cleanStateDir(stateDir: string): null;
        }
    }
}