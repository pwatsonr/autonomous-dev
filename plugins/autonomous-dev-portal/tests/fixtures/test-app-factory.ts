// Minimal test-app factory.
//
// Builds a Hono instance with the portal's routes registered against
// stub-defaults (no live deps wired). Used by integration tests that
// only need the route table — the page renderers fall through to the
// safe-defaults paths when daemon-side deps are absent.
//
// Created to satisfy `import { buildTestApp } from "../fixtures/test-app-factory"`
// which was referenced by `tests/integration/settings-agents-tab.test.ts`
// without the helper ever being authored. See PR that added this file
// for the test fix-up.

import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";

/**
 * Returns a fresh Hono app with all portal routes registered.
 *
 * Tests that need fully-wired deps (real settings store, real intake
 * router, real audit logger) should compose them inline instead of
 * using this helper.
 */
export function buildTestApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}
