// PLAN-021 Phase 1A — Portal server management helpers.
//
// Provides startPortal/stopPortal functions (probably unused if start-server-and-test
// handles process management, but available for manual test isolation).

/**
 * Start portal server for testing (currently unused as start-server-and-test
 * handles this, but provided for future manual control).
 */
export function startPortal(): Promise<void> {
    // Phase 1A stub — start-server-and-test handles server lifecycle
    return Promise.resolve();
}

/**
 * Stop portal server after testing.
 */
export function stopPortal(): Promise<void> {
    // Phase 1A stub — start-server-and-test handles server lifecycle
    return Promise.resolve();
}